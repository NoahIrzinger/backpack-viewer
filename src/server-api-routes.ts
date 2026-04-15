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
  configDir,
  resolveAuthorName,
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
  storage: { current: JsonFileBackend; activeEntry: BackpackEntry | null };
  remoteRegistry: RemoteRegistry;
  viewerConfig: ViewerConfig;
  /** Recreate the backend pointing at the active backpack. */
  makeBackend: () => Promise<{ backend: JsonFileBackend; entry: BackpackEntry }>;
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

    // --- /api/graphs/<name>/branches/* ---
    const branchSwitch = url.match(/^\/api\/graphs\/(.+)\/branches\/switch$/);
    if (branchSwitch && method === "POST") {
      const graphName = decodeURIComponent(branchSwitch[1]);
      const body = await readBody(req);
      try {
        const { name: branchName } = JSON.parse(body);
        await ctx.storage.current.switchBranch(graphName, branchName);
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
        await ctx.storage.current.deleteBranch(graphName, branchName);
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
        const list = await ctx.storage.current.listBranches(graphName);
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
        await ctx.storage.current.createBranch(graphName, branchName, from);
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
        const list = await ctx.storage.current.listSnapshots(graphName);
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
        await ctx.storage.current.createSnapshot(graphName, label);
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
        await ctx.storage.current.rollback(graphName, version);
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
        const snapshot = await ctx.storage.current.loadSnapshot(graphName, version);
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
        const snippet = await ctx.storage.current.loadSnippet(graphName, snippetId);
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
        await ctx.storage.current.deleteSnippet(graphName, snippetId);
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
        const list = await ctx.storage.current.listSnippets(graphName);
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
        const id = await ctx.storage.current.saveSnippet(graphName, {
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
        await setActiveBackpack(name);
        const swapped = await ctx.makeBackend();
        ctx.storage.current = swapped.backend;
        ctx.storage.activeEntry = swapped.entry;
        ctx.onActiveBackpackChange?.();
        sendJson(res, 200, { ok: true, active: ctx.storage.activeEntry });
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
        const settings = await readExtensionSettings("share");
        const syncedMap = settings.synced;
        const keys = (settings.keys as Record<string, string>) || {};
        const synced: Record<string, { encrypted: boolean }> = {};
        if (syncedMap && typeof syncedMap === "object" && !Array.isArray(syncedMap)) {
          for (const name of Object.keys(syncedMap as Record<string, unknown>)) {
            synced[name] = { encrypted: !!keys[name] };
          }
        }
        sendJson(res, 200, { synced });
      } catch {
        sendJson(res, 200, { synced: {} });
      }
      return true;
    }

    // --- /api/kb/* (Knowledge Base documents) ---

    // Helper: resolve a DocumentStore for the active backpack
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
        const docs = await getDocStore();
        const params = new URL(req.url ?? "/", "http://localhost").searchParams;
        const result = await docs.list({
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
        const docs = await getDocStore();
        const mounts = await docs.listMounts();
        sendJson(res, 200, mounts);
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
        const docs = await getDocStore();
        const doc = await docs.read(id);
        sendJson(res, 200, doc);
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

    // --- /api/ontologies/* ---
    if (url === "/api/ontologies" && method === "GET") {
      try {
        const summaries = await ctx.storage.current.listOntologies();
        sendJson(res, 200, summaries);
      } catch {
        sendJson(res, 200, []);
      }
      return true;
    }

    // /api/ontologies/<name>/rename — must match before /api/ontologies/<name>
    const rename = url.match(/^\/api\/ontologies\/(.+)\/rename$/);
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

    if (url.startsWith("/api/ontologies/")) {
      const name = decodeURIComponent(url.replace("/api/ontologies/", ""));
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
          sendErr(res, 404, "Ontology not found");
        }
        return true;
      }
    }

    // --- /oauth/callback (for Share extension OAuth popup or same-tab redirect) ---
    if (url.startsWith("/oauth/callback") && method === "GET") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<!DOCTYPE html><html><body><script>
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
        const graphJSON = new TextEncoder().encode(body);

        const params = new URLSearchParams(url.split("?")[1] || "");
        const wantEncrypted = params.get("encrypted") !== "false";

        let payload: Uint8Array;
        let format: string;

        if (wantEncrypted) {
          const age = await import("age-encryption");
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
        }

        // Build BPAK envelope
        const parsed = JSON.parse(body);
        const kind = params.get("kind") || "learning_graph";
        const typeSet = new Set<string>();
        if (parsed.nodes) for (const n of parsed.nodes) typeSet.add(n.type);
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
          headerObj.document_count = (parsed.documents || []).length;
        } else {
          headerObj.graph_count = 1;
          headerObj.node_count = (parsed.nodes || []).length;
          headerObj.edge_count = (parsed.edges || []).length;
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

        // Proxy to relay
        const syncHeaders: Record<string, string> = {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/octet-stream",
        };
        try {
          syncHeaders["X-Backpack-Device-Name"] = os.hostname();
          syncHeaders["X-Backpack-Device-Hostname"] = os.hostname();
          syncHeaders["X-Backpack-Device-Platform"] = os.platform();
        } catch { /* device info unavailable */ }

        const relayRes = await fetch(`${relayUrl}/api/graphs/${encodeURIComponent(name)}/sync`, {
          method: "PUT",
          headers: syncHeaders,
          body: envelope,
        });

        if (!relayRes.ok) {
          let msg = `Sync failed (${relayRes.status})`;
          try { const b = await relayRes.json(); if (b.error) msg = b.error; } catch {}
          sendErr(res, relayRes.status, msg);
          return true;
        }

        // Mark as synced in extension settings
        const synced = ((settings.synced as Record<string, boolean>) || {});
        synced[name] = true;
        await writeExtensionSetting("share", "synced", synced);

        const result = await relayRes.json();
        sendJson(res, 200, result);
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
