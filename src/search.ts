import type { LearningGraphData, Node } from "backpack-ontology";
import { getColor } from "./colors";

/** Extract a display label from a node — first string property value, fallback to id. */
function nodeLabel(node: Node): string {
  for (const value of Object.values(node.properties)) {
    if (typeof value === "string") return value;
  }
  return node.id;
}

/** Check if a node matches a search query (case-insensitive across label + all string properties). */
function matchesQuery(node: Node, query: string): boolean {
  const q = query.toLowerCase();
  // Check label
  if (nodeLabel(node).toLowerCase().includes(q)) return true;
  // Check type
  if (node.type.toLowerCase().includes(q)) return true;
  // Check all string property values
  for (const value of Object.values(node.properties)) {
    if (typeof value === "string" && value.toLowerCase().includes(q)) return true;
  }
  return false;
}

export function initSearch(container: HTMLElement) {
  let data: LearningGraphData | null = null;
  let filterCallback: ((ids: Set<string> | null) => void) | null = null;
  let selectCallback: ((nodeId: string) => void) | null = null;
  let activeTypes: Set<string> = new Set();
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  // --- DOM ---

  const overlay = document.createElement("div");
  overlay.className = "search-overlay hidden";

  const inputWrap = document.createElement("div");
  inputWrap.className = "search-input-wrap";

  const input = document.createElement("input");
  input.className = "search-input";
  input.type = "text";
  input.placeholder = "Search nodes...";
  input.setAttribute("autocomplete", "off");
  input.setAttribute("spellcheck", "false");

  const kbd = document.createElement("kbd");
  kbd.className = "search-kbd";
  kbd.textContent = "/";

  const chipToggle = document.createElement("button");
  chipToggle.className = "chip-toggle";
  chipToggle.setAttribute("aria-label", "Toggle filter chips");
  chipToggle.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>';
  let chipsVisible = false;

  chipToggle.addEventListener("click", () => {
    chipsVisible = !chipsVisible;
    chips.classList.toggle("hidden", !chipsVisible);
    chipToggle.classList.toggle("active", chipsVisible);
  });

  inputWrap.appendChild(input);
  inputWrap.appendChild(kbd);
  inputWrap.appendChild(chipToggle);

  const results = document.createElement("ul");
  results.className = "search-results hidden";

  const chips = document.createElement("div");
  chips.className = "type-chips hidden";

  overlay.appendChild(inputWrap);
  overlay.appendChild(results);
  overlay.appendChild(chips);
  container.appendChild(overlay);

  // --- Type chips ---

  function buildChips() {
    chips.innerHTML = "";
    if (!data) return;

    // Count nodes per type
    const typeCounts = new Map<string, number>();
    for (const node of data.nodes) {
      typeCounts.set(node.type, (typeCounts.get(node.type) ?? 0) + 1);
    }

    // Sort alphabetically
    const types = [...typeCounts.keys()].sort();
    activeTypes = new Set(); // None selected = show all

    for (const type of types) {
      const chip = document.createElement("button");
      chip.className = "type-chip";
      chip.dataset.type = type;

      const dot = document.createElement("span");
      dot.className = "type-chip-dot";
      dot.style.backgroundColor = getColor(type);

      const label = document.createElement("span");
      label.textContent = `${type} (${typeCounts.get(type)})`;

      chip.appendChild(dot);
      chip.appendChild(label);

      chip.addEventListener("click", () => {
        if (activeTypes.has(type)) {
          activeTypes.delete(type);
          chip.classList.remove("active");
        } else {
          activeTypes.add(type);
          chip.classList.add("active");
        }
        applyFilter();
      });

      chips.appendChild(chip);
    }
  }

  // --- Search + filter logic ---

  function getMatchingIds(): Set<string> | null {
    if (!data) return null;

    const query = input.value.trim();
    const noChipsSelected = activeTypes.size === 0;
    const noQuery = query.length === 0;

    // No filter active — return null (show all)
    if (noQuery && noChipsSelected) return null;

    const ids = new Set<string>();
    for (const node of data.nodes) {
      // If chips are selected, only include those types
      if (!noChipsSelected && !activeTypes.has(node.type)) continue;
      if (noQuery || matchesQuery(node, query)) {
        ids.add(node.id);
      }
    }
    return ids;
  }

  function applyFilter() {
    const ids = getMatchingIds();
    filterCallback?.(ids);
    updateResults();
  }

  function updateResults() {
    results.innerHTML = "";
    const query = input.value.trim();

    if (!data || query.length === 0) {
      results.classList.add("hidden");
      return;
    }

    const noChipsSelected = activeTypes.size === 0;
    const matches: Node[] = [];
    for (const node of data.nodes) {
      if (!noChipsSelected && !activeTypes.has(node.type)) continue;
      if (matchesQuery(node, query)) {
        matches.push(node);
        if (matches.length >= 8) break;
      }
    }

    if (matches.length === 0) {
      results.classList.add("hidden");
      return;
    }

    for (const node of matches) {
      const li = document.createElement("li");
      li.className = "search-result-item";

      const dot = document.createElement("span");
      dot.className = "search-result-dot";
      dot.style.backgroundColor = getColor(node.type);

      const label = document.createElement("span");
      label.className = "search-result-label";
      const text = nodeLabel(node);
      label.textContent = text.length > 36 ? text.slice(0, 34) + "..." : text;

      const type = document.createElement("span");
      type.className = "search-result-type";
      type.textContent = node.type;

      li.appendChild(dot);
      li.appendChild(label);
      li.appendChild(type);

      li.addEventListener("click", () => {
        selectCallback?.(node.id);
        input.value = "";
        results.classList.add("hidden");
        applyFilter();
      });

      results.appendChild(li);
    }

    results.classList.remove("hidden");
  }

  // --- Input events ---

  input.addEventListener("input", () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(applyFilter, 150);
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      input.value = "";
      input.blur();
      results.classList.add("hidden");
      applyFilter();
    } else if (e.key === "Enter") {
      // Select first result
      const first = results.querySelector(".search-result-item") as HTMLElement | null;
      first?.click();
    }
  });

  // Close results when clicking outside
  document.addEventListener("click", (e) => {
    if (!overlay.contains(e.target as HTMLElement)) {
      results.classList.add("hidden");
    }
  });

  // Hide kbd hint when focused
  input.addEventListener("focus", () => kbd.classList.add("hidden"));
  input.addEventListener("blur", () => {
    if (input.value.length === 0) kbd.classList.remove("hidden");
  });

  // --- Public API ---

  return {
    setLearningGraphData(newData: LearningGraphData | null) {
      data = newData;
      input.value = "";
      results.classList.add("hidden");
      if (data && data.nodes.length > 0) {
        overlay.classList.remove("hidden");
        buildChips();
      } else {
        overlay.classList.add("hidden");
      }
    },

    onFilterChange(cb: (ids: Set<string> | null) => void) {
      filterCallback = cb;
    },

    onNodeSelect(cb: (nodeId: string) => void) {
      selectCallback = cb;
    },

    clear() {
      input.value = "";
      results.classList.add("hidden");
      activeTypes.clear();
      chipsVisible = false;
      chips.classList.add("hidden");
      chipToggle.classList.remove("active");
      filterCallback?.(null);
    },

    focus() {
      input.focus();
    },
  };
}
