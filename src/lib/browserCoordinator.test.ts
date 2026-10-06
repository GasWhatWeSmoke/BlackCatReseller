// Two Nifty runs at once do not queue — Chromium dies on the profile lock with an
// error that reads like a broken install. The upload route had a private flag that
// could not see an edit run; this is the shared claim that replaced it.
import test from "node:test";
import assert from "node:assert/strict";
import {
  claimBrowser, releaseBrowser, browserHolder, browserBusyMessage,
  resetBrowserForTests,
} from "./browserCoordinator.ts";

test("a claim is exclusive", () => {
  resetBrowserForTests();
  assert.equal(claimBrowser("upload 000001"), true);
  assert.equal(claimBrowser("upload 000002"), false);
  releaseBrowser();
  assert.equal(claimBrowser("upload 000002"), true);
  resetBrowserForTests();
});

test("an EDIT cannot start while an UPLOAD holds the browser", () => {
  // The whole reason the lock moved out of the upload route: these two are different
  // endpoints driving the same profile directory.
  resetBrowserForTests();
  assert.equal(claimBrowser("upload 000042"), true);
  assert.equal(claimBrowser("edit 000042"), false);
  assert.match(browserBusyMessage(), /upload 000042/);
  resetBrowserForTests();
});

test("and an upload cannot start while an edit holds it", () => {
  resetBrowserForTests();
  assert.equal(claimBrowser("edit 000003"), true);
  assert.equal(claimBrowser("upload 000003"), false);
  assert.match(browserBusyMessage(), /edit 000003/);
  resetBrowserForTests();
});

test("releasing when nothing is held is harmless", () => {
  resetBrowserForTests();
  releaseBrowser();
  releaseBrowser();
  assert.equal(browserHolder(), null);
  assert.equal(claimBrowser("upload 000009"), true);
  resetBrowserForTests();
});

test("separately loaded startup and API modules share the same browser claim", async () => {
  resetBrowserForTests();
  const startupCopy = await import(new URL("./browserCoordinator.ts?startup-copy", import.meta.url).href);
  assert.equal(claimBrowser("Nifty upload"), true);
  assert.equal(startupCopy.claimBrowser("background sales scan"), false);
  startupCopy.setBrowserNote("Waiting for operator");
  assert.equal(startupCopy.browserHolder(), "Nifty upload");
  startupCopy.releaseBrowser();
  assert.equal(browserHolder(), null);
});
