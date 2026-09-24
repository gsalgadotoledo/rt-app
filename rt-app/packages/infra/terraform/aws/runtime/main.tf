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
data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}
locals { name = var.environment == "prod" ? var.app : "${var.app}-${var.environment}" }
data "archive_file" "lambda" {
  type        = "zip"
  source_dir  = var.lambda_bundle_path
  output_path = var.lambda_archive_path
}
resource "aws_secretsmanager_secret" "jwt" {
  name                    = "${local.name}/jwt"
  recovery_window_in_days = 30
  lifecycle {
    prevent_destroy = true
  }
}
resource "aws_secretsmanager_secret" "infra" {
  name                    = "${local.name}/infra"
  recovery_window_in_days = 30
  lifecycle {
    prevent_destroy = true
  }
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
    ApiUrl                  = aws_apigatewayv2_api.api.api_endpoint
    LambdaVersion           = aws_lambda_function.api.version
  }
}
output "environment_variables" { value = aws_lambda_function.api.environment[0].variables }


resource "aws_secretsmanager_secret" "admin_password" {
  name                    = "${local.name}/admin-password"
  recovery_window_in_days = 30
  lifecycle { prevent_destroy = true }
}

# Values are provisioned separately, never written to Terraform state.
resource "aws_secretsmanager_secret" "stripe" {
  count                   = var.stripe_enabled ? 1 : 0
  name                    = "${local.name}/stripe"
  recovery_window_in_days = 30
  lifecycle { prevent_destroy = true }
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
