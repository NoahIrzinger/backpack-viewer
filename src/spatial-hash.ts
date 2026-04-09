/**
 * Grid-based spatial hash for O(1) average-case point queries on nodes.
 * Cell size should be >= 2× the node radius so a node overlaps at most 4 cells.
 */

export interface Positioned {
  x: number;
  y: number;
}

export class SpatialHash<T extends Positioned> {
  private cells = new Map<number, T[]>();
  private cellSize: number;
  private invCell: number;

  constructor(cellSize: number) {
    this.cellSize = cellSize;
    this.invCell = 1 / cellSize;
  }

  private key(cx: number, cy: number): number {
    // Cantor-like hash combining two integers — fast and good enough for grid coords.
    // Shift to positive range first to avoid issues with negative coordinates.
    const a = (cx + 0x8000) | 0;
    const b = (cy + 0x8000) | 0;
    return (a * 73856093) ^ (b * 19349663);
  }

  clear(): void {
    this.cells.clear();
  }

  /** Insert an item at its current position. */
  insert(item: T): void {
    const cx = Math.floor(item.x * this.invCell);
    const cy = Math.floor(item.y * this.invCell);
    const k = this.key(cx, cy);
    const bucket = this.cells.get(k);
    if (bucket) bucket.push(item);
    else this.cells.set(k, [item]);
  }

  /** Rebuild from an array of items. */
  rebuild(items: T[]): void {
    this.cells.clear();
    for (const item of items) this.insert(item);
  }

  /** Find the nearest item within `radius` of (x, y), or null. */
  query(x: number, y: number, radius: number): T | null {
    const r2 = radius * radius;
    const cxMin = Math.floor((x - radius) * this.invCell);
    const cxMax = Math.floor((x + radius) * this.invCell);
    const cyMin = Math.floor((y - radius) * this.invCell);
    const cyMax = Math.floor((y + radius) * this.invCell);

    let best: T | null = null;
    let bestDist = r2;

    for (let cx = cxMin; cx <= cxMax; cx++) {
      for (let cy = cyMin; cy <= cyMax; cy++) {
        const bucket = this.cells.get(this.key(cx, cy));
        if (!bucket) continue;
        for (const item of bucket) {
          const dx = item.x - x;
          const dy = item.y - y;
          const d2 = dx * dx + dy * dy;
          if (d2 <= bestDist) {
            bestDist = d2;
            best = item;
          }
        }
      }
    }
    return best;
  }
}
