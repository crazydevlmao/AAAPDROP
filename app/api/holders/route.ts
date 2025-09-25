// app/api/holders/route.ts
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

import { NextResponse } from "next/server";
import { Connection, PublicKey } from "@solana/web3.js";
import { getMint, TOKEN_PROGRAM_ID, AccountLayout } from "@solana/spl-token";

let cache:
  | {
      at: number;
      data: { holders: Array<{ wallet: string; balance: number }> };
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

function minRawThreshold(decimals: number): bigint {
  const safeDec = Math.max(0, decimals | 0);
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

    const mintInfo = await getMint(conn, mintPk);
    const decimals = typeof mintInfo?.decimals === "number" ? mintInfo.decimals : 0;
    const minRaw = minRawThreshold(decimals);

    const accounts = await conn.getProgramAccounts(TOKEN_PROGRAM_ID, {
      filters: [
        { dataSize: 165 },
        { memcmp: { offset: 0, bytes: mintPk.toBase58() } },
      ],
      commitment: "processed",
    });

    const perOwner = new Map<string, bigint>();
    for (let i = 0; i < accounts.length; i++) {
      try {
        const acc = accounts[i];
        const data = AccountLayout.decode(acc.account.data);
        const owner = new PublicKey(data.owner).toBase58().toLowerCase();
        const amt = BigInt(data.amount.toString());
        if (amt > BigInt(0)) {
          const prev = perOwner.has(owner) ? perOwner.get(owner)! : BigInt(0);
          perOwner.set(owner, prev + amt);
        }
      } catch {
        /* ignore */
      }
    }

    const blacklist = parseBlacklist();
    const denom = Math.pow(10, decimals || 0);
    const holders = Array.from(perOwner.entries())
      .filter(function (entry) {
        const owner = entry[0];
        const raw = entry[1];
        return raw >= minRaw && !blacklist.has(owner);
      })
      .map(function (entry) {
        const owner = entry[0];
        const raw = entry[1];
        return { wallet: owner, balance: Number(raw) / denom };
      })
      .sort(function (a, b) {
        return b.balance - a.balance;
      });

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
