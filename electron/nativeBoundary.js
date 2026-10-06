const { URL } = require("node:url");

function isAppUrl(value, origin) {
  try {
    const parsed = new URL(value);
    return parsed.origin === origin && !parsed.username && !parsed.password;
  } catch { return false; }
}

function assertNativeCaller(event, window, origin) {
  const contents = window && !window.isDestroyed() ? window.webContents : null;
  if (!contents || contents.isDestroyed() || event.sender !== contents ||
      !event.senderFrame || event.senderFrame !== contents.mainFrame ||
      !isAppUrl(event.senderFrame.url, origin)) {
    throw new Error("Native actions are available only from the Black Cat app.");
  }
}

function guardNavigation(contents, origin) {
  // loadURL used by main for the boot splash is not a renderer navigation.
  for (const name of ["will-navigate", "will-frame-navigate", "will-redirect"]) {
    contents.on(name, event => {
      if (!isAppUrl(event.url, origin)) event.preventDefault();
    });
  }
}

async function copyManagedImage(photoPath, { origin, nativeImage, clipboard, checkCaller, request = fetch }) {
  try {
    checkCaller();
    if (typeof photoPath !== "string" || !/\.(jpe?g|png|webp)$/i.test(photoPath)) return false;
    // The photo route checks saved media roots and real paths (including junctions).
    // Never read a renderer-supplied path directly or follow a server redirect.
    const url = new URL("/api/photo", origin);
    url.searchParams.set("path", photoPath);
    const response = await request(url.href, { redirect: "error", signal: AbortSignal.timeout(10000) });
    if (!response.ok) return false;
    const image = nativeImage.createFromBuffer(Buffer.from(await response.arrayBuffer()));
    if (image.isEmpty()) return false;
    checkCaller(); // The window may have closed or navigated during the read.
    clipboard.writeImage(image);
    return true;
  } catch { return false; }
}

module.exports = { isAppUrl, assertNativeCaller, guardNavigation, copyManagedImage };
