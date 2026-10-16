// Exposes a minimal, safe native API to the renderer (window.blackcat).
const { contextBridge, ipcRenderer } = require("electron");

const diagnosticActions = {
  'setup-worker': 'worker_setup', 'pick-folder': 'folder_select', 'pick-file': 'file_select',
  'chrome-connect': 'chrome_connect', 'chrome-disconnect': 'chrome_disconnect',
  'open-ebay-seller': 'ebay_connect', 'open-etsy-seller': 'marketplace_link', 'open-mercari-seller': 'marketplace_link',
  'open-external': 'external_open', 'copy-image': 'photo_copy',
  'open-chrome-widget': 'widget_open', 'open-chrome-extensions': 'widget_settings', 'show-chrome-extension-folder': 'widget_settings',
};
function diagnostic(channel, phase, error) {
  if (!diagnosticActions[channel]) return;
  try {
    window.dispatchEvent(new CustomEvent('blackcat-native-diagnostic', { detail: JSON.stringify({
      action: diagnosticActions[channel], phase,
      ...(error ? { message: `${channel}: ${error.message || 'Native action failed'}` } : {}),
    }) }));
  } catch { /* Diagnostics must never interfere with native actions. */ }
}
function invoke(channel, ...args) {
  diagnostic(channel, 'started');
  try {
    const result = ipcRenderer.invoke(channel, ...args);
    // Observe completion without changing the returned promise or recording arguments/results.
    Promise.resolve(result).then(value => diagnostic(channel, value === false ? 'failed' : 'completed'),
      error => diagnostic(channel, 'failed', error));
    return result;
  } catch (error) { diagnostic(channel, 'failed', error); throw error; }
}

contextBridge.exposeInMainWorld("blackcat", {
  pickFolder: () => invoke("pick-folder"),
  pickFile: () => invoke("pick-file"),
  setupWorker: () => invoke("setup-worker"),
  workerSetupStatus: () => invoke("worker-setup-status"),
  notify: (title, body) => invoke("notify", { title, body }),
  // Opens an https link in the user's REAL default browser (comps lookups) —
  // never in an Electron child window.
  openExternal: (url) => invoke("open-external", url),
  openEtsySeller: () => invoke("open-etsy-seller"),
  openEbaySeller: () => invoke("open-ebay-seller"),
  openMercariSeller: () => invoke("open-mercari-seller"),
  chromeStatus: () => invoke("chrome-status"),
  chromeConnect: () => invoke("chrome-connect"),
  chromeDisconnect: () => invoke("chrome-disconnect"),
  openChromeWidget: () => invoke("open-chrome-widget"),
  openChromeExtensions: () => invoke("open-chrome-extensions"),
  showChromeExtensionFolder: () => invoke("show-chrome-extension-folder"),
  // Copies a managed photo to the OS clipboard (Google Lens flow: copy → paste).
  copyImage: (path) => invoke("copy-image", path),
  // Restores keyboard focus after a native confirm/prompt/alert (Electron dead-input bug).
  refocus: () => invoke("refocus"),
});
