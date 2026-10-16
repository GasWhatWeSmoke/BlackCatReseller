import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { acquireIntakeLease, intakeJobDir, intakeLeaseActive, latestIntakeJob, readIntakeJob,
  saveIntakeJob, validIntakeJobId, type IntakeJob } from "./intakeJobStore.ts";

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
