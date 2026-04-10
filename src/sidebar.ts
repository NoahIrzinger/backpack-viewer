import type { LearningGraphSummary } from "backpack-ontology";
import type { RemoteSummary } from "./api.js";
import { showConfirm, showPrompt, showBackpackAddDialog } from "./dialog";

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
}

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
  footer.innerHTML =
    '<a href="mailto:support@backpackontology.com">support@backpackontology.com</a>' +
    "<span>Feedback & support</span>" +
    `<span class="sidebar-version">v${__VIEWER_VERSION__}</span>`;

  // Collapse toggle button
  const collapseBtn = document.createElement("button");
  collapseBtn.className = "sidebar-collapse-btn";
  collapseBtn.title = "Toggle sidebar (Tab)";
  collapseBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="11 17 6 12 11 7"/><polyline points="18 17 13 12 18 7"/></svg>';

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

  function renderPickerDropdown() {
    pickerDropdown.replaceChildren();
    for (const b of currentBackpacks) {
      const item = document.createElement("button");
      item.className = "backpack-picker-item";
      item.type = "button";
      item.setAttribute("role", "option");
      if (b.active) item.classList.add("active");

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
        if (!b.active && cbs.onBackpackSwitch) {
          cbs.onBackpackSwitch(b.name);
        }
      });
      pickerDropdown.appendChild(item);
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
  expandBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="13 7 18 12 13 17"/><polyline points="6 7 11 12 6 17"/></svg>';
  expandBtn.addEventListener("click", toggleSidebar);
  container.appendChild(input);
  container.appendChild(list);
  container.appendChild(remoteHeading);
  container.appendChild(remoteList);
  container.appendChild(footer);

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
      list.innerHTML = "";
      // Fetch all locks in one batch request, then distribute to items
      // as they render. One HTTP roundtrip per sidebar refresh, not N.
      const lockBatchPromise = fetch("/api/locks")
        .then((r) => r.json())
        .catch(() => ({} as Record<string, { author?: string; lastActivity?: string } | null>));

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
          // Bail if this badge has been detached from the DOM (sidebar
          // re-rendered before the batch resolved)
          if (!lockBadge.isConnected) return;
          const lock = locks[s.name];
          if (lock && typeof lock === "object" && lock.author) {
            lockBadge.textContent = `editing: ${lock.author}`;
            lockBadge.title = `Last activity: ${lock.lastActivity ?? ""}`;
            lockBadge.classList.add("active");
          }
        });

        li.appendChild(nameSpan);
        li.appendChild(statsSpan);
        li.appendChild(lockBadge);
        li.appendChild(branchSpan);

        if (cbs.onRename) {
          const editBtn = document.createElement("button");
          editBtn.className = "sidebar-edit-btn";
          editBtn.textContent = "\u270E";
          editBtn.title = "Rename";
          const renameCb = cbs.onRename;
          editBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            const input = document.createElement("input");
            input.type = "text";
            input.className = "sidebar-rename-input";
            input.value = s.name;
            nameSpan.textContent = "";
            nameSpan.appendChild(input);
            editBtn.style.display = "none";
            input.focus();
            input.select();
            const finish = () => {
              const val = input.value.trim();
              if (val && val !== s.name) {
                renameCb(s.name, val);
              } else {
                nameSpan.textContent = s.name;
                editBtn.style.display = "";
              }
            };
            input.addEventListener("blur", finish);
            input.addEventListener("keydown", (ke) => {
              if (ke.key === "Enter") input.blur();
              if (ke.key === "Escape") { input.value = s.name; input.blur(); }
            });
          });
          li.appendChild(editBtn);
        }

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
