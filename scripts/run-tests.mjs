import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function run(label, command, args, options = {}) {
  console.log(`\n== ${label} ==`);
  const result = spawnSync(command, args, {
    cwd: root,
    env: { ...process.env, PYTHONPATH: "", PYTHONIOENCODING: "utf-8" },
    stdio: "inherit",
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${label} failed with exit code ${result.status ?? "unknown"}`);
  }
}

function filesMatching(directory, predicate) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const absolute = path.join(directory, entry.name);
      return entry.isDirectory() ? filesMatching(absolute, predicate)
        : predicate(entry.name) ? [absolute] : [];
    });
}

function usablePython() {
  const candidates = [
    process.env.BLACKCAT_PYTHON,
    path.join(root, "worker", ".venv", "Scripts", "python.exe"),
    path.join(root, "worker", "python", "python", "python.exe"),
    process.platform === "win32" ? "python.exe" : "python3",
    "python",
  ].filter(Boolean);
  for (const candidate of [...new Set(candidates)]) {
    const probe = spawnSync(candidate, ["--version"], { encoding: "utf8", windowsHide: true });
    if (!probe.error && probe.status === 0) return candidate;
  }
  throw new Error("No usable Python interpreter found. Run `npm.cmd run worker:setup` first.");
}

try {
  const nodeTests = [
    ...filesMatching(path.join(root, "electron"), (name) => /\.test\.js$/.test(name)),
    ...filesMatching(path.join(root, "src", "lib"), (name) => /\.test\.(?:[cm]?js|ts)$/.test(name)),
    ...filesMatching(path.join(root, "scripts"), (name) => /\.test\.(?:[cm]?js|ts)$/.test(name)),
  ].sort();
  if (nodeTests.length === 0) throw new Error("No Node test files were found");
  run("Node tests", process.execPath, ["--test", ...nodeTests]);

  if (process.platform === "win32") {
    const powershellTests = filesMatching(path.join(root, "scripts"), (name) => name.endsWith(".test.ps1")).sort();
    for (const test of powershellTests) {
      run(`PowerShell ${path.basename(test)}`, "powershell.exe", [
        "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", test,
      ]);
    }
  }

  const python = usablePython();
  run("Python unittest discovery", python, ["-m", "unittest", "discover", "-s", "worker/tests", "-p", "test*.py"]);
  run("Python logic suite", python, ["worker/tests/test_logic.py"]);

  const tsc = path.join(root, "node_modules", "typescript", "bin", "tsc");
  run("TypeScript", process.execPath, [tsc, "--noEmit", "--incremental", "false"]);
  console.log("\nAll required tests passed.");
} catch (error) {
  console.error(`\nTest gate failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
