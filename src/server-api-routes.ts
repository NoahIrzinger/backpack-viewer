import type { IncomingMessage, ServerResponse } from "node:http";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  type RemoteRegistry,
  JsonFileBackend,
  listBackpacks,
  getActiveBackpack,
  setActiveBackpack,
  registerBackpack,
  unregisterBackpack,
  getKBMounts,
  addKBMount,
  removeKBMount,
  editKBMount,
  DocumentStore,
  SignalStore,
  configDir,
  resolveAuthorName,
  CloudCacheBackend,
  SyncClient,
  SyncRelayClient,
  readSyncState,
  GRAPH_DETECTORS,
  CROSS_CUTTING_DETECTORS,
} from "backpack-ontology";
import type { ViewerConfig } from "./config.js";
import { readExtensionSettings, writeExtensionSetting } from "./server-extensions.js";

/**
 * Shared API route handler. Both `bin/serve.js` (production raw http)
 * and `vite.config.ts`'s middleware plugin (dev) call `handleApiRequest`
 * with the raw Node IncomingMessage/ServerResponse — they share the
 * exact same shape. Each entry only owns the static-file serving and
 * its own startup wiring.
 *
 * Before this module existed, every route below had two near-identical
 * copies (one per entry file) and adding/changing an endpoint required
 * editing both, with predictable drift bugs. Consolidated here into a
 * single source of truth.
 *
 * Storage handling: the active backpack can be swapped at runtime via
 * `/api/backpacks/switch`, which atomically replaces the storage
 * backend. The context holds a mutable wrapper so the swap is visible
 * to subsequent requests. Vite needs to broadcast a WebSocket event on
 * the swap; production has no WS channel, so the hook is optional.
 */

export interface BackpackEntry {
  name: string;
  path: string;
  color: string;
}

export interface ApiContext {
  /** Mutable wrapper around the storage backend so backpack-switch can swap it. */
  storage: { current: JsonFileBackend | CloudCacheBackend; activeEntry: BackpackEntry | null };
  remoteRegistry: RemoteRegistry;
  viewerConfig: ViewerConfig;
  /** Recreate the backend pointing at the active backpack. */
  makeBackend: () => Promise<{ backend: JsonFileBackend; entry: BackpackEntry }>;
  /** Cloud cache backend — always available, used when "Cloud" backpack is active. */
  cloudCache: CloudCacheBackend;
  /** Optional hook called after a successful backpack switch (vite uses this for WS broadcast). */
  onActiveBackpackChange?: () => void;
  /** How to answer GET /api/version-check. Differs between dev (always not-stale) and prod (cached npm lookup). */
  versionCheck: () => Promise<{ current: string; latest: string | null; stale: boolean }>;
}

// --- Small HTTP helpers (used only inside this module) ---

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString();
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(value));
}

function sendErr(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: message });
}

function urlPath(req: IncomingMessage): string {
  return (req.url ?? "/").replace(/\?.*$/, "");
}

// --- Shared sync helpers ---

/**
 * Sync a single graph to the cloud relay using BPAK envelope format.
 * Handles encryption, envelope building, device headers, and synced-status tracking.
 */
/** Read or generate the persistent machine-id (same logic as /api/device-info). */
async function getMachineId(): Promise<string> {
  const idPath = path.join(configDir(), "machine-id");
  try {
    return (await fs.readFile(idPath, "utf-8")).trim();
  } catch {
    const hash = crypto.createHash("sha256").update(os.hostname() + os.platform()).digest("hex").slice(0, 16);
    try { await fs.mkdir(configDir(), { recursive: true }); } catch {}
    await fs.writeFile(idPath, hash, "utf-8");
    return hash;
  }
}

async function syncGraphToRelay(
  name: string,
  data: Record<string, unknown>,
  token: string,
  relayUrl: string,
  encrypted: boolean = true,
  kind: string = "learning_graph",
  machineId?: string,
  sourceBackpackName?: string,
): Promise<void> {
  const graphJSON = new TextEncoder().encode(JSON.stringify(data));
  let payload: Uint8Array;
  let format: string;

  if (encrypted) {
    const age = await import("age-encryption");
    const settings = await readExtensionSettings("share");
    const keys = ((settings.keys as Record<string, string>) || {});
    let secretKey = keys[name];
    if (!secretKey) {
      secretKey = await age.generateX25519Identity();
      keys[name] = secretKey;
      await writeExtensionSetting("share", "keys", keys);
    }
    const publicKey = await age.identityToRecipient(secretKey);
    const e = new age.Encrypter();
    e.addRecipient(publicKey);
    payload = await e.encrypt(graphJSON);
    format = "age-v1";
  } else {
    payload = graphJSON;
    format = "plaintext";
    // Remove stale key if switching from encrypted to unencrypted
    const settings = await readExtensionSettings("share");
    const keys = ((settings.keys as Record<string, string>) || {});
    if (keys[name]) {
      delete keys[name];
      await writeExtensionSetting("share", "keys", keys);
    }
  }

  // Build BPAK envelope
  const typeSet = new Set<string>();
  const nodes = (data as Record<string, unknown>).nodes as { type: string }[] | undefined;
  if (nodes) for (const n of nodes) typeSet.add(n.type);
  const checksumBuf = await crypto.subtle.digest("SHA-256", new Uint8Array(payload).buffer as ArrayBuffer);
  const checksum = "sha256:" + Array.from(new Uint8Array(checksumBuf)).map(b => b.toString(16).padStart(2, "0")).join("");
  const headerObj: Record<string, unknown> = {
    format,
    kind,
    created_at: new Date().toISOString(),
    backpack_name: name,
    checksum,
  };
  if (kind === "knowledge_base") {
    headerObj.document_count = ((data as Record<string, unknown>).documents as unknown[] || []).length;
  } else {
    headerObj.graph_count = 1;
    headerObj.node_count = (nodes || []).length;
    headerObj.edge_count = ((data as Record<string, unknown>).edges as unknown[] || []).length;
    headerObj.node_types = Array.from(typeSet);
  }
  const header = JSON.stringify(headerObj);
  const headerBytes = new TextEncoder().encode(header);
  const headerLenBuf = new ArrayBuffer(4);
  new DataView(headerLenBuf).setUint32(0, headerBytes.length, false);
  const envelope = new Uint8Array(4 + 1 + 4 + headerBytes.length + payload.length);
  let off = 0;
  envelope.set(new Uint8Array([0x42, 0x50, 0x41, 0x4b]), off); off += 4;
  envelope[off] = 0x01; off += 1;
  envelope.set(new Uint8Array(headerLenBuf), off); off += 4;
  envelope.set(headerBytes, off); off += headerBytes.length;
  envelope.set(payload, off);

  // Send to relay
  const syncHeaders: Record<string, string> = {
    "Authorization": `Bearer ${token}`,
    "Content-Type": "application/octet-stream",
  };
  try {
    syncHeaders["X-Backpack-Device-Name"] = os.hostname();
    syncHeaders["X-Backpack-Device-Hostname"] = os.hostname();
    syncHeaders["X-Backpack-Device-Platform"] = os.platform();
    if (machineId) syncHeaders["X-Backpack-Device-Id"] = machineId;
    if (sourceBackpackName) syncHeaders["X-Backpack-Source-Name"] = sourceBackpackName;
  } catch { /* device info unavailable */ }

  const relayRes = await fetch(`${relayUrl}/api/graphs/${encodeURIComponent(name)}/sync`, {
    method: "PUT",
    headers: syncHeaders,
    body: envelope,
  });

  if (!relayRes.ok) {
    let msg = `Sync failed (${relayRes.status})`;
    try { const b = await relayRes.json() as Record<string, string>; if (b.error) msg = b.error; } catch {}
    throw new Error(msg);
  }

  // Mark as synced
  const syncedSettings = await readExtensionSettings("share");
  const synced = ((syncedSettings.synced as Record<string, boolean>) || {});
  synced[name] = true;
  await writeExtensionSetting("share", "synced", synced);
}

// --- Main dispatcher ---

/**
 * Try to match and handle an API request. Returns true if the request
 * was handled (response written), false if no route matched and the
 * caller should fall through to its own handlers (e.g., static files).
 *
 * Errors that escape route handlers result in a 500 with a JSON body.
 */
export async function handleApiRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ApiContext,
): Promise<boolean> {
  const method = req.method ?? "GET";
  const url = urlPath(req);

  try {
    // --- /api/config ---
    if (url === "/api/config" && method === "GET") {
      sendJson(res, 200, ctx.viewerConfig);
      return true;
    }

    // --- /api/version-check ---
    if (url === "/api/version-check" && method === "GET") {
      const result = await ctx.versionCheck();
      sendJson(res, 200, result);
      return true;
    }

    // --- /api/device-info ---
    if (url === "/api/device-info" && method === "GET") {
      const idPath = path.join(configDir(), "machine-id");
      let machineId: string;
      try {
        machineId = (await fs.readFile(idPath, "utf-8")).trim();
      } catch {
        const hash = crypto
          .createHash("sha256")
          .update(os.hostname() + os.platform())
          .digest("hex")
          .slice(0, 16);
        await fs.mkdir(configDir(), { recursive: true });
        await fs.writeFile(idPath, hash, "utf-8");
        machineId = hash;
      }
      sendJson(res, 200, {
        machineId,
        authorName: resolveAuthorName(),
        hostname: os.hostname(),
        platform: os.platform(),
      });
      return true;
    }

    // --- /api/remotes (read-only) ---
    if (url === "/api/remotes" && method === "GET") {
      const remotes = await ctx.remoteRegistry.list();
      const summaries = await Promise.all(
        remotes.map(async (r) => {
          let nodeCount = 0;
          let edgeCount = 0;
          try {
            const data = await ctx.remoteRegistry.loadCached(r.name);
            nodeCount = data.nodes.length;
            edgeCount = data.edges.length;
          } catch {
            /* keep counts at 0 */
          }
          return {
            name: r.name,
            url: r.url,
            source: r.source,
            addedAt: r.addedAt,
            lastFetched: r.lastFetched,
            pinned: r.pinned,
            sizeBytes: r.sizeBytes,
            nodeCount,
            edgeCount,
          };
        }),
      );
      sendJson(res, 200, summaries);
      return true;
    }

    const remoteItem = url.match(/^\/api\/remotes\/(.+)$/);
    if (remoteItem && method === "GET") {
      const name = decodeURIComponent(remoteItem[1]);
      try {
        const data = await ctx.remoteRegistry.loadCached(name);
        sendJson(res, 200, data);
      } catch (err) {
        sendErr(res, 404, (err as Error).message);
      }
      return true;
    }

    // Helper: get local-only backend (branches/snapshots/snippets don't apply to cloud)
    function localBackend(): JsonFileBackend {
      if (ctx.storage.current instanceof CloudCacheBackend) {
        throw new Error("Branches, snapshots, and snippets are not available for cloud backpacks");
      }
      return ctx.storage.current;
    }

    // --- /api/graphs/<name>/branches/* ---
    const branchSwitch = url.match(/^\/api\/graphs\/(.+)\/branches\/switch$/);
    if (branchSwitch && method === "POST") {
      const graphName = decodeURIComponent(branchSwitch[1]);
      const body = await readBody(req);
      try {
        const { name: branchName } = JSON.parse(body);
        await localBackend().switchBranch(graphName, branchName);
        sendJson(res, 200, { ok: true });
      } catch (err) {
        sendErr(res, 400, (err as Error).message);
      }
      return true;
    }

    const deleteBranch = url.match(/^\/api\/graphs\/(.+)\/branches\/(.+)$/);
    if (deleteBranch && method === "DELETE") {
      const graphName = decodeURIComponent(deleteBranch[1]);
      const branchName = decodeURIComponent(deleteBranch[2]);
      try {
        await localBackend().deleteBranch(graphName, branchName);
        sendJson(res, 200, { ok: true });
      } catch (err) {
        sendErr(res, 400, (err as Error).message);
      }
      return true;
    }

    const branches = url.match(/^\/api\/graphs\/(.+)\/branches$/);
    if (branches && method === "GET") {
      const graphName = decodeURIComponent(branches[1]);
      try {
        const list = await localBackend().listBranches(graphName);
        sendJson(res, 200, list);
      } catch (err) {
        sendErr(res, 500, (err as Error).message);
      }
      return true;
    }

    if (branches && method === "POST") {
      const graphName = decodeURIComponent(branches[1]);
      const body = await readBody(req);
      try {
        const { name: branchName, from } = JSON.parse(body);
        await localBackend().createBranch(graphName, branchName, from);
        sendJson(res, 200, { ok: true });
      } catch (err) {
        sendErr(res, 400, (err as Error).message);
      }
      return true;
    }

    // --- /api/graphs/<name>/snapshots ---
    const snapshots = url.match(/^\/api\/graphs\/(.+)\/snapshots$/);
    if (snapshots && method === "GET") {
      const graphName = decodeURIComponent(snapshots[1]);
      try {
        const list = await localBackend().listSnapshots(graphName);
        sendJson(res, 200, list);
      } catch (err) {
        sendErr(res, 500, (err as Error).message);
      }
      return true;
    }

    if (snapshots && method === "POST") {
      const graphName = decodeURIComponent(snapshots[1]);
      const body = await readBody(req);
      try {
        const { label } = JSON.parse(body);
        await localBackend().createSnapshot(graphName, label);
        sendJson(res, 200, { ok: true });
      } catch (err) {
        sendErr(res, 400, (err as Error).message);
      }
      return true;
    }

    // --- /api/graphs/<name>/rollback ---
    const rollback = url.match(/^\/api\/graphs\/(.+)\/rollback$/);
    if (rollback && method === "POST") {
      const graphName = decodeURIComponent(rollback[1]);
      const body = await readBody(req);
      try {
        const { version } = JSON.parse(body);
        await localBackend().rollback(graphName, version);
        sendJson(res, 200, { ok: true });
      } catch (err) {
        sendErr(res, 400, (err as Error).message);
      }
      return true;
    }

    // --- /api/graphs/<name>/diff/<version> ---
    const diff = url.match(/^\/api\/graphs\/(.+)\/diff\/(\d+)$/);
    if (diff && method === "GET") {
      const graphName = decodeURIComponent(diff[1]);
      const version = parseInt(diff[2], 10);
      try {
        const current = await ctx.storage.current.loadOntology(graphName);
        const snapshot = await localBackend().loadSnapshot(graphName, version);
        const currentNodeIds = new Set(current.nodes.map((n: any) => n.id));
        const snapshotNodeIds = new Set(snapshot.nodes.map((n: any) => n.id));
        const currentEdgeIds = new Set(current.edges.map((e: any) => e.id));
        const snapshotEdgeIds = new Set(snapshot.edges.map((e: any) => e.id));
        sendJson(res, 200, {
          nodesAdded: current.nodes.filter((n: any) => !snapshotNodeIds.has(n.id)).length,
          nodesRemoved: snapshot.nodes.filter((n: any) => !currentNodeIds.has(n.id)).length,
          edgesAdded: current.edges.filter((e: any) => !snapshotEdgeIds.has(e.id)).length,
          edgesRemoved: snapshot.edges.filter((e: any) => !currentEdgeIds.has(e.id)).length,
        });
      } catch (err) {
        sendErr(res, 500, (err as Error).message);
      }
      return true;
    }

    // --- /api/graphs/<name>/snippets/<id> ---
    const snippetItem = url.match(/^\/api\/graphs\/(.+)\/snippets\/(.+)$/);
    if (snippetItem && method === "GET") {
      const graphName = decodeURIComponent(snippetItem[1]);
      const snippetId = decodeURIComponent(snippetItem[2]);
      try {
        const snippet = await localBackend().loadSnippet(graphName, snippetId);
        sendJson(res, 200, snippet);
      } catch {
        sendErr(res, 404, "Snippet not found");
      }
      return true;
    }

    if (snippetItem && method === "DELETE") {
      const graphName = decodeURIComponent(snippetItem[1]);
      const snippetId = decodeURIComponent(snippetItem[2]);
      try {
        await localBackend().deleteSnippet(graphName, snippetId);
        sendJson(res, 200, { ok: true });
      } catch (err) {
        sendErr(res, 400, (err as Error).message);
      }
      return true;
    }

    const snippets = url.match(/^\/api\/graphs\/(.+)\/snippets$/);
    if (snippets && method === "GET") {
      const graphName = decodeURIComponent(snippets[1]);
      try {
        const list = await localBackend().listSnippets(graphName);
        sendJson(res, 200, list);
      } catch {
        sendJson(res, 200, []);
      }
      return true;
    }

    if (snippets && method === "POST") {
      const graphName = decodeURIComponent(snippets[1]);
      const body = await readBody(req);
      try {
        const { label, description, nodeIds, edgeIds } = JSON.parse(body);
        const id = await localBackend().saveSnippet(graphName, {
          label,
          description,
          nodeIds,
          edgeIds: edgeIds ?? [],
        });
        sendJson(res, 200, { ok: true, id });
      } catch (err) {
        sendErr(res, 400, (err as Error).message);
      }
      return true;
    }

    // --- /api/backpacks (meta: list, active, register, switch, unregister) ---
    if (url === "/api/backpacks" && method === "GET") {
      try {
        const list = await listBackpacks();
        const active = await getActiveBackpack();
        sendJson(
          res,
          200,
          list.map((b) => ({ ...b, active: b.name === active.name })),
        );
      } catch (err) {
        sendErr(res, 500, (err as Error).message);
      }
      return true;
    }

    // List graphs from ALL registered backpacks (for "All" picker mode)
    if (url === "/api/backpacks/all-graphs" && method === "GET") {
      try {
        const bpList = await listBackpacks();
        const all: (Record<string, unknown> & { backpack: string })[] = [];
        for (const bp of bpList) {
          try {
            const backend = new JsonFileBackend(bp.path);
            await backend.initialize();
            const summaries = await backend.listOntologies();
            for (const s of summaries) all.push({ ...s, backpack: bp.name });
          } catch { /* skip inaccessible backpacks */ }
        }
        sendJson(res, 200, all);
      } catch (err) {
        sendErr(res, 500, (err as Error).message);
      }
      return true;
    }

    if (url === "/api/backpacks/active" && method === "GET") {
      try {
        const active = await getActiveBackpack();
        sendJson(res, 200, active);
      } catch (err) {
        sendErr(res, 500, (err as Error).message);
      }
      return true;
    }

    if (url === "/api/backpacks/switch" && method === "POST") {
      const body = await readBody(req);
      try {
        const { name } = JSON.parse(body);
        if (name === "__cloud__") {
          // Switch to cloud cache backend
          await ctx.cloudCache.initialize();
          ctx.storage.current = ctx.cloudCache;
          ctx.storage.activeEntry = { name: "Cloud", path: "cloud://app.backpackontology.com", color: "#5b9bd5" };
          ctx.onActiveBackpackChange?.();
          sendJson(res, 200, { ok: true, active: ctx.storage.activeEntry });
        } else {
          await setActiveBackpack(name);
          const swapped = await ctx.makeBackend();
          ctx.storage.current = swapped.backend;
          ctx.storage.activeEntry = swapped.entry;
          ctx.onActiveBackpackChange?.();
          sendJson(res, 200, { ok: true, active: ctx.storage.activeEntry });
        }
      } catch (err) {
        sendErr(res, 400, (err as Error).message);
      }
      return true;
    }

    if (url === "/api/backpacks" && method === "POST") {
      const body = await readBody(req);
      try {
        const { name, path: p, activate } = JSON.parse(body);
        // registerBackpack only takes a path; the name is derived by
        // backpack-ontology from the directory. Pre-existing call sites
        // pass `name` as a hint but it's not used by the function.
        void name;
        const entry = await registerBackpack(p);
        if (activate) {
          await setActiveBackpack(name);
          const swapped = await ctx.makeBackend();
          ctx.storage.current = swapped.backend;
          ctx.storage.activeEntry = swapped.entry;
          ctx.onActiveBackpackChange?.();
        }
        sendJson(res, 200, { ok: true, entry });
      } catch (err) {
        sendErr(res, 400, (err as Error).message);
      }
      return true;
    }

    const backpackDelete = url.match(/^\/api\/backpacks\/(.+)$/);
    if (backpackDelete && method === "DELETE") {
      const name = decodeURIComponent(backpackDelete[1]);
      try {
        await unregisterBackpack(name);
        if (ctx.storage.activeEntry && ctx.storage.activeEntry.name === name) {
          const swapped = await ctx.makeBackend();
          ctx.storage.current = swapped.backend;
          ctx.storage.activeEntry = swapped.entry;
          ctx.onActiveBackpackChange?.();
        }
        sendJson(res, 200, { ok: true });
      } catch (err) {
        sendErr(res, 400, (err as Error).message);
      }
      return true;
    }

    // --- /api/locks ---
    if (url === "/api/locks" && method === "GET") {
      try {
        const summaries = await ctx.storage.current.listOntologies();
        const result: Record<string, unknown> = {};
        const storage = ctx.storage.current as any;
        if (typeof storage.readLock === "function") {
          await Promise.all(
            summaries.map(async (s) => {
              try {
                result[s.name] = await storage.readLock(s.name);
              } catch {
                result[s.name] = null;
              }
            }),
          );
        }
        sendJson(res, 200, result);
      } catch {
        sendJson(res, 200, {});
      }
      return true;
    }

    const lock = url.match(/^\/api\/graphs\/(.+)\/lock$/);
    if (lock && method === "GET") {
      const graphName = decodeURIComponent(lock[1]);
      try {
        const storage = ctx.storage.current as any;
        const lockInfo =
          typeof storage.readLock === "function"
            ? await storage.readLock(graphName)
            : null;
        sendJson(res, 200, lockInfo);
      } catch {
        sendJson(res, 200, null);
      }
      return true;
    }

    // --- /api/sync-status ---
    if (url === "/api/sync-status" && method === "GET") {
      try {
        const synced: Record<string, { encrypted: boolean }> = {};
        const settings = await readExtensionSettings("share");
        const syncedMap = settings.synced;
        const keys = (settings.keys as Record<string, string>) || {};
        if (syncedMap && typeof syncedMap === "object" && !Array.isArray(syncedMap)) {
          for (const name of Object.keys(syncedMap as Record<string, unknown>)) {
            synced[name] = { encrypted: !!keys[name] };
          }
        }
        // In cloud mode, every graph the active backend returns is by
        // definition synced. CloudCacheBackend filters out encrypted
        // graphs (it can't cache without keys), so anything visible
        // here is plaintext. Mark them synced so the sidebar renders
        // a cloud badge instead of nothing.
        if (ctx.storage.current instanceof CloudCacheBackend) {
          try {
            const summaries = await ctx.storage.current.listOntologies();
            for (const s of summaries) {
              if (!(s.name in synced)) synced[s.name] = { encrypted: false };
            }
          } catch { /* fall through */ }
        }
        sendJson(res, 200, { synced });
      } catch {
        sendJson(res, 200, { synced: {} });
      }
      return true;
    }

    // --- /api/kb/* (Knowledge Base documents) ---

    const isCloudActive = ctx.storage.current instanceof CloudCacheBackend;

    // Helper: resolve a DocumentStore for the active backpack (local only)
    async function getDocStore(): Promise<DocumentStore> {
      const active = ctx.storage.activeEntry;
      if (!active) throw new Error("No active backpack");
      const mountConfigs = await getKBMounts(active.path);
      return new DocumentStore(
        mountConfigs.map((m) => ({
          name: m.name,
          path: m.path,
          writable: m.writable !== false,
        })),
      );
    }

    if (url === "/api/kb/documents" && method === "GET") {
      try {
        if (isCloudActive) {
          const docs = await ctx.cloudCache.listCachedKBDocs();
          sendJson(res, 200, { documents: docs, total: docs.length, hasMore: false });
        } else {
          const docs = await getDocStore();
          const params = new URL(req.url ?? "/", "http://localhost").searchParams;
          const result = await docs.list({
            collection: params.get("collection") ?? undefined,
            limit: params.has("limit") ? parseInt(params.get("limit")!, 10) : undefined,
            offset: params.has("offset") ? parseInt(params.get("offset")!, 10) : undefined,
          });
          sendJson(res, 200, result);
        }
      } catch (err) {
        sendErr(res, 500, (err as Error).message);
      }
      return true;
    }

    if (url === "/api/kb/search" && method === "GET") {
      try {
        const docs = await getDocStore();
        const params = new URL(req.url ?? "/", "http://localhost").searchParams;
        const query = params.get("q") ?? "";
        const result = await docs.search(query, {
          collection: params.get("collection") ?? undefined,
          limit: params.has("limit") ? parseInt(params.get("limit")!, 10) : undefined,
          offset: params.has("offset") ? parseInt(params.get("offset")!, 10) : undefined,
        });
        sendJson(res, 200, result);
      } catch (err) {
        sendErr(res, 500, (err as Error).message);
      }
      return true;
    }

    if (url === "/api/kb/mounts" && method === "GET") {
      try {
        if (isCloudActive) {
          const docs = await ctx.cloudCache.listCachedKBDocs();
          sendJson(res, 200, [{ name: "cloud", path: "cloud://backpack", writable: true, docCount: docs.length, type: "cloud" }]);
        } else {
          const docs = await getDocStore();
          const mounts = await docs.listMounts();
          sendJson(res, 200, mounts);
        }
      } catch (err) {
        sendErr(res, 500, (err as Error).message);
      }
      return true;
    }

    if (url === "/api/kb/mounts" && method === "POST") {
      const body = await readBody(req);
      try {
        const active = ctx.storage.activeEntry;
        if (!active) throw new Error("No active backpack");
        const { action, name, path: mountPath, writable } = JSON.parse(body);
        if (action === "add") {
          await addKBMount(active.path, {
            name,
            path: mountPath,
            ...(writable === false ? { writable: false } : {}),
          });
        } else if (action === "remove") {
          await removeKBMount(active.path, name);
        } else if (action === "edit") {
          await editKBMount(active.path, name, mountPath);
        } else {
          throw new Error(`Unknown action: ${action}`);
        }
        sendJson(res, 200, { ok: true });
      } catch (err) {
        sendErr(res, 400, (err as Error).message);
      }
      return true;
    }

    const kbDocItem = url.match(/^\/api\/kb\/documents\/(.+)$/);
    if (kbDocItem && method === "GET") {
      const id = decodeURIComponent(kbDocItem[1]);
      try {
        if (isCloudActive) {
          const doc = await ctx.cloudCache.readCachedKBDoc(id);
          sendJson(res, 200, doc);
        } else {
          const docs = await getDocStore();
          const doc = await docs.read(id);
          sendJson(res, 200, doc);
        }
      } catch (err) {
        sendErr(res, 404, (err as Error).message);
      }
      return true;
    }

    if (kbDocItem && method === "DELETE") {
      const id = decodeURIComponent(kbDocItem[1]);
      try {
        const docs = await getDocStore();
        await docs.delete(id);
        sendJson(res, 200, { ok: true });
      } catch (err) {
        sendErr(res, 400, (err as Error).message);
      }
      return true;
    }

    if (kbDocItem && method === "PUT") {
      const id = decodeURIComponent(kbDocItem[1]);
      const body = await readBody(req);
      try {
        if (isCloudActive) {
          sendErr(res, 400, "Editing KB documents in a cloud backpack is not yet supported");
          return true;
        }
        const payload = JSON.parse(body) as {
          title?: string;
          content?: string;
          tags?: string[];
          sourceGraphs?: string[];
          sourceNodeIds?: string[];
          collection?: string;
        };
        const docs = await getDocStore();
        const existing = await docs.read(id);
        const saved = await docs.save({
          id,
          title: payload.title ?? existing.title,
          content: payload.content ?? existing.content,
          tags: payload.tags ?? existing.tags,
          sourceGraphs: payload.sourceGraphs ?? existing.sourceGraphs,
          sourceNodeIds: payload.sourceNodeIds ?? existing.sourceNodeIds,
          collection: payload.collection ?? existing.collection,
        });
        sendJson(res, 200, saved);
      } catch (err) {
        sendErr(res, 400, (err as Error).message);
      }
      return true;
    }

    // --- /api/backpack/sync — bidirectional sync for graphs + KB ---
    if (url === "/api/backpack/sync" && method === "POST") {
      const body = await readBody(req);
      try {
        const { direction, encrypted: wantEncrypted = true } = JSON.parse(body) as { direction: "push" | "pull"; encrypted?: boolean };
        const settings = await readExtensionSettings("share");
        const token = settings.relay_token;
        if (!token || typeof token !== "string") {
          sendErr(res, 401, "Not authenticated — sign in first");
          return true;
        }
        const relayUrl = (settings.relay_url as string) || "https://app.backpackontology.com";

        type SyncItemStatus = "synced" | "failed" | "skipped";
        interface SyncItem { name: string; kind: "graph" | "kb"; status: SyncItemStatus; error?: string }
        const result = { total: 0, synced: 0, skipped: 0, failed: 0, errors: [] as string[], items: [] as SyncItem[] };

        const bulkMachineId = await getMachineId().catch(() => undefined);
        const bulkSourceName = ctx.storage.activeEntry?.name;

        if (direction === "push") {
          // Fetch existing cloud graphs to preserve their encryption status
          let cloudEncryptionMap = new Map<string, boolean>();
          try {
            const cloudRes = await fetch(`${relayUrl}/api/graphs`, { headers: { "Authorization": `Bearer ${token}` } });
            if (cloudRes.ok) {
              const cloudGraphs = await cloudRes.json() as { name: string; encrypted?: boolean }[];
              for (const g of cloudGraphs) cloudEncryptionMap.set(g.name, g.encrypted === true);
            }
          } catch { /* cloud unreachable, fall through to wantEncrypted default */ }

          // Push graphs via BPAK envelopes — preserve existing encryption status
          const summaries = await ctx.storage.current.listOntologies();
          result.total += summaries.length;
          for (const s of summaries) {
            try {
              const data = await ctx.storage.current.loadOntology(s.name);
              // If user explicitly chose unencrypted, force plaintext (fixes corrupted graphs).
              // Otherwise, preserve cloud encryption status for existing graphs.
              // New graphs use the user's default preference.
              const encrypt = !wantEncrypted
                ? false
                : cloudEncryptionMap.has(s.name)
                  ? cloudEncryptionMap.get(s.name)!
                  : wantEncrypted;
              await syncGraphToRelay(s.name, data as unknown as Record<string, unknown>, token, relayUrl, encrypt, "learning_graph", bulkMachineId, bulkSourceName);
              result.synced++;
              result.items.push({ name: s.name, kind: "graph", status: "synced" });
            } catch (err) {
              result.failed++;
              const msg = (err as Error).message;
              result.errors.push(`Graph "${s.name}": ${msg}`);
              result.items.push({ name: s.name, kind: "graph", status: "failed", error: msg });
            }
          }

          // Push KB docs as encrypted BPAK envelope (same as graphs)
          try {
            const docs = await getDocStore();
            const kbResult = await docs.list();
            if (kbResult.documents.length > 0) {
              const allDocs = await Promise.all(kbResult.documents.map(s => docs.read(s.id)));
              result.total++;
              try {
                await syncGraphToRelay(
                  "knowledge-base",
                  { documents: allDocs } as unknown as Record<string, unknown>,
                  token, relayUrl, wantEncrypted, "knowledge_base",
                  bulkMachineId, bulkSourceName,
                );
                result.synced++;
                result.items.push({ name: `KB (${allDocs.length} docs)`, kind: "kb", status: "synced" });
              } catch (err) {
                result.failed++;
                result.errors.push(`KB: ${(err as Error).message}`);
                result.items.push({ name: `KB (${allDocs.length} docs)`, kind: "kb", status: "failed", error: (err as Error).message });
              }
            }
          } catch { /* no KB mount configured */ }
        } else {
          // Pull graphs + KB into cloud cache (never into local backpacks)
          try {
            await ctx.cloudCache.initialize();
            const refreshResult = await ctx.cloudCache.refreshFromCloud();
            result.total = refreshResult.graphs + refreshResult.kbDocs;
            result.synced = refreshResult.graphs + refreshResult.kbDocs;
            result.items.push({ name: `${refreshResult.graphs} graphs`, kind: "graph", status: "synced" });
            if (refreshResult.kbDocs > 0) {
              result.items.push({ name: `${refreshResult.kbDocs} KB docs`, kind: "kb", status: "synced" });
            }
          } catch (pullErr) {
            result.failed++;
            result.errors.push(`Pull failed: ${(pullErr as Error).message}`);
            result.items.push({ name: "Cloud refresh", kind: "graph", status: "failed", error: (pullErr as Error).message });
          }
        }

        sendJson(res, 200, result);
      } catch (err) {
        sendErr(res, 500, (err as Error).message);
      }
      return true;
    }

    // --- /api/cloud-cache/refresh ---
    if (url === "/api/cloud-cache/refresh" && method === "POST") {
      try {
        await ctx.cloudCache.initialize();
        const refreshResult = await ctx.cloudCache.refreshFromCloud();
        sendJson(res, 200, refreshResult);
      } catch (err) {
        sendErr(res, 500, (err as Error).message);
      }
      return true;
    }

    // --- /api/cloud-cache/meta ---
    if (url === "/api/cloud-cache/meta" && method === "GET") {
      try {
        const meta = await ctx.cloudCache.getCacheMeta();
        sendJson(res, 200, meta || {});
      } catch {
        sendJson(res, 200, {});
      }
      return true;
    }

    // --- /api/graphs/* ---
    if (url === "/api/graphs" && method === "GET") {
      try {
        const summaries = await ctx.storage.current.listOntologies();
        sendJson(res, 200, summaries);
      } catch {
        sendJson(res, 200, []);
      }
      return true;
    }

    // /api/graphs/<name>/tags — get or set tags
    const tagsMatch = url.match(/^\/api\/graphs\/(.+)\/tags$/);
    if (tagsMatch && (method === "GET" || method === "PUT")) {
      const name = decodeURIComponent(tagsMatch[1]);
      try {
        if (method === "GET") {
          const data = await ctx.storage.current.loadOntology(name);
          sendJson(res, 200, { tags: data.metadata.tags ?? [] });
        } else {
          const body = JSON.parse(await readBody(req));
          const tags: string[] = (body.tags ?? []).map((t: string) => t.trim().toLowerCase()).filter(Boolean);
          const data = await ctx.storage.current.loadOntology(name);
          data.metadata.tags = tags;
          await ctx.storage.current.saveOntology(name, data);
          sendJson(res, 200, { tags });
        }
      } catch (err) {
        sendErr(res, 500, (err as Error).message);
      }
      return true;
    }

    // --- /api/backpack/v2-sync — Sync Protocol v0.1 (artifact-versioned) ---
    if (url === "/api/backpack/v2-sync/status" && method === "GET") {
      try {
        const settings = await readExtensionSettings("share");
        const authenticated = typeof settings.relay_token === "string" && settings.relay_token.length > 0;

        const active = ctx.storage.activeEntry;
        if (!active || active.path.startsWith("cloud://")) {
          sendJson(res, 200, {
            authenticated,
            registered: false,
            reason: "no_local_active",
          });
          return true;
        }
        const state = await readSyncState(active.path);
        if (!state) {
          sendJson(res, 200, {
            authenticated,
            registered: false,
            backpack_name: active.name,
          });
          return true;
        }
        sendJson(res, 200, {
          authenticated,
          registered: true,
          backpack_id: state.backpack_id,
          backpack_name: state.name,
          relay_url: state.relay_url,
          last_sync_at: state.last_sync_at,
          artifact_count: Object.keys(state.artifacts).length,
        });
      } catch (err) {
        sendErr(res, 500, (err as Error).message);
      }
      return true;
    }

    if (url === "/api/backpack/v2-sync/register" && method === "POST") {
      try {
        const active = ctx.storage.activeEntry;
        if (!active || active.path.startsWith("cloud://")) {
          sendErr(res, 400, "no local backpack active");
          return true;
        }
        const settings = await readExtensionSettings("share");
        const token = settings.relay_token as string | undefined;
        if (!token) {
          sendErr(res, 401, "Sign in to enable cloud sync");
          return true;
        }
        const relayUrl = (settings.relay_url as string) || "https://app.backpackontology.com";
        const body = await readBody(req).catch(() => "{}");
        const reqBody = JSON.parse(body || "{}") as {
          name?: string; color?: string; tags?: string[];
          autoPush?: boolean;
        };
        const relay = new SyncRelayClient({ baseUrl: relayUrl, token });
        const client = new SyncClient({ backpackPath: active.path, relay });
        const state = await client.register({
          name: reqBody.name ?? active.name,
          color: reqBody.color ?? active.color,
          tags: reqBody.tags ?? [],
        });

        // Auto-push: by default, register also pushes all local artifacts
        // so the user's first click does the obvious thing. Pass
        // autoPush=false to opt out.
        let push;
        if (reqBody.autoPush !== false) {
          push = await client.push();
        }
        sendJson(res, 200, { state, push });
      } catch (err) {
        const msg = (err as Error).message;
        const status = /relay token rejected/i.test(msg) ? 401 : 500;
        sendErr(res, status, msg);
      }
      return true;
    }

    if (url === "/api/backpack/v2-sync/sync" && method === "POST") {
      try {
        const active = ctx.storage.activeEntry;
        if (!active || active.path.startsWith("cloud://")) {
          sendErr(res, 400, "no local backpack active");
          return true;
        }
        const state = await readSyncState(active.path);
        if (!state) {
          sendErr(res, 400, "backpack is not registered for sync");
          return true;
        }
        const settings = await readExtensionSettings("share");
        const token = settings.relay_token as string | undefined;
        if (!token) {
          sendErr(res, 401, "Sign in via Share extension first to set relay token");
          return true;
        }
        const relay = new SyncRelayClient({ baseUrl: state.relay_url, token });
        const client = new SyncClient({ backpackPath: active.path, relay });
        const body = await readBody(req).catch(() => "{}");
        const { direction = "sync" } = JSON.parse(body || "{}") as { direction?: "push" | "pull" | "sync" };
        let result;
        if (direction === "push") result = await client.push();
        else if (direction === "pull") result = await client.pull();
        else result = await client.sync();
        sendJson(res, 200, result);
      } catch (err) {
        const msg = (err as Error).message;
        const status = /relay token rejected/i.test(msg) ? 401 : 500;
        sendErr(res, status, msg);
      }
      return true;
    }

    // Daemon status — sidebar polls this every few seconds while the
    // sync row is visible to render the live state ("Auto-syncing", "↑3 ↓1
    // 12 sec ago", etc).
    if (url === "/api/backpack/v2-sync/daemon-status" && method === "GET") {
      const daemon = (ctx as { syncDaemon?: { status: () => unknown } }).syncDaemon;
      sendJson(res, 200, daemon ? daemon.status() : { enabled: false, state: "disabled" });
      return true;
    }

    // Re-arm the daemon after the user signs in (or signs out and
    // back in). Idempotent.
    if (url === "/api/backpack/v2-sync/daemon-arm" && method === "POST") {
      const daemon = (ctx as { syncDaemon?: { handleAuthChange: () => Promise<void> } }).syncDaemon;
      if (daemon) {
        daemon.handleAuthChange().catch(() => {});
      }
      sendJson(res, 200, { ok: true });
      return true;
    }

    // List cloud sync_backpacks (containers) the user owns. Different
    // from /api/cloud-backpacks (which lists graphs); this surfaces
    // the parent containers so the user can pick one to pull down.
    if (url === "/api/cloud-sync-backpacks" && method === "GET") {
      try {
        const settings = await readExtensionSettings("share");
        const token = settings.relay_token;
        if (!token || typeof token !== "string") {
          sendJson(res, 200, { authenticated: false, backpacks: [] });
          return true;
        }
        const relayUrl = (settings.relay_url as string) || "https://app.backpackontology.com";
        const relayRes = await fetch(`${relayUrl}/api/sync/backpacks`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!relayRes.ok) {
          sendJson(res, 200, { authenticated: false, backpacks: [] });
          return true;
        }
        const data = await relayRes.json() as { backpacks?: unknown[] };
        sendJson(res, 200, { authenticated: true, backpacks: data.backpacks ?? [] });
      } catch {
        sendJson(res, 200, { authenticated: false, backpacks: [] });
      }
      return true;
    }

    // Clone a remote sync_backpack into a new local folder. The local
    // folder is created under the parent of the currently-active
    // backpack (so pulled backpacks land alongside existing ones), or
    // ~/.local/share/backpack/<name> as a fallback. Idempotent: if the
    // user already has this remote id locally, returns its path.
    if (url === "/api/backpack/v2-sync/clone" && method === "POST") {
      try {
        const settings = await readExtensionSettings("share");
        const token = settings.relay_token as string | undefined;
        if (!token) {
          sendErr(res, 401, "Sign in to enable cloud sync");
          return true;
        }
        const relayUrl = (settings.relay_url as string) || "https://app.backpackontology.com";
        const body = await readBody(req).catch(() => "{}");
        const reqBody = JSON.parse(body || "{}") as { backpack_id?: string; name?: string; color?: string; parent_path?: string; activate?: boolean };
        if (!reqBody.backpack_id) {
          sendErr(res, 400, "backpack_id is required");
          return true;
        }

        // Resolve remote metadata so we have the canonical name.
        const relay = new SyncRelayClient({ baseUrl: relayUrl, token });
        const manifest = await relay.manifest(reqBody.backpack_id) as { name: string; color?: string; tags?: string[] };
        const remoteName = reqBody.name || manifest.name;

        // Pick local path. Default = sibling of active backpack's
        // folder if local; else ~/.local/share/backpack/<name>.
        const safeName = remoteName.replace(/[^a-zA-Z0-9._-]/g, "_");
        let parent = reqBody.parent_path;
        if (!parent) {
          const active = ctx.storage.activeEntry;
          if (active && !active.path.startsWith("cloud://")) {
            parent = path.dirname(active.path);
          } else {
            parent = path.join(os.homedir(), ".local", "share", "backpack");
          }
        }
        const localPath = path.join(parent, safeName);

        // Check if already registered locally — if so just return it.
        const existing = await listBackpacks();
        const already = existing.find((b) => b.path === localPath);
        if (already) {
          // Make sure remote state is attached even if folder existed already.
          const state = await readSyncState(localPath);
          if (state && state.backpack_id === reqBody.backpack_id) {
            sendJson(res, 200, { path: localPath, name: already.name, alreadyExists: true });
            return true;
          }
        }

        // Create folder + clone.
        await fs.mkdir(localPath, { recursive: true });
        const client = new SyncClient({ backpackPath: localPath, relay });
        const cloned = await client.clone(reqBody.backpack_id, remoteName, reqBody.color || manifest.color, manifest.tags);

        // Register in the local backpack registry so it appears in pickers.
        const registered = await registerBackpack(localPath);
        if (reqBody.activate !== false) {
          await setActiveBackpack(registered.path);
          // Hot-swap server storage so subsequent reads/writes use the new path.
          ctx.storage.current = new JsonFileBackend(undefined, { graphsDirOverride: registered.path });
          await ctx.storage.current.initialize();
          ctx.storage.activeEntry = registered;
          if (ctx.onActiveBackpackChange) ctx.onActiveBackpackChange();
        }

        sendJson(res, 201, {
          path: registered.path,
          name: registered.name,
          activated: reqBody.activate !== false,
          pulled: cloned.pull.pulled.length,
          skipped: (cloned.pull.skipped ?? []).length,
          errors: cloned.pull.errors.length,
        });
      } catch (err) {
        const msg = (err as Error).message;
        const status = /\b401\b|relay token rejected/i.test(msg) ? 401 : 500;
        sendErr(res, status, msg);
      }
      return true;
    }

    if (url === "/api/backpack/v2-sync/conflicts" && method === "GET") {
      try {
        const active = ctx.storage.activeEntry;
        if (!active || active.path.startsWith("cloud://")) {
          sendJson(res, 200, { conflicts: [] });
          return true;
        }
        const dir = path.join(active.path, ".sync", "conflicts");
        let entries: string[] = [];
        try {
          entries = (await fs.readdir(dir)).filter((f) => f.endsWith(".json"));
        } catch {
          entries = [];
        }
        sendJson(res, 200, {
          conflicts: entries.map((name) => ({
            name,
            path: path.join(dir, name),
          })),
        });
      } catch (err) {
        sendErr(res, 500, (err as Error).message);
      }
      return true;
    }

    // /api/graphs/<name>/rename — must match before /api/graphs/<name>
    const rename = url.match(/^\/api\/graphs\/(.+)\/rename$/);
    if (rename && method === "POST") {
      const oldName = decodeURIComponent(rename[1]);
      const body = await readBody(req);
      try {
        const { name: newName } = JSON.parse(body);
        await ctx.storage.current.renameOntology(oldName, newName);
        sendJson(res, 200, { ok: true, name: newName });
      } catch (err) {
        sendErr(res, 500, (err as Error).message);
      }
      return true;
    }

    if (url.startsWith("/api/graphs/")) {
      const name = decodeURIComponent(url.replace("/api/graphs/", ""));
      if (!name) return false;
      if (method === "PUT") {
        const body = await readBody(req);
        try {
          const data = JSON.parse(body);
          await ctx.storage.current.saveOntology(name, data);
          sendJson(res, 200, { ok: true });
        } catch (err) {
          sendErr(res, 500, (err as Error).message);
        }
        return true;
      }
      if (method === "GET") {
        try {
          const data = await ctx.storage.current.loadOntology(name);
          sendJson(res, 200, data);
        } catch {
          sendErr(res, 404, "Graph not found");
        }
        return true;
      }
      if (method === "DELETE") {
        try {
          await ctx.storage.current.deleteOntology(name);
          sendJson(res, 200, { ok: true });
        } catch (err) {
          sendErr(res, 500, (err as Error).message);
        }
        return true;
      }
    }

    // --- /oauth/callback (for Share extension OAuth popup or same-tab redirect) ---
    if (url.startsWith("/oauth/callback") && method === "GET") {
      // The page emits an inline <script> to finish the OAuth handshake.
      // The global CSP is strict (script-src 'self'), so override it for
      // this route with a per-response nonce that authorizes only the
      // single inline block we control. No external scripts allowed.
      const nonce = crypto.randomBytes(16).toString("base64");
      res.setHeader(
        "Content-Security-Policy",
        [
          "default-src 'self'",
          `script-src 'self' 'nonce-${nonce}'`,
          "style-src 'self'",
          "img-src 'self' data:",
          "connect-src 'self' https://app.backpackontology.com https://*.ciamlogin.com",
          "object-src 'none'",
          "base-uri 'self'",
          "frame-ancestors 'none'",
        ].join("; "),
      );
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<!DOCTYPE html><html><body><script nonce="${nonce}">
(function() {
  var params = new URLSearchParams(window.location.search);
  var code = params.get("code");
  var state = params.get("state");

  // Popup path: post back to opener and close
  if (window.opener && code) {
    window.opener.postMessage({
      type: "backpack-oauth-callback",
      code: code,
      returnedState: state
    }, "*");
    window.close();
    return;
  }

  if (!code) { document.body.textContent = "Missing authorization code."; return; }

  // Same-tab redirect path: exchange token using stored PKCE params
  var tokenEndpoint = sessionStorage.getItem("share_oauth_token_endpoint");
  var clientId = sessionStorage.getItem("share_oauth_client_id");
  var codeVerifier = sessionStorage.getItem("share_oauth_code_verifier");
  var redirectUri = sessionStorage.getItem("share_oauth_redirect_uri");
  var savedState = sessionStorage.getItem("share_oauth_state");

  if (!tokenEndpoint || !clientId || !codeVerifier || !redirectUri) {
    document.body.textContent = "OAuth session expired. Please try again from the viewer.";
    return;
  }
  if (savedState && state !== savedState) {
    document.body.textContent = "State mismatch. Please try again.";
    return;
  }

  document.body.textContent = "Completing sign-in...";

  fetch(tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: codeVerifier
    }).toString()
  })
  .then(function(r) { return r.json(); })
  .then(function(data) {
    var token = data.id_token || data.access_token;
    if (!token) {
      document.body.textContent = "Token exchange failed: " + JSON.stringify(data);
      return;
    }
    return fetch("/api/extensions/share/settings/relay_token", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: token })
    }).then(function() {
      sessionStorage.removeItem("share_oauth_token_endpoint");
      sessionStorage.removeItem("share_oauth_client_id");
      sessionStorage.removeItem("share_oauth_code_verifier");
      sessionStorage.removeItem("share_oauth_redirect_uri");
      sessionStorage.removeItem("share_oauth_state");
      window.location.href = "/";
    });
  })
  .catch(function(err) {
    document.body.textContent = "Sign-in failed: " + err.message;
  });
})();
      </script></body></html>`);
      return true;
    }

    // --- /api/cloud-backpacks (proxy to relay for cloud visibility) ---
    if (url === "/api/cloud-backpacks" && method === "GET") {
      try {
        const settings = await readExtensionSettings("share");
        const token = settings.relay_token;
        if (!token || typeof token !== "string") {
          sendJson(res, 200, { authenticated: false, backpacks: [] });
          return true;
        }
        const relayUrl = (settings.relay_url as string) || "https://app.backpackontology.com";
        const relayRes = await fetch(`${relayUrl}/api/graphs`, {
          headers: { "Authorization": `Bearer ${token}` },
        });
        if (!relayRes.ok) {
          sendJson(res, 200, { authenticated: false, backpacks: [] });
          return true;
        }
        const data = await relayRes.json();
        // Decode email from JWT token (base64url decode middle segment)
        let email: string | undefined;
        try {
          const parts = token.split(".");
          if (parts.length === 3) {
            const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
            email = payload.email || payload.preferred_username;
          }
        } catch { /* ignore */ }
        sendJson(res, 200, { authenticated: true, email, backpacks: Array.isArray(data) ? data : [] });
      } catch {
        sendJson(res, 200, { authenticated: false, backpacks: [] });
      }
      return true;
    }

    // --- /api/cloud-backpacks/{name} (proxy to load a cloud graph) ---
    const cloudMatch = url.match(/^\/api\/cloud-backpacks\/(.+)$/);
    if (cloudMatch && method === "GET") {
      const name = decodeURIComponent(cloudMatch[1]);
      try {
        const settings = await readExtensionSettings("share");
        const token = settings.relay_token;
        if (!token || typeof token !== "string") {
          sendErr(res, 401, "Not authenticated");
          return true;
        }
        const relayUrl = (settings.relay_url as string) || "https://app.backpackontology.com";
        const relayRes = await fetch(`${relayUrl}/api/graphs/${encodeURIComponent(name)}`, {
          headers: { "Authorization": `Bearer ${token}` },
        });
        if (!relayRes.ok) {
          sendErr(res, relayRes.status, "Failed to load cloud graph");
          return true;
        }
        const data = await relayRes.json();
        sendJson(res, 200, data);
      } catch (err) {
        sendErr(res, 500, (err as Error).message);
      }
      return true;
    }

    // --- /api/auth/status (lightweight auth check — JWT decode only, no relay call) ---
    if (url === "/api/auth/status" && method === "GET") {
      try {
        const settings = await readExtensionSettings("share");
        const token = settings.relay_token;
        if (!token || typeof token !== "string") {
          sendJson(res, 200, { authenticated: false });
          return true;
        }
        let email: string | undefined;
        let valid = true;
        try {
          const parts = token.split(".");
          if (parts.length === 3) {
            const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
            email = payload.email || payload.preferred_username;
            if (payload.exp && payload.exp * 1000 < Date.now()) valid = false;
          } else {
            valid = false;
          }
        } catch { valid = false; }
        sendJson(res, 200, { authenticated: valid, email: valid ? email : undefined });
      } catch {
        sendJson(res, 200, { authenticated: false });
      }
      return true;
    }

    // --- /api/cloud-sync/{name} (server-side sync proxy) ---
    const syncMatch = url.match(/^\/api\/cloud-sync\/([^?]+)/);
    if (syncMatch && method === "PUT") {
      const name = decodeURIComponent(syncMatch[1]);
      try {
        const settings = await readExtensionSettings("share");
        const token = settings.relay_token;
        if (!token || typeof token !== "string") {
          sendErr(res, 401, "Not authenticated — sign in first");
          return true;
        }
        const relayUrl = (settings.relay_url as string) || "https://app.backpackontology.com";
        const body = await readBody(req);
        const parsed = JSON.parse(body);

        // Parse query params from the raw URL (urlPath() strips the query string)
        const params = new URLSearchParams((req.url || "").split("?")[1] || "");
        const wantEncrypted = params.get("encrypted") !== "false";
        const kind = params.get("kind") || "learning_graph";

        const mid = await getMachineId().catch(() => undefined);
        const srcName = ctx.storage.activeEntry?.name;
        await syncGraphToRelay(name, parsed, token, relayUrl, wantEncrypted, kind, mid, srcName);
        sendJson(res, 200, { ok: true });
      } catch (err) {
        sendErr(res, 500, (err as Error).message);
      }
      return true;
    }

    // --- /api/signals/* (Signals — the third primitive) ---

    if (url === "/api/signals" && method === "GET") {
      try {
        const active = ctx.storage.activeEntry;
        if (!active) { sendErr(res, 400, "No active backpack"); return true; }
        const store = new SignalStore(active.path);
        const params = new URL(req.url ?? "/", "http://localhost").searchParams;
        const result = await store.list({
          graph: params.get("graph") ?? undefined,
          kind: (params.get("kind") ?? undefined) as any,
          severity: params.get("severity") ?? undefined,
          query: params.get("q") ?? undefined,
        });
        sendJson(res, 200, result);
      } catch (err) {
        sendErr(res, 500, (err as Error).message);
      }
      return true;
    }

    if (url === "/api/signals/detect" && method === "POST") {
      try {
        const active = ctx.storage.activeEntry;
        if (!active) { sendErr(res, 400, "No active backpack"); return true; }
        const store = new SignalStore(active.path);
        const backend = ctx.storage.current;

        // Load all graphs
        const names = await backend.listOntologies();
        const graphs: { name: string; data: any }[] = [];
        for (const s of names) {
          try {
            const data = await backend.loadOntology(s.name);
            graphs.push({ name: s.name, data });
          } catch { /* skip */ }
        }

        // Load KB docs
        let docs: any[] = [];
        try {
          const mountConfigs = await getKBMounts(active.path);
          const docStore = new DocumentStore(
            mountConfigs.map((m) => ({ name: m.name, path: m.path, writable: m.writable !== false })),
          );
          const result = await docStore.list({ limit: 500 });
          docs = result.documents;
        } catch { /* KB might not be configured */ }

        const result = await store.detect(graphs, docs);
        sendJson(res, 200, result);
      } catch (err) {
        sendErr(res, 500, (err as Error).message);
      }
      return true;
    }

    if (url === "/api/signals/dismiss" && method === "POST") {
      try {
        const active = ctx.storage.activeEntry;
        if (!active) { sendErr(res, 400, "No active backpack"); return true; }
        const store = new SignalStore(active.path);
        const body = await readBody(req);
        const { signalId } = JSON.parse(body);
        if (!signalId) { sendErr(res, 400, "signalId required"); return true; }
        await store.dismiss(signalId);
        sendJson(res, 200, { ok: true });
      } catch (err) {
        sendErr(res, 500, (err as Error).message);
      }
      return true;
    }

    // --- /api/connector/knowledge-graph (live read from ArcadeDB backpack database) ---

    if (url === "/api/connector/knowledge-graph" && method === "GET") {
      try {
        // @ts-ignore — backpack-connector is optional
        const { ArcadeDBClient, ArcadeDBAdapter } = await import("backpack-connector");

        const adapter = new ArcadeDBAdapter(new ArcadeDBClient({
          url: process.env.ARCADEDB_URL ?? "http://localhost:2480",
          username: process.env.ARCADEDB_USERNAME ?? "root",
          password: process.env.ARCADEDB_PASSWORD ?? "arcadedb",
        }));

        const qp = new URLSearchParams((req.url ?? "").replace(/^[^?]*/, ""));
        const bpParam = qp.get("backpack");
        const graphParam = qp.get("graph");
        const bpFilter = bpParam && /^[a-zA-Z0-9_-]+$/.test(bpParam) ? bpParam : null;
        const graphFilter = graphParam && /^[a-zA-Z0-9_\- ]+$/.test(graphParam) ? graphParam : null;
        const esc = (s: string) => s.replace(/'/g, "\\'");
        let whereClause = "n.bk_id IS NOT NULL";
        if (bpFilter) whereClause += ` AND n.bk_backpack = '${esc(bpFilter)}'`;
        if (graphFilter) whereClause += ` AND n.bk_graph = '${esc(graphFilter)}'`;

        const database = "backpack";
        const nodeRows = await adapter.execute(database, "opencypher",
          `MATCH (n) WHERE ${whereClause} RETURN n LIMIT 10000`);

        const edgeRows = await adapter.execute(database, "opencypher",
          `MATCH (a)-[r]->(b)
           WHERE r.bk_id IS NOT NULL AND a.bk_id IS NOT NULL AND b.bk_id IS NOT NULL
           RETURN r.bk_id AS bk_id, r.bk_type AS bk_type,
                  r.bk_created_at AS bk_created_at,
                  a.bk_id AS sourceId, b.bk_id AS targetId`);

        const nodes: { id: string; type: string; properties: Record<string, unknown>; createdAt: string; updatedAt: string }[] = [];
        for (const row of nodeRows) {
          const n = ((row as Record<string, unknown>).n ?? row) as Record<string, unknown>;
          const bkId = String(n.bk_id ?? "");
          if (!bkId) continue;
          const type = String(n.bk_type ?? n["@type"] ?? "Unknown");
          const createdAt = String(n.bk_created_at ?? new Date().toISOString());
          // User-defined properties first — label extraction takes first string value
          const properties: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(n)) {
            if (k.startsWith("@") || k.startsWith("_") || k.startsWith("bk_")) continue;
            if (v !== null && v !== undefined) properties[k] = v;
          }
          if (n.bk_graph) properties.bk_graph = n.bk_graph;
          nodes.push({ id: bkId, type, properties, createdAt, updatedAt: createdAt });
        }

        const nodeIds = new Set(nodes.map(n => n.id));
        const edges: { id: string; type: string; sourceId: string; targetId: string; properties: Record<string, unknown>; createdAt: string; updatedAt: string }[] = [];
        for (const row of edgeRows) {
          const r = row as Record<string, unknown>;
          const bkId = String(r.bk_id ?? "");
          const sourceId = String(r.sourceId ?? "");
          const targetId = String(r.targetId ?? "");
          if (!bkId || !nodeIds.has(sourceId) || !nodeIds.has(targetId)) continue;
          edges.push({
            id: bkId,
            type: String(r.bk_type ?? "RELATED_TO"),
            sourceId, targetId,
            properties: {},
            createdAt: String(r.bk_created_at ?? new Date().toISOString()),
            updatedAt: String(r.bk_created_at ?? new Date().toISOString()),
          });
        }

        const graphCount = new Set(nodes.map(n => n.properties.bk_graph).filter(Boolean)).size;
        sendJson(res, 200, {
          metadata: {
            name: "Knowledge Graph",
            description: `Live view from ArcadeDB — ${nodes.length} nodes from ${graphCount} graphs`,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
          nodes,
          edges,
        });
      } catch (err) {
        sendErr(res, 503, `ArcadeDB not available: ${(err as Error).message}`);
      }
      return true;
    }

    if (url === "/api/connector/knowledge-graph/status" && method === "GET") {
      try {
        // @ts-ignore
        const { ArcadeDBClient } = await import("backpack-connector");
        const client = new ArcadeDBClient({
          url: process.env.ARCADEDB_URL ?? "http://localhost:2480",
          username: process.env.ARCADEDB_USERNAME ?? "root",
          password: process.env.ARCADEDB_PASSWORD ?? "arcadedb",
        });
        const exists = await client.databaseExists("backpack");
        if (!exists) { sendJson(res, 200, { available: false, nodeCount: 0, graphCount: 0, backpacks: [] }); return true; }

        // @ts-ignore
        const { ArcadeDBAdapter } = await import("backpack-connector");
        const adapter = new ArcadeDBAdapter(client);
        const rows = await adapter.execute("backpack", "opencypher",
          "MATCH (n) WHERE n.bk_id IS NOT NULL WITH n.bk_backpack AS bp, n.bk_graph AS g, count(n) AS c RETURN bp, g, c");

        // Aggregate by backpack, preserving per-graph detail
        const bpMap = new Map<string, { nodeCount: number; graphs: Map<string, number> }>();
        const graphSet = new Set<string>();
        let totalNodes = 0;
        for (const row of rows) {
          const r = row as Record<string, unknown>;
          const bp = String(r.bp ?? "unknown");
          const g = String(r.g ?? "");
          const c = Number(r.c ?? 0);
          if (!bpMap.has(bp)) bpMap.set(bp, { nodeCount: 0, graphs: new Map() });
          const entry = bpMap.get(bp)!;
          entry.nodeCount += c;
          if (g) entry.graphs.set(g, c);
          totalNodes += c;
          if (g) graphSet.add(g);
        }
        const backpacks = Array.from(bpMap.entries()).map(([name, d]) => ({
          name,
          nodeCount: d.nodeCount,
          graphCount: d.graphs.size,
          graphs: Array.from(d.graphs.entries()).map(([graphName, nodeCount]) => ({ name: graphName, nodeCount })),
        }));
        sendJson(res, 200, {
          available: true,
          nodeCount: totalNodes,
          graphCount: graphSet.size,
          backpacks,
        });
      } catch {
        sendJson(res, 200, { available: false, nodeCount: 0, graphCount: 0, backpacks: [] });
      }
      return true;
    }

    // --- /api/connector/project-all ---
    // Projects every graph in every registered local backpack into the shared ArcadeDB "backpack" database.
    // Sequential to avoid ArcadeDB MVCC conflicts. Skips cloud and temp paths.

    if (url === "/api/connector/project-all" && method === "POST") {
      try {
        // @ts-ignore — optional peer
        const { ArcadeDBAdapter, ArcadeDBClient, project: connProject } = await import("backpack-connector")
          .catch(() => { throw new Error("backpack-connector is not installed. Run: npm install -g backpack-connector"); });

        const adapter = new ArcadeDBAdapter(new ArcadeDBClient({
          url: process.env.ARCADEDB_URL ?? "http://localhost:2480",
          username: process.env.ARCADEDB_USERNAME ?? "root",
          password: process.env.ARCADEDB_PASSWORD ?? "arcadedb",
        }));

        const allBackpacks = await listBackpacks();
        type ProjectRecord = { backpack: string; graph: string; nodeCount: number; status: "ok" | "error"; error?: string };
        const results: ProjectRecord[] = [];

        for (const bp of allBackpacks) {
          // Skip cloud, temp, and unreachable paths
          if (!bp.path || bp.path.startsWith("cloud://") || bp.path.startsWith("/private/tmp")) continue;
          if (!bp.path.startsWith("/") && !bp.path.startsWith("~")) continue;

          let graphs: { name: string }[] = [];
          try {
            const backend = new JsonFileBackend(bp.path);
            await backend.initialize();
            graphs = await backend.listOntologies();
          } catch { continue; }

          for (const g of graphs) {
            try {
              const result = await connProject(adapter, { backpackPath: bp.path, graph: g.name, branch: "main" });
              results.push({ backpack: bp.name, graph: g.name, nodeCount: result.nodeOps, status: "ok" });
            } catch (err) {
              results.push({ backpack: bp.name, graph: g.name, nodeCount: 0, status: "error", error: (err as Error).message });
            }
          }
        }

        const okCount = results.filter((r) => r.status === "ok").length;
        const errorCount = results.filter((r) => r.status === "error").length;
        const totalNodes = results.filter((r) => r.status === "ok").reduce((s, r) => s + r.nodeCount, 0);
        sendJson(res, 200, { results, graphCount: okCount, errorCount, totalNodes });
      } catch (err) {
        sendErr(res, 503, (err as Error).message);
      }
      return true;
    }

    // --- /api/connector/project-backpack ---
    // Projects all graphs in one specific registered backpack into ArcadeDB.

    if (url === "/api/connector/project-backpack" && method === "POST") {
      try {
        const body = JSON.parse(await readBody(req));
        const targetName: string = body.backpackName ?? "";
        if (!targetName) { sendErr(res, 400, "backpackName required"); return true; }

        // @ts-ignore — optional peer
        const { ArcadeDBAdapter, ArcadeDBClient, project: connProject } = await import("backpack-connector")
          .catch(() => { throw new Error("backpack-connector is not installed"); });

        const adapter = new ArcadeDBAdapter(new ArcadeDBClient({
          url: process.env.ARCADEDB_URL ?? "http://localhost:2480",
          username: process.env.ARCADEDB_USERNAME ?? "root",
          password: process.env.ARCADEDB_PASSWORD ?? "arcadedb",
        }));

        const allBackpacks = await listBackpacks();
        const bp = allBackpacks.find((b) => b.name === targetName);
        if (!bp) { sendErr(res, 404, `Backpack "${targetName}" not found`); return true; }
        if (!bp.path || bp.path.startsWith("cloud://") || bp.path.startsWith("/private/tmp")) {
          sendErr(res, 400, "Cannot project cloud or temp backpacks"); return true;
        }

        const backend = new JsonFileBackend(bp.path);
        await backend.initialize();
        const graphs = await backend.listOntologies();

        type ProjectRecord = { backpack: string; graph: string; nodeCount: number; status: "ok" | "error"; error?: string };
        const results: ProjectRecord[] = [];
        for (const g of graphs) {
          try {
            const result = await connProject(adapter, { backpackPath: bp.path, graph: g.name, branch: "main" });
            results.push({ backpack: bp.name, graph: g.name, nodeCount: result.nodeOps, status: "ok" });
          } catch (err) {
            results.push({ backpack: bp.name, graph: g.name, nodeCount: 0, status: "error", error: (err as Error).message });
          }
        }

        const okCount = results.filter((r) => r.status === "ok").length;
        const errorCount = results.filter((r) => r.status === "error").length;
        const totalNodes = results.filter((r) => r.status === "ok").reduce((s, r) => s + r.nodeCount, 0);
        sendJson(res, 200, { results, graphCount: okCount, errorCount, totalNodes });
      } catch (err) {
        sendErr(res, 503, (err as Error).message);
      }
      return true;
    }

    // --- /api/connector/synthesize-all ---

    if (url === "/api/connector/synthesize-all" && method === "POST") {
      try {
        const active = ctx.storage.activeEntry;
        if (!active) { sendErr(res, 400, "No active backpack"); return true; }

        // Dynamically import connector — optional, only available when backpack-connector is installed.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let connectorMod: any = null;
        try {
          // @ts-ignore — backpack-connector is an optional peer, not in viewer's deps
          connectorMod = await import("backpack-connector");
        } catch {
          sendErr(res, 503, "backpack-connector is not installed. Run: npm install -g backpack-connector");
          return true;
        }

        const backend = ctx.storage.current;
        const summaries = await backend.listOntologies();
        if (summaries.length === 0) { sendErr(res, 400, "No graphs in active backpack"); return true; }

        const graphNames = summaries.map((s: { name: string }) => s.name);
        const outputName = "all-graphs";

        // @ts-ignore
        const { ArcadeDBAdapter, ArcadeDBClient } = await import("backpack-connector");
        const adapter = new ArcadeDBAdapter(new ArcadeDBClient({
          url: process.env.ARCADEDB_URL ?? "http://localhost:2480",
          username: process.env.ARCADEDB_USERNAME ?? "root",
          password: process.env.ARCADEDB_PASSWORD ?? "arcadedb",
        }));

        await connectorMod.synthesize(adapter, {
          backpackPath: active.path,
          graphs: graphNames,
          into: outputName,
          projectFirst: true,
          reset: true,
        });

        sendJson(res, 200, { graphName: outputName, graphCount: graphNames.length });
      } catch (err) {
        sendErr(res, 500, (err as Error).message);
      }
      return true;
    }

    // --- /api/signals/config (detector enable/disable) ---

    if (url === "/api/signals/config" && method === "GET") {
      try {
        const active = ctx.storage.activeEntry;
        if (!active) { sendErr(res, 400, "No active backpack"); return true; }
        const store = new SignalStore(active.path);
        const globalCfg = await store.loadGlobalConfig();
        const builtIn = [
          ...GRAPH_DETECTORS.map((d) => ({ kind: String(d.kind), category: "structural", requiresConnector: false })),
          ...CROSS_CUTTING_DETECTORS.map((d) => ({ kind: String(d.kind), category: "structural", requiresConnector: false })),
        ].map((d) => ({
          ...d,
          enabled: globalCfg.detectors?.[d.kind]?.enabled !== false,
          displayName: d.kind.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
        }));
        sendJson(res, 200, { detectors: builtIn, global: globalCfg.global ?? {} });
      } catch (err) { sendErr(res, 500, (err as Error).message); }
      return true;
    }

    if (url === "/api/signals/config" && method === "PUT") {
      try {
        const active = ctx.storage.activeEntry;
        if (!active) { sendErr(res, 400, "No active backpack"); return true; }
        const store = new SignalStore(active.path);
        const body = await readBody(req);
        const update = JSON.parse(body) as { detectors?: Record<string, { enabled: boolean }> };
        const existing = await store.loadGlobalConfig();
        for (const [kind, cfg] of Object.entries(update.detectors ?? {})) {
          if (!existing.detectors) existing.detectors = {};
          existing.detectors[kind] = { ...(existing.detectors[kind] ?? {}), ...cfg };
        }
        await store.saveGlobalConfig(existing);
        sendJson(res, 200, { ok: true });
      } catch (err) { sendErr(res, 500, (err as Error).message); }
      return true;
    }

    // --- /api/signals/view (signals panel widget layout) ---

    if (url === "/api/signals/view" && method === "GET") {
      try {
        const active = ctx.storage.activeEntry;
        if (!active) { sendJson(res, 200, { spec: null, version: "" }); return true; }
        const dashPath = path.join(active.path, "signals-view.json");
        try {
          const raw = await fs.readFile(dashPath, "utf8");
          const version = crypto.createHash("md5").update(raw).digest("hex").slice(0, 8);
          sendJson(res, 200, { spec: JSON.parse(raw), version });
        } catch {
          sendJson(res, 200, { spec: null, version: "" });
        }
      } catch (err) {
        sendErr(res, 500, (err as Error).message);
      }
      return true;
    }

    if (url === "/api/signals/view" && method === "PUT") {
      try {
        const active = ctx.storage.activeEntry;
        if (!active) { sendErr(res, 400, "No active backpack"); return true; }
        const body = await readBody(req);
        const spec = JSON.parse(body);
        const dashPath = path.join(active.path, "signals-view.json");
        await fs.writeFile(dashPath, JSON.stringify(spec, null, 2), "utf8");
        sendJson(res, 200, { ok: true });
      } catch (err) {
        sendErr(res, 500, (err as Error).message);
      }
      return true;
    }

    return false;
  } catch (err) {
    if (!res.headersSent) {
      sendErr(res, 500, (err as Error).message);
    } else {
      res.end();
    }
    return true;
  }
}
