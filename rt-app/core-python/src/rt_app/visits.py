"""Visit sessions: a tiny diagnostic sample of pointer and scroll positions (TypeScript is the reference).

One row ``{pk: "VISITS", sk: "recent"}`` holds at most 10 sessions of at most 120 points each and is
replaced atomically with version-guarded writes. Browsers get a signed token from
``POST /visits/start`` and send batches to ``POST /visits/events``; the owner reads and deletes
sessions under ``/admin/app/visits``. Tokens are ``base64url(JSON {"id", "startedAt"})`` plus
``base64url(HMAC-SHA256(secret, "visits:" + payload))`` and valid for 30 minutes, so any language
verifies the tokens another one issued. Rate limits are per instance (60 calls per ip per minute).
"""
from __future__ import annotations

import copy
import hashlib
import hmac
import math
import re
import threading
import uuid
from collections.abc import Callable, Mapping, Sequence
from typing import Any, Final, TypedDict

from . import _js
from ._jsnum import utf8
from .contracts import Clock, epoch_ms
from .errors import Conflict, HttpError
from .nosql import NoSQL
from .web.app import Context, Endpoint, Feature

PARTITION: Final = "VISITS"
SORT_KEY: Final = "recent"
MAX_POINTS: Final = 120
MAX_SESSIONS: Final = 10
MAX_AGE: Final = 86_400_000
TOKEN_AGE: Final = 1_800_000
RATE_WINDOW: Final = 60_000
RATE_LIMIT: Final = 60
MAX_CLIENTS: Final = 2000
DEFAULT_PAGES: Final = ("/", "/about", "/services")
POINT_TYPES: Final = ("move", "click", "scroll", "page")

_PAGE = re.compile(r"/[a-zA-Z0-9/_-]{0,79}")
_SIGNATURE = re.compile(r"[A-Za-z0-9_-]{43}")


class VisitPoint(TypedDict):
    type: str
    path: str
    t: int
    x: int
    y: int


class Visit(TypedDict):
    id: str
    startedAt: int
    updatedAt: int
    sequence: int
    points: list[VisitPoint]


def _is_integer(value: object) -> bool:
    """``Number.isInteger``: a finite number without a fraction (1.0 counts, True does not)."""
    return _js.is_finite_number(value) and float(value).is_integer()  # type: ignore[arg-type]


def _new_id() -> str:
    return str(uuid.uuid4())


class Visits:
    """Tiny diagnostic sample: one atomically replaced document, at most 10 x 120 points."""

    def __init__(
        self,
        store: NoSQL,
        secret: str,
        pages: Sequence[str] = DEFAULT_PAGES,
        *,
        now: Clock | None = None,
        new_id: Callable[[], str] = _new_id,
    ) -> None:
        if not isinstance(secret, str) or _js.utf16_length(secret) < 32:
            raise ValueError("Visits requires a server secret of at least 32 characters")
        pages = list(pages)
        if len(pages) > 30 or any(not isinstance(path, str) or not _PAGE.fullmatch(path) for path in pages):
            raise ValueError("Invalid public visit pages")
        self.store = store
        self.pages = pages
        self._key = utf8(secret)
        self._now = now
        self._new_id = new_id
        self._rates: dict[str, dict[str, float]] = {}
        self._rates_lock = threading.Lock()

    def _clock(self) -> int:
        return int(epoch_ms(self._now))

    def _signature(self, value: str) -> str:
        digest = hmac.new(self._key, utf8("visits:" + value), hashlib.sha256).digest()
        return _js.base64url_encode(digest)

    def sign(self, payload: str) -> str:
        """``payload + "." + signature``: the token format (tests and other languages use it)."""
        return payload + "." + self._signature(payload)

    def _token(self, value: object) -> dict[str, Any]:
        if not isinstance(value, str) or _js.utf16_length(value) > 500:
            raise HttpError(400, "Invalid visit token")
        payload, *parts = value.split(".")
        signature = parts[0] if parts else ""
        expected = self._signature(payload)
        if (
            len(parts) != 1
            or not signature
            or not _SIGNATURE.fullmatch(signature)
            or len(signature) != len(expected)
            or not hmac.compare_digest(signature, expected)
        ):
            raise HttpError(400, "Invalid visit token")
        try:
            parsed = _js.parse(_js.base64url_decode(payload).decode("utf-8", "replace"))
            now = self._clock()
            if (
                not isinstance(parsed, dict)
                or not isinstance(parsed.get("id"), str)
                or not _js.is_safe_integer(parsed.get("startedAt"))
                or parsed["startedAt"] > now
                or now - parsed["startedAt"] > TOKEN_AGE
            ):
                raise ValueError("expired or invalid")
        except Exception:
            raise HttpError(400, "Expired or invalid visit token") from None
        return {"id": parsed["id"], "startedAt": int(parsed["startedAt"])}

    def _rate(self, ip: str) -> None:
        """Limits are per instance; use API Gateway/WAF for public distributed traffic."""
        now = self._clock()
        key = hashlib.sha256(utf8(ip)).hexdigest()
        with self._rates_lock:
            for known, value in list(self._rates.items()):
                if now - value["at"] >= RATE_WINDOW:
                    del self._rates[known]
            if len(self._rates) >= MAX_CLIENTS and key not in self._rates:
                raise HttpError(429, "Visits busy")
            value = self._rates.setdefault(key, {"at": now, "count": 0})
            value["count"] += 1
            if value["count"] > RATE_LIMIT:
                raise HttpError(429, "Visit rate limit")

    def start(self, ip: str) -> dict[str, Any]:
        self._rate(ip)
        payload = _js.base64url_encode(utf8(_js.stringify({"id": self._new_id(), "startedAt": self._clock()})))
        return {"token": self.sign(payload), "maxPoints": MAX_POINTS, "pages": list(self.pages)}

    def _point(self, point: object) -> VisitPoint:
        if not (
            isinstance(point, dict)
            and isinstance(point.get("type"), str)
            and point["type"] in POINT_TYPES
            and isinstance(point.get("path"), str)
            and point["path"] in self.pages
            and _js.is_safe_integer(point.get("t"))
            and 0 <= point["t"] <= TOKEN_AGE
            and _is_integer(point.get("x"))
            and _is_integer(point.get("y"))
            and 0 <= point["x"] <= 100
            and 0 <= point["y"] <= 100
        ):
            raise HttpError(400, "Invalid visit point")
        return {"type": point["type"], "path": point["path"], "t": int(point["t"]), "x": int(point["x"]), "y": int(point["y"])}

    def ingest(self, input: Mapping[str, Any], ip: str) -> dict[str, bool]:
        """Append a batch ``{token, sequence, points}``; replays (sequence not increasing) are ignored."""
        self._rate(ip)
        body = input if isinstance(input, Mapping) else {}
        identity = self._token(body.get("token"))
        sequence, raw_points = body.get("sequence"), body.get("points")
        if (
            not _js.is_safe_integer(sequence)
            or sequence < 1
            or not isinstance(raw_points, list)
            or not raw_points
            or len(raw_points) > 20
        ):
            raise HttpError(400, "Invalid visit batch")
        points = [self._point(point) for point in raw_points]
        recorded = False

        def apply(sessions: list[Visit]) -> list[Visit]:
            nonlocal recorded
            session = next((value for value in sessions if value["id"] == identity["id"]), None)
            if session is not None and sequence <= session["sequence"]:
                return sessions
            now = self._clock()
            if session is None:
                session = {**identity, "updatedAt": now, "sequence": 0, "points": []}  # type: ignore[typeddict-item]
                sessions.append(session)
            session["sequence"] = int(sequence)
            session["updatedAt"] = now
            session["points"].extend(points[: MAX_POINTS - len(session["points"])])
            # Newest first, then id (UUIDs: code point order equals JavaScript localeCompare).
            sessions.sort(key=lambda value: (-value["startedAt"], value["id"]))
            retained = sessions[:MAX_SESSIONS]
            recorded = any(value["id"] == identity["id"] for value in retained)
            return retained

        self._update(apply)
        return {"ok": True, "recorded": recorded}

    def _update(self, operation: Callable[[list[Visit]], list[Visit]]) -> list[Visit]:
        for attempt in range(5):
            row = self.store.get(PARTITION, SORT_KEY)
            now = self._clock()
            stored = (row["data"].get("sessions") if row else None) or []
            sessions = [session for session in stored if session["startedAt"] > now - MAX_AGE]
            result = operation(copy.deepcopy(sessions))
            try:
                self.store.transact([
                    {
                        "row": {
                            "pk": PARTITION,
                            "sk": SORT_KEY,
                            "version": (row["version"] if row else 0) + 1,
                            "ttl": math.ceil((now + MAX_AGE) / 1000),
                            "data": {"sessions": result},
                        },
                        "expected": row["version"] if row else None,
                    }
                ])
                return result
            except Conflict:
                if attempt == 4:
                    raise
        raise HttpError(409, "Visit update conflict")

    def _read(self) -> list[Visit]:
        row = self.store.get(PARTITION, SORT_KEY)
        sessions: list[Visit] = (row["data"].get("sessions") if row else None) or []
        now = self._clock()
        if any(session["startedAt"] <= now - MAX_AGE for session in sessions):
            return self._update(lambda value: value)
        return sessions

    def list(self) -> dict[str, Any]:
        items = []
        for session in self._read():
            summary = {k: v for k, v in session.items() if k != "points"}
            summary["events"] = len(session["points"])
            summary["pages"] = list(dict.fromkeys(point["path"] for point in session["points"]))
            items.append(summary)
        return {"items": items, "limit": MAX_SESSIONS, "maxPoints": MAX_POINTS}

    def detail(self, id: str) -> Visit:
        for session in self._read():
            if session["id"] == id:
                return session
        raise HttpError(404, "Visit not found")

    def remove(self, id: str) -> dict[str, bool]:
        self._update(lambda sessions: [value for value in sessions if value["id"] != id])
        return {"ok": True}

    def feature(self) -> Feature:
        """Public capture endpoints; reading and deleting sessions is owner-only."""

        def start(ctx: Context) -> Any:
            return self.start(ctx.request.ip)

        def events(ctx: Context) -> Any:
            return self.ingest(ctx.request.body, ctx.request.ip)

        return Feature(
            id="visits",
            admin={
                "id": "visits",
                "title": "Visit sessions",
                "resource": "visits.read",
                "path": "/visits",
                "component": "visits",
                "ownerOnly": True,
                "fields": [],
                "actions": [],
            },
            endpoints=[
                Endpoint(method="POST", path="/visits/start", resource="visits.capture", access="guest", handle=start),
                Endpoint(method="POST", path="/visits/events", resource="visits.capture", access="guest", handle=events),
                Endpoint(method="GET", path="/visits", resource="visits.read", access="owner", handle=lambda _: self.list()),
                Endpoint(method="GET", path="/visits/:id", resource="visits.read", access="owner", handle=lambda ctx: self.detail(ctx.params["id"])),
                Endpoint(method="DELETE", path="/visits/:id", resource="visits.delete", access="owner", handle=lambda ctx: self.remove(ctx.params["id"])),
            ],
        )


__all__ = ["Visits", "Visit", "VisitPoint", "DEFAULT_PAGES", "MAX_POINTS", "MAX_SESSIONS"]
