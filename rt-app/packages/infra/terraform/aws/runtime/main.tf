terraform {
  required_version = ">= 1.11.0, < 2.0.0"
  required_providers {
    aws = {
      source = "hashicorp/aws", version = "= 6.36.0"
    }
    archive = {
      source = "hashicorp/archive", version = "~> 2.7"
    }
  }
}

variable "cognito_user_pool_id" { type = string }
variable "cognito_user_pool_arn" { type = string }
variable "cognito_client_id" { type = string }
variable "region" { type = string }
variable "stripe_enabled" {
  type    = bool
  default = false
}
variable "app" { type = string }
variable "environment" { type = string }
variable "mail_from" { type = string }
variable "revision" { type = string }
variable "lambda_bundle_path" { type = string }
variable "lambda_archive_path" { type = string }
variable "application_table_name" { type = string }
variable "table_arns" { type = list(string) }
variable "allowed_origins" { type = list(string) }
variable "protect" {
  description = "Keep secrets recoverable for 30 days after deletion (true). false deletes them immediately on destroy, so the environment can be created again with the same names. Apply protect = false before terraform destroy."
  type        = bool
  default     = true
}
variable "domain" {
  description = "Optional custom domain for the API, for example api.example.com. Empty keeps the execute-api URL."
  type        = string
  default     = ""
  validation {
    condition     = var.domain == "" || can(regex("^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,63}$", var.domain))
    error_message = "Use a lowercase host name such as api.example.com, without scheme or path."
  }
}
variable "certificate_arn" {
  description = "Regional ACM certificate for domain, issued in the API's region (not us-east-1 unless the API runs there). Required when domain is set."
  type        = string
  default     = ""
  validation {
    condition     = var.domain == "" ? var.certificate_arn == "" : can(regex("^arn:aws[a-z-]*:acm:[a-z0-9-]+:[0-9]{12}:certificate/", var.certificate_arn))
    error_message = "certificate_arn is required with domain and must be empty without it."
  }
}
variable "zone_id" {
  description = "Optional Route53 hosted zone for domain. When set, an A alias record points domain at API Gateway; empty means you create the DNS record yourself (CNAME to the regional target in the outputs)."
  type        = string
  default     = ""
  validation {
    condition     = var.zone_id == "" || var.domain != ""
    error_message = "zone_id requires domain."
  }
}
data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}
locals {
  name          = var.environment == "prod" ? var.app : "${var.app}-${var.environment}"
  custom_domain = var.domain != ""
  # Secrets Manager keeps deleted secrets (and reserves their names) for the recovery window.
  secret_recovery_days = var.protect ? 30 : 0
}
data "archive_file" "lambda" {
  type        = "zip"
  source_dir  = var.lambda_bundle_path
  output_path = var.lambda_archive_path
}
resource "aws_secretsmanager_secret" "jwt" {
  name                    = "${local.name}/jwt"
  recovery_window_in_days = local.secret_recovery_days
}
resource "aws_secretsmanager_secret" "infra" {
  name                    = "${local.name}/infra"
  recovery_window_in_days = local.secret_recovery_days
}
resource "aws_cloudwatch_log_group" "api" {
  name              = "/aws/lambda/${local.name}"
  retention_in_days = 30
}
resource "aws_cloudwatch_log_group" "observer" {
  name              = "/aws/lambda/${local.name}/observer"
  retention_in_days = 7
}
resource "aws_cloudwatch_log_stream" "observer" {
  name           = "events"
  log_group_name = aws_cloudwatch_log_group.observer.name
}
resource "aws_iam_role" "lambda" {
  name                 = "${local.name}-lambda"
  permissions_boundary = "arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:policy/${local.name}-runtime-boundary"
  assume_role_policy = jsonencode({
    Version = "2012-10-17", Statement = [{
      Effect = "Allow", Principal = {
        Service = "lambda.amazonaws.com"
      },
      Action = "sts:AssumeRole"
      }
    ]
    }
  )
}
resource "aws_iam_role_policy" "lambda" {
  role = aws_iam_role.lambda.id
  policy = jsonencode({
    Version = "2012-10-17", Statement = [
      { Effect = "Allow", Action = ["tag:GetResources", "ce:GetCostAndUsage", "ce:GetCostAndUsageWithResources", "budgets:ViewBudget"], Resource = "*" },
      { Effect = "Allow", Action = ["lambda:GetFunctionConcurrency", "lambda:ListTags", "lambda:PutFunctionConcurrency", "lambda:DeleteFunctionConcurrency"], Resource = "arn:${data.aws_partition.current.partition}:lambda:${var.region}:${data.aws_caller_identity.current.account_id}:function:${local.name}" },
      { Effect = "Allow", Action = ["cognito-idp:AdminDisableUser", "cognito-idp:AdminEnableUser", "cognito-idp:AdminCreateUser", "cognito-idp:AdminGetUser", "cognito-idp:AdminSetUserPassword", "cognito-idp:AdminSetUserMFAPreference", "cognito-idp:AdminUserGlobalSignOut", "cognito-idp:AdminUpdateUserAttributes"], Resource = var.cognito_user_pool_arn },
      {
        Effect = "Allow", Action = ["logs:CreateLogStream", "logs:PutLogEvents"], Resource = "${aws_cloudwatch_log_group.api.arn}:*"
      },
      { Effect = "Allow", Action = ["logs:PutLogEvents", "logs:FilterLogEvents"], Resource = "${aws_cloudwatch_log_group.observer.arn}:*" },
      {
        Effect = "Allow", Action = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:Query", "dynamodb:TransactWriteItems"], Resource = var.table_arns
      },
      {
        Effect = "Allow", Action = ["secretsmanager:GetSecretValue"], Resource = concat([aws_secretsmanager_secret.jwt.arn, aws_secretsmanager_secret.admin_password.arn], aws_secretsmanager_secret.stripe[*].arn)
      },
      {
        Effect = "Allow", Action = ["secretsmanager:GetSecretValue", "secretsmanager:PutSecretValue"], Resource = aws_secretsmanager_secret.infra.arn
      },
      {
        Effect = "Allow", Action = ["ses:SendEmail"], Resource = "arn:${data.aws_partition.current.partition}:ses:${var.region}:${data.aws_caller_identity.current.account_id}:identity/*", Condition = {
          StringEquals = {
            "ses:FromAddress" = var.mail_from
          }
        }
      }
    ]
    }
  )
}
resource "aws_lambda_function" "api" {
  function_name                  = local.name
  role                           = aws_iam_role.lambda.arn
  runtime                        = "nodejs22.x"
  handler                        = "index.handler"
  filename                       = data.archive_file.lambda.output_path
  source_code_hash               = data.archive_file.lambda.output_base64sha256
  memory_size                    = 512
  timeout                        = 25
  reserved_concurrent_executions = 5
  publish                        = true
  environment {
    variables = {
      TABLE_NAME                 = var.application_table_name
      SUBSCRIPTIONS_PROVIDER     = var.stripe_enabled ? "stripe" : "none"
      STRIPE_SECRET_ARN          = var.stripe_enabled ? aws_secretsmanager_secret.stripe[0].arn : ""
      ADMIN_PASSWORD_SECRET_ARN  = aws_secretsmanager_secret.admin_password.arn
      JWT_SECRET_ARN             = aws_secretsmanager_secret.jwt.arn
      AWS_CREDENTIALS_SECRET_ARN = aws_secretsmanager_secret.infra.arn
      MAIL_FROM                  = var.mail_from
      NOSQL_PROVIDER             = "dynamodb"
      INFRA_PROVIDER             = "aws"
      RT_APP_ENVIRONMENT         = var.environment
      OBSERVER_LOG_GROUP         = aws_cloudwatch_log_group.observer.name
      OBSERVER_LOG_STREAM        = aws_cloudwatch_log_stream.observer.name
      RT_APP_AWS_APP             = var.app
      AUTH_PROVIDER              = "cognito"
      COGNITO_USER_POOL_ID       = var.cognito_user_pool_id
      COGNITO_CLIENT_ID          = var.cognito_client_id
      RT_APP_REVISION            = var.revision
    }
  }
  depends_on = [aws_iam_role_policy.lambda, aws_cloudwatch_log_group.api]
}
resource "aws_lambda_alias" "live" {
  name             = "live"
  function_name    = aws_lambda_function.api.function_name
  function_version = aws_lambda_function.api.version
}
resource "aws_apigatewayv2_api" "api" {
  name          = local.name
  protocol_type = "HTTP"
  cors_configuration {
    allow_origins = var.allowed_origins
    allow_methods = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]
    allow_headers = ["content-type", "authorization", "idempotency-key"]
    max_age       = 600
  }
}
resource "aws_apigatewayv2_integration" "api" {
  api_id                 = aws_apigatewayv2_api.api.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_alias.live.invoke_arn
  payload_format_version = "2.0"
}
resource "aws_apigatewayv2_route" "api" {
  api_id    = aws_apigatewayv2_api.api.id
  route_key = "$default"
  target    = "integrations/${aws_apigatewayv2_integration.api.id}"
}
resource "aws_apigatewayv2_stage" "live" {
  api_id      = aws_apigatewayv2_api.api.id
  name        = "$default"
  auto_deploy = true
  default_route_settings {
    throttling_burst_limit = 30
    throttling_rate_limit  = 15
  }
}
resource "aws_lambda_permission" "api" {
  statement_id  = "AllowApiGateway"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.api.function_name
  qualifier     = aws_lambda_alias.live.name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.api.execution_arn}/*/*"
}
output "deployment" {
  value = {
    StripeSecretArn         = var.stripe_enabled ? aws_secretsmanager_secret.stripe[0].arn : null
    AdminPasswordSecretArn  = aws_secretsmanager_secret.admin_password.arn
    JwtSecretArn            = aws_secretsmanager_secret.jwt.arn
    AwsCredentialsSecretArn = aws_secretsmanager_secret.infra.arn
    ApiUrl                  = local.custom_domain ? "https://${var.domain}" : aws_apigatewayv2_api.api.api_endpoint
    LambdaVersion           = aws_lambda_function.api.version
  }
}
output "environment_variables" { value = aws_lambda_function.api.environment[0].variables }
output "api" {
  value = {
    url         = local.custom_domain ? "https://${var.domain}" : aws_apigatewayv2_api.api.api_endpoint
    execute_url = aws_apigatewayv2_api.api.api_endpoint
    domain      = local.custom_domain ? var.domain : null
    dns_target  = local.custom_domain ? aws_apigatewayv2_domain_name.api[0].domain_name_configuration[0].target_domain_name : null
    dns_zone_id = local.custom_domain ? aws_apigatewayv2_domain_name.api[0].domain_name_configuration[0].hosted_zone_id : null
    dns_managed = var.zone_id != ""
  }
}

# Optional custom domain: the HTTP API keeps its execute-api URL and also answers on domain.
resource "aws_apigatewayv2_domain_name" "api" {
  count       = local.custom_domain ? 1 : 0
  domain_name = var.domain
  domain_name_configuration {
    certificate_arn = var.certificate_arn
    endpoint_type   = "REGIONAL"
    security_policy = "TLS_1_2"
  }
}
resource "aws_apigatewayv2_api_mapping" "api" {
  count       = local.custom_domain ? 1 : 0
  api_id      = aws_apigatewayv2_api.api.id
  domain_name = aws_apigatewayv2_domain_name.api[0].id
  stage       = aws_apigatewayv2_stage.live.id
}
resource "aws_route53_record" "api" {
  count   = var.zone_id == "" ? 0 : 1
  zone_id = var.zone_id
  name    = var.domain
  type    = "A"
  alias {
    name                   = aws_apigatewayv2_domain_name.api[0].domain_name_configuration[0].target_domain_name
    zone_id                = aws_apigatewayv2_domain_name.api[0].domain_name_configuration[0].hosted_zone_id
    evaluate_target_health = false
  }
}


resource "aws_secretsmanager_secret" "admin_password" {
  name                    = "${local.name}/admin-password"
  recovery_window_in_days = local.secret_recovery_days
}

# Values are provisioned separately, never written to Terraform state.
resource "aws_secretsmanager_secret" "stripe" {
  count                   = var.stripe_enabled ? 1 : 0
  name                    = "${local.name}/stripe"
  recovery_window_in_days = local.secret_recovery_days
}
resource "aws_cloudwatch_event_rule" "subscriptions" {
  name                = "${local.name}-subscriptions"
  schedule_expression = "rate(5 minutes)"
}
resource "aws_cloudwatch_event_target" "subscriptions" {
  rule  = aws_cloudwatch_event_rule.subscriptions.name
  arn   = aws_lambda_alias.live.arn
  input = jsonencode({ source = "rt-app.subscriptions" })
}
resource "aws_lambda_permission" "subscriptions" {
  statement_id  = "SubscriptionMaintenance"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.api.function_name
  qualifier     = aws_lambda_alias.live.name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.subscriptions.arn
}
