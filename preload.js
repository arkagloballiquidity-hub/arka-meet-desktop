"use strict";

/**
 * Minimal bridge between the web app and the desktop shell — annotation
 * traffic for the on-screen overlay, nothing else. The web app feature-detects
 * window.arkaDesktop, so the same code runs unchanged in plain browsers.
 */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("arkaDesktop", {
  shareStarted: () => ipcRenderer.send("arka-share-started"),
  shareStopped: () => ipcRenderer.send("arka-share-stopped"),
  /** Mirror a room annotation (stroke/clear) onto the screen overlay. */
  annotateToOverlay: (payload) =>
    ipcRenderer.send("arka-annotate-to-overlay", payload),
  /** Strokes drawn ON the overlay come back to be sent to the room. */
  onAnnotateFromOverlay: (callback) => {
    ipcRenderer.on("arka-annotate-from-overlay", (_event, payload) =>
      callback(payload),
    );
  },
});
