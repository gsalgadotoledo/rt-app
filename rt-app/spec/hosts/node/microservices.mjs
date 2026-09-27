// Subjects: microservice, session-authenticator, signed-jwt-authenticator, remote-feature.
// Facades over @gsalgadotoledo/rt-app-microservices. Features, authenticators, metering and remote
// responses are declared as data in init, so every language builds the same service (microservices
// contract). Other languages expose the same method names with the same positional arguments.
import { createLocalJWKSet } from "jose";
import { HttpError } from "@gsalgadotoledo/rt-app-contracts";
import { JwtTokens } from "@gsalgadotoledo/rt-app-jwt";
import {
  createMicroservice,
  SessionAuthenticator,
  SignedJwtAuthenticator,
  remoteJwtAuthenticator,
  remoteFeature,
} from "@gsalgadotoledo/rt-app-microservices";

/** {status?, message}: an HttpError when status is given, a plain Error otherwise. */
const failure = (error) => (typeof error.status === "number" ? new HttpError(error.status, error.message) : new Error(error.message));

/**
 * Endpoint handler from its `reply`: {value} is returned, {error} is thrown; without reply the
 * handler echoes {params, actor, headers} (headers as the handler received them).
 */
function handler(reply) {
  return async (context) => {
    if (reply?.error) throw failure(reply.error);
    if (reply && "value" in reply) return reply.value;
    return { params: context.params, actor: context.actor ?? null, headers: context.request.headers };
  };
}

/** Endpoint metadata as declared, plus its handler. */
const endpoint = ({ reply, ...declared }) => ({ ...declared, handle: handler(reply) });
const feature = (f) => ({ migrations: [], ...f, endpoints: (f.endpoints ?? []).map(endpoint) });
const request = (r) => ({ method: "GET", path: "/", headers: {}, query: {}, body: {}, ip: "127.0.0.1", ...r });

function microservice(init) {
  const authentications = [];
  const observations = [];
  const metered = [];
  const tokens = init.tokens ?? {};
  const authenticate = {
    async authenticate(token) {
      authentications.push(token);
      const entry = tokens[token];
      if (entry === undefined) throw new HttpError(401, "Unknown token");
      if (entry?.error) throw failure(entry.error);
      return entry;
    },
  };
  const metering = init.metering;
  const service = createMicroservice({
    features: (init.features ?? []).map(feature),
    authenticate,
    ...(metering == null ? {} : {
      async invokeMetered(e, actor, work) {
        metered.push({ resource: e.resource, subscription: e.subscription, actor: actor?.id ?? null });
        if (metering.error) throw failure(metering.error);
        return work();
      },
    }),
    ...(init.observe === "none" ? {} : {
      async observe(metric) {
        observations.push(metric);
        if (init.observe === "fail") throw new Error("telemetry down");
      },
    }),
  });
  return {
    // handle(request) → {status, body, headers}
    handle: (r) => service.handle(request(r)),
    authentications: () => authentications,
    observations: () => observations,
    metered: () => metered,
  };
}

/** SessionAuthenticator over JwtTokens(secret, issuer?, audience?, {now}) and a table of actors. */
function session(init) {
  let now = Date.parse(init.now);
  const tokens = new JwtTokens(init.secret, init.issuer ?? undefined, init.audience ?? undefined, { now: () => now });
  const resolved = [];
  const actors = init.actors ?? {};
  const auth = new SessionAuthenticator(tokens, async (id) => {
    resolved.push(id);
    return actors[id];
  });
  return {
    authenticate: (token) => auth.authenticate(token),
    issue: (user) => tokens.issue(user),
    resolved: () => resolved,
    setNow: (iso) => {
      now = Date.parse(iso);
      return null;
    },
  };
}

/** SignedJwtAuthenticator over a local JWK Set; actors are looked up by String(sub). */
function signed(init) {
  const resolved = [];
  const actors = init.actors ?? {};
  const resolve = async (claims) => {
    resolved.push(claims);
    return actors[String(claims.sub)];
  };
  const auth = new SignedJwtAuthenticator(createLocalJWKSet(init.jwks), init.issuer ?? "", init.audience ?? "", resolve);
  return {
    authenticate: (token) => auth.authenticate(token),
    resolved: () => resolved,
    // remote(jwksUrl, issuer, audience) → null: remoteJwtAuthenticator configuration checks only.
    remote: (url, issuer, audience) => (remoteJwtAuthenticator(url, issuer ?? "", audience ?? "", resolve), null),
  };
}

/**
 * remoteFeature(feature, baseUrl, transport, timeoutMs?) with a recording transport that answers
 * init.responses in order: {status, json} | {status, text} | {status} | {network: message}.
 */
function remote(init) {
  const requests = [];
  const responses = [...(init.responses ?? [])];
  const transport = async (url, options) => {
    requests.push({
      url: url.toString(),
      method: options.method,
      headers: options.headers,
      body: options.body ?? null,
      redirect: options.redirect,
      timeout: options.signal instanceof AbortSignal,
    });
    const next = responses.shift();
    if (!next) throw new Error("No response left");
    if (next.network) throw new Error(next.network);
    if ("json" in next) return Response.json(next.json, { status: next.status });
    return new Response(next.text ?? null, { status: next.status });
  };
  const proxied = remoteFeature(feature(init.feature), init.baseUrl, transport, init.timeoutMs ?? undefined);
  return {
    // call(index, context) → endpoints[index].handle(context); context {params, request}.
    call: (index, context) => proxied.endpoints[index].handle({ params: {}, ...context, request: request(context?.request) }),
    requests: () => requests,
    // feature() → the proxied feature without handlers.
    feature: () => ({ ...proxied, endpoints: proxied.endpoints.map(({ handle, ...rest }) => rest) }),
  };
}

export const subjects = {
  microservice,
  "session-authenticator": session,
  "signed-jwt-authenticator": signed,
  "remote-feature": remote,
};
