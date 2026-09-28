mock_provider "aws" {}
mock_provider "archive" {}
override_data {
  target = data.aws_partition.current
  values = { partition = "aws" }
}
override_data {
  target = data.aws_caller_identity.current
  values = { account_id = "123456789012" }
}
override_data {
  target = data.archive_file.lambda
  values = { output_path = "/tmp/bundle.zip", output_base64sha256 = "c2hh" }
}
variables {
  cognito_user_pool_id   = "us-east-1_test"
  cognito_user_pool_arn  = "arn:aws:cognito-idp:us-east-1:123456789012:userpool/us-east-1_test"
  cognito_client_id      = "client"
  region                 = "us-east-1"
  app                    = "rt-app-test"
  environment            = "stage"
  mail_from              = "mail@example.test"
  revision               = "abc"
  lambda_bundle_path     = "/tmp/bundle"
  lambda_archive_path    = "/tmp/bundle.zip"
  application_table_name = "rt-app-test-stage-application"
  table_arns             = ["arn:aws:dynamodb:us-east-1:123456789012:table/rt-app-test-stage-application"]
  allowed_origins        = ["https://admin.example.test"]
}
run "protected_secrets_keep_their_recovery_window" {
  command = plan
  assert {
    condition     = alltrue([for secret in [aws_secretsmanager_secret.jwt, aws_secretsmanager_secret.infra, aws_secretsmanager_secret.admin_password] : secret.recovery_window_in_days == 30])
    error_message = "Protected environments keep deleted secrets recoverable for 30 days."
  }
  assert {
    condition     = length(aws_apigatewayv2_domain_name.api) == 0 && length(aws_route53_record.api) == 0 && output.api.domain == null
    error_message = "Without domain the API keeps only its execute-api URL."
  }
}
run "unprotected_secrets_are_deleted_immediately" {
  command = plan
  variables {
    protect        = false
    stripe_enabled = true
  }
  assert {
    condition     = alltrue([for secret in concat([aws_secretsmanager_secret.jwt, aws_secretsmanager_secret.infra, aws_secretsmanager_secret.admin_password], aws_secretsmanager_secret.stripe) : secret.recovery_window_in_days == 0])
    error_message = "protect = false must free the secret names at destroy so the environment can be recreated."
  }
}
run "custom_domain_with_route53" {
  command = plan
  variables {
    domain          = "api.example.test"
    certificate_arn = "arn:aws:acm:us-east-1:123456789012:certificate/abc"
    zone_id         = "Z123"
  }
  assert {
    condition     = aws_apigatewayv2_domain_name.api[0].domain_name == "api.example.test" && aws_apigatewayv2_domain_name.api[0].domain_name_configuration[0].endpoint_type == "REGIONAL" && aws_apigatewayv2_domain_name.api[0].domain_name_configuration[0].security_policy == "TLS_1_2"
    error_message = "The API domain must be regional with TLS 1.2."
  }
  assert {
    condition     = length(aws_apigatewayv2_api_mapping.api) == 1 && aws_route53_record.api[0].type == "A" && aws_route53_record.api[0].zone_id == "Z123"
    error_message = "The domain must map to the live stage and get an alias record in the zone."
  }
  assert {
    condition     = output.deployment.ApiUrl == "https://api.example.test" && output.api.url == "https://api.example.test"
    error_message = "ApiUrl must use the custom domain."
  }
}
run "custom_domain_with_external_dns" {
  command = plan
  variables {
    domain          = "api.example.test"
    certificate_arn = "arn:aws:acm:us-east-1:123456789012:certificate/abc"
  }
  assert {
    condition     = length(aws_apigatewayv2_domain_name.api) == 1 && length(aws_route53_record.api) == 0 && !output.api.dns_managed
    error_message = "Without zone_id no Route53 record is created."
  }
}
run "domain_requires_certificate" {
  command = plan
  variables {
    domain = "api.example.test"
  }
  expect_failures = [var.certificate_arn]
}
run "zone_requires_domain" {
  command = plan
  variables {
    zone_id = "Z123"
  }
  expect_failures = [var.zone_id]
}
run "extra_environment_reaches_the_api_and_core_values_win" {
  command = plan
  variables {
    extra_environment = {
      RT_AGENT_ADMIN_URL            = "https://agent.example.test"
      RT_AGENT_ADMIN_KEY_SECRET_ARN = "arn:aws:secretsmanager:us-east-1:123456789012:secret:app/agent/admin-key"
      TABLE_NAME                    = "not-the-table"
    }
    extra_secret_arns = ["arn:aws:secretsmanager:us-east-1:123456789012:secret:app/agent/admin-key"]
  }
  assert {
    condition     = aws_lambda_function.api.environment[0].variables["RT_AGENT_ADMIN_URL"] == "https://agent.example.test"
    error_message = "The app's own variables reach the API."
  }
  assert {
    condition     = aws_lambda_function.api.environment[0].variables["TABLE_NAME"] == "rt-app-test-stage-application"
    error_message = "The core's variables win on a clash."
  }
}
run "a_secret_is_never_an_extra_variable" {
  command = plan
  variables {
    extra_environment = { RT_AGENT_ADMIN_KEY = "plain" }
  }
  expect_failures = [var.extra_environment]
}
