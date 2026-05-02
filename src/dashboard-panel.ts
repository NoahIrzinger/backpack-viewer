import type { Signal, LearningGraphSummary } from "backpack-ontology";
import type { DashboardSpec } from "./dashboard-spec.js";
import { DEFAULT_DASHBOARD } from "./dashboard-spec.js";
import { mountWidget } from "./dashboard-widgets.js";
import type { DashboardBridge, WidgetTeardown } from "./dashboard-widgets.js";
import type { PanelMount } from "./extensions/panel-mount.js";
import { listSignals, detectSignals, dismissSignal, getDashboard } from "./api.js";

async function loadGraphSummaries(): Promise<LearningGraphSummary[]> {
  try {
    const res = await fetch("/api/ontologies");
    if (!res.ok) return [];
    return res.json();
  } catch {
    return [];
  }
}

export function initDashboardPanel(panelMount: PanelMount): {
  show(): Promise<void>;
  hide(): void;
  reload(): Promise<void>;
} {
  const bodyEl = document.createElement("div");
  bodyEl.className = "dash-panel-root";

  const handle = panelMount.mount("dashboard", bodyEl, {
    title: "Dashboard",
    persistKey: "dashboard-panel",
    hideOnClose: true,
  });
  handle.setVisible(false);

  let signals: Signal[] = [];
  let graphSummaries: LearningGraphSummary[] = [];
  let spec: DashboardSpec = DEFAULT_DASHBOARD;
  let specVersion = "";
  let teardowns: WidgetTeardown[] = [];
  let pollTimer: ReturnType<typeof setInterval> | undefined;

  const bridge: DashboardBridge = {
    focusNodes(nodeIds, hops = 2) {
      window.dispatchEvent(new CustomEvent("backpack-dashboard-focus-nodes", { detail: { nodeIds, hops } }));
    },
    async dismissSignal(id) {
      await dismissSignal(id);
    },
    async reloadSignals() {
      await loadData();
      renderWidgets();
    },
    panToNode(nodeId) {
      window.dispatchEvent(new CustomEvent("backpack-dashboard-pan-to-node", { detail: { nodeId } }));
    },
  };

  function renderWidgets() {
    teardowns.forEach((t) => t());
    teardowns = [];

    const grid = bodyEl.querySelector(".dash-grid") as HTMLElement | null;
    if (!grid) return;

    grid.replaceChildren();
    grid.style.gridTemplateColumns = `repeat(${spec.grid.columns}, 1fr)`;

    const ctx = { signals, graphSummaries, bridge };

    for (const widget of spec.widgets) {
      const teardown = mountWidget(grid, widget, ctx);
      teardowns.push(teardown);
    }
  }

  function buildLayout() {
    bodyEl.replaceChildren();

    const toolbar = document.createElement("div");
    toolbar.className = "dash-toolbar";

    const detectBtn = document.createElement("button");
    detectBtn.type = "button";
    detectBtn.className = "dash-toolbar-btn";
    detectBtn.textContent = "Detect signals";
    detectBtn.addEventListener("click", async () => {
      detectBtn.disabled = true;
      detectBtn.textContent = "Detecting…";
      try {
        await detectSignals();
        await loadData(); // reload both signals and graph summaries
        renderWidgets();
      } finally {
        detectBtn.disabled = false;
        detectBtn.textContent = "Detect signals";
      }
    });

    const refreshBtn = document.createElement("button");
    refreshBtn.type = "button";
    refreshBtn.className = "dash-toolbar-btn";
    refreshBtn.textContent = "Refresh";
    refreshBtn.addEventListener("click", async () => {
      refreshBtn.disabled = true;
      try { await loadData(); renderWidgets(); } finally { refreshBtn.disabled = false; }
    });

    toolbar.appendChild(detectBtn);
    toolbar.appendChild(refreshBtn);
    bodyEl.appendChild(toolbar);

    const grid = document.createElement("div");
    grid.className = "dash-grid";
    grid.style.gridTemplateColumns = `repeat(${spec.grid.columns}, 1fr)`;
    grid.style.gap = `${spec.grid.gap}px`;
    bodyEl.appendChild(grid);

    renderWidgets();
  }

  async function loadData() {
    const [signalRes, graphRes] = await Promise.allSettled([
      listSignals(),
      loadGraphSummaries(),
    ]);
    if (signalRes.status === "fulfilled") signals = signalRes.value.signals;
    if (graphRes.status === "fulfilled") graphSummaries = graphRes.value;
  }

  async function loadSpec() {
    try {
      const result = await getDashboard();
      if (result && result.version !== specVersion) {
        specVersion = result.version;
        spec = result.spec ?? DEFAULT_DASHBOARD;
        return true;
      }
    } catch {
      spec = DEFAULT_DASHBOARD;
    }
    return false;
  }

  async function initialize() {
    await Promise.all([loadData(), loadSpec()]);
    buildLayout();
  }

  function startPoll() {
    if (pollTimer) return;
    pollTimer = setInterval(async () => {
      const changed = await loadSpec();
      if (changed) buildLayout();
    }, 3000);
  }

  function stopPoll() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = undefined; }
  }

  return {
    async show() {
      handle.setVisible(true);
      handle.bringToFront();
      await initialize();
      startPoll();
    },
    hide() {
      handle.setVisible(false);
      stopPoll();
    },
    async reload() {
      await loadData();
      renderWidgets();
    },
  };
}
