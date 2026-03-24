import type { OntologyData } from "backpack-ontology";
import { listOntologies, loadOntology, saveOntology, renameOntology } from "./api";
import { initSidebar } from "./sidebar";
import { initCanvas } from "./canvas";
import { initInfoPanel } from "./info-panel";
import { initSearch } from "./search";
import "./style.css";

let activeOntology = "";
let currentData: OntologyData | null = null;

async function main() {
  const canvasContainer = document.getElementById("canvas-container")!;

  // --- Theme toggle (top-right of canvas) ---
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)");
  const stored = localStorage.getItem("backpack-theme");
  const initial = stored ?? (prefersDark.matches ? "dark" : "light");
  document.documentElement.setAttribute("data-theme", initial);

  const themeBtn = document.createElement("button");
  themeBtn.className = "theme-toggle";
  themeBtn.textContent = initial === "light" ? "\u263E" : "\u263C";
  themeBtn.title = "Toggle light/dark mode";
  themeBtn.addEventListener("click", () => {
    const current = document.documentElement.getAttribute("data-theme");
    const next = current === "light" ? "dark" : "light";
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem("backpack-theme", next);
    themeBtn.textContent = next === "light" ? "\u263E" : "\u263C";
  });
  canvasContainer.appendChild(themeBtn);

  // --- Save and re-render helper ---
  async function save() {
    if (!activeOntology || !currentData) return;
    currentData.metadata.updatedAt = new Date().toISOString();
    await saveOntology(activeOntology, currentData);
    canvas.loadGraph(currentData);
    search.setOntologyData(currentData);
    // Refresh sidebar counts
    const updated = await listOntologies();
    sidebar.setSummaries(updated);
  }

  // --- Info panel with edit callbacks ---
  const infoPanel = initInfoPanel(canvasContainer, {
    onUpdateNode(nodeId, properties) {
      if (!currentData) return;
      const node = currentData.nodes.find((n) => n.id === nodeId);
      if (!node) return;
      node.properties = { ...node.properties, ...properties };
      node.updatedAt = new Date().toISOString();
      save().then(() => infoPanel.show([nodeId], currentData!));
    },

    onChangeNodeType(nodeId, newType) {
      if (!currentData) return;
      const node = currentData.nodes.find((n) => n.id === nodeId);
      if (!node) return;
      node.type = newType;
      node.updatedAt = new Date().toISOString();
      save().then(() => infoPanel.show([nodeId], currentData!));
    },

    onDeleteNode(nodeId) {
      if (!currentData) return;
      currentData.nodes = currentData.nodes.filter((n) => n.id !== nodeId);
      currentData.edges = currentData.edges.filter(
        (e) => e.sourceId !== nodeId && e.targetId !== nodeId
      );
      save();
    },

    onDeleteEdge(edgeId) {
      if (!currentData) return;
      const selectedNodeId = currentData.edges.find(
        (e) => e.id === edgeId
      )?.sourceId;
      currentData.edges = currentData.edges.filter((e) => e.id !== edgeId);
      save().then(() => {
        if (selectedNodeId && currentData) {
          infoPanel.show([selectedNodeId], currentData);
        }
      });
    },

    onAddProperty(nodeId, key, value) {
      if (!currentData) return;
      const node = currentData.nodes.find((n) => n.id === nodeId);
      if (!node) return;
      node.properties[key] = value;
      node.updatedAt = new Date().toISOString();
      save().then(() => infoPanel.show([nodeId], currentData!));
    },
  });

  const canvas = initCanvas(canvasContainer, (nodeIds) => {
    if (nodeIds && nodeIds.length > 0 && currentData) {
      infoPanel.show(nodeIds, currentData);
    } else {
      infoPanel.hide();
    }
  });

  const search = initSearch(canvasContainer);

  search.onFilterChange((ids) => {
    canvas.setFilteredNodeIds(ids);
  });

  search.onNodeSelect((nodeId) => {
    canvas.panToNode(nodeId);
    if (currentData) {
      infoPanel.show([nodeId], currentData);
    }
  });

  const sidebar = initSidebar(
    document.getElementById("sidebar")!,
    {
      onSelect: async (name) => {
        activeOntology = name;
        sidebar.setActive(name);
        infoPanel.hide();
        search.clear();
        currentData = await loadOntology(name);
        canvas.loadGraph(currentData);
        search.setOntologyData(currentData);
      },
      onRename: async (oldName, newName) => {
        await renameOntology(oldName, newName);
        if (activeOntology === oldName) {
          activeOntology = newName;
        }
        const updated = await listOntologies();
        sidebar.setSummaries(updated);
        sidebar.setActive(activeOntology);
        if (activeOntology === newName) {
          currentData = await loadOntology(newName);
          canvas.loadGraph(currentData);
          search.setOntologyData(currentData);
        }
      },
    }
  );

  // Load ontology list
  const summaries = await listOntologies();
  sidebar.setSummaries(summaries);

  // Auto-load first ontology
  if (summaries.length > 0) {
    activeOntology = summaries[0].name;
    sidebar.setActive(activeOntology);
    currentData = await loadOntology(activeOntology);
    canvas.loadGraph(currentData);
    search.setOntologyData(currentData);
  }

  // Keyboard shortcut: / or Ctrl+K to focus search
  document.addEventListener("keydown", (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

    if (e.key === "/" || (e.key === "k" && (e.metaKey || e.ctrlKey))) {
      e.preventDefault();
      search.focus();
    }
  });

  // Live reload — when Claude adds nodes via MCP, re-fetch and re-render
  if (import.meta.hot) {
    import.meta.hot.on("ontology-change", async () => {
      const updated = await listOntologies();
      sidebar.setSummaries(updated);

      if (activeOntology) {
        try {
          currentData = await loadOntology(activeOntology);
          canvas.loadGraph(currentData);
          search.setOntologyData(currentData);
        } catch {
          // Ontology may have been deleted
        }
      }
    });
  }
}

main();
