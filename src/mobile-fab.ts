/**
 * Mobile FAB: a small floating action button + popup menu that lets
 * users open the sidebar (and other panels) on narrow viewports
 * without having the panels eat half the screen.
 *
 * The CSS in style.css already hides the sidebar by default below 768px
 * and shows it as a slide-in overlay when body has class
 * "bp-mobile-open". This module just wires the FAB and menu DOM to
 * toggle that class. Hosts can pass extraItems to surface their own
 * actions (rename, share, delete, etc.) without competing with the
 * minimap for canvas space.
 */

export interface MobileFabExtraItem {
  label: string;
  onClick: () => void | Promise<void>;
  danger?: boolean;
}

export interface MobileFabOptions {
  getActiveBackpackName?: () => string | null;
  extraItems?: MobileFabExtraItem[] | (() => MobileFabExtraItem[]);
}

export function initMobileFab(opts: MobileFabOptions = {}): void {
  if (document.querySelector(".bp-fab")) return;

  const chip = document.createElement("div");
  chip.className = "bp-mobile-chip";
  chip.id = "bp-mobile-chip";
  document.body.appendChild(chip);

  const refreshChip = () => {
    const name = opts.getActiveBackpackName?.() ?? null;
    chip.textContent = name ?? "Backpack";
  };
  refreshChip();
  setInterval(refreshChip, 1500);

  const fab = document.createElement("button");
  fab.type = "button";
  fab.className = "bp-fab";
  fab.setAttribute("aria-label", "Open menu");
  fab.textContent = "☰";

  const menu = document.createElement("div");
  menu.className = "bp-fab-menu";
  menu.setAttribute("role", "menu");

  const closeMenu = () => menu.classList.remove("open");
  const closeAllPanels = () => {
    document.body.classList.remove("bp-mobile-open");
    document.querySelectorAll<HTMLElement>(".info-panel, .extension-panel").forEach((el) => {
      if (!el.hidden) el.hidden = true;
    });
  };

  function appendItem(label: string, onClick: () => void | Promise<void>, danger = false) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "bp-fab-menu-item" + (danger ? " bp-fab-menu-item-danger" : "");
    btn.textContent = label;
    btn.addEventListener("click", () => {
      closeMenu();
      void onClick();
    });
    menu.appendChild(btn);
  }

  function rebuildMenu() {
    menu.replaceChildren();
    appendItem("Sidebar", () => { document.body.classList.toggle("bp-mobile-open"); });
    appendItem("Search", () => {
      const search = document.querySelector<HTMLInputElement>(".search-input-wrap input, input[type=search]");
      search?.focus();
    });
    const extras = typeof opts.extraItems === "function" ? opts.extraItems() : (opts.extraItems ?? []);
    for (const item of extras) appendItem(item.label, item.onClick, item.danger);
    appendItem("Close panels", closeAllPanels);
  }

  fab.addEventListener("click", (e) => {
    e.stopPropagation();
    if (menu.classList.contains("open")) {
      closeMenu();
    } else {
      rebuildMenu();
      menu.classList.add("open");
    }
  });

  document.addEventListener("click", (e) => {
    if (!menu.classList.contains("open")) return;
    if (menu.contains(e.target as Node)) return;
    if (e.target === fab) return;
    closeMenu();
  });

  document.body.appendChild(fab);
  document.body.appendChild(menu);

  document.addEventListener("click", (e) => {
    if (!document.body.classList.contains("bp-mobile-open")) return;
    const target = e.target as HTMLElement;
    if (target.closest("#sidebar")) return;
    if (target === fab || menu.contains(target)) return;
    if (target === document.body || target === document.documentElement) {
      document.body.classList.remove("bp-mobile-open");
    }
  });
}
