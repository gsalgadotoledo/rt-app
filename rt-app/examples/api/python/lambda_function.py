"""AWS Lambda entry point (handler: lambda_function.handler) for API Gateway HTTP (v2) or REST (v1)."""
from rt_app.web import handler_for

from app import app

handler = handler_for(app)
