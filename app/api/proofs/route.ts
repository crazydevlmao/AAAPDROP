// app/api/proofs/route.ts
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

import { NextResponse } from "next/server";
import { db } from "@/lib/db";

const CYCLE_MINUTES = Number(process.env.CYCLE_MINUTES || 10);
const WINDOW_MS = CYCLE_MINUTES * 60_000;

function windowInfo(nowMs = Date.now()) {
  const idx = Math.floor(nowMs / WINDOW_MS);
  const start = idx * WINDOW_MS;
  const end = start + WINDOW_MS;
  const cycleId = String(end);
  return { idx, start, end, cycleId };
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
function cycleIdMinus(cycleId: string, windows: number) {
  const end = Number(cycleId);
  return String(end - windows * WINDOW_MS);
}

export async function GET() {
  try {
    // Look at the current cycle and also walk backwards a few windows to find latest data
    const now = Date.now();
    const { cycleId: currentCycle } = windowInfo(now);

    // Try current cycle first; if empty, peek 1–3 cycles back for "latest completed"
    const cycleCandidates = [0, 1, 2, 3].map((k) => (k === 0 ? currentCycle : cycleIdMinus(currentCycle, k)));

    let pickedCycle: string | null = null;
    let prep: any = null;
    let snap: any = null;

    for (const cid of cycleCandidates) {
      const p = await readPrep(cid);
      const s = await readSnapshot(cid);
      if (p || s) {
        pickedCycle = cid;
        prep = p;
        snap = s;
        break;
      }
    }

    // Shape the "current" card
    const current = {
      snapshotId: snap?.snapshotId ?? pickedCycle,
      snapshotTs: snap?.snapshotTs ?? null,
      snapshotHash: snap?.holdersHash ?? snap?.snapshotHash ?? "",
      pumpBalance: typeof snap?.deltaPump === "number" ? snap.deltaPump : 0, // UI shows "Delta $PUMP (allocated this cycle)"
      // Creator rewards in SOL (UI: "Creator rewards (SOL, this cycle)")
      creatorSol: typeof prep?.creatorSolDelta === "number" ? prep.creatorSolDelta : 0,
      // PUMP swapped (from prep)
      pumpSwapped: typeof prep?.acquiredPump === "number" ? prep.acquiredPump : 0,
      txs: {
        claimSig: prep?.claimSig || null,
        swapSig: prep?.swapSigTreas || (Array.isArray(prep?.swapSigs) ? prep.swapSigs[0] : null),
      },
    };

    // Build a small "previous" list
    const previous: any[] = [];
    for (let back = 1; back <= 5; back++) {
      const cid = cycleIdMinus(pickedCycle || currentCycle, back);
      const p = await readPrep(cid);
      const s = await readSnapshot(cid);
      if (!p && !s) continue;
      previous.push({
        snapshotId: s?.snapshotId ?? cid,
        snapshotTs: s?.snapshotTs ?? null,
        snapshotHash: s?.holdersHash ?? s?.snapshotHash ?? "",
        pumpBalance: typeof s?.deltaPump === "number" ? s.deltaPump : 0,
        creatorSol: typeof p?.creatorSolDelta === "number" ? p.creatorSolDelta : 0,
        pumpSwapped: typeof p?.acquiredPump === "number" ? p.acquiredPump : 0,
        txs: {
          claimSig: p?.claimSig || null,
          swapSig: p?.swapSigTreas || (Array.isArray(p?.swapSigs) ? p.swapSigs[0] : null),
        },
        // Optional CSV if you ever attach it
        csv: s?.csv || null,
      });
    }

    return NextResponse.json({ ...current, previous });
  } catch (e: any) {
    console.error("proofs error:", e);
    return NextResponse.json({ error: String(e?.message || e) }, { status: 500 });
  }
}
