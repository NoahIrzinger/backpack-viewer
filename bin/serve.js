#!/usr/bin/env node

import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import http from "node:http";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const distDir = path.resolve(root, "dist/app");
const port = parseInt(process.env.PORT || "5173", 10);

const hasDistBuild = fs.existsSync(path.join(distDir, "index.html"));

if (hasDistBuild) {
  // --- Production: static file server + API (zero native deps) ---
  const { JsonFileBackend, dataDir } = await import("backpack-ontology");
  const { loadViewerConfig } = await import("../dist/config.js");

  const storage = new JsonFileBackend();
  await storage.initialize();
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

  const server = http.createServer(async (req, res) => {
    const url = req.url?.replace(/\?.*$/, "") || "/";

    // --- API routes ---
    if (url === "/api/config") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(viewerConfig));
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

  server.listen(port, () => {
    console.log(`  Backpack Viewer running at http://localhost:${port}/`);
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
