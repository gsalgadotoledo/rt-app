import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compare, encode, decode, expand, normalize, loadContract, saveRecorded, serveContracts, runTarget, check, main } from "../dist/index.js";

test("values: tagged types round-trip and null equals missing", () => {
  const value = { at: new Date("2026-01-02T03:04:05.000Z"), n: 10n, bytes: new Uint8Array([1, 2]), skip: undefined, fn() {}, set: new Set([1]) };
  const wire = encode(value);
  assert.deepEqual(wire, { at: { $date: "2026-01-02T03:04:05.000Z" }, n: { $bigint: "10" }, bytes: { $bytes: "AQI=" }, set: [1] });
  const back = decode(wire);
  assert.equal(back.at.getTime(), value.at.getTime());
  assert.equal(back.n, 10n);
  assert.deepEqual([...back.bytes], [1, 2]);
  assert.throws(() => encode(NaN), /Non-finite/);
  assert.equal(compare({ a: 1, b: null }, { a: 1 }), undefined);
  assert.equal(compare({ a: 1 }, { a: 1, b: null }), undefined);
  assert.match(compare({ a: 1, leak: "x" }, { a: 1 }), /unexpected field leak/);
});

test("values: matchers", () => {
  assert.equal(compare("2026-01-01T00:00:00.000Z", { $type: "iso-date" }), undefined);
  assert.match(compare("yesterday", { $type: "iso-date" }), /expected iso-date/);
  assert.equal(compare(3, { $type: "integer" }), undefined);
  assert.match(compare(3.5, { $type: "integer" }), /integer/);
  assert.equal(compare("prod_1", { $regex: "^prod_" }), undefined);
  assert.equal(compare(0.30000000000000004, { $approx: 0.3 }), undefined);
  assert.equal(compare({ a: 1, extra: 2 }, { $partial: { a: 1 } }), undefined);
  assert.equal(compare([1, 2], { $length: 2 }), undefined);
  assert.equal(compare("b", { $oneOf: ["a", "b"] }), undefined);
  assert.equal(compare(null, { $any: true }), undefined);
  assert.match(compare(1, { $nope: 1 }), /unknown matcher/);
  assert.match(compare([1], [1, 2]), /expected 2 items/);
});

test("values: $ref, $repeat and $text macros", () => {
  const results = [{ value: { cursor: "c1", items: [{ sk: "a" }] } }];
  assert.equal(expand({ $ref: "0.value.cursor" }, results), "c1");
  assert.equal(expand({ $ref: "0.value.items[0].sk" }, results), "a");
  assert.throws(() => expand({ $ref: "1.value" }, results), /nothing at 1/);
  assert.deepEqual(expand([0, { $repeat: { count: 2, start: 1, item: { sk: "k{i:03}", i: "{i}" } } }, 9]), [0, { sk: "k001", i: 1 }, { sk: "k002", i: 2 }, 9]);
  assert.equal(expand({ $text: { repeat: "ab", count: 3 } }), "ababab");
  assert.throws(() => expand({ $repeat: { count: -1, item: 1 } }), /count/);
});

test("contracts: shorthands, defaults and validation", () => {
  const contract = normalize({ contract: 1, module: "m", init: { a: 1 }, cases: [{ name: "one", call: "f", args: [1], expect: { value: 2 } }, { name: "two", init: { b: 2 }, steps: [{ call: "g" }] }] });
  assert.equal(contract.subject, "m");
  assert.deepEqual(contract.cases[0].steps, [{ call: "f", args: [1], expect: { value: 2 }, note: undefined }]);
  assert.deepEqual(contract.cases[1].init, { b: 2 });
  assert.deepEqual(contract.cases[1].steps[0].args, []);
  assert.throws(() => normalize({ module: "m", cases: [] }), /contract: 1/);
  assert.throws(() => normalize({ contract: 1, module: "m", cases: [{ name: "x", call: "f", expect: { value: 1, error: {} } }] }), /exactly one/);
  assert.throws(() => normalize({ contract: 1, module: "m", cases: [{ name: "x", call: "f" }, { name: "x", call: "f" }] }), /duplicate case name/);
  assert.throws(() => normalize({ contract: 1, module: "m", cases: [{ name: "x", call: "f", args: "no" }] }), /args must be a list/);
  assert.throws(() => normalize({ contract: 1, kind: "http", module: "m", cases: [{ name: "x", request: { method: "GET", path: "health" } }] }), /path starting/);
});

test("check: values, errors and mismatches", () => {
  assert.equal(check({ ok: true, value: 1 }, { value: 1 }), undefined);
  assert.equal(check({ ok: false, error: { type: "HttpError", status: 400, message: "Bad" } }, { error: { status: 400 } }), undefined);
  assert.match(check({ ok: true, value: 1 }, { error: { status: 400 } }), /expected error/);
  assert.match(check({ ok: false, error: { type: "Error", message: "boom" } }, { value: 1 }), /threw Error: boom/);
  assert.match(check({ ok: false, error: { type: "E", status: 409, message: "c" } }, { error: { status: 400 } }), /error.status/);
});

class Counter {
  constructor(start) { this.value = start; }
  add(n) { if (typeof n !== "number") throw Object.assign(new Error("Not a number"), { status: 400 }); this.value += n; return this.value; }
  async later() { return { at: new Date(0), missing: undefined }; }
  _internal() { return "hidden"; }
}

test("host + runner: instances per case, steps share the instance, missing subjects and methods", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "contract-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const host = await serveContracts({ language: "test", subjects: { counter: (init) => { if (init.start < 0) throw new RangeError("start must be positive"); return new Counter(init.start); } } });
  t.after(() => host.close());
  const info = await (await fetch(host.url)).json();
  assert.deepEqual(info.subjects, ["counter"]);
  assert.equal((await fetch(host.url + "/instances", { method: "POST", headers: { origin: "https://evil.example" }, body: "{}" })).status, 403, "browsers are refused");
  const file = join(dir, "counter.contract.yaml");
  await writeFile(file, `contract: 1
module: counter
init: { start: 1 }
cases:
  - name: adds
    steps:
      - { call: add, args: [2], expect: { value: 3 } }
      - { call: add, args: [{ $ref: "0.value" }], expect: { value: 6 } }
  - name: validates
    call: add
    args: ["x"]
    expect: { error: { status: 400, message: Not a number } }
  - name: fresh instance per case
    call: add
    args: [0]
    expect: { value: 1 }
  - name: dates are tagged
    call: later
    expect: { value: { at: { $date: "1970-01-01T00:00:00.000Z" } } }
  - name: init errors are testable
    init: { start: -1 }
    create: { error: { type: RangeError, message: start must be positive } }
  - name: private methods are not callable
    call: _internal
  - name: to record
    call: add
    args: [41]
  - name: wrong
    call: add
    args: [1]
    expect: { value: 99 }
  - name: other subject
    subject: nope
    call: x
`);
  const contract = await loadContract(file);
  const results = await runTarget({ name: "js", host: host.url }, [contract]);
  assert.deepEqual(results.map((r) => [r.name, r.status]), [["adds", "passed"], ["validates", "passed"], ["fresh instance per case", "passed"], ["dates are tagged", "passed"], ["init errors are testable", "passed"], ["private methods are not callable", "missing"], ["to record", "unrecorded"], ["wrong", "failed"], ["other subject", "missing"]]);
  assert.match(results.find((r) => r.name === "wrong").message, /expected 99, got 2/);
  const recorded = new Map();
  await runTarget({ name: "js", host: host.url }, [contract], { recorded, filter: "to record" });
  assert.equal(await saveRecorded(contract, recorded.get(file)), 1);
  assert.match(await readFile(file, "utf8"), /name: to record\n    call: add\n    args: \[ 41 \]\n    expect: \{ value: 42 \}/);
});

test("cli: show and test with a config file", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "contract-cli-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const host = await serveContracts({ subjects: { counter: (init) => new Counter(init.start ?? 0) } });
  t.after(() => host.close());
  await writeFile(join(dir, "c.contract.json"), JSON.stringify({ contract: 1, module: "counter", cases: [{ name: "adds", call: "add", args: [1], expect: { value: 1 } }] }));
  await writeFile(join(dir, "contracts.json"), JSON.stringify({ contracts: ["."], targets: { js: { host: host.url } } }));
  const lines = [];
  assert.equal(await main(["show", join(dir, "c.contract.json")], (l) => lines.push(l)), 0);
  assert.match(lines.join("\n"), /add\(1\) → 1/);
  lines.length = 0;
  assert.equal(await main(["test", "--config", join(dir, "contracts.json")], (l) => lines.push(l)), 0);
  assert.match(lines.join("\n"), /✓ counter · adds/);
  await assert.rejects(main(["test", "--bogus"]), /Usage/);
});

const DIST = new URL("../dist/index.js", import.meta.url).href;

test("targets started by command: host, API, http contracts and startup failures", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "contract-cmd-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, "host.mjs"), `import { runHost } from ${JSON.stringify(DIST)};\nawait runHost({ language: "test", subjects: { echo: () => ({ echo: (v) => v }) } });\n`);
  await writeFile(join(dir, "api.mjs"), `import { createServer } from "node:http";
createServer(async (req, res) => {
  let raw = ""; for await (const c of req) raw += c;
  if (req.url === "/health") { res.writeHead(200, { "content-type": "application/json", "x-kind": "health" }); return res.end('{"ok":true}'); }
  if (req.url.startsWith("/echo")) { let body; try { body = raw ? JSON.parse(raw) : {}; } catch { res.writeHead(400); return res.end('{"error":"Invalid JSON"}'); } res.writeHead(200); return res.end(JSON.stringify({ body, url: req.url })); }
  res.writeHead(404, { "content-type": "text/plain" }); res.end("missing");
}).listen(Number(process.env.PORT), "127.0.0.1");\n`);
  await writeFile(join(dir, "broken.mjs"), `process.exit(3);\n`);
  await writeFile(join(dir, "echo.contract.yaml"), `contract: 1
module: echo
cases:
  - { name: echoes, call: echo, args: [{ a: 1 }], expect: { value: { a: 1 } } }
`);
  await writeFile(join(dir, "api.contract.yaml"), `contract: 1
kind: http
module: api
cases:
  - name: health
    request: { method: GET, path: /health }
    expect: { status: 200, body: { ok: true }, headers: { x-kind: health } }
  - name: chained
    requests:
      - { request: { method: POST, path: /echo, body: { id: 7 } }, expect: { status: 200, body: { $partial: { body: { id: 7 } } } } }
      - { request: { method: POST, path: /echo, query: { q: "1" }, body: { again: { $ref: "0.body.body.id" } } }, expect: { status: 200, body: { body: { again: 7 }, url: "/echo?q=1" } } }
      - { request: { method: POST, path: "/echo/{{0.body.body.id}}/a b", query: { r: { $ref: "0.body.body.id" } } }, expect: { status: 200, body: { $partial: { url: "/echo/7/a%20b?r=7" } } } }
  - name: raw
    request: { method: POST, path: /echo, raw: "{nope" }
    expect: { status: 400, body: { error: Invalid JSON } }
  - name: text body
    request: { method: GET, path: /other }
    expect: { status: 404, body: missing }
  - name: wrong status
    request: { method: GET, path: /other }
    expect: { status: 200 }
  - name: wrong body
    request: { method: GET, path: /health }
    expect: { body: { ok: false } }
  - name: wrong header
    request: { method: GET, path: /health }
    expect: { headers: { x-kind: other } }
  - name: not recorded
    request: { method: GET, path: /health }
`);
  const contracts = [await loadContract(join(dir, "echo.contract.yaml")), await loadContract(join(dir, "api.contract.yaml"))];
  const results = await runTarget({ name: "cmd", host: { command: [process.execPath, "host.mjs"], cwd: dir }, api: { command: [process.execPath, "api.mjs"], cwd: dir, readyPath: "/health" } }, contracts);
  assert.deepEqual(results.map((r) => [r.name, r.status]), [["echoes", "passed"], ["health", "passed"], ["chained", "passed"], ["raw", "passed"], ["text body", "passed"], ["wrong status", "failed"], ["wrong body", "failed"], ["wrong header", "failed"], ["not recorded", "unrecorded"]]);
  const hostOnly = await runTarget({ name: "no-api", host: { command: [process.execPath, "host.mjs"], cwd: dir } }, contracts);
  assert.equal(hostOnly.find((r) => r.name === "health").status, "skipped");
  const apiOnly = await runTarget({ name: "no-host", api: { command: [process.execPath, "api.mjs"], cwd: dir, readyPath: "/health", port: 4997 } }, contracts, { filter: "echoes" });
  assert.deepEqual(apiOnly.map((r) => r.status), ["skipped"]);
  await assert.rejects(runTarget({ name: "broken", host: { command: [process.execPath, "broken.mjs"], cwd: dir } }, contracts), /exited \(3\) before it was ready/);
  await assert.rejects(runTarget({ name: "broken-api", api: { command: [process.execPath, "broken.mjs"], cwd: dir } }, [contracts[1]]), /API exited/);
  await assert.rejects(runTarget({ name: "no-command", host: { command: [join(dir, "missing-binary")] } }, contracts), /ENOENT|exited/);

  // CLI over the same folder: --json, --target, --record and show for http contracts
  await writeFile(join(dir, "contracts.json"), JSON.stringify({ contracts: ["echo.contract.yaml"], reference: "cmd", targets: { cmd: { host: { command: [process.execPath, "host.mjs"] } }, other: { host: { command: [process.execPath, "host.mjs"] } } } }));
  const lines = [];
  assert.equal(await main(["test", "--config", join(dir, "contracts.json"), "--json", "--target", "cmd"], (l) => lines.push(l)), 0);
  assert.equal(JSON.parse(lines.join("\n")).summary[0].passed, 1);
  await writeFile(join(dir, "echo.contract.yaml"), `contract: 1\nmodule: echo\ncases:\n  - { name: to record, call: echo, args: [5] }\n`);
  lines.length = 0;
  assert.equal(await main(["test", "--config", join(dir, "contracts.json"), "--record"], (l) => lines.push(l)), 0);
  assert.match(lines.join("\n"), /recorded 1 expectation/);
  assert.match(await readFile(join(dir, "echo.contract.yaml"), "utf8"), /expect: \{ value: 5 \}/);
  await assert.rejects(main(["test", "--config", join(dir, "contracts.json"), "--record", "--target", "cmd,other"]), /exactly one/);
  await assert.rejects(main(["test", "--config", join(dir, "contracts.json"), "--target", "nope"]), /No such target/);
  await assert.rejects(main(["test", join(dir, "api.contract.yaml")]), /needs --config/);
  lines.length = 0;
  await main(["show", join(dir, "api.contract.yaml")], (l) => lines.push(l));
  assert.match(lines.join("\n"), /POST \/echo \{"id":7\} → 200/);
  assert.equal(await main([], () => {}), 1);
  assert.equal(await main(["help"], () => {}), 0);
});

test("host protocol errors", async (t) => {
  const host = await serveContracts({ subjects: { thing: () => ({ fail() { throw "plain string"; }, close() { throw new Error("ignored"); } }) } });
  t.after(() => host.close());
  const post = (path, body) => fetch(host.url + path, { method: "POST", headers: { "content-type": "application/json" }, body });
  assert.equal((await post("/instances", "{bad")).status, 400);
  assert.equal((await post("/instances", JSON.stringify({ subject: "nope" }))).status, 404);
  const { id } = await (await post("/instances", JSON.stringify({ subject: "thing" }))).json();
  assert.deepEqual(await (await post(`/instances/${id}/fail`, JSON.stringify({ args: [] }))).json(), { ok: false, error: { type: "string", message: "plain string" } });
  assert.equal((await post(`/instances/${id}/fail`, JSON.stringify({ args: "x" }))).status, 400);
  assert.equal((await post(`/instances/999/fail`, "{}")).status, 404);
  assert.equal((await fetch(host.url + "/unknown")).status, 404);
  assert.equal((await fetch(host.url.replace("/rt-contract/v1", "/other"))).status, 404);
  assert.deepEqual(await (await fetch(`${host.url}/instances/${id}`, { method: "DELETE" })).json(), { ok: true });
  assert.equal((await post("/instances", "x".repeat(5 * 1024 * 1024 + 1))).status, 413);
});

test("values and contracts: remaining branches", async (t) => {
  for (const [value, type] of [["s", "string"], [1.5, "number"], [true, "boolean"], [[1], "array"], [{}, "object"], [null, "null"]]) assert.equal(compare(value, { $type: type }), undefined, type);
  assert.match(compare(1, { $type: "weird" }), /unknown \$type/);
  assert.match(compare(1, { $regex: "x" }), /does not match/);
  assert.match(compare(1, { $approx: 2 }), /≈2/);
  assert.match(compare("abc", { $length: 2 }), /length 2/);
  assert.match(compare("c", { $oneOf: ["a"] }), /none of/);
  assert.match(compare(1, { $partial: { a: 1 } }), /expected an object/);
  assert.match(compare({}, { $partial: 1 }), /needs an object/);
  assert.match(compare({ a: 1 }, { $partial: { a: 2 } }), /expected 2/);
  assert.equal(compare({ $date: "x" }, { $date: "x" }), undefined);
  assert.match(compare(1, { a: 1 }), /expected an object/);
  assert.match(compare(1, [1]), /expected an array/);
  assert.match(compare({ a: [1, 2] }, { a: [1, 3] }), /\$\.a\[1\]/);
  assert.deepEqual(encode(new Map([["k", new Date(0)]])), { k: { $date: "1970-01-01T00:00:00.000Z" } });
  assert.throws(() => encode(Symbol("x")), /Cannot encode/);
  assert.throws(() => expand({ $text: { repeat: 1, count: 2 } }), /\$text/);
  assert.deepEqual(expand({ $repeat: { count: 2, item: ["{i}", { n: "{i}" }, true] } }), [[0, { n: 0 }, true], [1, { n: 1 }, true]]);
  assert.throws(() => lookupThrough(), /nothing/);
  const dir = await mkdtemp(join(tmpdir(), "contract-find-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, "a.contract.json"), JSON.stringify({ contract: 1, module: "a", cases: [{ name: "x", call: "f", args: [] }] }));
  await writeFile(join(dir, "bad.contract.yaml"), "contract: [\n");
  const { findContracts } = await import("../dist/index.js");
  assert.deepEqual(await findContracts([join(dir, "a.contract.json")]), [join(dir, "a.contract.json")]);
  assert.equal((await findContracts([dir])).length, 2);
  await assert.rejects(loadContract(join(dir, "bad.contract.yaml")), /bad.contract.yaml/);
  const json = await loadContract(join(dir, "a.contract.json"));
  assert.equal(await saveRecorded(json, new Map([["x\u00000", { value: 1 }]])), 1);
  assert.deepEqual(JSON.parse(await readFile(join(dir, "a.contract.json"), "utf8")).cases[0].expect, { value: 1 });
  assert.equal(await saveRecorded({ cases: [] }, new Map([["a", {}]])), 0);
  for (const bad of [null, { contract: 1, module: "Bad" }, { contract: 1, kind: "x", module: "m", cases: [{}] }, { contract: 1, module: "m", cases: [{ name: "" }] }, { contract: 1, module: "m", cases: [{ name: "t", tags: [1], call: "f" }] }, { contract: 1, module: "m", cases: [{ name: "s", steps: [{ call: "1bad" }] }] }, { contract: 1, module: "m", cases: [{ name: "n" }] }, { contract: 1, module: "m", cases: [{ name: "e", call: "f", expect: { error: "x" } }] }, { contract: 1, kind: "http", module: "m", cases: [{ name: "h" }] }]) assert.throws(() => normalize(bad));
  assert.equal(normalize({ contract: 1, module: "m", cases: [{ name: "c", create: { value: null } }] }).cases[0].steps.length, 0);
});
function lookupThrough() { return expand({ $ref: "0.a.b" }, [{ a: 1 }]); }

test("one contract, several subjects; optional subjects are skipped when a host lacks them", async (t) => {
  const contract = normalize({ contract: 1, module: "store", subjects: ["mem", "pg", "db"], optionalSubjects: ["pg"], cases: [{ name: "reads", call: "get", expect: { value: 1 } }, { name: "custom", subject: "mem", call: "get", expect: { value: 1 } }] });
  assert.deepEqual(contract.cases.map((c) => [c.name, c.subject]), [["reads [mem]", "mem"], ["reads [pg]", "pg"], ["reads [db]", "db"], ["custom", "mem"]]);
  assert.throws(() => normalize({ contract: 1, module: "m", subjects: [], cases: [{ name: "x", call: "f" }] }), /subjects must be/);
  assert.throws(() => normalize({ contract: 1, module: "m", optionalSubjects: "x", cases: [{ name: "x", call: "f" }] }), /optionalSubjects/);
  const host = await serveContracts({ subjects: { mem: () => ({ get: () => 1 }) } });
  t.after(() => host.close());
  const results = await runTarget({ name: "t", host: host.url }, [contract]);
  assert.deepEqual(results.map((r) => r.status), ["passed", "skipped", "missing", "passed"]);
});
