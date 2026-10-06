import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { validImportPhotoName, writeIncomingPhoto } from "./importPhoto.ts";

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "blackcat-upload-"));
  t.after(() => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("blackcat-upload-"));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

test("import accepts plain JPEG names and rejects path, stream and device names", () => {
  for (const name of ["IMG_001.JPG", "shirt front.jpeg", "café.jpg", ".photo.jpg"])
    assert.equal(validImportPhotoName(name), true, name);
  for (const name of ["", "../outside.jpg", "..\\outside.jpg", "C:\\photo.jpg", "/photo.jpg",
    "a/b.jpg", "a\\b.jpg", "photo:stream.jpg", "NUL.jpg", "COM1.jpg", "lpt0.jpeg", "a\0.jpg",
    "photo.jpg ", "photo.jpg.", "photo.png", "photo?.jpg"])
    assert.equal(validImportPhotoName(name), false, name);
});

test("concurrent same-name uploads preserve every complete file and existing original", async t => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, "camera.jpg"), "original");
  const contents = Array.from({ length: 20 }, (_, i) => `photo-${i}`);
  const results = await Promise.all(contents.map(value => writeIncomingPhoto(root, "camera.jpg", Buffer.from(value))));
  assert.equal(new Set(results).size, contents.length);
  for (const [index, destination] of results.entries()) {
    assert.equal(path.dirname(destination), fs.realpathSync(root));
    assert.equal(fs.readFileSync(destination, "utf8"), contents[index]);
  }
  assert.equal(fs.readFileSync(path.join(root, "camera.jpg"), "utf8"), "original");
});

test("invalid upload paths create nothing outside incoming", async t => {
  const root = fixture(t), incoming = path.join(root, "incoming");
  await assert.rejects(writeIncomingPhoto(incoming, "..\\outside.jpg", Buffer.from("bad")));
  await assert.rejects(writeIncomingPhoto("relative", "safe.jpg", Buffer.from("bad")));
  assert.deepEqual(fs.readdirSync(root), []);
});

test("an existing junction entry is preserved and the upload receives another name", async t => {
  const root = fixture(t), incoming = path.join(root, "incoming"), target = path.join(root, "target");
  fs.mkdirSync(incoming); fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, "sentinel"), "preserved");
  fs.symlinkSync(target, path.join(incoming, "camera.jpg"), "junction");
  const result = await writeIncomingPhoto(incoming, "camera.jpg", Buffer.from("uploaded"));
  assert.equal(path.basename(result), "camera__1.jpg");
  assert.equal(fs.readFileSync(result, "utf8"), "uploaded");
  assert.equal(fs.readFileSync(path.join(target, "sentinel"), "utf8"), "preserved");
  assert.equal(fs.lstatSync(path.join(incoming, "camera.jpg")).isSymbolicLink(), true);
});
