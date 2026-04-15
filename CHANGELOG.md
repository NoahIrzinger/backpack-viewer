# Changelog

## 0.7.27

### Cloud sync overhaul
- **Bidirectional backpack sync** — push all graphs + KB to cloud, pull from cloud into isolated cache.
- **Cloud cache backpack** — switch to a "Cloud" backpack in the sidebar that reads from the relay via `CloudCacheBackend`. Auto-refreshes from relay on switch.
- **Per-item "Sync unencrypted"** — every graph, KB doc, and KB mount three-dot menu now has a red "Sync unencrypted" option alongside the default encrypted sync.
- **Sync results popup** — per-item checkmarks/X marks showing sync status for each graph and KB doc.
- **Encryption preservation** — push no longer re-encrypts previously unencrypted cloud graphs.

### Extensions
- **KB extension system** — `registerKBMount()` API for extensions to provide KB mount data.
- **kb-local extension** — registers filesystem mounts as KB providers.
- **Share extension stripped** — removed all sync controls; sharing implicitly syncs the open graph.

### UI
- **Three-dot context menus** — backpack picker, graph items, KB docs, and KB mounts all use consistent three-dot menus.
- **KB pill picker** — replaced native `<select>` with pill-style dropdown matching the backpack picker.
- **Cloud picker fix** — switching to cloud now correctly shows "Cloud" in the picker (was being overwritten by HMR event).
- **Favicon** — added SVG graph icon as browser tab favicon.
- **Markdown tables** — pipe-delimited table rendering with column alignment.
- **Strikethrough, task lists, images** — additional markdown rendering support.

### Security
- **XSS prevention** — reject `javascript:`/`vbscript:`/`data:` URIs in markdown links, restrict image `data:` URIs to safe MIME types.

### Knowledge Base integration
- **Tabbed sidebar** — Graphs and Knowledge Base are peer tabs in the sidebar, reflecting the two components of a backpack.
- **KB documents list** — browse documents in the Knowledge Base tab with client-side search filtering.
- **Document detail panel** — click a document to open a floating panel showing title, metadata, tags, source graphs, and markdown content.
- **KB search in search overlay** — Ctrl+K / `/` search now includes KB documents alongside graph nodes, with a "KB" badge.
- **Mount management UI** — add, remove, and edit KB mount paths from the sidebar. Inline path editing, writable toggle, error toasts on failure.
- **Add mount dialog** — multi-field dialog for connecting local folders (Obsidian vaults, shared drives).
- **KB API routes** — `/api/kb/documents` (list, get, delete), `/api/kb/search`, `/api/kb/mounts` (list, add/remove/edit).
- **Live reload** — KB documents refresh alongside graphs on file changes.

### Fixes
- **OAuth token exchange** — prefer `id_token` over `access_token` for bearer auth, handle direct token exchange flow.
- **OAuth callback fallback** — prevent Vite SPA fallback from intercepting `/oauth/` routes.

## 0.7.8 (2026-04-12)

### Sync & Share rewrite
- **Encrypted by default** — no encryption toggle on the happy path. First sync always encrypts with age-v1.
- **Account status check** — fetches existing graphs to detect already-synced state.
- **Two-step flow** — uses `PUT /api/graphs/{name}/sync` + `POST /api/graphs/{name}/share` (replaces single `POST /v1/share`).
- **Already synced state** — shows last sync time, encrypted badge, "Update & Share" button.
- **Quota exceeded fallback** — upgrade prompt + "Share as public graph" with explicit confirmation checkbox.
- **BPAK envelope stats** — includes `node_count`, `edge_count`, `node_types` in envelope header for dashboard display.
- **Fragment key warning** — explains recipients need the complete link including `#k=` part.
- **Configurable relay URL** — set `relay_url` in extension settings to target a custom relay.
- **OAuth hardening** — try/catch on token exchange, access_token validation, clipboard error handling.

## 0.7.1 (2026-04-12)

### Share extension (first-party)
- **Share button** in the viewer toolbar — encrypt and share any graph with a link.
- **OAuth popup flow** — sign in to Backpack App via the viewer to upload encrypted graphs. Token cached in localStorage for future shares.
- **API token fallback** — paste an API token from Backpack App settings for manual auth.
- **Encrypt toggle** (default: on) + optional passphrase protection.
- **Link display** with one-click copy after sharing.
- **Upsell CTA** — "Create a free Backpack account to share encrypted graphs" when not authenticated.
- `/oauth/callback` route for the popup redirect.

## 0.7.0 (2026-04-12)

### Encrypted share links
- **In-browser decrypt** — when the viewer opens a `?share=TOKEN` URL, it fetches the BPAK envelope from the relay, parses the binary header, and decrypts the payload client-side using the `#k=` fragment key. The decryption key never leaves the browser.
- **age-encryption** dynamically imported and code-split (~128KB) — only loaded when an encrypted share link is opened. Zero overhead for normal usage.
- Inline BPAK envelope parsing avoids pulling Node.js dependencies into the browser bundle.

### Extension system
- **Panel mount API** for extensions to render custom UI panels alongside the graph.
- **Event bus** for viewer↔extension communication (graph-changed, selection, focus events).
- **Extension loader** with manifest-based discovery and lazy loading.
- **Chat extension** (bundled) — AI chat panel with Anthropic provider integration.
- **Build script** for compiling extensions into distributable bundles.

### Viewer improvements
- **Copy prompt button** — copy graph context as a formatted prompt.
- **Viewer state bridge** — exposes current selection/focus to MCP resources.
- **Server-side extension loading** and viewer state API routes.
- Various sidebar, search, info panel, empty state, and tools pane improvements.

## 0.6.0 (2026-04-10)

### Drag-to-pin nodes (temporary layout tweaks)
- **Drag any node with the cursor** to move it out of the way or into
  a specific position. The node stays pinned where you drop it — the
  force simulation reflows neighbors around the new position instead
  of dragging it back.
- **Multi-selection with Shift-click** or Shift-drag rubber-band on
  empty canvas. Selection is visible as an accent-colored outline.
- **Multi-drag**: dragging any selected node moves the entire selected
  group as a rigid body, preserving relative offsets. All dragged
  nodes become pinned on drop.
- **Pin indicator**: pinned nodes show a subtle dashed outer ring so
  you can tell which positions are being manually held.
- **Reset with `r`**: releases every pinned node and lets the force
  simulation reclaim the layout. Binds to keyboard shortcut `r` by
  default, customizable in `~/.config/backpack/viewer.json`.
- **Release triggers — pins are strictly temporary.** Pins release
  automatically on any of these events, restoring the pure force
  layout:
  - Data changes (node/edge add/remove/update via live reload)
  - Graph switch or backpack switch
  - Focus mode enter/exit
  - Walk mode enter/exit
  - Explicit `r` shortcut press
- **Toast on auto-release**: when incoming live-reload data resets
  the user's manual layout, a brief toast appears explaining why
  ("Manual layout reset — new data arrived"). Pressing `r` shows a
  different toast ("Manual layout reset — pins released").
- **Walk mode guard**: drag is disabled while walk mode is active —
  clicking a node in walk mode advances the path as before, and drag
  gestures are ignored so they don't fight the animation.
- **ESC now clears selection first** before falling through to focus
  exit / help close behaviors.

### Canvas API additions
- `releaseAllPins(): boolean` — clears every pinned node and returns
  true if any were released (so callers can decide whether to show a
  toast).
- `hasPinnedNodes(): boolean` — cheap pre-check.
- `clearSelection()` and `getSelectedNodeIds()` — explicit selection
  control exposed to main.ts.

### Layout API additions
- `LayoutNode.pinned?: boolean` — new optional field. When true, the
  force simulation's integration step skips position updates for the
  node. Pinned nodes still contribute forces to non-pinned neighbors.
- New worker protocol messages: `pin` (apply pin with position
  updates), `unpin` (release pins by ID list or `"all"`), `resume`
  (restart a stopped loop with optional alpha).
- `simulate()` now resets `animFrame = 0` on early-return, so
  `if (!animFrame) simulate()` idioms work correctly after the
  simulation settles. **This is a latent bug fix** — the old code
  left `animFrame` dangling, which silently broke any later attempt
  to restart the simulation on the main thread.

### Shortcuts updated
- New keybinding: `resetPins` → `r` (default).
- `escape` extended: first clears selection if any, then falls
  through to focus exit, then help modal close.
- Help modal's mouse hint table updated: `Drag node` / `Drag selection`
  / `Shift+drag empty` for rubber-band, `Drag empty` for pan.

### Testing
- Interactively verified end-to-end with chrome-devtools:
  single-node drag-to-pin, reset via `r` with toast confirmation,
  shift-click multi-selection, multi-drag of 3-node group,
  shift+drag rubber-band selection of 3 Person nodes, plain pan
  regression check.

## 0.5.1 (2026-04-10)

### Stale-version detection (unsticks users from the npx cache trap)
- **Viewer now checks `https://registry.npmjs.org/backpack-viewer/latest`
  on startup** and compares the result to its own version. If out of
  date, prints a loud terminal warning:
  ```
  ⚠ Backpack Viewer 0.5.0 is out of date — latest is 0.5.2
  To update:
    npm cache clean --force
    npx backpack-viewer@latest
  ```
- **Sidebar banner** in the viewer UI (above the backpack picker) when
  stale: shows the current vs latest version and the exact commands
  to run. Users stuck on old versions because their npx cache reused
  an old install now see the stale state in-app instead of silently
  running outdated code.
- New server endpoint `GET /api/version-check` returns
  `{ current, latest, stale }`. Backed by a 1-hour in-memory cache so
  we don't hammer the npm registry.
- Offline-friendly: if the registry is unreachable (network error,
  timeout, non-200), the check silently skips and no warning shows.
  Users offline don't get spurious "out of date" messages.
- Version number now printed in the startup log line
  (`Backpack Viewer vX.Y.Z running at http://...`).

## 0.5.0 (2026-04-10)

Pairs with `backpack-ontology@0.5.0` — the backpacks config format
simplified to a list of paths. This release updates the viewer UI to
match the simpler model, plus ships a security fix that landed at the
same time.

### Security (localhost-only binding)
- **Viewer now binds to `127.0.0.1` (loopback) by default** instead of
  `0.0.0.0`. The previous default exposed the viewer's read/write API
  to any machine on the local network, which was unsafe for corporate
  users. The new default is localhost-only; a startup warning prints
  if a different host is explicitly configured.
- New `server.host` and `server.port` fields in
  `~/.config/backpack/viewer.json` let users override the bind host
  and port. Environment variables `BACKPACK_VIEWER_HOST` and `PORT`
  take precedence over the config file. Both the dev server
  (`npm run dev`) and production server (`npx backpack-viewer`) honor
  the same settings.

### Simpler "Add Backpack" dialog
- **Single path field** — no more name field. The display name is
  derived from the path tail by the backend. Matches the new
  `backpack_register <path>` signature in ontology 0.5.0.
- **Native folder picker** where available. On Chromium browsers the
  Browse button opens the native `showDirectoryPicker` dialog. Since
  the picker returns a handle rather than a filesystem path, it's
  only a UX hint — the user still pastes the absolute path below.
- **Drag-and-drop** a folder from Finder/Explorer onto the path input
  shows a hint with the folder name. The OS path is still sandboxed
  out of the drop event (browser security), so the user manually
  pastes the absolute path.
- **No hardcoded suggestion chips.** Users can paste any path:
  local, OneDrive, Dropbox, iCloud, Google Drive, network mount, SMB
  share, SSHFS mount — anything the filesystem presents as a path.
- **Activate checkbox** lets the user decide whether to switch to the
  new backpack immediately (default yes).
- `/api/suggested-paths` endpoint removed — it was only feeding the
  hardcoded chips. The registry accepts any path via
  `POST /api/backpacks`.

### UI polish
- **Backpack picker pill** now uses `border-radius: 6px` to match the
  rest of the sidebar UI (inputs, buttons). Was `border-radius: 999px`
  which looked out of place.

### Dependencies
- Bumped `backpack-ontology` to `^0.5.0` for the new registry format
  and simpler tool signatures.

## 0.4.0 (2026-04-10)

This release adds UI for the new multi-backpack feature introduced in
`backpack-ontology@0.4.0`. Users who stay on one backpack see only a
subtle indicator in the sidebar; users with multiple backpacks get a
discrete picker to switch between them.

### Sidebar backpack picker
- New pill-shaped picker in the sidebar header showing the active
  backpack with a colored dot matching its deterministic color.
- Click to open a dropdown of all registered backpacks — click one
  to switch.
- Bottom of the dropdown has an "Add new backpack..." action that
  prompts for a name, path, and whether to activate immediately.
- Sidebar's left border is colored to match the active backpack —
  glanceable at all times, never in the way.

### API
- New endpoints in both `bin/serve.js` (production) and
  `vite.config.ts` (dev): `GET /api/backpacks`, `GET /api/backpacks/active`,
  `POST /api/backpacks`, `POST /api/backpacks/switch`,
  `DELETE /api/backpacks/:name`.
- The storage backend is now constructed with `graphsDirOverride`
  pointing at the active backpack's path, and swapped in place when
  the active backpack changes (no server restart).
- The file watcher re-registers itself on the new backpack's directory
  on switch, so live-reload continues to work across backpacks.

### Hot-swap
- New WebSocket event `active-backpack-change` fired by the vite dev
  server when the active backpack changes. The viewer listens and
  refreshes its backpack list + graphs list seamlessly — no full
  reload required.

### Dependencies
- Bumped `backpack-ontology` to `^0.4.0` for the new registry API.

### CSS
- New CSS classes (all CSP-compliant, no inline styles):
  `backpack-picker-container`, `backpack-picker-pill`,
  `backpack-picker-dot`, `backpack-picker-name`, `backpack-picker-caret`,
  `backpack-picker-dropdown`, `backpack-picker-item`,
  `backpack-picker-item-dot`, `backpack-picker-item-name`,
  `backpack-picker-item-path`, `backpack-picker-divider`,
  `backpack-picker-add`.
- Sidebar's `border-left` now uses a CSS custom property
  `--backpack-color` set via `element.style.setProperty` (allowed
  under strict CSP).

## 0.3.1 (2026-04-10)

### Docs
- **README cross-references the Claude Code plugin** as the recommended
  install path for Claude Code users. The viewer works with standalone
  MCP too, but the plugin bundles the MCP server with usage skills and
  is strictly better for that audience.
- Fixed stale storage path in the "How it works" diagram
  (`~/.local/share/backpack/ontologies/` → current event-sourced layout).
- Features list expanded with walk mode, focus mode, path finding,
  snippets, node history, star nodes, lock heartbeat badge, remote
  graphs, branches and snapshots — all of which shipped in or before
  0.3.0 but were missing from the README.

## 0.3.0 (2026-04-10)

This release pairs with `backpack-ontology@0.3.0` and inherits its event-sourced
storage, optimistic concurrency, and lock heartbeat. Existing graphs from older
versions are migrated automatically on first start.

### Collaboration awareness
- **Sidebar lock badge** — each graph item now shows `editing: <author>` when
  another writer has touched the graph in the last 5 minutes. Backed by the new
  `GET /api/locks` batch endpoint (one HTTP roundtrip per sidebar refresh, not N).
- New CSS class `sidebar-lock-badge.active` (CSP-compliant, no inline styles).

### Remote graphs
- New API client functions `listRemotes` and `loadRemote`.
- `main.ts` tracks `remoteNames` set and `activeIsRemote` flag for read-only
  remote graph viewing.
- Sidebar renders a remotes section alongside local graphs.

### Reliability
- **Vite dev plugin awaits storage init.** Both `JsonFileBackend.initialize()`
  and `RemoteRegistry.initialize()` are now awaited via a shared `readyPromise`,
  and every middleware request waits for it before touching storage. Eliminates
  a race where the first sidebar fetch could land before the registry was ready.
- Init failures log to stderr instead of breaking silently.

### Dependencies
- Bumped `backpack-ontology` to `^0.3.0` (was `^0.2.24`). The new ontology
  introduces breaking storage changes — see its CHANGELOG. The viewer is
  read-compatible with both formats via the auto-migration path.

### Security (carried from earlier unreleased work)
- **Strict CSP in production** — `bin/serve.js` and `vite preview` now ship `style-src 'self'` (no `'unsafe-inline'`). Defense-in-depth against XSS via injected styles, important now that remote graph loading is on the roadmap.
- Vite dev server keeps `'unsafe-inline'` for `style-src` only because Vite injects CSS inline for HMR. Dev server is local-only and not exposed.
- All inline `style="..."` attributes, `style.cssText` assignments, and inline `<style>` blocks removed from the viewer source.
- Token efficiency card refactored from `innerHTML` string to `createElement` so the bar fill width can be set via CSSOM (allowed under strict CSP).
- New CSS classes: `info-badge-row`, `info-empty-message`, `share-list-message`.

## 0.2.21 (2026-03-30)

### Exploration Features
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
