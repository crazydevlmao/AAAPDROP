// app/api/holders/route.ts
export const runtime = "nodejs";
export const dynamic = "force-dynamic"; // never static cache this route
export const revalidate = 0;

import { NextResponse } from "next/server";
import { Connection, PublicKey } from "@solana/web3.js";
import {
  getMint,
  AccountLayout,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";

/** Small in-memory throttle to avoid hammering RPC if many clients poll at once. */
let cache:
  | {
      at: number; // ms
      data: { holders: Array<{ wallet: string; balance: number }> };
    }
  | null = null;

/** Keep very short so UI polling sees near-real-time updates. */
const TTL_MS = 1200;

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

/** BigInt-safe: 10_000 * 10^decimals in raw/base units */
function minRawThreshold(decimals: number): bigint {
  const tenPow = BigInt(Math.floor(Math.pow(10, Math.max(0, decimals | 0))));
  return BigInt(10_000) * tenPow;
}


async function fetchHoldersForProgram(
  conn: Connection,
  mintPk: PublicKey,
  programId: PublicKey,
  commitment: "confirmed" | "finalized"
) {
  const accounts = await conn.getProgramAccounts(programId, {
    filters: [
      { dataSize: 165 }, // token account size
      { memcmp: { offset: 0, bytes: mintPk.toBase58() } }, // mint field
    ],
    commitment,
  });

  const perOwner = new Map<string, bigint>();

  for (const acc of accounts) {
    try {
      const data = AccountLayout.decode(acc.account.data);
      // skip closed / uninitialized
      if (!data || (data as any).isInitialized === 0) continue;

      const owner = new PublicKey(data.owner).toBase58().toLowerCase();
      // amount is a BN-like; convert safely to BigInt
      const amt = BigInt(data.amount.toString());
      if (amt > 0n) {
        perOwner.set(owner, (perOwner.get(owner) ?? 0n) + amt);
      }
    } catch {
      // ignore malformed accounts
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
      return NextResponse.json(
        { holders: [] },
        { headers: { "cache-control": "no-store" } }
      );
    }

    const mintPk = new PublicKey(MINT_STR);
    const rpc = pickRpc();
    const commitment: "confirmed" = "confirmed";

    const conn = new Connection(rpc, commitment);

    // Get decimals from the mint (works for both token programs)
    const mintInfo = await getMint(conn, mintPk, commitment).catch(() => null);
    const decimals = mintInfo?.decimals ?? 0;
    const minRaw = minRawThreshold(decimals);

    // Query BOTH Token-2017 and Token-2022 to be safe
    const [perOwnerA, perOwnerB] = await Promise.all([
      fetchHoldersForProgram(conn, mintPk, TOKEN_PROGRAM_ID, commitment),
      fetchHoldersForProgram(conn, mintPk, TOKEN_2022_PROGRAM_ID, commitment),
    ]);

    // Merge maps
    const perOwner = new Map<string, bigint>(perOwnerA);
    for (const [owner, raw] of perOwnerB) {
      perOwner.set(owner, (perOwner.get(owner) ?? 0n) + raw);
    }

    // Apply blacklist and threshold, convert to UI units
    const blacklist = parseBlacklist();
    const holders = Array.from(perOwner.entries())
      .filter(([owner, raw]) => raw >= minRaw && !blacklist.has(owner))
      .map(([owner, raw]) => ({
        wallet: owner,
        balance: Number(raw) / 10 ** decimals,
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

