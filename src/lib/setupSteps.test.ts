// A checklist that lies is worse than no checklist: a new user who is told they are set
// up, and then cannot upload, has no idea which of eight things went wrong. These tests
// pin the two ways it could lie — calling something done that is not, and calling the
// app broken when it is merely missing an optional GPU.
import test from "node:test";
import assert from "node:assert/strict";
import { buildSetupSteps, setupProgress, blockingSteps, type SetupFacts } from "./setupSteps.ts";

const fresh = (over: Partial<SetupFacts> = {}): SetupFacts => ({
  incomingPathSet: false, incomingPathExists: false, incomingPath: "",
  workerInstalled: false, hasMarketplaceAccount: false, hasSecondaryDisplay: false,
  visionEnabled: false, visionInstalled: false,
  itemCount: 0, readyCount: 0, uploadedCount: 0, acknowledged: [],
  ...over,
});

const ready = (over: Partial<SetupFacts> = {}): SetupFacts => fresh({
  incomingPathSet: true, incomingPathExists: true, incomingPath: "C:\\photos",
  workerInstalled: true, hasMarketplaceAccount: true, hasSecondaryDisplay: true,
  itemCount: 12, readyCount: 3, uploadedCount: 1, acknowledged: ["ebay-policy"],
  ...over,
});

test("a brand-new install has everything to do and nothing claimed done", () => {
  const steps = buildSetupSteps(fresh());
  assert.equal(steps.filter((s) => s.state === "done").length, 0);
  const p = setupProgress(steps);
  assert.equal(p.done, 0);
  assert.equal(p.complete, false);
});

test("the worker comes FIRST — nothing else works without it", () => {
  assert.equal(buildSetupSteps(fresh())[0].id, "worker");
});

test("a fully set-up install reports complete", () => {
  const steps = buildSetupSteps(ready());
  const p = setupProgress(steps);
  assert.equal(p.complete, true, steps.filter((s) => s.state !== "done").map((s) => s.id).join(", "));
});

test("missing the GPU never makes the app look broken", () => {
  // The whole listing workflow runs without local AI. A tester on a laptop must not be
  // told they are incomplete because of a card they were never going to have.
  const steps = buildSetupSteps(ready({ visionEnabled: false, visionInstalled: false }));
  const vision = steps.find((s) => s.id === "vision")!;
  assert.equal(vision.optional, true);
  assert.equal(vision.blocking, false);
  assert.equal(setupProgress(steps).complete, true);
  assert.equal(blockingSteps(steps).length, 0);
});

test("only the required workstation and marketplace steps are blocking", () => {
  const blockers = blockingSteps(buildSetupSteps(fresh())).map((s) => s.id);
  assert.deepEqual(blockers, ["worker", "folders", "marketplace-accounts", "second-monitor"]);
});

test("a photo folder that is configured but does not exist is NOT done", () => {
  // The commonest first-run mistake: a path typed by hand, or a drive that is not plugged
  // in. Treating "a value is set" as "it works" sends them to Process to fail.
  const steps = buildSetupSteps(ready({ incomingPathSet: true, incomingPathExists: false, incomingPath: "D:\\gone" }));
  const folders = steps.find((s) => s.id === "folders")!;
  assert.equal(folders.state, "todo");
  assert.match(folders.note ?? "", /does not exist/);
});

test("the eBay policy is acknowledged by hand, because nothing local can see it", () => {
  const notAcked = buildSetupSteps(ready({ acknowledged: [] })).find((s) => s.id === "ebay-policy")!;
  assert.equal(notAcked.state, "todo");
  assert.equal(notAcked.manual, true);
  const acked = buildSetupSteps(ready({ acknowledged: ["ebay-policy"] })).find((s) => s.id === "ebay-policy")!;
  assert.equal(acked.state, "done");
});

test("browser tasks require a second monitor", () => {
  const steps=buildSetupSteps(ready({hasSecondaryDisplay:false}));
  const display=steps.find(s=>s.id==='second-monitor')!;
  assert.equal(display.blocking,true);
  assert.equal(display.state,'todo');
});

test("every step tells you where to go, or says it is done elsewhere", () => {
  for (const s of buildSetupSteps(fresh())) {
    assert.ok(s.title.length > 0, s.id);
    assert.ok(s.detail.length > 40, `${s.id} needs a real explanation`);
    assert.ok(s.href || s.manual, `${s.id} has nowhere to go and is not marked manual`);
  }
});

test("progress counts real state, and vision never inflates it", () => {
  const half = buildSetupSteps(fresh({ workerInstalled: true, incomingPathSet: true, incomingPathExists: true }));
  const p = setupProgress(half);
  assert.equal(p.done, 2);
  assert.ok(p.total >= 6 && p.total <= 8, String(p.total));
  // Turning vision on must not change the denominator.
  const withVision = setupProgress(buildSetupSteps(fresh({
    workerInstalled: true, incomingPathSet: true, incomingPathExists: true,
    visionEnabled: true, visionInstalled: true,
  })));
  assert.equal(withVision.total, p.total);
});

test("the listing step reflects how far along you actually are", () => {
  const nothing = buildSetupSteps(ready({ uploadedCount: 0, readyCount: 0 })).find((s) => s.id === "first-listing")!;
  assert.match(nothing.note ?? "", /Nothing uploaded/);
  const staged = buildSetupSteps(ready({ uploadedCount: 0, readyCount: 5 })).find((s) => s.id === "first-listing")!;
  assert.match(staged.note ?? "", /5 item\(s\) ready/);
});
