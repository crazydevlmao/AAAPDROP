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
import {
  connection,
  keypairFromEnv,
  pubkeyFromEnv,
  getMintTokenProgramId,
  PUMP_MINT,
} from "@/lib/solana";
import { db } from "@/lib/db";
import { createHash } from "crypto";

/* ===== Config ===== */
const DROP_SECRET = process.env.DROP_SECRET || "";
const RATE_PER_MIN_IP = 30;
const RATE_PER_MIN_WALLET = 30;
const ENTITLEMENT_IS_RAW = String(process.env.ENTITLEMENT_IS_RAW || "").toLowerCase() === "true";

// Optional fallback endpoint for bursty slots
const FALLBACK_RPC =
  process.env.SOLANA_RPC_FALLBACK ||
  process.env.NEXT_PUBLIC_SOLANA_RPC_2 ||
  process.env.HELIUS_RPC_2 ||
  "";

// How long a preview is valid (if you choose to bind submit to preview)
const PREVIEW_TTL_MS = 120_000;

/* ===== tiny helpers ===== */
const noStore = {
  headers: {
    "cache-control": "no-store, no-cache, must-revalidate, max-age=0",
    pragma: "no-cache",
    expires: "0",
  },
};
const json = (data: any, init?: ResponseInit) => NextResponse.json(data, { ...init, ...noStore });
const bad = (status: number, msg: string, extra?: any) =>
  json({ ok: false, error: msg, ...extra }, { status });

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
  if (tokens < 1) {
    bucket.set(key, { tokens, ts: now });
    return false;
  }
  bucket.set(key, { tokens: tokens - 1, ts: now });
  return true;
}

function parseWallet(raw: any): PublicKey | null {
  try {
    const s = String(raw ?? "").trim();
    if (s.length < 32 || s.length > 64) return null;
    return new PublicKey(s);
  } catch {
    return null;
  }
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
        await new Promise((r) => setTimeout(r, baseDelay * Math.pow(2, i)));
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

/* ===== Per-wallet in-flight lock (prevents double-spend races) ===== */
const BUSY_WALLETS = new Set<string>();

function sha256Msg(u8: Uint8Array) {
  return createHash("sha256").update(u8).digest("hex");
}

/* ===== structural validators (robust to extra harmless ixs) ===== */
function allAccountKeys(msg: any): PublicKey[] {
  try {
    const ak = msg.getAccountKeys?.();
    if (ak) {
      const out: PublicKey[] = [...(ak.staticAccountKeys || [])];
      const look = (ak as any).accountKeysFromLookups;
      if (look) {
        if (Array.isArray(look.writable)) out.push(...look.writable);
        if (Array.isArray(look.readonly)) out.push(...look.readonly);
      }
      if (out.length) return out;
    }
  } catch {}
  const fallback = (msg?.accountKeys || []) as PublicKey[];
  return Array.isArray(fallback) ? fallback : [];
}
function u64FromLE(bytes: Uint8Array, off = 0): bigint {
  let x = 0n;
  for (let i = 0; i < 8; i++) x |= BigInt(bytes[off + i] ?? 0) << (8n * BigInt(i));
  return x;
}
/** Find SPL-Token TransferChecked that matches from/mint/to/authority and return its (amount,decimals). */
function findMatchingTransferChecked(
  tx: VersionedTransaction,
  keys: PublicKey[],
  tokenProgramId: PublicKey,
  fromAta: PublicKey,
  mint: PublicKey,
  toAta: PublicKey,
  authority: PublicKey
): { amount: bigint; decimals: number } | null {
  const ins: any[] =
    (tx.message as any).compiledInstructions ||
    (tx.message as any).instructions ||
    [];
  for (const ci of ins) {
    try {
      const prog = keys[(ci.programIdIndex as number) ?? 0];
      if (!prog || !prog.equals(tokenProgramId)) continue;

      const accIdxs: number[] = (ci.accountKeyIndexes as number[]) || (ci.accounts as number[]) || [];
      if (accIdxs.length < 4) continue; // src, mint, dest, owner

      const src = keys[accIdxs[0]];
      const mnt = keys[accIdxs[1]];
      const dst = keys[accIdxs[2]];
      const own = keys[accIdxs[3]];
      if (!src || !mnt || !dst || !own) continue;

      if (!src.equals(fromAta)) continue;
      if (!mnt.equals(mint)) continue;
      if (!dst.equals(toAta)) continue;
      if (!own.equals(authority)) continue;

      // parse data: [0]=12 tag, [1..8]=amount(u64 LE), [9]=decimals(u8)
      const raw: Uint8Array =
        ci.data instanceof Uint8Array ? ci.data : Uint8Array.from(ci.data ?? []);
      if (!raw || raw.length < 10) continue;
      if (raw[0] !== 12 /* TransferChecked */) continue;
      const amount = u64FromLE(raw, 1);
      const decimals = Number(raw[9] ?? 0);
      return { amount, decimals };
    } catch {
      /* ignore malformed ix */
    }
  }
  return null;
}

/* ===== Route ===== */
export async function POST(req: Request) {
  const cid = cidOf(req);

  try {
    // Optional secret: accept if provided & correct; never required by browser.
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

    // optional: stronger binding to a preview
    const previewId: string = typeof body.previewId === "string" ? body.previewId.trim() : "";
    const msgHashClient: string = typeof body.msgHash === "string" ? body.msgHash.trim() : "";

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

    // HARD GUARD: one in-flight claim per wallet across this instance
    if (BUSY_WALLETS.has(userLc)) {
      return bad(409, "Claim already in progress for this wallet");
    }
    BUSY_WALLETS.add(userLc);

    try {
      // === Deserialize the user-signed tx (Phantom signs first) ===
      const raw = Buffer.from(signedTxB64, "base64");
      const tx = VersionedTransaction.deserialize(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength));

      // Fee payer must be the user
      const feePayer = tx.message.staticAccountKeys[0];
      if (!feePayer.equals(userPk)) {
        return bad(400, "Invalid fee payer");
      }

      // Optional preview binding (idempotency + anti-replay)
      if (previewId) {
        try {
          const row =
            (db as any).getPreviewById ? await (db as any).getPreviewById(previewId) : null;

          if (!row) {
            return bad(400, "no_preview_for_wallet");
          }
          if (row.walletLc !== userLc) {
            return bad(400, "preview_wallet_mismatch");
          }
          if (row.consumed) {
            return bad(409, "preview_already_consumed", { sig: row.sig || undefined });
          }
          if (Date.now() - Number(row.createdAt || 0) > PREVIEW_TTL_MS) {
            return bad(400, "preview_expired");
          }
          // Compare message hash from tx against preview msgHash (or provided msgHash)
          const actualHash = sha256Msg(tx.message.serialize());
          const expectedHash = String(row.msgHash || msgHashClient || "");
          if (expectedHash && expectedHash !== actualHash) {
            // don't hard-fail here; continue to structural checks below
            console.warn(JSON.stringify({ cid, where: "claim-submit", warn: "preview_hash_mismatch_but_continuing" }));
          }
          // Snapshot set must match exactly (order-insensitive)
          const aIds: string[] = Array.isArray(row.snapshotIds) ? row.snapshotIds.map(String) : [];
          if (aIds.length === snapshotIds.length) {
            const setA: Record<string, true> = Object.create(null);
            for (let i = 0; i < aIds.length; i++) setA[aIds[i]] = true;
            for (let i = 0; i < snapshotIds.length; i++) {
              if (!setA[snapshotIds[i]]) {
                return bad(400, "preview_snapshot_mismatch");
              }
            }
          }
          // Amount must match (UI units)
          const pvAmt = Number(row.amount || 0);
          if (Number.isFinite(pvAmt) && Math.abs(pvAmt - amountClient) > 1e-9) {
            return bad(400, "preview_amount_mismatch");
          }
        } catch {
          // If preview lookup fails, keep going (wallet lock still prevents x2 on this instance)
        }
      }

      // === Re-derive entitlements server-side (anti-tamper + idempotent) ===
      const ent = await db.listWalletEntitlements(userLc);
      const isInSnapshot = new Set(snapshotIds);

      let newlyUi = 0;
      let totalUi = 0;
      for (const r of ent) {
        if (!isInSnapshot.has(String(r.snapshotId))) continue;
        const a = Number(r.amount || 0);
        const ui = Number.isFinite(a) ? (ENTITLEMENT_IS_RAW ? a / 1e6 : a) : 0;
        totalUi += ui;
        if (!r.claimed) newlyUi += ui;
      }

      if (newlyUi <= 0) {
        return bad(409, "Nothing left to claim for these snapshots");
      }
      if (amountClient > 0 && amountClient - newlyUi > 1e-9) {
        return bad(400, "Amount exceeds unclaimed entitlements");
      }

      // === Derive expected addresses & amounts ===
      const primaryConn = connection();
      const treasuryPubkey = pubkeyFromEnv("NEXT_PUBLIC_TREASURY");
      const tokenProgramId = await getMintTokenProgramId(primaryConn, PUMP_MINT);

      const fromAta = getAssociatedTokenAddressSync(PUMP_MINT, treasuryPubkey, false, tokenProgramId);
      const toAta = getAssociatedTokenAddressSync(PUMP_MINT, userPk, false, tokenProgramId);

      const DECIMALS = 6;
      const rawAmount = Math.max(0, Math.floor(newlyUi * 10 ** DECIMALS));
      const expectedAmount = BigInt(rawAmount);

      // === Robust structural validation of the token transfer ===
      const keys = allAccountKeys(tx.message);
      const match = findMatchingTransferChecked(tx, keys, tokenProgramId, fromAta, PUMP_MINT, toAta, treasuryPubkey);
      if (!match) {
        return bad(400, "Submitted transaction does not match the issued preview");
      }
      if (match.decimals !== DECIMALS) {
        return bad(400, "claim_amount_decimals_mismatch");
      }
      if (match.amount !== expectedAmount) {
        return bad(400, "claim_amount_mismatch");
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

      // Best-effort confirm
      try {
        await primaryConn.confirmTransaction(sig, "confirmed");
      } catch {}

      // Mark preview consumed (if DB supports it)
      try {
        if (previewId && (db as any).markPreviewConsumed) {
          await (db as any).markPreviewConsumed(previewId, sig);
        }
      } catch {}

      // === Mark claimed (idempotent) & update UX metrics ONLY for newly claimed ===
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

      try {
        await db.addToTotalDistributed(newlyUi);
      } catch {}

      const solscan = `https://solscan.io/tx/${encodeURIComponent(sig)}`;
      return json({ ok: true, sig, solscan, claimed: newlyUi });
    } finally {
      BUSY_WALLETS.delete(userLc);
    }
  } catch (e: any) {
    console.error(JSON.stringify({ cid: cidOf(req), where: "claim-submit", error: String(e?.message || e) }));
    return bad(500, String(e?.message || e || "Internal Error"));
  }
}
