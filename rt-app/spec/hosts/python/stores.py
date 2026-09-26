"""Subjects: nosql-postgres, nosql-dynamodb (mirrors the database stores of hosts/node/storage.mjs).

Registered only when RT_APP_TEST_POSTGRES_URL / RT_APP_TEST_DYNAMODB_ENDPOINT are set (see
spec/services.mjs). Every instance gets a fresh table holding init.rows; close() drops it.
"""
from __future__ import annotations

import os
import secrets
import time
from typing import Any

from storage import rows_of

from rt_app.nosql import Page, Row, Write


def _unique() -> str:
    return f"rt_contract_{_base36(int(time.time() * 1000))}_{secrets.token_hex(4)}"


def _base36(n: int) -> str:
    digits = "0123456789abcdefghijklmnopqrstuvwxyz"
    out = ""
    while True:
        n, r = divmod(n, 36)
        out = digits[r] + out
        if not n:
            return out


class _Throwaway:
    """A store over its own table; the host calls close() when the case ends."""

    def __init__(self, store: Any, drop: Any, rows: list[Row] | None) -> None:
        self._store, self._drop = store, drop
        if rows:
            store.transact([{"row": row, "expected": None} for row in rows])

    def get(self, pk: str, sk: str) -> Row | None:
        return self._store.get(pk, sk)

    def transact(self, writes: list[Write]) -> None:
        self._store.transact(writes)

    def list(self, pk: str, cursor: str | None = None) -> Page:
        return self._store.list(pk, cursor)

    def close(self) -> None:
        try:
            self._drop()
        finally:
            self._store.close()


def postgres_store(init: Any) -> _Throwaway:
    from rt_app.nosql.postgres import PostgresStore

    store = PostgresStore(os.environ["RT_APP_TEST_POSTGRES_URL"], table=_unique(), max=2, ssl=False)
    try:
        return _Throwaway(store, store.drop_table, rows_of(init))
    except BaseException:
        store.drop_table()
        store.close()
        raise


def dynamo_store(init: Any) -> _Throwaway:
    import boto3

    from rt_app.nosql.dynamodb import DynamoStore

    endpoint, table = os.environ["RT_APP_TEST_DYNAMODB_ENDPOINT"], _unique()
    client = boto3.client("dynamodb", endpoint_url=endpoint, region_name="us-east-1")
    client.create_table(
        TableName=table,
        BillingMode="PAY_PER_REQUEST",
        AttributeDefinitions=[{"AttributeName": "pk", "AttributeType": "S"}, {"AttributeName": "sk", "AttributeType": "S"}],
        KeySchema=[{"AttributeName": "pk", "KeyType": "HASH"}, {"AttributeName": "sk", "KeyType": "RANGE"}],
    )
    store = DynamoStore(table, endpoint=endpoint, region="us-east-1")

    def drop() -> None:
        try:
            client.delete_table(TableName=table)
        finally:
            client.close()

    try:
        return _Throwaway(store, drop, rows_of(init))
    except BaseException:
        drop()
        store.close()
        raise


SUBJECTS: dict[str, Any] = {}
if os.environ.get("RT_APP_TEST_POSTGRES_URL"):
    SUBJECTS["nosql-postgres"] = postgres_store
if os.environ.get("RT_APP_TEST_DYNAMODB_ENDPOINT"):
    SUBJECTS["nosql-dynamodb"] = dynamo_store
