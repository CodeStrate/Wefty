import * as fs from "fs";
import * as path from "path";

import { app, logger } from "../electron/runtime.js";

import { HARNESS_IDS, type HarnessId, type ThemeMode, type ThemeSource } from "../shared/types.js";
import { isAbsolutePath } from "./platform.js";
import { isRecord, writeFileAtomic } from "./util.js";

/** Durable library preferences, stored in the app's userData folder. */
export interface Preferences {
  /** Harnesses the user added to the library. Claude Code is the only default. */
  enabledHarnesses: HarnessId[];
  /** Custom display names keyed by absolute project path. */
  projectNames: Record<string, string>;
  /** Projects removed from the library (files untouched). */
  hiddenProjects: string[];
  /** Appearance: follow the OS, or force light/dark. */
  themeSource: ThemeSource;
  /** Colour theme preset, and whether it forces light or dark. */
  themeId: string;
  themeMode: ThemeMode;
  /** Check GitHub releases for a newer Wefty once a day. */
  checkForUpdates: boolean;
  /** When the last update check ran, in ms, so it runs at most once a day. */
  lastUpdateCheck: number;
  /** Remember project changes (either moved or renamed) */
  projectChanges: Record<string, string>;
}

const DEFAULTS: Preferences = {
  enabledHarnesses: ["claude-code"],
  projectNames: {},
  hiddenProjects: [],
  themeSource: "system",
  themeId: "wefty",
  themeMode: "adaptive",
  projectChanges: {},
  checkForUpdates: true,
  lastUpdateCheck: 0,
};

let cached: Preferences | null = null;
let saveChain: Promise<void> = Promise.resolve();

function preferencesFile(): string {
  return path.join(app.getPath("userData"), "preferences.json");
}

function normalize(raw: unknown): Preferences {
  if (!isRecord(raw)) return structuredClone(DEFAULTS);
  const enabled = Array.isArray(raw.enabledHarnesses)
    ? HARNESS_IDS.filter((id) => (raw.enabledHarnesses as unknown[]).includes(id))
    : DEFAULTS.enabledHarnesses;
  const projectNames: Record<string, string> = {};
  if (isRecord(raw.projectNames)) {
    for (const [key, value] of Object.entries(raw.projectNames)) {
      if (isAbsolutePath(key) && typeof value === "string" && value.trim())
        projectNames[key] = value.trim();
    }
  }

  const projectChanges: Record<string, string> = {};
  if (isRecord(raw.projectChanges)) {
    for (const [from, to] of Object.entries(raw.projectChanges)) {
      if (isAbsolutePath(from) && typeof to === "string" && isAbsolutePath(to) && from !== to)
        projectChanges[from] = to;
    }
  }
  const hiddenProjects = Array.isArray(raw.hiddenProjects)
    ? raw.hiddenProjects.filter(
        (value): value is string => typeof value === "string" && isAbsolutePath(value),
      )
    : [];
  const themeSource =
    raw.themeSource === "light" || raw.themeSource === "dark" ? raw.themeSource : "system";
  const themeId =
    typeof raw.themeId === "string" && /^[a-z0-9-]{1,40}$/.test(raw.themeId)
      ? raw.themeId
      : "wefty";
  const themeMode =
    raw.themeMode === "light" || raw.themeMode === "dark" ? raw.themeMode : "adaptive";
  return {
    enabledHarnesses: enabled.length > 0 ? [...enabled] : [...DEFAULTS.enabledHarnesses],
    projectNames,
    projectChanges,
    hiddenProjects: [...new Set(hiddenProjects)],
    themeSource,
    themeId,
    themeMode,
    // On unless turned off in Settings.
    checkForUpdates: raw.checkForUpdates !== false,
    lastUpdateCheck:
      typeof raw.lastUpdateCheck === "number" && raw.lastUpdateCheck > 0 ? raw.lastUpdateCheck : 0,
  };
}

export async function getPreferences(): Promise<Preferences> {
  if (cached) return cached;
  const file = preferencesFile();
  try {
    cached = normalize(JSON.parse(await fs.promises.readFile(file, "utf8")));
  } catch (error) {
    const code = isRecord(error) ? error.code : undefined;
    if (code !== "ENOENT") {
      // Keep the unreadable file for inspection instead of silently overwriting it.
      const backup = `${file}.corrupt-${Date.now()}`;
      logger.error("preferences", `Could not read ${file}; moved to ${backup}: ${String(error)}`);
      await fs.promises.rename(file, backup).catch(() => undefined);
    }
    cached = structuredClone(DEFAULTS);
  }
  return cached;
}

/** Applies `change` to the in-memory preferences and persists them atomically (saves are serialized). */
export async function updatePreferences(
  change: (draft: Preferences) => void,
): Promise<Preferences> {
  const draft = structuredClone(await getPreferences());
  change(draft);
  cached = normalize(draft);
  const snapshot = JSON.stringify(cached, null, 2);
  const file = preferencesFile();
  const write = saveChain.then(async () => {
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await writeFileAtomic(file, snapshot);
  });
  saveChain = write.catch(() => undefined);
  await write;
  return cached;
}
