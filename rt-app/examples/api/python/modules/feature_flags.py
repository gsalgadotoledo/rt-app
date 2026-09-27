"""Feature flags over the shared store."""
from rt_app.feature_flags import FeatureFlags


def features(components):
    return [FeatureFlags(components.store.get()).feature()]
