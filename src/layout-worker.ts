/**
 * Web Worker for off-main-thread force-directed layout.
 *
 * Runs the tick loop in a worker thread so physics never blocks
 * the main thread's rendering or input handling.
 *
 * Protocol:
 *   Main → Worker:
 *     { type: 'start', nodes, edges, params }  — begin simulation
 *     { type: 'stop' }                          — halt simulation
 *     { type: 'params', params }                — update layout params + reheat
 *
 *   Worker → Main:
 *     { type: 'tick', positions: Float64Array, alpha }  — position update per tick
 *     { type: 'settled' }                                — simulation converged
 */

import { createLayout, tick, setLayoutParams, autoLayoutParams, type LayoutParams, type LayoutNode, type LayoutEdge } from "./layout.js";
import type { LearningGraphData } from "backpack-ontology";

const ALPHA_MIN = 0.001;
const TICK_BATCH = 3; // ticks per message to reduce postMessage overhead

let running = false;
let state: ReturnType<typeof createLayout> | null = null;
let alpha = 1;

function packPositions(nodes: LayoutNode[]): Float64Array {
  const buf = new Float64Array(nodes.length * 4);
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    buf[i * 4] = n.x;
    buf[i * 4 + 1] = n.y;
    buf[i * 4 + 2] = n.vx;
    buf[i * 4 + 3] = n.vy;
  }
  return buf;
}

function runLoop() {
  if (!running || !state) return;

  for (let i = 0; i < TICK_BATCH; i++) {
    if (alpha < ALPHA_MIN) {
      running = false;
      const positions = packPositions(state.nodes);
      self.postMessage({ type: "tick", positions, alpha }, { transfer: [positions.buffer] });
      self.postMessage({ type: "settled" });
      return;
    }
    alpha = tick(state, alpha);
  }

  const positions = packPositions(state.nodes);
  self.postMessage({ type: "tick", positions, alpha }, { transfer: [positions.buffer] });

  // Yield to allow incoming messages, then continue
  setTimeout(runLoop, 0);
}

self.onmessage = (e: MessageEvent) => {
  const msg = e.data;

  if (msg.type === "start") {
    running = false; // stop any existing loop

    const data: LearningGraphData = msg.data;
    const params: Partial<LayoutParams> | undefined = msg.params;

    // Auto-scale params based on graph size, then apply overrides
    const auto = autoLayoutParams(data.nodes.length);
    setLayoutParams({ ...auto, ...params });

    state = createLayout(data);
    alpha = 1;
    running = true;
    runLoop();
  }

  if (msg.type === "stop") {
    running = false;
  }

  if (msg.type === "params") {
    setLayoutParams(msg.params);
    // Reheat simulation
    alpha = Math.max(alpha, 0.3);
    if (!running && state) {
      running = true;
      runLoop();
    }
  }
};
