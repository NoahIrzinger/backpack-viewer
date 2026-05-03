import type { ViewerExtensionAPI } from "./viewer-api";
import type {
  LLMProvider,
  ChatMessage,
  ToolUseBlock,
  ToolResultBlock,
  ContentBlock,
} from "./providers/types.js";
import { TOOLS, executeTool } from "./tools.js";

const MAX_TOOL_LOOP_ITERATIONS = 12;
const HISTORY_SETTINGS_KEY = "history";
/** Cap on persisted history to keep the settings file sane. */
const MAX_PERSISTED_MESSAGES = 200;

const SYSTEM_PROMPT = `You are an assistant embedded in the Backpack viewer, helping the user explore and edit a learning graph that they are looking at right now.

You have tools to read and manipulate the graph the user is currently viewing. When you call tools that change the visible state of the viewer (focus_nodes, pan_to_node), the user will see the change happen live.

Be concise. When the user asks about the graph, prefer using tools to ground your answer in real data instead of guessing. When you make changes that mutate the graph, briefly confirm what you did. Destructive actions (remove_node, remove_edge) should usually be confirmed with the user first unless the request is unambiguous.`;

interface PanelHandles {
  body: HTMLElement;
  messageList: HTMLElement;
  input: HTMLTextAreaElement;
  sendBtn: HTMLButtonElement;
}

/**
 * Build and mount the chat panel into the viewer. Returns a controller
 * with show/hide/toggle methods so the taskbar icon can flip visibility.
 *
 * The panel is created lazily on first show — until the user clicks
 * the icon, no DOM is added to the page. Once mounted, the panel stays
 * mounted and toggles visibility via close()/re-mount.
 */
export function createChatPanelController(
  viewer: ViewerExtensionAPI,
  provider: LLMProvider,
) {
  let mounted: { handle: { close(): void }; els: PanelHandles } | null = null;

  function buildBody(): { body: HTMLElement; els: PanelHandles } {
    const body = document.createElement("div");
    body.className = "chat-ext-body";

    const messageList = document.createElement("div");
    messageList.className = "chat-ext-messages";
    renderIntro(messageList);

    body.appendChild(messageList);

    const inputRow = document.createElement("div");
    inputRow.className = "chat-ext-input-row";

    const input = document.createElement("textarea");
    input.className = "chat-ext-input";
    input.placeholder = "Ask about this graph…";
    input.rows = 2;
    inputRow.appendChild(input);

    const sendBtn = document.createElement("button");
    sendBtn.className = "chat-ext-send";
    sendBtn.textContent = "Send";
    inputRow.appendChild(sendBtn);

    body.appendChild(inputRow);

    return { body, els: { body, messageList, input, sendBtn } };
  }

  let messages: ChatMessage[] = [];
  let busy = false;
  let persistTimer: number | null = null;

  function setBusy(b: boolean) {
    busy = b;
    if (mounted) {
      mounted.els.sendBtn.disabled = b;
      mounted.els.input.disabled = b;
    }
  }

  /**
   * Debounced write of the current message history to per-extension
   * settings. Backpack-viewer's settings backend writes to
   * `~/.config/backpack/extensions/chat/settings.json` atomically.
   * Errors are logged but don't interrupt the conversation.
   */
  function schedulePersist() {
    if (persistTimer !== null) {
      window.clearTimeout(persistTimer);
    }
    persistTimer = window.setTimeout(() => {
      persistTimer = null;
      // Cap the history to MAX_PERSISTED_MESSAGES — drop oldest first.
      const trimmed =
        messages.length > MAX_PERSISTED_MESSAGES
          ? messages.slice(-MAX_PERSISTED_MESSAGES)
          : messages;
      viewer.settings
        .set(HISTORY_SETTINGS_KEY, trimmed)
        .catch((err) => console.warn("[chat] failed to persist history:", err));
    }, 300);
  }

  async function loadHistory() {
    try {
      const stored = await viewer.settings.get<ChatMessage[]>(HISTORY_SETTINGS_KEY);
      if (Array.isArray(stored) && stored.length > 0) {
        messages = stored;
        // If the panel is already mounted (rare — loadHistory is called
        // at activate time before any user interaction), replay into it.
        if (mounted) {
          mounted.els.messageList.replaceChildren();
          renderIntro(mounted.els.messageList);
          for (const msg of messages) {
            renderMessage(mounted.els.messageList, msg.role, msg.content);
          }
        }
      }
    } catch (err) {
      console.warn("[chat] failed to load history:", err);
    }
  }

  function appendUserMessage(text: string) {
    messages.push({ role: "user", content: [{ type: "text", text }] });
    if (mounted) renderMessage(mounted.els.messageList, "user", [{ type: "text", text }]);
    schedulePersist();
  }

  async function sendMessage() {
    if (!mounted) return;
    const els = mounted.els;
    const text = els.input.value.trim();
    if (!text || busy) return;

    els.input.value = "";
    appendUserMessage(text);
    setBusy(true);

    let activeAssistant: { textEl: HTMLElement } | null = null;

    function ensureAssistantRow(): { textEl: HTMLElement } {
      if (!mounted) throw new Error("panel unmounted mid-stream");
      if (activeAssistant) return activeAssistant;
      const { textEl } = createMessageRow(mounted.els.messageList, "assistant");
      mounted.els.messageList.scrollTop = mounted.els.messageList.scrollHeight;
      activeAssistant = { textEl };
      return activeAssistant;
    }

    try {
      let iter = 0;
      while (iter < MAX_TOOL_LOOP_ITERATIONS) {
        iter++;
        const assistantMsg: ChatMessage = await provider.send({
          system: SYSTEM_PROMPT,
          messages,
          tools: TOOLS,
          callbacks: {
            onTextDelta(delta) {
              const a = ensureAssistantRow();
              a.textEl.textContent = (a.textEl.textContent ?? "") + delta;
              if (mounted) {
                mounted.els.messageList.scrollTop = mounted.els.messageList.scrollHeight;
              }
            },
            onToolUse(block) {
              if (!mounted) return;
              const node = document.createElement("div");
              node.className = "chat-ext-tool-call";
              node.textContent = `→ ${block.name}(${truncateInput(block.input)})`;
              mounted.els.messageList.appendChild(node);
              mounted.els.messageList.scrollTop = mounted.els.messageList.scrollHeight;
            },
          },
        });

        messages.push(assistantMsg);
        schedulePersist();

        const toolUses = assistantMsg.content.filter(
          (b): b is ToolUseBlock => b.type === "tool_use",
        );
        if (toolUses.length === 0) break;

        const results: ToolResultBlock[] = [];
        for (const tu of toolUses) {
          try {
            const out = await executeTool(viewer, tu.name, tu.input);
            results.push({
              type: "tool_result",
              tool_use_id: tu.id,
              content: out,
            });
            if (mounted) {
              const node = document.createElement("div");
              node.className = "chat-ext-tool-result";
              node.textContent = `← ${truncate(out, 200)}`;
              mounted.els.messageList.appendChild(node);
            }
          } catch (err) {
            results.push({
              type: "tool_result",
              tool_use_id: tu.id,
              content: `Error: ${(err as Error).message}`,
              is_error: true,
            });
            if (mounted) {
              const node = document.createElement("div");
              node.className = "chat-ext-tool-result chat-ext-tool-error";
              node.textContent = `← Error: ${(err as Error).message}`;
              mounted.els.messageList.appendChild(node);
            }
          }
        }
        messages.push({ role: "user", content: results });
        schedulePersist();
        activeAssistant = null;
        if (mounted) {
          mounted.els.messageList.scrollTop = mounted.els.messageList.scrollHeight;
        }
      }

      if (iter >= MAX_TOOL_LOOP_ITERATIONS && mounted) {
        const node = document.createElement("div");
        node.className = "chat-ext-tool-error";
        node.textContent = `Tool loop hit max iterations (${MAX_TOOL_LOOP_ITERATIONS}) — stopping.`;
        mounted.els.messageList.appendChild(node);
      }
    } catch (err) {
      if (mounted) {
        const node = document.createElement("div");
        node.className = "chat-ext-tool-error";
        node.textContent = `Error: ${(err as Error).message}`;
        mounted.els.messageList.appendChild(node);
      }
    } finally {
      setBusy(false);
      if (mounted) mounted.els.input.focus();
    }
  }

  function show() {
    if (mounted) return;
    const { body, els } = buildBody();
    const handle = viewer.mountPanel(body, {
      title: "Ask Claude",
      // The chat panel adds one custom header button: "Clear" which
      // wipes the in-memory message history. Sits to the left of the
      // built-in fullscreen + close controls.
      headerButtons: [
        {
          label: "Clear",
          onClick: () => {
            messages = [];
            // Wipe the panel UI too — replace its message list with a
            // fresh intro card.
            if (mounted) {
              mounted.els.messageList.replaceChildren();
              renderIntro(mounted.els.messageList);
            }
            // Drop persisted history
            viewer.settings.remove(HISTORY_SETTINGS_KEY).catch(() => {});
          },
        },
      ],
      // The panel mount calls this when the user clicks the X button
      // OR when our hide() calls handle.close() — either way the
      // controller's mounted ref needs to be cleared so the next
      // show() call rebuilds fresh.
      onClose: () => {
        mounted = null;
      },
    });
    mounted = { handle, els };

    // Replay existing message history into the freshly-mounted panel
    // so closing+reopening doesn't lose the conversation.
    for (const msg of messages) {
      renderMessage(els.messageList, msg.role, msg.content);
    }

    els.sendBtn.addEventListener("click", sendMessage);
    els.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });
    setTimeout(() => els.input.focus(), 50);
  }

  function hide() {
    if (!mounted) return;
    mounted.handle.close();
    mounted = null;
  }

  function toggle() {
    if (mounted) hide();
    else show();
  }

  return { show, hide, toggle, loadHistory };
}

function renderIntro(messageList: HTMLElement) {
  const intro = document.createElement("div");
  intro.className = "chat-ext-intro";
  intro.textContent =
    "Ask questions about the graph you're looking at, or tell me to add/edit nodes. Embedded in backpack-app the model runs on the SaaS backend; standalone OSS reads ANTHROPIC_API_KEY from the env it was started with. Either way the key never enters the browser.";
  messageList.appendChild(intro);
}

function renderMessage(
  list: HTMLElement,
  role: "user" | "assistant",
  content: ContentBlock[],
) {
  const { textEl } = createMessageRow(list, role);
  for (const block of content) {
    if (block.type === "text") {
      textEl.textContent = (textEl.textContent ?? "") + block.text;
    }
  }
  list.scrollTop = list.scrollHeight;
}

function createMessageRow(
  list: HTMLElement,
  role: "user" | "assistant",
): { row: HTMLElement; textEl: HTMLElement } {
  const row = document.createElement("div");
  row.className = `chat-ext-msg chat-ext-msg-${role}`;
  const textEl = document.createElement("div");
  textEl.className = "chat-ext-msg-text";
  row.appendChild(textEl);
  list.appendChild(row);
  return { row, textEl };
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n) + "…";
}

function truncateInput(input: Record<string, unknown>): string {
  const json = JSON.stringify(input);
  return truncate(json, 80);
}
