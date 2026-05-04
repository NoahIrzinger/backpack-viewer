import type { ViewerExtensionAPI, MountedPanel } from "./viewer-api";

const DEFAULT_RELAY_URL = "https://app.backpackontology.com";
let RELAY_URL = DEFAULT_RELAY_URL;
let OAUTH_METADATA_URL = `${RELAY_URL}/.well-known/oauth-authorization-server`;


let panel: MountedPanel | null = null;

export async function activate(viewer: ViewerExtensionAPI): Promise<void> {
  const customRelay = await viewer.settings.get<string>("relay_url");
  if (customRelay) {
    RELAY_URL = customRelay;
    OAUTH_METADATA_URL = `${RELAY_URL}/.well-known/oauth-authorization-server`;
  }
  viewer.registerTaskbarIcon({
    label: "Share",
    iconText: "\u2197",
    position: "bottom-center",
    onClick: () => toggleSharePanel(viewer),
  });
}

function toggleSharePanel(viewer: ViewerExtensionAPI): void {
  if (panel && panel.isVisible()) {
    panel.setVisible(false);
    return;
  }
  const graphName = viewer.getGraphName();
  if (!graphName) return;
  const body = document.createElement("div");
  body.className = "share-panel-body";
  if (panel) {
    panel.element.replaceChildren();
    panel.element.appendChild(body);
    panel.setTitle(`Share "${graphName}"`);
    panel.setVisible(true);
    panel.bringToFront();
  } else {
    body.textContent = "Loading...";
    panel = viewer.mountPanel(body, {
      title: `Share "${graphName}"`,
      defaultPosition: { left: Math.max(100, (window.innerWidth - 380) / 2), top: Math.max(80, (window.innerHeight - 400) / 2) },
      persistKey: "share-v2",
      showFullscreenButton: false,
      onClose: () => { panel = null; },
    });
  }
  renderSharePanel(viewer, body);
}

async function renderSharePanel(viewer: ViewerExtensionAPI, container: HTMLElement): Promise<void> {
  const token = await viewer.settings.get<string>("relay_token");
  container.replaceChildren();
  if (!token) {
    renderUpsell(viewer, container);
  } else {
    renderSyncView(viewer, container, token);
  }
}

// --- Pre-auth: sign-in upsell ---

function renderUpsell(viewer: ViewerExtensionAPI, container: HTMLElement): void {
  const w = document.createElement("div");
  w.className = "share-upsell";
  const h = document.createElement("h4");
  h.textContent = "Share this graph with anyone";
  w.appendChild(h);
  const p = document.createElement("p");
  p.textContent = "Encrypt your graph and get a shareable link. Recipients open it in their browser \u2014 no install needed.";
  w.appendChild(p);
  const cta = document.createElement("button");
  cta.className = "share-cta-btn";
  cta.textContent = "Sign in to share";
  cta.addEventListener("click", () => startOAuthFlow(viewer, container));
  w.appendChild(cta);

  const tokenLink = document.createElement("button");
  tokenLink.className = "share-token-link";
  tokenLink.textContent = "Or paste an API token";
  tokenLink.addEventListener("click", () => renderTokenInput(viewer, container));
  w.appendChild(tokenLink);

  const trust = document.createElement("p");
  trust.className = "share-trust";
  trust.textContent = "Free to share. Anyone with the link can view the graph.";
  w.appendChild(trust);
  container.replaceChildren(w);
}

function renderTokenInput(viewer: ViewerExtensionAPI, container: HTMLElement): void {
  const w = document.createElement("div");
  w.className = "share-token-input";
  const label = document.createElement("p");
  label.textContent = "Paste your API token from your account settings:";
  w.appendChild(label);
  const input = document.createElement("input");
  input.type = "password";
  input.placeholder = "Token";
  input.className = "share-input";
  w.appendChild(input);
  const row = document.createElement("div");
  row.className = "share-btn-row";
  const saveBtn = document.createElement("button");
  saveBtn.className = "share-btn-primary";
  saveBtn.textContent = "Save";
  saveBtn.addEventListener("click", async () => {
    const val = input.value.trim();
    if (!val) return;
    await viewer.settings.set("relay_token", val);
    window.dispatchEvent(new CustomEvent("backpack-auth-changed"));
    renderSharePanel(viewer, container);
  });
  row.appendChild(saveBtn);
  const backBtn = document.createElement("button");
  backBtn.className = "share-btn-secondary";
  backBtn.textContent = "Back";
  backBtn.addEventListener("click", () => renderSharePanel(viewer, container));
  row.appendChild(backBtn);
  w.appendChild(row);
  container.replaceChildren(w);
}

// --- Post-auth: guided sync flow ---

interface GraphSummary {
  name: string;
  encrypted: boolean;
  source: string;
  syncedAt?: string;
}

async function fetchGraphs(token: string): Promise<{ graphs: GraphSummary[]; error?: string }> {
  try {
    const res = await fetch(`${RELAY_URL}/api/graphs`, {
      headers: { "Authorization": `Bearer ${token}` },
    });
    if (res.status === 401) return { graphs: [], error: "unauthorized" };
    if (!res.ok) return { graphs: [], error: `status ${res.status}` };
    const data = await res.json();
    return { graphs: Array.isArray(data) ? data : [] };
  } catch {
    // Network errors (e.g., expired token causing a redirect that CORS
    // blocks) surface as "Failed to fetch". Treat as unauthorized so the
    // extension clears the stale token and prompts re-auth.
    return { graphs: [], error: "unauthorized" };
  }
}

async function renderSyncView(viewer: ViewerExtensionAPI, container: HTMLElement, token: string): Promise<void> {
  const graphName = viewer.getGraphName();

  const loading = document.createElement("div");
  loading.className = "share-loading";
  loading.textContent = "Checking account\u2026";
  container.replaceChildren(loading);

  const result = await fetchGraphs(token);

  if (result.error === "unauthorized") {
    await viewer.settings.remove("relay_token");
    renderSharePanel(viewer, container);
    return;
  }

  container.replaceChildren();

  const existing = result.graphs.find(g => g.name === graphName);

  if (existing && existing.source === "cloud") {
    renderCloudShare(viewer, container, token);
  } else if (existing) {
    renderAlreadySynced(viewer, container, token, existing);
  } else {
    renderSyncForm(viewer, container, token);
  }
}

function renderCloudShare(viewer: ViewerExtensionAPI, container: HTMLElement, token: string): void {
  const w = document.createElement("div");
  w.className = "share-form";

  const desc = document.createElement("p");
  desc.className = "share-description";
  desc.textContent = "Share this graph with a link. No sync needed \u2014 this graph lives in the cloud.";
  w.appendChild(desc);

  const shareBtn = document.createElement("button");
  shareBtn.className = "share-cta-btn";
  shareBtn.textContent = "Get share link";
  shareBtn.addEventListener("click", async () => {
    shareBtn.disabled = true;
    shareBtn.textContent = "Creating link\u2026";
    try {
      await doShareOnly(viewer, container, token);
    } catch (err) {
      shareBtn.disabled = false;
      shareBtn.textContent = "Get share link";
      clearErrors(w);
      appendError(w, (err as Error).message);
    }
  });
  w.appendChild(shareBtn);

  appendFooter(viewer, container, w, token);
}

async function doShareOnly(viewer: ViewerExtensionAPI, container: HTMLElement, token: string): Promise<void> {
  const graphName = viewer.getGraphName();
  if (!graphName) throw new Error("No graph loaded");

  const shareRes = await relayFetch(token, `${RELAY_URL}/api/graphs/${encodeURIComponent(graphName)}/share`, {
    method: "POST",
  });

  if (!shareRes.ok) {
    if (shareRes.status === 401) {
      await viewer.settings.remove("relay_token");
      throw new Error("Session expired. Please sign in again.");
    }
    let errorMsg = `Share failed (${shareRes.status})`;
    try {
      const body = await shareRes.json();
      if (body.error) errorMsg = body.error;
    } catch { /* ignore */ }
    throw new Error(errorMsg);
  }

  const shareData = (await shareRes.json()) as { token: string; url: string; expires_at?: string };
  renderSuccess(container, shareData.url, shareData.expires_at);
}

function renderAlreadySynced(viewer: ViewerExtensionAPI, container: HTMLElement, token: string, graph: GraphSummary): void {
  const w = document.createElement("div");
  w.className = "share-synced";

  const h = document.createElement("h4");
  h.textContent = "Synced to your account";
  w.appendChild(h);

  if (graph.syncedAt) {
    const time = document.createElement("p");
    time.className = "share-note";
    time.textContent = `Last synced: ${new Date(graph.syncedAt).toLocaleString()}`;
    w.appendChild(time);
  }

  const badge = document.createElement("p");
  badge.className = "share-note";
  badge.textContent = "Stored in your cloud account.";
  w.appendChild(badge);

  const updateBtn = document.createElement("button");
  updateBtn.className = "share-cta-btn";
  updateBtn.textContent = "Update & Share";
  updateBtn.addEventListener("click", async () => {
    updateBtn.disabled = true;
    updateBtn.textContent = "Uploading\u2026";
    try {
      await doSyncAndShare(viewer, container, token);
    } catch (err) {
      updateBtn.disabled = false;
      updateBtn.textContent = "Update & Share";
      clearErrors(w);
      appendError(w, (err as Error).message);
    }
  });
  w.appendChild(updateBtn);

  const dashLink = document.createElement("a");
  dashLink.href = RELAY_URL;
  dashLink.target = "_blank";
  dashLink.rel = "noopener";
  dashLink.className = "share-token-link";
  dashLink.textContent = "Open dashboard";
  w.appendChild(dashLink);

  appendFooter(viewer, container, w, token);
}

function renderSyncForm(viewer: ViewerExtensionAPI, container: HTMLElement, token: string): void {
  const w = document.createElement("div");
  w.className = "share-form";

  const desc = document.createElement("p");
  desc.className = "share-description";
  desc.textContent = "Upload this graph to your Backpack account and get a shareable link.";
  w.appendChild(desc);

  const syncBtn = document.createElement("button");
  syncBtn.className = "share-cta-btn";
  syncBtn.textContent = "Share";
  syncBtn.addEventListener("click", async () => {
    syncBtn.disabled = true;
    syncBtn.textContent = "Uploading\u2026";
    try {
      await doSyncAndShare(viewer, container, token);
    } catch (err) {
      syncBtn.disabled = false;
      syncBtn.textContent = "Share";
      const msg = (err as Error).message;
      if (msg.includes("encrypted") && msg.includes("limit")) {
        renderQuotaExceeded(viewer, container, token);
        return;
      }
      clearErrors(w);
      appendError(w, msg);
    }
  });
  w.appendChild(syncBtn);

  const freeNote = document.createElement("p");
  freeNote.className = "share-trust";
  freeNote.textContent = "Free to share. Anyone with the link can view the graph.";
  w.appendChild(freeNote);

  appendFooter(viewer, container, w, token);
}

function renderQuotaExceeded(viewer: ViewerExtensionAPI, container: HTMLElement, token: string): void {
  const w = document.createElement("div");
  w.className = "share-quota";

  const h = document.createElement("h4");
  h.textContent = "Encrypted limit reached";
  w.appendChild(h);

  const desc = document.createElement("p");
  desc.className = "share-description";
  desc.textContent = "Your free account includes one encrypted graph, which is already in use.";
  w.appendChild(desc);

  const upgradeBtn = document.createElement("a");
  upgradeBtn.href = `${RELAY_URL}/settings`;
  upgradeBtn.target = "_blank";
  upgradeBtn.rel = "noopener";
  upgradeBtn.className = "share-cta-btn share-btn-link";
  upgradeBtn.textContent = "Upgrade for unlimited encryption";
  w.appendChild(upgradeBtn);

  const divider = document.createElement("div");
  divider.className = "share-divider";
  w.appendChild(divider);

  const publicLabel = document.createElement("p");
  publicLabel.className = "share-description";
  publicLabel.textContent = "Or share as a public graph:";
  w.appendChild(publicLabel);

  const warning = document.createElement("p");
  warning.className = "share-warning";
  warning.textContent = "Your graph data will be stored unencrypted and visible to the server and anyone with the link.";
  w.appendChild(warning);

  const confirmRow = document.createElement("label");
  confirmRow.className = "share-toggle-row";
  const confirmCb = document.createElement("input");
  confirmCb.type = "checkbox";
  confirmRow.appendChild(confirmCb);
  const confirmLabel = document.createElement("span");
  confirmLabel.textContent = "I understand this graph will not be encrypted";
  confirmRow.appendChild(confirmLabel);
  w.appendChild(confirmRow);

  const publicBtn = document.createElement("button");
  publicBtn.className = "share-btn-secondary";
  publicBtn.textContent = "Share as public graph";
  publicBtn.disabled = true;
  confirmCb.addEventListener("change", () => {
    publicBtn.disabled = !confirmCb.checked;
  });
  publicBtn.addEventListener("click", async () => {
    publicBtn.disabled = true;
    publicBtn.textContent = "Syncing\u2026";
    try {
      await doSyncAndShare(viewer, container, token, "public");
    } catch (err) {
      publicBtn.disabled = false;
      publicBtn.textContent = "Share as public graph";
      clearErrors(w);
      appendError(w, (err as Error).message);
    }
  });
  w.appendChild(publicBtn);

  appendFooter(viewer, container, w, token);
}

function appendFooter(_viewer: ViewerExtensionAPI, container: HTMLElement, w: HTMLElement, _token?: string): void {
  const footer = document.createElement("div");
  footer.className = "share-footer";
  w.appendChild(footer);
  container.replaceChildren(w);
}

function clearErrors(parent: HTMLElement): void {
  for (const el of parent.querySelectorAll(".share-error")) el.remove();
}

function appendError(parent: HTMLElement, msg: string): void {
  const el = document.createElement("p");
  el.className = "share-error";
  el.textContent = msg;
  parent.appendChild(el);
}

// --- OAuth PKCE flow ---

async function startOAuthFlow(viewer: ViewerExtensionAPI, container: HTMLElement): Promise<void> {
  try {
    const metaRes = await fetch(OAUTH_METADATA_URL);
    const meta = (await metaRes.json()) as { authorization_endpoint: string; token_endpoint: string; registration_endpoint: string };
    const regRes = await fetch(meta.registration_endpoint, { method: "POST" });
    const client = (await regRes.json()) as { client_id: string };
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = await generateCodeChallenge(codeVerifier);
    const redirectUri = window.location.origin + "/oauth/callback";
    const state = crypto.randomUUID();
    const authUrl = new URL(meta.authorization_endpoint);
    authUrl.searchParams.set("client_id", client.client_id);
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("code_challenge", codeChallenge);
    authUrl.searchParams.set("code_challenge_method", "S256");
    authUrl.searchParams.set("state", state);
    if (!authUrl.searchParams.has("scope")) {
      authUrl.searchParams.set("scope", "openid email profile offline_access");
    }
    sessionStorage.setItem("share_oauth_state", state);
    sessionStorage.setItem("share_oauth_token_endpoint", meta.token_endpoint);
    sessionStorage.setItem("share_oauth_client_id", client.client_id);
    sessionStorage.setItem("share_oauth_code_verifier", codeVerifier);
    sessionStorage.setItem("share_oauth_redirect_uri", redirectUri);
    const popup = window.open(authUrl.toString(), "backpack-share-auth", "width=500,height=700");
    const handler = async (event: MessageEvent) => {
      if (event.data?.type !== "backpack-oauth-callback") return;
      window.removeEventListener("message", handler);
      const { code, returnedState } = event.data;
      if (returnedState !== state) return;
      clearOAuthSessionStorage();
      try {
        const tokenRes = await fetch(meta.token_endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: client.client_id, code_verifier: codeVerifier }).toString(),
        });
        const tokenData = (await tokenRes.json()) as { access_token?: string; id_token?: string };
        // Prefer id_token (validated by the relay's auth layer) over access_token
        const bearerToken = tokenData.id_token || tokenData.access_token;
        if (!bearerToken) {
          appendError(container, "Token exchange failed: no token returned.");
          return;
        }
        await viewer.settings.set("relay_token", bearerToken);
        window.dispatchEvent(new CustomEvent("backpack-auth-changed"));
        renderSharePanel(viewer, container);
      } catch (err) {
        appendError(container, `Token exchange failed: ${(err as Error).message}`);
      }
    };
    window.addEventListener("message", handler);
    if (!popup || popup.closed) {
      window.location.href = authUrl.toString();
    }
  } catch (err) {
    appendError(container, `Auth failed: ${(err as Error).message}`);
  }
}

// --- Sync & Share ---

async function doSyncAndShare(
  viewer: ViewerExtensionAPI, container: HTMLElement,
  token: string, visibility: "private" | "public" = "private",
): Promise<void> {
  const graphName = viewer.getGraphName();
  if (!graphName) throw new Error("No graph loaded");

  // Step 1: Push graph snapshot to cloud via event log API (server-side)
  const pushRes = await fetch("/api/backpack/cloud-sync/push", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ graphName, visibility }),
  });

  if (!pushRes.ok) {
    if (pushRes.status === 401) {
      await viewer.settings.remove("relay_token");
      renderSharePanel(viewer, container);
      throw new Error("Session expired. Please sign in again.");
    }
    let errorMsg = `Upload failed (${pushRes.status})`;
    try {
      const body = await pushRes.json();
      if (body.error) errorMsg = body.error;
    } catch { /* ignore */ }
    throw new Error(errorMsg);
  }

  // Track this graph as synced (for sidebar indicator)
  const synced = await viewer.settings.get<Record<string, boolean>>("synced") || {};
  if (!synced[graphName]) {
    synced[graphName] = true;
    await viewer.settings.set("synced", synced);
  }

  // Step 2: Create share link
  const shareRes = await relayFetch(token, `${RELAY_URL}/api/graphs/${encodeURIComponent(graphName)}/share`, {
    method: "POST",
  });

  if (!shareRes.ok) {
    renderSuccess(container, null, undefined);
    return;
  }

  const shareData = (await shareRes.json()) as { token: string; url: string; expires_at?: string };
  renderSuccess(container, shareData.url, shareData.expires_at);
}

async function relayFetch(token: string, url: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  return fetch(url, { ...init, headers });
}

// --- Success state ---

function renderSuccess(container: HTMLElement, shareLink: string | null, expiresAt?: string): void {
  const w = document.createElement("div");
  w.className = "share-success";
  const h = document.createElement("h4");
  h.textContent = shareLink ? "Synced & shared!" : "Synced!";
  w.appendChild(h);

  if (shareLink) {
    const row = document.createElement("div");
    row.className = "share-link-row";
    const input = document.createElement("input");
    input.type = "text";
    input.readOnly = true;
    input.value = shareLink;
    input.className = "share-link-input";
    row.appendChild(input);
    const copyBtn = document.createElement("button");
    copyBtn.className = "share-btn-primary";
    copyBtn.textContent = "Copy";
    copyBtn.addEventListener("click", () => {
      navigator.clipboard.writeText(shareLink).then(() => {
        copyBtn.textContent = "Copied!";
        setTimeout(() => { copyBtn.textContent = "Copy"; }, 2000);
      }).catch(() => {
        copyBtn.textContent = "Failed";
        setTimeout(() => { copyBtn.textContent = "Copy"; }, 2000);
      });
    });
    row.appendChild(copyBtn);
    w.appendChild(row);
  }

  if (shareLink) {
    const note = document.createElement("p");
    note.className = "share-note";
    note.textContent = "Anyone with the link can view this graph.";
    w.appendChild(note);
  }

  if (expiresAt) {
    const exp = document.createElement("p");
    exp.className = "share-note";
    exp.textContent = `Expires: ${new Date(expiresAt).toLocaleDateString()}`;
    w.appendChild(exp);
  }
  container.replaceChildren(w);
}

// --- OAuth session helpers ---

function clearOAuthSessionStorage(): void {
  sessionStorage.removeItem("share_oauth_state");
  sessionStorage.removeItem("share_oauth_token_endpoint");
  sessionStorage.removeItem("share_oauth_client_id");
  sessionStorage.removeItem("share_oauth_code_verifier");
  sessionStorage.removeItem("share_oauth_redirect_uri");
}

// --- PKCE helpers ---

function generateCodeVerifier(): string {
  const arr = new Uint8Array(32);
  crypto.getRandomValues(arr);
  return btoa(String.fromCharCode(...arr)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/,"");
}

async function generateCodeChallenge(verifier: string): Promise<string> {
  const data = new TextEncoder().encode(verifier);
  const dataCopy = new Uint8Array(data).buffer as ArrayBuffer;
  const digest = await crypto.subtle.digest("SHA-256", dataCopy);
  return btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
