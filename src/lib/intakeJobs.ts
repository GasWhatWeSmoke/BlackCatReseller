import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { prisma } from "./db";
import type { AppSettingsData, WorkerResult } from "./types";
import { persistWorkerResult } from "./persist";
import { validateWorkerResult } from "./workerResultValidation";
import { startIntake, tryReserveIntake, releaseIntakePrep, tryReserveIncomingMutation,
  releaseIncomingMutation, INTAKE_CANCELLED, type IntakeAdmission, type IntakeHandle } from "./worker";
import { activeIntakeState, acquireIntakeLease, intakeJobDir, latestIntakeJob,
  processAlive, readIntakeJob, saveIntakeJob, writeIntakeJson, type IntakeJob } from "./intakeJobStore";
export { intakeJobDir, readIntakeJob } from "./intakeJobStore";

type Event = Record<string, unknown>;
interface LiveJob {
  job: IntakeJob;
  admission: Promise<IntakeAdmission>;
  terminal: Promise<Event>;
  subscribe: (listener: (event: Event) => void) => () => void;
  intake?: IntakeHandle;
}
const registry = globalThis as unknown as { __bcaDurableIntake?: Map<string, LiveJob> };
const liveJobs = registry.__bcaDurableIntake ??= new Map();
const key = (settings: AppSettingsData) => path.resolve(settings.dataRoot);

function revisionAt(directory: string): number {
  try {
    const revision = JSON.parse(fs.readFileSync(path.join(directory, "corrections.json"), "utf8")).revision;
    if (!Number.isSafeInteger(revision) || revision < 0) throw new Error("Invalid correction revision");
    return revision;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

export function intakeJobSnapshot(settings: AppSettingsData) {
  const active = liveJobs.get(key(settings));
  let job = active?.job ?? latestIntakeJob(settings);
  if (job && !active && activeIntakeState(job.state) && !processAlive(job.ownerPid)) {
    job = { ...job, state: "interrupted", stage: "interrupted", updatedAt: new Date().toISOString(),
      error: "The application stopped before this batch finished. Resume to continue from saved checkpoints." };
    saveIntakeJob(settings, job);
  }
  if (job && !active && activeIntakeState(job.state) && Date.now() - Date.parse(job.heartbeatAt) > 30_000) {
    job = { ...job, state: "interrupted", stage: "interrupted",
      error: "The processing service has stopped reporting. Its owner must exit before this batch can safely resume." };
  }
  return { running: !!job && activeIntakeState(job.state), seq: job?.seq ?? 0, event: job?.event ?? null, job };
}

/** Corrections and launches share both the in-process workset reservation and
 * the durable workspace lease. UI pages may detach; only explicit cancel stops work. */
export async function withIntakeJobMutation<T>(settings: AppSettingsData, id: string,
  action: (job: IntakeJob, directory: string) => T | Promise<T>): Promise<T> {
  if (!tryReserveIncomingMutation()) throw new Error("INTAKE_BUSY");
  let release: (() => void) | undefined;
  try {
    release = acquireIntakeLease(settings, id);
    const job = readIntakeJob(settings, id);
    if (!job) throw new Error("Intake job not found");
    if (activeIntakeState(job.state) && processAlive(job.ownerPid)) throw new Error("INTAKE_BUSY");
    await checkpointCommitted(settings, job);
    return await action(job, intakeJobDir(settings, id));
  } finally { release?.(); releaseIncomingMutation(); }
}

/** Rebuild from committed SQLite rows, including a crash before the JSON checkpoint. */
async function checkpointCommitted(settings: AppSettingsData, job: IntakeJob) {
  const directory = intakeJobDir(settings, job.id);
  const receipt = await prisma.intakeReceipt.findUnique({ where: { jobId: job.id } });
  const manifestFile = path.join(directory, "manifest.json");
  if (!receipt || !fs.existsSync(manifestFile)) return;
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  const photos = (manifest.photos ?? []) as Array<{ id: string; photoId?: string; sha256: string; originalFilename: string }>;
  const items = await prisma.item.findMany({ where: { batchId: receipt.batchId }, include: { photos: true } });
  const collisions = await prisma.collision.findMany({ where: { batchId: receipt.batchId } });
  const committedGroups = [...items, ...collisions.map(collision => ({ sku: collision.sku,
    photos: JSON.parse(collision.incomingPhotosJson) as Array<{ sha256: string; originalFilename: string }> }))];
  const groups = committedGroups.map(item => ({ sku: item.sku, photoIds: item.photos.flatMap(photo =>
    photos.filter(source => source.sha256 === photo.sha256 && source.originalFilename === photo.originalFilename)
      .map(source => source.id ?? source.photoId).filter((id): id is string => !!id)) }));
  job.committedPhotoIds = [...new Set(groups.flatMap(group => group.photoIds))];
  writeIntakeJson(path.join(directory, "committed.json"), { revision: job.manifestRevision, groups });
  saveIntakeJob(settings, job);
}

/** Already committed groups need no second receipt validation against incoming
 * files which were correctly archived after their transaction. Match exact saved
 * paths and hashes in this job's batch before removing them from a retry receipt. */
async function uncommittedResult(raw: WorkerResult, job: IntakeJob): Promise<WorkerResult> {
  const receipt = await prisma.intakeReceipt.findUnique({ where: { jobId: job.id } });
  if (!receipt) return raw;
  const items = await prisma.item.findMany({ where: { batchId: receipt.batchId }, include: { photos: true } });
  const collisions = await prisma.collision.findMany({ where: { batchId: receipt.batchId } });
  const samePhotos = (a: { storedPath: string; sha256?: string | null }[], b: { storedPath: string; sha256?: string | null }[]) =>
    a.length === b.length && a.every(p => b.some(q => p.storedPath === q.storedPath && p.sha256 === q.sha256));
  const removedNames = new Set<string>();
  const remainingItems = raw.items.filter(item => {
    const found = items.find(saved => saved.sku === item.sku && samePhotos(item.photos, saved.photos));
    if (found) for (const row of item.grouping?.log ?? []) removedNames.add(row.file);
    return !found;
  });
  const remainingCollisions = raw.collisions.filter(col => {
    const found = collisions.some(saved => saved.sku === col.sku && samePhotos(col.photos, JSON.parse(saved.incomingPhotosJson)));
    if (found) for (const row of col.grouping?.log ?? []) removedNames.add(row.file);
    return !found;
  });
  const duplicates = raw.duplicates.filter(photo => !removedNames.has(photo.originalFilename));
  return { ...raw, items: remainingItems, collisions: remainingCollisions, duplicates,
    counts: { ...raw.counts, itemsCreated: remainingItems.length, collisions: remainingCollisions.length,
      duplicatesSkipped: duplicates.length,
      photosProcessed: [...remainingItems, ...remainingCollisions].reduce((n, item) => n + item.photos.length, duplicates.length) } };
}

export function existingIntakeJob(settings: AppSettingsData): LiveJob | undefined {
  return liveJobs.get(key(settings));
}

/** Cancellation belongs to the job, including its queued pre-worker phase.
 * Once committing has begun, finish the atomic receipt instead of claiming a
 * cancellation which cannot undo already committed inventory. */
export async function cancelIntakeJob(settings: AppSettingsData): Promise<boolean> {
  const live = existingIntakeJob(settings);
  if (!live || live.job.state === "persisting") return false;
  live.job.cancelRequested = true;
  saveIntakeJob(settings, live.job);
  live.intake?.cancel();
  await live.terminal;
  return live.job.state === "cancelled";
}

export function startIntakeJob(settings: AppSettingsData, options: { forceNoAi: boolean; resumeJobId?: string }): LiveJob {
  const existing = existingIntakeJob(settings);
  if (existing) {
    if (options.resumeJobId && options.resumeJobId !== existing.job.id) throw new Error("INTAKE_BUSY");
    return existing;
  }
  const last = latestIntakeJob(settings);
  if (last?.workerPid && !processAlive(last.ownerPid) && processAlive(last.workerPid)) {
    throw new Error("The previous worker is finishing shutdown. Wait a moment, then resume this batch.");
  }
  if (!tryReserveIntake()) throw new Error("INTAKE_BUSY");
  let releaseLease: (() => void) | undefined;
  try {
    const id = options.resumeJobId ?? randomUUID();
    const directory = intakeJobDir(settings, id);
    releaseLease = acquireIntakeLease(settings, id);
    const prior = options.resumeJobId ? readIntakeJob(settings, id) : null;
    if (options.resumeJobId && !prior) throw new Error("Intake job not found");
    const now = new Date().toISOString();
    const job: IntakeJob = { ...prior, id, state: "queued", stage: "queued", createdAt: prior?.createdAt ?? now,
      updatedAt: now, heartbeatAt: now, ownerPid: process.pid, attempt: (prior?.attempt ?? 0) + 1,
      manifestRevision: revisionAt(directory), forceNoAi: options.forceNoAi, seq: prior?.seq ?? 0, event: null };
    delete job.error;
    delete job.cancelRequested;
    saveIntakeJob(settings, job);
    let admit!: (value: IntakeAdmission) => void;
    let finish!: (value: Event) => void;
    const admission = new Promise<IntakeAdmission>(resolve => { admit = resolve; });
    const terminal = new Promise<Event>(resolve => { finish = resolve; });
    const listeners = new Set<(event: Event) => void>();
    let finalEvent: Event | undefined;
    const publish = (event: Event) => { for (const listener of listeners) { try { listener(event); } catch { /* subscriber detached */ } } };
    const live: LiveJob = { job, admission, terminal, subscribe(listener) {
      listeners.add(listener);
      listener({ type: "job", jobId: id, job });
      if (job.event) listener({ ...job.event, type: "progress" });
      if (finalEvent) listener(finalEvent);
      return () => { listeners.delete(listener); };
    } };
    liveJobs.set(key(settings), live);
    const release = releaseLease;
    const heartbeat = setInterval(() => {
      job.heartbeatAt = new Date().toISOString();
      try { saveIntakeJob(settings, job); } catch (error) { console.error("[intake] checkpoint write failed", error); }
    }, 5_000);
    heartbeat.unref?.();
    void (async () => {
      let admitted = false;
      try {
        await checkpointCommitted(settings, job);
        if (job.cancelRequested) throw new Error(INTAKE_CANCELLED);
        const resultFile = path.join(directory, "result.json");
        const revisionFile = path.join(directory, "result-revision.json");
        const savedRevision = fs.existsSync(revisionFile) ? JSON.parse(fs.readFileSync(revisionFile, "utf8")).revision : 0;
        let result: WorkerResult;
        if (fs.existsSync(resultFile) && savedRevision === job.manifestRevision) {
          const raw = JSON.parse(fs.readFileSync(resultFile, "utf8")) as WorkerResult;
          result = validateWorkerResult(await uncommittedResult(raw, job), settings);
          admit({ ok: true, mode: options.forceNoAi ? "no-ai" : "managed" }); admitted = true;
        } else {
          live.intake = startIntake(settings, { forceNoAi: options.forceNoAi, jobDir: directory, jobId: id,
            onSpawn(pid) { job.workerPid = pid; saveIntakeJob(settings, job); },
            onProgress(event) {
              job.seq++;
              job.event = event;
              job.stage = String(event.stage);
              job.state = ["enrich", "enrich_done", "item"].includes(job.stage) ? "processing" : "detecting";
              job.updatedAt = job.heartbeatAt = new Date().toISOString();
              saveIntakeJob(settings, job);
              publish({ ...event, type: "progress", jobId: id });
            } });
          if (job.cancelRequested) live.intake.cancel();
          const decision = await live.intake.admission;
          admit(decision); admitted = true;
          result = await live.intake.result;
          // Node saves independently too, so older workers remain recoverable.
          writeIntakeJson(resultFile, result);
          writeIntakeJson(revisionFile, { revision: job.manifestRevision });
        }
        if (job.cancelRequested) throw new Error(INTAKE_CANCELLED);
        if (revisionAt(directory) !== job.manifestRevision) throw new Error("STALE_INTAKE_REVISION");
        job.state = "persisting"; job.stage = "persisting";
        saveIntakeJob(settings, job); publish({ type: "persisting", jobId: id });
        const summary = await persistWorkerResult(result, settings, { jobId: id, revision: job.manifestRevision });
        job.summary = { ...summary };
        await checkpointCommitted(settings, job);
        job.state = summary.retryableFailures ? "failed" : summary.problems || summary.collisions || summary.needsReview
          ? "completed_with_review" : "completed";
        job.stage = job.state;
        if (summary.retryableFailures) job.error = "Some item commits failed. Resume this job to retry them; originals are preserved.";
        finalEvent = { type: "done", summary, counts: result.counts, jobId: id };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        job.state = message === INTAKE_CANCELLED ? "cancelled" : "failed";
        job.stage = job.state; job.error = message;
        if (!admitted) admit(message === INTAKE_CANCELLED ? { ok: false, kind: "cancelled" } : { ok: false, kind: "error", error: message });
        finalEvent = message === INTAKE_CANCELLED ? { type: "cancelled", jobId: id } : { type: "error", error: message, jobId: id };
      } finally {
        clearInterval(heartbeat);
        delete job.workerPid;
        job.updatedAt = job.heartbeatAt = new Date().toISOString();
        try { saveIntakeJob(settings, job); } catch (error) { console.error("[intake] final checkpoint failed", error); }
        publish(finalEvent!); finish(finalEvent!);
        liveJobs.delete(key(settings));
        release?.(); releaseIntakePrep();
      }
    })();
    return live;
  } catch (error) { releaseLease?.(); releaseIntakePrep(); throw error; }
}
