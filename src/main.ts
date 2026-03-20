import type { OntologyData } from "backpack-ontology";
import { listOntologies, loadOntology } from "./api";
import { initSidebar } from "./sidebar";
import { initCanvas } from "./canvas";
import { initInfoPanel } from "./info-panel";
import "./style.css";

let activeOntology = "";
let currentData: OntologyData | null = null;

async function main() {
  const infoPanel = initInfoPanel(
    document.getElementById("canvas-container")!
  );

  const canvas = initCanvas(
    document.getElementById("canvas-container")!,
    (nodeId) => {
      if (nodeId && currentData) {
        infoPanel.show(nodeId, currentData);
      } else {
        infoPanel.hide();
      }
    }
  );

  const sidebar = initSidebar(
    document.getElementById("sidebar")!,
    async (name) => {
      activeOntology = name;
      sidebar.setActive(name);
      infoPanel.hide();
      currentData = await loadOntology(name);
      canvas.loadGraph(currentData);
    }
  );

  // Load ontology list
  const summaries = await listOntologies();
  sidebar.setSummaries(summaries);

  // Auto-load first ontology
  if (summaries.length > 0) {
    activeOntology = summaries[0].name;
    sidebar.setActive(activeOntology);
    currentData = await loadOntology(activeOntology);
    canvas.loadGraph(currentData);
  }

  // Live reload — when Claude adds nodes via MCP, re-fetch and re-render
  if (import.meta.hot) {
    import.meta.hot.on("ontology-change", async () => {
      const updated = await listOntologies();
      sidebar.setSummaries(updated);

      if (activeOntology) {
        try {
          currentData = await loadOntology(activeOntology);
          canvas.loadGraph(currentData);
        } catch {
          // Ontology may have been deleted
        }
      }
    });
  }
}

main();
