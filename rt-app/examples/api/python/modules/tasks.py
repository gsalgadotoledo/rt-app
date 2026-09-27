"""Tasks: personal endpoints (/tasks…, need a session) and admin endpoints under /admin/app/tasks/admin."""
from rt_app.tasks import Tasks


def features(components):
    return [Tasks(components.store.get()).feature()]
