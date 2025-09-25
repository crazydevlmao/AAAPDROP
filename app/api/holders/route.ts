// app/api/holders/route.ts
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

import { NextResponse } from "next/server";
import {
  Connection,
  PublicKey,
  type ParsedAccountData,
} from "@solana/web3.js";
import {
  getMint,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";

type HolderRow = { wallet: string; balance: number };

let cache:
  | {
      at: number;
      data: { holders: HolderRow[] };
    }
  | null = null;

const TTL_MS = 2000;

function pickRpc() {
  return (
    process.env.HELIUS_RPC ||
    process.env.SOLANA_RPC ||
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

/** >= 10,000 tokens in raw base units */
function minRawThreshold(decimals: number): bigint {
  const safeDec = Math.max(0, decimals | 0);
  const tenPow = BigInt(Math.floor(Math.pow(10, safeDec)));
  return BigInt(10000) * tenPow; // >= 10k tokens
}

/** Try mint via classic; if missing/fails, try Token-2022. */
async function fetchMintDecimals(
  conn: Connection,
  mintPk: PublicKey
): Promise<{ decimals: number; programId: PublicKey | null }> {
  try {
    const m = await getMint(conn, mintPk, "confirmed");
    if (typeof m?.decimals === "number") {
      return { decimals: m.decimals, programId: TOKEN_PROGRAM_ID };
    }
  } catch {}
  try {
    const m22 = await getMint(conn, mintPk, "confirmed", TOKEN_2022_PROGRAM_ID);
    if (typeof m22?.decimals === "number") {
      return { decimals: m22.decimals, programId: TOKEN_2022_PROGRAM_ID };
    }
  } catch {}
  // Fallback if RPC struggles
  return { decimals: 6, programId: null };
}

/** Aggregate balances per owner for a given token program id using parsed accounts. */
async function collectBalancesForProgram(
  conn: Connection,
  mintPk: PublicKey,
  programId: PublicKey
): Promise<Map<string, bigint> & { __display?: Map<string, string> }> {
  const parsed = await conn.getParsedProgramAccounts(programId, {
    filters: [{ memcmp: { offset: 0, bytes: mintPk.toBase58() } }],
    commitment: "processed",
  });

  // Attach a display map to preserve first-seen original-case addresses
  const perOwner = new Map<string, bigint>() as Map<
    string,
    bigint
  > & { __display?: Map<string, string> };
  perOwner.__display = new Map<string, string>();

  for (let i = 0; i < parsed.length; i++) {
    try {
      const acc = parsed[i];
      const data = acc.account.data as ParsedAccountData;
      if (data?.program !== "spl-token") continue;
      const info: any = data.parsed?.info;
      const owner: string | undefined = info?.owner;
      const amountStr: string | undefined = info?.tokenAmount?.amount;
      if (!owner || !amountStr) continue;

      const amt = BigInt(amountStr);
      if (amt <= BigInt(0)) continue;

      const keyLc = owner.toLowerCase();
      const prev = perOwner.get(keyLc) ?? BigInt(0);
      perOwner.set(keyLc, prev + amt);

      if (!perOwner.__display!.has(keyLc)) perOwner.__display!.set(keyLc, owner);
    } catch {
      // ignore a bad row
    }
  }
  return perOwner;
}

export async function GET() {
  try {
    const now = Date.now();
    if (cache && now - cache.at < TTL_MS) {
      return NextResponse.json(cache.data, {
        headers: { "cache-control": "no-store" },
      });
    }

    const mintStr =
      process.env.NEXT_PUBLIC_COIN_MINT || process.env.COIN_MINT || "";
    if (!mintStr) {
      return NextResponse.json(
        { holders: [] },
        { headers: { "cache-control": "no-store" } }
      );
    }

    const mintPk = new PublicKey(mintStr);
    const conn = new Connection(pickRpc(), "processed");

    // Resolve decimals
    const { decimals } = await fetchMintDecimals(conn, mintPk);
    const minRaw = minRawThreshold(decimals);
    const denom = Math.pow(10, decimals || 0);

    // Pull both programs defensively
    const maps: (Map<string, bigint> & { __display?: Map<string, string> })[] =
      [];
    try {
      maps.push(await collectBalancesForProgram(conn, mintPk, TOKEN_PROGRAM_ID));
    } catch {}
    try {
      maps.push(
        await collectBalancesForProgram(conn, mintPk, TOKEN_2022_PROGRAM_ID)
      );
    } catch {}

    // Merge maps by lowercase key; keep first-seen original-case for display
    const perOwner = new Map<string, bigint>();
    const display = new Map<string, string>(); // lc -> original-case

    for (let i = 0; i < maps.length; i++) {
      const m = maps[i];
      m.forEach((amt, lc) => {
        const prev = perOwner.get(lc) ?? BigInt(0);
        perOwner.set(lc, prev + amt);
      });
      const disp = m.__display;
      if (disp) {
        disp.forEach((d, lc) => {
          if (!display.has(lc)) display.set(lc, d);
        });
      }
    }

    const blacklist = parseBlacklist();

    const holders: HolderRow[] = [];
    perOwner.forEach((raw, lc) => {
      if (raw < minRaw) return;
      if (blacklist.has(lc)) return;
      const walletDisplay = display.get(lc) ?? lc;
      holders.push({
        wallet: walletDisplay, // original case for UI/links
        balance: Number(raw) / denom,
      });
    });

    holders.sort((a, b) => b.balance - a.balance);

    const data = { holders };
    cache = { at: now, data };

    return NextResponse.json(data, {
      headers: { "cache-control": "no-store" },
    });
  } catch (e) {
    console.error("holders route error:", e);
    return NextResponse.json(
      { holders: [] },
      { headers: { "cache-control": "no-store" } }
    );
  }
}
