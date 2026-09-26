"""Web layer: features and endpoints, one dispatcher, three adapters (server, Lambda, CLI).

    from rt_app.web import App, serve, handler_for
    app = App([Health().feature(), flags.feature()], local_admin=True)
    serve(app)                    # python -m rt_app.web serve app:app
    handler = handler_for(app)    # AWS Lambda (API Gateway v1/v2)
                                  # python -m rt_app.web call app:app GET /health/live
    App(features, authenticate=auth.actor_from_request, acl=acl,
        fallback=proxy_to("http://127.0.0.1:4000"))  # forward unported routes to the Node core
"""
from .app import (
    ADMIN_PREFIX,
    DEFAULT_BODY_LIMIT,
    LOCAL_OWNER,
    Access,
    AccessPolicy,
    Actor,
    App,
    Context,
    Endpoint,
    Fallback,
    Feature,
    Request,
    Response,
    decode_uri_component,
    parse_body,
    serve_raw,
)
from .aws_lambda import handler_for, parse_event
from .proxy import Proxy, proxy_to
from .server import serve

__all__ = [
    "ADMIN_PREFIX",
    "DEFAULT_BODY_LIMIT",
    "LOCAL_OWNER",
    "Access",
    "AccessPolicy",
    "Actor",
    "App",
    "Context",
    "Endpoint",
    "Fallback",
    "Feature",
    "Request",
    "Response",
    "decode_uri_component",
    "parse_body",
    "serve_raw",
    "handler_for",
    "parse_event",
    "serve",
    "Proxy",
    "proxy_to",
]
