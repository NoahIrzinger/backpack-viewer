import type { LearningGraphData } from "backpack-ontology";
import {
  listOntologies, loadOntology, saveOntology, renameOntology,
  listBranches, createBranch, switchBranch, deleteBranch,
  listSnapshots, createSnapshot, rollbackSnapshot,
} from "./api";
import { initSidebar } from "./sidebar";
import { initCanvas, type FocusInfo } from "./canvas";
import { initInfoPanel } from "./info-panel";
import { initSearch } from "./search";
import { initToolsPane } from "./tools-pane";
import { setLayoutParams, getLayoutParams, autoLayoutParams } from "./layout";
import { initShortcuts } from "./shortcuts";
import { initEmptyState } from "./empty-state";
import { createHistory } from "./history";
import { matchKey, type KeybindingMap } from "./keybindings";
import { initContextMenu } from "./context-menu";
import defaultConfig from "./default-config.json";
import "./style.css";

let activeOntology = "";
let currentData: LearningGraphData | null = null;

async function main() {
  const canvasContainer = document.getElementById("canvas-container")!;

  // --- Load config ---
  const cfg = { ...defaultConfig } as typeof defaultConfig;
  try {
    const res = await fetch("/api/config");
    if (res.ok) {
      const user = await res.json();
      Object.assign(cfg.keybindings, user.keybindings ?? {});
      Object.assign(cfg.display, user.display ?? {});
      Object.assign(cfg.layout, user.layout ?? {});
      Object.assign(cfg.navigation, user.navigation ?? {});
      Object.assign(cfg.lod, user.lod ?? {});
      Object.assign(cfg.limits, user.limits ?? {});
    }
  } catch { /* use defaults */ }
  const bindings = cfg.keybindings as KeybindingMap;

  // --- Theme toggle (top-right of canvas) ---
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)");
  const themeDefault = cfg.display.theme === "system"
    ? (prefersDark.matches ? "dark" : "light")
    : cfg.display.theme;
  const stored = localStorage.getItem("backpack-theme");
  const initial = stored ?? themeDefault;
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
  }, (nodeIds) => {
    toolsPane.addToFocusSet(nodeIds);
  });

  const mobileQuery = window.matchMedia("(max-width: 768px)");

  // Track current selection for keyboard shortcuts
  let currentSelection: string[] = [];
  let edgesVisible = cfg.display.edges;
  let panSpeed = cfg.navigation.panSpeed;
  let viewCycleIndex = -1;

  // --- Focus indicator (top bar pill) ---
  let focusIndicator: HTMLElement | null = null;

  function buildFocusIndicator(info: FocusInfo) {
    if (focusIndicator) focusIndicator.remove();

    focusIndicator = document.createElement("div");
    focusIndicator.className = "focus-indicator";

    const label = document.createElement("span");
    label.className = "focus-indicator-label";
    label.textContent = `Focused: ${info.totalNodes} nodes`;

    const hopsLabel = document.createElement("span");
    hopsLabel.className = "focus-indicator-hops";
    hopsLabel.textContent = `${info.hops}`;

    const minus = document.createElement("button");
    minus.className = "focus-indicator-btn";
    minus.textContent = "\u2212";
    minus.title = "Fewer hops";
    minus.disabled = info.hops === 0;
    minus.addEventListener("click", () => {
      canvas.enterFocus(info.seedNodeIds, Math.max(0, info.hops - 1));
    });

    const plus = document.createElement("button");
    plus.className = "focus-indicator-btn";
    plus.textContent = "+";
    plus.title = "More hops";
    plus.disabled = false;
    plus.addEventListener("click", () => {
      canvas.enterFocus(info.seedNodeIds, info.hops + 1);
    });

    const exit = document.createElement("button");
    exit.className = "focus-indicator-btn focus-indicator-exit";
    exit.textContent = "\u00d7";
    exit.title = "Exit focus (Esc)";
    exit.addEventListener("click", () => toolsPane.clearFocusSet());

    focusIndicator.appendChild(label);
    focusIndicator.appendChild(minus);
    focusIndicator.appendChild(hopsLabel);
    focusIndicator.appendChild(plus);
    focusIndicator.appendChild(exit);
  }

  function removeFocusIndicator() {
    if (focusIndicator) {
      focusIndicator.remove();
      focusIndicator = null;
    }
  }

  canvas = initCanvas(canvasContainer, (nodeIds) => {
    currentSelection = nodeIds ?? [];
    if (nodeIds && nodeIds.length > 0 && currentData) {
      infoPanel.show(nodeIds, currentData);
      if (mobileQuery.matches) toolsPane.collapse();
      updateUrl(activeOntology, nodeIds);
    } else {
      infoPanel.hide();
      if (activeOntology) updateUrl(activeOntology);
    }
  }, (focus) => {
    if (focus) {
      buildFocusIndicator(focus);
      const topLeft = canvasContainer.querySelector(".canvas-top-left");
      if (topLeft && focusIndicator) topLeft.appendChild(focusIndicator);
      updateUrl(activeOntology, focus.seedNodeIds);
      infoPanel.setFocusDisabled(focus.hops === 0);
    } else {
      removeFocusIndicator();
      infoPanel.setFocusDisabled(false);
      if (activeOntology) updateUrl(activeOntology);
    }
  }, { lod: cfg.lod, navigation: cfg.navigation });

  const search = initSearch(canvasContainer, {
    maxResults: cfg.limits.maxSearchResults,
    debounceMs: cfg.limits.searchDebounceMs,
  });
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
    onFocusChange(seedNodeIds) {
      if (seedNodeIds && seedNodeIds.length > 0) {
        canvas.enterFocus(seedNodeIds, 0);
      } else {
        if (canvas.isFocused()) canvas.exitFocus();
      }
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
    onPanSpeedChange(speed) {
      panSpeed = speed;
    },
    onExport(format) {
      const dataUrl = canvas.exportImage(format);
      if (!dataUrl) return;
      const link = document.createElement("a");
      link.download = `${activeOntology || "graph"}.${format}`;
      link.href = dataUrl;
      link.click();
    },
    onSnapshot: async (label) => {
      if (!activeOntology) return;
      await createSnapshot(activeOntology, label);
      await refreshSnapshots(activeOntology);
    },
    onRollback: async (version) => {
      if (!activeOntology) return;
      await rollbackSnapshot(activeOntology, version);
      currentData = await loadOntology(activeOntology);
      canvas.loadGraph(currentData);
      search.setLearningGraphData(currentData);
      toolsPane.setData(currentData);
      await refreshSnapshots(activeOntology);
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
    // If focused and the node isn't in the subgraph, exit focus first
    if (canvas.isFocused()) {
      toolsPane.clearFocusSet();
    }
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
      onBranchSwitch: async (graphName, branchName) => {
        await switchBranch(graphName, branchName);
        await refreshBranches(graphName);
        currentData = await loadOntology(graphName);
        canvas.loadGraph(currentData);
        search.setLearningGraphData(currentData);
        toolsPane.setData(currentData);
        await refreshSnapshots(graphName);
      },
      onBranchCreate: async (graphName, branchName) => {
        await createBranch(graphName, branchName);
        await refreshBranches(graphName);
      },
      onBranchDelete: async (graphName, branchName) => {
        await deleteBranch(graphName, branchName);
        await refreshBranches(graphName);
      },
    }
  );

  async function refreshBranches(graphName: string) {
    const branches = await listBranches(graphName);
    const active = branches.find((b) => b.active);
    if (active) {
      sidebar.setActiveBranch(graphName, active.name, branches);
    }
  }

  async function refreshSnapshots(graphName: string) {
    const snaps = await listSnapshots(graphName);
    toolsPane.setSnapshots(snaps);
  }

  const shortcuts = initShortcuts(canvasContainer, bindings);
  const emptyState = initEmptyState(canvasContainer);

  // Context menu (right-click on nodes)
  const contextMenu = initContextMenu(canvasContainer, {
    onStar(nodeId) {
      if (!currentData) return;
      const node = currentData.nodes.find((n) => n.id === nodeId);
      if (!node) return;
      const starred = node.properties._starred === true;
      node.properties._starred = !starred;
      saveOntology(activeOntology, currentData);
      canvas.loadGraph(currentData);
    },
    onFocusNode(nodeId) {
      toolsPane.addToFocusSet([nodeId]);
    },
    onExploreInBranch(nodeId) {
      // Create a branch and enter focus
      if (activeOntology) {
        const branchName = `explore-${nodeId.slice(0, 8)}`;
        createBranch(activeOntology, branchName).then(() => {
          switchBranch(activeOntology, branchName).then(() => {
            canvas.enterFocus([nodeId], 1);
          });
        });
      }
    },
    onCopyId(nodeId) {
      navigator.clipboard.writeText(nodeId);
    },
  });

  // Right-click handler for context menu
  canvasContainer.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    const canvasEl = canvasContainer.querySelector("canvas");
    if (!canvasEl || !currentData) return;
    const rect = canvasEl.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const hit = canvas.nodeAtScreen(x, y);
    if (!hit) return;
    const node = currentData.nodes.find((n: any) => n.id === hit.id);
    if (!node) return;
    const label = Object.values(node.properties).find((v) => typeof v === "string") as string ?? node.id;
    const isStarred = node.properties._starred === true;
    contextMenu.show(node.id, label, isStarred, e.clientX - rect.left, e.clientY - rect.top);
  });

  // Apply display defaults from config
  if (!cfg.display.edges) canvas.setEdges(false);
  if (!cfg.display.edgeLabels) canvas.setEdgeLabels(false);
  if (!cfg.display.typeHulls) canvas.setTypeHulls(false);
  if (!cfg.display.minimap) canvas.setMinimap(false);

  // --- URL deep linking ---
  function updateUrl(name: string, nodeIds?: string[] | null) {
    const parts: string[] = [];
    if (nodeIds?.length) {
      parts.push("node=" + nodeIds.map(encodeURIComponent).join(","));
    }
    const focusInfo = canvas.getFocusInfo();
    if (focusInfo) {
      parts.push("focus=" + focusInfo.seedNodeIds.map(encodeURIComponent).join(","));
      parts.push("hops=" + focusInfo.hops);
    }
    const hash = "#" + encodeURIComponent(name) +
      (parts.length ? "?" + parts.join("&") : "");
    history.replaceState(null, "", hash);
  }

  function parseUrl(): { graph: string | null; nodes: string[]; focus: string[]; hops: number } {
    const hash = window.location.hash.slice(1);
    if (!hash) return { graph: null, nodes: [], focus: [], hops: 1 };
    const [graphPart, queryPart] = hash.split("?");
    const graph = graphPart ? decodeURIComponent(graphPart) : null;
    let nodes: string[] = [];
    let focus: string[] = [];
    let hops = 1;
    if (queryPart) {
      const params = new URLSearchParams(queryPart);
      const nodeParam = params.get("node");
      if (nodeParam) nodes = nodeParam.split(",").map(decodeURIComponent);
      const focusParam = params.get("focus");
      if (focusParam) focus = focusParam.split(",").map(decodeURIComponent);
      const hopsParam = params.get("hops");
      if (hopsParam) hops = Math.max(0, parseInt(hopsParam, 10) || 1);
    }
    return { graph, nodes, focus, hops };
  }

  async function selectGraph(
    name: string,
    panToNodeIds?: string[],
    focusSeedIds?: string[],
    focusHops?: number
  ) {
    activeOntology = name;
    sidebar.setActive(name);
    infoPanel.hide();
    removeFocusIndicator();
    search.clear();
    undoHistory.clear();
    currentData = await loadOntology(name);
    const autoParams = autoLayoutParams(currentData.nodes.length);
    setLayoutParams({
      spacing: Math.max(cfg.layout.spacing, autoParams.spacing),
      clusterStrength: Math.max(cfg.layout.clustering, autoParams.clusterStrength),
    });
    canvas.loadGraph(currentData);
    search.setLearningGraphData(currentData);
    toolsPane.setData(currentData);
    emptyState.hide();
    updateUrl(name);

    // Load branches and snapshots
    await refreshBranches(name);
    await refreshSnapshots(name);

    // Restore focus mode if requested
    if (focusSeedIds?.length && currentData) {
      const validFocus = focusSeedIds.filter((id) =>
        currentData!.nodes.some((n) => n.id === id)
      );
      if (validFocus.length) {
        setTimeout(() => {
          canvas.enterFocus(validFocus, focusHops ?? 1);
        }, 500);
        return; // enterFocus handles the URL update
      }
    }

    // Pan to specific nodes if requested
    if (panToNodeIds?.length && currentData) {
      const validIds = panToNodeIds.filter((id) =>
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
    await selectGraph(
      initialName,
      initialUrl.nodes.length ? initialUrl.nodes : undefined,
      initialUrl.focus.length ? initialUrl.focus : undefined,
      initialUrl.hops
    );
  } else {
    emptyState.show();
  }

  // Keyboard shortcuts — dispatched via configurable bindings
  const actions: Record<string, () => void> = {
    search() { search.focus(); },
    searchAlt() { search.focus(); },
    undo() { if (currentData) { const r = undoHistory.undo(currentData); if (r) applyState(r); } },
    redo() { if (currentData) { const r = undoHistory.redo(currentData); if (r) applyState(r); } },
    focus() {
      if (canvas.isFocused()) { toolsPane.clearFocusSet(); }
      else if (currentSelection.length > 0) { toolsPane.addToFocusSet(currentSelection); }
    },
    hopsDecrease() { const i = canvas.getFocusInfo(); if (i && i.hops > 0) canvas.enterFocus(i.seedNodeIds, i.hops - 1); },
    hopsIncrease() { const i = canvas.getFocusInfo(); if (i) canvas.enterFocus(i.seedNodeIds, i.hops + 1); },
    nextNode() {
      const ids = canvas.getNodeIds();
      if (ids.length > 0) { viewCycleIndex = (viewCycleIndex + 1) % ids.length; canvas.panToNode(ids[viewCycleIndex]); if (currentData) infoPanel.show([ids[viewCycleIndex]], currentData); }
    },
    prevNode() {
      const ids = canvas.getNodeIds();
      if (ids.length > 0) { viewCycleIndex = viewCycleIndex <= 0 ? ids.length - 1 : viewCycleIndex - 1; canvas.panToNode(ids[viewCycleIndex]); if (currentData) infoPanel.show([ids[viewCycleIndex]], currentData); }
    },
    nextConnection() { const id = infoPanel.cycleConnection(1); if (id) canvas.panToNode(id); },
    prevConnection() { const id = infoPanel.cycleConnection(-1); if (id) canvas.panToNode(id); },
    historyBack() { infoPanel.goBack(); },
    historyForward() { infoPanel.goForward(); },
    center() { canvas.centerView(); },
    toggleEdges() { edgesVisible = !edgesVisible; canvas.setEdges(edgesVisible); },
    panLeft() { canvas.panBy(-panSpeed, 0); },
    panDown() { canvas.panBy(0, panSpeed); },
    panUp() { canvas.panBy(0, -panSpeed); },
    panRight() { canvas.panBy(panSpeed, 0); },
    panFastLeft() { canvas.panBy(-panSpeed * cfg.navigation.panFastMultiplier, 0); },
    zoomOut() { canvas.zoomBy(1 / cfg.navigation.zoomFactor); },
    zoomIn() { canvas.zoomBy(cfg.navigation.zoomFactor); },
    panFastRight() { canvas.panBy(panSpeed * cfg.navigation.panFastMultiplier, 0); },
    spacingDecrease() { const p = getLayoutParams(); setLayoutParams({ spacing: Math.max(0.5, p.spacing - 0.5) }); canvas.reheat(); },
    spacingIncrease() { const p = getLayoutParams(); setLayoutParams({ spacing: Math.min(20, p.spacing + 0.5) }); canvas.reheat(); },
    clusteringDecrease() { const p = getLayoutParams(); setLayoutParams({ clusterStrength: Math.max(0, p.clusterStrength - 0.03) }); canvas.reheat(); },
    clusteringIncrease() { const p = getLayoutParams(); setLayoutParams({ clusterStrength: Math.min(1, p.clusterStrength + 0.03) }); canvas.reheat(); },
    help() { shortcuts.toggle(); },
    toggleSidebar() { sidebar.toggle(); },
    walkMode() { canvas.setWalkMode(!canvas.getWalkMode()); },
    escape() { if (canvas.isFocused()) { toolsPane.clearFocusSet(); } else { shortcuts.hide(); } },
  };

  document.addEventListener("keydown", (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

    for (const [action, binding] of Object.entries(bindings)) {
      if (matchKey(e, binding)) {
        const needsPrevent = action === "search" || action === "searchAlt" || action === "undo" || action === "redo" || action === "toggleSidebar";
        if (needsPrevent) e.preventDefault();
        actions[action]?.();
        return;
      }
    }
  });

  // Handle browser back/forward
  window.addEventListener("hashchange", () => {
    const url = parseUrl();
    if (url.graph && url.graph !== activeOntology) {
      selectGraph(
        url.graph,
        url.nodes.length ? url.nodes : undefined,
        url.focus.length ? url.focus : undefined,
        url.hops
      );
    } else if (url.graph && url.focus.length && currentData) {
      canvas.enterFocus(url.focus, url.hops);
    } else if (url.graph && url.nodes.length && currentData) {
      if (canvas.isFocused()) canvas.exitFocus();
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
