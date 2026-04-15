/**
 * Local declaration of the viewer extension API v1 contract.
 * See backpack-viewer/src/extensions/types.ts for the canonical version.
 */

export interface KBMountProvider {
  name: string;
  label?: string;
  type: "local" | "cloud" | "extension";
  writable: boolean;
  list(opts?: { limit?: number; offset?: number }): Promise<KBMountListResult>;
  read(id: string): Promise<KBMountDocument>;
  search?(query: string, opts?: { limit?: number }): Promise<KBMountListResult>;
  save?(doc: KBMountDocument): Promise<KBMountDocument>;
  delete?(id: string): Promise<void>;
}

export interface KBMountDocument {
  id: string;
  title: string;
  content: string;
  tags: string[];
  sourceGraphs: string[];
  sourceNodeIds: string[];
  collection: string;
  createdAt: string;
  updatedAt: string;
}

export interface KBMountListResult {
  documents: KBMountDocumentSummary[];
  total: number;
}

export interface KBMountDocumentSummary {
  id: string;
  title: string;
  tags: string[];
  sourceGraphs: string[];
  collection: string;
  createdAt: string;
  updatedAt: string;
}

export type TaskbarPosition = "top-left" | "top-right" | "bottom-left" | "bottom-center" | "bottom-right";

export interface TaskbarIconOptions {
  label: string;
  iconText?: string;
  position?: TaskbarPosition;
  onClick: () => void;
}

export interface MountedPanel {
  close(): void;
  setFullscreen(fullscreen: boolean): void;
  isFullscreen(): boolean;
  setTitle(title: string): void;
  setVisible(visible: boolean): void;
  isVisible(): boolean;
  bringToFront(): void;
  element: HTMLElement;
}

export interface MountPanelOptions {
  title?: string;
  defaultPosition?: { left: number; top: number };
  persistKey?: string;
  showFullscreenButton?: boolean;
  onClose?: () => void;
}

export interface ViewerExtensionAPI {
  readonly name: string;
  readonly viewerApiVersion: "1";

  getGraph(): unknown;
  getGraphName(): string;

  registerTaskbarIcon(opts: TaskbarIconOptions): () => void;
  mountPanel(element: HTMLElement, opts?: MountPanelOptions): MountedPanel;

  settings: {
    get<T = unknown>(key: string): Promise<T | null>;
    set(key: string, value: unknown): Promise<void>;
    remove(key: string): Promise<void>;
  };

  fetch(url: string, init?: RequestInit): Promise<Response>;

  registerKBMount(mount: KBMountProvider): () => void;
}
