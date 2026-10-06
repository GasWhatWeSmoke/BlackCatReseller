#!/usr/bin/env node
/**
 * Hardware report: what this machine actually is, so model choices are made
 * against measured limits instead of assumptions.
 *
 * Zero new dependencies -- node:os plus the tools Windows already ships
 * (nvidia-smi for real VRAM, Get-CimInstance as the no-NVIDIA fallback).
 *
 * The parsers are exported and pure so they can be tested on a machine with no
 * GPU at all; only collect()/main() touch the system.
 */
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Run a command and return stdout, or null if it is missing/fails. */
export function tryExec(cmd, args, opts = {}) {
  try {
    return execFileSync(cmd, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 20_000,
      ...opts,
    });
  } catch {
    return null;
  }
}

/**
 * Parse `nvidia-smi --query-gpu=name,memory.total,memory.free,driver_version
 * --format=csv,noheader`. Returns [] for null/blank/garbage rather than
 * throwing -- "no NVIDIA GPU" is a normal machine, not an error.
 */
export function parseNvidiaSmi(text) {
  if (!text || typeof text !== "string") return [];
  const gpus = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(",").map((p) => p.trim());
    if (parts.length < 2) continue;
    const name = parts[0];
    if (!name || /^(name|failed|unable|no devices)/i.test(name)) continue;
    const toMib = (v) => {
      const m = /(\d+(?:\.\d+)?)/.exec(v || "");
      return m ? Math.round(Number(m[1])) : null;
    };
    gpus.push({
      name,
      vramTotalMib: toMib(parts[1]),
      vramFreeMib: parts.length > 2 ? toMib(parts[2]) : null,
      driver: parts.length > 3 && parts[3] ? parts[3] : null,
      source: "nvidia-smi",
    });
  }
  return gpus;
}

/**
 * Fallback for machines with no NVIDIA driver: PowerShell CIM video controllers
 * as `Name|AdapterRAM` lines. AdapterRAM is a 32-bit field that saturates at
 * 4 GiB, so it is reported as approximate and never used to size a model.
 */
export function parseCimGpu(text) {
  if (!text || typeof text !== "string") return [];
  const gpus = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.includes("|")) continue;
    const [name, ram] = trimmed.split("|").map((p) => p.trim());
    if (!name) continue;
    const bytes = Number(ram);
    gpus.push({
      name,
      vramTotalMib: Number.isFinite(bytes) && bytes > 0 ? Math.round(bytes / 1048576) : null,
      vramFreeMib: null,
      driver: null,
      source: "cim",
      approximate: true,
    });
  }
  return gpus;
}

/** Extract the pinned vision runtime facts from config/local-vision.json. */
export function summarizeVisionManifest(manifest) {
  if (!manifest || typeof manifest !== "object") return null;
  const server = manifest.server || {};
  const args = Array.isArray(server.arguments) ? server.arguments : [];
  const argValue = (flag) => {
    const i = args.indexOf(flag);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
  };
  return {
    model: manifest.model?.id ?? null,
    runtime: manifest.runtime?.id ?? null,
    host: server.host ?? null,
    port: server.port ?? null,
    contextTokens: argValue("-c"),
    gpuLayers: argValue("-ngl"),
    threads: argValue("-t"),
    imageMaxTokens: argValue("--image-max-tokens"),
  };
}

export function detectGpus() {
  const smi = tryExec("nvidia-smi", [
    "--query-gpu=name,memory.total,memory.free,driver_version",
    "--format=csv,noheader",
  ]);
  const gpus = parseNvidiaSmi(smi);
  if (gpus.length) return gpus;
  if (process.platform !== "win32") return [];
  const cim = tryExec("powershell.exe", [
    "-NoProfile",
    "-Command",
    "Get-CimInstance Win32_VideoController | ForEach-Object { \"$($_.Name)|$($_.AdapterRAM)\" }",
  ]);
  return parseCimGpu(cim);
}

function pythonVersion() {
  const candidates = [
    process.env.BLACKCAT_PYTHON,
    path.join(ROOT, "worker", ".venv", "Scripts", "python.exe"),
    path.join(ROOT, "worker", "python", "python", "python.exe"),
    "python",
  ].filter(Boolean);
  for (const exe of candidates) {
    const out = tryExec(exe, ["--version"]);
    if (out) return { path: exe, version: out.trim() };
  }
  return { path: null, version: null };
}

export function collect() {
  const cpus = os.cpus();
  let manifest = null;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "config", "local-vision.json"), "utf8"));
  } catch { /* manifest is optional -- vision may not be set up yet */ }

  return {
    generatedAt: new Date().toISOString(),
    os: {
      platform: process.platform,
      release: os.release(),
      arch: process.arch,
    },
    cpu: {
      model: cpus.length ? cpus[0].model.trim().replace(/\s+/g, " ") : null,
      logicalCores: cpus.length,
    },
    memory: {
      totalGiB: Number((os.totalmem() / 1073741824).toFixed(1)),
      freeGiB: Number((os.freemem() / 1073741824).toFixed(1)),
    },
    gpus: detectGpus(),
    node: process.version,
    python: pythonVersion(),
    vision: summarizeVisionManifest(manifest),
  };
}

export function renderMarkdown(hw) {
  const L = [];
  L.push("# Hardware", "");
  L.push("Generated by `npm run hardware` (`scripts/hardware-report.mjs`). Regenerate after a hardware or driver change.", "");
  L.push(`_Last generated: ${hw.generatedAt}_`, "");
  L.push("## Machine", "");
  L.push("| | |");
  L.push("|---|---|");
  L.push(`| OS | ${hw.os.platform} ${hw.os.release} (${hw.os.arch}) |`);
  L.push(`| CPU | ${hw.cpu.model ?? "unknown"} -- ${hw.cpu.logicalCores} logical cores |`);
  L.push(`| RAM | ${hw.memory.totalGiB} GiB total |`);
  if (hw.gpus.length) {
    for (const g of hw.gpus) {
      const total = g.vramTotalMib ? `${g.vramTotalMib} MiB` : "unknown";
      const note = g.approximate ? " _(approximate -- 32-bit CIM field)_" : "";
      L.push(`| GPU | ${g.name} -- ${total} VRAM${note} |`);
    }
  } else {
    L.push("| GPU | none detected |");
  }
  L.push(`| Node | ${hw.node} |`);
  L.push(`| Python (worker) | ${hw.python.version ?? "not found"} |`);
  L.push("");

  if (hw.vision) {
    L.push("## Local vision runtime (pinned)", "");
    L.push("| | |");
    L.push("|---|---|");
    L.push(`| Model | ${hw.vision.model ?? "--"} |`);
    L.push(`| Runtime | ${hw.vision.runtime ?? "--"} |`);
    L.push(`| Endpoint | ${hw.vision.host ?? "--"}:${hw.vision.port ?? "--"} (pinned loopback) |`);
    L.push(`| Context | ${hw.vision.contextTokens ?? "--"} tokens |`);
    L.push(`| GPU layers | ${hw.vision.gpuLayers ?? "--"} |`);
    L.push(`| CPU threads | ${hw.vision.threads ?? "--"} |`);
    L.push(`| Tokens per image | ${hw.vision.imageMaxTokens ?? "--"} |`);
    L.push("");
  }

  L.push("## What this envelope means for model choices", "");
  L.push("- **Vision runs on the GPU, OCR runs on the CPU.** Every PaddleOCR constructor the worker");
  L.push("  tries is pinned to `device=\"cpu\"`, so OCR never competes for VRAM with the sidecar.");
  L.push("  With this many cores that is a real division of labour: OCR gets its own lane.");
  L.push("- **VRAM is the binding constraint, not RAM.** The Q4_K_M build fits fully on-GPU with room to");
  L.push("  spare; the Q6 build was benchmarked, spilled into shared memory, and was rejected. Growing the");
  L.push("  context window or the image count spends the same budget -- measure before changing either.");
  L.push("- **Free VRAM at load time is what matters**, not total: the sidecar reserves its KV cache up");
  L.push("  front. Check free VRAM with the app closed before concluding a bigger model fits.");
  L.push("");
  return L.join("\n") + "\n";
}

function main() {
  const hw = collect();
  const md = renderMarkdown(hw);
  const out = path.join(ROOT, "HARDWARE.md");
  fs.writeFileSync(out, md, "utf8");
  process.stdout.write(md);
  process.stdout.write(`\nWrote ${out}\n`);
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
