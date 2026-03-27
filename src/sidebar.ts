import type { LearningGraphSummary } from "backpack-ontology";

export interface SidebarCallbacks {
  onSelect: (name: string) => void;
  onRename?: (oldName: string, newName: string) => void;
  onBranchSwitch?: (graphName: string, branchName: string) => void;
  onBranchCreate?: (graphName: string, branchName: string) => void;
  onBranchDelete?: (graphName: string, branchName: string) => void;
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

  const footer = document.createElement("div");
  footer.className = "sidebar-footer";
  footer.innerHTML =
    '<a href="mailto:support@backpackontology.com">support@backpackontology.com</a>' +
    "<span>Feedback & support</span>";

  // Collapse toggle button
  const collapseBtn = document.createElement("button");
  collapseBtn.className = "sidebar-collapse-btn";
  collapseBtn.title = "Toggle sidebar (Tab)";
  collapseBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="11 17 6 12 11 7"/><polyline points="18 17 13 12 18 7"/></svg>';

  let collapsed = false;
  function toggleSidebar() {
    collapsed = !collapsed;
    container.classList.toggle("sidebar-collapsed", collapsed);
    collapseBtn.innerHTML = collapsed
      ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="13 7 18 12 13 17"/><polyline points="6 7 11 12 6 17"/></svg>'
      : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="11 17 6 12 11 7"/><polyline points="18 17 13 12 18 7"/></svg>';
  }
  collapseBtn.addEventListener("click", toggleSidebar);

  const headingRow = document.createElement("div");
  headingRow.className = "sidebar-heading-row";
  headingRow.appendChild(heading);
  headingRow.appendChild(collapseBtn);

  container.appendChild(headingRow);
  container.appendChild(input);
  container.appendChild(list);
  container.appendChild(footer);

  let items: HTMLLIElement[] = [];
  let activeName = "";
  let activeBranchName = "main";

  // Filter
  input.addEventListener("input", () => {
    const query = input.value.toLowerCase();
    for (const item of items) {
      const name = item.dataset.name ?? "";
      item.style.display = name.includes(query) ? "" : "none";
    }
  });

  return {
    setSummaries(summaries: LearningGraphSummary[]) {
      list.innerHTML = "";
      items = summaries.map((s) => {
        const li = document.createElement("li");
        li.className = "ontology-item";
        li.dataset.name = s.name;

        const nameSpan = document.createElement("span");
        nameSpan.className = "name";
        nameSpan.textContent = s.name;

        const statsSpan = document.createElement("span");
        statsSpan.className = "stats";
        statsSpan.textContent = `${s.nodeCount} nodes, ${s.edgeCount} edges`;

        const branchSpan = document.createElement("span");
        branchSpan.className = "sidebar-branch";
        branchSpan.dataset.graph = s.name;

        li.appendChild(nameSpan);
        li.appendChild(statsSpan);
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

    toggle: toggleSidebar,
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
          if (confirm(`Delete branch "${b.name}"?`)) {
            cbs.onBranchDelete!(graphName, b.name);
            picker.remove();
          }
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
        const name = prompt("Branch name:");
        if (name?.trim()) {
          cbs.onBranchCreate!(graphName, name.trim());
          picker.remove();
        }
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
