import app from "./app";
import { logger } from "./lib/logger";
import { initNodeEarnings } from "./lib/nodeState.js";

// Solana RPC calls (proof submission, confirmations) can throw outside the
// request's own promise chain when the underlying transport hits a
// rate-limit (HTTP 429) or transient network error deep inside
// @solana/web3.js's retry/subscription internals. Without these handlers,
// that single flaky RPC call crashes the *entire* API server process,
// taking down every unrelated endpoint (dashboard, contribute section,
// etc.) along with it. Log and keep serving instead of dying.
process.on("uncaughtException", (err) => {
  logger.error({ err }, "uncaughtException — server continuing, but investigate this");
});
process.on("unhandledRejection", (reason) => {
  logger.error({ err: reason }, "unhandledRejection — server continuing, but investigate this");
});

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");

  initNodeEarnings().catch((e: unknown) =>
    logger.error({ err: e }, "Failed to initialise node_earnings"),
  );
});
