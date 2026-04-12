import type {
  ViewerExtensionAPI,
  ViewerHost,
  ViewerEvent,
  TaskbarIconOptions,
  MountPanelOptions,
  MountedPanel,
} from "./types";
import { VIEWER_API_VERSION } from "./types";
import type { Taskbar } from "./taskbar";
import type { PanelMount } from "./panel-mount";

/**
 * Construct a per-extension `ViewerExtensionAPI` instance. Each loaded
 * extension gets its own API object whose closures know its name — that
 * scoping is what makes per-extension settings + per-extension fetch
 * proxies work.
 *
 * The API surface is intentionally minimal in v1: graph reads, graph
 * mutations (auto-undo, auto-persist, auto-rerender), viewer driving,
 * mount surfaces, settings, network proxy. Anything else extensions
 * need will get added in v2 with a viewerApi version bump.
 */
export function createExtensionAPI(
  extensionName: string,
  host: ViewerHost,
  taskbar: Taskbar,
  panelMount: PanelMount,
): ViewerExtensionAPI {
  function newId(): string {
    // Sufficient for client-side ids; backpack-ontology accepts arbitrary
    // string ids and we already use a similar pattern in main.ts callbacks.
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }

  function ensureGraph() {
    const data = host.getGraph();
    if (!data) throw new Error("no graph loaded in viewer");
    return data;
  }

  return {
    name: extensionName,
    viewerApiVersion: VIEWER_API_VERSION,

    // --- Graph reads ---
    getGraph: () => host.getGraph(),
    getGraphName: () => host.getGraphName(),
    getSelection: () => host.getSelection(),
    getFocus: () => host.getFocus(),

    // --- Events ---
    on(event: ViewerEvent, callback: () => void) {
      return host.subscribe(event, callback);
    },

    // --- Graph mutations ---
    async addNode(type, properties) {
      if (!type) throw new Error("addNode: type is required");
      const data = ensureGraph();
      host.snapshotForUndo();
      const id = newId();
      const now = new Date().toISOString();
      data.nodes.push({
        id,
        type,
        properties: properties as Record<string, string | number | boolean | null>,
        createdAt: now,
        updatedAt: now,
      } as any);
      await host.saveCurrentGraph();
      return id;
    },

    async updateNode(nodeId, properties) {
      const data = ensureGraph();
      const node = data.nodes.find((n) => n.id === nodeId);
      if (!node) throw new Error(`updateNode: node not found: ${nodeId}`);
      host.snapshotForUndo();
      node.properties = { ...node.properties, ...(properties as any) };
      node.updatedAt = new Date().toISOString();
      await host.saveCurrentGraph();
    },

    async removeNode(nodeId) {
      const data = ensureGraph();
      const node = data.nodes.find((n) => n.id === nodeId);
      if (!node) throw new Error(`removeNode: node not found: ${nodeId}`);
      host.snapshotForUndo();
      data.nodes = data.nodes.filter((n) => n.id !== nodeId);
      data.edges = data.edges.filter(
        (e) => e.sourceId !== nodeId && e.targetId !== nodeId,
      );
      await host.saveCurrentGraph();
    },

    async addEdge(sourceId, targetId, type) {
      if (!sourceId || !targetId || !type) {
        throw new Error("addEdge: sourceId, targetId, and type are required");
      }
      const data = ensureGraph();
      if (!data.nodes.find((n) => n.id === sourceId)) {
        throw new Error(`addEdge: source not found: ${sourceId}`);
      }
      if (!data.nodes.find((n) => n.id === targetId)) {
        throw new Error(`addEdge: target not found: ${targetId}`);
      }
      host.snapshotForUndo();
      const id = newId();
      data.edges.push({ id, sourceId, targetId, type } as any);
      await host.saveCurrentGraph();
      return id;
    },

    async removeEdge(edgeId) {
      const data = ensureGraph();
      const edge = data.edges.find((e) => e.id === edgeId);
      if (!edge) throw new Error(`removeEdge: edge not found: ${edgeId}`);
      host.snapshotForUndo();
      data.edges = data.edges.filter((e) => e.id !== edgeId);
      await host.saveCurrentGraph();
    },

    // --- Viewer driving ---
    panToNode: (nodeId: string) => host.panToNode(nodeId),
    focusNodes: (nodeIds: string[], hops: number) => host.focusNodes(nodeIds, hops),
    exitFocus: () => host.exitFocus(),

    // --- UI mounting ---
    registerTaskbarIcon(opts: TaskbarIconOptions): () => void {
      return taskbar.register(opts);
    },

    mountPanel(element: HTMLElement, opts?: MountPanelOptions): MountedPanel {
      return panelMount.mount(extensionName, element, opts);
    },

    // --- Settings ---
    settings: {
      async get<T = unknown>(key: string): Promise<T | null> {
        const url = `/api/extensions/${encodeURIComponent(extensionName)}/settings`;
        const res = await fetch(url);
        if (!res.ok) return null;
        const all = (await res.json()) as Record<string, unknown>;
        return key in all ? (all[key] as T) : null;
      },
      async set(key: string, value: unknown): Promise<void> {
        const url = `/api/extensions/${encodeURIComponent(extensionName)}/settings/${encodeURIComponent(key)}`;
        const res = await fetch(url, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ value }),
        });
        if (!res.ok) {
          const err = await res.text().catch(() => "");
          throw new Error(`settings.set failed: ${err || res.status}`);
        }
      },
      async remove(key: string): Promise<void> {
        const url = `/api/extensions/${encodeURIComponent(extensionName)}/settings/${encodeURIComponent(key)}`;
        const res = await fetch(url, { method: "DELETE" });
        if (!res.ok) {
          const err = await res.text().catch(() => "");
          throw new Error(`settings.remove failed: ${err || res.status}`);
        }
      },
    },

    // --- Network ---
    async fetch(url: string, init: RequestInit = {}): Promise<Response> {
      // The browser-side viewer.fetch wraps the call into a POST against
      // the per-extension proxy endpoint. The proxy validates the URL
      // against the manifest's network allowlist and injects any
      // configured headers (env-var or literal) server-side.
      const proxyUrl = `/api/extensions/${encodeURIComponent(extensionName)}/fetch`;
      const headers: Record<string, string> = {};
      if (init.headers) {
        if (init.headers instanceof Headers) {
          init.headers.forEach((v, k) => {
            headers[k] = v;
          });
        } else if (Array.isArray(init.headers)) {
          for (const [k, v] of init.headers) headers[k] = v;
        } else {
          Object.assign(headers, init.headers as Record<string, string>);
        }
      }
      const body =
        typeof init.body === "string" || init.body == null
          ? (init.body as string | undefined)
          : // RequestInit body can be many things; for v1 we only support
            // strings (which is what JSON-based APIs use). Throw on
            // anything else so extension authors get a clear error.
            (() => {
              throw new Error("viewer.fetch only supports string bodies in v1");
            })();
      return fetch(proxyUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url,
          method: init.method ?? "POST",
          headers,
          body,
        }),
      });
    },
  };
}
