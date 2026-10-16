import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

test("mounted beta8 recorder preserves fetch responses, records native outcomes, honors opt-out and restores fetch", async () => {
  const effects: (() => void | (() => void))[] = [], sent: Record<string, unknown>[][] = [];
  const originalFetch: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === '/api/diagnostics') {
      if (init?.method === 'POST') { sent.push(JSON.parse(String(init.body)).events); return Response.json({ recorded: true }); }
      return Response.json({ enabled: true });
    }
    return Response.json({ error: 'Same application response' }, { status: 409 });
  };
  const window = Object.assign(new EventTarget(), { fetch: originalFetch }), document = new EventTarget();
  let flush = () => {};
  const context = vm.createContext({ window, document, location: { origin: 'http://localhost', href: 'http://localhost/inventory', pathname: '/inventory' },
    performance, URL, Request, Event, CustomEvent, Element: class {}, setInterval: (callback: () => void) => { flush = callback; return 1; }, clearInterval() {} });
  const source = ts.transpileModule(fs.readFileSync('src/components/DiagnosticRecorder.tsx', 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const exports: Record<string, () => unknown> = {};
  vm.compileFunction(source, ['exports', 'require'], { parsingContext: context })(exports, (name: string) => {
    if (name === 'react') return { useEffect: (effect: () => void) => effects.push(effect) };
    assert.equal(name, 'next/navigation'); return { usePathname: () => '/inventory' };
  });
  exports.DiagnosticRecorder();
  const cleanup = effects[0]() as () => void; effects[1]();
  await new Promise(resolve => setImmediate(resolve));
  window.dispatchEvent(new CustomEvent('blackcat-native-diagnostic', { detail: JSON.stringify({ action: 'folder_select', phase: 'completed', args: 'NEVER-CAPTURE-ARGS' }) }));
  const response = await window.fetch('/api/items/42', { method: 'PATCH', body: 'NEVER-CAPTURE-BODY' });
  assert.equal(response.status, 409); assert.deepEqual(await response.json(), { error: 'Same application response' });
  await new Promise(resolve => setImmediate(resolve)); flush();
  assert.ok(sent.flat().some(event => event.action === 'folder_select' && event.phase === 'completed'));
  assert.ok(sent.flat().some(event => event.kind === 'request' && event.status === 409));
  assert.ok(!JSON.stringify(sent).includes('NEVER-CAPTURE'));
  const before = sent.length;
  window.dispatchEvent(new CustomEvent('blackcat-diagnostics-enabled', { detail: { enabled: false } }));
  await window.fetch('/api/items/43', { method: 'DELETE' });
  window.dispatchEvent(new CustomEvent('blackcat-native-diagnostic', { detail: JSON.stringify({ action: 'file_select', phase: 'started' }) }));
  await new Promise(resolve => setImmediate(resolve)); flush();
  assert.equal(sent.length, before);
  cleanup(); assert.equal(window.fetch, originalFetch);
});
