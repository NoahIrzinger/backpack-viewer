import type {
  LLMProvider,
  ProviderSendOptions,
  ChatMessage,
  ContentBlock,
  ToolUseBlock,
  ExtensionFetch,
} from "./types.js";

const DEFAULT_MODEL = "claude-sonnet-4-5";
const MAX_TOKENS = 4096;

/**
 * Anthropic Messages API provider.
 *
 * Uses `viewer.fetch()` (passed in as `extFetch`) to call
 * `https://api.anthropic.com/v1/messages` through the per-extension
 * server-side proxy. The chat extension's manifest declares
 * api.anthropic.com in `permissions.network` and configures
 * x-api-key/anthropic-version header injection. The browser never
 * touches the API key.
 *
 * Streams the SSE response and parses Anthropic's content_block_*
 * event types. Multi-turn tool use is driven by the panel — this
 * provider just handles one request/response cycle.
 */
export function createAnthropicProvider(extFetch: ExtensionFetch): LLMProvider {
  return {
    id: "anthropic",
    displayName: "Anthropic Claude",
    defaultModel: DEFAULT_MODEL,

    async send(opts: ProviderSendOptions): Promise<ChatMessage> {
      const body: Record<string, unknown> = {
        model: opts.model ?? DEFAULT_MODEL,
        max_tokens: MAX_TOKENS,
        stream: true,
        messages: opts.messages,
      };
      if (opts.system) body.system = opts.system;
      if (opts.tools.length > 0) body.tools = opts.tools;

      const res = await extFetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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
                opts.callbacks.onTextDelta?.(delta.text);
              } else if (delta.type === "input_json_delta" && inp.type === "tool_use") {
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
                opts.callbacks.onToolUse?.(block);
              }
              inProgress.delete(idx);
              break;
            }

            case "error": {
              throw new Error(
                `Anthropic stream error: ${JSON.stringify(parsed.error ?? parsed)}`,
              );
            }
          }
        }
      }

      return { role: "assistant", content: blocks };
    },
  };
}
