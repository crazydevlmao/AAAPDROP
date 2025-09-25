// app/api/proofs/route.ts
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { connection } from "@/lib/solana";

const CYCLE_MINUTES = Number(process.env.CYCLE_MINUTES || 10);
const WINDOW_MS = CYCLE_MINUTES * 60_000;

function cycleIdAt(ms: number) {
  const idx = Math.floor(ms / WINDOW_MS);
  const end = (idx * WINDOW_MS) + WINDOW_MS;
  return String(end);
}
function cycleIdMinus(cycleId: string, windows: number) {
  return String(Number(cycleId) - windows * WINDOW_MS);
}
async function readPrep(cycleId: string) {
  try { return await (db as any).getPrep?.(cycleId); } catch { return null; }
}
async function readSnapshot(cycleId: string) {
  try {
    if (typeof (db as any).getSnapshot === "function") return await (db as any).getSnapshot(cycleId);
    if ((db as any).snapshot?.findUnique) return await (db as any).snapshot.findUnique({ where: { cycleId } });
  } catch {}
  return null;
}

export async function GET() {
  try {
    const now = Date.now();
    const current = cycleIdAt(now);

    // find the most recent cycle that HAS a snapshot
    let snapCycle: string | null = null;
    let snap: any = null;
    for (const back of [0, 1, 2, 3, 4]) {
      const cid = back === 0 ? current : cycleIdMinus(current, back);
      const s = await readSnapshot(cid);
      if (s) { snapCycle = cid; snap = s; break; }
    }

    // If we truly have no snapshots yet, fall back to current/prep-only
    const pickedCycle = snapCycle || current;
    const prep = await readPrep(pickedCycle);

    // optional: safety — if claimSig exists but is not collect_creator_fee, hide it
    let claimSig: string | null = prep?.claimSig || null;
    if (claimSig) {
      try {
        const conn = connection("confirmed");
        const tx = await conn.getTransaction(claimSig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
        const logs: string[] = (tx?.meta?.logMessages || []).filter(Boolean) as string[];
        const ok = logs.some(l => l.toLowerCase().includes("collect_creator_fee"));
        if (!ok) claimSig = null;
      } catch {
        // if inspection fails, leave as-is; prepare-drop already verified
      }
    }

    const body = {
      snapshotId: snap?.snapshotId ?? pickedCycle,
      snapshotTs: snap?.snapshotTs ?? null,
      snapshotHash: snap?.holdersHash ?? snap?.snapshotHash ?? "",
      pumpBalance: typeof snap?.deltaPump === "number" ? snap.deltaPump : 0, // Delta $PUMP (allocated this cycle)
      creatorSol: typeof prep?.creatorSolDelta === "number" ? prep.creatorSolDelta : 0, // Creator rewards (SOL)
      pumpSwapped: typeof prep?.acquiredPump === "number" ? prep.acquiredPump : 0,      // $PUMP swapped
      txs: {
        claimSig, // only if verified/kept
        swapSig: prep?.swapSigTreas || (Array.isArray(prep?.swapSigs) ? prep.swapSigs[0] : null),
      },
      previous: [] as any[],
    };

    // Build previous list (up to 5)
    let cursor = pickedCycle;
    for (let i = 0; i < 5; i++) {
      cursor = cycleIdMinus(cursor, 1);
      const p = await readPrep(cursor);
      const s = await readSnapshot(cursor);
      if (!p && !s) continue;
      body.previous.push({
        snapshotId: s?.snapshotId ?? cursor,
        snapshotTs: s?.snapshotTs ?? null,
        snapshotHash: s?.holdersHash ?? s?.snapshotHash ?? "",
        pumpBalance: typeof s?.deltaPump === "number" ? s.deltaPump : 0,
        creatorSol: typeof p?.creatorSolDelta === "number" ? p.creatorSolDelta : 0,
        pumpSwapped: typeof p?.acquiredPump === "number" ? p.acquiredPump : 0,
        txs: {
          claimSig: p?.claimSig || null,
          swapSig: p?.swapSigTreas || (Array.isArray(p?.swapSigs) ? p.swapSigs[0] : null),
        },
        csv: s?.csv || null,
      });
    }

    return NextResponse.json(body);
  } catch (e: any) {
    console.error("proofs error:", e);
    return NextResponse.json({ error: String(e?.message || e) }, { status: 500 });
  }
}
