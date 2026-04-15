import type { ViewerExtensionAPI, KBMountProvider, KBMountListResult, KBMountDocument } from "./viewer-api";

/**
 * kb-local extension — registers local filesystem mounts as KB providers.
 *
 * Loaded by the OSS viewer. Not loaded by backpack-app (which has its own
 * Go-backed KB). Delegates all document operations to the viewer's built-in
 * /api/kb/* server endpoints, which use DocumentStore + filesystem I/O.
 */

const unregisters: (() => void)[] = [];

export async function activate(viewer: ViewerExtensionAPI): Promise<void> {
  // Fetch configured mounts from the server
  const res = await fetch("/api/kb/mounts");
  if (!res.ok) return;
  const mounts = (await res.json()) as { name: string; path: string; writable: boolean; docCount: number; type?: string }[];

  // Register each local mount as a KB provider
  for (const m of mounts) {
    const provider: KBMountProvider = {
      name: m.name,
      label: m.name,
      type: "local",
      writable: m.writable,

      async list(opts?: { limit?: number; offset?: number }): Promise<KBMountListResult> {
        const params = new URLSearchParams({ collection: m.name });
        if (opts?.limit) params.set("limit", String(opts.limit));
        if (opts?.offset) params.set("offset", String(opts.offset));
        const r = await fetch(`/api/kb/documents?${params}`);
        if (!r.ok) return { documents: [], total: 0 };
        return r.json();
      },

      async read(id: string): Promise<KBMountDocument> {
        const r = await fetch(`/api/kb/documents/${encodeURIComponent(id)}`);
        if (!r.ok) throw new Error(`Document not found: ${id}`);
        return r.json();
      },

      async search(query: string, opts?: { limit?: number }): Promise<KBMountListResult> {
        const params = new URLSearchParams({ q: query, collection: m.name });
        if (opts?.limit) params.set("limit", String(opts.limit));
        const r = await fetch(`/api/kb/search?${params}`);
        if (!r.ok) return { documents: [], total: 0 };
        return r.json();
      },

      async save(doc: KBMountDocument): Promise<KBMountDocument> {
        const r = await fetch(`/api/kb/documents/${encodeURIComponent(doc.id)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...doc, collection: m.name }),
        });
        if (!r.ok) throw new Error(`Failed to save: ${r.status}`);
        return r.json();
      },

      async delete(id: string): Promise<void> {
        const r = await fetch(`/api/kb/documents/${encodeURIComponent(id)}`, { method: "DELETE" });
        if (!r.ok) throw new Error(`Failed to delete: ${r.status}`);
      },
    };

    const unreg = viewer.registerKBMount(provider);
    unregisters.push(unreg);
  }
}

export function deactivate(): void {
  for (const unreg of unregisters) unreg();
  unregisters.length = 0;
}
