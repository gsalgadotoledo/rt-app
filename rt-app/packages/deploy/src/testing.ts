import type { DeployContext, DeployEnvironment, Role } from "./index.js";

export interface RecordedCall {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: any;
}

type Handler = (call: RecordedCall) => { status?: number; body?: unknown; headers?: Record<string, string> } | undefined;

/**
 * Fake `fetch` for provider tests: routes are "METHOD url-prefix" → handler (or static response).
 * Every call is recorded; an unmatched call fails the test instead of reaching the network.
 * @example const api = fakeFetch({"GET https://api.render.com/v1/owners": {body: [{owner:{id:"o1"}}]}})
 */
export function fakeFetch(routes: Record<string, Handler | { status?: number; body?: unknown }>) {
  const calls: RecordedCall[] = [];
  const fetch = (async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    const method = (init.method ?? "GET").toUpperCase();
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const call: RecordedCall = { method, url, headers, body: init.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    const key = Object.keys(routes)
      .filter((route) => {
        const [m, prefix] = route.split(" ");
        return m === method && url.startsWith(prefix);
      })
      .sort((a, b) => b.length - a.length)[0];
    if (!key) throw new Error(`Unexpected request: ${method} ${url}`);
    const route = routes[key];
    const response = typeof route === "function" ? route(call) ?? { status: 200, body: {} } : route;
    const status = response.status ?? 200;
    const text = response.body === undefined ? "" : typeof response.body === "string" ? response.body : JSON.stringify(response.body);
    return new Response(status === 204 ? null : text, { status, headers: (response as any).headers ?? {} });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

/** A complete deploy context with safe defaults; override what a test needs. */
export function testContext(overrides: Partial<DeployContext> & { role: Role }): DeployContext {
  return {
    app: "shop",
    environment: "stage" as DeployEnvironment,
    settings: {},
    credentials: {},
    source: { repository: "acme/shop", branch: "stage", directory: "apps/server", runtime: "node" },
    variables: {},
    fetch: (async () => {
      throw new Error("No fetch configured");
    }) as typeof fetch,
    log: () => {},
    ...overrides,
  };
}
