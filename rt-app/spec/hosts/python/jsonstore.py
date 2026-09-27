"""Subject: json-store (mirrors hosts/node/json.mjs; see spec/contracts/json.contract.yaml).

Each instance owns a fresh temporary directory; the database is "db.json" there (or init.path).
File helpers take names relative to that directory. The module is not called json.py because this
folder is on sys.path and would shadow the standard library.
"""
from __future__ import annotations

import os
import shutil
import tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

from rt_app import _js
from rt_app.nosql import Page, Row, Write
from rt_app.nosql.json import JsonStore, local_secret

DEFAULT_NOW = 1767225600000  # 2026-01-01T00:00:00.000Z


class JsonStoreSubject:
    def __init__(self, init: Any) -> None:
        init = init if isinstance(init, dict) else {}
        self._dir = Path(tempfile.mkdtemp(prefix="rt-contract-json-"))
        self._file = self._dir / (init.get("path") or "db.json")
        now = init.get("now")
        self._now: float = now if _js.is_number(now) else DEFAULT_NOW
        self._lock_timeout = init.get("lockTimeout")
        if isinstance(init.get("text"), str):
            self._file.write_bytes(init["text"].encode("utf-8"))
        self._store = self._open()
        rows = init.get("rows")
        if rows:
            self._store.transact([{"row": row, "expected": None} for row in rows])

    def _open(self) -> JsonStore:
        return JsonStore(self._file, self._lock_timeout, now=lambda: self._now)

    def _path(self, name: Any = None) -> Path:
        return self._file if name is None else self._dir / name

    # The store ----------------------------------------------------------------------------------

    def get(self, pk: Any, sk: Any) -> Row | None:
        return self._store.get(pk, sk)

    def transact(self, writes: list[Write]) -> None:
        self._store.transact(writes)

    def list(self, pk: Any, cursor: Any = None) -> Page:
        return self._store.list(pk, cursor)

    def race(self, writes: list[Write], count: int) -> dict[str, Any]:
        """``count`` store instances run the same transaction at once (threads)."""
        stores = [self._open() for _ in range(int(count))]
        with ThreadPoolExecutor(max_workers=int(count)) as pool:
            futures = [pool.submit(store.transact, writes) for store in stores]
            errors = [future.exception() for future in futures]
        failed = [error for error in errors if error is not None]
        return {
            "committed": len(errors) - len(failed),
            "conflicts": sum(1 for error in failed if getattr(error, "status", None) == 409),
            "errors": [str(error) for error in failed if getattr(error, "status", None) != 409],
        }

    # The file as another process or language sees it --------------------------------------------

    def document(self) -> Any:
        try:
            return _js.parse(self._file.read_text("utf-8"))
        except FileNotFoundError:
            return None

    def text(self, name: Any = None) -> str | None:
        try:
            return self._path(name).read_bytes().decode("utf-8", "replace")
        except FileNotFoundError:
            return None

    def write_text(self, text: str, name: Any = None) -> None:
        self._path(name).write_bytes(text.encode("utf-8"))

    def remove(self, name: Any = None) -> None:
        self._path(name).unlink()

    def mode(self, name: Any = None) -> str | None:
        try:
            return format(self._path(name).stat().st_mode & 0o777, "o")
        except FileNotFoundError:
            return None

    def chmod(self, mode: str, name: Any = None) -> None:
        os.chmod(self._path(name), int(mode, 8))

    def files(self) -> list[str]:
        return sorted(os.listdir(self._dir))

    def lock(self) -> None:
        Path(str(self._file) + ".lock").write_bytes(b"")

    def unlock(self) -> None:
        Path(str(self._file) + ".lock").unlink()

    def set_now(self, ms: Any) -> None:
        self._now = ms

    def local_secret(self) -> str:
        return local_secret(self._file)

    def close(self) -> None:
        shutil.rmtree(self._dir, ignore_errors=True)


SUBJECTS = {"json-store": JsonStoreSubject}
