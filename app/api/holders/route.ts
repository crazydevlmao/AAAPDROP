// app/api/holders/route.ts
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

import { NextResponse } from "next/server";
import { Connection, PublicKey, type ParsedAccountData } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, AccountLayout } from "@solana/spl-token";

type HolderRow = { wallet: string; balance: number; display?: string };

let cache: { at: number; data: { holders: HolderRow[] } } | null = null;
// Server cache TTL (clients still get no-store; server shields upstream)
const TTL_MS = 5000;

// Single-flight to dedupe concurrent refreshes
let pending: Promise<{ holders: HolderRow[]; debug?: any }> | null = null;

function cidOf(req: Request) {
  return (
    req.headers.get("x-request-id") ||
    req.headers.get("cf-ray") ||
    Math.random().toString(36).slice(2)
  );
}

function pickRpc() {
  return (
    process.env.HELIUS_RPC ||
    process.env.SOLANA_RPC ||
    process.env.NEXT_PUBLIC_SOLANA_RPC ||
    "https://api.mainnet-beta.solana.com"
  );
}

function parseBlacklist(): Set<string> {
  const set = new Set<string>();
  const envList = (process.env.NEXT_PUBLIC_BLACKLIST || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (let i = 0; i < envList.length; i++) set.add(envList[i].toLowerCase());
  const amm = (process.env.NEXT_PUBLIC_PUMPFUN_AMM || "").trim();
  if (amm) set.add(amm.toLowerCase());
  return set;
}

/** >= 10,000 tokens (raw units) */
function minRawThreshold(decimals: number): bigint {
  const safeDec = Math.max(0, decimals | 0);
  const tenPow = BigInt(Math.floor(Math.pow(10, safeDec)));
  return BigInt(10000) * tenPow;
}

/** Auto-blacklist >100,000,000 PUMPDROP (raw) */
function giantHolderThreshold(decimals: number): bigint {
  const safeDec = Math.max(0, decimals | 0);
  const tenPow = BigInt(Math.floor(Math.pow(10, safeDec)));
  return BigInt(100000000) * tenPow; // 100M * 10^dec
}

/** Decimals via RPC getTokenSupply (works for Token-2022 too). */
async function fetchMintDecimals(conn: Connection, mintPk: PublicKey): Promise<number> {
  try {
    const sup = await conn.getTokenSupply(mintPk, "confirmed");
    const d = Number(sup?.value?.decimals);
    if (Number.isFinite(d)) return d;
  } catch {}
  return 6;
}

/** Detect mint program owner to avoid 2 extra RPC sweeps. */
async function detectTokenProgram(conn: Connection, mintPk: PublicKey): Promise<PublicKey> {
  try {
    const info = await conn.getAccountInfo(mintPk, "confirmed");
    const owner = info?.owner?.toBase58?.() || "";
    if (owner === TOKEN_2022_PROGRAM_ID.toBase58()) return TOKEN_2022_PROGRAM_ID;
  } catch {}
  return TOKEN_PROGRAM_ID; // default to classic
}

/** Classic SPL fast path: getProgramAccounts (binary), dataSize=165 + memcmp(mint) */
async function collectClassicBinary(
  conn: Connection,
  mintPk: PublicKey
): Promise<Map<string, bigint> & { __display?: Map<string, string> }> {
  const accs = await conn.getProgramAccounts(TOKEN_PROGRAM_ID, {
    filters: [{ dataSize: 165 }, { memcmp: { offset: 0, bytes: mintPk.toBase58() } }],
    commitment: "processed",
  });

  const per = new Map<string, bigint>() as Map<string, bigint> & { __display?: Map<string, string> };
  per.__display = new Map<string, string>();

  for (let i = 0; i < accs.length; i++) {
    try {
      const raw = accs[i].account.data as unknown as Uint8Array;
      const u8 =
        raw instanceof Uint8Array
          ? raw
          : new Uint8Array(
              // @ts-ignore
              raw.buffer ?? raw,
              // @ts-ignore
              raw.byteOffset ?? 0,
              // @ts-ignore
              raw.byteLength ?? (raw as any).length ?? undefined
            );

      const decoded = AccountLayout.decode(u8);
      const owner = new PublicKey(decoded.owner).toBase58();
      const amount = BigInt(decoded.amount.toString());
      if (amount <= BigInt(0)) continue;

      const lc = owner.toLowerCase();
      per.set(lc, (per.get(lc) ?? BigInt(0)) + amount);
      if (!per.__display!.has(lc)) per.__display!.set(lc, owner);
    } catch {
      /* ignore bad row */
    }
  }
  return per;
}

/** Parsed path (used for Token-2022; works for classic too if needed) */
async function collectParsed(
  conn: Connection,
  mintPk: PublicKey,
  programId: PublicKey
): Promise<Map<string, bigint> & { __display?: Map<string, string> }> {
  const parsed = await conn.getParsedProgramAccounts(programId, {
    filters: [{ memcmp: { offset: 0, bytes: mintPk.toBase58() } }],
    commitment: "processed",
  });

  const per = new Map<string, bigint>() as Map<string, bigint> & { __display?: Map<string, string> };
  per.__display = new Map<string, string>();

  for (let i = 0; i < parsed.length; i++) {
    try {
      const data = parsed[i].account.data as ParsedAccountData;
      const info: any = (data as any)?.parsed?.info;
      const owner: string | undefined = info?.owner;
      const amountStr: string | undefined = info?.tokenAmount?.amount;
      if (!owner || !amountStr) continue;

      const amt = BigInt(amountStr);
      if (amt <= BigInt(0)) continue;

      const lc = owner.toLowerCase();
      per.set(lc, (per.get(lc) ?? BigInt(0)) + amt);
      if (!per.__display!.has(lc)) per.__display!.set(lc, owner);
    } catch {
      /* ignore bad row */
    }
  }
  return per;
}

/* ==== Per-IP throttle (token bucket) ==== */
type Bucket = { tokens: number; ts: number };
const IP_BUCKET = new Map<string, Bucket>();
function allowIp(ip: string, ratePerMin: number) {
  const now = Date.now();
  const refill = ratePerMin / 60000;
  const slot = IP_BUCKET.get(ip) ?? { tokens: ratePerMin, ts: now };
  const tokens = Math.min(ratePerMin, slot.tokens + (now - slot.ts) * refill);
  if (tokens < 1) {
    IP_BUCKET.set(ip, { tokens, ts: now });
    return false;
  }
  IP_BUCKET.set(ip, { tokens: tokens - 1, ts: now });
  return true;
}

async function buildHolders(): Promise<{ holders: HolderRow[]; debug: any }> {
  const mintStr = process.env.NEXT_PUBLIC_COIN_MINT || process.env.COIN_MINT || "";
  if (!mintStr) return { holders: [], debug: { note: "No mint set" } };

  const mintPk = new PublicKey(mintStr);
  const conn = new Connection(pickRpc(), "processed");

  const decimals = await fetchMintDecimals(conn, mintPk);
  const minRaw = minRawThreshold(decimals);
  const giantRaw = giantHolderThreshold(decimals);
  const denom = Math.pow(10, decimals || 0);

  // Decide program once, then do a single sweep
  const program = await detectTokenProgram(conn, mintPk);

  let perOwner = new Map<string, bigint>() as Map<string, bigint> & { __display?: Map<string, string> };
  try {
    if (program.equals(TOKEN_PROGRAM_ID)) {
      perOwner = await collectClassicBinary(conn, mintPk);
    } else {
      perOwner = await collectParsed(conn, mintPk, TOKEN_2022_PROGRAM_ID);
    }
  } catch {
    // Fallback: try the other path once
    try {
      perOwner = program.equals(TOKEN_PROGRAM_ID)
        ? await collectParsed(conn, mintPk, TOKEN_PROGRAM_ID)
        : await collectClassicBinary(conn, mintPk);
    } catch {}
  }

  const display = perOwner.__display ?? new Map<string, string>();
  const blacklist = parseBlacklist();
  const holders: HolderRow[] = [];

  perOwner.forEach((raw, lc) => {
    if (raw < minRaw) return;        // ignore dust
    if (raw >= giantRaw) return;     // auto-blacklist > 100,000,000 PUMPDROP
    if (blacklist.has(lc)) return;   // explicit blacklist (includes AMM)
    const walletDisplay = display.get(lc) ?? lc;
    holders.push({ wallet: walletDisplay, display: walletDisplay, balance: Number(raw) / denom });
  });

  holders.sort((a, b) => b.balance - a.balance);

  return {
    holders,
    debug: {
      rpc: pickRpc(),
      decimals,
      programUsed: program.equals(TOKEN_PROGRAM_ID) ? "TOKEN_PROGRAM_ID" : "TOKEN_2022_PROGRAM_ID",
      perOwnerSize: perOwner.size,
      holdersLen: holders.length,
      ttlMs: TTL_MS,
      autoBlacklistOver100M: true,
    },
  };
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const debug = url.searchParams.get("debug") === "1";
  const cid = cidOf(req);

  // Per-IP limit (clients shouldn’t spam anyway; 30/min is plenty for this route)
  const ip =
    (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() ||
    req.headers.get("x-real-ip") ||
    "unknown";
  if (!allowIp(ip, 30)) {
    console.warn(JSON.stringify({ cid, where: "holders", ip, err: "rate_limited_ip" }));
    return NextResponse.json(
      { holders: [], error: "Too Many Requests (ip)" },
      { headers: { "cache-control": "no-store" }, status: 429 }
    );
  }

  try {
    const now = Date.now();
    if (cache && now - cache.at < TTL_MS && !debug) {
      return NextResponse.json(cache.data, { headers: { "cache-control": "no-store" } });
    }

    // Single-flight: if a refresh is already in progress, await it
    if (!pending) {
      pending = buildHolders().finally(() => {
        setTimeout(() => {
          pending = null;
        }, 50);
      });
    }

    let payload: { holders: HolderRow[]; debug?: any };
    try {
      payload = await pending;

      // Always cache the lean payload (no debug leakage)
      cache = { at: now, data: { holders: payload.holders } };
    } catch (err) {
      console.error(JSON.stringify({ cid, where: "holders", error: String((err as any)?.message || err) }));
      // Serve stale cache on failure
      if (cache) {
        return NextResponse.json(cache.data, { headers: { "cache-control": "no-store" } });
      }
      return NextResponse.json(
        { holders: [], error: "Upstream fetch failed" },
        { headers: { "cache-control": "no-store" }, status: 502 }
      );
    }

    console.info(JSON.stringify({ cid, where: "holders", holders: payload.holders.length }));
    const out = debug ? { holders: payload.holders, debug: payload.debug } : { holders: payload.holders };
    return NextResponse.json(out, { headers: { "cache-control": "no-store" } });
  } catch (e: any) {
    console.error(JSON.stringify({ cid, where: "holders", error: String(e?.message || e) }));
    if (cache) return NextResponse.json(cache.data, { headers: { "cache-control": "no-store" } });
    return NextResponse.json(
      { holders: [], error: String(e?.message || e) },
      { headers: { "cache-control": "no-store" }, status: 500 }
    );
  }
}
