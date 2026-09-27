"""DynamoCache: NoSQLCache over an existing DynamoDB table (port of ``@gsalgadotoledo/rt-app-cache-dynamodb``).

The table needs ``pk``/``sk`` string keys and TTL enabled on the ``ttl`` attribute; this adapter
never creates infrastructure. Needs the optional ``dynamodb`` extra (boto3).
"""
from __future__ import annotations

from typing import Any

from ..contracts import Clock
from .nosql import NoSQLCache


class DynamoCache(NoSQLCache):
    """``DynamoCache("my-table", region="us-east-1")``."""

    def __init__(
        self,
        table: str,
        *,
        region: str | None = None,
        endpoint: str | None = None,
        client: Any = None,
        namespace: str = "default",
        clock: Clock | None = None,
    ) -> None:
        from ..nosql.dynamodb import DynamoStore

        super().__init__(DynamoStore(table, endpoint=endpoint, region=region, client=client), namespace, clock)

    def close(self) -> None:
        """Release the DynamoDB client."""
        close = getattr(self.store, "close", None)
        if close:
            close()


__all__ = ["DynamoCache"]
