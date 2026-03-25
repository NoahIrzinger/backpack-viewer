import type { LearningGraphData, LearningGraphSummary } from "backpack-ontology";

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
