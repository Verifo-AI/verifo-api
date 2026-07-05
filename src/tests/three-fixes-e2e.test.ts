/**
 * E2E verification for the 3 user-reported fixes:
 *
 *   1. Proof page "You Paid" must be driven by creditsUsed (credits), not
 *      totalPaidUsdcMicros (USDC) — see proof.tsx.
 *   2. 70/30 node/treasury reward split — computeRewardMicros() /
 *      GET /api/tasks/:taskId's totalPaidUsdcMicros/treasuryUsdcMicros math.
 *   3. 16 platform fallback nodes get auto-seeded (idempotently) with their
 *      own distinct wallets, and real task routing distributes across
 *      multiple nodes instead of always picking the same one.
 *
 * ISOLATION: Requires TEST_DATABASE_URL. The test runner (test.mjs) enforces
 * this. All DB writes use unique clerkUserId/taskId values and are cleaned
 * up in `after()`.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import jwt from "jsonwebtoken";
import { db, nodesTable, tasksTable, creditsTable, platformNodeCredentialsTable } from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { initNodeEarnings } from "../lib/nodeState.js";
import { findAvailableNode } from "../lib/taskRouter.js";
import { computeRewardMicros, CREDIT_USDC_MICROS, NODE_REWARD_SHARE, TREASURY_SHARE } from "../routes/tasks.js";
import { seedPlatformNodesIfMissing } from "../platformNodesWorker.js";
import app from "../app.js";

if (!process.env.TEST_DATABASE_URL) {
  throw new Error(
    "TEST_DATABASE_URL must be set before running integration tests. " +
      "These tests mutate the database and must not run against the live database.",
  );
}

const JWT_SECRET = process.env.JWT_SECRET ?? "verifo-dev-secret-2024";
const RUN_ID = Date.now().toString(36);
const TEST_WALLET = `e2e_threefix_wallet_${RUN_ID}`;

function makeToken(wallet: string): string {
  return jwt.sign({ walletAddress: wallet }, JWT_SECRET, { expiresIn: "1h" });
}

function request(
  server: http.Server,
  method: string,
  reqPath: string,
  opts: { token?: string; body?: unknown } = {},
): Promise<{ status: number; body: any }> {
  const addr = server.address() as { port: number };
  const url = `http://127.0.0.1:${addr.port}${reqPath}`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.token) headers["Authorization"] = `Bearer ${opts.token}`;
  const payload = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;

  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers }, (res) => {
      let raw = "";
      res.on("data", (c: Buffer) => { raw += c.toString(); });
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) });
        } catch {
          resolve({ status: res.statusCode ?? 0, body: raw });
        }
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

let server: http.Server;
const createdNodeIds: number[] = [];
const createdTaskIds: string[] = [];

before(async () => {
  await initNodeEarnings();
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
});

after(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );

  if (createdTaskIds.length > 0) {
    await db.delete(tasksTable).where(inArray(tasksTable.taskId, createdTaskIds));
  }
  if (createdNodeIds.length > 0) {
    await db.delete(platformNodeCredentialsTable).where(inArray(platformNodeCredentialsTable.nodeId, createdNodeIds));
    await db.delete(nodesTable).where(inArray(nodesTable.id, createdNodeIds));
  }
  await db.delete(creditsTable).where(eq(creditsTable.clerkUserId, TEST_WALLET));

  await (db as unknown as { $client: { end: () => Promise<void> } }).$client.end();
});

// ---------------------------------------------------------------------------
// Fix #1: "You Paid" shows credits, not USDC — static regression guard on
// the actual component the user was looking at, plus the API field it reads.
// ---------------------------------------------------------------------------

test("Fix #1: proof.tsx 'You Paid' block reads task.creditsUsed, not totalPaidUsdcMicros", () => {
  // Resolve from process.cwd() (always artifacts/api-server when `pnpm test`
  // runs) rather than import.meta.url: the esbuild-bundled test file's own
  // location varies depending on where test.mjs writes its build output, so
  // a path relative to the bundle is not stable.
  const proofTsxPath = path.resolve(process.cwd(), "../verifo/src/pages/dashboard/proof.tsx");
  const source = readFileSync(proofTsxPath, "utf-8");

  const paidBlockMatch = source.match(/You Paid[\s\S]{0,300}/);
  assert.ok(paidBlockMatch, "'You Paid' label should still exist in proof.tsx");

  const paidBlock = paidBlockMatch![0];
  assert.ok(paidBlock.includes("task.creditsUsed"), "'You Paid' block must render task.creditsUsed");
  assert.ok(paidBlock.includes("Credits"), "'You Paid' block must label the unit as Credits");
  assert.ok(
    !/totalPaidUsdcMicros/.test(paidBlock),
    "'You Paid' block must NOT reference totalPaidUsdcMicros (the original bug)",
  );
});

test("Fix #1: GET /api/tasks/:taskId returns creditsUsed as a positive integer for the UI to render", async () => {
  const token = makeToken(TEST_WALLET);
  const taskId = `e2e_task_credits_${RUN_ID}`;
  createdTaskIds.push(taskId);

  await db.insert(tasksTable).values({
    taskId,
    clerkUserId: TEST_WALLET,
    prompt: "e2e test prompt",
    model: "claude-sonnet-4-6",
    type: "chat",
    status: "completed",
    creditsUsed: 10,
    response: "e2e test response",
    source: "fallback_claude",
    completedAt: new Date(),
  });

  const { status, body } = await request(server, "GET", `/api/tasks/${taskId}`, { token });
  assert.equal(status, 200, "task fetch should succeed");
  assert.equal(body.creditsUsed, 10, "creditsUsed should be exactly what was stored");
  assert.equal(typeof body.creditsUsed, "number", "creditsUsed must be a number for direct UI rendering");
});

// ---------------------------------------------------------------------------
// Fix #2: 70/30 node/treasury split
// ---------------------------------------------------------------------------

test("Fix #2: NODE_REWARD_SHARE / TREASURY_SHARE are exactly 0.7 / 0.3", () => {
  assert.equal(NODE_REWARD_SHARE, 0.7, "node share must be 70%");
  // TREASURY_SHARE is derived as `1 - NODE_REWARD_SHARE`, which lands on
  // 0.30000000000000004 due to IEEE 754 float rounding — that's fine, it
  // doesn't affect real money math (computeRewardMicros works in integer
  // micros), so compare with a tolerance instead of exact equality.
  assert.ok(Math.abs(TREASURY_SHARE - 0.3) < 1e-9, "treasury share must be 30%");
  assert.ok(Math.abs(NODE_REWARD_SHARE + TREASURY_SHARE - 1) < 1e-9, "shares must sum to 100%");
});

test("Fix #2: computeRewardMicros pays a CLI node exactly 70% for local_model and relayed work", () => {
  const creditsUsed = 20;
  const totalPaidMicros = creditsUsed * CREDIT_USDC_MICROS;

  const localReward = computeRewardMicros("local_model", creditsUsed, "cli");
  const relayedReward = computeRewardMicros("relayed", creditsUsed, "cli");

  assert.equal(localReward, Math.round(totalPaidMicros * 0.7), "local_model reward must be 70% of what was paid");
  assert.equal(relayedReward, Math.round(totalPaidMicros * 0.7), "relayed reward must also be 70% (flat rate)");
  assert.equal(
    totalPaidMicros - localReward,
    Math.round(totalPaidMicros * 0.3),
    "the remaining 30% must go to the treasury",
  );
});

test("Fix #2: computeRewardMicros pays nothing for fallback_claude/fallback_openai_image (no node involved)", () => {
  assert.equal(computeRewardMicros("fallback_claude", 20, "cli"), 0);
  assert.equal(computeRewardMicros("fallback_openai_image", 30, "cli"), 0);
});

test("Fix #2: GET /api/tasks/:taskId reports totalPaidUsdcMicros/treasuryUsdcMicros consistent with a 70/30 split", async () => {
  const token = makeToken(TEST_WALLET);
  const taskId = `e2e_task_split_${RUN_ID}`;
  createdTaskIds.push(taskId);

  const creditsUsed = 20;
  const totalPaidMicros = creditsUsed * CREDIT_USDC_MICROS;
  const nodeRewardMicros = Math.round(totalPaidMicros * NODE_REWARD_SHARE);

  await db.insert(tasksTable).values({
    taskId,
    clerkUserId: TEST_WALLET,
    prompt: "e2e split test",
    model: "claude-sonnet-4-6",
    type: "coding",
    status: "completed",
    creditsUsed,
    response: "e2e split response",
    source: "local_model",
    nodeRewardUsdcMicros: nodeRewardMicros,
    rewardPayoutStatus: "paid",
    completedAt: new Date(),
  });

  const { status, body } = await request(server, "GET", `/api/tasks/${taskId}`, { token });
  assert.equal(status, 200);
  assert.equal(body.totalPaidUsdcMicros, totalPaidMicros, "totalPaidUsdcMicros must equal creditsUsed * CREDIT_USDC_MICROS");
  assert.equal(
    body.treasuryUsdcMicros,
    totalPaidMicros - nodeRewardMicros,
    "treasuryUsdcMicros must equal the remaining 30% after the node's 70% cut",
  );

  const nodeShareRatio = body.nodeRewardUsdcMicros / body.totalPaidUsdcMicros;
  const treasuryShareRatio = body.treasuryUsdcMicros / body.totalPaidUsdcMicros;
  assert.ok(Math.abs(nodeShareRatio - 0.7) < 0.02, `node share ratio should be ~70%, got ${nodeShareRatio}`);
  assert.ok(Math.abs(treasuryShareRatio - 0.3) < 0.02, `treasury share ratio should be ~30%, got ${treasuryShareRatio}`);
});

// ---------------------------------------------------------------------------
// Fix #3: platform fallback nodes auto-seed + random routing distribution
// ---------------------------------------------------------------------------

test("Fix #3: seedPlatformNodesIfMissing creates exactly 16 platform nodes with distinct wallets on a fresh DB", async () => {
  await seedPlatformNodesIfMissing();

  const platformNodes = await db
    .select({ id: nodesTable.id, walletAddress: nodesTable.walletAddress, nodePublicKey: nodesTable.nodePublicKey })
    .from(nodesTable)
    .where(eq(nodesTable.isPlatformNode, true));

  assert.equal(platformNodes.length, 16, "should seed exactly 16 platform nodes");

  const uniqueWallets = new Set(platformNodes.map((n) => n.walletAddress));
  assert.equal(uniqueWallets.size, 16, "every platform node must have its own distinct wallet address");

  const uniqueIdentities = new Set(platformNodes.map((n) => n.nodePublicKey));
  assert.equal(uniqueIdentities.size, 16, "every platform node must have its own distinct node identity");

  const credRows = await db
    .select({ nodeId: platformNodeCredentialsTable.nodeId })
    .from(platformNodeCredentialsTable)
    .where(inArray(platformNodeCredentialsTable.nodeId, platformNodes.map((n) => n.id)));
  assert.equal(credRows.length, 16, "every platform node must have its encrypted credentials row");
});

test("Fix #3: seedPlatformNodesIfMissing is idempotent — calling it again does not create duplicates", async () => {
  await seedPlatformNodesIfMissing();
  await seedPlatformNodesIfMissing();

  const platformNodes = await db
    .select({ id: nodesTable.id })
    .from(nodesTable)
    .where(eq(nodesTable.isPlatformNode, true));

  assert.equal(platformNodes.length, 16, "re-running the seed must not add more than the original 16 nodes");
});

test("Fix #3: findAvailableNode distributes tasks across multiple distinct platform nodes, not always the same one", async () => {
  const platformNodes = await db
    .select({ id: nodesTable.id })
    .from(nodesTable)
    .where(eq(nodesTable.isPlatformNode, true));
  assert.ok(platformNodes.length >= 2, "need at least 2 platform nodes seeded to test distribution");

  const seenNodeIds = new Set<number>();
  const platformNodeIdSet = new Set(platformNodes.map((n) => n.id));

  for (let i = 0; i < 40; i++) {
    const picked = await findAvailableNode();
    assert.ok(picked, "should always find a node given 16 platform nodes exist and are marked verified+recent");
    if (picked && platformNodeIdSet.has(picked.id)) {
      seenNodeIds.add(picked.id);
    }
  }

  assert.ok(
    seenNodeIds.size >= 3,
    `random routing across 40 picks should hit at least 3 distinct platform nodes, got ${seenNodeIds.size} (this is the exact bug reported: 'always the same node')`,
  );
});

test("Fix #3: real contributor (compute/relay) nodes always win over platform nodes when both are online", async () => {
  const [realNode] = await db
    .insert(nodesTable)
    .values({
      clerkUserId: `e2e_real_contributor_${RUN_ID}`,
      nodeType: "compute",
      os: "linux",
      hardware: "e2e test rig",
      walletAddress: `e2e_real_wallet_${RUN_ID}`,
      verified: true,
      lastSeenAt: new Date(),
      contributionMode: "compute",
      isPlatformNode: false,
    })
    .returning();
  createdNodeIds.push(realNode!.id);

  for (let i = 0; i < 10; i++) {
    const picked = await findAvailableNode();
    assert.equal(picked?.id, realNode!.id, "a real online compute node must always be picked over platform fallback nodes");
  }
});
