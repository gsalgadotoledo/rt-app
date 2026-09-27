"""Product analytics over the Observer pipeline (TypeScript is the reference).

``Analytics(observer)`` validates event names and delegates, under the log context
``{"category": "analytics"}``: ``track`` emits an ``info`` event of kind ``analytics`` and
``page_view`` counts a page view. It has no endpoints and no storage; filtering, sanitizing and
delivery are the Observer's job, so any object with the three methods of ``AnalyticsObserver``
works (an Observer port, or an adapter over your logging).
"""
from __future__ import annotations

import re
from collections.abc import Callable, Mapping
from typing import Any, Protocol, TypeVar

T = TypeVar("T")

#: ``^[a-zA-Z][a-zA-Z0-9._-]{0,79}$`` (ASCII only; matched with fullmatch, so "a\n" is invalid).
EVENT_NAME = re.compile(r"[a-zA-Z][a-zA-Z0-9._-]{0,79}")
CATEGORY = "analytics"


class AnalyticsObserver(Protocol):
    """What Analytics needs from an Observer (the TypeScript ``Observer`` surface)."""

    def with_context(self, context: Mapping[str, str], operation: Callable[[], T]) -> T:
        """Run ``operation`` with ``context`` merged over the current log context."""
        ...

    def emit(self, level: str, kind: str, source: str, message: str, data: Mapping[str, Any]) -> Any: ...

    def count_view(self, message: str, options: Mapping[str, Any]) -> Any:
        """``options``: ``{"url", "apiUrl"?, "source"?}`` (the Observer defaults source to "spa")."""
        ...


class Analytics:
    """Product analytics uses the same filtered delivery pipeline, with a distinct event kind."""

    def __init__(self, observer: AnalyticsObserver) -> None:
        self.observer = observer

    def page_view(self, title: str, options: Mapping[str, Any]) -> Any:
        return self.observer.with_context({"category": CATEGORY}, lambda: self.observer.count_view(title, options))

    def track(self, name: str, properties: Mapping[str, Any] | None = None, source: str | None = None) -> Any:
        """Emit ``name`` (a stable identifier) with ``properties`` (default ``{}``) from ``source`` ("app")."""
        if not isinstance(name, str) or not EVENT_NAME.fullmatch(name):
            raise ValueError("Use a stable analytics event name")
        data = {} if properties is None else properties
        origin = "app" if source is None else source
        return self.observer.with_context(
            {"category": CATEGORY}, lambda: self.observer.emit("info", "analytics", origin, name, data)
        )


__all__ = ["Analytics", "AnalyticsObserver", "EVENT_NAME"]
