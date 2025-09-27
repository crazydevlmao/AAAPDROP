// app/api/proofs/route.ts
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

import { NextResponse } from "next/server";

const TTL_MS = 15_000;
const noStore = {
  headers: {
    "cache-control": "no-store, no-cache, must-revalidate, max-age=0",
    pragma: "no-cache",
    expires: "0",
  },
};

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

function n(v: any) { const x = Number(v); return Number.isFinite(x) ? x : 0; }
function cidOf(req: Request) {
  return req.headers.get("x-request-id") || req.headers.get("cf-ray") || Math.random().toString(36).slice(2);
}

let SNAP_CACHE: { at: number; key: string; data: ProofsPayload } | null = null;
let PENDING: Promise<ProofsPayload> | null = null;

/* DB helpers (support multiple backends) */
async function readLatestSnapshot(db: any) {
  if (db?.snapshot?.findFirst) return db.snapshot.findFirst({ orderBy: { cycleId: "desc" } });
  if (db?.getLatestSnapshot) return db.getLatestSnapshot();
  if (db?.snapshot?.findMany) {
    const r = await db.snapshot.findMany({ orderBy: { cycleId: "desc" }, take: 1 });
    return r?.[0] || null;
  }
  return null;
}
async function readPreviousSnapshots(db: any, limit = 6) {
  if (db?.snapshot?.findMany) return db.snapshot.findMany({ orderBy: { cycleId: "desc" }, skip: 1, take: limit });
  if (db?.listSnapshots) return db.listSnapshots(limit);
  return [];
}
async function getPrep(db: any, cycleId: string) {
  if (!cycleId) return null;
  if ((db as any)?.getPrep) return (db as any).getPrep(String(cycleId));
  if (db?.prep?.findFirst) return db.prep.findFirst({ where: { cycleId: String(cycleId) } });
  return null;
}

/* Build payload strictly from DB */
async function computeProofsDBOnly(): Promise<ProofsPayload> {
  const { db } = await import("@/lib/db");
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

  const snapshotId = snap.snapshotId ?? null;
  const snapshotTs = snap.snapshotTs ?? null;
  const deltaPump = n(snap.deltaPump);
  const holdersHash = snap.holdersHash || null;

  const prepNow = await getPrep(db, snap.cycleId || "");
  const creatorSol = n(prepNow?.creatorSol);
  const pumpSwapped = n(prepNow?.pumpSwapped);
  const claimSig = creatorSol > 0 && prepNow?.claimSig ? String(prepNow.claimSig) : null;
  const swapSig = prepNow?.swapSig ? String(prepNow.swapSig) : null;

  const prev = await readPreviousSnapshots(db, 6);
  const previous = await Promise.all(prev.map(async (p: any) => {
    const pr = await getPrep(db, p.cycleId || "");
    const prevCreator = n(pr?.creatorSol);
    const prevSwap = n(pr?.pumpSwapped);
    return {
      snapshotId: p.snapshotId,
      snapshotTs: p.snapshotTs,
      snapshotHash: p.holdersHash,
      deltaPump: n(p.deltaPump),
      pumpBalance: n(p.deltaPump),
      creatorSol: prevCreator,
      pumpSwapped: prevSwap,
      txs: {
        claimSig: prevCreator > 0 && pr?.claimSig ? String(pr.claimSig) : null,
        swapSig: pr?.swapSig ? String(pr.swapSig) : null,
      },
    };
  }));

  return {
    snapshotId,
    snapshotTs,
    snapshotHash: holdersHash,
    pumpBalance: deltaPump,
    deltaPump,
    creatorSol,
    pumpSwapped,
    txs: {
      claimSig,
      claimSolscan: claimSig ? `https://solscan.io/tx/${encodeURIComponent(claimSig)}` : undefined,
      swapSig,
      swapSolscan: swapSig ? `https://solscan.io/tx/${encodeURIComponent(swapSig)}` : undefined,
    },
    previous,
  };
}

export async function GET(req: Request) {
  const cid = cidOf(req);
  try {
    const { db } = await import("@/lib/db");
    const latest = await readLatestSnapshot(db);
    const key = latest?.cycleId ? String(latest.cycleId) : "none";
    const now = Date.now();

    if (SNAP_CACHE && SNAP_CACHE.key === key && now - SNAP_CACHE.at < TTL_MS) {
      return NextResponse.json(SNAP_CACHE.data, noStore);
    }

    if (!PENDING) {
      PENDING = computeProofsDBOnly()
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
