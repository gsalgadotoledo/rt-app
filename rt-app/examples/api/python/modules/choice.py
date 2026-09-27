"""Choice: POST /admin/app/choice/decide (explicit grant choice.decide) with a local provider.

LocalChoiceProvider is for local development and the HTTP contracts only (choice-api): it answers
deterministically without a model. In a real app swap it here, e.g.
``Choice(JevProvider(os.environ["TYPESAFE_API_KEY"]))`` (rt_app.choice.jev).
"""
from dataclasses import replace
from typing import Any

from rt_app.choice import Choice


class LocalChoiceProvider:
    """Never for production: returns ``context.prediction`` when the context is an object that has
    one ("fail" raises); otherwise 1/n per option as uncalibrated scores, so decisions abstain."""

    id = "local"

    def predict(self, input: dict[str, Any], signal: Any = None) -> Any:
        context = input.get("context")
        if isinstance(context, dict) and "prediction" in context:
            if context["prediction"] == "fail":
                raise RuntimeError("Local choice provider failure")
            return context["prediction"]
        share = 1 / len(input["options"])
        return {
            "model": "local",
            "semantics": "uncalibrated-scores",
            "probabilities": {option["id"]: share for option in input["options"]},
        }


def features(components):
    feature = Choice(LocalChoiceProvider()).feature()
    # The TypeScript admin mount (/admin/app) only requires the local root and ignores
    # explicitGrant; rt_app.web applies it there too, which would lock the local owner out.
    # Drop the flag on this admin-only mount until rt_app.web matches (see docs/polyglot/choice.md).
    return [replace(feature, endpoints=[replace(e, explicit_grant=False) for e in feature.endpoints])]
