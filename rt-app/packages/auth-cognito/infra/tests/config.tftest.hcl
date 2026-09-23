mock_provider "aws" {}
override_data {
  target = data.aws_caller_identity.current
  values = { account_id = "123456789012" }
}
override_data {
  target = data.aws_partition.current
  values = { partition = "aws" }
}
run "password_email_and_totp_no_sms" {
  command = plan
  variables {
    name      = "rt-app-test"
    region    = "us-east-1"
    mail_from = "mail@example.test"
  }
  assert {
    condition     = aws_cognito_user_pool.application.user_pool_tier == "ESSENTIALS" && aws_cognito_user_pool.application.mfa_configuration == "OPTIONAL" && aws_cognito_user_pool.application.software_token_mfa_configuration[0].enabled
    error_message = "Email first-factor and optional TOTP require the chosen pool configuration."
  }
  assert {
    condition     = length(aws_cognito_user_pool.application.sms_configuration) == 0 && !aws_cognito_user_pool_client.application.generate_secret && aws_cognito_user_pool.application.admin_create_user_config[0].allow_admin_create_user_only
    error_message = "No SMS, browser client secret or unauthenticated self-registration."
  }
}
