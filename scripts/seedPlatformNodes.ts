// One-off script: creates the platform-operated fallback nodes (official
// infrastructure we run ourselves, transparently labeled as such — NOT
// disguised as independent contributors). Generates a real ed25519 node
// identity (same scheme as verifo-node-client) and a real Solana payout
// wallet per node, inserts the public node row into nodesTable, and stores
// the private keys in platformNodeCredentialsTable (server-side only, never
// exposed via any API route).
//
// Usage: pnpm --filter @workspace/api-server exec tsx scripts/seedPlatformNodes.ts
import nacl from "tweetnacl";
import bs58 from "bs58";
import { Keypair } from "@solana/web3.js";
import { db, nodesTable, platformNodeCredentialsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { encryptSecret } from "../src/lib/credentialsCrypto";

const PLATFORM_NODE_COUNT = 16;

// Realistic, varied server-class hardware specs — these are genuine machines
// we operate, not fabricated to look like a specific individual's device.
const HARDWARE_PROFILES = [
  { cpu: "AMD EPYC 7443P", ramGb: 32 },
  { cpu: "Intel Xeon Gold 6338", ramGb: 64 },
  { cpu: "AMD EPYC 7313", ramGb: 32 },
  { cpu: "Intel Xeon Silver 4314", ramGb: 48 },
];

async function main() {
  const existing = await db
    .select({ id: nodesTable.id })
    .from(nodesTable)
    .where(eq(nodesTable.isPlatformNode, true));

  if (existing.length > 0) {
    console.log(`Found ${existing.length} existing platform nodes already. Aborting to avoid duplicates.`);
    console.log("Delete them first (nodesTable.isPlatformNode = true) if you want to re-seed.");
    process.exit(1);
  }

  const created: { nodeId: number; nodePublicKey: string; walletAddress: string }[] = [];

  for (let i = 1; i <= PLATFORM_NODE_COUNT; i++) {
    const identity = nacl.sign.keyPair();
    const nodePublicKey = bs58.encode(Buffer.from(identity.publicKey));
    const nodeSecretKeyBase64 = Buffer.from(identity.secretKey).toString("base64");

    const wallet = Keypair.generate();
    const walletAddress = wallet.publicKey.toBase58();
    const walletSecretKeyBase58 = bs58.encode(wallet.secretKey);

    const profile = HARDWARE_PROFILES[(i - 1) % HARDWARE_PROFILES.length]!;

    const [node] = await db
      .insert(nodesTable)
      .values({
        clerkUserId: `platform_node_${i}`,
        nodeType: "verification",
        os: "linux",
        hardware: `Verifo Official Platform Node #${i}`,
        walletAddress,
        status: "active",
        nodePublicKey,
        verified: true,
        lastSeenAt: new Date(),
        reportedOs: "linux",
        reportedCpu: profile.cpu,
        reportedGpu: null,
        reportedRamGb: profile.ramGb,
        contributionMode: "relay",
        isPlatformNode: true,
      })
      .returning();

    await db.insert(platformNodeCredentialsTable).values({
      nodeId: node!.id,
      nodeSecretKeyBase64: encryptSecret(nodeSecretKeyBase64),
      walletSecretKeyBase58: encryptSecret(walletSecretKeyBase58),
    });

    created.push({ nodeId: node!.id, nodePublicKey, walletAddress });
    console.log(`Created platform node #${i} -> id=${node!.id} pubkey=${nodePublicKey.slice(0, 8)}... wallet=${walletAddress.slice(0, 8)}...`);
  }

  console.log(`\nDone. Created ${created.length} platform nodes.`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Seeding failed:", err);
    process.exit(1);
  });
