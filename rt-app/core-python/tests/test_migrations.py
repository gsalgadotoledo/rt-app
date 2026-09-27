"""Tests for rt_app.migrations (module migrations, seeds and the migrate/seed commands)."""
from __future__ import annotations

import io
import json
import math
import os
import sys
import tempfile
import textwrap
import unittest
from contextlib import redirect_stderr, redirect_stdout
from typing import Any

from rt_app.errors import Conflict
from rt_app.migrations import (
    Migration,
    MigrationError,
    MigrationLockedError,
    MigrationRunner,
    MigrationStep,
    Module,
    Seed,
    SeedRunner,
    create_context,
    date_ms,
    migrate,
    schema_migration,
)
from rt_app.migrations.__main__ import main
from rt_app.migrations.cli import MIGRATE_USAGE, SEED_USAGE, Migratable, js_number, migrate_command, seed_command
from rt_app.nosql import MemoryStore

NOW = 1790244000000  # 2026-09-24T10:00:00.000Z


def catalog(calls: list[str] | None = None) -> Module:
    calls = calls if calls is not None else []

    def up(context: Any) -> None:
        calls.append("up")
        context.ensure_rows([{"pk": "CURRENCY", "sk": "USD", "data": {"code": "USD"}}, {"pk": "CURRENCY", "sk": "EUR", "data": {"code": "EUR"}}])

    def down(context: Any) -> None:
        calls.append("down")
        for sk in ("USD", "EUR"):
            row = context.store.get("CURRENCY", sk)
            if row:
                context.store.transact([{"row": row, "expected": row["version"], "delete": True}])

    return Module("catalog", migrations=[
        schema_migration("catalog"),
        Migration("catalog:002", checksum="catalog-currencies-v1", description="Add supported currencies", up=up, down=down),
    ])


def keys(store: MemoryStore, pk: str) -> list[str]:
    return [row["sk"] for row in store.list(pk)["items"]]


class Clock:
    def __init__(self, ms: int = NOW) -> None:
        self.ms = ms

    def __call__(self) -> int:
        return self.ms


class MigrationRunnerTest(unittest.TestCase):
    def test_applies_once_in_order_and_reports_status(self) -> None:
        store, calls = MemoryStore(), []
        runner = MigrationRunner(store, [catalog(calls)], clock=Clock())
        self.assertEqual([s["state"] for s in runner.status()], ["pending", "pending"])
        self.assertEqual(runner.up(), ["catalog:001", "catalog:002"])
        self.assertEqual(runner.up(), [])
        self.assertEqual(calls, ["up"])
        self.assertEqual(store.get("MIGRATIONS", "catalog:002")["data"], {"checksum": "catalog-currencies-v1", "provider": "memory", "appliedAt": "2026-09-24T10:00:00.000Z"})
        self.assertEqual(keys(store, "MIGRATION_LOCKS"), [])
        self.assertEqual([(s["id"], s["state"], s["reversible"]) for s in runner.status()], [("catalog:001", "applied", False), ("catalog:002", "applied", True)])

    def test_mapping_declarations_and_module_order(self) -> None:
        store, ran = MemoryStore(), []
        modules = [
            {"id": "zeta", "migrations": [{"id": "zeta:b", "checksum": "1", "up": lambda c: ran.append("b")}]},
            Module("alpha", migrations=[Migration("alpha:1", checksum="1", up=lambda c: ran.append("a"))]),
        ]
        self.assertEqual(migrate(store, modules), ["zeta:b", "alpha:1"])
        self.assertEqual(ran, ["b", "a"])

    def test_step_to_and_negative_slices(self) -> None:
        store = MemoryStore()
        three = Module("m", migrations=[Migration(f"m:{i}", checksum=str(i), up=lambda c: None, down=lambda c: None) for i in (1, 2, 3)])
        runner = MigrationRunner(store, [three])
        self.assertEqual(runner.up(step=-1), ["m:1", "m:2"])
        with self.assertRaisesRegex(ValueError, r'^Couldn\'t find migration to apply with name "m:1"$'):
            runner.up(to="m:1")
        self.assertEqual(runner.up(to="m:3", step=0), ["m:3"])
        self.assertEqual(runner.down(step=2), ["m:3", "m:2"])
        self.assertEqual(runner.down(), ["m:1"])
        self.assertEqual(runner.down(), [])
        with self.assertRaisesRegex(ValueError, "^Migration is not applied: m:1$"):
            runner.down(to="m:1")

    def test_down_refuses_irreversible_before_anything(self) -> None:
        store, calls = MemoryStore(), []
        runner = MigrationRunner(store, [catalog(calls)])
        runner.up()
        with self.assertRaisesRegex(ValueError, "^Irreversible migrations: catalog:001$"):
            runner.down(step=2)
        self.assertEqual(calls, ["up"])
        self.assertEqual(keys(store, "CURRENCY"), ["EUR", "USD"])
        self.assertEqual(runner.down(), ["catalog:002"])
        self.assertEqual(keys(store, "CURRENCY"), [])

    def test_partial_failures_stop_and_retry(self) -> None:
        store, fail = MemoryStore(), [True]

        def flaky(_c: Any) -> None:
            if fail[0]:
                raise RuntimeError("provider unavailable")

        module = Module("f", migrations=[schema_migration("f"), Migration("f:2", checksum="2", up=flaky), Migration("f:3", checksum="3", up=lambda c: None)])
        with self.assertRaises(MigrationError) as caught:
            migrate(store, [module])
        self.assertEqual(str(caught.exception), "Migration f:2 (up) failed: Original error: provider unavailable")
        self.assertIsInstance(caught.exception.cause, RuntimeError)
        self.assertEqual(keys(store, "MIGRATIONS"), ["f:001"])
        self.assertEqual(keys(store, "MIGRATION_LOCKS"), [])
        fail[0] = False
        self.assertEqual(migrate(store, [module]), ["f:2", "f:3"])

    def test_rollback_failure_keeps_reverted(self) -> None:
        store = MemoryStore()

        def boom(_c: Any) -> None:
            raise RuntimeError("no")

        module = Module("m", migrations=[Migration("m:1", checksum="1", up=lambda c: None, down=lambda c: None), Migration("m:2", checksum="2", up=lambda c: None, down=boom), Migration("m:3", checksum="3", up=lambda c: None, down=lambda c: None)])
        runner = MigrationRunner(store, [module])
        runner.up()
        with self.assertRaisesRegex(MigrationError, r"^Migration m:2 \(down\) failed: Original error: no$"):
            runner.down(step=3)
        self.assertEqual(keys(store, "MIGRATIONS"), ["m:1", "m:2"])

    def test_plan_validation(self) -> None:
        store = MemoryStore()

        def plan(*migrations: Any, **options: Any) -> MigrationRunner:
            return MigrationRunner(store, [Module("x", migrations=list(migrations))], **options)

        for bad in ["no-module", "-x:1", "x:a:b", "x:1\n", "x:é", "x:\u212a", "\u017fx:1", "", "m:" + "a" * 199]:
            with self.assertRaisesRegex(ValueError, "^Invalid migration id: "):
                plan(Migration(bad, checksum="1", up=lambda c: None))
        with self.assertRaisesRegex(ValueError, r"^Invalid migration id: undefined \(expected module:name\)$"):
            plan(Migration(None, checksum="1", up=lambda c: None))  # type: ignore[arg-type]
        plan(Migration("Mod-1.x_y:Name.2-b_c", checksum="1", up=lambda c: None), Migration("m:" + "a" * 198, checksum="1", up=lambda c: None))
        with self.assertRaisesRegex(ValueError, "^Duplicate migration id: x:1$"):
            plan(Migration("x:1", checksum="1", up=lambda c: None), Migration("x:1", checksum="1", up=lambda c: None))
        with self.assertRaisesRegex(ValueError, "^Unsupported migration x:1 for memory$"):
            plan(Migration("x:1", checksum="1", up=lambda c: None, providers={"memory": MigrationStep(checksum="2")}))
        with self.assertRaisesRegex(ValueError, "^Migration without checksum: x:1$"):
            plan(Migration("x:1", checksum="", up=lambda c: None))
        with self.assertRaisesRegex(ValueError, "^Unknown environment: qa$"):
            plan(environment="qa")
        self.assertEqual(keys(store, "MIGRATIONS"), [])

    def test_provider_overrides_and_legacy_run(self) -> None:
        store, used = MemoryStore(), []
        migrate(store, [Module("legacy", migrations=[
            Migration("legacy:1", checksum="generic", up=lambda c: used.append("generic"), providers={"memory": MigrationStep(checksum="memory-v1", up=lambda c: used.append(c.provider))}),
            Migration("legacy:2", checksum="old", run=lambda s: used.append("run:" + s.provider)),
        ])])
        self.assertEqual(used, ["memory", "run:memory"])
        self.assertEqual(store.get("MIGRATIONS", "legacy:1")["data"]["checksum"], "memory-v1")
        used.clear()
        migrate(MemoryStore(), [Module("d", migrations=[Migration("d:1", checksum="g", up=lambda c: used.append(c.provider), providers={"dynamodb": MigrationStep(up=lambda c: used.append("dyn:" + c.provider))})])], provider="dynamodb")
        self.assertEqual(used, ["dyn:dynamodb"])

    def test_checksums_are_strict(self) -> None:
        store = MemoryStore()
        store.transact([{"row": {"pk": "MIGRATIONS", "sk": "m:1", "version": 1, "data": {"checksum": 3}}, "expected": None}])
        module = Module("m", migrations=[Migration("m:1", checksum="3", up=lambda c: None)])
        with self.assertRaisesRegex(ValueError, "^Migration changed: m:1$"):
            migrate(store, [module])
        self.assertEqual(keys(store, "MIGRATION_LOCKS"), [])
        specific = Module("i", migrations=[Migration("i:1", checksum="c", providers={"memory": MigrationStep(checksum="c", up=lambda c: None)})])
        store.transact([{"row": {"pk": "MIGRATIONS", "sk": "i:1", "version": 1, "data": {"checksum": "c", "provider": "dynamodb"}}, "expected": None}])
        with self.assertRaisesRegex(ValueError, "^Migration changed: i:1$"):
            migrate(store, [specific])

    def test_unknown_history(self) -> None:
        store = MemoryStore()
        migrate(store, [catalog(), Module("old", migrations=[schema_migration("old")])])
        runner = MigrationRunner(store, [catalog()])
        self.assertEqual(runner.status()[-1], {"id": "old:001", "module": "old", "state": "unknown", "appliedAt": runner.status()[-1]["appliedAt"], "reversible": False})
        self.assertEqual(runner.down(), ["catalog:002"])
        self.assertIsNotNone(store.get("MIGRATIONS", "old:001"))


class LockTest(unittest.TestCase):
    def test_live_lock_refuses_and_expired_is_taken_over(self) -> None:
        store, clock = MemoryStore(), Clock()
        store.transact([{"row": {"pk": "MIGRATION_LOCKS", "sk": "migrations", "version": 3, "data": {"owner": "crashed", "expiresAt": "2026-09-24T10:05:00.000Z"}}, "expected": None}])
        with self.assertRaises(MigrationLockedError) as caught:
            migrate(store, [catalog()], clock=clock)
        self.assertEqual(caught.exception.holder, "crashed")
        self.assertEqual(str(caught.exception), "Migrations are already running (crashed, lock expires 2026-09-24T10:05:00.000Z)")
        clock.ms += 5 * 60_000  # expiresAt equal to now is expired
        self.assertEqual(migrate(store, [catalog()], clock=clock, lock_ttl_ms=1000), ["catalog:001", "catalog:002"])
        self.assertEqual(keys(store, "MIGRATION_LOCKS"), [])

    def test_owner_missing_or_invalid_expiry(self) -> None:
        store = MemoryStore()
        store.transact([{"row": {"pk": "MIGRATION_LOCKS", "sk": "migrations", "version": 1, "data": {"expiresAt": "2099-01-01T00:00:00Z"}}, "expected": None}])
        with self.assertRaisesRegex(MigrationLockedError, r"\(undefined, lock expires 2099"):
            migrate(store, [catalog()], clock=Clock())
        store2 = MemoryStore()
        store2.transact([{"row": {"pk": "MIGRATION_LOCKS", "sk": "migrations", "version": 1, "data": {"owner": "x", "expiresAt": "soon"}}, "expected": None}])
        self.assertEqual(migrate(store2, [catalog()], clock=Clock()), ["catalog:001", "catalog:002"])

    def test_contention_nested_runner_is_locked_out(self) -> None:
        store, seen = MemoryStore(), []

        def step(_c: Any) -> None:
            try:
                migrate(store, [], owner="runner-b", clock=Clock())
            except MigrationLockedError as error:
                seen.append(error.holder)

        migrate(store, [Module("s", migrations=[Migration("s:1", checksum="1", up=step)])], owner="runner-a", clock=Clock())
        self.assertEqual(seen, ["runner-a"])

    def test_lost_lease_records_nothing(self) -> None:
        store = MemoryStore()

        def intrude(context: Any) -> None:
            lock = context.store.get("MIGRATION_LOCKS", "migrations")
            context.store.transact([{"row": {**lock, "version": lock["version"] + 1, "data": {**lock["data"], "owner": "intruder"}}, "expected": lock["version"]}])

        module = Module("lease", migrations=[Migration("lease:1", checksum="1", up=intrude), Migration("lease:2", checksum="2", up=lambda c: None)])
        with self.assertRaises(Conflict):
            migrate(store, [module])
        self.assertEqual(keys(store, "MIGRATIONS"), [])
        self.assertEqual(store.get("MIGRATION_LOCKS", "migrations")["data"]["owner"], "intruder")

    def test_default_owner(self) -> None:
        store, owners = MemoryStore(), []
        migrate(store, [Module("m", migrations=[Migration("m:1", checksum="1", up=lambda c: owners.append(c.store.get("MIGRATION_LOCKS", "migrations")["data"]["owner"]))])])
        self.assertRegex(owners[0], r"^rt-app-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")

    def test_date_parsing(self) -> None:
        self.assertEqual(date_ms("1970-01-01T00:00:01.5Z"), 1500)
        self.assertEqual(date_ms("2026-09-24T12:00:00+02:00"), NOW)
        self.assertTrue(math.isnan(date_ms("soon")))
        self.assertEqual(date_ms(None), 0)


class ContextTest(unittest.TestCase):
    def test_ensure_rows(self) -> None:
        store = MemoryStore()
        store.transact([{"row": {"pk": "P", "sk": "a", "version": 4, "data": {"n": 99}}, "expected": None}])
        context = create_context(store, "local")
        self.assertEqual(context.ensure_rows([{"pk": "P", "sk": "a", "data": {}}, {"pk": "P", "sk": "b", "data": {}}, {"pk": "P", "sk": "b", "data": {}}]), ["P/b"])
        self.assertEqual(store.get("P", "a")["data"], {"n": 99})

        class Offline:
            provider = "x"

            def get(self, pk: str, sk: str) -> None:
                return None

            def transact(self, writes: Any) -> None:
                raise RuntimeError("offline")

            def list(self, pk: str, cursor: Any = None) -> Any:
                return {"items": []}

        with self.assertRaisesRegex(RuntimeError, "offline"):
            create_context(Offline()).ensure_rows([{"pk": "P", "sk": "a", "data": {}}])


def seed_modules(log: list[str]) -> list[Module]:
    return [
        Module("users", seeds=[Seed("users:demo", description="Demo identities", run=lambda c: log.append("users:" + c.secret("DEMO_PASSWORD")))]),
        Module("catalog", seeds=[
            Seed("catalog:currencies", environments=["local", "develop", "stage", "prod"], run=lambda c: log.append("currencies")),
            Seed("catalog:products", run=lambda c: log.append("products:" + c.service("users")["owner"])),
        ]),
    ]


class SeedRunnerTest(unittest.TestCase):
    options = {"secrets": {"DEMO_PASSWORD": "pw"}, "services": {"users": {"owner": "ana"}}}

    def test_runs_once_per_environment(self) -> None:
        store, log = MemoryStore(), []
        runner = SeedRunner(store, seed_modules(log), environment="stage", **self.options)
        self.assertEqual(runner.run(), ["users:demo", "catalog:currencies", "catalog:products"])
        self.assertEqual(runner.run(), [])
        self.assertEqual(log, ["users:pw", "currencies", "products:ana"])
        self.assertEqual(store.get("SEEDS", "users:demo")["data"]["environment"], "stage")

    def test_prod_filter_rerun_and_versions(self) -> None:
        store, log = MemoryStore(), []
        prod = SeedRunner(store, seed_modules(log), environment="prod", **self.options)
        self.assertEqual(prod.run(), ["catalog:currencies"])
        self.assertEqual([s["state"] for s in prod.status()], ["skipped", "applied", "skipped"])
        local = SeedRunner(store, seed_modules(log), **self.options)
        self.assertEqual(local.run(modules=["users"]), ["users:demo"])
        self.assertEqual(local.run(modules=["users"], rerun=True), ["users:demo"])
        self.assertEqual(store.get("SEEDS", "users:demo")["version"], 2)
        self.assertEqual(local.run(modules=[]), [])
        with self.assertRaisesRegex(ValueError, "^Unknown module: billing$"):
            local.run(modules=["billing"])
        modules = seed_modules(log)
        modules[1] = Module("catalog", seeds=[modules[1].seeds[0], Seed("catalog:products", version="2", run=lambda c: None)])
        changed = SeedRunner(store, modules, **self.options)
        self.assertEqual(changed.status()[2]["state"], "pending")

    def test_missing_secret_and_invalid_declarations(self) -> None:
        store = MemoryStore()
        with self.assertRaisesRegex(MigrationError, "^Migration users:demo \\(up\\) failed: Original error: Seed users:demo requires DEMO_PASSWORD$"):
            SeedRunner(store, seed_modules([]), secrets={"DEMO_PASSWORD": ""}).run()
        self.assertIsNone(store.get("SEEDS", "users:demo"))
        self.assertEqual(keys(store, "MIGRATION_LOCKS"), [])
        for seed in [Seed("x:a", run=lambda c: None, environments=[]), Seed("x:a", run=lambda c: None, environments=["qa"])]:
            with self.assertRaisesRegex(ValueError, "^Invalid environments for seed x:a$"):
                SeedRunner(store, [Module("x", seeds=[seed])])
        with self.assertRaisesRegex(ValueError, "^Duplicate seed id: x:a$"):
            SeedRunner(store, [Module("x", seeds=[Seed("x:a", run=lambda c: None), Seed("x:a", run=lambda c: None)])])


def app(environment: str = "local") -> Migratable:
    return Migratable(MemoryStore(), [Module(
        "catalog",
        migrations=[schema_migration("catalog"), Migration("catalog:002", checksum="2", description="Currencies", up=lambda c: None, down=lambda c: None)],
        seeds=[Seed("catalog:demo", description="Demo products", run=lambda c: c.secret("DEMO_PASSWORD"))],
    )], environment, clock=Clock())


class CliTest(unittest.TestCase):
    def run_migrate(self, application: Migratable, argv: list[str]) -> list[str]:
        lines: list[str] = []
        migrate_command(application, argv, lines.append)
        return lines

    def test_migrate_output(self) -> None:
        a = app()
        self.assertEqual(self.run_migrate(a, []), ["Migrations (local):", "  pending  catalog:001 — Register the catalog document schema", "  pending  catalog:002 — Currencies", "2 pending. Run: rta migrate up"])
        self.assertEqual(self.run_migrate(a, ["up", "--step", "1"]), ["  migrating catalog:001", "Applied: catalog:001"])
        self.assertEqual(self.run_migrate(a, ["up", "--json"]), ['{"environment":"local","applied":["catalog:002"]}'])
        self.assertEqual(self.run_migrate(a, ["up"]), ["Nothing to apply."])
        status = json.loads(self.run_migrate(a, ["status", "--json"])[0])
        self.assertEqual(list(status["migrations"][1]), ["id", "module", "description", "state", "appliedAt", "reversible"])
        self.assertEqual(self.run_migrate(a, ["down", "--to", "catalog:002"]), ["  reverting catalog:002", "Reverted: catalog:002"])
        self.assertEqual(self.run_migrate(a, ["down", "--json", "--step", "0"]), ['{"environment":"local","reverted":[]}'])

    def test_migrate_usage(self) -> None:
        a = app()
        for argv in (["sideways"], ["up", "--step", "-1"], ["up", "--step", "x"], ["up", "--step", "1.5"], ["up", "--to"], ["up", "--force"], ["status", "--step", "1"], ["up", "stray"], ["--json", "up"]):
            with self.assertRaises(ValueError) as caught:
                migrate_command(a, argv, lambda _line: None)
            self.assertEqual(str(caught.exception), MIGRATE_USAGE, argv)
        self.assertEqual(keys(a.store, "MIGRATIONS"), [])

    def test_seed_command(self) -> None:
        a, lines = app("stage"), []
        with self.assertRaisesRegex(MigrationError, "requires DEMO_PASSWORD"):
            seed_command(a, [], {}, lines.append)
        self.assertEqual(lines, ["  seeding catalog:demo"])
        lines.clear()
        seed_command(a, ["--module", " catalog ,"], {"DEMO_PASSWORD": "x"}, lines.append)
        self.assertEqual(lines, ["  seeding catalog:demo", "Seeded: catalog:demo"])
        lines.clear()
        seed_command(a, ["status"], {}, lines.append)
        self.assertEqual(lines, ["Seeds (stage):", "  applied  catalog:demo — Demo products"])
        lines.clear()
        seed_command(a, ["status", "--json"], {}, lines.append)
        self.assertIn('"environments": [\n        "local",', lines[0])
        for argv in (["plant"], ["status", "--rerun"], ["--module"], ["--everything"]):
            with self.assertRaises(ValueError) as caught:
                seed_command(a, argv, {}, lambda _line: None)
            self.assertEqual(str(caught.exception), SEED_USAGE)

    def test_js_number(self) -> None:
        cases = {"": 0, " 2 \n": 2, "0x1": 1, "0o7": 7, "0b10": 2, "1e0": 1, "+1.0": 1, ".5e1": 5, "1.": 1, "-0": 0, "1e21": 1e21}
        for text, expected in cases.items():
            self.assertEqual(js_number(text), expected, text)
        for text in ("-0x1", "1_0", "x", "1e", "0x", "٣"):
            self.assertTrue(math.isnan(js_number(text)), text)
        self.assertEqual(js_number("-Infinity"), -math.inf)

    def test_main_entry(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            with open(os.path.join(folder, "migratable_app.py"), "w", encoding="utf-8") as f:
                f.write(textwrap.dedent("""
                    from rt_app.migrations import Module, schema_migration
                    from rt_app.migrations.cli import Migratable
                    from rt_app.nosql import MemoryStore
                    app = Migratable(MemoryStore(), [Module("m", migrations=[schema_migration("m")])])
                """))
            cwd = os.getcwd()
            os.chdir(folder)
            try:
                out, err = io.StringIO(), io.StringIO()
                with redirect_stdout(out), redirect_stderr(err):
                    self.assertEqual(main(["migratable_app:app", "migrate", "up"]), 0)
                    self.assertEqual(main(["migratable_app:app", "migrate", "sideways"]), 1)
                self.assertEqual(out.getvalue(), "  migrating m:001\nApplied: m:001\n")
                self.assertEqual(err.getvalue(), MIGRATE_USAGE + "\n")
            finally:
                os.chdir(cwd)
                sys.modules.pop("migratable_app", None)


if __name__ == "__main__":
    unittest.main()
