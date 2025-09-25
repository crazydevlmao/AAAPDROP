// app/api/claim-preview/route.ts
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  buildClaimTx,
  connection,
  keypairFromEnv,
  pubkeyFromEnv,
  PUMP_MINT,
  getMintTokenProgramId,
} from "@/lib/solana";
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddress } from "@solana/spl-token";

const DECIMALS = 6;
const TEN_POW_DEC = Math.pow(10, DECIMALS);
const ENTITLEMENT_IS_RAW = String(process.env.ENTITLEMENT_IS_RAW || "").toLowerCase() === "true";

function toNumberSafe(v: any): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") { const n = Number(v); return Number.isFinite(n) ? n : 0; }
  if (v && typeof v.toNumber === "function") { const n = Number(v.toNumber()); return Number.isFinite(n) ? n : 0; }
  return 0;
}
function isClaimedTrue(v: any): boolean {
  if (v === true || v === 1) return true;
  if (typeof v === "string") { const s = v.trim().toLowerCase(); return s === "true" || s === "1"; }
  return false;
}
function toUiAmount(n: any): number {
  const num = toNumberSafe(n);
  if (num <= 0) return 0;
  return ENTITLEMENT_IS_RAW ? num / TEN_POW_DEC : num;
}

async function readPumpUiFromOwner(conn: any, owner: PublicKey, tokenProgramId: PublicKey): Promise<{ ui: number; ata: PublicKey | null }> {
  try {
    const ata = await getAssociatedTokenAddress(PUMP_MINT, owner, false, tokenProgramId);
    const bal = await conn.getTokenAccountBalance(ata, "confirmed" as any);
    const ui = bal?.value?.uiAmount ?? 0;
    return { ui: typeof ui === "number" && isFinite(ui) ? ui : 0, ata };
  } catch {
    return { ui: 0, ata: null };
  }
}

/* Healthcheck for GET /api/claim-preview */
export async function GET() {
  return NextResponse.json({ ok: true, expects: "POST", usage: 'POST { wallet: "<base58>", debug?: true }' });
}

export async function POST(req: Request) {
  try {
    const { wallet, debug: wantDebug } = await req.json().catch(() => ({}));
    if (!wallet) {
      return NextResponse.json({ txBase64: null, amount: 0, feeSol: 0.01, snapshotIds: [], note: "No wallet" });
    }

    const userPk = new PublicKey(wallet);
    const walletLc = userPk.toBase58().toLowerCase();
    const conn = connection();

    // env
    const team = pubkeyFromEnv("TEAM_WALLET");
    const treasuryKp = keypairFromEnv("TREASURY_SECRET"); // signer == source owner

    // detect token program (Token-2020 vs Token-2022) for the PUMP mint
    const tokenProgramId = await getMintTokenProgramId(conn, PUMP_MINT);

    // 1) DB entitlements (use lowercased wallet for lookups)
    const rows: any[] = await db.listWalletEntitlements(walletLc);
    const unclaimedRows = rows.filter((r: any) => !isClaimedTrue(r?.claimed));
    const amountUi = unclaimedRows.reduce((a: number, r: any) => a + toUiAmount(r?.amount), 0);
    const snapshotIds = unclaimedRows
      .map((r: any) => (typeof r?.snapshotId === "string" ? r.snapshotId : null))
      .filter(Boolean) as string[];

    if (!(amountUi > 0)) {
      return NextResponse.json({
        txBase64: null, amount: 0, feeSol: 0.01, snapshotIds: [],
        note: "No Claimable $PUMP.",
        ...(wantDebug ? { debug: { rows: rows.length, unclaimedRows: unclaimedRows.length, amountUi, walletLc } } : {}),
      });
    }

    // 2) Probe **signer** treasury only (must match the key we can sign with)
    const signerTreasuryPub = treasuryKp.publicKey;
    const signerProbe = await readPumpUiFromOwner(conn, signerTreasuryPub, tokenProgramId);

    if (!signerProbe.ata) {
      return NextResponse.json({
        txBase64: null, amount: 0, feeSol: 0.01, snapshotIds: [],
        note: "Treasury token account not found for signer. Create ATA & fund it.",
        ...(wantDebug ? { debug: { amountUi, treasUi: signerProbe.ui, treasAta: null, signerTreasuryPub: signerTreasuryPub.toBase58(), tokenProgramId: tokenProgramId.toBase58() } } : {}),
      });
    }
    if (signerProbe.ui <= 0) {
      return NextResponse.json({
        txBase64: null, amount: 0, feeSol: 0.01, snapshotIds: [],
        note: "Treasury has no $PUMP available right now.",
        ...(wantDebug ? { debug: { amountUi, treasUi: signerProbe.ui, treasAta: signerProbe.ata.toBase58(), signerTreasuryPub: signerTreasuryPub.toBase58(), tokenProgramId: tokenProgramId.toBase58() } } : {}),
      });
    }

    // Cap by signer treasury balance
    const sendUi = Math.min(amountUi, signerProbe.ui);

    // Min unit guard
    const minUi = 1 / TEN_POW_DEC;
    if (sendUi < minUi) {
      return NextResponse.json({ txBase64: null, amount: 0, feeSol: 0.01, snapshotIds: [], note: "Below minimum transferable unit." });
    }

    // 3) Build tx
    const built = await buildClaimTx({
      conn,
      treasuryKp,
      user: userPk,
      amountPump: sendUi,
      teamWallet: team,
      tokenProgramId, // ← pass the detected program id
    });

    if (!built?.txB64) {
      return NextResponse.json({
        txBase64: null, amount: 0, feeSol: 0.01, snapshotIds: [],
        note: "Unable to build claim right now. Try again.",
        ...(wantDebug ? { debug: { amountUi, treasUi: signerProbe.ui, sendUi, signerTreasuryPub: signerTreasuryPub.toBase58(), tokenProgramId: tokenProgramId.toBase58() } } : {}),
      });
    }

    return NextResponse.json({
      txBase64: built.txB64,
      amount: built.amount ?? sendUi,
      feeSol: built.feeSol ?? 0.01,
      snapshotIds,
      ...(wantDebug ? { debug: { amountUi, treasUi: signerProbe.ui, sendUi, signerTreasuryPub: signerTreasuryPub.toBase58(), tokenProgramId: tokenProgramId.toBase58() } } : {}),
    });
  } catch (e: any) {
    return NextResponse.json({ txBase64: null, amount: 0, feeSol: 0.01, snapshotIds: [], error: String(e?.message || e) }, { status: 500 });
  }
}
