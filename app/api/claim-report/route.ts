// app/api/claim-report/route.ts
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

import { NextResponse } from "next/server";
import { db } from "@/lib/db";

const noStore = { headers: { "cache-control": "no-store" } };

export async function POST(req: Request) {
  try {
    const body = await req.json();

    const wallet = String(body.wallet || "").trim();         // keep ORIGINAL CASE for UI/feed
    const walletLc = wallet.toLowerCase();                   // use lowercase for DB lookups
    const sig = String(body.sig || "").trim();
    const snapshotIds: string[] = Array.isArray(body.snapshotIds) ? body.snapshotIds : [];
    const amtNum = Number(body.amount);
    const amount = Number.isFinite(amtNum) && amtNum > 0 ? amtNum : 0;

    if (!wallet || !walletLc || !sig || snapshotIds.length === 0) {
      return NextResponse.json(
        { ok: false, error: "Missing wallet, sig, or snapshotIds" },
        { status: 400, ...noStore }
      );
    }

    // mark entitlements claimed (DB expects lowercase wallet)
    await db.markEntitlementsClaimed(walletLc, snapshotIds, sig);

    // persist recent claim + metrics (store ORIGINAL CASE for UI)
    if (amount > 0) {
      await db.insertRecentClaim({
        wallet,               // <- original case for front-end display
        amount,
        sig,
        ts: new Date().toISOString(),
      });
      await db.addToTotalDistributed(amount);
    }

    return NextResponse.json({ ok: true }, noStore);
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: String(e?.message || e) },
      { status: 500, ...noStore }
    );
  }
}
