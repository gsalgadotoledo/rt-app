"""Observer: POST /observer/events (guests, page views); GET /admin/app/observer/report and
/admin/app/observer/logs (owner only, served under /admin/app only).

Events are kept in the shared store (OBSERVER#<day> partitions, seven-day TTL). Add outputs here,
e.g. Output(ConsoleOutput(), levels=["info", "warn", "error"]) or a WebhookOutput; remote outputs
are server configuration and never come from clients.
"""
from rt_app.observer import Observer, ObserverStore, Output, observer_feature


def features(components):
    storage = ObserverStore(components.store.get())
    observer = Observer([Output(storage)])
    return [observer_feature(observer, storage)]
