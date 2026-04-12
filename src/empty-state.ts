import { makeSvgIcon } from "./dom-utils";

export function initEmptyState(container: HTMLElement) {
  const el = document.createElement("div");
  el.className = "empty-state";

  // Background circles + decorative line art
  const bg = document.createElement("div");
  bg.className = "empty-state-bg";
  for (const cls of ["c1", "c2", "c3", "c4", "c5"]) {
    const circle = document.createElement("div");
    circle.className = `empty-state-circle ${cls}`;
    bg.appendChild(circle);
  }
  bg.appendChild(
    makeSvgIcon(
      { size: 0, viewBox: "0 0 400 300", className: "empty-state-lines" },
      [
        { tag: "line", attrs: { x1: 80, y1: 60, x2: 220, y2: 140, "stroke-width": "0.5", opacity: "0.15" } },
        { tag: "line", attrs: { x1: 220, y1: 140, x2: 320, y2: 80, "stroke-width": "0.5", opacity: "0.15" } },
        { tag: "line", attrs: { x1: 220, y1: 140, x2: 160, y2: 240, "stroke-width": "0.5", opacity: "0.15" } },
        { tag: "line", attrs: { x1: 160, y1: 240, x2: 300, y2: 220, "stroke-width": "0.5", opacity: "0.15" } },
      ],
    ),
  );
  // makeSvgIcon sets width/height attrs; the lines layer is sized by CSS
  // (preserveAspectRatio comes from the empty-state-lines class).
  const linesSvg = bg.querySelector(".empty-state-lines");
  if (linesSvg) {
    linesSvg.removeAttribute("width");
    linesSvg.removeAttribute("height");
    linesSvg.setAttribute("preserveAspectRatio", "xMidYMid slice");
  }
  el.appendChild(bg);

  // Content card
  const content = document.createElement("div");
  content.className = "empty-state-content";

  const iconWrap = document.createElement("div");
  iconWrap.className = "empty-state-icon";
  iconWrap.appendChild(
    makeSvgIcon(
      { size: 48, strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round" },
      [
        { tag: "path", attrs: { d: "M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 002 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0022 16z" } },
        { tag: "polyline", attrs: { points: "3.27 6.96 12 12.01 20.73 6.96" } },
        { tag: "line", attrs: { x1: 12, y1: 22.08, x2: 12, y2: 12 } },
      ],
    ),
  );
  content.appendChild(iconWrap);

  const title = document.createElement("h2");
  title.className = "empty-state-title";
  title.textContent = "No learning graphs yet";
  content.appendChild(title);

  const desc = document.createElement("p");
  desc.className = "empty-state-desc";
  desc.textContent =
    "Connect Backpack to Claude, then start a conversation. Claude will build your first learning graph automatically.";
  content.appendChild(desc);

  const setup = document.createElement("div");
  setup.className = "empty-state-setup";
  const setupLabel = document.createElement("div");
  setupLabel.className = "empty-state-label";
  setupLabel.textContent = "Add Backpack to Claude Code:";
  const setupCode = document.createElement("code");
  setupCode.className = "empty-state-code";
  setupCode.textContent = "claude mcp add backpack-local -s user -- npx backpack-ontology@latest";
  setup.append(setupLabel, setupCode);
  content.appendChild(setup);

  const hint = document.createElement("p");
  hint.className = "empty-state-hint";
  hint.append("Press ");
  const kbd = document.createElement("kbd");
  kbd.textContent = "?";
  hint.appendChild(kbd);
  hint.append(" for keyboard shortcuts");
  content.appendChild(hint);

  el.appendChild(content);
  container.appendChild(el);

  return {
    show() { el.classList.remove("hidden"); },
    hide() { el.classList.add("hidden"); },
  };
}
