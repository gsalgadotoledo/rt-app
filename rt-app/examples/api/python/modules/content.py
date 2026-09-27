"""Home content: GET / and the settings under /admin/app/content/settings."""
from rt_app.content import Content


def features(components):
    return [Content(components.store.get()).feature()]
