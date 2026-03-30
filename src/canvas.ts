import type { LearningGraphData } from "backpack-ontology";
import { createLayout, extractSubgraph, tick, type LayoutState, type LayoutNode } from "./layout";
import { getColor } from "./colors";

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
  lod?: { hideBadges?: number; hideLabels?: number; hideEdgeLabels?: number; smallNodes?: number; hideArrows?: number };
  navigation?: { zoomFactor?: number; zoomMin?: number; zoomMax?: number; panAnimationMs?: number };
}

// Defaults — overridden per-instance via config
const LOD_DEFAULTS = { hideBadges: 0.4, hideLabels: 0.25, hideEdgeLabels: 0.35, smallNodes: 0.2, hideArrows: 0.15 };
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

  // Pan animation state
  let panTarget: { x: number; y: number } | null = null;
  let panStart: { x: number; y: number; time: number } | null = null;
  const PAN_DURATION = nav.panAnimationMs;

  // --- Sizing ---

  function resize() {
    canvas.width = canvas.clientWidth * dpr;
    canvas.height = canvas.clientHeight * dpr;
    render();
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
    // Iterate in reverse so topmost (last drawn) nodes are hit first
    for (let i = state.nodes.length - 1; i >= 0; i--) {
      const node = state.nodes[i];
      const dx = wx - node.x;
      const dy = wy - node.y;
      if (dx * dx + dy * dy <= NODE_RADIUS * NODE_RADIUS) {
        return node;
      }
    }
    return null;
  }

  // --- Rendering ---

  function render() {
    if (!state) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }

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

    // Draw edges
    if (showEdges) for (const edge of state.edges) {
      const source = state.nodeMap.get(edge.sourceId);
      const target = state.nodeMap.get(edge.targetId);
      if (!source || !target) continue;

      // Viewport culling — skip if both endpoints are off-screen
      if (!isInViewport(source.x, source.y, camera, canvas.clientWidth, canvas.clientHeight, 200) &&
          !isInViewport(target.x, target.y, camera, canvas.clientWidth, canvas.clientHeight, 200)) continue;

      const sourceMatch = filteredNodeIds === null || filteredNodeIds.has(edge.sourceId);
      const targetMatch = filteredNodeIds === null || filteredNodeIds.has(edge.targetId);
      const bothMatch = sourceMatch && targetMatch;

      // Hide edges where neither endpoint matches the filter
      if (filteredNodeIds !== null && !sourceMatch && !targetMatch) continue;

      const isConnected =
        selectedNodeIds.size > 0 &&
        (selectedNodeIds.has(edge.sourceId) || selectedNodeIds.has(edge.targetId));

      const highlighted = isConnected || (filteredNodeIds !== null && bothMatch);
      const edgeDimmed = filteredNodeIds !== null && !bothMatch;

      // Check if this edge is part of the highlighted path
      const fullEdge = highlightedPath ? lastLoadedData?.edges.find(e =>
        (e.sourceId === edge.sourceId && e.targetId === edge.targetId) ||
        (e.targetId === edge.sourceId && e.sourceId === edge.targetId)
      ) : null;
      const isPathEdge = highlightedPath && fullEdge && highlightedPath.edgeIds.has(fullEdge.id);

      // Self-loop
      if (edge.sourceId === edge.targetId) {
        drawSelfLoop(source, edge.type, highlighted, edgeColor, edgeHighlight, edgeLabel, edgeLabelHighlight);
        continue;
      }

      // Line
      ctx.beginPath();
      ctx.moveTo(source.x, source.y);
      ctx.lineTo(target.x, target.y);
      ctx.strokeStyle = isPathEdge
        ? (cssVar("--accent") || "#d4a27f")
        : highlighted
          ? edgeHighlight
          : edgeDimmed
            ? edgeDimColor
            : edgeColor;
      ctx.lineWidth = isPathEdge
        ? 3
        : camera.scale < lod.hideArrows ? 1 : highlighted ? 2.5 : 1.5;
      ctx.stroke();

      // Arrowhead
      if (camera.scale >= lod.hideArrows) {
        drawArrowhead(source.x, source.y, target.x, target.y, highlighted, arrowColor, arrowHighlight);
      }

      // Edge label at midpoint
      if (showEdgeLabels && camera.scale >= lod.hideEdgeLabels) {
        const mx = (source.x + target.x) / 2;
        const my = (source.y + target.y) / 2;
        ctx.fillStyle = highlighted
          ? edgeLabelHighlight
          : edgeDimmed
            ? edgeLabelDim
            : edgeLabel;
        ctx.font = "9px system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "bottom";
        ctx.fillText(edge.type, mx, my - 4);
      }
    }

    // Draw nodes
    for (const node of state.nodes) {
      // Viewport culling
      if (!isInViewport(node.x, node.y, camera, canvas.clientWidth, canvas.clientHeight)) continue;

      const color = getColor(node.type);
      const isSelected = selectedNodeIds.has(node.id);
      const isNeighbor =
        selectedNodeIds.size > 0 &&
        state.edges.some(
          (e) =>
            (selectedNodeIds.has(e.sourceId) && e.targetId === node.id) ||
            (selectedNodeIds.has(e.targetId) && e.sourceId === node.id)
        );
      const filteredOut =
        filteredNodeIds !== null && !filteredNodeIds.has(node.id);
      const dimmed =
        filteredOut ||
        (selectedNodeIds.size > 0 && !isSelected && !isNeighbor);

      const r = camera.scale < lod.smallNodes ? NODE_RADIUS * 0.5 : NODE_RADIUS;

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
      ctx.globalAlpha = filteredOut ? 0.1 : dimmed ? 0.3 : 1;
      ctx.fill();
      ctx.strokeStyle = isSelected ? selectionBorder : nodeBorder;
      ctx.lineWidth = isSelected ? 3 : 1.5;
      ctx.stroke();

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

      // Label below
      if (camera.scale >= lod.hideLabels) {
        const label =
          node.label.length > 24 ? node.label.slice(0, 22) + "..." : node.label;
        ctx.fillStyle = dimmed ? nodeLabelDim : nodeLabel;
        ctx.font = "11px system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.fillText(label, node.x, node.y + r + 4);
      }

      // Type badge above
      if (camera.scale >= lod.hideBadges) {
        ctx.fillStyle = dimmed ? typeBadgeDim : typeBadge;
        ctx.font = "9px system-ui, sans-serif";
        ctx.textBaseline = "bottom";
        ctx.fillText(node.type, node.x, node.y - r - 3);
      }

      ctx.globalAlpha = 1;
    }

    ctx.restore();
    ctx.restore();

    // Minimap
    if (showMinimap && state.nodes.length > 1) {
      drawMinimap();
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
    render();
    if (t < 1) {
      requestAnimationFrame(animatePan);
    } else {
      panTarget = null;
      panStart = null;
    }
  }

  function simulate() {
    if (!state || alpha < ALPHA_MIN) return;
    alpha = tick(state, alpha);
    render();
    animFrame = requestAnimationFrame(simulate);
  }

  // --- Interaction: Pan + Click ---

  let dragging = false;
  let didDrag = false;
  let lastX = 0;
  let lastY = 0;

  canvas.addEventListener("mousedown", (e) => {
    dragging = true;
    didDrag = false;
    lastX = e.clientX;
    lastY = e.clientY;
  });

  canvas.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) didDrag = true;
    camera.x -= dx / camera.scale;
    camera.y -= dy / camera.scale;
    lastX = e.clientX;
    lastY = e.clientY;
    render();
  });

  canvas.addEventListener("mouseup", (e) => {
    dragging = false;
    if (didDrag) return;

    // Click — hit test for node selection
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const hit = nodeAtScreen(mx, my);
    const multiSelect = e.ctrlKey || e.metaKey;

    if (walkMode && focusSeedIds && hit) {
      // Walk mode: re-center focus on clicked node (minimum 1 hop so you see neighbors)
      focusSeedIds = [hit.id];
      const walkHops = Math.max(1, focusHops);
      focusHops = walkHops;
      const subgraph = extractSubgraph(lastLoadedData!, [hit.id], walkHops);
      cancelAnimationFrame(animFrame);
      state = createLayout(subgraph);
      alpha = 1;
      selectedNodeIds = new Set([hit.id]);
      filteredNodeIds = null;
      camera = { x: 0, y: 0, scale: 1 };
      simulate();

      // Center after physics settle
      setTimeout(() => {
        if (!state) return;
        if (state.nodes.length > 0) {
          let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
          for (const n of state.nodes) {
            if (n.x < minX) minX = n.x;
            if (n.y < minY) minY = n.y;
            if (n.x > maxX) maxX = n.x;
            if (n.y > maxY) maxY = n.y;
          }
          camera.x = (minX + maxX) / 2 - canvas.clientWidth / (2 * camera.scale);
          camera.y = (minY + maxY) / 2 - canvas.clientHeight / (2 * camera.scale);
        }
        render();
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
    render();
  });

  canvas.addEventListener("mouseleave", () => {
    dragging = false;
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

      render();
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
      render();
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
      render();
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
    render();
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
    render();
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
    render();
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
    render();
  });

  zoomControls.appendChild(zoomInBtn);
  zoomControls.appendChild(zoomResetBtn);
  zoomControls.appendChild(zoomOutBtn);
  container.appendChild(zoomControls);

  // --- Public API ---

  return {
    loadGraph(data: LearningGraphData) {
      cancelAnimationFrame(animFrame);
      lastLoadedData = data;
      // Exit any active focus when full graph reloads
      focusSeedIds = null;
      savedFullState = null;
      savedFullCamera = null;
      state = createLayout(data);
      alpha = 1;
      selectedNodeIds = new Set();
      filteredNodeIds = null;

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

      simulate();
    },

    setFilteredNodeIds(ids: Set<string> | null) {
      filteredNodeIds = ids;
      render();
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
      render();
    },

    setEdgeLabels(visible: boolean) {
      showEdgeLabels = visible;
      render();
    },

    setTypeHulls(visible: boolean) {
      showTypeHulls = visible;
      render();
    },

    setMinimap(visible: boolean) {
      showMinimap = visible;
      render();
    },

    centerView() {
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
        camera.x = (minX + maxX) / 2 - canvas.clientWidth / 2;
        camera.y = (minY + maxY) / 2 - canvas.clientHeight / 2;
      }
      render();
    },

    panBy(dx: number, dy: number) {
      camera.x += dx / camera.scale;
      camera.y += dy / camera.scale;
      render();
    },

    zoomBy(factor: number) {
      const cx = canvas.clientWidth / 2;
      const cy = canvas.clientHeight / 2;
      const [wx, wy] = screenToWorld(cx, cy);
      camera.scale = Math.max(nav.zoomMin, Math.min(nav.zoomMax, camera.scale * factor));
      camera.x = wx - cx / camera.scale;
      camera.y = wy - cy / camera.scale;
      render();
    },

    reheat() {
      alpha = 0.5;
      cancelAnimationFrame(animFrame);
      simulate();
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
      // Save current full-graph state
      if (!focusSeedIds) {
        savedFullState = state;
        savedFullCamera = { ...camera };
      }
      focusSeedIds = seedNodeIds;
      focusHops = hops;

      const subgraph = extractSubgraph(lastLoadedData, seedNodeIds, hops);
      cancelAnimationFrame(animFrame);
      state = createLayout(subgraph);
      alpha = 1;
      selectedNodeIds = new Set(seedNodeIds);
      filteredNodeIds = null;

      // Start simulation, then center after layout settles
      camera = { x: 0, y: 0, scale: 1 };
      simulate();

      // Center after a short delay to let physics settle
      setTimeout(() => {
        if (!state || !focusSeedIds) return;
        // Use the same centering logic as centerView
        if (state.nodes.length > 0) {
          let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
          for (const n of state.nodes) {
            if (n.x < minX) minX = n.x;
            if (n.y < minY) minY = n.y;
            if (n.x > maxX) maxX = n.x;
            if (n.y > maxY) maxY = n.y;
          }
          camera.x = (minX + maxX) / 2 - canvas.clientWidth / (2 * camera.scale);
          camera.y = (minY + maxY) / 2 - canvas.clientHeight / (2 * camera.scale);
        }
        render();
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
      state = savedFullState;
      camera = savedFullCamera ?? { x: 0, y: 0, scale: 1 };
      focusSeedIds = null;
      savedFullState = null;
      savedFullCamera = null;
      selectedNodeIds = new Set();
      filteredNodeIds = null;
      render();
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
      render();
    },

    clearHighlightedPath() {
      highlightedPath = null;
      render();
    },

    setWalkMode(enabled: boolean) {
      walkMode = enabled;
    },

    getWalkMode(): boolean {
      return walkMode;
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
