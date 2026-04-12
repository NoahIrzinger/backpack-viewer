import type { ViewerExtensionAPI, ViewerHost } from "./types";
import { createExtensionAPI } from "./api";
import { createTaskbar } from "./taskbar";
import type { PanelMount } from "./panel-mount";
import { VIEWER_API_VERSION } from "./types";

/**
 * Browser-side extension loader.
 *
 * On startup, fetches `/api/extensions` to learn which extensions the
 * server has loaded. For each one:
 *   1. Constructs a per-extension API instance scoped to its name
 *   2. Loads the extension's stylesheet (if any) by appending a <link>
 *   3. Dynamic-imports the extension's entry file from
 *      `/extensions/<name>/<entry>`
 *   4. Calls `module.activate(api)` inside a try/catch
 *
 * One extension's failure (load error, activate throw) does not affect
 * the others. Errors are surfaced to the console with the extension
 * name so the user can debug.
 */

interface ExtensionInfo {
  name: string;
  version: string;
  viewerApi: string;
  displayName?: string;
  description?: string;
  entry: string;
  stylesheet?: string;
}

export interface LoadedExtensionInstance {
  info: ExtensionInfo;
  api: ViewerExtensionAPI;
}

export async function loadExtensions(
  host: ViewerHost,
  panelMount: PanelMount,
): Promise<LoadedExtensionInstance[]> {
  // Construct the taskbar (icons routed into one of four host-owned
  // slot containers). Panel mount is provided by main.ts so the same
  // instance is shared with built-in panels (info-panel) — that way
  // the click-to-front z-stack and persistent storage work across the
  // whole panel system.
  const taskbar = createTaskbar(host.taskbarSlots);

  let infos: ExtensionInfo[] = [];
  try {
    const res = await fetch("/api/extensions");
    if (!res.ok) {
      console.warn(
        `[backpack-viewer] /api/extensions returned ${res.status}; no extensions will be loaded`,
      );
      return [];
    }
    infos = (await res.json()) as ExtensionInfo[];
  } catch (err) {
    console.error(
      `[backpack-viewer] failed to fetch extensions list: ${(err as Error).message}`,
    );
    return [];
  }

  const loaded: LoadedExtensionInstance[] = [];
  for (const info of infos) {
    if (info.viewerApi !== VIEWER_API_VERSION) {
      console.warn(
        `[backpack-viewer] extension "${info.name}" targets viewerApi "${info.viewerApi}" but this viewer supports "${VIEWER_API_VERSION}"; skipping`,
      );
      continue;
    }

    // Load stylesheet first so it's available before the extension's
    // panel/widget mounts.
    if (info.stylesheet) {
      try {
        loadStylesheet(info.name, info.stylesheet);
      } catch (err) {
        console.error(
          `[backpack-viewer] extension "${info.name}" stylesheet load failed:`,
          err,
        );
      }
    }

    const api = createExtensionAPI(info.name, host, taskbar, panelMount);

    try {
      const moduleUrl = `/extensions/${encodeURIComponent(info.name)}/${info.entry}`;
      const mod = await import(/* @vite-ignore */ moduleUrl);
      const activate = (mod as { activate?: (api: ViewerExtensionAPI) => unknown | Promise<unknown> }).activate;
      if (typeof activate !== "function") {
        console.error(
          `[backpack-viewer] extension "${info.name}" has no exported activate(api) function; skipping`,
        );
        continue;
      }
      await activate(api);
      loaded.push({ info, api });
      console.log(`[backpack-viewer] loaded extension "${info.name}" v${info.version}`);
    } catch (err) {
      console.error(
        `[backpack-viewer] extension "${info.name}" failed to activate:`,
        err,
      );
    }
  }

  return loaded;
}

function loadStylesheet(extName: string, stylesheet: string): void {
  // Reject anything that smells like a path traversal — the server
  // already enforces this server-side, but we mirror it client-side
  // for clarity.
  if (stylesheet.includes("..")) {
    throw new Error(`stylesheet path "${stylesheet}" is invalid`);
  }
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = `/extensions/${encodeURIComponent(extName)}/${stylesheet}`;
  link.dataset.extension = extName;
  document.head.appendChild(link);
}
