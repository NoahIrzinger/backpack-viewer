import { defineConfig, type Plugin } from "vite";
import fs from "node:fs";
import path from "node:path";
import { JsonFileBackend, dataDir } from "backpack-ontology";
import type { StorageBackend } from "backpack-ontology";

function ontologyApiPlugin(): Plugin {
  let storage: StorageBackend;

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
        if (!req.url?.startsWith("/api/ontologies")) return next();

        const urlPath = req.url.replace(/\?.*$/, "");

        // GET /api/ontologies
        if (urlPath === "/api/ontologies") {
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

        // GET /api/ontologies/:name
        const name = decodeURIComponent(
          urlPath.replace("/api/ontologies/", "")
        );
        if (!name) return next();

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
});
