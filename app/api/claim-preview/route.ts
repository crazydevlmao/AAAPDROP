// app/api/claim-preview/route.ts
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

import { NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  connection,
  buildClaimTx,
  pubkeyFromEnv,
  getMintTokenProgramId,
  PUMP_MINT,
} from "@/lib/solana";
import { db } from "@/lib/db";

/* ========= CONFIG & CONSTANTS ========= */
const DECIMALS = 6; // ⚠️ must match snapshot semantics
const TEN_POW_DEC = Math.pow(10, DECIMALS);
const ENTITLEMENT_IS_RAW = String(process.env.ENTITLEMENT_IS_RAW || "").toLowerCase() === "true";

// DO NOT require DROP_SECRET for this route — browsers cannot send it.
// (Keep it for prepare-drop/snapshot/worker-only routes.)
const DROP_SECRET = process.env.DROP_SECRET || "";

// Gentle rate limits
const RATE_PER_MIN_IP = 60;      // 60 req/min per IP
const RATE_PER_MIN_WALLET = 120; // 120 req/min per wallet

// Program/ATA discovery cache (avoid repeated RPC)
const PROGRAM_CACHE_TTL_MS = 5 * 60 * 1000;

// Ultra-short per-wallet preview cache to absorb double-clicks (prevents RPC pileup)
// Keep tiny to avoid any chance of stale double-claim. The claim flow marks DB,
// so a 2.5s window is safe for accidental duplicate clicks/tabs.
const PREVIEW_CACHE_TTL_MS = 2500;

/* ========= HELPERS ========= */
const noStore = {
  headers: {
    "cache-control": "no-store, no-cache, must-revalidate, max-age=0",
    pragma: "no-cache",
    expires: "0",
  },
};

function json(data: any, init?: ResponseInit) {
  return NextResponse.json(data, { ...init, ...noStore });
}
function bad(status: number, msg: string, extra?: any) {
  return json({ ok: false, error: msg, ...extra }, { status });
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
function correlationId(req: Request) {
  return (
    req.headers.get("x-request-id") ||
    req.headers.get("cf-ray") ||
    Math.random().toString(36).slice(2)
  );
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
  if (tokens < 1) {
    bucket.set(key, { tokens, ts: now });
    return false;
  }
  bucket.set(key, { tokens: tokens - 1, ts: now });
  return true;
}

/* ========= PROGRAM/ATA CACHE ========= */
type ProgCache = {
  at: number;
  tokenProgramId: PublicKey;
  fromAta: PublicKey;
};
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

/* ========= PER-WALLET SINGLE-FLIGHT + MICRO-CACHE ========= */
type PreviewPayload = {
  ok: true;
  txBase64: string;
  amount: number;
  feeSol: number;
  snapshotIds: string[];
  now: number;
};
type CacheRow = { at: number; resp: PreviewPayload };

const PREVIEW_CACHE = new Map<string, CacheRow>();      // walletLc -> last preview
const PENDING = new Map<string, Promise<PreviewPayload>>(); // walletLc -> in-flight promise

/* ========= ROUTE ========= */
export async function POST(req: Request) {
  const cid = correlationId(req);

  try {
    // DO NOT gate this route with DROP_SECRET (browser cannot send it).
    // Keep it public, but shield with rate limits + caches.

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

    // Micro-cache to absorb double-clicks/tabs
    const hit = PREVIEW_CACHE.get(userLc);
    if (hit && Date.now() - hit.at < PREVIEW_CACHE_TTL_MS) {
      return json(hit.resp);
    }

    // Single-flight: if already building, await that promise
    const inflight = PENDING.get(userLc);
    if (inflight) {
      const resp = await inflight.catch(() => null);
      if (resp) return json(resp);
    }

    // Build once for this wallet, share to concurrent callers
    const promise = (async (): Promise<PreviewPayload> => {
      // Gather unclaimed entitlements (DB only, no RPC)
      const rows = await db.listWalletEntitlements(userLc);
      const unclaimed = rows.filter((r: any) => !r.claimed);
      const snapshotIds: string[] = unclaimed.map((r: any) => String(r.snapshotId));

      const amountUi = unclaimed.reduce((sum: number, r: any) => {
        const a = Number(r.amount || 0);
        if (!Number.isFinite(a) || a <= 0) return sum;
        return sum + (ENTITLEMENT_IS_RAW ? a / TEN_POW_DEC : a);
      }, 0);

      if (!Number.isFinite(amountUi) || amountUi <= 0 || snapshotIds.length === 0) {
        const resp: PreviewPayload = {
          ok: true,
          txBase64: "", // no tx to sign
          amount: 0,
          feeSol: 0,
          snapshotIds: [],
          now: Date.now(),
        };
        return resp;
      }

      // Program/ATA discovery (cached)
      const { tokenProgramId } = await getProgramAndFromAta();

      // Build UNSIGNED tx (user pays fees). Note: buildClaimTx currently fetches a blockhash
      // internally. We'll keep it here; the single-flight+cache prevents dogpiles.
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

      const resp: PreviewPayload = {
        ok: true,
        txBase64: built.txB64,
        amount: built.amount,
        feeSol: built.feeSol,
        snapshotIds,
        now: Date.now(),
      };
      return resp;
    })();

    PENDING.set(userLc, promise);

    let out: PreviewPayload;
    try {
      out = await promise;
    } finally {
      PENDING.delete(userLc);
    }

    // Only cache non-empty responses for a tiny window (prevents accidental double-click storms)
    PREVIEW_CACHE.set(userLc, { at: Date.now(), resp: out });

    console.info(JSON.stringify({
      cid,
      where: "claim-preview",
      wallet: userBase58,
      amount: out.amount,
      snapshots: out.snapshotIds.length,
      cachedMs: PREVIEW_CACHE_TTL_MS,
    }));

    return json(out);
  } catch (e: any) {
    console.error(JSON.stringify({ cid, where: "claim-preview", error: String(e?.message || e) }));
    const msg = String(e?.message || e || "Internal Error");
    const status = /not found for this mint\/program/i.test(msg) ? 409 : 500;
    return bad(status, msg);
  }
}
