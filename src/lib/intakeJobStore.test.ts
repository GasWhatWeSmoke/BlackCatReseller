import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { acquireIntakeLease, intakeJobDir, intakeLeaseActive, latestIntakeJob, readIntakeJob,
  saveIntakeJob, validIntakeJobId, writeIntakeJson, type IntakeJob } from "./intakeJobStore.ts";

test("atomic checkpoints survive transient Windows replacement locks without deleting the saved version", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "blackcat-checkpoint-lock-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filename = path.join(root, "checkpoint.json");
  writeIntakeJson(filename, { revision: 1 });
  const rename = fs.renameSync;
  let attempts = 0;
  const mocked = t.mock.method(fs, "renameSync", (source: fs.PathLike, destination: fs.PathLike) => {
    assert.deepEqual(JSON.parse(fs.readFileSync(filename, "utf8")), { revision: 1 });
    if (++attempts < 3) throw Object.assign(Error("Windows sharing lock"), { code: "EPERM" });
    return rename(source, destination);
  });
  writeIntakeJson(filename, { revision: 2 }); mocked.mock.restore();
  assert.equal(attempts, 3);
  assert.deepEqual(JSON.parse(fs.readFileSync(filename, "utf8")), { revision: 2 });
  assert.deepEqual(fs.readdirSync(root), ["checkpoint.json"]);
  t.mock.method(fs, "renameSync", () => { throw Object.assign(Error("I/O failure"), { code: "EIO" }); });
  assert.throws(() => writeIntakeJson(filename, { revision: 3 }), /I\/O failure/);
  assert.deepEqual(JSON.parse(fs.readFileSync(filename, "utf8")), { revision: 2 });
  assert.deepEqual(fs.readdirSync(root), ["checkpoint.json"]);
});

test("job checkpoints survive reconstruction, are isolated per workspace, and reject traversal", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "blackcat-jobs-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = { dataRoot: path.join(root, "one") }, other = { dataRoot: path.join(root, "two") };
  const id = randomUUID();
  const job: IntakeJob = { id, state: "detecting", stage: "decode", createdAt: "now", updatedAt: "now", heartbeatAt: "now",
    ownerPid: process.pid, attempt: 1, manifestRevision: 0, forceNoAi: true, seq: 200,
    event: { stage: "decode", done: 200, total: 1000 } };
  saveIntakeJob(workspace, job);
  assert.deepEqual(readIntakeJob(workspace, id), job);
  assert.deepEqual(latestIntakeJob(workspace), job);
  assert.equal(latestIntakeJob(other), null);
  assert.equal(readIntakeJob(other, id), null);
  assert.equal(validIntakeJobId("../../other"), false);
  assert.throws(() => intakeJobDir(workspace, "../../other"));
  assert.deepEqual(fs.readdirSync(intakeJobDir(workspace, id)), ["job.json"]);
});

test("the durable lease rejects competing owners and releases only its own token", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "blackcat-lease-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = { dataRoot: root };
  const release = acquireIntakeLease(workspace, randomUUID());
  assert.equal(intakeLeaseActive(workspace), true);
  assert.throws(() => acquireIntakeLease(workspace, randomUUID()), /INTAKE_BUSY/);
  release();
  assert.equal(intakeLeaseActive(workspace), false);
  const releaseNext = acquireIntakeLease(workspace, randomUUID());
  release(); // old cleanup cannot unlock the next owner's work
  assert.equal(intakeLeaseActive(workspace), true);
  releaseNext();
});
