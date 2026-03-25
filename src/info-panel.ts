import type { Node, Edge, OntologyData } from "backpack-ontology";
import { getColor } from "./colors";

/** Extract a display label from a node — first string property, fallback to id. */
function nodeLabel(node: Node): string {
  for (const value of Object.values(node.properties)) {
    if (typeof value === "string") return value;
  }
  return node.id;
}

export interface EditCallbacks {
  onUpdateNode(nodeId: string, properties: Record<string, unknown>): void;
  onChangeNodeType(nodeId: string, newType: string): void;
  onDeleteNode(nodeId: string): void;
  onDeleteEdge(edgeId: string): void;
  onAddProperty(nodeId: string, key: string, value: string): void;
}

const EDIT_ICON = '\u270E'; // pencil

export function initInfoPanel(
  container: HTMLElement,
  callbacks?: EditCallbacks,
  onNavigateToNode?: (nodeId: string) => void
) {
  const panel = document.createElement("div");
  panel.id = "info-panel";
  panel.className = "info-panel hidden";
  container.appendChild(panel);

  // --- State ---
  let maximized = false;
  let history: string[] = [];
  let historyIndex = -1;
  let navigatingHistory = false;
  let lastData: OntologyData | null = null;

  function hide() {
    panel.classList.add("hidden");
    panel.classList.remove("info-panel-maximized");
    panel.innerHTML = "";
    maximized = false;
    history = [];
    historyIndex = -1;
  }

  function navigateTo(nodeId: string) {
    if (!lastData || !onNavigateToNode) return;
    // Push to history before navigating
    if (historyIndex < history.length - 1) {
      history = history.slice(0, historyIndex + 1);
    }
    history.push(nodeId);
    historyIndex = history.length - 1;
    // Set flag so the show() call from canvas doesn't double-push
    navigatingHistory = true;
    onNavigateToNode(nodeId);
    navigatingHistory = false;
  }

  function goBack() {
    if (historyIndex <= 0 || !lastData || !onNavigateToNode) return;
    historyIndex--;
    navigatingHistory = true;
    onNavigateToNode(history[historyIndex]);
    navigatingHistory = false;
  }

  function goForward() {
    if (historyIndex >= history.length - 1 || !lastData || !onNavigateToNode) return;
    historyIndex++;
    navigatingHistory = true;
    onNavigateToNode(history[historyIndex]);
    navigatingHistory = false;
  }

  function createToolbar(): HTMLElement {
    const toolbar = document.createElement("div");
    toolbar.className = "info-panel-toolbar";

    // Back
    const backBtn = document.createElement("button");
    backBtn.className = "info-toolbar-btn";
    backBtn.textContent = "\u2190";
    backBtn.title = "Back";
    backBtn.disabled = historyIndex <= 0;
    backBtn.addEventListener("click", goBack);
    toolbar.appendChild(backBtn);

    // Forward
    const fwdBtn = document.createElement("button");
    fwdBtn.className = "info-toolbar-btn";
    fwdBtn.textContent = "\u2192";
    fwdBtn.title = "Forward";
    fwdBtn.disabled = historyIndex >= history.length - 1;
    fwdBtn.addEventListener("click", goForward);
    toolbar.appendChild(fwdBtn);

    // Maximize/restore
    const maxBtn = document.createElement("button");
    maxBtn.className = "info-toolbar-btn";
    maxBtn.textContent = maximized ? "\u2398" : "\u26F6";
    maxBtn.title = maximized ? "Restore" : "Maximize";
    maxBtn.addEventListener("click", () => {
      maximized = !maximized;
      panel.classList.toggle("info-panel-maximized", maximized);
      maxBtn.textContent = maximized ? "\u2398" : "\u26F6";
      maxBtn.title = maximized ? "Restore" : "Maximize";
    });
    toolbar.appendChild(maxBtn);

    // Close
    const closeBtn = document.createElement("button");
    closeBtn.className = "info-toolbar-btn info-close-btn";
    closeBtn.textContent = "\u00d7";
    closeBtn.title = "Close";
    closeBtn.addEventListener("click", hide);
    toolbar.appendChild(closeBtn);

    return toolbar;
  }

  function showSingle(nodeId: string, data: OntologyData) {
    const node = data.nodes.find((n) => n.id === nodeId);
    if (!node) return;

    const connectedEdges = data.edges.filter(
      (e) => e.sourceId === nodeId || e.targetId === nodeId
    );

    panel.innerHTML = "";
    panel.classList.remove("hidden");
    if (maximized) panel.classList.add("info-panel-maximized");

    // Toolbar (back, forward, maximize, close)
    panel.appendChild(createToolbar());

    // Header: type badge + label
    const header = document.createElement("div");
    header.className = "info-header";

    const typeBadge = document.createElement("span");
    typeBadge.className = "info-type-badge";
    typeBadge.textContent = node.type;
    typeBadge.style.backgroundColor = getColor(node.type);

    if (callbacks) {
      typeBadge.classList.add("info-editable");
      const typeEditBtn = document.createElement("button");
      typeEditBtn.className = "info-inline-edit";
      typeEditBtn.textContent = EDIT_ICON;
      typeEditBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const input = document.createElement("input");
        input.type = "text";
        input.className = "info-edit-inline-input";
        input.value = node.type;
        typeBadge.textContent = "";
        typeBadge.appendChild(input);
        input.focus();
        input.select();
        const finish = () => {
          const val = input.value.trim();
          if (val && val !== node.type) {
            callbacks.onChangeNodeType(nodeId, val);
          } else {
            typeBadge.textContent = node.type;
            typeBadge.appendChild(typeEditBtn);
          }
        };
        input.addEventListener("blur", finish);
        input.addEventListener("keydown", (ke) => {
          if (ke.key === "Enter") input.blur();
          if (ke.key === "Escape") { input.value = node.type; input.blur(); }
        });
      });
      typeBadge.appendChild(typeEditBtn);
    }

    const label = document.createElement("h3");
    label.className = "info-label";
    label.textContent = nodeLabel(node);

    const nodeIdEl = document.createElement("span");
    nodeIdEl.className = "info-id";
    nodeIdEl.textContent = node.id;

    header.appendChild(typeBadge);
    header.appendChild(label);
    header.appendChild(nodeIdEl);
    panel.appendChild(header);

    // Properties section (editable)
    const propKeys = Object.keys(node.properties);
    const propSection = createSection("Properties");

    if (propKeys.length > 0) {
      const table = document.createElement("dl");
      table.className = "info-props";

      for (const key of propKeys) {
        const dt = document.createElement("dt");
        dt.textContent = key;

        const dd = document.createElement("dd");

        if (callbacks) {
          const valueStr = formatValue(node.properties[key]);
          const input = document.createElement("input");
          input.type = "text";
          input.className = "info-edit-input";
          input.value = valueStr;
          input.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
              input.blur();
            }
          });
          input.addEventListener("blur", () => {
            const newVal = input.value;
            if (newVal !== valueStr) {
              callbacks.onUpdateNode(nodeId, { [key]: tryParseValue(newVal) });
            }
          });
          dd.appendChild(input);

          // Delete property button
          const delProp = document.createElement("button");
          delProp.className = "info-delete-prop";
          delProp.textContent = "\u00d7";
          delProp.title = `Remove ${key}`;
          delProp.addEventListener("click", () => {
            const updated = { ...node.properties };
            delete updated[key];
            callbacks.onUpdateNode(nodeId, updated);
          });
          dd.appendChild(delProp);
        } else {
          dd.appendChild(renderValue(node.properties[key]));
        }

        table.appendChild(dt);
        table.appendChild(dd);
      }

      propSection.appendChild(table);
    }

    // Add property button
    if (callbacks) {
      const addBtn = document.createElement("button");
      addBtn.className = "info-add-btn";
      addBtn.textContent = "+ Add property";
      addBtn.addEventListener("click", () => {
        const row = document.createElement("div");
        row.className = "info-add-row";

        const keyInput = document.createElement("input");
        keyInput.type = "text";
        keyInput.className = "info-edit-input";
        keyInput.placeholder = "key";

        const valInput = document.createElement("input");
        valInput.type = "text";
        valInput.className = "info-edit-input";
        valInput.placeholder = "value";

        const saveBtn = document.createElement("button");
        saveBtn.className = "info-add-save";
        saveBtn.textContent = "Add";
        saveBtn.addEventListener("click", () => {
          if (keyInput.value) {
            callbacks.onAddProperty(
              nodeId,
              keyInput.value,
              valInput.value
            );
          }
        });

        row.appendChild(keyInput);
        row.appendChild(valInput);
        row.appendChild(saveBtn);
        propSection.appendChild(row);
        keyInput.focus();
      });
      propSection.appendChild(addBtn);
    }

    panel.appendChild(propSection);

    // Connections section
    if (connectedEdges.length > 0) {
      const section = createSection(
        `Connections (${connectedEdges.length})`
      );
      const list = document.createElement("ul");
      list.className = "info-connections";

      for (const edge of connectedEdges) {
        const isOutgoing = edge.sourceId === nodeId;
        const otherId = isOutgoing ? edge.targetId : edge.sourceId;
        const otherNode = data.nodes.find((n) => n.id === otherId);
        const otherLabel = otherNode ? nodeLabel(otherNode) : otherId;

        const li = document.createElement("li");
        li.className = "info-connection";

        // Make clickable if we can navigate
        if (onNavigateToNode && otherNode) {
          li.classList.add("info-connection-link");
          li.addEventListener("click", (e) => {
            // Don't navigate if clicking the delete edge button
            if ((e.target as HTMLElement).closest(".info-delete-edge")) return;
            navigateTo(otherId);
          });
        }

        if (otherNode) {
          const dot = document.createElement("span");
          dot.className = "info-target-dot";
          dot.style.backgroundColor = getColor(otherNode.type);
          li.appendChild(dot);
        }

        const arrow = document.createElement("span");
        arrow.className = "info-arrow";
        arrow.textContent = isOutgoing ? "\u2192" : "\u2190";

        const edgeType = document.createElement("span");
        edgeType.className = "info-edge-type";
        edgeType.textContent = edge.type;

        const target = document.createElement("span");
        target.className = "info-target";
        target.textContent = otherLabel;

        li.appendChild(arrow);
        li.appendChild(edgeType);
        li.appendChild(target);

        // Edge properties (if any)
        const edgePropKeys = Object.keys(edge.properties);
        if (edgePropKeys.length > 0) {
          const edgeProps = document.createElement("div");
          edgeProps.className = "info-edge-props";
          for (const key of edgePropKeys) {
            const prop = document.createElement("span");
            prop.className = "info-edge-prop";
            prop.textContent = `${key}: ${formatValue(edge.properties[key])}`;
            edgeProps.appendChild(prop);
          }
          li.appendChild(edgeProps);
        }

        // Delete edge button
        if (callbacks) {
          const delEdge = document.createElement("button");
          delEdge.className = "info-delete-edge";
          delEdge.textContent = "\u00d7";
          delEdge.title = "Remove connection";
          delEdge.addEventListener("click", (e) => {
            e.stopPropagation();
            callbacks.onDeleteEdge(edge.id);
          });
          li.appendChild(delEdge);
        }

        list.appendChild(li);
      }

      section.appendChild(list);
      panel.appendChild(section);
    }

    // Timestamps
    const tsSection = createSection("Timestamps");
    const timestamps = document.createElement("dl");
    timestamps.className = "info-props";

    const createdDt = document.createElement("dt");
    createdDt.textContent = "created";
    const createdDd = document.createElement("dd");
    createdDd.textContent = formatTimestamp(node.createdAt);

    const updatedDt = document.createElement("dt");
    updatedDt.textContent = "updated";
    const updatedDd = document.createElement("dd");
    updatedDd.textContent = formatTimestamp(node.updatedAt);

    timestamps.appendChild(createdDt);
    timestamps.appendChild(createdDd);
    timestamps.appendChild(updatedDt);
    timestamps.appendChild(updatedDd);
    tsSection.appendChild(timestamps);
    panel.appendChild(tsSection);

    // Delete node button
    if (callbacks) {
      const deleteSection = document.createElement("div");
      deleteSection.className = "info-section info-danger";

      const deleteBtn = document.createElement("button");
      deleteBtn.className = "info-delete-node";
      deleteBtn.textContent = "Delete node";
      deleteBtn.addEventListener("click", () => {
        callbacks.onDeleteNode(nodeId);
        hide();
      });
      deleteSection.appendChild(deleteBtn);
      panel.appendChild(deleteSection);
    }
  }

  function showMulti(nodeIds: string[], data: OntologyData) {
    const selectedSet = new Set(nodeIds);
    const nodes = data.nodes.filter((n) => selectedSet.has(n.id));
    if (nodes.length === 0) return;

    const sharedEdges = data.edges.filter(
      (e) => selectedSet.has(e.sourceId) && selectedSet.has(e.targetId)
    );

    panel.innerHTML = "";
    panel.classList.remove("hidden");
    if (maximized) panel.classList.add("info-panel-maximized");

    // Toolbar
    panel.appendChild(createToolbar());

    const header = document.createElement("div");
    header.className = "info-header";

    const label = document.createElement("h3");
    label.className = "info-label";
    label.textContent = `${nodes.length} nodes selected`;

    header.appendChild(label);

    const badgeRow = document.createElement("div");
    badgeRow.style.cssText = "display:flex;flex-wrap:wrap;gap:4px;margin-top:6px";
    const typeCounts = new Map<string, number>();
    for (const node of nodes) {
      typeCounts.set(node.type, (typeCounts.get(node.type) ?? 0) + 1);
    }
    for (const [type, count] of typeCounts) {
      const badge = document.createElement("span");
      badge.className = "info-type-badge";
      badge.style.backgroundColor = getColor(type);
      badge.textContent = count > 1 ? `${type} (${count})` : type;
      badgeRow.appendChild(badge);
    }
    header.appendChild(badgeRow);
    panel.appendChild(header);

    const nodesSection = createSection("Selected Nodes");
    const nodesList = document.createElement("ul");
    nodesList.className = "info-connections";

    for (const node of nodes) {
      const li = document.createElement("li");
      li.className = "info-connection";

      // Make clickable to navigate to single node
      if (onNavigateToNode) {
        li.classList.add("info-connection-link");
        li.addEventListener("click", () => {
          navigateTo(node.id);
        });
      }

      const dot = document.createElement("span");
      dot.className = "info-target-dot";
      dot.style.backgroundColor = getColor(node.type);

      const name = document.createElement("span");
      name.className = "info-target";
      name.textContent = nodeLabel(node);

      const type = document.createElement("span");
      type.className = "info-edge-type";
      type.textContent = node.type;

      li.appendChild(dot);
      li.appendChild(name);
      li.appendChild(type);
      nodesList.appendChild(li);
    }

    nodesSection.appendChild(nodesList);
    panel.appendChild(nodesSection);

    const connSection = createSection(
      sharedEdges.length > 0
        ? `Connections Between Selected (${sharedEdges.length})`
        : "Connections Between Selected"
    );

    if (sharedEdges.length === 0) {
      const empty = document.createElement("p");
      empty.style.cssText = "font-size:12px;color:var(--text-dim)";
      empty.textContent = "No direct connections between selected nodes";
      connSection.appendChild(empty);
    } else {
      const list = document.createElement("ul");
      list.className = "info-connections";

      for (const edge of sharedEdges) {
        const sourceNode = data.nodes.find((n) => n.id === edge.sourceId);
        const targetNode = data.nodes.find((n) => n.id === edge.targetId);
        const sourceLabel = sourceNode
          ? nodeLabel(sourceNode)
          : edge.sourceId;
        const targetLabel = targetNode
          ? nodeLabel(targetNode)
          : edge.targetId;

        const li = document.createElement("li");
        li.className = "info-connection";

        if (sourceNode) {
          const dot = document.createElement("span");
          dot.className = "info-target-dot";
          dot.style.backgroundColor = getColor(sourceNode.type);
          li.appendChild(dot);
        }

        const source = document.createElement("span");
        source.className = "info-target";
        source.textContent = sourceLabel;

        const arrow = document.createElement("span");
        arrow.className = "info-arrow";
        arrow.textContent = "\u2192";

        const edgeType = document.createElement("span");
        edgeType.className = "info-edge-type";
        edgeType.textContent = edge.type;

        const arrow2 = document.createElement("span");
        arrow2.className = "info-arrow";
        arrow2.textContent = "\u2192";

        li.appendChild(source);
        li.appendChild(arrow);
        li.appendChild(edgeType);
        li.appendChild(arrow2);

        if (targetNode) {
          const dot2 = document.createElement("span");
          dot2.className = "info-target-dot";
          dot2.style.backgroundColor = getColor(targetNode.type);
          li.appendChild(dot2);
        }

        const target = document.createElement("span");
        target.className = "info-target";
        target.textContent = targetLabel;
        li.appendChild(target);

        const edgePropKeys = Object.keys(edge.properties);
        if (edgePropKeys.length > 0) {
          const edgeProps = document.createElement("div");
          edgeProps.className = "info-edge-props";
          for (const key of edgePropKeys) {
            const prop = document.createElement("span");
            prop.className = "info-edge-prop";
            prop.textContent = `${key}: ${formatValue(edge.properties[key])}`;
            edgeProps.appendChild(prop);
          }
          li.appendChild(edgeProps);
        }

        list.appendChild(li);
      }

      connSection.appendChild(list);
    }

    panel.appendChild(connSection);
  }

  return {
    show(nodeIds: string[], data: OntologyData) {
      lastData = data;

      // Track history for single-node views
      if (nodeIds.length === 1 && !navigatingHistory) {
        const nodeId = nodeIds[0];
        // Don't push duplicate consecutive entries
        if (history[historyIndex] !== nodeId) {
          if (historyIndex < history.length - 1) {
            history = history.slice(0, historyIndex + 1);
          }
          history.push(nodeId);
          historyIndex = history.length - 1;
        }
      }

      if (nodeIds.length === 1) {
        showSingle(nodeIds[0], data);
      } else if (nodeIds.length > 1) {
        showMulti(nodeIds, data);
      }
    },

    hide,

    get visible() {
      return !panel.classList.contains("hidden");
    },
  };
}

function createSection(title: string): HTMLElement {
  const section = document.createElement("div");
  section.className = "info-section";

  const heading = document.createElement("h4");
  heading.className = "info-section-title";
  heading.textContent = title;
  section.appendChild(heading);

  return section;
}

function renderValue(value: unknown): HTMLElement {
  if (Array.isArray(value)) {
    const container = document.createElement("div");
    container.className = "info-array";
    for (const item of value) {
      const tag = document.createElement("span");
      tag.className = "info-tag";
      tag.textContent = String(item);
      container.appendChild(tag);
    }
    return container;
  }

  if (value !== null && typeof value === "object") {
    const pre = document.createElement("pre");
    pre.className = "info-json";
    pre.textContent = JSON.stringify(value, null, 2);
    return pre;
  }

  const span = document.createElement("span");
  span.className = "info-value";
  span.textContent = String(value ?? "");
  return span;
}

function formatValue(value: unknown): string {
  if (Array.isArray(value)) return value.map(String).join(", ");
  if (value !== null && typeof value === "object")
    return JSON.stringify(value);
  return String(value ?? "");
}

/** Try to parse a string as JSON (number, boolean, array), fall back to string. */
function tryParseValue(str: string): unknown {
  const trimmed = str.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed !== "" && !isNaN(Number(trimmed))) return Number(trimmed);
  if (
    (trimmed.startsWith("[") && trimmed.endsWith("]")) ||
    (trimmed.startsWith("{") && trimmed.endsWith("}"))
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return str;
    }
  }
  return str;
}

function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString();
  } catch {
    return iso;
  }
}
