#!/usr/bin/env node
/**
 * Bundle extensions that have a vite.config.ts — these need their
 * npm dependencies inlined since extensions are loaded at runtime
 * via dynamic import() from a URL, not through a bundler.
 *
 * Extensions without a vite.config.ts keep their tsc-compiled output
 * (no bundling needed — they have no npm deps).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const extRoot = path.join(repoRoot, "extensions");

if (!fs.existsSync(extRoot)) {
  console.log("[bundle-extensions] no extensions directory; nothing to bundle");
  process.exit(0);
}

const entries = fs.readdirSync(extRoot, { withFileTypes: true });
let bundled = 0;

for (const entry of entries) {
  if (!entry.isDirectory()) continue;
  const viteConfig = path.join(extRoot, entry.name, "vite.config.ts");
  if (!fs.existsSync(viteConfig)) continue;

  console.log(`[bundle-extensions] bundling ${entry.name}...`);
  try {
    execSync(`npx vite build --config ${viteConfig}`, {
      cwd: repoRoot,
      stdio: "pipe",
    });
    bundled++;
    console.log(`[bundle-extensions] ${entry.name} bundled`);
  } catch (err) {
    const msg = err.stderr?.toString() ?? err.message;
    // Rollup native binaries may not be available when installed as a
    // dependency on a different platform (e.g., npm prepare in CI).
    // Skip bundling instead of failing — consumers build their own
    // private extensions separately via their own build pipeline.
    if (msg.includes("@rollup/rollup-") || msg.includes("Cannot find module")) {
      console.warn(`[bundle-extensions] ${entry.name} skipped (Rollup native binary not available)`);
      continue;
    }
    console.error(`[bundle-extensions] ${entry.name} failed:`, msg);
    process.exit(1);
  }
}

console.log(`[bundle-extensions] bundled ${bundled} extension(s)`);
