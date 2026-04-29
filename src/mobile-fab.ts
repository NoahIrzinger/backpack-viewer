/**
 * Mobile FAB: a small floating action button + popup menu that lets
 * users open the sidebar (and other panels) on narrow viewports
 * without having the panels eat half the screen.
 *
 * The CSS in style.css already hides the sidebar by default below 768px
 * and shows it as a slide-in overlay when body has class
 * "bp-mobile-open". This module just wires the FAB and menu DOM to
 * toggle that class.
 */

export interface MobileFabOptions {
  getActiveBackpackName?: () => string | null;
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

  const items: Array<{ label: string; onClick: () => void }> = [
    {
      label: "Sidebar",
      onClick: () => {
        document.body.classList.toggle("bp-mobile-open");
        menu.classList.remove("open");
      },
    },
    {
      label: "Search",
      onClick: () => {
        const search = document.querySelector<HTMLInputElement>(".search-input-wrap input, input[type=search]");
        search?.focus();
        menu.classList.remove("open");
      },
    },
    {
      label: "Close panels",
      onClick: () => {
        document.body.classList.remove("bp-mobile-open");
        document.querySelectorAll<HTMLElement>(".info-panel, .extension-panel").forEach((el) => {
          if (!el.hidden) el.hidden = true;
        });
        menu.classList.remove("open");
      },
    },
  ];

  for (const item of items) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "bp-fab-menu-item";
    btn.textContent = item.label;
    btn.addEventListener("click", item.onClick);
    menu.appendChild(btn);
  }

  fab.addEventListener("click", (e) => {
    e.stopPropagation();
    menu.classList.toggle("open");
  });

  document.addEventListener("click", (e) => {
    if (!menu.classList.contains("open")) return;
    if (menu.contains(e.target as Node)) return;
    if (e.target === fab) return;
    menu.classList.remove("open");
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
