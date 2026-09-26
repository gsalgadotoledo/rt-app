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
