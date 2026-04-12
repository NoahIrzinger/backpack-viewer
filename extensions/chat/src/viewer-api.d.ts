/**
 * Local declaration of the viewer extension API v1 contract.
 *
 * This file is intentionally a copy of (the public surface of)
 * `backpack-viewer/src/extensions/types.ts`. The duplication is the
 * pattern third-party extensions will use too — they declare what they
 * expect from the host. The viewerApi version field in the manifest
 * gives runtime safety against drift.
 *
 * Bumping `viewerApi` in the manifest = updating this file alongside
 * the source file in viewer's src/extensions/types.ts.
 */

export interface LearningGraphNode {
  id: string;
  type: string;
  properties: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
}

export interface LearningGraphEdge {
  id: string;
  sourceId: string;
  targetId: string;
  type: string;
}

export interface LearningGraphData {
  metadata: { name: string; description?: string; createdAt?: string; updatedAt?: string };
  nodes: LearningGraphNode[];
  edges: LearningGraphEdge[];
}

export interface ViewerFocusSnapshot {
  seedNodeIds: string[];
  hops: number;
  totalNodes: number;
}

export type ViewerEvent =
  | "graph-changed"
  | "graph-switched"
  | "selection-changed"
  | "focus-changed";

export type TaskbarPosition =
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right";

export interface TaskbarIconOptions {
  label: string;
  iconText?: string;
  position?: TaskbarPosition;
  onClick: () => void;
}

export interface PanelHeaderButton {
  label: string;
  iconText?: string;
  onClick: () => void;
  disabled?: boolean;
}

export interface MountPanelOptions {
  title?: string;
  defaultPosition?: { left: number; top: number };
  headerButtons?: PanelHeaderButton[];
  showFullscreenButton?: boolean;
  showCloseButton?: boolean;
  hideOnClose?: boolean;
  persistKey?: string;
  onClose?: () => void;
  onFullscreenChange?: (fullscreen: boolean) => void;
}

export interface MountedPanel {
  close(): void;
  setFullscreen(fullscreen: boolean): void;
  isFullscreen(): boolean;
  setTitle(title: string): void;
  setHeaderButtons(buttons: PanelHeaderButton[]): void;
  setVisible(visible: boolean): void;
  isVisible(): boolean;
  bringToFront(): void;
  element: HTMLElement;
}

export interface ViewerExtensionAPI {
  readonly name: string;
  readonly viewerApiVersion: "1";

  getGraph(): LearningGraphData | null;
  getGraphName(): string;
  getSelection(): string[];
  getFocus(): ViewerFocusSnapshot | null;

  on(event: ViewerEvent, callback: () => void): () => void;

  addNode(type: string, properties: Record<string, unknown>): Promise<string>;
  updateNode(nodeId: string, properties: Record<string, unknown>): Promise<void>;
  removeNode(nodeId: string): Promise<void>;
  addEdge(sourceId: string, targetId: string, type: string): Promise<string>;
  removeEdge(edgeId: string): Promise<void>;

  panToNode(nodeId: string): void;
  focusNodes(nodeIds: string[], hops: number): void;
  exitFocus(): void;

  registerTaskbarIcon(opts: TaskbarIconOptions): () => void;
  mountPanel(element: HTMLElement, opts?: MountPanelOptions): MountedPanel;

  settings: {
    get<T = unknown>(key: string): Promise<T | null>;
    set(key: string, value: unknown): Promise<void>;
    remove(key: string): Promise<void>;
  };

  fetch(url: string, init?: RequestInit): Promise<Response>;
}
