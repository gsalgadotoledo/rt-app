"""Local HTTP server: python main.py (PORT, default 4010). Other modes:

    python -m rt_app.web lambda-local app:create_app       # the Lambda handler behind local HTTP
    python -m rt_app.web call app:create_app GET /hello     # one request from the command line
"""
import os

from app import create_app
from rt_app.web import serve

if __name__ == "__main__":
    serve(create_app(), int(os.environ.get("PORT", "4010")))
