import type { LearningGraphData } from "backpack-ontology";

const MAX_HISTORY = 30;

export function createHistory() {
  let undoStack: string[] = [];
  let redoStack: string[] = [];

  return {
    /** Call before mutating the data to snapshot the current state. */
    push(data: LearningGraphData) {
      undoStack.push(JSON.stringify(data));
      if (undoStack.length > MAX_HISTORY) undoStack.shift();
      redoStack = [];
    },

    undo(currentData: LearningGraphData): LearningGraphData | null {
      if (undoStack.length === 0) return null;
      redoStack.push(JSON.stringify(currentData));
      return JSON.parse(undoStack.pop()!);
    },

    redo(currentData: LearningGraphData): LearningGraphData | null {
      if (redoStack.length === 0) return null;
      undoStack.push(JSON.stringify(currentData));
      return JSON.parse(redoStack.pop()!);
    },

    canUndo(): boolean {
      return undoStack.length > 0;
    },

    canRedo(): boolean {
      return redoStack.length > 0;
    },

    clear() {
      undoStack = [];
      redoStack = [];
    },
  };
}
