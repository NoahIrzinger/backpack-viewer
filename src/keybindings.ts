export type KeybindingAction =
  | "search" | "searchAlt" | "undo" | "redo" | "help" | "escape"
  | "focus" | "toggleEdges" | "center"
  | "nextNode" | "prevNode" | "nextConnection" | "prevConnection"
  | "historyBack" | "historyForward"
  | "hopsIncrease" | "hopsDecrease"
  | "panLeft" | "panDown" | "panUp" | "panRight"
  | "panFastLeft" | "zoomOut" | "zoomIn" | "panFastRight"
  | "spacingDecrease" | "spacingIncrease"
  | "clusteringDecrease" | "clusteringIncrease";

export type KeybindingMap = Record<KeybindingAction, string>;

/** Parse a binding string like "ctrl+shift+z" and check if it matches a KeyboardEvent. */
export function matchKey(e: KeyboardEvent, binding: string): boolean {
  const parts = binding.toLowerCase().split("+");
  const key = parts.pop()!;
  const needCtrl = parts.includes("ctrl") || parts.includes("cmd") || parts.includes("meta");
  const needShift = parts.includes("shift");
  const needAlt = parts.includes("alt");

  // Modifier checks
  if (needCtrl !== (e.ctrlKey || e.metaKey)) return false;
  if (needShift !== e.shiftKey) return false;
  if (needAlt !== e.altKey) return false;

  // For plain keys (no modifiers required), reject if ctrl/meta is held
  if (!needCtrl && (e.ctrlKey || e.metaKey)) return false;

  // Key match — case-sensitive for single chars, case-insensitive for named keys
  if (key === "escape") return e.key === "Escape";
  if (key.length === 1) return e.key === binding.split("+").pop()!; // preserve original case
  return e.key.toLowerCase() === key;
}

/** Build a reverse map: for each action, store its binding string. Used by the help modal. */
export function actionDescriptions(): Record<KeybindingAction, string> {
  return {
    search: "Focus search",
    searchAlt: "Focus search (alt)",
    undo: "Undo",
    redo: "Redo",
    help: "Toggle help",
    escape: "Exit focus / close panel",
    focus: "Focus on selected / exit focus",
    toggleEdges: "Toggle edges on/off",
    center: "Center view on graph",
    nextNode: "Next node in view",
    prevNode: "Previous node in view",
    nextConnection: "Next connection",
    prevConnection: "Previous connection",
    historyBack: "Node history back",
    historyForward: "Node history forward",
    hopsIncrease: "Increase hops",
    hopsDecrease: "Decrease hops",
    panLeft: "Pan left",
    panDown: "Pan down",
    panUp: "Pan up",
    panRight: "Pan right",
    panFastLeft: "Pan fast left",
    zoomOut: "Zoom out",
    zoomIn: "Zoom in",
    panFastRight: "Pan fast right",
    spacingDecrease: "Decrease spacing",
    spacingIncrease: "Increase spacing",
    clusteringDecrease: "Decrease clustering",
    clusteringIncrease: "Increase clustering",
  };
}
