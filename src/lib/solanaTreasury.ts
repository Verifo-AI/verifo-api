import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  createTransferCheckedInstruction,
  getAccount,
} from "@solana/spl-token";
import bs58 from "bs58";
import { logger } from "./logger";

export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const USDC_DECIMALS = 6;

// Helius is our primary Solana RPC provider (much higher rate limits than
// the public mainnet-beta endpoint, which is what was causing 429s and
// crashing the server under load). PUBLIC_FALLBACK_URL is only used as a
// last resort: either when HELIUS_API_KEY isn't configured at all, or as a
// temporary runtime fallback if Helius itself starts returning 429s.
const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const HELIUS_URL = HELIUS_API_KEY ? `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}` : null;
const PUBLIC_FALLBACK_URL = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";

// How long to keep routing to the public RPC after Helius rate-limits us,
// before trying Helius again.
const HELIUS_COOLDOWN_MS = 30_000;
let heliusCooldownUntil = 0;

export const SOLANA_RPC_URL = HELIUS_URL || PUBLIC_FALLBACK_URL;

/**
 * Custom fetch used by the Connection (and the /api/solana-rpc proxy) that
 * always prefers Helius. If Helius responds with 429, it retries the same
 * request against the public RPC immediately and starts a cooldown window
 * so subsequent requests skip Helius until it's likely to have recovered.
 */
export const solanaFetch: typeof fetch = async (info, init) => {
  if (!HELIUS_URL) {
    return fetch(PUBLIC_FALLBACK_URL, init);
  }

  const useHelius = Date.now() >= heliusCooldownUntil;
  const targetUrl = useHelius ? HELIUS_URL : PUBLIC_FALLBACK_URL;
  let response = await fetch(targetUrl, init);

  if (response.status === 429 && useHelius) {
    logger.warn(
      { cooldownMs: HELIUS_COOLDOWN_MS },
      "Helius RPC rate-limited (429), falling back to public Solana RPC temporarily",
    );
    heliusCooldownUntil = Date.now() + HELIUS_COOLDOWN_MS;
    response = await fetch(PUBLIC_FALLBACK_URL, init);
  }

  return response;
};

export const connection = new Connection(SOLANA_RPC_URL, { commitment: "confirmed", fetch: solanaFetch });

function parseTreasuryKeypair(): Keypair | null {
  const raw = process.env.TREASURY_WALLET_PRIVATE_KEY;
  if (!raw || !raw.trim()) return null;

  const trimmed = raw.trim();
  try {
    if (trimmed.startsWith("[")) {
      const arr = JSON.parse(trimmed) as number[];
      return Keypair.fromSecretKey(Uint8Array.from(arr));
    }
    return Keypair.fromSecretKey(bs58.decode(trimmed));
  } catch (err) {
    logger.error({ err }, "[solanaTreasury] Failed to parse TREASURY_WALLET_PRIVATE_KEY");
    return null;
  }
}

const treasuryKeypair = parseTreasuryKeypair();

export function isTreasuryConfigured(): boolean {
  return treasuryKeypair !== null;
}

export function getTreasuryPublicKey(): string | null {
  return treasuryKeypair ? treasuryKeypair.publicKey.toBase58() : null;
}

/**
 * Exposes the parsed treasury Keypair for other modules that need to sign
 * mainnet transactions on the treasury's behalf (e.g. sponsoring the fee for
 * a node's co-signed on-chain proof memo). Returns null if unconfigured.
 */
export function getTreasuryKeypair(): Keypair | null {
  return treasuryKeypair;
}

/**
 * Returns the treasury's real on-chain USDC balance (in micro-USDC), so
 * callers can refuse payouts the treasury can't actually afford instead of
 * sending a doomed transaction.
 */
export async function getTreasuryUsdcBalanceMicros(): Promise<number> {
  if (!treasuryKeypair) throw new Error("Treasury wallet is not configured");
  const usdcMint = new PublicKey(USDC_MINT);
  const treasuryAta = await getAssociatedTokenAddress(usdcMint, treasuryKeypair.publicKey);
  try {
    const account = await getAccount(connection, treasuryAta);
    return Number(account.amount);
  } catch {
    return 0;
  }
}

/**
 * Sends a REAL, on-chain mainnet USDC transfer from the Verifo treasury
 * wallet to a contributor's wallet. Creates the recipient's associated token
 * account (paid for by the treasury) if it doesn't exist yet. Throws on any
 * failure — callers must not assume success without a returned signature.
 */
export async function sendUsdcPayout(destinationWallet: string, amountUsdcMicros: number): Promise<string> {
  if (!treasuryKeypair) {
    throw new Error("Treasury wallet is not configured (missing TREASURY_WALLET_PRIVATE_KEY)");
  }
  if (amountUsdcMicros <= 0) {
    throw new Error("Payout amount must be positive");
  }

  let destination: PublicKey;
  try {
    destination = new PublicKey(destinationWallet);
  } catch {
    throw new Error("Invalid destination wallet address");
  }

  const usdcMint = new PublicKey(USDC_MINT);
  const treasuryAta = await getAssociatedTokenAddress(usdcMint, treasuryKeypair.publicKey);
  const destinationAta = await getAssociatedTokenAddress(usdcMint, destination);

  const transaction = new Transaction();

  let destinationAtaExists = true;
  try {
    await getAccount(connection, destinationAta);
  } catch {
    destinationAtaExists = false;
  }

  if (!destinationAtaExists) {
    transaction.add(
      createAssociatedTokenAccountInstruction(
        treasuryKeypair.publicKey,
        destinationAta,
        destination,
        usdcMint,
      ),
    );
  }

  transaction.add(
    createTransferCheckedInstruction(
      treasuryAta,
      usdcMint,
      destinationAta,
      treasuryKeypair.publicKey,
      amountUsdcMicros,
      USDC_DECIMALS,
    ),
  );

  const signature = await sendAndConfirmTransaction(connection, transaction, [treasuryKeypair], {
    commitment: "confirmed",
  });

  return signature;
}
