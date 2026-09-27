"""Choice provider for the TypeSafe Jev System One API (port of ``@gsalgadotoledo/rt-app-choice-jev``).

    JevProvider(os.environ["TYPESAFE_API_KEY"])                    # urllib, 15 s deadline
    JevProvider(key, "jev-latest", transport=my_transport, timeout_ms=5000)

One request per call, no implicit (billable) retries, redirects refused. Failures never echo the
response body: ``Jev request failed: HTTP <status>`` or ``Invalid Jev response``. Contract:
rt-app/spec/contracts/choice-jev.contract.yaml.
"""
from __future__ import annotations

import urllib.error
import urllib.request
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from typing import Any

from .. import _js
from .._jsnum import js_trim
from . import AbortSignal, throw_if_aborted, validate_choice
from ._json import quote, stringify

__all__ = ["JEV_URL", "HttpRequest", "HttpResponse", "JevError", "JevProvider", "Transport", "urllib_transport"]

JEV_URL = "https://api.typesafe.ai/v1/systemone"


@dataclass(frozen=True)
class HttpRequest:
    url: str
    method: str
    headers: dict[str, str]
    body: bytes
    #: Deadline of the whole request, in seconds.
    timeout: float
    signal: AbortSignal | None = field(default=None, compare=False)


@dataclass(frozen=True)
class HttpResponse:
    status: int
    body: bytes = b""


#: Sends one request; must not follow redirects. Raise on network errors.
Transport = Callable[[HttpRequest], HttpResponse]


class JevError(Exception):
    """A failed Jev call; the message never includes the response body."""

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


class _NoRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args: Any, **kwargs: Any) -> None:
        raise urllib.error.URLError("Redirects are refused")


_opener = urllib.request.build_opener(_NoRedirects)


def urllib_transport(request: HttpRequest) -> HttpResponse:
    """Default transport (stdlib): refuses redirects; the body of a failure is never read."""
    outgoing = urllib.request.Request(request.url, data=request.body, headers=request.headers, method=request.method)
    try:
        with _opener.open(outgoing, timeout=request.timeout) as response:
            return HttpResponse(response.status, response.read())
    except urllib.error.HTTPError as error:
        error.close()
        return HttpResponse(error.code)


def _decode(body: bytes) -> str:
    """``Response.text()``: UTF-8 with a leading BOM removed and invalid bytes replaced."""
    return body.decode("utf-8", "replace").removeprefix("\ufeff")


def _criteria(options: list[dict[str, Any]]) -> str:
    """``Object.fromEntries(options → [id, description ?? null])`` written by JSON.stringify."""
    return stringify({o["id"]: o.get("description") for o in options})


class JevProvider:
    """Official TypeSafe System One wire format; no implicit billable retries."""

    id = "jev"

    def __init__(
        self,
        api_key: str,
        model: str = "jev-latest",
        transport: Transport | None = None,
        timeout_ms: float = 15000,
    ) -> None:
        if (
            not isinstance(api_key, str)
            or not js_trim(api_key)
            or not isinstance(model, str)
            or not js_trim(model)
            or not _js.is_finite_number(timeout_ms)
            or timeout_ms < 1
        ):
            raise TypeError("Invalid Jev configuration")
        self._api_key = api_key
        self.model = model
        self.transport = transport or urllib_transport
        self.timeout_ms = timeout_ms

    def body(self, snapshot: dict[str, Any]) -> str:
        """The request body, byte-identical to the reference (``state`` absent without context)."""
        state = "" if "context" not in snapshot else ',"state":' + stringify(snapshot["context"])
        return (
            '{"model":' + quote(self.model) + state + ',"questions":{"decision":{"type":"choice","instructions":'
            + quote(snapshot["question"]) + ',"criteria":' + _criteria(snapshot["options"]) + "}}}"
        )

    def predict(self, input: Any, signal: AbortSignal | None = None) -> dict[str, Any]:
        """Send one named Choice; ``Choice.decide`` validates the returned distribution."""
        snapshot = validate_choice(input)
        throw_if_aborted(signal)
        response = self.transport(
            HttpRequest(
                url=JEV_URL,
                method="POST",
                headers={"authorization": "Bearer " + self._api_key, "content-type": "application/json"},
                body=self.body(snapshot).encode("utf-8"),
                timeout=self.timeout_ms / 1000,
                signal=signal,
            )
        )
        throw_if_aborted(signal)
        if not 200 <= response.status <= 299:
            raise JevError(f"Jev request failed: HTTP {response.status}")
        try:
            data = _js.parse(_decode(response.body))
        except ValueError:
            raise JevError("Invalid Jev response") from None
        answers = data.get("answers") if isinstance(data, Mapping) else None
        decision = answers.get("decision") if isinstance(answers, Mapping) else None
        if not isinstance(decision, Mapping) or decision.get("type") != "choice":
            raise JevError("Invalid Jev response")
        prediction: dict[str, Any] = {}
        # Absent fields stay absent (JavaScript undefined); Choice rejects what is missing.
        if "model" in data:
            prediction["model"] = data["model"]
        if "probabilities" in decision:
            prediction["probabilities"] = decision["probabilities"]
        if "confidence" in decision:
            prediction["confidence"] = decision["confidence"]
        prediction["semantics"] = "model-probabilities"
        return prediction
