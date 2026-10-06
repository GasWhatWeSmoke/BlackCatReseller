(() => {
  if (location.href !== "http://127.0.0.1:41999/browser-link" || window !== window.top) return;
  window.addEventListener("message", (event) => {
    const message = event.data;
    if (event.source !== window || event.origin !== location.origin || message?.channel !== "blackcat-request" || typeof message.id !== "string") return;
    chrome.runtime.sendMessage(message.request, (response) => {
      const error = chrome.runtime.lastError;
      window.postMessage({ channel: "blackcat-response", id: message.id,
        response: error ? { ok: false, error: error.message } : response }, location.origin);
    });
  });
})();
