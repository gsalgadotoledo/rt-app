"""Boolean feature flags with deterministic percentage rollouts and explicit subjects.

Stored in a NoSQL store under partition ``FLAGS``. Keys: ``^[a-z][a-z0-9._-]{0,79}$``. Unknown or
disabled flags are off. Rollout bucket: first 4 bytes (big-endian) of
``sha256(key + "\\0" + subject)`` / 2**32 * 100; the flag is on when ``bucket < rollout``.
String limits count UTF-16 code units, like the TypeScript reference.
"""
from __future__ import annotations

import hashlib
import re
from collections.abc import Callable, Mapping
from datetime import datetime
from typing import Any, Final, TypedDict

from . import _js
from .errors import HttpError
from .nosql import NoSQL
from .web.app import Context, Endpoint, Feature

PARTITION: Final = "FLAGS"
_KEY = re.compile(r"[a-z][a-z0-9._-]{0,79}")


class _Missing:
    def __repr__(self) -> str:
        return "MISSING"


#: A value that was not given at all (JavaScript ``undefined``), unlike ``None`` (``null``).
MISSING: Final = _Missing()


class FlagDefinition(TypedDict):
    description: str
    enabled: bool
    public: bool
    rollout: float
    subjects: list[str]


class Flag(FlagDefinition):
    key: str
    version: int
    updatedAt: str
    updatedBy: str


class FlagPage(TypedDict, total=False):
    items: list[Flag]
    cursor: str


def _valid_key(key: object) -> str:
    if not isinstance(key, str) or not _KEY.fullmatch(key):
        raise HttpError(400, "Invalid flag key")
    return key


def _valid_definition(definition: object, version: object) -> bool:
    if not isinstance(definition, Mapping):
        return False
    description = definition.get("description")
    rollout = definition.get("rollout")
    subjects = definition.get("subjects")
    return (
        isinstance(description, str)
        and _js.utf16_length(description) <= 400
        and isinstance(definition.get("enabled"), bool)
        and isinstance(definition.get("public"), bool)
        and _js.is_finite_number(rollout)
        and 0 <= rollout <= 100  # type: ignore[operator]
        and isinstance(subjects, list)
        and len(subjects) <= 100
        and all(isinstance(s, str) and _js.utf16_length(s) <= 120 for s in subjects)
        and (version is None or (_js.is_safe_integer(version) and version > 0))  # type: ignore[operator]
    )


def rollout_bucket(key: str, subject: str) -> float:
    """Deterministic bucket in [0, 100) for a key and subject (same value in every language)."""
    # Node hashes strings as UTF-8 with lone surrogates replaced by U+FFFD; do the same.
    text = (key + "\0" + subject).encode("utf-16-le", "surrogatepass").decode("utf-16-le", "replace")
    digest = hashlib.sha256(text.encode("utf-8")).digest()
    return int.from_bytes(digest[:4], "big") / 0x100000000 * 100


class FeatureFlags:
    """Boolean features, deterministic percentage rollouts and explicit subject targeting."""

    def __init__(self, store: NoSQL, *, now: Callable[[], datetime] = _js.utc_now) -> None:
        self.store = store
        self.now = now

    def list(self, cursor: str | None = None) -> FlagPage:
        """One storage page of admin-only definitions; the opaque cursor is forwarded unchanged."""
        page = self.store.list(PARTITION, cursor)
        result: FlagPage = {"items": [{**row["data"], "version": row["version"]} for row in page["items"]]}  # type: ignore[typeddict-item]
        if page.get("cursor") is not None:
            result["cursor"] = page["cursor"]
        return result

    def get(self, key: str) -> Flag | None:
        """Read a validated key; missing definitions return None."""
        _valid_key(key)
        row = self.store.get(PARTITION, key)
        return {**row["data"], "version": row["version"]} if row else None  # type: ignore[return-value, typeddict-item]

    def save(self, key: str, definition: FlagDefinition, version: int | None, actor_id: str) -> Flag:
        """Create with ``version=None`` or update with the current version; stale writes are 409."""
        _valid_key(key)
        if not _valid_definition(definition, version):
            raise HttpError(400, "Invalid flag configuration")
        data = {
            "key": key,
            "description": definition["description"],
            "enabled": definition["enabled"],
            "public": definition["public"],
            "rollout": definition["rollout"],
            "subjects": list(dict.fromkeys(definition["subjects"])),
            "updatedAt": _js.iso_timestamp(self.now()),
            "updatedBy": actor_id,
        }
        expected = None if version is None else int(version)
        next_version = (expected or 0) + 1
        self.store.transact([{"row": {"pk": PARTITION, "sk": key, "version": next_version, "data": data}, "expected": expected}])
        return {**data, "version": next_version}  # type: ignore[return-value, typeddict-item]

    def enabled(self, key: str, subject: str = "", public_only: bool = False) -> bool:
        """Unknown/disabled flags fail closed. Public evaluation never reveals targeting rules."""
        if not isinstance(subject, str) or _js.utf16_length(subject) > 120:
            raise HttpError(400, "Invalid flag subject")
        flag = self.get(key)
        if not flag or not flag.get("enabled") or (public_only and not flag.get("public")):
            return False
        if subject and subject in (flag.get("subjects") or []):
            return True
        rollout = flag.get("rollout")
        if _js.is_number(rollout) and rollout == 100:
            return True
        if not subject or (_js.is_number(rollout) and rollout == 0):
            return False
        return rollout_bucket(key, subject) < rollout  # type: ignore[operator]

    def _evaluate(self, c: Context) -> dict[str, bool]:
        body = c.request.body
        keys = body.get("keys")
        subject = body["subject"] if "subject" in body else ""
        if not isinstance(keys, list) or len(keys) > 20 or any(not isinstance(k, str) for k in keys):
            raise HttpError(400, "Provide up to 20 flag keys")
        return {key: self.enabled(key, subject, True) for key in keys}

    def feature(self) -> Feature:
        """Owner-only editing (mounted under /admin/app) and a public boolean evaluator."""
        return Feature(
            id="feature-flags",
            admin={
                "id": "feature-flags",
                "title": "Feature flags",
                "resource": "flags.manage",
                "path": "/feature-flags",
                "component": "feature-flags",
                "ownerOnly": True,
                "fields": [],
                "actions": [],
            },
            endpoints=[
                Endpoint(
                    method="GET",
                    path="/feature-flags",
                    resource="flags.manage",
                    access="owner",
                    handle=lambda c: self.list(c.request.query.get("cursor")),
                ),
                Endpoint(
                    method="PUT",
                    path="/feature-flags/:key",
                    resource="flags.manage",
                    access="owner",
                    tool={
                        "name": "flags_save",
                        "description": "Create or update a boolean flag. Pass version:null for creation; "
                        "use the current version to update. Flags do not grant permissions.",
                        "example": {
                            "params": {"key": "new-checkout"},
                            "body": {
                                "version": None,
                                "enabled": False,
                                "public": True,
                                "rollout": 100,
                                "subjects": [],
                                "description": "New checkout UI",
                            },
                        },
                    },
                    handle=lambda c: self.save(
                        c.params["key"],
                        c.request.body,  # type: ignore[arg-type]
                        c.request.body.get("version", MISSING),  # a missing version is invalid, not a create
                        c.actor["id"] if c.actor else "",
                    ),
                ),
                Endpoint(
                    method="POST",
                    path="/feature-flags/evaluate",
                    resource="flags.evaluate",
                    access="guest",
                    handle=self._evaluate,
                ),
            ],
        )


__all__ = ["FeatureFlags", "Flag", "FlagDefinition", "FlagPage", "MISSING", "PARTITION", "rollout_bucket"]
