// ============================================================
// Signal card renderers.
//
// Design language: utilitarian warmth. Quiet instruments that
// reward attention. Data-dense, not decorative.
//
// Unified interface:
//   vizFor(kind) → VizRenderer
//   VizRenderer.render(signal) → HTMLElement
//
// Three primitives, composed:
//   1. Metric  — single emphasized number with label
//   2. Rows    — labeled horizontal bars or comparison rows
//   3. Grid    — small multiples (dots, cells, chips)
//
// Everything via document.createElement. CSP safe.
// ============================================================

import type { Signal } from "backpack-ontology";

const SVG_NS = "http://www.w3.org/2000/svg";

// --- Unified viz interface ---

interface VizRenderer {
  render(signal: Signal): HTMLElement;
}

const renderers: Record<string, VizRenderer> = {
  type_ratio_imbalance: {
    render(s) {
      const el = vizShell();
      // Two-column comparison: problems vs solutions
      const row = document.createElement("div");
      row.className = "sv-compare-row";

      // Extract counts from description
      const match = s.title.match(/(\d+)\s+problems?\s+vs\s+(\d+)\s+solutions?/i)
        ?? s.title.match(/(\d+)\s+problems?\s+identified/i);

      if (match) {
        const problems = parseInt(match[1]) || 0;
        const solutions = match[2] ? parseInt(match[2]) : 0;

        row.appendChild(compareBlock(String(problems), "problems", s.severity));
        const vs = document.createElement("span");
        vs.className = "sv-compare-vs";
        vs.textContent = "vs";
        row.appendChild(vs);
        row.appendChild(compareBlock(String(solutions), "solutions", "low"));
      }

      el.appendChild(row);
      el.appendChild(caption(s.description));
      return el;
    },
  },

  missing_relationships: {
    render(s) {
      const el = vizShell();
      // Two types with a broken connection between them
      const row = document.createElement("div");
      row.className = "sv-compare-row";

      const match = s.title.match(/"([^"]+)"\s+\((\d+)\)\s+and\s+"([^"]+)"\s+\((\d+)\)/);
      if (match) {
        row.appendChild(compareBlock(match[2], match[1], "medium"));
        const gap = document.createElement("span");
        gap.className = "sv-gap-indicator";
        gap.textContent = "no edges";
        row.appendChild(gap);
        row.appendChild(compareBlock(match[4], match[3], "medium"));
      }

      el.appendChild(row);
      el.appendChild(caption(s.description));
      return el;
    },
  },

  property_completeness: {
    render(s) {
      const el = vizShell();
      // Progress bar showing completion
      const match = s.title.match(/(\d+)\s+of\s+(\d+)/);
      if (match) {
        const missing = parseInt(match[1]);
        const total = parseInt(match[2]);
        const complete = total - missing;
        el.appendChild(progressBar(complete, total, s.severity));
      }
      el.appendChild(caption(s.description));
      return el;
    },
  },

  underconnected_important: {
    render(s) {
      const el = vizShell();
      // Metric: the node with its low connection count
      const row = document.createElement("div");
      row.className = "sv-metric-row";

      const gauge = ringGauge(0.15, s.severity); // low fill = underconnected
      row.appendChild(gauge);

      const text = document.createElement("div");
      text.className = "sv-metric-text";
      const label = document.createElement("div");
      label.className = "sv-metric-label";
      label.textContent = "Important node with few connections — what does it affect?";
      text.appendChild(label);
      row.appendChild(text);
      el.appendChild(row);

      return el;
    },
  },

  disconnected_island: {
    render(s) {
      const el = vizShell();
      const row = document.createElement("div");
      row.className = "sv-metric-row";
      const numEl = document.createElement("div");
      numEl.className = "sv-metric-hero";
      numEl.textContent = String(s.evidenceNodeIds.length);
      const text = document.createElement("div");
      text.className = "sv-metric-text";
      const label = document.createElement("div");
      label.className = "sv-metric-label";
      label.textContent = "nodes disconnected from the main graph";
      text.appendChild(label);
      row.appendChild(numEl);
      row.appendChild(text);
      el.appendChild(row);

      if (s.evidenceNodeIds.length > 2) {
        el.appendChild(dotGrid(s.evidenceNodeIds.length, s.severity));
      }
      return el;
    },
  },

  cross_graph_entity: {
    render(s) {
      const el = vizShell();
      const chips = document.createElement("div");
      chips.className = "sv-chip-row";
      for (const g of s.graphNames) {
        const chip = document.createElement("span");
        chip.className = "sv-chip";
        chip.textContent = g;
        chips.appendChild(chip);
      }
      el.appendChild(chips);
      if (s.graphNames.length === 2) {
        const connector = document.createElement("div");
        connector.className = "sv-connector";
        el.appendChild(connector);
      }
      return el;
    },
  },

  kb_graph_gap: {
    render(s) {
      const el = vizShell();
      // Show the unlinked doc → graph relationship
      const row = document.createElement("div");
      row.className = "sv-compare-row";

      const docBlock = document.createElement("div");
      docBlock.className = "sv-block";
      const docIcon = document.createElement("div");
      docIcon.className = "sv-block-icon";
      docIcon.textContent = "KB";
      const docLabel = document.createElement("div");
      docLabel.className = "sv-block-label";
      docLabel.textContent = s.evidenceDocIds[0]?.slice(0, 20) ?? "document";
      docBlock.appendChild(docIcon);
      docBlock.appendChild(docLabel);
      row.appendChild(docBlock);

      const gap = document.createElement("span");
      gap.className = "sv-gap-indicator";
      gap.textContent = "not linked";
      row.appendChild(gap);

      const graphBlock = document.createElement("div");
      graphBlock.className = "sv-block";
      const graphIcon = document.createElement("div");
      graphIcon.className = "sv-block-icon";
      graphIcon.textContent = "G";
      const graphLabel = document.createElement("div");
      graphLabel.className = "sv-block-label";
      graphLabel.textContent = s.graphNames[0] ?? "graph";
      graphBlock.appendChild(graphIcon);
      graphBlock.appendChild(graphLabel);
      row.appendChild(graphBlock);

      el.appendChild(row);
      el.appendChild(caption(s.description));
      return el;
    },
  },

  coverage_asymmetry: {
    render(s) {
      const el = vizShell();
      const chips = document.createElement("div");
      chips.className = "sv-chip-row";
      for (const g of s.graphNames) {
        const chip = document.createElement("span");
        chip.className = "sv-chip";
        chip.textContent = g;
        chips.appendChild(chip);
      }
      el.appendChild(chips);
      el.appendChild(caption(s.description));
      return el;
    },
  },
};

// --- Shared viz primitives ---

function vizShell(): HTMLElement {
  const el = document.createElement("div");
  el.className = "sv-shell";
  return el;
}

function ringGauge(pct: number, severity: string): HTMLElement {
  const size = 40;
  const strokeW = 4;
  const r = (size - strokeW) / 2;
  const circ = 2 * Math.PI * r;

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
  svg.setAttribute("class", "sv-ring");

  const track = document.createElementNS(SVG_NS, "circle");
  track.setAttribute("cx", String(size / 2));
  track.setAttribute("cy", String(size / 2));
  track.setAttribute("r", String(r));
  track.setAttribute("fill", "none");
  track.setAttribute("stroke-width", String(strokeW));
  track.setAttribute("class", "sv-ring-track");
  svg.appendChild(track);

  const fill = document.createElementNS(SVG_NS, "circle");
  fill.setAttribute("cx", String(size / 2));
  fill.setAttribute("cy", String(size / 2));
  fill.setAttribute("r", String(r));
  fill.setAttribute("fill", "none");
  fill.setAttribute("stroke-width", String(strokeW));
  fill.setAttribute("stroke-linecap", "round");
  fill.setAttribute("class", `sv-ring-fill sv-sev-${severity}`);
  fill.setAttribute("stroke-dasharray", String(circ));
  fill.setAttribute("stroke-dashoffset", String(circ * (1 - pct)));
  fill.setAttribute("transform", `rotate(-90 ${size / 2} ${size / 2})`);
  svg.appendChild(fill);

  return svg as unknown as HTMLElement;
}

function dotGrid(count: number, severity: string): HTMLElement {
  const grid = document.createElement("div");
  grid.className = "sv-dot-grid";
  const max = Math.min(count, 32);
  for (let i = 0; i < max; i++) {
    const dot = document.createElement("div");
    dot.className = `sv-dot sv-sev-bg-${severity}`;
    grid.appendChild(dot);
  }
  if (count > 32) {
    const more = document.createElement("span");
    more.className = "sv-dot-more";
    more.textContent = `+${count - 32}`;
    grid.appendChild(more);
  }
  return grid;
}

function compareBlock(value: string, label: string, severity: string): HTMLElement {
  const block = document.createElement("div");
  block.className = "sv-compare-block";
  const num = document.createElement("div");
  num.className = `sv-compare-num sv-sev-text-${severity}`;
  num.textContent = value;
  const lbl = document.createElement("div");
  lbl.className = "sv-compare-label";
  lbl.textContent = label;
  block.appendChild(num);
  block.appendChild(lbl);
  return block;
}

function progressBar(complete: number, total: number, severity: string): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "sv-progress";
  const track = document.createElement("div");
  track.className = "sv-progress-track";
  const fill = document.createElement("div");
  fill.className = `sv-progress-fill sv-sev-bg-${severity}`;
  const pct = total > 0 ? (complete / total) * 100 : 0;
  fill.style.width = `${pct}%`;
  track.appendChild(fill);
  wrap.appendChild(track);
  const label = document.createElement("div");
  label.className = "sv-progress-label";
  label.textContent = `${complete} of ${total} complete`;
  wrap.appendChild(label);
  return wrap;
}

function caption(text: string): HTMLElement {
  const p = document.createElement("p");
  p.className = "sv-caption";
  p.textContent = text;
  return p;
}

// --- Card shell ---

export function renderSignalCard(
  signal: Signal,
  opts: {
    onDismiss: (id: string) => void;
    onDismissPanel: () => void;
    onToggleSelect: (id: string) => void;
    isSelected: (id: string) => boolean;
  },
): HTMLElement {
  const card = document.createElement("div");
  card.className = `signal-card signal-${signal.severity}${opts.isSelected(signal.id) ? " signal-card-selected" : ""}`;
  card.dataset.signalId = signal.id;
  card.dataset.tags = (signal.tags ?? []).join(" ").toLowerCase();

  // Header
  const header = document.createElement("div");
  header.className = "signal-card-header";

  const checkbox = document.createElement("span");
  checkbox.className = `signal-card-checkbox${opts.isSelected(signal.id) ? " checked" : ""}`;
  checkbox.addEventListener("click", (e) => {
    e.stopPropagation();
    opts.onToggleSelect(signal.id);
    const nowSelected = opts.isSelected(signal.id);
    checkbox.classList.toggle("checked", nowSelected);
    card.classList.toggle("signal-card-selected", nowSelected);
  });

  const sev = document.createElement("span");
  sev.className = `sv-sev-dot sv-sev-bg-${signal.severity}`;

  const title = document.createElement("span");
  title.className = "signal-card-title";
  title.textContent = signal.title;

  const dismiss = document.createElement("button");
  dismiss.className = "signal-dismiss-btn";
  dismiss.type = "button";
  dismiss.title = "Dismiss";
  dismiss.textContent = "\u00D7";
  dismiss.addEventListener("click", (e) => {
    e.stopPropagation();
    opts.onDismiss(signal.id);
    card.classList.add("signal-card-dismissed");
    setTimeout(() => card.remove(), 200);
  });

  header.appendChild(checkbox);
  header.appendChild(sev);
  header.appendChild(title);
  header.appendChild(dismiss);
  card.appendChild(header);

  // Kind + graph meta
  const meta = document.createElement("div");
  meta.className = "signal-card-meta";
  meta.textContent = `${signal.kind.replace(/_/g, " ")} · ${signal.graphNames.join(", ")}`;
  card.appendChild(meta);

  // Visualization
  const renderer = renderers[signal.kind];
  if (renderer) {
    card.appendChild(renderer.render(signal));
  }

  // Tags
  if (signal.tags && signal.tags.length > 0) {
    const tagsEl = document.createElement("div");
    tagsEl.className = "signal-card-tags";
    for (const tag of signal.tags.slice(0, 5)) {
      const t = document.createElement("span");
      t.className = "sv-tag";
      t.textContent = tag;
      tagsEl.appendChild(t);
    }
    card.appendChild(tagsEl);
  }

  // Footer
  if (signal.evidenceNodeIds.length > 0 && signal.graphNames.length > 0) {
    const footer = document.createElement("div");
    footer.className = "signal-card-footer";
    const viewBtn = document.createElement("button");
    viewBtn.className = "signal-view-btn";
    viewBtn.type = "button";
    const graphLabel = signal.graphNames.length === 1 ? signal.graphNames[0] : `${signal.graphNames.length} graphs`;
    viewBtn.textContent = `View in ${graphLabel}`;
    viewBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      const graph = signal.graphNames[0];
      const nodeParam = signal.evidenceNodeIds.slice(0, 20).join(",");
      window.location.hash = `${graph}?node=${nodeParam}`;
      opts.onDismissPanel();
    });
    footer.appendChild(viewBtn);
    card.appendChild(footer);
  }

  return card;
}
