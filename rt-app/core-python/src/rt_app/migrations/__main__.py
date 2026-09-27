"""Command line for module migrations and seeds.

    python -m rt_app.migrations app:migratable migrate [status|up|down] [--to <id>] [--step <n>] [--json]
    python -m rt_app.migrations app:migratable seed [status|run] [--module <id>[,<id>]] [--rerun] [--json]

``module:attr`` is imported from the current directory; ``attr`` is a MigratableApplication
(``environment``, ``migrations(**options)``, ``seeds(**options)``, e.g. ``rt_app.migrations.cli.Migratable``)
or a function returning one. Seeds read ``DEMO_PASSWORD`` from the environment. Errors are printed
to stderr with exit code 1.
"""
from __future__ import annotations

import importlib
import os
import sys
from collections.abc import Sequence
from typing import Any

from .cli import migrate_command, seed_command

USAGE = "Usage: python -m rt_app.migrations module:attr (migrate|seed) [arguments]"


def load(spec: str) -> Any:
    """Import ``module:attr`` from the current directory; call it when it is not an application."""
    module_name, _, attr = spec.partition(":")
    if not module_name or not attr:
        raise ValueError(f"Expected module:attr, got {spec!r}")
    cwd = os.getcwd()
    if cwd not in sys.path:
        sys.path.insert(0, cwd)
    target: Any = importlib.import_module(module_name)
    for part in attr.split("."):
        target = getattr(target, part)
    if not hasattr(target, "migrations") and callable(target):
        target = target()
    if not all(hasattr(target, name) for name in ("environment", "migrations", "seeds")):
        raise ValueError(f"{spec} is not a migratable application (environment, migrations, seeds)")
    return target


def main(argv: Sequence[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if len(args) < 2 or args[1] not in ("migrate", "seed"):
        print(USAGE, file=sys.stderr)
        return 2
    try:
        app = load(args[0])
        if args[1] == "migrate":
            migrate_command(app, args[2:])
        else:
            seed_command(app, args[2:], {"DEMO_PASSWORD": os.environ.get("DEMO_PASSWORD")})
    except Exception as error:  # noqa: BLE001 - the command prints the message like `rta`
        message = getattr(error, "message", None)
        print(message if isinstance(message, str) else str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
