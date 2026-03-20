import type { OntologyData } from "backpack-ontology";
import { createLayout, tick, type LayoutState, type LayoutNode } from "./layout";
import { getColor } from "./colors";

interface Camera {
  x: number;
  y: number;
  scale: number;
}

const NODE_RADIUS = 20;
const ALPHA_MIN = 0.001;

export function initCanvas(
  container: HTMLElement,
  onNodeClick?: (nodeId: string | null) => void
) {
  const canvas = container.querySelector("canvas") as HTMLCanvasElement;
  const ctx = canvas.getContext("2d")!;
  const dpr = window.devicePixelRatio || 1;

  let camera: Camera = { x: 0, y: 0, scale: 1 };
  let state: LayoutState | null = null;
  let alpha = 1;
  let animFrame = 0;
  let selectedNodeId: string | null = null;

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

      const isConnected =
        selectedNodeId !== null &&
        (edge.sourceId === selectedNodeId || edge.targetId === selectedNodeId);

      // Self-loop
      if (edge.sourceId === edge.targetId) {
        drawSelfLoop(source, edge.type, isConnected);
        continue;
      }

      // Line
      ctx.beginPath();
      ctx.moveTo(source.x, source.y);
      ctx.lineTo(target.x, target.y);
      ctx.strokeStyle = isConnected
        ? "rgba(212, 162, 127, 0.5)"
        : "rgba(255, 255, 255, 0.08)";
      ctx.lineWidth = isConnected ? 2.5 : 1.5;
      ctx.stroke();

      // Arrowhead
      drawArrowhead(source.x, source.y, target.x, target.y, isConnected);

      // Edge label at midpoint
      const mx = (source.x + target.x) / 2;
      const my = (source.y + target.y) / 2;
      ctx.fillStyle = isConnected
        ? "rgba(212, 162, 127, 0.7)"
        : "rgba(255, 255, 255, 0.2)";
      ctx.font = "9px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "bottom";
      ctx.fillText(edge.type, mx, my - 4);
    }

    // Draw nodes
    for (const node of state.nodes) {
      const color = getColor(node.type);
      const isSelected = node.id === selectedNodeId;
      const isNeighbor =
        selectedNodeId !== null &&
        state.edges.some(
          (e) =>
            (e.sourceId === selectedNodeId && e.targetId === node.id) ||
            (e.targetId === selectedNodeId && e.sourceId === node.id)
        );
      const dimmed =
        selectedNodeId !== null && !isSelected && !isNeighbor;

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
      ctx.globalAlpha = dimmed ? 0.3 : 1;
      ctx.fill();
      ctx.strokeStyle = isSelected
        ? "#d4d4d4"
        : "rgba(255, 255, 255, 0.15)";
      ctx.lineWidth = isSelected ? 3 : 1.5;
      ctx.stroke();

      // Label below
      const label =
        node.label.length > 24 ? node.label.slice(0, 22) + "..." : node.label;
      ctx.fillStyle = dimmed
        ? "rgba(212, 212, 212, 0.2)"
        : "#a3a3a3";
      ctx.font = "11px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.fillText(label, node.x, node.y + NODE_RADIUS + 4);

      // Type badge above
      ctx.fillStyle = dimmed
        ? "rgba(115, 115, 115, 0.15)"
        : "rgba(115, 115, 115, 0.5)";
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
    highlighted: boolean
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
    ctx.fillStyle = highlighted
      ? "rgba(212, 162, 127, 0.5)"
      : "rgba(255, 255, 255, 0.12)";
    ctx.fill();
  }

  function drawSelfLoop(
    node: LayoutNode,
    type: string,
    highlighted: boolean
  ) {
    const cx = node.x + NODE_RADIUS + 15;
    const cy = node.y - NODE_RADIUS - 15;
    ctx.beginPath();
    ctx.arc(cx, cy, 15, 0, Math.PI * 2);
    ctx.strokeStyle = highlighted
      ? "rgba(212, 162, 127, 0.5)"
      : "rgba(255, 255, 255, 0.08)";
    ctx.lineWidth = highlighted ? 2.5 : 1.5;
    ctx.stroke();

    ctx.fillStyle = highlighted
      ? "rgba(212, 162, 127, 0.7)"
      : "rgba(255, 255, 255, 0.2)";
    ctx.font = "9px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(type, cx, cy - 18);
  }

  // --- Simulation loop ---

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

    if (hit) {
      selectedNodeId = hit.id;
      onNodeClick?.(hit.id);
    } else {
      selectedNodeId = null;
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

  // --- Public API ---

  return {
    loadGraph(data: OntologyData) {
      cancelAnimationFrame(animFrame);
      state = createLayout(data);
      alpha = 1;
      selectedNodeId = null;

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

    destroy() {
      cancelAnimationFrame(animFrame);
      observer.disconnect();
    },
  };
}
