// Two of six overnight sync heartbeats died before the reader process even started —
// Windows could not launch the venv's base interpreter. Nothing was wrong with Nifty or
// the data; the run just never began, then waited three hours to try again. This is the
// predicate that decides whether a failure is worth one retry, and the line it must NOT
// cross is retrying a read that actually reached Nifty and came back with an answer.
import test from "node:test";
import assert from "node:assert/strict";
import { isSpawnFailure } from "./syncSpawn.ts";

test("the real overnight failure is recognized", () => {
  // Verbatim from var/logs/electron.log, 2026-08-21 01:56 and 04:56.
  assert.equal(
    isSpawnFailure(
      "Unable to create process using '\"E:\\Projects\\BlackCatReseller\\worker\\python\\python\\python.exe\" " +
      "-m black_cat_worker.sync_nifty --url https://app.nifty.ai/inventory'",
    ),
    true,
  );
});

test("the other ways a process fails to start are recognized", () => {
  for (const msg of [
    "spawn python.exe ENOENT",
    "spawn C:\\x\\python.exe EACCES",
    "Error: ENOENT: no such file or directory",
    "EAGAIN: resource temporarily unavailable",
    "EBUSY: resource busy or locked",
    "The system cannot find the file specified",
    "The system cannot find the path specified",
  ]) {
    assert.equal(isSpawnFailure(msg), true, msg);
  }
});

test("a real answer from Nifty is NEVER retried", () => {
  // These all mean the reader ran, reached the page, and reported something true.
  // Retrying doubles a browser session to get the same answer.
  for (const msg of [
    "not logged in",
    "no result from reader",
    "sync timed out",
    "playwright-not-installed",
    "the Nifty page could not be read",
    "",
  ]) {
    assert.equal(isSpawnFailure(msg), false, msg);
  }
});

test("it does not throw on rubbish input", () => {
  assert.equal(isSpawnFailure(undefined as unknown as string), false);
  assert.equal(isSpawnFailure(null as unknown as string), false);
});
