export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { PublicKey } from "@solana/web3.js";

/* Config */
const ENTITLEMENT_IS_RAW = String(process.env.ENTITLEMENT_IS_RAW || "").toLowerCase() === "true";
const TTL_MS = 15_000;

/* Small caches + RL */
type CacheRow = { at: number; data: { eligible: boolean; amount: number; snapshotIds: string[] } };
const WALLET_CACHE = new Map<string, CacheRow>();

type Bucket = { tokens: number; ts: number };
const IP_BUCKET = new Map<string, Bucket>();
const WALLET_BUCKET = new Map<string, Bucket>();

function allow(bucket: Map<string, Bucket>, key: string, rpm: number) {
  const now = Date.now();
  const refill = rpm / 60000;
  const slot = bucket.get(key) ?? { tokens: rpm, ts: now };
  const tokens = Math.min(rpm, slot.tokens + (now - slot.ts) * refill);
  if (tokens < 1) { bucket.set(key, { tokens, ts: now }); return false; }
  bucket.set(key, { tokens: tokens - 1, ts: now });
  return true;
}

function bad(status: number, msg: string) {
  return NextResponse.json({ ok: false, error: msg }, { status, headers: { "cache-control": "no-store" } });
}
function ok(data: any) {
  return NextResponse.json(data, { headers: { "cache-control": "no-store" } });
}

function parseWallet(s: string | null): string | null {
  try {
    if (!s) return null;
    const pk = new PublicKey(s.trim());
    return pk.toBase58().toLowerCase();
  } catch { return null; }
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const w = parseWallet(url.searchParams.get("wallet"));

  // basic RL
  const ip =
    (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() ||
    req.headers.get("x-real-ip") ||
    "unknown";
  if (!allow(IP_BUCKET, ip, 120)) return bad(429, "Too Many Requests (ip)");
  if (!w) return bad(400, "missing or invalid wallet");
  if (!allow(WALLET_BUCKET, w, 12)) return bad(429, "Too Many Requests (wallet)");

  // serve from cache
  const hit = WALLET_CACHE.get(w);
  const now = Date.now();
  if (hit && now - hit.at < TTL_MS) return ok(hit.data);

  // DB-only computation (no RPC)
  const rows = await db.listWalletEntitlements(w);
  let amountUi = 0;
  const snapshotIds: string[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r.claimed) continue;
    const a = Number(r.amount || 0);
    const ui = Number.isFinite(a) ? (ENTITLEMENT_IS_RAW ? a / 1e6 : a) : 0;
    if (ui > 0) {
      amountUi += ui;
      snapshotIds.push(String(r.snapshotId));
    }
  }

  const data = { eligible: amountUi > 0 && snapshotIds.length > 0, amount: amountUi, snapshotIds };
  WALLET_CACHE.set(w, { at: now, data });
  return ok(data);
}
