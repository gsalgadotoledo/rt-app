"""Queue: owner dead-letter endpoints over an in-memory adapter (local development).

    GET  /admin/app/queue/status          capabilities of the adapter
    POST /admin/app/queue/failed/inspect  {limit?} → dead letters
    POST /admin/app/queue/failed/retry    {token} → requeue one dead letter

Swap MemoryQueue for a broker adapter (SQS, RabbitMQ) here; workers share the same Queue.
"""
from rt_app import Singleton
from rt_app.queue import MemoryQueue, Queue

queue = Singleton(lambda: Queue(MemoryQueue()))


def features(components):
    return [queue.get().feature()]
