# Changelog

## 0.2.21 (2026-03-30)

### Curiosity Engine
- **Path finding** — select two nodes, shortest path highlighted with path bar at bottom
- **Walk mode** — traverse the graph node-by-node, pulsing trail, accent edges, walk trail panel
- **Walk isolate** — press `i` to re-render only trail nodes as a fresh subgraph
- **Walk trail panel** — numbered list with edge types between nodes, remove button per node, save as snippet
- **Node context menu** — right-click for star, focus, explore in branch, copy ID
- **Node starring** — gold star indicator, persisted in properties
- **Graph snippets** — save walk trails as named snippets, sidebar list with load/delete

### UI Fixes
- Focus mode centers camera properly (fitToNodes with scale)
- Sidebar expand button in top bar when collapsed
- Inline dialog system (replaced all native browser popups)
- Walk mode button with strobe animation in focus bar
- Theme-aware walk edge colors (black in light, tan in dark)
- Unicode symbols replacing emoji in context menu and snippets
- Version display in sidebar footer
- Drag threshold increased to 5px

### Branches & Snapshots UI
- Branch picker in sidebar — click branch label to switch, create, or delete branches
- Snapshot management in Controls tab — save snapshots, view history, restore previous versions
- 8 new server API endpoints for branches and snapshots (bin/serve.js + vite dev server)

### Inline Dialog System
- Replaced all native `alert`/`confirm`/`prompt` calls with styled inline dialogs
- Toast notifications for non-blocking feedback

## 0.2.18 (2026-03-27)

### Configurable Keybindings
- User config file at `~/.config/backpack/viewer.json` (XDG-compatible)
- All 30+ keyboard shortcuts are remappable via JSON config
- Dynamic help modal shows actual configured keys
- Config also supports `display`, `layout`, `navigation`, `lod`, and `limits` sections

### Tools Pane Redesign
- Tabbed interface: **Types**, **Insights**, **Controls**
- Focused types pinned to top of Types tab with clear button
- "Most Connected" moved to Insights tab alongside orphans, singletons, empty nodes
- Search fields in Types and Insights tabs for filtering long lists
- Scrolling inside tab content — header, tabs, and search stay pinned

### Level of Detail & Performance
- LOD rendering: labels, badges, edge labels, arrows hidden at progressive zoom thresholds
- Nodes shrink to half size when deeply zoomed out
- Viewport culling: off-screen nodes and edges skip rendering entirely
- Auto-scale layout parameters based on graph size (30+ nodes)
- Wider layout slider ranges: clustering 0–1, spacing 0.5–20

### Keyboard Shortcuts
- Vim-style panning: `h`/`j`/`k`/`l`, `H`/`L` fast pan, `J`/`K` zoom
- `,`/`.` cycle through nodes in view, `<`/`>` cycle connections
- `(`/`)` node history back/forward
- `-`/`=` adjust hops in focus mode
- `c` center view, `e` toggle edges, `f` focus/unfocus
- `Tab` toggle sidebar, `?` toggle help
- Configurable pan speed in Controls tab

### Info Panel
- Pinned header (toolbar + node name) — properties and connections scroll below
- Focus button disabled at 0 hops to prevent camera jump
- Connection cycling with accent highlight (`<`/`>` keys)
- Node history navigation (`(`/`)` keys)

### Search
- Arrow key navigation through search results with highlight
- Enter selects result and blurs search bar

### Sidebar
- Collapsible sidebar with toggle button and `Tab` keybinding

### Other
- Auto-scale layout defaults when loading a graph
- Tools pane width synced with top-left control bar
- Focus mode starts at 0 hops (see seed nodes first, then expand)

## 0.2.16 (2026-03-26)

- Initial public release with Canvas 2D renderer, force-directed layout, live reload
