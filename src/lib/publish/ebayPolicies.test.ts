import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import type { ChildProcess } from "node:child_process";
import { readEbayPolicies } from "./ebayPolicies.ts";
import { ebayPolicyNames, mergeEbayPolicies, savedEbayPolicyCatalog, validateEbayPolicyResult } from "./ebayPolicyCatalog.ts";
import * as policyCatalog from "./ebayPolicyCatalog.ts";
import { browserHolder, claimBrowser, releaseBrowser } from "../browserCoordinator.ts";
import type { AppSettingsData } from "../types.ts";

const settings = (names = {}) => ({ dataRoot: '/local-workspace', publish: { ebayBrowser: { enabled: true, ...names }, depop: { enabled: true } } }) as AppSettingsData;
const reply = { ok: true, complete: true, policies: [
  { kind: 'shipping', name: 'Default shipping', isDefault: true }, { kind: 'shipping', name: 'Express', isDefault: false },
  { kind: 'return', name: '30 day returns', isDefault: false },
  { kind: 'payment', name: 'Choice one', isDefault: false }, { kind: 'payment', name: 'Choice two', isDefault: false },
] };

test("complete policy catalogs fill only unchanged empty fields and preserve other settings", () => {
  const before = settings(), catalog = validateEbayPolicyResult(reply);
  const merged = { ...before, ...mergeEbayPolicies(before, before, catalog) };
  assert.deepEqual(ebayPolicyNames(merged), { shippingPolicyName: 'Default shipping', returnPolicyName: '30 day returns', paymentPolicyName: '' });
  assert.equal(merged.publish!.depop!.enabled, true);
  const changed = settings({ shippingPolicyName: 'My manual override' });
  assert.equal(mergeEbayPolicies(changed, before, catalog).publish!.ebayBrowser!.shippingPolicyName, 'My manual override');
  const formerlySet = settings({ returnPolicyName: 'Previous override' });
  assert.equal(mergeEbayPolicies(before, formerlySet, catalog).publish!.ebayBrowser!.returnPolicyName, undefined,
    'a manually cleared field must stay blank even when a lookup started with a previous choice');
  assert.throws(() => mergeEbayPolicies({ ...before, dataRoot: '/other' }, before, catalog), /workspace changed/);
});

test("incomplete, duplicate, malformed and multiple-default policy readings never choose arbitrary names", () => {
  assert.throws(() => validateEbayPolicyResult({ ...reply, complete: false }), /incomplete/);
  assert.throws(() => validateEbayPolicyResult({ ...reply, policies: [{ kind: 'shipping', name: 'Same', isDefault: false }, { kind: 'shipping', name: ' same ', isDefault: true }] }), /duplicate/);
  assert.throws(() => validateEbayPolicyResult({ ...reply, policies: [{ kind: 'shipping', name: 'Bad\nname', isDefault: true }] }), /invalid/);
  assert.throws(() => savedEbayPolicyCatalog({ ...reply, readAt: 'not-a-date' }), /incomplete/);
  const catalog = validateEbayPolicyResult({ ...reply, policies: reply.policies.slice(0, 2).map(policy => ({ ...policy, isDefault: true })) });
  assert.equal(mergeEbayPolicies(settings(), settings(), catalog).publish!.ebayBrowser!.shippingPolicyName, undefined);
});

function child(pid: number | undefined = 42) {
  return Object.assign(new EventEmitter(), { pid: pid as number | undefined, stdout: new PassThrough(), stderr: new PassThrough(), killed: false,
    kill() { this.killed = true; return true; } });
}
test("policy worker holds the shared browser until close and decodes split Unicode names", async () => {
  const worker = child(), promise = readEbayPolicies(settings(), { launch: () => worker as unknown as ChildProcess });
  const bytes = Buffer.from('EBAY_POLICIES_DONE ' + JSON.stringify({ ...reply, policies: [{ kind: 'return', name: 'Retours été', isDefault: true }] }) + '\n');
  for (const byte of bytes) worker.stdout.write(Buffer.from([byte]));
  assert.equal(browserHolder(), 'eBay policy lookup');
  assert.equal(claimBrowser('posting'), false);
  worker.emit('close', 0);
  assert.equal((await promise).policies[0].name, 'Retours été');
  assert.equal(browserHolder(), null);
});
test("policy timeout and process errors retain ownership until the child really exits", async () => {
  const worker = child(), promise = readEbayPolicies(settings(), { launch: () => worker as unknown as ChildProcess, timeoutMs: 5 });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(worker.killed, true); assert.equal(browserHolder(), 'eBay policy lookup');
  worker.emit('close', 0);
  await assert.rejects(promise, /timed out/); assert.equal(browserHolder(), null);
  const missing = child(); missing.pid = undefined;
  const failed = readEbayPolicies(settings(), { launch: () => missing as unknown as ChildProcess });
  missing.emit('error', Error('ENOENT')); await assert.rejects(failed, /could not start/);
  assert.equal(browserHolder(), null);
});
test("an occupied browser blocks policy lookup without releasing another task's claim", async () => {
  claimBrowser('active listing');
  try { await assert.rejects(readEbayPolicies(settings()), /active listing/); assert.equal(browserHolder(), 'active listing'); }
  finally { releaseBrowser(); }
});

test("policy API rejects stale workspace/preferences before browser work and preserves edits during lookup", async () => {
  let current = settings(), lookups = 0;
  const source = ts.transpileModule(fs.readFileSync('src/app/api/publish/ebay-policies/route.ts', 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const dependencies: Record<string, unknown> = {
    'next/server': { NextResponse: Response }, '@/lib/publish/ebayPolicyCatalog': policyCatalog,
    '@/lib/settings': { getRequiredSettings: async () => structuredClone(current), updateSettings: async (update: (settings: AppSettingsData) => Partial<AppSettingsData>) => {
      current = { ...current, ...update(current) }; return current;
    } },
    '@/lib/publish/ebayPolicies': { readEbayPolicies: async () => {
      lookups++; current.publish!.ebayBrowser!.shippingPolicyName = 'Edited in another window'; return validateEbayPolicyResult(reply);
    } },
  };
  const routes: Record<string, (request?: Request) => Promise<Response>> = {};
  vm.compileFunction(source, ['exports', 'require'])(routes, (name: string) => {
    assert.ok(name in dependencies, name); return dependencies[name];
  });
  const send = (body: unknown) => routes.POST(new Request('http://localhost/api/publish/ebay-policies', { method: 'POST', body: JSON.stringify(body) }));
  const names = ebayPolicyNames(current);
  assert.equal((await send({ workspace: '/foreign', expected: names })).status, 409);
  assert.equal((await send({ workspace: current.dataRoot, expected: { ...names, returnPolicyName: 'stale' } })).status, 409);
  assert.equal(lookups, 0);
  const response = await send({ workspace: current.dataRoot, expected: names });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.names.shippingPolicyName, 'Edited in another window');
  assert.equal(result.names.returnPolicyName, '30 day returns');
  assert.equal((await (await routes.GET()).json()).catalog.complete, true);
});
