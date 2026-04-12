import type { ViewerExtensionAPI, MountedPanel } from "./viewer-api";

const RELAY_URL = "https://app.backpackontology.com";

// OAuth metadata endpoint on the relay
const OAUTH_METADATA_URL = `${RELAY_URL}/.well-known/oauth-authorization-server`;

let panel: MountedPanel | null = null;

export function activate(viewer: ViewerExtensionAPI): void {
  // Register the Share button in the top-right toolbar
  viewer.registerTaskbarIcon({
    label: "Share",
    iconText: "\u2197", // ↗
    position: "top-right",
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

async function renderShareForm(
  viewer: ViewerExtensionAPI,
  container: HTMLElement,
): Promise<void> {
  const token = await viewer.settings.get<string>("relay_token");

  container.replaceChildren();

  if (!token) {
    renderUpsell(viewer, container);
    return;
  }

  renderForm(viewer, container, token);
}

function renderUpsell(viewer: ViewerExtensionAPI, container: HTMLElement): void {
  const wrapper = document.createElement("div");
  wrapper.className = "share-upsell";

  const heading = document.createElement("h4");
  heading.textContent = "Share this graph with anyone";
  wrapper.appendChild(heading);

  const desc = document.createElement("p");
  desc.textContent =
    "Encrypt your graph and get a shareable link. Recipients open it in their browser — no install needed. Your data stays encrypted on our servers.";
  wrapper.appendChild(desc);

  const cta = document.createElement("button");
  cta.className = "share-cta-btn";
  cta.textContent = "Sign in to share";
  cta.addEventListener("click", () => startOAuthFlow(viewer, container));
  wrapper.appendChild(cta);

  const tokenLink = document.createElement("button");
  tokenLink.className = "share-token-link";
  tokenLink.textContent = "Or paste an API token";
  tokenLink.addEventListener("click", () => renderTokenInput(viewer, container));
  wrapper.appendChild(tokenLink);

  const trust = document.createElement("p");
  trust.className = "share-trust";
  trust.textContent =
    "Free account. Your graph is encrypted before upload — we can't read it.";
  wrapper.appendChild(trust);

  container.replaceChildren(wrapper);
}

function renderTokenInput(
  viewer: ViewerExtensionAPI,
  container: HTMLElement,
): void {
  const wrapper = document.createElement("div");
  wrapper.className = "share-token-input";

  const label = document.createElement("p");
  label.textContent = "Paste your API token from Backpack App settings:";
  wrapper.appendChild(label);

  const input = document.createElement("input");
  input.type = "password";
  input.placeholder = "Token";
  input.className = "share-input";
  wrapper.appendChild(input);

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

  wrapper.appendChild(row);
  container.replaceChildren(wrapper);
}

async function startOAuthFlow(
  viewer: ViewerExtensionAPI,
  container: HTMLElement,
): Promise<void> {
  try {
    // Fetch OAuth metadata
    const metaRes = await viewer.fetch(OAUTH_METADATA_URL);
    const meta = (await metaRes.json()) as {
      authorization_endpoint: string;
      token_endpoint: string;
      registration_endpoint: string;
    };

    // Register as a dynamic client
    const regRes = await viewer.fetch(meta.registration_endpoint, {
      method: "POST",
    });
    const client = (await regRes.json()) as { client_id: string };

    // Generate PKCE challenge
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = await generateCodeChallenge(codeVerifier);

    // Build authorization URL
    const redirectUri = window.location.origin + "/oauth/callback";
    const state = crypto.randomUUID();
    const authUrl = new URL(meta.authorization_endpoint);
    // authorization_endpoint may already have query params (e.g., scope=...)
    authUrl.searchParams.set("client_id", client.client_id);
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("code_challenge", codeChallenge);
    authUrl.searchParams.set("code_challenge_method", "S256");
    authUrl.searchParams.set("state", state);
    if (!authUrl.searchParams.has("scope")) {
      authUrl.searchParams.set("scope", "openid email profile offline_access");
    }

    // Store state for the callback
    sessionStorage.setItem("share_oauth_state", state);
    sessionStorage.setItem("share_oauth_verifier", codeVerifier);
    sessionStorage.setItem("share_oauth_token_endpoint", meta.token_endpoint);
    sessionStorage.setItem("share_oauth_client_id", client.client_id);
    sessionStorage.setItem("share_oauth_redirect_uri", redirectUri);

    // Open popup
    const popup = window.open(
      authUrl.toString(),
      "backpack-share-auth",
      "width=500,height=700",
    );

    // Listen for the callback
    const handler = async (event: MessageEvent) => {
      if (event.data?.type !== "backpack-oauth-callback") return;
      window.removeEventListener("message", handler);

      const { code, returnedState } = event.data;
      if (returnedState !== state) return;

      // Exchange code for token
      const tokenRes = await viewer.fetch(meta.token_endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri,
          client_id: client.client_id,
          code_verifier: codeVerifier,
        }).toString(),
      });

      const tokenData = (await tokenRes.json()) as { access_token: string };
      await viewer.settings.set("relay_token", tokenData.access_token);
      renderShareForm(viewer, container);
    };

    window.addEventListener("message", handler);

    // Fallback: if popup is blocked, show a link
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

function renderForm(
  viewer: ViewerExtensionAPI,
  container: HTMLElement,
  token: string,
): void {
  const wrapper = document.createElement("div");
  wrapper.className = "share-form";

  // Encrypt toggle
  const encryptRow = document.createElement("label");
  encryptRow.className = "share-toggle-row";
  const encryptCheckbox = document.createElement("input");
  encryptCheckbox.type = "checkbox";
  encryptCheckbox.checked = true;
  encryptRow.appendChild(encryptCheckbox);
  const encryptLabel = document.createElement("span");
  encryptLabel.textContent = "Encrypt (recommended)";
  encryptRow.appendChild(encryptLabel);
  wrapper.appendChild(encryptRow);

  // Passphrase
  const passRow = document.createElement("div");
  passRow.className = "share-pass-row";
  const passInput = document.createElement("input");
  passInput.type = "password";
  passInput.placeholder = "Passphrase (optional)";
  passInput.className = "share-input";
  passRow.appendChild(passInput);
  wrapper.appendChild(passRow);

  // Share button
  const shareBtn = document.createElement("button");
  shareBtn.className = "share-btn-primary";
  shareBtn.textContent = "Share";
  shareBtn.addEventListener("click", async () => {
    shareBtn.disabled = true;
    shareBtn.textContent = "Encrypting...";
    try {
      await doShare(viewer, container, token, encryptCheckbox.checked, passInput.value.trim());
    } catch (err) {
      shareBtn.disabled = false;
      shareBtn.textContent = "Share";
      const errMsg = document.createElement("p");
      errMsg.className = "share-error";
      errMsg.textContent = (err as Error).message;
      wrapper.appendChild(errMsg);
    }
  });
  wrapper.appendChild(shareBtn);

  const note = document.createElement("p");
  note.className = "share-note";
  note.textContent = "Recipients open the link in their browser. No install needed.";
  wrapper.appendChild(note);

  // Logout link
  const logoutBtn = document.createElement("button");
  logoutBtn.className = "share-token-link";
  logoutBtn.textContent = "Sign out";
  logoutBtn.addEventListener("click", async () => {
    await viewer.settings.remove("relay_token");
    renderShareForm(viewer, container);
  });
  wrapper.appendChild(logoutBtn);

  container.replaceChildren(wrapper);
}

async function doShare(
  viewer: ViewerExtensionAPI,
  container: HTMLElement,
  token: string,
  encrypted: boolean,
  passphrase: string,
): Promise<void> {
  const graph = viewer.getGraph();
  const graphName = viewer.getGraphName();
  if (!graph || !graphName) throw new Error("No graph loaded");

  const plaintext = new TextEncoder().encode(JSON.stringify(graph));

  let payload: Uint8Array;
  let format: "plaintext" | "age-v1";
  let fragmentKey = "";

  if (encrypted) {
    const { generateKeyPair, encrypt, encodeKeyForFragment } = await import("backpack-ontology");
    const keyPair = await generateKeyPair();
    payload = await encrypt(plaintext, keyPair.publicKey);
    format = "age-v1";
    fragmentKey = encodeKeyForFragment(keyPair.secretKey);
  } else {
    payload = plaintext;
    format = "plaintext";
  }

  // Build BPAK envelope
  const { createEnvelope } = await import("backpack-ontology");
  const envelope = await createEnvelope(graphName, payload, format, 1);

  // Upload to relay
  const headers: Record<string, string> = {
    "Content-Type": "application/octet-stream",
    Authorization: `Bearer ${token}`,
  };
  if (passphrase) {
    headers["X-Passphrase"] = passphrase;
  }

  const res = await viewer.fetch(`${RELAY_URL}/v1/share`, {
    method: "POST",
    headers,
    body: envelope as unknown as BodyInit,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    if (res.status === 401) {
      // Token expired — clear and show upsell
      await viewer.settings.remove("relay_token");
      renderShareForm(viewer, container);
      throw new Error("Session expired. Please sign in again.");
    }
    throw new Error(`Upload failed: ${body}`);
  }

  const result = (await res.json()) as { token: string; url: string; expires_at?: string };

  const shareLink = fragmentKey
    ? `${result.url}#k=${fragmentKey}`
    : result.url;

  renderSuccess(container, shareLink, encrypted, result.expires_at);
}

function renderSuccess(
  container: HTMLElement,
  shareLink: string,
  encrypted: boolean,
  expiresAt?: string,
): void {
  const wrapper = document.createElement("div");
  wrapper.className = "share-success";

  const heading = document.createElement("h4");
  heading.textContent = "Shared!";
  wrapper.appendChild(heading);

  const linkRow = document.createElement("div");
  linkRow.className = "share-link-row";

  const linkInput = document.createElement("input");
  linkInput.type = "text";
  linkInput.readOnly = true;
  linkInput.value = shareLink;
  linkInput.className = "share-link-input";
  linkRow.appendChild(linkInput);

  const copyBtn = document.createElement("button");
  copyBtn.className = "share-btn-primary";
  copyBtn.textContent = "Copy";
  copyBtn.addEventListener("click", () => {
    navigator.clipboard.writeText(shareLink);
    copyBtn.textContent = "Copied!";
    setTimeout(() => { copyBtn.textContent = "Copy"; }, 2000);
  });
  linkRow.appendChild(copyBtn);
  wrapper.appendChild(linkRow);

  if (encrypted) {
    const note = document.createElement("p");
    note.className = "share-note";
    note.textContent =
      "The decryption key is in the link. Anyone with the full link can view this graph. The server cannot read your data.";
    wrapper.appendChild(note);
  }

  if (expiresAt) {
    const exp = document.createElement("p");
    exp.className = "share-note";
    exp.textContent = `Expires: ${new Date(expiresAt).toLocaleDateString()}`;
    wrapper.appendChild(exp);
  }

  container.replaceChildren(wrapper);
}

// --- PKCE helpers ---

function generateCodeVerifier(): string {
  const arr = new Uint8Array(32);
  crypto.getRandomValues(arr);
  return btoa(String.fromCharCode(...arr))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function generateCodeChallenge(verifier: string): Promise<string> {
  const data = new TextEncoder().encode(verifier);
  const buf = new ArrayBuffer(data.byteLength);
  new Uint8Array(buf).set(data);
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
