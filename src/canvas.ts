import type { LearningGraphData } from "backpack-ontology";
import { createLayout, extractSubgraph, tick, getLayoutParams, type LayoutState, type LayoutNode } from "./layout";
import { getColor } from "./colors";
import { SpatialHash } from "./spatial-hash";
import { drawCachedLabel, clearLabelCache } from "./label-cache";

interface Camera {
  x: number;
  y: number;
  scale: number;
}

/** Read a CSS custom property from :root. */
function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

const NODE_RADIUS = 20;
const ALPHA_MIN = 0.001;

export interface CanvasConfig {
  lod?: { hideBadges?: number; hideLabels?: number; hideEdgeLabels?: number; smallNodes?: number; hideArrows?: number; dotNodes?: number; hullsOnly?: number };
  navigation?: { zoomFactor?: number; zoomMin?: number; zoomMax?: number; panAnimationMs?: number };
  walk?: { pulseSpeed?: number };
}

// Defaults — overridden per-instance via config
const LOD_DEFAULTS = { hideBadges: 0.4, hideLabels: 0.25, hideEdgeLabels: 0.35, smallNodes: 0.2, hideArrows: 0.15, dotNodes: 0.1, hullsOnly: 0.05 };
const NAV_DEFAULTS = { zoomFactor: 1.3, zoomMin: 0.05, zoomMax: 10, panAnimationMs: 300 };

/** Check if a point is within the visible viewport (with padding). */
function isInViewport(
  x: number, y: number,
  camera: { x: number; y: number; scale: number },
  canvasW: number, canvasH: number,
  pad: number = 100
): boolean {
  const sx = (x - camera.x) * camera.scale;
  const sy = (y - camera.y) * camera.scale;
  return sx >= -pad && sx <= canvasW + pad && sy >= -pad && sy <= canvasH + pad;
}

export interface FocusInfo {
  seedNodeIds: string[];
  hops: number;
  totalNodes: number;
}

export function initCanvas(
  container: HTMLElement,
  onNodeClick?: (nodeIds: string[] | null) => void,
  onFocusChange?: (focus: FocusInfo | null) => void,
  config?: CanvasConfig
) {
  const lod = { ...LOD_DEFAULTS, ...(config?.lod ?? {}) };
  const nav = { ...NAV_DEFAULTS, ...(config?.navigation ?? {}) };
  const walkCfg = { pulseSpeed: 0.02, ...(config?.walk ?? {}) };

  const canvas = container.querySelector("canvas") as HTMLCanvasElement;
  const ctx = canvas.getContext("2d")!;
  const dpr = window.devicePixelRatio || 1;

  let camera: Camera = { x: 0, y: 0, scale: 1 };
  let state: LayoutState | null = null;
  let alpha = 1;
  let animFrame = 0;
  let selectedNodeIds: Set<string> = new Set();
  let filteredNodeIds: Set<string> | null = null; // null = no filter (show all)
  let showEdges = true;
  let showEdgeLabels = true;
  let showTypeHulls = true;
  let showMinimap = true;

  // --- Drag state (node pinning + multi-drag + rubber-band select) ---
  // `dragMode` is the discriminator. "pending" means mousedown happened
  // but we haven't moved enough yet to commit to a gesture — could turn
  // into "pan", "nodeDrag", "rubberBand", or just a click on mouseup.
  type DragMode = "idle" | "pending" | "pan" | "nodeDrag" | "rubberBand";
  let dragMode: DragMode = "idle";
  // Node(s) being dragged, with their starting world positions so the
  // mouse delta can translate a whole selection as a rigid body.
  let dragNodes: Array<{ node: LayoutNode; startX: number; startY: number }> = [];
  // World coords of the cursor when the drag started — used to compute
  // how far the dragged group should move each mousemove.
  let dragStartWorldX = 0;
  let dragStartWorldY = 0;
  // Rubber-band rectangle in world coords during shift-drag on empty canvas.
  let rubberBand: { x1: number; y1: number; x2: number; y2: number } | null = null;
  // IDs of nodes that currently have `pinned: true`. Tracked here for
  // rendering the pin indicator without scanning the full nodes array.
  let pinnedNodeIds: Set<string> = new Set();
  // Pixels the cursor must move between mousedown and mousemove before
  // the gesture is promoted from "click" to "drag". Matches pan threshold.
  const CLICK_DRAG_THRESHOLD = 5;

  // Focus mode state
  let lastLoadedData: LearningGraphData | null = null;
  let focusSeedIds: string[] | null = null;
  let focusHops = 1;
  let savedFullState: LayoutState | null = null;
  let savedFullCamera: Camera | null = null;

  // Highlighted path state (for path finding visualization)
  let highlightedPath: { nodeIds: Set<string>; edgeIds: Set<string> } | null = null;

  // Walk mode state
  let walkMode = false;
  let walkTrail: string[] = []; // node IDs visited during walk, most recent last
  let pulsePhase = 0; // animation counter for pulse effect

  // Entrance animation state
  let loadTime = 0;
  const ENTRANCE_DURATION = 400; // ms

  // Spatial hash for O(1) hit testing — cell size = 2× node radius
  const nodeHash = new SpatialHash<LayoutNode>(NODE_RADIUS * 2);

  // Render coalescing — multiple requestRedraw() calls per frame result in one render()
  let renderPending = 0;
  function requestRedraw(): void {
    invalidateSceneCache();
    if (!renderPending) renderPending = requestAnimationFrame(() => { renderPending = 0; render(); });
  }

  // Layout Web Worker — offloads physics simulation from the main thread.
  // For small graphs (< WORKER_THRESHOLD nodes), runs on main thread to avoid overhead.
  const WORKER_THRESHOLD = 150;
  let layoutWorker: Worker | null = null;
  let useWorker = false;

  function getWorker(): Worker | null {
    if (!layoutWorker) {
      try {
        layoutWorker = new Worker(new URL("./layout-worker.js", import.meta.url), { type: "module" });
        layoutWorker.onmessage = onWorkerMessage;
        layoutWorker.onerror = () => {
          // Worker failed to load — fall back to main-thread layout
          useWorker = false;
          layoutWorker = null;
          simulate();
        };
      } catch {
        useWorker = false;
        return null;
      }
    }
    return layoutWorker;
  }

  function onWorkerMessage(e: MessageEvent) {
    const msg = e.data;
    if (msg.type === "tick" && state) {
      const positions: Float64Array = msg.positions;
      const nodes = state.nodes;
      for (let i = 0; i < nodes.length; i++) {
        nodes[i].x = positions[i * 4];
        nodes[i].y = positions[i * 4 + 1];
        nodes[i].vx = positions[i * 4 + 2];
        nodes[i].vy = positions[i * 4 + 3];
      }
      alpha = msg.alpha;
      nodeHash.rebuild(nodes);
      render();
    }
    if (msg.type === "settled") {
      alpha = 0;
      if (walkMode && walkTrail.length > 0 && !walkAnimFrame) {
        walkAnimFrame = requestAnimationFrame(walkAnimate);
      }
    }
  }

  // Scene cache — avoids full redraws during walk pulse animation.
  // When the graph is settled, we snapshot the rendered scene (minus walk effects)
  // to an OffscreenCanvas. Walk animate then composites cache + draws pulse overlay.
  let sceneCache: OffscreenCanvas | null = null;
  let sceneCacheCtx: OffscreenCanvasRenderingContext2D | null = null;
  let sceneCacheDirty = true;

  function invalidateSceneCache(): void {
    sceneCacheDirty = true;
  }

  // Pan animation state
  let panTarget: { x: number; y: number } | null = null;
  let panStart: { x: number; y: number; time: number } | null = null;
  const PAN_DURATION = nav.panAnimationMs;

  // --- Sizing ---

  function resize() {
    canvas.width = canvas.clientWidth * dpr;
    canvas.height = canvas.clientHeight * dpr;
    invalidateSceneCache();
    requestRedraw();
  }

  const observer = new ResizeObserver(resize);
  observer.observe(container);
  resize();

  // --- Coordinate transforms ---

  function screenToWorld(sx: number, sy: number): [number, number] {
    return [
      sx / camera.scale + camera.x,
      sy / camera.scale + camera.y,
    ];
  }

  // --- Hit testing ---

  function nodeAtScreen(sx: number, sy: number): LayoutNode | null {
    if (!state) return null;
    const [wx, wy] = screenToWorld(sx, sy);
    return nodeHash.query(wx, wy, NODE_RADIUS);
  }

  // --- Rendering ---

  /** Draw only walk pulse effects (edges + node glows) + minimap on top of cached scene. */
  /**
   * Draw the rubber-band selection rectangle in world coords, if active.
   * Intended to be called AFTER the main scene has been drawn and
   * AFTER the camera transform has been applied (so the rect is in
   * world space). Idempotent when no rubber-band is active.
   */
  function drawRubberBandIfActive() {
    if (!rubberBand) return;
    ctx.save();
    const minX = Math.min(rubberBand.x1, rubberBand.x2);
    const maxX = Math.max(rubberBand.x1, rubberBand.x2);
    const minY = Math.min(rubberBand.y1, rubberBand.y2);
    const maxY = Math.max(rubberBand.y1, rubberBand.y2);
    ctx.strokeStyle = cssVar("--accent") || "#d4a27f";
    ctx.fillStyle = cssVar("--accent") || "#d4a27f";
    ctx.globalAlpha = 0.12;
    ctx.fillRect(minX, minY, maxX - minX, maxY - minY);
    ctx.globalAlpha = 0.8;
    ctx.lineWidth = 1 / Math.max(camera.scale, 0.5);
    ctx.setLineDash([6 / Math.max(camera.scale, 0.5), 4 / Math.max(camera.scale, 0.5)]);
    ctx.strokeRect(minX, minY, maxX - minX, maxY - minY);
    ctx.setLineDash([]);
    ctx.restore();
  }

  function renderWalkOverlay() {
    if (!state) return;
    pulsePhase += walkCfg.pulseSpeed;
    const walkTrailSet = new Set(walkTrail);

    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Composite cached scene
    if (sceneCache) {
      ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
      ctx.drawImage(sceneCache, 0, 0, canvas.clientWidth, canvas.clientHeight);
    }

    ctx.save();
    ctx.translate(-camera.x * camera.scale, -camera.y * camera.scale);
    ctx.scale(camera.scale, camera.scale);

    // Walk edge pulse — redraw only walk trail edges
    const walkEdgeColor = cssVar("--canvas-walk-edge") || "#1a1a1a";
    const walkLines: number[] = [];
    for (const edge of state.edges) {
      if (!walkTrailSet.has(edge.sourceId) || !walkTrailSet.has(edge.targetId)) continue;
      if (edge.sourceId === edge.targetId) continue;
      const source = state.nodeMap.get(edge.sourceId);
      const target = state.nodeMap.get(edge.targetId);
      if (!source || !target) continue;
      walkLines.push(source.x, source.y, target.x, target.y);
    }
    if (walkLines.length > 0) {
      ctx.beginPath();
      for (let i = 0; i < walkLines.length; i += 4) {
        ctx.moveTo(walkLines[i], walkLines[i + 1]);
        ctx.lineTo(walkLines[i + 2], walkLines[i + 3]);
      }
      ctx.strokeStyle = walkEdgeColor;
      ctx.lineWidth = 3;
      ctx.globalAlpha = 0.5 + 0.5 * Math.sin(pulsePhase);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // Walk node glows
    const r = camera.scale < lod.smallNodes ? NODE_RADIUS * 0.5 : NODE_RADIUS;
    const accent = cssVar("--accent") || "#d4a27f";
    for (const nodeId of walkTrail) {
      const node = state.nodeMap.get(nodeId);
      if (!node) continue;
      if (!isInViewport(node.x, node.y, camera, canvas.clientWidth, canvas.clientHeight)) continue;
      const isCurrent = nodeId === walkTrail[walkTrail.length - 1];
      const pulse = 0.5 + 0.5 * Math.sin(pulsePhase);
      ctx.strokeStyle = accent;
      ctx.lineWidth = isCurrent ? 3 : 2;
      ctx.globalAlpha = isCurrent ? 0.5 + 0.5 * pulse : 0.3 + 0.4 * pulse;
      ctx.beginPath();
      ctx.arc(node.x, node.y, r + (isCurrent ? 6 : 4), 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // Rubber-band overlay (still inside the world-transform save/restore)
    drawRubberBandIfActive();

    ctx.restore();

    // Minimap
    if (showMinimap && state.nodes.length > 1) {
      drawMinimap();
    }

    ctx.restore();
  }

  function render() {
    if (!state) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }

    // Fast path: walk-only animation with valid scene cache
    if (!sceneCacheDirty && sceneCache && walkMode && walkTrail.length > 0 && alpha < ALPHA_MIN) {
      renderWalkOverlay();
      return;
    }

    // Determine if we should cache the scene (settled + walk mode active).
    // When caching, we skip walk effects so the cache is a clean base layer.
    const shouldCache = alpha < ALPHA_MIN && walkMode && walkTrail.length > 0;

    // Advance pulse animation for walk mode
    if (walkMode && walkTrail.length > 0) {
      pulsePhase += walkCfg.pulseSpeed;
    }
    const walkTrailSet = (walkMode && !shouldCache) ? new Set(walkTrail) : null;

    // Read theme colors from CSS variables each frame
    const edgeColor = cssVar("--canvas-edge");
    const edgeHighlight = cssVar("--canvas-edge-highlight");
    const edgeDimColor = cssVar("--canvas-edge-dim");
    const edgeLabel = cssVar("--canvas-edge-label");
    const edgeLabelHighlight = cssVar("--canvas-edge-label-highlight");
    const edgeLabelDim = cssVar("--canvas-edge-label-dim");
    const arrowColor = cssVar("--canvas-arrow");
    const arrowHighlight = cssVar("--canvas-arrow-highlight");
    const nodeLabel = cssVar("--canvas-node-label");
    const nodeLabelDim = cssVar("--canvas-node-label-dim");
    const typeBadge = cssVar("--canvas-type-badge");
    const typeBadgeDim = cssVar("--canvas-type-badge-dim");
    const selectionBorder = cssVar("--canvas-selection-border");
    const nodeBorder = cssVar("--canvas-node-border");

    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);

    ctx.save();
    ctx.translate(-camera.x * camera.scale, -camera.y * camera.scale);
    ctx.scale(camera.scale, camera.scale);

    // Draw type hulls (shaded regions behind same-type nodes)
    if (showTypeHulls && camera.scale >= lod.smallNodes) {
      const typeGroups = new Map<string, LayoutNode[]>();
      for (const node of state.nodes) {
        if (filteredNodeIds !== null && !filteredNodeIds.has(node.id)) continue;
        const group = typeGroups.get(node.type) ?? [];
        group.push(node);
        typeGroups.set(node.type, group);
      }

      for (const [type, nodes] of typeGroups) {
        if (nodes.length < 2) continue;
        const color = getColor(type);
        const padding = NODE_RADIUS * 2.5;

        // Compute bounding box
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const n of nodes) {
          if (n.x < minX) minX = n.x;
          if (n.y < minY) minY = n.y;
          if (n.x > maxX) maxX = n.x;
          if (n.y > maxY) maxY = n.y;
        }

        ctx.beginPath();
        const rx = (maxX - minX) / 2 + padding;
        const ry = (maxY - minY) / 2 + padding;
        const cx = (minX + maxX) / 2;
        const cy = (minY + maxY) / 2;
        ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.globalAlpha = 0.05;
        ctx.fill();
        ctx.strokeStyle = color;
        ctx.globalAlpha = 0.12;
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
      }
    }

    // Pre-compute neighbor set for selected nodes (avoids O(n×e) scan)
    let neighborIds: Set<string> | null = null;
    if (selectedNodeIds.size > 0) {
      neighborIds = new Set<string>();
      for (const edge of state.edges) {
        if (selectedNodeIds.has(edge.sourceId)) neighborIds.add(edge.targetId);
        if (selectedNodeIds.has(edge.targetId)) neighborIds.add(edge.sourceId);
      }
    }

    const accent = cssVar("--accent") || "#d4a27f";
    const walkEdgeColor = cssVar("--canvas-walk-edge") || "#1a1a1a";
    const drawArrows = camera.scale >= lod.hideArrows;
    const drawEdgeLabelsThisFrame = showEdgeLabels && camera.scale >= lod.hideEdgeLabels;

    // Draw edges — batched by visual state to minimize Canvas state changes
    if (showEdges) {
      // Classify edges into batches by visual style
      const normalBatch: number[] = [];
      const highlightBatch: number[] = [];
      const dimBatch: number[] = [];
      const walkBatch: number[] = [];
      const pathBatch: number[] = [];
      const deferred: { sx: number; sy: number; tx: number; ty: number; type: string; highlighted: boolean; edgeDimmed: boolean; isPathEdge: boolean; isWalkEdge: boolean }[] = [];

      for (const edge of state.edges) {
        const source = state.nodeMap.get(edge.sourceId);
        const target = state.nodeMap.get(edge.targetId);
        if (!source || !target) continue;

        // Viewport culling
        if (!isInViewport(source.x, source.y, camera, canvas.clientWidth, canvas.clientHeight, 200) &&
            !isInViewport(target.x, target.y, camera, canvas.clientWidth, canvas.clientHeight, 200)) continue;

        const sourceMatch = filteredNodeIds === null || filteredNodeIds.has(edge.sourceId);
        const targetMatch = filteredNodeIds === null || filteredNodeIds.has(edge.targetId);
        const bothMatch = sourceMatch && targetMatch;
        if (filteredNodeIds !== null && !sourceMatch && !targetMatch) continue;

        const isConnected =
          selectedNodeIds.size > 0 &&
          (selectedNodeIds.has(edge.sourceId) || selectedNodeIds.has(edge.targetId));
        const highlighted = isConnected || (filteredNodeIds !== null && bothMatch);
        const edgeDimmed = filteredNodeIds !== null && !bothMatch;
        const isWalkEdge = walkTrailSet !== null && walkTrailSet.has(edge.sourceId) && walkTrailSet.has(edge.targetId);

        const fullEdge = highlightedPath ? lastLoadedData?.edges.find(e =>
          (e.sourceId === edge.sourceId && e.targetId === edge.targetId) ||
          (e.targetId === edge.sourceId && e.sourceId === edge.targetId)
        ) : null;
        const isPathEdge = !!(highlightedPath && fullEdge && highlightedPath.edgeIds.has(fullEdge.id));

        // Self-loop
        if (edge.sourceId === edge.targetId) {
          drawSelfLoop(source, edge.type, highlighted, edgeColor, edgeHighlight, edgeLabel, edgeLabelHighlight);
          continue;
        }

        // Sort into batch by visual state
        const batch = isPathEdge ? pathBatch
          : isWalkEdge ? walkBatch
          : highlighted ? highlightBatch
          : edgeDimmed ? dimBatch
          : normalBatch;
        batch.push(source.x, source.y, target.x, target.y);

        // Queue deferred work (arrowheads, labels)
        if (drawArrows || drawEdgeLabelsThisFrame) {
          deferred.push({ sx: source.x, sy: source.y, tx: target.x, ty: target.y, type: edge.type, highlighted, edgeDimmed, isPathEdge, isWalkEdge });
        }
      }

      // Stroke each batch with one beginPath/stroke pair
      const normalWidth = drawArrows ? 1.5 : 1;
      const highlightWidth = drawArrows ? 2.5 : 1;
      const batches: { lines: number[]; color: string; width: number; alpha: number }[] = [
        { lines: normalBatch, color: edgeColor, width: normalWidth, alpha: 1 },
        { lines: dimBatch, color: edgeDimColor, width: normalWidth, alpha: 1 },
        { lines: highlightBatch, color: edgeHighlight, width: highlightWidth, alpha: 1 },
        { lines: pathBatch, color: accent, width: 3, alpha: 1 },
        { lines: walkBatch, color: walkEdgeColor, width: 3, alpha: 0.5 + 0.5 * Math.sin(pulsePhase) },
      ];

      for (const b of batches) {
        if (b.lines.length === 0) continue;
        ctx.beginPath();
        for (let i = 0; i < b.lines.length; i += 4) {
          ctx.moveTo(b.lines[i], b.lines[i + 1]);
          ctx.lineTo(b.lines[i + 2], b.lines[i + 3]);
        }
        ctx.strokeStyle = b.color;
        ctx.lineWidth = b.width;
        ctx.globalAlpha = b.alpha;
        ctx.stroke();
      }
      ctx.globalAlpha = 1;

      // Draw arrowheads and labels (can't batch — each needs individual positioning)
      for (const d of deferred) {
        if (drawArrows) {
          drawArrowhead(d.sx, d.sy, d.tx, d.ty, d.highlighted || d.isPathEdge, arrowColor, arrowHighlight);
        }
        if (drawEdgeLabelsThisFrame) {
          const mx = (d.sx + d.tx) / 2;
          const my = (d.sy + d.ty) / 2;
          ctx.fillStyle = d.highlighted
            ? edgeLabelHighlight
            : d.edgeDimmed
              ? edgeLabelDim
              : edgeLabel;
          ctx.font = "9px system-ui, sans-serif";
          ctx.textAlign = "center";
          ctx.textBaseline = "bottom";
          ctx.fillText(d.type, mx, my - 4);
        }
      }
    }

    // Entrance animation — fade/scale nodes in over ENTRANCE_DURATION ms
    const entranceElapsed = performance.now() - loadTime;
    const entranceT = Math.min(1, entranceElapsed / ENTRANCE_DURATION);
    const entranceProgress = 1 - (1 - entranceT) * (1 - entranceT); // ease-out quad
    const isEntering = entranceT < 1;

    // Draw nodes — skip entirely at extreme zoom-out (hulls-only mode)
    const hullsOnlyMode = camera.scale < lod.hullsOnly;
    const dotMode = !hullsOnlyMode && camera.scale < lod.dotNodes;

    if (!hullsOnlyMode) for (const node of state.nodes) {
      // Viewport culling
      if (!isInViewport(node.x, node.y, camera, canvas.clientWidth, canvas.clientHeight)) continue;

      const color = getColor(node.type);

      // Dot mode — render as single-pixel colored dots, skip all decorations
      if (dotMode) {
        const filteredOut = filteredNodeIds !== null && !filteredNodeIds.has(node.id);
        ctx.fillStyle = color;
        const dotAlpha = filteredOut ? 0.1 : 0.8;
        ctx.globalAlpha = isEntering ? dotAlpha * entranceProgress : dotAlpha;
        ctx.fillRect(node.x - 2, node.y - 2, 4, 4);
        continue;
      }

      const isSelected = selectedNodeIds.has(node.id);
      const isNeighbor = neighborIds !== null && neighborIds.has(node.id);
      const filteredOut =
        filteredNodeIds !== null && !filteredNodeIds.has(node.id);
      const dimmed =
        filteredOut ||
        (selectedNodeIds.size > 0 && !isSelected && !isNeighbor);

      const baseR = camera.scale < lod.smallNodes ? NODE_RADIUS * 0.5 : NODE_RADIUS;
      const r = isEntering ? baseR * entranceProgress : baseR;

      // Walk trail effect — all visited nodes pulse together
      if (walkTrailSet?.has(node.id)) {
        const isCurrent = walkTrail[walkTrail.length - 1] === node.id;
        const pulse = 0.5 + 0.5 * Math.sin(pulsePhase);
        const accent = cssVar("--accent") || "#d4a27f";
        ctx.save();
        ctx.strokeStyle = accent;
        ctx.lineWidth = isCurrent ? 3 : 2;
        ctx.globalAlpha = isCurrent ? 0.5 + 0.5 * pulse : 0.3 + 0.4 * pulse;
        ctx.beginPath();
        ctx.arc(node.x, node.y, r + (isCurrent ? 6 : 4), 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }

      // Glow for selected node
      if (isSelected) {
        ctx.save();
        ctx.shadowColor = color;
        ctx.shadowBlur = 20;
        ctx.beginPath();
        ctx.arc(node.x, node.y, r + 3, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.globalAlpha = 0.3;
        ctx.fill();
        ctx.restore();
      }

      // Circle
      ctx.beginPath();
      ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
      ctx.fillStyle = color;
      const baseAlpha = filteredOut ? 0.1 : dimmed ? 0.3 : 1;
      ctx.globalAlpha = isEntering ? baseAlpha * entranceProgress : baseAlpha;
      ctx.fill();
      ctx.strokeStyle = isSelected ? selectionBorder : nodeBorder;
      ctx.lineWidth = isSelected ? 3 : 1.5;
      ctx.stroke();
      ctx.globalAlpha = 1;

      // Pin indicator — subtle dashed outer ring on pinned nodes so the
      // user can see which positions are being manually held. Rendered
      // after the main circle but before the label so the label stays
      // on top.
      if (node.pinned) {
        ctx.save();
        ctx.strokeStyle = nodeBorder;
        ctx.globalAlpha = 0.55;
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.arc(node.x, node.y, r + 4, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();
      }

      // Highlighted path glow
      if (highlightedPath && highlightedPath.nodeIds.has(node.id) && !isSelected) {
        ctx.save();
        ctx.shadowColor = cssVar("--accent") || "#d4a27f";
        ctx.shadowBlur = 15;
        ctx.beginPath();
        ctx.arc(node.x, node.y, r + 2, 0, Math.PI * 2);
        ctx.strokeStyle = cssVar("--accent") || "#d4a27f";
        ctx.globalAlpha = 0.5;
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.restore();
      }

      // Star indicator for starred nodes
      const originalNode = lastLoadedData?.nodes.find(n => n.id === node.id);
      const isStarred = originalNode?.properties?._starred === true;
      if (isStarred) {
        ctx.fillStyle = "#ffd700";
        ctx.font = "10px system-ui, sans-serif";
        ctx.textAlign = "left";
        ctx.textBaseline = "bottom";
        ctx.fillText("\u2605", node.x + r - 2, node.y - r + 2);
      }

      // Label below (cached offscreen)
      if (camera.scale >= lod.hideLabels) {
        const label =
          node.label.length > 24 ? node.label.slice(0, 22) + "..." : node.label;
        const labelColor = dimmed ? nodeLabelDim : nodeLabel;
        drawCachedLabel(ctx, label, node.x, node.y + r + 4, "11px system-ui, sans-serif", labelColor, "top");
      }

      // Type badge above (cached offscreen)
      if (camera.scale >= lod.hideBadges) {
        const badgeColor = dimmed ? typeBadgeDim : typeBadge;
        drawCachedLabel(ctx, node.type, node.x, node.y - r - 3, "9px system-ui, sans-serif", badgeColor, "bottom");
      }

      ctx.globalAlpha = 1;
    }

    ctx.restore();
    ctx.restore();

    // Snapshot scene to cache BEFORE walk overlay and minimap.
    // The cache contains the clean scene (hulls + edges + nodes) without walk effects.
    if (shouldCache) {
      const w = canvas.width;
      const h = canvas.height;
      if (!sceneCache || sceneCache.width !== w || sceneCache.height !== h) {
        sceneCache = new OffscreenCanvas(w, h);
        sceneCacheCtx = sceneCache.getContext("2d");
      }
      if (sceneCacheCtx) {
        sceneCacheCtx.clearRect(0, 0, w, h);
        sceneCacheCtx.drawImage(canvas, 0, 0);
        sceneCacheDirty = false;
      }
      // Now draw walk effects + minimap on top for this frame
      renderWalkOverlay();
      return;
    }

    // Minimap
    if (showMinimap && state.nodes.length > 1) {
      drawMinimap();
    }

    // Rubber-band overlay — drawn AFTER the cache snapshot so it never
    // gets baked into the cached scene. Uses its own camera transform.
    if (rubberBand) {
      ctx.save();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.translate(-camera.x * camera.scale, -camera.y * camera.scale);
      ctx.scale(camera.scale, camera.scale);
      drawRubberBandIfActive();
      ctx.restore();
    }
  }

  function drawMinimap() {
    if (!state) return;

    const mapW = 140;
    const mapH = 100;
    const mapPad = 8;
    const mapX = canvas.clientWidth - mapW - 16;
    const mapY = canvas.clientHeight - mapH - 16;

    // Compute graph bounds
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of state.nodes) {
      if (n.x < minX) minX = n.x;
      if (n.y < minY) minY = n.y;
      if (n.x > maxX) maxX = n.x;
      if (n.y > maxY) maxY = n.y;
    }

    const gw = maxX - minX || 1;
    const gh = maxY - minY || 1;
    const scale = Math.min((mapW - mapPad * 2) / gw, (mapH - mapPad * 2) / gh);

    const offsetX = mapX + mapPad + ((mapW - mapPad * 2) - gw * scale) / 2;
    const offsetY = mapY + mapPad + ((mapH - mapPad * 2) - gh * scale) / 2;

    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Background
    ctx.fillStyle = cssVar("--bg-surface") || "#1a1a1a";
    ctx.globalAlpha = 0.85;
    ctx.beginPath();
    ctx.roundRect(mapX, mapY, mapW, mapH, 8);
    ctx.fill();
    ctx.strokeStyle = cssVar("--border") || "#2a2a2a";
    ctx.globalAlpha = 1;
    ctx.lineWidth = 1;
    ctx.stroke();

    // Edges
    ctx.globalAlpha = 0.15;
    ctx.strokeStyle = cssVar("--canvas-edge") || "#555";
    ctx.lineWidth = 0.5;
    for (const edge of state.edges) {
      const src = state.nodeMap.get(edge.sourceId);
      const tgt = state.nodeMap.get(edge.targetId);
      if (!src || !tgt || edge.sourceId === edge.targetId) continue;
      ctx.beginPath();
      ctx.moveTo(offsetX + (src.x - minX) * scale, offsetY + (src.y - minY) * scale);
      ctx.lineTo(offsetX + (tgt.x - minX) * scale, offsetY + (tgt.y - minY) * scale);
      ctx.stroke();
    }

    // Nodes
    ctx.globalAlpha = 0.8;
    for (const node of state.nodes) {
      const nx = offsetX + (node.x - minX) * scale;
      const ny = offsetY + (node.y - minY) * scale;
      ctx.beginPath();
      ctx.arc(nx, ny, 2, 0, Math.PI * 2);
      ctx.fillStyle = getColor(node.type);
      ctx.fill();
    }

    // Viewport rectangle
    const vx1 = camera.x;
    const vy1 = camera.y;
    const vx2 = camera.x + canvas.clientWidth / camera.scale;
    const vy2 = camera.y + canvas.clientHeight / camera.scale;

    const rx = offsetX + (vx1 - minX) * scale;
    const ry = offsetY + (vy1 - minY) * scale;
    const rw = (vx2 - vx1) * scale;
    const rh = (vy2 - vy1) * scale;

    ctx.globalAlpha = 0.3;
    ctx.strokeStyle = cssVar("--accent") || "#d4a27f";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(
      Math.max(mapX, Math.min(rx, mapX + mapW)),
      Math.max(mapY, Math.min(ry, mapY + mapH)),
      Math.min(rw, mapW),
      Math.min(rh, mapH)
    );

    ctx.globalAlpha = 1;
    ctx.restore();
  }

  function drawArrowhead(
    sx: number,
    sy: number,
    tx: number,
    ty: number,
    highlighted: boolean,
    arrowColor: string,
    arrowHighlight: string
  ) {
    const angle = Math.atan2(ty - sy, tx - sx);
    const tipX = tx - Math.cos(angle) * NODE_RADIUS;
    const tipY = ty - Math.sin(angle) * NODE_RADIUS;
    const size = 8;

    ctx.beginPath();
    ctx.moveTo(tipX, tipY);
    ctx.lineTo(
      tipX - size * Math.cos(angle - 0.4),
      tipY - size * Math.sin(angle - 0.4)
    );
    ctx.lineTo(
      tipX - size * Math.cos(angle + 0.4),
      tipY - size * Math.sin(angle + 0.4)
    );
    ctx.closePath();
    ctx.fillStyle = highlighted ? arrowHighlight : arrowColor;
    ctx.fill();
  }

  function drawSelfLoop(
    node: LayoutNode,
    type: string,
    highlighted: boolean,
    edgeColor: string,
    edgeHighlight: string,
    labelColor: string,
    labelHighlight: string
  ) {
    const cx = node.x + NODE_RADIUS + 15;
    const cy = node.y - NODE_RADIUS - 15;
    ctx.beginPath();
    ctx.arc(cx, cy, 15, 0, Math.PI * 2);
    ctx.strokeStyle = highlighted ? edgeHighlight : edgeColor;
    ctx.lineWidth = highlighted ? 2.5 : 1.5;
    ctx.stroke();

    if (showEdgeLabels) {
      ctx.fillStyle = highlighted ? labelHighlight : labelColor;
      ctx.font = "9px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(type, cx, cy - 18);
    }
  }

  // --- Simulation loop ---

  function animatePan() {
    if (!panTarget || !panStart) return;
    const elapsed = performance.now() - panStart.time;
    const t = Math.min(elapsed / PAN_DURATION, 1);
    // Ease out cubic
    const ease = 1 - Math.pow(1 - t, 3);
    camera.x = panStart.x + (panTarget.x - panStart.x) * ease;
    camera.y = panStart.y + (panTarget.y - panStart.y) * ease;
    invalidateSceneCache();
    render();
    if (t < 1) {
      requestAnimationFrame(animatePan);
    } else {
      panTarget = null;
      panStart = null;
    }
  }

  let walkAnimFrame = 0;
  function walkAnimate() {
    if (!walkMode || walkTrail.length === 0) {
      walkAnimFrame = 0;
      return;
    }
    render();
    walkAnimFrame = requestAnimationFrame(walkAnimate);
  }

  function fitToNodes() {
    if (!state || state.nodes.length === 0) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of state.nodes) {
      if (n.x < minX) minX = n.x;
      if (n.y < minY) minY = n.y;
      if (n.x > maxX) maxX = n.x;
      if (n.y > maxY) maxY = n.y;
    }
    const pad = NODE_RADIUS * 4;
    const graphW = (maxX - minX) + pad * 2;
    const graphH = (maxY - minY) + pad * 2;
    const scaleX = canvas.clientWidth / Math.max(graphW, 1);
    const scaleY = canvas.clientHeight / Math.max(graphH, 1);
    camera.scale = Math.min(scaleX, scaleY, 2);
    camera.x = (minX + maxX) / 2 - canvas.clientWidth / (2 * camera.scale);
    camera.y = (minY + maxY) / 2 - canvas.clientHeight / (2 * camera.scale);
    requestRedraw();
  }

  function simulate() {
    if (!state || alpha < ALPHA_MIN) {
      // Clear animFrame so callers using the `if (!animFrame) simulate()`
      // idiom can kick the sim back on after releasing pins or bumping
      // alpha. Without this reset, animFrame stays truthy from the last
      // RAF handle and subsequent restart attempts silently no-op.
      animFrame = 0;
      // Start walk animation loop if simulation stopped but walk mode is active
      if (walkMode && walkTrail.length > 0 && !walkAnimFrame) {
        walkAnimFrame = requestAnimationFrame(walkAnimate);
      }
      return;
    }
    alpha = tick(state, alpha);
    nodeHash.rebuild(state.nodes);
    render();
    animFrame = requestAnimationFrame(simulate);
  }

  // --- Interaction: Pan + Click + Node drag + Rubber-band select ---
  //
  // Gesture dispatch on mousedown:
  //   1. mousedown on a node (no modifier) + cursor moves > threshold →
  //      NODE DRAG. If the node is part of the current selection, drag
  //      the whole selection as a rigid body. Otherwise drag just this
  //      node. On drop, pin all dragged nodes.
  //   2. mousedown on a node (no movement) → CLICK (existing selection
  //      and walk-mode behavior).
  //   3. mousedown on empty canvas with Shift → RUBBER-BAND select.
  //   4. mousedown on empty canvas without modifier → PAN (existing).
  //
  // Node drag is disabled during walk mode — in walk mode, clicking a
  // node advances the path, and drag gestures would fight the animation.

  let didDrag = false;
  let lastX = 0;
  let lastY = 0;
  let mouseDownStartX = 0;
  let mouseDownStartY = 0;

  canvas.addEventListener("mousedown", (e) => {
    dragMode = "pending";
    didDrag = false;
    lastX = e.clientX;
    lastY = e.clientY;
    mouseDownStartX = e.clientX;
    mouseDownStartY = e.clientY;

    // Decide the potential gesture now — committed on first movement
    // past the threshold. We still track "pending" so mouseup without
    // movement falls through to the click path below.
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const hit = nodeAtScreen(mx, my);

    if (hit && !walkMode) {
      // Set up the pending node drag. On first movement past the
      // threshold we commit to "nodeDrag" mode.
      dragNodes = [];
      if (selectedNodeIds.has(hit.id) && selectedNodeIds.size > 1) {
        // Drag the whole selection as a group
        for (const id of selectedNodeIds) {
          const n = state?.nodeMap.get(id);
          if (n) dragNodes.push({ node: n, startX: n.x, startY: n.y });
        }
      } else {
        dragNodes.push({ node: hit, startX: hit.x, startY: hit.y });
      }
      const [wx, wy] = screenToWorld(mx, my);
      dragStartWorldX = wx;
      dragStartWorldY = wy;
    } else if (!hit && e.shiftKey) {
      // Pending rubber-band (commits on first movement)
      const [wx, wy] = screenToWorld(mx, my);
      rubberBand = { x1: wx, y1: wy, x2: wx, y2: wy };
    }
    // Otherwise (empty canvas, no shift): will become pan on first move
  });

  canvas.addEventListener("mousemove", (e) => {
    if (dragMode === "idle") return;

    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    const totalDx = Math.abs(e.clientX - mouseDownStartX);
    const totalDy = Math.abs(e.clientY - mouseDownStartY);

    // Commit to a gesture once the cursor crosses the threshold
    if (
      dragMode === "pending" &&
      (totalDx > CLICK_DRAG_THRESHOLD || totalDy > CLICK_DRAG_THRESHOLD)
    ) {
      didDrag = true;
      if (dragNodes.length > 0) {
        dragMode = "nodeDrag";
        // Freeze the worker while the user is actively dragging so its
        // incoming tick messages don't fight our local x/y updates
        if (useWorker && layoutWorker) {
          layoutWorker.postMessage({ type: "stop" });
        }
      } else if (rubberBand) {
        dragMode = "rubberBand";
      } else {
        dragMode = "pan";
      }
    }

    if (dragMode === "nodeDrag") {
      // Translate the dragged group by the cursor delta in world coords
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const [wx, wy] = screenToWorld(mx, my);
      const worldDx = wx - dragStartWorldX;
      const worldDy = wy - dragStartWorldY;
      for (const d of dragNodes) {
        d.node.x = d.startX + worldDx;
        d.node.y = d.startY + worldDy;
        d.node.vx = 0;
        d.node.vy = 0;
        d.node.pinned = true;
        pinnedNodeIds.add(d.node.id);
      }
      nodeHash.rebuild(state?.nodes ?? []);
      requestRedraw();
    } else if (dragMode === "rubberBand" && rubberBand) {
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const [wx, wy] = screenToWorld(mx, my);
      rubberBand.x2 = wx;
      rubberBand.y2 = wy;
      requestRedraw();
    } else if (dragMode === "pan") {
      camera.x -= dx / camera.scale;
      camera.y -= dy / camera.scale;
      requestRedraw();
    }

    lastX = e.clientX;
    lastY = e.clientY;
  });

  canvas.addEventListener("mouseup", (e) => {
    const wasNodeDrag = dragMode === "nodeDrag";
    const wasRubberBand = dragMode === "rubberBand";
    const draggedNodeIdsSnapshot = dragNodes.map((d) => d.node.id);

    if (wasNodeDrag) {
      // Commit pins to the worker's copy so its simulation respects them
      if (useWorker && layoutWorker && state) {
        const updates = dragNodes.map((d) => ({
          id: d.node.id,
          x: d.node.x,
          y: d.node.y,
        }));
        layoutWorker.postMessage({ type: "pin", updates });
        layoutWorker.postMessage({ type: "resume", alpha: 0.5 });
      } else {
        // Main-thread simulation — just bump alpha so neighbors reflow
        alpha = Math.max(alpha, 0.5);
        if (!animFrame) simulate();
      }
      dragMode = "idle";
      dragNodes = [];
      requestRedraw();
      return;
    }

    if (wasRubberBand && rubberBand && state) {
      // Compute which nodes are inside the rectangle (world coords)
      const minX = Math.min(rubberBand.x1, rubberBand.x2);
      const maxX = Math.max(rubberBand.x1, rubberBand.x2);
      const minY = Math.min(rubberBand.y1, rubberBand.y2);
      const maxY = Math.max(rubberBand.y1, rubberBand.y2);
      // Shift extends the existing selection; rubber-band without shift
      // is currently impossible (we only enter this mode on shift+drag),
      // but if that changes later we handle both cases here.
      if (!e.shiftKey) selectedNodeIds.clear();
      for (const node of state.nodes) {
        if (node.x >= minX && node.x <= maxX && node.y >= minY && node.y <= maxY) {
          selectedNodeIds.add(node.id);
        }
      }
      const ids = [...selectedNodeIds];
      onNodeClick?.(ids.length > 0 ? ids : null);
      rubberBand = null;
      dragMode = "idle";
      requestRedraw();
      return;
    }

    // Pan finishing → nothing to do, state cleanup below
    if (dragMode === "pan") {
      dragMode = "idle";
      return;
    }

    // Fall through: this was a click (pending → no drag). Treat as the
    // existing click-to-select / walk-mode-path behavior.
    dragMode = "idle";
    rubberBand = null;
    if (didDrag) return;

    // Click — hit test for node selection
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const hit = nodeAtScreen(mx, my);
    const multiSelect = e.ctrlKey || e.metaKey || e.shiftKey;
    void draggedNodeIdsSnapshot;

    if (walkMode && focusSeedIds && hit && state) {
      // Walk mode: find path from current position to clicked node
      const currentId = walkTrail.length > 0 ? walkTrail[walkTrail.length - 1] : focusSeedIds[0];

      // BFS in the current subgraph to find path
      const visited = new Set<string>([currentId]);
      const queue: Array<{ id: string; path: string[] }> = [{ id: currentId, path: [currentId] }];
      let pathToTarget: string[] | null = null;

      while (queue.length > 0) {
        const { id, path } = queue.shift()!;
        if (id === hit.id) { pathToTarget = path; break; }
        for (const edge of state.edges) {
          let neighbor: string | null = null;
          if (edge.sourceId === id) neighbor = edge.targetId;
          else if (edge.targetId === id) neighbor = edge.sourceId;
          if (neighbor && !visited.has(neighbor)) {
            visited.add(neighbor);
            queue.push({ id: neighbor, path: [...path, neighbor] });
          }
        }
      }

      // No path found — node is unreachable, ignore click
      if (!pathToTarget) return;

      // Add all intermediate nodes to the trail (skip first since it's already the current position)
      for (const id of pathToTarget.slice(1)) {
        if (!walkTrail.includes(id)) walkTrail.push(id);
      }

      focusSeedIds = [hit.id];
      const walkHops = Math.max(1, focusHops);
      focusHops = walkHops;
      const subgraph = extractSubgraph(lastLoadedData!, [hit.id], walkHops);
      cancelAnimationFrame(animFrame);
      if (layoutWorker) layoutWorker.postMessage({ type: "stop" });
      state = createLayout(subgraph);
      nodeHash.rebuild(state.nodes);
      alpha = 1;
      selectedNodeIds = new Set([hit.id]);
      filteredNodeIds = null;
      camera = { x: 0, y: 0, scale: 1 };
      useWorker = subgraph.nodes.length >= WORKER_THRESHOLD;
      const w = useWorker ? getWorker() : null;
      if (w) {
        w.postMessage({ type: "start", data: subgraph });
      } else {
        useWorker = false;
        simulate();
      }

      // Center after physics settle
      setTimeout(() => {
        if (!state) return;
        fitToNodes();
      }, 300);
      onFocusChange?.({ seedNodeIds: [hit.id], hops: walkHops, totalNodes: subgraph.nodes.length });
      onNodeClick?.([hit.id]);
      return; // skip normal selection
    }

    if (hit) {
      if (multiSelect) {
        // Toggle node in/out of multi-selection
        if (selectedNodeIds.has(hit.id)) {
          selectedNodeIds.delete(hit.id);
        } else {
          selectedNodeIds.add(hit.id);
        }
      } else {
        // Single click — toggle if already the only selection, otherwise replace
        if (selectedNodeIds.size === 1 && selectedNodeIds.has(hit.id)) {
          selectedNodeIds.clear();
        } else {
          selectedNodeIds.clear();
          selectedNodeIds.add(hit.id);
        }
      }
      const ids = [...selectedNodeIds];
      onNodeClick?.(ids.length > 0 ? ids : null);
    } else {
      selectedNodeIds.clear();
      onNodeClick?.(null);
    }
    requestRedraw();
  });

  canvas.addEventListener("mouseleave", () => {
    // Cancel any in-progress drag. Node drags keep the pins they already
    // applied (the dragged nodes stay where the cursor last was). Rubber-
    // band selects are abandoned without committing the selection.
    if (dragMode === "nodeDrag") {
      // Sync the final pin positions to the worker so simulation resumes
      if (useWorker && layoutWorker && dragNodes.length > 0) {
        const updates = dragNodes.map((d) => ({
          id: d.node.id,
          x: d.node.x,
          y: d.node.y,
        }));
        layoutWorker.postMessage({ type: "pin", updates });
        layoutWorker.postMessage({ type: "resume", alpha: 0.5 });
      } else {
        alpha = Math.max(alpha, 0.5);
        if (!animFrame) simulate();
      }
    }
    if (dragMode === "rubberBand") {
      rubberBand = null;
      requestRedraw();
    }
    dragMode = "idle";
    dragNodes = [];
  });

  // --- Interaction: Zoom (wheel + pinch) ---

  canvas.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();

      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;

      const [wx, wy] = screenToWorld(mx, my);

      const factor = e.ctrlKey
        ? 1 - e.deltaY * 0.01
        : e.deltaY > 0
          ? 0.9
          : 1.1;

      camera.scale = Math.max(nav.zoomMin, Math.min(nav.zoomMax, camera.scale * factor));

      camera.x = wx - mx / camera.scale;
      camera.y = wy - my / camera.scale;

      requestRedraw();
    },
    { passive: false }
  );

  // --- Interaction: Touch (pinch zoom + drag) ---

  let touches: Touch[] = [];
  let initialPinchDist = 0;
  let initialPinchScale = 1;
  let touchStartX = 0;
  let touchStartY = 0;
  let touchDidMove = false;

  canvas.addEventListener("touchstart", (e) => {
    e.preventDefault();
    touches = Array.from(e.touches);
    if (touches.length === 2) {
      initialPinchDist = touchDistance(touches[0], touches[1]);
      initialPinchScale = camera.scale;
    } else if (touches.length === 1) {
      lastX = touches[0].clientX;
      lastY = touches[0].clientY;
      touchStartX = touches[0].clientX;
      touchStartY = touches[0].clientY;
      touchDidMove = false;
    }
  }, { passive: false });

  canvas.addEventListener("touchmove", (e) => {
    e.preventDefault();
    const current = Array.from(e.touches);

    if (current.length === 2 && touches.length === 2) {
      const dist = touchDistance(current[0], current[1]);
      const ratio = dist / initialPinchDist;
      camera.scale = Math.max(nav.zoomMin, Math.min(nav.zoomMax, initialPinchScale * ratio));
      requestRedraw();
    } else if (current.length === 1) {
      const dx = current[0].clientX - lastX;
      const dy = current[0].clientY - lastY;
      if (Math.abs(current[0].clientX - touchStartX) > 10 ||
          Math.abs(current[0].clientY - touchStartY) > 10) {
        touchDidMove = true;
      }
      camera.x -= dx / camera.scale;
      camera.y -= dy / camera.scale;
      lastX = current[0].clientX;
      lastY = current[0].clientY;
      requestRedraw();
    }

    touches = current;
  }, { passive: false });

  canvas.addEventListener("touchend", (e) => {
    e.preventDefault();
    if (touchDidMove || e.changedTouches.length !== 1) return;

    const t = e.changedTouches[0];
    const rect = canvas.getBoundingClientRect();
    const mx = t.clientX - rect.left;
    const my = t.clientY - rect.top;
    const hit = nodeAtScreen(mx, my);

    if (hit) {
      if (selectedNodeIds.size === 1 && selectedNodeIds.has(hit.id)) {
        selectedNodeIds.clear();
      } else {
        selectedNodeIds.clear();
        selectedNodeIds.add(hit.id);
      }
      const ids = [...selectedNodeIds];
      onNodeClick?.(ids.length > 0 ? ids : null);
    } else {
      selectedNodeIds.clear();
      onNodeClick?.(null);
    }
    requestRedraw();
  }, { passive: false });

  // Prevent Safari page-level pinch zoom on the canvas
  canvas.addEventListener("gesturestart", (e) => e.preventDefault());
  canvas.addEventListener("gesturechange", (e) => e.preventDefault());

  function touchDistance(a: Touch, b: Touch): number {
    const dx = a.clientX - b.clientX;
    const dy = a.clientY - b.clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }

  // --- Zoom controls ---

  const zoomControls = document.createElement("div");
  zoomControls.className = "zoom-controls";

  const zoomInBtn = document.createElement("button");
  zoomInBtn.className = "zoom-btn";
  zoomInBtn.textContent = "+";
  zoomInBtn.title = "Zoom in";
  zoomInBtn.addEventListener("click", () => {
    const cx = canvas.clientWidth / 2;
    const cy = canvas.clientHeight / 2;
    const [wx, wy] = screenToWorld(cx, cy);
    camera.scale = Math.min(nav.zoomMax, camera.scale * nav.zoomFactor);
    camera.x = wx - cx / camera.scale;
    camera.y = wy - cy / camera.scale;
    requestRedraw();
  });

  const zoomOutBtn = document.createElement("button");
  zoomOutBtn.className = "zoom-btn";
  zoomOutBtn.textContent = "\u2212";
  zoomOutBtn.title = "Zoom out";
  zoomOutBtn.addEventListener("click", () => {
    const cx = canvas.clientWidth / 2;
    const cy = canvas.clientHeight / 2;
    const [wx, wy] = screenToWorld(cx, cy);
    camera.scale = Math.max(nav.zoomMin, camera.scale / nav.zoomFactor);
    camera.x = wx - cx / camera.scale;
    camera.y = wy - cy / camera.scale;
    requestRedraw();
  });

  const zoomResetBtn = document.createElement("button");
  zoomResetBtn.className = "zoom-btn";
  zoomResetBtn.textContent = "\u25CB";
  zoomResetBtn.title = "Reset zoom";
  zoomResetBtn.addEventListener("click", () => {
    if (!state) return;
    camera = { x: 0, y: 0, scale: 1 };
    if (state.nodes.length > 0) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const n of state.nodes) {
        if (n.x < minX) minX = n.x;
        if (n.y < minY) minY = n.y;
        if (n.x > maxX) maxX = n.x;
        if (n.y > maxY) maxY = n.y;
      }
      const cx = (minX + maxX) / 2;
      const cy = (minY + maxY) / 2;
      camera.x = cx - canvas.clientWidth / 2;
      camera.y = cy - canvas.clientHeight / 2;
    }
    requestRedraw();
  });

  zoomControls.appendChild(zoomInBtn);
  zoomControls.appendChild(zoomResetBtn);
  zoomControls.appendChild(zoomOutBtn);
  container.appendChild(zoomControls);

  // --- Hover tooltip ---
  const tooltip = document.createElement("div");
  tooltip.className = "node-tooltip";
  tooltip.style.display = "none";
  container.appendChild(tooltip);

  let hoverNodeId: string | null = null;
  let hoverTimeout: ReturnType<typeof setTimeout> | null = null;

  canvas.addEventListener("mousemove", (e) => {
    // Suppress hover tooltip while any drag gesture is active
    if (dragMode !== "idle" && dragMode !== "pending") {
      if (tooltip.style.display !== "none") {
        tooltip.style.display = "none";
        hoverNodeId = null;
      }
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const hit = nodeAtScreen(mx, my);
    const hitId = hit?.id ?? null;

    if (hitId !== hoverNodeId) {
      hoverNodeId = hitId;
      tooltip.style.display = "none";
      if (hoverTimeout) clearTimeout(hoverTimeout);
      hoverTimeout = null;

      if (hitId && hit) {
        hoverTimeout = setTimeout(() => {
          if (!state || !lastLoadedData) return;
          const edgeCount = state.edges.filter(
            (edge) => edge.sourceId === hitId || edge.targetId === hitId
          ).length;
          tooltip.textContent = `${hit.label} · ${hit.type} · ${edgeCount} edge${edgeCount !== 1 ? "s" : ""}`;
          tooltip.style.left = `${e.clientX - rect.left + 12}px`;
          tooltip.style.top = `${e.clientY - rect.top - 8}px`;
          tooltip.style.display = "block";
        }, 200);
      }
    } else if (hitId && tooltip.style.display === "block") {
      tooltip.style.left = `${e.clientX - rect.left + 12}px`;
      tooltip.style.top = `${e.clientY - rect.top - 8}px`;
    }
  });

  canvas.addEventListener("mouseleave", () => {
    tooltip.style.display = "none";
    hoverNodeId = null;
    if (hoverTimeout) clearTimeout(hoverTimeout);
    hoverTimeout = null;
  });

  // --- Public API ---

  return {
    loadGraph(data: LearningGraphData) {
      cancelAnimationFrame(animFrame);
      if (layoutWorker) layoutWorker.postMessage({ type: "stop" });
      clearLabelCache();
      lastLoadedData = data;
      // Exit any active focus when full graph reloads
      focusSeedIds = null;
      savedFullState = null;
      savedFullCamera = null;
      loadTime = performance.now();
      state = createLayout(data);
      nodeHash.rebuild(state.nodes);
      alpha = 1;
      selectedNodeIds = new Set();
      filteredNodeIds = null;
      // Reset any lingering drag/pin state from the previous graph
      pinnedNodeIds.clear();
      dragMode = "idle";
      dragNodes = [];
      rubberBand = null;

      // Center camera on the graph
      camera = { x: 0, y: 0, scale: 1 };
      if (state.nodes.length > 0) {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const n of state.nodes) {
          if (n.x < minX) minX = n.x;
          if (n.y < minY) minY = n.y;
          if (n.x > maxX) maxX = n.x;
          if (n.y > maxY) maxY = n.y;
        }
        const cx = (minX + maxX) / 2;
        const cy = (minY + maxY) / 2;
        const w = canvas.clientWidth;
        const h = canvas.clientHeight;
        camera.x = cx - w / 2;
        camera.y = cy - h / 2;
      }

      // Use worker for large graphs, main thread for small ones
      useWorker = data.nodes.length >= WORKER_THRESHOLD;
      const w = useWorker ? getWorker() : null;
      if (w) {
        w.postMessage({ type: "start", data });
      } else {
        useWorker = false;
        simulate();
      }
    },

    setFilteredNodeIds(ids: Set<string> | null) {
      filteredNodeIds = ids;
      requestRedraw();
    },

    /**
     * Release every manually-pinned node so the force simulation
     * reclaims them. Called by main.ts when a data event (node/edge
     * add/remove, graph switch, backpack switch, focus/walk mode
     * enter/exit, live reload) invalidates the user's temporary
     * layout tweaks.
     *
     * Returns `true` if any pins were released, so the caller can
     * show a toast only when the user actually loses work.
     */
    releaseAllPins(): boolean {
      if (!state) return false;
      let hadPins = false;
      for (const node of state.nodes) {
        if (node.pinned) {
          hadPins = true;
          node.pinned = false;
        }
      }
      pinnedNodeIds.clear();
      // Clear any in-progress drag state too — a data change mid-drag
      // should abort the drag cleanly
      dragMode = "idle";
      dragNodes = [];
      rubberBand = null;
      if (hadPins) {
        // Nudge the simulation so the freed nodes start moving
        if (useWorker && layoutWorker) {
          layoutWorker.postMessage({ type: "unpin", ids: "all" });
        } else {
          alpha = Math.max(alpha, 0.5);
          if (!animFrame) simulate();
        }
        requestRedraw();
      }
      return hadPins;
    },

    hasPinnedNodes(): boolean {
      if (!state) return false;
      for (const node of state.nodes) {
        if (node.pinned) return true;
      }
      return false;
    },

    /** Clear the multi-selection (used by ESC keyboard shortcut). */
    clearSelection() {
      if (selectedNodeIds.size === 0) return;
      selectedNodeIds.clear();
      onNodeClick?.(null);
      requestRedraw();
    },

    getSelectedNodeIds(): string[] {
      return [...selectedNodeIds];
    },

    panToNode(nodeId: string) {
      this.panToNodes([nodeId]);
    },

    panToNodes(nodeIds: string[]) {
      if (!state || nodeIds.length === 0) return;
      const nodes = nodeIds.map((id) => state!.nodeMap.get(id)).filter(Boolean) as LayoutNode[];
      if (nodes.length === 0) return;

      selectedNodeIds = new Set(nodeIds);
      onNodeClick?.(nodeIds);

      const w = canvas.clientWidth;
      const h = canvas.clientHeight;

      if (nodes.length === 1) {
        panStart = { x: camera.x, y: camera.y, time: performance.now() };
        panTarget = {
          x: nodes[0].x - w / (2 * camera.scale),
          y: nodes[0].y - h / (2 * camera.scale),
        };
      } else {
        // Fit all nodes in view with padding
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const n of nodes) {
          if (n.x < minX) minX = n.x;
          if (n.y < minY) minY = n.y;
          if (n.x > maxX) maxX = n.x;
          if (n.y > maxY) maxY = n.y;
        }
        const pad = NODE_RADIUS * 4;
        const bw = maxX - minX + pad * 2;
        const bh = maxY - minY + pad * 2;
        const fitScale = Math.min(w / bw, h / bh, camera.scale);
        camera.scale = fitScale;

        const cx = (minX + maxX) / 2;
        const cy = (minY + maxY) / 2;
        panStart = { x: camera.x, y: camera.y, time: performance.now() };
        panTarget = {
          x: cx - w / (2 * camera.scale),
          y: cy - h / (2 * camera.scale),
        };
      }
      animatePan();
    },

    setEdges(visible: boolean) {
      showEdges = visible;
      requestRedraw();
    },

    setEdgeLabels(visible: boolean) {
      showEdgeLabels = visible;
      requestRedraw();
    },

    setTypeHulls(visible: boolean) {
      showTypeHulls = visible;
      requestRedraw();
    },

    setMinimap(visible: boolean) {
      showMinimap = visible;
      requestRedraw();
    },

    centerView() {
      fitToNodes();
    },

    panBy(dx: number, dy: number) {
      camera.x += dx / camera.scale;
      camera.y += dy / camera.scale;
      requestRedraw();
    },

    zoomBy(factor: number) {
      const cx = canvas.clientWidth / 2;
      const cy = canvas.clientHeight / 2;
      const [wx, wy] = screenToWorld(cx, cy);
      camera.scale = Math.max(nav.zoomMin, Math.min(nav.zoomMax, camera.scale * factor));
      camera.x = wx - cx / camera.scale;
      camera.y = wy - cy / camera.scale;
      requestRedraw();
    },

    reheat() {
      if (useWorker && layoutWorker) {
        layoutWorker.postMessage({ type: "params", params: getLayoutParams() });
      } else {
        alpha = 0.5;
        cancelAnimationFrame(animFrame);
        simulate();
      }
    },

    exportImage(format: "png" | "svg"): string {
      if (!state) return "";

      // Use the actual canvas pixel dimensions (already scaled by dpr)
      const pw = canvas.width;
      const ph = canvas.height;

      if (format === "png") {
        const exportCanvas = document.createElement("canvas");
        exportCanvas.width = pw;
        exportCanvas.height = ph;
        const ectx = exportCanvas.getContext("2d")!;

        // Draw background
        ectx.fillStyle = cssVar("--bg") || "#141414";
        ectx.fillRect(0, 0, pw, ph);

        // Copy current canvas pixels 1:1
        ectx.drawImage(canvas, 0, 0);

        // Watermark (scale font to match pixel density)
        drawWatermark(ectx, pw, ph);

        return exportCanvas.toDataURL("image/png");
      }

      // SVG: embed the canvas as a PNG image with text overlay
      const dataUrl = canvas.toDataURL("image/png");
      const fontSize = Math.max(16, Math.round(pw / 80));
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${pw}" height="${ph}">
  <image href="${dataUrl}" width="${pw}" height="${ph}"/>
  <text x="${pw - 20}" y="${ph - 16}" text-anchor="end" font-family="system-ui, sans-serif" font-size="${fontSize}" fill="#ffffff" opacity="0.4">backpackontology.com</text>
</svg>`;
      return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
    },

    enterFocus(seedNodeIds: string[], hops: number) {
      if (!lastLoadedData || !state) return;
      // Release any user-pinned nodes — focus has its own layout and
      // shouldn't inherit manual tweaks from the full-graph view.
      for (const n of state.nodes) n.pinned = false;
      pinnedNodeIds.clear();
      dragMode = "idle";
      dragNodes = [];
      rubberBand = null;
      // Save current full-graph state
      if (!focusSeedIds) {
        savedFullState = state;
        savedFullCamera = { ...camera };
      }
      focusSeedIds = seedNodeIds;
      focusHops = hops;

      const subgraph = extractSubgraph(lastLoadedData, seedNodeIds, hops);
      cancelAnimationFrame(animFrame);
      if (layoutWorker) layoutWorker.postMessage({ type: "stop" });
      state = createLayout(subgraph);
      nodeHash.rebuild(state.nodes);
      alpha = 1;
      selectedNodeIds = new Set(seedNodeIds);
      filteredNodeIds = null;

      // Start simulation, then center after layout settles
      camera = { x: 0, y: 0, scale: 1 };
      useWorker = subgraph.nodes.length >= WORKER_THRESHOLD;
      const w = useWorker ? getWorker() : null;
      if (w) {
        w.postMessage({ type: "start", data: subgraph });
      } else {
        useWorker = false;
        simulate();
      }

      // Center + fit after physics settle
      setTimeout(() => {
        if (!state || !focusSeedIds) return;
        fitToNodes();
      }, 300);
      onFocusChange?.({
        seedNodeIds,
        hops,
        totalNodes: subgraph.nodes.length,
      });
    },

    exitFocus() {
      if (!focusSeedIds || !savedFullState) return;
      cancelAnimationFrame(animFrame);
      if (layoutWorker) layoutWorker.postMessage({ type: "stop" });
      state = savedFullState;
      // The saved full-graph state may have stale pinned flags from
      // before the focus transition; scrub them so the user starts
      // fresh on exit (pins are temporary view tweaks, not persistent).
      for (const n of state.nodes) n.pinned = false;
      pinnedNodeIds.clear();
      dragMode = "idle";
      dragNodes = [];
      rubberBand = null;
      nodeHash.rebuild(state.nodes);
      camera = savedFullCamera ?? { x: 0, y: 0, scale: 1 };
      focusSeedIds = null;
      savedFullState = null;
      savedFullCamera = null;
      selectedNodeIds = new Set();
      filteredNodeIds = null;
      requestRedraw();
      onFocusChange?.(null);
    },

    isFocused(): boolean {
      return focusSeedIds !== null;
    },

    getFocusInfo(): FocusInfo | null {
      if (!focusSeedIds || !state) return null;
      return {
        seedNodeIds: focusSeedIds,
        hops: focusHops,
        totalNodes: state.nodes.length,
      };
    },

    findPath(sourceId: string, targetId: string): { nodeIds: string[]; edgeIds: string[] } | null {
      if (!state) return null;
      const visited = new Set<string>([sourceId]);
      const queue: Array<{ nodeId: string; path: string[]; edges: string[] }> = [
        { nodeId: sourceId, path: [sourceId], edges: [] }
      ];
      while (queue.length > 0) {
        const { nodeId, path, edges } = queue.shift()!;
        if (nodeId === targetId) return { nodeIds: path, edgeIds: edges };
        for (const edge of state.edges) {
          let neighbor: string | null = null;
          if (edge.sourceId === nodeId) neighbor = edge.targetId;
          else if (edge.targetId === nodeId) neighbor = edge.sourceId;
          if (neighbor && !visited.has(neighbor)) {
            visited.add(neighbor);
            const fullEdge = lastLoadedData?.edges.find(e =>
              (e.sourceId === edge.sourceId && e.targetId === edge.targetId) ||
              (e.targetId === edge.sourceId && e.sourceId === edge.targetId)
            );
            queue.push({
              nodeId: neighbor,
              path: [...path, neighbor],
              edges: [...edges, fullEdge?.id ?? ""]
            });
          }
        }
      }
      return null;
    },

    setHighlightedPath(nodeIds: string[] | null, edgeIds: string[] | null) {
      if (nodeIds && edgeIds) {
        highlightedPath = { nodeIds: new Set(nodeIds), edgeIds: new Set(edgeIds) };
      } else {
        highlightedPath = null;
      }
      requestRedraw();
    },

    clearHighlightedPath() {
      highlightedPath = null;
      requestRedraw();
    },

    setWalkMode(enabled: boolean) {
      walkMode = enabled;
      // Walk mode has its own layout choreography and must not fight
      // with user-pinned positions. Releasing pins on mode transitions
      // (either direction) keeps the two subsystems independent.
      this.releaseAllPins();
      if (enabled) {
        walkTrail = focusSeedIds ? [...focusSeedIds] : [...selectedNodeIds];
        if (!walkAnimFrame) walkAnimFrame = requestAnimationFrame(walkAnimate);
      } else {
        walkTrail = [];
        if (walkAnimFrame) { cancelAnimationFrame(walkAnimFrame); walkAnimFrame = 0; }
      }
      requestRedraw();
    },

    getWalkMode(): boolean {
      return walkMode;
    },

    getWalkTrail(): string[] {
      return [...walkTrail];
    },

    getFilteredNodeIds(): Set<string> | null {
      return filteredNodeIds;
    },

    removeFromWalkTrail(nodeId: string) {
      walkTrail = walkTrail.filter((id) => id !== nodeId);
      requestRedraw();
    },

    /** Hit-test a screen coordinate against nodes. Returns the node or null. */
    nodeAtScreen(sx: number, sy: number) {
      return nodeAtScreen(sx, sy);
    },

    /** Get all node IDs in the current layout (subgraph if focused, full graph otherwise). Seed nodes first. */
    getNodeIds(): string[] {
      if (!state) return [];
      if (focusSeedIds) {
        const seedSet = new Set(focusSeedIds);
        const seeds = state.nodes.filter((n) => seedSet.has(n.id)).map((n) => n.id);
        const rest = state.nodes.filter((n) => !seedSet.has(n.id)).map((n) => n.id);
        return [...seeds, ...rest];
      }
      return state.nodes.map((n) => n.id);
    },

    destroy() {
      cancelAnimationFrame(animFrame);
      if (renderPending) { cancelAnimationFrame(renderPending); renderPending = 0; }
      if (walkAnimFrame) { cancelAnimationFrame(walkAnimFrame); walkAnimFrame = 0; }
      if (layoutWorker) { layoutWorker.terminate(); layoutWorker = null; }
      sceneCache = null;
      sceneCacheCtx = null;
      observer.disconnect();
    },
  };

  function drawWatermark(ectx: CanvasRenderingContext2D, w: number, h: number) {
    const fontSize = Math.max(16, Math.round(w / 80));
    ectx.save();
    ectx.font = `${fontSize}px system-ui, sans-serif`;
    ectx.fillStyle = "rgba(255, 255, 255, 0.4)";
    ectx.textAlign = "right";
    ectx.textBaseline = "bottom";
    ectx.fillText("backpackontology.com", w - 20, h - 16);
    ectx.restore();
  }
}
