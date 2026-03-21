# Backpack Viewer

A web-based graph visualizer for [backpack-ontology](https://www.npmjs.com/package/backpack-ontology). Renders ontology graphs on a Canvas 2D surface with force-directed layout, interactive navigation, and live reload.

## Installation

```bash
npm install -g backpack-viewer
```

## Usage

```bash
backpack-viewer
```

Opens a browser at `http://localhost:5173` with the viewer interface. The sidebar lists all ontologies stored by backpack-ontology. Click any ontology to visualize its graph.

### Navigation

- **Pan**: Click and drag the canvas
- **Zoom**: Scroll wheel or trackpad pinch
- **Inspect**: Click any node to view its properties, connections, and metadata
- **Filter**: Type in the sidebar search to filter ontologies by name

### Live Reload

When running alongside Claude Code with backpack-ontology, the viewer automatically detects changes to ontology data and re-renders the active graph. Add a node via MCP and watch it appear in real time.

### Environment

The viewer reads ontology data from the same location as backpack-ontology:

| Variable | Effect |
|----------|--------|
| `PORT` | Override the default port (default: `5173`) |
| `XDG_DATA_HOME` | Override data location (default: `~/.local/share`) |
| `BACKPACK_DIR` | Override data directory |

## Architecture

The viewer connects to backpack-ontology through the `StorageBackend` interface — the same abstraction the engine uses for persistence. This means the viewer works with any storage backend (JSON files, SQLite, remote API) without modification.

```
backpack-ontology (MCP) ──writes──> StorageBackend
                                         │
backpack-viewer ──reads──────────────────┘
```

## Support

For questions, feedback, or sponsorship inquiries: **support@backpackontology.com**

## Privacy

See the [Backpack Ontology Privacy Policy](https://github.com/noahirzinger/backpack-ontology/blob/main/PRIVACY.md). The viewer itself collects no data.

## License

Licensed under the [Apache License, Version 2.0](./LICENSE).
