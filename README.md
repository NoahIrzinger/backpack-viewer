# Backpack Ontology Viewer

A web-based graph visualizer for [backpack-ontology](../backpack-ontology). Renders ontology graphs on a Canvas 2D surface with force-directed layout, pan/zoom navigation, node inspection, and live reload when data changes.

## Quick Start

```bash
# Build the ontology engine first (required — viewer depends on it)
cd ../backpack-ontology && npm run build

# Install and start the viewer
cd ../backpack-viewer
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173). The sidebar lists all ontologies stored by backpack-ontology. Click one to visualize it.

## How It Works

### Architecture

```
Claude (MCP tools) ──writes──> StorageBackend ──persists──> ontology data
                                     │
Viewer (Vite plugin) ──reads via─────┘
         │
    HTTP API ──> Browser ──> Canvas 2D
```

The viewer connects to backpack-ontology through the `StorageBackend` interface — the same abstraction the engine uses for persistence. It calls two methods:

- `listOntologies()` — returns names, descriptions, and counts
- `loadOntology(name)` — returns the full graph (nodes + edges)

This means the viewer works with **any** storage backend (JSON files, SQLite, remote API) without code changes.

### Live Reload

The Vite dev server watches the ontologies directory for file changes. When Claude adds or modifies nodes via MCP tools, the viewer automatically re-fetches and re-renders the active graph.

### Rendering

- **Layout**: Custom force-directed algorithm (repulsion + spring attraction + centering gravity). Nodes start in a circle and settle over ~200 frames.
- **Nodes**: Colored circles. Colors are deterministic by node type (hash → palette). Label below, type badge above.
- **Edges**: Straight lines with arrowheads. Edge type label at midpoint. Self-loops rendered as small circles.
- **Navigation**: Mouse drag to pan. Scroll wheel to zoom. Trackpad pinch to zoom. Touch drag/pinch on mobile.
- **Node inspection**: Click any node to open a detail panel showing all properties, connections, and timestamps. Selected nodes glow and highlight their connected edges. Non-connected nodes dim to focus attention.

### Data Handling

Ontology schemas are freeform — LLMs generate arbitrary node types and property shapes. The viewer handles this defensively:

- **Labels**: First string value in `node.properties`, fallback to `node.id`
- **Colors**: Deterministic hash of `node.type` into a 16-color palette — no hardcoded type lists
- **Properties**: Iterated dynamically, never assumed to have specific keys
- **Edge cases**: Self-loops, multiple edges between same pair, nodes with no string properties, empty edge properties

## API Endpoints

The Vite dev server exposes two endpoints (served by the ontology-api plugin):

| Endpoint | Returns |
|----------|---------|
| `GET /api/ontologies` | `OntologySummary[]` — name, description, nodeCount, edgeCount |
| `GET /api/ontologies/:name` | `OntologyData` — full graph with all nodes and edges |

## Project Structure

```
backpack-viewer/
├── vite.config.ts       # Vite plugin: StorageBackend → HTTP API + file watcher
├── index.html           # Single page shell
└── src/
    ├── main.ts          # Entry point, wires sidebar + canvas + live reload
    ├── api.ts           # fetch() wrappers returning backpack-ontology types
    ├── sidebar.ts       # Ontology list with text filter
    ├── canvas.ts        # Canvas 2D rendering + pan/zoom/pinch + node selection
    ├── info-panel.ts    # Node detail panel (properties, connections, timestamps)
    ├── layout.ts        # Force-directed graph layout algorithm
    ├── colors.ts        # Deterministic type → color mapping
    └── style.css        # Dark theme
```

## Dependencies

- **Runtime**: `backpack-ontology` (local sibling — `StorageBackend` interface + types)
- **Dev**: `vite`, `typescript`

No frameworks. No UI libraries. Pure TypeScript + Canvas 2D.

## License

Apache-2.0
