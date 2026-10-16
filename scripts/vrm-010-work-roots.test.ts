// Offline VRM-010 work-root safety regressions. No app data/model/network is used.
// Run: node scripts/vrm-010-work-roots.test.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  InvalidManagedWorkRootsError,
  validateManagedWorkRoots,
  type ManagedWorkRoots,
} from "../src/lib/workRoots.ts";

let failures = 0;
function check(name: string, condition: boolean): void {
  if (!condition) failures += 1;
  console.log(`  [${condition ? "ok " : "FAIL"}] ${name}`);
}

function rejected(roots: ManagedWorkRoots): boolean {
  try {
    validateManagedWorkRoots(roots);
    return false;
  } catch (error) {
    return error instanceof InvalidManagedWorkRootsError;
  }
}

const sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "bca-work-roots-")));
try {
  const roots: ManagedWorkRoots = {
    incomingPath: path.join(sandbox, "incoming"),
    processingPath: path.join(sandbox, "processing"),
    needsReviewPath: path.join(sandbox, "needs-review"),
    archivePath: path.join(sandbox, "archive"),
  };
  for (const directory of Object.values(roots)) fs.mkdirSync(directory);

  console.log("== managed work roots ==");
  let valid = true;
  try { validateManagedWorkRoots(roots); } catch { valid = false; }
  check("four existing absolute disjoint directories are accepted", valid);
  check("relative roots are rejected", rejected({ ...roots, incomingPath: "relative/incoming" }));
  const freshRoot = path.join(sandbox, "fresh-install-data");
  const freshRoots: ManagedWorkRoots = {
    incomingPath: path.join(freshRoot, "incoming"),
    processingPath: path.join(freshRoot, "processing"),
    needsReviewPath: path.join(freshRoot, "needs-review"),
    archivePath: path.join(freshRoot, "archive"),
  };
  let freshValid = true;
  try { validateManagedWorkRoots(freshRoots); } catch { freshValid = false; }
  check("fresh-install missing leaf roots validate without being created", freshValid
    && Object.values(freshRoots).every((directory) => !fs.existsSync(directory)));
  check("prospective missing roots cannot be nested", rejected({
    ...freshRoots,
    processingPath: path.join(freshRoots.incomingPath, "processing"),
  }));
  const file = path.join(sandbox, "not-a-directory");
  fs.writeFileSync(file, "x", { flag: "wx" });
  check("regular files cannot stand in for roots", rejected({ ...roots, incomingPath: file }));
  const child = path.join(roots.incomingPath, "nested-processing");
  fs.mkdirSync(child);
  check("lexically nested roots are rejected", rejected({ ...roots, processingPath: child }));

  const alias = path.join(sandbox, "processing-alias");
  fs.symlinkSync(roots.processingPath, alias, process.platform === "win32" ? "junction" : "dir");
  check("realpath aliases cannot disguise the same root", rejected({ ...roots, incomingPath: alias }));
  const external = path.join(sandbox, "external-target");
  const externalAlias = path.join(sandbox, "external-alias");
  fs.mkdirSync(external);
  fs.symlinkSync(external, externalAlias, process.platform === "win32" ? "junction" : "dir");
  check("missing leaves under a linked/reparse ancestor are rejected", rejected({
    ...roots, incomingPath: path.join(externalAlias, "future-incoming"),
  }));

  const processRoute = fs.readFileSync(
    path.join(process.cwd(), "src/app/api/process/route.ts"), "utf8",
  );
  check("the process route validates roots before starting the service-owned job",
    processRoute.indexOf("validateManagedWorkRoots(settings)") >= 0
    && processRoute.indexOf("validateManagedWorkRoots(settings)") < processRoute.indexOf("startIntakeJob(settings"));
  const workerSource = fs.readFileSync(path.join(process.cwd(), "src/lib/worker.ts"), "utf8");
  const startIntake = workerSource.slice(workerSource.indexOf("export function startIntake"));
  check("direct startIntake/runIntake callers cannot bypass work-root validation",
    startIntake.indexOf("validateManagedWorkRoots(settings)") >= 0
    && startIntake.indexOf("validateManagedWorkRoots(settings)") < startIntake.indexOf("spawnWorker("));
  check("stream cancellation only detaches the listener without cancelling worker ownership",
    /cancel\(\)\s*\{\s*unsubscribe\(\);\s*\}/.test(processRoute)
    && !processRoute.includes("intake.cancel") && !processRoute.includes("req.signal")
    && !processRoute.includes("releaseIntakePrep()"));
  const service = fs.readFileSync(path.join(process.cwd(), "src/lib/intakeJobs.ts"), "utf8");
  const launch = service.slice(service.indexOf("export function startIntakeJob"));
  check("the service reserves work before spawning and owns its detached task",
    launch.indexOf("tryReserveIntake()") >= 0 && launch.indexOf("tryReserveIntake()") < launch.indexOf("startIntake(settings")
    && launch.indexOf("void (async () =>") >= 0 && !launch.includes("req.signal"));
  const resultStart = launch.indexOf("result = await live.intake.result");
  const persistStart = launch.indexOf("await persistWorkerResult", resultStart);
  check("a valid worker result is checkpointed and persisted by the service after clients disconnect",
    resultStart >= 0 && persistStart > resultStart
    && launch.indexOf("writeIntakeJson(resultFile, result)", resultStart) < persistStart
    && !/req\.signal|request\.signal/.test(launch.slice(resultStart, persistStart)));
} finally {
  fs.rmSync(sandbox, { recursive: true, force: true });
}

console.log(`\n${failures ? `VRM-010 WORK-ROOT FAILURES: ${failures}` : "ALL VRM-010 WORK-ROOT CHECKS PASSED"}`);
process.exitCode = failures ? 1 : 0;
