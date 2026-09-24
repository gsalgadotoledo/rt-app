import { randomUUID } from "node:crypto";
import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTVerifyGetKey,
  type JWTPayload,
} from "jose";
import {
  HttpError,
  type Actor,
  type Feature,
  type Request as AppRequest,
  type Endpoint,
} from "@gsalgadotoledo/rt-app-contracts";
import type { JwtTokens } from "@gsalgadotoledo/rt-app-jwt";

export interface Authenticator {
  authenticate(token: string): Promise<Actor>;
}

/** RT-App session verification preserves token-version revocation through an authoritative resolver. */
export class SessionAuthenticator implements Authenticator {
  constructor(
    private tokens: JwtTokens,
    private resolve: (id: string) => Promise<Actor | undefined>,
  ) {}
  async authenticate(token: string) {
    const claims = await this.tokens.verify(token),
      actor = await this.resolve(claims.id);
    if (
      !actor ||
      actor.id !== claims.id ||
      !actor.active ||
      actor.tokenVersion !== claims.version
    )
      throw new HttpError(401, "Invalid or revoked session");
    return actor;
  }
}

/** Asymmetric JWTs for distributed services; caller maps verified claims to current permissions. */
export class SignedJwtAuthenticator implements Authenticator {
  constructor(
    private key: JWTVerifyGetKey | CryptoKey,
    private issuer: string,
    private audience: string,
    private resolve: (claims: JWTPayload) => Promise<Actor | undefined>,
  ) {
    if (!issuer || !audience)
      throw new TypeError("JWT issuer and audience required");
  }
  async authenticate(token: string) {
    const { payload } = await jwtVerify(token, this.key as JWTVerifyGetKey, {
      issuer: this.issuer,
      audience: this.audience,
      algorithms: ["RS256", "ES256"],
      requiredClaims: ["exp", "iat", "sub"],
    }).catch(() => {
      throw new HttpError(401, "Invalid service JWT");
    });
    const actor = await this.resolve(payload);
    if (!actor || actor.id !== payload.sub || !actor.active)
      throw new HttpError(401, "Inactive service identity");
    return actor;
  }
}

/** JWKS address is trusted deployment configuration; never derive it from token jku/iss headers. */
export function remoteJwtAuthenticator(
  jwksUrl: string,
  issuer: string,
  audience: string,
  resolve: (claims: JWTPayload) => Promise<Actor | undefined>,
) {
  const url = new URL(jwksUrl);
  if (url.protocol !== "https:" || url.username || url.password)
    throw new TypeError("JWKS requires HTTPS");
  return new SignedJwtAuthenticator(
    createRemoteJWKSet(url),
    issuer,
    audience,
    resolve,
  );
}

function authorize(endpoint: Endpoint, actor?: Actor) {
  if (endpoint.access === "guest") return;
  if (!actor || !actor.active) throw new HttpError(401, "Sign in");
  if (endpoint.access === "owner" && actor.role !== "owner")
    throw new HttpError(403, "Owner permission required");
  if (
    endpoint.access === "permission" &&
    !(
      actor.grants.includes(endpoint.resource) ||
      (!endpoint.explicitGrant && actor.role === "owner")
    )
  )
    throw new HttpError(403, "Permission required");
}

export interface ServiceOptions {
  features: Feature[];
  authenticate: Authenticator;
  /** Required for metered endpoints; reserve/settle using the authoritative subscription service. */
  invokeMetered?: (
    endpoint: Endpoint,
    actor: Actor | undefined,
    work: () => Promise<unknown>,
  ) => Promise<unknown>;
  observe?: (metric: {
    requestId: string;
    route: string;
    status: number;
    durationMs: number;
  }) => Promise<void>;
}

/** Host selected existing Features without importing the full application or trusting forwarded identities. */
export function createMicroservice(options: ServiceOptions) {
  const routes = options.features
    .flatMap((f) => f.endpoints)
    .map((endpoint) => {
      const names: string[] = [];
      const pattern = endpoint.path
        .split("/")
        .map((segment) => {
          if (segment.startsWith(":")) {
            names.push(segment.slice(1));
            return "([^/]+)";
          }
          return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        })
        .join("/");
      return { endpoint, names, pattern: new RegExp("^" + pattern + "/?$") };
    });
  if (
    new Set(routes.map((r) => r.endpoint.method + " " + r.endpoint.path))
      .size !== routes.length
  )
    throw new TypeError("Duplicate service route");
  return {
    async handle(request: AppRequest) {
      const requestId = randomUUID(),
        start = performance.now();
      let route = "/unmatched",
        status = 500;
      try {
        const selected = routes.find(
          (r) =>
            r.endpoint.method === request.method &&
            r.pattern.test(request.path),
        );
        if (!selected) throw new HttpError(404, "Not found");
        route = selected.endpoint.path;
        const authorization = request.headers.authorization;
        let actor: Actor | undefined;
        if (authorization) {
          if (!/^Bearer [^\s]+$/i.test(authorization))
            throw new HttpError(401, "Invalid authorization");
          actor = await options.authenticate.authenticate(
            authorization.slice(7),
          );
        }
        authorize(selected.endpoint, actor);
        const match = selected.pattern.exec(request.path)!;
        let params: Record<string, string>;
        try {
          params = Object.fromEntries(
            selected.names.map((name, i) => [
              name,
              decodeURIComponent(match[i + 1]),
            ]),
          );
        } catch {
          throw new HttpError(400, "Invalid route encoding");
        }
        const work = () =>
          selected.endpoint.handle({
            request: {
              ...request,
              headers: { ...request.headers, "x-request-id": requestId },
            },
            actor,
            params,
          });
        let body: unknown;
        if (selected.endpoint.subscription) {
          if (!options.invokeMetered)
            throw new HttpError(503, "Metering adapter required");
          body = await options.invokeMetered(selected.endpoint, actor, work);
        } else body = await work();
        status = 200;
        return { status, body, headers: { "x-request-id": requestId } };
      } catch (error) {
        status = error instanceof HttpError ? error.status : 500;
        return {
          status,
          body: {
            error:
              error instanceof HttpError ? error.message : "Internal error",
          },
          headers: { "x-request-id": requestId },
        };
      } finally {
        try {
          await options.observe?.({
            requestId,
            route,
            status,
            durationMs: performance.now() - start,
          });
        } catch {
          /* Telemetry must not change a completed operation. */
        }
      }
    },
  };
}

/** Swap local handlers for remote HTTP calls while preserving route ACL and tool metadata. No mutation retries. */
export function remoteFeature(
  feature: Feature,
  baseUrl: string,
  transport: typeof fetch = fetch,
  timeoutMs = 10000,
): Feature {
  const base = new URL(baseUrl);
  if (
    base.protocol !== "https:" ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs < 1
  )
    throw new TypeError("Invalid remote service configuration");
  return {
    ...feature,
    migrations: [],
    endpoints: feature.endpoints.map((endpoint) => ({
      ...endpoint,
      async handle(context) {
        const path = endpoint.path.replace(/:([A-Za-z0-9_]+)/g, (_, name) =>
          encodeURIComponent(context.params[name]),
        );
        const url = new URL(base.toString());
        url.pathname = base.pathname.replace(/\/$/, "") + path;
        url.search = new URLSearchParams(context.request.query).toString();
        const headers: Record<string, string> = {
          "content-type": "application/json",
        };
        if (context.request.headers.authorization)
          headers.authorization = context.request.headers.authorization;
        const response = await transport(url, {
          method: endpoint.method,
          headers,
          redirect: "error",
          signal: AbortSignal.timeout(timeoutMs),
          ...(["GET", "HEAD"].includes(endpoint.method)
            ? {}
            : { body: JSON.stringify(context.request.body) }),
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw new HttpError(response.status, "Remote service request failed");
        }
        return response.status === 204 ? null : response.json();
      },
    })),
  };
}
