import type { LearningGraphData, Node } from "backpack-ontology";
import { getColor } from "./colors";

interface ToolsPaneCallbacks {
  onFilterByType: (type: string | null) => void;
  onNavigateToNode: (nodeId: string) => void;
  onFocusChange: (seedNodeIds: string[] | null) => void;
  onRenameNodeType: (oldType: string, newType: string) => void;
  onRenameEdgeType: (oldType: string, newType: string) => void;
  onToggleEdgeLabels: (visible: boolean) => void;
  onToggleTypeHulls: (visible: boolean) => void;
  onToggleMinimap: (visible: boolean) => void;
  onLayoutChange: (param: string, value: number) => void;
  onPanSpeedChange: (speed: number) => void;
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
  let activeTab: "types" | "insights" | "controls" = "types";
  let typesSearch = "";
  let qualitySearch = "";

  // Unified focus set — two layers that compose via union
  const focusSet = {
    types: new Set<string>(),   // toggled node types (dynamic — resolves to all nodes of type)
    nodeIds: new Set<string>(), // individually toggled node IDs
  };

  /** Resolve the focus set to a flat array of node IDs. */
  function resolveFocusSet(): string[] {
    if (!data) return [];
    const ids = new Set<string>();
    for (const node of data.nodes) {
      if (focusSet.types.has(node.type)) ids.add(node.id);
    }
    for (const id of focusSet.nodeIds) ids.add(id);
    return [...ids];
  }

  /** Check if a node is in the focus set (directly or via its type). */
  function isNodeFocused(nodeId: string): boolean {
    if (focusSet.nodeIds.has(nodeId)) return true;
    const node = data?.nodes.find((n) => n.id === nodeId);
    return node ? focusSet.types.has(node.type) : false;
  }

  function isFocusSetEmpty(): boolean {
    return focusSet.types.size === 0 && focusSet.nodeIds.size === 0;
  }

  /** Emit the resolved focus set to the callback. */
  function emitFocusChange() {
    const resolved = resolveFocusSet();
    callbacks.onFocusChange(resolved.length > 0 ? resolved : null);
  }

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

    // Graph stats summary (always visible)
    const summary = document.createElement("div");
    summary.className = "tools-pane-summary";
    summary.innerHTML =
      `<span>${stats.nodeCount} nodes</span><span class="tools-pane-sep">&middot;</span>` +
      `<span>${stats.edgeCount} edges</span><span class="tools-pane-sep">&middot;</span>` +
      `<span>${stats.types.length} types</span>`;
    content.appendChild(summary);

    // Tab bar
    const tabBar = document.createElement("div");
    tabBar.className = "tools-pane-tabs";

    const tabs: { id: "types" | "insights" | "controls"; label: string }[] = [
      { id: "types", label: "Types" },
      { id: "insights", label: "Insights" },
      { id: "controls", label: "Controls" },
    ];

    for (const tab of tabs) {
      const btn = document.createElement("button");
      btn.className = "tools-pane-tab";
      if (activeTab === tab.id) btn.classList.add("tools-pane-tab-active");
      btn.textContent = tab.label;
      btn.addEventListener("click", () => {
        activeTab = tab.id;
        render();
      });
      tabBar.appendChild(btn);
    }

    content.appendChild(tabBar);

    // Global focused section (visible on any tab when something is focused)
    if (!isFocusSetEmpty()) {
      renderFocusedSection();
    }

    // Search input (for types and quality tabs)
    if (activeTab === "types" && stats.types.length > 5) {
      content.appendChild(makeSearchInput("Filter types...", typesSearch, (v) => {
        typesSearch = v;
        renderTabContent();
      }));
    } else if (activeTab === "insights") {
      const totalIssues = stats.orphans.length + stats.singletons.length + stats.emptyNodes.length;
      if (totalIssues > 5) {
        content.appendChild(makeSearchInput("Filter issues...", qualitySearch, (v) => {
          qualitySearch = v;
          renderTabContent();
        }));
      }
    }

    // Tab content container (re-rendered on search without destroying the input)
    const tabContainer = document.createElement("div");
    tabContainer.className = "tools-pane-tab-content";
    content.appendChild(tabContainer);

    renderTabContent();
  }

  function renderTabContent() {
    const tabContainer = content.querySelector(".tools-pane-tab-content");
    if (!tabContainer) return;
    tabContainer.innerHTML = "";

    if (activeTab === "types") {
      renderTypesTab(tabContainer as HTMLElement);
    } else if (activeTab === "insights") {
      renderInsightsTab(tabContainer as HTMLElement);
    } else if (activeTab === "controls") {
      renderControlsTab(tabContainer as HTMLElement);
    }
  }

  function renderFocusedSection() {
    if (!stats || !data) return;
    const resolved = resolveFocusSet();

    content.appendChild(makeSection("Focused", (section) => {
      // Show focused types
      for (const typeName of focusSet.types) {
        const t = stats!.types.find((t) => t.name === typeName);
        if (!t) continue;
        const row = document.createElement("div");
        row.className = "tools-pane-row tools-pane-clickable";

        const dot = document.createElement("span");
        dot.className = "tools-pane-dot";
        dot.style.backgroundColor = getColor(t.name);

        const name = document.createElement("span");
        name.className = "tools-pane-name";
        name.textContent = t.name;

        const badge = document.createElement("span");
        badge.className = "tools-pane-count";
        badge.textContent = `${t.count} nodes`;

        const removeBtn = document.createElement("button");
        removeBtn.className = "tools-pane-edit tools-pane-focus-active";
        removeBtn.style.opacity = "1";
        removeBtn.textContent = "\u00d7";
        removeBtn.title = `Remove ${t.name} from focus`;

        row.appendChild(dot);
        row.appendChild(name);
        row.appendChild(badge);
        row.appendChild(removeBtn);

        removeBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          focusSet.types.delete(t.name);
          emitFocusChange();
          render();
        });

        section.appendChild(row);
      }

      // Show focused individual nodes
      for (const nodeId of focusSet.nodeIds) {
        const node = data!.nodes.find((n) => n.id === nodeId);
        if (!node) continue;
        const label = firstStringValue(node.properties) ?? node.id;

        const row = document.createElement("div");
        row.className = "tools-pane-row tools-pane-clickable";

        const dot = document.createElement("span");
        dot.className = "tools-pane-dot";
        dot.style.backgroundColor = getColor(node.type);

        const name = document.createElement("span");
        name.className = "tools-pane-name";
        name.textContent = label;

        const typeBadge = document.createElement("span");
        typeBadge.className = "tools-pane-count";
        typeBadge.textContent = node.type;

        const removeBtn = document.createElement("button");
        removeBtn.className = "tools-pane-edit tools-pane-focus-active";
        removeBtn.style.opacity = "1";
        removeBtn.textContent = "\u00d7";
        removeBtn.title = `Remove ${label} from focus`;

        row.appendChild(dot);
        row.appendChild(name);
        row.appendChild(typeBadge);
        row.appendChild(removeBtn);

        row.addEventListener("click", (e) => {
          if ((e.target as HTMLElement).closest(".tools-pane-edit")) return;
          callbacks.onNavigateToNode(nodeId);
        });

        removeBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          focusSet.nodeIds.delete(nodeId);
          emitFocusChange();
          render();
        });

        section.appendChild(row);
      }

      // Summary + clear all
      const clearRow = document.createElement("div");
      clearRow.className = "tools-pane-row tools-pane-clickable tools-pane-focus-clear";

      const label = document.createElement("span");
      label.className = "tools-pane-name";
      label.style.color = "var(--accent)";
      label.textContent = `${resolved.length} total`;

      const clearBtn = document.createElement("span");
      clearBtn.className = "tools-pane-badge";
      clearBtn.textContent = "clear all";

      clearRow.appendChild(label);
      clearRow.appendChild(clearBtn);
      clearRow.addEventListener("click", () => {
        focusSet.types.clear();
        focusSet.nodeIds.clear();
        emitFocusChange();
        render();
      });
      section.appendChild(clearRow);
    }));
  }

  function buildTypeRow(t: { name: string; count: number }): HTMLElement {
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

    const focusBtn = document.createElement("button");
    focusBtn.className = "tools-pane-edit tools-pane-focus-toggle";
    if (focusSet.types.has(t.name)) focusBtn.classList.add("tools-pane-focus-active");
    focusBtn.textContent = "\u25CE";
    focusBtn.title = focusSet.types.has(t.name)
      ? `Remove ${t.name} from focus`
      : `Add ${t.name} to focus`;

    const editBtn = document.createElement("button");
    editBtn.className = "tools-pane-edit";
    editBtn.textContent = "\u270E";
    editBtn.title = `Rename all ${t.name} nodes`;

    row.appendChild(dot);
    row.appendChild(name);
    row.appendChild(count);
    row.appendChild(focusBtn);
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

    focusBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (focusSet.types.has(t.name)) {
        focusSet.types.delete(t.name);
      } else {
        focusSet.types.add(t.name);
      }
      emitFocusChange();
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

    return row;
  }

  function makeSearchInput(placeholder: string, value: string, onChange: (v: string) => void): HTMLElement {
    const input = document.createElement("input");
    input.type = "text";
    input.className = "tools-pane-search";
    input.placeholder = placeholder;
    input.value = value;
    input.addEventListener("input", () => onChange(input.value));
    return input;
  }

  function renderTypesTab(target: HTMLElement) {
    if (!stats) return;

    const q = typesSearch.toLowerCase();

    if (stats.types.length) {
      // Node types (excluding focused ones — those are in the global section)
      const unfocusedTypes = stats.types
        .filter((t) => !focusSet.types.has(t.name))
        .filter((t) => !q || t.name.toLowerCase().includes(q));

      if (unfocusedTypes.length > 0) {
        target.appendChild(makeSection("Node Types", (section) => {
          for (const t of unfocusedTypes) {
            section.appendChild(buildTypeRow(t));
          }
        }));
      }
    }

    // Edge types — with rename (filtered by search)
    const filteredEdgeTypes = stats.edgeTypes.filter((t) => !q || t.name.toLowerCase().includes(q));
    if (filteredEdgeTypes.length) {
      target.appendChild(makeSection("Edge Types", (section) => {
        for (const t of filteredEdgeTypes) {
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

  }

  function renderInsightsTab(target: HTMLElement) {
    if (!stats) return;

    const qq = qualitySearch.toLowerCase();

    // Most connected nodes — click to navigate, focus button
    const filteredConnected = stats.mostConnected.filter((n) =>
      !qq || n.label.toLowerCase().includes(qq) || n.type.toLowerCase().includes(qq)
    );
    if (filteredConnected.length) {
      target.appendChild(makeSection("Most Connected", (section) => {
        for (const n of filteredConnected) {
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

          const focusBtn = document.createElement("button");
          focusBtn.className = "tools-pane-edit tools-pane-focus-toggle";
          if (isNodeFocused(n.id)) focusBtn.classList.add("tools-pane-focus-active");
          focusBtn.textContent = "\u25CE";
          focusBtn.title = isNodeFocused(n.id)
            ? `Remove ${n.label} from focus`
            : `Add ${n.label} to focus`;

          row.appendChild(dot);
          row.appendChild(name);
          row.appendChild(count);
          row.appendChild(focusBtn);

          row.addEventListener("click", (e) => {
            if ((e.target as HTMLElement).closest(".tools-pane-edit")) return;
            callbacks.onNavigateToNode(n.id);
          });

          focusBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            if (focusSet.nodeIds.has(n.id)) {
              focusSet.nodeIds.delete(n.id);
            } else {
              focusSet.nodeIds.add(n.id);
            }
            emitFocusChange();
            render();
          });

          section.appendChild(row);
        }
      }));
    }
    const orphans = stats.orphans.filter((o) => !qq || o.label.toLowerCase().includes(qq) || o.type.toLowerCase().includes(qq));
    const singletons = stats.singletons.filter((s) => !qq || s.name.toLowerCase().includes(qq));
    const emptyNodes = stats.emptyNodes.filter((e) => !qq || e.label.toLowerCase().includes(qq) || e.type.toLowerCase().includes(qq));

    const hasOrphans = orphans.length > 0;
    const hasSingletons = singletons.length > 0;
    const hasEmptyNodes = emptyNodes.length > 0;

    if (!hasOrphans && !hasSingletons && !hasEmptyNodes) {
      const msg = document.createElement("div");
      msg.className = "tools-pane-empty-msg";
      msg.textContent = "No issues found";
      target.appendChild(msg);
      return;
    }

    // Orphans — click to navigate, focus button
    if (hasOrphans) {
      target.appendChild(makeSection("Orphans", (section) => {
        for (const o of orphans.slice(0, 5)) {
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

          const focusBtn = document.createElement("button");
          focusBtn.className = "tools-pane-edit tools-pane-focus-toggle";
          if (isNodeFocused(o.id)) focusBtn.classList.add("tools-pane-focus-active");
          focusBtn.textContent = "\u25CE";
          focusBtn.title = isNodeFocused(o.id)
            ? `Remove ${o.label} from focus`
            : `Add ${o.label} to focus`;

          row.appendChild(dot);
          row.appendChild(name);
          row.appendChild(badge);
          row.appendChild(focusBtn);

          row.addEventListener("click", (e) => {
            if ((e.target as HTMLElement).closest(".tools-pane-edit")) return;
            callbacks.onNavigateToNode(o.id);
          });

          focusBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            if (focusSet.nodeIds.has(o.id)) {
              focusSet.nodeIds.delete(o.id);
            } else {
              focusSet.nodeIds.add(o.id);
            }
            emitFocusChange();
            render();
          });

          section.appendChild(row);
        }

        if (orphans.length > 5) {
          const more = document.createElement("div");
          more.className = "tools-pane-more";
          more.textContent = `+ ${orphans.length - 5} more orphans`;
          section.appendChild(more);
        }
      }));
    }

    // Singleton types
    if (hasSingletons) {
      target.appendChild(makeSection("Singletons", (section) => {
        for (const s of singletons.slice(0, 5)) {
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

    // Empty nodes
    if (hasEmptyNodes) {
      target.appendChild(makeSection("Empty Nodes", (section) => {
        for (const e of emptyNodes.slice(0, 5)) {
          const row = document.createElement("div");
          row.className = "tools-pane-row tools-pane-issue";

          const dot = document.createElement("span");
          dot.className = "tools-pane-dot";
          dot.style.backgroundColor = getColor(e.type);

          const name = document.createElement("span");
          name.className = "tools-pane-name";
          name.textContent = e.label;

          const badge = document.createElement("span");
          badge.className = "tools-pane-badge";
          badge.textContent = "empty";

          row.appendChild(dot);
          row.appendChild(name);
          row.appendChild(badge);
          section.appendChild(row);
        }

        if (stats!.emptyNodes.length > 5) {
          const more = document.createElement("div");
          more.className = "tools-pane-more";
          more.textContent = `+ ${stats!.emptyNodes.length - 5} more empty nodes`;
          section.appendChild(more);
        }
      }));
    }
  }

  function renderControlsTab(target: HTMLElement) {
    // Edge labels toggle
    target.appendChild(makeSection("Display", (section) => {
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
    }));

    // Layout sliders
    target.appendChild(makeSection("Layout", (section) => {
      section.appendChild(makeSlider("Clustering", 0, 1, 0.02, 0.08, (v) => {
        callbacks.onLayoutChange("clusterStrength", v);
      }));
      section.appendChild(makeSlider("Spacing", 0.5, 20, 0.5, 1.5, (v) => {
        callbacks.onLayoutChange("spacing", v);
      }));
      section.appendChild(makeSlider("Pan speed", 20, 200, 10, 60, (v) => {
        callbacks.onPanSpeedChange(v);
      }));
    }));

    // Export buttons
    target.appendChild(makeSection("Export", (section) => {
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

    addToFocusSet(nodeIds: string[]) {
      for (const id of nodeIds) focusSet.nodeIds.add(id);
      emitFocusChange();
      render();
    },

    clearFocusSet() {
      focusSet.types.clear();
      focusSet.nodeIds.clear();
      emitFocusChange();
      render();
    },

    setData(newData: LearningGraphData | null) {
      data = newData;
      activeTypeFilter = null;
      focusSet.types.clear();
      focusSet.nodeIds.clear();
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
