#!/usr/bin/env node
/**
 * Copy non-TypeScript assets (manifests, stylesheets) from
 * `extensions/<name>/` into `dist/extensions/<name>/` after `tsc -p
 * tsconfig.extensions.json` has compiled the .ts sources.
 *
 * Kept as a tiny standalone script (no dependencies) so the build
 * pipeline stays understandable. Walks the extensions directory,
 * mirrors the directory structure, and copies any file that's NOT a
 * TypeScript source. Idempotent.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const srcRoot = path.join(repoRoot, "extensions");
const dstRoot = path.join(repoRoot, "dist", "extensions");

if (!fs.existsSync(srcRoot)) {
  console.log("[build-extensions] no extensions directory; nothing to copy");
  process.exit(0);
}

function walk(dir, out = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const files = walk(srcRoot);
let copied = 0;
for (const file of files) {
  const ext = path.extname(file);
  // Skip TypeScript sources — tsc handles them
  if (ext === ".ts" || ext === ".tsx") continue;
  const rel = path.relative(srcRoot, file);
  const dst = path.join(dstRoot, rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(file, dst);
  copied++;
}

console.log(`[build-extensions] copied ${copied} extension asset(s) to dist/extensions/`);
