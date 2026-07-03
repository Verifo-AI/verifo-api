// One-off migration: the 16 platform node private keys were originally
// inserted as plaintext base64/base58 strings by seedPlatformNodes.ts. This
// script re-encrypts every existing row in platform_node_credentials with
// AES-256-GCM (see lib/credentialsCrypto.ts) using PLATFORM_NODE_CREDENTIALS_KEY,
// so a DB leak no longer exposes usable private keys.
//
// Safe to run more than once: it decrypts first to check whether a row is
// already encrypted (skips it), otherwise treats it as legacy plaintext and
// encrypts it in place.
//
// Usage: pnpm --filter @workspace/api-server exec tsx scripts/encryptExistingPlatformCredentials.ts
import { db, platformNodeCredentialsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { encryptSecret, decryptSecret } from "../src/lib/credentialsCrypto";

function isAlreadyEncrypted(value: string): boolean {
  try {
    decryptSecret(value);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const rows = await db
    .select({
      id: platformNodeCredentialsTable.id,
      nodeId: platformNodeCredentialsTable.nodeId,
      nodeSecretKeyBase64: platformNodeCredentialsTable.nodeSecretKeyBase64,
      walletSecretKeyBase58: platformNodeCredentialsTable.walletSecretKeyBase58,
    })
    .from(platformNodeCredentialsTable);

  if (rows.length === 0) {
    console.log("No platform_node_credentials rows found. Nothing to do.");
    return;
  }

  let encryptedCount = 0;
  let skippedCount = 0;

  for (const row of rows) {
    const nodeKeyAlreadyEncrypted = isAlreadyEncrypted(row.nodeSecretKeyBase64);
    const walletKeyAlreadyEncrypted = isAlreadyEncrypted(row.walletSecretKeyBase58);

    if (nodeKeyAlreadyEncrypted && walletKeyAlreadyEncrypted) {
      skippedCount++;
      console.log(`node ${row.nodeId}: already encrypted, skipping.`);
      continue;
    }

    await db
      .update(platformNodeCredentialsTable)
      .set({
        nodeSecretKeyBase64: nodeKeyAlreadyEncrypted ? row.nodeSecretKeyBase64 : encryptSecret(row.nodeSecretKeyBase64),
        walletSecretKeyBase58: walletKeyAlreadyEncrypted ? row.walletSecretKeyBase58 : encryptSecret(row.walletSecretKeyBase58),
      })
      .where(eq(platformNodeCredentialsTable.id, row.id));

    encryptedCount++;
    console.log(`node ${row.nodeId}: encrypted at rest.`);
  }

  console.log(`\nDone. Encrypted ${encryptedCount} row(s), skipped ${skippedCount} already-encrypted row(s).`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Migration failed:", err);
    process.exit(1);
  });
