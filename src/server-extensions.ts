import * as fs from "node:fs";
import * as path from "node:path";
import { configDir, dataDir } from "backpack-ontology";
import { validateManifest, ManifestError, type ExtensionManifest } from "./extensions/manifest.js";

/**
 * Server-side extension infrastructure shared by `bin/serve.js` (prod)
 * and `vite.config.ts` (dev). Both entry files import these helpers and
 * keep only thin HTTP wiring.
 *
 * Responsibilities:
 *   - Resolve enabled extensions from config + first-party in-tree dirs
 *   - Parse and validate each manifest
 *   - Provide handlers for the generic extension endpoints:
 *       GET  /api/extensions
 *       POST /api/extensions/<name>/fetch
 *       GET  /api/extensions/<name>/settings
 *       PUT  /api/extensions/<name>/settings/<key>
 *       DELETE /api/extensions/<name>/settings/<key>
 *
 * Static file serving (`/extensions/<name>/<file>`) is handled by each
 * entry file because the static-file plumbing differs between Vite and
 * the raw http server.
 */

export interface LoadedExtension {
  manifest: ExtensionManifest;
  /** Absolute path to the extension's directory on disk. */
  rootDir: string;
  /** Whether this extension shipped with the viewer (in-tree). */
  firstParty: boolean;
}

export interface ExtensionConfigEntry {
  /** Extension name (must match the manifest and the directory). */
  name: string;
  /**
   * Source. Either:
   *   - "first-party" — load from <viewer-dist>/extensions/<name> or
   *     <viewer-src>/extensions/<name> in dev
   *   - { path: "/abs/path" } — load from a user-specified absolute path
   */
  source: "first-party" | { path: string };
  enabled?: boolean;
}

/**
 * Resolve enabled extensions. Reads:
 *   1. The list of first-party extensions bundled with the viewer
 *      (default-enabled unless the user disabled them)
 *   2. The list of external extensions from the user's viewer config
 *
 * For each one: locates the manifest, validates it, and returns the
 * loaded extension. Errors are logged but don't crash the server —
 * a malformed extension is skipped, others keep working.
 *
 * @param firstPartyDir absolute path to the directory containing
 *                      bundled first-party extensions (typically
 *                      `<dist>/extensions/` in prod or
 *                      `<repo>/extensions/` in dev)
 * @param userExtensions list from viewer config; same shape regardless of source
 * @param disabledFirstParty names of first-party extensions the user disabled
 */
export function loadExtensions(
  firstPartyDir: string,
  userExtensions: { name: string; path: string }[],
  disabledFirstParty: Set<string>,
): LoadedExtension[] {
  const out: LoadedExtension[] = [];

  // 1) First-party — discover all subdirs of firstPartyDir
  if (fs.existsSync(firstPartyDir)) {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(firstPartyDir, { withFileTypes: true });
    } catch (err) {
      console.error(
        `[backpack-viewer] failed to read first-party extensions dir ${firstPartyDir}: ${(err as Error).message}`,
      );
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (disabledFirstParty.has(entry.name)) continue;
      const rootDir = path.join(firstPartyDir, entry.name);
      const loaded = tryLoadOne(rootDir, true);
      if (loaded) out.push(loaded);
    }
  }

  // 2) User-installed external extensions
  for (const ext of userExtensions) {
    if (out.some((e) => e.manifest.name === ext.name)) {
      console.warn(
        `[backpack-viewer] external extension "${ext.name}" shadows a first-party extension; skipping external`,
      );
      continue;
    }
    const loaded = tryLoadOne(ext.path, false);
    if (loaded) out.push(loaded);
  }

  return out;
}

function tryLoadOne(rootDir: string, firstParty: boolean): LoadedExtension | null {
  const manifestPath = path.join(rootDir, "backpack-extension.json");
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (err) {
    console.error(
      `[backpack-viewer] could not read manifest at ${manifestPath}: ${(err as Error).message}`,
    );
    return null;
  }
  try {
    const manifest = validateManifest(raw, manifestPath);
    return { manifest, rootDir, firstParty };
  } catch (err) {
    if (err instanceof ManifestError) {
      console.error(`[backpack-viewer] ${err.message}`);
    } else {
      console.error(
        `[backpack-viewer] failed to validate manifest at ${manifestPath}: ${(err as Error).message}`,
      );
    }
    return null;
  }
}

/**
 * Per-extension settings file path. Each extension gets its own file
 * under `~/.config/backpack/extensions/<name>/settings.json`. The file
 * is created on first write.
 */
export function extensionSettingsPath(extName: string): string {
  return path.join(configDir(), "extensions", extName, "settings.json");
}

/** Ensures the parent directory exists, then atomically writes JSON. */
async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = filePath + ".tmp";
  await fs.promises.writeFile(tmp, JSON.stringify(value));
  await fs.promises.rename(tmp, filePath);
}

export async function readExtensionSettings(
  extName: string,
): Promise<Record<string, unknown>> {
  try {
    const raw = await fs.promises.readFile(extensionSettingsPath(extName), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
    return {};
  } catch {
    return {};
  }
}

export async function writeExtensionSetting(
  extName: string,
  key: string,
  value: unknown,
): Promise<void> {
  const settings = await readExtensionSettings(extName);
  settings[key] = value;
  await atomicWriteJson(extensionSettingsPath(extName), settings);
}

export async function deleteExtensionSetting(extName: string, key: string): Promise<void> {
  const settings = await readExtensionSettings(extName);
  if (!(key in settings)) return;
  delete settings[key];
  await atomicWriteJson(extensionSettingsPath(extName), settings);
}

/**
 * Result of an extension fetch proxy call. Either an error JSON to send
 * back to the client, or an upstream body for the caller to pipe through.
 */
export interface ExtensionFetchResult {
  status: number;
  errorJson?: string;
  upstreamHeaders?: Headers;
  upstreamBody?: ReadableStream<Uint8Array>;
}

interface ProxyRequestPayload {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

/**
 * Forward an extension fetch request to its declared upstream.
 *
 * Validates that the requested URL's origin is in the extension's
 * manifest network allowlist. Injects headers (env-var or literal) per
 * the manifest's `injectHeaders` config. Returns either a structured
 * error or a ReadableStream the caller pipes back to the browser.
 *
 * The browser-side `viewer.fetch(url, init)` POSTs to
 * `/api/extensions/<name>/fetch` with a JSON body matching
 * ProxyRequestPayload. The caller (serve.js / vite plugin) handles the
 * raw HTTP wiring; this function handles validation, secret injection,
 * and the upstream call.
 */
export async function proxyExtensionFetch(
  ext: LoadedExtension,
  rawJsonBody: string,
): Promise<ExtensionFetchResult> {
  let payload: ProxyRequestPayload;
  try {
    payload = JSON.parse(rawJsonBody) as ProxyRequestPayload;
  } catch {
    return {
      status: 400,
      errorJson: JSON.stringify({ error: "invalid JSON body" }),
    };
  }

  if (typeof payload.url !== "string" || !payload.url) {
    return {
      status: 400,
      errorJson: JSON.stringify({ error: "url is required" }),
    };
  }

  let target: URL;
  try {
    target = new URL(payload.url);
  } catch {
    return {
      status: 400,
      errorJson: JSON.stringify({ error: `invalid url: ${payload.url}` }),
    };
  }

  const allowed = ext.manifest.permissions?.network ?? [];
  const matched = allowed.find((entry) => entry.origin === target.origin);
  if (!matched) {
    return {
      status: 403,
      errorJson: JSON.stringify({
        error: `extension "${ext.manifest.name}" is not allowed to call origin ${target.origin} (not in permissions.network)`,
      }),
    };
  }

  // Build outbound headers: caller-supplied headers first, then
  // manifest-declared injectHeaders take priority (so an extension can't
  // override a literal version pin or omit a required key).
  const outHeaders: Record<string, string> = { ...(payload.headers ?? {}) };

  if (matched.injectHeaders) {
    for (const [name, source] of Object.entries(matched.injectHeaders)) {
      if ("literal" in source) {
        outHeaders[name] = source.literal;
      } else {
        const envValue = process.env[source.fromEnv];
        if (!envValue) {
          return {
            status: 503,
            errorJson: JSON.stringify({
              error: `extension "${ext.manifest.name}" requires env var ${source.fromEnv} which is not set. Restart the viewer with: ${source.fromEnv}=... npx backpack-viewer`,
            }),
          };
        }
        outHeaders[name] = envValue;
      }
    }
  }

  let upstream: Response;
  try {
    upstream = await fetch(target.toString(), {
      method: payload.method ?? "POST",
      headers: outHeaders,
      body: payload.body,
    });
  } catch (err) {
    return {
      status: 502,
      errorJson: JSON.stringify({
        error: `extension proxy fetch failed: ${(err as Error).message}`,
      }),
    };
  }

  if (!upstream.body) {
    return {
      status: upstream.status,
      errorJson: JSON.stringify({
        error: `upstream returned no body (status ${upstream.status})`,
      }),
    };
  }

  return {
    status: upstream.status,
    upstreamHeaders: upstream.headers,
    upstreamBody: upstream.body,
  };
}

/**
 * Look up a loaded extension by name. Used by the per-extension
 * endpoints to resolve which extension a request is targeting.
 */
export function findExtension(
  extensions: LoadedExtension[],
  name: string,
): LoadedExtension | null {
  return extensions.find((e) => e.manifest.name === name) ?? null;
}

/**
 * Public manifest serialization — what `GET /api/extensions` returns.
 * Strips no fields currently but exists as the boundary in case we want
 * to filter (e.g., redact env-var names) in the future.
 */
export function publicExtensionInfo(ext: LoadedExtension) {
  return {
    name: ext.manifest.name,
    version: ext.manifest.version,
    viewerApi: ext.manifest.viewerApi,
    displayName: ext.manifest.displayName,
    description: ext.manifest.description,
    entry: ext.manifest.entry,
    stylesheet: ext.manifest.stylesheet,
    permissions: ext.manifest.permissions,
    firstParty: ext.firstParty,
  };
}

/**
 * Resolve the on-disk file path for a request like
 * `/extensions/<name>/<sub-path>`. Validates the sub-path stays within
 * the extension's root dir (no path traversal). Returns null if the
 * extension is unknown or the path escapes.
 */
export function resolveExtensionFile(
  extensions: LoadedExtension[],
  extName: string,
  subPath: string,
): string | null {
  const ext = findExtension(extensions, extName);
  if (!ext) return null;
  // Strip leading slash; path.join + path.normalize would handle it but
  // we want to be explicit.
  const cleaned = subPath.replace(/^\/+/, "");
  if (cleaned.includes("..")) return null;
  const resolved = path.resolve(ext.rootDir, cleaned);
  // Reject anything that resolves outside the extension's root
  if (!resolved.startsWith(path.resolve(ext.rootDir) + path.sep) && resolved !== path.resolve(ext.rootDir)) {
    return null;
  }
  return resolved;
}

// Re-export configDir/dataDir helpers used by callers so they don't
// need a second import path
export { configDir, dataDir };
