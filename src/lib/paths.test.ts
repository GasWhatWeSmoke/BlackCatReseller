import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isUnderManagedRoots } from "./paths.ts";
import type { AppSettingsData } from "./types.ts";

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "blackcat-media-boundary-"));
  const managed = path.join(root, "managed"), outside = path.join(root, "outside");
  fs.mkdirSync(managed); fs.mkdirSync(outside);
  const settings = { processingPath: managed } as AppSettingsData;
  t.after(() => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("blackcat-media-boundary-"));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, managed, outside, settings };
}

test("managed media allows real photos and missing thumbnails but rejects siblings and relative paths", t => {
  const { managed, outside, settings } = fixture(t);
  fs.writeFileSync(path.join(managed, "photo.jpg"), "image");
  assert.equal(isUnderManagedRoots(path.join(managed, "photo.jpg"), settings), true);
  assert.equal(isUnderManagedRoots(path.join(managed, "missing", "thumb.jpg"), settings), true);
  for (const target of [path.join(outside, "photo.jpg"), `${managed}-other/photo.jpg`, "relative.jpg", ""])
    assert.equal(isUnderManagedRoots(target, settings), false, target);
});

test("junctions cannot expose outside files or missing thumbnail descendants", t => {
  const { managed, outside, settings } = fixture(t);
  fs.writeFileSync(path.join(outside, "sentinel.jpg"), "private fixture");
  fs.symlinkSync(outside, path.join(managed, "linked"), "junction");
  assert.equal(isUnderManagedRoots(path.join(managed, "linked", "sentinel.jpg"), settings), false);
  assert.equal(isUnderManagedRoots(path.join(managed, "linked", "missing", "thumb.jpg"), settings), false);
});

test("configured linked roots and links within a managed root remain usable", t => {
  const { root, managed, settings } = fixture(t);
  const alias = path.join(root, "configured-root");
  fs.symlinkSync(managed, alias, "junction");
  fs.mkdirSync(path.join(managed, "photos"));
  fs.writeFileSync(path.join(managed, "photos", "photo.jpg"), "image");
  fs.symlinkSync(path.join(managed, "photos"), path.join(managed, "linked"), "junction");
  assert.equal(isUnderManagedRoots(path.join(managed, "linked", "photo.jpg"), settings), true);
  assert.equal(isUnderManagedRoots(path.join(alias, "photos", "photo.jpg"), { processingPath: alias } as AppSettingsData), true);
});

test("a dangling junction is not treated as an ordinary missing photo path", t => {
  const { managed, outside, settings } = fixture(t);
  fs.symlinkSync(outside, path.join(managed, "dangling"), "junction");
  fs.rmdirSync(outside);
  assert.equal(isUnderManagedRoots(path.join(managed, "dangling", "thumb.jpg"), settings), false);
});
