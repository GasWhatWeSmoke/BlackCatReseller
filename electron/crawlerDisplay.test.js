const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { crawlerDisplay, watchCrawlerDisplay } = require('./crawlerDisplay');
const main = { id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1032 } };
const second = { id: 2, workArea: { x: -313, y: -1440, width: 2560, height: 1392 } };

test('posting uses the secondary monitor including negative desktop coordinates', () => {
  const result = crawlerDisplay([main, second], 1);
  assert.equal(result.secondary, true);
  assert.equal(result.displayId, '2');
  assert.deepEqual(result.bounds, { left: 167, top: -1244, width: 1600, height: 1000 });
});

test('unplugging the second screen blocks browser windows and invalidates stale placement', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blackcat-screen-'));
  const screen = new EventEmitter();
  let displays = [main, second];
  screen.getAllDisplays = () => displays;
  screen.getPrimaryDisplay = () => main;
  try {
    watchCrawlerDisplay(screen, dir);
    const read = () => JSON.parse(fs.readFileSync(path.join(dir, 'crawler-display.json')));
    assert.equal(read().secondary, true);
    displays = [main]; screen.emit('display-removed');
    assert.equal(read().secondary, false);
    assert.equal(read().bounds, null);
    displays = [main, second]; screen.emit('display-added');
    assert.equal(read().secondary, true);
    screen.getAllDisplays = () => { throw Error('display read failed'); };
    screen.emit('display-metrics-changed');
    assert.equal(read().bounds, null);
    assert.equal(crawlerDisplay([{ id: 1, workArea: { x: NaN } }], 1).secondary, false);
  } finally { for (const file of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, file)); fs.rmdirSync(dir); }
});
