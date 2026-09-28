variable "name" { type = string }
variable "environment" { type = string }
variable "region" { type = string }
variable "api_url" { type = string }
variable "admin_url" { type = string }
variable "spa_url" { type = string }
variable "revision" { type = string }
variable "domain" {
  description = "Optional custom domain added to this environment's Amplify app, for example example.com or stage.example.com. A domain can belong to one Amplify app only, so give each environment its own."
  type        = string
  default     = ""
  validation {
    condition     = var.domain == "" || can(regex("^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,63}$", var.domain))
    error_message = "Use a lowercase host name such as example.com, without scheme or path."
  }
}
variable "domain_prefix" {
  description = "Subdomain of domain that serves the branch: \"\" serves domain itself, \"app\" serves app.<domain>."
  type        = string
  default     = ""
  validation {
    condition     = var.domain_prefix == "" || (var.domain != "" && can(regex("^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$", var.domain_prefix)))
    error_message = "domain_prefix must be one lowercase DNS label and requires domain."
  }
}
variable "zone_id" {
  description = "Optional Route53 hosted zone of domain in this AWS account. When set, Amplify writes its certificate and routing records there and Terraform waits for verification. Empty: add the records from the dns_records output at your DNS provider."
  type        = string
  default     = ""
  validation {
    condition     = var.zone_id == "" || var.domain != ""
    error_message = "zone_id requires domain."
  }
}
data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}
data "aws_route53_zone" "domain" {
  count   = var.zone_id == "" ? 0 : 1
  zone_id = var.zone_id
}
locals {
  branch = var.environment == "prod" ? "main" : var.environment
  arn    = "arn:${data.aws_partition.current.partition}"
  host   = var.domain_prefix == "" ? var.domain : "${var.domain_prefix}.${var.domain}"
  # Route53 zone names may end with a dot.
  zone_name = var.zone_id == "" ? null : trimsuffix(one(data.aws_route53_zone.domain[*].name), ".")
  url       = var.domain != "" ? "https://${local.host}" : "https://${local.branch}.${aws_amplify_app.ssr.default_domain}"
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
        preBuild = { commands = ["nvm use 24", "npm ci", "npm exec -- rta prepare-ssr"] },
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
# Optional custom domain. Amplify issues and renews the certificate itself.
resource "aws_amplify_domain_association" "ssr" {
  count       = var.domain == "" ? 0 : 1
  app_id      = aws_amplify_app.ssr.id
  domain_name = var.domain
  # With an external DNS provider nothing can be verified before its records exist.
  wait_for_verification = var.zone_id != ""
  sub_domain {
    branch_name = aws_amplify_branch.ssr.branch_name
    prefix      = var.domain_prefix
  }
  lifecycle {
    precondition {
      condition     = local.zone_name == null || var.domain == local.zone_name || endswith(var.domain, ".${coalesce(local.zone_name, "-")}")
      error_message = "domain must belong to the Route53 zone zone_id."
    }
  }
}
output "url" { value = local.url }
output "default_url" { value = "https://${local.branch}.${aws_amplify_app.ssr.default_domain}" }
output "dns_records" {
  description = "Records to create at an external DNS provider (space-separated \"name TYPE value\"), or null without domain."
  value = var.domain == "" ? null : {
    certificate = aws_amplify_domain_association.ssr[0].certificate_verification_dns_record
    routing     = [for sub in aws_amplify_domain_association.ssr[0].sub_domain : sub.dns_record]
  }
}
output "app_id" { value = aws_amplify_app.ssr.id }
output "branch" { value = aws_amplify_branch.ssr.branch_name }
