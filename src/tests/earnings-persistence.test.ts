/**
 * Integration test: earnings data survives a server restart.
 *
 * Strategy mirrors the real startup sequence exactly:
 *   1. Snapshot and wipe node_earnings (clean slate = "fresh process").
 *   2. Insert a known set of rows (data accumulated before the restart).
 *   3. Call initNodeEarnings() — the same hook index.ts runs on boot.
 *   4. Start the Express app on an ephemeral port.
 *   5. Hit GET /api/nodes/earnings?days=7 via HTTP (the real endpoint).
 *   6. Assert the JSON response reflects the rows written before the restart.
 *   7. Restore original data and shut down the server.
 *
 * ISOLATION: This test requires TEST_DATABASE_URL to be set so it runs against
 * a dedicated test database. The test runner (test.mjs) enforces this before
 * reaching here. All database operations — including those inside
 * initNodeEarnings() and the Express route handlers — automatically target the
 * test database because lib/db prefers TEST_DATABASE_URL over DATABASE_URL.
 * Live production data is never touched.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { db, nodeEarningsTable } from "@workspace/db";
import { initNodeEarnings } from "../lib/nodeState.js";
import app from "../app.js";

if (!process.env.TEST_DATABASE_URL) {
  throw new Error(
    "TEST_DATABASE_URL must be set before running integration tests. " +
    "These tests mutate the database and must not run against the live database.",
  );
}

function dayOffset(daysAgo: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString().split("T")[0]!;
}

function noonUtcMs(dateStr: string): number {
  return new Date(`${dateStr}T12:00:00.000Z`).getTime();
}

async function getJson(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = "";
      res.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      res.on("end", () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    }).on("error", reject);
  });
}

let server: http.Server;
let baseUrl: string;
let savedRows: Array<{ type: string; rewardVrf: number; timestampMs: number }> = [];

const date2DaysAgo = dayOffset(2);
const date4DaysAgo = dayOffset(4);
const date6DaysAgo = dayOffset(6);

before(async () => {
  savedRows = await db
    .select({
      type: nodeEarningsTable.type,
      rewardVrf: nodeEarningsTable.rewardVrf,
      timestampMs: nodeEarningsTable.timestampMs,
    })
    .from(nodeEarningsTable);

  if (savedRows.length > 0) {
    await db.delete(nodeEarningsTable);
  }

  const testRows = [
    { type: "Inference: LLM Batch", rewardVrf: 1.23, timestampMs: noonUtcMs(date2DaysAgo) },
    { type: "Data Validation",       rewardVrf: 2.45, timestampMs: noonUtcMs(date4DaysAgo) },
    { type: "Embedding Compute",     rewardVrf: 3.67, timestampMs: noonUtcMs(date6DaysAgo) },
  ];

  await db.insert(nodeEarningsTable).values(testRows);

  await initNodeEarnings();

  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve()))
  );

  await db.delete(nodeEarningsTable);

  if (savedRows.length > 0) {
    await db.insert(nodeEarningsTable).values(savedRows);
  }

  await (db as unknown as { $client: { end: () => Promise<void> } }).$client.end();
});

test("GET /api/nodes/earnings returns rows inserted before the restart", async () => {
  const data = await getJson(`${baseUrl}/api/nodes/earnings?days=7`) as {
    days: Array<{ date: string; label: string; vrfEarned: number }>;
    totalVrf: number;
    periodDays: number;
  };

  assert.equal(data.periodDays, 7, "periodDays should be 7");
  assert.equal(data.days.length, 7, "should return exactly 7 days");

  const byDate = new Map(data.days.map((d) => [d.date, d.vrfEarned]));

  assert.ok(byDate.has(date2DaysAgo), `missing entry for ${date2DaysAgo}`);
  assert.ok(byDate.has(date4DaysAgo), `missing entry for ${date4DaysAgo}`);
  assert.ok(byDate.has(date6DaysAgo), `missing entry for ${date6DaysAgo}`);

  assert.equal(byDate.get(date2DaysAgo), 1.23, `VRF for ${date2DaysAgo} should be 1.23`);
  assert.equal(byDate.get(date4DaysAgo), 2.45, `VRF for ${date4DaysAgo} should be 2.45`);
  assert.equal(byDate.get(date6DaysAgo), 3.67, `VRF for ${date6DaysAgo} should be 3.67`);
});

test("GET /api/nodes/earnings response shape is valid after restart", async () => {
  const data = await getJson(`${baseUrl}/api/nodes/earnings?days=7`) as {
    days: Array<{ date: string; label: string; vrfEarned: number }>;
    totalVrf: number;
    periodDays: number;
  };

  assert.ok(Array.isArray(data.days), "days should be an array");
  assert.equal(typeof data.totalVrf, "number", "totalVrf should be a number");
  assert.equal(typeof data.periodDays, "number", "periodDays should be a number");

  for (const day of data.days) {
    assert.equal(typeof day.date, "string", "each day.date should be a string");
    assert.equal(typeof day.label, "string", "each day.label should be a string");
    assert.equal(typeof day.vrfEarned, "number", "each day.vrfEarned should be a number");
    assert.ok(day.vrfEarned >= 0, `vrfEarned for ${day.date} must be >= 0`);
  }
});

test("totalVrf in response equals sum of daily vrfEarned after restart", async () => {
  const data = await getJson(`${baseUrl}/api/nodes/earnings?days=7`) as {
    days: Array<{ date: string; label: string; vrfEarned: number }>;
    totalVrf: number;
    periodDays: number;
  };

  const expectedTotal = parseFloat(
    data.days.reduce((s, d) => s + d.vrfEarned, 0).toFixed(2),
  );
  assert.equal(data.totalVrf, expectedTotal, "totalVrf should equal sum of daily amounts");
});
