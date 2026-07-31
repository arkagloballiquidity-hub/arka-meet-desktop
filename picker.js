"use strict";

/**
 * Zoom-style screen picker for macOS.
 *
 * Safari and Chrome each impose their own share dialog and web pages cannot
 * change them. A native app can: Electron lets us intercept getDisplayMedia,
 * enumerate screens and windows with thumbnails, and present our own chooser —
 * which is exactly how Zoom does it.
 *
 * The picker is a frameless window rendering a data: URL, so there is no extra
 * file to load and nothing to keep in sync with the web app.
 */

const { BrowserWindow, desktopCapturer, ipcMain, screen } = require("electron");

function pickerHtml(sources) {
  const cards = sources
    .map(
      (s, i) => `
      <button class="card" data-index="${i}">
        <img src="${s.thumbnail}" alt="">
        <span class="name" title="${s.name}">${s.name}</span>
      </button>`,
    )
    .join("");

  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8">
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 20px 22px 88px;
    background: #080B10; color: #F4F7FA;
    font: 300 14px/1.4 -apple-system, system-ui, sans-serif;
    letter-spacing: .01em; user-select: none;
  }
  h1 { margin: 0 0 4px; font-size: 17px; font-weight: 500; }
  p.sub { margin: 0 0 18px; font-size: 12px; color: #8A94A6; }
  .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; }
  .card {
    display: flex; flex-direction: column; gap: 8px; padding: 8px;
    background: #0D1118; border: 1px solid #0B2745; border-radius: 12px;
    cursor: pointer; text-align: left; color: inherit; font: inherit;
    transition: border-color .15s, transform .15s;
  }
  .card:hover { border-color: rgba(0,186,179,.6); transform: translateY(-2px); }
  .card.sel { border-color: #00BAB3; }
  .card img {
    width: 100%; aspect-ratio: 16/10; object-fit: cover;
    border-radius: 7px; background: #030509;
  }
  .name {
    font-size: 11px; color: #C9D2DE;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  footer {
    position: fixed; inset: auto 0 0 0; display: flex; justify-content: flex-end;
    gap: 10px; padding: 14px 22px;
    background: rgba(8,11,16,.94); border-top: 1px solid #0B2745;
    backdrop-filter: blur(12px);
  }
  button.action {
    padding: 9px 22px; border-radius: 999px; cursor: pointer;
    font: 500 13px/1 inherit; border: 1px solid #0B2745;
    background: transparent; color: #8A94A6;
  }
  button.action.primary {
    background: #00BAB3; color: #030509; border-color: #00BAB3;
  }
  button.action.primary:disabled { opacity: .4; cursor: not-allowed; }
</style></head>
<body>
  <h1>Compartir pantalla</h1>
  <p class="sub">Elige una pantalla o una ventana de tu Mac.</p>
  <div class="grid">${cards}</div>
  <footer>
    <button class="action" id="cancel">Cancelar</button>
    <button class="action primary" id="share" disabled>Compartir</button>
  </footer>
<script>
  const { ipcRenderer } = require('electron');
  let sel = null;
  const shareBtn = document.getElementById('share');
  document.querySelectorAll('.card').forEach((card) => {
    card.addEventListener('click', () => {
      document.querySelectorAll('.card').forEach((c) => c.classList.remove('sel'));
      card.classList.add('sel');
      sel = Number(card.dataset.index);
      shareBtn.disabled = false;
    });
    card.addEventListener('dblclick', () => {
      ipcRenderer.send('arka-picker-choose', Number(card.dataset.index));
    });
  });
  shareBtn.addEventListener('click', () => {
    if (sel !== null) ipcRenderer.send('arka-picker-choose', sel);
  });
  document.getElementById('cancel').addEventListener('click', () => {
    ipcRenderer.send('arka-picker-choose', -1);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') ipcRenderer.send('arka-picker-choose', -1);
  });
</script>
</body></html>`;
}

/** Shows the picker and resolves with the chosen source, or null if cancelled. */
async function choose(parent) {
  const sources = await desktopCapturer.getSources({
    types: ["screen", "window"],
    thumbnailSize: { width: 480, height: 300 },
    fetchWindowIcons: false,
  });

  const usable = sources.filter((s) => s.name !== "ARKA Meet");
  if (usable.length === 0) return null;

  const payload = usable.map((s) => ({
    name: s.name,
    thumbnail: s.thumbnail.toDataURL(),
  }));

  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  const win = new BrowserWindow({
    width: Math.min(900, width - 80),
    height: Math.min(620, height - 80),
    parent,
    modal: true,
    show: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    title: "Compartir pantalla",
    backgroundColor: "#080B10",
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });

  win.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(pickerHtml(payload))}`,
  );
  win.once("ready-to-show", () => win.show());

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      ipcMain.removeListener("arka-picker-choose", onChoose);
      if (!win.isDestroyed()) win.close();
      resolve(value);
    };
    const onChoose = (event, index) => {
      if (event.sender !== win.webContents) return;
      finish(index >= 0 ? usable[index] : null);
    };
    ipcMain.on("arka-picker-choose", onChoose);
    // Closing the window with the red button counts as cancelling.
    win.on("closed", () => finish(null));
  });
}

module.exports = { choose };
