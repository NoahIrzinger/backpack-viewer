import { defineConfig, type Plugin } from "vite";
import fs from "node:fs";
import path from "node:path";
import { JsonFileBackend, dataDir } from "backpack-ontology";
import { loadViewerConfig } from "./src/config.js";

function ontologyApiPlugin(): Plugin {
  let storage: JsonFileBackend;

  return {
    name: "ontology-api",

    configureServer(server) {
      storage = new JsonFileBackend();
      storage.initialize();

      // Watch the ontologies directory for live updates from Claude/MCP
      const ontologiesDir = path.join(dataDir(), "ontologies");
      try {
        fs.watch(ontologiesDir, { recursive: true }, () => {
          server.ws.send({
            type: "custom",
            event: "ontology-change",
            data: {},
          });
        });
      } catch {
        // Directory may not exist yet
      }

      server.middlewares.use((req, res, next) => {
        // Config endpoint
        if (req.url === "/api/config" && req.method === "GET") {
          const config = loadViewerConfig();
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(config));
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

export default defineConfig({
  plugins: [ontologyApiPlugin()],
  build: {
    outDir: "dist/app",
  },
});
