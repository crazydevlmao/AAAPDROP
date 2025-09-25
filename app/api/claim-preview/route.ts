// app/api/claim-preview/route.ts
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

import { NextResponse } from "next/server";
import {
  connection,
  buildClaimTx,
  pubkeyFromEnv,
  getMintTokenProgramId,
  PUMP_MINT,
} from "@/lib/solana";
import { PublicKey } from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { db } from "@/lib/db";

// ⚠️ Must match snapshot.ts semantics
const DECIMALS = 6;
const TEN_POW_DEC = Math.pow(10, DECIMALS);
const ENTITLEMENT_IS_RAW =
  String(process.env.ENTITLEMENT_IS_RAW || "").toLowerCase() === "true";

const noStore = { headers: { "cache-control": "no-store" } };

export async function POST(req: Request) {
  try {
    const { wallet } = await req.json();
    if (!wallet) {
      return NextResponse.json(
        { ok: false, note: "Missing wallet" },
        { status: 400, ...noStore }
      );
    }

    const userPk = new PublicKey(String(wallet).trim());
    const userLc = userPk.toBase58().toLowerCase();

    // Gather ALL unclaimed entitlements for this wallet
    const rows = await db.listWalletEntitlements(userLc);
    const unclaimed = rows.filter((r: any) => !r.claimed);
    const snapshotIds = unclaimed.map((r: any) => String(r.snapshotId));

    // Sum amount (convert to UI units if stored as raw)
    const amountUi = unclaimed.reduce((sum: number, r: any) => {
      const a = Number(r.amount || 0);
      if (!Number.isFinite(a) || a <= 0) return sum;
      return sum + (ENTITLEMENT_IS_RAW ? a / TEN_POW_DEC : a);
    }, 0);

    if (!Number.isFinite(amountUi) || amountUi <= 0 || snapshotIds.length === 0) {
      return NextResponse.json(
        { ok: true, note: "No unclaimed $PUMP.", amount: 0 },
        noStore
      );
    }

    const conn = connection();
    const treasuryPubkey = pubkeyFromEnv("NEXT_PUBLIC_TREASURY");

    // Detect correct Token Program for the mint (classic vs 2022)
    const tokenProgramId = await getMintTokenProgramId(conn, PUMP_MINT);

    // Sanity-check: Treasury ATA should exist for this program
    const fromAta = getAssociatedTokenAddressSync(
      PUMP_MINT,
      treasuryPubkey,
      false,
      tokenProgramId
    );
    const fromInfo = await conn.getAccountInfo(fromAta, "confirmed");
    if (!fromInfo) {
      return NextResponse.json(
        {
          ok: false,
          note:
            "Treasury token account not found for this mint/program. Verify treasury holds $PUMP and the correct token program (Token-2022 vs classic).",
        },
        { status: 409, ...noStore }
      );
    }

    // Build UNSIGNED tx (user is fee payer; Phantom signs first)
    const tx = await buildClaimTx({
      conn,
      treasuryPubkey,
      user: userPk,
      amountPump: amountUi,
      teamWallet: treasuryPubkey, // not used in current flow
      tokenProgramId,
    });

    return NextResponse.json(
      {
        ok: true,
        txBase64: tx.txB64,
        amount: tx.amount,
        feeSol: tx.feeSol,
        snapshotIds,
      },
      noStore
    );
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: String(e?.message || e) },
      { status: 500, ...noStore }
    );
  }
}
