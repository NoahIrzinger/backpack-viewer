import type { LearningGraphData, LearningGraphSummary, KBDocumentSummary, KBListResult, KBMountInfo, KBDocument, SignalResult } from "backpack-ontology";

export async function listOntologies(): Promise<LearningGraphSummary[]> {
  const res = await fetch("/api/ontologies");
  if (!res.ok) return [];
  return res.json();
}

export async function loadOntology(name: string): Promise<LearningGraphData> {
  const res = await fetch(`/api/ontologies/${encodeURIComponent(name)}`);
  if (!res.ok) throw new Error(`Failed to load ontology: ${name}`);
  return res.json();
}

// --- Remote graphs ---

export interface RemoteSummary {
  name: string;
  url: string;
  source?: string;
  addedAt: string;
  lastFetched: string;
  pinned: boolean;
  sizeBytes: number;
  nodeCount: number;
  edgeCount: number;
}

export async function listRemotes(): Promise<RemoteSummary[]> {
  const res = await fetch("/api/remotes");
  if (!res.ok) return [];
  return res.json();
}

export async function loadRemote(name: string): Promise<LearningGraphData> {
  const res = await fetch(`/api/remotes/${encodeURIComponent(name)}`);
  if (!res.ok) throw new Error(`Failed to load remote graph: ${name}`);
  return res.json();
}

export async function saveOntology(
  name: string,
  data: LearningGraphData
): Promise<void> {
  const res = await fetch(`/api/ontologies/${encodeURIComponent(name)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`Failed to save ontology: ${name}`);
}

export async function renameOntology(
  oldName: string,
  newName: string
): Promise<void> {
  const res = await fetch(
    `/api/ontologies/${encodeURIComponent(oldName)}/rename`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newName }),
    }
  );
  if (!res.ok) throw new Error(`Failed to rename ontology: ${oldName}`);
}

// --- Branch API ---

export interface BranchInfo {
  name: string;
  nodeCount: number;
  edgeCount: number;
  active: boolean;
}

export async function listBranches(graphName: string): Promise<BranchInfo[]> {
  const res = await fetch(`/api/graphs/${encodeURIComponent(graphName)}/branches`);
  if (!res.ok) return [];
  return res.json();
}

export async function createBranch(graphName: string, branchName: string, from?: string): Promise<void> {
  const res = await fetch(`/api/graphs/${encodeURIComponent(graphName)}/branches`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: branchName, from }),
  });
  if (!res.ok) {
    const d = await res.json().catch(() => ({}));
    throw new Error((d as any).error || "Failed to create branch");
  }
}

export async function switchBranch(graphName: string, branchName: string): Promise<void> {
  const res = await fetch(`/api/graphs/${encodeURIComponent(graphName)}/branches/switch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: branchName }),
  });
  if (!res.ok) {
    const d = await res.json().catch(() => ({}));
    throw new Error((d as any).error || "Failed to switch branch");
  }
}

export async function deleteBranch(graphName: string, branchName: string): Promise<void> {
  const res = await fetch(`/api/graphs/${encodeURIComponent(graphName)}/branches/${encodeURIComponent(branchName)}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    const d = await res.json().catch(() => ({}));
    throw new Error((d as any).error || "Failed to delete branch");
  }
}

// --- Snapshot API ---

export interface SnapshotInfo {
  version: number;
  timestamp: string;
  nodeCount: number;
  edgeCount: number;
  label?: string;
}

export async function listSnapshots(graphName: string): Promise<SnapshotInfo[]> {
  const res = await fetch(`/api/graphs/${encodeURIComponent(graphName)}/snapshots`);
  if (!res.ok) return [];
  return res.json();
}

export async function createSnapshot(graphName: string, label?: string): Promise<void> {
  const res = await fetch(`/api/graphs/${encodeURIComponent(graphName)}/snapshots`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label }),
  });
  if (!res.ok) {
    const d = await res.json().catch(() => ({}));
    throw new Error((d as any).error || "Failed to create snapshot");
  }
}

export async function rollbackSnapshot(graphName: string, version: number): Promise<void> {
  const res = await fetch(`/api/graphs/${encodeURIComponent(graphName)}/rollback`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ version }),
  });
  if (!res.ok) {
    const d = await res.json().catch(() => ({}));
    throw new Error((d as any).error || "Failed to rollback");
  }
}

export interface DiffResult {
  nodesAdded: number;
  nodesRemoved: number;
  edgesAdded: number;
  edgesRemoved: number;
}

export async function diffSnapshot(graphName: string, version: number): Promise<DiffResult> {
  const res = await fetch(`/api/graphs/${encodeURIComponent(graphName)}/diff/${version}`);
  if (!res.ok) throw new Error("Failed to compute diff");
  return res.json();
}

// --- Snippet API ---

export interface SnippetSummary {
  id: string;
  label: string;
  description: string;
  nodeCount: number;
  edgeCount: number;
  createdAt: string;
}

export async function listSnippets(graphName: string): Promise<SnippetSummary[]> {
  const res = await fetch(`/api/graphs/${encodeURIComponent(graphName)}/snippets`);
  if (!res.ok) return [];
  return res.json();
}

export async function saveSnippet(graphName: string, label: string, nodeIds: string[], edgeIds: string[], description?: string): Promise<string> {
  const res = await fetch(`/api/graphs/${encodeURIComponent(graphName)}/snippets`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label, description, nodeIds, edgeIds }),
  });
  if (!res.ok) throw new Error("Failed to save snippet");
  const data = await res.json();
  return data.id;
}

export async function loadSnippet(graphName: string, snippetId: string): Promise<any> {
  const res = await fetch(`/api/graphs/${encodeURIComponent(graphName)}/snippets/${encodeURIComponent(snippetId)}`);
  if (!res.ok) throw new Error("Snippet not found");
  return res.json();
}

export async function deleteSnippet(graphName: string, snippetId: string): Promise<void> {
  const res = await fetch(`/api/graphs/${encodeURIComponent(graphName)}/snippets/${encodeURIComponent(snippetId)}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error("Failed to delete snippet");
}

// --- Knowledge Base API ---

export async function listKBDocuments(opts?: {
  collection?: string;
  limit?: number;
  offset?: number;
}): Promise<KBListResult> {
  const params = new URLSearchParams();
  if (opts?.collection) params.set("collection", opts.collection);
  if (opts?.limit != null) params.set("limit", String(opts.limit));
  if (opts?.offset != null) params.set("offset", String(opts.offset));
  const qs = params.toString();
  const res = await fetch(`/api/kb/documents${qs ? `?${qs}` : ""}`);
  if (!res.ok) return { documents: [], total: 0, hasMore: false };
  return res.json();
}

export async function readKBDocument(id: string): Promise<KBDocument> {
  const res = await fetch(`/api/kb/documents/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`Document not found: ${id}`);
  return res.json();
}

export async function deleteKBDocument(id: string): Promise<void> {
  const res = await fetch(`/api/kb/documents/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error("Failed to delete document");
}

export async function searchKBDocuments(query: string, opts?: {
  collection?: string;
  limit?: number;
}): Promise<KBListResult> {
  const params = new URLSearchParams({ q: query });
  if (opts?.collection) params.set("collection", opts.collection);
  if (opts?.limit != null) params.set("limit", String(opts.limit));
  const res = await fetch(`/api/kb/search?${params}`);
  if (!res.ok) return { documents: [], total: 0, hasMore: false };
  return res.json();
}

export async function listKBMounts(): Promise<KBMountInfo[]> {
  const res = await fetch("/api/kb/mounts");
  if (!res.ok) return [];
  return res.json();
}

// --- Signals ---

export async function listSignals(opts?: {
  graph?: string;
  kind?: string;
  severity?: string;
  query?: string;
}): Promise<SignalResult> {
  const params = new URLSearchParams();
  if (opts?.graph) params.set("graph", opts.graph);
  if (opts?.kind) params.set("kind", opts.kind);
  if (opts?.severity) params.set("severity", opts.severity);
  if (opts?.query) params.set("q", opts.query);
  const qs = params.toString();
  const res = await fetch(`/api/signals${qs ? `?${qs}` : ""}`);
  if (!res.ok) return { signals: [], dismissed: 0, computedAt: "" };
  return res.json();
}

export async function detectSignals(): Promise<SignalResult> {
  const res = await fetch("/api/signals/detect", { method: "POST" });
  if (!res.ok) return { signals: [], dismissed: 0, computedAt: "" };
  return res.json();
}

export async function dismissSignal(signalId: string): Promise<void> {
  await fetch("/api/signals/dismiss", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ signalId }),
  });
}
