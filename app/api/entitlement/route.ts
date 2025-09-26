// app/api/entitlement/route.ts
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

import { NextResponse } from "next/server";
import { db } from "@/lib/db";

/** Keep in sync with snapshot/claim-preview */
const DECIMALS = 6;
const TEN_POW_DEC = Math.pow(10, DECIMALS);
const ENTITLEMENT_IS_RAW = String(process.env.ENTITLEMENT_IS_RAW || "").toLowerCase() === "true";

/* ==== RL + Microcache ==== */
const RATE_PER_MIN_IP = 120;     // reads are cheap, but protect DB
const RATE_PER_MIN_WALLET = 60;  // per wallet throttling
type Bucket = { tokens: number; ts: number };
const IP_BUCKET = new Map<string, Bucket>();
const WALLET_BUCKET = new Map<string, Bucket>();
function allow(bucket: Map<string, Bucket>, key: string, ratePerMin: number) {
  const now = Date.now();
  const refill = ratePerMin / 60000;
  const slot = bucket.get(key) ?? { tokens: ratePerMin, ts: now };
  const tokens = Math.min(ratePerMin, slot.tokens + (now - slot.ts) * refill);
  if (tokens < 1) { bucket.set(key, { tokens, ts: now }); return false; }
  bucket.set(key, { tokens: tokens - 1, ts: now });
  return true;
}

// per-wallet microcache (avoid stampede on refresh spam)
type CacheEntry = { at: number; data: any };
const ENT_CACHE_TTL_MS = 2000;
const ENT_CACHE = new Map<string, CacheEntry>();

/* ==== Helpers ==== */
const noStore = {
  headers: {
    "cache-control": "no-store, no-cache, must-revalidate, max-age=0",
    pragma: "no-cache",
    expires: "0",
  },
};
const json = (data: any, init?: ResponseInit) => NextResponse.json(data, { ...init, ...noStore });
const bad = (status: number, msg: string) => json({ entitled: 0, claimed: 0, unclaimed: 0, error: msg }, { status });

const zero = { entitled: 0, claimed: 0, unclaimed: 0 };

function cidOf(req: Request) {
  return (
    req.headers.get("x-request-id") ||
    req.headers.get("cf-ray") ||
    Math.random().toString(36).slice(2)
  );
}

function toNumberSafe(v: any): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  if (v && typeof v.toNumber === "function") {
    const n = Number(v.toNumber());
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function isClaimedTrue(v: any): boolean {
  if (v === true || v === 1) return true;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    return s === "true" || s === "1" || s === "yes";
  }
  return false;
}

/** Convert DB amount to UI units honoring ENTITLEMENT_IS_RAW */
function toUiAmount(n: any): number {
  const num = toNumberSafe(n);
  if (num <= 0) return 0;
  return ENTITLEMENT_IS_RAW ? num / TEN_POW_DEC : num;
}

export async function GET(req: Request) {
  const cid = cidOf(req);
  try {
    const url = new URL(req.url);
    const walletRaw = (url.searchParams.get("wallet") || "").trim();
    if (!walletRaw) return json(zero);

    // Rate limit IP + wallet
    const ip =
      (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() ||
      req.headers.get("x-real-ip") ||
      "unknown";
    if (!allow(IP_BUCKET, ip, RATE_PER_MIN_IP)) {
      console.warn(JSON.stringify({ cid, where: "entitlement", ip, err: "rate_limited_ip" }));
      return bad(429, "Too Many Requests (ip)");
    }

    const walletLc = walletRaw.toLowerCase();
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(walletLc)) {
      return bad(400, "Invalid wallet");
    }
    if (!allow(WALLET_BUCKET, walletLc, RATE_PER_MIN_WALLET)) {
      console.warn(JSON.stringify({ cid, where: "entitlement", wallet: walletLc, err: "rate_limited_wallet" }));
      return bad(429, "Too Many Requests (wallet)");
    }

    // Microcache
    const now = Date.now();
    const hit = ENT_CACHE.get(walletLc);
    if (hit && now - hit.at < ENT_CACHE_TTL_MS) {
      return json(hit.data);
    }

    const rows: any[] = await db.listWalletEntitlements(walletLc);

    let entitled = 0;
    let claimed = 0;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i] || {};
      const ui = toUiAmount(r.amount);
      entitled += ui;
      if (isClaimedTrue(r.claimed)) claimed += ui;
    }
    const unclaimed = Math.max(0, entitled - claimed);

    const payload = { entitled, claimed, unclaimed };
    ENT_CACHE.set(walletLc, { at: now, data: payload });

    console.info(JSON.stringify({ cid, where: "entitlement", wallet: walletLc, rows: rows.length, entitled, claimed, unclaimed }));

    return json(payload);
  } catch (e: any) {
    console.error(JSON.stringify({ cid, where: "entitlement", error: String(e?.message || e) }));
    return bad(500, String(e?.message || e || "Internal Error"));
  }
}
