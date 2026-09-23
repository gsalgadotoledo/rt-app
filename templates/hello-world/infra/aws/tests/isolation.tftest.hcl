override_data {
  target = module.ssr.data.aws_partition.current
  values = { partition = "aws" }
}
override_data {
  target = module.ssr.data.aws_caller_identity.current
  values = { account_id = "123456789012" }
}
override_data {
  target = module.authentication.data.aws_partition.current
  values = { partition = "aws" }
}
override_data {
  target = module.authentication.data.aws_caller_identity.current
  values = { account_id = "123456789012" }
}
mock_provider "aws" {}
override_data {
  target = data.aws_caller_identity.current
  values = { account_id = "123456789012" }
}
override_data {
  target = module.api.data.aws_partition.current
  values = { partition = "aws" }
}
override_data {
  target = module.api.data.aws_caller_identity.current
  values = { account_id = "123456789012" }
}
run "private_sites_and_separate_identity" {
  command = plan
  variables {
    region      = "us-east-1"
    app         = "rt-app-test"
    environment = "develop"
    mail_from   = "mail@example.com"
    revision    = "test"
  }
  assert {
    condition     = !contains(keys(module.api.environment_variables), "ADMIN_TABLE_NAME")
    error_message = "The admin must not depend on a database."
  }
  assert {
    condition     = module.admin.site.private && module.public.site.private
    error_message = "Both S3 sites must remain private."
  }
  assert {
    condition     = !contains(keys(module.api.environment_variables), "JWT_SECRET")
    error_message = "Plaintext JWT secrets must not be in the Terraform-managed environment."
  }
}
run "production_table_has_no_environment_suffix" {
  command = plan
  variables {
    region      = "us-east-1"
    app         = "rt-app-test"
    environment = "prod"
    mail_from   = "mail@example.com"
    revision    = "test"
  }
  assert {
    condition     = aws_dynamodb_table.application.name == "rt-app-test-application"
    error_message = "Production must use the base application name."
  }
}
run "cognito_uses_totp_without_sms_and_cloud_adapter" {
  command = plan
  variables {
    region      = "us-east-1"
    app         = "rt-app-test"
    environment = "prod"
    mail_from   = "mail@example.com"
    revision    = "test"
  }
  assert {
    condition     = module.api.environment_variables.AUTH_PROVIDER == "cognito"
    error_message = "AWS must select Cognito, never local password hashes."
  }
}
