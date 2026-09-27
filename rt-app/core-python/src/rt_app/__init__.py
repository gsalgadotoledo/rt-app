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

# Identity modules (jwt, users, acl, auth). AES-GCM sealing needs the optional "crypto" extra,
# imported only when a value is sealed or opened.
from .acl import ACL  # noqa: E402
from .auth import Auth, AuthVault, LocalMailbox  # noqa: E402
from .jwt import JwtTokens  # noqa: E402
from .users import Users, hash_password, validate_password, verify_password  # noqa: E402

__all__ += [
    "JwtTokens",
    "Users",
    "validate_password",
    "hash_password",
    "verify_password",
    "ACL",
    "Auth",
    "AuthVault",
    "LocalMailbox",
]

# Scoped service keys for backends (Bearer rtsk_<id>.<secret> on /service/ endpoints).
from .service_keys import ServiceKeys, parse_service_keys, service_keys_from_env  # noqa: E402

__all__ += ["ServiceKeys", "parse_service_keys", "service_keys_from_env"]
