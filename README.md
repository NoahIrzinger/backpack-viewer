# Backpack Viewer

**See your knowledge graph.** A web-based visualizer for [Backpack](https://www.npmjs.com/package/backpack-ontology) ontologies with force-directed layout, interactive navigation, and live reload.

## Quick start

Tell Claude:

> "Show me my knowledge graph"

Or run it directly:

```bash
npx backpack-viewer
```

Opens http://localhost:5173. Click any ontology in the sidebar to visualize it.

## Features

- **Live reload**: add knowledge via Claude and watch it appear in real time
- **Pan and zoom**: click-drag to pan, scroll to zoom
- **Inspect**: click any item to see its properties, connections, and metadata
- **Edit**: rename ontologies, edit node types and properties, add or remove items inline
- **Search**: filter ontologies by name in the sidebar

## How it works

The viewer reads ontology data from the same local files that the MCP server writes to. Changes appear automatically, no refresh needed.

```
backpack-ontology (MCP) ──writes──> ~/.local/share/backpack/ontologies/
                                         │
backpack-viewer ──reads──────────────────┘
```

## Reference

| Variable | Effect |
|---|---|
| `PORT` | Override the default port (default: `5173`) |
| `XDG_DATA_HOME` | Override data location (default: `~/.local/share`) |
| `BACKPACK_DIR` | Override data directory |

## Support

Questions, feedback, or partnership inquiries: **support@backpackontology.com**

## Privacy

See the [Privacy Policy](https://github.com/noahirzinger/backpack-ontology/blob/main/PRIVACY.md). The viewer itself collects no data.

## License

Licensed under the [Apache License, Version 2.0](./LICENSE).
