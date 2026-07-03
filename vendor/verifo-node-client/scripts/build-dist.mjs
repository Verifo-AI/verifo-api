import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createZip } from "./zip.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

export async function buildNodeClientZip() {
  const bundleResult = await build({
    entryPoints: [path.join(root, "bin", "verifo-node.mjs")],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node18",
    write: false,
    banner: {
      js: [
        "#!/usr/bin/env node",
        "import { createRequire as __createRequire } from 'node:module';",
        "const require = __createRequire(import.meta.url);",
      ].join("\n"),
    },
  });

  const bundleContent = Buffer.from(bundleResult.outputFiles[0].contents);

  const files = [
    { name: "verifo-node-client/verifo-node.mjs", content: bundleContent },
    { name: "verifo-node-client/README.md", content: fs.readFileSync(path.join(root, "README.md")) },
    {
      name: "verifo-node-client/package.json",
      content: Buffer.from(
        JSON.stringify({ name: "verifo-node-client", type: "module", bin: { "verifo-node": "./verifo-node.mjs" } }, null, 2)
      ),
    },
  ];

  return createZip(files);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const outDir = path.join(root, "dist");
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const zipBuffer = await buildNodeClientZip();
  const zipPath = path.join(outDir, "verifo-node-client.zip");
  fs.writeFileSync(zipPath, zipBuffer);
  console.log(`Built ${zipPath} (${(zipBuffer.length / 1024).toFixed(1)} KB)`);
}
