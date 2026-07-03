import { Router } from "express";
import { requireAuth } from "../middlewares/jwtAuth";
import { db } from "@workspace/db";
import { creditsTable, topupTransactionsTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddress } from "@solana/spl-token";
import { logger } from "../lib/logger";
import { connection } from "../lib/solanaTreasury";

const router = Router();

// Credit counts here are 100x the old amounts to match the CREDIT_USDC_MICROS
// change in tasks.ts (1 credit now = $0.0001 instead of $0.01). The USDC
// price of each package is unchanged; only the number of credits granted
// per dollar went up, so the real purchase rate still matches what a
// credit is actually worth when spent on a task (keeps the 70/30 node
// split honest end-to-end). See verifo-payment-splits memory doc.
const USDC_PACKAGES = [
  { id: "pack_100", usdcAmount: 1, credits: 10_000, label: "Starter" },
  { id: "pack_500", usdcAmount: 4, credits: 50_000, label: "Pro" },
  { id: "pack_2000", usdcAmount: 14, credits: 200_000, label: "Builder" },
  { id: "pack_10000", usdcAmount: 60, credits: 1_000_000, label: "Enterprise" },
];

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDC_DECIMALS = 6;
const TREASURY_WALLET = process.env.VERIFO_TREASURY_WALLET ?? "11111111111111111111111111111111";

router.get("/credits/packages", (_req, res) => {
  res.json({ packages: USDC_PACKAGES, usdcMint: USDC_MINT, treasuryWallet: TREASURY_WALLET });
});

/**
 * Verifies a submitted Solana tx signature is a REAL, finalized, on-chain
 * mainnet USDC transfer of the exact package amount from the claimed wallet
 * to the treasury's associated token account. Throws with a user-facing
 * message string on any mismatch.
 */
async function verifyTopupTransaction(params: {
  txSignature: string;
  walletAddress: string;
  expectedUsdcAmount: number;
}): Promise<void> {
  const { txSignature, walletAddress, expectedUsdcAmount } = params;

  let sender: PublicKey;
  try {
    sender = new PublicKey(walletAddress);
  } catch {
    throw new Error("Invalid wallet address");
  }

  let tx;
  try {
    tx = await connection.getParsedTransaction(txSignature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
  } catch {
    throw new Error("Transaction not found on-chain (it may not be confirmed yet, or the signature is invalid)");
  }

  if (!tx) {
    throw new Error("Transaction not found on-chain (it may not be confirmed yet, or the signature is invalid)");
  }

  if (tx.meta?.err) {
    throw new Error("Transaction failed on-chain");
  }

  const usdcMint = new PublicKey(USDC_MINT);
  const treasury = new PublicKey(TREASURY_WALLET);
  const senderAta = await getAssociatedTokenAddress(usdcMint, sender);
  const treasuryAta = await getAssociatedTokenAddress(usdcMint, treasury);

  const preBalances = tx.meta?.preTokenBalances ?? [];
  const postBalances = tx.meta?.postTokenBalances ?? [];
  const accountKeys = tx.transaction.message.accountKeys.map((k) => k.pubkey.toBase58());

  const findDelta = (ataBase58: string): number => {
    const idx = accountKeys.indexOf(ataBase58);
    if (idx === -1) return 0;
    const pre = preBalances.find((b) => b.accountIndex === idx);
    const post = postBalances.find((b) => b.accountIndex === idx);
    const preAmount = pre ? Number(pre.uiTokenAmount.amount) : 0;
    const postAmount = post ? Number(post.uiTokenAmount.amount) : 0;
    return postAmount - preAmount;
  };

  const treasuryDelta = findDelta(treasuryAta.toBase58());
  const senderDelta = findDelta(senderAta.toBase58());

  const expectedMicros = Math.round(expectedUsdcAmount * 10 ** USDC_DECIMALS);

  if (treasuryDelta !== expectedMicros) {
    throw new Error(
      `Transaction did not transfer the expected amount to the treasury (expected ${expectedMicros} micro-USDC, saw ${treasuryDelta})`,
    );
  }

  if (senderDelta !== -expectedMicros) {
    throw new Error("Transaction sender does not match the claimed wallet address");
  }
}

router.post("/credits/topup", requireAuth, async (req: any, res) => {
  const { packageId, txSignature, walletAddress } = req.body;

  if (!packageId || !txSignature || !walletAddress) {
    return res.status(400).json({ error: "packageId, txSignature, and walletAddress are required" });
  }

  const pkg = USDC_PACKAGES.find((p) => p.id === packageId);
  if (!pkg) return res.status(400).json({ error: "Invalid package" });

  if (typeof txSignature !== "string" || txSignature.length < 20) {
    return res.status(400).json({ error: "Invalid transaction signature" });
  }

  try {
    const [alreadyUsed] = await db
      .select()
      .from(topupTransactionsTable)
      .where(eq(topupTransactionsTable.txSignature, txSignature))
      .limit(1);

    if (alreadyUsed) {
      return res.status(409).json({ error: "This transaction has already been redeemed for credits" });
    }

    try {
      await verifyTopupTransaction({
        txSignature,
        walletAddress,
        expectedUsdcAmount: pkg.usdcAmount,
      });
    } catch (verifyErr: any) {
      logger.warn({ err: verifyErr, txSignature, walletAddress }, "Top-up verification failed");
      return res.status(400).json({ error: verifyErr.message || "Could not verify transaction on-chain" });
    }

    const now = new Date();
    const expectedMicros = Math.round(pkg.usdcAmount * 10 ** USDC_DECIMALS);

    const result = await db.transaction(async (trx) => {
      await trx.insert(topupTransactionsTable).values({
        txSignature,
        clerkUserId: req.userId,
        walletAddress,
        packageId: pkg.id,
        usdcAmount: expectedMicros,
        creditsAdded: pkg.credits,
        verifiedAt: now,
      });

      const [existing] = await trx
        .select()
        .from(creditsTable)
        .where(eq(creditsTable.clerkUserId, req.userId))
        .limit(1);

      if (existing) {
        const [updated] = await trx
          .update(creditsTable)
          .set({ credits: existing.credits + pkg.credits, updatedAt: now })
          .where(eq(creditsTable.clerkUserId, req.userId))
          .returning();
        return updated;
      }

      const [created] = await trx
        .insert(creditsTable)
        .values({ clerkUserId: req.userId, credits: 100 + pkg.credits, plan: "free", updatedAt: now })
        .returning();
      return created;
    });

    res.json({ success: true, credits: result.credits, added: pkg.credits, txSignature, package: pkg.label });
  } catch (err: any) {
    if (err?.code === "23505") {
      return res.status(409).json({ error: "This transaction has already been redeemed for credits" });
    }
    console.error("POST /credits/topup error:", err);
    res.status(500).json({ error: "Failed to apply credits" });
  }
});

export default router;
