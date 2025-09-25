export const runtime = "nodejs";

import { NextResponse } from "next/server";
import crypto from "crypto";
import { db } from "@/lib/db";

type Holder = { wallet: string; balance: number };

function sha256Hex(s: string) {
  return crypto.createHash("sha256").update(s).digest("hex");
}

function baseUrl() {
  if (process.env.NEXT_PUBLIC_BASE_URL) return process.env.NEXT_PUBLIC_BASE_URL;
  return "http://localhost:3000";
}

function cycleIdNow(minutes = Number(process.env.CYCLE_MINUTES || 10)): string {
  const d = new Date();
  d.setSeconds(0, 0);
  const m = d.getMinutes();
  const r = m % minutes;
  d.setMinutes(r ? m + (minutes - r) : m + minutes);
  return String(+d);
}

export async function GET() {
  try {
    // 1) pull current holders (already filtered & >=10k by /api/holders)
    const res = await fetch(`${baseUrl()}/api/holders`, { cache: "no-store" });
    const { holders = [] } = (await res.json()) as { holders: Holder[] };
    const eligible = holders;
    const eligibleCount = eligible.length;
    const totalBal = eligible.reduce((a, b) => a + (b.balance || 0), 0);

    // 2) read PREP for THIS cycle (what $PUMP we bought this cycle)
    const thisCycle = cycleIdNow();
    const prep = await db.getPrep(thisCycle);
    const cyclePump = Math.max(0, Number(prep?.acquiredPump || 0)); // UI units bought this cycle
    const allocPump = cyclePump * 0.95; // allocate 95% to holders (per your spec)

    // 3) pro-rata entitlements (UI units), independent per snapshot → old leftover stays
    const snapshotTs = new Date().toISOString();
    const snapshotId = String(Date.now());

    const entRows = [];
    if (allocPump > 0 && totalBal > 0) {
      for (const h of eligible) {
        const share = (h.balance / totalBal) * allocPump;
        if (share > 0) {
          entRows.push({
            snapshotId,
            wallet: h.wallet,
            amount: share,
            claimed: false,
          });
        }
      }
      await db.addEntitlements(entRows);
    }

    // 4) persist snapshot meta (deltaPump = allocPump)
    const bodyHash = sha256Hex(JSON.stringify({ eligible }, null, 0));
    await db.addSnapshot({
      cycleId: thisCycle,
      snapshotId,
      snapshotTs,
      deltaPump: allocPump,
      eligibleCount,
      holdersHash: bodyHash,
      // If your db.ts defines holdersCsvPath, you can add it here later
    });

    // 5) respond for UI
    return NextResponse.json(
      {
        snapshotId,
        snapshotTs,
        snapshotHash: bodyHash,
        holders: eligible,
        eligible,
        pumpBalance: allocPump,
        perHolder: eligibleCount > 0 ? allocPump / eligibleCount : 0,
      },
      { headers: { "cache-control": "no-store" } }
    );
  } catch (e) {
    console.error("snapshot error:", e);
    return NextResponse.json(
      {
        snapshotId: null,
        snapshotTs: null,
        snapshotHash: null,
        holders: [],
        eligible: [],
        pumpBalance: 0,
        perHolder: 0,
      },
      { headers: { "cache-control": "no-store" } }
    );
  }
}
