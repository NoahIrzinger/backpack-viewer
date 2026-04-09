/**
 * Barnes-Hut quadtree for O(n log n) force-directed repulsion.
 *
 * Instead of computing repulsion between every pair of nodes (O(n²)),
 * the quadtree groups distant nodes into aggregate "bodies" and applies
 * a single force from each group. The θ parameter controls accuracy:
 * lower θ = more accurate but slower, higher θ = faster but less precise.
 */

export interface Body {
  x: number;
  y: number;
  vx: number;
  vy: number;
  type: string;
}

interface QuadNode {
  // Bounding box
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  // Aggregate center of mass and count
  cx: number;
  cy: number;
  mass: number;
  // Children (NW, NE, SW, SE) — null if empty
  children: (QuadNode | null)[];
  // Leaf body (only set if this is a leaf with exactly one body)
  body: Body | null;
}

function createNode(x0: number, y0: number, x1: number, y1: number): QuadNode {
  return { x0, y0, x1, y1, cx: 0, cy: 0, mass: 0, children: [null, null, null, null], body: null };
}

function quadrant(node: QuadNode, x: number, y: number): number {
  const mx = (node.x0 + node.x1) / 2;
  const my = (node.y0 + node.y1) / 2;
  return (x < mx ? 0 : 1) + (y < my ? 0 : 2);
}

function childBounds(node: QuadNode, q: number): [number, number, number, number] {
  const mx = (node.x0 + node.x1) / 2;
  const my = (node.y0 + node.y1) / 2;
  switch (q) {
    case 0: return [node.x0, node.y0, mx, my];       // NW
    case 1: return [mx, node.y0, node.x1, my];       // NE
    case 2: return [node.x0, my, mx, node.y1];       // SW
    default: return [mx, my, node.x1, node.y1];      // SE
  }
}

function insert(node: QuadNode, body: Body): void {
  // Empty leaf — place body here
  if (node.mass === 0 && node.body === null) {
    node.body = body;
    node.cx = body.x;
    node.cy = body.y;
    node.mass = 1;
    return;
  }

  // If leaf with existing body, push it down
  if (node.body !== null) {
    const existing = node.body;
    node.body = null;

    // If bodies are at the exact same position, nudge slightly to avoid infinite recursion
    if (existing.x === body.x && existing.y === body.y) {
      body.x += (Math.random() - 0.5) * 0.1;
      body.y += (Math.random() - 0.5) * 0.1;
    }

    const eq = quadrant(node, existing.x, existing.y);
    if (node.children[eq] === null) {
      const [x0, y0, x1, y1] = childBounds(node, eq);
      node.children[eq] = createNode(x0, y0, x1, y1);
    }
    insert(node.children[eq]!, existing);
  }

  // Insert new body into appropriate child
  const q = quadrant(node, body.x, body.y);
  if (node.children[q] === null) {
    const [x0, y0, x1, y1] = childBounds(node, q);
    node.children[q] = createNode(x0, y0, x1, y1);
  }
  insert(node.children[q]!, body);

  // Update aggregate center of mass
  const total = node.mass + 1;
  node.cx = (node.cx * node.mass + body.x) / total;
  node.cy = (node.cy * node.mass + body.y) / total;
  node.mass = total;
}

/**
 * Build a quadtree from an array of bodies.
 * Computes bounding box automatically with padding.
 */
export function buildQuadtree(bodies: Body[]): QuadNode | null {
  if (bodies.length === 0) return null;

  // Find bounding box
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const b of bodies) {
    if (b.x < minX) minX = b.x;
    if (b.y < minY) minY = b.y;
    if (b.x > maxX) maxX = b.x;
    if (b.y > maxY) maxY = b.y;
  }

  // Pad and square the bounds (quadtree needs square region)
  const pad = Math.max(maxX - minX, maxY - minY) * 0.1 + 50;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const half = Math.max(maxX - minX, maxY - minY) / 2 + pad;

  const root = createNode(cx - half, cy - half, cx + half, cy + half);
  for (const b of bodies) insert(root, b);
  return root;
}

/**
 * Apply Barnes-Hut repulsion forces to a single body.
 *
 * @param root      Quadtree root
 * @param body      The body to compute forces for
 * @param theta     Accuracy parameter (0.5–1.0). Higher = faster, less accurate.
 * @param strength  Base repulsion strength
 * @param alpha     Simulation alpha (decays over time)
 * @param minDist   Minimum distance clamp to avoid explosion
 */
export function applyRepulsion(
  root: QuadNode,
  body: Body,
  theta: number,
  strength: number,
  alpha: number,
  minDist: number,
): void {
  _walk(root, body, theta, strength, alpha, minDist);
}

function _walk(
  node: QuadNode,
  body: Body,
  theta: number,
  strength: number,
  alpha: number,
  minDist: number,
): void {
  if (node.mass === 0) return;

  const dx = node.cx - body.x;
  const dy = node.cy - body.y;
  const distSq = dx * dx + dy * dy;

  // If this is a leaf with a single body, compute direct force (skip self)
  if (node.body !== null) {
    if (node.body !== body) {
      let dist = Math.sqrt(distSq);
      if (dist < minDist) dist = minDist;
      const force = (strength * alpha) / (dist * dist);
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      body.vx -= fx;
      body.vy -= fy;
      // Newton's 3rd law applied in the caller loop to avoid double-counting
    }
    return;
  }

  // Barnes-Hut criterion: if node is far enough away, treat as aggregate
  const size = node.x1 - node.x0;
  if (size * size / distSq < theta * theta) {
    let dist = Math.sqrt(distSq);
    if (dist < minDist) dist = minDist;
    const force = (strength * node.mass * alpha) / (dist * dist);
    const fx = (dx / dist) * force;
    const fy = (dy / dist) * force;
    body.vx -= fx;
    body.vy -= fy;
    return;
  }

  // Otherwise, recurse into children
  for (let i = 0; i < 4; i++) {
    if (node.children[i] !== null) {
      _walk(node.children[i]!, body, theta, strength, alpha, minDist);
    }
  }
}
