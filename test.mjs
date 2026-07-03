import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build as esbuild } from "esbuild";
import esbuildPluginPino from "esbuild-plugin-pino";
import { execSync } from "node:child_process";
import { rm, mkdtemp } from "node:fs/promises";
import os from "node:os";

globalThis.require = createRequire(import.meta.url);

if (!process.env.TEST_DATABASE_URL) {
  console.error(
    "\nERROR: TEST_DATABASE_URL is not set.\n" +
    "Integration tests require a dedicated test database to avoid touching live data.\n" +
    "Set TEST_DATABASE_URL to a separate database URL before running tests.\n" +
    "Example: TEST_DATABASE_URL=postgresql://user:pass@host/testdb pnpm test\n",
  );
  process.exit(1);
}

const artifactDir = path.dirname(fileURLToPath(import.meta.url));
const dbDir = path.resolve(artifactDir, "../../lib/db");
const drizzleConfig = path.join(dbDir, "drizzle.config.ts");
const drizzleKit = path.join(dbDir, "node_modules/.bin/drizzle-kit");

console.log("\nApplying migrations to test database via drizzle-kit migrate...");
execSync(`${drizzleKit} migrate --config ${drizzleConfig}`, {
  stdio: "inherit",
  env: { ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL },
});
console.log("Test database migrations applied.\n");

const testSuites = [
  "src/tests/earnings-persistence.test.ts",
  "src/tests/credits-nodes-smoke.test.ts",
];

const esbuildBanner = {
  js: `import { createRequire as __bannerCrReq } from 'node:module';
import __bannerPath from 'node:path';
import __bannerUrl from 'node:url';
globalThis.require = __bannerCrReq(import.meta.url);
globalThis.__filename = __bannerUrl.fileURLToPath(import.meta.url);
globalThis.__dirname = __bannerPath.dirname(globalThis.__filename);
`,
};

let overallFailed = false;

for (const suite of testSuites) {
  const outDir = await mkdtemp(path.join(os.tmpdir(), "verifo-test-"));
  const entryPoint = path.resolve(artifactDir, suite);
  const outFile = path.join(outDir, path.basename(suite).replace(/\.ts$/, ".mjs"));

  try {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`Building: ${suite}`);
    console.log("=".repeat(60));

    await esbuild({
      entryPoints: [entryPoint],
      platform: "node",
      bundle: true,
      format: "esm",
      outdir: outDir,
      outExtension: { ".js": ".mjs" },
      logLevel: "info",
      external: ["*.node", "pg-native"],
      plugins: [esbuildPluginPino({ transports: ["pino-pretty"] })],
      banner: esbuildBanner,
    });

    console.log(`\nRunning: ${suite}`);
    console.log("=".repeat(60));

    execSync(`node --test --test-force-exit ${outFile}`, {
      stdio: "inherit",
      env: process.env,
    });
  } catch (err) {
    overallFailed = true;
    console.error(`\nTest suite FAILED: ${suite}`);
    if (err instanceof Error && "status" in err) {
      // execSync throws with exit code — already printed to stderr via stdio:"inherit"
    } else {
      console.error(err);
    }
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
}

if (overallFailed) {
  console.error("\nOne or more test suites failed.");
  process.exit(1);
}

console.log("\nAll test suites passed.");
