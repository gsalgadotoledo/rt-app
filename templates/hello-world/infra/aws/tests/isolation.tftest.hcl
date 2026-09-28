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
run "environments_are_protected_by_default" {
  command = plan
  variables {
    region      = "us-east-1"
    app         = "rt-app-test"
    environment = "prod"
    mail_from   = "mail@example.com"
    revision    = "test"
  }
  assert {
    condition     = aws_dynamodb_table.application.deletion_protection_enabled && aws_dynamodb_table.application.point_in_time_recovery[0].enabled && aws_dynamodb_table.application.server_side_encryption[0].enabled
    error_message = "Tables keep deletion protection, point-in-time recovery and encryption."
  }
  assert {
    condition     = terraform_data.protect.input && module.admin.site.protected && module.public.site.protected && output.deployment.Protected
    error_message = "The destroy guard and the site buckets are protected by default."
  }
}
run "unprotected_environment_can_be_destroyed" {
  command = plan
  variables {
    region      = "us-east-1"
    app         = "rt-app-test"
    environment = "develop"
    mail_from   = "mail@example.com"
    revision    = "test"
    protect     = false
  }
  assert {
    condition     = !aws_dynamodb_table.application.deletion_protection_enabled && aws_dynamodb_table.application.point_in_time_recovery[0].enabled && aws_dynamodb_table.application.server_side_encryption[0].enabled
    error_message = "protect = false lifts only the deletion protection; backups and encryption stay on."
  }
  assert {
    condition     = !terraform_data.protect.input && !module.admin.site.protected && !module.public.site.protected
    error_message = "protect = false must reach the guard and every bucket."
  }
}
run "custom_domains" {
  command = plan
  override_data {
    target = module.ssr.data.aws_route53_zone.domain[0]
    values = { name = "example.com" }
  }
  variables {
    region              = "us-east-1"
    app                 = "rt-app-test"
    environment         = "prod"
    mail_from           = "mail@example.com"
    revision            = "test"
    public_domain       = "www.example.com"
    admin_domain        = "admin.example.com"
    certificate_arn     = "arn:aws:acm:us-east-1:123456789012:certificate/sites"
    api_domain          = "api.example.com"
    api_certificate_arn = "arn:aws:acm:us-east-1:123456789012:certificate/api"
    ssr_domain          = "example.com"
    zone_id             = "Z123"
  }
  assert {
    condition     = module.public.site.url == "https://www.example.com" && module.admin.site.url == "https://admin.example.com" && module.api.deployment.ApiUrl == "https://api.example.com" && module.ssr.url == "https://example.com"
    error_message = "Every role must publish its custom domain URL."
  }
}
