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
    ├── sidebar.ts          # Ontology list with text filter and click-to-load
    ├── canvas.ts           # Canvas 2D rendering, camera transform, pan/zoom/pinch, hit testing
    ├── info-panel.ts       # Node detail panel (properties, connections, timestamps)
    ├── layout.ts           # Force-directed graph layout (repulsion, spring, gravity, cooling)
    ├── colors.ts           # Deterministic type → color hash mapping
    └── style.css           # Dark theme with earth-tone accents
```

## Architecture

### Vite Plugin (`vite.config.ts`)

The custom Vite plugin serves two purposes:

1. **API middleware** — Exposes two HTTP endpoints backed by `JsonFileBackend`:
   - `GET /api/ontologies` → `storage.listOntologies()`
   - `GET /api/ontologies/:name` → `storage.loadOntology(name)`

2. **File watcher** — Monitors the ontologies directory for changes and pushes events to the browser via Vite's WebSocket, triggering automatic re-renders.

### Rendering Pipeline

1. `loadOntology()` fetches the full `OntologyData` from the API
2. `createLayout()` initializes a force-directed simulation with nodes in a circle
3. `tick()` runs per animation frame — applies repulsion, attraction, and gravity forces
4. `render()` draws edges, arrowheads, nodes, labels, and type badges to Canvas 2D
5. The simulation cools down via alpha decay and stops when settled

### Data Handling

Ontology schemas are freeform — LLMs generate arbitrary node types and property shapes. The viewer handles this defensively:

- Labels are the first string value in `node.properties`, falling back to `node.id`
- Colors are a deterministic hash of `node.type` into a 16-color palette
- Properties are iterated dynamically, never assumed to have specific keys
- Self-loops, multiple edges between the same pair, and empty properties are all handled

## API Endpoints

| Endpoint | Returns |
|----------|---------|
| `GET /api/ontologies` | `OntologySummary[]` — name, description, nodeCount, edgeCount |
| `GET /api/ontologies/:name` | `OntologyData` — full graph with all nodes and edges |

## Releasing

```bash
# Bump version, create tag, push
npm run release:patch       # 0.1.0 → 0.1.1
npm run release:minor       # 0.1.0 → 0.2.0
npm run release:major       # 0.1.0 → 1.0.0
```

The `v*` tag triggers the GitHub Actions publish workflow, which validates the tag against `package.json`, runs the test matrix (Node 18/20/22), and publishes to npm.

## Dependencies

- **Runtime**: `backpack-ontology` (JsonFileBackend + types), `vite` (dev server + bundler)
- **Dev**: `typescript`, `@types/node`

No frameworks. No UI libraries. Pure TypeScript + Canvas 2D.
