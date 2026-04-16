// ============================================================
// Signals panel — the third tab.
//
// Opens as an extension panel (like KB panel). Shows a scrollable
// report of signal cards, grouped by severity. Each card renders
// with type-driven visuals.
// ============================================================

import type { Signal, SignalResult } from "backpack-ontology";
import type { PanelMount } from "./extensions/panel-mount";
import { listSignals, dismissSignal, detectSignals } from "./api";
import { renderSignalCard } from "./signal-renderers";

export function initSignalsPanel(panelMount: PanelMount) {
  const bodyEl = document.createElement("div");
  bodyEl.className = "signals-panel-content";

  const handle = panelMount.mount("signals-report", bodyEl, {
    title: "Signals",
    persistKey: "signals-panel",
    hideOnClose: true,
  });
  handle.setVisible(false);

  let onDismissPanel: (() => void) | null = null;
  let onSelectionChange: ((ids: string[]) => void) | null = null;
  const selectedIds = new Set<string>();

  function toggleSelect(id: string) {
    if (selectedIds.has(id)) {
      selectedIds.delete(id);
    } else {
      selectedIds.add(id);
    }
    onSelectionChange?.([...selectedIds]);
  }

  function isSelected(id: string): boolean {
    return selectedIds.has(id);
  }

  function renderReport(result: SignalResult) {
    bodyEl.replaceChildren();

    if (result.signals.length === 0) {
      const empty = document.createElement("div");
      empty.className = "signals-empty-state";

      if (result.computedAt) {
        empty.textContent = `No active signals. ${result.dismissed} dismissed. Last scan: ${result.computedAt.slice(0, 16).replace("T", " ")}`;
      } else {
        empty.textContent = "No signals detected yet. Use backpack_signal_detect via MCP to scan the backpack.";
      }

      const detectBtn = document.createElement("button");
      detectBtn.className = "signals-detect-btn";
      detectBtn.type = "button";
      detectBtn.textContent = "Detect signals now";
      detectBtn.addEventListener("click", async () => {
        detectBtn.disabled = true;
        detectBtn.textContent = "Detecting…";
        try {
          const fresh = await detectSignals();
          renderReport(fresh);
        } catch {
          detectBtn.textContent = "Detection failed — retry";
          detectBtn.disabled = false;
        }
      });
      empty.appendChild(detectBtn);
      bodyEl.appendChild(empty);
      return;
    }

    // Header with counts
    const header = document.createElement("div");
    header.className = "signals-report-header";

    const counts: Record<string, number> = {};
    for (const s of result.signals) counts[s.severity] = (counts[s.severity] ?? 0) + 1;

    const countText = document.createElement("span");
    countText.className = "signals-count-text";
    const parts: string[] = [];
    for (const sev of ["critical", "high", "medium", "low"]) {
      if (counts[sev]) parts.push(`${counts[sev]} ${sev}`);
    }
    countText.textContent = `${result.signals.length} signal${result.signals.length > 1 ? "s" : ""}: ${parts.join(", ")}`;
    header.appendChild(countText);

    // Refresh button
    const refreshBtn = document.createElement("button");
    refreshBtn.className = "signals-refresh-btn";
    refreshBtn.type = "button";
    refreshBtn.textContent = "\u21BB"; // ↻
    refreshBtn.title = "Re-detect signals";
    refreshBtn.addEventListener("click", async () => {
      refreshBtn.disabled = true;
      try {
        const fresh = await detectSignals();
        renderReport(fresh);
      } catch {
        refreshBtn.disabled = false;
      }
    });
    header.appendChild(refreshBtn);

    bodyEl.appendChild(header);

    // Cards grouped by severity
    const severityOrder = ["critical", "high", "medium", "low"];
    for (const sev of severityOrder) {
      const group = result.signals.filter((s) => s.severity === sev);
      if (group.length === 0) continue;

      const section = document.createElement("div");
      section.className = `signals-severity-group signals-group-${sev}`;

      const sectionLabel = document.createElement("div");
      sectionLabel.className = "signals-group-label";
      sectionLabel.textContent = `${sev.toUpperCase()} (${group.length})`;
      section.appendChild(sectionLabel);

      const grid = document.createElement("div");
      grid.className = "signals-card-grid";

      for (const signal of group) {
        const card = renderSignalCard(signal, {
          onDismiss: async (id) => {
            await dismissSignal(id);
            selectedIds.delete(id);
            onSelectionChange?.([...selectedIds]);
          },
          onDismissPanel: () => {
            handle.setVisible(false);
            onDismissPanel?.();
          },
          onToggleSelect: (id) => {
            toggleSelect(id);
          },
          isSelected,
        });
        grid.appendChild(card);
      }

      section.appendChild(grid);
      bodyEl.appendChild(section);
    }

    // Dismissed count
    if (result.dismissed > 0) {
      const dismissedNote = document.createElement("div");
      dismissedNote.className = "signals-dismissed-note";
      dismissedNote.textContent = `${result.dismissed} signal${result.dismissed > 1 ? "s" : ""} dismissed`;
      bodyEl.appendChild(dismissedNote);
    }
  }

  let lastResult: SignalResult | null = null;

  function filterCards(query: string) {
    const cards = bodyEl.querySelectorAll(".signal-card");
    const q = query.toLowerCase();
    for (const card of cards) {
      const el = card as HTMLElement;
      if (!q) {
        el.classList.remove("hidden");
        continue;
      }
      const text = (el.textContent ?? "").toLowerCase();
      const tags = el.dataset.tags ?? "";
      el.classList.toggle("hidden", !text.includes(q) && !tags.includes(q));
    }
    // Hide severity groups where all cards are hidden
    const groups = bodyEl.querySelectorAll(".signals-severity-group");
    for (const group of groups) {
      const visibleCards = group.querySelectorAll(".signal-card:not(.hidden)");
      (group as HTMLElement).classList.toggle("hidden", visibleCards.length === 0);
    }
  }

  return {
    async show() {
      const result = await listSignals();
      lastResult = result;
      renderReport(result);
      handle.setVisible(true);
    },
    hide() {
      handle.setVisible(false);
    },
    setDismissHandler(handler: () => void) {
      onDismissPanel = handler;
    },
    setSelectionChangeHandler(handler: (ids: string[]) => void) {
      onSelectionChange = handler;
    },
    setSelected(id: string, selected: boolean) {
      if (selected) selectedIds.add(id); else selectedIds.delete(id);
      // Update card visuals
      const card = bodyEl.querySelector(`[data-signal-id="${CSS.escape(id)}"]`) as HTMLElement | null;
      if (card) {
        card.classList.toggle("signal-card-selected", selected);
        const cb = card.querySelector(".signal-card-checkbox") as HTMLElement | null;
        if (cb) cb.classList.toggle("checked", selected);
      }
    },
    clearSelection() {
      selectedIds.clear();
      for (const card of bodyEl.querySelectorAll(".signal-card-selected")) {
        card.classList.remove("signal-card-selected");
        const cb = card.querySelector(".signal-card-checkbox") as HTMLElement | null;
        if (cb) cb.classList.remove("checked");
      }
    },
    filter(query: string) {
      filterCards(query);
    },
    async refresh() {
      const result = await listSignals();
      lastResult = result;
      renderReport(result);
    },
    getSignals: async () => {
      if (!lastResult) lastResult = await listSignals();
      return lastResult.signals;
    },
  };
}
