import type { KBDocument } from "backpack-ontology";
import type { MountedPanel } from "./extensions/types";
import type { PanelMount } from "./extensions/panel-mount";
import { readKBDocument, updateKBDocument } from "./api";
import { renderMarkdown } from "./markdown";

const AUTOSAVE_DEBOUNCE_MS = 600;

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

    // Title row (title + copy button)
    const header = document.createElement("div");
    header.className = "kb-panel-header";

    const title = document.createElement("h3");
    title.className = "kb-panel-title";
    title.textContent = doc.title;
    header.appendChild(title);

    const copyBtn = document.createElement("button");
    copyBtn.className = "kb-copy-btn";
    copyBtn.type = "button";
    copyBtn.textContent = "Copy";
    copyBtn.title = "Copy contents";
    let copyResetTimer: ReturnType<typeof setTimeout> | null = null;
    copyBtn.addEventListener("click", async () => {
      let text: string;
      if (viewMode === "raw") {
        const ta = contentArea.querySelector<HTMLTextAreaElement>(".kb-panel-editor");
        text = ta ? ta.value : doc.content;
      } else {
        // Render markdown and use innerText so block elements produce real
        // line breaks. innerText needs the node attached to the document for
        // layout-aware whitespace, so mount it off-screen via a CSS class.
        const stage = renderMarkdown(doc.content);
        stage.classList.add("kb-copy-stage");
        document.body.appendChild(stage);
        text = stage.innerText;
        stage.remove();
      }
      try {
        await navigator.clipboard.writeText(text);
        copyBtn.textContent = "Copied";
        copyBtn.classList.add("kb-copy-btn-ok");
      } catch {
        copyBtn.textContent = "Copy failed";
        copyBtn.classList.add("kb-copy-btn-err");
      }
      if (copyResetTimer) clearTimeout(copyResetTimer);
      copyResetTimer = setTimeout(() => {
        copyBtn.textContent = "Copy";
        copyBtn.classList.remove("kb-copy-btn-ok", "kb-copy-btn-err");
      }, 1500);
    });
    header.appendChild(copyBtn);

    bodyEl.appendChild(header);

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

    const status = document.createElement("span");
    status.className = "kb-save-status";
    toggle.appendChild(previewBtn);
    toggle.appendChild(rawBtn);
    toggle.appendChild(status);
    bodyEl.appendChild(toggle);

    // Content area
    const contentArea = document.createElement("div");
    contentArea.className = "kb-panel-content-area";

    let saveTimer: ReturnType<typeof setTimeout> | null = null;
    let savePending = false;
    let saveInFlight = false;

    function setStatus(text: string, kind: "" | "saving" | "saved" | "error" = "") {
      status.textContent = text;
      status.className = "kb-save-status" + (kind ? ` kb-save-status-${kind}` : "");
    }

    async function flushSave(content: string) {
      if (saveInFlight) {
        savePending = true;
        return;
      }
      saveInFlight = true;
      setStatus("Saving…", "saving");
      try {
        const updated = await updateKBDocument(doc.id, { content });
        doc.content = updated.content;
        doc.updatedAt = updated.updatedAt;
        setStatus("Saved", "saved");
      } catch (err) {
        setStatus(`Save failed: ${(err as Error).message}`, "error");
      } finally {
        saveInFlight = false;
        if (savePending) {
          savePending = false;
          // Re-flush with the latest textarea value
          const ta = contentArea.querySelector<HTMLTextAreaElement>(".kb-panel-editor");
          if (ta) flushSave(ta.value);
        }
      }
    }

    function scheduleSave(content: string) {
      if (saveTimer) clearTimeout(saveTimer);
      setStatus("Editing…");
      saveTimer = setTimeout(() => {
        saveTimer = null;
        flushSave(content);
      }, AUTOSAVE_DEBOUNCE_MS);
    }

    function renderContent() {
      contentArea.replaceChildren();
      if (viewMode === "preview") {
        contentArea.appendChild(renderMarkdown(doc.content));
        setStatus("");
      } else {
        const editor = document.createElement("textarea");
        editor.className = "kb-panel-editor";
        editor.spellcheck = false;
        editor.value = doc.content;
        editor.addEventListener("input", () => {
          scheduleSave(editor.value);
        });
        editor.addEventListener("blur", () => {
          if (saveTimer) {
            clearTimeout(saveTimer);
            saveTimer = null;
            flushSave(editor.value);
          }
        });
        contentArea.appendChild(editor);
        setStatus("");
      }
    }

    previewBtn.addEventListener("click", () => {
      // If switching away from raw with a pending save, flush it first.
      if (viewMode === "raw" && saveTimer) {
        const ta = contentArea.querySelector<HTMLTextAreaElement>(".kb-panel-editor");
        clearTimeout(saveTimer);
        saveTimer = null;
        if (ta) flushSave(ta.value);
      }
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
