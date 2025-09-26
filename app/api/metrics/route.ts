// app/api/metrics/route.ts
export const runtime = "nodejs";
export const dynamic = "force-dynamic"; // never statically cached
export const revalidate = 0;
export const fetchCache = "force-no-store";

import { NextResponse } from "next/server";
import { pumpPriceInfo } from "@/lib/price";
import { db } from "@/lib/db";

/* ===== Config ===== */
const TTL_MS = 10_000; // server-side cache for price + total (protects upstream)
const DROP_SECRET = process.env.DROP_SECRET || "";

/* ===== Cache & single-flight ===== */
type Metrics = { totalDistributedPump: number; pumpPrice: number; pumpChangePct: number };
let cache: { at: number; data: Metrics } | null = null;
let pending: Promise<Metrics> | null = null;

/* ===== Rate limiting (IP) ===== */
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

/* ===== Helpers ===== */
const noStore = {
  headers: {
    "cache-control": "no-store, no-cache, must-revalidate, max-age=0",
    pragma: "no-cache",
    expires: "0",
  },
};
const json = (data: any, init?: ResponseInit) => NextResponse.json(data, { ...init, ...noStore });
const bad = (status: number, msg: string, extra?: any) => json({ error: msg, ...extra }, { status });

function cidOf(req?: Request) {
  return (
    req?.headers.get("x-request-id") ||
    req?.headers.get("cf-ray") ||
    Math.random().toString(36).slice(2)
  );
}

/** Normalize different 24h change formats to a % number */
function normalizeChangeToPct(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  if (n > 0 && n < 2) return (n - 1) * 100; // multiplier -> %
  if (n > -1 && n < 1) return n * 100;      // decimal -> %
  return n;                                  // already a %
}

async function computeMetrics(): Promise<Metrics> {
  const [totalDistributedPump, priceInfo] = await Promise.all([
    db.totalDistributedPump(),
    pumpPriceInfo().catch(() => ({ price: 0, change24h: 0 } as any)),
  ]);
  const pumpPrice = Number(priceInfo?.price) || 0;
  const pumpChangePct = normalizeChangeToPct(priceInfo?.change24h);
  return { totalDistributedPump, pumpPrice, pumpChangePct };
}

/* ===== GET ===== */
export async function GET(req: Request) {
  const cid = cidOf(req);
  // Light per-IP throttle: 120/min is plenty (server cache prevents dogpiles)
  const ip =
    (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() ||
    req.headers.get("x-real-ip") ||
    "unknown";
  if (!allowIp(ip, 120)) {
    console.warn(JSON.stringify({ cid, where: "metrics.GET", ip, err: "rate_limited_ip" }));
    return bad(429, "Too Many Requests (ip)");
  }

  try {
    const now = Date.now();
    if (cache && now - cache.at < TTL_MS) {
      return json(cache.data);
    }

    if (!pending) {
      pending = computeMetrics()
        .then((data) => {
          cache = { at: Date.now(), data };
          return data;
        })
        .finally(() => {
          // brief gap to avoid immediate reflood after resolve
          setTimeout(() => { pending = null; }, 50);
        });
    }

    const data = await pending;
    console.info(JSON.stringify({ cid, where: "metrics.GET", price: data.pumpPrice, total: data.totalDistributedPump }));
    return json(data);
  } catch (e: any) {
    console.error(JSON.stringify({ cid, where: "metrics.GET", error: String(e?.message || e) }));
    // Serve stale cache on failure
    if (cache) return json(cache.data);
    return json({ totalDistributedPump: 0, pumpPrice: 0, pumpChangePct: 0, error: "metrics failed" }, { status: 502 });
  }
}

/* ===== POST (increment total) ===== */
export async function POST(req: Request) {
  const cid = cidOf(req);
  try {
    // Optional shared secret for mutation
    if (DROP_SECRET) {
      const provided = req.headers.get("x-drop-secret") || "";
      if (provided !== DROP_SECRET) {
        console.warn(JSON.stringify({ cid, where: "metrics.POST", err: "bad_secret" }));
        return bad(401, "Unauthorized");
      }
    }

    const body = await req.json().catch(() => ({}));
    const add = Number(body?.add || 0);
    if (!Number.isFinite(add) || add < 0) {
      return bad(400, "invalid add");
    }

    await db.addToTotalDistributed(add);
    const totalDistributedPump = await db.totalDistributedPump();

    // Invalidate cache (cheap) so GET refreshes next time
    cache = null;

    console.info(JSON.stringify({ cid, where: "metrics.POST", add, total: totalDistributedPump }));
    return json({ ok: true, totalDistributedPump });
  } catch (e: any) {
    console.error(JSON.stringify({ cid, where: "metrics.POST", error: String(e?.message || e) }));
    return bad(500, "metrics post failed");
  }
}
