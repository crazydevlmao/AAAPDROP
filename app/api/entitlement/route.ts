export const runtime = "nodejs";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const wallet = (url.searchParams.get("wallet") || "").trim().toLowerCase();
  if (!wallet) return NextResponse.json({ entitled: 0, claimed: 0, unclaimed: 0 });

  const rows = await db.listWalletEntitlements(wallet);
  let entitled = 0, claimed = 0;
  for (const r of rows) {
    const amt = Number(r.amount || 0);
    entitled += amt;
    if (r.claimed) claimed += amt;
  }
  const unclaimed = Math.max(0, entitled - claimed);

  return NextResponse.json({ entitled, claimed, unclaimed }, { headers: { "cache-control": "no-store" } });
}
