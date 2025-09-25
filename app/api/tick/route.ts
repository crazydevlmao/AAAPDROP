// app/api/holders/route.ts
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

import { NextResponse } from "next/server";
import { Connection, PublicKey } from "@solana/web3.js";
import { getMint, TOKEN_PROGRAM_ID, AccountLayout } from "@solana/spl-token";

// in-memory cache
let cache:
  | {
      at: number; // ms
      data: { holders: Array<{ wallet: string; balance: number }> };
    }
  | null = null;

const TTL_MS = 2000; // poll-friendly, near real-time

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

/** BigInt-safe: 10,000 * 10^decimals in raw/base units, without BigInt literals */
function minRawThreshold(decimals: number): bigint {
  const safeDec = Math.max(0, (decimals | 0) as number);
  const tenPow = BigInt(Math.floor(Math.pow(10, safeDec)));
  return BigInt(10000) * tenPow; // >= 10k tokens
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
    const conn = new Connection(pickRpc(), "processed"); // faster reflection

    // read mint to get decimals
    const mintInfo = await getMint(conn, mintPk);
    const decimals = (mintInfo?.decimals as number) ?? 0;
    const minRaw = minRawThreshold(decimals);

    // get all token accounts for this mint
    const accounts = await conn.getProgramAccounts(TOKEN_PROGRAM_ID, {
      filters: [
        { dataSize: 165 }, // SPL token account size
        { memcmp: { offset: 0, bytes: mintPk.toBase58() } }, // mint filter
      ],
      commitment: "processed",
    });

    // Aggregate balances per owner (decode directly with AccountLayout)
    const perOwner = new Map<string, bigint>();
    for (const acc of accounts) {
      try {
        const data = AccountLayout.decode(acc.account.data);
        const owner = new PublicKey(data.owner).toBase58().toLowerCase();
        // amount is a BN-like (BufferLayout u64). Convert via string → BigInt
        const amt = BigInt(data.amount.toString());
        if (amt > BigInt(0)) {
          const prev = perOwner.get(owner) ?? BigInt(0);
          perOwner.set(owner, prev + amt);
        }
      } catch {
        // ignore malformed accounts
      }
    }

    // Filter: >= 10k, exclude AMM/blacklist, and convert to UI units
    const blacklist = parseBlacklist();
    const denom = Math.pow(10, decimals || 0);
    const holders = Array.from(perOwner.entries())
      .filter(([owner, raw]) => raw >= minRaw && !blacklist.has(owner))
      .map(([owner, raw]) => ({
        wallet: owner,
        balance: Number(raw) / denom,
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
