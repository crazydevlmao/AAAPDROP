// app/api/recent-claims/route.ts
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

import { NextResponse } from "next/server";
import { db } from "@/lib/db";

/** Shape your UI expects */
type RecentClaim = {
  wallet: string;
  amount: number;
  ts: string;   // ISO
  sig: string;  // transaction signature
};

/* ===== Config ===== */
const TTL_MS = 5000; // server-side cache to avoid DB stampedes

/* ===== Helpers ===== */
const noStore = {
  headers: {
    "cache-control": "no-store, no-cache, must-revalidate, max-age=0",
    pragma: "no-cache",
    expires: "0",
  },
};
const json = (data: any, init?: ResponseInit) => NextResponse.json(data, { ...init, ...noStore });

function cidOf(req: Request) {
  return (
    req.headers.get("x-request-id") ||
    req.headers.get("cf-ray") ||
    Math.random().toString(36).slice(2)
  );
}

/* ===== Per-IP rate limit ===== */
type Bucket = { tokens: number; ts: number };
const IP_BUCKET = new Map<string, Bucket>();
function allowIp(ip: string, ratePerMin: number) {
  const now = Date.now();
  const refill = ratePerMin / 60000;
  const slot = IP_BUCKET.get(ip) ?? { tokens: ratePerMin, ts: now };
  const tokens = Math.min(ratePerMin, slot.tokens + (now - slot.ts) * refill);
  if (tokens < 1) { IP_BUCKET.set(ip, { tokens, ts: now }); return false; }
  IP_BUCKET.set(ip, { tokens: tokens - 1, ts: now });
  return true;
}

/* ===== Cache & single-flight per key (wallet/all) ===== */
type CacheEntry = { at: number; data: RecentClaim[] };
const CACHE = new Map<string, CacheEntry>();
const PENDING = new Map<string, Promise<RecentClaim[]>>();

async function fetchClaims(key: string, walletFilter: string): Promise<RecentClaim[]> {
  let rows: any[] = [];
  if (walletFilter) {
    rows = await db.recentClaimsByWallet(walletFilter, 50);
  } else {
    rows = await db.recentClaims(50);
  }

  const data: RecentClaim[] = (Array.isArray(rows) ? rows : [])
    .map((r: any) => ({
      wallet: String(r.wallet || r.owner || ""),
      amount: Number(r.amount || r.qty || 0),
      ts: r.ts ? new Date(r.ts).toISOString() : new Date().toISOString(),
      sig: String(r.sig || r.signature || ""),
    }))
    .filter((r) => r.wallet && r.sig && Number.isFinite(r.amount))
    .sort((a, b) => +new Date(b.ts) - +new Date(a.ts))
    .slice(0, 50);

  CACHE.set(key, { at: Date.now(), data });
  return data;
}

export async function GET(req: Request) {
  const cid = cidOf(req);

  // Per-IP throttle (reads) — 120/min is plenty
  const ip =
    (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() ||
    req.headers.get("x-real-ip") ||
    "unknown";
  if (!allowIp(ip, 120)) {
    console.warn(JSON.stringify({ cid, where: "recent-claims.GET", ip, err: "rate_limited_ip" }));
    return json({ error: "Too Many Requests (ip)" }, { status: 429 });
  }

  try {
    const { searchParams } = new URL(req.url);
    const raw = (searchParams.get("wallet") || "").trim();
    const walletFilter = raw.toLowerCase();
    const key = walletFilter ? `w:${walletFilter}` : "all";

    const now = Date.now();
    const hit = CACHE.get(key);
    if (hit && now - hit.at < TTL_MS) {
      return json(hit.data);
    }

    if (!PENDING.has(key)) {
      PENDING.set(
        key,
        fetchClaims(key, walletFilter).finally(() => {
          // small gap to prevent stampede
          setTimeout(() => PENDING.delete(key), 50);
        })
      );
    }

    const data = await PENDING.get(key)!;
    console.info(JSON.stringify({ cid, where: "recent-claims.GET", key, count: data.length }));
    return json(data);
  } catch (e: any) {
    console.error(JSON.stringify({ cid, where: "recent-claims.GET", error: String(e?.message || e) }));
    const { searchParams } = new URL(req.url);
    const walletFilter = (searchParams.get("wallet") || "").trim().toLowerCase();
    const key = walletFilter ? `w:${walletFilter}` : "all";
    const hit = CACHE.get(key);
    if (hit) return json(hit.data); // serve stale
    return json({ error: "failed_to_load_recent_claims", message: String(e?.message || e) }, { status: 502 });
  }
}
