// app/api/metrics/route.ts
export const runtime = "nodejs";
export const dynamic = "force-dynamic"; // ensure this route never gets statically cached
export const revalidate = 0;

import { NextResponse } from "next/server";
import { pumpPriceInfo } from "@/lib/price";
import { db } from "@/lib/db";

/** Normalize different 24h change formats to a % number */
function normalizeChangeToPct(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  if (n > 0 && n < 2) return (n - 1) * 100; // multiplier -> %
  if (n > -1 && n < 1) return n * 100;      // decimal -> %
  return n;                                  // already a %
}

export async function GET() {
  try {
    // Persisted total: sums claims, or uses metrics.json if present
    const totalDistributedPump = await db.totalDistributedPump();

    // Live price info
    const { price, change24h } = await pumpPriceInfo();
    const pumpChangePct = normalizeChangeToPct(change24h);

    return NextResponse.json(
      {
        totalDistributedPump,          // <- shown as "Total $PUMP Distributed" in UI
        pumpPrice: Number(price) || 0, // guard NaN
        pumpChangePct,                 // clean percentage number
      },
      { headers: { "cache-control": "no-store" } }
    );
  } catch (e: any) {
    return NextResponse.json(
      {
        totalDistributedPump: 0,
        pumpPrice: 0,
        pumpChangePct: 0,
        error: String(e?.message || e),
      },
      { status: 500, headers: { "cache-control": "no-store" } }
    );
  }
}

/**
 * Optional: allow simple increments from client/server (you already post `add`)
 * This updates metrics.json and then returns the authoritative total (which
 * also falls back to summing claims if needed).
 */
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const add = Number(body?.add || 0);
    if (!Number.isFinite(add) || add < 0) {
      return NextResponse.json({ error: "invalid add" }, { status: 400 });
    }

    await db.addToTotalDistributed(add);
    const totalDistributedPump = await db.totalDistributedPump();

    return NextResponse.json(
      { ok: true, totalDistributedPump },
      { headers: { "cache-control": "no-store" } }
    );
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message || "metrics post failed" },
      { status: 500 }
    );
  }
}
