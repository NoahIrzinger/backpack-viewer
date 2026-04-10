import type { LearningGraphData } from "backpack-ontology";
import { buildQuadtree, applyRepulsion, type Body } from "./quadtree.js";

export interface LayoutNode {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  label: string;
  type: string;
  /**
   * When true, the simulation treats this node as a fixed point:
   * it still contributes forces to neighbors (its x/y is read for
   * repulsion and attraction calculations) but its own position is
   * not updated by the integration step. Set by the viewer's drag
   * handler to temporarily pin a node at a user-chosen location.
   */
  pinned?: boolean;
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

export interface LayoutParams {
  clusterStrength: number; // 0–1, how tightly same-type nodes group
  spacing: number;         // 0.5–20, multiplier on edge rest lengths
}

export const DEFAULT_LAYOUT_PARAMS: LayoutParams = {
  clusterStrength: 0.08,
  spacing: 1.5,
};

const REPULSION = 6000;
const CROSS_TYPE_REPULSION_BASE = 12000;
const ATTRACTION = 0.004;
const REST_LENGTH_SAME_BASE = 140;
const REST_LENGTH_CROSS_BASE = 350;
const DAMPING = 0.9;
const CENTER_GRAVITY = 0.01;
const MIN_DISTANCE = 30;
const MAX_VELOCITY = 50;

// Active params — mutated by setLayoutParams()
let params: LayoutParams = { ...DEFAULT_LAYOUT_PARAMS };

export function setLayoutParams(p: Partial<LayoutParams>) {
  if (p.clusterStrength !== undefined) params.clusterStrength = p.clusterStrength;
  if (p.spacing !== undefined) params.spacing = p.spacing;
}

export function getLayoutParams(): LayoutParams {
  return { ...params };
}

/** Compute sensible default layout params based on graph size. */
export function autoLayoutParams(nodeCount: number): LayoutParams {
  if (nodeCount <= 30) return { ...DEFAULT_LAYOUT_PARAMS };
  const scale = Math.log2(nodeCount / 30);
  return {
    clusterStrength: Math.min(0.5, 0.08 + 0.06 * scale),
    spacing: Math.min(15, 1.5 + 1.2 * scale),
  };
}

/** Extract a display label from a node — first string property value, fallback to id. */
function nodeLabel(properties: Record<string, unknown>, id: string): string {
  for (const value of Object.values(properties)) {
    if (typeof value === "string") return value;
  }
  return id;
}

/** Extract the N-hop neighborhood of seed nodes as a new subgraph. */
export function extractSubgraph(
  data: LearningGraphData,
  seedIds: string[],
  hops: number
): LearningGraphData {
  const visited = new Set<string>(seedIds);
  let frontier = new Set<string>(seedIds);

  for (let h = 0; h < hops; h++) {
    const next = new Set<string>();
    for (const edge of data.edges) {
      if (frontier.has(edge.sourceId) && !visited.has(edge.targetId)) {
        next.add(edge.targetId);
      }
      if (frontier.has(edge.targetId) && !visited.has(edge.sourceId)) {
        next.add(edge.sourceId);
      }
    }
    for (const id of next) visited.add(id);
    frontier = next;
    if (next.size === 0) break;
  }

  return {
    nodes: data.nodes.filter((n) => visited.has(n.id)),
    edges: data.edges.filter(
      (e) => visited.has(e.sourceId) && visited.has(e.targetId)
    ),
    metadata: data.metadata,
  };
}

/** Create a layout state from ontology data. Nodes start grouped by type. */
export function createLayout(data: LearningGraphData): LayoutState {
  const nodeMap = new Map<string, LayoutNode>();

  // Group nodes by type for initial placement
  const types = [...new Set(data.nodes.map((n) => n.type))];
  const typeRadius = Math.sqrt(types.length) * REST_LENGTH_CROSS_BASE * 0.6 * Math.max(1, params.spacing);
  const typeCounters = new Map<string, number>();
  const typeSizes = new Map<string, number>();
  for (const n of data.nodes) {
    typeSizes.set(n.type, (typeSizes.get(n.type) ?? 0) + 1);
  }

  const nodes: LayoutNode[] = data.nodes.map((n) => {
    const ti = types.indexOf(n.type);
    const typeAngle = (2 * Math.PI * ti) / Math.max(types.length, 1);
    const cx = Math.cos(typeAngle) * typeRadius;
    const cy = Math.sin(typeAngle) * typeRadius;

    const ni = typeCounters.get(n.type) ?? 0;
    typeCounters.set(n.type, ni + 1);
    const groupSize = typeSizes.get(n.type) ?? 1;
    const nodeAngle = (2 * Math.PI * ni) / groupSize;
    const nodeRadius = REST_LENGTH_SAME_BASE * 0.6;

    const node: LayoutNode = {
      id: n.id,
      x: cx + Math.cos(nodeAngle) * nodeRadius,
      y: cy + Math.sin(nodeAngle) * nodeRadius,
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

// Barnes-Hut accuracy parameter (0.5 = accurate, 1.0 = fast).
// 0.7 is a good balance for interactive use.
const BH_THETA = 0.7;

// Threshold below which we fall back to direct O(n²) — quadtree overhead isn't worth it
const BH_THRESHOLD = 80;

/** Run one tick of the force simulation. Returns new alpha. */
export function tick(state: LayoutState, alpha: number): number {
  const { nodes, edges, nodeMap } = state;

  // Repulsion — Barnes-Hut O(n log n) for large graphs, direct O(n²) for small
  const crossRep = CROSS_TYPE_REPULSION_BASE * params.spacing;

  if (nodes.length >= BH_THRESHOLD) {
    // Barnes-Hut: apply cross-type repulsion strength globally via quadtree
    const tree = buildQuadtree(nodes as Body[]);
    if (tree) {
      for (const node of nodes) {
        applyRepulsion(tree, node as Body, BH_THETA, crossRep, alpha, MIN_DISTANCE);
      }
    }

    // Same-type correction: same-type pairs should use REPULSION (weaker) not crossRep.
    // Apply a negative correction of (crossRep - REPULSION) for same-type pairs.
    // Group by type to avoid checking all n² pairs — only intra-group pairs.
    const repDiff = crossRep - REPULSION;
    if (repDiff > 0) {
      const typeGroups = new Map<string, LayoutNode[]>();
      for (const node of nodes) {
        let group = typeGroups.get(node.type);
        if (!group) { group = []; typeGroups.set(node.type, group); }
        group.push(node);
      }
      for (const group of typeGroups.values()) {
        for (let i = 0; i < group.length; i++) {
          for (let j = i + 1; j < group.length; j++) {
            const a = group[i];
            const b = group[j];
            let dx = b.x - a.x;
            let dy = b.y - a.y;
            let dist = Math.sqrt(dx * dx + dy * dy);
            if (dist < MIN_DISTANCE) dist = MIN_DISTANCE;
            // Subtract the excess repulsion (correction is attractive between same-type)
            const force = (repDiff * alpha) / (dist * dist);
            const fx = (dx / dist) * force;
            const fy = (dy / dist) * force;
            a.vx += fx;
            a.vy += fy;
            b.vx -= fx;
            b.vy -= fy;
          }
        }
      }
    }
  } else {
    // Small graph — direct all-pairs (original algorithm)
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i];
        const b = nodes[j];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < MIN_DISTANCE) dist = MIN_DISTANCE;

        const rep = a.type === b.type ? REPULSION : crossRep;
        const force = (rep * alpha) / (dist * dist);
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;

        a.vx -= fx;
        a.vy -= fy;
        b.vx += fx;
        b.vy += fy;
      }
    }
  }

  // Attraction — along edges (shorter rest length within same type)
  for (const edge of edges) {
    const source = nodeMap.get(edge.sourceId);
    const target = nodeMap.get(edge.targetId);
    if (!source || !target) continue;

    const dx = target.x - source.x;
    const dy = target.y - source.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist === 0) continue;

    const restLen = source.type === target.type
      ? REST_LENGTH_SAME_BASE * params.spacing
      : REST_LENGTH_CROSS_BASE * params.spacing;
    const force = ATTRACTION * (dist - restLen) * alpha;
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

  // Cluster force — pull nodes toward their type centroid
  const centroids = new Map<string, { x: number; y: number; count: number }>();
  for (const node of nodes) {
    const c = centroids.get(node.type) ?? { x: 0, y: 0, count: 0 };
    c.x += node.x;
    c.y += node.y;
    c.count++;
    centroids.set(node.type, c);
  }
  for (const c of centroids.values()) {
    c.x /= c.count;
    c.y /= c.count;
  }
  for (const node of nodes) {
    const c = centroids.get(node.type)!;
    node.vx += (c.x - node.x) * params.clusterStrength * alpha;
    node.vy += (c.y - node.y) * params.clusterStrength * alpha;
  }

  // Integrate — update positions, apply damping, clamp velocity.
  // Pinned nodes keep their x/y and have velocity zeroed so they
  // don't drift when released later with pending momentum.
  for (const node of nodes) {
    if (node.pinned) {
      node.vx = 0;
      node.vy = 0;
      continue;
    }
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
