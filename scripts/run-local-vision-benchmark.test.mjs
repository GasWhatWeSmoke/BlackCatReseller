import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertPinnedQ6Profile,
  buildServerArguments,
  buildServerSpawnOptions,
  parseRunnerArgs,
  sanitizedEnvironment,
  validateForwardedBenchmarkArgs,
} from "./run-local-vision-benchmark.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const profile = JSON.parse(fs.readFileSync(
  path.join(root, "config", "local-vision-q6-benchmark.json"), "utf8",
));

test("checked-in Q6 profile exactly matches reviewed immutable pins", () => {
  assert.equal(assertPinnedQ6Profile(profile), profile);
  assert.throws(() => assertPinnedQ6Profile({ ...profile, revision: "main" }), /immutable pins/);
});

test("runner accepts bounded tuning and leaves ordinary benchmark flags intact", () => {
  assert.deepEqual(
    parseRunnerArgs([
      "--model-profile", "q6", "--batch=2048", "--micro-batch", "1024",
      "--threads", "8", "--smoke",
    ]),
    {
      modelProfile: "q6",
      batch: 2048,
      microBatch: 1024,
      threads: 8,
      benchmarkArgs: ["--smoke"],
    },
  );
});

test("runner rejects profile overrides, duplicates, and provenance-owned flags", () => {
  assert.throws(() => parseRunnerArgs(["--model-profile", "q4"]), /only accepts/);
  assert.throws(
    () => parseRunnerArgs(["--model-profile", "q6", "--batch", "512", "--batch", "1024"]),
    /only be supplied once/,
  );
  assert.throws(
    () => parseRunnerArgs(["--model-profile", "q6", "--server-pid", "123"]),
    /owned by the pinned benchmark launcher/,
  );
  assert.throws(
    () => parseRunnerArgs(["--model-profile", "q6", "--res", "old.json"]),
    /Unapproved forwarded benchmark argument/,
  );
});

test("forwarded options are allowlisted and photo counts stay bounded", () => {
  assert.deepEqual(
    validateForwardedBenchmarkArgs([
      "--items=3", "--photo-counts", "1", "2", "4", "--output", "results", "--smoke",
    ]),
    ["--items", "3", "--photo-counts", "1", "2", "4", "--output", "results", "--smoke"],
  );
  assert.throws(
    () => validateForwardedBenchmarkArgs(["--photo-counts", "8"]),
    /only accepts/,
  );
});

test("server argv contains one fixed local identity and selected bounded tuning", () => {
  const context = { apiKeyFile: "C:\\repo\\.local\\vision\\api-key.txt" };
  const paths = {
    weights: "C:\\repo\\.local\\vision\\models\\q6\\weights.gguf",
    projector: "C:\\repo\\.local\\vision\\models\\q6\\projector.gguf",
    log: "C:\\repo\\.local\\vision\\logs\\q6.log",
  };
  const args = buildServerArguments(
    context, profile, { batch: 2048, microBatch: 1024, threads: 8 }, paths,
  );
  for (const [flag, expected] of [
    ["-m", paths.weights], ["--mmproj", paths.projector],
    ["--alias", "blackcat-vision"], ["--host", "127.0.0.1"],
    ["--port", "1235"], ["--api-key-file", context.apiKeyFile],
    ["-b", "2048"], ["-ub", "1024"], ["-t", "8"], ["-lv", "4"],
    ["--log-file", paths.log],
  ]) {
    assert.equal(args.filter((value) => value === flag).length, 1, `${flag} count`);
    assert.equal(args[args.indexOf(flag) + 1], expected, `${flag} value`);
  }
  assert.ok(args.includes("--offline"));
  assert.ok(args.includes("--no-webui"));
});

test("launcher strips every llama environment override", () => {
  assert.deepEqual(
    sanitizedEnvironment({ PATH: "ok", LLAMA_ARG_TOOLS: "all", llama_api_key: "drift" }),
    { PATH: "ok" },
  );
});

test("Q6 server has one log writer and cannot flood the launcher console", () => {
  const options = buildServerSpawnOptions(
    { runtimeDirectory: "C:\\repo\\.local\\vision\\runtime" },
    { PATH: "ok", LLAMA_ARG_LOG_VERBOSITY: "99" },
  );
  assert.equal(options.cwd, "C:\\repo\\.local\\vision\\runtime");
  assert.equal(options.windowsHide, true);
  assert.equal(options.stdio, "ignore");
  assert.deepEqual(options.env, { PATH: "ok" });
});
