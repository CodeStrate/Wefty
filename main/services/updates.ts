/**
 * The daily update check: asks GitHub for Wefty's latest release and, if it's newer than the
 * running version, offers its installer. Nothing about you or your library is sent; it's one
 * unauthenticated request for public release data. Unsigned builds can't install updates in
 * place on macOS, so this points to the download instead of updating itself.
 */
import { app, ipcMain, logger } from "../electron/runtime.js";
import type { UpdateInfo } from "../shared/types.js";
import { getPreferences, updatePreferences } from "./preferences.js";
import { isRecord, str } from "./util.js";

const REPO = "CodeStrate/Wefty";
const LATEST_RELEASE = `https://api.github.com/repos/${REPO}/releases/latest`;
const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Wait a little after launch so the check never competes with the first library scan. */
const FIRST_CHECK_DELAY_MS = 15_000;

/** This OS's installer in a release (same files the website links). */
const INSTALLERS: Partial<Record<NodeJS.Platform, RegExp>> = {
  darwin: /\.dmg$/,
  win32: /Setup.*\.exe$/,
  linux: /\.AppImage$/,
};

let available: UpdateInfo["available"] = null;
let timer: NodeJS.Timeout | null = null;

interface Version {
  core: number[];
  pre: string[];
}

function parseVersion(text: string): Version | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(text.trim());
  if (!match) return null;
  return { core: [match[1], match[2], match[3]].map(Number), pre: match[4]?.split(".") ?? [] };
}

/** Semver order: 0.1.2-alpha < 0.1.2-beta < 0.1.2 < 0.2.0-alpha. Positive when `a` is newer. */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] - y.core[i];
  // A release is newer than any pre-release of the same version.
  if (!x.pre.length || !y.pre.length) return y.pre.length - x.pre.length;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined || q === undefined) return p === undefined ? -1 : 1;
    if (p === q) continue;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) return Number(p) - Number(q);
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

async function info(): Promise<UpdateInfo> {
  const prefs = await getPreferences();
  return {
    current: app.getVersion(),
    autoCheck: prefs.checkForUpdates,
    checkedAt: prefs.lastUpdateCheck,
    available,
  };
}

async function announce(): Promise<UpdateInfo> {
  const current = await info();
  ipcMain.broadcast("update:changed", current);
  return current;
}

/** Ask GitHub now. Throws when GitHub can't be reached, so a manual check can say so. */
export async function checkForUpdates(): Promise<UpdateInfo> {
  const response = await fetch(LATEST_RELEASE, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": `Wefty/${app.getVersion()}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
  const release: unknown = await response.json();
  const tag = isRecord(release) ? str(release.tag_name) : null;
  if (!isRecord(release) || !tag) throw new Error("GitHub sent an unexpected release");

  await updatePreferences((draft) => {
    draft.lastUpdateCheck = Date.now();
  });
  const version = tag.replace(/^v/, "");
  if (compareVersions(version, app.getVersion()) > 0) {
    const notesUrl = str(release.html_url) ?? RELEASES_PAGE;
    const pattern = INSTALLERS[process.platform];
    const assets = Array.isArray(release.assets) ? release.assets.filter(isRecord) : [];
    const installer = pattern ? assets.find((asset) => pattern.test(str(asset.name) ?? "")) : null;
    available = {
      version,
      notesUrl,
      downloadUrl: str(installer?.browser_download_url) ?? notesUrl,
    };
    logger.info("updates", `Wefty ${version} is available (running ${app.getVersion()})`);
  } else {
    available = null;
  }
  return announce();
}

/** Check at most once a day while automatic checks are on; quiet about network failures. */
async function checkIfDue(): Promise<void> {
  const prefs = await getPreferences();
  if (!prefs.checkForUpdates || Date.now() - prefs.lastUpdateCheck < DAY_MS) return;
  await checkForUpdates().catch((error: unknown) =>
    logger.warn("updates", `Update check failed: ${String(error)}`),
  );
}

/** Start the daily schedule. Dev builds don't check: their version isn't a release. */
export function startUpdateChecks(): void {
  if (!app.isPackaged || timer) return;
  setTimeout(() => void checkIfDue(), FIRST_CHECK_DELAY_MS);
  // Hourly ticks; checkIfDue lets one through per day, so a laptop that slept still catches up.
  timer = setInterval(() => void checkIfDue(), 60 * 60 * 1000);
}

export async function getUpdateInfo(): Promise<UpdateInfo> {
  return info();
}

export async function setAutoCheck(enabled: boolean): Promise<UpdateInfo> {
  await updatePreferences((draft) => {
    draft.checkForUpdates = enabled;
  });
  if (enabled) void checkIfDue();
  return announce();
}
