import type { KBDocument } from "backpack-ontology";
import type { MountedPanel } from "./extensions/types";
import type { PanelMount } from "./extensions/panel-mount";
import { readKBDocument } from "./api";
import { renderMarkdown } from "./markdown";

export function initKBPanel(panelMount: PanelMount) {
  const bodyEl = document.createElement("div");
  bodyEl.className = "kb-panel-content";

  const handle: MountedPanel = panelMount.mount("kb-document", bodyEl, {
    title: "Document",
    persistKey: "kb-panel",
    hideOnClose: true,
  });
  handle.setVisible(false);

  let viewMode: "preview" | "raw" = "preview";

  function renderDoc(doc: KBDocument) {
    bodyEl.replaceChildren();

    // Title
    const title = document.createElement("h3");
    title.className = "kb-panel-title";
    title.textContent = doc.title;
    bodyEl.appendChild(title);

    // Metadata row
    const meta = document.createElement("div");
    meta.className = "kb-panel-meta";

    if (doc.collection) {
      const collBadge = document.createElement("span");
      collBadge.className = "kb-panel-badge";
      collBadge.textContent = doc.collection;
      meta.appendChild(collBadge);
    }

    if (doc.tags.length > 0) {
      for (const tag of doc.tags) {
        const tagEl = document.createElement("span");
        tagEl.className = "kb-panel-tag";
        tagEl.textContent = tag;
        meta.appendChild(tagEl);
      }
    }

    bodyEl.appendChild(meta);

    // Source graphs
    if (doc.sourceGraphs.length > 0) {
      const sources = document.createElement("div");
      sources.className = "kb-panel-sources";
      sources.textContent = `From: ${doc.sourceGraphs.join(", ")}`;
      bodyEl.appendChild(sources);
    }

    // Timestamps
    const timestamps = document.createElement("div");
    timestamps.className = "kb-panel-timestamps";
    const parts: string[] = [];
    if (doc.createdAt) parts.push(`Created: ${new Date(doc.createdAt).toLocaleDateString()}`);
    if (doc.updatedAt) parts.push(`Updated: ${new Date(doc.updatedAt).toLocaleDateString()}`);
    timestamps.textContent = parts.join(" · ");
    bodyEl.appendChild(timestamps);

    // Preview/Raw toggle
    const toggle = document.createElement("div");
    toggle.className = "kb-content-toggle";

    const previewBtn = document.createElement("button");
    previewBtn.className = "kb-content-toggle-btn" + (viewMode === "preview" ? " active" : "");
    previewBtn.type = "button";
    previewBtn.textContent = "Preview";

    const rawBtn = document.createElement("button");
    rawBtn.className = "kb-content-toggle-btn" + (viewMode === "raw" ? " active" : "");
    rawBtn.type = "button";
    rawBtn.textContent = "Raw";

    toggle.appendChild(previewBtn);
    toggle.appendChild(rawBtn);
    bodyEl.appendChild(toggle);

    // Content area
    const contentArea = document.createElement("div");

    function renderContent() {
      contentArea.replaceChildren();
      if (viewMode === "preview") {
        contentArea.appendChild(renderMarkdown(doc.content));
      } else {
        const raw = document.createElement("div");
        raw.className = "kb-panel-body";
        raw.textContent = doc.content;
        contentArea.appendChild(raw);
      }
    }

    previewBtn.addEventListener("click", () => {
      viewMode = "preview";
      previewBtn.classList.add("active");
      rawBtn.classList.remove("active");
      renderContent();
    });

    rawBtn.addEventListener("click", () => {
      viewMode = "raw";
      rawBtn.classList.add("active");
      previewBtn.classList.remove("active");
      renderContent();
    });

    renderContent();
    bodyEl.appendChild(contentArea);
  }

  return {
    async show(docId: string) {
      handle.setTitle("Loading...");
      handle.setVisible(true);
      try {
        const doc = await readKBDocument(docId);
        handle.setTitle(doc.title);
        renderDoc(doc);
      } catch (err) {
        bodyEl.replaceChildren();
        const errEl = document.createElement("div");
        errEl.className = "kb-panel-error";
        errEl.textContent = `Failed to load document: ${(err as Error).message}`;
        bodyEl.appendChild(errEl);
        handle.setTitle("Error");
      }
    },

    hide() {
      handle.setVisible(false);
    },
  };
}
