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

// Optional server-to-server secret. If set, client must send header x-drop-secret
const DROP_SECRET = process.env.DROP_SECRET || "";

// Per-IP & per-wallet token buckets (simple in-memory). Tune as needed.
const RATE_PER_MIN_IP = 60;      // 60 req/min per IP
const RATE_PER_MIN_WALLET = 120; // 120 req/min per wallet

// Cache program/ATA discovery for 5 min to avoid RPC dogpiles
const PROGRAM_CACHE_TTL_MS = 5 * 60 * 1000;

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
  // allow upstream to pass one; otherwise generate light id
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

  // Discover token program and treasury ATA once per cache window
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

/* ========= ROUTE ========= */
export async function POST(req: Request) {
  const cid = correlationId(req);

  try {
    // Optional auth: require secret when configured
    if (DROP_SECRET) {
      const provided = req.headers.get("x-drop-secret") || "";
      if (provided !== DROP_SECRET) {
        console.warn(
          JSON.stringify({ cid, where: "claim-preview", msg: "Unauthorized: bad DROP_SECRET" })
        );
        return bad(401, "Unauthorized");
      }
    }

    // Rate limit by IP and wallet
    const ip =
      (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() ||
      req.headers.get("x-real-ip") ||
      "unknown";
    if (!allow(IP_BUCKET, ip, RATE_PER_MIN_IP)) {
      console.warn(JSON.stringify({ cid, where: "claim-preview", ip, err: "rate_limited_ip" }));
      return bad(429, "Too Many Requests (ip)");
    }

    // Parse body
    const body = await req.json().catch(() => ({}));
    const userPk = parseWallet(body.wallet);
    if (!userPk) return bad(400, "Missing or invalid wallet");

    const userBase58 = userPk.toBase58();
    const userLc = userBase58.toLowerCase();

    if (!allow(WALLET_BUCKET, userLc, RATE_PER_MIN_WALLET)) {
      console.warn(
        JSON.stringify({ cid, where: "claim-preview", wallet: userBase58, err: "rate_limited_wallet" })
      );
      return bad(429, "Too Many Requests (wallet)");
    }

    // Gather all unclaimed entitlements for this wallet
    const rows = await db.listWalletEntitlements(userLc);
    const unclaimed = rows.filter((r: any) => !r.claimed);
    const snapshotIds: string[] = unclaimed.map((r: any) => String(r.snapshotId));

    const amountUi = unclaimed.reduce((sum: number, r: any) => {
      const a = Number(r.amount || 0);
      if (!Number.isFinite(a) || a <= 0) return sum;
      return sum + (ENTITLEMENT_IS_RAW ? a / TEN_POW_DEC : a);
    }, 0);

    if (!Number.isFinite(amountUi) || amountUi <= 0 || snapshotIds.length === 0) {
      // Return ok:true so UI can immediately show "0" and avoid extra requests
      console.info(
        JSON.stringify({
          cid,
          where: "claim-preview",
          wallet: userBase58,
          note: "no_unclaimed",
        })
      );
      return json({ ok: true, amount: 0, snapshotIds: [] });
    }

    // Program/ATA discovery (cached)
    const { tokenProgramId } = await getProgramAndFromAta();

    // Build UNSIGNED TX (user pays fees)
    const conn = connection();
    const treasuryPubkey = pubkeyFromEnv("NEXT_PUBLIC_TREASURY");
    const { txB64, amount, feeSol } = await buildClaimTx({
      conn,
      treasuryPubkey,
      user: userPk,
      amountPump: amountUi,
      teamWallet: treasuryPubkey, // not used in current flow
      tokenProgramId,
    });

    // Structured success log
    console.info(
      JSON.stringify({
        cid,
        where: "claim-preview",
        wallet: userBase58,
        amount,
        feeSol,
        snapshots: snapshotIds.length,
      })
    );

    // Return ready-to-sign tx so you can bypass the preview modal
    return json({
      ok: true,
      txBase64: txB64,
      amount,
      feeSol,
      snapshotIds,
      now: Date.now(),
    });
  } catch (e: any) {
    // Structured error log with message
    console.error(
      JSON.stringify({
        cid,
        where: "claim-preview",
        error: String(e?.message || e),
      })
    );
    // 409 is returned above for ATA-missing; default others to 500
    const msg = String(e?.message || e || "Internal Error");
    const status = /not found for this mint\/program/i.test(msg) ? 409 : 500;
    return bad(status, msg);
  }
}
