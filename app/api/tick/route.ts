// app/api/tick/route.ts
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

import { NextResponse } from "next/server";

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

function originFromReq(req: Request) {
  const u = new URL(req.url);
  return `${u.protocol}//${u.host}`;
}

let lastCycleKeyPrep = "";
let lastCycleKeySnapshot = "";

export async function GET(req: Request) {
  // simple auth
  const key = req.headers.get("x-cron-key") || "";
  if (!CRON_SECRET || key !== CRON_SECRET) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const origin = originFromReq(req);
  const now = new Date();
  const boundary = nextBoundary(CYCLE_MINUTES, now);
  const sLeft = Math.max(0, Math.floor((+boundary - +now) / 1000));
  const cycleKey = boundary.toISOString().slice(0, 16); // e.g. 2025-09-24T20:10
  const actions: string[] = [];

  // ==== PREP window ====
  // Fire once any time in the last PREP_OFFSET_SECONDS (default 120s) before boundary.
  if (sLeft <= PREP_OFFSET_SECONDS && lastCycleKeyPrep !== cycleKey) {
    actions.push("prepare-drop");
    lastCycleKeyPrep = cycleKey;
    try {
      await fetch(`${origin}/api/prepare-drop`, { method: "POST", cache: "no-store" });
    } catch {}
  }

  // ==== SNAPSHOT window ====
  // Fire once in the last max(30s, SNAPSHOT_OFFSET_SECONDS) before boundary.
  const snapshotWindow = Math.max(30, SNAPSHOT_OFFSET_SECONDS);
  if (sLeft <= snapshotWindow && lastCycleKeySnapshot !== cycleKey) {
    actions.push("snapshot");
    lastCycleKeySnapshot = cycleKey;

    const u = new URL(`${origin}/api/snapshot`);
    if (process.env.NEXT_PUBLIC_COIN_MINT) u.searchParams.set("mint", process.env.NEXT_PUBLIC_COIN_MINT);
    u.searchParams.set("min", "10000");
    if (process.env.NEXT_PUBLIC_BLACKLIST || process.env.NEXT_PUBLIC_PUMPFUN_AMM) {
      const list = [
        ...(process.env.NEXT_PUBLIC_BLACKLIST || "").split(",").map(s => s.trim()).filter(Boolean),
        (process.env.NEXT_PUBLIC_PUMPFUN_AMM || "").trim(),
      ].filter(Boolean).join(",");
      if (list) u.searchParams.set("blacklist", list);
    }

    try {
      await fetch(u.toString(), { cache: "no-store" });
    } catch {}
  }

  return NextResponse.json(
    { ok: true, now: now.toISOString(), secondsLeft: sLeft, actionsFired: actions, cycle: cycleKey, snapshotWindow },
    { headers: { "cache-control": "no-store" } }
  );
}
