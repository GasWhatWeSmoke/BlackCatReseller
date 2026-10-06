// Offline VRM-010 worker protocol regressions. No worker/model/network is run.
// Run: node scripts/vrm-010-worker-protocol.test.ts
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createWorkerUtf8Decoder,
  managedVisionDeferralFromEvent,
  ManagedVisionCancelledError,
  normalizeIntakeProgressEvent,
  runReenrichBatch,
  runVisionProbe,
  validateIntakeProtocolTransition,
  validateManagedProtocolEvents,
  type IntakeProtocolCounts,
} from "../src/lib/worker.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;

function check(name: string, condition: boolean): void {
  if (!condition) failures += 1;
  console.log(`  [${condition ? "ok " : "FAIL"}] ${name}`);
}

function transcript(events: ("admitted" | "result" | "deferred" | "cancelled" | "error")[]): string[] {
  const counts: IntakeProtocolCounts = { admitted: 0, result: 0, deferred: 0, cancelled: 0, error: 0 };
  const violations: string[] = [];
  for (const event of events) {
    const violation = validateIntakeProtocolTransition(counts, event);
    if (violation) violations.push(violation);
    counts[event] += 1;
  }
  return violations;
}

console.log("== intake transcript ordering ==");
check("one admission then one result is valid", transcript(["admitted", "result"]).length === 0);
check("result without admission is rejected", /before admission/.test(transcript(["result"])[0] ?? ""));
check("deferred then admitted cannot open a 200 stream", transcript(["deferred", "admitted"]).length === 1);
check("post-admission deferral is a hard protocol violation", transcript(["admitted", "deferred"]).length === 1);
check("duplicate admission is rejected", transcript(["admitted", "admitted"]).length === 1);
check("duplicate result is rejected", transcript(["admitted", "result", "result"]).length === 1);
check("cancel after admission is valid but result after cancel is not",
  transcript(["admitted", "cancelled", "result"]).length === 1);
const forgedProgress = normalizeIntakeProgressEvent({
  event: "progress", stage: "scan", type: "done", summary: { forged: true },
});
check("progress copies only allowlisted fields",
  forgedProgress?.event === "progress" && !("type" in forgedProgress) && !("summary" in forgedProgress));
const workerSource = fs.readFileSync(path.join(ROOT, "src/lib/worker.ts"), "utf8");
check("unknown event names become protocol errors instead of progress",
  /else if \(event === "progress"\)[\s\S]*worker emitted unknown event/.test(workerSource));
check("progress after a terminal is rejected",
  /worker emitted progress after a terminal event/.test(workerSource));
const closeHandler = workerSource.indexOf(".then(({ code, stderr, protocolIssue })");
check("worker result paths and hashes are validated only after process close",
  closeHandler >= 0 && workerSource.indexOf("validateWorkerResult(rawResult, settings)") > closeHandler);

const splitDecoder = createWorkerUtf8Decoder();
const splitUtf8 = Buffer.from('prefix-🧶-suffix', "utf8");
const decodedSplit = splitDecoder.write(splitUtf8.subarray(0, 9))
  + splitDecoder.write(splitUtf8.subarray(9, 10))
  + splitDecoder.write(splitUtf8.subarray(10))
  + splitDecoder.end();
check("split UTF-8 pipe chunks preserve exact non-ASCII receipt text",
  decodedSplit === 'prefix-🧶-suffix' && !decodedSplit.includes("\ufffd"));
check("production stdout and stderr both use the streaming decoder",
  /stdoutDecoder\.write\(d\)/.test(workerSource)
  && /stderrDecoder\.write\(d\)/.test(workerSource)
  && /stdoutDecoder\.end\(\)/.test(workerSource)
  && /stderrDecoder\.end\(\)/.test(workerSource));

console.log("\n== retry/probe disconnect cleanup ==");
const preAborted = new AbortController();
preAborted.abort();
for (const [label, operation] of [
  ["retry", () => runReenrichBatch({} as never, [], { signal: preAborted.signal })],
  ["probe", () => runVisionProbe({} as never, { signal: preAborted.signal })],
] as const) {
  let cancelledBeforeSpawn = false;
  try { await operation(); } catch (error) {
    cancelledBeforeSpawn = error instanceof ManagedVisionCancelledError;
  }
  check(`pre-aborted ${label} never reaches validation/spawn`, cancelledBeforeSpawn);
}
const managedSpawnStart = workerSource.indexOf("async function spawnManagedWorker");
const managedSpawnEnd = workerSource.indexOf("function managedPayload", managedSpawnStart);
const managedSpawn = workerSource.slice(managedSpawnStart, managedSpawnEnd);
check("each managed retry/probe owns one absolute UUID cancel capability",
  /path\.resolve\([\s\S]*blackcat-managed-cancel-\$\{randomUUID\(\)\}/.test(managedSpawn)
  && /BLACKCAT_CANCEL_FILE:\s*cancelFile/.test(managedSpawn));
check("abort only writes a cooperative token and never kills the child",
  /addEventListener\("abort", onAbort/.test(managedSpawn)
  && /writeFileSync\(cancelFile/.test(managedSpawn)
  && !/taskkill|SIGKILL|\.kill\s*\(/i.test(managedSpawn));
check("listener/token cleanup follows child close on success and error",
  managedSpawn.indexOf("await closeCell.promise") >= 0
  && managedSpawn.indexOf("await closeCell.promise") < managedSpawn.lastIndexOf("removeEventListener")
  && managedSpawn.indexOf("await spawnWorker") < managedSpawn.lastIndexOf("unlinkSync(cancelFile)"));
check("cancel token write failures survive until cleanup as a hard typed error",
  /cancelFailure = new ManagedVisionCancelRequestError/.test(managedSpawn)
  && /if \(cancelFailure\) throw cancelFailure/.test(managedSpawn));
check("intake clears its stale local handle before final token cleanup",
  workerSource.indexOf("reg = null;") >= 0
  && workerSource.indexOf("reg = null;") < workerSource.indexOf("unlinkSync(cancelFile)", workerSource.indexOf("reg = null;")));

const singleRetryRoute = fs.readFileSync(
  path.join(ROOT, "src/app/api/items/[id]/reidentify/route.ts"), "utf8",
);
const bulkReidentifyRoute = fs.readFileSync(
  path.join(ROOT, "src/app/api/items/reidentify-failed/route.ts"), "utf8",
);
const visionRoute = fs.readFileSync(path.join(ROOT, "src/app/api/vision/route.ts"), "utf8");
check("single retry connects Request.signal through the managed worker",
  /reidentifyItem\(id, settings, \{ signal: req\.signal \}\)/.test(singleRetryRoute));
check("bulk retry connects Request.signal and fences abort before first DB apply",
  /\{ signal: req\.signal \}/.test(bulkReidentifyRoute)
  && bulkReidentifyRoute.indexOf("if (req.signal.aborted)")
    < bulkReidentifyRoute.indexOf("for (const [index, completed]"));
check("Settings probe connects Request.signal to its managed worker",
  /workerProbeRunner\(settings, req\.signal\)/.test(visionRoute)
  && /probe\(settings, \{ signal \}\)/.test(visionRoute));
check("single and bulk surface cancellation-token write failures as hard 500s",
  [singleRetryRoute, bulkReidentifyRoute].every((source) =>
    /ManagedVisionCancelRequestError/.test(source) && /status:\s*500/.test(source)));
check("retry IPC mirrors the intake aggregate enrichment budget",
  /MAX_ENRICHMENT_BATCH_JSON_BYTES/.test(workerSource)
  && /enrichmentBytes \+= Buffer\.byteLength\(JSON\.stringify\(enrichment\)/.test(workerSource)
  && /oversized enrichment batch/.test(workerSource));

console.log("\n== one-shot managed transcript ordering ==");
check("one result terminal is valid",
  validateManagedProtocolEvents([{ event: "result", payload: {} }]) === null);
check("managed commands reject missing terminals",
  /no terminal/.test(validateManagedProtocolEvents([]) ?? ""));
check("managed commands reject result followed by progress",
  validateManagedProtocolEvents([{ event: "result" }, { event: "progress" }]) !== null);
check("managed commands reject progress before result",
  validateManagedProtocolEvents([{ event: "progress" }, { event: "result" }]) !== null);
check("managed commands reject admission events",
  validateManagedProtocolEvents([{ event: "admitted" }]) !== null);
check("managed commands reject mixed terminals",
  validateManagedProtocolEvents([{ event: "deferred" }, { event: "error" }]) !== null);

console.log("\n== bounded deferral compatibility ==");
const nested = managedVisionDeferralFromEvent({
  event: "deferred",
  message: "busy at http://localhost:1234/private",
  verdict: { status: "ambiguous", detail: "peer http://secret:8188", attempts: 2, elapsed_s: 1.5 },
});
check("legacy nested ambiguous status is preserved", nested.status === "ambiguous");
check("nested attempts/elapsed are preserved", nested.attempts === 2 && nested.elapsedSeconds === 1.5);
check("transport URLs are redacted", !JSON.stringify(nested).includes("localhost") && !JSON.stringify(nested).includes("secret"));

console.log("\n== cooperative cancellation acknowledgement ==");
const worker = workerSource;
const cancelRoute = fs.readFileSync(path.join(ROOT, "src/app/api/process/cancel/route.ts"), "utf8");
const reidentify = fs.readFileSync(path.join(ROOT, "src/lib/reidentify.ts"), "utf8");
const reenrichPython = fs.readFileSync(
  path.join(ROOT, "worker/black_cat_worker/reenrich_batch.py"), "utf8",
);
const cancelStart = worker.indexOf("export async function cancelIntake");
const cancelEnd = worker.indexOf("export type IntakeAdmission", cancelStart);
const cancelBody = worker.slice(cancelStart, cancelEnd);
check("cancel writes a token before waiting for close",
  cancelBody.indexOf("requestIntakeCancellation(reg)") >= 0 &&
  cancelBody.indexOf("requestIntakeCancellation(reg)") < cancelBody.indexOf("await reg.closed"));
check("cancel path contains no force kill", !/taskkill|SIGKILL|\.kill\s*\(/i.test(cancelBody));
check("HTTP acknowledgement awaits natural close",
  cancelRoute.indexOf("await cancelIntake()") >= 0 &&
  cancelRoute.indexOf("await cancelIntake()") < cancelRoute.indexOf("NextResponse.json"));
check("cancel write failure is a typed 500", /CANCEL_REQUEST_FAILED/.test(cancelRoute) && /status:\s*500/.test(cancelRoute));

console.log("\n== bounded IPC and reenrich input ==");
check("stdout, stderr, line, event, and progress buffers are capped",
  ["MAX_WORKER_STDOUT_BYTES", "MAX_WORKER_STDERR_BYTES", "MAX_WORKER_LINE_BYTES",
    "MAX_WORKER_EVENTS", "MAX_INTAKE_PROGRESS_EVENTS"].every((name) => worker.includes(name)));
check("overflow drains to natural close without force-kill",
  /keep draining the pipe; never kill/.test(worker));
check("reenrich validates processing-root containment before writing",
  worker.indexOf("assertReenrichBatchInput(settings, items)") >= 0 &&
  worker.indexOf("assertReenrichBatchInput(settings, items)") < worker.indexOf("fs.writeFileSync(tmp, serialized"));
check("reenrich temp spec is exclusive and owner-only",
  /flag:\s*"wx"/.test(worker) && /mode:\s*0o600/.test(worker));
check("Node and Python enforce the same 32-photo cap",
  /MAX_REENRICH_PHOTOS_PER_ITEM\s*=\s*32/.test(worker)
  && /_MAX_PHOTOS_PER_ITEM\s*=\s*32/.test(reenrichPython));
check("Node and Python align 256 MiB per-file and 16 GiB aggregate retry caps",
  /MAX_REENRICH_IMAGE_FILE_BYTES\s*=\s*256 \* 1024 \* 1024/.test(worker)
  && /MAX_REENRICH_BATCH_IMAGE_BYTES\s*=\s*16 \* 1024 \* 1024 \* 1024/.test(worker)
  && /_MAX_IMAGE_FILE_BYTES\s*=\s*256 \* 1024 \* 1024/.test(reenrichPython)
  && /_MAX_BATCH_IMAGE_BYTES\s*=\s*16 \* 1024 \* 1024 \* 1024/.test(reenrichPython));
check("Node preflight requires real regular strict processing-root descendants",
  /lstatSync\(candidate\)/.test(worker) && /realpathSync\.native\(candidate\)/.test(worker)
  && /realRelative/.test(worker));
check("photo ID, path, and SHA-256 cross the exact managed spec",
  ["photoId", "storedPath", "sha256"].every((field) => worker.includes(field)
    && reenrichPython.includes(field)));
check("Python hashes before, during, around asks, and after session exit",
  (reenrichPython.match(/_verify_photo_identities\(/g) ?? []).length >= 6);
check("DB apply compares ordered photo identity and optimistic updatedAt",
  /photo\.photoId === prepared\.photos\[index\]\.photoId/.test(reidentify)
  && /photo\.sha256 === prepared\.photos\[index\]\.sha256/.test(reidentify)
  && /updateMany/.test(reidentify) && /updatedAt:\s*item\.updatedAt/.test(reidentify)
  && /\$transaction/.test(reidentify));
check("bulk retry pages only photo-eligible failures so invalid rows cannot starve later IDs",
  /photos:\s*\{\s*some:/.test(bulkReidentifyRoute)
  && /orderBy:\s*\{ id: "asc" \}/.test(bulkReidentifyRoute)
  && /take:\s*500/.test(bulkReidentifyRoute)
  && /remainingEligible/.test(bulkReidentifyRoute));

console.log(`\n${failures ? `VRM-010 WORKER PROTOCOL FAILURES: ${failures}` : "ALL VRM-010 WORKER PROTOCOL CHECKS PASSED"}`);
process.exitCode = failures ? 1 : 0;
