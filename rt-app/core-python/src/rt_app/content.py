"""Editable home content (port of ``@gsalgadotoledo/rt-app-content``).

One row ``CONTENT/home`` holds ``{title, content}``. Reads fall back to ``DEFAULT_HOME`` with version
0 until the first save; saves need the current version (optimistic concurrency), which is checked
before the values. Text limits count UTF-16 code units before JavaScript ``trim()``.

    GET /                   guest       content.home   → {title, content}
    GET /content/settings   permission  content.read   → {version, values, fields}
    PUT /content/settings   permission  content.write  {version, values} → settings
"""
from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Final, TypedDict

from . import _js
from .contracts import text
from .errors import Conflict, HttpError
from .nosql import NoSQL
from .web.app import Context, Endpoint, Feature

PARTITION: Final = "CONTENT"
KEY: Final = "home"
TITLE_MAX: Final = 120
CONTENT_MAX: Final = 2000

DEFAULT_HOME: Final[Mapping[str, str]] = {
    "title": "Welcome to RT-App",
    "content": "A small starting point for building great applications.",
}

FIELDS: Final = (
    {"name": "title", "label": "Title", "type": "text", "maxLength": TITLE_MAX},
    {"name": "content", "label": "Description", "type": "textarea", "maxLength": CONTENT_MAX},
)

ADMIN: Final[Mapping[str, Any]] = {
    "id": "content",
    "group": "content",
    "title": "Home",
    "resource": "content.read",
    "path": "/content/settings",
    "component": "content",
    "fields": [],
    "actions": [],
    "settings": {"path": "/content/settings", "resource": "content.write"},
}


class Migration(TypedDict):
    id: str
    checksum: str
    description: str


#: The first migration of every document module: records schema version 1 once.
MIGRATIONS: Final[tuple[Migration, ...]] = (
    {"id": "content:001", "checksum": "content-document-v1", "description": "Register the content document schema"},
)


class Settings(TypedDict):
    version: int
    values: dict[str, Any]
    fields: list[dict[str, Any]]


def _is_integer(value: object) -> bool:
    """``Number.isInteger``: finite and without a fraction; booleans are not numbers."""
    if not _js.is_finite_number(value):
        return False
    return isinstance(value, int) or float(value).is_integer()  # type: ignore[arg-type]


def migrate(store: NoSQL) -> None:
    """Run the module migrations: ``SCHEMA/content`` ``{schemaVersion: 1}`` unless it exists."""
    if store.get("SCHEMA", "content") is None:
        store.transact([{"row": {"pk": "SCHEMA", "sk": "content", "version": 1, "data": {"schemaVersion": 1}}, "expected": None}])


class Content:
    """The home page content of an application."""

    def __init__(self, store: NoSQL) -> None:
        self.store = store

    def settings(self) -> Settings:
        """The stored version (0 before the first save), the stored data as is (or the defaults) and the form fields."""
        row = self.store.get(PARTITION, KEY)
        return {
            "version": row["version"] if row else 0,
            "values": row["data"] if row else dict(DEFAULT_HOME),
            "fields": [dict(field) for field in FIELDS],
        }

    def home(self) -> dict[str, Any]:
        """``{title, content}`` of the settings."""
        values = self.settings()["values"]
        return {"title": values.get("title"), "content": values.get("content")}

    def save(self, body: Mapping[str, Any]) -> Settings:
        """Replace the values when ``body["version"]`` is the stored version; returns the new settings.

        Errors, in order: 400 "Version is required", 409 on a stale version, 400 "Invalid field: title"
        (at most 120 UTF-16 units), 400 "Invalid field: content" (at most 2000).
        """
        row = self.store.get(PARTITION, KEY)
        version = body.get("version")
        if not _is_integer(version):
            raise HttpError(400, "Version is required")
        current = row["version"] if row else 0
        if version != current:
            raise Conflict()
        raw = body.get("values")
        values = raw if isinstance(raw, Mapping) else {}
        data = {
            "title": text(values.get("title"), "title", TITLE_MAX),
            "content": text(values.get("content"), "content", CONTENT_MAX),
        }
        self.store.transact(
            [{"row": {"pk": PARTITION, "sk": KEY, "version": int(version) + 1, "data": data}, "expected": row["version"] if row else None}]  # type: ignore[arg-type]
        )
        return self.settings()

    def migrate(self) -> None:
        migrate(self.store)

    def feature(self) -> Feature:
        return Feature(
            id="content",
            admin=ADMIN,
            endpoints=[
                Endpoint("GET", "/", "content.home", "guest", lambda c: self.home()),
                Endpoint("GET", "/content/settings", "content.read", "permission", lambda c: self.settings()),
                Endpoint("PUT", "/content/settings", "content.write", "permission", self._save),
            ],
        )

    def _save(self, c: Context) -> Settings:
        return self.save(c.request.body)


__all__ = ["Content", "ADMIN", "DEFAULT_HOME", "FIELDS", "MIGRATIONS", "Migration", "PARTITION", "KEY", "migrate"]
