"""Typed decisions with explicit abstention (port of ``@gsalgadotoledo/rt-app-choice``).

    from rt_app.choice import Choice
    from rt_app.choice.jev import JevProvider
    choices = Choice(JevProvider(os.environ["TYPESAFE_API_KEY"]))
    choices.decide({"context": "Refund please", "question": "Route?",
                    "options": [{"id": "billing"}, {"id": "sales"}]})

A provider turns ``{context, question, options}`` into a probability per option; ``Choice``
validates the input and the provider's answer and only *accepts* a clear winner. The probability is
not measured accuracy: calibrate on your own labeled data. Contract:
rt-app/spec/contracts/choice.contract.yaml (semantics in rt-app/docs/polyglot/choice.md).

Values follow JSON/JavaScript rules: a provider answer is a dict whose ``confidence`` key is left
out when there is none (``None`` is JSON null, which is invalid). Cancellation uses any object with
``is_set()`` (``threading.Event``), checked before and after the provider call.
"""
from __future__ import annotations

import copy
from collections.abc import Mapping
from typing import Any, Literal, NotRequired, Protocol, TypedDict

from .._js import is_finite_number, utf16_length
from .._jsnum import js_trim
from ..errors import HttpError
from ..web import Context, Endpoint, Feature
from ._json import canonical, snapshot

__all__ = [
    "ABORTED",
    "AbortError",
    "AbortSignal",
    "Choice",
    "ChoiceProvider",
    "InvalidProviderResponse",
    "Prediction",
    "throw_if_aborted",
    "validate_choice",
]

MAX_QUESTION = 4000
MAX_OPTIONS = 255
MAX_DESCRIPTION = 2000
MAX_INPUT_BYTES = 128000
SEMANTICS = ("model-probabilities", "uncalibrated-scores")
#: Message of a cancelled call (the DOMException AbortError of the reference).
ABORTED = "This operation was aborted"

_ID_CHARS = frozenset("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-")


class AbortSignal(Protocol):
    """A cancellation flag, e.g. ``threading.Event``."""

    def is_set(self) -> bool: ...


class AbortError(Exception):
    """The call was cancelled through its signal."""

    def __init__(self, message: str = ABORTED) -> None:
        super().__init__(message)
        self.message = message


class InvalidProviderResponse(Exception):
    """The provider answered something that is not a distribution over the options."""

    def __init__(self) -> None:
        super().__init__("Invalid choice provider response")
        self.message = "Invalid choice provider response"


class Prediction(TypedDict):
    probabilities: dict[str, float]
    model: str
    semantics: Literal["model-probabilities", "uncalibrated-scores"]
    confidence: NotRequired[float]


class ChoiceProvider(Protocol):
    """Evaluates one validated snapshot; ``Choice.decide`` validates the answer."""

    @property
    def id(self) -> str: ...

    def predict(self, input: dict[str, Any], signal: AbortSignal | None = None) -> Any: ...


def throw_if_aborted(signal: AbortSignal | None) -> None:
    """``signal.throwIfAborted()``."""
    if signal is not None and signal.is_set():
        raise AbortError()


def _valid_id(value: object) -> bool:
    """``/^[a-zA-Z0-9_-]{1,80}$/`` (ASCII only; no trailing newline)."""
    return isinstance(value, str) and 1 <= len(value) <= 80 and all(c in _ID_CHARS for c in value)


def _valid_option(option: object) -> bool:
    if not isinstance(option, dict) or not _valid_id(option.get("id")):
        return False
    if "description" not in option:
        return True
    description = option["description"]  # null counts as present, like the reference
    return isinstance(description, str) and utf16_length(description) <= MAX_DESCRIPTION


def validate_choice(input: Any) -> dict[str, Any]:
    """Reject malformed input before a provider sees it; return the canonical snapshot (a copy).

    Raises ``HttpError(400)``: "Invalid choice question or options", "Invalid or duplicate option"
    or "Choice input too large" (canonical JSON over 128000 UTF-8 bytes), in that order.
    """
    question = input.get("question") if isinstance(input, dict) else None
    options = input.get("options") if isinstance(input, dict) else None
    if (
        not isinstance(question, str)
        or not js_trim(question)
        or utf16_length(question) > MAX_QUESTION
        or not isinstance(options, list)
        or not 2 <= len(options) <= MAX_OPTIONS
    ):
        raise HttpError(400, "Invalid choice question or options")
    if not all(_valid_option(o) for o in options) or len({o["id"] for o in options}) != len(options):
        raise HttpError(400, "Invalid or duplicate option")
    if len(canonical(input).encode("utf-8")) > MAX_INPUT_BYTES:
        raise HttpError(400, "Choice input too large")
    return snapshot(input)


def _threshold(policy: Mapping[str, Any], name: str, default: float) -> Any:
    value = policy.get(name)
    return default if value is None else value  # `??`: null and missing take the default


def _probabilities(result: Any, keys: list[str]) -> dict[str, Any] | list[Any]:
    """The provider's probabilities as JavaScript reads them; raise unless one per option."""
    probabilities = result.get("probabilities") if isinstance(result, Mapping) else None
    if isinstance(probabilities, Mapping):
        own = {str(k): v for k, v in probabilities.items()}
    elif isinstance(probabilities, list):  # Object.keys of an array: its indexes
        own = {str(i): v for i, v in enumerate(probabilities)}
    else:  # null, strings, numbers and booleans never give one number per option
        raise InvalidProviderResponse()
    if len(own) != len(keys) or any(
        k not in own or not is_finite_number(own[k]) or not 0 <= own[k] <= 1 for k in keys
    ):
        raise InvalidProviderResponse()
    total = 0.0
    for k in keys:
        total += own[k]
    if abs(total - 1) > 0.001:
        raise InvalidProviderResponse()
    return own


def _check(result: Any, keys: list[str]) -> dict[str, Any]:
    probabilities = _probabilities(result, keys)
    model = result.get("model")
    if not isinstance(model, str) or not model or result.get("semantics") not in SEMANTICS:
        raise InvalidProviderResponse()
    if "confidence" in result:
        confidence = result["confidence"]
        if not is_finite_number(confidence) or not 0 <= confidence <= 1:
            raise InvalidProviderResponse()
    return probabilities


class Choice:
    """Typed decisions with explicit abstention; probability is not measured accuracy."""

    def __init__(self, provider: ChoiceProvider) -> None:
        self.provider = provider

    def decide(
        self,
        input: Any,
        policy: Mapping[str, Any] | None = None,
        signal: AbortSignal | None = None,
    ) -> dict[str, Any]:
        """Validate, ask the provider, and accept only a clear, calibrated winner.

        ``policy``: ``minProbability`` (default 0.8), ``minMargin`` (default 0.1), both in [0, 1],
        and ``allowUncalibrated`` (only ``True`` accepts uncalibrated scores). Returns the provider
        answer plus ``provider``, ``selected``, ``accepted`` and ``requiresReview``.
        """
        snap = validate_choice(input)
        policy = policy if isinstance(policy, Mapping) else {}
        minimum = _threshold(policy, "minProbability", 0.8)
        margin = _threshold(policy, "minMargin", 0.1)
        if not all(is_finite_number(n) and 0 <= n <= 1 for n in (minimum, margin)):
            raise HttpError(400, "Invalid choice policy")
        throw_if_aborted(signal)
        result = self.provider.predict(snap, signal)
        throw_if_aborted(signal)
        keys = [option["id"] for option in snap["options"]]
        probabilities = _check(result, keys)
        # Stable: ties keep the option order.
        ranked = sorted(keys, key=lambda k: -probabilities[k])
        top, second = probabilities[ranked[0]], probabilities[ranked[1]]
        accepted = (
            top >= minimum
            and top - second >= margin
            and top > second
            and (result["semantics"] != "uncalibrated-scores" or policy.get("allowUncalibrated") is True)
        )
        return {
            "provider": self.provider.id,
            **copy.deepcopy(dict(result)),
            "selected": ranked[0],
            "accepted": accepted,
            "requiresReview": not accepted,
        }

    def feature(self) -> Feature:
        """Opt-in API/CLI/MCP exposure; the caller must hold ``choice.decide`` explicitly."""
        return Feature(
            id="choice",
            endpoints=[
                Endpoint(
                    method="POST",
                    path="/choice/decide",
                    resource="choice.decide",
                    access="permission",
                    explicit_grant=True,
                    tool={
                        "name": "choice_decide",
                        "description": "Evaluate context against named options. May incur provider usage. "
                        "Low-certainty decisions require review.",
                        "example": {
                            "body": {
                                "context": "Refund please",
                                "question": "Route?",
                                "options": [{"id": "billing"}, {"id": "sales"}],
                            }
                        },
                    },
                    handle=self._handle,
                )
            ],
        )

    def _handle(self, context: Context) -> dict[str, Any]:
        return self.decide(context.request.body)
