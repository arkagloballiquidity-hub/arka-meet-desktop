"use strict";

/**
 * Zoom-style annotation over the REAL screen while sharing.
 *
 * Two windows on the shared display:
 *   - overlay: transparent, full-display, always-on-top, click-through unless
 *     the pencil is on. Paints every stroke of the room (normalized coords ×
 *     display size — a full-screen share maps 1:1).
 *   - toolbar: a small floating pill (pencil / clear), draggable, always
 *     interactive.
 *
 * Strokes drawn here go back to the web app (via main → preload), which sends
 * them to the room like any other annotation.
 */

const { BrowserWindow, ipcMain, screen } = require("electron");

let overlayWin = null;
let toolbarWin = null;
let mainWindowRef = null;

function overlayHtml() {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;height:100%;background:transparent;overflow:hidden}
  canvas{position:fixed;inset:0;cursor:crosshair}
</style></head><body>
<canvas id="c"></canvas>
<script>
  const { ipcRenderer } = require("electron");
  const canvas = document.getElementById("c");
  const ctx = canvas.getContext("2d");
  const strokes = [];
  const known = new Set();
  let pencil = false;
  let current = null;

  function resize() {
    canvas.width = window.innerWidth * devicePixelRatio;
    canvas.height = window.innerHeight * devicePixelRatio;
    ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    redraw();
  }
  window.addEventListener("resize", resize);

  function redraw() {
    const W = window.innerWidth, H = window.innerHeight;
    ctx.clearRect(0, 0, W, H);
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    for (const s of strokes.concat(current ? [current] : [])) {
      if (s.points.length < 2) continue;
      ctx.strokeStyle = s.color || "#00BAB3";
      ctx.lineWidth = Math.max(3, W * 0.004);
      ctx.beginPath();
      s.points.forEach((p, i) => {
        if (i === 0) ctx.moveTo(p.x * W, p.y * H);
        else ctx.lineTo(p.x * W, p.y * H);
      });
      ctx.stroke();
    }
  }

  ipcRenderer.on("paint", (_e, payload) => {
    if (payload.kind === "clear") { strokes.length = 0; known.clear(); current = null; }
    else if (payload.kind === "stroke" && payload.stroke) {
      if (known.has(payload.stroke.id)) return;
      known.add(payload.stroke.id);
      strokes.push(payload.stroke);
    }
    redraw();
  });

  ipcRenderer.on("mode", (_e, on) => { pencil = on; });

  canvas.addEventListener("pointerdown", (e) => {
    if (!pencil) return;
    canvas.setPointerCapture(e.pointerId);
    current = {
      id: Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7),
      color: "#00BAB3",
      points: [{ x: e.clientX / window.innerWidth, y: e.clientY / window.innerHeight }],
    };
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!pencil || !current) return;
    const p = { x: e.clientX / window.innerWidth, y: e.clientY / window.innerHeight };
    const last = current.points[current.points.length - 1];
    if (Math.hypot(p.x - last.x, p.y - last.y) > 0.003) {
      current.points.push(p);
      redraw();
    }
  });
  canvas.addEventListener("pointerup", () => {
    if (!pencil || !current) return;
    const s = current; current = null;
    if (s.points.length > 1) {
      known.add(s.id);
      strokes.push(s);
      ipcRenderer.send("arka-overlay-stroke", s);
    }
    redraw();
  });
  resize();
</script></body></html>`;
}

function toolbarHtml() {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  :root{color-scheme:dark}
  body{margin:0;background:rgba(8,11,16,.92);border:1px solid #0B2745;border-radius:999px;
    display:flex;align-items:center;gap:4px;padding:6px 10px;height:44px;box-sizing:border-box;
    -webkit-app-region:drag;font:500 12px -apple-system,system-ui,sans-serif;color:#8A94A6;user-select:none;overflow:hidden}
  button{-webkit-app-region:no-drag;width:34px;height:32px;border-radius:999px;border:1px solid transparent;
    background:transparent;color:#C9D2DE;cursor:pointer;font-size:15px;display:flex;align-items:center;justify-content:center}
  button:hover{border-color:#0B2745}
  button.on{background:#00BAB3;color:#030509}
  span.grip{cursor:grab;letter-spacing:2px;color:#3a4656;padding:0 2px}
</style></head><body>
  <span class="grip">⋮⋮</span>
  <button id="pen" title="Rayar la pantalla">✏️</button>
  <button id="clear" title="Borrar anotaciones">🗑</button>
<script>
  const { ipcRenderer } = require("electron");
  let on = false;
  const pen = document.getElementById("pen");
  pen.addEventListener("click", () => {
    on = !on;
    pen.classList.toggle("on", on);
    ipcRenderer.send("arka-overlay-mode", on);
  });
  document.getElementById("clear").addEventListener("click", () =>
    ipcRenderer.send("arka-overlay-clear"));
</script></body></html>`;
}

function open(display, mainWindow) {
  close();
  mainWindowRef = mainWindow;
  const { x, y, width, height } = display.bounds;

  overlayWin = new BrowserWindow({
    x, y, width, height,
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    hasShadow: false,
    skipTaskbar: true,
    focusable: true,
    show: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  overlayWin.setAlwaysOnTop(true, "screen-saver");
  overlayWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayWin.setIgnoreMouseEvents(true);
  overlayWin.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(overlayHtml())}`,
  );
  overlayWin.once("ready-to-show", () => overlayWin.showInactive());

  toolbarWin = new BrowserWindow({
    x: x + Math.round(width / 2) - 70,
    y: y + 12,
    width: 140,
    height: 44,
    transparent: true,
    frame: false,
    resizable: false,
    hasShadow: false,
    skipTaskbar: true,
    show: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  toolbarWin.setAlwaysOnTop(true, "screen-saver");
  toolbarWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  toolbarWin.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(toolbarHtml())}`,
  );
  toolbarWin.once("ready-to-show", () => toolbarWin.showInactive());
}

function close() {
  for (const win of [overlayWin, toolbarWin]) {
    if (win && !win.isDestroyed()) win.close();
  }
  overlayWin = null;
  toolbarWin = null;
}

function paint(payload) {
  if (overlayWin && !overlayWin.isDestroyed()) {
    overlayWin.webContents.send("paint", payload);
  }
}

// Toolbar → overlay interactivity; strokes/clears → back to the web app.
ipcMain.on("arka-overlay-mode", (_event, on) => {
  if (overlayWin && !overlayWin.isDestroyed()) {
    overlayWin.setIgnoreMouseEvents(!on);
    overlayWin.webContents.send("mode", on);
    if (on) overlayWin.focus();
  }
});
ipcMain.on("arka-overlay-clear", () => {
  mainWindowRef?.webContents.send("arka-annotate-from-overlay", {
    kind: "clear",
  });
});
ipcMain.on("arka-overlay-stroke", (_event, stroke) => {
  mainWindowRef?.webContents.send("arka-annotate-from-overlay", {
    kind: "stroke",
    stroke,
  });
});

module.exports = { open, close, paint };
