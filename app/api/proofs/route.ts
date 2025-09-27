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
const TTL_MS = 15_000;        // fast UI refresh post-boundary
const TX_TTL_MS = 5 * 60_000; // per-tx parse cache

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
  pumpBalance: number;  // equals deltaPump (UI units)
  deltaPump: number;    // allocated this cycle (UI units)
  creatorSol: number;   // SOL credited to DEV this cycle
  pumpSwapped: number;  // PUMP bought into Treasury this cycle (UI units)
  txs: {
    claimSig: string | null;
    claimSolscan?: string;
    swapSig: string | null;
    swapSolscan?: string;
  };
  previous: Array<{
    snapshotId: any;
    snapshotTs: any;
    snapshotHash: any;
    deltaPump: number;
    pumpBalance: number;
    creatorSol: number;
    pumpSwapped: number;
    txs: { claimSig: string | null; swapSig: string | null };
  }>;
};
let SNAP_CACHE: { at: number; key: string; data: ProofsPayload } | null = null;
let PENDING: Promise<ProofsPayload> | null = null;

// Per-tx derived values cache
type TxCacheEntry = { at: number; creatorSol?: number; pumpSwapped?: number; isCollect?: boolean };
const TX_CACHE = new Map<string, TxCacheEntry>();

/* ===== Utils ===== */
function cidOf(req: Request) {
  return (
    req.headers.get("x-request-id") ||
    req.headers.get("cf-ray") ||
    Math.random().toString(36).slice(2)
  );
}
function n(v: any) { const x = Number(v); return Number.isFinite(x) ? x : 0; }

/** Include ALT lookups so indices align with pre/post balances. */
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

/** Quick check: does this tx have the Collect Creator Fee log? (supports both forms) */
async function isCollectCreatorFee(sig: string): Promise<boolean> {
  const key = "isCollect:" + sig;
  const hit = TX_CACHE.get(key);
  const now = Date.now();
  if (hit && now - hit.at < TX_TTL_MS && typeof hit.isCollect === "boolean") {
    return !!hit.isCollect;
  }
  try {
    const conn = connection();
    // pull quickly at confirmed; fall back to finalized if needed
    let tx = await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
    if (!tx) {
      tx = await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "finalized" });
    }
    const logs: string[] = (tx?.meta?.logMessages || []).filter(Boolean) as string[];

    // Accept either "Instruction: CollectCoinCreatorFee" or "collect_creator_fee"
    const ok = logs.some((l) =>
      /instruction:\s*collectcoincreatorfee/i.test(l) ||
      /collect[_\s]?creator[_\s]?fee/i.test(l)
    );

    TX_CACHE.set(key, { at: now, isCollect: ok });
    return ok;
  } catch {
    TX_CACHE.set(key, { at: now, isCollect: false });
    return false;
  }
}

/** SOL credited to `target` (never negative). */
async function lamportsToSolFromTx(sig: string, target: PublicKey): Promise<number> {
  const key = "creator:" + sig;
  const hit = TX_CACHE.get(key);
  const now = Date.now();
  if (hit && now - hit.at < TX_TTL_MS && typeof hit.creatorSol === "number") return Math.max(0, hit.creatorSol!);

  const conn = connection();
  // prefer confirmed for freshness, fall back to finalized
  let tx = await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
  if (!tx) tx = await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "finalized" });

  if (!tx?.meta) { TX_CACHE.set(key, { at: now, creatorSol: 0 }); return 0; }

  const keys: PublicKey[] = allAccountKeys(tx.transaction.message);
  const i = keys.findIndex((k) => k.equals(target));
  if (i < 0) { TX_CACHE.set(key, { at: now, creatorSol: 0 }); return 0; }

  const pre = tx.meta.preBalances?.[i] ?? 0;
  const post = tx.meta.postBalances?.[i] ?? 0;
  const deltaLamports = post - pre;
  const val = Math.max(0, deltaLamports / 1e9);
  TX_CACHE.set(key, { at: now, creatorSol: val });
  return val;
}

/** Net PUMP change for `owner` in this tx (UI units). */
async function pumpDeltaFromTx(sig: string, owner: PublicKey): Promise<number> {
  const key = "pump:" + sig;
  const hit = TX_CACHE.get(key);
  const now = Date.now();
  if (hit && now - hit.at < TX_TTL_MS && typeof hit.pumpSwapped === "number") return hit.pumpSwapped!;

  const conn = connection();
  let tx = await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
  if (!tx) tx = await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "finalized" });
  if (!tx?.meta) { TX_CACHE.set(key, { at: now, pumpSwapped: 0 }); return 0; }

  const pre = tx.meta.preTokenBalances || [];
  const post = tx.meta.postTokenBalances || [];

  const mintStr = PUMP_MINT.toBase58();
  const ownerLc = owner.toBase58().toLowerCase();

  const preMap = new Map<string, number>();
  for (const p of pre) {
    if (p.mint === mintStr && (p as any).owner?.toLowerCase() === ownerLc) {
      preMap.set(String(p.accountIndex), Number(p.uiTokenAmount?.amount || 0));
    }
  }
  let deltaRaw = 0;
  for (const q of post) {
    if (q.mint === mintStr && (q as any).owner?.toLowerCase() === ownerLc) {
      const idx = String(q.accountIndex);
      const preAmt = preMap.get(idx) ?? 0;
      const postAmt = Number(q.uiTokenAmount?.amount || 0);
      deltaRaw += (postAmt - preAmt);
    }
  }
  const val = deltaRaw / 1e6;
  TX_CACHE.set(key, { at: now, pumpSwapped: val });
  return val;
}

/* ===== DB helpers ===== */
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
async function getPrep(db: any, cycleId: string) {
  if (!cycleId) return null;
  if ((db as any)?.getPrep) return (db as any).getPrep(String(cycleId));
  if (db?.prep?.findFirst) return db.prep.findFirst({ where: { cycleId: String(cycleId) } });
  return null;
}

function resolveDevPub(): PublicKey {
  try { return pubkeyFromEnv("DEV_WALLET"); } catch {}
  const sec = process.env.DEV_WALLET_SECRET?.trim();
  if (sec) {
    const kp = Keypair.fromSecretKey(bs58.decode(sec));
    return kp.publicKey;
  }
  throw new Error("Missing DEV_WALLET or DEV_WALLET_SECRET");
}

/* ===== Enrichment ===== */
async function enrichFromPrep(prep: any, treasury: PublicKey, devPub: PublicKey) {
  const claimSig: string | null = prep?.claimSig ?? null;
  const swapSig: string | null =
    prep?.swapSigTreas ??
    ((Array.isArray(prep?.swapSigs) && prep.swapSigs.length > 0) ? prep.swapSigs[0] : null) ??
    null;

  let claimOk = false;
  if (claimSig) {
    try { claimOk = await isCollectCreatorFee(claimSig); } catch {}
  }

  const creatorSol = claimOk ? await lamportsToSolFromTx(claimSig!, devPub) : 0;
  const pumpSwapped = swapSig ? await pumpDeltaFromTx(swapSig, treasury) : 0;

  return {
    creatorSol,
    pumpSwapped,
    txs: {
      // Show claim link only if the tx is truly a collect-creator-fee AND value > 0
      claimSig: claimOk && creatorSol > 0 ? claimSig : null,
      // Show swap link if we have a signature
      swapSig: swapSig || null,
    },
  };
}

/* ===== Core ===== */
async function computeProofs(): Promise<ProofsPayload> {
  const { db } = await import("@/lib/db");
  const treasury = pubkeyFromEnv("NEXT_PUBLIC_TREASURY");
  const devPub = resolveDevPub();

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
  const deltaPump = n(snap?.deltaPump);

  // latest prep
  const prepNow: any = await getPrep(db, snap?.cycleId || "");
  const latest = prepNow
    ? await enrichFromPrep(prepNow, treasury, devPub)
    : { creatorSol: 0, pumpSwapped: 0, txs: { claimSig: null, swapSig: null } };

  // previous snapshots → enrich via their prep
  const prevRows = await readPreviousSnapshots(db, 6);
  const previous = [];
  for (const p of prevRows) {
    const pr = await getPrep(db, p?.cycleId || "");
    const enriched = pr
      ? await enrichFromPrep(pr, treasury, devPub)
      : { creatorSol: 0, pumpSwapped: 0, txs: { claimSig: null, swapSig: null } };
    previous.push({
      snapshotId: p.snapshotId,
      snapshotTs: p.snapshotTs,
      snapshotHash: p.holdersHash,
      deltaPump: n(p.deltaPump),
      pumpBalance: n(p.deltaPump),
      creatorSol: enriched.creatorSol,
      pumpSwapped: enriched.pumpSwapped,
      txs: enriched.txs,
    });
  }

  return {
    snapshotId,
    snapshotTs,
    snapshotHash: snap?.holdersHash || null,
    pumpBalance: deltaPump,
    deltaPump,
    creatorSol: latest.creatorSol,
    pumpSwapped: latest.pumpSwapped,
    txs: {
      claimSig: latest.txs.claimSig,
      claimSolscan: latest.txs.claimSig ? `https://solscan.io/tx/${encodeURIComponent(latest.txs.claimSig)}` : undefined,
      swapSig: latest.txs.swapSig,
      swapSolscan: latest.txs.swapSig ? `https://solscan.io/tx/${encodeURIComponent(latest.txs.swapSig)}` : undefined,
    },
    previous,
  };
}

/* ===== Route ===== */
export async function GET(req: Request) {
  const cid = cidOf(req);

  // Per-IP throttle: 60/min
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
    const latest = await readLatestSnapshot(db);
    const key = latest?.cycleId ? String(latest.cycleId) : "none";
    const now = Date.now();

    if (SNAP_CACHE && SNAP_CACHE.key === key && now - SNAP_CACHE.at < TTL_MS) {
      return NextResponse.json(SNAP_CACHE.data, noStore);
    }

    if (!PENDING) {
      PENDING = computeProofs()
        .then((data) => { SNAP_CACHE = { at: Date.now(), key, data }; return data; })
        .finally(() => setTimeout(() => { PENDING = null; }, 50));
    }

    const data = await PENDING;
    console.info(JSON.stringify({ cid, where: "proofs.GET", key, ok: true }));
    return NextResponse.json(data, noStore);
  } catch (e: any) {
    console.error(JSON.stringify({ cid, where: "proofs.GET", error: String(e?.message || e) }));
    if (SNAP_CACHE) return NextResponse.json(SNAP_CACHE.data, noStore);
    return NextResponse.json(
      { snapshotId: null, snapshotTs: null, snapshotHash: null, pumpBalance: 0, deltaPump: 0, creatorSol: 0, pumpSwapped: 0, txs: {}, previous: [], error: "proofs failed" },
      { status: 502, ...noStore }
    );
  }
}
