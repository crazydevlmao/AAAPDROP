// app/api/claim-submit/route.ts
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

import { NextResponse } from "next/server";
import {
  Connection,
  VersionedTransaction,
  PublicKey,
  clusterApiUrl,
  ComputeBudgetProgram,
  TransactionMessage,
  SystemProgram,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
} from "@solana/spl-token";
import { connection, keypairFromEnv, pubkeyFromEnv, getMintTokenProgramId, PUMP_MINT } from "@/lib/solana";
import { db } from "@/lib/db";

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
  return new Connection(
    url || (process.env.NEXT_PUBLIC_SOLANA_RPC || process.env.SOLANA_RPC || clusterApiUrl("mainnet-beta")),
    "confirmed"
  );
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
        const fallbackConn = connFrom(FALLBACK_RPC);
        return await fallbackConn.sendRawTransaction(tx.serialize(), {
          skipPreflight: true,
          maxRetries: 5,
          preflightCommitment: "confirmed",
        });
      }
      throw new Error(`relay failed: ${msg}`);
    }
  }
  throw new Error("relay failed: attempts exhausted");
}

/* ===== Route ===== */
export async function POST(req: Request) {
  const cid = cidOf(req);

  try {
    // Optional secret: if provided & mismatched, reject; never required.
    if (DROP_SECRET) {
      const provided = req.headers.get("x-drop-secret");
      if (provided && provided !== DROP_SECRET) {
        return bad(401, "Unauthorized");
      }
    }

    // Rate limit
    const ip =
      (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() ||
      req.headers.get("x-real-ip") ||
      "unknown";
    if (!allow(IP_BUCKET, ip, RATE_PER_MIN_IP)) {
      return bad(429, "Too Many Requests (ip)");
    }

    const body = await req.json().catch(() => ({}));

    const userPk = parseWallet(body.wallet);
    const signedTxB64 = String(body.signedTxB64 || "").trim();
    const snapshotIds: string[] = Array.isArray(body.snapshotIds) ? body.snapshotIds.map(String) : [];
    const amtNum = Number(body.amount);
    const amountClient = Number.isFinite(amtNum) && amtNum > 0 ? amtNum : 0;

    if (!userPk || !signedTxB64 || snapshotIds.length === 0) {
      return bad(400, "Missing wallet, signedTxB64 or snapshotIds");
    }

    const userBase58 = userPk.toBase58();
    const userLc = userBase58.toLowerCase();

    if (!allow(WALLET_BUCKET, userLc, RATE_PER_MIN_WALLET)) {
      return bad(429, "Too Many Requests (wallet)");
    }

    // === Re-derive entitlements server-side (anti-tamper + idempotent) ===
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

    if (newlyUi <= 0) {
      return bad(409, "Nothing left to claim for these snapshots");
    }
    if (amountClient > 0 && amountClient - newlyUi > 1e-9) {
      return bad(400, "Amount exceeds unclaimed entitlements");
    }

    // === Deserialize the user-signed tx (Phantom signs first) ===
    const raw = Buffer.from(signedTxB64, "base64");
    const tx = VersionedTransaction.deserialize(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength));

    // Fee payer must be the user
    const feePayer = tx.message.staticAccountKeys[0];
    if (!feePayer.equals(userPk)) {
      return bad(400, "Invalid fee payer");
    }

    // === Build the EXPECTED claim message (with the SAME blockhash the user signed) ===
    const primaryConn = connection();
    const treasuryPubkey = pubkeyFromEnv("NEXT_PUBLIC_TREASURY");
    const tokenProgramId = await getMintTokenProgramId(primaryConn, PUMP_MINT);

    const fromAta = getAssociatedTokenAddressSync(PUMP_MINT, treasuryPubkey, false, tokenProgramId);
    const toAta   = getAssociatedTokenAddressSync(PUMP_MINT, userPk,        false, tokenProgramId);

    const DECIMALS = 6;
    const rawAmount = Math.max(0, Math.floor(newlyUi * 10 ** DECIMALS));

    const CLAIM_FEE_SOL_RAW = Number(process.env.CLAIM_FEE_SOL ?? "0.01");
    const CLAIM_FEE_SOL = Number.isFinite(CLAIM_FEE_SOL_RAW) ? Math.max(0, CLAIM_FEE_SOL_RAW) : 0.01;
    const feeLamports = Math.max(0, Math.floor(CLAIM_FEE_SOL * 1_000_000_000));

    const expectedIxs = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }),
      createAssociatedTokenAccountIdempotentInstruction(
        userPk,        // payer
        fromAta,       // treasury ATA
        treasuryPubkey,
        PUMP_MINT,
        tokenProgramId
      ),
      createAssociatedTokenAccountIdempotentInstruction(
        userPk,        // payer
        toAta,         // user ATA
        userPk,
        PUMP_MINT,
        tokenProgramId
      ),
      ...(feeLamports > 0
        ? [SystemProgram.transfer({ fromPubkey: userPk, toPubkey: treasuryPubkey, lamports: feeLamports })]
        : []),
      createTransferCheckedInstruction(
        fromAta,
        PUMP_MINT,
        toAta,
        treasuryPubkey,    // authority co-signed server-side
        rawAmount,
        DECIMALS,
        [],
        tokenProgramId
      ),
    ];

    // Use the SAME recentBlockhash as the signed tx so messages can match exactly
    const expectedMsg = new TransactionMessage({
      payerKey: userPk,
      recentBlockhash: tx.message.recentBlockhash,
      instructions: expectedIxs,
    }).compileToV0Message();

    const expectedMsgB64 = Buffer.from(expectedMsg.serialize()).toString("base64");
    const actualMsgB64   = Buffer.from(tx.message.serialize()).toString("base64");

    if (expectedMsgB64 !== actualMsgB64) {
      // Hard fail: user-signed message isn’t the allowed claim format/amount
      return bad(400, "Submitted transaction does not match the issued preview");
    }

    // === Server co-sign & relay ===
    const treasuryKp = keypairFromEnv("TREASURY_SECRET");
    tx.sign([treasuryKp]);

    let sig = "";
    try {
      sig = await sendWithFallback(tx, primaryConn);
    } catch (e: any) {
      return bad(502, "Upstream relay error", { detail: String(e?.message || e).slice(0, 200) });
    }

    // Non-blocking confirm
    try { await primaryConn.confirmTransaction(sig, "confirmed"); } catch {}

    // === Mark claimed (idempotent) & update metrics ONLY for newly claimed ===
    try {
      if ((db as any).markEntitlementsClaimed) {
        await (db as any).markEntitlementsClaimed(userLc, snapshotIds, sig);
      }
    } catch {}
    try {
      await db.insertRecentClaim({
        wallet: userBase58,
        amount: newlyUi,
        sig,
        ts: new Date().toISOString(),
      });
    } catch {}
    try { await db.addToTotalDistributed(newlyUi); } catch {}

    const solscan = `https://solscan.io/tx/${encodeURIComponent(sig)}`;

    console.info(JSON.stringify({
      cid,
      where: "claim-submit",
      wallet: userBase58,
      sig,
      snapshots: snapshotIds.length,
      newlyUi,
    }));

    return json({ ok: true, sig, solscan, claimed: newlyUi });
  } catch (e: any) {
    console.error(JSON.stringify({ cid, where: "claim-submit", error: String(e?.message || e) }));
    return bad(500, String(e?.message || e || "Internal Error"));
  }
}
