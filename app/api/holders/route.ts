// app/api/holders/route.ts
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { Connection, PublicKey } from "@solana/web3.js";
import { getMint, TOKEN_PROGRAM_ID, AccountLayout } from "@solana/spl-token";

// in-memory cache
let cache: {
  at: number; // ms
  data: { holders: Array<{ wallet: string; balance: number }> };
} | null = null;

const TTL_MS = 2000; // shorter cache for near real-time updates

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
      return NextResponse.json({ holders: [] });
    }
    const mintPk = new PublicKey(MINT_STR);
    const rpc = pickRpc();
    const conn = new Connection(rpc, "processed"); // 👈 faster reflection

    // read mint to get decimals
    const mintInfo = await getMint(conn, mintPk);
    const decimals = mintInfo.decimals ?? 0;
    const minRaw = BigInt(Math.floor(10000 * 10 ** decimals)); // >10k threshold in raw units

    // get all token accounts for this mint
    const accounts = await conn.getProgramAccounts(TOKEN_PROGRAM_ID, {
      filters: [
        { dataSize: 165 }, // Token account size
        { memcmp: { offset: 0, bytes: mintPk.toBase58() } }, // Mint filter
      ],
      commitment: "processed",
    });

    // Aggregate balances per owner (decode directly)
    const perOwner = new Map<string, bigint>();
    for (const acc of accounts) {
      try {
        const data = AccountLayout.decode(acc.account.data);
        const owner = new PublicKey(data.owner).toBase58().toLowerCase();
        const amt = BigInt(data.amount.toString());
        if (amt > 0n) {
          perOwner.set(owner, (perOwner.get(owner) ?? 0n) + amt);
        }
      } catch {
        // ignore malformed accounts
      }
    }

    // Filter: >= 10k, exclude AMM/blacklist, and convert to UI units
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
    return NextResponse.json({ holders: [] });
  }
}
