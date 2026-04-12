import type {
  MountPanelOptions,
  MountedPanel,
  PanelHeaderButton,
} from "./types";
import { makeSvgIcon } from "../dom-utils";

/**
 * Panel mount surface — wraps an extension-provided body element with
 * standard chrome (title, custom buttons, fullscreen toggle, close X)
 * and makes it draggable + click-to-front + position-persistent.
 *
 * Layout policy:
 *   - Each panel positions itself via inline left/top from JS, so
 *     drag-to-move is just updating those properties.
 *   - The user grabs the title bar to move the panel anywhere within
 *     the canvas container. Bounds-clamped so the title bar stays
 *     visible.
 *   - Click anywhere on a panel raises it above all other panels via
 *     a shared z-index counter. The counter is module-global so
 *     info-panel and extension panels share the same focus stack.
 *   - Position + fullscreen state are persisted to localStorage per
 *     panel key, so dragging + maximize survive page refreshes.
 *
 * No region/dock vocabulary, no automatic collision avoidance — if
 * two panels overlap, the user drags one out of the way. The user is
 * the layout coordinator.
 */
export interface PanelMount {
  mount(extName: string, body: HTMLElement, opts?: MountPanelOptions): MountedPanel;
}

const PANEL_TIER_BASE = 30;       // matches --z-panel
const PANEL_TIER_MAX = 39;        // last value before --z-floating (40); reset above this
const FULLSCREEN_Z = 45;          // matches --z-panel-fullscreen — above secondary floating, below floating-primary (search bar)
const DEFAULT_PANEL_WIDTH = 380;
const DEFAULT_TOP_OFFSET = 70;
const DEFAULT_RIGHT_MARGIN = 16;
const MIN_VISIBLE_AFTER_DRAG = 80;
const STORAGE_PREFIX = "backpack-viewer:panel:";
const FULLSCREEN_PARENT_CLASS = "has-fullscreen-panel";

/**
 * Module-global click-to-front counter shared by all panels (info-panel
 * AND extension panels). Click any panel and it bumps it above the
 * other panels in the panel tier. Reset on page reload.
 *
 * If the counter ever exceeds PANEL_TIER_MAX (e.g., the user clicks
 * many panels back and forth), all panels reset to base+1 and the
 * counter resumes — this prevents panels from leaking into the
 * floating tier and overlapping the top bar.
 */
let topZ = PANEL_TIER_BASE;
function bringPanelToFront(panel: HTMLElement) {
  topZ++;
  if (topZ > PANEL_TIER_MAX) {
    // Compress: reset every panel in the layer to base+1, then
    // promote this one. Counter resumes from base+2.
    document.querySelectorAll(".extension-panel").forEach((p) => {
      (p as HTMLElement).style.zIndex = String(PANEL_TIER_BASE + 1);
    });
    topZ = PANEL_TIER_BASE + 2;
  }
  panel.style.zIndex = String(topZ);
}

/**
 * Ref-count of panels currently in fullscreen mode. The has-fullscreen
 * class is added to #canvas-container while count > 0 and removed when
 * it drops to 0. CSS uses the class to hide secondary top-bar controls
 * (zoom, theme, copy-prompt, sidebar-expand, taskbar slots) so they
 * don't visually conflict with the fullscreen panel's chrome buttons.
 */
let fullscreenCount = 0;
function notifyFullscreenChange(parent: HTMLElement, entering: boolean) {
  // Walk up to #canvas-container — that's where the class lives.
  // If parent is the canvas container itself, use it directly.
  const target =
    parent.id === "canvas-container"
      ? parent
      : parent.closest("#canvas-container") ?? parent;
  if (entering) {
    fullscreenCount++;
  } else {
    fullscreenCount = Math.max(0, fullscreenCount - 1);
  }
  target.classList.toggle(FULLSCREEN_PARENT_CLASS, fullscreenCount > 0);
}

interface PersistedState {
  left?: number;
  top?: number;
  fullscreen?: boolean;
}

function loadPersistedState(key: string): PersistedState | null {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed as PersistedState;
  } catch {
    /* ignore — best effort */
  }
  return null;
}

function savePersistedState(key: string, state: PersistedState): void {
  try {
    localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(state));
  } catch {
    /* ignore — quota exceeded etc */
  }
}

/** Build a fullscreen-toggle SVG icon (4 corner arrows). */
function makeFullscreenIcon(): SVGSVGElement {
  return makeSvgIcon(
    { size: 13, strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round" },
    [
      { tag: "polyline", attrs: { points: "4 9 4 4 9 4" } },
      { tag: "polyline", attrs: { points: "20 9 20 4 15 4" } },
      { tag: "polyline", attrs: { points: "4 15 4 20 9 20" } },
      { tag: "polyline", attrs: { points: "20 15 20 20 15 20" } },
    ],
  );
}

/** Build a restore-from-fullscreen SVG icon (4 inward arrows). */
function makeRestoreIcon(): SVGSVGElement {
  return makeSvgIcon(
    { size: 13, strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round" },
    [
      { tag: "polyline", attrs: { points: "9 4 9 9 4 9" } },
      { tag: "polyline", attrs: { points: "15 4 15 9 20 9" } },
      { tag: "polyline", attrs: { points: "9 20 9 15 4 15" } },
      { tag: "polyline", attrs: { points: "15 20 15 15 20 15" } },
    ],
  );
}

export function createPanelMount(parent: HTMLElement): PanelMount {
  const layer = document.createElement("div");
  layer.className = "extension-panel-layer";
  parent.appendChild(layer);

  function defaultPosition(): { left: number; top: number } {
    const parentRect = parent.getBoundingClientRect();
    const left = Math.max(0, parentRect.width - DEFAULT_PANEL_WIDTH - DEFAULT_RIGHT_MARGIN);
    return { left, top: DEFAULT_TOP_OFFSET };
  }

  function clampPosition(
    pos: { left: number; top: number },
    panelRect: DOMRect,
  ): { left: number; top: number } {
    const parentRect = parent.getBoundingClientRect();
    const minLeft = MIN_VISIBLE_AFTER_DRAG - panelRect.width;
    const maxLeft = parentRect.width - MIN_VISIBLE_AFTER_DRAG;
    const minTop = 0;
    const maxTop = parentRect.height - 40;
    return {
      left: Math.max(minLeft, Math.min(maxLeft, pos.left)),
      top: Math.max(minTop, Math.min(maxTop, pos.top)),
    };
  }

  function mount(
    extName: string,
    body: HTMLElement,
    opts: MountPanelOptions = {},
  ): MountedPanel {
    const persistKey = opts.persistKey ?? extName;
    const persisted = loadPersistedState(persistKey);

    const root = document.createElement("aside");
    root.className = "extension-panel";
    root.dataset.panel = persistKey;

    // --- Header (drag handle + chrome) ---
    const header = document.createElement("div");
    header.className = "extension-panel-header";

    const titleEl = document.createElement("span");
    titleEl.className = "extension-panel-title";
    titleEl.textContent = opts.title ?? extName;
    header.appendChild(titleEl);

    // Custom header buttons get their own container so setHeaderButtons
    // can replace its children without disturbing the built-in controls.
    const customBtnContainer = document.createElement("div");
    customBtnContainer.className = "extension-panel-custom-btns";
    header.appendChild(customBtnContainer);

    function renderCustomButtons(buttons: PanelHeaderButton[]) {
      customBtnContainer.replaceChildren();
      for (const spec of buttons) {
        const btn = document.createElement("button");
        btn.className = "extension-panel-btn";
        btn.title = spec.label;
        btn.setAttribute("aria-label", spec.label);
        btn.textContent = spec.iconText ?? spec.label;
        if (spec.disabled) btn.disabled = true;
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          try {
            spec.onClick();
          } catch (err) {
            console.error(`[backpack-viewer] panel header button "${spec.label}" threw:`, err);
          }
        });
        // Buttons live inside the header (which is the drag handle), so
        // mousedown must not start a drag.
        btn.addEventListener("mousedown", (e) => e.stopPropagation());
        customBtnContainer.appendChild(btn);
      }
    }
    renderCustomButtons(opts.headerButtons ?? []);

    // --- Built-in fullscreen + close buttons ---
    let fullscreen = false;

    let fullscreenBtn: HTMLButtonElement | null = null;
    let fullscreenIconEl: SVGSVGElement | null = null;
    if (opts.showFullscreenButton !== false) {
      fullscreenBtn = document.createElement("button");
      fullscreenBtn.className = "extension-panel-btn extension-panel-btn-fullscreen";
      fullscreenBtn.title = "Toggle fullscreen";
      fullscreenBtn.setAttribute("aria-label", "Toggle fullscreen");
      fullscreenIconEl = makeFullscreenIcon();
      fullscreenBtn.appendChild(fullscreenIconEl);
      fullscreenBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        setFullscreen(!fullscreen);
      });
      fullscreenBtn.addEventListener("mousedown", (e) => e.stopPropagation());
      header.appendChild(fullscreenBtn);
    }

    let closeBtn: HTMLButtonElement | null = null;
    if (opts.showCloseButton !== false) {
      closeBtn = document.createElement("button");
      closeBtn.className = "extension-panel-btn extension-panel-btn-close";
      closeBtn.title = "Close panel";
      closeBtn.setAttribute("aria-label", "Close panel");
      closeBtn.textContent = "\u00d7";
      closeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (opts.hideOnClose) {
          setVisible(false);
          // Fire onClose for hideOnClose panels too — owners may want
          // to reset state.
          try {
            opts.onClose?.();
          } catch (err) {
            console.error("[backpack-viewer] panel onClose threw:", err);
          }
        } else {
          close();
        }
      });
      closeBtn.addEventListener("mousedown", (e) => e.stopPropagation());
      header.appendChild(closeBtn);
    }

    root.appendChild(header);

    // --- Body ---
    const bodyWrap = document.createElement("div");
    bodyWrap.className = "extension-panel-body";
    bodyWrap.appendChild(body);
    root.appendChild(bodyWrap);

    layer.appendChild(root);

    // --- Initial position ---
    // Priority: persisted > opts.defaultPosition > computed default
    const initial = (persisted && persisted.left != null && persisted.top != null)
      ? { left: persisted.left, top: persisted.top }
      : (opts.defaultPosition ?? defaultPosition());

    // Bounds-clamp the restored position in case the viewport shrank
    // since it was saved (otherwise the panel could end up off-screen
    // and unrecoverable).
    const initialRect = { width: DEFAULT_PANEL_WIDTH, height: 200 } as DOMRect;
    const clampedInitial = clampPosition(initial, initialRect);
    root.style.left = clampedInitial.left + "px";
    root.style.top = clampedInitial.top + "px";
    bringPanelToFront(root);

    // --- Drag handling ---
    let dragStartX = 0;
    let dragStartY = 0;
    let panelStartLeft = 0;
    let panelStartTop = 0;
    let dragging = false;

    function onMouseMove(e: MouseEvent) {
      if (!dragging) return;
      const dx = e.clientX - dragStartX;
      const dy = e.clientY - dragStartY;
      const next = clampPosition(
        { left: panelStartLeft + dx, top: panelStartTop + dy },
        root.getBoundingClientRect(),
      );
      root.style.left = next.left + "px";
      root.style.top = next.top + "px";
    }

    function onMouseUp() {
      if (!dragging) return;
      dragging = false;
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      // Persist the new position
      const rect = root.getBoundingClientRect();
      const parentRect = parent.getBoundingClientRect();
      savePersistedState(persistKey, {
        ...loadPersistedState(persistKey),
        left: rect.left - parentRect.left,
        top: rect.top - parentRect.top,
      });
    }

    header.addEventListener("mousedown", (e) => {
      if (fullscreen) return; // can't drag while fullscreen
      // Buttons inside the header stop propagation already, so we know
      // this came from the title area or empty space.
      dragging = true;
      dragStartX = e.clientX;
      dragStartY = e.clientY;
      const rect = root.getBoundingClientRect();
      const parentRect = parent.getBoundingClientRect();
      panelStartLeft = rect.left - parentRect.left;
      panelStartTop = rect.top - parentRect.top;
      bringPanelToFront(root);
      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
      e.preventDefault();
    });

    // Click anywhere on the panel raises it.
    root.addEventListener(
      "mousedown",
      () => {
        if (!fullscreen) bringPanelToFront(root);
      },
      { capture: true },
    );

    // --- Lifecycle ---
    let closed = false;
    let visible = true;

    function close() {
      if (closed) return;
      closed = true;
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      // If this panel was in fullscreen, decrement the global counter
      // so the parent class clears properly.
      if (fullscreen) {
        notifyFullscreenChange(parent, false);
        fullscreen = false;
      }
      root.remove();
      try {
        opts.onClose?.();
      } catch (err) {
        console.error("[backpack-viewer] panel onClose threw:", err);
      }
    }

    function setVisible(value: boolean) {
      if (value === visible) return;
      visible = value;
      root.classList.toggle("is-hidden", !visible);
      if (visible) {
        bringPanelToFront(root);
        // If we were fullscreen when hidden, the global counter was
        // decremented; restore it now that we're visible again.
        if (fullscreen) {
          notifyFullscreenChange(parent, true);
        }
      } else if (fullscreen) {
        // Hidden while fullscreen — decrement the global counter so
        // other panels and the top bar reappear.
        notifyFullscreenChange(parent, false);
      }
    }

    function setFullscreen(value: boolean) {
      if (value === fullscreen) return;
      fullscreen = value;
      root.classList.toggle("is-fullscreen", fullscreen);
      // Swap the icon between the fullscreen-out and restore-in glyphs
      if (fullscreenBtn && fullscreenIconEl) {
        fullscreenIconEl.remove();
        fullscreenIconEl = fullscreen ? makeRestoreIcon() : makeFullscreenIcon();
        fullscreenBtn.appendChild(fullscreenIconEl);
      }
      // Bump z-index above secondary floating tier when fullscreen so
      // the panel covers zoom/theme/copy-prompt; restore to the
      // panel-tier counter when not. The search bar lives at
      // --z-floating-primary above this and stays visible.
      if (fullscreen) {
        root.style.zIndex = String(FULLSCREEN_Z);
      } else {
        bringPanelToFront(root);
      }
      // Toggle the parent class so CSS hides secondary controls
      notifyFullscreenChange(parent, fullscreen);
      // Persist
      savePersistedState(persistKey, {
        ...loadPersistedState(persistKey),
        fullscreen,
      });
      try {
        opts.onFullscreenChange?.(fullscreen);
      } catch (err) {
        console.error("[backpack-viewer] panel onFullscreenChange threw:", err);
      }
    }

    // Restore fullscreen state if persisted
    if (persisted?.fullscreen) {
      setFullscreen(true);
    }

    function setTitle(t: string) {
      titleEl.textContent = t;
    }

    function setHeaderButtons(buttons: PanelHeaderButton[]) {
      renderCustomButtons(buttons);
    }

    return {
      close,
      setFullscreen,
      isFullscreen: () => fullscreen,
      setTitle,
      setHeaderButtons,
      setVisible,
      isVisible: () => visible,
      bringToFront: () => bringPanelToFront(root),
      element: body,
    };
  }

  return { mount };
}
