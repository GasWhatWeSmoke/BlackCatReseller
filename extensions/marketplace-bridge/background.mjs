import { APP_URL, createController } from "./controller.mjs";
const handle = createController(chrome);
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  handle(request, sender).then((result) => sendResponse({ ok: true, result }),
    (error) => sendResponse({ ok: false, error: error.message }));
  return true;
});
chrome.action.onClicked.addListener(() => chrome.tabs.create({ url: APP_URL }));
