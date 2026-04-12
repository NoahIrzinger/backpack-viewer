import type { ViewerExtensionAPI, MountedPanel } from "./viewer-api";

const RELAY_URL = "https://app.backpackontology.com";
const OAUTH_METADATA_URL = `${RELAY_URL}/.well-known/oauth-authorization-server`;

// BPAK envelope magic bytes
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
      defaultPosition: { left: window.innerWidth - 420, top: 80 },
      showFullscreenButton: false,
      onClose: () => { panel = null; },
    });
  }
  renderShareForm(viewer, body);
}

async function renderShareForm(viewer: ViewerExtensionAPI, container: HTMLElement): Promise<void> {
  const token = await viewer.settings.get<string>("relay_token");
  container.replaceChildren();
  if (!token) {
    renderUpsell(viewer, container);
  } else {
    renderForm(viewer, container, token);
  }
}

function renderUpsell(viewer: ViewerExtensionAPI, container: HTMLElement): void {
  const w = document.createElement("div");
  w.className = "share-upsell";
  w.innerHTML = `
    <h4>Share this graph with anyone</h4>
    <p>Encrypt your graph and get a shareable link. Recipients open it in their browser — no install needed. Your data stays encrypted on our servers.</p>
  `;
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
  trust.textContent = "Free account. Your graph is encrypted before upload — we can't read it.";
  w.appendChild(trust);
  container.replaceChildren(w);
}

function renderTokenInput(viewer: ViewerExtensionAPI, container: HTMLElement): void {
  const w = document.createElement("div");
  w.className = "share-token-input";
  const label = document.createElement("p");
  label.textContent = "Paste your API token from Backpack App settings:";
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
    renderShareForm(viewer, container);
  });
  row.appendChild(saveBtn);
  const backBtn = document.createElement("button");
  backBtn.className = "share-btn-secondary";
  backBtn.textContent = "Back";
  backBtn.addEventListener("click", () => renderShareForm(viewer, container));
  row.appendChild(backBtn);
  w.appendChild(row);
  container.replaceChildren(w);
}

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
    const popup = window.open(authUrl.toString(), "backpack-share-auth", "width=500,height=700");
    const handler = async (event: MessageEvent) => {
      if (event.data?.type !== "backpack-oauth-callback") return;
      window.removeEventListener("message", handler);
      const { code, returnedState } = event.data;
      if (returnedState !== state) return;
      const tokenRes = await fetch(meta.token_endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: client.client_id, code_verifier: codeVerifier }).toString(),
      });
      const tokenData = (await tokenRes.json()) as { access_token: string };
      await viewer.settings.set("relay_token", tokenData.access_token);
      renderShareForm(viewer, container);
    };
    window.addEventListener("message", handler);
    if (!popup || popup.closed) {
      const msg = document.createElement("p");
      msg.className = "share-error";
      msg.textContent = "Popup blocked. ";
      const link = document.createElement("a");
      link.href = authUrl.toString();
      link.target = "_blank";
      link.textContent = "Click here to sign in";
      msg.appendChild(link);
      container.appendChild(msg);
    }
  } catch (err) {
    const msg = document.createElement("p");
    msg.className = "share-error";
    msg.textContent = `Auth failed: ${(err as Error).message}`;
    container.appendChild(msg);
  }
}

function renderForm(viewer: ViewerExtensionAPI, container: HTMLElement, token: string): void {
  const w = document.createElement("div");
  w.className = "share-form";
  const encryptRow = document.createElement("label");
  encryptRow.className = "share-toggle-row";
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = true;
  encryptRow.appendChild(cb);
  const lbl = document.createElement("span");
  lbl.textContent = "Encrypt (recommended)";
  encryptRow.appendChild(lbl);
  w.appendChild(encryptRow);
  const passRow = document.createElement("div");
  passRow.className = "share-pass-row";
  const passInput = document.createElement("input");
  passInput.type = "password";
  passInput.placeholder = "Passphrase (optional)";
  passInput.className = "share-input";
  passRow.appendChild(passInput);
  w.appendChild(passRow);
  const shareBtn = document.createElement("button");
  shareBtn.className = "share-btn-primary";
  shareBtn.textContent = "Share";
  shareBtn.addEventListener("click", async () => {
    shareBtn.disabled = true;
    shareBtn.textContent = "Encrypting...";
    try {
      await doShare(viewer, container, token, cb.checked, passInput.value.trim());
    } catch (err) {
      shareBtn.disabled = false;
      shareBtn.textContent = "Share";
      const errMsg = document.createElement("p");
      errMsg.className = "share-error";
      errMsg.textContent = (err as Error).message;
      w.appendChild(errMsg);
    }
  });
  w.appendChild(shareBtn);
  const note = document.createElement("p");
  note.className = "share-note";
  note.textContent = "Recipients open the link in their browser. No install needed.";
  w.appendChild(note);
  const logoutBtn = document.createElement("button");
  logoutBtn.className = "share-token-link";
  logoutBtn.textContent = "Sign out";
  logoutBtn.addEventListener("click", async () => {
    await viewer.settings.remove("relay_token");
    renderShareForm(viewer, container);
  });
  w.appendChild(logoutBtn);
  container.replaceChildren(w);
}

async function doShare(
  viewer: ViewerExtensionAPI, container: HTMLElement,
  token: string, encrypted: boolean, passphrase: string,
): Promise<void> {
  const graph = viewer.getGraph();
  const graphName = viewer.getGraphName();
  if (!graph || !graphName) throw new Error("No graph loaded");

  const plaintext = new TextEncoder().encode(JSON.stringify(graph));
  let payload: Uint8Array;
  let format: "plaintext" | "age-v1";
  let fragmentKey = "";

  if (encrypted) {
    // Dynamic import age-encryption (browser-compatible, no Node deps)
    const age = await import("age-encryption");
    const secretKey = await age.generateX25519Identity();
    const publicKey = await age.identityToRecipient(secretKey);
    const e = new age.Encrypter();
    e.addRecipient(publicKey);
    payload = await e.encrypt(plaintext);
    format = "age-v1";
    fragmentKey = btoa(secretKey).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  } else {
    payload = plaintext;
    format = "plaintext";
  }

  // Build BPAK envelope inline (no backpack-ontology import needed)
  const envelope = await buildEnvelope(graphName, payload, format);

  const headers: Record<string, string> = {
    "Content-Type": "application/octet-stream",
    "Authorization": `Bearer ${token}`,
  };
  if (passphrase) headers["X-Passphrase"] = passphrase;

  const res = await fetch(`${RELAY_URL}/v1/share`, {
    method: "POST",
    headers,
    body: envelope as unknown as BodyInit,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    if (res.status === 401) {
      await viewer.settings.remove("relay_token");
      renderShareForm(viewer, container);
      throw new Error("Session expired. Please sign in again.");
    }
    throw new Error(`Upload failed: ${body}`);
  }

  const result = (await res.json()) as { token: string; url: string; expires_at?: string };
  const shareLink = fragmentKey ? `${result.url}#k=${fragmentKey}` : result.url;
  renderSuccess(container, shareLink, encrypted, result.expires_at);
}

// --- Inline BPAK envelope builder (browser-safe, no Node deps) ---

async function buildEnvelope(
  name: string, payload: Uint8Array, format: string,
): Promise<Uint8Array> {
  const checksumBuf = new ArrayBuffer(payload.byteLength);
  new Uint8Array(checksumBuf).set(payload);
  const hash = await crypto.subtle.digest("SHA-256", checksumBuf);
  const checksum = "sha256:" + Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, "0")).join("");

  const header = JSON.stringify({
    format,
    created_at: new Date().toISOString(),
    backpack_name: name,
    graph_count: 1,
    checksum,
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

function renderSuccess(container: HTMLElement, shareLink: string, encrypted: boolean, expiresAt?: string): void {
  const w = document.createElement("div");
  w.className = "share-success";
  const h = document.createElement("h4");
  h.textContent = "Shared!";
  w.appendChild(h);
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
    navigator.clipboard.writeText(shareLink);
    copyBtn.textContent = "Copied!";
    setTimeout(() => { copyBtn.textContent = "Copy"; }, 2000);
  });
  row.appendChild(copyBtn);
  w.appendChild(row);
  if (encrypted) {
    const note = document.createElement("p");
    note.className = "share-note";
    note.textContent = "The decryption key is in the link. Anyone with the full link can view. The server cannot read your data.";
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

// --- PKCE helpers ---

function generateCodeVerifier(): string {
  const arr = new Uint8Array(32);
  crypto.getRandomValues(arr);
  return btoa(String.fromCharCode(...arr)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/,"");
}

async function generateCodeChallenge(verifier: string): Promise<string> {
  const data = new TextEncoder().encode(verifier);
  const buf = new ArrayBuffer(data.byteLength);
  new Uint8Array(buf).set(data);
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
