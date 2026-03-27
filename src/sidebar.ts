import type { LearningGraphSummary } from "backpack-ontology";

export interface SidebarCallbacks {
  onSelect: (name: string) => void;
  onRename?: (oldName: string, newName: string) => void;
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

        li.appendChild(nameSpan);
        li.appendChild(statsSpan);

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

    toggle: toggleSidebar,
  };
}
