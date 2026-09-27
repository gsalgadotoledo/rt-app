"""The ``migrate`` and ``seed`` commands (port of ``@gsalgadotoledo/rt-app-migrations/cli``).

``migrate_command(app, ["up", "--step", "1"])`` prints ``Applied: catalog:001``; argument errors
raise ``ValueError(MIGRATE_USAGE)`` (or ``SEED_USAGE``) and runner errors propagate. ``app`` is a
``MigratableApplication``: ``environment``, ``migrations(**options)`` and ``seeds(**options)``;
``Migratable(store, modules, environment)`` is a ready one.
"""
from __future__ import annotations

import json
import math
import re
from collections.abc import Callable, Mapping, Sequence
from typing import Any, Protocol

from .. import _js
from ..contracts import js_trim
from . import MigrationRunner, SeedRunner

MIGRATE_USAGE = "Usage: rta migrate [status|up|down] [--to <id>] [--step <n>] [--json]"
SEED_USAGE = "Usage: rta seed [status|run] [--module <id>[,<id>]] [--rerun] [--json]"

_DECIMAL = re.compile(r"[+-]?(?:Infinity|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)", re.ASCII)
_RADIX = re.compile(r"0[xX][0-9a-fA-F]+|0[oO][0-7]+|0[bB][01]+", re.ASCII)
_LONE_SURROGATE = re.compile("[\ud800-\udfff]")


class MigratableApplication(Protocol):
    """What an application must expose for the migrate/seed commands."""

    environment: str

    def migrations(self, **options: Any) -> MigrationRunner: ...

    def seeds(self, **options: Any) -> SeedRunner: ...


class Migratable:
    """A MigratableApplication over one store and a module list (runner options are shared)."""

    def __init__(self, store: Any, modules: Sequence[Any], environment: str = "local", **runner_options: Any) -> None:
        self.store = store
        self.modules = list(modules)
        self.environment = environment
        self.runner_options = runner_options

    def migrations(self, **options: Any) -> MigrationRunner:
        return MigrationRunner(self.store, self.modules, **{"environment": self.environment, **self.runner_options, **options})

    def seeds(self, **options: Any) -> SeedRunner:
        return SeedRunner(self.store, self.modules, **{"environment": self.environment, **self.runner_options, **options})


def js_number(text: str) -> float:
    """JavaScript ``Number(string)``: trimmed, "" → 0, decimal/Infinity/0x/0o/0b, otherwise NaN."""
    value = js_trim(text)
    if value == "":
        return 0.0
    if _DECIMAL.fullmatch(value):
        if value.lstrip("+-") == "Infinity":
            return -math.inf if value.startswith("-") else math.inf
        return float(value)
    if _RADIX.fullmatch(value):
        return float(int(value, 0))
    return math.nan


def stringify_indented(value: Any) -> str:
    """``JSON.stringify(value, null, 2)`` for JSON values (non-ASCII and U+2028 unescaped)."""
    text = json.dumps(_js.to_json(value), ensure_ascii=False, indent=2, allow_nan=False)
    return _LONE_SURROGATE.sub(lambda m: f"\\u{ord(m.group()):04x}", text)


def _parse(argv: Sequence[str], value_flags: Sequence[str], boolean_flags: Sequence[str], usage: str) -> tuple[str, dict[str, Any]]:
    argv = list(argv)
    if argv and argv[0] and not argv[0].startswith("--"):
        action, rest = argv[0], argv[1:]
    else:
        action, rest = "", argv
    flags: dict[str, Any] = {}
    i = 0
    while i < len(rest):
        name = rest[i][2:] if rest[i].startswith("--") else rest[i]
        if not rest[i].startswith("--"):
            raise ValueError(usage)
        if name in boolean_flags:
            flags[name] = True
        elif name in value_flags and i + 1 < len(rest) and not rest[i + 1].startswith("--"):
            i += 1
            flags[name] = rest[i]
        else:
            raise ValueError(usage)
        i += 1
    return action, flags


def _step(value: str, usage: str) -> float:
    n = js_number(value)
    if not math.isfinite(n) or n != math.trunc(n) or n < 0:
        raise ValueError(usage)
    return n


def migrate_command(app: MigratableApplication, argv: Sequence[str], out: Callable[[str], None] = print) -> None:
    """``rta migrate [status|up|down] [--to <id>] [--step <n>] [--json]``."""
    action, flags = _parse(argv, ["to", "step"], ["json"], MIGRATE_USAGE)
    as_json = flags.get("json") is True
    log: Callable[[str], None] = (lambda _line: None) if as_json else (lambda line: out("  " + line))
    runner = app.migrations(log=log)
    target: dict[str, Any] = {}
    if isinstance(flags.get("to"), str):
        target["to"] = flags["to"]
    if "step" in flags:
        target["step"] = _step(flags["step"], MIGRATE_USAGE)
    if action in ("", "status"):
        if flags.get("to") or "step" in flags:
            raise ValueError(MIGRATE_USAGE)
        status = runner.status()
        if as_json:
            out(stringify_indented({"environment": app.environment, "migrations": status}))
            return
        out(f"Migrations ({app.environment}):")
        for m in status:
            description = f" — {m['description']}" if m.get("description") else ""
            applied = f" ({m['appliedAt']})" if m.get("appliedAt") else ""
            out(f"  {m['state']:<8} {m['id']}{description}{applied}")
        pending = sum(1 for m in status if m["state"] == "pending")
        out(f"{pending} pending. Run: rta migrate up" if pending else "Up to date.")
        return
    if action not in ("up", "down"):
        raise ValueError(MIGRATE_USAGE)
    ids = runner.up(**target) if action == "up" else runner.down(**target)
    if as_json:
        out(_js.stringify({"environment": app.environment, "applied" if action == "up" else "reverted": ids}))
        return
    if ids:
        out(("Applied: " if action == "up" else "Reverted: ") + ", ".join(ids))
    else:
        out("Nothing to " + ("apply." if action == "up" else "revert."))


def seed_command(
    app: MigratableApplication,
    argv: Sequence[str],
    secrets: Mapping[str, str | None],
    out: Callable[[str], None] = print,
) -> None:
    """``rta seed [status|run] [--module <id>[,<id>]] [--rerun] [--json]``."""
    action, flags = _parse(argv, ["module"], ["rerun", "json"], SEED_USAGE)
    as_json = flags.get("json") is True
    log: Callable[[str], None] = (lambda _line: None) if as_json else (lambda line: out("  " + line))
    runner = app.seeds(secrets=secrets, log=log)
    if action == "status":
        if flags.get("module") or flags.get("rerun"):
            raise ValueError(SEED_USAGE)
        status = runner.status()
        if as_json:
            out(stringify_indented({"environment": app.environment, "seeds": status}))
            return
        out(f"Seeds ({app.environment}):")
        for s in status:
            description = f" — {s['description']}" if s.get("description") else ""
            out(f"  {s['state']:<8} {s['id']}{description}")
        return
    if action not in ("", "run"):
        raise ValueError(SEED_USAGE)
    module = flags.get("module")
    modules = [m for m in (js_trim(part) for part in module.split(",")) if m] if isinstance(module, str) else None
    ran = runner.run(modules=modules, rerun=flags.get("rerun") is True)
    if as_json:
        out(_js.stringify({"environment": app.environment, "seeded": ran}))
        return
    out("Seeded: " + ", ".join(ran) if ran else f"No pending seeds for {app.environment}.")


__all__ = [
    "MIGRATE_USAGE",
    "SEED_USAGE",
    "MigratableApplication",
    "Migratable",
    "migrate_command",
    "seed_command",
    "js_number",
    "stringify_indented",
]
