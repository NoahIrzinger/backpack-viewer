import type { LearningGraphData } from "backpack-ontology";

export interface LayoutNode {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  label: string;
  type: string;
}

export interface LayoutEdge {
  sourceId: string;
  targetId: string;
  type: string;
}

export interface LayoutState {
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  nodeMap: Map<string, LayoutNode>;
}

const REPULSION = 5000;
const ATTRACTION = 0.005;
const REST_LENGTH = 150;
const DAMPING = 0.9;
const CENTER_GRAVITY = 0.01;
const MIN_DISTANCE = 30;
const MAX_VELOCITY = 50;

/** Extract a display label from a node — first string property value, fallback to id. */
function nodeLabel(properties: Record<string, unknown>, id: string): string {
  for (const value of Object.values(properties)) {
    if (typeof value === "string") return value;
  }
  return id;
}

/** Create a layout state from ontology data. Nodes start in a circle. */
export function createLayout(data: LearningGraphData): LayoutState {
  const radius = Math.sqrt(data.nodes.length) * REST_LENGTH * 0.5;
  const nodeMap = new Map<string, LayoutNode>();

  const nodes: LayoutNode[] = data.nodes.map((n, i) => {
    const angle = (2 * Math.PI * i) / data.nodes.length;
    const node: LayoutNode = {
      id: n.id,
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius,
      vx: 0,
      vy: 0,
      label: nodeLabel(n.properties, n.id),
      type: n.type,
    };
    nodeMap.set(n.id, node);
    return node;
  });

  const edges: LayoutEdge[] = data.edges.map((e) => ({
    sourceId: e.sourceId,
    targetId: e.targetId,
    type: e.type,
  }));

  return { nodes, edges, nodeMap };
}

/** Run one tick of the force simulation. Returns new alpha. */
export function tick(state: LayoutState, alpha: number): number {
  const { nodes, edges, nodeMap } = state;

  // Repulsion — all pairs
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i];
      const b = nodes[j];
      let dx = b.x - a.x;
      let dy = b.y - a.y;
      let dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < MIN_DISTANCE) dist = MIN_DISTANCE;

      const force = (REPULSION * alpha) / (dist * dist);
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;

      a.vx -= fx;
      a.vy -= fy;
      b.vx += fx;
      b.vy += fy;
    }
  }

  // Attraction — along edges
  for (const edge of edges) {
    const source = nodeMap.get(edge.sourceId);
    const target = nodeMap.get(edge.targetId);
    if (!source || !target) continue;

    const dx = target.x - source.x;
    const dy = target.y - source.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist === 0) continue;

    const force = ATTRACTION * (dist - REST_LENGTH) * alpha;
    const fx = (dx / dist) * force;
    const fy = (dy / dist) * force;

    source.vx += fx;
    source.vy += fy;
    target.vx -= fx;
    target.vy -= fy;
  }

  // Centering gravity
  for (const node of nodes) {
    node.vx -= node.x * CENTER_GRAVITY * alpha;
    node.vy -= node.y * CENTER_GRAVITY * alpha;
  }

  // Integrate — update positions, apply damping, clamp velocity
  for (const node of nodes) {
    node.vx *= DAMPING;
    node.vy *= DAMPING;

    const speed = Math.sqrt(node.vx * node.vx + node.vy * node.vy);
    if (speed > MAX_VELOCITY) {
      node.vx = (node.vx / speed) * MAX_VELOCITY;
      node.vy = (node.vy / speed) * MAX_VELOCITY;
    }

    node.x += node.vx;
    node.y += node.vy;
  }

  return alpha * 0.995;
}
