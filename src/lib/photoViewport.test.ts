import test from "node:test";
import assert from "node:assert/strict";
import { photoViewport, photoViewCenter, photoViewScroll } from "./photoViewport.ts";
const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < .00001, `${actual} != ${expected}`);

test("fit contains landscape, portrait and quarter-turn images without enlarging small originals", () => {
  const image = { width: 1600, height: 900 }, frame = { width: 800, height: 600 };
  for (const rotation of [0, 90, 180, 270, -90, 450]) {
    const view = photoViewport(image, frame, rotation)!;
    assert.ok(view.width <= 800.00001 && view.height <= 600.00001);
    assert.equal(view.canPan, false);
    close(view.scale, rotation % 180 === 0 ? .5 : .375);
  }
  const small = photoViewport({ width: 100, height: 200 }, frame, 0)!;
  assert.equal(small.scale, 1); assert.equal(small.imageWidth, 100);
});

test("100 percent retains source dimensions and makes every rotated edge reachable", () => {
  const view = photoViewport({ width: 1600, height: 900 }, { width: 800, height: 600 }, 90, 1)!;
  assert.equal(view.imageWidth, 1600); assert.equal(view.imageHeight, 900); assert.equal(view.canPan, true);
  close(view.width, 900); close(view.height, 1600);
  assert.deepEqual(photoViewScroll(view, { x: 0, y: 0 }), { left: 0, top: 0 });
  const end = photoViewScroll(view, { x: 1, y: 1 }); close(end.left, 100); close(end.top, 1000);
});

test("zoom preserves the viewed center away from clamped edges", () => {
  const image = { width: 2400, height: 1800 }, frame = { width: 800, height: 600 };
  const before = photoViewport(image, frame, 270, 1)!;
  const center = photoViewCenter(before, 400, 700);
  const after = photoViewport(image, frame, 270, 2)!;
  const scroll = photoViewScroll(after, center), result = photoViewCenter(after, scroll.left, scroll.top);
  close(result.x, center.x); close(result.y, center.y);
});

test("zoom bounds and invalid dimensions do not create infinite or negative layout", () => {
  const image = { width: 12000, height: 8000 }, frame = { width: 300, height: 200 };
  close(photoViewport(image, frame, 0, -5)!.scale, .025);
  assert.equal(photoViewport(image, frame, 0, 99)!.scale, 4);
  close(photoViewport(image, frame, 0, NaN)!.scale, .025);
  for (const value of [0, -1, Infinity, NaN]) assert.equal(photoViewport({ width: value, height: 10 }, frame, 0), null);
  assert.equal(photoViewport(image, { width: 0, height: 0 }, 0), null);
  assert.equal(photoViewport(image, frame, NaN), null);
  assert.equal(photoViewport({ width: Number.MAX_VALUE, height: 10 }, frame, 0, 4), null);
});
