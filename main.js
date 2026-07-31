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

const {
  app,
  BrowserWindow,
  dialog,
  session,
  shell,
  systemPreferences,
} = require("electron");
const path = require("path");
const picker = require("./picker");
const overlay = require("./overlay");
const { ipcMain, screen } = require("electron");

// The display being shared, so the annotation overlay knows where to live.
let sharedDisplay = null;

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

// Sign-in happens in the SYSTEM browser: Electron's webview cannot talk to
// the Mac's passkeys (Touch ID / iCloud Keychain), which forced the "try
// another way" dance. The system browser does the whole ceremony and hands
// the session back through arka-meet:// (see open-url below).
function isLoginPath(url) {
  try {
    const u = new URL(url);
    return (
      (u.host === APP_HOST && u.pathname === "/api/auth/login") ||
      u.host === "accounts.google.com" ||
      u.host.endsWith(".google.com") ||
      u.host === "accounts.youtube.com"
    );
  } catch {
    return false;
  }
}

function openSystemLogin() {
  shell.openExternal(`${APP_URL}/api/auth/login?flow=desktop`);
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

let mainWindow = null;

// macOS ties the Screen Recording grant to the binary's signature; ad-hoc
// builds sign differently on every release, so the old grant looks "on" in
// System Settings while the new binary is actually denied. Detect and guide.
async function ensureScreenPermission() {
  const status = systemPreferences.getMediaAccessStatus("screen");
  if (status === "granted") return true;
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: "info",
    title: "Permiso de grabación de pantalla",
    message: "macOS no le está dando a ARKA Meet acceso a la pantalla.",
    detail:
      "En Ajustes del Sistema → Privacidad y seguridad → Grabación de pantalla: " +
      "quita ARKA Meet de la lista (botón −), vuelve a añadirla (+) y reinicia la app. " +
      "Tras actualizar la app, macOS exige repetir este paso.",
    buttons: ["Abrir Ajustes", "Cancelar"],
    defaultId: 0,
  });
  if (response === 0) {
    shell.openExternal(
      "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
    );
  }
  return false;
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
      preload: path.join(__dirname, "preload.js"),
    },
  });

  // Web permission prompts (getUserMedia, screen share, clipboard) auto-
  // granted for our own origins only — the OS-level TCC permission is still
  // the real gate. Clipboard matters: without it "Copiar invitación" fails
  // silently.
  const ALLOWED_PERMISSIONS = [
    "media",
    "display-capture",
    "notifications",
    "clipboard-sanitized-write",
    "clipboard-write",
    "clipboard-read",
  ];
  session.defaultSession.setPermissionRequestHandler(
    (webContents, permission, callback) => {
      const ours = isOurs(webContents.getURL());
      callback(ours && ALLOWED_PERMISSIONS.includes(permission));
    },
  );
  session.defaultSession.setPermissionCheckHandler(
    (webContents, permission, requestingOrigin) => {
      const ours = isOurs(requestingOrigin || webContents?.getURL?.() || "");
      return ours && ALLOWED_PERMISSIONS.includes(permission);
    },
  );

  // Our own share chooser, Zoom-style. This is the one thing a browser cannot
  // give us: Safari and Chrome each force their own dialog, while here we
  // enumerate screens and windows ourselves and present them with thumbnails.
  session.defaultSession.setDisplayMediaRequestHandler(
    async (request, callback) => {
      try {
        if (!(await ensureScreenPermission())) {
          callback({});
          return;
        }
        const source = await picker.choose(win);
        if (!source) {
          // Electron has no "cancelled" signal; an empty grant is the way to
          // tell the page nothing was picked.
          callback({});
          return;
        }
        // Full-screen shares get the on-screen annotation overlay; window
        // shares stay in-app (their bounds move under our feet).
        sharedDisplay = null;
        if (source.display_id) {
          sharedDisplay =
            screen
              .getAllDisplays()
              .find((d) => String(d.id) === String(source.display_id)) ?? null;
        }
        // System-audio loopback only exists on Windows; requesting it on
        // macOS makes the whole capture fail and the share never starts.
        if (process.platform === "win32") {
          callback({ video: source, audio: "loopback" });
        } else {
          callback({ video: source });
        }
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

  // Login goes to the system browser (passkeys); anything else external
  // (Calendar links etc.) opens there too. Only our own origins stay in-app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isLoginPath(url)) {
      openSystemLogin();
      return { action: "deny" };
    }
    if (isOurs(url)) return { action: "allow" };
    shell.openExternal(url);
    return { action: "deny" };
  });

  win.webContents.on("will-navigate", (event, url) => {
    if (isLoginPath(url)) {
      event.preventDefault();
      openSystemLogin();
      return;
    }
    if (!isOurs(url)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  win.loadURL(APP_URL);
  mainWindow = win;
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });
  return win;
}

// arka-meet://auth?code=… — the system browser hands the session back here.
function handleDeepLink(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== "arka-meet:") return;
    const code = u.searchParams.get("code");
    if (!code) return;
    const win = mainWindow ?? createWindow();
    win.loadURL(
      `${APP_URL}/api/auth/desktop-exchange?code=${encodeURIComponent(code)}`,
    );
    if (win.isMinimized()) win.restore();
    win.focus();
  } catch {
    /* not ours */
  }
}

// The web layer updates itself (cache cleared each launch); this covers the
// SHELL. When GitHub has a newer release, offer the download like any app.
async function checkShellUpdate() {
  try {
    const response = await fetch(
      "https://api.github.com/repos/arkagloballiquidity-hub/arka-meet-desktop/releases/latest",
      { headers: { Accept: "application/vnd.github+json" } },
    );
    if (!response.ok) return;
    const release = await response.json();
    const latest = String(release.tag_name || "").replace(/^v/, "");
    if (!latest || latest === app.getVersion()) return;

    const { response: choice } = await dialog.showMessageBox({
      type: "info",
      title: "Actualización disponible",
      message: `Hay una versión nueva de ARKA Meet (${latest}).`,
      detail:
        `Tienes la ${app.getVersion()}. Descarga el instalador, arrastra la app a Aplicaciones ` +
        "y reemplaza la actual.",
      buttons: ["Descargar", "Después"],
      defaultId: 0,
    });
    if (choice === 0) {
      shell.openExternal(
        "https://github.com/arkagloballiquidity-hub/arka-meet-desktop/releases/latest/download/ARKA-Meet-AppleSilicon.dmg",
      );
    }
  } catch {
    /* offline or rate-limited — try again next launch */
  }
}

// Overlay lifecycle: the web app reports share start/stop, annotations flow
// both ways through it.
ipcMain.on("arka-share-started", (event) => {
  if (sharedDisplay && mainWindow) overlay.open(sharedDisplay, mainWindow);
});
ipcMain.on("arka-share-stopped", () => {
  sharedDisplay = null;
  overlay.close();
});
ipcMain.on("arka-annotate-to-overlay", (_event, payload) => {
  overlay.paint(payload);
});

app.setAsDefaultProtocolClient("arka-meet");

app.on("open-url", (event, url) => {
  event.preventDefault();
  if (app.isReady()) handleDeepLink(url);
  else app.whenReady().then(() => handleDeepLink(url));
});

app.whenReady().then(async () => {
  // The web app IS the product, so a stale HTTP cache means the desktop app
  // silently runs an old build — which is how it ended up without fixes the
  // browser already had. Clearing on launch keeps "it updates itself" true.
  await session.defaultSession.clearCache().catch(() => null);

  await ensureMediaAccess();
  createWindow();

  // Once at launch and then every 6 hours for long-lived sessions.
  checkShellUpdate();
  setInterval(checkShellUpdate, 6 * 60 * 60 * 1000);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  overlay.close();
  // macOS convention: the app lives in the Dock until quit explicitly.
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => overlay.close());
