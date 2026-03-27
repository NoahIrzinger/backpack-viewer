import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import defaultConfig from "./default-config.json" with { type: "json" };

export type ViewerConfig = typeof defaultConfig;
export type KeybindingMap = typeof defaultConfig.keybindings;

function viewerConfigDir(): string {
  if (process.env.BACKPACK_DIR) {
    return path.join(process.env.BACKPACK_DIR, "config");
  }
  const xdgConfig = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
  return path.join(xdgConfig, "backpack");
}

function viewerConfigFile(): string {
  return path.join(viewerConfigDir(), "viewer.json");
}

export function loadViewerConfig(): ViewerConfig {
  const filePath = viewerConfigFile();
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const user = JSON.parse(raw);
    return {
      keybindings: { ...defaultConfig.keybindings, ...(user.keybindings ?? {}) },
      display: { ...defaultConfig.display, ...(user.display ?? {}) },
      layout: { ...defaultConfig.layout, ...(user.layout ?? {}) },
      navigation: { ...defaultConfig.navigation, ...(user.navigation ?? {}) },
      lod: { ...defaultConfig.lod, ...(user.lod ?? {}) },
      limits: { ...defaultConfig.limits, ...(user.limits ?? {}) },
    };
  } catch {
    return defaultConfig;
  }
}
