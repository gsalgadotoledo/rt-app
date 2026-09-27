package main

import (
	"os"

	"rt.local/core-go/auth"
	"rt.local/core-go/mail"
	"rt.local/core-go/web"
)

// localMailbox holds the codes the local mailer captured, e.g.
// mail.NewLocalSMTP(mail.WithCapture(localMailbox)).
var localMailbox = &auth.LocalMailbox{}

// Local inbox: GET /__dev/mailbox lists the captured codes. A development tool like the TypeScript
// local server's: never mounted on AWS Lambda.
func init() {
	register(func(*Components) ([]web.Feature, error) {
		if os.Getenv("AWS_LAMBDA_RUNTIME_API") != "" {
			return nil, nil
		}
		return []web.Feature{mail.MailboxFeature(localMailbox)}, nil
	})
}
