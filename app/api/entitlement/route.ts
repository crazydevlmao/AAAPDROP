// app/api/entitlement/route.ts
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { PublicKey } from "@solana/web3.js";

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

const ZERO_PAYLOAD = (wallet = "") => ({ wallet, entitled: 0, claimed: 0, unclaimed: 0 });

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
    const walletParam = (url.searchParams.get("wallet") || "").trim();
    const wantBreakdown = url.searchParams.get("breakdown") === "1";

    if (!walletParam) return json(ZERO_PAYLOAD(""));

    // Rate limit IP + wallet
    const ip =
      (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() ||
      req.headers.get("x-real-ip") ||
      "unknown";
    if (!allow(IP_BUCKET, ip, RATE_PER_MIN_IP)) {
      console.warn(JSON.stringify({ cid, where: "entitlement", ip, err: "rate_limited_ip" }));
      // still respond 200 with zeros to avoid UI churn
      return json({ ...ZERO_PAYLOAD(""), error: "Too Many Requests (ip)" });
    }

    // Validate wallet by trying to parse a PublicKey, but lower-case for DB lookups
    let walletLc = "";
    try {
      const pk = new PublicKey(walletParam);
      walletLc = pk.toBase58().toLowerCase();
    } catch {
      console.warn(JSON.stringify({ cid, where: "entitlement", warn: "invalid_wallet", walletParam }));
      return json(ZERO_PAYLOAD(walletParam));
    }

    if (!allow(WALLET_BUCKET, walletLc, RATE_PER_MIN_WALLET)) {
      console.warn(JSON.stringify({ cid, where: "entitlement", wallet: walletLc, err: "rate_limited_wallet" }));
      return json({ ...ZERO_PAYLOAD(walletParam), error: "Too Many Requests (wallet)" });
    }

    // Microcache
    const now = Date.now();
    const hit = ENT_CACHE.get(walletLc);
    if (hit && now - hit.at < ENT_CACHE_TTL_MS) {
      return json(hit.data);
    }

    // Read rows from DB (already stored in lowercase)
    const rows: any[] = (await (db as any).listWalletEntitlements?.(walletLc)) ?? [];

    let entitled = 0;
    let claimed = 0;
    const breakdown: Array<{ snapshotId: string; amountUi: number; claimed: boolean }> = [];

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i] || {};
      const amtUi = toUiAmount(r.amount);
      entitled += amtUi;
      const claimedHere = isClaimedTrue(r.claimed);
      if (claimedHere) claimed += amtUi;
      if (wantBreakdown) {
        breakdown.push({ snapshotId: String(r.snapshotId || ""), amountUi: amtUi, claimed: claimedHere });
      }
    }
    const unclaimed = Math.max(0, entitled - claimed);

    const payload = wantBreakdown
      ? { wallet: walletParam, entitled, claimed, unclaimed, breakdown }
      : { wallet: walletParam, entitled, claimed, unclaimed };

    ENT_CACHE.set(walletLc, { at: now, data: payload });

    console.info(JSON.stringify({
      cid, where: "entitlement", wallet: walletLc, rows: rows.length,
      entitled, claimed, unclaimed, raw: ENTITLEMENT_IS_RAW, breakdown: wantBreakdown ? breakdown.length : 0
    }));

    return json(payload);
  } catch (e: any) {
    console.error(JSON.stringify({ cid, where: "entitlement", error: String(e?.message || e) }));
    // Return zeros but don’t hard-fail the UI
    return json({ ...ZERO_PAYLOAD(""), error: String(e?.message || e || "Internal Error") });
  }
}
