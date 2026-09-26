"""NoSQL store on DynamoDB (port of ``DynamoStore`` in ``@gsalgadotoledo/rt-app-dynamodb``), with boto3.

Rows are stored as items ``{pk, sk, version, data, ttl?}`` in a table keyed by ``pk`` (hash) and
``sk`` (range), the same layout the TypeScript store writes. Writes use ``TransactWriteItems`` with
the same conditions (``attribute_not_exists(pk)`` or ``#v = :v``), reads use ``ConsistentRead``, and
``list`` uses ``Query`` with ``Limit`` 51 (50 rows plus a look-ahead) and the shared cursor format.

Needs the optional dependency ``boto3`` (``pip install "rt-app-core[dynamodb]"``); it is imported
when a store is created, so ``rt_app`` works without it.
"""
from __future__ import annotations

import math
import re
from collections.abc import Mapping, Sequence
from decimal import Decimal
from typing import Any

from .._jsnum import number_to_string
from ..errors import Conflict
from . import PAGE_SIZE, Page, Row, Write, decode_cursor, encode_cursor

_CONFLICT_CODES = ("ConditionalCheckFailed", "TransactionConflict")


def _number_text(value: int | float) -> str:
    """The number as JavaScript writes it (``String(n)``), which is what the AWS SDK for JS sends."""
    return number_to_string(value) if isinstance(value, float) else str(value)


def to_dynamo(value: Any) -> Any:
    """Plain JSON value → value boto3 can serialize (numbers become ``Decimal``)."""
    if isinstance(value, bool) or value is None or isinstance(value, str):
        return value
    if isinstance(value, int):
        return Decimal(value)
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError("DynamoDB cannot store NaN or Infinity")
        return Decimal(_number_text(value))
    if isinstance(value, Mapping):
        return {str(k): to_dynamo(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [to_dynamo(v) for v in value]
    raise TypeError(f"Cannot store {type(value).__name__} in DynamoDB")


def from_dynamo(value: Any) -> Any:
    """boto3 value → plain JSON value: integral ``Decimal`` → ``int``, others → ``float``."""
    if isinstance(value, Decimal):
        return int(value) if value == value.to_integral_value() else float(value)
    if isinstance(value, Mapping):
        return {k: from_dynamo(v) for k, v in value.items()}
    if isinstance(value, list):
        return [from_dynamo(v) for v in value]
    if isinstance(value, (set, frozenset)):
        return [from_dynamo(v) for v in value]
    return value


def _cancellation_codes(error: Exception) -> list[str]:
    response = getattr(error, "response", None) or {}
    reasons = response.get("CancellationReasons") or []
    codes = [r.get("Code") for r in reasons if isinstance(r, Mapping)]
    if not codes:  # older botocore: the reasons are only in the message, e.g. "[ConditionalCheckFailed, None]"
        message = response.get("Error", {}).get("Message", "") or str(error)
        codes = re.findall(r"\b(ConditionalCheckFailed|TransactionConflict)\b", message)
    return [c for c in codes if isinstance(c, str)]


class DynamoStore:
    """NoSQL store contract on DynamoDB. Thread-safe (boto3 clients are).

    ``DynamoStore(table, endpoint=None, region=None)``; credentials come from the usual AWS
    environment/profile chain. ``endpoint`` points at DynamoDB Local or another compatible service.
    """

    provider = "dynamodb"

    def __init__(self, table: str, *, endpoint: str | None = None, region: str | None = None, client: Any = None) -> None:
        if not table:
            raise ValueError("TABLE_NAME is required")
        self.table = table
        if client is None:
            import boto3  # optional dependency: rt-app-core[dynamodb]
            from botocore.config import Config

            client = boto3.client(
                "dynamodb",
                endpoint_url=endpoint,
                region_name=region,
                config=Config(retries={"max_attempts": 3, "mode": "standard"}, connect_timeout=2, read_timeout=8),
            )
        from boto3.dynamodb.types import TypeDeserializer, TypeSerializer

        self.client = client
        self._serializer = TypeSerializer()
        self._deserializer = TypeDeserializer()

    def _item(self, value: Mapping[str, Any]) -> dict[str, Any]:
        return {k: self._serializer.serialize(to_dynamo(v)) for k, v in value.items()}

    def _plain(self, item: Mapping[str, Any]) -> Any:
        return from_dynamo({k: self._deserializer.deserialize(v) for k, v in item.items()})

    def close(self) -> None:
        """Close the HTTP connections of the client."""
        close = getattr(self.client, "close", None)
        if callable(close):
            close()

    def get(self, pk: str, sk: str) -> Row | None:
        """Read one row; absence returns None. Durable reads use ConsistentRead."""
        result = self.client.get_item(TableName=self.table, Key=self._item({"pk": pk, "sk": sk}), ConsistentRead=True)
        item = result.get("Item")
        return self._plain(item) if item else None

    def transact(self, writes: Sequence[Write]) -> None:
        """Apply all version-guarded writes atomically; conflicts never commit a partial transaction."""
        if not writes:
            return
        # Same answer as the other stores (DynamoDB itself rejects it with a ValidationException).
        if len({(w["row"]["pk"], w["row"]["sk"]) for w in writes}) != len(writes):
            raise ValueError("Duplicate transaction key")
        items: list[dict[str, Any]] = []
        for write in writes:
            row, expected = write["row"], write.get("expected")
            condition: dict[str, Any]
            if expected is None:
                condition = {"ConditionExpression": "attribute_not_exists(pk)"}
            else:
                condition = {
                    "ConditionExpression": "#v = :v",
                    "ExpressionAttributeNames": {"#v": "version"},
                    "ExpressionAttributeValues": self._item({":v": expected}),
                }
            if write.get("delete"):
                items.append({"Delete": {"TableName": self.table, "Key": self._item({"pk": row["pk"], "sk": row["sk"]}), **condition}})
            else:
                items.append({"Put": {"TableName": self.table, "Item": self._item(row), **condition}})
        try:
            self.client.transact_write_items(TransactItems=items)
        except Exception as error:
            code = (getattr(error, "response", None) or {}).get("Error", {}).get("Code")
            if code == "TransactionCanceledException" and any(c in _CONFLICT_CODES for c in _cancellation_codes(error)):
                raise Conflict() from None
            raise

    def list(self, pk: str, cursor: str | None = None) -> Page:
        """Return up to 50 rows and a cursor bound to this partition; reject cross-partition cursors."""
        request: dict[str, Any] = {
            "TableName": self.table,
            "KeyConditionExpression": "pk = :pk",
            "ExpressionAttributeValues": self._item({":pk": pk}),
            # One extra row tells whether another page exists, so a full last page has no cursor.
            "Limit": PAGE_SIZE + 1,
            "ConsistentRead": True,
        }
        if cursor:
            request["ExclusiveStartKey"] = self._item({"pk": pk, "sk": decode_cursor(pk, cursor)})
        result = self.client.query(**request)
        rows = [self._plain(item) for item in result.get("Items", [])]
        page: Page = {"items": rows[:PAGE_SIZE]}
        if len(rows) > PAGE_SIZE:
            page["cursor"] = encode_cursor(pk, rows[PAGE_SIZE - 1]["sk"])
        return page


__all__ = ["DynamoStore", "to_dynamo", "from_dynamo"]
