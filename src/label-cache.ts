/**
 * Offscreen canvas label cache.
 *
 * Pre-renders text labels to small offscreen canvases, then draws them
 * via drawImage() which is much faster than fillText() per frame.
 * Cache keys are "text|font|color" to handle theme changes.
 */

interface CachedLabel {
  canvas: OffscreenCanvas;
  width: number;
  height: number;
}

const cache = new Map<string, CachedLabel>();
const MAX_CACHE_SIZE = 2000;

function key(text: string, font: string, color: string): string {
  return `${text}|${font}|${color}`;
}

// Shared measurement canvas — reused across all renderLabel calls
const measureCanvas = new OffscreenCanvas(1, 1);
const measureCtx = measureCanvas.getContext("2d")!;

function renderLabel(text: string, font: string, color: string): CachedLabel {
  measureCtx.font = font;
  const metrics = measureCtx.measureText(text);
  const w = Math.ceil(metrics.width) + 2; // 1px padding each side
  const h = Math.ceil(metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent) + 4;

  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d")!;
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillText(text, 1, 1);

  return { canvas, width: w, height: h };
}

/**
 * Draw a cached label centered at (x, y) with the given baseline alignment.
 * Returns immediately — cache miss renders inline and stores for next frame.
 */
export function drawCachedLabel(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  font: string,
  color: string,
  align: "top" | "bottom",
): void {
  const k = key(text, font, color);
  let entry = cache.get(k);
  if (!entry) {
    // Evict oldest entries if cache is full
    if (cache.size >= MAX_CACHE_SIZE) {
      const first = cache.keys().next().value;
      if (first !== undefined) cache.delete(first);
    }
    entry = renderLabel(text, font, color);
    cache.set(k, entry);
  }

  const dx = x - entry.width / 2;
  const dy = align === "top" ? y : y - entry.height;
  ctx.drawImage(entry.canvas, dx, dy);
}

/** Clear the entire cache (call on theme change or graph reload). */
export function clearLabelCache(): void {
  cache.clear();
}
