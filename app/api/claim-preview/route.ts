// app/api/claim-preview/route.ts
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

import { NextResponse } from "next/server";
import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  connection,
  buildClaimTx,
  pubkeyFromEnv,
  getMintTokenProgramId,
  PUMP_MINT,
} from "@/lib/solana";
import { db } from "@/lib/db";
import { createHash, randomUUID } from "crypto";

/* ========= CONFIG & CONSTANTS ========= */
const DECIMALS = 6; // ⚠️ must match snapshot semantics
const TEN_POW_DEC = Math.pow(10, DECIMALS);
const ENTITLEMENT_IS_RAW = String(process.env.ENTITLEMENT_IS_RAW || "").toLowerCase() === "true";

// DO NOT require DROP_SECRET for this route — browsers cannot send it.
const RATE_PER_MIN_IP = 60;
const RATE_PER_MIN_WALLET = 120;

const PROGRAM_CACHE_TTL_MS = 5 * 60 * 1000;

// Tiny cache to absorb double-clicks (keeps same previewId/msgHash)
const PREVIEW_CACHE_TTL_MS = 2500;

// Server will reject previews older than this on submit (keep local; do NOT export)
const MAX_PREVIEW_AGE_MS = 120_000;

/* ========= HELPERS ========= */
const noStore = {
  headers: {
    "cache-control": "no-store, no-cache, must-revalidate, max-age=0",
    pragma: "no-cache",
    expires: "0",
  },
};
const json = (data: any, init?: ResponseInit) => NextResponse.json(data, { ...init, ...noStore });
const bad = (status: number, msg: string, extra?: any) => json({ ok: false, error: msg, ...extra }, { status });

function parseWallet(raw: any): PublicKey | null {
  try {
    const s = String(raw ?? "").trim();
    if (s.length < 32 || s.length > 64) return null;
    return new PublicKey(s);
  } catch { return null; }
}
const cidOf = (req: Request) =>
  req.headers.get("x-request-id") ||
  req.headers.get("cf-ray") ||
  Math.random().toString(36).slice(2);

function msgHashFromTxB64(txB64: string) {
  const tx = VersionedTransaction.deserialize(Buffer.from(txB64, "base64"));
  const m = tx.message.serialize();
  return createHash("sha256").update(m).digest("hex");
}

/* ========= RATE LIMITING ========= */
type Bucket = { tokens: number; ts: number };
const IP_BUCKET = new Map<string, Bucket>();
const WALLET_BUCKET = new Map<string, Bucket>();
function allow(bucket: Map<string, Bucket>, key: string, ratePerMin: number) {
  const now = Date.now();
  const refillPerMs = ratePerMin / 60000;
  const slot = bucket.get(key) ?? { tokens: ratePerMin, ts: now };
  const tokens = Math.min(ratePerMin, slot.tokens + (now - slot.ts) * refillPerMs);
  if (tokens < 1) { bucket.set(key, { tokens, ts: now }); return false; }
  bucket.set(key, { tokens: tokens - 1, ts: now });
  return true;
}

/* ========= PROGRAM/ATA CACHE ========= */
type ProgCache = { at: number; tokenProgramId: PublicKey; fromAta: PublicKey };
const PROG_CACHE = new Map<string, ProgCache>();
async function getProgramAndFromAta() {
  const key = "pump_prog";
  const now = Date.now();
  const hit = PROG_CACHE.get(key);
  if (hit && now - hit.at < PROGRAM_CACHE_TTL_MS) return hit;

  const conn = connection();
  const treasuryPubkey = pubkeyFromEnv("NEXT_PUBLIC_TREASURY");

  const tokenProgramId = await getMintTokenProgramId(conn, PUMP_MINT);
  const fromAta = getAssociatedTokenAddressSync(PUMP_MINT, treasuryPubkey, false, tokenProgramId);

  const fromInfo = await conn.getAccountInfo(fromAta, "confirmed");
  if (!fromInfo) {
    throw new Error(
      "Treasury token account not found for this mint/program. Verify treasury holds $PUMP and program (Token-2022 vs classic)."
    );
  }

  const val = { at: now, tokenProgramId, fromAta };
  PROG_CACHE.set(key, val);
  return val;
}

/* ========= PREVIEW PERSISTENCE (DB or in-memory fallback) ========= */
type PreviewRow = {
  previewId: string;
  walletLc: string;
  txB64: string;
  msgHash: string;
  snapshotIds: string[];
  amount: number;
  createdAt: number;
  consumed?: boolean;
};
const MEM_PREVIEWS = new Map<string, PreviewRow>();         // previewId -> row
const MEM_LATEST_BY_WALLET = new Map<string, string>();     // walletLc -> previewId

async function savePreview(row: PreviewRow) {
  if ((db as any).savePreview) return (db as any).savePreview(row);
  MEM_PREVIEWS.set(row.previewId, row);
  MEM_LATEST_BY_WALLET.set(row.walletLc, row.previewId);
}
async function getLatestPreviewForWallet(walletLc: string): Promise<PreviewRow | null> {
  if ((db as any).getLatestPreviewForWallet) return (db as any).getLatestPreviewForWallet(walletLc);
  const pid = MEM_LATEST_BY_WALLET.get(walletLc);
  return pid ? (MEM_PREVIEWS.get(pid) || null) : null;
}

/* ========= ROUTE ========= */
export async function POST(req: Request) {
  const cid = cidOf(req);

  try {
    // Rate limit
    const ip =
      (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() ||
      req.headers.get("x-real-ip") ||
      "unknown";
    if (!allow(IP_BUCKET, ip, RATE_PER_MIN_IP)) {
      console.warn(JSON.stringify({ cid, where: "claim-preview", ip, err: "rate_limited_ip" }));
      return bad(429, "Too Many Requests (ip)");
    }

    const body = await req.json().catch(() => ({}));
    const userPk = parseWallet(body.wallet);
    if (!userPk) return bad(400, "Missing or invalid wallet");

    const userBase58 = userPk.toBase58();
    const userLc = userBase58.toLowerCase();

    if (!allow(WALLET_BUCKET, userLc, RATE_PER_MIN_WALLET)) {
      console.warn(JSON.stringify({ cid, where: "claim-preview", wallet: userBase58, err: "rate_limited_wallet" }));
      return bad(429, "Too Many Requests (wallet)");
    }

    // Micro-cache to absorb accidental double-click storms
    {
      const latest = await getLatestPreviewForWallet(userLc);
      if (latest && Date.now() - latest.createdAt < PREVIEW_CACHE_TTL_MS) {
        return json({
          ok: true,
          txBase64: latest.txB64,
          amount: latest.amount,
          feeSol: 0,
          snapshotIds: latest.snapshotIds,
          now: Date.now(),
          previewId: latest.previewId,
          msgHash: latest.msgHash,
        });
      }
    }

    // Gather unclaimed entitlements (DB only)
    const rows = await db.listWalletEntitlements(userLc);
    const unclaimed = rows.filter((r: any) => !r.claimed);
    const snapshotIds: string[] = unclaimed.map((r: any) => String(r.snapshotId));

    const amountUi = unclaimed.reduce((sum: number, r: any) => {
      const a = Number(r.amount || 0);
      if (!Number.isFinite(a) || a <= 0) return sum;
      return sum + (ENTITLEMENT_IS_RAW ? a / TEN_POW_DEC : a);
    }, 0);

    if (!Number.isFinite(amountUi) || amountUi <= 0 || snapshotIds.length === 0) {
      return json({
        ok: true,
        txBase64: "",
        amount: 0,
        feeSol: 0,
        snapshotIds: [],
        now: Date.now(),
        previewId: null,
        msgHash: null,
      });
    }

    // Program/ATA discovery (cached)
    const { tokenProgramId } = await getProgramAndFromAta();

    // Build UNSIGNED tx (user pays fees)
    const conn = connection();
    const treasuryPubkey = pubkeyFromEnv("NEXT_PUBLIC_TREASURY");
    const built = await buildClaimTx({
      conn,
      treasuryPubkey,
      user: userPk,
      amountPump: amountUi,
      teamWallet: treasuryPubkey, // not used in current flow
      tokenProgramId,
    });

    const previewId = randomUUID();
    const msgHash = msgHashFromTxB64(built.txB64);
    await savePreview({
      previewId,
      walletLc: userLc,
      txB64: built.txB64,
      msgHash,
      snapshotIds,
      amount: built.amount,
      createdAt: Date.now(),
    });

    console.info(JSON.stringify({
      cid,
      where: "claim-preview",
      wallet: userBase58,
      previewId,
      amount: built.amount,
      snapshots: snapshotIds.length,
    }));

    return json({
      ok: true,
      txBase64: built.txB64,
      amount: built.amount,
      feeSol: built.feeSol,
      snapshotIds,
      now: Date.now(),
      previewId,
      msgHash,
      maxAgeMs: MAX_PREVIEW_AGE_MS,
    });
  } catch (e: any) {
    console.error(JSON.stringify({ cid: cidOf(req), where: "claim-preview", error: String(e?.message || e) }));
    const msg = String(e?.message || e || "Internal Error");
    const status = /not found for this mint\/program/i.test(msg) ? 409 : 500;
    return bad(status, msg);
  }
}
