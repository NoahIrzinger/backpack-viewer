import type { ColorSchemeName } from "./dashboard-theme.js";

export type WidgetType =
  | "stat-card"
  | "signal-cards"
  | "bar-chart"
  | "stacked-bar"
  | "line-chart"
  | "pie-chart"
  | "table";

export interface WidgetPosition {
  col: number;
  row: number;
  colSpan: number;
  rowSpan: number;
}

export interface GridConfig {
  columns: number;
  rowHeight: number;
  gap: number;
}

export type SignalGroupBy = "kind" | "severity" | "category" | "graphNames";
export type GraphGroupBy = "graphName" | "nodeType" | "edgeType";
export type CompositeGroupBy = ["graphName", "nodeType"] | ["graphName", "edgeType"];

export interface SignalFilter {
  severity?: string[];
  kind?: string[];
  graphNames?: string[];
}

export interface SignalQuery {
  source: "signals";
  metric: "count" | "avg_score";
  groupBy?: SignalGroupBy;
  filter?: SignalFilter;
  limit?: number;
}

export interface GraphQuery {
  source: "graphs";
  metric: "count";
  groupBy?: GraphGroupBy | CompositeGroupBy;
}

export type WidgetQuery = SignalQuery | GraphQuery;

export interface StatCardConfig {
  query: WidgetQuery;
  accentColor?: "accent" | "high" | "medium" | "critical" | "neutral";
  icon?: "alert" | "graph" | "nodes" | "edges" | "check";
}

export interface SignalCardsConfig {
  filter?: SignalFilter;
  limit?: number;
  showDismiss?: boolean;
  sortBy?: "score" | "severity";
  colorScheme?: ColorSchemeName;
}

export interface BarChartConfig {
  query: WidgetQuery;
  colorScheme?: ColorSchemeName;
  horizontal?: boolean;
}

export interface StackedBarConfig {
  query: GraphQuery & { groupBy: CompositeGroupBy };
  colorScheme?: ColorSchemeName;
}

export interface LineChartConfig {
  query: WidgetQuery;
  colorScheme?: ColorSchemeName;
  smooth?: boolean;
}

export interface PieChartConfig {
  query: WidgetQuery;
  colorScheme?: ColorSchemeName;
  donut?: boolean;
}

export interface TableConfig {
  query: WidgetQuery;
  columns?: string[];
  limit?: number;
}

export type WidgetConfig =
  | StatCardConfig
  | SignalCardsConfig
  | BarChartConfig
  | StackedBarConfig
  | LineChartConfig
  | PieChartConfig
  | TableConfig;

export interface WidgetSpec {
  id: string;
  type: WidgetType;
  title: string;
  position: WidgetPosition;
  config: WidgetConfig;
}

export interface SignalsViewSpec {
  version: 1;
  grid: GridConfig;
  widgets: WidgetSpec[];
}

export const DEFAULT_SIGNALS_VIEW: SignalsViewSpec = {
  version: 1,
  grid: { columns: 3, rowHeight: 200, gap: 12 },
  widgets: [
    {
      id: "w-total",
      type: "stat-card",
      title: "Active Signals",
      position: { col: 1, row: 1, colSpan: 1, rowSpan: 1 },
      config: { accentColor: "accent", query: { source: "signals", metric: "count" } } as StatCardConfig,
    },
    {
      id: "w-high",
      type: "stat-card",
      title: "High Priority",
      position: { col: 2, row: 1, colSpan: 1, rowSpan: 1 },
      config: { accentColor: "high", query: { source: "signals", metric: "count", filter: { severity: ["high", "critical"] } } } as StatCardConfig,
    },
    {
      id: "w-graphs",
      type: "stat-card",
      title: "Learning Graphs",
      position: { col: 3, row: 1, colSpan: 1, rowSpan: 1 },
      config: { accentColor: "neutral", query: { source: "graphs", metric: "count" } } as StatCardConfig,
    },
    {
      id: "w-by-kind",
      type: "bar-chart",
      title: "Signals by Type",
      position: { col: 1, row: 2, colSpan: 2, rowSpan: 1 },
      config: { horizontal: true, query: { source: "signals", groupBy: "kind", metric: "count", limit: 10 } } as BarChartConfig,
    },
    {
      id: "w-severity",
      type: "pie-chart",
      title: "By Severity",
      position: { col: 3, row: 2, colSpan: 1, rowSpan: 1 },
      config: { donut: true, query: { source: "signals", groupBy: "severity", metric: "count" } } as PieChartConfig,
    },
    {
      id: "w-signals",
      type: "signal-cards",
      title: "Active Signals",
      position: { col: 1, row: 3, colSpan: 3, rowSpan: 3 },
      config: { limit: 50, showDismiss: true, sortBy: "score" } as SignalCardsConfig,
    },
  ],
};
