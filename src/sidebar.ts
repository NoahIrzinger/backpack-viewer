import type { LearningGraphSummary, KBDocumentSummary } from "backpack-ontology";
import type { RemoteSummary } from "./api.js";
import { showConfirm, showPrompt, showBackpackAddDialog, showKBMountDialog, showToast } from "./dialog";
import { makeSvgIcon } from "./dom-utils";
import type { KBMountInfo } from "backpack-ontology";

function formatTokenCount(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k tokens`;
  return `${n} tokens`;
}

function truncateMiddle(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  const keep = maxLen - 1;
  const head = Math.ceil(keep * 0.4);
  const tail = keep - head;
  return s.slice(0, head) + "…" + s.slice(s.length - tail);
}

function estimateTokensFromCounts(nodeCount: number, edgeCount: number): number {
  return nodeCount * 50 + edgeCount * 25 + 50; // rough: 50 tok/node, 25 tok/edge, 50 metadata
}

export interface BackpackSummary {
  name: string;
  path: string;
  color: string;
  active?: boolean;
}

export interface SidebarCallbacks {
  onSelect: (name: string) => void;
  onRename?: (oldName: string, newName: string) => void;
  onBranchSwitch?: (graphName: string, branchName: string) => void;
  onBranchCreate?: (graphName: string, branchName: string) => void;
  onBranchDelete?: (graphName: string, branchName: string) => void;
  onSnippetLoad?: (graphName: string, snippetId: string) => void;
  onSnippetDelete?: (graphName: string, snippetId: string) => void;
  onBackpackSwitch?: (pathOrName: string) => void;
  onBackpackRegister?: (path: string, activate: boolean) => void;
  /**
   * Optional override for the "+ Add new backpack…" click. When set, the
   * sidebar fires this instead of opening its built-in path dialog. Cloud
   * hosts use this to ask the user for a backpack *name* (not a folder
   * path) and call POST /api/sync/register, since cloud-native backpacks
   * have no filesystem to point at.
   */
  onAddBackpackClick?: () => void;
  onKBDocSelect?: (docId: string) => void;
  onSignalsTabSelect?: () => void;
  onKnowledgeGraphSelect?: (backpack?: string, graph?: string) => void;
  onKgSyncAll?: () => Promise<{ graphCount: number; errorCount: number; totalNodes: number }>;
  onKgSyncBackpack?: (backpackName: string) => Promise<{ graphCount: number; errorCount: number; totalNodes: number }>;
  onKBMountAdd?: (name: string, path: string, writable: boolean) => void;
  onKBMountRemove?: (name: string) => void;
  onKBMountEdit?: (name: string, newPath: string) => void;
  onSignIn?: () => void;
  onSignOut?: () => void;
  onSyncGraph?: (name: string, encrypted?: boolean) => void;
  onSyncPush?: (encrypted?: boolean) => Promise<SyncResult>;
  onSyncPull?: () => Promise<SyncResult>;
  onCloudRefresh?: () => Promise<{ graphs: number; kbDocs: number }>;
  onSyncKBDoc?: (docId: string, encrypted?: boolean) => Promise<boolean>;
  onSyncKBMount?: (mountName: string, encrypted?: boolean) => Promise<{ synced: number; failed: number; total: number }>;
  onKBDocDelete?: (docId: string) => Promise<void>;
  onEditTags?: (name: string) => void;
  /**
   * Cloud-mode operations. When the host wires these the matching menu
   * items appear in the sidebar's per-graph 3-dot menu. Implementations
   * are expected to handle confirmations and reload the sidebar via
   * setSummaries() on success.
   */
  onShare?: (graphName: string) => void | Promise<void>;
  onDelete?: (graphName: string) => void | Promise<void>;
  onSetVisibility?: (graphName: string, nextVisibility: "public" | "private") => void | Promise<void>;
  /**
   * Returns the current visibility for a graph so the menu label can
   * read "Make public" or "Make private". Defaults to "private" when
   * not provided.
   */
  getVisibility?: (graphName: string) => "public" | "private" | undefined;
}

export interface SyncResultItem { name: string; kind: "graph" | "kb"; status: "synced" | "failed" | "skipped"; error?: string }
export interface SyncResult { total: number; synced: number; failed: number; skipped: number; errors: string[]; items: SyncResultItem[] }

export function initSidebar(
  container: HTMLElement,
  onSelectOrCallbacks: ((name: string) => void) | SidebarCallbacks
) {
  const cbs: SidebarCallbacks =
    typeof onSelectOrCallbacks === "function"
      ? { onSelect: onSelectOrCallbacks }
      : onSelectOrCallbacks;
  // Build DOM
  const heading = document.createElement("h2");
  heading.textContent = "Backpack Viewer";

  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "Filter...";
  input.id = "filter";

  const list = document.createElement("ul");
  list.id = "graph-list";

  const kbHeading = document.createElement("h3");
  kbHeading.className = "sidebar-section-heading";
  kbHeading.textContent = "KNOWLEDGE BASE";
  kbHeading.hidden = true;

  const kbList = document.createElement("ul");
  kbList.id = "kb-list";
  kbList.className = "kb-list";
  kbList.hidden = true;

  const remoteHeading = document.createElement("h3");
  remoteHeading.className = "sidebar-section-heading";
  remoteHeading.textContent = "REMOTE GRAPHS";
  remoteHeading.hidden = true;

  const remoteList = document.createElement("ul");
  remoteList.id = "remote-list";
  remoteList.className = "remote-list";
  remoteList.hidden = true;

  const footer = document.createElement("div");
  footer.className = "sidebar-footer";
  const footerLink = document.createElement("a");
  footerLink.href = "mailto:support@backpackontology.com";
  footerLink.textContent = "support@backpackontology.com";
  const footerCaption = document.createElement("span");
  footerCaption.textContent = "Feedback & support";
  const footerVersion = document.createElement("span");
  footerVersion.className = "sidebar-version";
  footerVersion.textContent = `v${__VIEWER_VERSION__}`;
  footer.append(footerLink, footerCaption, footerVersion);

  // Collapse toggle button
  const collapseBtn = document.createElement("button");
  collapseBtn.className = "sidebar-collapse-btn";
  collapseBtn.title = "Toggle sidebar (Tab)";
  collapseBtn.appendChild(
    makeSvgIcon({ size: 14 }, [
      { tag: "polyline", attrs: { points: "11 17 6 12 11 7" } },
      { tag: "polyline", attrs: { points: "18 17 13 12 18 7" } },
    ]),
  );

  let collapsed = false;
  function toggleSidebar() {
    collapsed = !collapsed;
    container.classList.toggle("sidebar-collapsed", collapsed);
    expandBtn.classList.toggle("hidden", !collapsed);
  }
  collapseBtn.addEventListener("click", toggleSidebar);

  const headingRow = document.createElement("div");
  headingRow.className = "sidebar-heading-row";
  headingRow.appendChild(heading);
  headingRow.appendChild(collapseBtn);

  container.appendChild(headingRow);

  // Stale-version banner — hidden by default. setStaleVersionBanner()
  // populates and reveals it when the startup check detects that the
  // running viewer is older than the latest published npm version
  // (classic npx cache trap).
  const staleBanner = document.createElement("div");
  staleBanner.className = "sidebar-stale-banner";
  staleBanner.hidden = true;
  container.appendChild(staleBanner);

  // Backpack picker pill — discrete indicator of the active backpack with
  // a dropdown to switch between registered ones.
  const backpackPicker = document.createElement("button");
  backpackPicker.className = "backpack-picker-pill";
  backpackPicker.type = "button";
  backpackPicker.setAttribute("aria-haspopup", "listbox");
  backpackPicker.setAttribute("aria-expanded", "false");

  const pickerDot = document.createElement("span");
  pickerDot.className = "backpack-picker-dot";
  const pickerName = document.createElement("span");
  pickerName.className = "backpack-picker-name";
  pickerName.textContent = "...";
  const pickerCaret = document.createElement("span");
  pickerCaret.className = "backpack-picker-caret";
  pickerCaret.textContent = "▾";
  backpackPicker.appendChild(pickerDot);
  backpackPicker.appendChild(pickerName);
  backpackPicker.appendChild(pickerCaret);

  const pickerDropdown = document.createElement("div");
  pickerDropdown.className = "backpack-picker-dropdown";
  pickerDropdown.hidden = true;
  pickerDropdown.setAttribute("role", "listbox");

  const pickerContainer = document.createElement("div");
  pickerContainer.className = "backpack-picker-container";
  pickerContainer.appendChild(backpackPicker);
  pickerContainer.appendChild(pickerDropdown);
  container.appendChild(pickerContainer);

  // Cloud sync section — single state-machine row that owns the entire
  // sync flow: sign-in (when needed), enable (register + auto-push), and
  // ongoing sync. Replaces the separate "Sign in to sync" auth widget
  // entry point and the legacy per-graph sync popup.
  const syncRow = document.createElement("div");
  syncRow.className = "backpack-sync-row";
  syncRow.hidden = true;
  const syncStatusText = document.createElement("span");
  syncStatusText.className = "backpack-sync-status";
  syncStatusText.textContent = "";
  const syncPrimaryBtn = document.createElement("button");
  syncPrimaryBtn.type = "button";
  syncPrimaryBtn.className = "backpack-sync-btn";
  syncRow.appendChild(syncStatusText);
  syncRow.appendChild(syncPrimaryBtn);
  container.appendChild(syncRow);

  type SyncMode = "signin" | "enable" | "sync";
  let syncMode: SyncMode = "signin";

  function setSyncRow(mode: SyncMode, statusText: string, btnLabel: string) {
    syncMode = mode;
    syncStatusText.textContent = statusText;
    syncPrimaryBtn.textContent = btnLabel;
    syncPrimaryBtn.disabled = false;
    syncRow.hidden = false;
  }

  async function refreshSyncStatus() {
    try {
      const [statusRes, daemonRes] = await Promise.all([
        fetch("/api/backpack/v2-sync/status"),
        fetch("/api/backpack/v2-sync/daemon-status").catch(() => null),
      ]);
      if (!statusRes.ok) {
        syncRow.hidden = true;
        return;
      }
      const status = await statusRes.json() as {
        authenticated: boolean;
        registered: boolean;
        backpack_name?: string;
        last_sync_at?: string | null;
        reason?: string;
      };
      const daemon = daemonRes && daemonRes.ok
        ? (await daemonRes.json() as {
            enabled: boolean;
            state: "disabled" | "idle" | "syncing" | "backoff" | "auth_required";
            last_run_at: string | null;
          })
        : null;

      if (status.reason === "no_local_active") {
        // Cloud-mode viewer; nothing to sync from here.
        syncRow.hidden = true;
        return;
      }
      if (!status.authenticated || daemon?.state === "auth_required") {
        setSyncRow("signin", "Cloud sync is off", "Sign in to enable");
        return;
      }
      if (!status.registered) {
        setSyncRow(
          "enable",
          status.backpack_name ? `${status.backpack_name} not synced` : "Not synced",
          "Enable cloud sync",
        );
        return;
      }

      // Daemon-aware status text. When the daemon is running the user
      // doesn't need to think about syncing; the row just shows live
      // state. The "Sync now" button stays as a force-sync escape hatch.
      const lastRunIso = daemon?.last_run_at ?? status.last_sync_at ?? null;
      const when = lastRunIso ? formatRelativeTime(new Date(lastRunIso)) : "never";
      let statusLine: string;
      if (daemon?.state === "syncing") {
        statusLine = "Syncing…";
      } else if (daemon?.state === "backoff") {
        statusLine = `Retrying soon · last ${when}`;
      } else if (daemon?.enabled) {
        statusLine = `Auto-syncing · last ${when}`;
      } else {
        statusLine = `Last sync: ${when}`;
      }
      setSyncRow("sync", statusLine, "Sync now");
    } catch {
      syncRow.hidden = true;
    }
  }

  // Light polling so the user sees daemon ticks without manual refresh.
  // Only ticks while the row is visible to avoid pointless work.
  setInterval(() => {
    if (!syncRow.hidden) refreshSyncStatus();
  }, 5_000);

  syncPrimaryBtn.addEventListener("click", async () => {
    if (syncMode === "signin") {
      cbs.onSignIn?.();
      return;
    }

    if (syncMode === "enable") {
      const originalLabel = syncPrimaryBtn.textContent ?? "Enable cloud sync";
      syncPrimaryBtn.disabled = true;
      syncPrimaryBtn.textContent = "Enabling…";
      syncStatusText.textContent = "Registering and pushing…";
      try {
        const res = await fetch("/api/backpack/v2-sync/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });
        const data = await res.json().catch(() => ({})) as {
          state?: { backpack_id: string };
          push?: { pushed: string[]; conflicts: { artifact_id: string }[]; skipped?: { artifact_id: string }[]; errors: { message: string }[] };
          error?: string;
        };
        if (res.status === 401) {
          await flipToSignIn(data.error);
          return;
        }
        if (!res.ok) {
          syncStatusText.textContent = friendlyError(data.error, res.status);
          syncPrimaryBtn.textContent = originalLabel;
          syncPrimaryBtn.disabled = false;
          return;
        }
        const pushed = data.push?.pushed.length ?? 0;
        const errors = data.push?.errors.length ?? 0;
        const skipped = data.push?.skipped?.length ?? 0;
        syncStatusText.textContent = `Synced ${pushed} artifact${pushed !== 1 ? "s" : ""}` +
          (skipped ? ` (${skipped} skipped)` : "") +
          (errors ? ` (${errors} error${errors !== 1 ? "s" : ""})` : "");
        syncPrimaryBtn.textContent = "Done";
        setTimeout(() => refreshSyncStatus(), 1500);
      } catch (err) {
        syncStatusText.textContent = friendlyError((err as Error).message);
        syncPrimaryBtn.textContent = originalLabel;
        syncPrimaryBtn.disabled = false;
      }
      return;
    }

    if (syncMode === "sync") {
      const originalLabel = syncPrimaryBtn.textContent ?? "Sync now";
      syncPrimaryBtn.disabled = true;
      syncPrimaryBtn.textContent = "Syncing…";
      try {
        const res = await fetch("/api/backpack/v2-sync/sync", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ direction: "sync" }),
        });
        const data = await res.json().catch(() => ({})) as {
          pushed?: string[];
          pulled?: string[];
          conflicts?: { artifact_id: string }[];
          skipped?: { artifact_id: string }[];
          errors?: { message: string }[];
          error?: string;
        };
        if (res.status === 401) {
          await flipToSignIn(data.error);
          return;
        }
        if (!res.ok) {
          syncStatusText.textContent = friendlyError(data.error, res.status);
          syncPrimaryBtn.textContent = originalLabel;
          syncPrimaryBtn.disabled = false;
          return;
        }
        const pushed = data.pushed?.length ?? 0;
        const pulled = data.pulled?.length ?? 0;
        const conflicts = data.conflicts?.length ?? 0;
        const skipped = data.skipped?.length ?? 0;
        const errors = data.errors?.length ?? 0;
        const summary =
          (pushed === 0 && pulled === 0 && conflicts === 0 && skipped === 0 && errors === 0)
            ? "Already in sync"
            : `↑${pushed} ↓${pulled}` +
              (conflicts ? ` !${conflicts}` : "") +
              (skipped ? ` ⊘${skipped}` : "") +
              (errors ? ` ✗${errors}` : "");
        syncStatusText.textContent = summary;
        syncPrimaryBtn.textContent = "Done";
        setTimeout(() => refreshSyncStatus(), 1500);
      } catch (err) {
        syncStatusText.textContent = friendlyError((err as Error).message);
        syncPrimaryBtn.textContent = originalLabel;
        syncPrimaryBtn.disabled = false;
      }
      return;
    }
  });

  // Single source of truth for "expired/rejected token, drop to sign-in".
  // Clears the cached token so the next click hits a clean sign-in flow,
  // updates the row to a friendly call-to-action, and reports the cause
  // without leaking raw HTTP error strings into the UI.
  async function flipToSignIn(reason?: string) {
    try {
      await fetch("/api/extensions/share/settings/relay_token", { method: "DELETE" });
    } catch { /* clearing the token is best-effort */ }
    setSyncRow(
      "signin",
      reason && reason.length < 60 ? reason : "Cloud sync is off — please sign in",
      "Sign in to enable",
    );
    window.dispatchEvent(new CustomEvent("backpack-auth-changed"));
  }

  function friendlyError(raw: string | undefined, status?: number): string {
    if (raw && raw.length > 0 && raw.length < 80) return raw;
    if (status === 502 || status === 503 || status === 504) return "Cloud is unreachable — try again";
    if (status === 500) return "Cloud error — try again";
    if (raw && /failed to fetch/i.test(raw)) return "Network unreachable";
    return raw ?? "Something went wrong";
  }

  function formatRelativeTime(d: Date): string {
    const diffMs = Date.now() - d.getTime();
    const diffSec = Math.floor(diffMs / 1000);
    if (diffSec < 60) return "just now";
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `${diffMin} min ago`;
    const diffHour = Math.floor(diffMin / 60);
    if (diffHour < 24) return `${diffHour} hr ago`;
    return d.toLocaleDateString();
  }

  // Initial fetch + refresh after backpack switch.
  refreshSyncStatus();

  // Path tooltip — shows full backpack path on hover/focus of a picker item.
  // Mounted on document.body so it can escape the narrow sidebar bounds.
  const pathTooltip = document.createElement("div");
  pathTooltip.className = "backpack-picker-path-tooltip";
  pathTooltip.hidden = true;
  document.body.appendChild(pathTooltip);

  let pathTooltipTimeout: ReturnType<typeof setTimeout> | null = null;

  function showPathTooltip(target: HTMLElement, fullPath: string) {
    if (pathTooltipTimeout) clearTimeout(pathTooltipTimeout);
    pathTooltipTimeout = setTimeout(() => {
      pathTooltip.textContent = fullPath;
      pathTooltip.hidden = false;
      const rect = target.getBoundingClientRect();
      pathTooltip.style.left = `${rect.right + 8}px`;
      pathTooltip.style.top = `${rect.top}px`;
      const ttRect = pathTooltip.getBoundingClientRect();
      if (ttRect.right > window.innerWidth - 8) {
        const flippedLeft = rect.left - ttRect.width - 8;
        pathTooltip.style.left = `${Math.max(8, flippedLeft)}px`;
      }
      if (ttRect.bottom > window.innerHeight - 8) {
        pathTooltip.style.top = `${Math.max(8, window.innerHeight - ttRect.height - 8)}px`;
      }
    }, 200);
  }

  function hidePathTooltip() {
    if (pathTooltipTimeout) {
      clearTimeout(pathTooltipTimeout);
      pathTooltipTimeout = null;
    }
    pathTooltip.hidden = true;
  }

  let pickerOpen = false;
  function closePicker() {
    pickerOpen = false;
    pickerDropdown.hidden = true;
    backpackPicker.setAttribute("aria-expanded", "false");
    hidePathTooltip();
  }
  function openPicker() {
    pickerOpen = true;
    pickerDropdown.hidden = false;
    backpackPicker.setAttribute("aria-expanded", "true");
  }
  backpackPicker.addEventListener("click", (e) => {
    e.stopPropagation();
    if (pickerOpen) closePicker();
    else openPicker();
  });
  // Click outside closes the dropdown
  document.addEventListener("click", (e) => {
    if (!pickerContainer.contains(e.target as Node)) closePicker();
  });

  let currentBackpacks: BackpackSummary[] = [];
  let currentActiveBackpack: BackpackSummary | null = null;

  let pickerAllMode = false;
  let hasCloudBackpack = false;
  let cloudContainers: { name: string; color?: string; origin_kind: string; graphCount: number }[] = [];

  function renderPickerDropdown() {
    hidePathTooltip();
    pickerDropdown.replaceChildren();

    // "All" entry — shows content from all backpacks
    if (currentBackpacks.length > 1 || hasCloudBackpack) {
      const allItem = document.createElement("button");
      allItem.className = "backpack-picker-item backpack-picker-all";
      allItem.type = "button";
      if (pickerAllMode) allItem.classList.add("active");
      const allLabel = document.createElement("span");
      allLabel.className = "backpack-picker-item-name";
      allLabel.textContent = "All";
      allItem.appendChild(allLabel);
      allItem.addEventListener("click", (e) => {
        e.stopPropagation();
        closePicker();
        pickerAllMode = true;
        pickerName.textContent = "All";
        cbs.onBackpackSwitch?.("__all__");
      });
      pickerDropdown.appendChild(allItem);
      const allDiv = document.createElement("div");
      allDiv.className = "backpack-picker-divider";
      pickerDropdown.appendChild(allDiv);
    }

    // Local backpacks
    for (const b of currentBackpacks) {
      const item = document.createElement("button");
      item.className = "backpack-picker-item";
      item.type = "button";
      item.setAttribute("role", "option");
      if (b.active && !pickerAllMode) item.classList.add("active");

      const dot = document.createElement("span");
      dot.className = "backpack-picker-item-dot";
      dot.style.setProperty("--backpack-color", b.color);

      const name = document.createElement("span");
      name.className = "backpack-picker-item-name";
      name.textContent = b.name;

      const path = document.createElement("span");
      path.className = "backpack-picker-item-path";
      path.textContent = truncateMiddle(b.path, 32);

      item.appendChild(dot);
      item.appendChild(name);
      item.appendChild(path);

      item.addEventListener("mouseenter", () => showPathTooltip(item, b.path));
      item.addEventListener("mouseleave", hidePathTooltip);
      item.addEventListener("focus", () => showPathTooltip(item, b.path));
      item.addEventListener("blur", hidePathTooltip);

      item.addEventListener("click", (e) => {
        e.stopPropagation();
        closePicker();
        pickerAllMode = false;
        if (cbs.onBackpackSwitch) {
          cbs.onBackpackSwitch(b.name);
        }
      });
      pickerDropdown.appendChild(item);
    }

    // Cloud containers \u2014 one entry per sync_backpack on the relay.
    // Empty containers are still listed so the user can pick into them; the
    // graph count is shown in the path slot. Falls back to a single "Cloud"
    // entry if the relay didn't return container metadata.
    if (cloudContainers.length > 0 || hasCloudBackpack) {
      const cloudDivider = document.createElement("div");
      cloudDivider.className = "backpack-picker-divider";
      pickerDropdown.appendChild(cloudDivider);

      const entries = cloudContainers.length > 0
        ? cloudContainers
        : [{ name: "Cloud", color: undefined, origin_kind: "cloud", graphCount: 0 }];

      for (const c of entries) {
        const cloudItem = document.createElement("button");
        cloudItem.className = "backpack-picker-item backpack-picker-cloud";
        cloudItem.type = "button";

        const dot = document.createElement("span");
        dot.className = "backpack-picker-item-dot";
        if (c.color) {
          dot.style.setProperty("--backpack-color", c.color);
        } else {
          dot.textContent = "\u2601";
        }

        const nameEl = document.createElement("span");
        nameEl.className = "backpack-picker-item-name";
        nameEl.textContent = c.name;

        const pathEl = document.createElement("span");
        pathEl.className = "backpack-picker-item-path";
        const originLabel = c.origin_kind === "local" ? "device" : "cloud";
        const pathText = `${originLabel} \u00b7 ${c.graphCount} graph${c.graphCount === 1 ? "" : "s"}`;
        pathEl.textContent = pathText;

        cloudItem.appendChild(dot);
        cloudItem.appendChild(nameEl);
        cloudItem.appendChild(pathEl);

        const tooltip = `${c.name} (${originLabel}) \u00b7 app.backpackontology.com`;
        cloudItem.addEventListener("mouseenter", () => showPathTooltip(cloudItem, tooltip));
        cloudItem.addEventListener("mouseleave", hidePathTooltip);
        cloudItem.addEventListener("focus", () => showPathTooltip(cloudItem, tooltip));
        cloudItem.addEventListener("blur", hidePathTooltip);

        cloudItem.addEventListener("click", (e) => {
          e.stopPropagation();
          closePicker();
          pickerAllMode = false;
          pickerName.textContent = c.name;
          const switchName = cloudContainers.length > 0 ? `__cloud__:${c.name}` : "__cloud__";
          cbs.onBackpackSwitch?.(switchName);
        });
        pickerDropdown.appendChild(cloudItem);
      }
    }

    // Separator + "Add new backpack..." action
    const divider = document.createElement("div");
    divider.className = "backpack-picker-divider";
    pickerDropdown.appendChild(divider);

    const addItem = document.createElement("button");
    addItem.className = "backpack-picker-item backpack-picker-add";
    addItem.type = "button";
    addItem.textContent = "+ Add new backpack…";
    addItem.addEventListener("click", async (e) => {
      e.stopPropagation();
      closePicker();
      // Cloud host provides its own name-based prompt and registers
      // via /api/sync/register. Falls back to the local path-dialog
      // flow if the host didn't override.
      if (cbs.onAddBackpackClick) {
        cbs.onAddBackpackClick();
        return;
      }
      if (!cbs.onBackpackRegister) return;
      const result = await showBackpackAddDialog();
      if (!result) return;
      cbs.onBackpackRegister(result.path, result.activate);
    });
    pickerDropdown.appendChild(addItem);

    // "Pull from cloud..." — only meaningful for the local viewer
    // (cloud hosts already see all containers natively). The handler
    // checks /api/cloud-sync-backpacks; if the user isn't signed in
    // or has no cloud containers, the entry no-ops with a toast.
    const pullItem = document.createElement("button");
    pullItem.className = "backpack-picker-item backpack-picker-add";
    pullItem.type = "button";
    pullItem.textContent = "↓ Pull from cloud…";
    pullItem.addEventListener("click", async (e) => {
      e.stopPropagation();
      closePicker();
      await openPullFromCloudDialog();
    });
    pickerDropdown.appendChild(pullItem);
  }

  // Lightweight inline list dialog for "Pull from cloud". Lists the
  // user's cloud sync_backpacks, lets them pick one, and POSTs to
  // /api/backpack/v2-sync/clone to download it as a new local folder.
  async function openPullFromCloudDialog(): Promise<void> {
    let listResp: Response;
    try {
      listResp = await fetch("/api/cloud-sync-backpacks");
    } catch {
      showToast("Could not reach cloud — try again", 3000);
      return;
    }
    const data = await listResp.json().catch(() => ({})) as {
      authenticated?: boolean;
      backpacks?: Array<{ id: string; name: string; origin_kind: string; origin_device_name?: string }>;
    };
    if (!data.authenticated) {
      showToast("Sign in to enable cloud sync first", 3000);
      return;
    }
    const all = data.backpacks ?? [];
    if (all.length === 0) {
      showToast("No cloud backpacks to pull", 3000);
      return;
    }

    // Filter out backpacks already registered locally — listed via
    // setBackpacks earlier. We can read currentBackpacks via the
    // closed-over picker state, but that's not exposed here; just let
    // the server's clone endpoint decide via its alreadyExists check.
    const overlay = document.createElement("div");
    overlay.className = "backpack-pull-overlay";
    const dialog = document.createElement("div");
    dialog.className = "backpack-pull-dialog";
    const title = document.createElement("div");
    title.className = "backpack-pull-title";
    title.textContent = "Pull a backpack from cloud";
    dialog.appendChild(title);

    const list = document.createElement("div");
    list.className = "backpack-pull-list";
    for (const bp of all) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "backpack-pull-row";
      const label = bp.origin_kind === "cloud"
        ? `${bp.name}  ·  cloud`
        : `${bp.name}  ·  ${bp.origin_device_name ?? "device"}`;
      row.textContent = label;
      row.addEventListener("click", async () => {
        row.disabled = true;
        row.textContent = `${label}  ·  pulling…`;
        try {
          const res = await fetch("/api/backpack/v2-sync/clone", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ backpack_id: bp.id, activate: true }),
          });
          const body = await res.json().catch(() => ({})) as { path?: string; pulled?: number; error?: string };
          if (!res.ok) {
            row.textContent = body.error ?? `${label}  ·  failed (${res.status})`;
            row.disabled = false;
            return;
          }
          showToast(`Pulled ${body.pulled ?? 0} artifact(s) into ${body.path}`, 4000);
          overlay.remove();
          // Reload so the picker re-fetches the local backpack list.
          window.location.reload();
        } catch (err) {
          row.textContent = (err as Error).message;
          row.disabled = false;
        }
      });
      list.appendChild(row);
    }
    dialog.appendChild(list);

    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "backpack-pull-cancel";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => overlay.remove());
    dialog.appendChild(cancel);

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
  }

  // Expand button — inserted into the canvas top-left bar when sidebar is collapsed
  const expandBtn = document.createElement("button");
  expandBtn.className = "tools-pane-toggle hidden";
  expandBtn.title = "Show sidebar (Tab)";
  expandBtn.appendChild(
    makeSvgIcon({ size: 14 }, [
      { tag: "polyline", attrs: { points: "13 7 18 12 13 17" } },
      { tag: "polyline", attrs: { points: "6 7 11 12 6 17" } },
    ]),
  );
  expandBtn.addEventListener("click", toggleSidebar);

  // --- Auth widget (sign-in / email indicator) ---
  const authWidget = document.createElement("div");
  authWidget.className = "sidebar-auth-widget";
  authWidget.hidden = true;
  const authContent = document.createElement("span");
  authWidget.appendChild(authContent);
  container.appendChild(authWidget);

  let isAuthenticated = false;

  function renderAuthWidget(auth: { authenticated: boolean; email?: string }) {
    isAuthenticated = auth.authenticated;
    authWidget.hidden = false;
    authContent.replaceChildren();
    if (auth.authenticated && auth.email) {
      const emailSpan = document.createElement("span");
      emailSpan.className = "sidebar-auth-email";
      emailSpan.textContent = auth.email;
      authContent.appendChild(emailSpan);
      const signOutBtn = document.createElement("button");
      signOutBtn.className = "sidebar-auth-link";
      signOutBtn.textContent = "Sign out";
      signOutBtn.addEventListener("click", () => cbs.onSignOut?.());
      authContent.appendChild(signOutBtn);
      bpMenuBtn.hidden = false;
    } else {
      // The "Sign in" entry point lives in the cloud-sync row beneath the
      // backpack picker. Hide the auth widget entirely so we don't show
      // two competing sign-in calls-to-action.
      authWidget.hidden = true;
      bpMenuBtn.hidden = true;
      syncStatus.hidden = true;
      syncPopup.hidden = true;
    }
    // Pick up auth state changes in the cloud-sync row.
    refreshSyncStatus();
  }

  // --- Shared context menu for graph items ---
  const itemMenu = document.createElement("div");
  itemMenu.className = "sidebar-item-menu";
  itemMenu.hidden = true;
  let itemMenuTarget = "";

  function showItemMenu(btn: HTMLElement, graphName: string) {
    itemMenuTarget = graphName;
    itemMenu.replaceChildren();

    if (cbs.onRename) {
      const renameItem = document.createElement("button");
      renameItem.className = "sidebar-item-menu-action";
      renameItem.textContent = "Rename";
      renameItem.addEventListener("click", () => {
        hideItemMenu();
        // Trigger inline rename on the graph item
        const nameEl = list.querySelector(`.graph-item[data-name="${CSS.escape(graphName)}"] .name`) as HTMLElement | null;
        if (nameEl) triggerInlineRename(graphName, nameEl);
      });
      itemMenu.appendChild(renameItem);
    }

    if (cbs.onEditTags) {
      const tagsItem = document.createElement("button");
      tagsItem.className = "sidebar-item-menu-action";
      tagsItem.textContent = "Edit tags";
      tagsItem.addEventListener("click", () => {
        hideItemMenu();
        cbs.onEditTags!(graphName);
      });
      itemMenu.appendChild(tagsItem);
    }

    if (cbs.onShare) {
      const shareItem = document.createElement("button");
      shareItem.className = "sidebar-item-menu-action";
      shareItem.textContent = "Share";
      shareItem.addEventListener("click", () => {
        hideItemMenu();
        void cbs.onShare!(graphName);
      });
      itemMenu.appendChild(shareItem);
    }

    if (cbs.onSetVisibility) {
      const current = cbs.getVisibility?.(graphName) ?? "private";
      const next: "public" | "private" = current === "public" ? "private" : "public";
      const visItem = document.createElement("button");
      visItem.className = "sidebar-item-menu-action";
      visItem.textContent = next === "public" ? "Make public" : "Make private";
      visItem.addEventListener("click", () => {
        hideItemMenu();
        void cbs.onSetVisibility!(graphName, next);
      });
      itemMenu.appendChild(visItem);
    }

    if (isAuthenticated && cbs.onSyncGraph) {
      const syncItem = document.createElement("button");
      syncItem.className = "sidebar-item-menu-action";
      syncItem.textContent = "Sync to cloud";
      syncItem.addEventListener("click", () => {
        hideItemMenu();
        cbs.onSyncGraph?.(graphName, true);
      });
      itemMenu.appendChild(syncItem);

      const syncUnencItem = document.createElement("button");
      syncUnencItem.className = "sidebar-item-menu-action sidebar-item-menu-danger";
      syncUnencItem.textContent = "Sync unencrypted";
      syncUnencItem.addEventListener("click", () => {
        hideItemMenu();
        cbs.onSyncGraph?.(graphName, false);
      });
      itemMenu.appendChild(syncUnencItem);
    }

    if (cbs.onDelete) {
      const deleteItem = document.createElement("button");
      deleteItem.className = "sidebar-item-menu-action sidebar-item-menu-danger";
      deleteItem.textContent = "Delete";
      deleteItem.addEventListener("click", () => {
        hideItemMenu();
        void cbs.onDelete!(graphName);
      });
      itemMenu.appendChild(deleteItem);
    }

    const rect = btn.getBoundingClientRect();
    itemMenu.style.top = rect.bottom + 2 + "px";
    itemMenu.style.left = rect.left + "px";
    itemMenu.hidden = false;
  }

  function hideItemMenu() {
    itemMenu.hidden = true;
    itemMenuTarget = "";
  }

  document.addEventListener("click", (e) => {
    if (!itemMenu.hidden && !itemMenu.contains(e.target as Node) && !(e.target as HTMLElement).closest(".sidebar-item-menu-btn")) {
      hideItemMenu();
    }
  });

  container.appendChild(itemMenu);

  // --- Shared context menu for KB document items ---
  const kbItemMenu = document.createElement("div");
  kbItemMenu.className = "sidebar-item-menu";
  kbItemMenu.hidden = true;
  let kbItemMenuTarget = "";

  function showKBItemMenu(btn: HTMLElement, docId: string, docTitle: string, mountWritable: boolean) {
    kbItemMenuTarget = docId;
    kbItemMenu.replaceChildren();

    if (isAuthenticated && cbs.onSyncKBDoc) {
      const syncItem = document.createElement("button");
      syncItem.className = "sidebar-item-menu-action";
      syncItem.textContent = "Sync to cloud";
      syncItem.addEventListener("click", async () => {
        hideKBItemMenu();
        syncItem.disabled = true;
        const ok = await cbs.onSyncKBDoc!(docId, true);
        if (!ok) { /* toast handled by caller */ }
      });
      kbItemMenu.appendChild(syncItem);

      const syncUnencItem = document.createElement("button");
      syncUnencItem.className = "sidebar-item-menu-action sidebar-item-menu-danger";
      syncUnencItem.textContent = "Sync unencrypted";
      syncUnencItem.addEventListener("click", async () => {
        hideKBItemMenu();
        const ok = await cbs.onSyncKBDoc!(docId, false);
        if (!ok) { /* toast handled by caller */ }
      });
      kbItemMenu.appendChild(syncUnencItem);
    }

    if (mountWritable && cbs.onKBDocDelete) {
      const deleteItem = document.createElement("button");
      deleteItem.className = "sidebar-item-menu-action sidebar-item-menu-danger";
      deleteItem.textContent = "Delete";
      deleteItem.addEventListener("click", async () => {
        hideKBItemMenu();
        const ok = await showConfirm("Delete document", `Delete "${docTitle}"? This cannot be undone.`);
        if (ok) cbs.onKBDocDelete!(docId);
      });
      kbItemMenu.appendChild(deleteItem);
    }

    const rect = btn.getBoundingClientRect();
    kbItemMenu.style.top = rect.bottom + 2 + "px";
    kbItemMenu.style.left = rect.left + "px";
    kbItemMenu.hidden = false;
  }

  function hideKBItemMenu() {
    kbItemMenu.hidden = true;
    kbItemMenuTarget = "";
  }

  document.addEventListener("click", (e) => {
    if (!kbItemMenu.hidden && !kbItemMenu.contains(e.target as Node) && !(e.target as HTMLElement).closest(".sidebar-item-menu-btn")) {
      hideKBItemMenu();
    }
  });

  container.appendChild(kbItemMenu);

  function triggerInlineRename(graphName: string, nameEl: HTMLElement) {
    const renameCb = cbs.onRename!;
    const input = document.createElement("input");
    input.type = "text";
    input.className = "sidebar-rename-input";
    input.value = graphName;
    nameEl.textContent = "";
    nameEl.appendChild(input);
    input.focus();
    input.select();
    const finish = () => {
      const val = input.value.trim();
      if (val && val !== graphName) {
        renameCb(graphName, val);
      } else {
        nameEl.textContent = graphName;
      }
    };
    input.addEventListener("blur", finish);
    input.addEventListener("keydown", (ke) => {
      if (ke.key === "Enter") input.blur();
      if (ke.key === "Escape") { input.value = graphName; input.blur(); }
    });
  }

  // --- Backpack three-dot menu (sync actions, visible when authenticated) ---
  const bpMenuBtn = document.createElement("button");
  bpMenuBtn.className = "sidebar-picker-menu-btn";
  bpMenuBtn.type = "button";
  bpMenuBtn.textContent = "\u22EE";
  bpMenuBtn.title = "Backpack actions";
  bpMenuBtn.hidden = true;
  pickerContainer.appendChild(bpMenuBtn);

  const bpMenu = document.createElement("div");
  bpMenu.className = "sidebar-item-menu";
  bpMenu.hidden = true;
  container.appendChild(bpMenu);

  // Sync results popup (shared)
  const syncPopup = document.createElement("div");
  syncPopup.className = "sidebar-sync-popup";
  syncPopup.hidden = true;

  const syncStatus = document.createElement("div");
  syncStatus.className = "sidebar-sync-status";
  syncStatus.hidden = true;

  function showSyncResults(title: string, result: SyncResult) {
    syncPopup.replaceChildren();
    syncPopup.hidden = false;
    const header = document.createElement("div");
    header.className = "sidebar-sync-popup-header";
    const headerTitle = document.createElement("span");
    headerTitle.textContent = `${title}: ${result.synced}/${result.total}`;
    if (result.failed > 0) headerTitle.textContent += ` (${result.failed} failed)`;
    const closeBtn = document.createElement("button");
    closeBtn.className = "sidebar-sync-popup-close";
    closeBtn.type = "button";
    closeBtn.textContent = "\u00d7";
    closeBtn.addEventListener("click", (e) => { e.stopPropagation(); syncPopup.hidden = true; });
    header.appendChild(headerTitle);
    header.appendChild(closeBtn);
    syncPopup.appendChild(header);
    const itemList = document.createElement("div");
    itemList.className = "sidebar-sync-popup-list";
    for (const item of result.items) {
      const row = document.createElement("div");
      row.className = "sidebar-sync-popup-item";
      const icon = document.createElement("span");
      icon.className = "sidebar-sync-popup-icon";
      if (item.status === "synced") { icon.textContent = "\u2713"; icon.classList.add("sidebar-sync-ok"); }
      else if (item.status === "failed") { icon.textContent = "\u2717"; icon.classList.add("sidebar-sync-fail"); }
      else { icon.textContent = "\u2014"; icon.classList.add("sidebar-sync-skip"); }
      const label = document.createElement("span");
      label.className = "sidebar-sync-popup-label";
      label.textContent = item.name;
      const badge = document.createElement("span");
      badge.className = "sidebar-sync-popup-badge";
      badge.textContent = item.kind;
      row.appendChild(icon);
      row.appendChild(label);
      row.appendChild(badge);
      if (item.error && item.status !== "synced") row.title = item.error;
      itemList.appendChild(row);
    }
    syncPopup.appendChild(itemList);
  }
  container.appendChild(syncPopup);
  container.appendChild(syncStatus);

  async function doSyncPush(encrypted: boolean = true) {
    if (!cbs.onSyncPush) return;
    syncPopup.hidden = true;
    syncStatus.hidden = false;
    syncStatus.textContent = encrypted ? "Syncing (encrypted)\u2026" : "Syncing (unencrypted)\u2026";
    syncStatus.className = "sidebar-sync-status";
    try {
      const result = await cbs.onSyncPush(encrypted);
      syncStatus.hidden = true;
      showSyncResults(encrypted ? "Pushed (encrypted)" : "Pushed (unencrypted)", result);
    } catch (err) {
      syncStatus.textContent = "Sync failed: " + (err as Error).message;
      syncStatus.className = "sidebar-sync-status sidebar-sync-error";
    }
  }

  async function doSyncPull() {
    if (!cbs.onSyncPull) return;
    syncPopup.hidden = true;
    syncStatus.hidden = false;
    syncStatus.textContent = "Pulling from cloud\u2026";
    syncStatus.className = "sidebar-sync-status";
    try {
      const result = await cbs.onSyncPull();
      syncStatus.hidden = true;
      showSyncResults("Pulled", result);
    } catch (err) {
      syncStatus.textContent = "Pull failed: " + (err as Error).message;
      syncStatus.className = "sidebar-sync-status sidebar-sync-error";
    }
  }

  let cloudModeActive = false;

  function showBpMenu() {
    bpMenu.replaceChildren();

    if (cloudModeActive) {
      // Cloud backpack active — only show refresh
      const refreshItem = document.createElement("button");
      refreshItem.className = "sidebar-item-menu-action";
      refreshItem.textContent = "Refresh from Cloud";
      refreshItem.addEventListener("click", async () => {
        bpMenu.hidden = true;
        syncStatus.hidden = false;
        syncStatus.textContent = "Refreshing from cloud\u2026";
        syncStatus.className = "sidebar-sync-status";
        try {
          const result = await cbs.onCloudRefresh?.();
          syncStatus.textContent = result ? `Refreshed ${result.graphs} graphs, ${result.kbDocs} KB docs` : "Refreshed";
          setTimeout(() => { syncStatus.hidden = true; }, 3000);
        } catch (err) {
          syncStatus.textContent = "Refresh failed: " + (err as Error).message;
          syncStatus.className = "sidebar-sync-status sidebar-sync-error";
        }
      });
      bpMenu.appendChild(refreshItem);
    } else {
      // Local backpack active — push/pull options
      const pushItem = document.createElement("button");
      pushItem.className = "sidebar-item-menu-action";
      pushItem.textContent = "Sync to Cloud";
      pushItem.addEventListener("click", () => { bpMenu.hidden = true; doSyncPush(true); });
      bpMenu.appendChild(pushItem);

      const pushUnencItem = document.createElement("button");
      pushUnencItem.className = "sidebar-item-menu-action sidebar-item-menu-danger";
      pushUnencItem.textContent = "Sync unencrypted";
      pushUnencItem.addEventListener("click", () => { bpMenu.hidden = true; doSyncPush(false); });
      bpMenu.appendChild(pushUnencItem);
    }

    const rect = bpMenuBtn.getBoundingClientRect();
    bpMenu.style.top = rect.bottom + 2 + "px";
    bpMenu.style.left = rect.left + "px";
    bpMenu.hidden = false;
  }

  bpMenuBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!bpMenu.hidden) { bpMenu.hidden = true; } else { showBpMenu(); }
  });
  document.addEventListener("click", (e) => {
    if (!bpMenu.hidden && !bpMenu.contains(e.target as Node) && !(e.target as HTMLElement).closest(".sidebar-picker-menu-btn")) {
      bpMenu.hidden = true;
    }
  });

  // --- Tab bar: Graphs | Knowledge Base ---
  const tabBar = document.createElement("div");
  tabBar.className = "sidebar-tab-bar";

  const graphsTab = document.createElement("button");
  graphsTab.className = "sidebar-tab active";
  graphsTab.type = "button";
  graphsTab.textContent = "Graphs";

  const kbTab = document.createElement("button");
  kbTab.className = "sidebar-tab";
  kbTab.type = "button";
  kbTab.textContent = "Knowledge Base";

  const signalsTab = document.createElement("button");
  signalsTab.className = "sidebar-tab";
  signalsTab.type = "button";
  signalsTab.textContent = "Signals";

  tabBar.appendChild(graphsTab);
  tabBar.appendChild(kbTab);
  tabBar.appendChild(signalsTab);
  container.appendChild(tabBar);

  // --- Graphs tab content ---
  // --- Knowledge Graph sticky section ---
  const kgSection = document.createElement("div");
  kgSection.className = "kg-section";

  const kgEntry = document.createElement("div");
  kgEntry.className = "kg-entry kg-entry--offline";
  kgEntry.title = "View knowledge graph";

  const kgIcon = document.createElement("span");
  kgIcon.className = "kg-icon";
  kgIcon.textContent = "⬡";

  const kgInfo = document.createElement("div");
  kgInfo.className = "kg-info";

  const kgName = document.createElement("span");
  kgName.className = "kg-name";
  kgName.textContent = "Knowledge Graph";

  const kgMeta = document.createElement("span");
  kgMeta.className = "kg-meta";
  kgMeta.textContent = "Connect ArcadeDB to enable";

  // Scope selector — three levels: All / per-backpack / per-graph
  const kgScopeSelect = document.createElement("select");
  kgScopeSelect.className = "kg-scope-select";
  kgScopeSelect.hidden = true;
  kgScopeSelect.title = "Filter knowledge graph scope";
  kgScopeSelect.addEventListener("click", (e) => e.stopPropagation());
  kgScopeSelect.addEventListener("change", () => { renderKgMeta(); });

  // Query/sync access moved to the floating canvas button (main.ts).
  // The sidebar entry is status-only — click opens the KG panel or settings.
  const kgDotTarget = document.createElement("span");
  kgDotTarget.className = "kg-conn-dot-target";

  kgInfo.append(kgName, kgMeta);
  kgEntry.append(kgIcon, kgInfo, kgScopeSelect, kgDotTarget);
  kgSection.appendChild(kgEntry);

  let kgOnline = false;
  type KGStatusCache = {
    available: boolean;
    nodeCount: number;
    graphCount: number;
    backpacks: Array<{ name: string; nodeCount: number; graphCount: number; graphs?: Array<{ name: string; nodeCount: number }> }>;
  };
  let kgStatusCache: KGStatusCache | null = null;

  function parseKgScope(val: string): { backpack?: string; graph?: string } {
    if (!val || val === "all") return {};
    const bpMatch = val.match(/^bp:([^/]+)/);
    const gMatch = val.match(/\/g:(.+)$/);
    return { backpack: bpMatch?.[1] ?? undefined, graph: gMatch?.[1] ?? undefined };
  }

  function rebuildScopeOptions() {
    const backpacks = kgStatusCache?.backpacks ?? [];
    const current = kgScopeSelect.value;
    kgScopeSelect.replaceChildren();

    const allOpt = document.createElement("option");
    allOpt.value = "all";
    allOpt.textContent = "All backpacks";
    kgScopeSelect.appendChild(allOpt);

    for (const bp of backpacks) {
      const group = document.createElement("optgroup");
      group.label = bp.name;

      const bpAllOpt = document.createElement("option");
      bpAllOpt.value = `bp:${bp.name}`;
      bpAllOpt.textContent = "All graphs";
      group.appendChild(bpAllOpt);

      for (const g of bp.graphs ?? []) {
        const gOpt = document.createElement("option");
        gOpt.value = `bp:${bp.name}/g:${g.name}`;
        gOpt.textContent = g.name;
        group.appendChild(gOpt);
      }
      kgScopeSelect.appendChild(group);
    }

    const stillValid = [...kgScopeSelect.options].some((o) => o.value === current);
    kgScopeSelect.value = stillValid ? current : "all";
  }

  function renderKgMeta() {
    if (!kgStatusCache || !kgStatusCache.available) {
      kgOnline = false;
      kgEntry.className = "kg-entry kg-entry--offline";
      kgMeta.textContent = "Connect ArcadeDB to enable";
      kgScopeSelect.hidden = true;
      return;
    }

    const scope = kgScopeSelect.value || "all";
    const { backpack, graph } = parseKgScope(scope);

    let nodeCount: number;
    let graphCount: number;
    let scopeLabel: string;

    if (!backpack) {
      nodeCount = kgStatusCache.nodeCount;
      graphCount = kgStatusCache.graphCount;
      scopeLabel = "live";
    } else if (!graph) {
      const bp = (kgStatusCache.backpacks ?? []).find((b) => b.name === backpack);
      nodeCount = bp?.nodeCount ?? 0;
      graphCount = bp?.graphCount ?? 0;
      scopeLabel = backpack;
    } else {
      const bp = (kgStatusCache.backpacks ?? []).find((b) => b.name === backpack);
      const g = (bp?.graphs ?? []).find((gg) => gg.name === graph);
      nodeCount = g?.nodeCount ?? 0;
      graphCount = nodeCount > 0 ? 1 : 0;
      scopeLabel = graph;
    }

    if (nodeCount > 0) {
      kgOnline = true;
      kgEntry.className = "kg-entry kg-entry--online";
      kgMeta.textContent = `${nodeCount} nodes · ${graphCount} graph${graphCount !== 1 ? "s" : ""} · ${scopeLabel}`;
    } else {
      kgOnline = kgStatusCache.available;
      kgEntry.className = "kg-entry kg-entry--empty";
      kgMeta.textContent = scope === "all"
        ? "No graphs projected yet — use the ⬡ button to sync"
        : `Nothing projected${backpack ? ` from "${backpack}"` : ""} yet`;
    }

    const hasData = (kgStatusCache.backpacks ?? []).length > 0;
    kgScopeSelect.hidden = !hasData;
    if (hasData) rebuildScopeOptions();
  }

  kgEntry.addEventListener("click", () => {
    const { backpack, graph } = parseKgScope(kgScopeSelect.value || "all");
    if (kgOnline) {
      cbs.onKnowledgeGraphSelect?.(backpack, graph);
    }
    window.dispatchEvent(new CustomEvent("backpack-kg-open", { detail: { openSettings: !kgOnline } }));
  });

  async function refreshKgStatus() {
    try {
      // Scope to the current backpack when one is active (cloud app injects BACKPACK_ID).
      const bpId = window.BACKPACK_ID;
      const statusUrl = bpId
        ? `/api/connector/knowledge-graph/status?backpackId=${encodeURIComponent(bpId)}`
        : "/api/connector/knowledge-graph/status";
      const res = await fetch(statusUrl);
      if (!res.ok) throw new Error("unavailable");
      kgStatusCache = await res.json() as KGStatusCache;
      renderKgMeta();
    } catch {
      kgStatusCache = null;
      kgOnline = false;
      kgEntry.className = "kg-entry kg-entry--offline";
      kgMeta.textContent = "Connect ArcadeDB to enable";
      kgScopeSelect.hidden = true;
    }
  }

  refreshKgStatus();
  setInterval(refreshKgStatus, 15000);

  // Helper: collapsible sidebar section with a header toggle
  function makeCollapsibleSection(label: string, startCollapsed = false) {
    const header = document.createElement("div");
    header.className = "sidebar-collapsible-header";

    const chevron = document.createElement("span");
    chevron.className = "sidebar-collapsible-chevron";
    chevron.textContent = startCollapsed ? "▸" : "▾";

    const title = document.createElement("span");
    title.className = "sidebar-collapsible-title";
    title.textContent = label;

    header.appendChild(chevron);
    header.appendChild(title);

    const content = document.createElement("div");
    content.className = "sidebar-collapsible-content";
    if (startCollapsed) content.classList.add("sidebar-collapsible-content--collapsed");

    header.addEventListener("click", () => {
      const collapsed = content.classList.toggle("sidebar-collapsible-content--collapsed");
      chevron.textContent = collapsed ? "▸" : "▾";
    });

    return { header, content };
  }

  const graphsPane = document.createElement("div");
  graphsPane.className = "sidebar-tab-pane";

  // Filter goes above both sections
  graphsPane.appendChild(input);

  // --- "Knowledge" collapsible section (ArcadeDB / Curiosity Engine) ---
  const knowledgeSection = makeCollapsibleSection("Knowledge");
  knowledgeSection.content.appendChild(kgSection);
  graphsPane.appendChild(knowledgeSection.header);
  graphsPane.appendChild(knowledgeSection.content);

  // --- "Learning" collapsible section (individual graphs) ---
  const learningSection = makeCollapsibleSection("Learning");
  learningSection.content.appendChild(list);
  learningSection.content.appendChild(remoteHeading);
  learningSection.content.appendChild(remoteList);

  // Cloud backpacks section (visible when SSO'd) — lives inside Learning
  const cloudHeading = document.createElement("h3");
  cloudHeading.className = "sidebar-section-heading";
  cloudHeading.textContent = "CLOUD";
  cloudHeading.hidden = true;
  const cloudEmail = document.createElement("span");
  cloudEmail.className = "sidebar-cloud-email";
  cloudHeading.appendChild(cloudEmail);

  const cloudList = document.createElement("ul");
  cloudList.id = "cloud-list";
  cloudList.className = "cloud-list";
  cloudList.hidden = true;

  learningSection.content.appendChild(cloudHeading);
  learningSection.content.appendChild(cloudList);

  graphsPane.appendChild(learningSection.header);
  graphsPane.appendChild(learningSection.content);
  container.appendChild(graphsPane);

  // --- KB tab content ---
  const kbPane = document.createElement("div");
  kbPane.className = "sidebar-tab-pane hidden";

  // KB mount picker (pill style matching backpack picker)
  const kbPickerContainer = document.createElement("div");
  kbPickerContainer.className = "kb-picker-container";

  const kbPickerBtn = document.createElement("button");
  kbPickerBtn.className = "kb-picker-pill";
  kbPickerBtn.type = "button";
  kbPickerBtn.setAttribute("aria-haspopup", "listbox");
  const kbPickerName = document.createElement("span");
  kbPickerName.className = "kb-picker-name";
  kbPickerName.textContent = "All";
  const kbPickerCaret = document.createElement("span");
  kbPickerCaret.className = "backpack-picker-caret";
  kbPickerCaret.textContent = "\u25BE";
  kbPickerBtn.appendChild(kbPickerName);
  kbPickerBtn.appendChild(kbPickerCaret);

  const kbPickerDropdown = document.createElement("div");
  kbPickerDropdown.className = "backpack-picker-dropdown";
  kbPickerDropdown.hidden = true;

  kbPickerContainer.appendChild(kbPickerBtn);
  kbPickerContainer.appendChild(kbPickerDropdown);

  let kbPickerOpen = false;
  kbPickerBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    kbPickerOpen = !kbPickerOpen;
    kbPickerDropdown.hidden = !kbPickerOpen;
  });
  document.addEventListener("click", (e) => {
    if (kbPickerOpen && !kbPickerContainer.contains(e.target as Node)) {
      kbPickerOpen = false;
      kbPickerDropdown.hidden = true;
    }
  });

  // KB three-dot menu (sync mount + add mount)
  const kbMenuBtn = document.createElement("button");
  kbMenuBtn.className = "sidebar-picker-menu-btn";
  kbMenuBtn.type = "button";
  kbMenuBtn.textContent = "\u22EE";
  kbMenuBtn.title = "Knowledge base actions";
  kbPickerContainer.appendChild(kbMenuBtn);

  const kbMenu = document.createElement("div");
  kbMenu.className = "sidebar-item-menu";
  kbMenu.hidden = true;
  container.appendChild(kbMenu);

  function showKBMenu() {
    kbMenu.replaceChildren();

    if (isAuthenticated && cbs.onSyncKBMount && selectedMount !== "__all__") {
      const syncItem = document.createElement("button");
      syncItem.className = "sidebar-item-menu-action";
      syncItem.textContent = `Sync "${selectedMount}" to cloud`;
      syncItem.addEventListener("click", async () => {
        kbMenu.hidden = true;
        if (cbs.onSyncKBMount) await cbs.onSyncKBMount(selectedMount, true);
      });
      kbMenu.appendChild(syncItem);

      const syncUnencItem = document.createElement("button");
      syncUnencItem.className = "sidebar-item-menu-action sidebar-item-menu-danger";
      syncUnencItem.textContent = `Sync "${selectedMount}" unencrypted`;
      syncUnencItem.addEventListener("click", async () => {
        kbMenu.hidden = true;
        if (cbs.onSyncKBMount) await cbs.onSyncKBMount(selectedMount, false);
      });
      kbMenu.appendChild(syncUnencItem);
    }

    if (isAuthenticated && cbs.onSyncKBMount && selectedMount === "__all__") {
      const syncAllItem = document.createElement("button");
      syncAllItem.className = "sidebar-item-menu-action";
      syncAllItem.textContent = "Sync all KB to cloud";
      syncAllItem.addEventListener("click", async () => {
        kbMenu.hidden = true;
        for (const m of currentKBMounts) {
          if (cbs.onSyncKBMount) await cbs.onSyncKBMount(m.name, true);
        }
      });
      kbMenu.appendChild(syncAllItem);

      const syncAllUnencItem = document.createElement("button");
      syncAllUnencItem.className = "sidebar-item-menu-action sidebar-item-menu-danger";
      syncAllUnencItem.textContent = "Sync all KB unencrypted";
      syncAllUnencItem.addEventListener("click", async () => {
        kbMenu.hidden = true;
        for (const m of currentKBMounts) {
          if (cbs.onSyncKBMount) await cbs.onSyncKBMount(m.name, false);
        }
      });
      kbMenu.appendChild(syncAllUnencItem);
    }

    const addItem = document.createElement("button");
    addItem.className = "sidebar-item-menu-action";
    addItem.textContent = "Add mount\u2026";
    addItem.addEventListener("click", async () => {
      kbMenu.hidden = true;
      const result = await showKBMountDialog();
      if (result) cbs.onKBMountAdd?.(result.name, result.path, result.writable);
    });
    kbMenu.appendChild(addItem);

    const rect = kbMenuBtn.getBoundingClientRect();
    kbMenu.style.top = rect.bottom + 2 + "px";
    kbMenu.style.left = rect.left + "px";
    kbMenu.hidden = false;
  }

  kbMenuBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!kbMenu.hidden) { kbMenu.hidden = true; } else { showKBMenu(); }
  });
  document.addEventListener("click", (e) => {
    if (!kbMenu.hidden && !kbMenu.contains(e.target as Node) && !(e.target as HTMLElement).closest(".sidebar-picker-menu-btn")) {
      kbMenu.hidden = true;
    }
  });

  kbPane.appendChild(kbPickerContainer);

  const kbFilter = document.createElement("input");
  kbFilter.type = "text";
  kbFilter.placeholder = "Search documents...";
  kbFilter.className = "sidebar-kb-filter";
  kbPane.appendChild(kbFilter);

  let selectedMount = "__all__";
  let currentKBMounts: KBMountInfo[] = [];

  function renderKBPickerDropdown() {
    kbPickerDropdown.replaceChildren();
    const totalDocs = currentKBMounts.reduce((s, m) => s + m.docCount, 0);

    // "All" option
    const allItem = document.createElement("button");
    allItem.className = "backpack-picker-item" + (selectedMount === "__all__" ? " active" : "");
    allItem.type = "button";
    const allLabel = document.createElement("span");
    allLabel.className = "backpack-picker-item-name";
    allLabel.textContent = `All (${totalDocs} docs)`;
    allItem.appendChild(allLabel);
    allItem.addEventListener("click", () => {
      selectedMount = "__all__";
      kbPickerName.textContent = "All";
      kbPickerOpen = false;
      kbPickerDropdown.hidden = true;
      filterKBItems();
    });
    kbPickerDropdown.appendChild(allItem);

    if (currentKBMounts.length > 0) {
      const div = document.createElement("div");
      div.className = "backpack-picker-divider";
      kbPickerDropdown.appendChild(div);
    }

    for (const m of currentKBMounts) {
      const item = document.createElement("button");
      item.className = "backpack-picker-item" + (selectedMount === m.name ? " active" : "");
      item.type = "button";
      const label = document.createElement("span");
      label.className = "backpack-picker-item-name";
      label.textContent = `${m.name} (${m.docCount})`;
      if (!m.writable) label.textContent += " \u2022 read-only";
      item.appendChild(label);
      item.addEventListener("click", () => {
        selectedMount = m.name;
        kbPickerName.textContent = m.name;
        kbPickerOpen = false;
        kbPickerDropdown.hidden = true;
        filterKBItems();
      });
      kbPickerDropdown.appendChild(item);
    }
  }

  function filterKBItems() {
    const query = kbFilter.value.toLowerCase();
    for (const item of kbItems) {
      const title = item.dataset.title ?? "";
      const mount = item.dataset.mount ?? "";
      const matchesSearch = title.includes(query);
      const matchesMount = selectedMount === "__all__" || mount === selectedMount;
      item.style.display = matchesSearch && matchesMount ? "" : "none";
    }
  }

  kbPane.appendChild(kbList);
  kbList.hidden = false;
  container.appendChild(kbPane);

  // --- Dashboard tab content ---
  const signalsPane = document.createElement("div");
  signalsPane.className = "sidebar-tab-pane hidden";

  const dashContent = document.createElement("div");
  dashContent.className = "sv-sidebar-pane";

  const statsRow = document.createElement("div");
  statsRow.className = "sv-sidebar-stat-row";

  const totalStat = document.createElement("div");
  totalStat.className = "sv-sidebar-stat";
  const totalNum = document.createElement("div");
  totalNum.className = "sv-sidebar-stat-number";
  totalNum.textContent = "—";
  const totalLabel = document.createElement("div");
  totalLabel.className = "sv-sidebar-stat-label";
  totalLabel.textContent = "Signals";
  totalStat.append(totalNum, totalLabel);

  const highStat = document.createElement("div");
  highStat.className = "sv-sidebar-stat";
  highStat.style.borderLeftColor = "var(--sev-high)";
  const highNum = document.createElement("div");
  highNum.className = "sv-sidebar-stat-number";
  highNum.textContent = "—";
  const highLabel = document.createElement("div");
  highLabel.className = "sv-sidebar-stat-label";
  highLabel.textContent = "High";
  highStat.append(highNum, highLabel);

  statsRow.append(totalStat, highStat);

  const openBtn = document.createElement("button");
  openBtn.type = "button";
  openBtn.className = "sv-open-btn";
  openBtn.textContent = "Open Signals";
  openBtn.addEventListener("click", () => cbs.onSignalsTabSelect?.());

  const lastScanEl = document.createElement("div");
  lastScanEl.className = "sv-sidebar-last-scan";

  // Gear button → signal detector config overlay
  const gearBtn = document.createElement("button");
  gearBtn.type = "button";
  gearBtn.className = "sv-gear-btn";
  gearBtn.title = "Configure signal detectors";
  gearBtn.textContent = "⚙ Detectors";

  const configOverlay = document.createElement("div");
  configOverlay.className = "sv-config-overlay hidden";

  const configTitle = document.createElement("div");
  configTitle.className = "sv-config-title";
  configTitle.textContent = "Signal Detectors";

  const configCloseBtn = document.createElement("button");
  configCloseBtn.type = "button";
  configCloseBtn.className = "sv-config-close";
  configCloseBtn.textContent = "×";
  configCloseBtn.addEventListener("click", () => configOverlay.classList.add("hidden"));

  const configList = document.createElement("div");
  configList.className = "sv-config-list";

  configOverlay.append(configTitle, configCloseBtn, configList);

  async function loadDetectorConfig() {
    try {
      const res = await fetch("/api/signals/config");
      if (!res.ok) return;
      const data = await res.json() as { detectors: { kind: string; displayName: string; enabled: boolean; requiresConnector: boolean }[] };
      configList.replaceChildren();
      for (const det of data.detectors) {
        const row = document.createElement("div");
        row.className = "sv-config-row";

        const toggle = document.createElement("input");
        toggle.type = "checkbox";
        toggle.className = "sv-config-toggle";
        toggle.checked = det.enabled;
        toggle.addEventListener("change", async () => {
          await fetch("/api/signals/config", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ detectors: { [det.kind]: { enabled: toggle.checked } } }),
          });
        });

        const label = document.createElement("label");
        label.className = "sv-config-label";
        label.textContent = det.displayName;

        if (det.requiresConnector) {
          const badge = document.createElement("span");
          badge.className = "sv-config-badge";
          badge.textContent = "connector";
          label.appendChild(badge);
        }

        row.append(toggle, label);
        configList.appendChild(row);
      }
    } catch { /* ignore */ }
  }

  gearBtn.addEventListener("click", () => {
    const hidden = configOverlay.classList.toggle("hidden");
    if (!hidden) loadDetectorConfig();
  });

  dashContent.append(statsRow, openBtn, lastScanEl, gearBtn, configOverlay);
  signalsPane.appendChild(dashContent);
  container.appendChild(signalsPane);

  container.appendChild(footer);

  // Tab switching
  let activeTab: "graphs" | "kb" | "signals" = "graphs";
  function switchTab(tab: "graphs" | "kb" | "signals") {
    activeTab = tab;
    graphsTab.classList.toggle("active", tab === "graphs");
    kbTab.classList.toggle("active", tab === "kb");
    signalsTab.classList.toggle("active", tab === "signals");
    graphsPane.classList.toggle("hidden", tab !== "graphs");
    kbPane.classList.toggle("hidden", tab !== "kb");
    signalsPane.classList.toggle("hidden", tab !== "signals");
    if (tab === "signals") cbs.onSignalsTabSelect?.();
  }
  graphsTab.addEventListener("click", () => switchTab("graphs"));
  kbTab.addEventListener("click", () => switchTab("kb"));
  signalsTab.addEventListener("click", () => switchTab("signals"));

  let kbItems: HTMLLIElement[] = [];
  kbFilter.addEventListener("input", () => filterKBItems());

  let items: HTMLLIElement[] = [];
  let remoteItems: HTMLLIElement[] = [];
  let activeName = "";
  let activeBranchName = "main";

  // Filter
  input.addEventListener("input", () => {
    const query = input.value.toLowerCase();
    for (const item of items) {
      const name = item.dataset.name ?? "";
      const tags = item.dataset.tags ?? "";
      item.style.display = (name.includes(query) || tags.includes(query)) ? "" : "none";
    }
    for (const item of remoteItems) {
      const name = item.dataset.name ?? "";
      item.style.display = name.includes(query) ? "" : "none";
    }
  });

  return {
    setStaleVersionBanner(current: string, latest: string) {
      staleBanner.replaceChildren();
      const title = document.createElement("div");
      title.className = "sidebar-stale-banner-title";
      title.textContent = `Viewer ${current} is out of date`;

      const subtitle = document.createElement("div");
      subtitle.className = "sidebar-stale-banner-subtitle";
      subtitle.textContent = `Latest is ${latest}. Run the command below to update:`;

      const hint = document.createElement("pre");
      hint.className = "sidebar-stale-banner-hint";
      hint.textContent = "npx backpack-viewer@latest --yes";

      staleBanner.appendChild(title);
      staleBanner.appendChild(subtitle);
      staleBanner.appendChild(hint);
      staleBanner.hidden = false;
    },
    setBackpacks(list: BackpackSummary[]) {
      currentBackpacks = list.slice();
      const active = list.find((b) => b.active) ?? null;
      currentActiveBackpack = active;
      if (active) {
        pickerName.textContent = active.name;
        pickerDot.style.setProperty("--backpack-color", active.color);
        container.style.setProperty("--backpack-color", active.color);
      }
      renderPickerDropdown();
    },
    setActiveBackpack(entry: BackpackSummary) {
      currentActiveBackpack = entry;
      // Update the currentBackpacks list to reflect the new active
      currentBackpacks = currentBackpacks.map((b) => ({
        ...b,
        active: b.name === entry.name,
      }));
      // If this name wasn't in the list (newly registered), include it
      if (!currentBackpacks.some((b) => b.name === entry.name)) {
        currentBackpacks.push({ ...entry, active: true });
      }
      pickerName.textContent = entry.name;
      pickerDot.style.setProperty("--backpack-color", entry.color);
      container.style.setProperty("--backpack-color", entry.color);
      renderPickerDropdown();
      refreshSyncStatus();
    },
    getActiveBackpack(): BackpackSummary | null {
      return currentActiveBackpack;
    },
    setSummaries(summaries: LearningGraphSummary[]) {
      list.replaceChildren();
      // Fetch all locks in one batch request, then distribute to items
      // as they render. One HTTP roundtrip per sidebar refresh, not N.
      const inShareMode = (window as unknown as Record<string, boolean>).__bpShareMode;
      const lockBatchPromise = inShareMode
        ? Promise.resolve({} as Record<string, { author?: string; lastActivity?: string } | null>)
        : fetch("/api/locks")
            .then((r) => r.json())
            .catch(() => ({} as Record<string, { author?: string; lastActivity?: string } | null>));

      const syncStatusPromise = inShareMode
        ? Promise.resolve(new Map<string, { encrypted: boolean }>())
        : fetch("/api/sync-status")
            .then((r) => r.json())
            .then((d: { synced: Record<string, { encrypted: boolean }> }) => {
              const m = new Map<string, { encrypted: boolean }>();
              if (d.synced && typeof d.synced === "object") {
                for (const [k, v] of Object.entries(d.synced)) m.set(k, v);
              }
              return m;
            })
            .catch(() => new Map<string, { encrypted: boolean }>());

      items = summaries.map((s) => {
        const li = document.createElement("li");
        li.className = "graph-item";
        li.dataset.name = s.name;
        li.dataset.tags = (s.tags ?? []).join(" ");

        const nameSpan = document.createElement("span");
        nameSpan.className = "name";
        nameSpan.textContent = s.name;

        const statsSpan = document.createElement("span");
        statsSpan.className = "stats";
        const tokens = estimateTokensFromCounts(s.nodeCount, s.edgeCount);
        statsSpan.textContent = `${s.nodeCount} nodes, ${s.edgeCount} edges · ~${formatTokenCount(tokens)}`;

        const branchSpan = document.createElement("span");
        branchSpan.className = "sidebar-branch";
        branchSpan.dataset.graph = s.name;

        // Lock heartbeat badge — populated from the batched fetch above
        const lockBadge = document.createElement("span");
        lockBadge.className = "sidebar-lock-badge";
        lockBadge.dataset.graph = s.name;
        lockBatchPromise.then((locks) => {
          if (!lockBadge.isConnected) return;
          const lock = locks[s.name];
          if (lock && typeof lock === "object" && lock.author) {
            lockBadge.textContent = `editing: ${lock.author}`;
            lockBadge.title = `Last activity: ${lock.lastActivity ?? ""}`;
            lockBadge.classList.add("active");
          }
        });

        // Sync badge — shows a cloud icon for graphs that have been synced
        const syncBadge = document.createElement("span");
        syncBadge.className = "sidebar-sync-badge";
        syncBadge.dataset.graph = s.name;
        syncStatusPromise.then((syncedMap) => {
          if (!syncBadge.isConnected) return;
          const info = syncedMap.get(s.name);
          if (info) {
            const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
            svg.setAttribute("width", "12");
            svg.setAttribute("height", "12");
            svg.setAttribute("viewBox", "0 0 24 24");
            svg.setAttribute("fill", "none");
            svg.setAttribute("stroke", "currentColor");
            svg.setAttribute("stroke-width", "2");
            svg.setAttribute("stroke-linecap", "round");
            svg.setAttribute("stroke-linejoin", "round");
            if (info.encrypted) {
              // Lock icon
              const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
              rect.setAttribute("x", "3"); rect.setAttribute("y", "11");
              rect.setAttribute("width", "18"); rect.setAttribute("height", "11");
              rect.setAttribute("rx", "2");
              const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
              path.setAttribute("d", "M7 11V7a5 5 0 0 1 10 0v4");
              svg.appendChild(rect);
              svg.appendChild(path);
            } else {
              // Cloud icon
              const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
              path.setAttribute("d", "M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z");
              svg.appendChild(path);
            }
            syncBadge.appendChild(svg);
            syncBadge.title = info.encrypted ? "Synced to cloud (encrypted)" : "Synced to cloud";
            syncBadge.classList.add("active");
          }
        });

        // Three-dot menu button
        const menuBtn = document.createElement("button");
        menuBtn.className = "sidebar-item-menu-btn";
        menuBtn.textContent = "\u22EE";
        menuBtn.title = "Actions";
        menuBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          if (!itemMenu.hidden && itemMenuTarget === s.name) {
            hideItemMenu();
          } else {
            showItemMenu(menuBtn, s.name);
          }
        });

        const tagsContainer = document.createElement("div");
        tagsContainer.className = "sidebar-tags";
        if (s.tags?.length) {
          for (const tag of s.tags) {
            const pill = document.createElement("span");
            pill.className = "sidebar-tag-pill";
            pill.textContent = `#${tag}`;
            tagsContainer.appendChild(pill);
          }
        }

        li.appendChild(nameSpan);
        li.appendChild(statsSpan);
        li.appendChild(tagsContainer);
        li.appendChild(lockBadge);
        li.appendChild(syncBadge);
        li.appendChild(branchSpan);
        li.appendChild(menuBtn);

        li.addEventListener("click", () => cbs.onSelect(s.name));

        list.appendChild(li);
        return li;
      });

      // Re-apply active state
      if (activeName) {
        this.setActive(activeName);
      }
    },

    setActive(name: string) {
      activeName = name;
      for (const item of items) {
        item.classList.toggle("active", item.dataset.name === name);
      }
      for (const item of remoteItems) {
        item.classList.toggle("active", item.dataset.name === name);
      }
    },

    setRemotes(remotes: RemoteSummary[]) {
      remoteList.replaceChildren();
      remoteItems = remotes.map((r) => {
        const li = document.createElement("li");
        li.className = "graph-item graph-item-remote";
        li.dataset.name = r.name;

        const nameRow = document.createElement("div");
        nameRow.className = "remote-name-row";

        const nameSpan = document.createElement("span");
        nameSpan.className = "name";
        nameSpan.textContent = r.name;

        const badge = document.createElement("span");
        badge.className = "remote-badge";
        badge.textContent = r.pinned ? "remote · pinned" : "remote";
        badge.title = `Source: ${r.source ?? r.url}`;

        nameRow.appendChild(nameSpan);
        nameRow.appendChild(badge);

        const statsSpan = document.createElement("span");
        statsSpan.className = "stats";
        const tokens = estimateTokensFromCounts(r.nodeCount, r.edgeCount);
        statsSpan.textContent = `${r.nodeCount} nodes, ${r.edgeCount} edges · ~${formatTokenCount(tokens)}`;

        const sourceSpan = document.createElement("span");
        sourceSpan.className = "remote-source";
        sourceSpan.textContent = r.source ?? new URL(r.url).hostname;
        sourceSpan.title = r.url;

        li.appendChild(nameRow);
        li.appendChild(statsSpan);
        li.appendChild(sourceSpan);

        li.addEventListener("click", () => cbs.onSelect(r.name));

        remoteList.appendChild(li);
        return li;
      });

      const visible = remotes.length > 0;
      remoteHeading.hidden = !visible;
      remoteList.hidden = !visible;

      // Re-apply active state in case the active graph is a remote
      if (activeName) {
        this.setActive(activeName);
      }
    },

    setCloudBackpacks(backpacks: { name: string; encrypted: boolean; nodeCount?: number; edgeCount?: number }[], email?: string) {
      cloudList.replaceChildren();
      if (email) {
        cloudEmail.textContent = ` \u2014 ${email}`;
      }
      for (const bp of backpacks) {
        const li = document.createElement("li");
        li.className = "graph-item graph-item-cloud";
        li.dataset.name = bp.name;

        const nameRow = document.createElement("div");
        nameRow.className = "remote-name-row";
        const nameSpan = document.createElement("span");
        nameSpan.className = "name";
        nameSpan.textContent = bp.name;
        const badge = document.createElement("span");
        badge.className = "remote-badge";
        badge.textContent = bp.encrypted ? "cloud \u00b7 encrypted" : "cloud";
        nameRow.appendChild(nameSpan);
        nameRow.appendChild(badge);

        const statsSpan = document.createElement("span");
        statsSpan.className = "stats";
        if (bp.nodeCount != null) {
          const tokens = estimateTokensFromCounts(bp.nodeCount, bp.edgeCount ?? 0);
          statsSpan.textContent = `${bp.nodeCount} nodes, ${bp.edgeCount ?? 0} edges \u00b7 ~${formatTokenCount(tokens)}`;
        }

        li.appendChild(nameRow);
        li.appendChild(statsSpan);
        li.addEventListener("click", () => cbs.onSelect(bp.name));
        cloudList.appendChild(li);
      }
      const visible = backpacks.length > 0;
      cloudHeading.hidden = !visible;
      cloudList.hidden = !visible;
    },

    setKBDocuments(documents: KBDocumentSummary[]) {
      kbList.replaceChildren();
      kbItems = [];

      if (documents.length === 0) {
        const empty = document.createElement("li");
        empty.className = "kb-empty-state";
        empty.textContent = "No documents yet. Use backpack_kb_save via MCP to create one.";
        kbList.appendChild(empty);
        return;
      }

      for (const doc of documents) {
        const li = document.createElement("li");
        li.className = "graph-item kb-item";
        li.dataset.id = doc.id;
        li.dataset.title = doc.title.toLowerCase();
        li.dataset.mount = doc.collection || "";

        const nameSpan = document.createElement("span");
        nameSpan.className = "name";
        nameSpan.textContent = doc.title;

        const statsSpan = document.createElement("span");
        statsSpan.className = "stats";
        const parts: string[] = [];
        if (doc.tags.length > 0) parts.push(doc.tags.join(", "));
        if (doc.sourceGraphs.length > 0) {
          parts.push(`from: ${doc.sourceGraphs.join(", ")}`);
        }
        statsSpan.textContent = parts.join(" · ") || doc.collection || "document";

        // Determine if this doc's mount is writable
        const docMount = currentKBMounts.find(m => m.name === doc.collection);
        const mountWritable = docMount ? docMount.writable : true;

        // Three-dot menu button
        const menuBtn = document.createElement("button");
        menuBtn.className = "sidebar-item-menu-btn";
        menuBtn.textContent = "\u22EE";
        menuBtn.title = "Actions";
        menuBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          if (!kbItemMenu.hidden && kbItemMenuTarget === doc.id) {
            hideKBItemMenu();
          } else {
            showKBItemMenu(menuBtn, doc.id, doc.title, mountWritable);
          }
        });

        li.appendChild(nameSpan);
        li.appendChild(statsSpan);
        li.appendChild(menuBtn);

        li.addEventListener("click", (e) => {
          // Don't open doc if click was on the menu button
          if ((e.target as HTMLElement).closest(".sidebar-item-menu-btn")) return;
          cbs.onKBDocSelect?.(doc.id);
        });

        kbList.appendChild(li);
        kbItems.push(li);
      }
      filterKBItems();
    },

    setKBMounts(mounts: KBMountInfo[]) {
      currentKBMounts = mounts;
      // Validate current selection still exists
      if (selectedMount !== "__all__" && !mounts.some(m => m.name === selectedMount)) {
        selectedMount = "__all__";
        kbPickerName.textContent = "All";
      }
      renderKBPickerDropdown();
      filterKBItems();
    },

    setActiveBranch(graphName: string, branchName: string, allBranches?: { name: string; active: boolean }[]) {
      activeBranchName = branchName;
      const spans = list.querySelectorAll(`.sidebar-branch[data-graph="${graphName}"]`);
      for (const span of spans) {
        (span as HTMLElement).textContent = `/ ${branchName}`;
        (span as HTMLElement).title = "Click to switch branch";
        (span as HTMLElement).style.cursor = "pointer";

        // Remove old listener by replacing element
        const fresh = span.cloneNode(true) as HTMLElement;
        span.replaceWith(fresh);
        fresh.addEventListener("click", (e) => {
          e.stopPropagation();
          showBranchPicker(graphName, fresh, allBranches ?? []);
        });
      }
    },

    setSnippets(graphName: string, snippets: { id: string; label: string; nodeCount: number }[]) {
      // Find the graph's list item and add/update snippet pills
      const li = items.find((el) => el.dataset.name === graphName);
      if (!li) return;

      // Remove existing snippet list
      li.querySelector(".sidebar-snippets")?.remove();

      if (snippets.length === 0) return;

      const snippetList = document.createElement("div");
      snippetList.className = "sidebar-snippets";

      for (const s of snippets) {
        const row = document.createElement("div");
        row.className = "sidebar-snippet";

        const label = document.createElement("span");
        label.className = "sidebar-snippet-label";
        label.textContent = `◆ ${s.label}`;
        label.title = `${s.nodeCount} nodes — click to load`;

        const del = document.createElement("button");
        del.className = "sidebar-snippet-delete";
        del.textContent = "\u00d7";
        del.title = "Delete snippet";
        del.addEventListener("click", (e) => {
          e.stopPropagation();
          cbs.onSnippetDelete?.(graphName, s.id);
        });

        row.appendChild(label);
        row.appendChild(del);

        row.addEventListener("click", (e) => {
          e.stopPropagation();
          cbs.onSnippetLoad?.(graphName, s.id);
        });

        snippetList.appendChild(row);
      }

      li.appendChild(snippetList);
    },

    setAuthStatus(auth: { authenticated: boolean; email?: string }) {
      renderAuthWidget(auth);
    },

    setCloudContainers(containers: { name: string; color?: string; origin_kind: string; graphCount: number }[]) {
      cloudContainers = containers;
      hasCloudBackpack = containers.length > 0;
      renderPickerDropdown();
    },

    setSyncResult(graphName: string, success: boolean) {
      const badge = list.querySelector(`.graph-item[data-name="${CSS.escape(graphName)}"] .sidebar-sync-badge`) as HTMLElement | null;
      if (badge && success) {
        badge.textContent = "synced";
        badge.title = "This graph has been synced";
        badge.classList.add("active");
      }
    },

    setCloudMode(active: boolean, label?: string, color?: string) {
      cloudModeActive = active;
      if (active) {
        pickerName.textContent = label ?? "Cloud";
        const c = color ?? "#5b9bd5";
        pickerDot.style.setProperty("--backpack-color", c);
        container.style.setProperty("--backpack-color", c);
        pickerAllMode = false;
      }
    },

    setSignalsStats(total: number, high: number, lastScan?: string) {
      totalNum.textContent = String(total);
      highNum.textContent = String(high);
      lastScanEl.textContent = lastScan ? `Last scan: ${lastScan.slice(0, 16).replace("T", " ")}` : "";
    },

    toggle: toggleSidebar,
    expandBtn,
  };

  function showBranchPicker(
    graphName: string,
    anchor: HTMLElement,
    branches: { name: string; active: boolean }[]
  ) {
    // Remove existing picker
    const old = container.querySelector(".branch-picker");
    if (old) old.remove();

    const picker = document.createElement("div");
    picker.className = "branch-picker";

    for (const b of branches) {
      const row = document.createElement("div");
      row.className = "branch-picker-item";
      if (b.active) row.classList.add("branch-picker-active");

      const label = document.createElement("span");
      label.textContent = b.name;
      row.appendChild(label);

      if (!b.active && cbs.onBranchDelete) {
        const del = document.createElement("button");
        del.className = "branch-picker-delete";
        del.textContent = "\u00d7";
        del.title = `Delete ${b.name}`;
        del.addEventListener("click", (e) => {
          e.stopPropagation();
          showConfirm("Delete branch", `Delete branch "${b.name}"?`).then((ok) => {
            if (ok) {
              cbs.onBranchDelete!(graphName, b.name);
              picker.remove();
            }
          });
        });
        row.appendChild(del);
      }

      if (!b.active) {
        row.addEventListener("click", () => {
          cbs.onBranchSwitch?.(graphName, b.name);
          picker.remove();
        });
      }

      picker.appendChild(row);
    }

    // Create new branch row
    if (cbs.onBranchCreate) {
      const createRow = document.createElement("div");
      createRow.className = "branch-picker-item branch-picker-create";
      createRow.textContent = "+ New branch";
      createRow.addEventListener("click", () => {
        showPrompt("New branch", "Branch name").then((name) => {
          if (name) {
            cbs.onBranchCreate!(graphName, name);
            picker.remove();
          }
        });
      });
      picker.appendChild(createRow);
    }

    anchor.after(picker);

    // Close on outside click
    const close = (e: MouseEvent) => {
      if (!picker.contains(e.target as Node)) {
        picker.remove();
        document.removeEventListener("click", close);
      }
    };
    setTimeout(() => document.addEventListener("click", close), 0);
  }
}
