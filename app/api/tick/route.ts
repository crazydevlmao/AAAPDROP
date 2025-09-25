export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

import { NextResponse } from "next/server";

/** Build a prod-safe origin */
function originFrom(req: any) {
  if (process.env.INTERNAL_BASE_URL) return process.env.INTERNAL_BASE_URL.replace(/\/$/, "");
  if (process.env.NEXT_PUBLIC_BASE_URL) return process.env.NEXT_PUBLIC_BASE_URL.replace(/\/$/, "");
  const u = new URL(req.url);
  return `${u.protocol}//${u.host}`;
}

/** Default APIs to ping. Add more via TICK_EXTRA_PATHS (comma-separated) */
function pathsToPing(): string[] {
  const defaults = ["/api/snapshot", "/api/holders"];
  const extra = (process.env.TICK_EXTRA_PATHS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((p) => (p.startsWith("/") ? p : `/${p}`));
  return Array.from(new Set([...defaults, ...extra]));
}

function trimBodyForLog(body: any) {
  try {
    const s = JSON.stringify(body);
    if (s.length <= 600) return body;
    return { note: "truncated", preview: s.slice(0, 600) };
  } catch {
    return { note: "non-json-or-empty-body" };
  }
}

export async function GET(req: any) {
  const startAll = Date.now();
  const u = new URL(req.url);

  // Optional shared-secret ?token=...
  const token = u.searchParams.get("token");
  if (process.env.TICK_TOKEN && token !== process.env.TICK_TOKEN) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const base = originFrom(req);
  const ts = Date.now();

  const targets = pathsToPing();

  const results = await Promise.allSettled(
    targets.map(async (path) => {
      const url = `${base}${path}?ts=${ts}`;
      const t0 = Date.now();
      try {
        const r = await fetch(url, { cache: "no-store" });
        const dur = Date.now() - t0;

        let body: any;
        try { body = await r.json(); } catch { body = { note: "non-json-or-empty-body" }; }

        return {
          path,
          status: r.status,
          ok: r.ok,
          ms: dur,
          body: trimBodyForLog(body),
        };
      } catch (e: any) {
        const dur = Date.now() - t0;
        return { path, status: 0, ok: false, ms: dur, error: String(e) };
      }
    })
  );

  const flattened = results.map((res, i) =>
    res.status === "fulfilled"
      ? res.value
      : { path: targets[i], ok: false, status: 0, ms: 0, error: String(res.reason) }
  );

  const anyOk = flattened.some((r) => r.ok);

  return NextResponse.json(
    { ok: anyOk, totalMs: Date.now() - startAll, hits: flattened },
    { status: anyOk ? 200 : 202, headers: { "cache-control": "no-store" } }
  );
}
