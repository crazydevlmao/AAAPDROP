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

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const walletFilter = (searchParams.get("wallet") || "").trim().toLowerCase();

    let rows;
    if (walletFilter) {
      rows = await db.recentClaimsByWallet(walletFilter, 50);
    } else {
      rows = await db.recentClaims(50);
    }

    // Normalize + enforce shape + newest first (defensive)
    const data: RecentClaim[] = (Array.isArray(rows) ? rows : [])
      .map((r: any) => ({
        wallet: String(r.wallet || r.owner || ""),
        amount: Number(r.amount || r.qty || 0),
        ts: r.ts ? new Date(r.ts).toISOString() : new Date().toISOString(),
        sig: String(r.sig || r.signature || ""),
      }))
      .filter((r) => r.wallet && r.sig)
      .sort((a, b) => +new Date(b.ts) - +new Date(a.ts))
      .slice(0, 50);

    return NextResponse.json(data, {
      headers: { "cache-control": "no-store" },
    });
  } catch (e: any) {
    return NextResponse.json(
      { error: "failed_to_load_recent_claims", message: String(e?.message || e) },
      { status: 500, headers: { "cache-control": "no-store" } }
    );
  }
}