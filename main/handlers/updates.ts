import { ipcMain, shell } from "../electron/runtime.js";
import { checkForUpdates, getUpdateInfo, setAutoCheck } from "../services/updates.js";
import { isRecord } from "../services/util.js";

/** Only Wefty's own release pages and files may be opened from the update pill. */
const RELEASE_LINK = /^https:\/\/github\.com\/CodeStrate\/Wefty\/releases\//;

export function registerUpdateHandlers(): void {
  ipcMain.handle("update:get", () => getUpdateInfo());

  /** A check you asked for: runs now, even if one ran today, and reports failures. */
  ipcMain.handle("update:check", () => checkForUpdates());

  ipcMain.handle("update:setAuto", (_event, params: unknown) => {
    const enabled = isRecord(params) ? params.enabled : undefined;
    if (typeof enabled !== "boolean")
      throw new Error('update:setAuto: "enabled" must be a boolean');
    return setAutoCheck(enabled);
  });

  ipcMain.handle("update:open", async (_event, params: unknown) => {
    const url = isRecord(params) ? params.url : undefined;
    if (typeof url !== "string" || !RELEASE_LINK.test(url))
      throw new Error("update:open: only Wefty release links can be opened");
    await shell.openExternal(url);
  });
}
