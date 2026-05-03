# Development Guide

## Prerequisites

- Node.js >= 18
- npm
- [backpack-ontology](https://www.npmjs.com/package/backpack-ontology) installed or linked locally

## Setup

```bash
git clone https://github.com/noahirzinger/backpack-viewer.git
cd backpack-viewer
npm install
```

### Local Development with backpack-ontology

To develop against a local copy of the ontology engine:

```bash
cd /path/to/backpack-ontology && npm link
cd /path/to/backpack-viewer && npm link backpack-ontology
```

Changes to the ontology source will be reflected after running `npm run build` in the ontology directory.

### Local Development with backpack-connector

The Knowledge Graph feature uses backpack-connector as an optional runtime dependency. In production the viewer loads it via dynamic `import("backpack-connector")` and degrades gracefully (503) when it is not installed. In dev, install it as a local file dep so the import resolves:

```bash
cd /path/to/backpack-viewer
npm install /path/to/backpack-connector
```

Then start ArcadeDB and project at least one graph before starting the viewer:

```bash
cd ~/arcadedb-26.4.2
JAVA_OPTS="-Darcadedb.server.rootPassword=arcadedb" ./bin/server.sh &

backpack-connector project --graph my-graph
npm run dev
```

The Knowledge Graph section in the sidebar will be active. To restore production behavior (no connector), remove it:

```bash
npm uninstall backpack-connector
```

## Commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Start Vite dev server at localhost:5173 |
| `npm run serve` | Start via the bin script (same as `npx backpack-viewer`) |
| `npm run build` | Production build |
| `npm run preview` | Preview production build |

## Project Structure

```
backpack-viewer/
├── vite.config.ts          # Vite plugin: JSON file backend → HTTP API + file watcher
├── index.html              # Single page shell
├── bin/
│   └── serve.js            # CLI entry point (npx backpack-viewer)
└── src/
    ├── main.ts             # Entry point — wires sidebar, canvas, info panel, live reload
    ├── api.ts              # fetch() wrappers returning backpack-ontology types
    ├── sidebar.ts          # Graph list, KG section, KB tab, Signals tab
    ├── canvas.ts           # Canvas 2D rendering, camera transform, pan/zoom/pinch, hit testing
    ├── info-panel.ts       # Node detail panel (properties, connections, timestamps)
    ├── layout.ts           # Force-directed graph layout (repulsion, spring, gravity, cooling)
    ├── colors.ts           # Deterministic type → color hash mapping
    ├── signals-panel.ts    # Signals tab: configurable widget canvas
    ├── server-api-routes.ts# All HTTP API route handlers shared by dev + prod servers
    └── style.css           # Light/dark theme via CSS custom properties
```

## Architecture

### Vite Plugin (`vite.config.ts`)

The custom Vite plugin serves two purposes:

1. **API middleware** — mounts all routes from `src/server-api-routes.ts` so the dev server and production `bin/serve.js` share identical behavior.
2. **File watcher** — monitors the backpack data directory for changes and pushes events to the browser via Vite's WebSocket, triggering automatic graph re-renders.

### Rendering Pipeline

1. `loadGraph()` fetches the full `LearningGraphData` from the API
2. `createLayout()` initializes a force-directed simulation with nodes in a circle
3. `tick()` runs per animation frame — applies repulsion, attraction, and gravity forces
4. `render()` draws edges, arrowheads, nodes, labels, and type badges to Canvas 2D
5. The simulation cools down via alpha decay and stops when settled

### Data Handling

Graph schemas are freeform — LLMs generate arbitrary node types and property shapes. The viewer handles this defensively:

- Labels are the first string value in `node.properties`, falling back to `node.id`
- Colors are a deterministic hash of `node.type` into a 16-color palette
- Properties are iterated dynamically, never assumed to have specific keys
- Self-loops, multiple edges between the same pair, and empty properties are all handled

## API Endpoints

| Endpoint | Method | Returns |
|----------|--------|---------|
| `/api/graphs` | GET | `LearningGraphSummary[]` — name, nodeCount, edgeCount, tags |
| `/api/graphs/:name` | GET | `LearningGraphData` — full graph with nodes and edges |
| `/api/graphs/:name` | PUT | Save graph |
| `/api/graphs/:name` | DELETE | Delete graph |
| `/api/graphs/:name/rename` | POST | Rename graph |
| `/api/graphs/:name/tags` | GET/PUT | Read/write tags |
| `/api/graphs/:name/branches` | GET/POST | List or create branches |
| `/api/graphs/:name/branches/switch` | POST | Switch active branch |
| `/api/graphs/:name/branches/:branch` | DELETE | Delete branch |
| `/api/graphs/:name/snapshots` | GET/POST | List or create snapshots |
| `/api/graphs/:name/rollback` | POST | Roll back to a snapshot |
| `/api/graphs/:name/snippets` | GET/POST | List or save snippets |
| `/api/graphs/:name/snippets/:id` | GET/DELETE | Load or delete a snippet |
| `/api/connector/knowledge-graph` | GET | Live graph from ArcadeDB (`?backpack=<name>` to scope) |
| `/api/connector/knowledge-graph/status` | GET | ArcadeDB status + per-backpack breakdown |
| `/api/signals` | GET | Signal list |
| `/api/signals/detect` | POST | Run signal detectors |
| `/api/signals/view` | GET/PUT | Signals panel widget layout |
| `/api/signals/config` | GET/PUT | Signal detector enable state |
| `/api/kb/documents` | GET | List KB documents |
| `/api/kb/documents/:id` | GET/PUT/DELETE | Read, update, or delete a document |
| `/api/kb/search` | GET | Full-text search across documents |
| `/api/kb/mounts` | GET/POST | List or manage KB mounts |

## Releasing

```bash
# Bump version, create tag, push
npm run release:patch       # 0.1.0 → 0.1.1
npm run release:minor       # 0.1.0 → 0.2.0
npm run release:major       # 0.1.0 → 1.0.0
```

The `v*` tag triggers the GitHub Actions publish workflow, which validates the tag against `package.json`, runs the test matrix (Node 18/20/22), and publishes to npm.

## Dependencies

- **Runtime**: `backpack-ontology` (JsonFileBackend + types), `age-encryption` (graph encryption), `echarts` (Signals panel charts)
- **Optional runtime**: `backpack-connector` (Knowledge Graph / ArcadeDB integration — not in package.json; loaded via dynamic import at runtime)
- **Dev**: `typescript`, `@types/node`, `vite`

No frameworks. No UI libraries. Pure TypeScript + Canvas 2D.
