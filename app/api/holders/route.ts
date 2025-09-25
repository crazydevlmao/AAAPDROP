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

const TTL_MS = 2_000; // 2s soft cache (in-process)

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
  return BigInt(10_000) * tenPow; // >= 10k tokens
}

/** Try mint via classic; if missing/fails, try Token-2022. Return decimals + which program succeeded. */
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
  // Fallback: assume 6 if unknown
  return { decimals: 6, programId: null };
}

/** Aggregate balances per owner for a given token program id using parsed accounts. */
async function collectBalancesForProgram(
  conn: Connection,
  mintPk: PublicKey,
  programId: PublicKey
): Promise<Map<string, bigint>> {
  // Use parsed accounts so Token-2022 extension sizes don’t break decoding
  const parsed = await conn.getParsedProgramAccounts(programId, {
    filters: [{ memcmp: { offset: 0, bytes: mintPk.toBase58() } }],
    commitment: "processed",
  });

  const perOwner = new Map<string, bigint>();
  for (const acc of parsed) {
    try {
      const data = acc.account.data as ParsedAccountData;
      if (data?.program !== "spl-token") continue;
      const info: any = data.parsed?.info;
      // Expect info = { mint, owner, tokenAmount: { amount, decimals, uiAmount, ... }, ... }
      const owner: string | undefined = info?.owner;
      const amountStr: string | undefined = info?.tokenAmount?.amount;
      if (!owner || !amountStr) continue;
      const amt = BigInt(amountStr);
      if (amt <= 0n) continue;

      // Keep original case for display; accumulate by lowercase key to dedupe
      const keyLc = owner.toLowerCase();
      const prev = perOwner.get(keyLc) ?? 0n;
      perOwner.set(keyLc, prev + amt);

      // Also stash the original-case display we saw first via a side map on the Map object
      // @ts-ignore - attach once
      if (!perOwner.__display) perOwner.__display = new Map<string, string>();
      // @ts-ignore
      if (!perOwner.__display.has(keyLc)) perOwner.__display.set(keyLc, owner);
    } catch {
      /* ignore individual rows */
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

    // Fetch decimals (try classic, then 2022)
    const { decimals } = await fetchMintDecimals(conn, mintPk);
    const minRaw = minRawThreshold(decimals);
    const denom = Math.pow(10, decimals || 0);

    // Collect balances from BOTH programs to be safe
    const maps: Map<string, bigint>[] = [];
    try {
      maps.push(await collectBalancesForProgram(conn, mintPk, TOKEN_PROGRAM_ID));
    } catch {}
    try {
      maps.push(
        await collectBalancesForProgram(conn, mintPk, TOKEN_2022_PROGRAM_ID)
      );
    } catch {}

    // Merge maps keyed by lowercase owner, track a display map
    const perOwner = new Map<string, bigint>();
    const display = new Map<string, string>(); // lc -> original-case

    for (const m of maps) {
      for (const [lc, amt] of m.entries()) {
        perOwner.set(lc, (perOwner.get(lc) ?? 0n) + amt);
      }
      // @ts-ignore - read attached display map if present
      const disp: Map<string, string> | undefined = m.__display;
      if (disp) {
        for (const [lc, d] of disp.entries()) {
          if (!display.has(lc)) display.set(lc, d);
        }
      }
    }

    const blacklist = parseBlacklist();

    const holders: HolderRow[] = [];
    for (const [lc, raw] of perOwner.entries()) {
      if (raw < minRaw) continue;
      if (blacklist.has(lc)) continue;
      const walletDisplay = display.get(lc) ?? lc; // prefer original-case if we saw it
      holders.push({
        wallet: walletDisplay,               // 🚫 Do NOT lowercase for UI
        balance: Number(raw) / denom,
      });
    }

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
