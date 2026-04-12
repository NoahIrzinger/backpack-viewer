/**
 * Tiny DOM helpers used across the viewer to avoid `innerHTML` for
 * static SVG icons and other markup that previously got built as
 * strings. Keeps every call site CSP-clean and XSS-safe by construction
 * (no string concatenation, no parsing of user content).
 */

const SVG_NS = "http://www.w3.org/2000/svg";

export interface SvgIconOptions {
  /** SVG viewBox attribute, e.g. "0 0 24 24" */
  viewBox?: string;
  /** Width and height in pixels (sets both attributes) */
  size?: number;
  /** Stroke width */
  strokeWidth?: number;
  /** Stroke linecap */
  strokeLinecap?: "round" | "square" | "butt";
  /** Stroke linejoin */
  strokeLinejoin?: "round" | "miter" | "bevel";
  /** Optional CSS class for the root <svg> */
  className?: string;
}

/**
 * Build an SVG icon from a list of child element specs. Each spec is
 * `{ tag, attrs }` where tag is one of the standard SVG element names.
 *
 * Example:
 *   makeSvgIcon({ size: 14 }, [
 *     { tag: "polyline", attrs: { points: "11 17 6 12 11 7" } },
 *     { tag: "polyline", attrs: { points: "18 17 13 12 18 7" } },
 *   ])
 */
export function makeSvgIcon(
  opts: SvgIconOptions,
  children: { tag: string; attrs: Record<string, string | number> }[],
): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  const size = opts.size ?? 16;
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("viewBox", opts.viewBox ?? "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", String(opts.strokeWidth ?? 2));
  if (opts.strokeLinecap) svg.setAttribute("stroke-linecap", opts.strokeLinecap);
  if (opts.strokeLinejoin) svg.setAttribute("stroke-linejoin", opts.strokeLinejoin);
  if (opts.className) svg.setAttribute("class", opts.className);

  for (const child of children) {
    const el = document.createElementNS(SVG_NS, child.tag);
    for (const [k, v] of Object.entries(child.attrs)) {
      el.setAttribute(k, String(v));
    }
    svg.appendChild(el);
  }
  return svg;
}

/**
 * Snapshot the current children of an element so they can be restored
 * later via `restoreChildren()`. Used by inline-edit flows that
 * temporarily replace a row's contents with an input.
 *
 * Returns a frozen array of cloned nodes — the original references are
 * NOT preserved (which would break if the parent is mutated). Cloning
 * is fine because the snapshotted markup is static — no event handlers
 * to lose.
 */
export function snapshotChildren(el: Element): Node[] {
  return Array.from(el.childNodes).map((n) => n.cloneNode(true));
}

export function restoreChildren(el: Element, snapshot: Node[]): void {
  el.replaceChildren(...snapshot);
}
