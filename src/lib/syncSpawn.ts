// Whether a sync failure means the worker PROCESS never started, as opposed to the read
// itself failing.
//
// The venv's python.exe is a stub that execs the portable base interpreter, and on the
// reference machine two of six overnight heartbeats died with Windows'
//   Unable to create process using '...worker\python\python\python.exe'
// — the base interpreter, momentarily unavailable. A resume from sleep and an antivirus
// scan are the usual suspects. Nothing was wrong with Nifty or the data; the run simply
// never began, and then waited three hours to try again.
//
// Its own module so it can be tested without pulling in Prisma, and so the distinction
// stays explicit: a read that REACHED Nifty and came back with an answer is never
// retried, because repeating it just doubles a browser session to learn the same thing.

/** True when the failure is "the process would not start". */
export function isSpawnFailure(message: string): boolean {
  return /unable to create process|ENOENT|EAGAIN|EBUSY|cannot find the (file|path)|spawn \S+ (ENOENT|EACCES)/i
    .test(message || "");
}

/** How long to wait before the single retry. Long enough to outlast a resume or a scan. */
export const SPAWN_RETRY_DELAY_MS = 4000;
