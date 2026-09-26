"""Access control: roles, grants and the endpoint access policy (port of ``@gsalgadotoledo/rt-app-acl``).

Owners are allowed every resource; other actors need the exact grant. ``check`` enforces an
endpoint's ``access`` and fails closed for unknown access values. The feature publishes resource
discovery and owner-only delegation (which bumps ``tokenVersion`` to revoke sessions).
"""
from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from typing import Any

from .contracts import Clock, audit_update, epoch_ms, filtered, to_datetime, view_user
from .errors import HttpError
from .nosql import NoSQL
from .web.app import Endpoint, Feature

#: An endpoint as a web ``Endpoint`` or a mapping with the TypeScript field names.
EndpointLike = Endpoint | Mapping[str, Any]
ACCESS_LEVELS = ("guest", "authenticated", "permission", "owner")
FORBIDDEN = "You do not have permission to access this resource"

ADMIN = {
    "id": "permissions",
    "title": "Permissions",
    "resource": "acl.resources",
    "path": "/acl/resources",
    "component": "permissions",
    "fields": ["resource", "method", "path", "access"],
    "actions": ["list"],
    "group": "authentication",
}


def endpoint_field(endpoint: EndpointLike, name: str) -> Any:
    """Read ``method``/``path``/``resource``/``access``/``explicitGrant`` from either shape."""
    if isinstance(endpoint, Mapping):
        return endpoint.get(name)
    return getattr(endpoint, "explicit_grant" if name == "explicitGrant" else name, None)


def _grants(actor: Mapping[str, Any]) -> list[Any]:
    grants = actor.get("grants")
    return grants if isinstance(grants, list) else []


class ACL:
    """Endpoint access policy. ``resources`` returns the registered endpoints (for discovery)."""

    def __init__(
        self,
        store: NoSQL,
        resources: Callable[[], Sequence[EndpointLike]] = lambda: (),
        *,
        now: Clock | None = None,
    ) -> None:
        self.store = store
        self.resources = resources
        self._now = now

    def allows(self, actor: Mapping[str, Any] | None, resource: str) -> bool:
        """Owners have normal resource access; other actors need the named grant (exact match)."""
        return bool(actor) and (actor.get("role") == "owner" or resource in _grants(actor))  # type: ignore[union-attr]

    def check(self, endpoint: EndpointLike, actor: Mapping[str, Any] | None = None) -> None:
        """Enforce the endpoint access policy; ``explicitGrant`` also applies to owners."""
        access = endpoint_field(endpoint, "access")
        if access == "guest":
            return
        # Fail closed: a typo in an endpoint's access must not open it to every signed-in user.
        if access not in ACCESS_LEVELS:
            raise HttpError(403, FORBIDDEN)
        if not actor:
            raise HttpError(401, "Sign in")
        if access == "owner" and actor.get("role") != "owner":
            raise HttpError(403, "Only the owner can perform this operation")
        resource = endpoint_field(endpoint, "resource")
        if access == "permission" and (
            resource not in _grants(actor) if endpoint_field(endpoint, "explicitGrant") else not self.allows(actor, resource)
        ):
            raise HttpError(403, FORBIDDEN)

    def list_resources(self, query: Mapping[str, str]) -> list[Mapping[str, Any]]:
        """``GET /acl/resources``: ``{resource, method, path, access}`` of every endpoint, filtered."""
        fields = ["resource", "method", "path", "access"]
        items = [{field: endpoint_field(e, field) for field in fields} for e in self.resources()]
        return filtered(items, query, fields)

    def assign(self, id: str, body: Mapping[str, Any], actor: Mapping[str, Any] | None) -> dict[str, Any]:
        """``PUT /acl/users/:id``: the owner sets role and grants; revokes the user's sessions."""
        # Delegating arbitrary permissions is reserved to the application owner.
        if not actor or actor.get("role") != "owner":
            raise HttpError(403, "Only the owner can assign permissions")
        row = self.store.get("USERS", id)
        if not row or row["data"].get("deletedAt"):
            raise HttpError(404, "User not found")
        if row["data"].get("role") == "owner":
            raise HttpError(403, "The owner cannot be modified through this endpoint")
        body = body if isinstance(body, Mapping) else {}
        grants, role = body.get("grants"), body.get("role")
        valid = {endpoint_field(e, "resource") for e in self.resources() if endpoint_field(e, "access") == "permission"}
        if (
            not isinstance(grants, list)
            or len(grants) > 100
            or any(not isinstance(g, str) or g not in valid for g in grants)
            or role not in ("user", "admin")
        ):
            raise HttpError(400, "Invalid permissions or role")
        data = {
            **row["data"],
            **audit_update(actor.get("id"), to_datetime(epoch_ms(self._now))),
            "role": role,
            "grants": list(dict.fromkeys(grants)),
            "tokenVersion": row["data"]["tokenVersion"] + 1,
        }
        self.store.transact([{"row": {**row, "version": row["version"] + 1, "data": data}, "expected": row["version"]}])
        return view_user(data)

    def feature(self) -> Feature:
        """Resource discovery and owner-only delegation, both behind permissions."""
        return Feature(
            id="acl",
            admin=ADMIN,
            endpoints=[
                Endpoint("GET", "/acl/resources", "acl.resources", "permission", lambda c: self.list_resources(c.request.query)),
                Endpoint(
                    "PUT", "/acl/users/:id", "acl.assign", "permission",
                    lambda c: self.assign(c.params["id"], c.request.body, c.actor),  # type: ignore[arg-type]
                ),
            ],
        )


__all__ = ["ACL", "ACCESS_LEVELS", "EndpointLike", "endpoint_field"]
