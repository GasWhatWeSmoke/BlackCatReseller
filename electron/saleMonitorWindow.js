const fs = require('node:fs');
const path = require('node:path');

function writeSaleMonitorWindow(dataRoot, open, ownerPid = process.pid) {
  fs.mkdirSync(dataRoot, { recursive: true });
  fs.writeFileSync(path.join(dataRoot, 'sale-monitor-window.json'), JSON.stringify({ ownerPid, open }));
}

function watchSaleMonitorWindow(win, write) {
  // Minimize still counts as open. Close-to-tray emits hide; reopening emits show.
  write(true);
  win.on('show', () => write(true));
  win.on('hide', () => write(false));
  win.on('closed', () => write(false));
}

module.exports = { writeSaleMonitorWindow, watchSaleMonitorWindow };
