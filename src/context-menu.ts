export interface ContextMenuCallbacks {
  onStar: (nodeId: string) => void;
  onFocusNode: (nodeId: string) => void;
  onExploreInBranch: (nodeId: string) => void;
  onCopyId: (nodeId: string) => void;
  onExpand?: (nodeId: string) => void;
  onExplainPath?: (nodeId: string) => void;
  onEnrich?: (nodeId: string) => void;
}

export function initContextMenu(container: HTMLElement, callbacks: ContextMenuCallbacks) {
  let menuEl: HTMLElement | null = null;

  function show(nodeId: string, nodeLabel: string, isStarred: boolean, screenX: number, screenY: number) {
    hide();
    menuEl = document.createElement("div");
    menuEl.className = "context-menu";
    menuEl.style.left = `${screenX}px`;
    menuEl.style.top = `${screenY}px`;

    const items = [
      { label: isStarred ? "\u2605 Unstar" : "\u2606 Star", action: () => callbacks.onStar(nodeId), premium: false },
      { label: "\u25CE Focus on node", action: () => callbacks.onFocusNode(nodeId), premium: false },
      { label: "\u2442 Explore in branch", action: () => callbacks.onExploreInBranch(nodeId), premium: false },
      { label: "\u2398 Copy ID", action: () => callbacks.onCopyId(nodeId), premium: false },
    ];

    if (callbacks.onExpand) items.push({ label: "\u2295 Expand node", action: () => callbacks.onExpand!(nodeId), premium: true });
    if (callbacks.onExplainPath) items.push({ label: "\u2194 Explain path to\u2026", action: () => callbacks.onExplainPath!(nodeId), premium: true });
    if (callbacks.onEnrich) items.push({ label: "\u2261 Enrich from web", action: () => callbacks.onEnrich!(nodeId), premium: true });

    let addedSep = false;
    for (const item of items) {
      if (!addedSep && item.premium) {
        const sep = document.createElement("div");
        sep.className = "context-menu-separator";
        menuEl.appendChild(sep);
        addedSep = true;
      }

      const row = document.createElement("div");
      row.className = "context-menu-item";
      row.textContent = item.label;
      row.addEventListener("click", () => {
        item.action();
        hide();
      });
      menuEl.appendChild(row);
    }

    container.appendChild(menuEl);

    // Clamp to viewport
    const rect = menuEl.getBoundingClientRect();
    if (rect.right > window.innerWidth) {
      menuEl.style.left = `${screenX - rect.width}px`;
    }
    if (rect.bottom > window.innerHeight) {
      menuEl.style.top = `${screenY - rect.height}px`;
    }

    // Close on outside click (delayed to not catch the opening right-click)
    setTimeout(() => document.addEventListener("click", hide), 0);
    document.addEventListener("keydown", handleEscape);
  }

  function hide() {
    if (menuEl) {
      menuEl.remove();
      menuEl = null;
    }
    document.removeEventListener("click", hide);
    document.removeEventListener("keydown", handleEscape);
  }

  function handleEscape(e: KeyboardEvent) {
    if (e.key === "Escape") hide();
  }

  return { show, hide };
}
