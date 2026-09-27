"""Subject: idempotency (mirrors hosts/node/idempotency.mjs).

A facade over create_idempotency(store, now=clock) on a MemoryStore holding init.rows, with a
settable ISO clock, a log of the works that ran and store fault injection.
"""
from __future__ import annotations

import time
from datetime import datetime, timedelta, timezone
from typing import Any

from cache import FaultyStore
from storage import memory_store, rows_of

from rt_app.idempotency import Context, Idempotency, NoSQLIdempotencyStore

_EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)


def _parse_iso(value: Any, what: str) -> int:
    try:
        if isinstance(value, str):
            value = datetime.fromisoformat(value[:-1] + "+00:00" if value.endswith(("Z", "z")) else value)
        if not isinstance(value, datetime):  # the wire decoder turns {"$date"} into datetimes
            raise ValueError
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return (value - _EPOCH) // timedelta(milliseconds=1)
    except (ValueError, TypeError):
        raise TypeError(f"{what} must be an ISO 8601 date") from None


class _Clock:
    """A settable clock starting at init.now (ISO 8601); the system clock when absent."""

    def __init__(self, now: Any) -> None:
        self.fixed: int | None = None if now is None else _parse_iso(now, "init.now")

    def __call__(self) -> int:
        return time.time_ns() // 1_000_000 if self.fixed is None else self.fixed

    def set(self, iso: Any) -> None:
        self.fixed = _parse_iso(iso, "setNow")


class IdempotencyFacade:
    def __init__(self, init: Any) -> None:
        init = init if isinstance(init, dict) else {}
        self._clock = _Clock(init.get("now"))
        self._store = FaultyStore(memory_store(rows_of(init)))
        self._adapter = NoSQLIdempotencyStore(self._store, now=self._clock)
        self._executor = Idempotency(self._adapter)
        self._executor.init()
        self._log: list[dict[str, Any]] = []

    def _work(self, outcome: Any) -> Any:
        """{result} is returned, {error} is raised, {during: [request, outcome]} runs a nested execute."""
        outcome = outcome if isinstance(outcome, dict) else {}

        def work(context: Context) -> Any:
            entry: dict[str, Any] = {"input": context.input, "idempotencyKey": context.idempotency_key}
            self._log.append(entry)
            during = outcome.get("during")
            if during:
                try:
                    entry["during"] = {"value": self._executor.execute(during[0], self._work(during[1]))}
                except Exception as error:  # noqa: BLE001 - logged for the contract
                    entry["during"] = {"error": {"code": getattr(error, "code", None), "message": getattr(error, "message", str(error))}}
            if isinstance(outcome.get("error"), str):
                raise RuntimeError(outcome["error"])
            return outcome.get("result")

        return work

    def execute(self, request: Any, outcome: Any) -> Any:
        return self._executor.execute(request, self._work(outcome))

    def calls(self) -> list[dict[str, Any]]:
        return self._log

    def claim(self, claim: Any) -> Any:
        return self._adapter.claim(claim)

    def complete(self, claim: Any, result: Any) -> None:
        self._adapter.complete(claim, result)

    def mark_uncertain(self, claim: Any) -> None:
        self._adapter.mark_uncertain(claim)

    def row(self, pk: Any, sk: Any) -> Any:
        return self._store.get(pk, sk)

    def inject_faults(self, kind: Any, count: Any = None) -> None:
        return self._store.inject(kind, count)

    def set_now(self, iso: Any) -> None:
        self._clock.set(iso)

    def init_unconfigured(self) -> None:
        Idempotency().init()

    def execute_unconfigured(self, request: Any) -> Any:
        return Idempotency().execute(request, self._work({"result": None}))


SUBJECTS = {"idempotency": IdempotencyFacade}
