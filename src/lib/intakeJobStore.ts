import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export type IntakeState = "queued" | "detecting" | "processing" | "persisting" | "completed" | "completed_with_review" | "failed" | "cancelled" | "interrupted";
export interface IntakeJob {
  id: string;
  state: IntakeState;
  stage: string;
  createdAt: string;
  updatedAt: string;
  heartbeatAt: string;
  ownerPid: number;
  workerPid?: number;
  attempt: number;
  manifestRevision: number;
  forceNoAi: boolean;
  seq: number;
  event: Record<string, unknown> | null;
  summary?: Record<string, unknown>;
  error?: string;
  committedPhotoIds?: string[];
  cancelRequested?: boolean;
}

export function validIntakeJobId(id: unknown): id is string {
  return typeof id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id);
}

export function intakeJobDir(settings: { dataRoot: string }, id: string): string {
  if (!validIntakeJobId(id)) throw new Error("Invalid intake job ID");
  return path.join(path.resolve(settings.dataRoot), "intake-jobs", id);
}

/** The rename is atomic; fsync ensures checkpoints survive a clean OS restart. */
export function writeIntakeJson(filename: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temporary, "wx", 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  try { fs.renameSync(temporary, filename); }
  finally { try { fs.unlinkSync(temporary); } catch { /* rename consumed the temporary */ } }
}

export function readIntakeJob(settings: { dataRoot: string }, id: string): IntakeJob | null {
  const filename = path.join(intakeJobDir(settings, id), "job.json");
  try {
    const value = JSON.parse(fs.readFileSync(filename, "utf8")) as IntakeJob;
    if (value.id !== id) throw new Error("Intake job identity mismatch");
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export function saveIntakeJob(settings: { dataRoot: string }, job: IntakeJob): void {
  writeIntakeJson(path.join(intakeJobDir(settings, job.id), "job.json"), job);
  writeIntakeJson(path.join(settings.dataRoot, "intake-jobs", "latest.json"), { id: job.id });
}

export function latestIntakeJob(settings: { dataRoot: string }): IntakeJob | null {
  try {
    const { id } = JSON.parse(fs.readFileSync(path.join(settings.dataRoot, "intake-jobs", "latest.json"), "utf8"));
    return readIntakeJob(settings, id);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export function activeIntakeState(state: IntakeState): boolean {
  return ["queued", "detecting", "processing", "persisting"].includes(state);
}

export function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

interface LeaseTicket { pid: number; token: string; jobId: string; ticket: number }

function leaseTickets(root: string): Array<LeaseTicket & { filename: string }> {
  const rows: Array<LeaseTicket & { filename: string }> = [];
  for (const name of fs.readdirSync(root).filter(name => name.endsWith(".json"))) {
    const filename = path.join(root, name);
    let row: LeaseTicket;
    try { row = JSON.parse(fs.readFileSync(filename, "utf8")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new Error("INTAKE_BUSY"); // a contender may be creating its choosing flag
    }
    if (!processAlive(row.pid)) {
      // Every contender owns a unique UUID pathname; it is NEVER reused. Removing
      // a crashed contender cannot unlink a new owner's lock (no stale-file CAS).
      try { fs.unlinkSync(filename); } catch { /* another observer removed it */ }
      continue;
    }
    if (!Number.isSafeInteger(row.ticket) || row.ticket < 0 || typeof row.token !== "string") throw new Error("INTAKE_BUSY");
    rows.push({ ...row, filename });
  }
  return rows;
}

/** Local-filesystem bakery lease: contenders publish a choosing flag (ticket 0),
 * then a monotonic ticket. A lower ticket / UUID, or any choosing contender,
 * prevents entry. We fail busy instead of spinning. Independent Node processes
 * therefore cannot both own a workset, including during dead-owner recovery. */
export function acquireIntakeLease(settings: { dataRoot: string }, jobId: string): () => void {
  const root = path.join(settings.dataRoot, "intake-jobs", "leases");
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const token = randomUUID();
  const filename = path.join(root, `${token}.json`);
  const row: LeaseTicket = { pid: process.pid, token, jobId, ticket: 0 };
  writeIntakeJson(filename, row);
  try {
    const existing = leaseTickets(root);
    row.ticket = 1 + Math.max(0, ...existing.map(other => other.ticket));
    writeIntakeJson(filename, row);
    for (const other of leaseTickets(root)) {
      if (other.token === token) continue;
      if (other.ticket === 0 || other.ticket < row.ticket ||
          (other.ticket === row.ticket && other.token < token)) throw new Error("INTAKE_BUSY");
    }
    const previous = latestIntakeJob(settings);
    if (previous?.workerPid && !processAlive(previous.ownerPid) && processAlive(previous.workerPid)) {
      throw new Error("INTAKE_BUSY"); // the parent's orphan is still reaching its safe shutdown checkpoint
    }
    return () => { try { fs.unlinkSync(filename); } catch { /* released already */ } };
  } catch (error) {
    try { fs.unlinkSync(filename); } catch { /* own unique ticket only */ }
    throw error;
  }
}

export function intakeLeaseActive(settings: { dataRoot: string }): boolean {
  const root = path.join(settings.dataRoot, "intake-jobs", "leases");
  try { return leaseTickets(root).length > 0; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    return true;
  }
}
