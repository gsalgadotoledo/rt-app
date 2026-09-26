import json
import unittest

from app import create_app
from rt_app.web import Request, handler_for


class AppTests(unittest.TestCase):
    def test_native_routes(self):
        app = create_app()
        self.assertEqual(app.handle(Request("GET", "/hello")).body, {"message": "Hello from Python", "language": "python"})
        self.assertEqual(app.handle(Request("GET", "/health/live")).body, {"ok": True})
        saved = app.handle(Request("PUT", "/admin/app/feature-flags/new-ui", body={"version": None, "description": "", "enabled": True, "public": True, "rollout": 100, "subjects": []}))
        self.assertEqual(saved.status, 200)
        self.assertEqual(app.handle(Request("POST", "/feature-flags/evaluate", body={"keys": ["new-ui"]})).body, {"new-ui": True})

    def test_lambda_mode(self):
        result = handler_for(create_app())({"version": "2.0", "rawPath": "/hello", "requestContext": {"http": {"method": "GET", "sourceIp": "127.0.0.1"}}, "headers": {}}, None)
        self.assertEqual((result["statusCode"], json.loads(result["body"])["language"]), (200, "python"))


if __name__ == "__main__":
    unittest.main()
