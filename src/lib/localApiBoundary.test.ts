import assert from "node:assert/strict";
import test from "node:test";
import {
  checkLocalApiBoundary,
  LOCAL_APP_HOST,
  LOCAL_APP_ORIGIN,
} from "./localApiBoundary.ts";

function headers(values: Record<string, string> = {}): Headers {
  return new Headers(values);
}

test("accepts the fixed loopback host for safe API reads", () => {
  assert.deepEqual(checkLocalApiBoundary("GET", headers({ host: LOCAL_APP_HOST })), { ok: true });
});

test("rejects DNS-rebinding and alternate loopback Host values", () => {
  for (const host of ["attacker.invalid", "localhost:41999", "127.0.0.1:42000", ""]) {
    const decision = checkLocalApiBoundary("GET", headers(host ? { host } : {}));
    assert.equal(decision.ok, false, host);
    if (!decision.ok) {
      assert.equal(decision.status, 421);
      assert.equal(decision.error, "INVALID_HOST");
    }
  }
});

test("accepts same-origin unsafe browser requests", () => {
  const decision = checkLocalApiBoundary("POST", headers({
    host: LOCAL_APP_HOST,
    origin: LOCAL_APP_ORIGIN,
    "sec-fetch-site": "same-origin",
  }));
  assert.deepEqual(decision, { ok: true });
});

test("rejects foreign Origin and Fetch-Metadata on unsafe methods", () => {
  const cases: Array<Record<string, string>> = [
    { origin: "https://attacker.invalid" },
    { "sec-fetch-site": "cross-site" },
    { "sec-fetch-site": "same-site" },
    { "sec-fetch-site": "none" },
    { origin: "null" },
  ];
  for (const extra of cases) {
    const decision = checkLocalApiBoundary("DELETE", headers({ host: LOCAL_APP_HOST, ...extra }));
    assert.equal(decision.ok, false, JSON.stringify(extra));
    if (!decision.ok) assert.equal(decision.status, 403);
  }
});

test("preserves same-host non-browser clients without browser-only headers", () => {
  assert.deepEqual(checkLocalApiBoundary("PUT", headers({ host: LOCAL_APP_HOST })), { ok: true });
});

test("a port hint cannot alter the production API boundary", () => {
  for (const options of [{ previewPort: "53000" }, { preview: false, previewPort: "53000" }]) {
    assert.deepEqual(checkLocalApiBoundary("GET", headers({ host: LOCAL_APP_HOST }), options), { ok: true });
    assert.equal(checkLocalApiBoundary("GET", headers({ host: "127.0.0.1:53000" }), options).ok, false);
  }
});

test("explicit preview reads accept only their validated isolated loopback host", () => {
  for (const previewPort of ["49152", "53000", "65535"]) {
    const options = { preview: true, previewPort };
    assert.deepEqual(checkLocalApiBoundary("GET", headers({ host: `127.0.0.1:${previewPort}` }), options), { ok: true });
    for (const host of [LOCAL_APP_HOST, `localhost:${previewPort}`, `attacker.invalid:${previewPort}`, "127.0.0.1:53001"]) {
      assert.equal(checkLocalApiBoundary("GET", headers({ host }), options).ok, false);
    }
  }
});

test("an incomplete preview cannot fall back to the production API", () => {
  for (const previewPort of [undefined, "", "41999", "49151", "65536", "53000.5", "invalid"]) {
    const result = checkLocalApiBoundary("GET", headers({ host: LOCAL_APP_HOST }), { preview: true, previewPort });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.status, 421);
  }
});

test("preview origin selection preserves the unsafe-request origin boundary", () => {
  const options = { preview: true, previewPort: "53000" };
  for (const origin of [LOCAL_APP_ORIGIN, "http://localhost:53000", "https://attacker.invalid", "null"]) {
    assert.equal(checkLocalApiBoundary("POST", headers({ host: "127.0.0.1:53000", origin }), options).ok, false);
  }
  assert.equal(checkLocalApiBoundary("POST", headers({ host: "127.0.0.1:53000", origin: "http://127.0.0.1:53000", "sec-fetch-site": "cross-site" }), options).ok, false);
  // Middleware independently rejects every unsafe preview method before this helper.
  assert.deepEqual(checkLocalApiBoundary("HEAD", headers({ host: "127.0.0.1:53000" }), options), { ok: true });
});
