// app/api/snapshot/route.ts
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

import { NextResponse } from "next/server";
import crypto from "crypto";
import { db } from "@/lib/db";

// === CONFIG ===
const CYCLE_MINUTES = Number(process.env.CYCLE_MINUTES || 10);
const SAFETY_LEAD_MS = 8_000;   // take snapshot at t-8s (server time)
const GRACE_AFTER_MS = 90_000;  // allow +90s late
const WINDOW_MS = CYCLE_MINUTES * 60_000;

// ⚠️ Align storage units with claim-preview
const DECIMALS = 6;
const TEN_POW_DEC = Math.pow(10, DECIMALS);
const ENTITLEMENT_IS_RAW = String(process.env.ENTITLEMENT_IS_RAW || "").toLowerCase() === "true";

const noStoreHeaders = {
  "cache-control": "no-store, no-cache, must-revalidate, max-age=0",
  pragma: "no-cache",
  expires: "0",
};

function sha256Hex(s: string) {
  return crypto.createHash("sha256").update(s).digest("hex");
}

function baseUrl(req: Request) {
  if (process.env.INTERNAL_BASE_URL) return process.env.INTERNAL_BASE_URL.replace(/\/$/, "");
  if (process.env.NEXT_PUBLIC_BASE_URL) return process.env.NEXT_PUBLIC_BASE_URL.replace(/\/$/, "");
  const u = new URL(req.url);
  return `${u.protocol}//${u.host}`;
}

/** Window math (UTC) */
function windowInfo(nowMs = Date.now()) {
  const idx = Math.floor(nowMs / WINDOW_MS);
  const start = idx * WINDOW_MS;
  const end = start + WINDOW_MS;
  const snapshotAt = end - SAFETY_LEAD_MS;
  const cycleId = String(end); // end-of-window ms
  return { idx, start, end, snapshotAt, cycleId };
}

async function readSnapshot(cycleId: string): Promise<any | null> {
  try {
    if (typeof (db as any).getSnapshot === "function") return (db as any).getSnapshot(cycleId);
    if ((db as any).snapshot?.findUnique) return (db as any).snapshot.findUnique({ where: { cycleId } });
  } catch {}
  return null;
}

async function writeSnapshotIdempotent(row: {
  cycleId: string;
  snapshotId: string;
  snapshotTs: string;
  deltaPump: number;        // UI units
  eligibleCount: number;
  holdersHash: string;
}) {
  if ((db as any).snapshot?.upsert) {
    return (db as any).snapshot.upsert({
      where: { cycleId: row.cycleId },
      update: {},
      create: row,
    });
  }
  if (typeof (db as any).addSnapshot === "function") return (db as any).addSnapshot(row);
  if ((db as any).snapshot?.create) {
    try { return await (db as any).snapshot.create({ data: row }); }
    catch { return await readSnapshot(row.cycleId); }
  }
  throw new Error("No snapshot writer available on db");
}

async function addEntitlementsIdempotent(
  entRows: Array<{ snapshotId: string; wallet: string; amount: number; claimed: boolean }>
) {
  if (!entRows.length) return;
  if ((db as any).entitlement?.createMany) {
    await (db as any).entitlement.createMany({ data: entRows, skipDuplicates: true });
    return;
  }
  if (typeof (db as any).addEntitlements === "function") {
    await (db as any).addEntitlements(entRows);
    return;
  }
  if ((db as any).entitlement?.upsert) {
    for (const r of entRows) {
      await (db as any).entitlement.upsert({
        where: { snapshotId_wallet: { snapshotId: r.snapshotId, wallet: r.wallet } },
        update: {},
        create: r,
      });
    }
    return;
  }
  if ((db as any).entitlement?.create) {
    for (const r of entRows) { try { await (db as any).entitlement.create({ data: r }); } catch {} }
    return;
  }
  throw new Error("No entitlement writer available on db");
}

export async function GET(req: Request) {
  try {
    const now = Date.now();
    const { start, end, snapshotAt, cycleId } = windowInfo(now);
    const snapshotId = cycleId;

    const existing = await readSnapshot(cycleId);
    if (existing) {
      return NextResponse.json(
        {
          status: "taken",
          cycleId,
          window: { start, end, snapshotAt },
          snapshotId: existing.snapshotId ?? snapshotId,
          deltaPump: existing.deltaPump ?? 0,
          eligibleCount: existing.eligibleCount ?? 0,
          holdersHash: existing.holdersHash ?? "",
          pumpBalance: existing.deltaPump ?? 0, // convenience alias for UI
        },
        { headers: noStoreHeaders }
      );
    }

    if (now < snapshotAt) {
      return NextResponse.json(
        { status: "pending", cycleId, window: { start, end, snapshotAt }, etaMs: snapshotAt - now },
        { headers: noStoreHeaders }
      );
    }

    // Due or within grace → take it
    if (now <= snapshotAt + GRACE_AFTER_MS) {
      // Pull holders from your API
      const origin = baseUrl(req);
      const r = await fetch(`${origin}/api/holders?ts=${Date.now()}`, { cache: "no-store", headers: noStoreHeaders });
      if (!r.ok) throw new Error(`holders fetch failed: ${r.status}`);
      const { holders = [] } = (await r.json()) as { holders: Array<{ wallet: string; balance: number }> };

      const eligible = holders;
      const eligibleCount = eligible.length;
      const totalBal = eligible.reduce((a, b) => a + (b.balance || 0), 0);

      // Read PREP for THIS cycle
      const prep = await (db as any).getPrep?.(cycleId);
      const cyclePumpUi = Math.max(0, Number(prep?.acquiredPump || 0)); // UI units
      const allocPumpUi = cyclePumpUi * 0.95; // keep 5% reserve if desired

      // Build entitlement rows in configured units
      const entRows: Array<{ snapshotId: string; wallet: string; amount: number; claimed: boolean }> = [];
      if (allocPumpUi > 0 && totalBal > 0) {
        for (const h of eligible) {
          const shareUi = (h.balance / totalBal) * allocPumpUi; // UI units
          const amount = ENTITLEMENT_IS_RAW ? Math.floor(shareUi * TEN_POW_DEC) : shareUi;
          if (amount > 0) {
            entRows.push({ snapshotId, wallet: h.wallet.toLowerCase(), amount, claimed: false });
          }
        }
      }

      const holdersHash = sha256Hex(JSON.stringify({ eligible }, null, 0));
      const snapshotTs = new Date().toISOString();

      const snapRow = await writeSnapshotIdempotent({
        cycleId,
        snapshotId,
        snapshotTs,
        deltaPump: allocPumpUi,  // store UI units here
        eligibleCount,
        holdersHash,
      });

      await addEntitlementsIdempotent(entRows);

      return NextResponse.json(
        {
          status: "taken",
          cycleId,
          window: { start, end, snapshotAt },
          snapshotId,
          snapshotTs,
          holders: eligible,
          eligible,
          pumpBalance: allocPumpUi,   // UI expects this key
          perHolder: eligibleCount > 0 ? allocPumpUi / eligibleCount : 0,
          holdersHash,
        },
        { headers: noStoreHeaders }
      );
    }

    // Beyond grace → missed
    return NextResponse.json(
      { status: "missed", cycleId, window: { start, end, snapshotAt }, missedByMs: now - snapshotAt },
      { status: 202, headers: noStoreHeaders }
    );
  } catch (e) {
    console.error("snapshot error:", e);
    return NextResponse.json(
      {
        status: "error",
        snapshotId: null,
        snapshotTs: null,
        snapshotHash: null,
        holders: [],
        eligible: [],
        pumpBalance: 0,
        perHolder: 0,
        message: String(e),
      },
      { status: 500, headers: noStoreHeaders }
    );
  }
}