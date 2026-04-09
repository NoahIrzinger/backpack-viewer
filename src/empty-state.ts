export function initEmptyState(container: HTMLElement) {
  const el = document.createElement("div");
  el.className = "empty-state";
  el.innerHTML = `
    <div class="empty-state-bg">
      <div class="empty-state-circle c1"></div>
      <div class="empty-state-circle c2"></div>
      <div class="empty-state-circle c3"></div>
      <div class="empty-state-circle c4"></div>
      <div class="empty-state-circle c5"></div>
      <svg class="empty-state-lines" viewBox="0 0 400 300" preserveAspectRatio="xMidYMid slice">
        <line x1="80" y1="60" x2="220" y2="140" stroke="currentColor" stroke-width="0.5" opacity="0.15"/>
        <line x1="220" y1="140" x2="320" y2="80" stroke="currentColor" stroke-width="0.5" opacity="0.15"/>
        <line x1="220" y1="140" x2="160" y2="240" stroke="currentColor" stroke-width="0.5" opacity="0.15"/>
        <line x1="160" y1="240" x2="300" y2="220" stroke="currentColor" stroke-width="0.5" opacity="0.15"/>
      </svg>
    </div>
    <div class="empty-state-content">
      <div class="empty-state-icon">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 002 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0022 16z"/>
          <polyline points="3.27 6.96 12 12.01 20.73 6.96"/>
          <line x1="12" y1="22.08" x2="12" y2="12"/>
        </svg>
      </div>
      <h2 class="empty-state-title">No learning graphs yet</h2>
      <p class="empty-state-desc">Connect Backpack to Claude, then start a conversation. Claude will build your first learning graph automatically.</p>
      <div class="empty-state-setup">
        <div class="empty-state-label">Add Backpack to Claude Code:</div>
        <code class="empty-state-code">claude mcp add backpack-local -s user -- npx backpack-ontology@latest</code>
      </div>
      <p class="empty-state-hint">Press <kbd>?</kbd> for keyboard shortcuts</p>
    </div>
  `;
  container.appendChild(el);

  return {
    show() { el.classList.remove("hidden"); },
    hide() { el.classList.add("hidden"); },
  };
}
