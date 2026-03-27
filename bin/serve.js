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
