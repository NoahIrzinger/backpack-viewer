import { defineConfig, type Plugin } from "vite";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import {
  JsonFileBackend,
  dataDir,
  RemoteRegistry,
  listBackpacks,
  getActiveBackpack,
  setActiveBackpack,
  registerBackpack,
  unregisterBackpack,
} from "backpack-ontology";
import { loadViewerConfig } from "./src/config.js";

const require = createRequire(import.meta.url);
const pkg = require("./package.json");

function ontologyApiPlugin(): Plugin {
  let storage: JsonFileBackend;
  let activeEntry: { name: string; path: string; color: string } | null = null;
  let remoteRegistry: RemoteRegistry;
  // Promise that resolves when both stores are ready. Every middleware
  // request awaits this before touching storage so a fast initial request
  // can't race a slow init.
  let readyPromise: Promise<void>;
  let currentWatcher: fs.FSWatcher | null = null;

  async function makeBackend() {
    const entry = await getActiveBackpack();
    const backend = new JsonFileBackend(undefined, {
      graphsDirOverride: entry.path,
    });
    await backend.initialize();
    return { backend, entry };
  }

  return {
    name: "ontology-api",

    configureServer(server) {
      remoteRegistry = new RemoteRegistry();
      readyPromise = (async () => {
        const swapped = await makeBackend();
        storage = swapped.backend;
        activeEntry = swapped.entry;
        await remoteRegistry.initialize();
      })();
      readyPromise.catch((err) => {
        console.error(`[backpack-viewer] storage init failed: ${err.message}`);
      });

      // Watch the active backpack's directory for live updates. Re-registers
      // the watcher any time the active backpack changes.
      function watchActiveBackpack() {
        if (currentWatcher) {
          try { currentWatcher.close(); } catch {}
        }
        if (!activeEntry) return;
        try {
          currentWatcher = fs.watch(activeEntry.path, { recursive: true }, () => {
            server.ws.send({
              type: "custom",
              event: "ontology-change",
              data: {},
            });
          });
        } catch {
          // Directory may not exist yet
        }
      }
      readyPromise.then(watchActiveBackpack);

      server.middlewares.use(async (req, res, next) => {
        // Wait for storage + remote registry to finish initializing before
        // touching them. Cheap once init is done (a resolved promise).
        try {
          await readyPromise;
        } catch {
          // Init failed; let the request fall through to next() so static
          // files still serve. API routes below will surface errors per-call.
        }
        // Config endpoint
        if (req.url === "/api/config" && req.method === "GET") {
          const config = loadViewerConfig();
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(config));
          return;
        }

        // --- Remote graph routes (read-only) ---
        if (req.url === "/api/remotes" && req.method === "GET") {
          remoteRegistry
            .list()
            .then(async (remotes) => {
              const summaries = await Promise.all(
                remotes.map(async (r) => {
                  try {
                    const data = await remoteRegistry.loadCached(r.name);
                    return {
                      name: r.name,
                      url: r.url,
                      source: r.source,
                      addedAt: r.addedAt,
                      lastFetched: r.lastFetched,
                      pinned: r.pinned,
                      sizeBytes: r.sizeBytes,
                      nodeCount: data.nodes.length,
                      edgeCount: data.edges.length,
                    };
                  } catch {
                    return {
                      name: r.name,
                      url: r.url,
                      source: r.source,
                      addedAt: r.addedAt,
                      lastFetched: r.lastFetched,
                      pinned: r.pinned,
                      sizeBytes: r.sizeBytes,
                      nodeCount: 0,
                      edgeCount: 0,
                    };
                  }
                }),
              );
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify(summaries));
            })
            .catch((err: Error) => {
              res.statusCode = 500;
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify({ error: err.message }));
            });
          return;
        }

        const remoteItemMatch = req.url?.match(/^\/api\/remotes\/(.+)$/);
        if (remoteItemMatch && req.method === "GET") {
          const remoteName = decodeURIComponent(remoteItemMatch[1]);
          remoteRegistry
            .loadCached(remoteName)
            .then((data) => {
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify(data));
            })
            .catch((err: Error) => {
              res.statusCode = 404;
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify({ error: err.message }));
            });
          return;
        }

        // --- Branch routes ---
        const branchSwitchMatch = req.url?.match(/^\/api\/graphs\/(.+)\/branches\/switch$/);
        if (branchSwitchMatch && req.method === "POST") {
          const graphName = decodeURIComponent(branchSwitchMatch[1]);
          let body = "";
          req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
          req.on("end", () => {
            try {
              const { name: branchName } = JSON.parse(body);
              storage.switchBranch(graphName, branchName).then(() => {
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify({ ok: true }));
              }).catch((err: Error) => {
                res.statusCode = 400;
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify({ error: err.message }));
              });
            } catch {
              res.statusCode = 400;
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify({ error: "Invalid JSON" }));
            }
          });
          return;
        }

        const deleteBranchMatch = req.url?.match(/^\/api\/graphs\/(.+)\/branches\/(.+)$/);
        if (deleteBranchMatch && req.method === "DELETE") {
          const graphName = decodeURIComponent(deleteBranchMatch[1]);
          const branchName = decodeURIComponent(deleteBranchMatch[2]);
          storage.deleteBranch(graphName, branchName).then(() => {
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ ok: true }));
          }).catch((err: Error) => {
            res.statusCode = 400;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: err.message }));
          });
          return;
        }

        const branchMatch = req.url?.match(/^\/api\/graphs\/(.+)\/branches$/);
        if (branchMatch && req.method === "GET") {
          const graphName = decodeURIComponent(branchMatch[1]);
          storage.listBranches(graphName).then((branches) => {
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify(branches));
          }).catch((err: Error) => {
            res.statusCode = 500;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: err.message }));
          });
          return;
        }

        if (branchMatch && req.method === "POST") {
          const graphName = decodeURIComponent(branchMatch[1]);
          let body = "";
          req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
          req.on("end", () => {
            try {
              const { name: branchName, from } = JSON.parse(body);
              storage.createBranch(graphName, branchName, from).then(() => {
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify({ ok: true }));
              }).catch((err: Error) => {
                res.statusCode = 400;
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify({ error: err.message }));
              });
            } catch {
              res.statusCode = 400;
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify({ error: "Invalid JSON" }));
            }
          });
          return;
        }

        // --- Snapshot routes ---
        const snapshotMatch = req.url?.match(/^\/api\/graphs\/(.+)\/snapshots$/);
        if (snapshotMatch && req.method === "GET") {
          const graphName = decodeURIComponent(snapshotMatch[1]);
          storage.listSnapshots(graphName).then((snapshots) => {
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify(snapshots));
          }).catch((err: Error) => {
            res.statusCode = 500;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: err.message }));
          });
          return;
        }

        if (snapshotMatch && req.method === "POST") {
          const graphName = decodeURIComponent(snapshotMatch[1]);
          let body = "";
          req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
          req.on("end", () => {
            try {
              const { label } = JSON.parse(body);
              storage.createSnapshot(graphName, label).then(() => {
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify({ ok: true }));
              }).catch((err: Error) => {
                res.statusCode = 400;
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify({ error: err.message }));
              });
            } catch {
              res.statusCode = 400;
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify({ error: "Invalid JSON" }));
            }
          });
          return;
        }

        // --- Rollback route ---
        const rollbackMatch = req.url?.match(/^\/api\/graphs\/(.+)\/rollback$/);
        if (rollbackMatch && req.method === "POST") {
          const graphName = decodeURIComponent(rollbackMatch[1]);
          let body = "";
          req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
          req.on("end", () => {
            try {
              const { version } = JSON.parse(body);
              storage.rollback(graphName, version).then(() => {
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify({ ok: true }));
              }).catch((err: Error) => {
                res.statusCode = 400;
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify({ error: err.message }));
              });
            } catch {
              res.statusCode = 400;
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify({ error: "Invalid JSON" }));
            }
          });
          return;
        }

        // --- Diff route ---
        const diffMatch = req.url?.match(/^\/api\/graphs\/(.+)\/diff\/(\d+)$/);
        if (diffMatch && req.method === "GET") {
          const graphName = decodeURIComponent(diffMatch[1]);
          const version = parseInt(diffMatch[2], 10);
          Promise.all([
            storage.loadOntology(graphName),
            storage.loadSnapshot(graphName, version),
          ]).then(([current, snapshot]) => {
            const currentNodeIds = new Set(current.nodes.map((n: any) => n.id));
            const snapshotNodeIds = new Set(snapshot.nodes.map((n: any) => n.id));
            const currentEdgeIds = new Set(current.edges.map((e: any) => e.id));
            const snapshotEdgeIds = new Set(snapshot.edges.map((e: any) => e.id));
            const diff = {
              nodesAdded: current.nodes.filter((n: any) => !snapshotNodeIds.has(n.id)).length,
              nodesRemoved: snapshot.nodes.filter((n: any) => !currentNodeIds.has(n.id)).length,
              edgesAdded: current.edges.filter((e: any) => !snapshotEdgeIds.has(e.id)).length,
              edgesRemoved: snapshot.edges.filter((e: any) => !currentEdgeIds.has(e.id)).length,
            };
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify(diff));
          }).catch((err: Error) => {
            res.statusCode = 500;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: err.message }));
          });
          return;
        }

        // --- Snippet routes ---
        const snippetItemMatch = req.url?.match(/^\/api\/graphs\/(.+)\/snippets\/(.+)$/);
        if (snippetItemMatch && req.method === "GET") {
          const graphName = decodeURIComponent(snippetItemMatch[1]);
          const snippetId = decodeURIComponent(snippetItemMatch[2]);
          storage.loadSnippet(graphName, snippetId).then((snippet: any) => {
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify(snippet));
          }).catch((err: Error) => {
            res.statusCode = 404;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: err.message }));
          });
          return;
        }

        if (snippetItemMatch && req.method === "DELETE") {
          const graphName = decodeURIComponent(snippetItemMatch[1]);
          const snippetId = decodeURIComponent(snippetItemMatch[2]);
          storage.deleteSnippet(graphName, snippetId).then(() => {
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ ok: true }));
          }).catch((err: Error) => {
            res.statusCode = 400;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: err.message }));
          });
          return;
        }

        const snippetMatch = req.url?.match(/^\/api\/graphs\/(.+)\/snippets$/);
        if (snippetMatch && req.method === "GET") {
          const graphName = decodeURIComponent(snippetMatch[1]);
          storage.listSnippets(graphName).then((snippets: any) => {
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify(snippets));
          }).catch((err: Error) => {
            res.statusCode = 500;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: err.message }));
          });
          return;
        }

        if (snippetMatch && req.method === "POST") {
          const graphName = decodeURIComponent(snippetMatch[1]);
          let body = "";
          req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
          req.on("end", () => {
            try {
              const { label, description, nodeIds, edgeIds } = JSON.parse(body);
              storage.saveSnippet(graphName, { label, description, nodeIds, edgeIds: edgeIds ?? [] }).then((id: string) => {
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify({ ok: true, id }));
              }).catch((err: Error) => {
                res.statusCode = 400;
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify({ error: err.message }));
              });
            } catch {
              res.statusCode = 400;
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify({ error: "Invalid JSON" }));
            }
          });
          return;
        }

        // --- Version check (dev mode: always reports not-stale) ---
        if (req.url === "/api/version-check" && req.method === "GET") {
          res.setHeader("Content-Type", "application/json");
          res.end(
            JSON.stringify({
              current: pkg.version,
              latest: pkg.version,
              stale: false,
            }),
          );
          return;
        }

        // --- Backpacks (meta: list, active, register, switch, unregister) ---
        if (req.url === "/api/backpacks" && req.method === "GET") {
          try {
            const list = await listBackpacks();
            const active = await getActiveBackpack();
            res.setHeader("Content-Type", "application/json");
            res.end(
              JSON.stringify(
                list.map((b) => ({ ...b, active: b.name === active.name })),
              ),
            );
          } catch (err: any) {
            res.statusCode = 500;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: err.message }));
          }
          return;
        }

        if (req.url === "/api/backpacks/active" && req.method === "GET") {
          try {
            const active = await getActiveBackpack();
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify(active));
          } catch (err: any) {
            res.statusCode = 500;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: err.message }));
          }
          return;
        }

        if (req.url === "/api/backpacks/switch" && req.method === "POST") {
          let body = "";
          req.on("data", (chunk) => { body += chunk.toString(); });
          req.on("end", async () => {
            try {
              const { name } = JSON.parse(body);
              await setActiveBackpack(name);
              const swapped = await makeBackend();
              storage = swapped.backend;
              activeEntry = swapped.entry;
              watchActiveBackpack();
              // Notify the browser so sidebar/canvas hot-swap
              server.ws.send({
                type: "custom",
                event: "active-backpack-change",
                data: { active: activeEntry },
              });
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify({ ok: true, active: activeEntry }));
            } catch (err: any) {
              res.statusCode = 400;
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify({ error: err.message }));
            }
          });
          return;
        }

        if (req.url === "/api/backpacks" && req.method === "POST") {
          let body = "";
          req.on("data", (chunk) => { body += chunk.toString(); });
          req.on("end", async () => {
            try {
              const { name, path: p, activate } = JSON.parse(body);
              const entry = await registerBackpack(name, p);
              if (activate) {
                await setActiveBackpack(name);
                const swapped = await makeBackend();
                storage = swapped.backend;
                activeEntry = swapped.entry;
                watchActiveBackpack();
                server.ws.send({
                  type: "custom",
                  event: "active-backpack-change",
                  data: { active: activeEntry },
                });
              }
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify({ ok: true, entry }));
            } catch (err: any) {
              res.statusCode = 400;
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify({ error: err.message }));
            }
          });
          return;
        }

        const backpackDeleteMatch = req.url?.match(/^\/api\/backpacks\/(.+)$/);
        if (backpackDeleteMatch && req.method === "DELETE") {
          const name = decodeURIComponent(backpackDeleteMatch[1]);
          try {
            await unregisterBackpack(name);
            if (activeEntry && activeEntry.name === name) {
              const swapped = await makeBackend();
              storage = swapped.backend;
              activeEntry = swapped.entry;
              watchActiveBackpack();
              server.ws.send({
                type: "custom",
                event: "active-backpack-change",
                data: { active: activeEntry },
              });
            }
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ ok: true }));
          } catch (err: any) {
            res.statusCode = 400;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: err.message }));
          }
          return;
        }

        // GET /api/locks — batch heartbeat for collaboration awareness
        if (req.url === "/api/locks" && req.method === "GET") {
          storage
            .listOntologies()
            .then(async (summaries) => {
              const result: Record<string, unknown> = {};
              if (typeof (storage as any).readLock === "function") {
                await Promise.all(
                  summaries.map(async (s) => {
                    try {
                      result[s.name] = await (storage as any).readLock(s.name);
                    } catch {
                      result[s.name] = null;
                    }
                  }),
                );
              }
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify(result));
            })
            .catch(() => {
              res.setHeader("Content-Type", "application/json");
              res.end("{}");
            });
          return;
        }

        // GET /api/graphs/:name/lock — single-graph heartbeat (kept for compat)
        const lockMatch = req.url?.match(/^\/api\/graphs\/(.+)\/lock$/);
        if (lockMatch && req.method === "GET") {
          const graphName = decodeURIComponent(lockMatch[1]);
          (typeof (storage as any).readLock === "function"
            ? (storage as any).readLock(graphName)
            : Promise.resolve(null))
            .then((lock: unknown) => {
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify(lock));
            })
            .catch(() => {
              res.setHeader("Content-Type", "application/json");
              res.end("null");
            });
          return;
        }

        if (!req.url?.startsWith("/api/ontologies")) return next();

        const urlPath = req.url.replace(/\?.*$/, "");

        // GET /api/ontologies
        if (urlPath === "/api/ontologies" && req.method === "GET") {
          storage
            .listOntologies()
            .then((summaries) => {
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify(summaries));
            })
            .catch(() => {
              res.setHeader("Content-Type", "application/json");
              res.end("[]");
            });
          return;
        }

        // POST /api/ontologies/:name/rename
        const renameMatch = urlPath.match(/^\/api\/ontologies\/(.+)\/rename$/);
        if (renameMatch && req.method === "POST") {
          const oldName = decodeURIComponent(renameMatch[1]);
          let body = "";
          req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
          req.on("end", () => {
            try {
              const { name: newName } = JSON.parse(body);
              storage.renameOntology(oldName, newName).then(() => {
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify({ ok: true, name: newName }));
              }).catch((err: Error) => {
                res.statusCode = 500;
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify({ error: err.message }));
              });
            } catch {
              res.statusCode = 400;
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify({ error: "Invalid JSON" }));
            }
          });
          return;
        }

        const name = decodeURIComponent(
          urlPath.replace("/api/ontologies/", "")
        );
        if (!name) return next();

        // PUT /api/ontologies/:name
        if (req.method === "PUT") {
          let body = "";
          req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
          req.on("end", () => {
            try {
              const data = JSON.parse(body);
              storage.saveOntology(name, data).then(() => {
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify({ ok: true }));
              }).catch((err: Error) => {
                res.statusCode = 500;
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify({ error: err.message }));
              });
            } catch {
              res.statusCode = 400;
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify({ error: "Invalid JSON" }));
            }
          });
          return;
        }

        // GET /api/ontologies/:name
        storage
          .loadOntology(name)
          .then((data) => {
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify(data));
          })
          .catch(() => {
            res.statusCode = 404;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: "Ontology not found" }));
          });
      });
    },
  };
}

// CSP for the viewer.
//
// Production (bin/serve.js, vite preview): strict — style-src 'self'.
// Dev server (vite dev): style-src must allow 'unsafe-inline' because Vite
// injects CSS as inline <style> blocks for HMR. The dev server is local-only
// and not exposed to the internet, so the relaxed style-src is acceptable
// in dev only. Production CSP (in bin/serve.js) stays strict; see CLAUDE.md.
const PROD_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
].join("; ");

const DEV_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'", // required by Vite HMR
  "img-src 'self' data:",
  "connect-src 'self' ws: wss:",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
].join("; ");

const baseHeaders = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
};

const DEV_HEADERS = {
  ...baseHeaders,
  "Content-Security-Policy": DEV_CSP,
};

const PREVIEW_HEADERS = {
  ...baseHeaders,
  "Content-Security-Policy": PROD_CSP,
};

// Resolve server bind host + port from the viewer config for the dev
// and preview servers too, so `npm run dev` and `vite preview` respect
// the same settings as production. Default is 127.0.0.1 loopback.
const viewerConfigForDev = loadViewerConfig();
const devHost =
  process.env.BACKPACK_VIEWER_HOST ?? viewerConfigForDev?.server?.host ?? "127.0.0.1";
const devPort = parseInt(
  process.env.PORT ?? String(viewerConfigForDev?.server?.port ?? 5173),
  10,
);

export default defineConfig({
  plugins: [ontologyApiPlugin()],
  define: {
    __VIEWER_VERSION__: JSON.stringify(pkg.version),
  },
  server: {
    host: devHost,
    port: devPort,
    headers: DEV_HEADERS,
  },
  preview: {
    host: devHost,
    port: devPort,
    headers: PREVIEW_HEADERS,
  },
  build: {
    outDir: "dist/app",
  },
});
