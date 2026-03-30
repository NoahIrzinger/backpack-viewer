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
      { label: isStarred ? "\u2605 Unstar" : "\u2606 Star", action: () => callbacks.onStar(nodeId) },
      { label: "\uD83D\uDD0D Focus on node", action: () => callbacks.onFocusNode(nodeId) },
      { label: "\uD83C\uDF3F Explore in branch", action: () => callbacks.onExploreInBranch(nodeId) },
      { label: "\uD83D\uDCCB Copy ID", action: () => callbacks.onCopyId(nodeId) },
    ];

    if (callbacks.onExpand) items.push({ label: "\uD83D\uDD2D Expand node", action: () => callbacks.onExpand!(nodeId) });
    if (callbacks.onExplainPath) items.push({ label: "\uD83D\uDCA1 Explain path to...", action: () => callbacks.onExplainPath!(nodeId) });
    if (callbacks.onEnrich) items.push({ label: "\uD83D\uDCDA Enrich from web", action: () => callbacks.onEnrich!(nodeId) });

    let addedSep = false;
    for (const item of items) {
      if (!addedSep && (item.label.startsWith("\uD83D\uDD2D") || item.label.startsWith("\uD83D\uDCA1") || item.label.startsWith("\uD83D\uDCDA"))) {
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
