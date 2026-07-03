// Encrypts sensitive private-key material before it is stored in Postgres
// (platform_node_credentials). Previously these were stored as plaintext
// base64/base58 strings, so anyone with read access to the DB (a leak, a
// backup, an over-privileged query) could sign transactions and drain the
// platform nodes' payout wallets. AES-256-GCM with a key held only in
// a dedicated secrets manager (never in the DB) closes that gap: a DB-only leak no
// longer exposes usable keys.
import crypto from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;

function getKey(): Buffer {
  const raw = process.env.PLATFORM_NODE_CREDENTIALS_KEY;
  if (!raw) {
    throw new Error(
      "PLATFORM_NODE_CREDENTIALS_KEY is not set. This secret is required to encrypt/decrypt platform node private keys.",
    );
  }
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error("PLATFORM_NODE_CREDENTIALS_KEY must decode to exactly 32 bytes (base64-encoded).");
  }
  return key;
}

// Stored format: base64(iv[12] || authTag[16] || ciphertext). Self-contained
// so no separate column is needed for iv/tag.
export function encryptSecret(plaintext: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString("base64");
}

export function decryptSecret(encoded: string): string {
  const key = getKey();
  const raw = Buffer.from(encoded, "base64");
  const iv = raw.subarray(0, IV_LENGTH);
  const authTag = raw.subarray(IV_LENGTH, IV_LENGTH + 16);
  const ciphertext = raw.subarray(IV_LENGTH + 16);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString("utf8");
}
