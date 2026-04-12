import type { ViewerEvent } from "./types";

/**
 * Tiny pub/sub for viewer events. Used by main.ts to emit and by the
 * extension API to subscribe. Synchronous — handlers run in registration
 * order on the same tick as the emit. Errors in one handler don't affect
 * others.
 */
export interface EventBus {
  emit(event: ViewerEvent): void;
  subscribe(event: ViewerEvent, cb: () => void): () => void;
}

export function createEventBus(): EventBus {
  const handlers = new Map<ViewerEvent, Set<() => void>>();

  return {
    emit(event) {
      const set = handlers.get(event);
      if (!set) return;
      for (const cb of set) {
        try {
          cb();
        } catch (err) {
          console.error(`[backpack-viewer] event handler for ${event} threw:`, err);
        }
      }
    },

    subscribe(event, cb) {
      let set = handlers.get(event);
      if (!set) {
        set = new Set();
        handlers.set(event, set);
      }
      set.add(cb);
      return () => {
        const s = handlers.get(event);
        s?.delete(cb);
      };
    },
  };
}
