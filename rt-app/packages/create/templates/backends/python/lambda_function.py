"""AWS Lambda entry point (API Gateway HTTP API or REST): handler = lambda_function.handler."""
from app import create_app
from rt_app.web import handler_for

handler = handler_for(create_app())
