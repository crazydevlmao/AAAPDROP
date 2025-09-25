// Derive a "cycle id" based on the next 10-min boundary; used for idempotency & logs
export const CYCLE_MINUTES = Number(process.env.CYCLE_MINUTES || 10);

export function nextBoundary(from = new Date(), minutes = CYCLE_MINUTES): Date {
  const d = new Date(from);
  d.setSeconds(0, 0);
  const m = d.getMinutes();
  const r = m % minutes;
  d.setMinutes(r ? m + (minutes - r) : m + minutes);
  return d;
}

// cycleId = ISO without seconds/millis (e.g. 2025-09-23T12:30Z)
export function cycleIdFor(ts: Date) {
  const d = new Date(ts);
  d.setUTCSeconds(0, 0);
  return d.toISOString().slice(0, 16) + "Z";
}
