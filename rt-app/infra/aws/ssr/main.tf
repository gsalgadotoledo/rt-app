variable "name" { type = string }
variable "environment" { type = string }
variable "region" { type = string }
variable "api_url" { type = string }
variable "admin_url" { type = string }
variable "spa_url" { type = string }
variable "revision" { type = string }
data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}
locals {
  branch = var.environment == "prod" ? "main" : var.environment
  arn    = "arn:${data.aws_partition.current.partition}"
  url    = "https://${local.branch}.${aws_amplify_app.ssr.default_domain}"
}
resource "aws_iam_role" "hosting" {
  name                 = "${var.name}-amplify"
  permissions_boundary = "${local.arn}:iam::${data.aws_caller_identity.current.account_id}:policy/${var.name}-amplify-boundary"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{
    Effect    = "Allow", Principal = { Service = "amplify.amazonaws.com" }, Action = "sts:AssumeRole",
    Condition = { StringEquals = { "aws:SourceAccount" = data.aws_caller_identity.current.account_id } }
  }] })
}
resource "aws_iam_role_policy" "logging" {
  role = aws_iam_role.hosting.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Action = ["logs:DescribeLogGroups"], Resource = "*" },
    { Effect = "Allow", Action = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"], Resource = "${local.arn}:logs:${var.region}:${data.aws_caller_identity.current.account_id}:log-group:/aws/amplify/${aws_amplify_app.ssr.id}:*" }
  ] })
}
resource "aws_amplify_app" "ssr" {
  name                        = "${var.name}-ssr"
  platform                    = "WEB_COMPUTE"
  iam_service_role_arn        = aws_iam_role.hosting.arn
  enable_branch_auto_build    = false
  enable_auto_branch_creation = false
  environment_variables       = { AMPLIFY_MONOREPO_APP_ROOT = "apps/ssr", ELECTRON_SKIP_BINARY_DOWNLOAD = "1" }
  build_spec = yamlencode({ version = 1, applications = [{
    appRoot = "apps/ssr",
    frontend = {
      buildPath = "/",
      phases = {
        preBuild = { commands = ["nvm use 22", "npm ci", "node rt-app/scripts/prepare-ssr.mjs"] },
        build    = { commands = ["npm run build -w @gsalgadotoledo/rt-app-ssr"] }
      },
      artifacts = { baseDirectory = "apps/ssr/.next", files = ["**/*"] },
      cache     = { paths = ["node_modules/**/*", "apps/ssr/.next/cache/**/*"] }
    }
  }] })
  # The installer connects GitHub through the SDK, keeping its token out of state.
  lifecycle { ignore_changes = [repository, access_token, oauth_token] }
}
resource "aws_amplify_branch" "ssr" {
  app_id            = aws_amplify_app.ssr.id
  branch_name       = local.branch
  framework         = "Next.js - SSR"
  stage             = var.environment == "prod" ? "PRODUCTION" : "DEVELOPMENT"
  enable_auto_build = false
  environment_variables = {
    RT_APP_ENVIRONMENT = var.environment
    RT_APP_API_URL     = var.api_url
    RT_APP_ADMIN_URL   = var.admin_url
    RT_APP_SPA_URL     = var.spa_url
    RT_APP_SSR_URL     = local.url
    RT_APP_REVISION    = var.revision
  }
}
output "url" { value = local.url }
output "app_id" { value = aws_amplify_app.ssr.id }
output "branch" { value = aws_amplify_branch.ssr.branch_name }
