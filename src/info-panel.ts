import type { Node, Edge, OntologyData } from "backpack-ontology";
import { getColor } from "./colors";

/** Extract a display label from a node — first string property, fallback to id. */
function nodeLabel(node: Node): string {
  for (const value of Object.values(node.properties)) {
    if (typeof value === "string") return value;
  }
  return node.id;
}

export function initInfoPanel(container: HTMLElement) {
  const panel = document.createElement("div");
  panel.id = "info-panel";
  panel.className = "info-panel hidden";
  container.appendChild(panel);

  return {
    show(nodeId: string, data: OntologyData) {
      const node = data.nodes.find((n) => n.id === nodeId);
      if (!node) return;

      const connectedEdges = data.edges.filter(
        (e) => e.sourceId === nodeId || e.targetId === nodeId
      );

      panel.innerHTML = "";
      panel.classList.remove("hidden");

      // Close button
      const closeBtn = document.createElement("button");
      closeBtn.className = "info-close";
      closeBtn.textContent = "\u00d7";
      closeBtn.addEventListener("click", () => this.hide());
      panel.appendChild(closeBtn);

      // Header: type badge + label
      const header = document.createElement("div");
      header.className = "info-header";

      const typeBadge = document.createElement("span");
      typeBadge.className = "info-type-badge";
      typeBadge.textContent = node.type;
      typeBadge.style.backgroundColor = getColor(node.type);

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

      // Properties section
      const propKeys = Object.keys(node.properties);
      if (propKeys.length > 0) {
        const section = createSection("Properties");
        const table = document.createElement("dl");
        table.className = "info-props";

        for (const key of propKeys) {
          const dt = document.createElement("dt");
          dt.textContent = key;

          const dd = document.createElement("dd");
          dd.appendChild(renderValue(node.properties[key]));

          table.appendChild(dt);
          table.appendChild(dd);
        }

        section.appendChild(table);
        panel.appendChild(section);
      }

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

          const arrow = document.createElement("span");
          arrow.className = "info-arrow";
          arrow.textContent = isOutgoing ? "\u2192" : "\u2190";

          const edgeType = document.createElement("span");
          edgeType.className = "info-edge-type";
          edgeType.textContent = edge.type;

          const target = document.createElement("span");
          target.className = "info-target";
          target.textContent = otherLabel;

          if (otherNode) {
            const dot = document.createElement("span");
            dot.className = "info-target-dot";
            dot.style.backgroundColor = getColor(otherNode.type);
            li.appendChild(dot);
          }

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

          list.appendChild(li);
        }

        section.appendChild(list);
        panel.appendChild(section);
      }

      // Timestamps
      const section = createSection("Timestamps");
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
      section.appendChild(timestamps);
      panel.appendChild(section);
    },

    hide() {
      panel.classList.add("hidden");
      panel.innerHTML = "";
    },

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

/** Render any property value into a DOM element. Handles strings, arrays, numbers, objects. */
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

/** Format a value for inline display. */
function formatValue(value: unknown): string {
  if (Array.isArray(value)) return value.map(String).join(", ");
  if (value !== null && typeof value === "object")
    return JSON.stringify(value);
  return String(value ?? "");
}

function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString();
  } catch {
    return iso;
  }
}
