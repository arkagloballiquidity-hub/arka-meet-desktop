"use strict";

/**
 * ARKA Meet for macOS — a native window over the web app.
 *
 * Deliberately thin: no local UI, no update logic, no state. The product IS
 * https://meet.arkaltd.io; this wrapper contributes a Dock icon, its own
 * window, and OS-level camera/microphone permission handling. Everything else
 * ships through Vercel, so shipping a new desktop feature never requires
 * rebuilding this app.
 */

const { app, BrowserWindow, session, shell, systemPreferences } = require("electron");

const APP_URL = "https://meet.arkaltd.io";
const APP_HOST = new URL(APP_URL).host;
// The call iframe lives on the media host; both are first-party here.
const MEDIA_HOST = "video.arkaltd.io";

function isOurs(url) {
  try {
    const host = new URL(url).host;
    return host === APP_HOST || host === MEDIA_HOST;
  } catch {
    return false;
  }
}

async function ensureMediaAccess() {
  // Triggers the macOS system prompts (TCC) on first launch, so the call
  // screen never sits waiting on a permission the user was never asked for.
  if (process.platform !== "darwin") return;
  try {
    await systemPreferences.askForMediaAccess("microphone");
    await systemPreferences.askForMediaAccess("camera");
  } catch {
    /* user said no — Jitsi will surface it in-call */
  }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 720,
    minHeight: 520,
    title: "ARKA Meet",
    backgroundColor: "#030509",
    titleBarStyle: "hiddenInset",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Web permission prompts (getUserMedia, screen share) auto-granted for our
  // own origins only — the OS-level TCC permission is still the real gate.
  session.defaultSession.setPermissionRequestHandler(
    (webContents, permission, callback) => {
      const ours = isOurs(webContents.getURL());
      const allowed = ["media", "display-capture", "notifications"];
      callback(ours && allowed.includes(permission));
    },
  );

  // Links outside ARKA (e.g. "Agregar a Google Calendar") open in the real
  // browser, never inside this window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!isOurs(url)) {
      shell.openExternal(url);
      return { action: "deny" };
    }
    return { action: "allow" };
  });

  win.webContents.on("will-navigate", (event, url) => {
    if (!isOurs(url)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  win.loadURL(APP_URL);
  return win;
}

app.whenReady().then(async () => {
  await ensureMediaAccess();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  // macOS convention: the app lives in the Dock until quit explicitly.
  if (process.platform !== "darwin") app.quit();
});
