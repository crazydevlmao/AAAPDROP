// app/api/entitlement/route.ts
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

import { NextResponse } from "next/server";
import { db } from "@/lib/db";

/** Keep in sync with snapshot/claim-preview */
const DECIMALS = 6;
const TEN_POW_DEC = Math.pow(10, DECIMALS);
const ENTITLEMENT_IS_RAW = String(process.env.ENTITLEMENT_IS_RAW || "").toLowerCase() === "true";

function toNumberSafe(v: any): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  if (v && typeof v.toNumber === "function") {
    const n = Number(v.toNumber());
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function isClaimedTrue(v: any): boolean {
  if (v === true || v === 1) return true;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    return s === "true" || s === "1" || s === "yes";
  }
  return false;
}

/** Convert DB amount to UI units honoring ENTITLEMENT_IS_RAW */
function toUiAmount(n: any): number {
  const num = toNumberSafe(n);
  if (num <= 0) return 0;
  return ENTITLEMENT_IS_RAW ? num / TEN_POW_DEC : num;
}

const noStore = { headers: { "cache-control": "no-store, no-cache, must-revalidate, max-age=0" } };

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const wallet = (url.searchParams.get("wallet") || "").trim();
    if (!wallet) {
      return NextResponse.json({ entitled: 0, claimed: 0, unclaimed: 0 }, noStore);
    }

    // All entitlement wallet keys are stored lowercased
    const walletLc = wallet.toLowerCase();

    const rows: any[] = await db.listWalletEntitlements(walletLc);

    let entitled = 0;
    let claimed = 0;

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i] || {};
      const ui = toUiAmount(r.amount);
      entitled += ui;
      if (isClaimedTrue(r.claimed)) claimed += ui;
    }

    const unclaimed = Math.max(0, entitled - claimed);

    return NextResponse.json({ entitled, claimed, unclaimed }, noStore);
  } catch (e: any) {
    return NextResponse.json(
      { entitled: 0, claimed: 0, unclaimed: 0, error: String(e?.message || e) },
      { status: 500, ...noStore }
    );
  }
}
