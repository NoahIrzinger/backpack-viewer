import type { LearningGraphData } from "backpack-ontology";
import {
  listOntologies, loadOntology, saveOntology, renameOntology,
  listBranches, createBranch, switchBranch, deleteBranch,
  listSnapshots, createSnapshot, rollbackSnapshot,
  listSnippets, saveSnippet, loadSnippet, deleteSnippet,
  listRemotes, loadRemote,
  type RemoteSummary,
} from "./api";
import { initSidebar } from "./sidebar";
import { initCanvas, type FocusInfo } from "./canvas";
import { initInfoPanel } from "./info-panel";
import { createPanelMount } from "./extensions/panel-mount";
import { initSearch } from "./search";
import { initToolsPane } from "./tools-pane";
import { setLayoutParams, getLayoutParams, autoLayoutParams } from "./layout";
import { initShortcuts } from "./shortcuts";
import { initEmptyState } from "./empty-state";
import { showToast } from "./dialog";
import { createHistory } from "./history";
import { matchKey, type KeybindingMap } from "./keybindings";
import { initContextMenu } from "./context-menu";
import { initCopyPromptButton } from "./copy-prompt";
import { publishViewerState } from "./bridge";
import { createEventBus } from "./extensions/event-bus";
import { loadExtensions } from "./extensions/loader";
import type { ViewerHost, ViewerFocusSnapshot } from "./extensions/types";
import defaultConfig from "./default-config.json";
import "./style.css";

let activeOntology = "";
let currentData: LearningGraphData | null = null;
let remoteNames = new Set<string>();
let activeIsRemote = false;

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
    eventBus.emit("graph-changed");
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

  // Create the shared panel-mount up front. Both info-panel and the
  // extension loader use this single instance so all panels share the
  // same click-to-front z-stack and the persistent layer DOM element.
  const panelMount = createPanelMount(canvasContainer);

  const infoPanel = initInfoPanel(canvasContainer, panelMount, {
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

    const walkBtn = document.createElement("button");
    walkBtn.className = "walk-indicator";
    if (canvas.getWalkMode()) walkBtn.classList.add("active");
    walkBtn.textContent = "Walk";
    walkBtn.title = "Toggle walk mode (W) — click nodes to traverse";
    walkBtn.addEventListener("click", () => {
      canvas.setWalkMode(!canvas.getWalkMode());
      walkBtn.classList.toggle("active", canvas.getWalkMode());
    });

    focusIndicator.appendChild(label);
    focusIndicator.appendChild(minus);
    focusIndicator.appendChild(hopsLabel);
    focusIndicator.appendChild(plus);
    focusIndicator.appendChild(walkBtn);
    focusIndicator.appendChild(exit);
  }

  function removeFocusIndicator() {
    if (focusIndicator) {
      focusIndicator.remove();
      focusIndicator = null;
    }
  }

  // --- Path bar (appended to bottom-center column later) ---
  const pathBar = document.createElement("div");
  pathBar.className = "path-bar hidden";

  function showPathBar(path: { nodeIds: string[]; edgeIds: string[] }) {
    pathBar.replaceChildren();
    if (!currentData) return;

    for (let i = 0; i < path.nodeIds.length; i++) {
      const nodeId = path.nodeIds[i];
      const node = currentData.nodes.find((n) => n.id === nodeId);
      if (!node) continue;
      const label = Object.values(node.properties).find((v) => typeof v === "string") as string ?? node.id;

      // Edge label before this node (except the first)
      if (i > 0) {
        const edgeId = path.edgeIds[i - 1];
        const edge = currentData.edges.find((e) => e.id === edgeId);
        const arrow = document.createElement("span");
        arrow.className = "path-bar-edge";
        arrow.textContent = edge ? `→ ${edge.type} →` : "→";
        pathBar.appendChild(arrow);
      }

      const nodeBtn = document.createElement("span");
      nodeBtn.className = "path-bar-node";
      nodeBtn.textContent = label;
      nodeBtn.addEventListener("click", () => canvas.panToNode(nodeId));
      pathBar.appendChild(nodeBtn);
    }

    const closeBtn = document.createElement("button");
    closeBtn.className = "path-bar-close";
    closeBtn.textContent = "\u00d7";
    closeBtn.addEventListener("click", hidePathBar);
    pathBar.appendChild(closeBtn);

    pathBar.classList.remove("hidden");
  }

  function hidePathBar() {
    pathBar.classList.add("hidden");
    pathBar.replaceChildren();
    canvas.clearHighlightedPath();
  }

  // Event bus for extensions. Emitted from the same hooks that drive
  // bridge publishing — selection changes, focus enter/exit, graph
  // load, save. Subscribers run synchronously; errors in one don't
  // affect others.
  const eventBus = createEventBus();

  function publishBridgeState() {
    if (!activeOntology) return;
    publishViewerState({
      graph: activeOntology,
      selection: currentSelection,
      focus: canvas?.getFocusInfo() ?? null,
    });
  }

  canvas = initCanvas(canvasContainer, (nodeIds) => {
    currentSelection = nodeIds ?? [];
    publishBridgeState();
    eventBus.emit("selection-changed");
    // Don't touch the path bar when walk mode is active — syncWalkTrail manages it
    if (!canvas.getWalkMode()) {
      if (nodeIds && nodeIds.length === 2) {
        const path = canvas.findPath(nodeIds[0], nodeIds[1]);
        if (path && path.nodeIds.length > 0) {
          canvas.setHighlightedPath(path.nodeIds, path.edgeIds);
          showPathBar(path);
        } else {
          hidePathBar();
        }
      } else {
        hidePathBar();
      }
    }

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
      syncWalkTrail();
    } else {
      removeFocusIndicator();
      infoPanel.setFocusDisabled(false);
      if (activeOntology) updateUrl(activeOntology);
      syncWalkTrail();
    }
    publishBridgeState();
    eventBus.emit("focus-changed");
  }, { lod: cfg.lod, navigation: cfg.navigation, walk: (cfg as any).walk });

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
    onWalkTrailRemove(nodeId) {
      canvas.removeFromWalkTrail(nodeId);
      syncWalkTrail();
    },
    onWalkIsolate() {
      if (!currentData) return;
      const trail = canvas.getWalkTrail();
      if (trail.length === 0) return;
      canvas.enterFocus(trail, 0);
    },
    async onWalkSaveSnippet(label) {
      if (!activeOntology || !currentData) return;
      const trail = canvas.getWalkTrail();
      if (trail.length < 2) return;
      const nodeSet = new Set(trail);
      const edgeIds = currentData.edges
        .filter((e) => nodeSet.has(e.sourceId) && nodeSet.has(e.targetId))
        .map((e) => e.id);
      await saveSnippet(activeOntology, label, trail, edgeIds);
      await refreshSnippets(activeOntology);
    },
    async onStarredSaveSnippet(label, nodeIds) {
      if (!activeOntology || !currentData) return;
      const nodeSet = new Set(nodeIds);
      const edgeIds = currentData.edges
        .filter((e) => nodeSet.has(e.sourceId) && nodeSet.has(e.targetId))
        .map((e) => e.id);
      await saveSnippet(activeOntology, label, nodeIds, edgeIds);
      await refreshSnippets(activeOntology);
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

  // Move zoom controls and theme toggle into right slot
  const zoomControls = canvasContainer.querySelector(".zoom-controls");
  if (zoomControls) topRight.appendChild(zoomControls);

  topRight.appendChild(themeBtn);

  // Extension taskbar slots — four hosted containers, one per
  // supported icon position. The top slots flank the search overlay
  // INSIDE top-center, alongside the copy-prompt button. The viewer's
  // own controls in top-left/top-right (zoom, theme, tools toggle)
  // stay visually separated. Bottom slots float in the canvas
  // corners. All four start hidden — they're invisible until at
  // least one extension registers into them, so empty slots take no
  // space.
  const extSlotTopLeft = document.createElement("div");
  extSlotTopLeft.className = "ext-slot ext-slot-top-left";
  topCenter.appendChild(extSlotTopLeft);

  // Move search overlay into center slot, after the left ext slot so
  // top-center reads: [ext-left, search, ext-right, copy-prompt].
  const searchOverlay = canvasContainer.querySelector(".search-overlay");
  if (searchOverlay) topCenter.appendChild(searchOverlay);

  const extSlotTopRight = document.createElement("div");
  extSlotTopRight.className = "ext-slot ext-slot-top-right";
  topCenter.appendChild(extSlotTopRight);

  // Copy-prompt button — viewer-owned, sits at the rightmost end of
  // the top-center group so any registered ext-right icons (like
  // chat) appear immediately to its left.
  const copyPromptBtn = initCopyPromptButton(() => ({
    graphName: activeOntology,
    data: currentData,
    selection: currentSelection,
    focus: canvas.getFocusInfo(),
  }));
  topCenter.appendChild(copyPromptBtn);

  topBar.appendChild(topLeft);
  topBar.appendChild(topCenter);
  topBar.appendChild(topRight);
  canvasContainer.appendChild(topBar);

  // --- Bottom bar: mirrors top bar structure at the bottom of the canvas ---
  const bottomBar = document.createElement("div");
  bottomBar.className = "canvas-bottom-bar";

  const bottomLeft = document.createElement("div");
  bottomLeft.className = "canvas-bottom-left";

  const bottomCenter = document.createElement("div");
  bottomCenter.className = "canvas-bottom-center";

  const bottomRight = document.createElement("div");
  bottomRight.className = "canvas-bottom-right";

  const extSlotBottomLeft = document.createElement("div");
  extSlotBottomLeft.className = "ext-slot ext-slot-bottom-left";
  bottomLeft.appendChild(extSlotBottomLeft);

  const extSlotBottomCenter = document.createElement("div");
  extSlotBottomCenter.className = "ext-slot ext-slot-bottom-center";
  bottomCenter.appendChild(extSlotBottomCenter);

  bottomCenter.appendChild(pathBar);

  const extSlotBottomRight = document.createElement("div");
  extSlotBottomRight.className = "ext-slot ext-slot-bottom-right";
  bottomRight.appendChild(extSlotBottomRight);

  bottomBar.appendChild(bottomLeft);
  bottomBar.appendChild(bottomCenter);
  bottomBar.appendChild(bottomRight);
  canvasContainer.appendChild(bottomBar);

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
      onSnippetLoad: async (graphName, snippetId) => {
        const snippet = await loadSnippet(graphName, snippetId);
        if (snippet?.nodeIds?.length > 0) {
          canvas.enterFocus(snippet.nodeIds, 0);
        }
      },
      onSnippetDelete: async (graphName, snippetId) => {
        await deleteSnippet(graphName, snippetId);
        await refreshSnippets(graphName);
      },
      onBackpackSwitch: async (name) => {
        await fetch("/api/backpacks/switch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name }),
        });
        // The dev WS will fire an active-backpack-change event that
        // triggers refreshBackpacksAndGraphs(). Production server has no
        // live-reload channel, so we refresh immediately as fallback.
        await refreshBackpacksAndGraphs();
      },
      onBackpackRegister: async (p, activate) => {
        await fetch("/api/backpacks", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: p, activate }),
        });
        await refreshBackpacksAndGraphs();
      },
    }
  );

  async function refreshBackpacksAndGraphs() {
    try {
      const res = await fetch("/api/backpacks");
      const list = await res.json();
      sidebar.setBackpacks(list);
    } catch {}
    // Re-fetch ontology list from the (possibly new) active backpack
    try {
      const updated = await listOntologies();
      sidebar.setSummaries(updated);
      // If the previously-active graph no longer exists, clear it
      if (activeOntology && !updated.some((g) => g.name === activeOntology)) {
        activeOntology = "";
        currentData = null;
        canvas.loadGraph({
          metadata: { name: "", description: "", createdAt: "", updatedAt: "" },
          nodes: [],
          edges: [],
        });
      }
    } catch {}
  }

  function syncWalkTrail() {
    const trail = canvas.getWalkTrail();
    if (!currentData || trail.length === 0) {
      toolsPane.setWalkTrail([]);
      hidePathBar();
      return;
    }

    const edgeIds: string[] = [];
    const items = trail.map((id, i) => {
      const node = currentData!.nodes.find((n) => n.id === id);
      let edgeType: string | undefined;
      if (i > 0) {
        const prevId = trail[i - 1];
        const edge = currentData!.edges.find((e) =>
          (e.sourceId === prevId && e.targetId === id) ||
          (e.targetId === prevId && e.sourceId === id)
        );
        edgeType = edge?.type;
        if (edge) edgeIds.push(edge.id);
      }
      return {
        id,
        label: node ? (Object.values(node.properties).find((v) => typeof v === "string") as string ?? node.id) : id,
        type: node?.type ?? "?",
        edgeType,
      };
    });
    toolsPane.setWalkTrail(items);

    // Show path bar for walk trail
    if (trail.length >= 2) {
      canvas.setHighlightedPath(trail, edgeIds);
      showPathBar({ nodeIds: trail, edgeIds });
    } else {
      hidePathBar();
    }
  }

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

  async function refreshSnippets(graphName: string) {
    const snips = await listSnippets(graphName);
    sidebar.setSnippets(graphName, snips);
  }

  // Insert sidebar expand button into top-left bar (before tools toggle)
  topLeft.insertBefore(sidebar.expandBtn, topLeft.firstChild);

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
    activeIsRemote = remoteNames.has(name);
    sidebar.setActive(name);
    infoPanel.hide();
    removeFocusIndicator();
    search.clear();
    undoHistory.clear();
    currentData = activeIsRemote ? await loadRemote(name) : await loadOntology(name);
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
    publishBridgeState();
    eventBus.emit("graph-switched");
    eventBus.emit("graph-changed");

    // Load branches and snapshots — skipped for remote graphs (read-only,
    // no branch/snapshot/snippet APIs on the remote endpoint)
    if (!activeIsRemote) {
      await refreshBranches(name);
      await refreshSnapshots(name);
      await refreshSnippets(name);
    }

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

  // Detect share mode early — skip all non-share API calls when viewing
  // a shared graph (avoids CSP errors from auth-gated endpoints).
  const isShareMode = new URLSearchParams(window.location.search).has("share");

  if (isShareMode) {
    // Hide sidebar in share mode — recipients see only the graph
    const sidebarEl = document.getElementById("sidebar");
    if (sidebarEl) sidebarEl.style.display = "none";
  }

  if (!isShareMode) {
    // Fetch backpack registry first so the picker shows the right active
    // backpack from the initial render.
    try {
      const res = await fetch("/api/backpacks");
      const list = await res.json();
      sidebar.setBackpacks(list);
    } catch {}

    // Fire-and-forget stale-version check.
    fetch("/api/version-check")
      .then((r) => r.json())
      .then((info: { current: string; latest: string | null; stale: boolean }) => {
        if (info.stale && info.latest) {
          sidebar.setStaleVersionBanner(info.current, info.latest);
        }
      })
      .catch(() => {});
  }

  // --- Share link detection ---
  // If URL has ?share=TOKEN, load from the relay instead of local API.
  // The #k=KEY fragment (if present) is used for client-side decryption.
  const shareParams = new URLSearchParams(window.location.search);
  const shareToken = shareParams.get("share");

  if (shareToken) {
    try {
      const metaRes = await fetch(`/v1/share/${shareToken}/meta`);
      if (!metaRes.ok) throw new Error("Share link not found or expired");
      const meta = await metaRes.json();

      const dataRes = await fetch(`/v1/share/${shareToken}`);
      if (!dataRes.ok) throw new Error("Failed to download shared backpack");

      // The share endpoint returns either:
      // - Raw JSON (plaintext cloud-native graphs) with Content-Type: application/json
      // - BPAK envelope (encrypted or synced graphs) with Content-Type: application/octet-stream
      const contentType = dataRes.headers.get("Content-Type") || "";
      let graphData: LearningGraphData;

      if (contentType.includes("application/json")) {
        // Raw JSON — plaintext graph data, no envelope wrapping
        graphData = await dataRes.json() as LearningGraphData;
      } else {
        // BPAK envelope — parse magic bytes, header, payload
        const envelopeBytes = new Uint8Array(await dataRes.arrayBuffer());
        if (envelopeBytes.length < 9 || envelopeBytes[0] !== 0x42 || envelopeBytes[1] !== 0x50 || envelopeBytes[2] !== 0x41 || envelopeBytes[3] !== 0x4B) {
          throw new Error("Invalid share data");
        }
        const headerLen = new DataView(envelopeBytes.buffer, envelopeBytes.byteOffset, envelopeBytes.byteLength).getUint32(5, false);
        if (9 + headerLen > envelopeBytes.length) throw new Error("Invalid envelope: header length exceeds data");
        const envelopeHeader = JSON.parse(new TextDecoder().decode(envelopeBytes.slice(9, 9 + headerLen)));
        const envelopePayload = envelopeBytes.slice(9 + headerLen);

        if (envelopeHeader.format !== "plaintext") {
          // Encrypted — decrypt client-side using fragment key
          const fragment = window.location.hash.slice(1);
          const keyParam = new URLSearchParams(fragment).get("k") ?? fragment.split("k=")[1];
          if (!keyParam) throw new Error("Missing decryption key in URL fragment");

          const { Decrypter } = await import("age-encryption");
          const secretKey = atob(keyParam.replace(/-/g, "+").replace(/_/g, "/"));

          const d = new Decrypter();
          d.addIdentity(secretKey);
          const plaintext = await d.decrypt(envelopePayload);
          graphData = JSON.parse(new TextDecoder().decode(plaintext));
        } else {
          graphData = JSON.parse(new TextDecoder().decode(envelopePayload));
        }
      }

      // Render in read-only mode
      activeOntology = meta.backpack_name || "Shared Backpack";
      currentData = graphData;
      canvas.loadGraph(graphData);
      search.setLearningGraphData(graphData);
      sidebar.setSummaries([{
        name: activeOntology,
        description: "",
        nodeCount: graphData.nodes?.length ?? 0,
        edgeCount: graphData.edges?.length ?? 0,
        nodeTypes: [],
      }]);
      sidebar.setActive(activeOntology);
      document.title = `${activeOntology} — Backpack`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to load shared backpack";
      showToast(msg, 5000);
      emptyState.show();
    }
  } else {
    // Normal mode — load from local/cloud API
    const [summaries, remotes] = await Promise.all([
      listOntologies(),
      listRemotes().catch(() => [] as RemoteSummary[]),
    ]);
    sidebar.setSummaries(summaries);
    sidebar.setRemotes(remotes);
    remoteNames = new Set(remotes.map((r) => r.name));

    // Auto-load from URL hash, or first graph
    const initialUrl = parseUrl();
    const initialName =
      initialUrl.graph && summaries.some((s) => s.name === initialUrl.graph)
        ? initialUrl.graph
        : initialUrl.graph && remoteNames.has(initialUrl.graph)
          ? initialUrl.graph
          : summaries.length > 0
            ? summaries[0].name
            : remotes.length > 0
              ? remotes[0].name
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
  }

  // --- Extension system ---
  // Load extensions after the viewer is fully initialized so any
  // extension that immediately reads the current graph state gets a
  // populated graph (not a startup race).
  const host: ViewerHost = {
    getGraph: () => currentData,
    getGraphName: () => activeOntology,
    getSelection: () => [...currentSelection],
    getFocus: (): ViewerFocusSnapshot | null => canvas.getFocusInfo(),
    saveCurrentGraph: async () => {
      await save();
    },
    snapshotForUndo: () => {
      if (currentData) undoHistory.push(currentData);
    },
    panToNode: (id) => canvas.panToNode(id),
    focusNodes: (ids, hops) => canvas.enterFocus(ids, hops),
    exitFocus: () => {
      if (canvas.isFocused()) canvas.exitFocus();
    },
    taskbarSlots: {
      topLeft: extSlotTopLeft,
      topRight: extSlotTopRight,
      bottomLeft: extSlotBottomLeft,
      bottomCenter: extSlotBottomCenter,
      bottomRight: extSlotBottomRight,
    },
    subscribe: (event, cb) => eventBus.subscribe(event, cb),
  };

  // Fire-and-forget — extension loading errors don't block startup.
  // Skip in share mode — recipients don't need extensions and the
  // /api/extensions endpoint is auth-gated.
  if (!isShareMode) {
    loadExtensions(host, panelMount).catch((err) => {
      console.error("[backpack-viewer] extension loader failed:", err);
    });
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
    resetPins() {
      const released = canvas.releaseAllPins();
      if (released) showToast("Manual layout reset — pins released");
    },
    walkIsolate() {
      if (!currentData) return;
      const trail = canvas.getWalkTrail();
      if (trail.length === 0) return;
      // Extract a subgraph of only the trail nodes and edges between them, re-layout as a fresh graph
      canvas.enterFocus(trail, 0);
    },
    walkMode() {
      // If not in focus mode, enter focus on current selection first
      if (!canvas.isFocused() && currentSelection.length > 0) {
        toolsPane.addToFocusSet(currentSelection);
      }
      canvas.setWalkMode(!canvas.getWalkMode());
      const walkBtn = canvasContainer.querySelector(".walk-indicator");
      if (walkBtn) walkBtn.classList.toggle("active", canvas.getWalkMode());
      syncWalkTrail();
    },
    escape() {
      // Priority: 1. clear selection, 2. exit focus, 3. hide help modal
      if (canvas.getSelectedNodeIds().length > 0) {
        canvas.clearSelection();
      } else if (canvas.isFocused()) {
        toolsPane.clearFocusSet();
      } else {
        shortcuts.hide();
      }
    },
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
    // Hot-swap when the active backpack changes (via /api/backpacks/switch
    // or the user clicking the picker on another viewer tab)
    import.meta.hot.on("active-backpack-change", async () => {
      await refreshBackpacksAndGraphs();
    });

    import.meta.hot.on("ontology-change", async () => {
      // If the user had manually pinned nodes, the incoming data change
      // is going to reset their layout tweaks. Warn them so they know
      // the change wasn't their fault — this is the one involuntary
      // pin-release case (graph switches and focus toggles are all
      // user-initiated and don't need a toast).
      const hadPins = canvas.hasPinnedNodes();

      const [updated, updatedRemotes] = await Promise.all([
        listOntologies(),
        listRemotes().catch(() => [] as RemoteSummary[]),
      ]);
      sidebar.setSummaries(updated);
      sidebar.setRemotes(updatedRemotes);
      remoteNames = new Set(updatedRemotes.map((r) => r.name));

      if (updated.length > 0 || updatedRemotes.length > 0) emptyState.hide();

      if (activeOntology) {
        try {
          currentData = activeIsRemote
            ? await loadRemote(activeOntology)
            : await loadOntology(activeOntology);
          canvas.loadGraph(currentData);
          search.setLearningGraphData(currentData);
          toolsPane.setData(currentData);
        } catch {
          // Ontology may have been deleted
        }
      } else if (updated.length > 0) {
        activeOntology = updated[0].name;
        activeIsRemote = false;
        sidebar.setActive(activeOntology);
        currentData = await loadOntology(activeOntology);
        canvas.loadGraph(currentData);
        search.setLearningGraphData(currentData);
        toolsPane.setData(currentData);
      }

      if (hadPins) {
        showToast("Manual layout reset — new data arrived");
      }
    });
  }
}

main();
