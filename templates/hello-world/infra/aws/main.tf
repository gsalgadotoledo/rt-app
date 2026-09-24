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
provider "aws" {
  region = var.region
  default_tags {
    tags = {
      Application = var.app, Environment = var.environment, ManagedBy = "Terraform"
    }
  }
}
data "aws_caller_identity" "current" {}
locals { name = var.environment == "prod" ? var.app : "${var.app}-${var.environment}" }
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
  lifecycle {
    prevent_destroy = true
  }
}
module "authentication" {
  source    = "../../node_modules/@gsalgadotoledo/rt-app-auth-cognito/infra"
  name      = local.name
  region    = var.region
  mail_from = var.mail_from
}
# Admin resources belong to the reusable core; only composition lives here.
module "admin" {
  source     = "../../node_modules/@gsalgadotoledo/rt-app-infra/terraform/aws/admin"
  name       = local.name
  account_id = data.aws_caller_identity.current.account_id
}
module "public" {
  source     = "../../node_modules/@gsalgadotoledo/rt-app-infra/terraform/aws/site"
  name       = local.name
  site       = "public"
  account_id = data.aws_caller_identity.current.account_id
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
  allowed_origins        = [module.admin.site.url, module.public.site.url, module.ssr.url, "http://127.0.0.1:5174", "http://localhost:5174"]
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
  })
}
