"""SMS output: one short text per event through SNS.

``SmsOutput(phone, client=None)`` needs an E.164 number (``^\\+[1-9]\\d{7,14}$``, ASCII digits) and
calls ``client.publish(PhoneNumber=…, Message=…)``, the boto3 ``sns`` client API; the default
client is created on the first write. The message is ``<LEVEL> <source>: <message>`` cut to 140
UTF-16 units.
"""
from __future__ import annotations

import re
import threading
from collections.abc import Mapping
from typing import Any

from .._jsnum import js_string, utf16_slice

_PHONE = re.compile(r"\+[1-9][0-9]{7,14}")


def _text(value: Any) -> str:
    return "undefined" if value is None else js_string(value)


class SmsOutput:
    """SNS SMS; keep it to rare, important events (messaging charges apply)."""

    id = "sms"

    def __init__(self, phone: str, client: Any = None) -> None:
        if not isinstance(phone, str) or not _PHONE.fullmatch(phone):
            raise ValueError("Observer SMS requires E.164 phone number")
        self.phone = phone
        self._client = client
        self._lock = threading.Lock()

    def _sns(self) -> Any:
        with self._lock:
            if self._client is None:
                import boto3  # optional dependency, loaded on first use

                self._client = boto3.client("sns")
            return self._client

    def write(self, event: Mapping[str, Any], signal: threading.Event | None = None) -> None:
        message = f"{_text(event.get('level')).upper()} {_text(event.get('source'))}: {_text(event.get('message'))}"
        self._sns().publish(PhoneNumber=self.phone, Message=utf16_slice(message, 140))


__all__ = ["SmsOutput"]
