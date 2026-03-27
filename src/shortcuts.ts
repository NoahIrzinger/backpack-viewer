const SHORTCUTS = [
  { key: "/", alt: "Ctrl+K", description: "Focus search" },
  { key: "Ctrl+Z", description: "Undo" },
  { key: "Ctrl+Shift+Z", description: "Redo" },
  { key: "?", description: "Toggle this help" },
  { key: "F", description: "Focus on selected / exit focus" },
  { key: "E", description: "Toggle edges on/off" },
  { key: ",  .", description: "Cycle previous / next node in view" },
  { key: "<  >", description: "Cycle previous / next connection" },
  { key: "(  )", description: "Node history back / forward" },
  { key: "C", description: "Center view on graph" },
  { key: "-  =", description: "Decrease / increase hops (in focus mode)" },
  { key: "h j k l", description: "Pan left / down / up / right" },
  { key: "H L", description: "Pan fast left / right" },
  { key: "J K", description: "Zoom out / zoom in" },
  { key: "[  ]", description: "Decrease / increase spacing" },
  { key: "{  }", description: "Decrease / increase clustering" },
  { key: "Esc", description: "Exit focus / close panel" },
  { key: "Click", description: "Select node" },
  { key: "Ctrl+Click", description: "Multi-select nodes" },
  { key: "Drag", description: "Pan canvas" },
  { key: "Scroll", description: "Zoom in/out" },
];

export function initShortcuts(container: HTMLElement) {
  const overlay = document.createElement("div");
  overlay.className = "shortcuts-overlay hidden";

  const modal = document.createElement("div");
  modal.className = "shortcuts-modal";

  const title = document.createElement("h3");
  title.className = "shortcuts-title";
  title.textContent = "Keyboard Shortcuts";

  const list = document.createElement("div");
  list.className = "shortcuts-list";

  for (const s of SHORTCUTS) {
    const row = document.createElement("div");
    row.className = "shortcuts-row";

    const keys = document.createElement("div");
    keys.className = "shortcuts-keys";

    const kbd = document.createElement("kbd");
    kbd.textContent = s.key;
    keys.appendChild(kbd);

    if (s.alt) {
      const or = document.createElement("span");
      or.className = "shortcuts-or";
      or.textContent = "or";
      keys.appendChild(or);

      const kbd2 = document.createElement("kbd");
      kbd2.textContent = s.alt;
      keys.appendChild(kbd2);
    }

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
