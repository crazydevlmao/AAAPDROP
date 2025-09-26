// app/api/claim-submit/route.ts
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

import { NextResponse } from "next/server";
import { connection, keypairFromEnv } from "@/lib/solana";
import { Connection, VersionedTransaction, PublicKey, clusterApiUrl } from "@solana/web3.js";
import { db } from "@/lib/db";
import { createHash } from "crypto";
import { MAX_PREVIEW_AGE_MS } from "@/app/api/claim-preview/route"; // import the shared TTL if same project

/* ===== Config ===== */
const DROP_SECRET = process.env.DROP_SECRET || "";
const RATE_PER_MIN_IP = 30;
const RATE_PER_MIN_WALLET = 30;

const FALLBACK_RPC =
  process.env.SOLANA_RPC_FALLBACK ||
  process.env.NEXT_PUBLIC_SOLANA_RPC_2 ||
  process.env.HELIUS_RPC_2 ||
  "";

/* ===== tiny helpers ===== */
const noStore = {
  headers: {
    "cache-control": "no-store, no-cache, must-revalidate, max-age=0",
    pragma: "no-cache",
    expires: "0",
  },
};
const json = (data: any, init?: ResponseInit) => NextResponse.json(data, { ...init, ...noStore });
const bad = (status: number, msg: string, extra?: any) => json({ ok: false, error: msg, ...extra }, { status });

const cidOf = (req: Request) =>
  req.headers.get("x-request-id") ||
  req.headers.get("cf-ray") ||
  Math.random().toString(36).slice(2);

type Bucket = { tokens: number; ts: number };
const IP_BUCKET = new Map<string, Bucket>();
const WALLET_BUCKET = new Map<string, Bucket>();
function allow(bucket: Map<string, Bucket>, key: string, ratePerMin: number) {
  const now = Date.now();
  const refill = ratePerMin / 60000;
  const slot = bucket.get(key) ?? { tokens: ratePerMin, ts: now };
  const tokens = Math.min(ratePerMin, slot.tokens + (now - slot.ts) * refill);
  if (tokens < 1) { bucket.set(key, { tokens, ts: now }); return false; }
  bucket.set(key, { tokens: tokens - 1, ts: now });
  return true;
}

function parseWallet(raw: any): PublicKey | null {
  try {
    const s = String(raw ?? "").trim();
    if (s.length < 32 || s.length > 64) return null;
    return new PublicKey(s);
  } catch { return null; }
}
function connFrom(url?: string) {
  return new Connection(url || (process.env.NEXT_PUBLIC_SOLANA_RPC || process.env.SOLANA_RPC || clusterApiUrl("mainnet-beta")), "confirmed");
}
function msgHashFromTxB64(txB64: string) {
  const tx = VersionedTransaction.deserialize(Buffer.from(txB64, "base64"));
  const m = tx.message.serialize();
  return createHash("sha256").update(m).digest("hex");
}
async function sendWithFallback(tx: VersionedTransaction, primary: Connection): Promise<string> {
  const maxAttempts = 4;
  const baseDelay = 400;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      return await primary.sendRawTransaction(tx.serialize(), {
        skipPreflight: true,
        maxRetries: 5,
        preflightCommitment: "confirmed",
      });
    } catch (err: any) {
      const msg = String(err?.message || err);
      const isRate = /rate|429|too many requests|limit/i.test(msg);
      const isBusy = /blockhash.*not found|node is behind|already processed/i.test(msg);
      if (i < maxAttempts - 1 && (isRate || isBusy)) {
        await new Promise(r => setTimeout(r, baseDelay * Math.pow(2, i)));
        continue;
      }
      if (FALLBACK_RPC && (isRate || isBusy)) {
        try {
          const fallbackConn = connFrom(FALLBACK_RPC);
          return await fallbackConn.sendRawTransaction(tx.serialize(), {
            skipPreflight: true,
            maxRetries: 5,
            preflightCommitment: "confirmed",
          });
        } catch (e: any) {
          throw new Error(`relay failed (fallback): ${String(e?.message || e)}`);
        }
      }
      throw new Error(`relay failed: ${msg}`);
    }
  }
  throw new Error("relay failed: attempts exhausted");
}

/* ===== Preview lookup (DB or in-memory fallback; mirrors claim-preview) ===== */
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
const MEM_PREVIEWS = (globalThis as any).__mem_previews__ || new Map<string, PreviewRow>();
const MEM_LATEST_BY_WALLET = (globalThis as any).__mem_latest_by_wallet__ || new Map<string, string>();
(globalThis as any).__mem_previews__ = MEM_PREVIEWS;
(globalThis as any).__mem_latest_by_wallet__ = MEM_LATEST_BY_WALLET;

async function getPreviewById(previewId: string): Promise<PreviewRow | null> {
  if ((db as any).getPreviewById) return (db as any).getPreviewById(previewId);
  return MEM_PREVIEWS.get(previewId) || null;
}
async function getLatestPreviewForWallet(walletLc: string): Promise<PreviewRow | null> {
  if ((db as any).getLatestPreviewForWallet) return (db as any).getLatestPreviewForWallet(walletLc);
  const pid = MEM_LATEST_BY_WALLET.get(walletLc);
  return pid ? (MEM_PREVIEWS.get(pid) || null) : null;
}
async function markPreviewConsumed(previewId: string) {
  if ((db as any).markPreviewConsumed) return (db as any).markPreviewConsumed(previewId);
  const row = MEM_PREVIEWS.get(previewId);
  if (row) row.consumed = true;
}

/* ===== Route ===== */
export async function POST(req: Request) {
  const cid = cidOf(req);

  try {
    if (DROP_SECRET) {
      const provided = req.headers.get("x-drop-secret");
      if (provided && provided !== DROP_SECRET) return bad(401, "Unauthorized");
    }

    // Rate limit
    const ip =
      (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() ||
      req.headers.get("x-real-ip") ||
      "unknown";
    if (!allow(IP_BUCKET, ip, RATE_PER_MIN_IP)) return bad(429, "Too Many Requests (ip)");

    const body = await req.json().catch(() => ({}));
    const userPk = parseWallet(body.wallet);
    const signedTxB64 = String(body.signedTxB64 || "").trim();
    const unsignedTxB64 = typeof body.unsignedTxB64 === "string" ? body.unsignedTxB64.trim() : "";
    const snapshotIds: string[] = Array.isArray(body.snapshotIds) ? body.snapshotIds.map(String) : [];
    const amtNum = Number(body.amount);
    const amountClient = Number.isFinite(amtNum) && amtNum > 0 ? amtNum : 0;
    const previewId = typeof body.previewId === "string" ? body.previewId.trim() : "";

    if (!userPk || !signedTxB64 || snapshotIds.length === 0) {
      return bad(400, "Missing wallet, signedTxB64 or snapshotIds");
    }
    const userBase58 = userPk.toBase58();
    const userLc = userBase58.toLowerCase();
    if (!allow(WALLET_BUCKET, userLc, RATE_PER_MIN_WALLET)) {
      return bad(429, "Too Many Requests (wallet)");
    }

    // === Re-derive entitlements server-side ===
    const ent = await db.listWalletEntitlements(userLc);
    const isInSnapshot = new Set(snapshotIds);
    let newlyUi = 0;
    let totalUi = 0;
    for (const r of ent) {
      if (!isInSnapshot.has(String(r.snapshotId))) continue;
      const a = Number(r.amount || 0);
      const ui = Number.isFinite(a) ? a : 0;
      totalUi += ui;
      if (!r.claimed) newlyUi += ui;
    }
    if (newlyUi <= 0) return bad(409, "Nothing left to claim for these snapshots");
    if (amountClient > 0 && amountClient - newlyUi > 1e-9) {
      return bad(400, "Amount exceeds unclaimed entitlements");
    }

    // === Deserialize the user-signed tx (Phantom signs first) ===
    const raw = Buffer.from(signedTxB64, "base64");
    const tx = VersionedTransaction.deserialize(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength));
    const feePayer = tx.message.staticAccountKeys[0];
    if (!feePayer.equals(userPk)) return bad(400, "Invalid fee payer");

    // === Preview integrity check ===
    // Preferred: verify against stored previewId
    let issued = previewId ? await getPreviewById(previewId) : null;
    if (!issued) issued = await getLatestPreviewForWallet(userLc); // fallback
    if (!issued) return bad(400, "no_preview_for_wallet");

    if (issued.consumed) return bad(409, "preview_already_used");

    if ((Date.now() - issued.createdAt) > MAX_PREVIEW_AGE_MS) {
      return bad(400, "preview_expired");
    }

    // Compare the signed message hash to the stored preview's message hash.
    const signedMsgHash = createHash("sha256").update(tx.message.serialize()).digest("hex");
    if (signedMsgHash !== issued.msgHash) {
      // Optional secondary check: if client provided unsigned tx, compare messages (helps debugging)
      if (unsignedTxB64) {
        try {
          const secondary = msgHashFromTxB64(unsignedTxB64);
          console.warn("preview_mismatch_secondary", { cid, wallet: userBase58, previewId: issued.previewId, issued: issued.msgHash, signed: signedMsgHash, clientUnsigned: secondary });
        } catch {}
      }
      return bad(400, "preview_mismatch");
    }

    // (Optional) verify snapshotIds match what we issued
    const a = new Set(issued.snapshotIds);
    if (snapshotIds.length !== issued.snapshotIds.length || snapshotIds.some(id => !a.has(id))) {
      return bad(400, "snapshot_mismatch");
    }

    // === Server co-sign & relay ===
    const treasuryKp = keypairFromEnv("TREASURY_SECRET");
    tx.sign([treasuryKp]);

    const primaryConn = connection();
    let sig = "";
    try {
      sig = await sendWithFallback(tx, primaryConn);
    } catch (e: any) {
      return bad(502, "Upstream relay error", { detail: String(e?.message || e).slice(0, 200) });
    }
    try { await primaryConn.confirmTransaction(sig, "confirmed"); } catch {}

    // Mark preview consumed & persist claim
    try { await markPreviewConsumed(issued.previewId); } catch {}
    try {
      if ((db as any).markEntitlementsClaimed) {
        await (db as any).markEntitlementsClaimed(userLc, snapshotIds, sig);
      }
    } catch {}

    try {
      await db.insertRecentClaim({ wallet: userBase58, amount: newlyUi, sig, ts: new Date().toISOString() });
    } catch {}
    try { await db.addToTotalDistributed(newlyUi); } catch {}

    const solscan = `https://solscan.io/tx/${encodeURIComponent(sig)}`;
    console.info(JSON.stringify({ cid, where: "claim-submit", wallet: userBase58, sig, snapshots: snapshotIds.length, newlyUi, previewId: issued.previewId }));

    return json({ ok: true, sig, solscan, claimed: newlyUi });
  } catch (e: any) {
    console.error(JSON.stringify({ cid, where: "claim-submit", error: String(e?.message || e) }));
    return bad(500, String(e?.message || e || "Internal Error"));
  }
}
