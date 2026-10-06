// Exposes a minimal, safe native API to the renderer (window.blackcat).
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("blackcat", {
  pickFolder: () => ipcRenderer.invoke("pick-folder"),
  pickFile: () => ipcRenderer.invoke("pick-file"),
  setupWorker: () => ipcRenderer.invoke("setup-worker"),
  workerSetupStatus: () => ipcRenderer.invoke("worker-setup-status"),
  notify: (title, body) => ipcRenderer.invoke("notify", { title, body }),
  // Opens an https link in the user's REAL default browser (comps lookups) —
  // never in an Electron child window.
  openExternal: (url) => ipcRenderer.invoke("open-external", url),
  openEtsySeller: () => ipcRenderer.invoke("open-etsy-seller"),
  openEbaySeller: () => ipcRenderer.invoke("open-ebay-seller"),
  openMercariSeller: () => ipcRenderer.invoke("open-mercari-seller"),
  chromeStatus: () => ipcRenderer.invoke("chrome-status"),
  chromeConnect: () => ipcRenderer.invoke("chrome-connect"),
  chromeDisconnect: () => ipcRenderer.invoke("chrome-disconnect"),
  openChromeWidget: () => ipcRenderer.invoke("open-chrome-widget"),
  openChromeExtensions: () => ipcRenderer.invoke("open-chrome-extensions"),
  showChromeExtensionFolder: () => ipcRenderer.invoke("show-chrome-extension-folder"),
  // Copies a managed photo to the OS clipboard (Google Lens flow: copy → paste).
  copyImage: (path) => ipcRenderer.invoke("copy-image", path),
  // Restores keyboard focus after a native confirm/prompt/alert (Electron dead-input bug).
  refocus: () => ipcRenderer.invoke("refocus"),
});
