import type { ViewerExtensionAPI } from "./viewer-api";
import { createAnthropicProvider } from "./providers/anthropic.js";
import { createChatPanelController } from "./panel.js";

/**
 * Chat extension entry. The viewer's loader dynamic-imports this file
 * and calls `activate(viewer)`.
 *
 * Wires up:
 *   - One LLM provider (Anthropic for v1; future: OpenAI, Ollama, …)
 *   - The chat panel controller (mounts/unmounts the panel)
 *   - A taskbar icon that toggles the panel
 *
 * Everything goes through the viewer extension API. There is no
 * special-case wiring into viewer internals — this extension uses
 * exactly the same surface a third-party extension would.
 */
export function activate(viewer: ViewerExtensionAPI): void {
  const provider = createAnthropicProvider(viewer.fetch.bind(viewer));
  const controller = createChatPanelController(viewer, provider);

  viewer.registerTaskbarIcon({
    label: "Chat",
    // Top-right groups the chat toggle with the existing top-bar
    // controls (zoom, copy-prompt, theme) and aligns visually with the
    // chat panel itself, which docks to the right side of the canvas.
    position: "top-right",
    onClick: () => controller.toggle(),
  });

  // Restore any persisted history before the user opens the panel.
  // Errors are non-fatal — first run has nothing to restore.
  controller.loadHistory().catch((err) => {
    console.warn("[chat] failed to load history:", err);
  });
}
