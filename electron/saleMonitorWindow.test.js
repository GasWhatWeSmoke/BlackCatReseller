const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { watchSaleMonitorWindow } = require('./saleMonitorWindow');

test('sale monitoring follows open, close-to-tray and reopen, while minimize stays open', () => {
  const win = new EventEmitter(), states = [];
  watchSaleMonitorWindow(win, open => states.push(open));
  win.emit('minimize'); win.emit('restore');
  assert.deepEqual(states, [true]);
  win.emit('hide'); win.emit('show'); win.emit('closed');
  assert.deepEqual(states, [true, false, true, false]);
});
