"""Subjects: choice, choice-jev, choice-transformers (mirrors hosts/node/choice.mjs).

Providers are faked from ``init`` so no network or model is used. Wire null means "not given".
"""
from __future__ import annotations

import copy
import json
import threading
from typing import Any

from rt_app.choice import Choice, validate_choice
from rt_app.choice.jev import HttpRequest, HttpResponse, JevProvider
from rt_app.choice.transformers import TransformersChoiceProvider
from rt_app.web import Context, Request


def _signal(when: str) -> threading.Event:
    """"before": already aborted; "during": the fake aborts it while it runs."""
    if when not in ("before", "during"):
        raise ValueError('when must be "before" or "during"')
    event = threading.Event()
    if when == "before":
        event.set()
    return event


class _FakeProvider:
    def __init__(self, init: dict[str, Any], owner: ChoiceFacade) -> None:
        self.id = init.get("id") or "fake"
        self._init = init
        self._owner = owner

    def predict(self, input: dict[str, Any], signal: Any = None) -> Any:
        self._owner.received.append(copy.deepcopy(input))
        if self._owner.during is not None:
            self._owner.during.set()
        if self._init.get("error") is not None:
            raise RuntimeError(self._init["error"])
        return copy.deepcopy(self._init.get("prediction"))


class ChoiceFacade:
    """Choice over a fake provider answering init.prediction (or raising init.error)."""

    def __init__(self, init: dict[str, Any]) -> None:
        self.received: list[Any] = []
        self.during: threading.Event | None = None
        self.module = Choice(_FakeProvider(init, self))

    def validate_choice(self, input: Any) -> Any:
        return validate_choice(input)

    def decide(self, input: Any, policy: Any = None) -> Any:
        return self.module.decide(input, policy)

    def decide_aborted(self, input: Any, policy: Any, when: str) -> Any:
        signal = _signal(when)
        if when == "during":
            self.during = signal
        return self.module.decide(input, policy, signal)

    def calls(self) -> list[Any]:
        return self.received

    def feature(self) -> Any:
        feature = self.module.feature()
        return {
            "id": feature.id,
            "migrations": [],
            "endpoints": [
                {
                    "method": e.method,
                    "path": e.path,
                    "resource": e.resource,
                    "access": e.access,
                    "explicitGrant": e.explicit_grant,
                    "tool": e.tool,
                }
                for e in feature.endpoints
            ],
        }

    def handle(self, body: Any) -> Any:
        endpoint = self.module.feature().endpoints[0]
        return endpoint.handle(Context(request=Request(method="POST", path=endpoint.path, body=body), params={}))


class JevFacade:
    """JevProvider over a fake transport answering init.responses in order."""

    def __init__(self, init: dict[str, Any]) -> None:
        self.sent: list[Any] = []
        self.responses = list(init.get("responses") or [])
        options: dict[str, Any] = {}
        if init.get("model") is not None:
            options["model"] = init["model"]
        if init.get("timeoutMs") is not None:
            options["timeout_ms"] = init["timeoutMs"]
        self.provider = JevProvider(init.get("apiKey"), transport=self._transport, **options)  # type: ignore[arg-type]
        self.module = Choice(self.provider)

    def _transport(self, request: HttpRequest) -> HttpResponse:
        text = request.body.decode("utf-8")
        self.sent.append(
            {"url": request.url, "method": request.method, "headers": dict(request.headers), "body": json.loads(text), "text": text}
        )
        if not self.responses:
            raise RuntimeError("No fake response left")
        answer = self.responses.pop(0)
        if answer.get("error") is not None:
            raise RuntimeError(answer["error"])
        if answer.get("text") is not None:
            body = answer["text"]
        elif "json" in answer:
            body = json.dumps(answer["json"])
        else:
            body = ""
        return HttpResponse(answer.get("status") or 200, body.encode("utf-8"))

    def id(self) -> str:
        return self.provider.id

    def predict(self, input: Any) -> Any:
        return self.provider.predict(input)

    def decide(self, input: Any, policy: Any = None) -> Any:
        return self.module.decide(input, policy)

    def requests(self) -> list[Any]:
        return self.sent


class TransformersFacade:
    """TransformersChoiceProvider over a fake pipeline answering init.results in order."""

    def __init__(self, init: dict[str, Any]) -> None:
        self.received: list[Any] = []
        self.results = list(init.get("results") or [])
        self.during: threading.Event | None = None
        self.provider = TransformersChoiceProvider(self._pipeline, init.get("model"))  # type: ignore[arg-type]
        self.module = Choice(self.provider)

    def _pipeline(self, text: str, labels: list[str], *, multi_label: bool) -> Any:
        self.received.append({"text": text, "labels": list(labels), "options": {"multi_label": multi_label}})
        if self.during is not None:
            self.during.set()
        if not self.results:
            raise RuntimeError("No fake result left")
        result = self.results.pop(0)
        if isinstance(result, dict) and result.get("error") is not None:
            raise RuntimeError(result["error"])
        return result

    def id(self) -> str:
        return self.provider.id

    def predict(self, input: Any) -> Any:
        return self.provider.predict(input)

    def predict_aborted(self, input: Any, when: str) -> Any:
        signal = _signal(when)
        if when == "during":
            self.during = signal
        return self.provider.predict(input, signal)

    def decide(self, input: Any, policy: Any = None) -> Any:
        return self.module.decide(input, policy)

    def calls(self) -> list[Any]:
        return self.received


SUBJECTS = {
    "choice": ChoiceFacade,
    "choice-jev": JevFacade,
    "choice-transformers": TransformersFacade,
}
