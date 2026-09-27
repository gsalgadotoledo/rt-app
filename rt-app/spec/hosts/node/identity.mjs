// Subjects: jwt, users, acl, auth (identity modules). Each subject is a small facade so every
// language exposes the same surface; helpers are documented in the contracts and docs/polyglot.md.
import { JwtTokens } from "@gsalgadotoledo/rt-app-jwt";
import { Users, validatePassword, hashPassword, verifyPassword } from "@gsalgadotoledo/rt-app-users";
import { ACL } from "@gsalgadotoledo/rt-app-acl";
import { Auth, LocalMailbox } from "@gsalgadotoledo/rt-app-auth";
import { AuthVault, totpCode } from "@gsalgadotoledo/rt-app-auth/totp";
import { memoryStore } from "./storage.mjs";

/** A settable clock starting at init.now (ISO 8601); the system clock when absent. */
function clock(now) {
  let fixed = now == null ? undefined : Date.parse(now);
  if (Number.isNaN(fixed)) throw new Error("init.now must be an ISO 8601 date");
  return {
    now: () => fixed ?? Date.now(),
    set(iso) {
      const value = Date.parse(iso);
      if (typeof iso !== "string" || Number.isNaN(value)) throw new Error("setNow needs an ISO 8601 date");
      fixed = value;
      return null;
    },
  };
}

const opt = (value) => (value === null ? undefined : value);

export const subjects = {
  jwt: (init) => {
    const time = clock(init.now);
    const tokens = new JwtTokens(init.secret, opt(init.issuer), opt(init.audience), { now: time.now });
    return {
      issue: (user) => tokens.issue(user),
      verify: (token) => tokens.verify(token),
      setNow: (iso) => time.set(iso),
    };
  },

  users: async (init) => {
    const time = clock(init.now);
    const store = await memoryStore(init.rows);
    const users = new Users(store, undefined, { now: time.now });
    return {
      get: (id) => users.get(id),
      byEmail: (email) => users.byEmail(email),
      create: (input, role, actor) => users.create(input, opt(role), opt(actor) ?? null),
      bootstrapOwner: (input) => users.bootstrapOwner(input),
      profile: (id, input, actor) => users.profile(id, input, opt(actor)),
      validatePassword: (password) => { validatePassword(password); return null; },
      hashPassword: (password) => hashPassword(password),
      verifyPassword: (password, stored) => verifyPassword(password, stored),
      row: (pk, sk) => store.get(pk, sk),
    };
  },

  acl: async (init) => {
    const time = clock(init.now);
    const store = await memoryStore(init.rows);
    const acl = new ACL(store, () => init.resources ?? [], { now: time.now });
    const [list, assign] = acl.feature().endpoints;
    return {
      allows: (actor, resource) => acl.allows(opt(actor), resource),
      check: (endpoint, actor) => { acl.check(endpoint, opt(actor)); return null; },
      resources: (query) => list.handle({ request: { query: query ?? {} }, params: {}, actor: undefined }),
      assign: (id, body, actor) => assign.handle({ request: { body: body ?? {} }, params: { id }, actor }),
      row: (pk, sk) => store.get(pk, sk),
    };
  },

  auth: async (init) => {
    const time = clock(init.now);
    const store = await memoryStore(init.rows);
    const users = new Users(store, undefined, { now: time.now });
    const mailbox = new LocalMailbox();
    const options = { now: time.now, sessionTtlMs: opt(init.sessionTtlMs) };
    const auth = new Auth(users, new JwtTokens(init.secret, undefined, undefined, { now: time.now }), mailbox, init.secret, undefined, options);
    const vault = new AuthVault(init.secret);
    return {
      login: (email, password, ip, userAgent) => auth.login(email, password, ip, opt(userAgent)),
      issue: (email, purpose, ip) => auth.issue(email, purpose, ip),
      consume: (email, code, purpose, ip, password, challengeId, userAgent) => auth.consume(email, code, purpose, ip, opt(password), opt(challengeId), opt(userAgent)),
      actor: (header) => auth.actor(opt(header)),
      limit: (key, max) => auth.limit(key, max).then(() => null),
      settings: () => auth.settings(),
      updateSettings: (input) => auth.updateSettings(input),
      hasMfa: (id) => auth.hasMfa(id),
      setupMfa: (id, password, ip) => auth.setupMfa(id, password, ip),
      enableMfa: (id, challengeId, code, ip) => auth.enableMfa(id, challengeId, code, ip),
      verifyMfa: (challengeId, code, ip, userAgent) => auth.verifyMfa(challengeId, code, ip, opt(userAgent)),
      resetMfa: (id) => auth.resetMfa(id),
      requestEmailChange: (id, email, ip) => auth.requestEmailChange(id, email, ip),
      confirmEmailChange: (id, code, ip, userAgent) => auth.confirmEmailChange(id, code, ip, opt(userAgent)),
      // Refresh sessions (POST /auth/refresh, GET/DELETE /auth/sessions, POST /auth/logout).
      refresh: (refreshToken, ip) => auth.refresh(refreshToken, ip),
      sessions: (userId, currentSessionId) => auth.sessions(userId, opt(currentSessionId)),
      revokeSession: (userId, sessionId) => auth.revokeSession(userId, sessionId),
      logout: (userId, sessionId, all) => auth.logout(userId, opt(sessionId), opt(all)),
      // Helpers (not Auth methods): captured mail, stored rows, clock, TOTP and vault.
      mailbox: () => mailbox.messages.map(({ email, code, purpose }) => ({ email, code, purpose })),
      row: (pk, sk) => store.get(pk, sk),
      setNow: (iso) => time.set(iso),
      totpCode: (secret, step) => totpCode(secret, step),
      unseal: (sealed) => vault.open(sealed),
    };
  },
};
