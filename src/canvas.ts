import type { OntologyData } from "backpack-ontology";
import { createLayout, tick, type LayoutState, type LayoutNode } from "./layout";
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

export function initCanvas(
  container: HTMLElement,
  onNodeClick?: (nodeIds: string[] | null) => void
) {
  const canvas = container.querySelector("canvas") as HTMLCanvasElement;
  const ctx = canvas.getContext("2d")!;
  const dpr = window.devicePixelRatio || 1;

  let camera: Camera = { x: 0, y: 0, scale: 1 };
  let state: LayoutState | null = null;
  let alpha = 1;
  let animFrame = 0;
  let selectedNodeIds: Set<string> = new Set();
  let filteredNodeIds: Set<string> | null = null; // null = no filter (show all)

  // Pan animation state
  let panTarget: { x: number; y: number } | null = null;
  let panStart: { x: number; y: number; time: number } | null = null;
  const PAN_DURATION = 300;

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

    // Draw edges
    for (const edge of state.edges) {
      const source = state.nodeMap.get(edge.sourceId);
      const target = state.nodeMap.get(edge.targetId);
      if (!source || !target) continue;

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

      // Self-loop
      if (edge.sourceId === edge.targetId) {
        drawSelfLoop(source, edge.type, highlighted, edgeColor, edgeHighlight, edgeLabel, edgeLabelHighlight);
        continue;
      }

      // Line
      ctx.beginPath();
      ctx.moveTo(source.x, source.y);
      ctx.lineTo(target.x, target.y);
      ctx.strokeStyle = highlighted
        ? edgeHighlight
        : edgeDimmed
          ? edgeDimColor
          : edgeColor;
      ctx.lineWidth = highlighted ? 2.5 : 1.5;
      ctx.stroke();

      // Arrowhead
      drawArrowhead(source.x, source.y, target.x, target.y, highlighted, arrowColor, arrowHighlight);

      // Edge label at midpoint
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

    // Draw nodes
    for (const node of state.nodes) {
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

      // Glow for selected node
      if (isSelected) {
        ctx.save();
        ctx.shadowColor = color;
        ctx.shadowBlur = 20;
        ctx.beginPath();
        ctx.arc(node.x, node.y, NODE_RADIUS + 3, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.globalAlpha = 0.3;
        ctx.fill();
        ctx.restore();
      }

      // Circle
      ctx.beginPath();
      ctx.arc(node.x, node.y, NODE_RADIUS, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.globalAlpha = filteredOut ? 0.1 : dimmed ? 0.3 : 1;
      ctx.fill();
      ctx.strokeStyle = isSelected ? selectionBorder : nodeBorder;
      ctx.lineWidth = isSelected ? 3 : 1.5;
      ctx.stroke();

      // Label below
      const label =
        node.label.length > 24 ? node.label.slice(0, 22) + "..." : node.label;
      ctx.fillStyle = dimmed ? nodeLabelDim : nodeLabel;
      ctx.font = "11px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.fillText(label, node.x, node.y + NODE_RADIUS + 4);

      // Type badge above
      ctx.fillStyle = dimmed ? typeBadgeDim : typeBadge;
      ctx.font = "9px system-ui, sans-serif";
      ctx.textBaseline = "bottom";
      ctx.fillText(node.type, node.x, node.y - NODE_RADIUS - 3);

      ctx.globalAlpha = 1;
    }

    ctx.restore();
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

    ctx.fillStyle = highlighted ? labelHighlight : labelColor;
    ctx.font = "9px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(type, cx, cy - 18);
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

      camera.scale = Math.max(0.05, Math.min(10, camera.scale * factor));

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

  canvas.addEventListener("touchstart", (e) => {
    e.preventDefault();
    touches = Array.from(e.touches);
    if (touches.length === 2) {
      initialPinchDist = touchDistance(touches[0], touches[1]);
      initialPinchScale = camera.scale;
    } else if (touches.length === 1) {
      lastX = touches[0].clientX;
      lastY = touches[0].clientY;
    }
  }, { passive: false });

  canvas.addEventListener("touchmove", (e) => {
    e.preventDefault();
    const current = Array.from(e.touches);

    if (current.length === 2 && touches.length === 2) {
      const dist = touchDistance(current[0], current[1]);
      const ratio = dist / initialPinchDist;
      camera.scale = Math.max(0.05, Math.min(10, initialPinchScale * ratio));
      render();
    } else if (current.length === 1) {
      const dx = current[0].clientX - lastX;
      const dy = current[0].clientY - lastY;
      camera.x -= dx / camera.scale;
      camera.y -= dy / camera.scale;
      lastX = current[0].clientX;
      lastY = current[0].clientY;
      render();
    }

    touches = current;
  }, { passive: false });

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
    camera.scale = Math.min(10, camera.scale * 1.3);
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
    camera.scale = Math.max(0.05, camera.scale / 1.3);
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
    loadGraph(data: OntologyData) {
      cancelAnimationFrame(animFrame);
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
      if (!state) return;
      const node = state.nodeMap.get(nodeId);
      if (!node) return;

      selectedNodeIds = new Set([nodeId]);
      onNodeClick?.([nodeId]);

      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      panStart = { x: camera.x, y: camera.y, time: performance.now() };
      panTarget = {
        x: node.x - w / (2 * camera.scale),
        y: node.y - h / (2 * camera.scale),
      };
      animatePan();
    },

    destroy() {
      cancelAnimationFrame(animFrame);
      observer.disconnect();
    },
  };
}
