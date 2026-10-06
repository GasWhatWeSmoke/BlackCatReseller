import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import ts from 'typescript';

// Exercise the actual private preflight without loading or spawning a worker.
const file = ts.createSourceFile('worker.ts', fs.readFileSync('src/lib/worker.ts', 'utf8'), ts.ScriptTarget.Latest, true);
const nodes = file.statements.filter(node => ts.isFunctionDeclaration(node) && node.name?.text === 'assertReenrichBatchInput'
  || ts.isVariableStatement(node) && node.declarationList.declarations.some(declaration => ts.isIdentifier(declaration.name) && declaration.name.text.startsWith('MAX_REENRICH_')));
const printer = ts.createPrinter();
const source = ts.transpileModule(nodes.map(node => printer.printNode(ts.EmitHint.Unspecified, node, file)).join('\n') + '\nexports.validate = assertReenrichBatchInput;',
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const api: Record<string, any> = {};
vm.compileFunction(source, ['exports', 'fs', 'path'])(api, fs, path);

test('retry preflight accepts optional quarter turns and rejects malformed rotation metadata', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blackcat-rotation-input-')), photo = path.join(root, 'photo.jpg');
  t.after(() => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('blackcat-rotation-input-')); fs.rmSync(root, { recursive: true, force: true }); });
  fs.writeFileSync(photo, 'metadata fixture; no image decoding or worker is invoked');
  const metadata = { photoId: 1, storedPath: photo, isMarker: false, sha256: 'a'.repeat(64) };
  const validate = (value: unknown) => api.validate({ processingPath: root }, [{ requestId: 'one', sku: 'ROTATE', photos: [value] }]);
  assert.doesNotThrow(() => validate(metadata));
  for (const rotation of [0, 90, 180, 270]) assert.doesNotThrow(() => validate({ ...metadata, rotation }));
  for (const rotation of [null, false, true, '90', -90, 45, 360, NaN, Infinity])
    assert.throws(() => validate({ ...metadata, rotation }), /photo metadata is invalid/);
  assert.throws(() => validate({ ...metadata, rotation: 90, endpoint: 'override' }), /photo metadata is invalid/);
});
