import { VIEWER_API_VERSION } from "./types.js";

/**
 * Manifest schema for `backpack-extension.json`. Hand-rolled validation
 * (no zod) because the manifest is small and we want zero runtime deps
 * for the extension system.
 */

export interface NetworkPermission {
  /** Origin the extension is allowed to call (e.g. "https://api.anthropic.com") */
  origin: string;
  /**
   * Headers to inject server-side when this extension fetches the
   * matching origin. Each value is either { fromEnv: ENV_VAR_NAME } —
   * pulled from process.env, never sent to browser — or { literal: "..." }
   * — a fixed string baked into the manifest. Used for things like API
   * keys (env) or anthropic-version (literal).
   */
  injectHeaders?: Record<string, { fromEnv: string } | { literal: string }>;
}

export interface ManifestPermissions {
  graph?: ("read" | "write")[];
  viewer?: ("focus" | "pan")[];
  settings?: boolean;
  network?: NetworkPermission[];
}

export interface ExtensionManifest {
  /** Extension id, must match its on-disk dir name. */
  name: string;
  /** Extension version (semver-ish, free-form). */
  version: string;
  /** Versioned API contract this extension targets. */
  viewerApi: string;
  /** Human-readable display name shown in the UI. */
  displayName?: string;
  /** Short user-facing description. */
  description?: string;
  /** Path to the JS entry file, relative to the extension directory. */
  entry: string;
  /** Optional CSS file relative to the extension dir. */
  stylesheet?: string;
  /** What this extension is allowed to do. */
  permissions?: ManifestPermissions;
}

export class ManifestError extends Error {
  constructor(extensionPath: string, problem: string) {
    super(`Invalid manifest at ${extensionPath}: ${problem}`);
    this.name = "ManifestError";
  }
}

/**
 * Validate a parsed manifest object. Throws ManifestError on invalid input.
 * Returns the typed manifest. Stricter than tsc since the file comes from
 * disk; we want clear errors at load time, not silent misbehavior later.
 */
export function validateManifest(raw: unknown, extensionPath: string): ExtensionManifest {
  if (!raw || typeof raw !== "object") {
    throw new ManifestError(extensionPath, "must be a JSON object");
  }
  const obj = raw as Record<string, unknown>;

  function requireString(field: string): string {
    const v = obj[field];
    if (typeof v !== "string" || !v) {
      throw new ManifestError(extensionPath, `field "${field}" must be a non-empty string`);
    }
    return v;
  }

  const name = requireString("name");
  const version = requireString("version");
  const viewerApi = requireString("viewerApi");
  const entry = requireString("entry");

  if (viewerApi !== VIEWER_API_VERSION) {
    throw new ManifestError(
      extensionPath,
      `viewerApi "${viewerApi}" is not supported (this viewer supports "${VIEWER_API_VERSION}")`,
    );
  }

  if (!/^[a-z0-9][a-z0-9-_]*$/.test(name)) {
    throw new ManifestError(
      extensionPath,
      `name "${name}" must be lowercase with hyphens/underscores only — used as a URL path segment and a directory name`,
    );
  }

  // Optional fields
  const displayName = typeof obj.displayName === "string" ? obj.displayName : undefined;
  const description = typeof obj.description === "string" ? obj.description : undefined;
  const stylesheet = typeof obj.stylesheet === "string" ? obj.stylesheet : undefined;

  let permissions: ManifestPermissions | undefined;
  if (obj.permissions !== undefined) {
    if (!obj.permissions || typeof obj.permissions !== "object") {
      throw new ManifestError(extensionPath, "permissions must be an object");
    }
    permissions = validatePermissions(obj.permissions as Record<string, unknown>, extensionPath);
  }

  return { name, version, viewerApi, displayName, description, entry, stylesheet, permissions };
}

function validatePermissions(
  raw: Record<string, unknown>,
  extensionPath: string,
): ManifestPermissions {
  const out: ManifestPermissions = {};

  if (raw.graph !== undefined) {
    if (!Array.isArray(raw.graph)) {
      throw new ManifestError(extensionPath, "permissions.graph must be an array");
    }
    out.graph = raw.graph.filter((v): v is "read" | "write" => v === "read" || v === "write");
  }

  if (raw.viewer !== undefined) {
    if (!Array.isArray(raw.viewer)) {
      throw new ManifestError(extensionPath, "permissions.viewer must be an array");
    }
    out.viewer = raw.viewer.filter((v): v is "focus" | "pan" => v === "focus" || v === "pan");
  }

  if (raw.settings !== undefined) {
    out.settings = raw.settings === true;
  }

  if (raw.network !== undefined) {
    if (!Array.isArray(raw.network)) {
      throw new ManifestError(extensionPath, "permissions.network must be an array");
    }
    out.network = raw.network.map((entry, i) => validateNetworkEntry(entry, i, extensionPath));
  }

  return out;
}

function validateNetworkEntry(
  raw: unknown,
  index: number,
  extensionPath: string,
): NetworkPermission {
  if (!raw || typeof raw !== "object") {
    throw new ManifestError(
      extensionPath,
      `permissions.network[${index}] must be an object with { origin, injectHeaders? }`,
    );
  }
  const obj = raw as Record<string, unknown>;
  const origin = obj.origin;
  if (typeof origin !== "string" || !origin) {
    throw new ManifestError(
      extensionPath,
      `permissions.network[${index}].origin must be a non-empty string`,
    );
  }
  // Reject obviously bad shapes early
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new ManifestError(
      extensionPath,
      `permissions.network[${index}].origin "${origin}" is not a valid URL`,
    );
  }
  if (parsed.pathname !== "/" && parsed.pathname !== "") {
    throw new ManifestError(
      extensionPath,
      `permissions.network[${index}].origin must be a bare origin (no path); got "${origin}"`,
    );
  }

  let injectHeaders: NetworkPermission["injectHeaders"];
  if (obj.injectHeaders !== undefined) {
    if (!obj.injectHeaders || typeof obj.injectHeaders !== "object") {
      throw new ManifestError(
        extensionPath,
        `permissions.network[${index}].injectHeaders must be an object`,
      );
    }
    injectHeaders = {};
    for (const [headerName, value] of Object.entries(obj.injectHeaders as Record<string, unknown>)) {
      if (!value || typeof value !== "object") {
        throw new ManifestError(
          extensionPath,
          `injectHeaders.${headerName} must be an object`,
        );
      }
      const v = value as Record<string, unknown>;
      if (typeof v.fromEnv === "string") {
        injectHeaders[headerName] = { fromEnv: v.fromEnv };
      } else if (typeof v.literal === "string") {
        injectHeaders[headerName] = { literal: v.literal };
      } else {
        throw new ManifestError(
          extensionPath,
          `injectHeaders.${headerName} must have either fromEnv (string) or literal (string)`,
        );
      }
    }
  }

  return { origin: parsed.origin, injectHeaders };
}
