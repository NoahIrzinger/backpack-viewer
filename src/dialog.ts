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
