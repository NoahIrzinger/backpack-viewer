#!/usr/bin/env node

import { createServer } from "vite";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const port = parseInt(process.env.PORT || "5173", 10);

const server = await createServer({
  root,
  configFile: path.resolve(root, "vite.config.ts"),
  server: { port, open: true },
});

await server.listen();
server.printUrls();
