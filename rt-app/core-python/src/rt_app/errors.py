"""Errors that carry an HTTP status. Every other exception becomes 500 "Internal error"."""
from __future__ import annotations


class HttpError(Exception):
    """An error meant for the client: answered as ``status`` with ``{"error": message}``."""

    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message

    def __repr__(self) -> str:
        return f"{type(self).__name__}({self.status!r}, {self.message!r})"


class Conflict(HttpError):
    """A version-guarded write lost the race; the client should reload and retry."""

    def __init__(self) -> None:
        super().__init__(409, "Conflict: refresh and try again")

    def __repr__(self) -> str:
        return "Conflict()"


__all__ = ["HttpError", "Conflict"]
