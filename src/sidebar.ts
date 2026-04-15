import type { LearningGraphSummary, KBDocumentSummary } from "backpack-ontology";
import type { RemoteSummary } from "./api.js";
import { showConfirm, showPrompt, showBackpackAddDialog, showKBMountDialog } from "./dialog";
import { makeSvgIcon } from "./dom-utils";
import type { KBMountInfo } from "backpack-ontology";

function formatTokenCount(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k tokens`;
  return `${n} tokens`;
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
  onKBDocSelect?: (docId: string) => void;
  onKBMountAdd?: (name: string, path: string, writable: boolean) => void;
  onKBMountRemove?: (name: string) => void;
  onKBMountEdit?: (name: string, newPath: string) => void;
  onSignIn?: () => void;
  onSignOut?: () => void;
  onSyncGraph?: (name: string) => void;
  onSyncPush?: (encrypted?: boolean) => Promise<SyncResult>;
  onSyncPull?: () => Promise<SyncResult>;
  onCloudRefresh?: () => Promise<{ graphs: number; kbDocs: number }>;
  onSyncKBDoc?: (docId: string) => Promise<boolean>;
  onSyncKBMount?: (mountName: string) => Promise<{ synced: number; failed: number; total: number }>;
  onKBDocDelete?: (docId: string) => Promise<void>;
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
  list.id = "ontology-list";

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

  let pickerOpen = false;
  function closePicker() {
    pickerOpen = false;
    pickerDropdown.hidden = true;
    backpackPicker.setAttribute("aria-expanded", "false");
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

  function renderPickerDropdown() {
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
      path.textContent = b.path;

      item.appendChild(dot);
      item.appendChild(name);
      item.appendChild(path);

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

    // Cloud backpack entry (single entry, not per-graph)
    if (hasCloudBackpack) {
      const cloudDivider = document.createElement("div");
      cloudDivider.className = "backpack-picker-divider";
      pickerDropdown.appendChild(cloudDivider);

      const cloudItem = document.createElement("button");
      cloudItem.className = "backpack-picker-item backpack-picker-cloud";
      cloudItem.type = "button";

      const cloudIcon = document.createElement("span");
      cloudIcon.className = "backpack-picker-item-dot";
      cloudIcon.textContent = "\u2601";

      const cloudNameEl = document.createElement("span");
      cloudNameEl.className = "backpack-picker-item-name";
      cloudNameEl.textContent = "Cloud";

      const cloudPath = document.createElement("span");
      cloudPath.className = "backpack-picker-item-path";
      cloudPath.textContent = "app.backpackontology.com";

      cloudItem.appendChild(cloudIcon);
      cloudItem.appendChild(cloudNameEl);
      cloudItem.appendChild(cloudPath);
      cloudItem.addEventListener("click", (e) => {
        e.stopPropagation();
        closePicker();
        pickerAllMode = false;
        pickerName.textContent = "Cloud";
        cbs.onBackpackSwitch?.("__cloud__");
      });
      pickerDropdown.appendChild(cloudItem);
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
      if (!cbs.onBackpackRegister) return;
      const result = await showBackpackAddDialog();
      if (!result) return;
      cbs.onBackpackRegister(result.path, result.activate);
    });
    pickerDropdown.appendChild(addItem);
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
      const signInBtn = document.createElement("button");
      signInBtn.className = "sidebar-auth-link sidebar-auth-signin";
      signInBtn.textContent = "Sign in to sync";
      signInBtn.addEventListener("click", () => cbs.onSignIn?.());
      authContent.appendChild(signInBtn);
      bpMenuBtn.hidden = true;
      syncStatus.hidden = true;
      syncPopup.hidden = true;
    }
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
        const nameEl = list.querySelector(`.ontology-item[data-name="${CSS.escape(graphName)}"] .name`) as HTMLElement | null;
        if (nameEl) triggerInlineRename(graphName, nameEl);
      });
      itemMenu.appendChild(renameItem);
    }

    if (isAuthenticated) {
      const syncItem = document.createElement("button");
      syncItem.className = "sidebar-item-menu-action";
      syncItem.textContent = "Sync to cloud";
      syncItem.addEventListener("click", () => {
        hideItemMenu();
        cbs.onSyncGraph?.(graphName);
      });
      itemMenu.appendChild(syncItem);
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
        const ok = await cbs.onSyncKBDoc!(docId);
        if (!ok) { /* toast handled by caller */ }
      });
      kbItemMenu.appendChild(syncItem);
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

  tabBar.appendChild(graphsTab);
  tabBar.appendChild(kbTab);
  container.appendChild(tabBar);

  // --- Graphs tab content ---
  const graphsPane = document.createElement("div");
  graphsPane.className = "sidebar-tab-pane";
  graphsPane.appendChild(input);
  graphsPane.appendChild(list);
  graphsPane.appendChild(remoteHeading);
  graphsPane.appendChild(remoteList);

  // Cloud backpacks section (visible when SSO'd)
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

  graphsPane.appendChild(cloudHeading);
  graphsPane.appendChild(cloudList);
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
        if (cbs.onSyncKBMount) await cbs.onSyncKBMount(selectedMount);
      });
      kbMenu.appendChild(syncItem);
    }

    if (isAuthenticated && cbs.onSyncKBMount && selectedMount === "__all__") {
      const syncAllItem = document.createElement("button");
      syncAllItem.className = "sidebar-item-menu-action";
      syncAllItem.textContent = "Sync all KB to cloud";
      syncAllItem.addEventListener("click", async () => {
        kbMenu.hidden = true;
        for (const m of currentKBMounts) {
          if (cbs.onSyncKBMount) await cbs.onSyncKBMount(m.name);
        }
      });
      kbMenu.appendChild(syncAllItem);
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

  // Remove the standalone KB heading — no longer needed in tabbed layout
  // (kbHeading was created earlier but we don't add it to the DOM)

  container.appendChild(footer);

  // Tab switching
  let activeTab: "graphs" | "kb" = "graphs";
  function switchTab(tab: "graphs" | "kb") {
    activeTab = tab;
    graphsTab.classList.toggle("active", tab === "graphs");
    kbTab.classList.toggle("active", tab === "kb");
    graphsPane.classList.toggle("hidden", tab !== "graphs");
    kbPane.classList.toggle("hidden", tab !== "kb");
  }
  graphsTab.addEventListener("click", () => switchTab("graphs"));
  kbTab.addEventListener("click", () => switchTab("kb"));

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
      item.style.display = name.includes(query) ? "" : "none";
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
      subtitle.textContent = `Latest is ${latest}. Your version is stuck because of an npx cache.`;

      const hint = document.createElement("pre");
      hint.className = "sidebar-stale-banner-hint";
      hint.textContent = "npm cache clean --force\nnpx backpack-viewer@latest";

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
        li.className = "ontology-item";
        li.dataset.name = s.name;

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
            syncBadge.textContent = info.encrypted ? "\uD83D\uDD12 synced" : "synced";
            syncBadge.title = info.encrypted ? "Synced (encrypted)" : "Synced (unencrypted)";
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

        li.appendChild(nameSpan);
        li.appendChild(statsSpan);
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
        li.className = "ontology-item ontology-item-remote";
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
        li.className = "ontology-item ontology-item-cloud";
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
        li.className = "ontology-item kb-item";
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

    setCloudBackpacksInPicker(names: string[]) {
      hasCloudBackpack = names.length > 0;
      renderPickerDropdown();
    },

    setSyncResult(graphName: string, success: boolean) {
      const badge = list.querySelector(`.ontology-item[data-name="${CSS.escape(graphName)}"] .sidebar-sync-badge`) as HTMLElement | null;
      if (badge && success) {
        badge.textContent = "synced";
        badge.title = "This graph has been synced";
        badge.classList.add("active");
      }
    },

    setCloudMode(active: boolean) {
      cloudModeActive = active;
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
