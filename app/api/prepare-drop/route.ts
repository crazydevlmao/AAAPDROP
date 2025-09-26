// app/api/prepare-drop/route.ts
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  VersionedTransaction,
  clusterApiUrl,
  SystemProgram,
  TransactionMessage,
  MessageV0,
} from "@solana/web3.js";
import bs58 from "bs58";
import { db } from "@/lib/db";

/* =================== Tunables (trimmed to avoid timeouts) =================== */
const TEAM_PCT = 0.10;              // 10% to TEAM
const TREASURY_SOL_PCT = 0.85;      // 85% to TREASURY (rest stays on DEV as buffer)
const SWAP_IN_TREASURY_PCT = 0.95;  // swap 95% of received SOL in Treasury

// Keep API under ~10–12s so the worker doesn’t AbortError
const POLL_TRIES_DELTA = 8;         // was 18
const POLL_DELAY_MS = 700;          // was 900

// Faster check for Treasury balance increase (don’t block long)
const TREAS_POLL_TRIES = 6;         // was 18
const TREAS_POLL_DELAY = 600;       // was 900

const SLIPPAGES_BPS = [100, 200, 300];

const MIN_DEV_BUFFER_SOL =
  typeof process.env.MIN_DEV_BUFFER_SOL === "string"
    ? Math.max(0, Number(process.env.MIN_DEV_BUFFER_SOL))
    : 0.004;

const PUMP_MINT = "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn";

const noStore = { "cache-control": "no-store, no-cache, must-revalidate, max-age=0" };

/* =================== Helpers =================== */
function pickRpc() {
  return process.env.HELIUS_RPC || process.env.SOLANA_RPC || clusterApiUrl("mainnet-beta");
}
function pk(s?: string) {
  if (!s) throw new Error("Missing public key in env");
  return new PublicKey(s);
}
function kpFromBase58(secret?: string) {
  if (!secret) throw new Error("Missing base58 secret in env");
  const bytes = bs58.decode(secret.trim());
  return Keypair.fromSecretKey(bytes);
}
function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
async function getSolBalance(conn: Connection, pubkey: PublicKey, comm: "confirmed" | "finalized" = "confirmed") {
  return (await conn.getBalance(pubkey, comm)) / LAMPORTS_PER_SOL;
}
async function sendSol(conn: Connection, from: Keypair, to: PublicKey, lamports: number) {
  if (lamports <= 0) return null;
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("finalized");
  const ix = SystemProgram.transfer({ fromPubkey: from.publicKey, toPubkey: to, lamports });
  const msg = new TransactionMessage({ payerKey: from.publicKey, recentBlockhash: blockhash, instructions: [ix] }).compileToV0Message();
  const tx = new VersionedTransaction(msg as MessageV0);
  tx.sign([from]);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
  await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  return sig;
}
async function pollSolDelta(conn: Connection, owner: PublicKey, preSol: number) {
  for (let i = 0; i < POLL_TRIES_DELTA; i++) {
    const b = await getSolBalance(conn, owner);
    const d = Math.max(0, b - preSol);
    if (d > 0) return { postSol: b, deltaSol: d };
    await sleep(POLL_DELAY_MS);
  }
  const b = await getSolBalance(conn, owner);
  return { postSol: b, deltaSol: Math.max(0, b - preSol) };
}
async function waitTreasuryIncrease(conn: Connection, treasury: PublicKey, preTreasSol: number, expectedDeltaSol: number) {
  const tol = Math.max(0.0001, expectedDeltaSol * 0.01);
  for (let i = 0; i < TREAS_POLL_TRIES; i++) {
    const cur = await getSolBalance(conn, treasury);
    if (cur >= preTreasSol + expectedDeltaSol - tol) return cur;
    await sleep(TREAS_POLL_DELAY);
  }
  return await getSolBalance(conn, treasury);
}

/** Only accept a tx as "creator rewards" if logs contain `collect_creator_fee`. */
async function isCollectCreatorFee(conn: Connection, sig: string): Promise<boolean> {
  try {
    await conn.confirmTransaction(sig, "finalized");
    const tx = await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "finalized" });
    const logs: string[] = (tx?.meta?.logMessages || []).filter(Boolean) as string[];
    return logs.some(l => l.toLowerCase().includes("collect_creator_fee"));
  } catch {
    return false;
  }
}

async function jupQuote(solUiAmount: number, slippageBps: number) {
  const inputMint = "So11111111111111111111111111111111111111112";
  const outputMint = PUMP_MINT;
  const amountLamports = Math.floor(solUiAmount * LAMPORTS_PER_SOL); // integer
  if (amountLamports <= 0) throw new Error("Jupiter: zero amount");
  const url =
    `https://quote-api.jup.ag/v6/quote?inputMint=${inputMint}` +
    `&outputMint=${outputMint}` +
    `&amount=${amountLamports}` +
    `&slippageBps=${slippageBps}` +
    `&enableDexes=pump,meteora,raydium` +
    `&onlyDirectRoutes=false`;
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`Jupiter quote failed: ${r.status}`);
  const j = await r.json();
  if (!j || !j.routePlan?.length) throw new Error("Jupiter: no routes");
  return j;
}
async function jupSwap(conn: Connection, signer: Keypair, quoteResp: any) {
  const swapReq = {
    quoteResponse: quoteResp,
    userPublicKey: signer.publicKey.toBase58(),
    wrapAndUnwrapSol: true,
    dynamicComputeUnitLimit: true,
    prioritizationFeeLamports: "auto",
  };
  const r = await fetch("https://quote-api.jup.ag/v6/swap", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(swapReq),
  });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`Jupiter swap failed: ${r.status} ${txt}`);
  }
  const { swapTransaction } = await r.json();
  const txBytes = Uint8Array.from(Buffer.from(swapTransaction, "base64"));
  const tx = VersionedTransaction.deserialize(txBytes);
  tx.sign([signer]);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
  await conn.confirmTransaction(sig, "confirmed");
  return sig;
}
function requireSecret(req: Request) {
  const s = process.env.DROP_SECRET;
  if (!s) return; // optional
  const got = req.headers.get("x-drop-secret");
  if (got !== s) throw new Error("Unauthorized (invalid x-drop-secret)");
}
function cycleIdNow(minutes = Number(process.env.CYCLE_MINUTES || 10)): string {
  const d = new Date();
  d.setSeconds(0, 0);
  const m = d.getMinutes();
  const r = m % minutes;
  d.setMinutes(r ? m + (minutes - r) : m + minutes);
  return String(+d);
}

/* =================== Route =================== */
export async function POST(req: Request) {
  try {
    requireSecret(req);

    const API_KEY = process.env.PUMPPORTAL_API_KEY;
    if (!API_KEY) throw new Error("Missing PUMPPORTAL_API_KEY");

    const COIN_MINT = process.env.NEXT_PUBLIC_COIN_MINT;
    if (!COIN_MINT) throw new Error("Missing NEXT_PUBLIC_COIN_MINT");

    const DEV = kpFromBase58(process.env.DEV_WALLET_SECRET);
    const TREASURY_PUB = pk(process.env.TREASURY || process.env.NEXT_PUBLIC_TREASURY);
    const TEAM_PUB = pk(process.env.TEAM_WALLET);

    const TREASURY_SECRET = process.env.TREASURY_SECRET?.trim();
    const TREASURY_KP = TREASURY_SECRET ? kpFromBase58(TREASURY_SECRET) : null;
    if (!TREASURY_KP) {
      return NextResponse.json(
        { ok: false, error: "Missing TREASURY_SECRET; required to swap in Treasury." },
        { status: 400, headers: noStore }
      );
    }

    const conn = new Connection(pickRpc(), "confirmed");
    const thisCycle = cycleIdNow();

    // ===== Idempotency guard (allow retry if swap didn't happen yet) =====
    const existing = await db.getPrep(thisCycle);
    if (existing) {
      if (Number(existing.acquiredPump) > 0) {
        return NextResponse.json(
          { ok: true, step: "already-prepared", cycleId: thisCycle, prep: existing },
          { headers: noStore }
        );
      }
      // If we already moved SOL to Treasury and tried swap (or delta was zero), also stop
      if (existing.swapSigTreas || existing.status === "swap_failed_or_dust" || existing.status === "ok") {
        // We consider this cycle handled; snapshot will use existing.prep fields.
        return NextResponse.json(
          { ok: true, step: "already-prepared", cycleId: thisCycle, prep: existing },
          { headers: noStore }
        );
      }
    }

    /* 1) Collect creator rewards */
    const preSolDev = await getSolBalance(conn, DEV.publicKey);
    const claimRes = await fetch(`https://pumpportal.fun/api/trade?api-key=${API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "collectCreatorFee", priorityFee: 0.000001, pool: "pump", mint: COIN_MINT }),
    });

    let claimJson: any = {};
    try { claimJson = await claimRes.json(); } catch {}
    let claimSig: string | null = claimJson?.signature || claimJson?.txSignature || null;

    // verify it’s really collect_creator_fee
    if (claimSig) {
      const ok = await isCollectCreatorFee(conn, claimSig);
      if (!ok) claimSig = null;
    }

    const { deltaSol } = await pollSolDelta(conn, DEV.publicKey, preSolDev);

    if (deltaSol <= 0) {
      await db.upsertPrep({
        cycleId: thisCycle,
        acquiredPump: 0,
        pumpToTreasury: 0,
        pumpToTeam: 0,
        claimedSol: 0,
        claimSig: claimSig || undefined,
        status: "ok",
        ts: new Date().toISOString(),
        creatorSolDelta: 0,
        toTeamSolLamports: 0,
        toTreasurySolLamports: 0,
        toSwapUi: 0,
        swapOutPumpUi: 0,
        swapSigs: [],
        splitSigs: [],
      });
      return NextResponse.json({ ok: true, step: "claimed-zero", claimSig, deltaSol: 0 }, { headers: noStore });
    }

    /* 2) Split SOL (don’t spend too long waiting) */
    const freshLamports = Math.floor(deltaSol * LAMPORTS_PER_SOL);
    const teamLamports = Math.floor(freshLamports * TEAM_PCT);
    const treasuryLamports = Math.floor(freshLamports * TREASURY_SOL_PCT);

    const keepLamports = Math.max(0, freshLamports - teamLamports - treasuryLamports);
    const mustKeep = Math.floor(MIN_DEV_BUFFER_SOL * LAMPORTS_PER_SOL);
    const adjustedTreasuryLamports =
      keepLamports >= mustKeep ? treasuryLamports : Math.max(0, treasuryLamports - (mustKeep - keepLamports));

    let teamSig: string | null = null;
    if (teamLamports > 0) {
      teamSig = await sendSol(conn, DEV, TEAM_PUB, teamLamports);
      await sleep(200);
    }

    let treasuryMoveSig: string | null = null;
    const preTreasSol = await getSolBalance(conn, TREASURY_PUB);
    if (adjustedTreasuryLamports > 0) {
      treasuryMoveSig = await sendSol(conn, DEV, TREASURY_PUB, adjustedTreasuryLamports);
    }

    // Try a short wait for Treasury balance to reflect; fall back to theoretical amount
    let postTreasSol = preTreasSol;
    if (adjustedTreasuryLamports > 0) {
      postTreasSol = await waitTreasuryIncrease(conn, TREASURY_PUB, preTreasSol, adjustedTreasuryLamports / LAMPORTS_PER_SOL);
    }

    /* 3) Swap in Treasury (retry slippages but don’t hang forever) */
    const receivedSol =
      postTreasSol - preTreasSol > 0 ? postTreasSol - preTreasSol : adjustedTreasuryLamports / LAMPORTS_PER_SOL;
    const toSwapUi = Math.max(0, receivedSol * SWAP_IN_TREASURY_PCT);

    let swapSigTreas: string | null = null;
    let pumpBoughtUi = 0;

    if (toSwapUi > 0) {
      let lastErr: any = null;
      for (const s of SLIPPAGES_BPS) {
        try {
          const quote = await jupQuote(toSwapUi, s);
          // Estimate outAmount from quote (UI units), guarded
          try { pumpBoughtUi = Number(quote?.outAmount ?? 0) / 1e6; } catch {}
          swapSigTreas = await jupSwap(conn, TREASURY_KP!, quote);
          break;
        } catch (e) {
          lastErr = e;
          await sleep(500);
        }
      }
      if (!swapSigTreas) {
        await db.upsertPrep({
          cycleId: thisCycle,
          acquiredPump: 0,
          pumpToTreasury: 0,
          pumpToTeam: 0,
          claimSig: claimSig || undefined,
          teamSig: teamSig || undefined,
          treasuryMoveSig: treasuryMoveSig || undefined,
          swapSigTreas: undefined,
          status: "swap_failed_or_dust",
          ts: new Date().toISOString(),
          creatorSolDelta: deltaSol,
          toTeamSolLamports: teamLamports,
          toTreasurySolLamports: adjustedTreasuryLamports,
          toSwapUi,
          swapOutPumpUi: 0,
          splitSigs: [teamSig!, treasuryMoveSig!].filter(Boolean),
          swapSigs: [],
        });
        return NextResponse.json(
          { ok: true, step: "treasury-swap-failed", reason: String(lastErr) },
          { headers: noStore }
        );
      }
    }

    // Persist prep for THIS cycle
    await db.upsertPrep({
      cycleId: thisCycle,
      acquiredPump: pumpBoughtUi,                // UI units
      pumpToTreasury: pumpBoughtUi,
      pumpToTeam: 0,
      claimSig: claimSig || undefined,          // only if it’s really collect_creator_fee
      teamSig: teamSig || undefined,
      treasuryMoveSig: treasuryMoveSig || undefined,
      swapSigTreas: swapSigTreas || undefined,
      swapSigs: swapSigTreas ? [swapSigTreas] : [],
      splitSigs: [teamSig!, treasuryMoveSig!].filter(Boolean),
      status: "ok",
      ts: new Date().toISOString(),
      creatorSolDelta: deltaSol,                 // SOL delta in DEV
      toTeamSolLamports: teamLamports,
      toTreasurySolLamports: adjustedTreasuryLamports,
      toSwapUi,
      swapOutPumpUi: pumpBoughtUi,
    });

    return NextResponse.json(
      {
        ok: true,
        step: "complete",
        cycleId: thisCycle,
        claimSig,
        splits: {
          toTeamSolLamports: teamLamports,
          toTreasurySolLamports: adjustedTreasuryLamports,
          keptOnDevLamports: freshLamports - teamLamports - adjustedTreasuryLamports,
        },
        txs: { teamSig, treasuryMoveSig, swapSigTreas },
        notes: "Prepared. Snapshot will allocate this cycle’s PUMP to eligible holders.",
      },
      { headers: noStore }
    );
  } catch (e: any) {
    console.error("prepare-drop error:", e);
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 500, headers: noStore });
  }
}

export async function GET(req: Request) {
  return POST(req);
}
