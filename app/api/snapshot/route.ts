// app/api/snapshot/route.ts
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

import { NextResponse } from "next/server";
import crypto from "crypto";
import { db } from "@/lib/db";

type Holder = { wallet: string; balance: number };

// === WINDOW / GRACE CONFIG ===
const CYCLE_MINUTES = Number(process.env.CYCLE_MINUTES || 10);
const SAFETY_LEAD_MS = 8_000;   // take at t-8s before window end
const GRACE_AFTER_MS = 90_000;  // allow up to 90s late
const WINDOW_MS = CYCLE_MINUTES * 60_000;

function sha256Hex(s: string) {
  return crypto.createHash("sha256").update(s).digest("hex");
}

/** Prod-safe base URL builder. */
function baseUrl(req: Request) {
  if (process.env.INTERNAL_BASE_URL) return process.env.INTERNAL_BASE_URL.replace(/\/$/, "");
  if (process.env.NEXT_PUBLIC_BASE_URL) return process.env.NEXT_PUBLIC_BASE_URL.replace(/\/$/, "");
  const u = new URL(req.url);
  return `${u.protocol}//${u.host}`;
}

/** Server-authoritative window math in UTC. */
function windowInfo(nowMs = Date.now()) {
  const idx = Math.floor(nowMs / WINDOW_MS);
  const start = idx * WINDOW_MS;
  const end = start + WINDOW_MS;
  const snapshotAt = end - SAFETY_LEAD_MS;
  // Use the window END (ms) as the stable ID → prevents dupes by design
  const cycleId = String(end);
  return { idx, start, end, snapshotAt, cycleId };
}

/** Optional helper: read snapshot if your db exposes it. Safe to be missing. */
async function readSnapshot(cycleId: string): Promise<any | null> {
  try {
    if (typeof (db as any).getSnapshot === "function") {
      return (db as any).getSnapshot(cycleId);
    }
    // If you use Prisma, you might have:
    // return (db as any).snapshot?.findUnique?.({ where: { cycleId } }) ?? null;
  } catch {}
  return null;
}

export async function GET(req: Request) {
  const noStore = { "cache-control": "no-store, no-cache, must-revalidate, max-age=0" };

  try {
    const now = Date.now();
    const { start, end, snapshotAt, cycleId } = windowInfo(now);
    const snapshotId = cycleId; // <— idempotent: 1 snapshot per cycle

    // 0) If already taken, just return it (no duplicate writes)
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
        },
        { headers: noStore }
      );
    }

    // 1) Not yet time → pending
    if (now < snapshotAt) {
      return NextResponse.json(
        { status: "pending", cycleId, window: { start, end, snapshotAt }, etaMs: snapshotAt - now },
        { headers: noStore }
      );
    }

    // 2) Due or within grace → TAKE it (idempotent path)
    if (now <= snapshotAt + GRACE_AFTER_MS) {
      // pull holders (already filtered by your /api/holders)
      const origin = baseUrl(req);
      const res = await fetch(`${origin}/api/holders?ts=${Date.now()}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`holders fetch failed: ${res.status}`);
      const { holders = [] } = (await res.json()) as { holders: Holder[] };

      const eligible = holders;
      const eligibleCount = eligible.length;
      const totalBal = eligible.reduce((a, b) => a + (b.balance || 0), 0);

      // read PREP for THIS cycle (what you bought this cycle)
      const prep = await (db as any).getPrep?.(cycleId);
      const cyclePump = Math.max(0, Number(prep?.acquiredPump || 0));
      const allocPump = cyclePump * 0.95;

      // compute entitlements in-memory
      const entRows: Array<{ snapshotId: string; wallet: string; amount: number; claimed: boolean }> = [];
      if (allocPump > 0 && totalBal > 0) {
        for (const h of eligible) {
          const share = (h.balance / totalBal) * allocPump;
          if (share > 0) {
            entRows.push({ snapshotId, wallet: h.wallet.toLowerCase(), amount: share, claimed: false });
          }
        }
      }

      // holders hash for dedupe/debug
      const holdersHash = sha256Hex(JSON.stringify({ eligible }, null, 0));
      const snapshotTs = new Date().toISOString();

      // 2a) Try to create the snapshot FIRST (so we can safely attach entitlements).
      // If your DB has UNIQUE(cycleId), second writers will throw → we read & return.
      try {
        await (db as any).addSnapshot?.({
          cycleId,
          snapshotId,
          snapshotTs,
          deltaPump: allocPump,
          eligibleCount,
          holdersHash,
        });
      } catch (e: any) {
        // Race: someone else created it. Read back and return.
        const again = await readSnapshot(cycleId);
        if (again) {
          return NextResponse.json(
            {
              status: "taken",
              cycleId,
              window: { start, end, snapshotAt },
              snapshotId: again.snapshotId ?? snapshotId,
              deltaPump: again.deltaPump ?? allocPump,
              eligibleCount: again.eligibleCount ?? eligibleCount,
              holdersHash: again.holdersHash ?? holdersHash,
              note: "race_won_elsewhere",
            },
            { headers: noStore }
          );
        }
        // If there is no unique and we still failed, rethrow
        throw e;
      }

      // 2b) Write entitlements AFTER snapshot exists (best-effort idempotency).
      // If your db.addEntitlements already de-duplicates (ON CONFLICT DO NOTHING on (snapshotId, wallet)),
      // this will be fully idempotent. If not, it still won’t double-write because the second writer never reaches here.
      if (entRows.length > 0) {
        await (db as any).addEntitlements?.(entRows);
      }

      // 2c) Done
      return NextResponse.json(
        {
          status: "taken",
          cycleId,
          window: { start, end, snapshotAt },
          snapshotId,
          snapshotTs,
          holders: eligible,
          eligible,
          pumpBalance: allocPump,
          perHolder: eligibleCount > 0 ? allocPump / eligibleCount : 0,
          holdersHash,
        },
        { headers: noStore }
      );
    }

    // 3) Beyond grace → declare missed (optional backfill policy could go here)
    return NextResponse.json(
      { status: "missed", cycleId, window: { start, end, snapshotAt }, missedByMs: now - snapshotAt },
      { status: 202, headers: noStore }
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
      { status: 500, headers: { "cache-control": "no-store" } }
    );
  }
}
