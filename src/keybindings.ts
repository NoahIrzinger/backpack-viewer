export type KeybindingAction =
  | "search" | "searchAlt" | "undo" | "redo" | "help" | "escape"
  | "focus" | "toggleEdges" | "center"
  | "nextNode" | "prevNode" | "nextConnection" | "prevConnection"
  | "historyBack" | "historyForward"
  | "hopsIncrease" | "hopsDecrease"
  | "panLeft" | "panDown" | "panUp" | "panRight"
  | "panFastLeft" | "zoomOut" | "zoomIn" | "panFastRight"
  | "spacingDecrease" | "spacingIncrease"
  | "clusteringDecrease" | "clusteringIncrease"
  | "toggleSidebar"
  | "walkMode";

export type KeybindingMap = Record<KeybindingAction, string>;

/** Parse a binding string like "ctrl+shift+z" and check if it matches a KeyboardEvent. */
export function matchKey(e: KeyboardEvent, binding: string): boolean {
  const parts = binding.split("+");
  const key = parts.pop()!;
  const modifiers = parts.map((p) => p.toLowerCase());

  const needCtrl = modifiers.includes("ctrl") || modifiers.includes("cmd") || modifiers.includes("meta");
  const explicitShift = modifiers.includes("shift");
  const needAlt = modifiers.includes("alt");

  // Ctrl/meta check
  if (needCtrl !== (e.ctrlKey || e.metaKey)) return false;
  if (!needCtrl && (e.ctrlKey || e.metaKey)) return false;

  // Only enforce shift when explicitly in the binding (e.g. "ctrl+shift+z").
  // Plain chars like "K", ">", "?" implicitly require shift via their character.
  if (explicitShift && !e.shiftKey) return false;

  // Alt check
  if (needAlt !== e.altKey) return false;

  // Named keys
  if (key.toLowerCase() === "escape") return e.key === "Escape";
  if (key.toLowerCase() === "tab") return e.key === "Tab";

  // For modified bindings (ctrl+z, ctrl+shift+z), compare case-insensitively
  // because browsers vary on e.key casing when modifiers are held.
  if (modifiers.length > 0) return e.key.toLowerCase() === key.toLowerCase();

  // For plain keys, compare exactly — "k" vs "K" distinguishes shift state.
  return e.key === key;
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
    toggleSidebar: "Toggle sidebar",
    walkMode: "Toggle walk mode (in focus)",
  };
}
