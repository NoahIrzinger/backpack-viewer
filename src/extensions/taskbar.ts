import type { TaskbarIconOptions, TaskbarPosition } from "./types";

/**
 * Extension taskbar — routes registered icons into one of four slot
 * containers based on the icon's `position`. Slots are owned by the
 * host (created in main.ts) so the viewer controls where each slot
 * lives in the DOM:
 *
 *   - top-left, top-right    → nested into the existing top bar
 *                              alongside zoom/theme controls
 *   - bottom-left, bottom-right → floating in the canvas corners
 *
 * No slot lives at bottom-center; that area is reserved for the
 * viewer's path bar so the two never overlap.
 *
 * Each slot tracks its own icon count so it can toggle a `.has-icons`
 * class — bottom corner slots use it to stay invisible (and take no
 * space) until at least one extension is active.
 */
export interface TaskbarSlots {
  topLeft: HTMLElement;
  topRight: HTMLElement;
  bottomLeft: HTMLElement;
  bottomRight: HTMLElement;
}

export interface Taskbar {
  /** Register an icon. Returns an unregister function. */
  register(opts: TaskbarIconOptions): () => void;
}

const DEFAULT_POSITION: TaskbarPosition = "bottom-right";

export function createTaskbar(slots: TaskbarSlots): Taskbar {
  const slotMap: Record<TaskbarPosition, HTMLElement> = {
    "top-left": slots.topLeft,
    "top-right": slots.topRight,
    "bottom-left": slots.bottomLeft,
    "bottom-right": slots.bottomRight,
  };

  // Per-slot icon count so we can toggle visibility cleanly.
  const counts: Record<TaskbarPosition, number> = {
    "top-left": 0,
    "top-right": 0,
    "bottom-left": 0,
    "bottom-right": 0,
  };

  function refreshVisibility(pos: TaskbarPosition) {
    slotMap[pos].classList.toggle("has-icons", counts[pos] > 0);
  }
  // Initialize all slots — bottom corners start hidden, top slots
  // ignore the class entirely (they stay visible to host their
  // existing buttons).
  refreshVisibility("top-left");
  refreshVisibility("top-right");
  refreshVisibility("bottom-left");
  refreshVisibility("bottom-right");

  function register(opts: TaskbarIconOptions): () => void {
    const pos = opts.position ?? DEFAULT_POSITION;
    const slot = slotMap[pos];
    if (!slot) {
      throw new Error(`unknown taskbar position: ${pos}`);
    }

    const btn = document.createElement("button");
    btn.className = "extension-taskbar-icon";
    btn.title = opts.label;
    btn.setAttribute("aria-label", opts.label);
    if (opts.iconText) {
      const symbol = document.createElement("span");
      symbol.className = "extension-taskbar-icon-symbol";
      symbol.textContent = opts.iconText;
      btn.appendChild(symbol);
    }
    const labelEl = document.createElement("span");
    labelEl.className = "extension-taskbar-icon-label";
    labelEl.textContent = opts.label;
    btn.appendChild(labelEl);

    btn.addEventListener("click", () => {
      try {
        opts.onClick();
      } catch (err) {
        console.error(`[backpack-viewer] taskbar icon "${opts.label}" onClick threw:`, err);
      }
    });
    slot.appendChild(btn);
    counts[pos]++;
    refreshVisibility(pos);

    return () => {
      btn.remove();
      counts[pos] = Math.max(0, counts[pos] - 1);
      refreshVisibility(pos);
    };
  }

  return { register };
}
