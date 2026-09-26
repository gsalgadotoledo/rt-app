import math
import unittest

from rt_app import HttpError
from rt_app._jsnum import js_round, js_string, js_trim, number_to_string, utf16_slice
from rt_app.subscriptions import (
    LEDGER,
    CreditPricing,
    apply_totals,
    currency_decimals,
    default_credits,
    empty_totals,
    ledger_key,
    ledger_write,
    rollover,
    used_from,
    valid_currency,
    valid_minor_amount,
    validate_credits,
)
from rt_app.subscriptions.ledger import js_own_keys


def pack(**rates):
    return {"pack": {"credits": 1, "amountMinor": 1, "currency": "usd"}, "rates": [{"id": "a", "name": "A", "inputPer1k": 1, "outputPer1k": 1, **rates}]}


class JavaScriptNumbersTests(unittest.TestCase):
    def test_number_to_string(self):
        cases = {
            0: "0", -0.0: "0", 1.0: "1", 1.5: "1.5", -1: "-1", 1e21: "1e+21", 1.5e21: "1.5e+21", 1e20: "100000000000000000000",
            1e-6: "0.000001", 1e-7: "1e-7", 1.25e-7: "1.25e-7", 0.1 + 0.2: "0.30000000000000004", 123.456: "123.456",
            2**53: "9007199254740992", math.inf: "Infinity", -math.inf: "-Infinity", math.nan: "NaN", 5e-324: "5e-324",
        }
        for value, text in cases.items():
            with self.subTest(value=value):
                self.assertEqual(number_to_string(value), text)

    def test_math_round_halves_up(self):
        self.assertEqual([js_round(x) for x in (0.5, 1.5, 2.5, -0.5, -1.5, -2.5, 0.49999999999999994)], [1, 2, 3, 0, -1, -2, 0])
        self.assertEqual(math.copysign(1, js_round(-0.4)), -1.0)  # Math.round(-0.4) is -0
        self.assertEqual(js_round(2**53 + 2.0), 2**53 + 2.0)

    def test_strings(self):
        self.assertEqual([js_string(v) for v in (None, True, 42, 1.5, [1, None, "x"], {"a": 1})], ["null", "true", "42", "1.5", "1,,x", "[object Object]"])
        self.assertEqual(js_trim("﻿  x  "), "x")
        self.assertEqual(js_trim("\x85x\x1f"), "\x85x\x1f")  # not JavaScript whitespace
        self.assertEqual(utf16_slice("ab😀", 3), "ab\ud83d")


class LedgerTests(unittest.TestCase):
    def test_partition_and_keys(self):
        self.assertEqual(LEDGER("alice"), "SUB_LEDGER#alice")
        self.assertEqual(ledger_key(0, "", 0), "000000000000000-0000000000-e3b0c44298fc1c14")
        self.assertEqual(ledger_key(1788220800000, "abc", 7), "001788220800000-0000000007-ba7816bf8f01cfea")
        self.assertEqual(ledger_key(1788220800000, "usage:r1"), ledger_key(1788220800000, "usage:r1", 0))
        self.assertEqual(ledger_key(-1, "s", 0), "0000000000000-1-0000000000-043a718774c572bd")
        self.assertEqual(ledger_key(1.5, "s", 2.5), "0000000000001.5-00000002.5-043a718774c572bd")
        self.assertEqual(ledger_key(1e21, "s"), "00000000001e+21-0000000000-043a718774c572bd")
        self.assertEqual(ledger_key(1, "a\ud800b", 1), ledger_key(1, "a�b", 1))

    def test_write_replaces_the_id_and_keeps_fields(self):
        entry = {"id": "forged", "at": 5, "kind": "grant", "source": "admin", "credits": 250, "reason": "Courtesy", "extra": "kept"}
        result = ledger_write("bob", entry, "grant:g1")
        key = ledger_key(5, "grant:g1", 0)
        self.assertEqual(list(result["entry"])[0], "id")
        self.assertEqual(result["entry"], {**entry, "id": key})
        self.assertEqual(result["write"], {"row": {"pk": "SUB_LEDGER#bob", "sk": key, "version": 1, "data": {**entry, "id": key}}, "expected": None})
        self.assertEqual(entry["id"], "forged")

    def test_totals_use_float64_and_never_mutate(self):
        totals = apply_totals(None, {"kind": "grant", "source": "api", "credits": 0.1})
        totals = apply_totals(totals, {"kind": "grant", "source": "api", "credits": 0.2})
        self.assertEqual(totals["creditsIn"], 0.30000000000000004)
        big = {"creditsIn": 2**53 - 1, "creditsOut": 0, "expired": 0, "paidMinor": {"usd": 2**53 - 1}, "grantedValueMinor": {}}
        after = apply_totals(big, {"kind": "purchase", "source": "billing", "credits": 2, "amountMinor": 2, "currency": "usd"})
        self.assertEqual((after["creditsIn"], after["paidMinor"]["usd"]), (2.0**53, 2.0**53))
        self.assertEqual(big["paidMinor"], {"usd": 2**53 - 1})
        admin = apply_totals(None, {"kind": "plan", "source": "admin", "credits": 0, "amountMinor": 2000, "currency": "usd"})
        self.assertEqual(admin, {**empty_totals(), "grantedValueMinor": {"usd": 2000}})
        self.assertEqual(apply_totals(None, {"kind": "purchase", "source": "billing", "credits": 1, "amountMinor": 0, "currency": "usd"})["paidMinor"], {})

    def test_rollover_expires_and_grants(self):
        previous = {"key": "own:starter", "products": {"api": {"start": 0, "allowance": 500, "name": "API credits", "weekSeconds": 604800}}}
        current = {"key": "own:starter", "periodStart": 0, "periodMs": 2592000000, "products": [{"id": "api", "name": "API credits", "weeklyLimit": 500, "weekSeconds": 604800, "start": 1814400000}]}
        result = rollover(previous, current, used_from({"api": {"0": 0}}), 1814401000)
        self.assertEqual(
            result["entries"][0],
            {"at": 604800000, "kind": "expiry", "credits": -1500, "productId": "api", "reason": "API credits: unused allowance of 3 weeks expired", "details": {"unused": 500, "skippedWeeks": 2}, "seed": "expiry:own:starter:api:0:1814401000"},
        )
        self.assertEqual(result["entries"][1]["seed"], "allowance:own:starter:api:1814400000:1814401000")
        self.assertEqual(result["state"], {"key": "own:starter", "products": {"api": {"start": 1814400000, "allowance": 500, "name": "API credits", "weekSeconds": 604800}}})
        self.assertEqual(rollover(None, None, used_from({}), 1), {"entries": [], "state": None})

    def test_rollover_order_matches_v8(self):
        self.assertEqual(js_own_keys({"b": 1, "a": 1, "10": 1, "2": 1, "01": 1}), ["2", "10", "b", "a", "01"])
        names = ["b", "a", "10", "2"]
        previous = {"key": "k", "products": {n: {"start": 0, "allowance": 5, "name": n, "weekSeconds": 604800} for n in names}}
        current = {"key": "k", "periodStart": 0, "periodMs": 2592000000, "products": [{"id": n, "name": n, "weeklyLimit": 7, "weekSeconds": 604800, "start": 604800000} for n in names]}
        entries = rollover(previous, current, used_from(None), 604800005)["entries"]
        self.assertEqual([(e["kind"][0], e["productId"]) for e in entries], [("e", "a"), ("e", "b"), ("e", "10"), ("e", "2"), ("a", "b"), ("a", "a"), ("a", "10"), ("a", "2")])


class CreditsTests(unittest.TestCase):
    def test_defaults_are_fresh_and_valid(self):
        first = default_credits()
        first["rates"].clear()
        self.assertEqual(len(default_credits()["rates"]), 2)
        self.assertEqual(validate_credits(default_credits()), default_credits())

    def test_validation_order_and_messages(self):
        def message(settings):
            with self.assertRaises(HttpError) as caught:
                validate_credits(settings)
            return caught.exception.status, caught.exception.message

        self.assertEqual(message(None), (400, "Invalid currency"))
        self.assertEqual(message({"pack": {"credits": 1, "amountMinor": 150, "currency": "ISK"}, "rates": []}), (400, "Invalid amount for currency"))
        self.assertEqual(message({"pack": {"credits": 1, "amountMinor": 1, "currency": "usd"}, "rates": {}}), (400, "Use at most 50 credit rates"))
        self.assertEqual(message(pack(id="bad id", inputPer1k=-1)), (400, "Invalid identifier"))
        self.assertEqual(message(pack(inputPer1k=True)), (400, "Invalid credit rate"))
        self.assertEqual(message(pack(inputPer1k=0.12345)), (400, "Invalid credit rate"))
        self.assertEqual(message(pack(minimum=0.5)), (400, "Invalid numeric setting"))
        self.assertEqual(message({**pack(), "pack": {"credits": 0, "amountMinor": 1, "currency": "usd"}}), (400, "Invalid numeric setting"))
        self.assertEqual(validate_credits(pack(inputPer1k=0.57, outputPer1k=0.07))["rates"][0]["inputPer1k"], 0.57)
        self.assertEqual(validate_credits({"pack": {"credits": 1, "amountMinor": 1, "currency": ["USD"]}, "rates": []})["pack"]["currency"], "usd")

    def test_names_are_trimmed_then_cut_in_utf16_units(self):
        name = validate_credits(pack(name="a" * 79 + "😀"))["rates"][0]["name"]
        self.assertEqual(name, "a" * 79 + "\ud83d")
        self.assertEqual(validate_credits(pack(name=42))["rates"][0]["name"], "42")

    def test_estimate(self):
        pricing = CreditPricing()
        self.assertEqual(
            pricing.estimate("standard", 1000, 500),
            {"rate": default_credits()["rates"][0], "inputTokens": 1000, "outputTokens": 500, "exactCredits": 2.5, "credits": 3, "valueMinor": 3, "currency": "usd"},
        )
        with self.assertRaises(HttpError) as caught:
            pricing.estimate("premium", -1)
        self.assertEqual(caught.exception.status, 404)
        custom = CreditPricing({"pack": {"credits": 2, "amountMinor": 1, "currency": "USD"}, "rates": [{"id": "noisy", "name": "Noisy", "inputPer1k": 1.1, "outputPer1k": 0}, {"id": "tiny", "name": "Tiny", "inputPer1k": 0.0001, "outputPer1k": 0}]})
        noisy = custom.estimate("noisy", 50000)
        self.assertEqual((noisy["credits"], noisy["valueMinor"], noisy["currency"]), (55, 28, "usd"))
        self.assertEqual(custom.estimate("tiny", 10000005)["credits"], 2)
        self.assertEqual(custom.estimate("tiny", 10000004)["credits"], 1)
        with self.assertRaises(HttpError):
            CreditPricing({"pack": {"credits": 1, "amountMinor": 1, "currency": "xyz"}, "rates": []})

    def test_currency_helpers(self):
        self.assertTrue(valid_currency("usd"))
        self.assertFalse(valid_currency("USD"))
        self.assertEqual([currency_decimals(c) for c in ("JPY", "kwd", "isk", "zzz")], [0, 3, 2, 2])
        self.assertTrue(valid_minor_amount(2**53 - 1, "usd"))
        self.assertFalse(valid_minor_amount(2**53, "usd"))
        self.assertFalse(valid_minor_amount(True, "usd"))
        self.assertFalse(valid_minor_amount(150, "UGX"))


if __name__ == "__main__":
    unittest.main()
