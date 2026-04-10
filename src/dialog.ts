/** Lightweight inline dialog system — replaces native alert/confirm/prompt. */

const DIALOG_CSS_CLASS = "bp-dialog-overlay";

function createOverlay(): HTMLElement {
  // Remove any existing dialog
  document.querySelector(`.${DIALOG_CSS_CLASS}`)?.remove();

  const overlay = document.createElement("div");
  overlay.className = DIALOG_CSS_CLASS;
  document.body.appendChild(overlay);
  return overlay;
}

function createModal(overlay: HTMLElement, title: string): HTMLElement {
  const modal = document.createElement("div");
  modal.className = "bp-dialog";

  const heading = document.createElement("h4");
  heading.className = "bp-dialog-title";
  heading.textContent = title;
  modal.appendChild(heading);

  overlay.appendChild(modal);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.remove();
  });

  return modal;
}

function addButtons(modal: HTMLElement, buttons: { label: string; accent?: boolean; danger?: boolean; onClick: () => void }[]): void {
  const row = document.createElement("div");
  row.className = "bp-dialog-buttons";
  for (const btn of buttons) {
    const el = document.createElement("button");
    el.className = "bp-dialog-btn";
    if (btn.accent) el.classList.add("bp-dialog-btn-accent");
    if (btn.danger) el.classList.add("bp-dialog-btn-danger");
    el.textContent = btn.label;
    el.addEventListener("click", btn.onClick);
    row.appendChild(el);
  }
  modal.appendChild(row);
}

/** Show a confirmation dialog. Returns a promise that resolves to true/false. */
export function showConfirm(title: string, message: string): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = createOverlay();
    const modal = createModal(overlay, title);

    const msg = document.createElement("p");
    msg.className = "bp-dialog-message";
    msg.textContent = message;
    modal.appendChild(msg);

    addButtons(modal, [
      { label: "Cancel", onClick: () => { overlay.remove(); resolve(false); } },
      { label: "Confirm", accent: true, onClick: () => { overlay.remove(); resolve(true); } },
    ]);

    // Focus the confirm button
    (modal.querySelector(".bp-dialog-btn-accent") as HTMLElement)?.focus();
  });
}

/** Show a prompt dialog with an input field. Returns null if cancelled. */
export function showPrompt(title: string, placeholder?: string, defaultValue?: string): Promise<string | null> {
  return new Promise((resolve) => {
    const overlay = createOverlay();
    const modal = createModal(overlay, title);

    const input = document.createElement("input");
    input.type = "text";
    input.className = "bp-dialog-input";
    input.placeholder = placeholder ?? "";
    input.value = defaultValue ?? "";
    modal.appendChild(input);

    const submit = () => {
      const val = input.value.trim();
      overlay.remove();
      resolve(val || null);
    };

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") submit();
      if (e.key === "Escape") { overlay.remove(); resolve(null); }
    });

    addButtons(modal, [
      { label: "Cancel", onClick: () => { overlay.remove(); resolve(null); } },
      { label: "OK", accent: true, onClick: submit },
    ]);

    input.focus();
    input.select();
  });
}

export interface BackpackAddResult {
  path: string;
  activate: boolean;
}

/**
 * Show the Add Backpack dialog. Single path field with an optional
 * native folder picker (Chromium only) and drag-and-drop hint. No
 * name field — the display name is derived from the path tail by
 * the backend. No suggestion chips — user pastes any path.
 *
 * Returns null if the user cancels.
 */
export function showBackpackAddDialog(): Promise<BackpackAddResult | null> {
  return new Promise((resolve) => {
    const overlay = createOverlay();
    const modal = createModal(overlay, "Add Backpack");

    const description = document.createElement("p");
    description.className = "bp-dialog-message";
    description.textContent =
      "Enter the absolute path to a directory that should become a backpack. It will be shown in the sidebar using the last segment of the path as its display name.";
    modal.appendChild(description);

    const pathLabel = document.createElement("label");
    pathLabel.className = "bp-dialog-label";
    pathLabel.textContent = "Path";
    modal.appendChild(pathLabel);

    const pathRow = document.createElement("div");
    pathRow.className = "bp-dialog-path-row";
    modal.appendChild(pathRow);

    const pathInput = document.createElement("input");
    pathInput.type = "text";
    pathInput.className = "bp-dialog-input bp-dialog-path-input";
    pathInput.placeholder = "/Users/you/OneDrive/work";
    pathRow.appendChild(pathInput);

    const browseBtn = document.createElement("button");
    browseBtn.type = "button";
    browseBtn.className = "bp-dialog-btn bp-dialog-browse-btn";
    browseBtn.textContent = "Browse...";
    pathRow.appendChild(browseBtn);

    // File System Access API is Chromium-only. On Safari/Firefox the
    // picker doesn't exist; even on Chromium it returns a handle, not
    // a filesystem path, so the user still types or pastes the
    // absolute path. The picker is only a hint.
    const hasNativePicker =
      typeof (window as any).showDirectoryPicker === "function";
    if (!hasNativePicker) {
      browseBtn.disabled = true;
      browseBtn.title =
        "Browser doesn't support native folder picker — paste the path manually";
    }
    browseBtn.addEventListener("click", async (e) => {
      e.preventDefault();
      try {
        const handle = await (window as any).showDirectoryPicker({
          mode: "read",
        });
        pickerHint.textContent = `Picked "${handle.name}" — paste the absolute path to it below.`;
        pathInput.focus();
      } catch {
        // User cancelled
      }
    });

    const pickerHint = document.createElement("div");
    pickerHint.className = "bp-dialog-picker-hint";
    modal.appendChild(pickerHint);

    // Activate checkbox
    const activateRow = document.createElement("div");
    activateRow.className = "bp-dialog-activate-row";
    const activateCheckbox = document.createElement("input");
    activateCheckbox.type = "checkbox";
    activateCheckbox.id = "bp-dialog-activate";
    activateCheckbox.checked = true;
    const activateLabel = document.createElement("label");
    activateLabel.htmlFor = "bp-dialog-activate";
    activateLabel.textContent = "Switch to this backpack after registering";
    activateRow.appendChild(activateCheckbox);
    activateRow.appendChild(activateLabel);
    modal.appendChild(activateRow);

    // Drag-and-drop: dropping a folder gives us the folder name via
    // webkitGetAsEntry but not the full OS path (sandboxed). Use it as
    // a visual hint only.
    pathInput.addEventListener("dragover", (e) => {
      e.preventDefault();
      pathInput.classList.add("bp-dialog-drag-over");
    });
    pathInput.addEventListener("dragleave", () => {
      pathInput.classList.remove("bp-dialog-drag-over");
    });
    pathInput.addEventListener("drop", (e) => {
      e.preventDefault();
      pathInput.classList.remove("bp-dialog-drag-over");
      const items = e.dataTransfer?.items;
      if (!items || items.length === 0) return;
      const entry = (items[0] as any).webkitGetAsEntry?.();
      if (entry?.isDirectory) {
        pickerHint.textContent = `Dropped "${entry.name}" — paste the absolute path to it below.`;
      }
    });

    const submit = () => {
      const p = pathInput.value.trim();
      if (!p) return;
      overlay.remove();
      resolve({ path: p, activate: activateCheckbox.checked });
    };

    pathInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") submit();
      if (e.key === "Escape") {
        overlay.remove();
        resolve(null);
      }
    });

    addButtons(modal, [
      { label: "Cancel", onClick: () => { overlay.remove(); resolve(null); } },
      { label: "Register", accent: true, onClick: submit },
    ]);

    pathInput.focus();
  });
}

/** Show a danger confirmation (for destructive actions). */
export function showDangerConfirm(title: string, message: string): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = createOverlay();
    const modal = createModal(overlay, title);

    const msg = document.createElement("p");
    msg.className = "bp-dialog-message";
    msg.textContent = message;
    modal.appendChild(msg);

    addButtons(modal, [
      { label: "Cancel", onClick: () => { overlay.remove(); resolve(false); } },
      { label: "Delete", danger: true, onClick: () => { overlay.remove(); resolve(true); } },
    ]);
  });
}

/** Show a brief toast notification. */
export function showToast(message: string, durationMs = 3000): void {
  const existing = document.querySelector(".bp-toast");
  if (existing) existing.remove();

  const toast = document.createElement("div");
  toast.className = "bp-toast";
  toast.textContent = message;
  document.body.appendChild(toast);

  setTimeout(() => toast.classList.add("bp-toast-visible"), 10);
  setTimeout(() => {
    toast.classList.remove("bp-toast-visible");
    setTimeout(() => toast.remove(), 300);
  }, durationMs);
}
