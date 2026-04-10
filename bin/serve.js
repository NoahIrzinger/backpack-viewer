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
  const {
    JsonFileBackend,
    dataDir,
    RemoteRegistry,
    listBackpacks,
    getActiveBackpack,
    setActiveBackpack,
    registerBackpack,
    unregisterBackpack,
  } = await import("backpack-ontology");
  const { loadViewerConfig } = await import("../dist/config.js");

  // Load our own version from package.json for the stale-version check
  const pkgJson = JSON.parse(
    fs.readFileSync(path.join(root, "package.json"), "utf8"),
  );
  const currentVersion = pkgJson.version;

  // Resolve host + port from the viewer config, with env vars taking
  // precedence for quick overrides. Default is 127.0.0.1 loopback —
  // the viewer must never bind to all interfaces by default because
  // its API exposes read/write access to the user's learning graphs.
  const viewerConfigForServer = loadViewerConfig();
  const configuredHost = viewerConfigForServer?.server?.host ?? "127.0.0.1";
  const configuredPort = viewerConfigForServer?.server?.port ?? 5173;
  const bindHost = process.env.BACKPACK_VIEWER_HOST ?? configuredHost;
  const port = parseInt(process.env.PORT || String(configuredPort), 10);

  // Storage points at the active backpack. Wrapped in a mutable
  // holder so a `/api/backpacks/switch` POST can swap it out in place
  // without restarting the whole server.
  async function makeBackend() {
    const entry = await getActiveBackpack();
    const backend = new JsonFileBackend(undefined, {
      graphsDirOverride: entry.path,
    });
    await backend.initialize();
    return { backend, entry };
  }
  let { backend: storage, entry: activeEntry } = await makeBackend();
  const remoteRegistry = new RemoteRegistry();
  await remoteRegistry.initialize();
  const viewerConfig = loadViewerConfig();

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
  const CSP = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "connect-src 'self'",
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

    // --- API routes ---
    if (url === "/api/config") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(viewerConfig));
      return;
    }

    if (url === "/api/version-check" && req.method === "GET") {
      try {
        const result = await getCachedVersionCheck(currentVersion);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      } catch {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({ current: currentVersion, latest: null, stale: false }),
        );
      }
      return;
    }

    // --- Remote graph routes (read-only) ---
    if (url === "/api/remotes" && req.method === "GET") {
      try {
        const remotes = await remoteRegistry.list();
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
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(summaries));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    const remoteItemMatch = url.match(/^\/api\/remotes\/(.+)$/);
    if (remoteItemMatch && req.method === "GET") {
      const remoteName = decodeURIComponent(remoteItemMatch[1]);
      try {
        const data = await remoteRegistry.loadCached(remoteName);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(data));
      } catch (err) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // --- Branch routes ---
    const branchSwitchMatch = url.match(/^\/api\/graphs\/(.+)\/branches\/switch$/);
    if (branchSwitchMatch && req.method === "POST") {
      const graphName = decodeURIComponent(branchSwitchMatch[1]);
      let body = "";
      req.on("data", (chunk) => { body += chunk.toString(); });
      req.on("end", async () => {
        try {
          const { name: branchName } = JSON.parse(body);
          await storage.switchBranch(graphName, branchName);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } catch (err) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    const deleteBranchMatch = url.match(/^\/api\/graphs\/(.+)\/branches\/(.+)$/);
    if (deleteBranchMatch && req.method === "DELETE") {
      const graphName = decodeURIComponent(deleteBranchMatch[1]);
      const branchName = decodeURIComponent(deleteBranchMatch[2]);
      try {
        await storage.deleteBranch(graphName, branchName);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    const branchMatch = url.match(/^\/api\/graphs\/(.+)\/branches$/);
    if (branchMatch && req.method === "GET") {
      const graphName = decodeURIComponent(branchMatch[1]);
      try {
        const branches = await storage.listBranches(graphName);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(branches));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (branchMatch && req.method === "POST") {
      const graphName = decodeURIComponent(branchMatch[1]);
      let body = "";
      req.on("data", (chunk) => { body += chunk.toString(); });
      req.on("end", async () => {
        try {
          const { name: branchName, from } = JSON.parse(body);
          await storage.createBranch(graphName, branchName, from);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } catch (err) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // --- Snapshot routes ---
    const snapshotMatch = url.match(/^\/api\/graphs\/(.+)\/snapshots$/);
    if (snapshotMatch && req.method === "GET") {
      const graphName = decodeURIComponent(snapshotMatch[1]);
      try {
        const snapshots = await storage.listSnapshots(graphName);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(snapshots));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (snapshotMatch && req.method === "POST") {
      const graphName = decodeURIComponent(snapshotMatch[1]);
      let body = "";
      req.on("data", (chunk) => { body += chunk.toString(); });
      req.on("end", async () => {
        try {
          const { label } = JSON.parse(body);
          await storage.createSnapshot(graphName, label);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } catch (err) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // --- Rollback route ---
    const rollbackMatch = url.match(/^\/api\/graphs\/(.+)\/rollback$/);
    if (rollbackMatch && req.method === "POST") {
      const graphName = decodeURIComponent(rollbackMatch[1]);
      let body = "";
      req.on("data", (chunk) => { body += chunk.toString(); });
      req.on("end", async () => {
        try {
          const { version } = JSON.parse(body);
          await storage.rollback(graphName, version);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } catch (err) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // --- Diff route ---
    const diffMatch = url.match(/^\/api\/graphs\/(.+)\/diff\/(\d+)$/);
    if (diffMatch && req.method === "GET") {
      const graphName = decodeURIComponent(diffMatch[1]);
      const version = parseInt(diffMatch[2], 10);
      try {
        const current = await storage.loadOntology(graphName);
        const snapshot = await storage.loadSnapshot(graphName, version);
        const currentNodeIds = new Set(current.nodes.map(n => n.id));
        const snapshotNodeIds = new Set(snapshot.nodes.map(n => n.id));
        const currentEdgeIds = new Set(current.edges.map(e => e.id));
        const snapshotEdgeIds = new Set(snapshot.edges.map(e => e.id));
        const diff = {
          nodesAdded: current.nodes.filter(n => !snapshotNodeIds.has(n.id)).length,
          nodesRemoved: snapshot.nodes.filter(n => !currentNodeIds.has(n.id)).length,
          edgesAdded: current.edges.filter(e => !snapshotEdgeIds.has(e.id)).length,
          edgesRemoved: snapshot.edges.filter(e => !currentEdgeIds.has(e.id)).length,
        };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(diff));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // --- Snippet routes ---
    const snippetItemMatch = url.match(/^\/api\/graphs\/(.+)\/snippets\/(.+)$/);
    if (snippetItemMatch && req.method === "GET") {
      const graphName = decodeURIComponent(snippetItemMatch[1]);
      const snippetId = decodeURIComponent(snippetItemMatch[2]);
      try {
        const snippet = await storage.loadSnippet(graphName, snippetId);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(snippet));
      } catch {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Snippet not found" }));
      }
      return;
    }

    if (snippetItemMatch && req.method === "DELETE") {
      const graphName = decodeURIComponent(snippetItemMatch[1]);
      const snippetId = decodeURIComponent(snippetItemMatch[2]);
      try {
        await storage.deleteSnippet(graphName, snippetId);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    const snippetMatch = url.match(/^\/api\/graphs\/(.+)\/snippets$/);
    if (snippetMatch && req.method === "GET") {
      const graphName = decodeURIComponent(snippetMatch[1]);
      try {
        const snippets = await storage.listSnippets(graphName);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(snippets));
      } catch {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("[]");
      }
      return;
    }

    if (snippetMatch && req.method === "POST") {
      const graphName = decodeURIComponent(snippetMatch[1]);
      let body = "";
      req.on("data", (chunk) => { body += chunk.toString(); });
      req.on("end", async () => {
        try {
          const { label, description, nodeIds, edgeIds } = JSON.parse(body);
          const id = await storage.saveSnippet(graphName, { label, description, nodeIds, edgeIds: edgeIds ?? [] });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, id }));
        } catch (err) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // --- Backpacks (meta: list, active, switch) ---
    if (url === "/api/backpacks" && req.method === "GET") {
      try {
        const list = await listBackpacks();
        const active = await getActiveBackpack();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify(
            list.map((b) => ({ ...b, active: b.name === active.name })),
          ),
        );
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (url === "/api/backpacks/active" && req.method === "GET") {
      try {
        const active = await getActiveBackpack();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(active));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (url === "/api/backpacks/switch" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => { body += chunk.toString(); });
      req.on("end", async () => {
        try {
          const { name } = JSON.parse(body);
          await setActiveBackpack(name);
          const swapped = await makeBackend();
          storage = swapped.backend;
          activeEntry = swapped.entry;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, active: activeEntry }));
        } catch (err) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    if (url === "/api/backpacks" && req.method === "POST") {
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
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, entry }));
        } catch (err) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    const backpackDeleteMatch = url.match(/^\/api\/backpacks\/(.+)$/);
    if (backpackDeleteMatch && req.method === "DELETE") {
      const name = decodeURIComponent(backpackDeleteMatch[1]);
      try {
        await unregisterBackpack(name);
        // If we just removed the active one, the registry switched us;
        // rebuild the backend to match.
        if (activeEntry && activeEntry.name === name) {
          const swapped = await makeBackend();
          storage = swapped.backend;
          activeEntry = swapped.entry;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // --- Lock heartbeat ---
    if (url === "/api/locks" && req.method === "GET") {
      // Batch endpoint: returns { graphName: lockInfo|null } for all graphs.
      // One request instead of N on every sidebar refresh.
      try {
        const summaries = await storage.listOntologies();
        const result = {};
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
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      } catch {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("{}");
      }
      return;
    }

    const lockMatch = url.match(/^\/api\/graphs\/(.+)\/lock$/);
    if (lockMatch && req.method === "GET") {
      const graphName = decodeURIComponent(lockMatch[1]);
      try {
        const lock =
          typeof storage.readLock === "function"
            ? await storage.readLock(graphName)
            : null;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(lock));
      } catch {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("null");
      }
      return;
    }

    if (url === "/api/ontologies") {
      try {
        const summaries = await storage.listOntologies();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(summaries));
      } catch {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("[]");
      }
      return;
    }

    if (url.startsWith("/api/ontologies/")) {
      const name = decodeURIComponent(url.replace("/api/ontologies/", ""));
      try {
        const data = await storage.loadOntology(name);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(data));
      } catch {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Ontology not found" }));
      }
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
        console.warn(`  ⚠ Backpack Viewer ${currentVersion} is out of date — latest is ${latest}`);
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
    server: { port, open: true },
  });

  await server.listen();
  server.printUrls();
}
