import type { ViewerExtensionAPI } from "./viewer-api";
import { createMessagesAPIProvider } from "./providers/messages-api.js";
import { createChatPanelController } from "./panel.js";

/**
 * Chat extension entry. The viewer's loader dynamic-imports this file
 * and calls `activate(viewer)`.
 *
 * One LLM provider, two deployment modes:
 *
 *  - Embedded in backpack-app: the host page sets
 *    `window.BACKPACK_CHAT_PROXY = "/api/chat/messages"` before loading
 *    the viewer bundle. The provider POSTs there and the backend talks
 *    to a Claude deployment in the SaaS Foundry workspace. Users never
 *    see Anthropic — auth is the existing app session cookie.
 *
 *  - Standalone OSS viewer: the global is unset. The provider falls
 *    back to api.anthropic.com via the extension's network proxy and
 *    the manifest injects the user's ANTHROPIC_API_KEY env var as
 *    x-api-key.
 */

declare global {
  interface Window {
    BACKPACK_CHAT_PROXY?: string;
  }
}

export function activate(viewer: ViewerExtensionAPI): void {
  const proxyPath =
    typeof window !== "undefined" ? window.BACKPACK_CHAT_PROXY : undefined;

  const provider =
    typeof proxyPath === "string" && proxyPath
      ? createMessagesAPIProvider({
          id: "backpack-cloud",
          displayName: "Backpack Cloud (Claude on Foundry)",
          endpoint: proxyPath,
          defaultModel: "claude-haiku-4-5",
        })
      : createMessagesAPIProvider({
          id: "anthropic",
          displayName: "Anthropic Claude",
          endpoint: "https://api.anthropic.com/v1/messages",
          defaultModel: "claude-sonnet-4-5",
          fetcher: viewer.fetch.bind(viewer),
        });

  const controller = createChatPanelController(viewer, provider);

  viewer.registerTaskbarIcon({
    label: "Chat",
    position: "top-right",
    onClick: () => controller.toggle(),
  });

  controller.loadHistory().catch((err) => {
    console.warn("[chat] failed to load history:", err);
  });
}
