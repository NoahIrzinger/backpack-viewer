import { defineConfig, type Plugin } from "vite";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { JsonFileBackend, RemoteRegistry, getActiveBackpack } from "backpack-ontology";
import { loadViewerConfig } from "./src/config.js";
import { writeViewerState, readViewerState } from "./src/server-viewer-state.js";
import {
  loadExtensions as loadServerExtensions,
  findExtension,
  publicExtensionInfo,
  proxyExtensionFetch,
  readExtensionSettings,
  writeExtensionSetting,
  deleteExtensionSetting,
  resolveExtensionFile,
  type LoadedExtension,
} from "./src/server-extensions.js";
import { handleApiRequest, type ApiContext } from "./src/server-api-routes.js";

const require = createRequire(import.meta.url);
const pkg = require("./package.json");

/**
 * Vite middleware plugin that wires the viewer's local API into the dev
 * server. The actual route logic lives in shared modules
 * (`src/server-api-routes.ts`, `src/server-extensions.ts`,
 * `src/server-viewer-state.ts`) so dev and prod (`bin/serve.js`) share
 * a single implementation.
 *
 * The dev-specific responsibilities that stay here:
 *   - Backpack-aware filesystem watcher that broadcasts WebSocket
 *     events to the browser when graphs change on disk (live reload)
 *   - Vite-specific URL rewriting for `.ts` extension files (redirect
 *     to `/@fs/` so Vite compiles them on the fly)
 *   - Hooking the `onActiveBackpackChange` callback so a backpack
 *     switch via the API also fires a WebSocket broadcast
 */
function backpackApiPlugin(): Plugin {
  let storageHolder: { current: JsonFileBackend; activeEntry: { name: string; path: string; color: string } | null } = {
    current: null as unknown as JsonFileBackend,
    activeEntry: null,
  };
  let remoteRegistry: RemoteRegistry;
  let readyPromise: Promise<void>;
  let currentWatcher: fs.FSWatcher | null = null;
  let loadedExtensions: LoadedExtension[] = [];
  let apiContext: ApiContext;

  async function makeBackend() {
    const entry = await getActiveBackpack();
    const backend = new JsonFileBackend(undefined, {
      graphsDirOverride: entry.path,
    });
    await backend.initialize();
    return { backend, entry };
  }

  return {
    name: "backpack-api",

    configureServer(server) {
      remoteRegistry = new RemoteRegistry();
      readyPromise = (async () => {
        const swapped = await makeBackend();
        storageHolder.current = swapped.backend;
        storageHolder.activeEntry = swapped.entry;
        await remoteRegistry.initialize();
      })();
      readyPromise.catch((err) => {
        console.error(`[backpack-viewer] storage init failed: ${err.message}`);
      });

      // Resolve in-tree first-party extensions and any user-config
      // external extensions. Logged at startup so the user can see
      // what loaded.
      const userCfg = loadViewerConfig();
      const extCfg = userCfg.extensions ?? { disabled: [], external: [] };
      const userExternalExtensions = Array.isArray(extCfg.external)
        ? (extCfg.external as Array<{ name: string; path: string }>).filter(
            (e) => e && typeof e.name === "string" && typeof e.path === "string",
          )
        : [];
      const disabledFirstParty = new Set<string>(
        Array.isArray(extCfg.disabled) ? (extCfg.disabled as string[]) : [],
      );
      // In dev, first-party extensions live at <repo>/extensions/<name>/
      const firstPartyExtensionsDir = path.resolve(__dirname, "extensions");
      loadedExtensions = loadServerExtensions(
        firstPartyExtensionsDir,
        userExternalExtensions,
        disabledFirstParty,
      );
      if (loadedExtensions.length > 0) {
        console.log(
          `[backpack-viewer] ${loadedExtensions.length} extension(s) loaded: ${loadedExtensions.map((e) => e.manifest.name).join(", ")}`,
        );
      } else {
        console.log("[backpack-viewer] No extensions loaded");
      }

      // Watch the active backpack's directory for live updates. Re-registers
      // the watcher any time the active backpack changes.
      function watchActiveBackpack() {
        if (currentWatcher) {
          try { currentWatcher.close(); } catch {}
        }
        if (!storageHolder.activeEntry) return;
        try {
          currentWatcher = fs.watch(storageHolder.activeEntry.path, { recursive: true }, () => {
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

      // Build the API context shared with the route handler. Uses the
      // mutable storageHolder so backpack switches inside the route
      // handler are visible to subsequent requests.
      apiContext = {
        storage: storageHolder,
        remoteRegistry,
        viewerConfig: userCfg,
        makeBackend,
        // Vite gets a hook so a backpack switch broadcasts to the
        // browser via WS — production has no live channel.
        onActiveBackpackChange: () => {
          watchActiveBackpack();
          server.ws.send({
            type: "custom",
            event: "active-backpack-change",
            data: { active: storageHolder.activeEntry },
          });
        },
        // Dev mode skips the npm registry lookup — always reports not-stale.
        versionCheck: async () => ({
          current: pkg.version,
          latest: pkg.version,
          stale: false,
        }),
      };

      server.middlewares.use(async (req, res, next) => {
        // Wait for storage + remote registry to finish initializing before
        // touching them. Cheap once init is done (a resolved promise).
        try {
          await readyPromise;
        } catch {
          /* let route handlers surface errors per-call */
        }

        // --- Viewer state bridge ---
        if (req.url === "/api/viewer-state" && req.method === "PUT") {
          let body = "";
          req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
          req.on("end", async () => {
            try {
              await writeViewerState(body);
              res.setHeader("Content-Type", "application/json");
              res.end('{"ok":true}');
            } catch (err: any) {
              res.statusCode = 400;
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify({ error: err.message }));
            }
          });
          return;
        }

        if (req.url === "/api/viewer-state" && req.method === "GET") {
          try {
            const data = await readViewerState();
            res.setHeader("Content-Type", "application/json");
            res.end(data);
          } catch {
            res.statusCode = 404;
            res.setHeader("Content-Type", "application/json");
            res.end('{"error":"no viewer state"}');
          }
          return;
        }

        // --- Extension system ---
        if (req.url === "/api/extensions" && req.method === "GET") {
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(loadedExtensions.map(publicExtensionInfo)));
          return;
        }

        const extFileMatch = req.url?.match(/^\/extensions\/([^/?]+)\/(.+?)(\?.*)?$/);
        if (extFileMatch && req.method === "GET") {
          const extName = decodeURIComponent(extFileMatch[1]);
          const subPath = decodeURIComponent(extFileMatch[2]);
          const requestedPath = resolveExtensionFile(loadedExtensions, extName, subPath);
          if (!requestedPath) {
            res.statusCode = 404;
            res.setHeader("Content-Type", "application/json");
            res.end('{"error":"extension file not found"}');
            return;
          }

          // In dev we serve from the SOURCE tree, not from dist/ —
          // there is no `tsc` step in the dev loop. The chat extension's
          // manifest declares `entry: "src/index.js"` (which is what
          // production serves from `dist/extensions/chat/src/index.js`),
          // but in dev only the `.ts` source exists. When the requested
          // `.js` doesn't exist, fall back to the corresponding `.ts`
          // and redirect through Vite's `/@fs/` prefix so Vite picks up
          // the file, transforms it, and serves the compiled JS. Vite's
          // own resolver swaps `.js` imports to `.ts` files for relative
          // imports inside the compiled module, so the transitive
          // imports in the extension also resolve correctly.
          let filePath = requestedPath;
          const ext = path.extname(filePath);
          if (ext === ".js" && !fs.existsSync(filePath)) {
            const tsCandidate = filePath.slice(0, -3) + ".ts";
            if (fs.existsSync(tsCandidate)) {
              filePath = tsCandidate;
            }
          }

          // .ts/.tsx files (whether requested directly or via the .js
          // → .ts fallback above) get redirected through /@fs/ so Vite
          // compiles them on the fly.
          const finalExt = path.extname(filePath);
          if (finalExt === ".ts" || finalExt === ".tsx") {
            res.statusCode = 302;
            res.setHeader("Location", "/@fs/" + filePath);
            res.end();
            return;
          }

          try {
            const data = fs.readFileSync(filePath);
            const mime =
              finalExt === ".js"
                ? "application/javascript"
                : finalExt === ".css"
                  ? "text/css"
                  : finalExt === ".json"
                    ? "application/json"
                    : finalExt === ".html"
                      ? "text/html"
                      : "application/octet-stream";
            res.setHeader("Content-Type", mime);
            res.end(data);
          } catch {
            res.statusCode = 404;
            res.end("Not found");
          }
          return;
        }

        const extFetchMatch = req.url?.match(/^\/api\/extensions\/([^/]+)\/fetch$/);
        if (extFetchMatch && req.method === "POST") {
          const extName = decodeURIComponent(extFetchMatch[1]);
          const ext = findExtension(loadedExtensions, extName);
          if (!ext) {
            res.statusCode = 404;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: `unknown extension: ${extName}` }));
            return;
          }
          let body = "";
          req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
          req.on("end", async () => {
            try {
              const result = await proxyExtensionFetch(ext, body);
              if (result.errorJson || !result.upstreamBody) {
                res.statusCode = result.status;
                res.setHeader("Content-Type", "application/json");
                res.end(result.errorJson ?? JSON.stringify({ error: "proxy failed" }));
                return;
              }
              const upstreamCT =
                result.upstreamHeaders?.get("content-type") ?? "application/octet-stream";
              res.statusCode = result.status;
              res.setHeader("Content-Type", upstreamCT);
              res.setHeader("Cache-Control", "no-cache");
              res.setHeader("Connection", "keep-alive");
              const reader = result.upstreamBody.getReader();
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                res.write(value);
              }
              res.end();
            } catch (err: any) {
              if (!res.headersSent) {
                res.statusCode = 500;
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify({ error: err.message }));
              } else {
                res.end();
              }
            }
          });
          return;
        }

        const extSettingsAllMatch = req.url?.match(/^\/api\/extensions\/([^/]+)\/settings$/);
        if (extSettingsAllMatch && req.method === "GET") {
          const extName = decodeURIComponent(extSettingsAllMatch[1]);
          try {
            const all = await readExtensionSettings(extName);
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify(all));
          } catch (err: any) {
            res.statusCode = 500;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: err.message }));
          }
          return;
        }

        const extSettingsKeyMatch = req.url?.match(/^\/api\/extensions\/([^/]+)\/settings\/([^/]+)$/);
        if (extSettingsKeyMatch && (req.method === "PUT" || req.method === "DELETE")) {
          const extName = decodeURIComponent(extSettingsKeyMatch[1]);
          const key = decodeURIComponent(extSettingsKeyMatch[2]);
          if (req.method === "DELETE") {
            try {
              await deleteExtensionSetting(extName, key);
              res.setHeader("Content-Type", "application/json");
              res.end('{"ok":true}');
            } catch (err: any) {
              res.statusCode = 500;
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify({ error: err.message }));
            }
            return;
          }
          let body = "";
          req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
          req.on("end", async () => {
            try {
              const parsed = JSON.parse(body);
              if (!("value" in parsed)) {
                res.statusCode = 400;
                res.setHeader("Content-Type", "application/json");
                res.end('{"error":"body must include {value}"}');
                return;
              }
              await writeExtensionSetting(extName, key, parsed.value);
              res.setHeader("Content-Type", "application/json");
              res.end('{"ok":true}');
            } catch (err: any) {
              res.statusCode = 400;
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify({ error: err.message }));
            }
          });
          return;
        }

        // --- Shared API routes ---
        // Everything else (config, version-check, ontologies, backpacks,
        // branches, snapshots, snippets, locks, remotes, oauth/callback)
        // lives in src/server-api-routes.ts.
        const handled = await handleApiRequest(req as any, res as any, apiContext);
        if (handled) return;

        // Don't let Vite's SPA fallback serve index.html for unmatched
        // routes that should have been handled above (e.g., /oauth/callback
        // if handleApiRequest didn't match due to a bug).
        if (req.url?.startsWith("/oauth/")) {
          res.statusCode = 404;
          res.end("OAuth route not handled");
          return;
        }

        return next();
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
  "connect-src 'self' ws: wss: https://app.backpackontology.com https://*.ciamlogin.com",
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
  plugins: [backpackApiPlugin()],
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
