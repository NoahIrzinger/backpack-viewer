/**
 * LLM provider abstraction. The chat extension is provider-agnostic at
 * the panel + tool-loop level — providers implement this interface and
 * the panel calls into them via a stable surface.
 *
 * Currently shipped: anthropic. Future: openai, ollama, others. Each
 * lives in its own file under extensions/chat/src/providers/.
 *
 * The interface is intentionally narrow:
 *   - One async streaming call per turn
 *   - Provider returns the assembled assistant message (text blocks
 *     and tool-use blocks) at the end
 *   - Caller (panel) drives the tool-use loop
 */

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
  };
}

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

export interface ChatMessage {
  role: "user" | "assistant";
  content: ContentBlock[];
}

export interface StreamCallbacks {
  /** Fired for each text token as it streams in. */
  onTextDelta?: (delta: string) => void;
  /** Fired once a tool_use block is fully assembled. */
  onToolUse?: (block: ToolUseBlock) => void;
}

export interface ProviderSendOptions {
  /** Conversation history (everything before this turn). */
  messages: ChatMessage[];
  /** Optional system prompt. */
  system?: string;
  /** Tool definitions handed to the model. */
  tools: ToolDefinition[];
  /** Streaming callbacks for in-flight rendering. */
  callbacks: StreamCallbacks;
  /** Model id (provider-specific string). */
  model?: string;
}

/**
 * One LLM provider. The chat panel picks one based on user settings
 * (default: anthropic) and calls `send()` per turn.
 */
export interface LLMProvider {
  /** Provider id, used in settings. */
  readonly id: string;
  /** Human-readable name. */
  readonly displayName: string;
  /** Default model for this provider. */
  readonly defaultModel: string;
  /**
   * Send a single turn to the LLM. Streams text + tool_use through
   * callbacks. Returns the assembled assistant message at the end.
   * Throws on transport / API errors with a human-readable message.
   */
  send(opts: ProviderSendOptions): Promise<ChatMessage>;
}

/**
 * The viewer's `viewer.fetch()` is the only way for an extension to
 * make outbound network calls — it goes through the per-extension
 * server-side proxy and respects the manifest's network allowlist.
 * Providers receive this as a constructor dependency so they don't
 * need to know how the proxy works.
 */
export type ExtensionFetch = (url: string, init?: RequestInit) => Promise<Response>;
