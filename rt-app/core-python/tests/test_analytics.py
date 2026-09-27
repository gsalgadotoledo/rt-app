import contextvars
import unittest

from rt_app.analytics import Analytics


class Spy:
    def __init__(self):
        self.calls = []
        self.context = contextvars.ContextVar("context", default={})

    def with_context(self, context, operation):
        token = self.context.set({**self.context.get(), **context})
        try:
            return operation()
        finally:
            self.context.reset(token)

    def emit(self, level, kind, source, message, data):
        self.calls.append(("emit", level, kind, source, message, data, self.context.get()))
        return "emitted"

    def count_view(self, message, options):
        self.calls.append(("countView", message, options, self.context.get()))


class AnalyticsTests(unittest.TestCase):
    def test_track_and_page_view_delegate_in_the_analytics_category(self):
        spy = Spy()
        analytics = Analytics(spy)
        self.assertEqual(analytics.track("checkout.completed", {"plan": "pro"}), "emitted")
        analytics.track("signup", source="web")
        analytics.page_view("Home", {"url": "/"})
        category = {"category": "analytics"}
        self.assertEqual(spy.calls, [
            ("emit", "info", "analytics", "app", "checkout.completed", {"plan": "pro"}, category),
            ("emit", "info", "analytics", "web", "signup", {}, category),
            ("countView", "Home", {"url": "/"}, category),
        ])
        self.assertEqual(spy.context.get(), {})

    def test_names_are_stable_ascii_identifiers(self):
        spy = Spy()
        analytics = Analytics(spy)
        for name in ["bad name", "1st", "", "a\n", "café", "xK", "a" * 81, None, ["ok"], 5]:
            with self.subTest(name=name), self.assertRaisesRegex(ValueError, "Use a stable analytics event name"):
                analytics.track(name)
        analytics.track("a" * 80)
        analytics.track("aZ09._-")
        self.assertEqual(len(spy.calls), 2)


if __name__ == "__main__":
    unittest.main()
