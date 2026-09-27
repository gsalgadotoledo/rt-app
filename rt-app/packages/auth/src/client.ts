// Browser session client: keeps the access token fresh with rotating refresh tokens.
// Framework-free (React, Next and the admin console wrap it); every browser API is optional and
// injectable so it also runs, and is tested, under Node.

/** A session as returned by sign-in and refresh endpoints (extra fields are kept). */
export interface ClientSession {
  token: string;
  expiresIn?: number;
  refreshToken?: string;
  refreshExpiresAt?: string;
  sessionId?: string;
  user?: any;
  /** Client-clock epoch ms after which the access token is treated as expired (computed). */
  accessExpiresAt?: number;
  [key: string]: unknown;
}

/** The subset of Web Storage used for persistence. */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

interface Channel {
  postMessage(message: unknown): void;
  close(): void;
  onmessage: ((event: { data: any }) => void) | null;
}

interface Locks {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>;
}

export interface SessionClientOptions {
  /** API base URL (or a function, when it changes at runtime). */
  baseUrl: string | (() => string);
  /** Refresh endpoint (default "/auth/refresh"; the admin root uses "/admin/identity/auth/refresh"). */
  refreshPath?: string;
  /** Where the session survives reloads; null keeps it in memory only (default). */
  storage?: KeyValueStorage | null;
  /** Storage key, BroadcastChannel name and Web Lock prefix (default "rt-app.session"). */
  storageKey?: string;
  /** Refresh this long before the access token expires (default 90 s). */
  refreshLeadMs?: number;
  /** Retry delay after a network or server error while refreshing (default 30 s). */
  retryMs?: number;
  fetch?: typeof fetch;
  now?: () => number;
  /** Cross-tab lock (default navigator.locks when available; null disables). */
  locks?: Locks | null;
  /** Cross-tab channel factory (default BroadcastChannel in browsers; null disables). */
  channel?: ((name: string) => Channel) | null;
  setTimeout?: (callback: () => void, ms: number) => unknown;
  clearTimeout?: (handle: any) => void;
}

export interface SessionClient {
  /** The current session, or undefined when signed out. */
  readonly session: ClientSession | undefined;
  /** Store a session after sign-in, or clear it (undefined) on sign-out. */
  set(session?: ClientSession | null): void;
  /** Listen to session changes (refresh, sign-out, other tabs); returns the unsubscribe function. */
  subscribe(listener: (session?: ClientSession) => void): () => void;
  /** Rotate now. One refresh at a time per tab (and per browser with Web Locks). */
  refresh(): Promise<ClientSession | undefined>;
  /** A usable access token, refreshing first when it is about to expire. */
  accessToken(): Promise<string | undefined>;
  /** fetch against the API with the bearer token; on a session 401 it refreshes once and retries. */
  fetch(path: string, init?: RequestInit): Promise<Response>;
  /** JSON helper: throws Error(message) with .status on non-2xx responses. */
  api(path: string, method?: string, body?: unknown): Promise<any>;
  /** Stop timers and cross-tab listeners. */
  dispose(): void;
}

/** 401 messages that mean "this access token is no longer valid" (anything else is passed through). */
export const SESSION_ERRORS = [
  "Invalid or expired session",
  "Invalid session",
  "Invalid token",
  "Invalid admin session",
];

const MAX_TIMER = 2 ** 31 - 1;

/**
 * Create a session client.
 * @example
 *   const sessions = createSessionClient({baseUrl: "https://api.example.test", storage: sessionStorage});
 *   sessions.set(await (await fetch(".../auth/login", ...)).json());
 *   await sessions.api("/users/me");   // refreshed in the background ~90 s before expiry
 */
export function createSessionClient(options: SessionClientOptions): SessionClient {
  const key = options.storageKey ?? "rt-app.session",
    lead = options.refreshLeadMs ?? 90_000,
    retry = options.retryMs ?? 30_000,
    now = options.now ?? (() => Date.now()),
    doFetch = options.fetch ?? ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args)),
    storage = options.storage ?? null,
    browser = globalThis as any,
    locks: Locks | null = options.locks === undefined ? browser.navigator?.locks ?? null : options.locks,
    startTimer = options.setTimeout ?? ((callback: () => void, ms: number) => setTimeout(callback, ms)),
    stopTimer = options.clearTimeout ?? ((handle: any) => clearTimeout(handle));
  const base = () => (typeof options.baseUrl === "function" ? options.baseUrl() : options.baseUrl);
  const listeners = new Set<(session?: ClientSession) => void>();
  let current: ClientSession | undefined, timer: unknown, inflight: Promise<ClientSession | undefined> | undefined;

  // --- persistence and cross-tab sync -------------------------------------------------------

  function load(): ClientSession | undefined {
    try {
      const value = JSON.parse(storage?.getItem(key) ?? "null");
      return value && typeof value.token === "string" ? value : undefined;
    } catch {
      return undefined;
    }
  }

  function save(session?: ClientSession) {
    try {
      if (session) storage?.setItem(key, JSON.stringify(session));
      else storage?.removeItem(key);
    } catch {
      // Storage can be full or blocked (private mode); memory still works.
    }
  }

  const channelFactory =
    options.channel === undefined
      ? // Browsers only: a server render (Next) must not open channels it never closes.
        typeof browser.BroadcastChannel === "function" && typeof browser.document !== "undefined"
        ? (name: string) => new browser.BroadcastChannel(name) as Channel
        : null
      : options.channel;
  const channel = channelFactory ? channelFactory(key) : null;
  if (channel)
    channel.onmessage = ({ data }) => {
      // Tabs sharing one session (duplicated tabs, localStorage) adopt each other's rotations.
      if (!current?.sessionId || data?.sessionId !== current.sessionId) return;
      if (data.type === "set" && data.session?.token) apply(data.session, false);
      if (data.type === "clear") apply(undefined, false);
    };
  const onStorage = (event: any) => {
    if (event?.key !== key || (event.storageArea && event.storageArea !== storage)) return;
    apply(load(), false);
  };
  if (storage && typeof browser.addEventListener === "function") browser.addEventListener("storage", onStorage);

  // --- state --------------------------------------------------------------------------------

  function normalize(session: ClientSession): ClientSession {
    if (typeof session.accessExpiresAt === "number") return session;
    const seconds = typeof session.expiresIn === "number" && session.expiresIn > 0 ? session.expiresIn : 900;
    return { ...session, accessExpiresAt: now() + seconds * 1000 };
  }

  function apply(session: ClientSession | undefined, broadcast: boolean) {
    const previous = current;
    current = session ? normalize(session) : undefined;
    save(current);
    schedule();
    if (broadcast && channel) {
      const sessionId = current?.sessionId ?? previous?.sessionId;
      if (sessionId)
        channel.postMessage(current ? { type: "set", sessionId, session: current } : { type: "clear", sessionId });
    }
    for (const listener of listeners) listener(current);
  }

  function schedule(delay?: number) {
    if (timer !== undefined) stopTimer(timer);
    timer = undefined;
    if (!current?.refreshToken) return;
    const wait = delay ?? Math.max(0, (current.accessExpiresAt ?? 0) - lead - now());
    timer = startTimer(() => {
      timer = undefined;
      void refresh().catch(() => schedule(retry));
    }, Math.min(wait, MAX_TIMER));
  }

  const fresh = (session?: ClientSession) => !!session && (session.accessExpiresAt ?? 0) - lead > now();

  // --- refresh ------------------------------------------------------------------------------

  async function rotate(started: ClientSession): Promise<ClientSession | undefined> {
    // Another tab may have rotated while we waited for the lock (broadcast or shared storage).
    const stored = load();
    if (stored?.sessionId === started.sessionId && stored?.refreshToken !== started.refreshToken && fresh(stored))
      apply(stored, false);
    if (current !== started && current?.sessionId === started.sessionId && fresh(current)) return current;
    if (current?.sessionId !== started.sessionId || !current?.refreshToken) return current;
    const response = await doFetch(base() + (options.refreshPath ?? "/auth/refresh"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken: current.refreshToken }),
    });
    if (response.ok) {
      apply(await response.json(), true);
      return current;
    }
    // Only a rejection of the token ends the session; 429 and 5xx are retried later. A banned
    // account (403 "Account suspended") is a rejection too: retrying would never succeed.
    if (response.status === 401 || response.status === 400 || (response.status === 403 && (await suspended(response)))) {
      apply(undefined, true);
      return undefined;
    }
    throw Object.assign(new Error("Session refresh failed"), { status: response.status });
  }

  function refresh() {
    if (!inflight) {
      const started = current;
      inflight = (async () => {
        if (!started?.refreshToken) return started;
        return locks ? locks.request(`${key}:refresh`, () => rotate(started)) : rotate(started);
      })().finally(() => {
        inflight = undefined;
      });
    }
    return inflight;
  }

  async function accessToken() {
    if (current?.refreshToken && !fresh(current)) {
      try {
        await refresh();
      } catch {
        // Keep the current token; the API decides whether it still works.
      }
    }
    return current?.token;
  }

  /** Whether a 403 answer is the banned-account refusal (ACCOUNT_SUSPENDED of rt-app-users). */
  async function suspended(response: Response) {
    try {
      return (await response.clone().json())?.error === "Account suspended";
    } catch {
      return false;
    }
  }

  // --- requests -----------------------------------------------------------------------------

  async function sessionError(response: Response) {
    if (response.status !== 401) return false;
    try {
      return SESSION_ERRORS.includes((await response.clone().json())?.error);
    } catch {
      return false;
    }
  }

  async function send(path: string, init: RequestInit, token?: string) {
    const headers = new Headers(init.headers);
    if (token) headers.set("authorization", "Bearer " + token);
    return doFetch(/^https?:\/\//.test(path) ? path : base() + path, { ...init, headers });
  }

  async function request(path: string, init: RequestInit = {}) {
    const token = await accessToken();
    const response = await send(path, init, token);
    if (!token || !(await sessionError(response))) return response;
    // The token was rejected: refresh once (unless another call already did) and retry once.
    if (current?.token === token) {
      if (!current.refreshToken) {
        apply(undefined, true);
        return response;
      }
      try {
        await refresh();
      } catch {
        return response;
      }
    }
    if (!current?.token || current.token === token) return response;
    return send(path, init, current.token);
  }

  async function api(path: string, method = "GET", body?: unknown) {
    const response = await request(path, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const value = await response.json().catch(() => ({}));
    if (!response.ok)
      throw Object.assign(new Error(value?.error ?? "Request failed"), { status: response.status });
    return value;
  }

  current = load();
  schedule();
  return {
    get session() {
      return current;
    },
    set: (session) => apply(session ?? undefined, true),
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    refresh,
    accessToken,
    fetch: request,
    api,
    dispose() {
      if (timer !== undefined) stopTimer(timer);
      timer = undefined;
      channel?.close();
      if (storage && typeof browser.removeEventListener === "function") browser.removeEventListener("storage", onStorage);
      listeners.clear();
    },
  };
}
