// lib/solana.ts
import {
  Connection,
  PublicKey,
  Keypair,
  clusterApiUrl,
  ComputeBudgetProgram,
  TransactionMessage,
  VersionedTransaction,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
} from "@solana/spl-token";

// $PUMP mint (override with NEXT_PUBLIC_PUMP_MINT if needed)
export const PUMP_MINT = new PublicKey(
  process.env.NEXT_PUBLIC_PUMP_MINT ?? "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn"
);

// Centralized RPC selection (same order you used)
function rpcUrl() {
  return (
    process.env.NEXT_PUBLIC_SOLANA_RPC ||
    process.env.SOLANA_RPC ||
    clusterApiUrl("mainnet-beta")
  );
}

export function connection() {
  return new Connection(rpcUrl(), "confirmed");
}

/**
 * Read a keypair from env in either JSON (array) or base58 formats.
 * e.g. JSON: "[12,34,...]"   or   base58: "3AbC...".
 */
export function keypairFromEnv(name: string): Keypair {
  const raw = process.env[name];
  if (!raw) throw new Error(`Missing ${name}`);
  let secret: Uint8Array;
  try {
    const arr = JSON.parse(raw);
    secret = Uint8Array.from(arr);
  } catch {
    // not JSON → assume base58
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const bs58 = require("bs58");
    secret = bs58.decode(raw.trim());
  }
  return Keypair.fromSecretKey(secret);
}

export function pubkeyFromEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name}`);
  return new PublicKey(v);
}

/**
 * Detect whether a mint is Token-2022 or classic by reading the account owner.
 */
export async function getMintTokenProgramId(
  conn: Connection,
  mint: PublicKey
): Promise<PublicKey> {
  const info = await conn.getAccountInfo(mint, "confirmed");
  const owner = info?.owner?.toBase58?.() ?? "";
  if (owner === TOKEN_2022_PROGRAM_ID.toBase58()) return TOKEN_2022_PROGRAM_ID;
  // default to classic if unknown
  return TOKEN_PROGRAM_ID;
}

/* ========= Recent blockhash cache (single-flight) =========
   Cuts RPC spam when many users hit claim at once.
   TTL kept short to avoid "blockhash not found" (default ~2 min on-chain). */
const BH_TTL_MS = 20_000;
let BH_CACHE: { at: number; blockhash: string } | null = null;
let BH_PENDING: Promise<string> | null = null;

async function getRecentBlockhashCached(conn: Connection): Promise<string> {
  const now = Date.now();
  if (BH_CACHE && now - BH_CACHE.at < BH_TTL_MS && BH_CACHE.blockhash) {
    return BH_CACHE.blockhash;
  }
  if (!BH_PENDING) {
    BH_PENDING = (async () => {
      const { blockhash } = await conn.getLatestBlockhash("finalized");
      BH_CACHE = { at: Date.now(), blockhash };
      return blockhash;
    })().finally(() => {
      // tiny delay to prevent immediate stampede
      setTimeout(() => { BH_PENDING = null; }, 50);
    });
  }
  return BH_PENDING;
}

/**
 * Build an UNSIGNED claim tx where the USER is the FEE PAYER.
 * Includes a fixed fee (default 0.01 SOL) paid to teamWallet.
 * Phantom signs first; server co-signs with treasury and broadcasts.
 */
export async function buildClaimTx(opts: {
  conn: Connection;
  treasuryPubkey: PublicKey; // server signer added later
  user: PublicKey;           // fee payer (Phantom)
  amountPump: number;        // UI units
  teamWallet: PublicKey;     // receives the SOL fee
  tokenProgramId: PublicKey;
}) {
  const { conn, treasuryPubkey, user, amountPump, teamWallet, tokenProgramId } = opts;

  // sanitize inputs
  const decimals = 6;
  const safeAmountUi = Number.isFinite(amountPump) ? Math.max(0, amountPump) : 0;
  const raw = Math.floor(safeAmountUi * 10 ** decimals);

  const fromAta = getAssociatedTokenAddressSync(PUMP_MINT, treasuryPubkey, false, tokenProgramId);
  const toAta   = getAssociatedTokenAddressSync(PUMP_MINT, user,           false, tokenProgramId);

  // 0.01 SOL team fee (override with CLAIM_FEE_SOL env if needed)
  const CLAIM_FEE_SOL_RAW = Number(process.env.CLAIM_FEE_SOL ?? "0.01");
  const CLAIM_FEE_SOL = Number.isFinite(CLAIM_FEE_SOL_RAW) ? Math.max(0, CLAIM_FEE_SOL_RAW) : 0.01;
  const feeLamports = Math.max(0, Math.floor(CLAIM_FEE_SOL * LAMPORTS_PER_SOL));

  const ixs = [
    // generous budget to avoid CU throttles on busy slots
    ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }),

    // ensure TREASURY's ATA exists (payer = user; owner signature not required)
    createAssociatedTokenAccountIdempotentInstruction(
      user,            // payer
      fromAta,         // ATA to create if missing
      treasuryPubkey,  // owner of ATA
      PUMP_MINT,
      tokenProgramId
    ),

    // ensure USER's ATA exists (payer = user)
    createAssociatedTokenAccountIdempotentInstruction(
      user,   // payer
      toAta,  // ATA to create if missing
      user,   // owner
      PUMP_MINT,
      tokenProgramId
    ),

    // optional SOL fee to team wallet (signed by the user / fee payer)
    ...(feeLamports > 0
      ? [SystemProgram.transfer({ fromPubkey: user, toPubkey: teamWallet, lamports: feeLamports })]
      : []),

    // transfer from TREASURY_ATA -> USER_ATA (requires treasury signature later)
    createTransferCheckedInstruction(
      fromAta,
      PUMP_MINT,
      toAta,
      treasuryPubkey, // authority that will partialSign server-side
      raw,
      decimals,
      [],
      tokenProgramId
    ),
  ];

  const blockhash = await getRecentBlockhashCached(conn);
  const msg = new TransactionMessage({
    payerKey: user,
    recentBlockhash: blockhash,
    instructions: ixs,
  }).compileToV0Message();

  const unsigned = new VersionedTransaction(msg);
  return {
    txB64: Buffer.from(unsigned.serialize()).toString("base64"),
    amount: safeAmountUi,
    feeSol: CLAIM_FEE_SOL,
  };
}
