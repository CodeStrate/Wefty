// Wefty main process: windows, the application menu, and app lifecycle. IPC handlers are
// registered in handlers/; everything else lives in services/.

import type { BrowserWindow, MenuItemConstructorOptions } from "electron";

import { app, dialog, ipcMain, logger, Menu, shell } from "./electron/runtime.js";
import { registerHandlers } from "./handlers/index.js";
import { applySavedTheme } from "./handlers/theme.js";
import { checkForUpdates, startUpdateChecks } from "./services/updates.js";
import { getSettingsWindow, openSettingsWindow } from "./windows/settings-window.js";
import { createSecureWindow } from "./windows/secure-window.js";
import { getAppIconPath, getWindowUrl } from "./windows/window-paths.js";

const APP_NAME = "Wefty";
const isMac = process.platform === "darwin";

app.setName(APP_NAME);

// One instance: a second launch focuses the existing window instead.
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

let mainWindow: BrowserWindow | null = null;

async function createMainWindow(): Promise<void> {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    return;
  }
  mainWindow = createSecureWindow({
    width: 1240,
    height: 800,
    minWidth: 760,
    minHeight: 520,
    title: APP_NAME,
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
    // Settings belongs to the main window: close it too (and on Windows/Linux this lets
    // window-all-closed quit the app instead of leaving a lone Settings window behind).
    getSettingsWindow()?.close();
  });
  await mainWindow.loadURL(getWindowUrl("main-window.html"));
}

/** Help › Check for Updates…: always asks GitHub now, and always answers. */
async function checkForUpdatesFromMenu(): Promise<void> {
  const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
  const show = (options: Electron.MessageBoxOptions) =>
    parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options);
  try {
    const { available, current } = await checkForUpdates();
    if (!available) {
      await show({
        type: "info",
        message: "You're up to date",
        detail: `Wefty ${current} is the latest version.`,
      });
      return;
    }
    const { response } = await show({
      type: "info",
      message: `Wefty ${available.version} is available`,
      detail: `You have ${current}. Download the new version and install it over this one; your library and settings stay as they are.`,
      buttons: ["Download", "Release Notes", "Later"],
      defaultId: 0,
      cancelId: 2,
    });
    if (response === 0) await shell.openExternal(available.downloadUrl);
    if (response === 1) await shell.openExternal(available.notesUrl);
  } catch (error) {
    await show({
      type: "warning",
      message: "Couldn't check for updates",
      detail: `GitHub couldn't be reached (${error instanceof Error ? error.message : String(error)}). Try again later.`,
    });
  }
}

function setupApplicationMenu(): void {
  const checkUpdates: MenuItemConstructorOptions = {
    label: "Check for Updates…",
    click: () => void checkForUpdatesFromMenu(),
  };
  const settings: MenuItemConstructorOptions = {
    label: isMac ? "Settings…" : "Preferences…",
    accelerator: "CmdOrCtrl+,",
    click: () => void openSettingsWindow(),
  };

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: APP_NAME,
            submenu: [
              { role: "about" },
              checkUpdates,
              { type: "separator" },
              settings,
              { type: "separator" },
              { role: "services" },
              { type: "separator" },
              { role: "hide" },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              { role: "quit" },
            ],
          } satisfies MenuItemConstructorOptions,
        ]
      : []),
    {
      label: "File",
      submenu: isMac ? [{ role: "close" }] : [settings, { type: "separator" }, { role: "quit" }],
    },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [
        {
          label: `${APP_NAME} Help`,
          accelerator: "CmdOrCtrl+?",
          click: () => ipcMain.broadcast("help:open", {}),
        },
        { label: "Show Tour", click: () => ipcMain.broadcast("tour:start", {}) },
        // macOS lists it under the app menu, by About.
        ...(isMac ? [] : [{ type: "separator" } as const, checkUpdates]),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.on("second-instance", () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});

// macOS keeps the app running with no windows; other platforms quit.
app.on("window-all-closed", () => {
  if (!isMac) app.quit();
});

app.on("activate", () => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createMainWindow().catch((error) =>
      logger.error("main", "Failed to create main window", error),
    );
  } else {
    mainWindow.show();
  }
});

app.whenReady().then(async () => {
  const icon = getAppIconPath(app.getAppPath());
  // Dev runs the stock Electron.app, so set the Dock icon ourselves (packaged builds use
  // the .icns from build-resources).
  if (isMac && !app.isPackaged) app.dock?.setIcon(icon);
  app.setAboutPanelOptions({
    applicationName: APP_NAME,
    applicationVersion: app.getVersion(),
    iconPath: icon,
    copyright: "CodeStrate",
  });

  registerHandlers();
  await applySavedTheme();
  setupApplicationMenu();
  await createMainWindow().catch((error) =>
    logger.error("main", "Failed to create main window", error),
  );
  startUpdateChecks();
});
