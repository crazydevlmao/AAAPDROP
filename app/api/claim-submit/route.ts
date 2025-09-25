// app/api/claim-submit/route.ts
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

import { NextResponse } from "next/server";
import { connection, keypairFromEnv } from "@/lib/solana";
import { VersionedTransaction, PublicKey } from "@solana/web3.js";
import { db } from "@/lib/db";

const noStore = { headers: { "cache-control": "no-store" } };

export async function POST(req: Request) {
  try {
    const { wallet, signedTxB64, snapshotIds = [], amount = 0 } = await req.json();

    if (!wallet || !signedTxB64 || !Array.isArray(snapshotIds) || snapshotIds.length === 0) {
      return NextResponse.json(
        { ok: false, error: "Missing wallet, signedTxB64 or snapshotIds" },
        { status: 400, ...noStore }
      );
    }

    const userPk = new PublicKey(String(wallet).trim());
    const userLc = userPk.toBase58().toLowerCase();
    const conn = connection();

    // Deserialize the user-signed tx (Phantom signs first)
    const raw = Buffer.from(signedTxB64, "base64");
    const bytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
    const tx = VersionedTransaction.deserialize(bytes);

    // Sanity: fee payer must be the user
    const feePayer = tx.message.staticAccountKeys[0];
    if (!feePayer.equals(userPk)) {
      return NextResponse.json({ ok: false, error: "Invalid fee payer" }, { status: 400, ...noStore });
    }

    // Add server signer AFTER wallet signature (Phantom Lighthouse order)
    const treasuryKp = keypairFromEnv("TREASURY_SECRET");
    tx.sign([treasuryKp]);

    // Relay fully-signed tx
    const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
    await conn.confirmTransaction(sig, "confirmed");

    // Mark entitlements claimed (idempotent) using lowercase wallet + the tx signature
    try {
      if ((db as any).markEntitlementsClaimed) {
        await (db as any).markEntitlementsClaimed(userLc, snapshotIds, sig);
      }
    } catch {}

    // Persist recent claim + metrics using ORIGINAL-CASE wallet for nicer UI
    const amt = Number(amount);
    if (Number.isFinite(amt) && amt > 0) {
      try {
        await db.insertRecentClaim({
          wallet: userPk.toBase58(),
          amount: amt,
          sig,
          ts: new Date().toISOString(),
        });
        await db.addToTotalDistributed(amt);
      } catch {}
    }

    return NextResponse.json({ ok: true, sig }, noStore);
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 500, ...noStore });
  }
}
