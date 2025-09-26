// worker/scheduler.ts
import { setTimeout as sleep } from "timers/promises";

/* ===== Config (mirrors your API routes) ===== */
const CYCLE_MINUTES = Number(process.env.CYCLE_MINUTES || 10);
const WINDOW_MS = CYCLE_MINUTES * 60_000;

const PREP_LEAD_MS = 120_000;     // prepare-drop at t-2m
const SNAP_LEAD_MS = 8_000;       // snapshot at t-8s
const SNAP_GRACE_MS = 90_000;     // accept up to +90s late

const WORKER_ID = process.env.WORKER_ID || "pow-worker";
const JITTER_MS = 250 + Math.floor(Math.random() * 500); // tiny jitter at boot

/* ===== Utilities ===== */
function baseUrl(): string {
  const origin =
    process.env.INTERNAL_BASE_URL ||
    process.env.NEXT_PUBLIC_BASE_URL ||
    process.env.WORKER_BASE_URL || "";
  if (!origin) {
    throw new Error(
      "Set one of INTERNAL_BASE_URL / NEXT_PUBLIC_BASE_URL / WORKER_BASE_URL for the worker."
    );
  }
  return origin.replace(/\/$/, "");
}

function headers(extra?: Record<string, string>, requestId?: string) {
  const h: Record<string, string> = {
    "cache-control": "no-store",
    pragma: "no-cache",
    "user-agent": `${WORKER_ID}/1.1`,
  };
  if (process.env.DROP_SECRET) h["x-drop-secret"] = process.env.DROP_SECRET;
  if (requestId) h["x-request-id"] = requestId;
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

function rid(tag: string, cycleId: string) {
  return `${tag}-${cycleId}-${Math.random().toString(36).slice(2, 8)}`;
}

async function fetchJson(
  url: string,
  init: RequestInit = {},
  timeoutMs = 15_000
): Promise<{ ok: boolean; status: number; json: any }> {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...init, signal: ctrl.signal });
    let j: any = null;
    try { j = await r.json(); } catch {}
    return { ok: r.ok, status: r.status, json: j };
  } finally {
    clearTimeout(to);
  }
}

function backoffMs(base: number, attempt: number, cap: number) {
  const exp = base * Math.pow(1.6, attempt - 1);
  const jitter = Math.floor(Math.random() * 200);
  return Math.min(cap, Math.max(200, exp + jitter));
}

/* ===== Tasks ===== */
async function ensurePrepare(cycleId: string, base: string, untilMs: number) {
  let attempt = 0;
  while (Date.now() < untilMs) {
    attempt++;
    const reqId = rid("prep", cycleId);
    const { ok, status, json } = await fetchJson(`${base}/api/prepare-drop`, {
      method: "POST",
      headers: headers(undefined, reqId),
    });

    if (ok) {
      const step = json?.step || "ok";
      if (step === "already-prepared" || step === "complete" || step === "claimed-zero") {
        console.log(`[worker] prepare-drop ${cycleId}: ${step} (rid=${reqId})`);
        return true;
      }
      // Unknown “ok” response → still break; route is single-flight/idempotent.
      console.log(`[worker] prepare-drop ${cycleId}: ok(${step}) (rid=${reqId})`);
      return true;
    }

    // Fatal auth issues → stop trying
    if (status === 401 || status === 403) {
      console.error(`[worker] prepare-drop ${cycleId}: unauthorized (${status}); check DROP_SECRET (rid=${reqId})`);
      return false;
    }

    const is429 = status === 429;
    const is5xx = status >= 500;
    const wait = is429
      ? backoffMs(800, attempt, 6000)
      : is5xx
      ? backoffMs(1000, attempt, 5000)
      : backoffMs(600, attempt, 3000);

    console.warn(`[worker] prepare-drop ${cycleId} failed (status ${status}) (rid=${reqId})`, json);
    await sleep(Math.min(wait, Math.max(250, untilMs - Date.now())));
  }

  console.error(`[worker] prepare-drop ${cycleId} not confirmed before snapshot window`);
  return false;
}

async function ensureSnapshot(cycleId: string, base: string, snapAt: number) {
  const deadline = snapAt + SNAP_GRACE_MS;
  let attempt = 0;

  while (Date.now() <= deadline) {
    attempt++;
    const reqId = rid("snap", cycleId);
    const { ok, status, json } = await fetchJson(`${base}/api/snapshot?ts=${Date.now()}`, {
      headers: headers(undefined, reqId),
    });

    if (!ok) {
      if (status === 401 || status === 403) {
        console.error(`[worker] snapshot ${cycleId}: unauthorized (${status}); check DROP_SECRET (rid=${reqId})`);
        return false;
      }
      const is429 = status === 429;
      const is5xx = status >= 500;
      const wait = is429
        ? backoffMs(600, attempt, 3000)
        : is5xx
        ? backoffMs(800, attempt, 3000)
        : backoffMs(400, attempt, 2000);
      console.warn(`[worker] snapshot ${cycleId}: http ${status} (rid=${reqId})`, json);
      await sleep(Math.min(wait, Math.max(50, deadline - Date.now())));
      continue;
    }

    const st = json?.status;
    if (st === "taken") {
      console.log(`[worker] snapshot ${cycleId}: taken (rid=${reqId})`);
      return true;
    }
    if (st === "pending") {
      const now = Date.now();
      const wait = Math.max(50, Math.min(500, snapAt - now));
      await sleep(wait);
      continue;
    }
    if (st === "missed") {
      console.error(`[worker] snapshot ${cycleId}: missed (by ${json?.missedByMs}ms) (rid=${reqId})`);
      return false;
    }
    if (st === "error") {
      const wait = backoffMs(700, attempt, 2500);
      console.warn(`[worker] snapshot ${cycleId}: route error (rid=${reqId})`, json?.message);
      await sleep(Math.min(wait, Math.max(50, deadline - Date.now())));
      continue;
    }

    // Unknown but not fatal → small backoff
    await sleep(backoffMs(400, attempt, 1500));
  }

  console.error(`[worker] snapshot ${cycleId}: grace window exhausted`);
  return false;
}

/* ===== Main loop ===== */
async function main() {
  const base = baseUrl();
  console.log(`[worker] booting. base=${base}, cycle=${CYCLE_MINUTES}m, jitter=${JITTER_MS}ms, id=${WORKER_ID}`);
  await sleep(JITTER_MS);

  // Optional warm-up tick to catch “in-grace” startup
  {
    const { snapAt, cycleId } = windowInfo();
    if (Date.now() >= snapAt && Date.now() <= snapAt + SNAP_GRACE_MS) {
      console.log(`[worker] startup inside grace → attempting immediate snapshot for ${cycleId}`);
      await ensureSnapshot(cycleId, base, snapAt);
    }
  }

  while (true) {
    const now = Date.now();
    const { start, end, prepAt, snapAt, cycleId } = windowInfo(now);

    // Phase A: wait until t-2m then ensure prepare-drop
    if (now < prepAt) {
      await sleep(Math.max(0, prepAt - now - 50));
    }
    await ensurePrepare(cycleId, base, snapAt - 500);

    // Phase B: wait until t-8s then ensure snapshot (within grace)
    let now2 = Date.now();
    if (now2 < snapAt) {
      await sleep(Math.max(0, snapAt - now2 - 30));
    }
    await ensureSnapshot(cycleId, base, snapAt);

    // Phase C: small idle until window end, then loop
    const after = Date.now();
    if (after < end + 200) await sleep(end + 200 - after);
  }
}

/* ===== Safety: unhandled errors ===== */
process.on("unhandledRejection", (e) => {
  console.error("[worker] unhandledRejection:", e);
});
process.on("uncaughtException", (e) => {
  console.error("[worker] uncaughtException:", e);
});

main().catch((e) => {
  console.error("[worker] fatal:", e);
  process.exit(1);
});
