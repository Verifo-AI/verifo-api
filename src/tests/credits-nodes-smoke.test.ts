/**
 * Smoke tests: credits and nodes endpoints.
 *
 * Coverage:
 *   GET  /api/credits/packages          — shape + static content (no auth)
 *   POST /api/credits/topup             — 401 without auth, 400 on missing/invalid fields,
 *                                         200 success path against test database
 *   GET  /api/nodes/status              — shape (no auth, in-memory)
 *   GET  /api/nodes/tasks               — shape + pagination params (no auth, in-memory)
 *   GET  /api/nodes/earnings            — shape smoke (no auth, test database)
 *
 * ISOLATION: Requires TEST_DATABASE_URL. The test runner (test.mjs) enforces this.
 * All DB writes use a unique wallet address and are cleaned up in `after()`.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import jwt from "jsonwebtoken";
import { db, creditsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { initNodeEarnings } from "../lib/nodeState.js";
import app from "../app.js";

if (!process.env.TEST_DATABASE_URL) {
  throw new Error(
    "TEST_DATABASE_URL must be set before running integration tests. " +
      "These tests mutate the database and must not run against the live database.",
  );
}

const JWT_SECRET = process.env.JWT_SECRET ?? "verifo-dev-secret-2024";
const TEST_WALLET = "SmokeTest_wallet_credits_nodes_" + Date.now();

function makeToken(wallet: string): string {
  return jwt.sign({ walletAddress: wallet }, JWT_SECRET, { expiresIn: "1h" });
}

async function request(
  server: http.Server,
  method: string,
  path: string,
  opts: { token?: string; body?: unknown } = {},
): Promise<{ status: number; body: unknown }> {
  const addr = server.address() as { port: number };
  const url = `http://127.0.0.1:${addr.port}${path}`;
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

before(async () => {
  await initNodeEarnings();
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
});

after(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
  await db.delete(creditsTable).where(eq(creditsTable.clerkUserId, TEST_WALLET));
  await (db as unknown as { $client: { end: () => Promise<void> } }).$client.end();
});

// ---------------------------------------------------------------------------
// GET /api/credits/packages
// ---------------------------------------------------------------------------

test("GET /api/credits/packages returns 200 with packages array", async () => {
  const { status, body } = await request(server, "GET", "/api/credits/packages");
  const data = body as { packages: Array<{ id: string; credits: number; usdcAmount: number; label: string }>; usdcMint: string; treasuryWallet: string };

  assert.equal(status, 200, "status should be 200");
  assert.ok(Array.isArray(data.packages), "packages should be an array");
  assert.ok(data.packages.length > 0, "packages should not be empty");
  assert.equal(typeof data.usdcMint, "string", "usdcMint should be a string");
  assert.equal(typeof data.treasuryWallet, "string", "treasuryWallet should be a string");
});

test("GET /api/credits/packages each package has required fields", async () => {
  const { body } = await request(server, "GET", "/api/credits/packages");
  const data = body as { packages: Array<{ id: string; credits: number; usdcAmount: number; label: string }> };

  for (const pkg of data.packages) {
    assert.equal(typeof pkg.id, "string", "package.id must be a string");
    assert.equal(typeof pkg.credits, "number", "package.credits must be a number");
    assert.ok(pkg.credits > 0, "package.credits must be positive");
    assert.equal(typeof pkg.usdcAmount, "number", "package.usdcAmount must be a number");
    assert.equal(typeof pkg.label, "string", "package.label must be a string");
  }
});

// ---------------------------------------------------------------------------
// POST /api/credits/topup — validation
// ---------------------------------------------------------------------------

test("POST /api/credits/topup returns 401 without auth token", async () => {
  const { status } = await request(server, "POST", "/api/credits/topup", {
    body: { packageId: "pack_100", txSignature: "x".repeat(25), walletAddress: TEST_WALLET },
  });
  assert.equal(status, 401, "should reject with 401 when no token");
});

test("POST /api/credits/topup returns 400 when body fields are missing", async () => {
  const token = makeToken(TEST_WALLET);
  const { status, body } = await request(server, "POST", "/api/credits/topup", {
    token,
    body: { packageId: "pack_100" },
  });
  const data = body as { error: string };
  assert.equal(status, 400, "should reject with 400 when fields are missing");
  assert.ok(typeof data.error === "string", "error message should be a string");
});

test("POST /api/credits/topup returns 400 for invalid packageId", async () => {
  const token = makeToken(TEST_WALLET);
  const { status, body } = await request(server, "POST", "/api/credits/topup", {
    token,
    body: { packageId: "pack_invalid", txSignature: "x".repeat(25), walletAddress: TEST_WALLET },
  });
  const data = body as { error: string };
  assert.equal(status, 400, "should reject with 400 for unknown package");
  assert.ok(typeof data.error === "string", "error message should be a string");
});

test("POST /api/credits/topup returns 400 when txSignature is too short", async () => {
  const token = makeToken(TEST_WALLET);
  const { status } = await request(server, "POST", "/api/credits/topup", {
    token,
    body: { packageId: "pack_100", txSignature: "short", walletAddress: TEST_WALLET },
  });
  assert.equal(status, 400, "should reject with 400 for short txSignature");
});

test("POST /api/credits/topup succeeds against test database and returns credits", async () => {
  const token = makeToken(TEST_WALLET);
  const { status, body } = await request(server, "POST", "/api/credits/topup", {
    token,
    body: { packageId: "pack_100", txSignature: "validFakeSig" + "x".repeat(20), walletAddress: TEST_WALLET },
  });
  const data = body as { success: boolean; credits: number; added: number; package: string };

  assert.equal(status, 200, "successful topup should return 200");
  assert.equal(data.success, true, "success should be true");
  assert.equal(typeof data.credits, "number", "credits should be a number");
  assert.ok(data.credits > 0, "credits should be positive");
  assert.equal(data.added, 10_000, "should have added 10,000 credits (pack_100)");
  assert.equal(data.package, "Starter", "package label should be Starter");
});

test("POST /api/credits/topup second top-up accumulates credits", async () => {
  const token = makeToken(TEST_WALLET);
  const first = await request(server, "POST", "/api/credits/topup", {
    token,
    body: { packageId: "pack_100", txSignature: "anotherFakeSig" + "x".repeat(20), walletAddress: TEST_WALLET },
  });
  const data = first.body as { success: boolean; credits: number };
  assert.equal(first.status, 200, "second topup should also return 200");
  assert.ok(data.credits > 100, "credits should have increased beyond initial grant");
});

// ---------------------------------------------------------------------------
// GET /api/nodes/status
// ---------------------------------------------------------------------------

test("GET /api/nodes/status returns 200 with valid shape", async () => {
  const { status, body } = await request(server, "GET", "/api/nodes/status");
  const data = body as {
    nodeId: string;
    region: string;
    status: string;
    uptimePercent: number;
    earningsToday: string;
    reputationScore: number;
    tasksCompleted: number;
    cpuLoad: string;
    memUsed: string;
    lastSeen: string;
  };

  assert.equal(status, 200, "status should be 200");
  assert.equal(typeof data.nodeId, "string", "nodeId should be a string");
  assert.equal(typeof data.region, "string", "region should be a string");
  assert.ok(["online", "offline", "syncing"].includes(data.status), "status should be a valid enum value");
  assert.equal(typeof data.uptimePercent, "number", "uptimePercent should be a number");
  assert.ok(data.uptimePercent >= 0 && data.uptimePercent <= 100, "uptimePercent should be 0–100");
  assert.equal(typeof data.tasksCompleted, "number", "tasksCompleted should be a number");
  assert.ok(data.tasksCompleted >= 0, "tasksCompleted must be non-negative");
  assert.equal(typeof data.reputationScore, "number", "reputationScore should be a number");
  assert.equal(typeof data.earningsToday, "string", "earningsToday should be a string");
  assert.equal(typeof data.cpuLoad, "string", "cpuLoad should be a string");
  assert.equal(typeof data.memUsed, "string", "memUsed should be a string");
  assert.equal(typeof data.lastSeen, "string", "lastSeen should be a string");
});

// ---------------------------------------------------------------------------
// GET /api/nodes/tasks
// ---------------------------------------------------------------------------

test("GET /api/nodes/tasks returns 200 with valid shape", async () => {
  const { status, body } = await request(server, "GET", "/api/nodes/tasks");
  const data = body as { tasks: unknown[]; total: number };

  assert.equal(status, 200, "status should be 200");
  assert.ok(Array.isArray(data.tasks), "tasks should be an array");
  assert.equal(typeof data.total, "number", "total should be a number");
  assert.ok(data.total >= 0, "total must be non-negative");
});

test("GET /api/nodes/tasks respects limit query param", async () => {
  const { body } = await request(server, "GET", "/api/nodes/tasks?limit=3");
  const data = body as { tasks: unknown[]; total: number };

  assert.ok(data.tasks.length <= 3, "returned tasks should not exceed the requested limit");
});

test("GET /api/nodes/tasks with status filter returns 200", async () => {
  const { status } = await request(server, "GET", "/api/nodes/tasks?status=completed");
  assert.equal(status, 200, "status filter should still return 200");
});

// ---------------------------------------------------------------------------
// GET /api/nodes/earnings — shape smoke (persistence detail covered separately)
// ---------------------------------------------------------------------------

test("GET /api/nodes/earnings returns 200 with valid shape", async () => {
  const { status, body } = await request(server, "GET", "/api/nodes/earnings?days=7");
  const data = body as { days: Array<{ date: string; label: string; vrfEarned: number }>; totalVrf: number; periodDays: number };

  assert.equal(status, 200, "status should be 200");
  assert.ok(Array.isArray(data.days), "days should be an array");
  assert.equal(typeof data.totalVrf, "number", "totalVrf should be a number");
  assert.equal(typeof data.periodDays, "number", "periodDays should be a number");
  assert.equal(data.periodDays, 7, "periodDays should match query param");
  assert.equal(data.days.length, 7, "should return exactly 7 day entries");
});

test("GET /api/nodes/earnings clamps days to 1 minimum", async () => {
  const { status, body } = await request(server, "GET", "/api/nodes/earnings?days=0");
  const data = body as { periodDays: number };
  assert.equal(status, 200);
  assert.equal(data.periodDays, 1, "days=0 should be clamped to 1");
});

test("GET /api/nodes/earnings clamps days to 90 maximum", async () => {
  const { status, body } = await request(server, "GET", "/api/nodes/earnings?days=999");
  const data = body as { periodDays: number };
  assert.equal(status, 200);
  assert.equal(data.periodDays, 90, "days=999 should be clamped to 90");
});
