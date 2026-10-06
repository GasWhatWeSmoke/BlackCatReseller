// The hardware report exists so model choices are made against measured limits.
// That makes its PARSERS the part worth testing: they run on whatever machine a
// contributor has, including one with no NVIDIA GPU and no nvidia-smi at all.
// A parser that throws on a missing tool would turn "you have no GPU" into a
// crashed report, so every degenerate input here must return a value, not raise.
import test from "node:test";
import assert from "node:assert/strict";
import {
  parseNvidiaSmi,
  parseCimGpu,
  summarizeVisionManifest,
  renderMarkdown,
} from "./hardware-report.mjs";

test("nvidia-smi: a real single-GPU line parses to measured VRAM", () => {
  const gpus = parseNvidiaSmi("NVIDIA GeForce RTX 3070, 8192 MiB, 2626 MiB, 610.88\n");
  assert.equal(gpus.length, 1);
  assert.equal(gpus[0].name, "NVIDIA GeForce RTX 3070");
  assert.equal(gpus[0].vramTotalMib, 8192);
  assert.equal(gpus[0].vramFreeMib, 2626);
  assert.equal(gpus[0].driver, "610.88");
  assert.equal(gpus[0].source, "nvidia-smi");
});

test("nvidia-smi: multiple GPUs each get a row", () => {
  const gpus = parseNvidiaSmi(
    "NVIDIA GeForce RTX 3070, 8192 MiB, 2626 MiB, 610.88\nNVIDIA T400, 2048 MiB, 2000 MiB, 610.88\n",
  );
  assert.equal(gpus.length, 2);
  assert.equal(gpus[1].vramTotalMib, 2048);
});

test("nvidia-smi missing or unusable yields no GPUs instead of throwing", () => {
  // tryExec returns null when the binary is absent; these are the shapes a
  // driver-less or virtualised machine actually produces.
  for (const input of [
    null,
    undefined,
    "",
    "   \n  \n",
    "NVIDIA-SMI has failed because it couldn't communicate with the NVIDIA driver",
    "Unable to determine the device handle",
    "No devices were found",
    42,
    {},
  ]) {
    assert.deepEqual(parseNvidiaSmi(input), [], `input: ${JSON.stringify(input)}`);
  }
});

test("nvidia-smi: a truncated line without memory is skipped, not half-reported", () => {
  assert.deepEqual(parseNvidiaSmi("NVIDIA GeForce RTX 3070\n"), []);
});

test("nvidia-smi: non-numeric memory becomes null rather than NaN", () => {
  const gpus = parseNvidiaSmi("NVIDIA GeForce RTX 3070, [N/A], [N/A], 610.88\n");
  assert.equal(gpus.length, 1);
  assert.equal(gpus[0].vramTotalMib, null);
  assert.equal(gpus[0].vramFreeMib, null);
});

test("CIM fallback parses name|bytes and flags the value approximate", () => {
  const gpus = parseCimGpu("NVIDIA GeForce RTX 3070|4293918720\nMicrosoft Basic Display Adapter|\n");
  assert.equal(gpus.length, 2);
  assert.equal(gpus[0].vramTotalMib, 4095);
  assert.equal(gpus[0].approximate, true);
  // AdapterRAM saturates at 4 GiB, which is exactly why it is never used to size
  // a model -- the card above really has 8192 MiB.
  assert.equal(gpus[1].vramTotalMib, null);
});

test("CIM fallback tolerates junk without throwing", () => {
  for (const input of [null, "", "no pipe here", 7]) {
    assert.deepEqual(parseCimGpu(input), [], `input: ${JSON.stringify(input)}`);
  }
});

test("vision manifest summary pulls the pinned runtime facts", () => {
  const summary = summarizeVisionManifest({
    model: { id: "qwen3.5-4b-q4-k-m" },
    runtime: { id: "llama-b10218-win-cuda-13.3-x64" },
    server: {
      host: "127.0.0.1",
      port: 1235,
      arguments: ["-ngl", "all", "-c", "8192", "-t", "12", "--image-max-tokens", "1024"],
    },
  });
  assert.equal(summary.model, "qwen3.5-4b-q4-k-m");
  assert.equal(summary.host, "127.0.0.1");
  assert.equal(summary.port, 1235);
  assert.equal(summary.contextTokens, "8192");
  assert.equal(summary.gpuLayers, "all");
  assert.equal(summary.threads, "12");
  assert.equal(summary.imageMaxTokens, "1024");
});

test("vision manifest summary survives a missing or partial manifest", () => {
  assert.equal(summarizeVisionManifest(null), null);
  assert.equal(summarizeVisionManifest("nope"), null);
  const bare = summarizeVisionManifest({});
  assert.equal(bare.model, null);
  assert.equal(bare.contextTokens, null);
});

test("markdown renders on a machine with no GPU and no python", () => {
  const md = renderMarkdown({
    generatedAt: "2026-08-19T00:00:00.000Z",
    os: { platform: "linux", release: "6.1.0", arch: "x64" },
    cpu: { model: null, logicalCores: 0 },
    memory: { totalGiB: 8, freeGiB: 2 },
    gpus: [],
    node: "v24.19.0",
    python: { path: null, version: null },
    vision: null,
  });
  assert.match(md, /# Hardware/);
  assert.match(md, /none detected/);
  assert.match(md, /not found/);
  // No vision section when the manifest is absent.
  assert.doesNotMatch(md, /pinned loopback/);
});
