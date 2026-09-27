"""Local inbox: GET /__dev/mailbox lists the codes the local mailer captured.

A development tool like the TypeScript local server's: never mounted on AWS Lambda. Mailers that
should appear here capture into MAILBOX, e.g. ``LocalSmtpMailer(port=1025, capture=MAILBOX)``.
"""
import os

from rt_app.auth import LocalMailbox
from rt_app.mail import mailbox_feature

MAILBOX = LocalMailbox()


def features(components):
    if os.environ.get("AWS_LAMBDA_FUNCTION_NAME"):
        return []
    return [mailbox_feature(MAILBOX)]
