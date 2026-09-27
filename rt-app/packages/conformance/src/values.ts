/**
 * Values on the wire are JSON. Types JSON cannot carry travel as tagged objects:
 *   {"$bytes": "<base64>"}  {"$date": "<ISO 8601>"}  {"$bigint": "<digits>"}
 * `undefined`, `None` and `nil` are all `null`; in objects a null field equals a missing one.
 */

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** Native JavaScript value → wire JSON (Date, Uint8Array/Buffer, bigint are tagged). */
export function encode(value: unknown): Json {
  if (value === undefined || value === null) return null;
  if (typeof value === "bigint") return { $bigint: value.toString() };
  if (value instanceof Date) return { $date: value.toISOString() };
  if (value instanceof Uint8Array) return { $bytes: Buffer.from(value).toString("base64") };
  if (value instanceof Map) return Object.fromEntries([...value].map(([k, v]) => [String(k), encode(v)]));
  if (value instanceof Set) return [...value].map(encode);
  if (Array.isArray(value)) return value.map(encode);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Non-finite numbers cannot be encoded");
    return value;
  }
  if (typeof value === "object") {
    const out: Record<string, Json> = {};
    for (const [k, v] of Object.entries(value)) if (v !== undefined && typeof v !== "function") out[k] = encode(v);
    return out;
  }
  if (typeof value === "string" || typeof value === "boolean") return value;
  throw new Error(`Cannot encode ${typeof value}`);
}

/** Wire JSON → native JavaScript value. */
export function decode(value: Json): unknown {
  if (Array.isArray(value)) return value.map(decode);
  if (value && typeof value === "object") {
    const keys = Object.keys(value);
    if (keys.length === 1) {
      if (typeof value.$bigint === "string") return BigInt(value.$bigint);
      if (typeof value.$date === "string") return new Date(value.$date);
      if (typeof value.$bytes === "string") return new Uint8Array(Buffer.from(value.$bytes, "base64"));
    }
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, decode(v)]));
  }
  return value;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const TYPES: Record<string, (v: Json) => boolean> = {
  string: (v) => typeof v === "string",
  number: (v) => typeof v === "number",
  integer: (v) => Number.isInteger(v),
  boolean: (v) => typeof v === "boolean",
  array: (v) => Array.isArray(v),
  object: (v) => !!v && typeof v === "object" && !Array.isArray(v),
  null: (v) => v === null,
  "iso-date": (v) => typeof v === "string" && ISO_DATE.test(v) && !Number.isNaN(Date.parse(v)),
};
export const MATCHER_TYPES = Object.keys(TYPES);

const isObject = (v: unknown): v is Record<string, Json> => !!v && typeof v === "object" && !Array.isArray(v);
const show = (v: unknown) => { const s = JSON.stringify(v); return s === undefined ? "undefined" : s.length > 120 ? s.slice(0, 117) + "..." : s; };

/**
 * Compare an actual wire value with an expectation. Returns the first difference or undefined.
 * Matchers inside expectations:
 *   {"$any": true}                  any value, including null
 *   {"$type": "iso-date"}           one of MATCHER_TYPES
 *   {"$regex": "^prod_"}            string matching the pattern
 *   {"$approx": 0.3, "$tolerance": 1e-9}
 *   {"$partial": {...}}             object that may contain more fields
 *   {"$length": 3}                  array or string length
 *   {"$oneOf": [a, b]}              equals one of the options
 */
export function compare(actual: Json | undefined, expected: Json | undefined, path = "$"): string | undefined {
  if (expected === undefined) expected = null;
  if (actual === undefined) actual = null;
  if (isObject(expected)) {
    const keys = Object.keys(expected);
    const matcher = keys.find((k) => k.startsWith("$"));
    if (matcher) {
      if (matcher === "$any") return undefined;
      if (matcher === "$type") {
        const check = TYPES[String(expected.$type)];
        if (!check) return `${path}: unknown $type ${show(expected.$type)}`;
        return check(actual) ? undefined : `${path}: expected ${expected.$type}, got ${show(actual)}`;
      }
      if (matcher === "$regex") return typeof actual === "string" && new RegExp(String(expected.$regex)).test(actual) ? undefined : `${path}: ${show(actual)} does not match /${expected.$regex}/`;
      if (matcher === "$approx") {
        const tolerance = typeof expected.$tolerance === "number" ? expected.$tolerance : 1e-9;
        return typeof actual === "number" && Math.abs(actual - Number(expected.$approx)) <= tolerance ? undefined : `${path}: expected ≈${expected.$approx}, got ${show(actual)}`;
      }
      if (matcher === "$length") return (typeof actual === "string" || Array.isArray(actual)) && actual.length === expected.$length ? undefined : `${path}: expected length ${expected.$length}, got ${show(actual)}`;
      if (matcher === "$oneOf") return Array.isArray(expected.$oneOf) && expected.$oneOf.some((option) => compare(actual, option, path) === undefined) ? undefined : `${path}: ${show(actual)} is none of ${show(expected.$oneOf)}`;
      if (matcher === "$partial") {
        if (!isObject(actual)) return `${path}: expected an object, got ${show(actual)}`;
        const partial = expected.$partial;
        if (!isObject(partial)) return `${path}: $partial needs an object`;
        for (const key of Object.keys(partial)) { const diff = compare(actual[key], partial[key], `${path}.${key}`); if (diff) return diff; }
        return undefined;
      }
      if (["$bytes", "$date", "$bigint"].includes(matcher)) return JSON.stringify(actual) === JSON.stringify(expected) ? undefined : `${path}: expected ${show(expected)}, got ${show(actual)}`;
      return `${path}: unknown matcher ${matcher}`;
    }
    if (!isObject(actual)) return `${path}: expected an object, got ${show(actual)}`;
    for (const key of new Set([...keys, ...Object.keys(actual)])) {
      const diff = compare(actual[key], expected[key], `${path}.${key}`);
      if (diff) return key in expected || actual[key] === null ? diff : `${path}: unexpected field ${key} = ${show(actual[key])}`;
    }
    return undefined;
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return `${path}: expected an array, got ${show(actual)}`;
    if (actual.length !== expected.length) return `${path}: expected ${expected.length} items, got ${actual.length} ${show(actual)}`;
    for (let i = 0; i < expected.length; i++) { const diff = compare(actual[i], expected[i], `${path}[${i}]`); if (diff) return diff; }
    return undefined;
  }
  return actual === expected ? undefined : `${path}: expected ${show(expected)}, got ${show(actual)}`;
}

/** Read `0.value.items[1].sk` from previous step results. */
export function lookup(results: Json[], reference: string): Json {
  const parts = reference.replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean);
  let current: Json | undefined = results as Json;
  for (const part of parts) {
    if (current === null || typeof current !== "object") throw new Error(`Reference ${reference}: nothing at ${part}`);
    current = (current as Record<string, Json>)[part];
    if (current === undefined) throw new Error(`Reference ${reference}: nothing at ${part}`);
  }
  return current;
}

/**
 * Expand runner-side macros so hosts only see plain values:
 *   {"$ref": "0.value.cursor"}   result of an earlier step of the same case
 *   {"$repeat": {"count": 60, "item": {...}}}  array of items; "{i}" and "{i:03}" in strings become the index
 *   {"$text": {"repeat": "ab", "count": 3}}    "ababab" (long strings for length limits)
 *   {"$concat": ["Bearer ", {"$ref": "0.value.token"}]}  strings (after expansion) joined
 */
export function expand(value: Json, results: Json[] = []): Json {
  if (Array.isArray(value)) return value.flatMap((item) => (isObject(item) && "$repeat" in item && Object.keys(item).length === 1 ? (expand(item, results) as Json[]) : [expand(item, results)]));
  if (isObject(value)) {
    if (typeof value.$ref === "string" && Object.keys(value).length === 1) return lookup(results, value.$ref);
    if (Array.isArray(value.$concat) && Object.keys(value).length === 1) {
      const parts = value.$concat.map((part) => expand(part, results));
      if (parts.some((part) => typeof part !== "string")) throw new Error("$concat needs strings");
      return parts.join("");
    }
    if (isObject(value.$text) && Object.keys(value).length === 1) {
      const { repeat, count } = value.$text;
      if (typeof repeat !== "string" || !Number.isInteger(count) || (count as number) < 0 || (count as number) * repeat.length > 1_000_000) throw new Error("$text needs repeat (string) and count");
      return repeat.repeat(count as number);
    }
    if (isObject(value.$repeat) && Object.keys(value).length === 1) {
      const { count, item, start = 0 } = value.$repeat;
      if (!Number.isInteger(count) || (count as number) < 0 || (count as number) > 10000) throw new Error("$repeat.count must be an integer 0-10000");
      return Array.from({ length: count as number }, (_, i) => substitute(item, (start as number) + i)).map((v) => expand(v, results));
    }
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expand(v, results)]));
  }
  return value;
}

function substitute(value: Json, index: number): Json {
  if (typeof value === "string") {
    const exact = value.match(/^\{i\}$/);
    if (exact) return index;
    return value.replace(/\{i(?::0(\d+))?\}/g, (_, width) => (width ? String(index).padStart(Number(width), "0") : String(index)));
  }
  if (Array.isArray(value)) return value.map((v) => substitute(v, index));
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v, index)]));
  return value;
}
