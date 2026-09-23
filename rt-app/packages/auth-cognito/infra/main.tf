terraform {
  required_providers {
    aws = { source = "hashicorp/aws", version = "= 6.36.0" }
  }
}
variable "name" { type = string }
variable "region" { type = string }
variable "mail_from" { type = string }
data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}
resource "aws_cognito_user_pool" "application" {
  name                     = var.name
  user_pool_tier           = "ESSENTIALS"
  deletion_protection      = "ACTIVE"
  alias_attributes         = ["email"]
  auto_verified_attributes = ["email"]
  username_configuration { case_sensitive = false }
  admin_create_user_config { allow_admin_create_user_only = true }
  mfa_configuration = "OPTIONAL"
  software_token_mfa_configuration { enabled = true }
  sign_in_policy { allowed_first_auth_factors = ["PASSWORD", "EMAIL_OTP"] }
  password_policy {
    minimum_length    = 12
    require_lowercase = false
    require_uppercase = false
    require_numbers   = false
    require_symbols   = false
  }
  account_recovery_setting {
    recovery_mechanism {
      name     = "verified_email"
      priority = 1
    }
  }
  email_configuration {
    email_sending_account = "DEVELOPER"
    from_email_address    = var.mail_from
    source_arn            = "arn:${data.aws_partition.current.partition}:ses:${var.region}:${data.aws_caller_identity.current.account_id}:identity/${var.mail_from}"
  }
  tags = { Application = var.name }
  lifecycle { prevent_destroy = true }
}
resource "aws_cognito_user_pool_client" "application" {
  name                          = "${var.name}-application"
  user_pool_id                  = aws_cognito_user_pool.application.id
  generate_secret               = false
  explicit_auth_flows           = ["ALLOW_USER_PASSWORD_AUTH", "ALLOW_USER_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"]
  prevent_user_existence_errors = "ENABLED"
  enable_token_revocation       = true
  access_token_validity         = 15
  id_token_validity             = 15
  refresh_token_validity        = 1
  token_validity_units {
    access_token  = "minutes"
    id_token      = "minutes"
    refresh_token = "days"
  }
  read_attributes  = ["email", "email_verified"]
  write_attributes = ["email"]
}
output "pool_id" { value = aws_cognito_user_pool.application.id }
output "pool_arn" { value = aws_cognito_user_pool.application.arn }
output "client_id" { value = aws_cognito_user_pool_client.application.id }
