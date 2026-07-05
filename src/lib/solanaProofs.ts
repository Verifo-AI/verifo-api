import {
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  MessageV0,
} from "@solana/web3.js";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { connection, getTreasuryKeypair } from "./solanaTreasury";
import { logger } from "./logger";

// Solana's native Memo program — writes arbitrary UTF-8 text into a
// transaction so it's permanently, publicly readable on-chain via any
// explorer. This is the cheapest honest way to leave a verifiable proof of
// activity without deploying a custom on-chain program.
export const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

export type ProofEventType = "connect" | "disconnect" | "task_assigned" | "task_completed" | "node_offline";

// All memo text is English-only by design (product requirement).
export interface TaskCompletedSettlement {
  rewardUsdc: number;
  totalPaidUsdc: number;
  treasuryUsdc: number;
}

// For task_completed proofs, the requesting user's wallet and the earning
// node's reward wallet are named directly in the memo TEXT (not attached as
// separate instruction accounts — the SPL Memo program rejects any
// transaction where an account it was given isn't also a signer, so a
// "plain, non-signer" account reference is not actually possible on this
// program). Embedding the addresses in the memo text keeps them just as
// permanently on-chain and human/explorer-verifiable, without needing
// either party's signature.
export interface RelatedWallets {
  userWallet?: string | null;
  nodeWallet?: string | null;
}

export function buildMemoText(
  eventType: ProofEventType,
  nodePublicKey: string,
  taskId?: string | null,
  settlement?: TaskCompletedSettlement | null,
  relatedWallets?: RelatedWallets | null
): string {
  switch (eventType) {
    case "connect":
      return `Verifo node ${nodePublicKey} connected`;
    case "disconnect":
      return `Verifo node ${nodePublicKey} disconnected`;
    case "task_assigned":
      return `Verifo node ${nodePublicKey} picked up task ${taskId}`;
    case "task_completed": {
      const walletSuffix = relatedWallets
        ? [
            relatedWallets.userWallet ? `user wallet ${relatedWallets.userWallet}` : null,
            relatedWallets.nodeWallet ? `node reward wallet ${relatedWallets.nodeWallet}` : null,
          ]
            .filter(Boolean)
            .join(", ")
        : "";
      const walletText = walletSuffix ? ` (${walletSuffix})` : "";
      return settlement
        ? `Verifo node ${nodePublicKey} completed task ${taskId}. Settlement: user paid ${settlement.totalPaidUsdc.toFixed(6)} USDC, node earned ${settlement.rewardUsdc.toFixed(6)} USDC, platform treasury kept ${settlement.treasuryUsdc.toFixed(6)} USDC${walletText}`
        : `Verifo node ${nodePublicKey} completed task ${taskId}${walletText}`;
    }
    case "node_offline":
      return `Verifo node ${nodePublicKey} went offline (missed heartbeat)`;
  }
}

/**
 * Builds and broadcasts a treasury-ONLY signed Memo transaction. Used only
 * for the node_offline event: by definition the node has stopped
 * responding, so it cannot co-sign. The treasury attests to the fact that it
 * observed the node missing its heartbeat window, and pays the fee itself.
 */
export async function buildAndSubmitTreasuryOnlyProof(memoText: string): Promise<string> {
  const treasuryKeypair = getTreasuryKeypair();
  if (!treasuryKeypair) {
    throw new Error("Treasury wallet is not configured (missing TREASURY_WALLET_PRIVATE_KEY)");
  }

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("finalized");

  const message = new TransactionMessage({
    payerKey: treasuryKeypair.publicKey,
    recentBlockhash: blockhash,
    instructions: [
      {
        programId: MEMO_PROGRAM_ID,
        // No extra accounts here — the SPL Memo program requires every
        // account it's given to also be a signer, so related wallets are
        // named in the memo text instead (see buildMemoText).
        keys: [],
        data: Buffer.from(memoText, "utf8"),
      },
    ],
  }).compileToV0Message();

  const transaction = new VersionedTransaction(message);
  transaction.sign([treasuryKeypair]);

  const signature = await connection.sendTransaction(transaction, {
    skipPreflight: false,
    maxRetries: 3,
  });

  await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");

  logger.info({ signature }, "[solanaProofs] treasury-only node_offline proof confirmed");
  return signature;
}

/**
 * Builds an UNSIGNED versioned Solana transaction: a single Memo-program
 * instruction, with the treasury wallet as fee payer and the node's own
 * public key included as a REQUIRED extra signer. The node must sign the
 * exact serialized bytes returned here with its own ed25519 key before the
 * transaction can be submitted — this is what makes the proof genuinely
 * co-signed by the node, not just a server-side claim about it.
 */
export async function buildUnsignedProofMessage(
  nodePublicKeyBase58: string,
  memoText: string
): Promise<{ messageBase64: string }> {
  const treasuryKeypair = getTreasuryKeypair();
  if (!treasuryKeypair) {
    throw new Error("Treasury wallet is not configured (missing TREASURY_WALLET_PRIVATE_KEY)");
  }

  let nodePubkey: PublicKey;
  try {
    nodePubkey = new PublicKey(bs58.decode(nodePublicKeyBase58));
  } catch {
    throw new Error("Invalid node public key");
  }

  const { blockhash } = await connection.getLatestBlockhash("finalized");

  const message = new TransactionMessage({
    payerKey: treasuryKeypair.publicKey,
    recentBlockhash: blockhash,
    instructions: [
      {
        programId: MEMO_PROGRAM_ID,
        // Only the node's own key is passed as an account here (and it IS
        // a real signer, co-signed by the node below) — related wallets
        // are named in the memo text instead, since the SPL Memo program
        // requires every account it's given to also be a signer.
        keys: [{ pubkey: nodePubkey, isSigner: true, isWritable: false }],
        data: Buffer.from(memoText, "utf8"),
      },
    ],
  }).compileToV0Message();

  const serialized = message.serialize();
  return { messageBase64: Buffer.from(serialized).toString("base64") };
}

/**
 * Verifies the node's ed25519 signature over the exact unsigned message
 * bytes, attaches both the node's signature and the treasury's own
 * fee-payer signature, and broadcasts the fully-signed transaction to
 * mainnet. Throws on any failure — callers must not assume success without
 * a returned signature.
 */
export async function finalizeAndSubmitProof(
  messageBase64: string,
  nodePublicKeyBase58: string,
  nodeSignatureBase64: string
): Promise<string> {
  const treasuryKeypair = getTreasuryKeypair();
  if (!treasuryKeypair) {
    throw new Error("Treasury wallet is not configured (missing TREASURY_WALLET_PRIVATE_KEY)");
  }

  let messageBytes: Buffer;
  let nodeSigBytes: Uint8Array;
  let nodePubKeyBytes: Uint8Array;
  try {
    messageBytes = Buffer.from(messageBase64, "base64");
    nodeSigBytes = new Uint8Array(Buffer.from(nodeSignatureBase64, "base64"));
    nodePubKeyBytes = new Uint8Array(bs58.decode(nodePublicKeyBase58));
  } catch {
    throw new Error("Malformed proof message, signature, or public key encoding");
  }

  const validSignature = nacl.sign.detached.verify(messageBytes, nodeSigBytes, nodePubKeyBytes);
  if (!validSignature) {
    throw new Error("Invalid node signature for this proof message");
  }

  const message = MessageV0.deserialize(messageBytes);
  const transaction = new VersionedTransaction(message);
  transaction.sign([treasuryKeypair]);
  transaction.addSignature(new PublicKey(nodePubKeyBytes), nodeSigBytes);

  const signature = await connection.sendTransaction(transaction, {
    skipPreflight: false,
    maxRetries: 3,
  });

  const latest = await connection.getLatestBlockhash("confirmed");
  await connection.confirmTransaction(
    {
      signature,
      blockhash: latest.blockhash,
      lastValidBlockHeight: latest.lastValidBlockHeight,
    },
    "confirmed"
  );

  logger.info({ signature, nodePublicKey: nodePublicKeyBase58 }, "[solanaProofs] on-chain proof confirmed");
  return signature;
}
