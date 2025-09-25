export const runtime = "nodejs";

import { NextResponse } from "next/server";
import crypto from "crypto";
import { db } from "@/lib/db";

type Holder = { wallet: string; balance: number };

function sha256Hex(s: string) {
  return crypto.createHash("sha256").update(s).digest("hex");
}

/**
 * Resolve the correct base URL in every environment.
 * Priority:
 * 1) INTERNAL_BASE_URL (set this explicitly on Render)
 * 2) RENDER_EXTERNAL_URL (Render system var)
 * 3) VERCEL_URL (Vercel system var)
 * 4) localhost for dev
 */
function baseUrl(): string {
  const explicit = process.env.INTERNAL_BASE_URL?.trim();
  if (explicit) return explicit.replace(/\/$/, "");

  const renderUrl = process.env.RENDER_EXTERNAL_URL?.trim();
  if (renderUrl) return `https://${renderUrl}`.replace(/\/$/, "");

  const vercelUrl = process.env.VERCEL_URL?.trim();
  if (vercelUrl) return `https://${vercelUrl}`.replace(/\/$/, "");

  // Local dev fallback
  return `http://127.0.0.1:${process.env.PORT || 3000}`;
}

/** Next cycle boundary ID (matches your timers) */
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
    // 1) Pull current holders (already pre-filtered by your /api/holders)
    const holdersRes = await fetch(`${baseUrl()}/api/holders`, {
      cache: "no-store",
      // IMPORTANT: no next:{ revalidate } here to avoid conflicting cache directives
    });

    if (!holdersRes.ok) {
      const txt = await holdersRes.text().catch(() => "");
      throw new Error(`holders fetch failed: ${holdersRes.status} ${txt}`);
    }

    const { holders = [] } = (await holdersRes.json()) as { holders: Holder[] };
    const eligible = Array.isArray(holders) ? holders : [];
    const eligibleCount = eligible.length;
    const totalBal = eligible.reduce((a, b) => a + (Number(b.balance) || 0), 0);

    // 2) Read PREP for THIS cycle (what $PUMP we bought this cycle)
    const thisCycle = cycleIdNow();
    const prep = await db.getPrep(thisCycle);
    const cyclePump = Math.max(0, Number(prep?.acquiredPump || 0)); // UI $PUMP units bought this cycle
    const allocPump = cyclePump * 0.95; // allocate 95% to holders (your rule)

    // 3) Pro-rata entitlements (independent per snapshot; old leftovers remain claimable)
    const snapshotTs = new Date().toISOString();
    const snapshotId = String(Date.now()); // keep your format; unique per invocation

    if (allocPump > 0 && totalBal > 0 && eligibleCount > 0) {
      const entRows = eligible.map((h) => ({
        snapshotId,
        wallet: String(h.wallet).toLowerCase(),
        amount: (Number(h.balance) / totalBal) * allocPump,
        claimed: false,
      }));
      // filter out any accidental NaN or 0s
      const cleaned = entRows.filter((r) => Number.isFinite(r.amount) && r.amount > 0);
      if (cleaned.length > 0) {
        await db.addEntitlements(cleaned);
      }
    }

    // 4) Persist snapshot meta (deltaPump = allocPump)
    const bodyHash = sha256Hex(JSON.stringify({ eligible }, null, 0));
    await db.addSnapshot({
      cycleId: thisCycle,
      snapshotId,
      snapshotTs,
      deltaPump: allocPump,
      eligibleCount,
      holdersHash: bodyHash,
      // holdersCsvPath: (optional) if/when you add CSV writing
    });

    // 5) Respond for UI
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
  } catch (e: any) {
    console.error("snapshot error:", e?.stack || e?.message || e);
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
