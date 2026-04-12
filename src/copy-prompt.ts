import type { LearningGraphData } from "backpack-ontology";
import { showToast } from "./dialog";

export interface CopyPromptContext {
  graphName: string;
  data: LearningGraphData | null;
  selection: string[];
  focus: { seedNodeIds: string[]; hops: number } | null;
}

/**
 * "Copy Prompt" button — universal floor for users with no in-viewer chat
 * and no MCP-capable client. Builds a prompt that describes the current
 * view (graph, selection, focus) and copies it to the clipboard so the
 * user can paste into Claude.ai web, Claude Desktop, or anywhere else.
 */
export function initCopyPromptButton(getCtx: () => CopyPromptContext): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.className = "copy-prompt-btn";
  btn.title = "Copy a prompt about the current view to clipboard";
  btn.textContent = "Copy Prompt";
  btn.addEventListener("click", async () => {
    const ctx = getCtx();
    if (!ctx.graphName || !ctx.data) {
      showToast("No graph loaded");
      return;
    }
    const prompt = buildPrompt(ctx);
    try {
      await navigator.clipboard.writeText(prompt);
      showToast("Prompt copied — paste into Claude");
    } catch {
      showToast("Failed to copy to clipboard");
    }
  });
  return btn;
}

function labelOf(node: { id: string; properties: Record<string, unknown> }): string {
  const first = Object.values(node.properties).find((v) => typeof v === "string");
  return (first as string) ?? node.id;
}

function buildPrompt(ctx: CopyPromptContext): string {
  const { graphName, data, selection, focus } = ctx;
  const lines: string[] = [];
  lines.push(`I'm looking at the Backpack learning graph "${graphName}" in the viewer.`);
  lines.push(
    `It has ${data!.nodes.length} nodes and ${data!.edges.length} edges.`
  );

  const typeCounts = new Map<string, number>();
  for (const n of data!.nodes) {
    typeCounts.set(n.type, (typeCounts.get(n.type) ?? 0) + 1);
  }
  if (typeCounts.size > 0) {
    const summary = Array.from(typeCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([t, c]) => `${t} (${c})`)
      .join(", ");
    lines.push(`Node types: ${summary}`);
  }

  if (focus && focus.seedNodeIds.length > 0) {
    lines.push("");
    lines.push(`I'm focused on ${focus.seedNodeIds.length} seed node(s) at ${focus.hops} hop(s):`);
    for (const id of focus.seedNodeIds.slice(0, 10)) {
      const node = data!.nodes.find((n) => n.id === id);
      if (!node) continue;
      lines.push(`- ${labelOf(node)} (type: ${node.type})`);
    }
  }

  if (selection.length > 0) {
    lines.push("");
    lines.push(`I have ${selection.length} node(s) selected:`);
    for (const id of selection.slice(0, 20)) {
      const node = data!.nodes.find((n) => n.id === id);
      if (!node) continue;
      const props = Object.entries(node.properties)
        .filter(([k]) => !k.startsWith("_"))
        .slice(0, 5)
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
        .join(", ");
      lines.push(`- ${labelOf(node)} (type: ${node.type}, id: ${id}${props ? `, ${props}` : ""})`);
    }
  }

  lines.push("");
  lines.push(
    "If you have access to the Backpack MCP tools, please use them to answer questions about this graph (backpack_get_node, backpack_get_neighbors, backpack_search, etc)."
  );
  lines.push("");
  lines.push("My question: ");
  return lines.join("\n");
}
