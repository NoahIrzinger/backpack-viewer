import type { OntologySummary } from "backpack-ontology";

export function initSidebar(
  container: HTMLElement,
  onSelect: (name: string) => void
) {
  // Build DOM
  const heading = document.createElement("h2");
  heading.textContent = "Backpack Ontology Viewer";

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

  container.appendChild(heading);
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
    setSummaries(summaries: OntologySummary[]) {
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

        li.addEventListener("click", () => onSelect(s.name));

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
  };
}
