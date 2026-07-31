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
const picker = require("./picker");

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

// Google sign-in MUST complete inside this window: the OAuth state cookie is
// set here, so finishing the flow in Safari lands on a session the app never
// sees (and a state mismatch besides). Google blocks known embedded webviews
// by user-agent, so the Electron token is stripped below.
function isAuthFlow(url) {
  try {
    const host = new URL(url).host;
    return (
      host === "accounts.google.com" ||
      host.endsWith(".google.com") ||
      host === "accounts.youtube.com"
    );
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
    // A real title bar, deliberately. With "hiddenInset" the video grid ran
    // edge to edge under the traffic lights, leaving nowhere to grab the
    // window and nothing to click past the tiles. Zoom keeps a title bar for
    // the same reason.
    titleBarStyle: "default",
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

  // Our own share chooser, Zoom-style. This is the one thing a browser cannot
  // give us: Safari and Chrome each force their own dialog, while here we
  // enumerate screens and windows ourselves and present them with thumbnails.
  session.defaultSession.setDisplayMediaRequestHandler(
    async (request, callback) => {
      try {
        const source = await picker.choose(win);
        if (!source) {
          // Electron has no "cancelled" signal; an empty grant is the way to
          // tell the page nothing was picked.
          callback({});
          return;
        }
        callback({ video: source, audio: "loopback" });
      } catch {
        callback({});
      }
    },
    { useSystemPicker: false },
  );

  // Google's webview blocklist keys on the Electron UA token.
  const cleanUA = win.webContents
    .getUserAgent()
    .replace(/\sElectron\/[\d.]+/, "")
    .replace(/\sarka-meet-desktop\/[\d.]+/, "");
  win.webContents.setUserAgent(cleanUA);

  // Sign-in stays in-window; anything else external (Calendar links etc.)
  // opens in the real browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isOurs(url) || isAuthFlow(url)) return { action: "allow" };
    shell.openExternal(url);
    return { action: "deny" };
  });

  win.webContents.on("will-navigate", (event, url) => {
    if (!isOurs(url) && !isAuthFlow(url)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  win.loadURL(APP_URL);
  return win;
}

app.whenReady().then(async () => {
  // The web app IS the product, so a stale HTTP cache means the desktop app
  // silently runs an old build — which is how it ended up without fixes the
  // browser already had. Clearing on launch keeps "it updates itself" true.
  await session.defaultSession.clearCache().catch(() => null);

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
