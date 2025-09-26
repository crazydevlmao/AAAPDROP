// app/api/proofs/route.ts
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

import { NextResponse } from "next/server";
import { connection, pubkeyFromEnv, PUMP_MINT } from "@/lib/solana";
import { PublicKey, Keypair } from "@solana/web3.js";
import bs58 from "bs58";

/* ===== Config ===== */
const TTL_MS = 60_000;        // cache per latest snapshot (protects RPC)
const TX_TTL_MS = 5 * 60_000; // cache per-tx parse (expensive RPC)
const noStore = {
  headers: {
    "cache-control": "no-store, no-cache, must-revalidate, max-age=0",
    pragma: "no-cache",
    expires: "0",
  },
};

/* ===== RL (per IP) ===== */
type Bucket = { tokens: number; ts: number };
const IP_BUCKET = new Map<string, Bucket>();
function allowIp(ip: string, ratePerMin: number) {
  const now = Date.now();
  const refill = ratePerMin / 60000;
  const slot = IP_BUCKET.get(ip) ?? { tokens: ratePerMin, ts: now };
  const tokens = Math.min(ratePerMin, slot.tokens + (now - slot.ts) * refill);
  if (tokens < 1) { IP_BUCKET.set(ip, { tokens, ts: now }); return false; }
  IP_BUCKET.set(ip, { tokens: tokens - 1, ts: now });
  return true;
}

/* ===== Cache & single-flight ===== */
type ProofsPayload = {
  snapshotId: any;
  snapshotTs: any;
  snapshotHash: any;
  pumpBalance: number;
  deltaPump: number;
  creatorSol: number;
  pumpSwapped: number;
  txs: {
    claimSig: string | null;
    claimSolscan?: string;
    swapSig: string | null;
    swapSolscan?: string;
  };
  previous: any[];
};
let SNAP_CACHE: { at: number; key: string; data: ProofsPayload } | null = null;
let PENDING: Promise<ProofsPayload> | null = null;

// Per-tx derived values cache (avoid re-decoding same tx)
type TxCacheEntry = { at: number; creatorSol?: number; pumpSwapped?: number; isCollect?: boolean };
const TX_CACHE = new Map<string, TxCacheEntry>();

function cidOf(req: Request) {
  return (
    req.headers.get("x-request-id") ||
    req.headers.get("cf-ray") ||
    Math.random().toString(36).slice(2)
  );
}
function n(v: any) { const x = Number(v); return Number.isFinite(x) ? x : 0; }

/** Build the full account-keys array = static + lookups (writable + readonly). */
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
  // Fallback (older web3.js)
  const fallback = (msg?.accountKeys || []) as PublicKey[];
  return Array.isArray(fallback) ? fallback : [];
}

/** Quick check: does this tx have the Pump log line? */
async function isCollectCreatorFee(sig: string): Promise<boolean> {
  const key = "isCollect:" + sig;
  const hit = TX_CACHE.get(key);
  const now = Date.now();
  if (hit && now - hit.at < TX_TTL_MS && typeof hit.isCollect === "boolean") {
    return !!hit.isCollect;
  }
  try {
    const conn = connection();
    await conn.confirmTransaction(sig, "finalized");
    const tx = await conn.getTransaction(sig, {
      maxSupportedTransactionVersion: 0,
      commitment: "finalized",
    });
    const logs: string[] = (tx?.meta?.logMessages || []).filter(Boolean) as string[];
    const ok = logs.some((l) => l.toLowerCase().includes("collect_creator_fee"));
    TX_CACHE.set(key, { at: now, isCollect: ok });
    return ok;
  } catch {
    TX_CACHE.set(key, { at: now, isCollect: false });
    return false;
  }
}

async function lamportsToSolFromTx(sig: string, target: PublicKey): Promise<number> {
  const key = "creator:" + sig;
  const hit = TX_CACHE.get(key);
  const now = Date.now();
  if (hit && now - hit.at < TX_TTL_MS && typeof hit.creatorSol === "number") return Math.max(0, hit.creatorSol!);

  const conn = connection();
  const tx = await conn.getTransaction(sig, {
    maxSupportedTransactionVersion: 0,
    commitment: "confirmed",
  });

  if (!tx?.meta) { TX_CACHE.set(key, { at: now, creatorSol: 0 }); return 0; }

  // IMPORTANT: include ALT (lookup) addresses so indices match pre/post balances
  const keys: PublicKey[] = allAccountKeys(tx.transaction.message);
  const i = keys.findIndex((k) => k.equals(target));
  if (i < 0) { TX_CACHE.set(key, { at: now, creatorSol: 0 }); return 0; }

  const pre = tx.meta.preBalances?.[i] ?? 0;
  const post = tx.meta.postBalances?.[i] ?? 0;
  const deltaLamports = post - pre;
  const val = Math.max(0, deltaLamports / 1e9); // never negative

  TX_CACHE.set(key, { at: now, creatorSol: val });
  return val;
}

async function pumpDeltaFromTx(sig: string, owner: PublicKey): Promise<number> {
  const key = "pump:" + sig;
  const hit = TX_CACHE.get(key);
  const now = Date.now();
  if (hit && now - hit.at < TX_TTL_MS && typeof hit.pumpSwapped === "number") return hit.pumpSwapped!;

  const conn = connection();
  const tx = await conn.getTransaction(sig, {
    maxSupportedTransactionVersion: 0,
    commitment: "confirmed",
  });
  if (!tx?.meta) { TX_CACHE.set(key, { at: now, pumpSwapped: 0 }); return 0; }

  const pre = tx.meta.preTokenBalances || [];
  const post = tx.meta.postTokenBalances || [];

  const mintStr = PUMP_MINT.toBase58();
  const ownerLc = owner.toBase58().toLowerCase();

  const preMap = new Map<string, number>(); // accountIndex -> preRaw
  for (const p of pre) {
    if (p.mint === mintStr && (p as any).owner?.toLowerCase() === ownerLc) {
      preMap.set(String(p.accountIndex), Number(p.uiTokenAmount?.amount || 0));
    }
  }
  let deltaRaw = 0;
  for (const q of post) {
    if (q.mint === mintStr && (q as any).owner?.toLowerCase() === ownerLc) {
      const key2 = String(q.accountIndex);
      const preAmt = preMap.get(key2) ?? 0;
      const postAmt = Number(q.uiTokenAmount?.amount || 0);
      deltaRaw += (postAmt - preAmt);
    }
  }
  const val = deltaRaw / 1e6; // 6 decimals
  TX_CACHE.set(key, { at: now, pumpSwapped: val });
  return val;
}

async function readLatestSnapshot(db: any) {
  if (db?.snapshot?.findFirst) return db.snapshot.findFirst({ orderBy: { cycleId: "desc" } });
  if (db?.getLatestSnapshot) return db.getLatestSnapshot();
  if (db?.snapshot?.findMany) {
    const rows = await db.snapshot.findMany({ orderBy: { cycleId: "desc" }, take: 1 });
    return rows?.[0] || null;
  }
  return null;
}

async function readPreviousSnapshots(db: any, limit = 5) {
  if (db?.snapshot?.findMany) {
    const rows = await db.snapshot.findMany({ orderBy: { cycleId: "desc" }, skip: 1, take: limit });
    return rows;
  }
  if (db?.listSnapshots) return db.listSnapshots(limit);
  return [];
}

function resolveDevPub(): PublicKey {
  try {
    return pubkeyFromEnv("DEV_WALLET");
  } catch {}
  const sec = process.env.DEV_WALLET_SECRET?.trim();
  if (sec) {
    const kp = Keypair.fromSecretKey(bs58.decode(sec));
    return kp.publicKey;
  }
  throw new Error("Missing DEV_WALLET or DEV_WALLET_SECRET");
}

async function computeProofs(): Promise<ProofsPayload> {
  const { db } = await import("@/lib/db");
  const treasury = pubkeyFromEnv("NEXT_PUBLIC_TREASURY");
  const devPub = resolveDevPub();

  // latest snapshot
  const snap = await readLatestSnapshot(db);
  if (!snap) {
    return {
      snapshotId: null,
      snapshotTs: null,
      snapshotHash: null,
      pumpBalance: 0,
      deltaPump: 0,
      creatorSol: 0,
      pumpSwapped: 0,
      txs: { claimSig: null, swapSig: null },
      previous: [],
    };
  }

  const snapshotId = snap?.snapshotId ?? null;
  const snapshotTs = snap?.snapshotTs ?? null;
  const deltaPump = n(snap?.deltaPump); // UI units

  // prep row for this cycle
  const prep: any = (db as any)?.getPrep ? await (db as any).getPrep(snap?.cycleId || "") : null;

  // Validate the stored claimSig -> must be a collectCreatorFee tx
  let claimSig: string | null = prep?.claimSig ?? null;
  if (claimSig) {
    const ok = await isCollectCreatorFee(claimSig);
    if (!ok) claimSig = null;
  }

  const swapSig: string | null =
    prep?.swapSigTreas ??
    ((Array.isArray(prep?.swapSigs) && prep.swapSigs.length > 0) ? prep.swapSigs[0] : null) ??
    null;

  // chain-derived amounts (cached per tx)
  const creatorSol = claimSig ? await lamportsToSolFromTx(claimSig, devPub) : 0;
  const pumpSwapped = swapSig ? await pumpDeltaFromTx(swapSig, treasury) : 0;

  const previous = await readPreviousSnapshots(db, 5);

  return {
    snapshotId,
    snapshotTs,
    snapshotHash: snap?.holdersHash || null,
    pumpBalance: deltaPump,
    deltaPump,
    creatorSol,
    pumpSwapped,
    txs: {
      claimSig: claimSig || null,
      claimSolscan: claimSig ? `https://solscan.io/tx/${encodeURIComponent(claimSig)}` : undefined,
      swapSig: swapSig || null,
      swapSolscan: swapSig ? `https://solscan.io/tx/${encodeURIComponent(swapSig)}` : undefined,
    },
    previous: (previous || []).map((p: any) => ({
      snapshotId: p.snapshotId,
      snapshotTs: p.snapshotTs,
      snapshotHash: p.holdersHash,
      deltaPump: n(p.deltaPump),
      pumpBalance: n(p.deltaPump),
      creatorSol: 0,
      pumpSwapped: 0,
      txs: p.txs || {},
    })),
  };
}

export async function GET(req: Request) {
  const cid = cidOf(req);

  // Per-IP throttle (reads only, but avoid spam): 60/min
  const ip =
    (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() ||
    req.headers.get("x-real-ip") ||
    "unknown";
  if (!allowIp(ip, 60)) {
    console.warn(JSON.stringify({ cid, where: "proofs.GET", ip, err: "rate_limited_ip" }));
    return NextResponse.json(
      { snapshotId: null, snapshotTs: null, snapshotHash: null, pumpBalance: 0, deltaPump: 0, creatorSol: 0, pumpSwapped: 0, txs: {}, previous: [], error: "Too Many Requests (ip)" },
      { status: 429, ...noStore }
    );
  }

  try {
    const { db } = await import("@/lib/db");

    // cache key is latest cycleId (falls back to "none")
    const latest = await readLatestSnapshot(db);
    const key = latest?.cycleId ? String(latest.cycleId) : "none";
    const now = Date.now();

    if (SNAP_CACHE && SNAP_CACHE.key === key && now - SNAP_CACHE.at < TTL_MS) {
      return NextResponse.json(SNAP_CACHE.data, noStore);
    }

    if (!PENDING) {
      PENDING = computeProofs()
        .then((data) => {
          SNAP_CACHE = { at: Date.now(), key, data };
          return data;
        })
        .finally(() => setTimeout(() => { PENDING = null; }, 50));
    }

    const data = await PENDING;
    console.info(JSON.stringify({ cid, where: "proofs.GET", key, ok: true }));
    return NextResponse.json(data, noStore);
  } catch (e: any) {
    console.error(JSON.stringify({ cid, where: "proofs.GET", error: String(e?.message || e) }));
    // serve stale if available
    if (SNAP_CACHE) return NextResponse.json(SNAP_CACHE.data, noStore);
    return NextResponse.json(
      { snapshotId: null, snapshotTs: null, snapshotHash: null, pumpBalance: 0, deltaPump: 0, creatorSol: 0, pumpSwapped: 0, txs: {}, previous: [], error: "proofs failed" },
      { status: 502, ...noStore }
    );
  }
}
