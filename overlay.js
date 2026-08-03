"use strict";

/**
 * Zoom-style annotation over the REAL screen while sharing a full display.
 *
 * Two always-on-top windows on the shared display:
 *   - overlay: transparent, click-through unless the pencil is on. Paints the
 *     room's strokes. Coordinates are normalized against the DISPLAY bounds
 *     using absolute screen positions (window.screenX/Y), because macOS may
 *     place the window below the menu bar — measuring, not assuming, is what
 *     keeps local ink and remote ink on the same pixels.
 *   - toolbar: floating pill — pencil, colors, undo (own strokes), clear,
 *     close. Draggable. ESC also drops the pencil.
 *
 * Window shares get no overlay (their bounds move under our feet); those keep
 * the in-app annotation.
 */

const { BrowserWindow, ipcMain, screen } = require("electron");

let overlayWin = null;
let toolbarWin = null;
let mainWindowRef = null;

function overlayHtml(disp) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;height:100%;background:transparent;overflow:hidden}
  canvas{position:fixed;inset:0;cursor:crosshair}
</style></head><body>
<canvas id="c"></canvas>
<script>
  const { ipcRenderer } = require("electron");
  const DISP = ${JSON.stringify(disp)};
  const canvas = document.getElementById("c");
  const ctx = canvas.getContext("2d");
  const strokes = [];
  const known = new Set();
  const mine = [];
  let pencil = false;
  let color = "#00BAB3";
  let current = null;

  function resize() {
    canvas.width = window.innerWidth * devicePixelRatio;
    canvas.height = window.innerHeight * devicePixelRatio;
    ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    redraw();
  }
  window.addEventListener("resize", resize);

  // Display-normalized <-> local window coords, via absolute screen position.
  function toLocal(p) {
    return {
      x: p.x * DISP.width + DISP.x - window.screenX,
      y: p.y * DISP.height + DISP.y - window.screenY,
    };
  }
  function toNorm(e) {
    return {
      x: Math.min(1, Math.max(0, (window.screenX + e.clientX - DISP.x) / DISP.width)),
      y: Math.min(1, Math.max(0, (window.screenY + e.clientY - DISP.y) / DISP.height)),
    };
  }

  function redraw() {
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    for (const s of strokes.concat(current ? [current] : [])) {
      if (s.points.length < 2) continue;
      ctx.strokeStyle = s.color || "#00BAB3";
      ctx.lineWidth = Math.max(3, DISP.width * 0.003);
      ctx.beginPath();
      s.points.forEach((p, i) => {
        const l = toLocal(p);
        if (i === 0) ctx.moveTo(l.x, l.y); else ctx.lineTo(l.x, l.y);
      });
      ctx.stroke();
    }
  }

  ipcRenderer.on("paint", (_e, payload) => {
    if (payload.kind === "clear") {
      strokes.length = 0; known.clear(); mine.length = 0; current = null;
    } else if (payload.kind === "remove" && payload.id) {
      const i = strokes.findIndex((s) => s.id === payload.id);
      if (i >= 0) strokes.splice(i, 1);
    } else if (payload.kind === "stroke" && payload.stroke) {
      if (known.has(payload.stroke.id)) return;
      known.add(payload.stroke.id);
      strokes.push(payload.stroke);
    }
    redraw();
  });
  ipcRenderer.on("mode", (_e, on) => { pencil = on; });
  ipcRenderer.on("color", (_e, c) => { color = c; });
  ipcRenderer.on("undo", () => {
    const id = mine.pop();
    if (id) ipcRenderer.send("arka-overlay-emit", { kind: "remove", id });
  });

  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") ipcRenderer.send("arka-overlay-mode", false);
  });

  canvas.addEventListener("pointerdown", (e) => {
    if (!pencil) return;
    canvas.setPointerCapture(e.pointerId);
    current = {
      id: Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7),
      color,
      points: [toNorm(e)],
    };
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!pencil || !current) return;
    const p = toNorm(e);
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
      mine.push(s.id);
      ipcRenderer.send("arka-overlay-emit", { kind: "stroke", stroke: s });
    }
    redraw();
  });
  resize();
</script></body></html>`;
}

function toolbarHtml() {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  :root{color-scheme:dark}
  body{margin:0;background:rgba(8,11,16,.94);border:1px solid #0B2745;border-radius:999px;
    display:flex;align-items:center;gap:5px;padding:6px 10px;height:46px;box-sizing:border-box;
    -webkit-app-region:drag;font:500 12px -apple-system,system-ui,sans-serif;color:#8A94A6;user-select:none;overflow:hidden}
  button{-webkit-app-region:no-drag;width:32px;height:32px;border-radius:999px;border:1px solid transparent;
    background:transparent;color:#C9D2DE;cursor:pointer;font-size:14px;display:flex;align-items:center;justify-content:center;padding:0}
  button:hover{border-color:#0B2745}
  button.on{background:#00BAB3;color:#030509}
  .dot{width:18px;height:18px;border-radius:999px;border:2px solid transparent;cursor:pointer;-webkit-app-region:no-drag}
  .dot.sel{border-color:#F4F7FA}
  span.grip{cursor:grab;letter-spacing:2px;color:#3a4656}
  .sep{width:1px;height:22px;background:#0B2745}
</style></head><body>
  <span class="grip">⋮⋮</span>
  <button id="pen" title="Rayar (ESC para soltar)">✏️</button>
  <div class="dot sel" data-c="#00BAB3" style="background:#00BAB3"></div>
  <div class="dot" data-c="#C8A96A" style="background:#C8A96A"></div>
  <div class="dot" data-c="#E5484D" style="background:#E5484D"></div>
  <div class="dot" data-c="#F4F7FA" style="background:#F4F7FA"></div>
  <div class="sep"></div>
  <button id="undo" title="Deshacer mi último trazo">↩︎</button>
  <button id="clear" title="Borrar todo (para todos)">🗑</button>
  <button id="exit" title="Cerrar anotaciones">✕</button>
<script>
  const { ipcRenderer } = require("electron");
  let on = false;
  const pen = document.getElementById("pen");
  pen.addEventListener("click", () => {
    on = !on;
    pen.classList.toggle("on", on);
    ipcRenderer.send("arka-overlay-mode", on);
  });
  ipcRenderer.on("mode-sync", (_e, v) => { on = v; pen.classList.toggle("on", v); });
  document.querySelectorAll(".dot").forEach((d) => d.addEventListener("click", () => {
    document.querySelectorAll(".dot").forEach((x) => x.classList.remove("sel"));
    d.classList.add("sel");
    ipcRenderer.send("arka-overlay-color", d.dataset.c);
  }));
  document.getElementById("undo").addEventListener("click", () =>
    ipcRenderer.send("arka-overlay-undo"));
  document.getElementById("clear").addEventListener("click", () =>
    ipcRenderer.send("arka-overlay-emit", { kind: "clear" }));
  document.getElementById("exit").addEventListener("click", () =>
    ipcRenderer.send("arka-overlay-exit"));
</script></body></html>`;
}

function open(display, mainWindow) {
  close();
  mainWindowRef = mainWindow;
  const b = display.bounds;

  overlayWin = new BrowserWindow({
    x: b.x, y: b.y, width: b.width, height: b.height,
    transparent: true, frame: false, resizable: false, movable: false,
    hasShadow: false, skipTaskbar: true, focusable: true, show: false,
    fullscreenable: false,
    enableLargerThanScreen: true,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  overlayWin.setAlwaysOnTop(true, "screen-saver");
  overlayWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayWin.setIgnoreMouseEvents(true);
  // Excluded from screen capture: a transparent Electron window composites
  // as SOLID BLACK in the captured stream — viewers were getting a black
  // screen. Zoom excludes its own windows the same way.
  overlayWin.setContentProtection(true);
  overlayWin.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(
      overlayHtml({ x: b.x, y: b.y, width: b.width, height: b.height }),
    )}`,
  );
  overlayWin.once("ready-to-show", () => {
    overlayWin.showInactive();
    // Simple fullscreen is the one mode macOS guarantees covers the WHOLE
    // display, menu bar included — geometry stops being a guess. The page's
    // measured math (screenX/Y vs display origin) stays as belt-and-braces.
    overlayWin.setSimpleFullScreen(true);
  });

  toolbarWin = new BrowserWindow({
    x: b.x + Math.round(b.width / 2) - 140,
    y: b.y + 12,
    width: 280, height: 46,
    transparent: true, frame: false, resizable: false, hasShadow: false,
    skipTaskbar: true, show: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  toolbarWin.setAlwaysOnTop(true, "screen-saver");
  toolbarWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  toolbarWin.setContentProtection(true);
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

const toWeb = (payload) =>
  mainWindowRef?.webContents.send("arka-annotate-from-overlay", payload);

ipcMain.on("arka-overlay-mode", (_event, on) => {
  if (overlayWin && !overlayWin.isDestroyed()) {
    overlayWin.setIgnoreMouseEvents(!on);
    overlayWin.webContents.send("mode", on);
    if (on) overlayWin.focus();
  }
  if (toolbarWin && !toolbarWin.isDestroyed()) {
    toolbarWin.webContents.send("mode-sync", on);
  }
});
ipcMain.on("arka-overlay-color", (_event, color) => {
  if (overlayWin && !overlayWin.isDestroyed()) {
    overlayWin.webContents.send("color", color);
  }
});
ipcMain.on("arka-overlay-undo", () => {
  if (overlayWin && !overlayWin.isDestroyed()) {
    overlayWin.webContents.send("undo");
  }
});
// Strokes, removes and clears all flow to the web app, which sends them to
// the room; the room loopback repaints us. One source of truth.
ipcMain.on("arka-overlay-emit", (_event, payload) => toWeb(payload));
ipcMain.on("arka-overlay-exit", () => close());

module.exports = { open, close, paint };
