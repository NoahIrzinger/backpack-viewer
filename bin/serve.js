#!/usr/bin/env node

import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const distDir = path.resolve(root, "dist/app");

const hasDistBuild = fs.existsSync(path.join(distDir, "index.html"));

/**
 * Fetch the `latest` tag for a package from the npm registry. Returns
 * the version string on success, null on any failure (offline,
 * timeout, parse error, etc). Never throws — caller uses a falsy
 * check to skip the stale warning if the registry is unreachable.
 */
function fetchLatestVersion(pkgName) {
  return new Promise((resolve) => {
    const req = https.get(
      `https://registry.npmjs.org/${pkgName}/latest`,
      { timeout: 5000, headers: { Accept: "application/json" } },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          resolve(null);
          return;
        }
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            const parsed = JSON.parse(data);
            resolve(typeof parsed.version === "string" ? parsed.version : null);
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
  });
}

// --- Version check cache (1 hour TTL) ---
// Used by the /api/version-check endpoint so the sidebar can render
// a stale-version banner without hammering the npm registry on every
// request.
const versionCheckCache = { ts: 0, latest: null, current: null };
const VERSION_CACHE_TTL_MS = 60 * 60 * 1000;

async function getCachedVersionCheck(currentVersion) {
  const now = Date.now();
  if (
    versionCheckCache.latest !== null &&
    now - versionCheckCache.ts < VERSION_CACHE_TTL_MS
  ) {
    return {
      current: versionCheckCache.current,
      latest: versionCheckCache.latest,
      stale: versionCheckCache.latest !== versionCheckCache.current,
    };
  }
  const latest = await fetchLatestVersion("backpack-viewer");
  if (latest) {
    versionCheckCache.ts = now;
    versionCheckCache.latest = latest;
    versionCheckCache.current = currentVersion;
  }
  return {
    current: currentVersion,
    latest,
    stale: latest !== null && latest !== currentVersion,
  };
}

if (hasDistBuild) {
  // --- Production: static file server + API (zero native deps) ---
  const { JsonFileBackend, RemoteRegistry, getActiveBackpack } = await import(
    "backpack-ontology"
  );
  const { loadViewerConfig } = await import("../dist/config.js");
  const { writeViewerState, readViewerState } = await import(
    "../dist/server-viewer-state.js"
  );
  const {
    loadExtensions: loadServerExtensions,
    findExtension,
    publicExtensionInfo,
    proxyExtensionFetch,
    readExtensionSettings,
    writeExtensionSetting,
    deleteExtensionSetting,
    resolveExtensionFile,
  } = await import("../dist/server-extensions.js");
  const { handleApiRequest } = await import("../dist/server-api-routes.js");

  // Load our own version from package.json for the stale-version check
  const pkgJson = JSON.parse(
    fs.readFileSync(path.join(root, "package.json"), "utf8"),
  );
  const currentVersion = pkgJson.version;

  // Resolve host + port from the viewer config, with env vars taking
  // precedence for quick overrides. Default is 127.0.0.1 loopback —
  // the viewer must never bind to all interfaces by default because
  // its API exposes read/write access to the user's learning graphs.
  const viewerConfig = loadViewerConfig();
  const configuredHost = viewerConfig?.server?.host ?? "127.0.0.1";
  const configuredPort = viewerConfig?.server?.port ?? 5173;
  const bindHost = process.env.BACKPACK_VIEWER_HOST ?? configuredHost;
  const port = parseInt(process.env.PORT || String(configuredPort), 10);

  // Storage points at the active backpack. Wrapped in a mutable
  // holder so a `/api/backpacks/switch` POST can swap it out in place
  // without restarting the whole server. The holder is shared with
  // the API route handler so a swap inside one request is visible to
  // the next request without re-plumbing.
  async function makeBackend() {
    const entry = await getActiveBackpack();
    const backend = new JsonFileBackend(undefined, {
      graphsDirOverride: entry.path,
    });
    await backend.initialize();
    return { backend, entry };
  }
  const initial = await makeBackend();
  const storageHolder = { current: initial.backend, activeEntry: initial.entry };

  const remoteRegistry = new RemoteRegistry();
  await remoteRegistry.initialize();

  // First-party extensions are bundled at dist/extensions/<name>/.
  // External extensions come from the user's viewer config.
  const firstPartyExtensionsDir = path.resolve(distDir, "..", "extensions");
  const extConfig = viewerConfig.extensions ?? {};
  const userExternalExtensions = Array.isArray(extConfig.external)
    ? extConfig.external.filter((e) => e && typeof e.name === "string" && typeof e.path === "string")
    : [];
  const disabledFirstParty = new Set(
    Array.isArray(extConfig.disabled) ? extConfig.disabled : [],
  );
  const loadedExtensions = loadServerExtensions(
    firstPartyExtensionsDir,
    userExternalExtensions,
    disabledFirstParty,
  );

  // Context object passed to the shared API route handler.
  const apiContext = {
    storage: storageHolder,
    remoteRegistry,
    viewerConfig,
    makeBackend,
    versionCheck: () => getCachedVersionCheck(currentVersion),
  };

  const MIME_TYPES = {
    ".html": "text/html",
    ".js": "application/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
  };

  // Strict CSP — style-src 'self' means no inline styles allowed.
  // Keep it that way; see CLAUDE.md for the rule.
  //
  // connect-src allows 'self' + the share relay for the Share extension's
  // OAuth flow and relay uploads.
  const CSP = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "connect-src 'self' https://app.backpackontology.com https://*.ciamlogin.com",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
  ].join("; ");

  const server = http.createServer(async (req, res) => {
    res.setHeader("Content-Security-Policy", CSP);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");

    const url = req.url?.replace(/\?.*$/, "") || "/";

    // --- Viewer state bridge ---
    // Logic lives in src/server-viewer-state.ts so dev (Vite plugin)
    // and prod share it. Only the HTTP wiring is here.
    if (url === "/api/viewer-state" && req.method === "PUT") {
      let body = "";
      req.on("data", (chunk) => { body += chunk.toString(); });
      req.on("end", async () => {
        try {
          await writeViewerState(body);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end('{"ok":true}');
        } catch (err) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    if (url === "/api/viewer-state" && req.method === "GET") {
      try {
        const data = await readViewerState();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(data);
      } catch {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end('{"error":"no viewer state"}');
      }
      return;
    }

    // --- Extension system ---
    // Generic per-extension endpoints. Logic lives in
    // src/server-extensions.ts so dev and prod share it.

    if (url === "/api/extensions" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(loadedExtensions.map(publicExtensionInfo)));
      return;
    }

    const extFileMatch = url.match(/^\/extensions\/([^/]+)\/(.+)$/);
    if (extFileMatch && req.method === "GET") {
      const extName = decodeURIComponent(extFileMatch[1]);
      const subPath = decodeURIComponent(extFileMatch[2]);
      const filePath = resolveExtensionFile(loadedExtensions, extName, subPath);
      if (!filePath) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end('{"error":"extension file not found"}');
        return;
      }
      try {
        const data = fs.readFileSync(filePath);
        const ext = path.extname(filePath);
        const mime = MIME_TYPES[ext] || "application/octet-stream";
        res.writeHead(200, { "Content-Type": mime });
        res.end(data);
      } catch {
        res.writeHead(404);
        res.end("Not found");
      }
      return;
    }

    const extFetchMatch = url.match(/^\/api\/extensions\/([^/]+)\/fetch$/);
    if (extFetchMatch && req.method === "POST") {
      const extName = decodeURIComponent(extFetchMatch[1]);
      const ext = findExtension(loadedExtensions, extName);
      if (!ext) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: `unknown extension: ${extName}` }));
        return;
      }
      let body = "";
      req.on("data", (chunk) => { body += chunk.toString(); });
      req.on("end", async () => {
        try {
          const result = await proxyExtensionFetch(ext, body);
          if (result.errorJson || !result.upstreamBody) {
            res.writeHead(result.status, { "Content-Type": "application/json" });
            res.end(result.errorJson ?? JSON.stringify({ error: "proxy failed" }));
            return;
          }
          const upstreamCT =
            result.upstreamHeaders?.get("content-type") ?? "application/octet-stream";
          res.writeHead(result.status, {
            "Content-Type": upstreamCT,
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          });
          const reader = result.upstreamBody.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(value);
          }
          res.end();
        } catch (err) {
          if (!res.headersSent) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: err.message }));
          } else {
            res.end();
          }
        }
      });
      return;
    }

    const extSettingsAllMatch = url.match(/^\/api\/extensions\/([^/]+)\/settings$/);
    if (extSettingsAllMatch && req.method === "GET") {
      const extName = decodeURIComponent(extSettingsAllMatch[1]);
      try {
        const all = await readExtensionSettings(extName);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(all));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    const extSettingsKeyMatch = url.match(/^\/api\/extensions\/([^/]+)\/settings\/([^/]+)$/);
    if (extSettingsKeyMatch && (req.method === "PUT" || req.method === "DELETE")) {
      const extName = decodeURIComponent(extSettingsKeyMatch[1]);
      const key = decodeURIComponent(extSettingsKeyMatch[2]);
      if (req.method === "DELETE") {
        try {
          await deleteExtensionSetting(extName, key);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end('{"ok":true}');
        } catch (err) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
        }
        return;
      }
      let body = "";
      req.on("data", (chunk) => { body += chunk.toString(); });
      req.on("end", async () => {
        try {
          const parsed = JSON.parse(body);
          if (!("value" in parsed)) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end('{"error":"body must include {value}"}');
            return;
          }
          await writeExtensionSetting(extName, key, parsed.value);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end('{"ok":true}');
        } catch (err) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // --- Shared API routes ---
    // All the other API endpoints (config, version-check, ontologies,
    // backpacks, branches, snapshots, snippets, locks, remotes, etc.)
    // live in src/server-api-routes.ts so dev and prod share them.
    if (await handleApiRequest(req, res, apiContext)) {
      return;
    }

    // --- Static files ---
    let filePath = path.join(distDir, url === "/" ? "index.html" : url);

    // SPA fallback: serve index.html for non-file routes
    if (!fs.existsSync(filePath)) {
      filePath = path.join(distDir, "index.html");
    }

    try {
      const data = fs.readFileSync(filePath);
      const ext = path.extname(filePath);
      const contentType = MIME_TYPES[ext] || "application/octet-stream";
      res.writeHead(200, { "Content-Type": contentType });
      res.end(data);
    } catch {
      res.writeHead(404);
      res.end("Not found");
    }
  });

  // Bind to whatever the config + env var resolved to. The default is
  // 127.0.0.1 because the viewer API exposes read/write access to the
  // user's learning graphs and must never be reachable from other
  // machines on the same network by default. Users who really need to
  // bind to another interface (e.g. for a devcontainer scenario) can
  // set server.host in ~/.config/backpack/viewer.json or the
  // BACKPACK_VIEWER_HOST env var, and will see a loud warning.
  server.listen(port, bindHost, () => {
    const displayHost = bindHost === "0.0.0.0" || bindHost === "::" ? "localhost" : bindHost;
    console.log(`  Backpack Viewer v${currentVersion} running at http://${displayHost}:${port}/`);
    if (loadedExtensions.length > 0) {
      console.log(
        `  ${loadedExtensions.length} extension(s) loaded: ${loadedExtensions.map((e) => e.manifest.name).join(", ")}`,
      );
    } else {
      console.log("  No extensions loaded");
    }
    const isLoopback =
      bindHost === "127.0.0.1" ||
      bindHost === "localhost" ||
      bindHost === "::1";
    if (!isLoopback) {
      console.warn(
        `  WARNING: viewer is bound to ${bindHost}, not loopback. The API exposes read/write access to your learning graphs — anyone on your network can reach it. Set server.host to "127.0.0.1" in ~/.config/backpack/viewer.json to restrict to localhost.`,
      );
    }

    // Fire-and-forget stale-version check. If the registry responds
    // and our version is older than `latest`, print a loud warning
    // telling the user exactly how to unblock themselves.
    fetchLatestVersion("backpack-viewer").then((latest) => {
      if (latest && latest !== currentVersion) {
        console.warn("");
        console.warn(`  Backpack Viewer ${currentVersion} is out of date — latest is ${latest}`);
        console.warn(`  To update:`);
        console.warn(`    npm cache clean --force`);
        console.warn(`    npx backpack-viewer@latest`);
        console.warn("");
      }
    });
  });
} else {
  // --- Development: use Vite for HMR + TypeScript compilation ---
  const { createServer } = await import("vite");

  const server = await createServer({
    root,
    configFile: path.resolve(root, "vite.config.ts"),
    server: { port: parseInt(process.env.PORT || "5173", 10), open: true },
  });

  await server.listen();
  server.printUrls();
}
