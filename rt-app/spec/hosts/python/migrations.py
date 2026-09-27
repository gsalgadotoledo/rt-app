"""Subjects: migrations (MemoryStore), migrations-postgres and migrations-dynamodb (optional).

Mirrors hosts/node/migrations.mjs: a facade over MigrationRunner, SeedRunner, create_context and
the migrate/seed commands. Migrations and seeds are declared as data in init.features and built
into step functions made of operations, so every language runs identical steps.
"""
from __future__ import annotations

import os
from collections.abc import Callable
from datetime import datetime, timedelta, timezone
from typing import Any

from cache import FaultyStore
from storage import memory_store

from rt_app import _js
from rt_app.contracts import to_datetime
from rt_app.migrations import (
    Migration,
    MigrationStep,
    MigrationRunner,
    Module,
    Seed,
    SeedRunner,
    create_context,
    schema_migration,
)
from rt_app.migrations.cli import migrate_command, seed_command

LOCKS = "MIGRATION_LOCKS"
DEFAULT_NOW = "2026-09-24T10:00:00.000Z"
_EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)


def _parse_iso(value: Any, what: str) -> int:
    try:
        if not isinstance(value, str):
            raise ValueError
        moment = datetime.fromisoformat(value[:-1] + "+00:00" if value.endswith(("Z", "z")) else value)
        if moment.tzinfo is None:
            moment = moment.replace(tzinfo=timezone.utc)
        return (moment - _EPOCH) // timedelta(milliseconds=1)
    except (ValueError, TypeError):
        raise TypeError(f"{what} must be an ISO 8601 date") from None


def _defined(value: Any) -> dict[str, Any]:
    return {k: v for k, v in (value or {}).items() if v is not None} if isinstance(value, dict) else {}


def _message(error: BaseException) -> str:
    message = getattr(error, "message", None)
    return message if isinstance(message, str) else str(error)


class MigrationsFacade:
    def __init__(self, backing: Any, init: dict[str, Any]) -> None:
        self._backing = backing
        self._now = _parse_iso(init.get("now") if init.get("now") is not None else DEFAULT_NOW, "init.now")
        self._store = FaultyStore(backing)
        # The provider name runners see (history rows record it), whatever the backing engine.
        self._provider = init.get("provider") if init.get("provider") is not None else "memory"
        self._features = init.get("features") or []
        self._environment = init.get("environment")
        self._owner = init["owner"] if "owner" in init else "runner-a"
        self._lock_ttl_ms = init.get("lockTtlMs")
        self._secrets = init.get("secrets")
        self._services = init.get("services")
        self._trace: list[Any] = []
        self._logs: list[str] = []
        self._output: list[str] = []

    # Runners ----------------------------------------------------------------------------------

    def _clock(self) -> datetime:
        return to_datetime(self._now)

    def _log(self, line: str) -> None:
        self._logs.append(line)

    def _options(self, **extra: Any) -> dict[str, Any]:
        options = {
            "environment": self._environment,
            "owner": self._owner,
            "lock_ttl_ms": self._lock_ttl_ms,
            "clock": self._clock,
            "log": self._log,
            "secrets": self._secrets,
            "services": self._services,
            "provider": self._provider,
            **extra,
        }
        return {k: v for k, v in options.items() if v is not None}

    def _migrations(self, **extra: Any) -> MigrationRunner:
        return MigrationRunner(self._store, self._build(self._features), **self._options(**extra))

    def _seeds(self, **extra: Any) -> SeedRunner:
        return SeedRunner(self._store, self._build(self._features), **self._options(**extra))

    # Declarations -----------------------------------------------------------------------------

    def _perform(self, ops: Any, context: Any) -> None:
        for op in ops or []:
            kind, value = next(iter(op.items())) if isinstance(op, dict) and op else (None, None)

            def need() -> Any:
                if context is None:
                    raise RuntimeError(f"Operation {kind} needs a migration context")
                return context

            if kind == "ensure":
                self._trace.append({"ensured": need().ensure_rows(value)})
            elif kind == "delete":
                row = self._store.get(value["pk"], value["sk"])
                if row is not None:
                    self._store.transact([{"row": row, "expected": row["version"], "delete": True}])
            elif kind == "fail":
                raise RuntimeError(value)
            elif kind == "advance":
                self._now += value
            elif kind == "steal":
                current = self._store.get(LOCKS, value["lock"])
                ttl = value.get("ttlMs") if value.get("ttlMs") is not None else 900000
                self._store.transact([{
                    "row": {
                        "pk": LOCKS,
                        "sk": value["lock"],
                        "version": current["version"] + 1 if current else 1,
                        "data": {
                            "owner": value.get("owner"),
                            "acquiredAt": _js.iso_timestamp(to_datetime(self._now)),
                            "expiresAt": _js.iso_timestamp(to_datetime(self._now + ttl)),
                        },
                    },
                    "expected": current["version"] if current else None,
                }])
            elif kind == "release":
                current = self._store.get(LOCKS, value)
                if current is not None:
                    self._store.transact([{"row": current, "expected": current["version"], "delete": True}])
            elif kind == "faults":
                for fault in value:
                    self._store.inject(fault, 1)
            elif kind == "peek":
                self._trace.append({"peek": self._store.get(value[0], value[1])})
            elif kind == "log":
                need().log(value)
            elif kind == "context":
                c = need()
                self._trace.append({"context": {"provider": c.provider, "environment": c.environment}})
            elif kind == "secret":
                self._trace.append({"secret": need().secret(value)})
            elif kind == "service":
                self._trace.append({"service": need().service(value)})
            elif kind == "nested":
                cls = SeedRunner if value.get("runner") == "seeds" else MigrationRunner
                runner = cls(self._store, self._build(value.get("features") or []), **self._options(owner=value.get("owner")))
                options = _defined(value.get("options"))
                try:
                    method = getattr(runner, value["call"])
                    result = method() if value["call"] == "status" else method(**options)
                    self._trace.append({"nested": {"value": result}})
                except Exception as error:  # noqa: BLE001 - logged for the contract
                    self._trace.append({"nested": {"error": _message(error)}})
            else:
                raise TypeError("Unknown operation " + _js.stringify(op))

    def _step(self, id: Any, name: str, ops: Any) -> Callable[[Any], None] | None:
        if ops is None:
            return None

        def step(context: Any) -> None:
            self._trace.append(f"{_js_id(id)} {name}")
            self._perform(ops, context)

        return step

    def _legacy(self, id: Any, name: str, ops: Any) -> Callable[[Any], None] | None:
        if ops is None:
            return None

        def run(_store: Any) -> None:
            self._trace.append(f"{_js_id(id)} {name}")
            self._perform(ops, None)

        return run

    def _migration(self, d: dict[str, Any]) -> Any:
        if d.get("schema") is not None:
            return schema_migration(d["schema"])
        id = d.get("id")
        providers = d.get("providers")
        return Migration(
            id=id,
            checksum=d.get("checksum"),
            description=d.get("description"),
            up=self._step(id, "up", d.get("up")),
            down=self._step(id, "down", d.get("down")),
            run=self._legacy(id, "run", d.get("run")),
            providers=None if providers is None else {
                name: MigrationStep(
                    checksum=p.get("checksum"),
                    up=self._step(id, "up@" + name, p.get("up")),
                    down=self._step(id, "down@" + name, p.get("down")),
                    run=self._legacy(id, "run@" + name, p.get("run")),
                )
                for name, p in providers.items()
            },
        )

    def _seed(self, d: dict[str, Any]) -> Seed:
        return Seed(
            id=d.get("id"),
            run=self._step(d.get("id"), "seed", d.get("run") if d.get("run") is not None else []),  # type: ignore[arg-type]
            description=d.get("description"),
            version=d.get("version"),
            environments=d.get("environments"),
        )

    def _build(self, features: Any) -> list[Module]:
        return [
            Module(
                id=f.get("id"),
                migrations=[self._migration(m) for m in f.get("migrations") or []],
                seeds=[self._seed(s) for s in f.get("seeds") or []],
            )
            for f in features
        ]

    # Contract methods -------------------------------------------------------------------------

    def status(self) -> Any:
        return self._migrations().status()

    def up(self, target: Any = None) -> Any:
        return self._migrations().up(**_defined(target))

    def down(self, target: Any = None) -> Any:
        return self._migrations().down(**_defined(target))

    def seed_status(self) -> Any:
        return self._seeds().status()

    def seed(self, options: Any = None) -> Any:
        return self._seeds().run(**_defined(options))

    def ensure_rows(self, rows: Any) -> Any:
        return create_context(self._store, self._environment or "local", self._log, self._provider).ensure_rows(rows)

    def _application(self) -> Any:
        facade = self

        class Application:
            environment = facade._environment or "local"

            def migrations(self, **o: Any) -> MigrationRunner:
                return facade._migrations(log=o.get("log"))

            def seeds(self, **o: Any) -> SeedRunner:
                return facade._seeds(log=o.get("log"), secrets=o.get("secrets"))

        return Application()

    def migrate_command(self, argv: Any = None) -> list[str]:
        self._output = []
        migrate_command(self._application(), argv or [], self._output.append)
        return self._output

    def seed_command(self, argv: Any = None, secrets: Any = None) -> list[str]:
        self._output = []
        seed_command(self._application(), argv or [], secrets or {}, self._output.append)
        return self._output

    def output(self) -> list[str]:
        return self._output

    def trace(self) -> list[Any]:
        return self._trace

    def logs(self) -> list[str]:
        return self._logs

    def row(self, pk: Any, sk: Any) -> Any:
        return self._store.get(pk, sk)

    def rows(self, pk: Any) -> list[Any]:
        rows: list[Any] = []
        cursor = None
        while True:
            page = self._store.list(pk, cursor)
            rows.extend(page["items"])
            cursor = page.get("cursor")
            if not cursor:
                return rows

    def set_now(self, iso: Any) -> None:
        self._now = _parse_iso(iso, "setNow")

    def set_features(self, features: Any) -> None:
        self._features = features or []

    def set_environment(self, environment: Any) -> None:
        self._environment = environment

    def set_owner(self, owner: Any) -> None:
        self._owner = owner

    def inject_faults(self, kind: Any, count: Any = None) -> None:
        return self._store.inject(kind, count)

    def close(self) -> None:
        close = getattr(self._backing, "close", None)
        if callable(close):
            close()


def _js_id(id: Any) -> str:
    return "undefined" if id is None else str(id)


def _init(init: Any) -> dict[str, Any]:
    return init if isinstance(init, dict) else {}


def _memory(init: Any) -> MigrationsFacade:
    init = _init(init)
    return MigrationsFacade(memory_store(init.get("rows")), init)


SUBJECTS: dict[str, Any] = {"migrations": _memory}

if os.environ.get("RT_APP_TEST_POSTGRES_URL"):

    def _postgres(init: Any) -> MigrationsFacade:
        from stores import postgres_store

        init = _init(init)
        return MigrationsFacade(postgres_store({"rows": init.get("rows")}), init)

    SUBJECTS["migrations-postgres"] = _postgres

if os.environ.get("RT_APP_TEST_DYNAMODB_ENDPOINT"):

    def _dynamo(init: Any) -> MigrationsFacade:
        from stores import dynamo_store

        init = _init(init)
        return MigrationsFacade(dynamo_store({"rows": init.get("rows")}), init)

    SUBJECTS["migrations-dynamodb"] = _dynamo
