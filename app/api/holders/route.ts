// app/api/holders/route.ts
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

import { NextResponse } from "next/server";
import { Connection, PublicKey, type Commitment } from "@solana/web3.js";
import {
  getMint,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  AccountLayout,
} from "@solana/spl-token";

/** ====== In-memory cache (per process) ====== */
let cache:
  | {
      at: number; // ms
      data: { holders: Array<{ wallet: string; balance: number }> };
    }
  | null = null;

// Short cache so UI (polling every ~10s) sees near real-time updates
const TTL_MS = 2000;

/** ====== Utils ====== */
const COMMITMENT: Commitment = "confirmed"; // fresher than finalized, more stable than processed

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
  for (const a of envList) set.add(a.toLowerCase());
  const amm = (process.env.NEXT_PUBLIC_PUMPFUN_AMM || "").trim();
  if (amm) set.add(amm.toLowerCase());
  return set;
}

/** Robustly read decimals: try legacy program first, then Token-2022 */
async function fetchMintDecimals(conn: Connection, mintPk: PublicKey): Promise<number> {
  try {
    const mi = await getMint(conn, mintPk, COMMITMENT, TOKEN_PROGRAM_ID);
    if (typeof mi.decimals === "number") return mi.decimals;
  } catch {}
  try {
    const mi = await getMint(conn, mintPk, COMMITMENT, TOKEN_2022_PROGRAM_ID);
    if (typeof mi.decimals === "number") return mi.decimals;
  } catch {}
  // Fallback (most Pump tokens are 6 or 9; use 6 if unknown)
  return 6;
}

/** Scan one token program (legacy or 2022) and aggregate raw balances per owner */
async function scanProgramAccounts(
  conn: Connection,
  mintPk: PublicKey,
  programId: PublicKey
): Promise<Map<string, bigint>> {
  const perOwner = new Map<string, bigint>();

  const accounts = await conn.getProgramAccounts(programId, {
    filters: [
      { dataSize: 165 }, // SPL token account size
      { memcmp: { offset: 0, bytes: mintPk.toBase58() } }, // mint at offset 0
    ],
    commitment: COMMITMENT,
  });

  for (const acc of accounts) {
    try {
      const data = AccountLayout.decode(acc.account.data);
      const owner = new PublicKey(data.owner).toBase58().toLowerCase();
      const amt = BigInt(data.amount.toString());
      if (amt > 0n) {
        perOwner.set(owner, (perOwner.get(owner) ?? 0n) + amt);
      }
    } catch {
      // ignore malformed
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

    const MINT_STR =
      process.env.NEXT_PUBLIC_COIN_MINT || process.env.COIN_MINT || "";
    if (!MINT_STR) {
      return NextResponse.json({ holders: [] }, { headers: { "cache-control": "no-store" } });
    }

    const mintPk = new PublicKey(MINT_STR);
    const conn = new Connection(pickRpc(), COMMITMENT);

    // Decimals (robust across both programs)
    const decimals = await fetchMintDecimals(conn, mintPk);

    // Minimum threshold raw units for >= 10,000
    const tenK = 10_000;
    const minRaw = BigInt(Math.floor(tenK * Math.pow(10, decimals)));

    // Scan both programs in parallel and merge
    const [legacy, tok2022] = await Promise.all([
      scanProgramAccounts(conn, mintPk, TOKEN_PROGRAM_ID).catch(() => new Map<string, bigint>()),
      scanProgramAccounts(conn, mintPk, TOKEN_2022_PROGRAM_ID).catch(() => new Map<string, bigint>()),
    ]);

    const perOwner = new Map<string, bigint>();
    // merge legacy first
    for (const [k, v] of legacy.entries()) perOwner.set(k, (perOwner.get(k) ?? 0n) + v);
    // then add token2022
    for (const [k, v] of tok2022.entries()) perOwner.set(k, (perOwner.get(k) ?? 0n) + v);

    // Filter & map to UI balances
    const blacklist = parseBlacklist();
    const holders = Array.from(perOwner.entries())
      .filter(([owner, raw]) => raw >= minRaw && !blacklist.has(owner))
      .map(([owner, raw]) => ({
        wallet: owner,
        balance: Number(raw) / Math.pow(10, decimals),
      }))
      .sort((a, b) => b.balance - a.balance);

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
