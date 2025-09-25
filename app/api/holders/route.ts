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

/** ===== In-memory cache ===== */
let cache:
  | { at: number; data: { holders: Array<{ wallet: string; balance: number }> } }
  | null = null;

const TTL_MS = 2000;
const COMMITMENT: Commitment = "confirmed";

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

async function fetchMintDecimals(conn: Connection, mintPk: PublicKey): Promise<number> {
  try {
    const mi = await getMint(conn, mintPk, COMMITMENT, TOKEN_PROGRAM_ID);
    if (typeof mi.decimals === "number") return mi.decimals;
  } catch {}
  try {
    const mi = await getMint(conn, mintPk, COMMITMENT, TOKEN_2022_PROGRAM_ID);
    if (typeof mi.decimals === "number") return mi.decimals;
  } catch {}
  return 6;
}

// Legacy SPL (fixed 165-byte accounts)
async function scanLegacy(
  conn: Connection,
  mintPk: PublicKey
): Promise<Map<string, bigint>> {
  const perOwner = new Map<string, bigint>();
  const accounts = await conn.getProgramAccounts(TOKEN_PROGRAM_ID, {
    filters: [
      { dataSize: 165 },
      { memcmp: { offset: 0, bytes: mintPk.toBase58() } },
    ],
    commitment: COMMITMENT,
  });
  for (const acc of accounts) {
    try {
      const data = AccountLayout.decode(acc.account.data);
      const owner = new PublicKey(data.owner).toBase58().toLowerCase();
      const amt = BigInt(data.amount.toString());
      if (amt > 0n) perOwner.set(owner, (perOwner.get(owner) ?? 0n) + amt);
    } catch {}
  }
  return perOwner;
}

// Token-2022 (TLV); use parsed accounts (no 165 filter)
async function scanToken2022(
  conn: Connection,
  mintPk: PublicKey
): Promise<Map<string, bigint>> {
  const perOwner = new Map<string, bigint>();
  const parsed = await conn.getParsedProgramAccounts(TOKEN_2022_PROGRAM_ID, {
    filters: [{ memcmp: { offset: 0, bytes: mintPk.toBase58() } }],
    commitment: COMMITMENT,
  });
  for (const item of parsed) {
    try {
      const info: any = (item.account.data as any).parsed?.info;
      if (!info) continue;
      const owner = String(info.owner || "").toLowerCase();
      const rawStr = info.tokenAmount?.amount ?? "0";
      const amt = BigInt(rawStr);
      if (owner && amt > 0n) perOwner.set(owner, (perOwner.get(owner) ?? 0n) + amt);
    } catch {}
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

    const MINT_STR = process.env.NEXT_PUBLIC_COIN_MINT || process.env.COIN_MINT || "";
    if (!MINT_STR) {
      return NextResponse.json({ holders: [] }, { headers: { "cache-control": "no-store" } });
    }

    const mintPk = new PublicKey(MINT_STR);
    const conn = new Connection(pickRpc(), COMMITMENT);
    const decimals = await fetchMintDecimals(conn, mintPk);

    const tenK = 10_000;
    const minRaw = BigInt(Math.floor(tenK * Math.pow(10, decimals)));

    const [legacy, tok2022] = await Promise.all([
      scanLegacy(conn, mintPk).catch(() => new Map<string, bigint>()),
      scanToken2022(conn, mintPk).catch(() => new Map<string, bigint>()),
    ]);

    const perOwner = new Map<string, bigint>();
    for (const [k, v] of legacy.entries()) perOwner.set(k, (perOwner.get(k) ?? 0n) + v);
    for (const [k, v] of tok2022.entries()) perOwner.set(k, (perOwner.get(k) ?? 0n) + v);

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

    return NextResponse.json(data, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    console.error("holders route error:", e);
    return NextResponse.json(
      { holders: [] },
      { headers: { "cache-control": "no-store" } }
    );
  }
}
