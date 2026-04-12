import * as fs from "node:fs";
import * as path from "node:path";
import { dataDir } from "backpack-ontology";

/**
 * Shared helpers for the viewer-state bridge endpoints. Used by both
 * `bin/serve.js` (production) and `vite.config.ts` (dev). The HTTP wiring
 * stays in each entry file because the signatures differ slightly
 * (raw http vs Vite connect middleware), but the actual logic — path
 * resolution, atomic write, read — lives once in this module.
 */

/** Absolute path to the viewer-state JSON file. */
export function viewerStatePath(): string {
  return path.join(dataDir(), "viewer-state.json");
}

/**
 * Atomically write a viewer-state payload. Validates that the body is
 * well-formed JSON, then writes to a `.tmp` file and renames into place
 * so readers (like the backpack-ontology MCP server) never see a partial
 * write.
 */
export async function writeViewerState(rawJsonBody: string): Promise<void> {
  // Round-trip validates the body is JSON before we touch the file system
  const state = JSON.parse(rawJsonBody);
  const target = viewerStatePath();
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  const tmp = target + ".tmp";
  await fs.promises.writeFile(tmp, JSON.stringify(state));
  await fs.promises.rename(tmp, target);
}

/** Read the current viewer-state file as a UTF-8 string. Throws on missing file. */
export async function readViewerState(): Promise<string> {
  return fs.promises.readFile(viewerStatePath(), "utf8");
}
