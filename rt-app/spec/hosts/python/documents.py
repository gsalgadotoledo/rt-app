"""Subjects: content, tasks (document modules).

Facades over the modules' endpoint handlers with the surface of hosts/node/documents.mjs; see
docs/polyglot/content.md and docs/polyglot/tasks.md. Wire null stands for an omitted body or query.
"""
from __future__ import annotations

from typing import Any

from identity import _Clock, _init
from storage import memory_store, rows_of

from rt_app import content as content_module
from rt_app import tasks as tasks_module
from rt_app.content import Content
from rt_app.contracts import to_datetime
from rt_app.tasks import Tasks
from rt_app.web import Context, Feature, Request


def _routes(feature: Feature) -> list[dict[str, str]]:
    return [{"method": e.method, "path": e.path, "resource": e.resource, "access": e.access} for e in feature.endpoints]


class _Facade:
    """Calls endpoint handlers the way the framework does (body and query default to {})."""

    feature: Feature

    def _call(self, method: str, path: str, *, params: Any = None, body: Any = None, query: Any = None, actor: Any = None) -> Any:
        endpoint = next(e for e in self.feature.endpoints if e.method == method and e.path == path)
        request = Request(method=method, path=path, body=body or {}, query=query or {})
        return endpoint.handle(Context(request=request, params=params or {}, actor=actor))


class ContentFacade(_Facade):
    def __init__(self, init: Any) -> None:
        self._store = memory_store(rows_of(init))
        self.feature = Content(self._store).feature()

    def home(self) -> Any:
        return self._call("GET", "/")

    def settings(self) -> Any:
        return self._call("GET", "/content/settings")

    def save(self, body: Any = None) -> Any:
        return self._call("PUT", "/content/settings", body=body)

    def endpoints(self) -> list[dict[str, str]]:
        return _routes(self.feature)

    def admin(self) -> Any:
        return self.feature.admin

    def migrations(self) -> Any:
        return list(content_module.MIGRATIONS)

    def migrate(self) -> None:
        content_module.migrate(self._store)

    def row(self, pk: Any, sk: Any) -> Any:
        return self._store.get(pk, sk)


class TasksFacade(_Facade):
    def __init__(self, init: Any) -> None:
        init = _init(init)
        self._clock = _Clock(init.get("now"))
        self._store = memory_store(rows_of(init))
        self.feature = Tasks(self._store, now=self._clock.now).feature()

    def list(self, query: Any, actor: Any) -> Any:
        return self._call("GET", "/tasks", query=query, actor=actor)

    def list_all(self, query: Any, actor: Any) -> Any:
        return self._call("GET", "/tasks/admin", query=query, actor=actor)

    def create(self, body: Any, actor: Any) -> Any:
        return self._call("POST", "/tasks", body=body, actor=actor)

    def update(self, id: Any, body: Any, actor: Any) -> Any:
        return self._call("PATCH", "/tasks/:id", params={"id": id}, body=body, actor=actor)

    def remove(self, id: Any, actor: Any) -> Any:
        return self._call("DELETE", "/tasks/:id", params={"id": id}, actor=actor)

    def restore(self, id: Any, actor: Any) -> Any:
        return self._call("POST", "/tasks/:id/restore", params={"id": id}, actor=actor)

    def manage(self, id: Any, body: Any, actor: Any) -> Any:
        return self._call("PATCH", "/tasks/admin/:id", params={"id": id}, body=body, actor=actor)

    def admin_remove(self, id: Any, actor: Any) -> Any:
        return self._call("DELETE", "/tasks/admin/:id", params={"id": id}, actor=actor)

    def admin_restore(self, id: Any, actor: Any) -> Any:
        return self._call("POST", "/tasks/admin/:id/restore", params={"id": id}, actor=actor)

    def endpoints(self) -> list[dict[str, str]]:
        return _routes(self.feature)

    def admin(self) -> Any:
        return self.feature.admin

    def migrations(self) -> Any:
        return list(tasks_module.MIGRATIONS)

    def migrate(self) -> None:
        tasks_module.migrate(self._store)

    def seeds(self) -> Any:
        return list(tasks_module.SEEDS)

    def seed_rows(self, users: Any = None) -> Any:
        return tasks_module.welcome_rows(users or [], to_datetime(self._clock.now()))

    def row(self, pk: Any, sk: Any) -> Any:
        return self._store.get(pk, sk)

    def set_now(self, iso: Any) -> None:
        return self._clock.set(iso)


SUBJECTS = {
    "content": ContentFacade,
    "tasks": TasksFacade,
}
