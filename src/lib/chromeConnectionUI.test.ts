import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as jsx from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';

const source = ts.transpileModule(fs.readFileSync('src/components/ChromeConnection.tsx', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
}).outputText;

function render(status: Record<string, boolean>) {
  const states = [status, false, '', true]; let stateIndex = 0;
  const modules: Record<string, unknown> = {
    react: { useState: () => [states[stateIndex++], () => {}], useRef: (value: unknown) => ({ current: value }), useEffect: () => {} },
    'react/jsx-runtime': jsx,
    './ChromeConnection.module.css': { __esModule: true, default: { panel: 'panel' } },
  };
  const exports: Record<string, any> = {};
  vm.compileFunction(source, ['exports', 'require'])(exports, (name: string) => {
    assert.ok(Object.hasOwn(modules, name), name); return modules[name];
  });
  const html = renderToStaticMarkup(exports.ChromeConnection());
  assert.equal(stateIndex, states.length);
  return html;
}

test('a queued browser task awaiting Chrome approval does not claim it is connected', () => {
  const html = render({ available: true, connected: false, busy: true, paused: false, failed: false, approvalPending: true });
  assert.match(html, /Waiting for Chrome.*click Allow in its prompt/);
  assert.doesNotMatch(html, /Connected · browser task running/);
  assert.match(html, /<button[^>]*disabled=""[^>]*>Connect Chrome<\/button>/);
  assert.match(html, /<button[^>]*disabled=""[^>]*>Disconnect Chrome<\/button>/);
});

test('approval guidance is also shown before a task is queued', () => {
  const html = render({ available: true, connected: false, busy: false, paused: false, approvalPending: true });
  assert.match(html, /Waiting for Chrome.*click Allow in its prompt/);
  assert.match(html, /<button[^>]*disabled=""[^>]*>Connect Chrome<\/button>/);
});

test('connected, disconnected and failed states retain their distinct guidance', () => {
  const base = { available: true, connected: true, busy: false, paused: false, failed: false, approvalPending: false };
  assert.match(render(base), /<p role="status">Connected<\/p>/);
  assert.match(render({ ...base, busy: true }), /Connected · browser task running/);
  assert.match(render({ ...base, connected: false, paused: true }), /Disconnected · automatic reconnect paused/);
  assert.match(render({ ...base, connected: false, failed: true }), /Connection lost/);
});
