// app/api/claim-submit/route.ts
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

import { NextResponse } from "next/server";
import { connection, keypairFromEnv } from "@/lib/solana";
import { VersionedTransaction, PublicKey } from "@solana/web3.js";
import { db } from "@/lib/db";

/* ===== Config ===== */
// Do NOT require DROP_SECRET here (browser calls). If you set it, we only *accept* but don't require.
const DROP_SECRET = process.env.DROP_SECRET || "";
const RATE_PER_MIN_IP = 30;       // Relaying should be rare; keep tight.
const RATE_PER_MIN_WALLET = 30;   // Prevent rapid resubmits.

const noStore = {
  headers: {
    "cache-control": "no-store, no-cache, must-revalidate, max-age=0",
    pragma: "no-cache",
    expires: "0",
  },
};
const json = (data: any, init?: ResponseInit) => NextResponse.json(data, { ...init, ...noStore });
const bad = (status: number, msg: string, extra?: any) => json({ ok: false, error: msg, ...extra }, { status });

const IP_BUCKET = new Map<string, { tokens: number; ts: number }>();
const WALLET_BUCKET = new Map<string, { tokens: number; ts: number }>();
function allow(bucket: Map<string, { tokens: number; ts: number }>, key: string, ratePerMin: number) {
  const now = Date.now();
  const refill = ratePerMin / 60000;
  const slot = bucket.get(key) ?? { tokens: ratePerMin, ts: now };
  const tokens = Math.min(ratePerMin, slot.tokens + (now - slot.ts) * refill);
  if (tokens < 1) { bucket.set(key, { tokens, ts: now }); return false; }
  bucket.set(key, { tokens: tokens - 1, ts: now });
  return true;
}
const cidOf = (req: Request) =>
  req.headers.get("x-request-id") ||
  req.headers.get("cf-ray") ||
  Math.random().toString(36).slice(2);

function parseWallet(raw: any): PublicKey | null {
  try {
    const s = String(raw ?? "").trim();
    if (s.length < 32 || s.length > 64) return null;
    return new PublicKey(s);
  } catch {
    return null;
  }
}

export async function POST(req: Request) {
  const cid = cidOf(req);

  try {
    // Optional secret: if provided by client & env set, verify; otherwise ignore.
    if (DROP_SECRET) {
      const provided = req.headers.get("x-drop-secret");
      if (provided && provided !== DROP_SECRET) {
        console.warn(JSON.stringify({ cid, where: "claim-submit", err: "bad_secret" }));
        return bad(401, "Unauthorized");
      }
    }

    // Rate limit
    const ip =
      (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() ||
      req.headers.get("x-real-ip") ||
      "unknown";
    if (!allow(IP_BUCKET, ip, RATE_PER_MIN_IP)) {
      console.warn(JSON.stringify({ cid, where: "claim-submit", ip, err: "rate_limited_ip" }));
      return bad(429, "Too Many Requests (ip)");
    }

    const body = await req.json().catch(() => ({}));
    const userPk = parseWallet(body.wallet);
    const signedTxB64 = String(body.signedTxB64 || "").trim();
    const snapshotIds: string[] = Array.isArray(body.snapshotIds) ? body.snapshotIds.map(String) : [];
    const amtNum = Number(body.amount);
    const amount = Number.isFinite(amtNum) && amtNum > 0 ? amtNum : 0;

    if (!userPk || !signedTxB64 || snapshotIds.length === 0) {
      return bad(400, "Missing wallet, signedTxB64 or snapshotIds");
    }

    const userBase58 = userPk.toBase58();
    const userLc = userBase58.toLowerCase();

    if (!allow(WALLET_BUCKET, userLc, RATE_PER_MIN_WALLET)) {
      console.warn(JSON.stringify({ cid, where: "claim-submit", wallet: userBase58, err: "rate_limited_wallet" }));
      return bad(429, "Too Many Requests (wallet)");
    }

    const conn = connection();

    // Deserialize the user-signed tx (Phantom signs first)
    const raw = Buffer.from(signedTxB64, "base64");
    const bytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
    const tx = VersionedTransaction.deserialize(bytes);

    // Sanity: fee payer must be the user
    const feePayer = tx.message.staticAccountKeys[0];
    if (!feePayer.equals(userPk)) {
      return bad(400, "Invalid fee payer");
    }

    // Add server signer AFTER wallet signature
    const treasuryKp = keypairFromEnv("TREASURY_SECRET");
    tx.sign([treasuryKp]);

    // Relay with minimal RPC chatter:
    // - skipPreflight=true avoids extra simulate RPC
    // - retry a few times on transient errors / rate limits
    let sig = "";
    const maxAttempts = 4;
    const baseDelay = 400; // ms
    for (let i = 0; i < maxAttempts; i++) {
      try {
        sig = await conn.sendRawTransaction(tx.serialize(), {
          skipPreflight: true,
          maxRetries: 5,
          preflightCommitment: "confirmed",
        });
        break;
      } catch (err: any) {
        const msg = String(err?.message || err);
        const isRate = /rate|429|Too Many Requests|limit/i.test(msg);
        const isBusy = /blockhash.*not found|node is behind|transaction.*already processed/i.test(msg);
        if (i < maxAttempts - 1 && (isRate || isBusy)) {
          const delay = baseDelay * Math.pow(2, i);
          console.warn(JSON.stringify({ cid, where: "claim-submit", retry: i + 1, reason: msg.slice(0, 180) }));
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        console.error(JSON.stringify({ cid, where: "claim-submit", relay_error: msg }));
        return bad(502, "Upstream relay error", { detail: msg.slice(0, 200) });
      }
    }

    if (!sig) {
      return bad(502, "Failed to relay transaction");
    }

    // Single confirm (don’t dogpile). "confirmed" is enough for UX.
    try {
      await conn.confirmTransaction(sig, "confirmed");
    } catch (e: any) {
      // Not fatal for user UX; we still return sig (wallet shows status anyway)
      console.warn(JSON.stringify({ cid, where: "claim-submit", confirm_warn: String(e?.message || e) }));
    }

    // Mark entitlements claimed (idempotent) + metrics
    try {
      if ((db as any).markEntitlementsClaimed) {
        await (db as any).markEntitlementsClaimed(userLc, snapshotIds, sig);
      }
    } catch (e: any) {
      console.warn(JSON.stringify({ cid, where: "claim-submit", mark_warn: String(e?.message || e) }));
    }

    if (amount > 0) {
      try {
        await db.insertRecentClaim({
          wallet: userBase58, // original case for UI
          amount,
          sig,
          ts: new Date().toISOString(),
        });
        await db.addToTotalDistributed(amount);
      } catch (e: any) {
        // Ignore duplicates if DB enforces unique(sig)
        if (!/unique|duplicate/i.test(String(e?.message || e))) {
          console.warn(JSON.stringify({ cid, where: "claim-submit", recent_warn: String(e?.message || e) }));
        }
      }
    }

    const solscan = `https://solscan.io/tx/${encodeURIComponent(sig)}`;

    console.info(JSON.stringify({
      cid,
      where: "claim-submit",
      wallet: userBase58,
      sig,
      snapshots: snapshotIds.length,
      amount,
    }));

    return json({ ok: true, sig, solscan });
  } catch (e: any) {
    console.error(JSON.stringify({ cid, where: "claim-submit", error: String(e?.message || e) }));
    return bad(500, String(e?.message || e || "Internal Error"));
  }
}
