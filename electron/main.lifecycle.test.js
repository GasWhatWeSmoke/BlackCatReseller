"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "main.js"), "utf8");

test("the Electron window and Next server share the exact fixed loopback origin", () => {
  assert.match(source, /const PORT = 41999;/);
  const start = source.indexOf("const isPreview ="), end = source.indexOf("const isDev =");
  assert.ok(start >= 0 && end > start, "The origin selection is explicit before native startup");
  const selection = source.slice(start, end);
  for (const env of [{}, { PORT: "53000" }, { BLACKCAT_PREVIEW_PORT: "53000" }, { BLACKCAT_PREVIEW: "0", BLACKCAT_PREVIEW_PORT: "53000" }]) {
    const actual = vm.runInNewContext(`${selection}; ({ port: serverPort, url: URL })`, { process: { env } });
    assert.equal(actual.port, 41999); assert.equal(actual.url, "http://127.0.0.1:41999");
  }
  assert.match(source, /const URL = `http:\/\/127\.0\.0\.1:\$\{serverPort\}`;/);
  assert.doesNotMatch(source, /process\.env\.PORT|http:\/\/localhost/);
});

test("the isolated preview selects only an explicitly enabled high loopback port", () => {
  const selection = source.slice(source.indexOf("const isPreview ="), source.indexOf("const isDev ="));
  for (const value of ["49152", "53000", "65535"]) {
    const actual = vm.runInNewContext(`${selection}; ({ port: serverPort, url: URL })`, { process: { env: { BLACKCAT_PREVIEW: "1", BLACKCAT_PREVIEW_PORT: value } } });
    assert.equal(actual.port, Number(value)); assert.equal(actual.url, `http://127.0.0.1:${value}`);
  }
  for (const value of ["", "41998", "49151", "65536", "53000.5", "invalid"]) {
    const actual = vm.runInNewContext(`${selection}; serverPort`, { process: { env: { BLACKCAT_PREVIEW: "1", BLACKCAT_PREVIEW_PORT: value } } });
    assert.equal(actual, 41999, "Invalid preview ports cannot change the fixed origin; main rejects preview startup on this port");
  }
});

test("a pending Next restart is cancelled and rechecked during quit", () => {
  assert.match(
    source,
    /function startServerIfNeeded\(\)\s*{\s*if \(isDev \|\| isQuitting\) return;/,
    "the spawn entry point must reject work after quit starts",
  );
  assert.match(
    source,
    /serverRestartTimer = setTimeout\(\(\) => {\s*serverRestartTimer = null;\s*if \(isQuitting\) return;[\s\S]*?startServerIfNeeded\(\);/,
    "the delayed restart callback must recheck quit state before spawning",
  );
  assert.match(
    source,
    /app\.on\("before-quit",[\s\S]*?isQuitting = true;\s*if \(serverRestartTimer\) clearTimeout\(serverRestartTimer\);\s*serverRestartTimer = null;/,
    "quit must clear the retained restart timer",
  );
});
