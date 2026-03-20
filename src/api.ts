import type { OntologyData, OntologySummary } from "backpack-ontology";

export async function listOntologies(): Promise<OntologySummary[]> {
  const res = await fetch("/api/ontologies");
  if (!res.ok) return [];
  return res.json();
}

export async function loadOntology(name: string): Promise<OntologyData> {
  const res = await fetch(`/api/ontologies/${encodeURIComponent(name)}`);
  if (!res.ok) throw new Error(`Failed to load ontology: ${name}`);
  return res.json();
}
