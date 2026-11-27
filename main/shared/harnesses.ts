/**
 * Harness facts shared by the main process and the renderer. Keep this file free of Node
 * imports (fs, path, os...): the renderer bundles it, and Node code there breaks the window.
 */
import type { HarnessId } from "./types.js";

/** How each harness is named everywhere a person reads it. */
export const HARNESS_NAMES: Record<HarnessId, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  opencode: "Opencode",
  antigravity: "Antigravity",
};
