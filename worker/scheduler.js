// worker/scheduler.js
const { setTimeout: sleep } = require("timers/promises");

// ===== Config (mirror your API routes) =====
const CYCLE_MINUTES = Number(process.env.CYCLE_MINUTES || 10);
const WINDOW_MS = CYCLE_MINUTES * 60_000;

const PREP_LEAD_MS = 120_000;   // prepare-drop at t-2m
const SNAP_LEAD_MS = 8_000;     // snapshot at t-8s
const SNAP_GRACE_MS = 90_000;   // accept up to +90s late

const JITTER_MS = 250 + Math.floor(Math.random() * 500); // tiny jitter at boot

function baseUrl() {
  const origin =
    process.env.INTERNAL_BASE_URL ||
    process.env.NEXT_PUBLIC_BASE_URL ||
    process.env.WORKER_BASE_URL ||
    "";
  if (!origin) {
    throw new Error(
      "Set INTERNAL_BASE_URL (or NEXT_PUBLIC_BASE_URL / WORKER_BASE_URL) for the worker."
    );
  }
  return origin.replace(/\/$/, "");
}

function headers(extra) {
  const h = {
    "cache-control": "no-store",
    pragma: "no-cache",
    "user-agent": "pow-worker/1.0",
  };
  if (process.env.DROP_SECRET) h["x-drop-secret"] = process.env.DROP_SECRET;
  if (extra) Object.assign(h, extra);
  return h;
}

function windowInfo(nowMs = Date.now()) {
  const idx = Math.floor(nowMs / WINDOW_MS);
  const start = idx * WINDOW_MS;
  const end = start + WINDOW_MS;
  const prepAt = end - PREP_LEAD_MS;
  const snapAt = end - SNAP_LEAD_MS;
  const cycleId = String(end);
  return { idx, start, end, prepAt, snapAt, cycleId };
}

async function fetchJson(url, init = {}, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...init, signal: ctrl.signal });
    let j = null;
    try { j = await r.json(); } catch {}
    return { ok: r.ok, status: r.status, json: j };
  } finally {
    clearTimeout(to);
  }
}

async function ensurePrepare(cycleId, base, untilMs) {
  let attempt = 0;
  while (Date.now() < untilMs) {
    attempt++;
    const { ok, status, json } = await fetchJson(`${base}/api/prepare-drop`, {
      method: "POST",
      headers: headers(),
    });
    if (ok) {
      const step = (json && json.step) || "ok";
      if (step === "already-prepared" || step === "complete" || step === "claimed-zero") {
        console.log(`[worker] prepare-drop ${cycleId}: ${step}`);
        return true;
      }
    } else {
      console.warn(`[worker] prepare-drop ${cycleId} failed (status ${status})`, json);
    }
    await sleep(Math.min(1500 * attempt, 5000));
  }
  console.error(`[worker] prepare-drop ${cycleId} not confirmed before snapshot window`);
  return false;
}

async function ensureSnapshot(cycleId, base, snapAt) {
  const deadline = snapAt + SNAP_GRACE_MS;
  let attempt = 0;

  while (Date.now() <= deadline) {
    attempt++;
    const { ok, status, json } = await fetchJson(`${base}/api/snapshot?ts=${Date.now()}`, {
      headers: headers(),
    });

    if (!ok && status >= 500) {
      console.warn(`[worker] snapshot ${cycleId}: server error ${status}`, json);
      await sleep(Math.min(1000 * attempt, 3000));
      continue;
    }

    const st = json && json.status;
    if (st === "taken") {
      console.log(`[worker] snapshot ${cycleId}: taken`);
      return true;
    }
    if (st === "pending") {
      const now = Date.now();
      const wait = Math.max(50, Math.min(500, snapAt - now));
      await sleep(wait);
      continue;
    }
    if (st === "missed") {
      console.error(`[worker] snapshot ${cycleId}: missed (by ${json && json.missedByMs}ms)`);
      return false;
    }
    if (st === "error") {
      console.warn(`[worker] snapshot ${cycleId}: route error`, json && json.message);
      await sleep(Math.min(1000 * attempt, 3000));
      continue;
    }

    await sleep(Math.min(500 * attempt, 1500));
  }

  console.error(`[worker] snapshot ${cycleId}: grace window exhausted`);
  return false;
}

(async function main() {
  const base = baseUrl();
  console.log(`[worker] booting. base=${base}, cycle=${CYCLE_MINUTES}m, jitter=${JITTER_MS}ms`);
  await sleep(JITTER_MS);

  // Startup catch-up: if we boot inside grace, try snapshot immediately
  {
    const { snapAt, cycleId } = windowInfo();
    const now = Date.now();
    if (now >= snapAt && now <= snapAt + SNAP_GRACE_MS) {
      console.log(`[worker] startup inside grace → attempting immediate snapshot for ${cycleId}`);
      await ensureSnapshot(cycleId, base, snapAt);
    }
  }

  while (true) {
    const now = Date.now();
    const { end, prepAt, snapAt, cycleId } = windowInfo(now);

    // Phase A: wait until t-2m, then ensure prepare-drop
    if (now < prepAt) await sleep(Math.max(0, prepAt - now - 50));
    await ensurePrepare(cycleId, base, snapAt - 500);

    // Phase B: wait until t-8s, then ensure snapshot (within grace)
    let now2 = Date.now();
    if (now2 < snapAt) await sleep(Math.max(0, snapAt - now2 - 30));
    await ensureSnapshot(cycleId, base, snapAt);

    // Phase C: idle until window end
    const after = Date.now();
    if (after < end + 200) await sleep(end + 200 - after);
  }
})().catch((e) => {
  console.error("[worker] fatal:", e);
  process.exit(1);
});
