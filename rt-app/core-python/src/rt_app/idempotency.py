"""Persisted idempotency for side effects (port of ``@gsalgadotoledo/rt-app-idempotency``).

Compose it in ``app.py`` and inject it into the modules that charge, send or create things::

    idempotency = Singleton(lambda: create_idempotency(store.get()))

    receipt = idempotency.get().execute(
        {"scope": json.dumps(["shop", tenant_id, user_id, "charge", "v1"]), "key": order_id, "input": body},
        lambda ctx: gateway.charge(ctx.input, idempotency_key=ctx.idempotency_key),
    )

Semantics shared with TypeScript (see ``rt-app/docs/polyglot/idempotency.md``):

- The first call claims ``(scope, key)`` atomically as ``pending`` before running the work, then
  stores the JSON result as ``completed``. Retries with the same input replay that result without
  running the work; another input is ``CONFLICT``; an unfinished claim is ``PENDING``.
- A failed work (or a failed completion) marks the claim ``uncertain`` and raises ``UNCERTAIN``:
  the side effect may have happened, so it must be reconciled, never retried automatically.
- Nothing expires and nothing is taken over; the work receives a snapshot of the input and a stable
  ``idempotency_key`` to forward to the provider.
"""
from __future__ import annotations

import copy
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Final, Literal, Protocol, TypedDict, runtime_checkable

from . import _canonical, _js
from .contracts import Clock, epoch_ms, js_trim, to_datetime
from .errors import Conflict
from .nosql import NoSQL, Row

Json = Any
"""A JSON value: None, bool, int, float, str, list or dict with str keys."""

ErrorCode = Literal["NOT_CONFIGURED", "INVALID_JSON", "INVALID_KEY", "PENDING", "UNCERTAIN", "CONFLICT"]

MAX_SCOPE_LENGTH: Final = 512
MAX_KEY_LENGTH: Final = 256
PARTITION_PREFIX: Final = "IDEMPOTENCY#"


class IdempotencyError(Exception):
    """``RTAppIdempotencyError``: ``code`` is one of :data:`ErrorCode`; the message is ``RT-App idempotency: <code>``."""

    def __init__(self, code: ErrorCode) -> None:
        self.code = code
        self.message = f"RT-App idempotency: {code}"
        super().__init__(self.message)


class Claim(TypedDict):
    scope: str
    key: str
    fingerprint: str
    owner: str


class Decision(TypedDict, total=False):
    state: Literal["acquired", "pending", "uncertain", "conflict", "completed"]
    result: Json


@runtime_checkable
class IdempotencyStore(Protocol):
    """Implementations MUST claim atomically and persist before returning ``acquired``."""

    def claim(self, claim: Claim) -> Decision: ...

    def complete(self, claim: Claim, result: Json) -> None: ...

    def mark_uncertain(self, claim: Claim) -> None: ...


@dataclass(frozen=True)
class Context:
    """What the work receives: the input snapshot and the key to forward to the provider."""

    input: Json
    idempotency_key: str


def _invalid_json(_: str) -> IdempotencyError:
    return IdempotencyError("INVALID_JSON")


def canonical(value: Json) -> str:
    """Canonical JSON of the input (sorted keys, JavaScript numbers); INVALID_JSON otherwise."""
    return _canonical.canonical(value, _invalid_json)


def _valid_text(value: object, limit: int) -> bool:
    """A string that is not blank after JavaScript ``trim()`` and fits ``limit`` UTF-16 units."""
    return isinstance(value, str) and bool(js_trim(value)) and _js.utf16_length(value) <= limit


#: ``request`` has no ``input`` at all (JavaScript ``undefined``), which is not JSON.
_ABSENT: Final = object()


class Idempotency:
    """``RTAppIdempotencyModule``: runs a work at most once per ``(scope, key)``. No retries or takeover."""

    def __init__(self, store: IdempotencyStore | None = None) -> None:
        self.store = store

    def init(self) -> None:
        """Fail fast when no store is configured."""
        if self.store is None:
            raise IdempotencyError("NOT_CONFIGURED")

    def execute(self, request: dict[str, Any], work: Callable[[Context], Json]) -> Json:
        """Run ``work`` once for ``request = {scope, key, input}`` and replay its result afterwards.

        ``scope`` names the application, authenticated actor, operation and contract version;
        ``key`` is the stable operation id reused on every retry.
        """
        store = self.store
        if store is None:
            raise IdempotencyError("NOT_CONFIGURED")
        scope, key = request.get("scope"), request.get("key")
        if not _valid_text(scope, MAX_SCOPE_LENGTH) or not _valid_text(key, MAX_KEY_LENGTH):
            raise IdempotencyError("INVALID_KEY")
        raw = request.get("input", _ABSENT)
        if raw is _ABSENT:
            raise IdempotencyError("INVALID_JSON")
        serialized = canonical(raw)
        snapshot = _canonical.parse(serialized)
        claim: Claim = {
            "scope": scope,
            "key": key,
            "fingerprint": _canonical.sha256_hex(serialized),
            "owner": str(uuid.uuid4()),
        }
        idempotency_key = "rtapp-" + _canonical.sha256_hex(_js.stringify([scope, key]))
        decision = store.claim(claim)
        state = decision.get("state")
        if state == "completed":
            if "result" not in decision:  # undefined is not JSON
                raise IdempotencyError("INVALID_JSON")
            return _canonical.parse(canonical(decision["result"]))
        if state != "acquired":
            raise IdempotencyError(str(state).upper())  # type: ignore[arg-type]
        try:
            result = _canonical.parse(canonical(work(Context(snapshot, idempotency_key))))
            store.complete(claim, result)
            return result
        except BaseException as cause:
            # Never remove a claim on failure: the remote side effect may have succeeded, and a
            # failed completion acknowledgement may also mean the completion was persisted.
            try:
                store.mark_uncertain(claim)
            except Exception:  # noqa: BLE001 - pending remains non-replayable
                pass
            if not isinstance(cause, Exception):
                raise
            raise IdempotencyError("UNCERTAIN") from cause


class IdempotentModule:
    """Optional base class (``RTAppIdempotentModule``); composition with :class:`Idempotency` works too."""

    idempotency: Idempotency | None = None

    def execute_idempotent(self, request: dict[str, Any], work: Callable[[Context], Json]) -> Json:
        if self.idempotency is None:
            raise IdempotencyError("NOT_CONFIGURED")
        return self.idempotency.execute(request, work)


class NoSQLIdempotencyStore:
    """Persistent claims in a NoSQL store: ``pk "IDEMPOTENCY#" + scope``, ``sk key``. Never expires."""

    def __init__(self, store: NoSQL, *, now: Clock | None = None) -> None:
        self.store = store
        self._now = now

    def _timestamp(self) -> str:
        return _js.iso_timestamp(to_datetime(epoch_ms(self._now)))

    @staticmethod
    def _address(claim: Claim) -> tuple[str, str]:
        return PARTITION_PREFIX + claim["scope"], claim["key"]

    def claim(self, claim: Claim) -> Decision:
        """Conditional creation elects exactly one worker, even across processes."""
        pk, sk = self._address(claim)
        try:
            self.store.transact(
                [
                    {
                        "row": {
                            "pk": pk,
                            "sk": sk,
                            "version": 1,
                            "data": {
                                "fingerprint": claim["fingerprint"],
                                "owner": claim["owner"],
                                "state": "pending",
                                "createdAt": self._timestamp(),
                            },
                        },
                        "expected": None,
                    }
                ]
            )
            return {"state": "acquired"}
        except Conflict:
            row = self.store.get(pk, sk)
            if not row:
                raise
            data = row["data"]
            if data.get("fingerprint") != claim["fingerprint"]:
                return {"state": "conflict"}
            if data.get("state") == "completed":
                decision: Decision = {"state": "completed"}
                if "result" in data:
                    decision["result"] = copy.deepcopy(data["result"])
                return decision
            return {"state": "uncertain" if data.get("state") == "uncertain" else "pending"}

    def complete(self, claim: Claim, result: Json) -> None:
        """Save a replayable result, only for the worker that acquired the claim."""
        self._transition(claim, "completed", result)

    def mark_uncertain(self, claim: Claim) -> None:
        """Mark the claim uncertain; a completed row is never overwritten."""
        self._transition(claim, "uncertain")

    def _transition(self, claim: Claim, state: str, result: Json = None) -> None:
        pk, sk = self._address(claim)
        row: Row | None = self.store.get(pk, sk)
        if not row or row["data"].get("owner") != claim["owner"] or row["data"].get("fingerprint") != claim["fingerprint"]:
            raise Conflict()
        if row["data"].get("state") == "completed":
            return
        data = {**row["data"], "state": state, "updatedAt": self._timestamp()}
        if state == "completed":
            data["result"] = result
        self.store.transact([{"row": {**row, "version": row["version"] + 1, "data": data}, "expected": row["version"]}])


def create_idempotency(store: NoSQL, *, now: Clock | None = None) -> Idempotency:
    """An executor over a :class:`NoSQLIdempotencyStore` on ``store``."""
    executor = Idempotency(NoSQLIdempotencyStore(store, now=now))
    executor.init()
    return executor


__all__ = [
    "Idempotency",
    "IdempotencyError",
    "IdempotencyStore",
    "IdempotentModule",
    "NoSQLIdempotencyStore",
    "Claim",
    "Decision",
    "Context",
    "canonical",
    "create_idempotency",
]
