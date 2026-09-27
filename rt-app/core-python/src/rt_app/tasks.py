"""Personal tasks with soft delete and restore (port of ``@gsalgadotoledo/rt-app-tasks``).

Rows ``TASKS/<id>`` hold ``{id, title, done, ownerId}`` plus audit fields. Deleting marks
``deletedAt``/``deletedBy`` (the trash); restoring clears them and records ``restoredAt``/``restoredBy``.
Owners of a task, role ``owner`` and holders of the ``tasks.manage`` grant may change it.

    GET    /tasks                     authenticated  tasks.mine     the actor's tasks
    GET    /tasks/admin               permission     tasks.list     every task
    POST   /tasks                     authenticated  tasks.create   {title}
    PATCH  /tasks/:id                 authenticated  tasks.edit     {title?, done?}
    DELETE /tasks/:id                 authenticated  tasks.delete
    POST   /tasks/:id/restore         authenticated  tasks.restore
    PATCH  /tasks/admin/:id           permission     tasks.manage
    DELETE /tasks/admin/:id           permission     tasks.remove   (also needs tasks.manage)
    POST   /tasks/admin/:id/restore   permission     tasks.restore
"""
from __future__ import annotations

import uuid
from collections.abc import Callable, Mapping, Sequence
from datetime import datetime
from typing import Any, Final, TypedDict

from . import _js
from .contracts import (
    Clock,
    audit_create,
    audit_delete,
    audit_restore,
    audit_update,
    epoch_ms,
    search_page,
    text,
    to_datetime,
)
from .errors import HttpError
from .nosql import NoSQL, Row
from .web.app import Actor, Context, Endpoint, Feature

PARTITION: Final = "TASKS"
FILTERS: Final = ("id", "title", "done", "ownerId")
WELCOME_TITLE: Final = "Explore my first task in RT-App"

ADMIN: Final[Mapping[str, Any]] = {
    "id": "tasks",
    "title": "Tasks",
    "resource": "tasks.list",
    "path": "/tasks/admin",
    "component": "tasks",
    "fields": list(FILTERS),
    "actions": ["list", "create", "edit", "delete"],
}


class Migration(TypedDict):
    id: str
    checksum: str
    description: str


class Seed(TypedDict):
    id: str
    description: str
    environments: list[str]


#: The first migration of every document module: records schema version 1 once.
MIGRATIONS: Final[tuple[Migration, ...]] = (
    {"id": "tasks:001", "checksum": "tasks-document-v1", "description": "Register the tasks document schema"},
)

#: Example data: one welcome task per demo user (never in prod).
SEEDS: Final[tuple[Seed, ...]] = (
    {"id": "tasks:welcome", "description": "A welcome task for each demo user", "environments": ["local", "develop", "stage"]},
)


def migrate(store: NoSQL) -> None:
    """Run the module migrations: ``SCHEMA/tasks`` ``{schemaVersion: 1}`` unless it exists."""
    if store.get("SCHEMA", "tasks") is None:
        store.transact([{"row": {"pk": "SCHEMA", "sk": "tasks", "version": 1, "data": {"schemaVersion": 1}}, "expected": None}])


def welcome_rows(users: Sequence[Row], at: datetime | None = None) -> list[dict[str, Any]]:
    """Rows of the ``tasks:welcome`` seed for the given demo user rows (insert only when missing)."""
    created = _js.iso_timestamp(at or _js.utc_now())
    rows = []
    for user in users:
        id = f"welcome-{user['data']['id']}"
        data = {"id": id, "title": WELCOME_TITLE, "done": False, "ownerId": user["data"]["id"], "createdAt": created}
        rows.append({"pk": PARTITION, "sk": id, "data": data})
    return rows


def _truthy(value: object) -> bool:
    """JavaScript truthiness of a JSON value (empty lists and objects are true)."""
    if isinstance(value, (list, dict)):
        return True
    return bool(value) and value == value  # NaN is falsy


def _manager(actor: Actor) -> bool:
    return actor.get("role") == "owner" or "tasks.manage" in (actor.get("grants") or [])


class Tasks:
    """Task storage and endpoints. ``now`` is the clock of audit timestamps (system clock by default)."""

    def __init__(self, store: NoSQL, *, now: Clock | None = None, new_id: Callable[[], str] | None = None) -> None:
        self.store = store
        self._clock = now
        self._new_id = new_id or (lambda: str(uuid.uuid4()))

    def _now(self) -> datetime:
        return to_datetime(epoch_ms(self._clock))

    def list(self, query: Mapping[str, str], actor: Actor, *, everyone: bool = False) -> dict[str, Any]:
        """One search page of live (or, with ``trash=true``, deleted) tasks: the actor's, or every task."""
        return search_page(
            self.store,
            PARTITION,
            query,
            FILTERS,
            lambda row: row["data"] if everyone or row["data"].get("ownerId") == actor["id"] else None,
        )

    def create(self, body: Mapping[str, Any], actor: Actor) -> dict[str, Any]:
        """A new open task owned by the actor; only ``title`` is read from the body."""
        id = self._new_id()
        data = {
            "id": id,
            "title": text(body.get("title"), "title"),
            "done": False,
            "ownerId": actor["id"],
            **audit_create(actor["id"], self._now()),
        }
        self.store.transact([{"row": {"pk": PARTITION, "sk": id, "version": 1, "data": data}, "expected": None}])
        return data

    def update(self, id: str, body: Mapping[str, Any], actor: Actor) -> dict[str, Any]:
        """Edit ``title`` and/or ``done`` of a live task."""
        return self._edit(id, actor, "update", body)

    def remove(self, id: str, actor: Actor) -> dict[str, bool]:
        """Move a live task to the trash."""
        self._edit(id, actor, "remove")
        return {"ok": True}

    def restore(self, id: str, actor: Actor) -> dict[str, Any]:
        """Bring a deleted task back."""
        return self._edit(id, actor, "restore")

    def admin_remove(self, id: str, actor: Actor) -> dict[str, bool]:
        """Remove any task: needs role ``owner`` or the ``tasks.manage`` grant, checked first."""
        if not _manager(actor):
            raise HttpError(403, "Requires tasks.manage")
        return self.remove(id, actor)

    def _edit(self, id: str, actor: Actor, action: str, body: Mapping[str, Any] | None = None) -> dict[str, Any]:
        row = self.store.get(PARTITION, id)
        restoring = action == "restore"
        if row is None or _truthy(row["data"].get("deletedAt")) != restoring:
            raise HttpError(404, "Task not found")
        if row["data"].get("ownerId") != actor["id"] and not _manager(actor):
            raise HttpError(403, "This task belongs to another user")
        at = self._now()
        audit = audit_restore(actor["id"], at) if restoring else audit_delete(actor["id"], at) if action == "remove" else audit_update(actor["id"], at)
        data = {**row["data"], **audit}
        if body is not None:
            if "title" in body:
                data["title"] = text(body["title"], "title")
            if "done" in body:
                if not isinstance(body["done"], bool):
                    raise HttpError(400, "done must be a boolean")
                data["done"] = body["done"]
        self.store.transact([{"row": {**row, "version": row["version"] + 1, "data": data}, "expected": row["version"]}])
        return data

    def migrate(self) -> None:
        migrate(self.store)

    def feature(self) -> Feature:
        def actor(c: Context) -> Actor:
            return c.actor  # type: ignore[return-value]  # the framework resolved it (not a guest endpoint)

        def params(c: Context) -> str:
            return c.params["id"]

        return Feature(
            id="tasks",
            admin=ADMIN,
            endpoints=[
                Endpoint("POST", "/tasks/:id/restore", "tasks.restore", "authenticated", lambda c: self.restore(params(c), actor(c))),
                Endpoint("POST", "/tasks/admin/:id/restore", "tasks.restore", "permission", lambda c: self.restore(params(c), actor(c))),
                Endpoint("GET", "/tasks", "tasks.mine", "authenticated", lambda c: self.list(c.request.query, actor(c))),
                Endpoint("GET", "/tasks/admin", "tasks.list", "permission", lambda c: self.list(c.request.query, actor(c), everyone=True)),
                Endpoint("POST", "/tasks", "tasks.create", "authenticated", lambda c: self.create(c.request.body, actor(c))),
                Endpoint("PATCH", "/tasks/:id", "tasks.edit", "authenticated", lambda c: self.update(params(c), c.request.body, actor(c))),
                Endpoint("DELETE", "/tasks/:id", "tasks.delete", "authenticated", lambda c: self.remove(params(c), actor(c))),
                Endpoint("PATCH", "/tasks/admin/:id", "tasks.manage", "permission", lambda c: self.update(params(c), c.request.body, actor(c))),
                Endpoint("DELETE", "/tasks/admin/:id", "tasks.remove", "permission", lambda c: self.admin_remove(params(c), actor(c))),
            ],
        )


__all__ = ["Tasks", "ADMIN", "FILTERS", "MIGRATIONS", "SEEDS", "PARTITION", "Migration", "Seed", "migrate", "welcome_rows"]
