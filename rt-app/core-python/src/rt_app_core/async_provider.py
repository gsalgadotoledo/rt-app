"""Asyncio provider. One instance belongs to one event loop."""
from __future__ import annotations

import asyncio
from contextvars import ContextVar
from typing import Awaitable, Callable, Generic, TypeVar

from . import InitializationError, ProviderClosedError

T = TypeVar("T")
_initializing: ContextVar[tuple[object, ...]] = ContextVar("rt_app_initializing", default=())


class AsyncSingleton(Generic[T]):
    """Share an initialization task; cancelling a waiter does not cancel the factory.

    Use an application-lifetime factory (not request credentials/context). Cleanup
    must use aclose after requests drain. Factories must not introduce dependency
    cycles, including cross-task cycles. Partial allocations belong to the factory.
    """

    def __init__(self, factory: Callable[[], Awaitable[T]], *, close: Callable[[T], Awaitable[None]] | None = None):
        self._factory = factory
        self._cleanup = close
        self._task: asyncio.Task[T] | None = None
        self._closing: asyncio.Task[None] | None = None
        self._loop: asyncio.AbstractEventLoop | None = None

    def _bind(self) -> None:
        loop = asyncio.get_running_loop()
        if self._loop is not None and self._loop is not loop:
            raise RuntimeError("AsyncSingleton belongs to a different event loop")
        self._loop = loop

    @staticmethod
    def _observe(task: asyncio.Task) -> None:
        # Observe failures even when all waiters cancel; awaiters still receive them.
        if not task.cancelled():
            task.exception()

    async def _initialize(self) -> T:
        token = _initializing.set((*_initializing.get(), self))
        try:
            return await self._factory()
        except Exception as error:
            raise InitializationError("Factory failed; create a new provider") from error
        finally:
            _initializing.reset(token)

    async def get(self) -> T:
        self._bind()
        if self._closing is not None:
            raise ProviderClosedError("Provider is closed")
        if self in _initializing.get():
            raise InitializationError("Recursive provider initialization")
        if self._task is None:
            self._task = asyncio.create_task(self._initialize())
            self._task.add_done_callback(self._observe)
        return await asyncio.shield(self._task)

    async def _close(self) -> None:
        if self._task is None:
            return
        try:
            value = await self._task
        except (Exception, asyncio.CancelledError):
            return
        if self._cleanup is not None:
            await self._cleanup(value)

    async def aclose(self) -> None:
        self._bind()
        if self in _initializing.get():
            raise RuntimeError("Cannot close a provider inside its factory")
        if self._closing is None:
            self._closing = asyncio.create_task(self._close())
            self._closing.add_done_callback(self._observe)
        await asyncio.shield(self._closing)

    async def __aenter__(self) -> AsyncSingleton[T]:
        return self

    async def __aexit__(self, *_: object) -> None:
        await self.aclose()
