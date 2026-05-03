import type {
  LLMProvider,
  ProviderSendOptions,
  ChatMessage,
  ContentBlock,
  ToolUseBlock,
  ExtensionFetch,
} from "./types.js";

const FALLBACK_MAX_TOKENS = 4096;

export interface MessagesAPIProviderOptions {
  /**
   * Base URL the provider POSTs to. Either:
   *  - a same-origin path like "/api/chat/messages" (backpack-app proxy
   *    to a Claude deployment in the SaaS Foundry workspace; users
   *    don't supply API keys), or
   *  - "https://api.anthropic.com/v1/messages" (OSS standalone with
   *    user-supplied ANTHROPIC_API_KEY in env, routed through the
   *    extension's network proxy for header injection).
   */
  endpoint: string;
  /** Default model id when callers don't override per turn. */
  defaultModel: string;
  /** Display name shown in chat UI / settings. */
  displayName?: string;
  /** Provider id used for storing per-provider settings. */
  id?: string;
  /**
   * Fetch implementation. For cross-origin endpoints (api.anthropic.com)
   * pass `viewer.fetch.bind(viewer)` so the request goes through the
   * extension's server-side proxy and picks up manifest header
   * injection. For same-origin endpoints, omit (plain `fetch` flows
   * session cookies and skips the proxy).
   */
  fetcher?: ExtensionFetch;
  /** Override max_tokens; defaults to 4096. */
  maxTokens?: number;
}

/**
 * Returns true if the last message in the array is a fresh user
 * message (not a tool_result continuation). Used to decide when to
 * roll over to a new X-Chat-Session-Id so the backend can group all
 * LLM calls in one user-visible turn under one foundry_usage row.
 */
function isNewUserTurn(messages: ChatMessage[]): boolean {
  const last = messages[messages.length - 1];
  if (!last || last.role !== "user") return false;
  return last.content.every((c) => c.type !== "tool_result");
}

function makeSessionId(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof (crypto as Crypto).randomUUID === "function"
  ) {
    return `chat-${(crypto as Crypto).randomUUID()}`;
  }
  return `chat-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

/**
 * Generic Anthropic Messages API provider. Speaks the wire protocol
 * directly so it works against both Anthropic's hosted endpoint and our
 * Foundry-fronting backpack-app proxy at /api/chat/messages.
 *
 * SSE parsing matches Anthropic's content_block_* event sequence,
 * including input_json_delta for partial tool-use arguments. Multi-turn
 * tool use is driven by the panel — this provider handles one
 * request/response cycle.
 */
export function createMessagesAPIProvider(
  opts: MessagesAPIProviderOptions,
): LLMProvider {
  const fetcher: ExtensionFetch =
    opts.fetcher ?? ((url, init) => fetch(url, init));
  const maxTokens = opts.maxTokens ?? FALLBACK_MAX_TOKENS;
  let activeSessionId = makeSessionId();

  return {
    id: opts.id ?? "messages-api",
    displayName: opts.displayName ?? "Claude",
    defaultModel: opts.defaultModel,

    async send(send: ProviderSendOptions): Promise<ChatMessage> {
      // Roll the session id at the start of every user-visible turn
      // so the backend can group tool-loop calls into one usage row.
      if (isNewUserTurn(send.messages)) {
        activeSessionId = makeSessionId();
      }

      const body: Record<string, unknown> = {
        model: send.model ?? opts.defaultModel,
        max_tokens: maxTokens,
        stream: true,
        messages: send.messages,
      };
      if (send.system) body.system = send.system;
      if (send.tools.length > 0) body.tools = send.tools;

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "X-Chat-Session-Id": activeSessionId,
      };

      const res = await fetcher(opts.endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });

      if (!res.ok || !res.body) {
        let errText = `HTTP ${res.status}`;
        try {
          const errBody = await res.text();
          try {
            const parsed = JSON.parse(errBody);
            if (parsed.error) {
              errText =
                typeof parsed.error === "string"
                  ? parsed.error
                  : JSON.stringify(parsed.error);
            } else {
              errText += `: ${errBody}`;
            }
          } catch {
            errText += `: ${errBody}`;
          }
        } catch {
          /* swallow */
        }
        throw new Error(errText);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      const blocks: ContentBlock[] = [];
      type InProgress =
        | { type: "text"; text: string }
        | { type: "tool_use"; id: string; name: string; inputJson: string };
      const inProgress = new Map<number, InProgress>();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const events = buffer.split("\n\n");
        buffer = events.pop() ?? "";

        for (const ev of events) {
          const dataLine = ev.split("\n").find((l) => l.startsWith("data: "));
          if (!dataLine) continue;
          const payload = dataLine.slice(6).trim();
          if (!payload || payload === "[DONE]") continue;

          let parsed: any;
          try {
            parsed = JSON.parse(payload);
          } catch {
            continue;
          }

          switch (parsed.type) {
            case "content_block_start": {
              const idx: number = parsed.index;
              const cb = parsed.content_block;
              if (cb.type === "text") {
                inProgress.set(idx, { type: "text", text: "" });
              } else if (cb.type === "tool_use") {
                inProgress.set(idx, {
                  type: "tool_use",
                  id: cb.id,
                  name: cb.name,
                  inputJson: "",
                });
              }
              break;
            }

            case "content_block_delta": {
              const idx: number = parsed.index;
              const delta = parsed.delta;
              const inp = inProgress.get(idx);
              if (!inp) break;
              if (delta.type === "text_delta" && inp.type === "text") {
                inp.text += delta.text;
                send.callbacks.onTextDelta?.(delta.text);
              } else if (
                delta.type === "input_json_delta" &&
                inp.type === "tool_use"
              ) {
                inp.inputJson += delta.partial_json ?? "";
              }
              break;
            }

            case "content_block_stop": {
              const idx: number = parsed.index;
              const inp = inProgress.get(idx);
              if (!inp) break;
              if (inp.type === "text") {
                blocks.push({ type: "text", text: inp.text });
              } else {
                let parsedInput: Record<string, unknown> = {};
                try {
                  parsedInput = inp.inputJson ? JSON.parse(inp.inputJson) : {};
                } catch {
                  parsedInput = {};
                }
                const block: ToolUseBlock = {
                  type: "tool_use",
                  id: inp.id,
                  name: inp.name,
                  input: parsedInput,
                };
                blocks.push(block);
                send.callbacks.onToolUse?.(block);
              }
              inProgress.delete(idx);
              break;
            }

            case "error": {
              throw new Error(
                `Messages API stream error: ${JSON.stringify(parsed.error ?? parsed)}`,
              );
            }
          }
        }
      }

      return { role: "assistant", content: blocks };
    },
  };
}
