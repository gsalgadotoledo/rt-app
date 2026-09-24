import { auditUpdate } from "@gsalgadotoledo/rt-app-contracts";
import type { NoSQL as Store } from "@gsalgadotoledo/rt-app-nosql";
import { migrations } from "./migrations.js";
import admin from "./admin.json" with { type: "json" };
import {
  type Actor,
  type Endpoint,
  type Feature,
  HttpError,
  viewUser,
  filtered,
} from "@gsalgadotoledo/rt-app-contracts";
export class ACL {
  constructor(
    private store: Store,
    private resources: () => Endpoint[],
  ) {}
  /** Owners have normal resource access; other actors need the named grant. */
  allows(actor: Actor | undefined, resource: string) {
    return (
      !!actor && (actor.role === "owner" || actor.grants.includes(resource))
    );
  }
  /** Enforce the endpoint access policy; explicitGrant also applies to owners. */
  check(endpoint: Endpoint, actor?: Actor) {
    if (endpoint.access === "guest") return;
    if (!actor) throw new HttpError(401, "Sign in");
    if (endpoint.access === "owner" && actor.role !== "owner")
      throw new HttpError(403, "Only the owner can perform this operation");
    if (
      endpoint.access === "permission" &&
      (endpoint.explicitGrant
        ? !actor.grants.includes(endpoint.resource)
        : !this.allows(actor, endpoint.resource))
    )
      throw new HttpError(
        403,
        "You do not have permission to access this resource",
      );
  }
  /** Publish resource discovery and owner-only delegation with token-version revocation. */
  feature(): Feature {
    return {
      id: "acl",
      migrations,
      admin: admin,
      endpoints: [
        {
          method: "GET",
          path: "/acl/resources",
          resource: "acl.resources",
          access: "permission",
          handle: async (c) =>
            filtered(
              this.resources().map(({ resource, method, path, access }) => ({
                resource,
                method,
                path,
                access,
              })),
              c.request.query,
              ["resource", "method", "path", "access"],
            ),
        },
        {
          method: "PUT",
          path: "/acl/users/:id",
          resource: "acl.assign",
          access: "permission",
          handle: async (c) => {
            // Delegating arbitrary permissions is reserved to the application owner.
            if (c.actor!.role !== "owner")
              throw new HttpError(403, "Only the owner can assign permissions");
            const row = await this.store.get("USERS", c.params.id);
            if (!row || row.data.deletedAt)
              throw new HttpError(404, "User not found");
            if (row.data.role === "owner")
              throw new HttpError(
                403,
                "The owner cannot be modified through this endpoint",
              );
            const { grants, role } = c.request.body;
            const valid = new Set(
              this.resources()
                .filter((r) => r.access === "permission")
                .map((r) => r.resource),
            );
            if (
              !Array.isArray(grants) ||
              grants.length > 100 ||
              grants.some((g) => typeof g !== "string" || !valid.has(g)) ||
              !["user", "admin"].includes(role)
            )
              throw new HttpError(400, "Invalid permissions or role");
            const next = {
              ...row,
              version: row.version + 1,
              data: {
                ...row.data,
                ...auditUpdate(c.actor!.id),
                role,
                grants: [...new Set(grants)],
                tokenVersion: row.data.tokenVersion + 1,
              },
            };
            await this.store.transact([{ row: next, expected: row.version }]);
            return viewUser(next.data);
          },
        },
      ],
    };
  }
}
