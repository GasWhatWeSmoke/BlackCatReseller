const path = require("node:path");
const fs = require("node:fs");
const { spawn } = require("node:child_process");

function openSellerChrome(url, { environment = process.env, exists = fs.existsSync, launch = spawn, display } = {}) {
  if (!display?.secondary || !display.bounds) return Promise.resolve(false);
  const root = path.join(__dirname, '..');
  const python = [environment.BLACKCAT_PYTHON,
    path.join(root, 'worker', '.venv', 'Scripts', 'python.exe'),
    path.join(root, 'worker', 'python', 'python', 'python.exe')].filter(Boolean).find(exists);
  if (!python) return Promise.resolve(false);
  return new Promise(resolve => {
    try {
      // The existing authorized Chrome connection creates an owned background
      // window and verifies normal size. Never hand a URL to a personal tab.
      const child = launch(python, ['-m', 'black_cat_worker.open_browser_link', '--url', url], {
        cwd: path.join(root, 'worker'), stdio: 'ignore', windowsHide: true,
        env: { ...environment, PYTHONPATH: '', BLACKCAT_DATA_ROOT: environment.BLACKCAT_DATA_ROOT || path.join(root, 'var'),
          BLACKCAT_CHROME_OWNER_PID: environment.BLACKCAT_CHROME_OWNER_PID || String(process.pid) },
      });
      const timer = setTimeout(() => { child.kill(); resolve(false); }, 240000);
      timer.unref?.();
      child.once('error', () => { clearTimeout(timer); resolve(false); });
      child.once('exit', code => { clearTimeout(timer); resolve(code === 0); });
    } catch { resolve(false); }
  });
}

const openEtsyChrome = options => openSellerChrome("https://www.etsy.com/your/shops/me/dashboard", options);
const openEbayChrome = options => openSellerChrome("https://www.ebay.com/sh/ovw", options);
const openMercariChrome = options => openSellerChrome("https://www.mercari.com/mypage/listings/active/", options);
module.exports = { openEtsyChrome, openEbayChrome, openMercariChrome, openSellerChrome };
