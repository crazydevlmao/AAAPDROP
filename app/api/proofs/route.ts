// app/api/proofs/route.ts
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

import { NextResponse } from "next/server";
import { db, Snapshot } from "@/lib/db";
import path from "path";
import { promises as fs } from "fs";

export async function GET(req: Request) {
  const url = new URL(req.url);

  // CSV download (holders list captured at that snapshot)
  const csvId = url.searchParams.get("csv");
  if (csvId) {
    try {
      const list = await db.listSnapshots();
      const snap = list.find((s) => s.snapshotId === csvId);
      if (!snap?.holdersCsvPath) {
        return NextResponse.json({ error: "CSV not found" }, { status: 404, headers: { "cache-control": "no-store" } });
      }
      const abs = path.join(process.cwd(), snap.holdersCsvPath);
      const csvText = await fs.readFile(abs, "utf8");
      return new Response(csvText, {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="holders_${csvId}.csv"`,
          "Cache-Control": "no-store",
        },
      });
    } catch (e) {
      console.error("csv download error:", e);
      return NextResponse.json({ error: "Failed to read CSV" }, { status: 500, headers: { "cache-control": "no-store" } });
    }
  }

  // Latest + previous (enriched)
  const snaps: Snapshot[] = await db.listSnapshots(); // oldest..newest
  const latest = snaps[snaps.length - 1];

  async function enrich(s?: Snapshot) {
    if (!s) return null as any;
    const prep = await db.getPrep(s.cycleId); // what happened during prepare-drop for this interval
    return {
      snapshotId: s.snapshotId,
      snapshotTs: s.snapshotTs,
      snapshotHash: s.holdersHash,
      pumpBalance: s.deltaPump,                 // allocated PUMP this cycle (after % cut)

      // Extra proofs
      claimedSol: prep?.claimedSol ?? 0,
      claimSig: prep?.claimSig ?? null,
      creatorSol: prep?.creatorSolDelta ?? 0,   // SOL claimed via lightning
      pumpSwapped: prep?.acquiredPump ?? 0,     // PUMP bought this cycle (est.)
      txs: {
        claimSig: prep?.claimSig || null,
        teamSig: prep?.teamSig || null,
        treasuryMoveSig: prep?.treasuryMoveSig || null,
        swapSig: prep?.swapSigTreas || (prep?.swapSigs?.[0] ?? null),
      },

      // CSV convenience link (front-end rewrite will proxy to Render)
      csv: s.holdersCsvPath ? `/api/proofs?csv=${s.snapshotId}` : null,
    };
  }

  const latestEnriched = await enrich(latest);
  const prevList = snaps.slice(0, -1);
  const previous = (await Promise.all(prevList.reverse().map(enrich))).filter(Boolean);

  return NextResponse.json(
    {
      // Back-compat fields your UI already reads:
      snapshotId: latestEnriched?.snapshotId ?? null,
      snapshotTs: latestEnriched?.snapshotTs ?? null,
      snapshotHash: latestEnriched?.snapshotHash ?? null,
      pumpBalance: latestEnriched?.pumpBalance ?? 0,
      perHolder: 0,

      // New surface:
      creatorSol: latestEnriched?.creatorSol ?? 0,
      pumpSwapped: latestEnriched?.pumpSwapped ?? 0,
      txs: latestEnriched?.txs ?? null,

      // Previous list (up to 20, db trims)
      previous,
    },
    { headers: { "cache-control": "no-store" } }
  );
}
