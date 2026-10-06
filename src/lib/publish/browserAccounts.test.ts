import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { AppSettingsData } from "../types.ts";
import { claimBrowser, releaseBrowser, browserHolder } from "../browserCoordinator.ts";
import { browserAccountStatus, confirmBrowserAccountLogin, startBrowserAccountLogin } from "./browserAccounts.ts";
import { BROWSER_MARKETPLACES, isBrowserMarketplace } from "./platforms.ts";

function fixture(t: TestContext, pid: number | undefined = 12345) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "blackcat-account-test-"));
  const settings = { dataRoot: root, logsPath: path.join(root, "logs"), pythonWorkerPath: process.execPath } as AppSettingsData;
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), pid });
  t.after(async () => {
    child.emit("close", 1);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  return { root, settings, child, launch: () => child as unknown as ChildProcessWithoutNullStreams };
}

test("login holds the browser claim through the worker report and only confirms after closure", (t) => {
  const { settings, child, launch } = fixture(t);
  assert.equal(startBrowserAccountLogin(settings, "ebay", launch).ok, true);
  assert.equal(browserAccountStatus(settings, "ebay").loginInProgress, true);
  assert.equal(claimBrowser("publish"), false);
  assert.equal(startBrowserAccountLogin(settings, "ebay", launch).ok, false);
  assert.equal(startBrowserAccountLogin(settings, "etsy", launch).ok, false);
  child.stdout.write("MARKETPLACE_LOGIN_DONE window-closed\n");
  assert.equal(confirmBrowserAccountLogin(settings, "ebay").ok, false);
  assert.equal(browserHolder(), "eBay login");
  child.emit("close", 0);
  assert.equal(browserHolder(), null);
  assert.equal(browserAccountStatus(settings, "ebay").awaitingConfirmation, true);
  assert.equal(browserAccountStatus(settings, "ebay").loggedIn, false);
  assert.equal(confirmBrowserAccountLogin(settings, "ebay").ok, true);
  assert.equal(browserAccountStatus(settings, "ebay").loggedIn, true);
  assert.equal(browserAccountStatus(settings, "ebay").awaitingConfirmation, false);
  assert.equal(confirmBrowserAccountLogin(settings, "ebay").ok, false);
});

test("a missing interpreter process releases the claim and never reports successful login", (t) => {
  const { settings, child, launch } = fixture(t, undefined);
  // Explicitly model a spawn failure, which has no process id.
  child.pid = undefined as unknown as number;
  startBrowserAccountLogin(settings, "etsy", launch);
  child.emit("error", new Error("spawn ENOENT"));
  assert.equal(browserHolder(), null);
  assert.equal(browserAccountStatus(settings, "etsy").loginInProgress, false);
  assert.equal(browserAccountStatus(settings, "etsy").awaitingConfirmation, false);
  assert.match(browserAccountStatus(settings, "etsy").error!, /ENOENT/);
});

test("an error after launch retains ownership until the process closes", (t) => {
  const { settings, child, launch } = fixture(t);
  startBrowserAccountLogin(settings, "poshmark", launch);
  child.emit("error", new Error("process error"));
  assert.equal(browserHolder(), "Poshmark login");
  child.emit("close", 1);
  assert.equal(browserHolder(), null);
  assert.equal(browserAccountStatus(settings, "poshmark").awaitingConfirmation, false);
});

test("closing without the worker handoff is not a confirmed sign-in", (t) => {
  const { settings, child, launch } = fixture(t);
  startBrowserAccountLogin(settings, "depop", launch);
  child.stdout.write("MARKETPLACE_LOGIN_DONE incomplete\n");
  child.emit("close", 0);
  assert.equal(confirmBrowserAccountLogin(settings, "depop").ok, false);
  assert.equal(browserAccountStatus(settings, "depop").loggedIn, false);
});

test("an active publish prevents login without invalidating an existing linked account", (t) => {
  const { root, settings, launch } = fixture(t);
  fs.writeFileSync(path.join(root, "depop-login-ok.json"), "{}");
  assert.equal(claimBrowser("active publish"), true);
  try {
    assert.equal(startBrowserAccountLogin(settings, "depop", launch).ok, false);
    assert.equal(browserAccountStatus(settings, "depop").loggedIn, true);
  } finally { releaseBrowser(); }
});

test("only the five requested marketplace identifiers can reach login routes", () => {
  for (const name of BROWSER_MARKETPLACES) assert.equal(isBrowserMarketplace(name), true);
  for (const name of ["../depop", "EBAY", "amazon", "", "https://example.test"]) assert.equal(isBrowserMarketplace(name), false);
});
