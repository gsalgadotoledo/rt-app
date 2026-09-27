"""Choice provider over an injected zero-shot classifier (port of ``@gsalgadotoledo/rt-app-choice-transformers``).

    from transformers import pipeline                       # installed and owned by the app
    classifier = pipeline("zero-shot-classification", model="MoritzLaurer/deberta-v3-base-zeroshot-v2.0")
    Choice(TransformersChoiceProvider(classifier, "deberta-v3-base-zeroshot-v2.0"))

The pipeline is called as ``pipeline(text, labels, multi_label=False)`` (the Hugging Face
``ZeroShotClassificationPipeline`` signature) and must return ``{"labels": [...], "scores": [...]}``.
NLI label scores are uncalibrated: ``Choice`` abstains by default even with a high score. The
signal is checked before and after inference; it does not interrupt a running model. Contract:
rt-app/spec/contracts/choice-transformers.contract.yaml.
"""
from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any, Protocol

from . import AbortSignal, throw_if_aborted, validate_choice
from ._json import stringify

__all__ = ["InvalidClassifierResponse", "TransformersChoiceProvider", "ZeroShotPipeline", "classifier_text", "labels_for"]


class ZeroShotPipeline(Protocol):
    def __call__(self, text: str, labels: list[str], *, multi_label: bool) -> Any: ...


class InvalidClassifierResponse(Exception):
    def __init__(self) -> None:
        super().__init__("Invalid classifier response")
        self.message = "Invalid classifier response"


def labels_for(snapshot: Mapping[str, Any]) -> list[str]:
    """One label per option: ``id`` or ``id: description`` (a non-empty description)."""
    return [o["id"] + (": " + o["description"] if o.get("description") else "") for o in snapshot["options"]]


def classifier_text(snapshot: Mapping[str, Any]) -> str:
    """``question + "\\n\\n" + JSON.stringify(context)``; a missing context is ``undefined``."""
    context = stringify(snapshot["context"]) if "context" in snapshot else "undefined"
    return snapshot["question"] + "\n\n" + context


class TransformersChoiceProvider:
    """Inject a zero-shot-classification pipeline; weights load only in the owning app."""

    id = "transformers"

    def __init__(self, pipeline: ZeroShotPipeline, model: str) -> None:
        self.pipeline = pipeline
        self.model = model

    def predict(self, input: Any, signal: AbortSignal | None = None) -> dict[str, Any]:
        snapshot = validate_choice(input)
        throw_if_aborted(signal)
        labels = labels_for(snapshot)
        result = self.pipeline(classifier_text(snapshot), labels, multi_label=False)
        throw_if_aborted(signal)
        got = result.get("labels") if isinstance(result, Mapping) else None
        scores = result.get("scores") if isinstance(result, Mapping) else None
        if (
            not isinstance(got, Sequence)
            or isinstance(got, str)
            or not isinstance(scores, Sequence)
            or isinstance(scores, str)
            or len(got) != len(labels)
            or len(scores) != len(labels)
            or not all(isinstance(label, str) and label in labels for label in got)
            or len(set(got)) != len(labels)
        ):
            raise InvalidClassifierResponse()
        got = list(got)
        return {
            "model": self.model,
            "semantics": "uncalibrated-scores",
            "probabilities": {o["id"]: scores[got.index(label)] for o, label in zip(snapshot["options"], labels)},
        }
