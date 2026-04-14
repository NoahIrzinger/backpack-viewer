import type { LearningGraphData, Node, KBDocumentSummary } from "backpack-ontology";
import { getColor } from "./colors";
import { searchKBDocuments } from "./api";

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
  if (nodeLabel(node).toLowerCase().includes(q)) return true;
  if (node.type.toLowerCase().includes(q)) return true;
  for (const value of Object.values(node.properties)) {
    if (typeof value === "string" && value.toLowerCase().includes(q)) return true;
  }
  return false;
}

export interface SearchConfig {
  maxResults?: number;
  debounceMs?: number;
}

export function initSearch(container: HTMLElement, config?: SearchConfig) {
  const maxResults = config?.maxResults ?? 8;
  const debounceMs = config?.debounceMs ?? 150;
  let data: LearningGraphData | null = null;
  let filterCallback: ((ids: Set<string> | null) => void) | null = null;
  let selectCallback: ((nodeId: string) => void) | null = null;
  let kbSelectCallback: ((docId: string) => void) | null = null;
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

  inputWrap.appendChild(input);
  inputWrap.appendChild(kbd);

  const results = document.createElement("ul");
  results.className = "search-results hidden";

  overlay.appendChild(inputWrap);
  overlay.appendChild(results);
  container.appendChild(overlay);

  // --- Search logic ---

  function getMatchingIds(): Set<string> | null {
    if (!data) return null;
    const query = input.value.trim();
    if (query.length === 0) return null;

    const ids = new Set<string>();
    for (const node of data.nodes) {
      if (matchesQuery(node, query)) ids.add(node.id);
    }
    return ids;
  }

  function applyFilter() {
    const ids = getMatchingIds();
    filterCallback?.(ids);
    updateResults();
  }

  function updateResults() {
    results.replaceChildren();
    activeIndex = -1;
    const query = input.value.trim();

    if (!data || query.length === 0) {
      results.classList.add("hidden");
      return;
    }

    const matches: Node[] = [];
    for (const node of data.nodes) {
      if (matchesQuery(node, query)) {
        matches.push(node);
        if (matches.length >= maxResults) break;
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

    // KB document results (appended after node results)
    searchKBDocuments(query, { limit: 4 }).then((kbResult) => {
      if (input.value.trim().toLowerCase() !== query.toLowerCase()) return; // stale
      if (kbResult.documents.length === 0) return;

      for (const doc of kbResult.documents) {
        const li = document.createElement("li");
        li.className = "search-result-item search-result-kb";

        const dot = document.createElement("span");
        dot.className = "search-result-dot";
        dot.style.backgroundColor = "var(--accent)";

        const label = document.createElement("span");
        label.className = "search-result-label";
        const text = doc.title;
        label.textContent = text.length > 30 ? text.slice(0, 28) + "..." : text;

        const badge = document.createElement("span");
        badge.className = "search-result-kb-badge";
        badge.textContent = "KB";

        li.appendChild(dot);
        li.appendChild(label);
        li.appendChild(badge);

        li.addEventListener("click", () => {
          kbSelectCallback?.(doc.id);
          input.value = "";
          results.classList.add("hidden");
          applyFilter();
        });

        results.appendChild(li);
      }
    }).catch(() => {});

    results.classList.remove("hidden");
  }

  // --- Input events ---

  input.addEventListener("input", () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(applyFilter, debounceMs);
  });

  let activeIndex = -1;

  function updateActiveResult() {
    const items = results.querySelectorAll(".search-result-item");
    items.forEach((el, i) => {
      (el as HTMLElement).classList.toggle("search-result-active", i === activeIndex);
    });
    if (activeIndex >= 0 && items[activeIndex]) {
      (items[activeIndex] as HTMLElement).scrollIntoView({ block: "nearest" });
    }
  }

  input.addEventListener("keydown", (e) => {
    const items = results.querySelectorAll(".search-result-item");
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (items.length > 0) {
        activeIndex = Math.min(activeIndex + 1, items.length - 1);
        updateActiveResult();
      }
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (items.length > 0) {
        activeIndex = Math.max(activeIndex - 1, 0);
        updateActiveResult();
      }
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (activeIndex >= 0 && items[activeIndex]) {
        (items[activeIndex] as HTMLElement).click();
      } else if (items.length > 0) {
        (items[0] as HTMLElement).click();
      }
      input.blur();
    } else if (e.key === "Escape") {
      input.value = "";
      input.blur();
      results.classList.add("hidden");
      activeIndex = -1;
      applyFilter();
    }
  });

  document.addEventListener("click", (e) => {
    if (!overlay.contains(e.target as HTMLElement)) {
      results.classList.add("hidden");
    }
  });

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

    onKBDocSelect(cb: (docId: string) => void) {
      kbSelectCallback = cb;
    },

    clear() {
      input.value = "";
      results.classList.add("hidden");
      filterCallback?.(null);
    },

    focus() {
      input.focus();
    },
  };
}
