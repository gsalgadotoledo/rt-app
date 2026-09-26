import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { decode, encode, type Json } from "./values.js";

/**
 * Host protocol v1: every language exposes its module implementations over loopback HTTP so one
 * runner can test them all. Hosts create real instances and call real methods — internal
 * methods included — with decoded arguments.
 *
 *   GET    /rt-contract/v1                           → {protocol, language, subjects}
 *   POST   /rt-contract/v1/instances                 {subject, init} → {ok, id} | {ok:false, error}
 *   POST   /rt-contract/v1/instances/<id>/<method>   {args:[…]}      → {ok, value} | {ok:false, error}
 *   DELETE /rt-contract/v1/instances/<id>                             → {ok}
 *
 * Errors thrown by the module are results, not protocol failures: {type, status?, code?, message}.
 * Unknown subjects, instances or methods answer HTTP 404 with {protocolError}.
 * A host prints `RT_CONTRACT_READY <url>` on stdout once it listens.
 */
export const PROTOCOL = 1;
export const READY = "RT_CONTRACT_READY";
export const BASE = "/rt-contract/v1";

/** Build one instance from the case's init values (dependencies such as stores are created here). */
export type SubjectFactory = (init: any) => unknown | Promise<unknown>;

export interface HostOptions {
  subjects: Record<string, SubjectFactory>;
  language?: string;
  port?: number;
  /** Method name used by contracts (camelCase) → method on the instance; defaults to the same name. */
  methodName?: (name: string) => string;
}

export interface WireError { type: string; status?: number; code?: string; message: string }

/** Error thrown by a module → wire error. */
export function describeError(error: unknown): WireError {
  if (error instanceof Error) {
    const e = error as Error & { status?: unknown; code?: unknown };
    return {
      type: e.constructor?.name && e.constructor.name !== "Object" ? e.constructor.name : e.name,
      ...(typeof e.status === "number" ? { status: e.status } : {}),
      ...(typeof e.code === "string" ? { code: e.code } : {}),
      message: e.message,
    };
  }
  return { type: typeof error, message: String(error) };
}

class ProtocolError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

async function body(request: IncomingMessage): Promise<any> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 5 * 1024 * 1024) throw new ProtocolError(413, "Body too large");
    chunks.push(chunk);
  }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new ProtocolError(400, "Invalid JSON"); }
}

function send(response: ServerResponse, status: number, value: unknown) {
  const text = JSON.stringify(value);
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  response.end(text);
}

/** A callable method: own or inherited function, not the constructor, not `_private`. */
function method(instance: unknown, name: string): ((...args: unknown[]) => unknown) | undefined {
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name) || name === "constructor") return undefined;
  const fn = (instance as Record<string, unknown>)?.[name];
  return typeof fn === "function" ? (fn as (...args: unknown[]) => unknown).bind(instance) : undefined;
}

/**
 * Serve module implementations for contract tests on 127.0.0.1.
 * @example
 * const host = await serveContracts({ subjects: { "feature-flags": init => new FeatureFlags(MemoryStore.from(init.rows)) } });
 * console.log(host.url); await host.close();
 */
export async function serveContracts(options: HostOptions): Promise<{ url: string; close(): Promise<void> }> {
  const instances = new Map<string, unknown>();
  let next = 0;
  const methodName = options.methodName ?? ((name: string) => name);
  const server = createServer(async (request, response) => {
    try {
      // Only local tools talk to a host: refuse browser requests (they carry Origin).
      if (request.headers.origin) throw new ProtocolError(403, "Browsers may not call a contract host");
      const url = new URL(request.url ?? "/", "http://host");
      const parts = url.pathname.startsWith(BASE) ? url.pathname.slice(BASE.length).split("/").filter(Boolean).map(decodeURIComponent) : undefined;
      if (!parts) throw new ProtocolError(404, "Not a contract host path");
      if (request.method === "GET" && parts.length === 0)
        return send(response, 200, { protocol: PROTOCOL, language: options.language ?? "javascript", runtime: `node ${process.version}`, subjects: Object.keys(options.subjects).sort() });
      if (request.method === "POST" && parts.length === 1 && parts[0] === "instances") {
        const { subject, init = {} } = await body(request);
        const factory = options.subjects[subject];
        if (typeof factory !== "function") throw new ProtocolError(404, `Unknown subject: ${subject}`);
        if (instances.size >= 1000) throw new ProtocolError(429, "Too many live instances; delete them after each case");
        try {
          const instance = await factory(decode(init));
          const id = String(++next);
          instances.set(id, instance);
          return send(response, 200, { ok: true, id });
        } catch (error) {
          return send(response, 200, { ok: false, error: describeError(error) });
        }
      }
      if (parts[0] === "instances" && parts.length === 2 && request.method === "DELETE") {
        const instance = instances.get(parts[1]);
        instances.delete(parts[1]);
        const close = method(instance, "dispose") ?? method(instance, "close");
        try { await close?.(); } catch { /* closing errors are not part of a case */ }
        return send(response, 200, { ok: true });
      }
      if (parts[0] === "instances" && parts.length === 3 && request.method === "POST") {
        if (!instances.has(parts[1])) throw new ProtocolError(404, `Unknown instance: ${parts[1]}`);
        const fn = method(instances.get(parts[1]), methodName(parts[2]));
        if (!fn) throw new ProtocolError(404, `Unknown method: ${parts[2]}`);
        const { args = [] } = await body(request);
        if (!Array.isArray(args)) throw new ProtocolError(400, "args must be a list");
        try {
          const value = await fn(...args.map((a: Json) => decode(a)));
          return send(response, 200, { ok: true, value: encode(value) });
        } catch (error) {
          return send(response, 200, { ok: false, error: describeError(error) });
        }
      }
      throw new ProtocolError(404, "Unknown contract host route");
    } catch (error) {
      const status = error instanceof ProtocolError ? error.status : 500;
      send(response, status, { protocolError: error instanceof Error ? error.message : String(error) });
    }
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(options.port ?? 0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Host did not bind");
  return {
    url: `http://127.0.0.1:${address.port}${BASE}`,
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}

/** Serve and announce readiness on stdout, for `rta-contract` targets. Stops on SIGTERM/SIGINT. */
export async function runHost(options: HostOptions) {
  const host = await serveContracts(options);
  process.stdout.write(`${READY} ${host.url}\n`);
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => void host.close().then(() => process.exit(0)));
  return host;
}
