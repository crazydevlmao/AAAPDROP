// app/api/tick/route.ts
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

import { NextResponse } from "next/server";

// OPTIONAL: if your internal routes expect extra params, tweak here.
const CYCLE_MINUTES = Number(process.env.CYCLE_MINUTES || 10);
const PREP_OFFSET_SECONDS = Number(process.env.PREP_OFFSET_SECONDS || 120);
const SNAPSHOT_OFFSET_SECONDS = Number(process.env.SNAPSHOT_OFFSET_SECONDS || 8);
const CRON_SECRET = process.env.CRON_SECRET || ""; // set this in Render

function nextBoundary(minutes = CYCLE_MINUTES, from = new Date()) {
  const d = new Date(from);
  d.setSeconds(0, 0);
  const m = d.getMinutes();
  const r = m % minutes;
  d.setMinutes(r ? m + (minutes - r) : m + minutes);
  return d;
}

let lastCycleKeyPrep = "";      // in-memory de-dupe (Render keeps process hot)
let lastCycleKeySnapshot = "";

export async function GET(req: Request) {
  // Simple auth so randos can't spam your tick
  const key = req.headers.get("x-cron-key") || "";
  if (!CRON_SECRET || key !== CRON_SECRET) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const now = new Date();
  const boundary = nextBoundary(CYCLE_MINUTES, now); // next cut
  const msLeft = +boundary - +now;                   // ms until next cut
  const sLeft = Math.floor(msLeft / 1000);
  const cycleKey = boundary.toISOString().slice(0, 16); // e.g. 2025-09-24T20:10

  const actions: string[] = [];

  // PREP window (trigger once per cycle)
  if (
    sLeft <= PREP_OFFSET_SECONDS &&
    sLeft >= PREP_OFFSET_SECONDS - 10 &&      // allow cron slop
    lastCycleKeyPrep !== cycleKey
  ) {
    actions.push("prepare-drop");
    lastCycleKeyPrep = cycleKey;
    try {
      await fetch(new URL("/api/prepare-drop", req.url).toString(), { method: "POST", cache: "no-store" });
    } catch {}
  }

  // SNAPSHOT window (trigger once per cycle)
  if (
    sLeft <= SNAPSHOT_OFFSET_SECONDS + 10 &&  // allow cron slop
    sLeft >= Math.max(0, SNAPSHOT_OFFSET_SECONDS - 10) &&
    lastCycleKeySnapshot !== cycleKey
  ) {
    actions.push("snapshot");
    lastCycleKeySnapshot = cycleKey;

    // Build snapshot URL (match your page.tsx params)
    const u = new URL("/api/snapshot", req.url);
    if (process.env.NEXT_PUBLIC_COIN_MINT) u.searchParams.set("mint", process.env.NEXT_PUBLIC_COIN_MINT);
    u.searchParams.set("min", "10000");
    if (process.env.NEXT_PUBLIC_BLACKLIST || process.env.NEXT_PUBLIC_PUMPFUN_AMM) {
      const list = [
        ...(process.env.NEXT_PUBLIC_BLACKLIST || "").split(",").map(s => s.trim()).filter(Boolean),
        (process.env.NEXT_PUBLIC_PUMPFUN_AMM || "").trim()
      ].filter(Boolean).join(",");
      if (list) u.searchParams.set("blacklist", list);
    }

    try {
      await fetch(u.toString(), { cache: "no-store" });
    } catch {}
  }

  return NextResponse.json({
    ok: true,
    now: now.toISOString(),
    secondsLeft: sLeft,
    actionsFired: actions,
    cycle: cycleKey
  }, { headers: { "cache-control": "no-store" } });
}
