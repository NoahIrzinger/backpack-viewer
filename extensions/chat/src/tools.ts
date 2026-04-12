import type { ViewerExtensionAPI, LearningGraphNode } from "./viewer-api";
import type { ToolDefinition } from "./providers/types.js";

/**
 * Tool definitions handed to the LLM. These are vendor-neutral —
 * they're shaped like Anthropic's tool format because we're starting
 * with Claude, but the same shape is trivially adaptable to OpenAI's
 * function-calling format inside an OpenAI provider implementation.
 *
 * The execution side runs against `viewer` (the extension API), which
 * gives us auto-undo, auto-persist, and auto-rerender for free — the
 * same call paths the user's manual edits go through.
 */

export const TOOLS: ToolDefinition[] = [
  {
    name: "get_graph_summary",
    description:
      "Get a summary of the current learning graph: total nodes, total edges, and counts by node type. Use this first to understand what's in the graph before drilling in.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "search_nodes",
    description:
      "Search nodes in the current graph by a substring match against any string property. Returns up to 20 matching nodes with id, type, and label.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Substring to search for (case-insensitive)" },
        type: { type: "string", description: "Optional: restrict to nodes of this type" },
      },
      required: ["query"],
    },
  },
  {
    name: "get_node",
    description: "Get full details (all properties + type) for a specific node by id.",
    input_schema: {
      type: "object",
      properties: { nodeId: { type: "string" } },
      required: ["nodeId"],
    },
  },
  {
    name: "get_neighbors",
    description:
      "Get all nodes directly connected to the given node, with the edge type for each connection.",
    input_schema: {
      type: "object",
      properties: { nodeId: { type: "string" } },
      required: ["nodeId"],
    },
  },
  {
    name: "list_node_types",
    description: "List all distinct node types in the current graph with counts.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "add_node",
    description:
      "Add a new node to the current graph. Returns the new node id. Properties should follow the existing convention in the graph — use list_node_types and get_node first to see what shape similar nodes use.",
    input_schema: {
      type: "object",
      properties: {
        type: { type: "string", description: "Node type (freeform)" },
        properties: {
          type: "object",
          description: "Freeform key/value properties — usually includes a 'name' or 'title' field",
        },
      },
      required: ["type", "properties"],
    },
  },
  {
    name: "update_node",
    description:
      "Update properties on an existing node. Pass only the properties you want to change — others are preserved.",
    input_schema: {
      type: "object",
      properties: {
        nodeId: { type: "string" },
        properties: { type: "object" },
      },
      required: ["nodeId", "properties"],
    },
  },
  {
    name: "remove_node",
    description:
      "Delete a node and all edges touching it. This is destructive — confirm with the user first if the node is non-trivial.",
    input_schema: {
      type: "object",
      properties: { nodeId: { type: "string" } },
      required: ["nodeId"],
    },
  },
  {
    name: "add_edge",
    description: "Connect two existing nodes with a typed edge.",
    input_schema: {
      type: "object",
      properties: {
        sourceId: { type: "string" },
        targetId: { type: "string" },
        type: { type: "string", description: "Edge type (freeform, e.g. 'contains', 'depends_on')" },
      },
      required: ["sourceId", "targetId", "type"],
    },
  },
  {
    name: "remove_edge",
    description: "Delete an edge by id.",
    input_schema: {
      type: "object",
      properties: { edgeId: { type: "string" } },
      required: ["edgeId"],
    },
  },
  {
    name: "focus_nodes",
    description:
      "Tell the viewer to enter focus mode on the given seed nodes, expanding to N hops of neighbors. Call this when the user is asking about a specific region of the graph so they can see what you're talking about.",
    input_schema: {
      type: "object",
      properties: {
        nodeIds: { type: "array", items: { type: "string" } },
        hops: { type: "number", description: "Hop distance (default 1)" },
      },
      required: ["nodeIds"],
    },
  },
  {
    name: "pan_to_node",
    description: "Pan and zoom the viewer to a specific node.",
    input_schema: {
      type: "object",
      properties: { nodeId: { type: "string" } },
      required: ["nodeId"],
    },
  },
];

function labelOf(node: LearningGraphNode): string {
  const first = Object.values(node.properties).find((v) => typeof v === "string");
  return (first as string) ?? node.id;
}

/**
 * Execute one tool call against the viewer extension API. Returns a
 * string that gets fed back to the LLM as the tool_result. Throws on
 * bad input — the caller turns the error into a tool_result with
 * `is_error: true`.
 */
export async function executeTool(
  viewer: ViewerExtensionAPI,
  name: string,
  input: Record<string, unknown>,
): Promise<string> {
  const data = viewer.getGraph();
  if (!data) throw new Error("no graph loaded in viewer");

  switch (name) {
    case "get_graph_summary": {
      const typeCounts = new Map<string, number>();
      for (const n of data.nodes) {
        typeCounts.set(n.type, (typeCounts.get(n.type) ?? 0) + 1);
      }
      return JSON.stringify(
        {
          name: viewer.getGraphName(),
          nodeCount: data.nodes.length,
          edgeCount: data.edges.length,
          nodeTypes: Object.fromEntries(typeCounts),
        },
        null,
        2,
      );
    }

    case "search_nodes": {
      const query = String(input.query ?? "").toLowerCase();
      const filterType = input.type ? String(input.type) : null;
      if (!query) throw new Error("query is required");
      const matches: { id: string; type: string; label: string }[] = [];
      for (const n of data.nodes) {
        if (filterType && n.type !== filterType) continue;
        const haystack = Object.values(n.properties)
          .filter((v): v is string => typeof v === "string")
          .join(" ")
          .toLowerCase();
        if (haystack.includes(query) || n.id.toLowerCase().includes(query)) {
          matches.push({ id: n.id, type: n.type, label: labelOf(n) });
          if (matches.length >= 20) break;
        }
      }
      return JSON.stringify({ query, matchCount: matches.length, matches }, null, 2);
    }

    case "get_node": {
      const nodeId = String(input.nodeId ?? "");
      const node = data.nodes.find((n) => n.id === nodeId);
      if (!node) throw new Error(`node not found: ${nodeId}`);
      return JSON.stringify(node, null, 2);
    }

    case "get_neighbors": {
      const nodeId = String(input.nodeId ?? "");
      const node = data.nodes.find((n) => n.id === nodeId);
      if (!node) throw new Error(`node not found: ${nodeId}`);
      const neighbors: Array<{
        edgeId: string;
        edgeType: string;
        direction: "out" | "in";
        node: { id: string; type: string; label: string };
      }> = [];
      for (const e of data.edges) {
        if (e.sourceId === nodeId) {
          const other = data.nodes.find((n) => n.id === e.targetId);
          if (other) {
            neighbors.push({
              edgeId: e.id,
              edgeType: e.type,
              direction: "out",
              node: { id: other.id, type: other.type, label: labelOf(other) },
            });
          }
        } else if (e.targetId === nodeId) {
          const other = data.nodes.find((n) => n.id === e.sourceId);
          if (other) {
            neighbors.push({
              edgeId: e.id,
              edgeType: e.type,
              direction: "in",
              node: { id: other.id, type: other.type, label: labelOf(other) },
            });
          }
        }
      }
      return JSON.stringify(
        { nodeId, label: labelOf(node), neighborCount: neighbors.length, neighbors },
        null,
        2,
      );
    }

    case "list_node_types": {
      const counts = new Map<string, number>();
      for (const n of data.nodes) counts.set(n.type, (counts.get(n.type) ?? 0) + 1);
      return JSON.stringify(Object.fromEntries(counts), null, 2);
    }

    case "add_node": {
      const type = String(input.type ?? "");
      const properties = (input.properties ?? {}) as Record<string, unknown>;
      if (!type) throw new Error("type is required");
      const id = await viewer.addNode(type, properties);
      return JSON.stringify({ ok: true, id, type }, null, 2);
    }

    case "update_node": {
      const nodeId = String(input.nodeId ?? "");
      const properties = (input.properties ?? {}) as Record<string, unknown>;
      await viewer.updateNode(nodeId, properties);
      return JSON.stringify({ ok: true, id: nodeId }, null, 2);
    }

    case "remove_node": {
      const nodeId = String(input.nodeId ?? "");
      await viewer.removeNode(nodeId);
      return JSON.stringify({ ok: true, removed: nodeId }, null, 2);
    }

    case "add_edge": {
      const sourceId = String(input.sourceId ?? "");
      const targetId = String(input.targetId ?? "");
      const type = String(input.type ?? "");
      if (!sourceId || !targetId || !type) {
        throw new Error("sourceId, targetId, and type are required");
      }
      const id = await viewer.addEdge(sourceId, targetId, type);
      return JSON.stringify({ ok: true, id }, null, 2);
    }

    case "remove_edge": {
      const edgeId = String(input.edgeId ?? "");
      await viewer.removeEdge(edgeId);
      return JSON.stringify({ ok: true, removed: edgeId }, null, 2);
    }

    case "focus_nodes": {
      const nodeIds = (input.nodeIds ?? []) as string[];
      const hops = typeof input.hops === "number" ? input.hops : 1;
      if (nodeIds.length === 0) throw new Error("nodeIds is required");
      const valid = nodeIds.filter((id) => data.nodes.some((n) => n.id === id));
      if (valid.length === 0) throw new Error("no valid node ids in focus_nodes");
      viewer.focusNodes(valid, hops);
      return JSON.stringify({ ok: true, focused: valid, hops }, null, 2);
    }

    case "pan_to_node": {
      const nodeId = String(input.nodeId ?? "");
      const node = data.nodes.find((n) => n.id === nodeId);
      if (!node) throw new Error(`node not found: ${nodeId}`);
      viewer.panToNode(nodeId);
      return JSON.stringify({ ok: true, panned: nodeId }, null, 2);
    }

    default:
      throw new Error(`unknown tool: ${name}`);
  }
}
