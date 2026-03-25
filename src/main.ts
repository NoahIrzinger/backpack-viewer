import type { LearningGraphData } from "backpack-ontology";
import { listOntologies, loadOntology, saveOntology, renameOntology } from "./api";
import { initSidebar } from "./sidebar";
import { initCanvas } from "./canvas";
import { initInfoPanel } from "./info-panel";
import { initSearch } from "./search";
import { initToolsPane } from "./tools-pane";
import "./style.css";

let activeOntology = "";
let currentData: LearningGraphData | null = null;

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
    search.setLearningGraphData(currentData);
    toolsPane.setData(currentData);
    // Refresh sidebar counts
    const updated = await listOntologies();
    sidebar.setSummaries(updated);
  }

  // --- Info panel with edit callbacks ---
  // canvas is used inside the navigate callback but declared below —
  // that's fine because the callback is only invoked after setup completes.
  let canvas: ReturnType<typeof initCanvas>;

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
  }, (nodeId) => {
    canvas.panToNode(nodeId);
  });

  const mobileQuery = window.matchMedia("(max-width: 768px)");

  canvas = initCanvas(canvasContainer, (nodeIds) => {
    if (nodeIds && nodeIds.length > 0 && currentData) {
      infoPanel.show(nodeIds, currentData);
      if (mobileQuery.matches) toolsPane.collapse();
    } else {
      infoPanel.hide();
    }
  });

  const search = initSearch(canvasContainer);
  const toolsPane = initToolsPane(canvasContainer, {
    onFilterByType(type) {
      if (!currentData) return;
      if (type === null) {
        canvas.setFilteredNodeIds(null);
      } else {
        const ids = new Set(
          (currentData?.nodes ?? [])
            .filter((n) => n.type === type)
            .map((n) => n.id)
        );
        canvas.setFilteredNodeIds(ids);
      }
    },
    onNavigateToNode(nodeId) {
      canvas.panToNode(nodeId);
      if (currentData) infoPanel.show([nodeId], currentData);
    },
    onRenameNodeType(oldType, newType) {
      if (!currentData) return;
      for (const node of currentData.nodes) {
        if (node.type === oldType) {
          node.type = newType;
          node.updatedAt = new Date().toISOString();
        }
      }
      save();
    },
    onRenameEdgeType(oldType, newType) {
      if (!currentData) return;
      for (const edge of currentData.edges) {
        if (edge.type === oldType) {
          edge.type = newType;
        }
      }
      save();
    },
    onOpen() {
      if (mobileQuery.matches) infoPanel.hide();
    },
  });

  // --- Top bar: flex container for all top controls ---
  const topBar = document.createElement("div");
  topBar.className = "canvas-top-bar";

  const topLeft = document.createElement("div");
  topLeft.className = "canvas-top-left";

  const topCenter = document.createElement("div");
  topCenter.className = "canvas-top-center";

  const topRight = document.createElement("div");
  topRight.className = "canvas-top-right";

  // Move tools toggle into left slot
  const toolsToggle = canvasContainer.querySelector(".tools-pane-toggle");
  if (toolsToggle) topLeft.appendChild(toolsToggle);

  // Move search overlay into center slot
  const searchOverlay = canvasContainer.querySelector(".search-overlay");
  if (searchOverlay) topCenter.appendChild(searchOverlay);

  // Move zoom controls and theme toggle into right slot
  const zoomControls = canvasContainer.querySelector(".zoom-controls");
  if (zoomControls) topRight.appendChild(zoomControls);
  topRight.appendChild(themeBtn);

  topBar.appendChild(topLeft);
  topBar.appendChild(topCenter);
  topBar.appendChild(topRight);
  canvasContainer.appendChild(topBar);

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
        search.setLearningGraphData(currentData);
    toolsPane.setData(currentData);
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
          search.setLearningGraphData(currentData);
    toolsPane.setData(currentData);
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
    search.setLearningGraphData(currentData);
    toolsPane.setData(currentData);
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
          search.setLearningGraphData(currentData);
    toolsPane.setData(currentData);
        } catch {
          // Ontology may have been deleted
        }
      }
    });
  }
}

main();
