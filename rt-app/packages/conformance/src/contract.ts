import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { isMap, isSeq, parseDocument, type Document } from "yaml";
import type { Json } from "./values.js";

/**
 * A contract describes one module's expected behavior independently of any language.
 *
 * ```yaml
 * contract: 1
 * module: feature-flags
 * subject: feature-flags          # name the language hosts register
 * init: { rows: [] }              # default initialization values of each case
 * cases:
 *   - name: unknown flags are disabled
 *     tags: [edge]
 *     steps:
 *       - call: enabled           # method, canonical camelCase
 *         args: [checkout, alice]
 *         expect: { value: false }
 *   - name: invalid key            # shorthand for a single step
 *     call: get
 *     args: [Bad Key]
 *     expect: { error: { status: 400, message: Invalid flag key } }
 * ```
 *
 * `kind: http` contracts test a running API instead: each case has `request` and `expect`
 * (`status`, `body`, `headers`).
 */
export interface Expectation {
  value?: Json;
  error?: { type?: string; status?: number; message?: Json; code?: string };
}
export interface Step {
  call: string;
  args: Json[];
  expect?: Expectation;
  /** Human note shown on failure. */
  note?: string;
}
export interface HttpRequest { method: string; path: string; headers?: Record<string, string>; query?: Record<string, string>; body?: Json }
export interface HttpExpectation { status?: number; body?: Json; headers?: Record<string, Json> }
export interface Case {
  name: string;
  tags: string[];
  subject: string;
  init: Json;
  /** Expected result of creating the instance; defaults to success. */
  create?: Expectation;
  steps: Step[];
  requests: { request: HttpRequest; expect?: HttpExpectation }[];
  /** Position in the source document, used to write recorded expectations back. */
  index: number;
}
export interface Contract {
  file?: string;
  kind: "module" | "http";
  module: string;
  title?: string;
  description?: string;
  subject: string;
  cases: Case[];
  document?: Document;
}

const isObject = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);

function fail(where: string, message: string): never {
  throw new Error(`${where}: ${message}`);
}

function expectation(value: unknown, where: string): Expectation | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value) || Object.keys(value).some((k) => !["value", "error"].includes(k)) || ("value" in value && "error" in value))
    fail(where, "expect needs exactly one of value or error");
  if ("error" in value && !isObject(value.error)) fail(where, "expect.error must be an object (type, status, message, code)");
  return value as Expectation;
}

/** Validate and normalize a parsed contract (shorthands expanded, defaults applied). */
export function normalize(raw: unknown, file = "contract"): Contract {
  if (!isObject(raw)) fail(file, "a contract must be an object");
  if (raw.contract !== 1) fail(file, "missing `contract: 1`");
  const kind = raw.kind ?? "module";
  if (kind !== "module" && kind !== "http") fail(file, "kind must be module or http");
  if (typeof raw.module !== "string" || !/^[a-z][a-z0-9-]*$/.test(raw.module)) fail(file, "module must be a lowercase id");
  if (!Array.isArray(raw.cases) || !raw.cases.length) fail(file, "cases must be a non-empty list");
  const subject = raw.subject ?? raw.module;
  const names = new Set<string>();
  const cases = raw.cases.map((c: unknown, index: number): Case => {
    const where = `${file} case #${index + 1}`;
    if (!isObject(c) || typeof c.name !== "string" || !c.name.trim()) fail(where, "each case needs a name");
    if (names.has(c.name)) fail(where, `duplicate case name "${c.name}"`);
    names.add(c.name);
    const tags = c.tags ?? [];
    if (!Array.isArray(tags) || tags.some((t: unknown) => typeof t !== "string")) fail(where, "tags must be strings");
    if (kind === "http") {
      const list = c.requests ?? (c.request ? [{ request: c.request, expect: c.expect }] : undefined);
      if (!Array.isArray(list) || !list.length) fail(where, "http cases need request (or requests)");
      for (const r of list) if (!isObject(r.request) || typeof r.request.method !== "string" || typeof r.request.path !== "string" || !r.request.path.startsWith("/")) fail(where, "request needs method and a path starting with /");
      return { name: c.name, tags, subject, init: null, steps: [], requests: list, index };
    }
    const steps = c.steps ?? (c.call ? [{ call: c.call, args: c.args, expect: c.expect, note: c.note }] : c.create ? [] : undefined);
    if (!Array.isArray(steps)) fail(where, "module cases need steps (or call/args/expect)");
    return {
      name: c.name,
      tags,
      subject: c.subject ?? subject,
      init: (c.init ?? raw.init ?? {}) as Json,
      create: expectation(c.create, where + " create"),
      steps: steps.map((s: unknown, i: number) => {
        if (!isObject(s) || typeof s.call !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(s.call)) fail(`${where} step ${i + 1}`, "call must be a method name");
        const args = s.args ?? [];
        if (!Array.isArray(args)) fail(`${where} step ${i + 1}`, "args must be a list (positional arguments)");
        return { call: s.call, args, expect: expectation(s.expect, `${where} step ${i + 1}`), note: s.note };
      }),
      requests: [],
      index,
    };
  });
  return { file, kind, module: raw.module, title: raw.title, description: raw.description, subject, cases };
}

/** Load one contract from YAML (.yaml/.yml) or JSON. */
export async function loadContract(file: string): Promise<Contract> {
  const document = parseDocument(await readFile(file, "utf8"), { prettyErrors: true });
  if (document.errors.length) throw new Error(`${file}: ${document.errors[0].message}`);
  const contract = normalize(document.toJS(), file);
  contract.document = document;
  return contract;
}

/** Contracts from files and folders (`*.contract.yaml|yml|json`, recursively). */
export async function findContracts(paths: string[]): Promise<string[]> {
  const found: string[] = [];
  for (const path of paths) {
    if ((await stat(path)).isDirectory()) {
      for (const entry of (await readdir(path, { withFileTypes: true, recursive: true })).sort((a, b) => join(a.parentPath, a.name).localeCompare(join(b.parentPath, b.name)))) {
        if (entry.isFile() && /\.contract\.(ya?ml|json)$/.test(entry.name)) found.push(join(entry.parentPath, entry.name));
      }
    } else found.push(path);
  }
  return found;
}

/**
 * Write expectations observed on a reference implementation into steps that have none.
 * Comments and formatting of the YAML file are preserved.
 */
export async function saveRecorded(contract: Contract, recorded: Map<string, Expectation>) {
  if (!contract.file || !contract.document || !recorded.size) return 0;
  const cases = contract.document.get("cases");
  if (!isSeq(cases)) return 0;
  let written = 0;
  for (const c of contract.cases) {
    const node = cases.items[c.index];
    if (!isMap(node)) continue;
    const steps = node.get("steps");
    c.steps.forEach((step, i) => {
      const value = recorded.get(`${c.name}\u0000${i}`);
      if (!value || step.expect) return;
      if (isSeq(steps)) {
        const stepNode = steps.items[i];
        if (isMap(stepNode)) { stepNode.set("expect", contract.document!.createNode(value, { flow: true })); written++; }
      } else if (i === 0) { node.set("expect", contract.document!.createNode(value, { flow: true })); written++; }
    });
  }
  if (written) await writeFile(contract.file, extname(contract.file) === ".json" ? JSON.stringify(contract.document.toJS(), null, 2) + "\n" : contract.document.toString({ lineWidth: 0, flowCollectionPadding: true }));
  return written;
}
