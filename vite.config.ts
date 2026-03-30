import { defineConfig, type Plugin } from "vite";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { JsonFileBackend, dataDir } from "backpack-ontology";
import { loadViewerConfig } from "./src/config.js";

const require = createRequire(import.meta.url);
const pkg = require("./package.json");

function ontologyApiPlugin(): Plugin {
  let storage: JsonFileBackend;

  return {
    name: "ontology-api",

    configureServer(server) {
      storage = new JsonFileBackend();
      storage.initialize();

      // Watch the ontologies directory for live updates from Claude/MCP
      const ontologiesDir = path.join(dataDir(), "graphs");
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
  define: {
    __VIEWER_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    outDir: "dist/app",
  },
});
