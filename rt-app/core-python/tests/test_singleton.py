import asyncio
import unittest
from concurrent.futures import ThreadPoolExecutor
from rt_app_core import Singleton, AsyncSingleton, InitializationError, ProviderClosedError

class SyncTests(unittest.TestCase):
    def test_concurrency_isolation_and_close(self):
        calls = []
        closed = []
        def factory():
            calls.append(1)
            return object()
        provider = Singleton(factory, close=closed.append)
        with ThreadPoolExecutor(max_workers=16) as pool:
            values = list(pool.map(lambda _: provider.get(), range(64)))
        self.assertEqual(len(calls), 1)
        self.assertTrue(all(v is values[0] for v in values))
        self.assertIsNot(Singleton(factory).get(), values[0])
        provider.close(); provider.close()
        self.assertEqual(closed, [values[0]])
        with self.assertRaises(ProviderClosedError): provider.get()

    def test_unused_and_none(self):
        unused = Singleton(lambda: self.fail("unused factory ran"))
        unused.close()
        closed = []
        p = Singleton(lambda: None, close=closed.append)
        self.assertIsNone(p.get()); p.close()
        self.assertEqual(closed, [None])

    def test_sticky_failure_and_recursive_factory(self):
        calls = []
        def fail():
            calls.append(1)
            raise ValueError("offline")
        p = Singleton(fail)
        for _ in range(2):
            with self.assertRaises(InitializationError): p.get()
        self.assertEqual(len(calls), 1)
        p.close()
        recursive = Singleton(lambda: recursive.get())
        with self.assertRaises(InitializationError): recursive.get()

    def test_cleanup_failure_once(self):
        calls = []
        def close(value):
            calls.append(value)
            raise ValueError("cleanup")
        p = Singleton(lambda: 1, close=close); p.get()
        for _ in range(2):
            with self.assertRaises(ValueError): p.close()
        self.assertEqual(calls, [1])

class AsyncTests(unittest.IsolatedAsyncioTestCase):
    async def test_cancelled_waiter_and_single_initialization(self):
        entered, release = asyncio.Event(), asyncio.Event()
        calls, closed = [], []
        async def factory():
            calls.append(1); entered.set(); await release.wait(); return object()
        async def cleanup(value): closed.append(value)
        p = AsyncSingleton(factory, close=cleanup)
        cancelled = asyncio.create_task(p.get()); await entered.wait()
        cancelled.cancel()
        with self.assertRaises(asyncio.CancelledError): await cancelled
        others = [asyncio.create_task(p.get()) for _ in range(32)]
        release.set(); values = await asyncio.gather(*others)
        self.assertEqual(calls, [1])
        self.assertTrue(all(v is values[0] for v in values))
        await p.aclose(); await p.aclose()
        self.assertEqual(closed, [values[0]])
        with self.assertRaises(ProviderClosedError): await p.get()

    async def test_failure_unused_and_recursive(self):
        calls = []
        async def fail(): calls.append(1); raise ValueError("offline")
        p = AsyncSingleton(fail)
        for _ in range(2):
            with self.assertRaises(InitializationError): await p.get()
        self.assertEqual(calls, [1]); await p.aclose()
        unused = AsyncSingleton(fail); await unused.aclose()
        self.assertEqual(calls, [1])
        async def recurse(): return await recursive.get()
        recursive = AsyncSingleton(recurse)
        with self.assertRaises(InitializationError): await recursive.get()
        await recursive.aclose()

    async def test_close_drains_inflight_initialization(self):
        entered, release = asyncio.Event(), asyncio.Event()
        closed = []
        async def factory(): entered.set(); await release.wait(); return 1
        async def cleanup(value): closed.append(value)
        p = AsyncSingleton(factory, close=cleanup)
        waiter = asyncio.create_task(p.get()); await entered.wait()
        closer = asyncio.create_task(p.aclose()); await asyncio.sleep(0)
        with self.assertRaises(ProviderClosedError): await p.get()
        release.set(); self.assertEqual(await waiter, 1); await closer
        self.assertEqual(closed, [1])

    async def test_cleanup_failure_once(self):
        calls = []
        async def factory(): return 1
        async def cleanup(value): calls.append(value); raise ValueError("cleanup")
        p = AsyncSingleton(factory, close=cleanup); await p.get()
        for _ in range(2):
            with self.assertRaises(ValueError): await p.aclose()
        self.assertEqual(calls, [1])
