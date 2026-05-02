import type { Signal } from "backpack-ontology";
import type { LearningGraphSummary } from "backpack-ontology";
import type { WidgetQuery, SignalFilter, GraphGroupBy, CompositeGroupBy } from "./signals-spec.js";
import { buildSeriesColors, SEVERITY_COLORS, getSeriesColor, getThemeValues } from "./dashboard-theme.js";

export interface SeriesData {
  name: string;
  data: number[];
  color?: string;
}

export interface ChartData {
  labels: string[];
  series: SeriesData[];
}

export interface StatValue {
  value: number;
  label: string;
}

const SEVERITY_ORDER = ["critical", "high", "medium", "low"];

function matchesFilter(signal: Signal, filter?: SignalFilter): boolean {
  if (!filter) return true;
  if (filter.severity?.length && !filter.severity.includes(signal.severity)) return false;
  if (filter.kind?.length && !filter.kind.includes(signal.kind as string)) return false;
  if (filter.graphNames?.length && !signal.graphNames.some((g) => filter.graphNames!.includes(g))) return false;
  return true;
}

export function resolveQuery(
  query: WidgetQuery,
  signals: Signal[],
  graphSummaries: LearningGraphSummary[],
): ChartData | StatValue {
  if (query.source === "signals") {
    return resolveSignalQuery(query as typeof query & { source: "signals" }, signals);
  }
  return resolveGraphQuery(query as typeof query & { source: "graphs" }, graphSummaries);
}

function resolveSignalQuery(
  query: Extract<WidgetQuery, { source: "signals" }>,
  signals: Signal[],
): ChartData | StatValue {
  const filtered = signals.filter((s) => matchesFilter(s, query.filter));

  if (!query.groupBy) {
    const value = query.metric === "count"
      ? filtered.length
      : filtered.length > 0 ? filtered.reduce((a, s) => a + s.score, 0) / filtered.length : 0;
    return { value: Math.round(value * 10) / 10, label: "" };
  }

  const counts = new Map<string, number>();
  const scores = new Map<string, number>();

  for (const s of filtered) {
    const keys: string[] =
      query.groupBy === "graphNames"
        ? (s.graphNames ?? [])
        : [String((s as unknown as Record<string, unknown>)[query.groupBy] ?? "unknown")];

    for (const key of keys) {
      counts.set(key, (counts.get(key) ?? 0) + 1);
      scores.set(key, (scores.get(key) ?? 0) + s.score);
    }
  }

  let labels = [...counts.keys()];
  if (query.groupBy === "severity") {
    labels = SEVERITY_ORDER.filter((s) => counts.has(s));
  } else {
    labels = labels.sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0));
  }

  if (query.limit) labels = labels.slice(0, query.limit);

  const data = labels.map((l) =>
    query.metric === "avg_score"
      ? Math.round((scores.get(l) ?? 0) / (counts.get(l) ?? 1) * 10) / 10
      : counts.get(l) ?? 0,
  );

  const colors = buildSeriesColors(labels, query.groupBy === "severity" ? "severity" : "kind");

  return {
    labels,
    series: [{ name: query.metric === "count" ? "Signals" : "Avg Score", data, color: undefined }],
    _perItemColors: colors,
  } as ChartData & { _perItemColors: string[] };
}

function resolveGraphQuery(
  query: Extract<WidgetQuery, { source: "graphs" }>,
  summaries: LearningGraphSummary[],
): ChartData | StatValue {
  if (!query.groupBy) {
    return { value: summaries.length, label: "" };
  }

  if (Array.isArray(query.groupBy)) {
    return resolveCompositeGroupBy(query.groupBy as CompositeGroupBy, summaries);
  }

  const gb = query.groupBy as GraphGroupBy;

  if (gb === "graphName") {
    const labels = summaries.map((s) => s.name);
    const data = summaries.map((s) => s.nodeCount);
    return { labels, series: [{ name: "Nodes", data }] };
  }

  if (gb === "nodeType") {
    const typeCounts = new Map<string, number>();
    for (const s of summaries) {
      for (const t of s.nodeTypes ?? []) {
        typeCounts.set(t.type, (typeCounts.get(t.type) ?? 0) + t.count);
      }
    }
    const labels = [...typeCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([t]) => t);
    const data = labels.map((t) => typeCounts.get(t) ?? 0);
    const colors = labels.map((t) => getSeriesColor(t));
    return { labels, series: [{ name: "Nodes", data }], _perItemColors: colors } as ChartData & { _perItemColors: string[] };
  }

  if (gb === "edgeType") {
    const typeCounts = new Map<string, number>();
    for (const s of summaries) {
      for (const t of (s as LearningGraphSummary & { edgeTypes?: { type: string; count: number }[] }).edgeTypes ?? []) {
        typeCounts.set(t.type, (typeCounts.get(t.type) ?? 0) + t.count);
      }
    }
    const labels = [...typeCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([t]) => t);
    const data = labels.map((t) => typeCounts.get(t) ?? 0);
    return { labels, series: [{ name: "Edges", data }] };
  }

  return { labels: [], series: [] };
}

function resolveCompositeGroupBy(
  groupBy: CompositeGroupBy,
  summaries: LearningGraphSummary[],
): ChartData {
  const [_primaryKey, secondaryKey] = groupBy;
  const useNodeTypes = secondaryKey === "nodeType";

  const graphNames = summaries.map((s) => s.name);
  const allTypes = new Set<string>();

  type SummaryWithEdges = LearningGraphSummary & { edgeTypes?: { type: string; count: number }[] };

  for (const s of summaries) {
    const items = useNodeTypes
      ? (s.nodeTypes ?? [])
      : ((s as SummaryWithEdges).edgeTypes ?? []);
    for (const t of items) allTypes.add(t.type);
  }

  const typeList = [...allTypes].slice(0, 8);
  const series: SeriesData[] = typeList.map((type) => ({
    name: type,
    data: summaries.map((s) => {
      const items = useNodeTypes
        ? (s.nodeTypes ?? [])
        : ((s as SummaryWithEdges).edgeTypes ?? []);
      return items.find((x) => x.type === type)?.count ?? 0;
    }),
    color: getSeriesColor(type),
  }));

  return { labels: graphNames, series };
}

export function filterSignals(signals: Signal[], filter?: SignalFilter, search?: string): Signal[] {
  return signals.filter((s) => {
    if (!matchesFilter(s, filter)) return false;
    if (search) {
      const q = search.toLowerCase();
      return (
        s.title.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        s.graphNames.some((g) => g.toLowerCase().includes(q)) ||
        (s.kind as string).toLowerCase().includes(q)
      );
    }
    return true;
  });
}

export function sortSignals(signals: Signal[], sortBy?: "score" | "severity"): Signal[] {
  if (sortBy === "severity") {
    return [...signals].sort((a, b) => {
      const ai = SEVERITY_ORDER.indexOf(a.severity);
      const bi = SEVERITY_ORDER.indexOf(b.severity);
      return ai !== bi ? ai - bi : b.score - a.score;
    });
  }
  return [...signals].sort((a, b) => b.score - a.score);
}
