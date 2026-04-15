/**
 * DOM-based markdown renderer — no innerHTML, no dependencies, CSP-safe.
 *
 * Parses markdown line-by-line and builds DOM elements using textContent
 * for all user content. Supports headings, bold, italic, inline code,
 * code blocks, lists, blockquotes, links, horizontal rules, and paragraphs.
 */

export function renderMarkdown(content: string): HTMLElement {
  const container = document.createElement("div");
  container.className = "kb-rendered";

  const lines = content.split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Blank line — skip
    if (line.trim() === "") {
      i++;
      continue;
    }

    // Fenced code block
    if (line.trimStart().startsWith("```")) {
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith("```")) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing ```
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      code.textContent = codeLines.join("\n");
      pre.appendChild(code);
      container.appendChild(pre);
      continue;
    }

    // Horizontal rule
    if (/^---+$|^\*\*\*+$|^___+$/.test(line.trim())) {
      container.appendChild(document.createElement("hr"));
      i++;
      continue;
    }

    // Heading
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const tag = `h${Math.min(level, 6)}` as "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
      const h = document.createElement(tag);
      appendInline(h, headingMatch[2]);
      container.appendChild(h);
      i++;
      continue;
    }

    // Blockquote
    if (line.trimStart().startsWith("> ")) {
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i].trimStart().startsWith("> ")) {
        quoteLines.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      const bq = document.createElement("blockquote");
      const p = document.createElement("p");
      appendInline(p, quoteLines.join(" "));
      bq.appendChild(p);
      container.appendChild(bq);
      continue;
    }

    // Table (lines starting with |)
    if (line.trimStart().startsWith("|") && i + 1 < lines.length && /^\s*\|[\s:]*-+/.test(lines[i + 1])) {
      const table = document.createElement("table");
      // Header row
      const thead = document.createElement("thead");
      const headerRow = document.createElement("tr");
      const headerCells = parsePipeCells(lines[i]);
      for (const cell of headerCells) {
        const th = document.createElement("th");
        appendInline(th, cell.trim());
        headerRow.appendChild(th);
      }
      thead.appendChild(headerRow);
      table.appendChild(thead);
      i++; // header row

      // Parse alignment from separator row
      const alignments: string[] = [];
      if (i < lines.length && /^\s*\|[\s:]*-+/.test(lines[i])) {
        const sepCells = parsePipeCells(lines[i]);
        for (const sep of sepCells) {
          const s = sep.trim();
          if (s.startsWith(":") && s.endsWith(":")) alignments.push("center");
          else if (s.endsWith(":")) alignments.push("right");
          else alignments.push("");
        }
        i++; // separator row
      }

      // Body rows
      const tbody = document.createElement("tbody");
      while (i < lines.length && lines[i].trimStart().startsWith("|")) {
        const bodyRow = document.createElement("tr");
        const bodyCells = parsePipeCells(lines[i]);
        for (let c = 0; c < bodyCells.length; c++) {
          const td = document.createElement("td");
          if (alignments[c]) td.style.textAlign = alignments[c];
          appendInline(td, bodyCells[c].trim());
          bodyRow.appendChild(td);
        }
        tbody.appendChild(bodyRow);
        i++;
      }
      table.appendChild(tbody);
      container.appendChild(table);
      continue;
    }

    // Task list (- [ ] or - [x])
    if (/^\s*[-*]\s+\[[ xX]\]\s/.test(line)) {
      const ul = document.createElement("ul");
      ul.className = "md-task-list";
      while (i < lines.length && /^\s*[-*]\s+\[[ xX]\]\s/.test(lines[i])) {
        const li = document.createElement("li");
        li.className = "md-task-item";
        const checked = /^\s*[-*]\s+\[[xX]\]/.test(lines[i]);
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = checked;
        cb.disabled = true;
        li.appendChild(cb);
        const span = document.createElement("span");
        appendInline(span, lines[i].replace(/^\s*[-*]\s+\[[ xX]\]\s+/, ""));
        li.appendChild(span);
        ul.appendChild(li);
        i++;
      }
      container.appendChild(ul);
      continue;
    }

    // Unordered list
    if (/^\s*[-*]\s+/.test(line)) {
      const ul = document.createElement("ul");
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        const li = document.createElement("li");
        appendInline(li, lines[i].replace(/^\s*[-*]\s+/, ""));
        ul.appendChild(li);
        i++;
      }
      container.appendChild(ul);
      continue;
    }

    // Ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      const ol = document.createElement("ol");
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        const li = document.createElement("li");
        appendInline(li, lines[i].replace(/^\s*\d+\.\s+/, ""));
        ol.appendChild(li);
        i++;
      }
      container.appendChild(ol);
      continue;
    }

    // Paragraph — collect consecutive non-blank, non-special lines
    const paraLines: string[] = [];
    while (i < lines.length && lines[i].trim() !== "" &&
      !lines[i].trimStart().startsWith("```") &&
      !lines[i].trimStart().startsWith("# ") &&
      !lines[i].trimStart().startsWith("## ") &&
      !lines[i].trimStart().startsWith("### ") &&
      !lines[i].trimStart().startsWith("> ") &&
      !lines[i].trimStart().startsWith("|") &&
      !/^\s*[-*]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i]) &&
      !/^---+$|^\*\*\*+$|^___+$/.test(lines[i].trim())) {
      paraLines.push(lines[i]);
      i++;
    }
    if (paraLines.length > 0) {
      const p = document.createElement("p");
      appendInline(p, paraLines.join(" "));
      container.appendChild(p);
    }
  }

  return container;
}

/** Split a pipe-delimited table row into cells. */
function parsePipeCells(line: string): string[] {
  const trimmed = line.trim();
  const inner = trimmed.startsWith("|") ? trimmed.slice(1) : trimmed;
  const end = inner.endsWith("|") ? inner.slice(0, -1) : inner;
  return end.split("|");
}

/** Parse inline markdown (bold, italic, code, strikethrough, images, links) and append DOM nodes. */
function appendInline(parent: HTMLElement, text: string): void {
  // Regex to match inline patterns: **bold**, *italic*, ~~strike~~, `code`, ![alt](url), [text](url)
  const pattern = /(\*\*(.+?)\*\*)|(\*(.+?)\*)|(`(.+?)`)|(~~(.+?)~~)|(!\[([^\]]*)\]\(([^)]+)\))|(\[([^\]]+)\]\(([^)]+)\))/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    // Append text before this match
    if (match.index > lastIndex) {
      parent.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
    }

    if (match[1]) {
      // **bold**
      const strong = document.createElement("strong");
      strong.textContent = match[2];
      parent.appendChild(strong);
    } else if (match[3]) {
      // *italic*
      const em = document.createElement("em");
      em.textContent = match[4];
      parent.appendChild(em);
    } else if (match[5]) {
      // `code`
      const code = document.createElement("code");
      code.textContent = match[6];
      parent.appendChild(code);
    } else if (match[7]) {
      // ~~strikethrough~~
      const del = document.createElement("del");
      del.textContent = match[8];
      parent.appendChild(del);
    } else if (match[9]) {
      // ![alt](url) — only load safe image data URIs and relative paths
      const src = match[11];
      const safeDataImage = /^data:image\/(png|jpe?g|gif|webp|svg\+xml);/.test(src);
      if (safeDataImage || src.startsWith("./") || src.startsWith("../") || !src.includes("://")) {
        const img = document.createElement("img");
        img.alt = match[10] || "";
        img.src = src;
        parent.appendChild(img);
      } else {
        const a = document.createElement("a");
        a.textContent = match[10] || src;
        a.href = src;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        parent.appendChild(a);
      }
    } else if (match[12]) {
      // [text](url) — reject dangerous URI schemes
      const href = match[14];
      if (/^(javascript|vbscript|data):/i.test(href.trim())) {
        parent.appendChild(document.createTextNode(match[13]));
      } else {
        const a = document.createElement("a");
        a.textContent = match[13];
        a.href = href;
        a.target = "_blank";
        a.rel = "noopener";
        parent.appendChild(a);
      }
    }

    lastIndex = match.index + match[0].length;
  }

  // Append remaining text
  if (lastIndex < text.length) {
    parent.appendChild(document.createTextNode(text.slice(lastIndex)));
  }
}
