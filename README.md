# Verifo API

The backend API server for Verifo, a decentralized AI infrastructure network built on Solana. It handles node registration and heartbeats, task submission and routing, on chain reward settlement, and authentication.

## Stack

- Node.js with Express
- TypeScript
- Drizzle ORM with PostgreSQL
- Solana web3.js for on chain reads and writes
- Anthropic for AI backed features

## Requirements

- Node.js 18 or newer
- A PostgreSQL database
- npm or pnpm

## Setup

1. Install dependencies:

   ```
   npm install
   ```

2. Set the required environment variables, including your database connection string, Solana RPC endpoint, treasury wallet key, and any auth provider keys your deployment needs. Check `src/` for the exact variable names read at startup.

3. Run database migrations using the tooling in `vendor/db/`.

4. Start the server:

   ```
   node build.mjs && node dist/index.js
   ```

   or, for local development, use your preferred TypeScript runner against `src/index.ts`.

## Project layout

- `src/`, application source code, including routes, middlewares, and business logic.
- `scripts/`, operational scripts, including the platform nodes worker.
- `vendor/api-zod/`, shared request and response validation schemas.
- `vendor/db/`, the Drizzle ORM schema and database access layer.
- `vendor/integrations-anthropic-ai/`, the Anthropic AI integration used for AI backed features.
- `vendor/verifo-node-client/`, a vendored copy of the contributor node client, used for reference and internal tooling.

## Tests

Run the test suite with:

```
node test.mjs
```

The test suite expects a `TEST_DATABASE_URL` environment variable pointing at a disposable PostgreSQL database.
