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
  backend "s3" {
  }
}
variable "stripe_enabled" {
  type    = bool
  default = false
}
variable "region" {
  type = string
}
variable "app" {
  type = string
  validation {
    condition     = can(regex("^rt-app-[a-z0-9-]{3,30}$", var.app))
    error_message = "Use rt-app- and lowercase letters/digits/hyphens."
  }
}
variable "environment" {
  type = string
  validation {
    condition     = contains(["develop", "stage", "prod"], var.environment)
    error_message = "Environment must be develop, stage or prod."
  }
}
variable "mail_from" {
  type = string
}
variable "revision" {
  type = string
}
variable "protect" {
  description = "Deletion protection for this environment: DynamoDB and Cognito deletion protection, site buckets kept on destroy, 30-day secret recovery, and a guard that stops terraform destroy before it deletes anything. Unset: environments/<environment>.json, else true. To destroy on purpose, apply with protect = false, then run terraform destroy with protect = false."
  type        = bool
  default     = null
}
# Optional custom domains. Empty values fall back to environments/<environment>.json, then to
# the AWS-generated URLs.
variable "public_domain" {
  description = "Custom domain of the public SPA, for example example.com or www.example.com."
  type        = string
  default     = ""
}
variable "admin_domain" {
  description = "Custom domain of the admin, for example admin.example.com."
  type        = string
  default     = ""
}
variable "certificate_arn" {
  description = "ACM certificate in us-east-1 covering public_domain and admin_domain (CloudFront). Required when either is set."
  type        = string
  default     = ""
}
variable "api_domain" {
  description = "Custom domain of the API, for example api.example.com."
  type        = string
  default     = ""
}
variable "api_certificate_arn" {
  description = "ACM certificate in the deployment region covering api_domain (API Gateway). Required when api_domain is set."
  type        = string
  default     = ""
}
variable "ssr_domain" {
  description = "Domain added to this environment's Amplify SSR app, for example example.com or stage.example.com. One Amplify app per domain."
  type        = string
  default     = ""
}
variable "ssr_domain_prefix" {
  description = "Subdomain of ssr_domain that serves the SSR branch (\"\" = ssr_domain itself, \"app\" = app.<ssr_domain>)."
  type        = string
  default     = ""
}
variable "zone_id" {
  description = "Route53 hosted zone (in this account) of the custom domains. When set, Terraform/Amplify write the DNS records; empty means you add them at your DNS provider."
  type        = string
  default     = ""
}
provider "aws" {
  region = var.region
  default_tags {
    tags = {
      Application = var.app, Environment = var.environment, ManagedBy = "Terraform"
    }
  }
}
data "aws_caller_identity" "current" {}
locals {
  name = var.environment == "prod" ? var.app : "${var.app}-${var.environment}"
  # Per-environment settings committed with the app, e.g. environments/prod.json:
  # {"protect": true, "public_domain": "example.com", "certificate_arn": "arn:aws:acm:us-east-1:..."}
  settings_file = "${path.module}/environments/${var.environment}.json"
  settings      = fileexists(local.settings_file) ? jsondecode(file(local.settings_file)) : {}
  setting_names = ["protect", "public_domain", "admin_domain", "certificate_arn", "api_domain", "api_certificate_arn", "ssr_domain", "ssr_domain_prefix", "zone_id"]
  # A variable that is set (TF_VAR_*, -var) wins over the file.
  protect = var.protect != null ? var.protect : try(tobool(local.settings.protect), true)
  domains = {
    public_domain       = var.public_domain != "" ? var.public_domain : try(tostring(local.settings.public_domain), "")
    admin_domain        = var.admin_domain != "" ? var.admin_domain : try(tostring(local.settings.admin_domain), "")
    certificate_arn     = var.certificate_arn != "" ? var.certificate_arn : try(tostring(local.settings.certificate_arn), "")
    api_domain          = var.api_domain != "" ? var.api_domain : try(tostring(local.settings.api_domain), "")
    api_certificate_arn = var.api_certificate_arn != "" ? var.api_certificate_arn : try(tostring(local.settings.api_certificate_arn), "")
    ssr_domain          = var.ssr_domain != "" ? var.ssr_domain : try(tostring(local.settings.ssr_domain), "")
    ssr_domain_prefix   = var.ssr_domain_prefix != "" ? var.ssr_domain_prefix : try(tostring(local.settings.ssr_domain_prefix), "")
    zone_id             = var.zone_id != "" ? var.zone_id : try(tostring(local.settings.zone_id), "")
  }
}
# Starter data: Users/Auth (including email challenges) and Home share one table.
resource "aws_dynamodb_table" "application" {
  name         = "${local.name}-application"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"
  range_key    = "sk"
  attribute {
    name = "pk"
    type = "S"
  }
  attribute {
    name = "sk"
    type = "S"
  }
  ttl {
    attribute_name = "ttl"
    enabled        = true
  }
  point_in_time_recovery {
    enabled = true
  }
  server_side_encryption {
    enabled = true
  }
  deletion_protection_enabled = local.protect
}
module "authentication" {
  source    = "../../node_modules/@gsalgadotoledo/rt-app-auth-cognito/infra"
  name      = local.name
  region    = var.region
  mail_from = var.mail_from
  protect   = local.protect
}
# Admin resources belong to the reusable core; only composition lives here.
module "admin" {
  source          = "../../node_modules/@gsalgadotoledo/rt-app-infra/terraform/aws/admin"
  name            = local.name
  account_id      = data.aws_caller_identity.current.account_id
  protect         = local.protect
  domain          = local.domains.admin_domain
  certificate_arn = local.domains.admin_domain == "" ? "" : local.domains.certificate_arn
  zone_id         = local.domains.admin_domain == "" ? "" : local.domains.zone_id
}
module "public" {
  source          = "../../node_modules/@gsalgadotoledo/rt-app-infra/terraform/aws/site"
  name            = local.name
  site            = "public"
  account_id      = data.aws_caller_identity.current.account_id
  protect         = local.protect
  domain          = local.domains.public_domain
  certificate_arn = local.domains.public_domain == "" ? "" : local.domains.certificate_arn
  zone_id         = local.domains.public_domain == "" ? "" : local.domains.zone_id
}
# One API serves both local server and Lambda entrypoints; no containers or ALB.
module "ssr" {
  source      = "../../node_modules/@gsalgadotoledo/rt-app-infra/terraform/aws/ssr"
  name        = local.name
  environment = var.environment
  region      = var.region
  revision    = var.revision
  api_url     = module.api.deployment.ApiUrl
  admin_url   = module.admin.site.url
  spa_url     = module.public.site.url
  # Amplify issues the SSR certificate itself.
  domain        = local.domains.ssr_domain
  domain_prefix = local.domains.ssr_domain_prefix
  zone_id       = local.domains.ssr_domain == "" ? "" : local.domains.zone_id
}
module "api" {
  stripe_enabled         = var.stripe_enabled
  source                 = "../../node_modules/@gsalgadotoledo/rt-app-infra/terraform/aws/runtime"
  cognito_user_pool_id   = module.authentication.pool_id
  cognito_user_pool_arn  = module.authentication.pool_arn
  cognito_client_id      = module.authentication.client_id
  app                    = var.app
  environment            = var.environment
  region                 = var.region
  mail_from              = var.mail_from
  revision               = var.revision
  lambda_bundle_path     = abspath("${path.module}/../../apps/lambda-ts/bundle")
  lambda_archive_path    = abspath("${path.module}/../../apps/lambda-ts/bundle.zip")
  application_table_name = aws_dynamodb_table.application.name
  table_arns             = [aws_dynamodb_table.application.arn]
  allowed_origins        = distinct([module.admin.site.url, module.admin.site.cloudfront_url, module.public.site.url, module.public.site.cloudfront_url, module.ssr.url, module.ssr.default_url, "http://127.0.0.1:5174", "http://localhost:5174"])
  protect                = local.protect
  domain                 = local.domains.api_domain
  certificate_arn        = local.domains.api_domain == "" ? "" : local.domains.api_certificate_arn
  zone_id                = local.domains.api_domain == "" ? "" : local.domains.zone_id
}
# Destroy guard: it depends on every resource, so terraform destroy removes it first and a
# protected environment fails here before anything is deleted. The AWS-level protections
# (DynamoDB, Cognito, site buckets) remain the second line of defense.
resource "terraform_data" "protect" {
  input      = local.protect
  depends_on = [aws_dynamodb_table.application, module.authentication, module.admin, module.public, module.ssr, module.api, module.spend_guards]
  provisioner "local-exec" {
    when    = destroy
    command = self.input ? "echo 'This environment is protected. Apply with protect = false (TF_VAR_protect=false), then destroy.' >&2; exit 1" : "true"
  }
  lifecycle {
    precondition {
      condition     = alltrue([for key in keys(local.settings) : contains(local.setting_names, key)])
      error_message = "Unknown setting in environments/${var.environment}.json. Allowed: ${join(", ", local.setting_names)}."
    }
  }
}
output "deployment" {
  value = merge(module.api.deployment, {
    SsrUrl               = module.ssr.url
    SsrAppId             = module.ssr.app_id
    SsrBranch            = module.ssr.branch
    CognitoUserPoolId    = module.authentication.pool_id
    CognitoClientId      = module.authentication.client_id
    TableName            = aws_dynamodb_table.application.name
    AdminUrl             = module.admin.site.url
    PublicUrl            = module.public.site.url
    AdminBucketName      = module.admin.site.bucket
    PublicBucketName     = module.public.site.bucket
    AdminDistributionId  = module.admin.site.distribution_id
    PublicDistributionId = module.public.site.distribution_id
    Protected            = local.protect
  })
}
