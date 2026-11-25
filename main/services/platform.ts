/**
 * Everything that differs between operating systems lives here, so a future Windows or
 * Linux build only has to touch this file (plus the app shell).
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export const HOME = os.homedir();

function onPath(name: string): boolean {
  // checks if a certain name (executable generally) is on PATH. (Win/Mac/Linux)
  // get path dirs split by delimiter (; on win32 or :) based on OS.
  const directories = (process.env.PATH ?? "").split(path.delimiter);
  return directories.some((dir) => dir !== "" && fs.existsSync(path.join(dir, name)));
}

let windowsShell: string | null = null; // caching so onPath doesn't run every time.

/** Per-user app config root: ~/Library/Application Support, %APPDATA%, or $XDG_CONFIG_HOME. */
function userConfigRoot(): string {
  switch (process.platform) {
    case "darwin":
      return path.join(HOME, "Library", "Application Support");
    case "win32":
      return process.env.APPDATA || path.join(HOME, "AppData", "Roaming");
    default:
      return process.env.XDG_CONFIG_HOME || path.join(HOME, ".config");
  }
}

/** Cursor's VS Code-style user folder (holds `globalStorage/state.vscdb`). */
export const CURSOR_USER_DIR = path.join(userConfigRoot(), "Cursor", "User");

/** opencode follows XDG on every platform. */
export const XDG_DATA_HOME = process.env.XDG_DATA_HOME || path.join(HOME, ".local", "share");

/** The sqlite3 CLI ships with macOS; elsewhere it must be on PATH. */
export const SQLITE_BINARY = process.platform === "darwin" ? "/usr/bin/sqlite3" : "sqlite3";

/** The user's login shell, used for embedded terminals. */
/** On Windows it defaults to Powershell 5.1 but can be overridden by Powershell 7+ if installed. */
export function defaultShell(): string {
  if (process.platform === "win32") {
    return (windowsShell ??= onPath("pwsh.exe") ? "pwsh.exe" : "powershell.exe");
    /** what it is: check windowsShell is null and based on the boolean from onPath,
     * assigns pwsh or powershell to windowsShell. ??= is if lhs is null it gets rhs value.
     * next time windowsShell is not null so windowsShell gets returned without calling onPath lookups.
     */
  }
  return process.env.SHELL || (process.platform === "darwin" ? "/bin/zsh" : "/bin/bash");
}

/** Arguments that make the shell load the user's profile (PATH, nvm, etc.).
 * Powershell loads the profile automatically, -NoLogo just avoids the default welcome banner.
 */
export function loginShellArgs(): string[] {
  return process.platform === "win32" ? ["-NoLogo"] : ["-l"];
}

/** What the OS calls its trash, for user-facing messages. */
export const TRASH_NAME = process.platform === "win32" ? "Recycle Bin" : "Trash";

export function isAbsolutePath(value: string): boolean {
  return path.isAbsolute(value);
}

/** True when `target` is `base` itself or inside it. */
export function isInside(target: string, base: string): boolean {
  const relative = path.relative(base, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
