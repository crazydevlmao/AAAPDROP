// app/api/claim-report/route.ts
export const runtime = "nodejs";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export async function POST(req: Request) {
  try {
    const body = await req.json();

    const wallet = String(body.wallet || "").trim();
    const walletLc = wallet.toLowerCase();
    const sig = String(body.sig || "").trim();
    const snapshotIds: string[] = Array.isArray(body.snapshotIds) ? body.snapshotIds : [];
    const amount = Number(body.amount || 0);

    if (!walletLc || !sig || snapshotIds.length === 0) {
      return NextResponse.json(
        { ok: false, error: "Missing wallet, sig, or snapshotIds" },
        { status: 400 }
      );
    }

    // mark entitlements claimed
    await db.markEntitlementsClaimed(walletLc, snapshotIds, sig);

    // persist into recent claims + metrics
    if (amount > 0) {
      await db.insertRecentClaim({
        wallet: walletLc,
        amount,
        sig,
        ts: new Date().toISOString(),
      });
      await db.addToTotalDistributed(amount);
    }

    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: String(e?.message || e) },
      { status: 500 }
    );
  }
}
