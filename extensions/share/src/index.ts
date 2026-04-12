import type { ViewerExtensionAPI, MountedPanel, LearningGraphData } from "./viewer-api";

const RELAY_URL = "https://app.backpackontology.com";
const OAUTH_METADATA_URL = `${RELAY_URL}/.well-known/oauth-authorization-server`;

const BPAK_MAGIC = new Uint8Array([0x42, 0x50, 0x41, 0x4b]);
const BPAK_VERSION = 0x01;

let panel: MountedPanel | null = null;

export function activate(viewer: ViewerExtensionAPI): void {
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
  trust.textContent = "Free account. Your graph is encrypted before upload \u2014 we can\u2019t read it.";
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
  } catch (err) {
    return { graphs: [], error: (err as Error).message };
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

  if (existing) {
    renderAlreadySynced(viewer, container, token, existing);
  } else {
    renderSyncForm(viewer, container, token);
  }
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
  badge.textContent = graph.encrypted ? "Encrypted \u2014 server cannot read your data." : "Public \u2014 stored unencrypted.";
  w.appendChild(badge);

  const updateBtn = document.createElement("button");
  updateBtn.className = "share-cta-btn";
  updateBtn.textContent = "Update & Share";
  updateBtn.addEventListener("click", async () => {
    updateBtn.disabled = true;
    updateBtn.textContent = graph.encrypted ? "Encrypting\u2026" : "Syncing\u2026";
    try {
      await doSyncAndShare(viewer, container, token, graph.encrypted);
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

  appendFooter(viewer, container, w);
}

function renderSyncForm(viewer: ViewerExtensionAPI, container: HTMLElement, token: string): void {
  const w = document.createElement("div");
  w.className = "share-form";

  const desc = document.createElement("p");
  desc.className = "share-description";
  desc.textContent = "Your graph will be encrypted and synced to your Backpack account. You\u2019ll get a shareable link.";
  w.appendChild(desc);

  const syncBtn = document.createElement("button");
  syncBtn.className = "share-cta-btn";
  syncBtn.textContent = "Sync & Share";
  syncBtn.addEventListener("click", async () => {
    syncBtn.disabled = true;
    syncBtn.textContent = "Encrypting\u2026";
    try {
      await doSyncAndShare(viewer, container, token, true);
    } catch (err) {
      syncBtn.disabled = false;
      syncBtn.textContent = "Sync & Share";
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
  freeNote.textContent = "Your first encrypted graph is free. Data is encrypted before upload\u200a\u2014\u200awe can\u2019t read it.";
  w.appendChild(freeNote);

  appendFooter(viewer, container, w);
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
      await doSyncAndShare(viewer, container, token, false);
    } catch (err) {
      publicBtn.disabled = false;
      publicBtn.textContent = "Share as public graph";
      clearErrors(w);
      appendError(w, (err as Error).message);
    }
  });
  w.appendChild(publicBtn);

  appendFooter(viewer, container, w);
}

function appendFooter(viewer: ViewerExtensionAPI, container: HTMLElement, w: HTMLElement): void {
  const footer = document.createElement("div");
  footer.className = "share-footer";
  const logoutBtn = document.createElement("button");
  logoutBtn.className = "share-token-link";
  logoutBtn.textContent = "Sign out";
  logoutBtn.addEventListener("click", async () => {
    await viewer.settings.remove("relay_token");
    renderSharePanel(viewer, container);
  });
  footer.appendChild(logoutBtn);
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
        const tokenData = (await tokenRes.json()) as { access_token?: string };
        if (!tokenData.access_token) {
          appendError(container, "Token exchange failed: no access token returned.");
          return;
        }
        await viewer.settings.set("relay_token", tokenData.access_token);
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
  token: string, encrypted: boolean,
): Promise<void> {
  const graph = viewer.getGraph();
  const graphName = viewer.getGraphName();
  if (!graph || !graphName) throw new Error("No graph loaded");

  // Step 1: Build BPAK envelope
  const graphJSON = new TextEncoder().encode(JSON.stringify(graph));
  let payload: Uint8Array;
  let format: "plaintext" | "age-v1";
  let fragmentKey = "";

  if (encrypted) {
    const age = await import("age-encryption");
    const secretKey = await age.generateX25519Identity();
    const publicKey = await age.identityToRecipient(secretKey);
    const e = new age.Encrypter();
    e.addRecipient(publicKey);
    payload = await e.encrypt(graphJSON);
    format = "age-v1";
    fragmentKey = btoa(secretKey).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  } else {
    payload = graphJSON;
    format = "plaintext";
  }

  const envelope = await buildEnvelope(graphName, payload, format, graph);

  // Step 2: Sync to cloud
  const syncRes = await relayFetch(token, `${RELAY_URL}/api/graphs/${encodeURIComponent(graphName)}/sync`, {
    method: "PUT",
    headers: { "Content-Type": "application/octet-stream" },
    body: envelope as unknown as BodyInit,
  });

  if (!syncRes.ok) {
    if (syncRes.status === 401) {
      await viewer.settings.remove("relay_token");
      renderSharePanel(viewer, container);
      throw new Error("Session expired. Please sign in again.");
    }
    let errorMsg = `Sync failed (${syncRes.status})`;
    try {
      const body = await syncRes.json();
      if (body.error) errorMsg = body.error;
    } catch { /* ignore */ }
    throw new Error(errorMsg);
  }

  // Step 3: Create share link
  const shareRes = await relayFetch(token, `${RELAY_URL}/api/graphs/${encodeURIComponent(graphName)}/share`, {
    method: "POST",
  });

  if (!shareRes.ok) {
    // Sync succeeded but share link creation failed — still show success without link
    renderSuccess(container, null, encrypted, undefined);
    return;
  }

  const shareData = (await shareRes.json()) as { token: string; url: string; expires_at?: string };
  const shareLink = fragmentKey ? `${shareData.url}#k=${fragmentKey}` : shareData.url;
  renderSuccess(container, shareLink, encrypted, shareData.expires_at);
}

async function relayFetch(token: string, url: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  return fetch(url, { ...init, headers });
}

// --- BPAK envelope builder ---

async function buildEnvelope(
  name: string, payload: Uint8Array, format: string, graph: LearningGraphData,
): Promise<Uint8Array> {
  const hash = await crypto.subtle.digest("SHA-256", payload);
  const checksum = "sha256:" + Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, "0")).join("");

  // Collect node type names for dashboard stats
  const typeSet = new Set<string>();
  for (const node of graph.nodes) typeSet.add(node.type);

  const header = JSON.stringify({
    format,
    created_at: new Date().toISOString(),
    backpack_name: name,
    graph_count: 1,
    checksum,
    node_count: graph.nodes.length,
    edge_count: graph.edges.length,
    node_types: Array.from(typeSet),
  });
  const headerBytes = new TextEncoder().encode(header);
  const headerLenBuf = new ArrayBuffer(4);
  new DataView(headerLenBuf).setUint32(0, headerBytes.length, false);

  const result = new Uint8Array(4 + 1 + 4 + headerBytes.length + payload.length);
  let off = 0;
  result.set(BPAK_MAGIC, off); off += 4;
  result[off] = BPAK_VERSION; off += 1;
  result.set(new Uint8Array(headerLenBuf), off); off += 4;
  result.set(headerBytes, off); off += headerBytes.length;
  result.set(payload, off);
  return result;
}

// --- Success state ---

function renderSuccess(container: HTMLElement, shareLink: string | null, encrypted: boolean, expiresAt?: string): void {
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

  if (encrypted) {
    const note = document.createElement("p");
    note.className = "share-note";
    note.textContent = "The decryption key is in the link. Anyone with the full link can view. The server cannot read your data.";
    w.appendChild(note);
  } else {
    const note = document.createElement("p");
    note.className = "share-note";
    note.textContent = "This graph is stored unencrypted. Anyone with the link can view it.";
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
  const digest = await crypto.subtle.digest("SHA-256", data);
  return btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
