// app/api/claim-report/route.ts
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

import { NextResponse } from "next/server";
import { db } from "@/lib/db";

/* ===== Config ===== */
const DROP_SECRET = process.env.DROP_SECRET || "";
const RATE_PER_MIN_IP = 30;       // posting report is rarer; keep lower than preview
const RATE_PER_MIN_WALLET = 60;   // generous but safe

/* ===== Helpers ===== */
const noStore = {
  headers: {
    "cache-control": "no-store, no-cache, must-revalidate, max-age=0",
    pragma: "no-cache",
    expires: "0",
  },
};
const json = (data: any, init?: ResponseInit) => NextResponse.json(data, { ...init, ...noStore });
const bad = (status: number, msg: string, extra?: any) => json({ ok: false, error: msg, ...extra }, { status });

const IP_BUCKET = new Map<string, { tokens: number; ts: number }>();
const WALLET_BUCKET = new Map<string, { tokens: number; ts: number }>();
function allow(bucket: Map<string, { tokens: number; ts: number }>, key: string, ratePerMin: number) {
  const now = Date.now();
  const refill = ratePerMin / 60000;
  const slot = bucket.get(key) ?? { tokens: ratePerMin, ts: now };
  const tokens = Math.min(ratePerMin, slot.tokens + (now - slot.ts) * refill);
  if (tokens < 1) { bucket.set(key, { tokens, ts: now }); return false; }
  bucket.set(key, { tokens: tokens - 1, ts: now });
  return true;
}
const cidOf = (req: Request) =>
  req.headers.get("x-request-id") ||
  req.headers.get("cf-ray") ||
  Math.random().toString(36).slice(2);

function looksLikeSig(s: string) {
  // Base58 sigs are usually 80–100 chars; quick sanity check only
  return /^[1-9A-HJ-NP-Za-km-z]{64,120}$/.test(s);
}

/* ===== Route ===== */
export async function POST(req: Request) {
  const cid = cidOf(req);
  try {
    // Optional shared secret
    if (DROP_SECRET) {
      const provided = req.headers.get("x-drop-secret") || "";
      if (provided !== DROP_SECRET) {
        console.warn(JSON.stringify({ cid, where: "claim-report", err: "bad_secret" }));
        return bad(401, "Unauthorized");
      }
    }

    // Rate limit
    const ip =
      (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() ||
      req.headers.get("x-real-ip") ||
      "unknown";
    if (!allow(IP_BUCKET, ip, RATE_PER_MIN_IP)) {
      console.warn(JSON.stringify({ cid, where: "claim-report", ip, err: "rate_limited_ip" }));
      return bad(429, "Too Many Requests (ip)");
    }

    const body = await req.json().catch(() => ({}));
    const wallet = String(body.wallet || "").trim();
    const walletLc = wallet.toLowerCase();
    const sig = String(body.sig || "").trim();
    const snapshotIds: string[] = Array.isArray(body.snapshotIds) ? body.snapshotIds.map(String) : [];
    const amtNum = Number(body.amount);
    const amount = Number.isFinite(amtNum) && amtNum > 0 ? amtNum : 0;

    if (!wallet || !walletLc || !looksLikeSig(sig) || snapshotIds.length === 0) {
      return bad(400, "Missing/invalid wallet, sig, or snapshotIds");
    }

    if (!allow(WALLET_BUCKET, walletLc, RATE_PER_MIN_WALLET)) {
      console.warn(JSON.stringify({ cid, where: "claim-report", wallet, err: "rate_limited_wallet" }));
      return bad(429, "Too Many Requests (wallet)");
    }

    // Mark entitlements claimed (DB expects lowercase wallet)
    await db.markEntitlementsClaimed(walletLc, snapshotIds, sig);

    // Record recent claim + totals (idempotent-ish: ignore duplicates by sig if DB enforces unique)
    let recorded = false;
    if (amount > 0) {
      try {
        await db.insertRecentClaim({
          wallet,   // preserve original case for UI
          amount,
          sig,
          ts: new Date().toISOString(),
        });
        recorded = true;
      } catch (e: any) {
        // If duplicate sig unique constraint exists, ignore
        if (!/unique|duplicate/i.test(String(e?.message || e))) throw e;
      }
      // Only bump totals if we actually recorded a new row
      if (recorded) {
        await db.addToTotalDistributed(amount);
      }
    }

    const solscan = `https://solscan.io/tx/${encodeURIComponent(sig)}`;

    console.info(
      JSON.stringify({
        cid,
        where: "claim-report",
        wallet,
        amount,
        snapshots: snapshotIds.length,
        recorded,
        sig,
      })
    );

    return json({ ok: true, sig, solscan });
  } catch (e: any) {
    console.error(JSON.stringify({ cid, where: "claim-report", error: String(e?.message || e) }));
    return bad(500, String(e?.message || e || "Internal Error"));
  }
}
