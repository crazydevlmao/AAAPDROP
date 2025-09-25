// app/api/holders/route.ts
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

import { NextResponse } from "next/server";
import { Connection, PublicKey, type ParsedAccountData } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  AccountLayout,
} from "@solana/spl-token";

type HolderRow = { wallet: string; balance: number; display?: string };

let cache: { at: number; data: { holders: HolderRow[] } } | null = null;
const TTL_MS = 2000;

function pickRpc() {
  return (
    process.env.HELIUS_RPC ||
    process.env.SOLANA_RPC ||
    process.env.NEXT_PUBLIC_SOLANA_RPC || // ← add frontend RPC as server fallback
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

/** >= 10,000 tokens (raw units; no BigInt literals for older TS targets) */
function minRawThreshold(decimals: number): bigint {
  const safeDec = Math.max(0, decimals | 0);
  const tenPow = BigInt(Math.floor(Math.pow(10, safeDec)));
  return BigInt(10000) * tenPow;
}

/** Decimals via RPC getTokenSupply (works for Token-2022 too). */
async function fetchMintDecimals(conn: Connection, mintPk: PublicKey): Promise<number> {
  try {
    const sup = await conn.getTokenSupply(mintPk, "confirmed");
    const d = Number(sup?.value?.decimals);
    if (Number.isFinite(d)) return d;
  } catch {}
  // safe fallback
  return 6;
}

/** Classic SPL fast path: raw getProgramAccounts (binary), dataSize=165 + memcmp. */
async function collectClassicBinary(
  conn: Connection,
  mintPk: PublicKey
): Promise<Map<string, bigint> & { __display?: Map<string, string> }> {
  const accs = await conn.getProgramAccounts(TOKEN_PROGRAM_ID, {
    filters: [
      { dataSize: 165 },
      { memcmp: { offset: 0, bytes: mintPk.toBase58() } },
    ],
    commitment: "processed",
  });

  const per = new Map<string, bigint>() as Map<string, bigint> & {
    __display?: Map<string, string>;
  };
  per.__display = new Map<string, string>();

  for (let i = 0; i < accs.length; i++) {
    try {
      const decoded = AccountLayout.decode(accs[i].account.data);
      const owner = new PublicKey(decoded.owner).toBase58();
      const amount = BigInt(decoded.amount.toString());
      if (amount <= BigInt(0)) continue;

      const lc = owner.toLowerCase();
      per.set(lc, (per.get(lc) ?? BigInt(0)) + amount);
      if (!per.__display!.has(lc)) per.__display!.set(lc, owner);
    } catch {
      // ignore one bad row
    }
  }
  return per;
}

/** Parsed path for a given token program (used for Token-2022; also OK for classic). */
async function collectParsed(
  conn: Connection,
  mintPk: PublicKey,
  programId: PublicKey
): Promise<Map<string, bigint> & { __display?: Map<string, string> }> {
  const parsed = await conn.getParsedProgramAccounts(programId, {
    // no dataSize for 2022; sizes vary. memcmp on mint still works.
    filters: [{ memcmp: { offset: 0, bytes: mintPk.toBase58() } }],
    commitment: "processed",
  });

  const per = new Map<string, bigint>() as Map<string, bigint> & {
    __display?: Map<string, string>;
  };
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
      // ignore one bad row
    }
  }
  return per;
}

export async function GET(req: Request) {
  const debug = new URL(req.url).searchParams.get("debug") === "1";
  try {
    const now = Date.now();
    if (!debug && cache && now - cache.at < TTL_MS) {
      return NextResponse.json(cache.data, { headers: { "cache-control": "no-store" } });
    }

    const mintStr = process.env.NEXT_PUBLIC_COIN_MINT || process.env.COIN_MINT || "";
    if (!mintStr) {
      return NextResponse.json({ holders: [], note: "No mint set" }, { headers: { "cache-control": "no-store" } });
    }

    const mintPk = new PublicKey(mintStr);
    const conn = new Connection(pickRpc(), "processed");

    const decimals = await fetchMintDecimals(conn, mintPk);
    const minRaw = minRawThreshold(decimals);
    const denom = Math.pow(10, decimals || 0);

    // Build from three sources (two for classic, one for 2022) then merge:
    const maps: (Map<string, bigint> & { __display?: Map<string, string> })[] = [];
    // Classic fast path (binary)
    try { maps.push(await collectClassicBinary(conn, mintPk)); } catch {}
    // Classic parsed (backup)
    try { maps.push(await collectParsed(conn, mintPk, TOKEN_PROGRAM_ID)); } catch {}
    // Token-2022 parsed
    try { maps.push(await collectParsed(conn, mintPk, TOKEN_2022_PROGRAM_ID)); } catch {}

    const perOwner = new Map<string, bigint>();
    const display = new Map<string, string>();

    for (let i = 0; i < maps.length; i++) {
      const m = maps[i];
      m.forEach((amt, lc) => perOwner.set(lc, (perOwner.get(lc) ?? BigInt(0)) + amt));
      const disp = m.__display;
      if (disp) disp.forEach((d, lc) => { if (!display.has(lc)) display.set(lc, d); });
    }

    const blacklist = parseBlacklist();
    const holders: HolderRow[] = [];
    perOwner.forEach((raw, lc) => {
      if (raw < minRaw) return;
      if (blacklist.has(lc)) return;
      const walletDisplay = display.get(lc) ?? lc;
      holders.push({ wallet: walletDisplay, display: walletDisplay, balance: Number(raw) / denom });
    });

    holders.sort((a, b) => b.balance - a.balance);

    const payload: any = { holders };
    if (debug) {
      payload.debug = {
        rpc: pickRpc(),
        decimals,
        mapsCollected: maps.length,
        perOwnerSize: perOwner.size,
        holdersLen: holders.length,
      };
    }

    if (!debug) cache = { at: now, data: payload };
    return NextResponse.json(payload, { headers: { "cache-control": "no-store" } });
  } catch (e: any) {
    console.error("holders route error:", e);
    return NextResponse.json(
      { holders: [], error: String(e?.message || e) },
      { headers: { "cache-control": "no-store" } }
    );
  }
}
