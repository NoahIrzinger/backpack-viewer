import type { LearningGraphData, Node } from "backpack-ontology";
import { getColor } from "./colors";

interface ToolsPaneCallbacks {
  onFilterByType: (type: string | null) => void;
  onNavigateToNode: (nodeId: string) => void;
  onRenameNodeType: (oldType: string, newType: string) => void;
  onRenameEdgeType: (oldType: string, newType: string) => void;
  onToggleEdgeLabels: (visible: boolean) => void;
  onToggleTypeHulls: (visible: boolean) => void;
  onToggleMinimap: (visible: boolean) => void;
  onLayoutChange: (param: string, value: number) => void;
  onExport: (format: "png" | "svg") => void;
  onOpen?: () => void;
}

interface DerivedStats {
  nodeCount: number;
  edgeCount: number;
  types: { name: string; count: number }[];
  edgeTypes: { name: string; count: number }[];
  orphans: { id: string; label: string; type: string }[];
  singletons: { name: string }[]; // types with only 1 node
  emptyNodes: { id: string; label: string; type: string }[]; // nodes with no properties beyond the label
  mostConnected: { id: string; label: string; type: string; connections: number }[];
}

export function initToolsPane(
  container: HTMLElement,
  callbacks: ToolsPaneCallbacks
) {
  let data: LearningGraphData | null = null;
  let stats: DerivedStats | null = null;
  let collapsed = true;
  let activeTypeFilter: string | null = null;
  let edgeLabelsVisible = true;
  let typeHullsVisible = true;
  let minimapVisible = true;

  // --- DOM ---

  const toggle = document.createElement("button");
  toggle.className = "tools-pane-toggle hidden";
  toggle.title = "Graph Inspector";
  toggle.innerHTML =
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16"/><path d="M4 12h16"/><path d="M4 17h10"/></svg>';

  const content = document.createElement("div");
  content.className = "tools-pane-content hidden";

  container.appendChild(toggle);
  container.appendChild(content);

  toggle.addEventListener("click", () => {
    collapsed = !collapsed;
    content.classList.toggle("hidden", collapsed);
    toggle.classList.toggle("active", !collapsed);
    if (!collapsed) callbacks.onOpen?.();
  });

  // --- Render ---

  function render() {
    content.innerHTML = "";
    if (!stats) return;

    // Graph stats summary
    const summary = document.createElement("div");
    summary.className = "tools-pane-summary";
    summary.innerHTML =
      `<span>${stats.nodeCount} nodes</span><span class="tools-pane-sep">&middot;</span>` +
      `<span>${stats.edgeCount} edges</span><span class="tools-pane-sep">&middot;</span>` +
      `<span>${stats.types.length} types</span>`;
    content.appendChild(summary);

    // Node types — click to filter, double-click to rename
    if (stats.types.length) {
      content.appendChild(makeSection("Node Types", (section) => {
        for (const t of stats!.types) {
          const row = document.createElement("div");
          row.className = "tools-pane-row tools-pane-clickable";
          if (activeTypeFilter === t.name) row.classList.add("active");

          const dot = document.createElement("span");
          dot.className = "tools-pane-dot";
          dot.style.backgroundColor = getColor(t.name);

          const name = document.createElement("span");
          name.className = "tools-pane-name";
          name.textContent = t.name;

          const count = document.createElement("span");
          count.className = "tools-pane-count";
          count.textContent = String(t.count);

          const editBtn = document.createElement("button");
          editBtn.className = "tools-pane-edit";
          editBtn.textContent = "\u270E";
          editBtn.title = `Rename all ${t.name} nodes`;

          row.appendChild(dot);
          row.appendChild(name);
          row.appendChild(count);
          row.appendChild(editBtn);

          row.addEventListener("click", (e) => {
            if ((e.target as HTMLElement).closest(".tools-pane-edit")) return;
            if (activeTypeFilter === t.name) {
              activeTypeFilter = null;
              callbacks.onFilterByType(null);
            } else {
              activeTypeFilter = t.name;
              callbacks.onFilterByType(t.name);
            }
            render();
          });

          editBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            startInlineEdit(row, t.name, (newName) => {
              if (newName && newName !== t.name) {
                callbacks.onRenameNodeType(t.name, newName);
              }
            });
          });

          section.appendChild(row);
        }
      }));
    }

    // Edge types — with rename
    if (stats.edgeTypes.length) {
      content.appendChild(makeSection("Edge Types", (section) => {
        for (const t of stats!.edgeTypes) {
          const row = document.createElement("div");
          row.className = "tools-pane-row tools-pane-clickable";

          const name = document.createElement("span");
          name.className = "tools-pane-name";
          name.textContent = t.name;

          const count = document.createElement("span");
          count.className = "tools-pane-count";
          count.textContent = String(t.count);

          const editBtn = document.createElement("button");
          editBtn.className = "tools-pane-edit";
          editBtn.textContent = "\u270E";
          editBtn.title = `Rename all ${t.name} edges`;

          row.appendChild(name);
          row.appendChild(count);
          row.appendChild(editBtn);

          editBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            startInlineEdit(row, t.name, (newName) => {
              if (newName && newName !== t.name) {
                callbacks.onRenameEdgeType(t.name, newName);
              }
            });
          });

          section.appendChild(row);
        }
      }));
    }

    // Most connected nodes — click to navigate
    if (stats.mostConnected.length) {
      content.appendChild(makeSection("Most Connected", (section) => {
        for (const n of stats!.mostConnected) {
          const row = document.createElement("div");
          row.className = "tools-pane-row tools-pane-clickable";

          const dot = document.createElement("span");
          dot.className = "tools-pane-dot";
          dot.style.backgroundColor = getColor(n.type);

          const name = document.createElement("span");
          name.className = "tools-pane-name";
          name.textContent = n.label;

          const count = document.createElement("span");
          count.className = "tools-pane-count";
          count.textContent = `${n.connections}`;

          row.appendChild(dot);
          row.appendChild(name);
          row.appendChild(count);

          row.addEventListener("click", () => {
            callbacks.onNavigateToNode(n.id);
          });

          section.appendChild(row);
        }
      }));
    }

    // Quality issues
    const issues: string[] = [];
    if (stats.orphans.length) issues.push(`${stats.orphans.length} orphan${stats.orphans.length > 1 ? "s" : ""}`);
    if (stats.singletons.length) issues.push(`${stats.singletons.length} singleton type${stats.singletons.length > 1 ? "s" : ""}`);
    if (stats.emptyNodes.length) issues.push(`${stats.emptyNodes.length} empty node${stats.emptyNodes.length > 1 ? "s" : ""}`);

    if (issues.length) {
      content.appendChild(makeSection("Quality", (section) => {
        // Orphans — click to navigate
        for (const o of stats!.orphans.slice(0, 5)) {
          const row = document.createElement("div");
          row.className = "tools-pane-row tools-pane-clickable tools-pane-issue";

          const dot = document.createElement("span");
          dot.className = "tools-pane-dot";
          dot.style.backgroundColor = getColor(o.type);

          const name = document.createElement("span");
          name.className = "tools-pane-name";
          name.textContent = o.label;

          const badge = document.createElement("span");
          badge.className = "tools-pane-badge";
          badge.textContent = "orphan";

          row.appendChild(dot);
          row.appendChild(name);
          row.appendChild(badge);

          row.addEventListener("click", () => {
            callbacks.onNavigateToNode(o.id);
          });

          section.appendChild(row);
        }

        if (stats!.orphans.length > 5) {
          const more = document.createElement("div");
          more.className = "tools-pane-more";
          more.textContent = `+ ${stats!.orphans.length - 5} more orphans`;
          section.appendChild(more);
        }

        // Singleton types
        for (const s of stats!.singletons.slice(0, 5)) {
          const row = document.createElement("div");
          row.className = "tools-pane-row tools-pane-issue";

          const dot = document.createElement("span");
          dot.className = "tools-pane-dot";
          dot.style.backgroundColor = getColor(s.name);

          const name = document.createElement("span");
          name.className = "tools-pane-name";
          name.textContent = s.name;

          const badge = document.createElement("span");
          badge.className = "tools-pane-badge";
          badge.textContent = "1 node";

          row.appendChild(dot);
          row.appendChild(name);
          row.appendChild(badge);
          section.appendChild(row);
        }
      }));
    }

    // Controls section
    content.appendChild(makeSection("Controls", (section) => {
      // Edge labels toggle
      const labelRow = document.createElement("div");
      labelRow.className = "tools-pane-row tools-pane-clickable";

      const labelCheck = document.createElement("input");
      labelCheck.type = "checkbox";
      labelCheck.checked = edgeLabelsVisible;
      labelCheck.className = "tools-pane-checkbox";

      const labelText = document.createElement("span");
      labelText.className = "tools-pane-name";
      labelText.textContent = "Edge labels";

      labelRow.appendChild(labelCheck);
      labelRow.appendChild(labelText);

      labelRow.addEventListener("click", (e) => {
        if (e.target !== labelCheck) labelCheck.checked = !labelCheck.checked;
        edgeLabelsVisible = labelCheck.checked;
        callbacks.onToggleEdgeLabels(edgeLabelsVisible);
      });

      section.appendChild(labelRow);

      // Type hulls toggle
      const hullRow = document.createElement("div");
      hullRow.className = "tools-pane-row tools-pane-clickable";

      const hullCheck = document.createElement("input");
      hullCheck.type = "checkbox";
      hullCheck.checked = typeHullsVisible;
      hullCheck.className = "tools-pane-checkbox";

      const hullText = document.createElement("span");
      hullText.className = "tools-pane-name";
      hullText.textContent = "Type regions";

      hullRow.appendChild(hullCheck);
      hullRow.appendChild(hullText);

      hullRow.addEventListener("click", (e) => {
        if (e.target !== hullCheck) hullCheck.checked = !hullCheck.checked;
        typeHullsVisible = hullCheck.checked;
        callbacks.onToggleTypeHulls(typeHullsVisible);
      });

      section.appendChild(hullRow);

      // Minimap toggle
      const mapRow = document.createElement("div");
      mapRow.className = "tools-pane-row tools-pane-clickable";

      const mapCheck = document.createElement("input");
      mapCheck.type = "checkbox";
      mapCheck.checked = minimapVisible;
      mapCheck.className = "tools-pane-checkbox";

      const mapText = document.createElement("span");
      mapText.className = "tools-pane-name";
      mapText.textContent = "Minimap";

      mapRow.appendChild(mapCheck);
      mapRow.appendChild(mapText);

      mapRow.addEventListener("click", (e) => {
        if (e.target !== mapCheck) mapCheck.checked = !mapCheck.checked;
        minimapVisible = mapCheck.checked;
        callbacks.onToggleMinimap(minimapVisible);
      });

      section.appendChild(mapRow);

      // Layout sliders
      section.appendChild(makeSlider("Clustering", 0, 0.15, 0.01, 0.05, (v) => {
        callbacks.onLayoutChange("clusterStrength", v);
      }));
      section.appendChild(makeSlider("Spacing", 0.5, 3, 0.1, 1, (v) => {
        callbacks.onLayoutChange("spacing", v);
      }));

      // Export buttons
      const exportRow = document.createElement("div");
      exportRow.className = "tools-pane-export-row";

      const pngBtn = document.createElement("button");
      pngBtn.className = "tools-pane-export-btn";
      pngBtn.textContent = "Export PNG";
      pngBtn.addEventListener("click", () => callbacks.onExport("png"));

      const svgBtn = document.createElement("button");
      svgBtn.className = "tools-pane-export-btn";
      svgBtn.textContent = "Export SVG";
      svgBtn.addEventListener("click", () => callbacks.onExport("svg"));

      exportRow.appendChild(pngBtn);
      exportRow.appendChild(svgBtn);
      section.appendChild(exportRow);
    }));
  }

  function makeSlider(
    label: string, min: number, max: number, step: number, initial: number,
    onChange: (value: number) => void
  ): HTMLElement {
    const row = document.createElement("div");
    row.className = "tools-pane-slider-row";

    const lbl = document.createElement("span");
    lbl.className = "tools-pane-slider-label";
    lbl.textContent = label;

    const input = document.createElement("input");
    input.type = "range";
    input.className = "tools-pane-slider";
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(initial);

    const val = document.createElement("span");
    val.className = "tools-pane-slider-value";
    val.textContent = String(initial);

    input.addEventListener("input", () => {
      const v = parseFloat(input.value);
      val.textContent = v % 1 === 0 ? String(v) : v.toFixed(2);
      onChange(v);
    });

    row.appendChild(lbl);
    row.appendChild(input);
    row.appendChild(val);
    return row;
  }

  function makeSection(title: string, build: (el: HTMLElement) => void): HTMLElement {
    const section = document.createElement("div");
    section.className = "tools-pane-section";

    const heading = document.createElement("div");
    heading.className = "tools-pane-heading";
    heading.textContent = title;
    section.appendChild(heading);

    build(section);
    return section;
  }

  // --- Inline editing ---

  function startInlineEdit(row: HTMLElement, currentValue: string, onCommit: (newValue: string) => void) {
    const input = document.createElement("input");
    input.className = "tools-pane-inline-input";
    input.value = currentValue;
    input.type = "text";

    // Replace row content with input
    const original = row.innerHTML;
    row.innerHTML = "";
    row.classList.add("tools-pane-editing");
    row.appendChild(input);
    input.focus();
    input.select();

    function commit() {
      const newValue = input.value.trim();
      row.classList.remove("tools-pane-editing");
      if (newValue && newValue !== currentValue) {
        onCommit(newValue);
      } else {
        row.innerHTML = original;
      }
    }

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); commit(); }
      if (e.key === "Escape") { row.innerHTML = original; row.classList.remove("tools-pane-editing"); }
    });
    input.addEventListener("blur", commit);
  }

  // --- Derive stats from graph data ---

  function deriveStats(graphData: LearningGraphData): DerivedStats {
    const typeCounts = new Map<string, number>();
    const edgeTypeCounts = new Map<string, number>();
    const connectionCounts = new Map<string, number>();
    const connectedNodes = new Set<string>();

    for (const node of graphData.nodes) {
      typeCounts.set(node.type, (typeCounts.get(node.type) ?? 0) + 1);
    }

    for (const edge of graphData.edges) {
      edgeTypeCounts.set(edge.type, (edgeTypeCounts.get(edge.type) ?? 0) + 1);
      connectionCounts.set(edge.sourceId, (connectionCounts.get(edge.sourceId) ?? 0) + 1);
      connectionCounts.set(edge.targetId, (connectionCounts.get(edge.targetId) ?? 0) + 1);
      connectedNodes.add(edge.sourceId);
      connectedNodes.add(edge.targetId);
    }

    const nodeLabel = (n: Node) => firstStringValue(n.properties) ?? n.id;

    const orphans = graphData.nodes
      .filter((n) => !connectedNodes.has(n.id))
      .map((n) => ({ id: n.id, label: nodeLabel(n), type: n.type }));

    const singletons = [...typeCounts.entries()]
      .filter(([, count]) => count === 1)
      .map(([name]) => ({ name }));

    const emptyNodes = graphData.nodes
      .filter((n) => Object.keys(n.properties).length === 0)
      .map((n) => ({ id: n.id, label: n.id, type: n.type }));

    const mostConnected = graphData.nodes
      .map((n) => ({
        id: n.id,
        label: nodeLabel(n),
        type: n.type,
        connections: connectionCounts.get(n.id) ?? 0,
      }))
      .filter((n) => n.connections > 0)
      .sort((a, b) => b.connections - a.connections)
      .slice(0, 5);

    return {
      nodeCount: graphData.nodes.length,
      edgeCount: graphData.edges.length,
      types: [...typeCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([name, count]) => ({ name, count })),
      edgeTypes: [...edgeTypeCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([name, count]) => ({ name, count })),
      orphans,
      singletons,
      emptyNodes,
      mostConnected,
    };
  }

  // --- Public API ---

  return {
    collapse() {
      collapsed = true;
      content.classList.add("hidden");
      toggle.classList.remove("active");
    },

    setData(newData: LearningGraphData | null) {
      data = newData;
      activeTypeFilter = null;
      if (data && data.nodes.length > 0) {
        stats = deriveStats(data);
        toggle.classList.remove("hidden");
        render();
      } else {
        stats = null;
        toggle.classList.add("hidden");
        content.classList.add("hidden");
      }
    },
  };
}

function firstStringValue(properties: Record<string, unknown>): string | null {
  for (const value of Object.values(properties)) {
    if (typeof value === "string") return value;
  }
  return null;
}
