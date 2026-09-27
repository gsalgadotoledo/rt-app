"""Console output: one JSON line per event, like ``console[level](JSON.stringify(event))``.

``ConsoleOutput(sink=None)`` writes debug and info lines to stdout and warn and error lines to
stderr (Node's console streams); pass ``sink(level, line)`` to send them elsewhere.
"""
from __future__ import annotations

import sys
import threading
from collections.abc import Callable, Mapping
from typing import Any

from ._json import stringify

Sink = Callable[[str, str], object]


def stdio_sink(level: str, line: str) -> None:
    stream = sys.stderr if level in ("warn", "error") else sys.stdout
    print(line, file=stream, flush=True)


class ConsoleOutput:
    """Structured stdout/stderr lines; ``id`` is "console"."""

    id = "console"

    def __init__(self, sink: Sink | None = None) -> None:
        self.sink = sink or stdio_sink

    def write(self, event: Mapping[str, Any], signal: threading.Event | None = None) -> None:
        self.sink(event["level"], stringify(event))


__all__ = ["ConsoleOutput", "Sink", "stdio_sink"]
