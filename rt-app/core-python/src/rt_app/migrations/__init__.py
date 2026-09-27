"""Module migrations and seeds (port of ``@gsalgadotoledo/rt-app-migrations``; TypeScript is the reference).

Modules declare migrations and seeds as values; the runners apply them through the NoSQL contract,
so the same step runs on memory, PostgreSQL and DynamoDB::

    CATALOG = Module("catalog", migrations=[
        schema_migration("catalog"),
        Migration("catalog:002", checksum="catalog-currencies-v1", description="Add supported currencies",
                  up=lambda c: c.ensure_rows([{"pk": "CURRENCY", "sk": "USD", "data": {"code": "USD"}}])),
    ])
    MigrationRunner(store, [CATALOG], environment="stage").up()

Guarantees (identical to TypeScript, pinned by ``spec/contracts/migrations.contract.yaml``):

- The whole plan (ids, duplicates, engine support, checksums) is validated when a runner is built.
- One runner at a time per database: a lease row ``MIGRATION_LOCKS/migrations`` (``seeds`` for
  seeds) written with conditional writes, renewed before each step; history rows are written in
  the same transaction as a renewal, so a runner that lost its lease records nothing.
- Checksums are opaque declared strings compared exactly, so history written by TypeScript, Python
  or Go is interchangeable: ``MIGRATIONS/<id> {checksum, provider, appliedAt}`` and
  ``SEEDS/<id> {version, environment, appliedAt}``.
- ``down`` refuses irreversible targets before touching anything.

The TypeScript seed context also has ``faker()`` (deterministic ``@faker-js/faker``); it is
TypeScript-only and not part of the contract.
"""
from __future__ import annotations

import inspect
import math
import re
import uuid
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

from .. import _js
from .._jsnum import number_to_string
from ..contracts import Clock, epoch_ms, to_datetime
from ..nosql import NoSQL, Row, Write

ENVIRONMENTS: tuple[str, ...] = ("local", "develop", "stage", "prod")
#: Seeds without an explicit list never reach production.
DEFAULT_SEED_ENVIRONMENTS: tuple[str, ...] = ("local", "develop", "stage")
DEFAULT_LOCK_TTL_MS = 15 * 60_000

MIGRATIONS = "MIGRATIONS"
SEEDS = "SEEDS"
LOCKS = "MIGRATION_LOCKS"

_ID = re.compile(r"[a-z0-9][a-z0-9._-]*:[a-z0-9][a-z0-9._-]*", re.ASCII | re.IGNORECASE)
_ISO = re.compile(
    r"([+-]\d{6}|\d{4})(?:-(\d{2})(?:-(\d{2}))?)?"
    r"(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?(Z|[+-]\d{2}:\d{2})?",
    re.ASCII,
)


# ---------------------------------------------------------------------------------------------
# Declarations
# ---------------------------------------------------------------------------------------------


@dataclass(frozen=True)
class MigrationStep:
    """A provider override: its own checksum (the migration's when None) and step functions."""

    checksum: str | None = None
    up: Callable[[MigrationContext], Any] | None = None
    down: Callable[[MigrationContext], Any] | None = None
    #: Deprecated ``run(store)``; used when ``up`` is absent.
    run: Callable[[NoSQL], Any] | None = None


@dataclass(frozen=True)
class Migration:
    """A module-owned change. ``id`` is permanent (``module:NNN``); never change an applied checksum."""

    id: str
    checksum: str | None = None
    description: str | None = None
    up: Callable[[MigrationContext], Any] | None = None
    down: Callable[[MigrationContext], Any] | None = None
    run: Callable[[NoSQL], Any] | None = None
    providers: Mapping[str, MigrationStep] | None = None


@dataclass(frozen=True)
class Seed:
    """Example or reference data. Runs once per ``version`` (default "1"); never in prod by default."""

    id: str
    run: Callable[[SeedContext], Any]
    description: str | None = None
    version: str | None = None
    environments: Sequence[str] | None = None


@dataclass(frozen=True)
class Module:
    """What the runners read from a module: its id, migrations and seeds."""

    id: str
    migrations: Sequence[Any] = ()
    seeds: Sequence[Any] = ()


def _field(value: Any, name: str) -> Any:
    """A declaration field from a dataclass/object or a Mapping (None when absent)."""
    if isinstance(value, Mapping):
        return value.get(name)
    return getattr(value, name, None)


def schema_migration(module: str) -> Migration:
    """First migration of every document module: records ``SCHEMA/<module> {schemaVersion: 1}`` once."""

    def up(context: MigrationContext) -> None:
        store = context.store
        if store.get("SCHEMA", module) is not None:
            return
        store.transact([{"row": {"pk": "SCHEMA", "sk": module, "version": 1, "data": {"schemaVersion": 1}}, "expected": None}])

    return Migration(
        id=module + ":001",
        checksum=module + "-document-v1",
        description="Register the " + module + " document schema",
        up=up,
    )


# ---------------------------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------------------------


def _message(error: BaseException) -> str:
    message = getattr(error, "message", None)
    return message if isinstance(message, str) else str(error)


class MigrationLockedError(RuntimeError):
    """Another runner holds the lease: ``Migrations are already running (<holder>, lock expires <at>)``."""

    def __init__(self, holder: Any, expires_at: Any) -> None:
        self.holder = holder
        self.expires_at = expires_at
        self.message = f"Migrations are already running ({_js_str(holder)}, lock expires {_js_str(expires_at)})"
        super().__init__(self.message)


class MigrationError(RuntimeError):
    """A step failed: ``Migration <id> (<direction>) failed: Original error: <message>`` (Umzug's text)."""

    def __init__(self, name: str, direction: str, cause: BaseException) -> None:
        self.migration = name
        self.direction = direction
        self.cause = cause
        self.message = f"Migration {name} ({direction}) failed: Original error: {_message(cause)}"
        super().__init__(self.message)


class _Undefined:
    """Marker for a missing field (``String(undefined)`` is "undefined")."""


UNDEFINED = _Undefined()


def _js_str(value: Any) -> str:
    """``String(value)``: missing → "undefined", None → "null", JavaScript numbers."""
    if value is UNDEFINED:
        return "undefined"
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return number_to_string(value)
    if isinstance(value, str):
        return value
    if isinstance(value, (list, tuple)):
        return ",".join("" if v is None else _js_str(v) for v in value)
    return "[object Object]"


def _get(data: Any, key: str) -> Any:
    return data.get(key, UNDEFINED) if isinstance(data, Mapping) else UNDEFINED


# ---------------------------------------------------------------------------------------------
# JavaScript helpers
# ---------------------------------------------------------------------------------------------


def _truthy(value: Any) -> bool:
    if value is None or value is UNDEFINED:
        return False
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0 and not (isinstance(value, float) and math.isnan(value))
    if isinstance(value, str):
        return value != ""
    return True  # objects, arrays and functions


def _strict_equal(a: Any, b: Any) -> bool:
    """``a === b`` for JSON scalars (True is not 1; 3 is not "3")."""
    if a is UNDEFINED or b is UNDEFINED:
        return a is b
    if a is None or b is None:
        return a is b
    if isinstance(a, bool) or isinstance(b, bool):
        return isinstance(a, bool) and isinstance(b, bool) and a == b
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        return a == b
    if isinstance(a, str) and isinstance(b, str):
        return a == b
    return a is b


def _slice_end(length: int, end: Any) -> int:
    """The end index of ``array.slice(0, end)`` (ToIntegerOrInfinity, negatives from the end)."""
    if end is None:
        return length
    n = float(end)
    if math.isnan(n):
        n = 0.0
    if math.isinf(n):
        return length if n > 0 else 0
    n = math.trunc(n)
    if n < 0:
        return max(length + int(n), 0)
    return min(int(n), length)


def date_ms(value: Any) -> float:
    """``new Date(value).getTime()`` for stored values: ISO strings, numbers; NaN otherwise.

    Date-times without an offset are read as UTC (JavaScript reads them as local time).
    """
    if isinstance(value, bool):
        return float(value)
    if isinstance(value, (int, float)):
        return float(value)
    if value is None:
        return 0.0
    if not isinstance(value, str):
        return math.nan
    match = _ISO.fullmatch(value)
    if not match:
        return math.nan
    year, month, day, hour, minute, second, fraction, zone = match.groups()
    try:
        moment = datetime(
            int(year), int(month or 1), int(day or 1), int(hour or 0), int(minute or 0), int(second or 0),
            tzinfo=timezone.utc,
        )
    except ValueError:
        return math.nan
    if hour is not None and int(hour) == 24:
        return math.nan
    ms = (moment - datetime(1970, 1, 1, tzinfo=timezone.utc)).total_seconds() * 1000
    ms = float(round(ms)) + (int((fraction + "00")[:3]) if fraction else 0)
    if zone and zone != "Z":
        sign = 1 if zone[0] == "+" else -1
        ms -= sign * (int(zone[1:3]) * 60 + int(zone[4:6])) * 60_000
    return ms


def _call(fn: Callable[..., Any], *args: Any) -> Any:
    result = fn(*args)
    return _js.run_sync(result) if inspect.isawaitable(result) else result


def _module_of(id: Any, kind: str) -> str:
    """Validate ``module:name`` (ASCII, at most 200 UTF-16 units) and return the module."""
    if not isinstance(id, str) or not _ID.fullmatch(id) or _js.utf16_length(id) > 200:
        raise ValueError(f"Invalid {kind} id: {_js_str(UNDEFINED if id is None else id)} (expected module:name)")
    return id[: id.index(":")]


def _list_all(store: NoSQL, pk: str) -> list[Row]:
    rows: list[Row] = []
    cursor: str | None = None
    while True:
        page = store.list(pk, cursor)
        rows.extend(page["items"])
        cursor = page.get("cursor")
        if not cursor:
            return rows


# ---------------------------------------------------------------------------------------------
# Contexts
# ---------------------------------------------------------------------------------------------


class MigrationContext:
    """Engine-agnostic helpers handed to every step: write through ``store`` (the NoSQL contract)."""

    def __init__(self, store: NoSQL, environment: str, log: Callable[[str], None], provider: str | None = None) -> None:
        self.store = store
        self.provider = provider if provider is not None else getattr(store, "provider", None)
        self.environment = environment
        self.log = log

    def ensure_rows(self, rows: Sequence[Mapping[str, Any]]) -> list[str]:
        """Insert rows that do not exist yet (version 1, conditional create); returns inserted "pk/sk"."""
        inserted: list[str] = []
        for row in rows:
            if self.store.get(row["pk"], row["sk"]) is not None:
                continue
            try:
                self.store.transact([{"row": {**row, "version": 1}, "expected": None}])  # type: ignore[typeddict-item]
                inserted.append(row["pk"] + "/" + row["sk"])
            except Exception:
                if self.store.get(row["pk"], row["sk"]) is None:
                    raise
        return inserted


class SeedContext(MigrationContext):
    """Migration helpers plus ``secret(name)`` and ``service(id)`` (faker is TypeScript-only)."""

    def __init__(
        self,
        seed_id: str,
        store: NoSQL,
        environment: str,
        log: Callable[[str], None],
        provider: str | None,
        secrets: Mapping[str, str | None],
        services: Mapping[str, Any],
    ) -> None:
        super().__init__(store, environment, log, provider)
        self._seed_id = seed_id
        self._secrets = secrets
        self._services = services

    def secret(self, name: str) -> str:
        value = self._secrets.get(name)
        if not value:
            raise ValueError(f"Seed {self._seed_id} requires {name}")
        return value

    def service(self, id: str) -> Any:
        if id not in self._services:
            raise ValueError(f"Seed {self._seed_id} requires the {id} service")
        return self._services[id]


def create_context(
    store: NoSQL, environment: str = "local", log: Callable[[str], None] | None = None, provider: str | None = None
) -> MigrationContext:
    """The context steps receive (``createContext`` in TypeScript)."""
    return MigrationContext(store, environment, log or (lambda _line: None), provider)


# ---------------------------------------------------------------------------------------------
# Lease lock
# ---------------------------------------------------------------------------------------------


class _Lock:
    def __init__(self, store: NoSQL, name: str, owner: str, ttl_ms: float, now: Callable[[], float]) -> None:
        self.store, self.name, self.owner, self.ttl_ms, self.now = store, name, owner, ttl_ms, now
        self.version = 0

    def acquire(self) -> None:
        current = self.store.get(LOCKS, self.name)
        now = self.now()
        if current is not None:
            data = current.get("data")
            if date_ms(_get(data, "expiresAt") if _get(data, "expiresAt") is not UNDEFINED else math.nan) > now:
                raise MigrationLockedError(_get(data, "owner"), _get(data, "expiresAt"))
        row = self._row(current["version"] + 1 if current is not None else 1, now)
        try:
            self.store.transact([{"row": row, "expected": current["version"] if current is not None else None}])
        except Exception:
            winner = self.store.get(LOCKS, self.name)
            data = winner.get("data") if winner is not None else None
            owner, expires = _get(data, "owner"), _get(data, "expiresAt")
            raise MigrationLockedError(
                "unknown" if owner is UNDEFINED or owner is None else owner,
                "unknown" if expires is UNDEFINED or expires is None else expires,
            ) from None
        self.version = row["version"]

    def renew(self) -> None:
        self.commit([])

    def commit(self, writes: Sequence[Write]) -> None:
        """Write history atomically with the renewal; a lost lease fails the whole transaction."""
        row = self._row(self.version + 1, self.now())
        self.store.transact([*writes, {"row": row, "expected": self.version}])
        self.version = row["version"]

    def release(self) -> None:
        current = self.store.get(LOCKS, self.name)
        if current is None or current["version"] != self.version or _get(current.get("data"), "owner") != self.owner:
            return
        self.store.transact([{"row": current, "expected": current["version"], "delete": True}])

    def _row(self, version: int, now: float) -> Row:
        return {
            "pk": LOCKS,
            "sk": self.name,
            "version": version,
            "data": {
                "owner": self.owner,
                "acquiredAt": _js.iso_timestamp(to_datetime(now)),
                "expiresAt": _js.iso_timestamp(to_datetime(now + self.ttl_ms)),
            },
        }


# ---------------------------------------------------------------------------------------------
# Runners
# ---------------------------------------------------------------------------------------------


@dataclass
class _Planned:
    migration: Any
    id: str
    module: str
    checksum: Any
    up: Callable[[MigrationContext], Any]
    down: Callable[[MigrationContext], Any] | None
    provider_specific: bool


def _select_step(migration: Any, provider: Any) -> tuple[Any, Callable[[MigrationContext], Any], Any] | None:
    """(checksum, up, down) of the provider override or the generic step; legacy run(store) maps to up."""
    providers = _field(migration, "providers")
    specific = providers.get(provider) if isinstance(providers, Mapping) and isinstance(provider, str) else None
    if specific is not None:
        source = specific
    elif _field(migration, "up") is not None or _field(migration, "run") is not None:
        source = migration
    else:
        return None
    up = _field(source, "up")
    run = _field(source, "run")
    if up is None and run is not None:
        up = lambda context, run=run: run(context.store)  # noqa: E731
    if up is None:
        return None
    checksum = _field(specific, "checksum") if specific is not None else None
    if checksum is None:
        checksum = _field(migration, "checksum")
    return checksum, up, _field(source, "down")


class _Base:
    def __init__(
        self,
        store: NoSQL,
        modules: Sequence[Any],
        environment: str | None = "local",
        owner: str | None = None,
        lock_ttl_ms: float | None = None,
        clock: Clock | None = None,
        log: Callable[[str], None] | None = None,
        secrets: Mapping[str, str | None] | None = None,
        services: Mapping[str, Any] | None = None,
        provider: str | None = None,
    ) -> None:
        self.store = store
        self.modules = list(modules)
        self.environment = "local" if environment is None else environment
        self.owner = owner if owner is not None else "rt-app-" + str(uuid.uuid4())
        self.lock_ttl_ms = DEFAULT_LOCK_TTL_MS if lock_ttl_ms is None else lock_ttl_ms
        self.clock = clock
        self.log = log or (lambda _line: None)
        self.secrets = secrets or {}
        self.services = services or {}
        self.provider = provider if provider is not None else getattr(store, "provider", None)
        if self.environment not in ENVIRONMENTS:
            raise ValueError("Unknown environment: " + _js_str(self.environment))

    def _now(self) -> float:
        return epoch_ms(self.clock)

    def _iso(self) -> str:
        return _js.iso_timestamp(to_datetime(self._now()))

    def _lock(self, name: str) -> _Lock:
        return _Lock(self.store, name, self.owner, self.lock_ttl_ms, self._now)

    def _with_lock(self, name: str, work: Callable[[_Lock], Any]) -> Any:
        lock = self._lock(name)
        lock.acquire()
        try:
            return work(lock)
        finally:
            lock.release()


class MigrationRunner(_Base):
    """Module migrations in module order with history in the application store.

    ``MigrationRunner(store, modules, environment="local", owner=None, lock_ttl_ms=900000,
    clock=None, log=None, secrets=None, services=None, provider=None)``. Steps must be idempotent:
    a crash between a step and its history record re-runs that step.
    """

    def __init__(self, store: NoSQL, modules: Sequence[Any], **options: Any) -> None:
        super().__init__(store, modules, **options)
        self._plan = self._build_plan()

    def status(self) -> list[dict[str, Any]]:
        """Every declared migration with its applied/pending state, then unknown history. Does not write."""
        history = self._history()
        known = {p.id for p in self._plan}
        out: list[dict[str, Any]] = []
        for p in self._plan:
            record = history.get(p.id)
            item: dict[str, Any] = {"id": p.id, "module": p.module}
            description = _field(p.migration, "description")
            if description is not None:
                item["description"] = description
            item["state"] = "applied" if record is not None else "pending"
            _applied_at(item, record)
            item["reversible"] = p.down is not None
            out.append(item)
        for sk, record in history.items():
            if sk in known:
                continue
            item = {"id": sk, "module": sk.split(":")[0], "state": "unknown"}
            _applied_at(item, record)
            item["reversible"] = False
            out.append(item)
        return out

    def up(self, to: str | None = None, step: float | None = None) -> list[str]:
        """Apply pending migrations (all, up to and including ``to``, or ``step`` of them)."""

        def work(lock: _Lock) -> list[str]:
            self._verify_history()
            history = self._history()
            pending = [p for p in self._plan if p.id not in history]
            if _truthy(to):
                index = next((i for i, p in enumerate(pending) if p.id == to), -1)
                if index < 0:
                    raise ValueError(f"Couldn't find migration to apply with name {_js.stringify(to)}")
                targets = pending[: index + 1]
            else:
                targets = pending[: _slice_end(len(pending), step)]
            context = self._context()
            for p in targets:
                self.log("migrating " + p.id)
                try:
                    lock.renew()
                    _call(p.up, context)
                except Exception as error:
                    raise MigrationError(p.id, "up", error) from error
                lock.commit([{
                    "row": {"pk": MIGRATIONS, "sk": p.id, "version": 1, "data": {"checksum": p.checksum, "provider": self.provider, "appliedAt": self._iso()}},
                    "expected": None,
                }])
            return [p.id for p in targets]

        return self._with_lock("migrations", work)

    def down(self, to: str | None = None, step: float | None = None) -> list[str]:
        """Revert the last ``step`` (default 1) applied migrations, or down to and including ``to``."""

        def work(lock: _Lock) -> list[str]:
            self._verify_history()
            history = self._history()
            applied = [p for p in self._plan if p.id in history][::-1]
            targets = applied[: _slice_end(len(applied), 1 if step is None else step)]
            if _truthy(to):
                index = next((i for i, p in enumerate(applied) if p.id == to), -1)
                if index < 0:
                    raise ValueError("Migration is not applied: " + _js_str(to))
                targets = applied[: index + 1]
            irreversible = [p.id for p in targets if p.down is None]
            if irreversible:
                raise ValueError("Irreversible migrations: " + ", ".join(irreversible))
            context = self._context()
            for p in targets:
                self.log("reverting " + p.id)
                try:
                    lock.renew()
                    _call(p.down, context)  # type: ignore[arg-type]
                except Exception as error:
                    raise MigrationError(p.id, "down", error) from error
                record = self.store.get(MIGRATIONS, p.id)
                lock.commit([{"row": record, "expected": record["version"], "delete": True}] if record is not None else [])
            return [p.id for p in targets]

        return self._with_lock("migrations", work)

    def _context(self) -> MigrationContext:
        return MigrationContext(self.store, self.environment, self.log, self.provider)

    def _build_plan(self) -> list[_Planned]:
        plan: list[_Planned] = []
        ids: set[str] = set()
        for module in self.modules:
            for migration in _field(module, "migrations") or ():
                id = _field(migration, "id")
                module_id = _module_of(id, "migration")
                if id in ids:
                    raise ValueError("Duplicate migration id: " + id)
                ids.add(id)
                step = _select_step(migration, self.provider)
                if step is None:
                    raise ValueError(f"Unsupported migration {id} for {_js_str(UNDEFINED if self.provider is None else self.provider)}")
                checksum, up, down = step
                if not _truthy(checksum):
                    raise ValueError("Migration without checksum: " + id)
                providers = _field(migration, "providers")
                specific = isinstance(providers, Mapping) and providers.get(self.provider) is not None
                plan.append(_Planned(migration, id, module_id, checksum, up, down, specific))
        return plan

    def _history(self) -> dict[str, Row]:
        return {row["sk"]: row for row in _list_all(self.store, MIGRATIONS)}

    def _verify_history(self) -> None:
        """Applied migrations are immutable: a changed checksum or engine-specific step fails the run."""
        history = self._history()
        for p in self._plan:
            record = history.get(p.id)
            if record is None:
                continue
            data = record.get("data")
            recorded_provider = _get(data, "provider")
            engine_changed = (
                p.provider_specific and _truthy(recorded_provider) and not _strict_equal(recorded_provider, self.provider)
            )
            if not _strict_equal(_get(data, "checksum"), p.checksum) or engine_changed:
                raise ValueError("Migration changed: " + p.id)


def _applied_at(item: dict[str, Any], record: Row | None) -> None:
    if record is None:
        return
    value = _get(record.get("data"), "appliedAt")
    if value is not UNDEFINED:
        item["appliedAt"] = value


@dataclass
class _PlannedSeed:
    seed: Any
    id: str
    module: str
    version: Any
    environments: list[str] = field(default_factory=list)


class SeedRunner(_Base):
    """Module seeds with their own history (``SEEDS``) and lock (``MIGRATION_LOCKS/seeds``).

    Same options as ``MigrationRunner``; ``secrets`` feed ``context.secret(name)`` and ``services``
    feed ``context.service(id)``. A seed runs once per version; ``rerun`` forces selected seeds.
    """

    def __init__(self, store: NoSQL, modules: Sequence[Any], **options: Any) -> None:
        super().__init__(store, modules, **options)
        ids: set[str] = set()
        self._plan: list[_PlannedSeed] = []
        for module in self.modules:
            for seed in _field(module, "seeds") or ():
                id = _field(seed, "id")
                module_id = _module_of(id, "seed")
                if id in ids:
                    raise ValueError("Duplicate seed id: " + id)
                ids.add(id)
                environments = _field(seed, "environments")
                environments = list(DEFAULT_SEED_ENVIRONMENTS if environments is None else environments)
                if not environments or any(e not in ENVIRONMENTS for e in environments):
                    raise ValueError("Invalid environments for seed " + id)
                version = _field(seed, "version")
                self._plan.append(_PlannedSeed(seed, id, module_id, "1" if version is None else version, environments))

    def status(self) -> list[dict[str, Any]]:
        """Every declared seed and whether it would run in this environment. Does not write."""
        history = self._history()
        out = []
        for p in self._plan:
            record = history.get(p.id)
            item: dict[str, Any] = {"id": p.id, "module": p.module}
            description = _field(p.seed, "description")
            if description is not None:
                item["description"] = description
            item["environments"] = list(p.environments)
            _applied_at(item, record)
            if self.environment not in p.environments:
                state = "skipped"
            elif record is None:
                state = "pending"
            elif not _strict_equal(_get(record.get("data"), "version"), p.version):
                state = "changed"
            else:
                state = "applied"
            item["state"] = state
            out.append(item)
        return out

    def run(self, modules: Sequence[str] | None = None, rerun: bool = False) -> list[str]:
        """Run pending or changed seeds allowed here, optionally only of ``modules``. Returns the ids that ran."""
        for module in modules or ():
            if not any(_field(m, "id") == module for m in self.modules):
                raise ValueError("Unknown module: " + _js_str(module))
        selected = [
            p for p in self._plan if self.environment in p.environments and (modules is None or p.module in modules)
        ]
        if not selected:
            return []

        def work(lock: _Lock) -> list[str]:
            if _truthy(rerun):
                targets = selected
            else:
                history = self._history()
                targets = [
                    p for p in selected
                    if not (p.id in history and _strict_equal(_get(history[p.id].get("data"), "version"), p.version))
                ]
            for p in targets:
                self.log("seeding " + p.id)
                try:
                    lock.renew()
                    _call(_field(p.seed, "run"), self._context(p.id))
                except Exception as error:
                    raise MigrationError(p.id, "up", error) from error
                current = self.store.get(SEEDS, p.id)
                lock.commit([{
                    "row": {
                        "pk": SEEDS,
                        "sk": p.id,
                        "version": (current["version"] if current is not None else 0) + 1,
                        "data": {"version": p.version, "environment": self.environment, "appliedAt": self._iso()},
                    },
                    "expected": current["version"] if current is not None else None,
                }])
            return [p.id for p in targets]

        return self._with_lock("seeds", work)

    def _history(self) -> dict[str, Row]:
        return {row["sk"]: row for row in _list_all(self.store, SEEDS)}

    def _context(self, seed_id: str) -> SeedContext:
        return SeedContext(seed_id, self.store, self.environment, self.log, self.provider, self.secrets, self.services)


def migrate(store: NoSQL, modules: Sequence[Any], **options: Any) -> list[str]:
    """Apply all pending migrations."""
    return MigrationRunner(store, modules, **options).up()


__all__ = [
    "ENVIRONMENTS",
    "DEFAULT_SEED_ENVIRONMENTS",
    "DEFAULT_LOCK_TTL_MS",
    "Migration",
    "MigrationStep",
    "Seed",
    "Module",
    "MigrationContext",
    "SeedContext",
    "MigrationLockedError",
    "MigrationError",
    "MigrationRunner",
    "SeedRunner",
    "create_context",
    "schema_migration",
    "migrate",
    "date_ms",
]
