/**
 * Right-click enrich panel. Hosts a small live-progress UI that
 * subscribes to the backend agent loop's SSE stream and applies graph
 * mutations to the local in-memory graph as they arrive — no full
 * reload needed for a clean UX.
 *
 * Cloud-only feature: relies on the host page setting
 * `window.BACKPACK_ENRICH_ENDPOINT` (backpack-app sets it to
 * "/api/enrich/node"). When unset, the right-click menu omits the
 * "Enrich" item — there's no backend to call against.
 */

declare global {
  interface Window {
    BACKPACK_ENRICH_ENDPOINT?: string;
  }
}

export interface EnrichPanelOptions {
  /** Callback fired when the agent applies a graph mutation. The host
   * uses it to update the in-memory graph state without re-fetching. */
  onGraphChange: (change: EnrichGraphChange) => void;
  /** Callback fired once the loop ends (success or error). The host
   * uses it to refresh layout / persist if any mutations occurred. */
  onDone: (summary: EnrichDoneSummary) => void;
}

export interface EnrichGraphChange {
  tool: string;
  result: { ok: boolean; summary: string; detail?: any };
}

export interface EnrichDoneSummary {
  mutations: number;
  inputTokens: number;
  outputTokens: number;
  error?: string;
}

export interface EnrichPanel {
  start(backpack: string, nodeId: string, nodeLabel: string): Promise<void>;
  hide(): void;
  isOpen(): boolean;
}

export function createEnrichPanel(opts: EnrichPanelOptions): EnrichPanel {
  let root: HTMLElement | null = null;
  let body: HTMLElement | null = null;
  let footer: HTMLElement | null = null;
  let abortCtrl: AbortController | null = null;

  function ensureRoot() {
    if (root) return;
    root = document.createElement("div");
    root.className = "bp-enrich-panel";

    const header = document.createElement("div");
    header.className = "bp-enrich-header";
    const title = document.createElement("div");
    title.className = "bp-enrich-title";
    title.textContent = "Enrich";
    const close = document.createElement("button");
    close.className = "bp-enrich-close";
    close.setAttribute("aria-label", "Close");
    close.textContent = "×";
    close.addEventListener("click", () => hide());
    header.appendChild(title);
    header.appendChild(close);

    body = document.createElement("div");
    body.className = "bp-enrich-body";

    footer = document.createElement("div");
    footer.className = "bp-enrich-footer";
    footer.textContent = "Idle";

    root.appendChild(header);
    root.appendChild(body);
    root.appendChild(footer);
    document.body.appendChild(root);
  }

  function hide() {
    if (abortCtrl) {
      abortCtrl.abort();
      abortCtrl = null;
    }
    if (root) {
      root.remove();
      root = null;
      body = null;
      footer = null;
    }
  }

  function isOpen(): boolean {
    return root !== null;
  }

  function appendCard(kind: string, lines: string[]) {
    if (!body) return;
    const card = document.createElement("div");
    card.className = `bp-enrich-card bp-enrich-card-${kind}`;
    for (const ln of lines) {
      const row = document.createElement("div");
      row.className = "bp-enrich-row";
      row.textContent = ln;
      card.appendChild(row);
    }
    body.appendChild(card);
    body.scrollTop = body.scrollHeight;
  }

  function setFooter(text: string) {
    if (footer) footer.textContent = text;
  }

  async function start(backpack: string, nodeId: string, nodeLabel: string) {
    ensureRoot();
    if (body) body.innerHTML = "";
    if (root) {
      const titleEl = root.querySelector(".bp-enrich-title");
      if (titleEl) titleEl.textContent = `Enriching: ${nodeLabel}`;
    }
    setFooter("Connecting...");

    const endpoint = window.BACKPACK_ENRICH_ENDPOINT;
    if (!endpoint) {
      appendCard("error", ["Enrich endpoint is not configured."]);
      setFooter("Error: not configured");
      return;
    }

    abortCtrl = new AbortController();

    let res: Response;
    try {
      res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ backpack, nodeId }),
        signal: abortCtrl.signal,
      });
    } catch (err: any) {
      appendCard("error", ["Network error: " + (err?.message ?? String(err))]);
      setFooter("Failed");
      opts.onDone({ mutations: 0, inputTokens: 0, outputTokens: 0, error: String(err) });
      return;
    }

    if (!res.ok || !res.body) {
      let text = `HTTP ${res.status}`;
      try {
        const errBody = await res.text();
        try {
          const j = JSON.parse(errBody);
          if (j.error) text = String(j.error);
        } catch {
          text += `: ${errBody.slice(0, 200)}`;
        }
      } catch { /* swallow */ }
      appendCard("error", [text]);
      setFooter("Failed");
      opts.onDone({ mutations: 0, inputTokens: 0, outputTokens: 0, error: text });
      return;
    }

    setFooter("Running...");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let summary: EnrichDoneSummary = { mutations: 0, inputTokens: 0, outputTokens: 0 };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split("\n\n");
      buffer = events.pop() ?? "";
      for (const ev of events) {
        const eventLine = ev.split("\n").find((l) => l.startsWith("event: "));
        const dataLine = ev.split("\n").find((l) => l.startsWith("data: "));
        if (!eventLine || !dataLine) continue;
        const eventName = eventLine.slice(7).trim();
        const payload = dataLine.slice(6);
        let parsed: any;
        try {
          parsed = JSON.parse(payload);
        } catch {
          continue;
        }
        switch (eventName) {
          case "ready":
            appendCard("ready", [`Connected. Model: ${parsed.model ?? "?"}`]);
            break;
          case "model_text":
            if (typeof parsed.text === "string" && parsed.text.trim()) {
              appendCard("model_text", [parsed.text]);
            }
            break;
          case "tool_call":
            appendCard("tool_call", [`→ ${parsed.name}(${truncateArgs(parsed.arguments)})`]);
            break;
          case "tool_result":
            appendCard("tool_result", [
              `${parsed.result?.ok ? "ok" : "fail"}: ${parsed.result?.summary ?? ""}`.slice(0, 240),
            ]);
            break;
          case "graph_change":
            opts.onGraphChange({ tool: parsed.tool, result: parsed.result });
            break;
          case "done":
            summary = {
              mutations: parsed.mutations ?? 0,
              inputTokens: parsed.inputTokens ?? 0,
              outputTokens: parsed.outputTokens ?? 0,
            };
            setFooter(
              `Done. ${summary.mutations} change${summary.mutations === 1 ? "" : "s"} • ` +
                `${summary.inputTokens + summary.outputTokens} tokens`,
            );
            break;
          case "error":
            appendCard("error", [parsed.error ?? "Unknown error"]);
            summary.error = parsed.error;
            break;
        }
      }
    }

    abortCtrl = null;
    opts.onDone(summary);
  }

  return { start, hide, isOpen };
}

function truncateArgs(args: unknown): string {
  if (args == null) return "";
  let s: string;
  if (typeof args === "string") {
    s = args;
  } else {
    try {
      s = JSON.stringify(args);
    } catch {
      s = String(args);
    }
  }
  if (s.length > 80) s = s.slice(0, 80) + "...";
  return s;
}
