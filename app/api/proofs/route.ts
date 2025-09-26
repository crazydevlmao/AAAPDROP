// app/api/proofs/route.ts
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

import { NextResponse } from "next/server";
import { connection, pubkeyFromEnv, PUMP_MINT } from "@/lib/solana";
import { PublicKey, Keypair } from "@solana/web3.js";
import bs58 from "bs58";

/* ---------- utils ---------- */
const noStore = { headers: { "cache-control": "no-store, no-cache, must-revalidate, max-age=0" } };
const n = (v: any) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** Safe tx fetch with 2 short retries (RPCs sometimes return null). */
async function getTx(sig: string, commitment: "confirmed" | "finalized" = "confirmed") {
  const conn = connection();
  for (let i = 0; i < 3; i++) {
    try {
      const tx = await conn.getTransaction(sig, {
        maxSupportedTransactionVersion: 0,
        commitment,
      });
      if (tx) return tx;
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  return null;
}

async function lamportsToSolFromTx(sig: string, target: PublicKey): Promise<number> {
  const tx = await getTx(sig, "finalized");
  if (!tx?.meta) return 0;
  const keys = tx.transaction.message.getAccountKeys().staticAccountKeys;
  const i = keys.findIndex((k) => k.equals(target));
  if (i < 0) return 0;
  const pre = tx.meta.preBalances?.[i] ?? 0;
  const post = tx.meta.postBalances?.[i] ?? 0;
  return (post - pre) / 1e9;
}

async function pumpDeltaFromTx(sig: string, owner: PublicKey): Promise<number> {
  const tx = await getTx(sig, "finalized");
  if (!tx?.meta) return 0;

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
      const key = String(q.accountIndex);
      const preAmt = preMap.get(key) ?? 0;
      const postAmt = Number(q.uiTokenAmount?.amount || 0);
      deltaRaw += postAmt - preAmt;
    }
  }
  return deltaRaw / 1e6; // PUMP has 6 decimals
}

/* ---------- db helpers (adapt to your file-db) ---------- */
async function readLatestSnapshot(db: any) {
  if (typeof db?.latestSnapshot === "function") return db.latestSnapshot();
  if (db?.snapshot?.findFirst) {
    return db.snapshot.findFirst({ orderBy: { cycleId: "desc" } });
  }
  if (db?.snapshot?.findMany) {
    const rows = await db.snapshot.findMany({ orderBy: { cycleId: "desc" }, take: 1 });
    return rows?.[0] || null;
  }
  return null;
}

async function readPreviousSnapshots(db: any, limit = 5) {
  // file-db path: returns all; slice here
  if (typeof db?.listSnapshots === "function") {
    const all = await db.listSnapshots();
    return all.slice(-1 - limit, -1).reverse(); // last N before latest
  }
  if (db?.snapshot?.findMany) {
    return db.snapshot.findMany({ orderBy: { cycleId: "desc" }, skip: 1, take: limit });
  }
  return [];
}

/* Resolve DEV public key for creator-fee delta */
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

/* ---------- route ---------- */
export async function GET() {
  try {
    const { db } = await import("@/lib/db");
    const treasury = pubkeyFromEnv("NEXT_PUBLIC_TREASURY");
    const devPub = resolveDevPub();

    // latest snapshot
    const snap = await readLatestSnapshot(db);
    if (!snap) {
      return NextResponse.json(
        {
          snapshotId: null,
          snapshotTs: null,
          snapshotHash: null,
          pumpBalance: 0,
          deltaPump: 0,
          creatorSol: 0,
          pumpSwapped: 0,
          txs: {},
          previous: [],
        },
        noStore
      );
    }

    const snapshotId = snap.snapshotId ?? null;
    const snapshotTs = snap.snapshotTs ?? null;
    const deltaPump = n(snap.deltaPump);

    // pull the PREP row for the same cycle
    const prep: any = typeof db.getPrep === "function" ? await db.getPrep(String(snap.cycleId || "")) : null;

    // prefer the authoritative fields written by prepare-drop
    const claimSig: string | null = prep?.claimSig ?? null;
    const swapSig: string | null =
      prep?.swapSigTreas ??
      (Array.isArray(prep?.swapSigs) && prep.swapSigs.length > 0 ? prep.swapSigs[0] : null) ??
      null;

    // derive from chain, but fall back to persisted prep numbers if RPC is flaky
    let creatorSol = 0;
    if (claimSig) {
      try {
        creatorSol = await lamportsToSolFromTx(claimSig, devPub);
      } catch {}
    }
    if (creatorSol === 0 && n(prep?.creatorSolDelta) > 0) {
      creatorSol = n(prep.creatorSolDelta); // fallback to recorded SOL delta on DEV
    }

    let pumpSwapped = 0;
    if (swapSig) {
      try {
        pumpSwapped = await pumpDeltaFromTx(swapSig, treasury);
      } catch {}
    }
    if (pumpSwapped === 0 && n(prep?.swapOutPumpUi) > 0) {
      pumpSwapped = n(prep.swapOutPumpUi); // fallback to recorded outAmount
    }

    // previous snapshots (metadata + tx refs if any); keep chain-light
    const prevSnaps: any[] = await readPreviousSnapshots(db, 5);
    const previous = await Promise.all(
      (prevSnaps || []).map(async (p: any) => {
        const prevPrep = typeof db.getPrep === "function" ? await db.getPrep(String(p.cycleId || "")) : null;
        const prevClaimSig = prevPrep?.claimSig ?? null;
        const prevSwapSig =
          prevPrep?.swapSigTreas ??
          (Array.isArray(prevPrep?.swapSigs) && prevPrep.swapSigs.length > 0 ? prevPrep.swapSigs[0] : null) ??
          null;
        return {
          snapshotId: p.snapshotId,
          snapshotTs: p.snapshotTs,
          snapshotHash: p.holdersHash,
          deltaPump: n(p.deltaPump),
          pumpBalance: n(p.deltaPump),
          creatorSol: 0,               // keep zero to avoid extra RPC; UI shows link if present
          pumpSwapped: 0,              // same; we display links below
          txs: {
            claimSig: prevClaimSig || null,
            swapSig: prevSwapSig || null,
          },
        };
      })
    );

    return NextResponse.json(
      {
        snapshotId,
        snapshotTs,
        snapshotHash: snap?.holdersHash || null,
        pumpBalance: deltaPump,
        deltaPump,

        creatorSol,
        pumpSwapped,

        txs: {
          claimSig: claimSig || null,
          swapSig: swapSig || null,
        },

        previous,
      },
      noStore
    );
  } catch (e: any) {
    console.error("proofs route error:", e);
    return NextResponse.json(
      {
        snapshotId: null,
        snapshotTs: null,
        snapshotHash: null,
        pumpBalance: 0,
        deltaPump: 0,
        creatorSol: 0,
        pumpSwapped: 0,
        txs: {},
        previous: [],
      },
      noStore
    );
  }
}
