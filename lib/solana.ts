// lib/solana.ts
import "server-only";

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
  Commitment,
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
export function connection(commitment: Commitment = "confirmed") {
  const rpc =
    process.env.HELIUS_RPC ||
    process.env.SOLANA_RPC ||
    process.env.NEXT_PUBLIC_SOLANA_RPC ||
    clusterApiUrl("mainnet-beta");
  return new Connection(rpc, commitment);
}

/** Read keypair from base58 secret in env (server-side only) */
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

/** Detect whether a mint uses Token-2022 or classic Token-2020 */
export async function getMintTokenProgramId(conn: Connection, mint: PublicKey): Promise<PublicKey> {
  const info = await conn.getAccountInfo(mint, "confirmed");
  if (!info) throw new Error("Mint not found on-chain");
  const owner = info.owner?.toBase58();
  if (owner === TOKEN_2022_PROGRAM_ID.toBase58()) return TOKEN_2022_PROGRAM_ID;
  return TOKEN_PROGRAM_ID;
}

/**
 * Build an **UNSIGNED** v0 transaction for the user to sign FIRST (Phantom-safe).
 */
export async function buildClaimTx(opts: {
  conn: Connection;
  treasuryPubkey: PublicKey;
  user: PublicKey;
  amountPump: number;
  teamWallet: PublicKey;
  tokenProgramId?: PublicKey;
}): Promise<{ txB64: string; amount: number; feeSol: number; lastValidBlockHeight: number; blockhash: string }> {
  const { conn, treasuryPubkey, user, amountPump, teamWallet } = opts;
  const tokenProgramId = opts.tokenProgramId || TOKEN_PROGRAM_ID;

  // Convert UI → raw
  const multiplier = Math.pow(10, DECIMALS);
  const raw = Math.floor(amountPump * multiplier);
  if (!Number.isFinite(raw) || raw <= 0) throw new Error("Invalid amount");

  // Derive ATAs under the correct token program
  const treasuryAta = await getAssociatedTokenAddress(
    PUMP_MINT,
    treasuryPubkey,
    false,
    tokenProgramId,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  const userAta = await getAssociatedTokenAddress(
    PUMP_MINT,
    user,
    false,
    tokenProgramId,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  const ixs = [];

  // Create user's ATA if missing (payer = user)
  const acctInfo = await conn.getAccountInfo(userAta, "confirmed");
  if (!acctInfo) {
    ixs.push(
      createAssociatedTokenAccountInstruction(
        user,
        userAta,
        user,
        PUMP_MINT,
        tokenProgramId,
        ASSOCIATED_TOKEN_PROGRAM_ID
      )
    );
  }

  // TransferChecked (Treasury -> User)
  ixs.push(
    createTransferCheckedInstruction(
      treasuryAta,
      PUMP_MINT,
      userAta,
      treasuryPubkey,
      raw,
      DECIMALS,
      [],
      tokenProgramId
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

  // Build message with user as fee payer
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("finalized");
  const msg = new TransactionMessage({
    payerKey: user,
    recentBlockhash: blockhash,
    instructions: ixs,
  }).compileToV0Message();

  const tx = new VersionedTransaction(msg as MessageV0);

  // Wallet must sign FIRST
  const txB64 = Buffer.from(tx.serialize()).toString("base64");
  return { txB64, amount: amountPump, feeSol: 0.01, lastValidBlockHeight, blockhash };
}

/**
 * Server-side helper: add treasury signature AFTER wallet signed first, then send+confirm.
 */
export async function finalizeAndSendClaimTx(opts: {
  conn: Connection;
  walletSignedB64: string;
  treasuryKp: Keypair;
  commitment?: Commitment;
  skipPreflight?: boolean;
}): Promise<{ signature: string }> {
  const { conn, walletSignedB64, treasuryKp } = opts;
  const commitment: Commitment = opts.commitment ?? "confirmed";

  // Deserialize wallet-signed tx
  const tx = VersionedTransaction.deserialize(Buffer.from(walletSignedB64, "base64"));

  // Add treasury signature (v0 API)
  tx.sign([treasuryKp]);

  // Send
  const sig = await conn.sendRawTransaction(tx.serialize(), {
    skipPreflight: opts.skipPreflight ?? false,
    preflightCommitment: commitment,
  });

  // ✅ Confirm with a full strategy to satisfy all typings
  // Use the latest blockhash context for confirmation.
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("finalized");
  await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, commitment);

  return { signature: sig };
}
