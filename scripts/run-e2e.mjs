// Driver for the end-to-end sandbox suites in scripts/e2e-*.ts.
//
// Each suite drives the REAL pipeline (runIntake -> persistWorkerResult ->
// exportItemById) against a throwaway SQLite stack and data root, so nothing it
// does can reach the operator's inventory, photos, or Nifty session. Before this
// existed the suites were only runnable by hand-copying an esbuild command out of
// a source comment, which meant in practice they were never run at all.
//
//   node scripts/run-e2e.mjs            # mixed-batch (default)
//   node scripts/run-e2e.mjs failure    # managed failure/recovery path
//   node scripts/run-e2e.mjs sidecar    # supervised smoke vs the REAL local server
//
// mixed/failure serve their own deterministic VLM fixture on the pinned local
// vision port and therefore need that port free — close Black Cat first. sidecar
// is the opposite: it exercises the app-owned server, so leave the app running.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The local vision boundary pins host+port on purpose (src/lib/visionServer.ts,
// scripts/local-vision-boundary.test.ts). The fixture binds the same address
// rather than taking an override, so that invariant stays a real invariant.
const VISION_HOST = "127.0.0.1";
const VISION_PORT = 1235;

const SUITES = {
  mixed:   { entry: "scripts/e2e-mixed-batch.ts",  fixtures: true,  mock: "responses_mixed.json" },
  failure: { entry: "scripts/e2e-failure-path.ts", fixtures: true,  mock: "responses_mixed.json" },
  sidecar: { entry: "scripts/e2e-sidecar-smoke.ts", fixtures: false, mock: null },
};

const name = process.argv[2] ?? "mixed";
const suite = SUITES[name];
if (!suite) {
  console.error(`Unknown suite "${name}". Choose one of: ${Object.keys(SUITES).join(", ")}`);
  process.exit(2);
}

function run(label, cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: "inherit", cwd: root, ...opts });
  if (r.error) throw new Error(`${label} could not start: ${r.error.message}`);
  if (r.status !== 0) {
    throw new Error(`${label} failed with exit code ${r.status ?? "signal " + r.signal}`);
  }
}

function usablePython() {
  const candidates = [
    path.join(root, "worker", ".venv", "Scripts", "python.exe"),
    path.join(root, "worker", "python", "python", "python.exe"),
    process.platform === "win32" ? "python.exe" : "python3",
  ];
  for (const c of candidates) {
    if (!path.isAbsolute(c) || fs.existsSync(c)) return c;
  }
  throw new Error("No usable Python interpreter found. Run `npm.cmd run worker:setup` first.");
}

/** Refuse to start rather than colliding with a running Black Cat. */
function assertVisionPortFree() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", (err) => {
      reject(new Error(
        `${VISION_HOST}:${VISION_PORT} is already in use (${err.code}). The ${name} suite serves its ` +
        `own VLM fixture on that address, which the local vision boundary pins. Close Black Cat ` +
        `Reseller (it runs the real vision server there) and try again.`));
    });
    probe.once("listening", () => probe.close(() => resolve()));
    probe.listen({ host: VISION_HOST, port: VISION_PORT, exclusive: true });
  });
}

/** Intake deliberately skips files newer than fileStabilitySeconds so it can
 *  never pick up a half-copied photo (fileops.is_stable, applied in process.py
 *  for every non-dry run). Fixtures are written milliseconds before the suite
 *  starts, so without this wait the worker scans an empty batch and every
 *  assertion fails as "0 items created" with nothing pointing at the cause. */
async function settleFixtures(dir) {
  const defaults = JSON.parse(
    fs.readFileSync(path.join(root, "config", "defaults.json"), "utf-8"));
  const stability = Number(defaults?.defaults?.fileStabilitySeconds ?? 2);
  const newest = fs.readdirSync(dir)
    .map((f) => fs.statSync(path.join(dir, f)).mtimeMs)
    .reduce((a, b) => Math.max(a, b), 0);
  const waitMs = Math.max(0, newest + (stability + 0.5) * 1000 - Date.now());
  if (waitMs > 0) {
    console.log(`[e2e] waiting ${(waitMs / 1000).toFixed(1)}s for fixtures to clear the ` +
                `${stability}s stability window`);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
}

const stack = fs.mkdtempSync(path.join(os.tmpdir(), "blackcat-e2e-"));
const dataRoot = path.join(stack, "data");
const dbPath = path.join(stack, "e2e.db");
let mock = null;

try {
  if (suite.mock) await assertVisionPortFree();

  // ---- isolated stack -------------------------------------------------------
  fs.mkdirSync(path.join(dataRoot, "incoming"), { recursive: true });
  const template = path.join(root, "config", "template.db");
  if (!fs.existsSync(template)) {
    throw new Error(`missing ${template} — run \`npm.cmd run db:template\` first`);
  }
  fs.copyFileSync(template, dbPath);
  console.log(`[e2e] stack: ${stack}`);

  const python = usablePython();

  // The template ships no AppSettings row, so getSettings() would fall back to
  // defaults with vision off — and the mixed suite asserts AI ran for all 7
  // items. Stored settings are merged OVER the defaults, so one key is enough.
  run("seed settings", python,
    [path.join(root, "scripts", "e2e", "seed_settings.py"), dbPath]);

  if (suite.fixtures) {
    run("generate fixtures", python,
      [path.join(root, "scripts", "e2e", "gen_fixtures.py"), "--out", path.join(dataRoot, "incoming")]);
    await settleFixtures(path.join(dataRoot, "incoming"));
  }

  // ---- deterministic VLM fixture -------------------------------------------
  if (suite.mock) {
    const responses = path.join(root, "scripts", "e2e", suite.mock);
    mock = spawn(python, [path.join(root, "scripts", "e2e", "mock_vlm.py")], {
      cwd: root, stdio: "inherit",
      env: { ...process.env, PYTHONPATH: "", PYTHONIOENCODING: "utf-8", BLACKCAT_E2E_RESPONSES: responses },
    });
    mock.on("exit", (code) => {
      if (code !== 0 && code !== null) console.error(`[e2e] VLM fixture exited early with code ${code}`);
    });
    // Wait for the fixture to accept connections instead of sleeping a guess.
    const deadline = Date.now() + 20_000;
    for (;;) {
      const up = await new Promise((resolve) => {
        const s = net.connect({ host: VISION_HOST, port: VISION_PORT });
        s.once("connect", () => s.end(() => resolve(true)));
        s.once("error", () => resolve(false));
      });
      if (up) break;
      if (Date.now() > deadline) throw new Error("VLM fixture never started listening");
    }
    console.log(`[e2e] VLM fixture ready on ${VISION_HOST}:${VISION_PORT}`);
  }

  // ---- bundle + run ---------------------------------------------------------
  const outfile = path.join(root, "node_modules", ".e2e", `${name}.cjs`);
  fs.mkdirSync(path.dirname(outfile), { recursive: true });
  await esbuild.build({
    entryPoints: [path.join(root, suite.entry)],
    bundle: true, platform: "node", format: "cjs",
    external: ["@prisma/client"], outfile,
  });
  console.log(`[e2e] bundled ${suite.entry}`);

  run(`e2e:${name}`, process.execPath, [outfile], {
    env: {
      ...process.env,
      DATABASE_URL: `file:${dbPath}`,
      BLACKCAT_DATA_ROOT: dataRoot,
      BLACKCAT_PYTHON: python,
    },
  });
  console.log(`\n[e2e] ${name}: PASSED`);
} catch (error) {
  // A port collision or a missing template is an operator-fixable setup problem,
  // not a crash — print the sentence that says what to do, not a stack trace.
  console.error(`
[e2e] ${name}: FAILED`);
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  if (mock && mock.exitCode === null) mock.kill();
  // Keep the stack on failure so the receipts and item.json can be inspected.
  if (!process.exitCode) {
    fs.rmSync(stack, { recursive: true, force: true });
  } else {
    console.log(`[e2e] stack kept for inspection: ${stack}`);
  }
}
