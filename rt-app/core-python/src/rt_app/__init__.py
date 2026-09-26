"""RT-App for Python: the same modules and API as the TypeScript reference, stdlib only.

Compose an application in one place (``app.py``) with one provider per component::

    store = Singleton(MemoryStore)
    flags = Singleton(lambda: FeatureFlags(store.get()))
    app = App([Health().feature(), flags.get().feature()], local_admin=True)
"""
from rt_app_core import AsyncSingleton, InitializationError, ProviderClosedError, Singleton

from .errors import Conflict, HttpError

__version__ = "0.3.0.dev0"

__all__ = [
    "Singleton",
    "AsyncSingleton",
    "InitializationError",
    "ProviderClosedError",
    "HttpError",
    "Conflict",
]
