import type { LearningGraphData } from "backpack-ontology";
import { listOntologies, loadOntology, saveOntology, renameOntology } from "./api";
import { initSidebar } from "./sidebar";
import { initCanvas } from "./canvas";
import { initInfoPanel } from "./info-panel";
import { initSearch } from "./search";
import { initToolsPane } from "./tools-pane";
import { setLayoutParams } from "./layout";
import { initShortcuts } from "./shortcuts";
import { initEmptyState } from "./empty-state";
import { createHistory } from "./history";
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

  // --- Undo/redo ---
  const undoHistory = createHistory();

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

  /** Snapshot current state, then save. Call this instead of save() for undoable actions. */
  async function undoableSave() {
    if (currentData) undoHistory.push(currentData);
    await save();
  }

  async function applyState(data: LearningGraphData) {
    currentData = data;
    await saveOntology(activeOntology, currentData);
    canvas.loadGraph(currentData);
    search.setLearningGraphData(currentData);
    toolsPane.setData(currentData);
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
      undoHistory.push(currentData);
      const node = currentData.nodes.find((n) => n.id === nodeId);
      if (!node) return;
      node.properties = { ...node.properties, ...properties };
      node.updatedAt = new Date().toISOString();
      save().then(() => infoPanel.show([nodeId], currentData!));
    },

    onChangeNodeType(nodeId, newType) {
      if (!currentData) return;
      undoHistory.push(currentData);
      const node = currentData.nodes.find((n) => n.id === nodeId);
      if (!node) return;
      node.type = newType;
      node.updatedAt = new Date().toISOString();
      save().then(() => infoPanel.show([nodeId], currentData!));
    },

    onDeleteNode(nodeId) {
      if (!currentData) return;
      undoHistory.push(currentData);
      currentData.nodes = currentData.nodes.filter((n) => n.id !== nodeId);
      currentData.edges = currentData.edges.filter(
        (e) => e.sourceId !== nodeId && e.targetId !== nodeId
      );
      save();
    },

    onDeleteEdge(edgeId) {
      if (!currentData) return;
      undoHistory.push(currentData);
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
      undoHistory.push(currentData);
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
      updateUrl(activeOntology, nodeIds);
    } else {
      infoPanel.hide();
      if (activeOntology) updateUrl(activeOntology);
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
      undoHistory.push(currentData);
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
      undoHistory.push(currentData);
      for (const edge of currentData.edges) {
        if (edge.type === oldType) {
          edge.type = newType;
        }
      }
      save();
    },
    onToggleEdgeLabels(visible) {
      canvas.setEdgeLabels(visible);
    },
    onToggleTypeHulls(visible) {
      canvas.setTypeHulls(visible);
    },
    onToggleMinimap(visible) {
      canvas.setMinimap(visible);
    },
    onLayoutChange(param, value) {
      setLayoutParams({ [param]: value });
      canvas.reheat();
    },
    onExport(format) {
      const dataUrl = canvas.exportImage(format);
      if (!dataUrl) return;
      const link = document.createElement("a");
      link.download = `${activeOntology || "graph"}.${format}`;
      link.href = dataUrl;
      link.click();
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
      onSelect: (name) => selectGraph(name),
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

  const shortcuts = initShortcuts(canvasContainer);
  const emptyState = initEmptyState(canvasContainer);

  // --- URL deep linking ---
  function updateUrl(name: string, nodeIds?: string[] | null) {
    const hash = "#" + encodeURIComponent(name) +
      (nodeIds?.length ? "?node=" + nodeIds.map(encodeURIComponent).join(",") : "");
    history.replaceState(null, "", hash);
  }

  function parseUrl(): { graph: string | null; nodes: string[] } {
    const hash = window.location.hash.slice(1);
    if (!hash) return { graph: null, nodes: [] };
    const [graphPart, queryPart] = hash.split("?");
    const graph = graphPart ? decodeURIComponent(graphPart) : null;
    let nodes: string[] = [];
    if (queryPart) {
      const params = new URLSearchParams(queryPart);
      const nodeParam = params.get("node");
      if (nodeParam) nodes = nodeParam.split(",").map(decodeURIComponent);
    }
    return { graph, nodes };
  }

  async function selectGraph(name: string, focusNodeIds?: string[]) {
    activeOntology = name;
    sidebar.setActive(name);
    infoPanel.hide();
    search.clear();
    undoHistory.clear();
    currentData = await loadOntology(name);
    canvas.loadGraph(currentData);
    search.setLearningGraphData(currentData);
    toolsPane.setData(currentData);
    emptyState.hide();
    updateUrl(name);

    // Focus on specific nodes if requested
    if (focusNodeIds?.length && currentData) {
      const validIds = focusNodeIds.filter((id) =>
        currentData!.nodes.some((n) => n.id === id)
      );
      if (validIds.length) {
        setTimeout(() => {
          canvas.panToNodes(validIds);
          if (currentData) infoPanel.show(validIds, currentData);
          updateUrl(name, validIds);
        }, 500);
      }
    }
  }

  // Load ontology list
  const summaries = await listOntologies();
  sidebar.setSummaries(summaries);

  // Auto-load from URL hash, or first graph
  const initialUrl = parseUrl();
  const initialName = initialUrl.graph && summaries.some((s) => s.name === initialUrl.graph)
    ? initialUrl.graph
    : summaries.length > 0
      ? summaries[0].name
      : null;

  if (initialName) {
    await selectGraph(initialName, initialUrl.nodes.length ? initialUrl.nodes : undefined);
  } else {
    emptyState.show();
  }

  // Keyboard shortcuts
  document.addEventListener("keydown", (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

    if (e.key === "/" || (e.key === "k" && (e.metaKey || e.ctrlKey))) {
      e.preventDefault();
      search.focus();
    } else if (e.key === "z" && (e.metaKey || e.ctrlKey) && e.shiftKey) {
      e.preventDefault();
      if (currentData) {
        const restored = undoHistory.redo(currentData);
        if (restored) applyState(restored);
      }
    } else if (e.key === "z" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (currentData) {
        const restored = undoHistory.undo(currentData);
        if (restored) applyState(restored);
      }
    } else if (e.key === "?") {
      shortcuts.show();
    } else if (e.key === "Escape") {
      shortcuts.hide();
    }
  });

  // Handle browser back/forward
  window.addEventListener("hashchange", () => {
    const url = parseUrl();
    if (url.graph && url.graph !== activeOntology) {
      selectGraph(url.graph, url.nodes.length ? url.nodes : undefined);
    } else if (url.graph && url.nodes.length && currentData) {
      const validIds = url.nodes.filter((id) =>
        currentData!.nodes.some((n) => n.id === id)
      );
      if (validIds.length) {
        canvas.panToNodes(validIds);
        infoPanel.show(validIds, currentData);
      }
    }
  });

  // Live reload — when Claude adds nodes via MCP, re-fetch and re-render
  if (import.meta.hot) {
    import.meta.hot.on("ontology-change", async () => {
      const updated = await listOntologies();
      sidebar.setSummaries(updated);

      if (updated.length > 0) emptyState.hide();

      if (activeOntology) {
        try {
          currentData = await loadOntology(activeOntology);
          canvas.loadGraph(currentData);
          search.setLearningGraphData(currentData);
    toolsPane.setData(currentData);
        } catch {
          // Ontology may have been deleted
        }
      } else if (updated.length > 0) {
        activeOntology = updated[0].name;
        sidebar.setActive(activeOntology);
        currentData = await loadOntology(activeOntology);
        canvas.loadGraph(currentData);
        search.setLearningGraphData(currentData);
    toolsPane.setData(currentData);
      }
    });
  }
}

main();
