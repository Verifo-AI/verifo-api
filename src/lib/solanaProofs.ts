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
// node's reward wallet are attached to the transaction as plain (non-signer,
// non-writable) accounts. The treasury still pays gas and is the only
// required signer, but this makes the payer/payee relationship an on-chain
// fact anyone can verify on an explorer — not just text in the memo.
export interface RelatedWallets {
  userWallet?: string | null;
  nodeWallet?: string | null;
}

function buildRelatedWalletKeys(relatedWallets?: RelatedWallets | null) {
  const keys: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[] = [];
  if (!relatedWallets) return keys;
  for (const address of [relatedWallets.userWallet, relatedWallets.nodeWallet]) {
    if (!address) continue;
    try {
      keys.push({ pubkey: new PublicKey(address), isSigner: false, isWritable: false });
    } catch {
      // Wallet address wasn't a valid base58 pubkey (e.g. a placeholder
      // identity) — skip it rather than fail the whole proof broadcast.
    }
  }
  return keys;
}

export function buildMemoText(
  eventType: ProofEventType,
  nodePublicKey: string,
  taskId?: string | null,
  settlement?: TaskCompletedSettlement | null
): string {
  switch (eventType) {
    case "connect":
      return `Verifo node ${nodePublicKey} connected`;
    case "disconnect":
      return `Verifo node ${nodePublicKey} disconnected`;
    case "task_assigned":
      return `Verifo node ${nodePublicKey} picked up task ${taskId}`;
    case "task_completed":
      return settlement
        ? `Verifo node ${nodePublicKey} completed task ${taskId}. Settlement: user paid ${settlement.totalPaidUsdc.toFixed(6)} USDC, node earned ${settlement.rewardUsdc.toFixed(6)} USDC, platform treasury kept ${settlement.treasuryUsdc.toFixed(6)} USDC`
        : `Verifo node ${nodePublicKey} completed task ${taskId}`;
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
export async function buildAndSubmitTreasuryOnlyProof(
  memoText: string,
  relatedWallets?: RelatedWallets | null
): Promise<string> {
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
        keys: buildRelatedWalletKeys(relatedWallets),
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
  memoText: string,
  relatedWallets?: RelatedWallets | null
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
        keys: [
          { pubkey: nodePubkey, isSigner: true, isWritable: false },
          ...buildRelatedWalletKeys(relatedWallets),
        ],
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
