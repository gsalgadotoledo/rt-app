# RT-App Python core

Package distribution: `rt-app-core`; Python import: `rt_app_core`. This is a local, independently packageable library; it has not been published to PyPI. Python 3.11+, no runtime dependencies.

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -e /absolute/path/to/rt-app/core-python
.venv/bin/python /absolute/path/to/rt-app/core-python/examples/hello.py
```

Build an installable wheel with `python -m pip wheel --no-deps /path/to/core-python -w dist`. Once a public release exists, installation will be `python -m pip install rt-app-core==<version>` (not available yet). Use a virtual environment; the desktop-generated backend creates one automatically and installs this local library in editable mode.

## Community-style composition

Use normal classes/functions, keyword arguments, `functools.partial`, `typing.Protocol`, and context managers. There is no required base class or metaclass, and there is no global container.

```python
from functools import partial
from typing import Protocol
from rt_app_core import Singleton
from my_app.adapters.smtp import Mailer  # replace with another compatible adapter

class MailSender(Protocol):
    def send(self, recipient: str) -> None: ...
    def close(self) -> None: ...

mailer: Singleton[MailSender] = Singleton(
    partial(Mailer, host="localhost", port=1025),
    close=lambda instance: instance.close(),
)
with mailer:
    sender = mailer.get()  # initialized once; inject this into your handlers
```

Create providers inside `create_app`, not at module-import time. For multiple resources, `contextlib.ExitStack` gives reverse-order cleanup; enter dependencies before consumers. The working `examples/hello.py` shows a typed application and two interchangeable adapters. Swapping only the import works when constructor contracts match; differing credentials/options belong in the composition root.

For async applications:

```python
from rt_app_core import AsyncSingleton

async with AsyncSingleton(open_database, close=lambda db: db.aclose()) as database:
    db = await database.get()
```

`AsyncSingleton` belongs to one event loop and shares an initialization task. Cancelling a caller waiting for `get` does not cancel the shared factory. Async close waits for initialization and performs cleanup once, including if an awaiting closer is cancelled. Always close at application shutdown; do not capture request secrets/state inside a singleton factory. Async factories must release partially acquired resources on failure or cancellation.

## Guarantees and limits

Initialization is lazy and exactly once per provider on ordinary success/failure. A failing factory produces a sticky `InitializationError`; create a new provider to retry. `KeyboardInterrupt`/`SystemExit` in synchronous factories are not memoized. Unused providers never initialize during close. Closed providers reject resolution. Cleanup errors propagate and cleanup is not repeated.

Synchronous initialization is protected by a lock; this does not make component methods thread-safe. Both variants detect direct recursive initialization within their execution context, but arbitrary cycles between threads/tasks are not detected and can deadlock. Compose an acyclic graph explicitly. Cleanup must not recursively close its own provider. Drain requests before shutdown; already returned values are not tracked.

Singleton scope is one provider in one process; workers/Lambda instances have separate memory. These libraries do not provide persistent idempotency, distributed locking, automatic adapter migration, or the TypeScript admin/auth/CRUD modules.

Tests:

```sh
PYTHONPATH=src python3 -m unittest discover -s tests -v
```
