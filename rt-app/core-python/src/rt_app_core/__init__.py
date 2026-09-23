"""Typed providers scoped to one application. No global service registry."""
from __future__ import annotations

from threading import RLock
from typing import Callable, Generic, TypeVar, cast

T = TypeVar("T")


class ProviderClosedError(RuntimeError):
    pass


class InitializationError(RuntimeError):
    """A factory failed. Create a new provider to retry initialization."""


class Singleton(Generic[T]):
    """Lazy synchronous factory with thread-safe initialization and explicit cleanup.

    Use keyword arguments/partial to bind constructor configuration. Dependencies
    must be acyclic. Constructors own cleanup of partial failures. This class does
    not make the returned object's methods thread-safe. Stop requests before close.
    Use AsyncSingleton for async factories; never block an event loop with this class.
    """

    def __init__(self, factory: Callable[[], T], *, close: Callable[[T], None] | None = None):
        self._factory = factory
        self._cleanup = close
        self._lock = RLock()
        self._ready = False
        self._initializing = False
        self._closed = False
        self._value: T | None = None
        self._error: Exception | None = None
        self._close_error: Exception | None = None

    def get(self) -> T:
        with self._lock:
            if self._closed:
                raise ProviderClosedError("Provider is closed")
            if self._initializing:
                raise InitializationError("Recursive provider initialization")
            if self._error is not None:
                raise InitializationError("Factory previously failed; create a new provider") from self._error
            if not self._ready:
                self._initializing = True
                try:
                    self._value = self._factory()
                    self._ready = True
                except Exception as error:
                    self._error = error
                    raise InitializationError("Factory failed") from error
                finally:
                    self._initializing = False
            return cast(T, self._value)

    def close(self) -> None:
        with self._lock:
            if self._initializing:
                raise RuntimeError("Cannot close a provider inside its factory")
            if self._closed:
                if self._close_error is not None:
                    raise self._close_error
                return
            self._closed = True
            if self._ready and self._cleanup is not None:
                try:
                    self._cleanup(cast(T, self._value))
                except Exception as error:
                    self._close_error = error
                    raise

    def __enter__(self) -> Singleton[T]:
        return self

    def __exit__(self, *_: object) -> None:
        self.close()


from .async_provider import AsyncSingleton

__all__ = ["Singleton", "AsyncSingleton", "ProviderClosedError", "InitializationError"]
