// lib/solana.ts
import {
  Connection,
  PublicKey,
  Keypair,
  SystemProgram,
  LAMPORTS_PER_SOL,
  VersionedTransaction,
  TransactionMessage,
  MessageV0,
  clusterApiUrl,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  createTransferCheckedInstruction,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import bs58 from "bs58";

/** $PUMP mint (6 decimals) */
export const PUMP_MINT = new PublicKey("pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn");
const DECIMALS = 6;

/** Connection using your env (HELIUS/SOLANA) */
export function connection() {
  const rpc =
    process.env.HELIUS_RPC ||
    process.env.SOLANA_RPC ||
    process.env.NEXT_PUBLIC_SOLANA_RPC ||
    clusterApiUrl("mainnet-beta");
  return new Connection(rpc, "confirmed");
}

/** Read keypair from base58 secret in env */
export function keypairFromEnv(varName: string): Keypair {
  const sec = process.env[varName];
  if (!sec) throw new Error(`Missing ${varName}`);
  const bytes = bs58.decode(sec.trim());
  return Keypair.fromSecretKey(bytes);
}

/** Read pubkey from env */
export function pubkeyFromEnv(varName: string): PublicKey {
  const s = process.env[varName];
  if (!s) throw new Error(`Missing ${varName}`);
  return new PublicKey(s);
}

/** Detect whether a mint uses Token-2020 or Token-2022 (by account owner) */
export async function getMintTokenProgramId(conn: Connection, mint: PublicKey): Promise<PublicKey> {
  const info = await conn.getAccountInfo(mint, "confirmed");
  if (!info) throw new Error("Mint not found on-chain");
  const owner = info.owner?.toBase58();
  if (owner === TOKEN_2022_PROGRAM_ID.toBase58()) return TOKEN_2022_PROGRAM_ID;
  return TOKEN_PROGRAM_ID; // default to classic
}

/**
 * Build a VersionedTransaction that:
 *  - fee payer = user
 *  - (optional) creates user's PUMP ATA (payer=user)
 *  - transfers `amountPump` $PUMP from Treasury ATA -> User ATA
 *  - adds a 0.01 SOL SystemProgram.transfer from user -> team
 *  - pre-signs with Treasury (server), returns base64 for the client to sign & send
 */
export async function buildClaimTx(opts: {
  conn: Connection;
  treasuryKp: Keypair;        // source owner & signer
  user: PublicKey;
  amountPump: number;         // UI units
  teamWallet: PublicKey;
  tokenProgramId?: PublicKey; // detected program id (classic or 2022)
}): Promise<{ txB64: string; amount: number; feeSol: number }> {
  const { conn, treasuryKp, user, amountPump, teamWallet } = opts;
  const tokenProgramId = opts.tokenProgramId || TOKEN_PROGRAM_ID;

  // Convert UI → raw
  const multiplier = Math.pow(10, DECIMALS);
  const raw = Math.floor(amountPump * multiplier);
  if (raw <= 0) throw new Error("Invalid amount");

  // Derive ATAs under the correct token program
  const treasuryAta = await getAssociatedTokenAddress(PUMP_MINT, treasuryKp.publicKey, false, tokenProgramId, ASSOCIATED_TOKEN_PROGRAM_ID);
  const userAta = await getAssociatedTokenAddress(PUMP_MINT, user, false, tokenProgramId, ASSOCIATED_TOKEN_PROGRAM_ID);

  const ixs = [];

  // Create user's ATA if missing (payer = user)
  const acctInfo = await conn.getAccountInfo(userAta, "confirmed");
  if (!acctInfo) {
    ixs.push(
      createAssociatedTokenAccountInstruction(
        user,            // payer (must have a little SOL)
        userAta,         // ata to create
        user,            // owner
        PUMP_MINT,
        tokenProgramId,  // ← ensure we match mint's program
        ASSOCIATED_TOKEN_PROGRAM_ID
      )
    );
  }

  // TransferChecked (Treasury -> User), decimals=6; signer = Treasury KP
  ixs.push(
    createTransferCheckedInstruction(
      treasuryAta,            // source
      PUMP_MINT,              // mint
      userAta,                // destination
      treasuryKp.publicKey,   // owner (signer)
      raw,                    // amount (raw)
      DECIMALS,               // decimals
      [],                     // multisig (none)
      tokenProgramId          // ← ensure correct program
    )
  );

  // 0.01 SOL fee from user -> team
  const feeLamports = Math.floor(0.01 * LAMPORTS_PER_SOL);
  if (feeLamports > 0) {
    ixs.push(
      SystemProgram.transfer({
        fromPubkey: user,
        toPubkey: teamWallet,
        lamports: feeLamports,
      })
    );
  }

  // Build message with user as fee payer (needs their signature)
  const { blockhash } = await conn.getLatestBlockhash("finalized");
  const msg = new TransactionMessage({
    payerKey: user,
    recentBlockhash: blockhash,
    instructions: ixs,
  }).compileToV0Message();

  const tx = new VersionedTransaction(msg as MessageV0);

  // Pre-sign with Treasury (required by transferChecked)
  tx.sign([treasuryKp]);

  const txB64 = Buffer.from(tx.serialize()).toString("base64");
  return { txB64, amount: amountPump, feeSol: 0.01 };
}
