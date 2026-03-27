import { type KeybindingAction, type KeybindingMap, actionDescriptions } from "./keybindings";

// Non-keyboard actions shown at the bottom of help
const MOUSE_ACTIONS = [
  { key: "Click", description: "Select node" },
  { key: "Ctrl+Click", description: "Multi-select nodes" },
  { key: "Drag", description: "Pan canvas" },
  { key: "Scroll", description: "Zoom in/out" },
];

// Group and order for display
const ACTION_ORDER: KeybindingAction[] = [
  "search", "searchAlt", "undo", "redo", "help",
  "focus", "toggleEdges", "center",
  "nextNode", "prevNode", "nextConnection", "prevConnection",
  "historyBack", "historyForward",
  "hopsIncrease", "hopsDecrease",
  "panLeft", "panDown", "panUp", "panRight",
  "panFastLeft", "panFastRight", "zoomIn", "zoomOut",
  "spacingDecrease", "spacingIncrease",
  "clusteringDecrease", "clusteringIncrease",
  "escape",
];

/** Format a binding string for display (e.g. "ctrl+z" → "Ctrl+Z"). */
function formatBinding(binding: string): string {
  return binding
    .split("+")
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join("+");
}

export function initShortcuts(container: HTMLElement, bindings: KeybindingMap) {
  const descriptions = actionDescriptions();

  const overlay = document.createElement("div");
  overlay.className = "shortcuts-overlay hidden";

  const modal = document.createElement("div");
  modal.className = "shortcuts-modal";

  const title = document.createElement("h3");
  title.className = "shortcuts-title";
  title.textContent = "Keyboard Shortcuts";

  const list = document.createElement("div");
  list.className = "shortcuts-list";

  // Keybinding actions
  for (const action of ACTION_ORDER) {
    const binding = bindings[action];
    if (!binding) continue;

    const row = document.createElement("div");
    row.className = "shortcuts-row";

    const keys = document.createElement("div");
    keys.className = "shortcuts-keys";

    const kbd = document.createElement("kbd");
    kbd.textContent = formatBinding(binding);
    keys.appendChild(kbd);

    const desc = document.createElement("span");
    desc.className = "shortcuts-desc";
    desc.textContent = descriptions[action];

    row.appendChild(keys);
    row.appendChild(desc);
    list.appendChild(row);
  }

  // Mouse actions
  for (const s of MOUSE_ACTIONS) {
    const row = document.createElement("div");
    row.className = "shortcuts-row";

    const keys = document.createElement("div");
    keys.className = "shortcuts-keys";

    const kbd = document.createElement("kbd");
    kbd.textContent = s.key;
    keys.appendChild(kbd);

    const desc = document.createElement("span");
    desc.className = "shortcuts-desc";
    desc.textContent = s.description;

    row.appendChild(keys);
    row.appendChild(desc);
    list.appendChild(row);
  }

  const closeBtn = document.createElement("button");
  closeBtn.className = "shortcuts-close";
  closeBtn.textContent = "\u00d7";

  modal.appendChild(closeBtn);
  modal.appendChild(title);
  modal.appendChild(list);
  overlay.appendChild(modal);
  container.appendChild(overlay);

  function show() {
    overlay.classList.remove("hidden");
  }

  function hide() {
    overlay.classList.add("hidden");
  }

  function toggle() {
    overlay.classList.toggle("hidden");
  }

  closeBtn.addEventListener("click", hide);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) hide();
  });

  return { show, hide, toggle };
}
