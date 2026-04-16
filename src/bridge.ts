/**
 * Viewer ↔ MCP bridge.
 *
 * Publishes the viewer's current state (active graph, selection, focus) to
 * the local serve.js, which writes it to a state file in dataDir(). The
 * backpack-ontology MCP server exposes that file as the
 * `backpack://viewer/current` resource so any MCP client (Claude Code,
 * Claude Desktop, etc.) can ask "what is the user looking at?" and get a
 * grounded answer.
 *
 * Calls are debounced — selection changes can fire rapidly during walk
 * mode, and we don't need to publish each frame.
 */

export interface ViewerState {
  graph: string;
  selection: string[];
  focus: { seedNodeIds: string[]; hops: number } | null;
  selectedSignalIds?: string[];
}

const PUBLISH_DEBOUNCE_MS = 200;

let pending: ViewerState | null = null;
let scheduled: number | null = null;

export function publishViewerState(state: ViewerState): void {
  pending = state;
  if (scheduled !== null) return;
  scheduled = window.setTimeout(async () => {
    const payload = pending;
    pending = null;
    scheduled = null;
    if (!payload) return;
    try {
      await fetch("/api/viewer-state", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...payload,
          updatedAt: new Date().toISOString(),
        }),
      });
    } catch {
      // Best-effort. The bridge is non-critical — viewer keeps working.
    }
  }, PUBLISH_DEBOUNCE_MS);
}
