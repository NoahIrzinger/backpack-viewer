import type { LearningGraphData } from "backpack-ontology";

/**
 * Versioned extension API contract.
 *
 * Bumping the major version means breaking changes for installed
 * extensions — extensions declare which version they target in their
 * manifest and the loader rejects mismatches.
 */
export const VIEWER_API_VERSION = "1" as const;
export type ViewerApiVersion = "1";

/**
 * Events an extension can subscribe to via `viewer.on(event, cb)`.
 *
 * - `graph-changed`: the active graph data was mutated (any source)
 * - `graph-switched`: the user switched to a different active graph
 * - `selection-changed`: the set of selected node ids changed
 * - `focus-changed`: focus mode was entered, exited, or modified
 */
export type ViewerEvent =
  | "graph-changed"
  | "graph-switched"
  | "selection-changed"
  | "focus-changed";

/** Snapshot of the viewer's current focus state. */
export interface ViewerFocusSnapshot {
  seedNodeIds: string[];
  hops: number;
  totalNodes: number;
}

/** Public extension API surface. */
export interface ViewerExtensionAPI {
  readonly name: string;
  readonly viewerApiVersion: ViewerApiVersion;

  // --- Graph reads ---
  getGraph(): LearningGraphData | null;
  getGraphName(): string;
  getSelection(): string[];
  getFocus(): ViewerFocusSnapshot | null;

  // --- Events ---
  on(event: ViewerEvent, callback: () => void): () => void;

  // --- Graph mutations (auto-undo, auto-persist, auto-rerender) ---
  addNode(type: string, properties: Record<string, unknown>): Promise<string>;
  updateNode(nodeId: string, properties: Record<string, unknown>): Promise<void>;
  removeNode(nodeId: string): Promise<void>;
  addEdge(sourceId: string, targetId: string, type: string): Promise<string>;
  removeEdge(edgeId: string): Promise<void>;

  // --- Viewer driving ---
  panToNode(nodeId: string): void;
  focusNodes(nodeIds: string[], hops: number): void;
  exitFocus(): void;

  // --- UI mounting ---
  registerTaskbarIcon(opts: TaskbarIconOptions): () => void;
  mountPanel(element: HTMLElement, opts?: MountPanelOptions): MountedPanel;

  // --- Per-extension persistent settings ---
  settings: ExtensionSettingsAPI;

  // --- Network (server-side proxy with manifest-declared origins) ---
  fetch(url: string, init?: RequestInit): Promise<Response>;
}

export type TaskbarPosition =
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-center"
  | "bottom-right";

export interface TaskbarIconOptions {
  /** Visible button text and accessible label */
  label: string;
  /** Optional leading symbol shown before the label (no SVG in v1) */
  iconText?: string;
  /**
   * Where to place the icon. Top slots nest into the viewer's existing
   * top bar (alongside zoom/theme controls); bottom slots float in the
   * canvas corners. Default: "bottom-right".
   */
  position?: TaskbarPosition;
  /** Click handler — usually toggles a panel */
  onClick: () => void;
}

/**
 * A custom button rendered in a panel's header, to the left of the
 * built-in fullscreen + close controls. Each button shares the same
 * visual style as the built-ins so extension chrome reads as one row
 * of controls.
 */
export interface PanelHeaderButton {
  label: string;
  /** Optional short text shown as the button content (defaults to label). */
  iconText?: string;
  onClick: () => void;
  disabled?: boolean;
}

export interface MountPanelOptions {
  /** Panel header title */
  title?: string;
  /**
   * Initial position relative to the canvas container (CSS pixels).
   * Defaults to a sensible right-side spot. If a persisted position
   * exists for this panel's persistence key, that wins over this
   * default. The user can drag the panel by its title bar from there.
   */
  defaultPosition?: { left: number; top: number };
  /** Custom buttons rendered before the built-in fullscreen + close. */
  headerButtons?: PanelHeaderButton[];
  /** Show the built-in fullscreen toggle button (default true). */
  showFullscreenButton?: boolean;
  /** Show the built-in close X button (default true). */
  showCloseButton?: boolean;
  /**
   * If true, clicking the X button hides the panel via setVisible(false)
   * instead of removing it from the DOM. Used by long-lived built-in
   * panels (like info-panel) which are mounted once and reused for
   * the lifetime of the viewer. Extensions typically leave this unset.
   */
  hideOnClose?: boolean;
  /**
   * Persistence key suffix. Position + fullscreen state are stored in
   * localStorage under `backpack-viewer:panel:<key>`. Defaults to the
   * extension/panel name passed to mount(). Set this if you need
   * multiple panels for the same name.
   */
  persistKey?: string;
  /**
   * Called once after the panel is closed for any reason — user
   * clicked the X button, the extension called `close()` itself, or
   * the panel was destroyed because the viewer is reloading. For
   * `hideOnClose` panels, this fires when the X is clicked too. The
   * callback fires at most once per close.
   */
  onClose?: () => void;
  /** Called whenever fullscreen state changes (button or programmatic). */
  onFullscreenChange?: (fullscreen: boolean) => void;
}

export interface MountedPanel {
  /** Remove the panel from the DOM (ignores hideOnClose). */
  close(): void;
  /** Toggle fullscreen state. */
  setFullscreen(fullscreen: boolean): void;
  /** Whether the panel is currently fullscreen. */
  isFullscreen(): boolean;
  /** Update the title shown in the header. */
  setTitle(title: string): void;
  /** Replace the custom header buttons. */
  setHeaderButtons(buttons: PanelHeaderButton[]): void;
  /** Show or hide the panel (without destroying it). */
  setVisible(visible: boolean): void;
  /** Whether the panel is currently visible. */
  isVisible(): boolean;
  /** Bring the panel to the front of the panel z-tier. */
  bringToFront(): void;
  /** The body element the extension owns (not the chrome). */
  element: HTMLElement;
}

export interface ExtensionSettingsAPI {
  get<T = unknown>(key: string): Promise<T | null>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
}

/**
 * Internal interface — what the extension API factory needs from main.ts
 * to construct a per-extension API instance. main.ts creates a single
 * "host" object and passes it to the API factory for each loaded
 * extension. The host is the abstraction barrier between extension code
 * and viewer internals.
 */
export interface ViewerHost {
  getGraph(): LearningGraphData | null;
  getGraphName(): string;
  getSelection(): string[];
  getFocus(): ViewerFocusSnapshot | null;

  /** Save current graph state. Caller is expected to mutate getGraph() in place first. */
  saveCurrentGraph(): Promise<void>;
  /** Push current graph onto undo stack. */
  snapshotForUndo(): void;

  /** Drive the canvas. */
  panToNode(nodeId: string): void;
  focusNodes(nodeIds: string[], hops: number): void;
  exitFocus(): void;

  /**
   * Taskbar slot containers (one per supported position). The host
   * creates these in main.ts; the extension API factory routes
   * `registerTaskbarIcon` calls into the right one based on the
   * extension's chosen position.
   */
  taskbarSlots: {
    topLeft: HTMLElement;
    topRight: HTMLElement;
    bottomLeft: HTMLElement;
    bottomCenter: HTMLElement;
    bottomRight: HTMLElement;
  };

  /** Subscribe to events emitted by the host. */
  subscribe(event: ViewerEvent, cb: () => void): () => void;
}
