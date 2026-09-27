// Subject: userBans (UserBans of @gsalgadotoledo/rt-app-users-bans) wired like the framework:
// Users + JwtTokens + a capturing mailbox + Auth + UserBans(sessions: auth.refreshSessions) over one
// MemoryStore and one settable clock, so contracts can ban and then try every sign-in path.
// See docs/polyglot/users-bans.md and spec/contracts/users-bans.contract.yaml.
//
// init: {secret, now, rows}
import { JwtTokens } from "@gsalgadotoledo/rt-app-jwt";
import { Users, activeBan, parseInstant } from "@gsalgadotoledo/rt-app-users";
import { Auth, LocalMailbox } from "@gsalgadotoledo/rt-app-auth";
import { UserBans } from "@gsalgadotoledo/rt-app-users-bans";
import { memoryStore } from "./storage.mjs";

const opt = (value) => (value === null ? undefined : value);

async function userBans(init) {
  let now = Date.parse(init.now ?? "2026-01-02T03:04:05.000Z");
  if (Number.isNaN(now)) throw new Error("init.now must be an ISO 8601 date");
  const clock = () => now;
  const store = await memoryStore(init.rows ?? []);
  const users = new Users(store, undefined, { now: clock });
  const mailbox = new LocalMailbox();
  const auth = new Auth(users, new JwtTokens(init.secret, undefined, undefined, { now: clock }), mailbox, init.secret, undefined, { now: clock });
  const bans = new UserBans(users, { now: clock, sessions: auth.refreshSessions });
  const endpoint = (feature, method, path) => feature.endpoints.find((e) => e.method === method && e.path === path);
  const usersFeature = users.feature();
  return {
    ban: (userId, input, actor) => bans.ban(userId, input ?? {}, actor),
    unban: (userId, input, actor) => bans.unban(userId, input ?? {}, actor),
    history: (userId) => bans.history(userId),
    // GET /users/:id and GET /users (the admin views with the ban status).
    view: (userId) => endpoint(usersFeature, "GET", "/users/:id").handle({ request: { query: {}, body: {} }, params: { id: userId }, actor: undefined }),
    list: (query) => endpoint(usersFeature, "GET", "/users").handle({ request: { query: query ?? {}, body: {} }, params: {}, actor: undefined }),
    activeBan: (data) => activeBan(opt(data), now),
    parseInstant: (value) => parseInstant(value) ?? null,
    // The sign-in paths the ban gate covers.
    login: (email, password, ip) => auth.login(email, password, ip),
    issue: (email, purpose, ip) => auth.issue(email, purpose, ip),
    consume: (email, code, purpose, ip, password) => auth.consume(email, code, purpose, ip, opt(password)),
    refresh: (refreshToken, ip) => auth.refresh(refreshToken, ip),
    actor: (header) => auth.actor(opt(header)),
    sessions: (userId) => auth.sessions(userId),
    // Helpers.
    mailbox: () => mailbox.messages.map(({ email, code, purpose }) => ({ email, code, purpose })),
    row: (pk, sk) => store.get(pk, sk),
    endpoints: () => bans.feature().endpoints.map((e) => ({ method: e.method, path: e.path, access: e.access, resource: e.resource, tool: e.tool?.name ?? null })),
    setNow: (iso) => {
      const value = Date.parse(iso);
      if (typeof iso !== "string" || Number.isNaN(value)) throw new Error("setNow needs an ISO 8601 date");
      now = value;
      return null;
    },
  };
}

export const subjects = { userBans };
