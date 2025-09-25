// app/api/proofs/route.ts
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

import { NextResponse } from "next/server";
import { connection, pubkeyFromEnv, PUMP_MINT } from "@/lib/solana";
import { PublicKey, Keypair } from "@solana/web3.js";
import bs58 from "bs58";

function n(v: any) { const x = Number(v); return Number.isFinite(x) ? x : 0; }

async function lamportsToSolFromTx(sig: string, target: PublicKey): Promise<number> {
  const conn = connection();
  const tx = await conn.getTransaction(sig, {
    maxSupportedTransactionVersion: 0,
    commitment: "confirmed",
  });
  if (!tx?.meta) return 0;
  const keys = tx.transaction.message.getAccountKeys().staticAccountKeys;
  const i = keys.findIndex(k => k.equals(target));
  if (i < 0) return 0;
  const pre = tx.meta.preBalances?.[i] ?? 0;
  const post = tx.meta.postBalances?.[i] ?? 0;
  const deltaLamports = post - pre;
  return deltaLamports / 1e9;
}

async function pumpDeltaFromTx(sig: string, owner: PublicKey): Promise<number> {
  const conn = connection();
  const tx = await conn.getTransaction(sig, {
    maxSupportedTransactionVersion: 0,
    commitment: "confirmed",
  });
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
      deltaRaw += (postAmt - preAmt);
    }
  }
  return deltaRaw / 1e6; // UI units for PUMP (6 decimals)
}

async function readLatestSnapshot(db: any) {
  if (db?.snapshot?.findFirst) {
    return db.snapshot.findFirst({ orderBy: { cycleId: "desc" } });
  }
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

export async function GET() {
  try {
    const { db } = await import("@/lib/db");
    const treasury = pubkeyFromEnv("NEXT_PUBLIC_TREASURY");
    const devPub = resolveDevPub();

    // latest snapshot
    const snap = await readLatestSnapshot(db);
    if (!snap) {
      return NextResponse.json({
        snapshotId: null,
        snapshotTs: null,
        snapshotHash: null,
        pumpBalance: 0,
        deltaPump: 0,
        creatorSol: 0,
        pumpSwapped: 0,
        txs: {},
        previous: [],
      }, { headers: { "cache-control": "no-store" } });
    }

    const snapshotId = snap?.snapshotId ?? null;
    const snapshotTs = snap?.snapshotTs ?? null;
    const deltaPump = n(snap?.deltaPump); // UI units

    // prep row for this cycle
    const prep: any = db?.getPrep ? await db.getPrep(snap?.cycleId || "") : null;

    const claimSig: string | null = (prep?.claimSig) ?? null;
    const swapSig: string | null =
      (prep?.swapSigTreas) ??
      ((Array.isArray(prep?.swapSigs) && prep.swapSigs.length > 0) ? prep.swapSigs[0] : null) ??
      null;

    // chain-derived amounts
    const creatorSol = claimSig ? await lamportsToSolFromTx(claimSig, devPub) : 0;
    const pumpSwapped = swapSig ? await pumpDeltaFromTx(swapSig, treasury) : 0;

    const previous = await readPreviousSnapshots(db, 5);

    return NextResponse.json({
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
    }, { headers: { "cache-control": "no-store" } });
  } catch (e: any) {
    console.error("proofs route error:", e);
    return NextResponse.json({
      snapshotId: null,
      snapshotTs: null,
      snapshotHash: null,
      pumpBalance: 0,
      deltaPump: 0,
      creatorSol: 0,
      pumpSwapped: 0,
      txs: {},
      previous: [],
    }, { headers: { "cache-control": "no-store" } });
  }
}
