// worker/scheduler.js
const { setTimeout: sleep } = require("timers/promises");

// ===== Config =====
const CYCLE_MINUTES = Number(process.env.CYCLE_MINUTES || 10);
const WINDOW_MS = CYCLE_MINUTES * 60_000;

const PREP_LEAD_MS = 120_000;  // prepare-drop at t-2m
const SNAP_LEAD_MS = 8_000;    // snapshot at t-8s
const SNAP_GRACE_MS = 90_000;  // allow +90s after snapAt

const JITTER_MS = 250 + Math.floor(Math.random() * 500);

// ----- Utils -----
function baseUrl() {
  const origin =
    process.env.INTERNAL_BASE_URL ||
    process.env.NEXT_PUBLIC_BASE_URL ||
    process.env.WORKER_BASE_URL ||
    "";
  if (!origin) throw new Error("Set INTERNAL_BASE_URL (or NEXT_PUBLIC_BASE_URL / WORKER_BASE_URL).");
  return origin.replace(/\/$/, "");
}
function headers(extra) {
  const h = {
    "cache-control": "no-store",
    pragma: "no-cache",
    "user-agent": "pow-worker/1.1",
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
// Sleep in small chunks so logs don’t go dark for ages
async function sleepUntil(ts, tickMs = 5_000) {
  for (;;) {
    const d = ts - Date.now();
    if (d <= 0) break;
    await sleep(Math.min(d, tickMs));
  }
}
async function fetchJson(url, init = {}, timeoutMs = 30000, attempts = 5) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(url, { ...init, signal: ctrl.signal });
      let j = null;
      try { j = await r.json(); } catch {}
      return { ok: r.ok, status: r.status, json: j };
    } catch (e) {
      lastErr = e;
      await sleep(400 + 400 * i);
    } finally {
      clearTimeout(t);
    }
  }
  throw lastErr;
}

// ----- Actions -----
async function ensurePrepare(cycleId, base, untilMs) {
  let attempt = 0;
  while (Date.now() < untilMs) {
    attempt++;
    try {
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
        console.warn(`[worker] prepare-drop ${cycleId}: unexpected step`, step);
      } else {
        console.warn(`[worker] prepare-drop ${cycleId} failed (${status})`, json);
      }
    } catch (e) {
      console.warn(`[worker] prepare-drop ${cycleId} network error`, String(e));
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
    try {
      const { ok, status, json } = await fetchJson(`${base}/api/snapshot?ts=${Date.now()}`, {
        headers: headers(),
      });

      if (!ok && status >= 500) {
        console.warn(`[worker] snapshot ${cycleId}: server ${status}`, json);
        await sleep(Math.min(1000 * attempt, 3000));
        continue;
      }

      const st = json && json.status;
      if (st === "taken") {
        console.log(`[worker] snapshot ${cycleId}: taken`);
        return true;
      }
      if (st === "pending") {
        await sleepUntil(snapAt, 200); // fine-grained wait until snapAt
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
      // Unknown reply; backoff a bit
      await sleep(Math.min(500 * attempt, 1500));
    } catch (e) {
      console.warn(`[worker] snapshot ${cycleId} network error`, String(e));
      await sleep(Math.min(1000 * attempt, 3000));
    }
  }

  console.error(`[worker] snapshot ${cycleId}: grace window exhausted`);
  return false;
}

// ----- Main loop + heartbeat -----
(async function main() {
  const base = baseUrl();
  console.log(`[worker] booting. base=${base}, cycle=${CYCLE_MINUTES}m, jitter=${JITTER_MS}ms`);
  await sleep(JITTER_MS);

  // Heartbeat every 60s so logs prove liveness
  setInterval(() => {
    const { start, end, prepAt, snapAt, cycleId } = windowInfo();
    console.log(
      `[worker] hb cycle=${cycleId} start=${new Date(start).toISOString()} end=${new Date(end).toISOString()} ` +
      `prepAt=${new Date(prepAt).toISOString()} snapAt=${new Date(snapAt).toISOString()}`
    );
  }, 60_000).unref?.();

  // If booted inside grace, try snapshot immediately
  {
    const { snapAt, cycleId } = windowInfo();
    const now = Date.now();
    if (now >= snapAt && now <= snapAt + SNAP_GRACE_MS) {
      console.log(`[worker] startup inside grace → snapshot ${cycleId}`);
      await ensureSnapshot(cycleId, base, snapAt);
    }
  }

  while (true) {
    const now = Date.now();
    const { end, prepAt, snapAt, cycleId } = windowInfo(now);

    console.log(
      `[worker] cycle ${cycleId}: ` +
      `prepAt=${new Date(prepAt).toISOString()}, snapAt=${new Date(snapAt).toISOString()}, end=${new Date(end).toISOString()}`
    );

    // Wait to t-2m, then ensure prepare
    if (now < prepAt) await sleepUntil(prepAt - 50);
    await ensurePrepare(cycleId, base, snapAt - 500);

    // Wait to t-8s, then snapshot within grace
    let now2 = Date.now();
    if (now2 < snapAt) await sleepUntil(snapAt - 30);
    await ensureSnapshot(cycleId, base, snapAt);

    // Idle until window end
    const after = Date.now();
    if (after < end + 200) await sleepUntil(end + 200);
  }
})().catch((e) => {
  console.error("[worker] fatal:", e);
  process.exit(1);
});

