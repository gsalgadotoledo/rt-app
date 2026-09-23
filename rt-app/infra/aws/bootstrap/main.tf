terraform {
  required_version = ">= 1.11.0, < 2.0.0"
  required_providers {
    aws = {
      source = "hashicorp/aws", version = "= 6.36.0"
    }
  }
}
variable "multi_environment" {
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
    error_message = "Invalid RT-App name."
  }
}
variable "repository" {
  type = string
  validation {
    condition     = can(regex("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", var.repository))
    error_message = "Use OWNER/REPOSITORY."
  }
}
variable "oidc_provider_arn" {
  type    = string
  default = ""
}
provider "aws" {
  region = var.region
}
data "aws_caller_identity" "current" {
}
data "aws_partition" "current" {
}
locals {
  account      = data.aws_caller_identity.current.account_id
  arn          = "arn:${data.aws_partition.current.partition}"
  environments = toset(var.multi_environment ? ["develop", "stage", "prod"] : ["prod"])
  names        = { for env in local.environments : env => env == "prod" ? var.app : "${var.app}-${env}" }
}
resource "aws_s3_bucket" "state" {
  bucket = "${var.app}-${local.account}-tfstate"
  lifecycle {
    prevent_destroy = true
  }
}
resource "aws_s3_bucket_versioning" "state" {
  bucket = aws_s3_bucket.state.id
  versioning_configuration {
    status = "Enabled"
  }
}
resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  bucket = aws_s3_bucket.state.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}
resource "aws_s3_bucket_public_access_block" "state" {
  bucket                  = aws_s3_bucket.state.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
resource "aws_s3_bucket_policy" "state" {
  bucket = aws_s3_bucket.state.id
  policy = jsonencode({
    Version = "2012-10-17", Statement = [{
      Effect = "Deny", Principal = "*", Action = "s3:*", Resource = [aws_s3_bucket.state.arn, "${aws_s3_bucket.state.arn}/*"],
      Condition = {
        Bool = {
          "aws:SecureTransport" = "false"
        }
      }
      }
    ]
    }
  )
}
resource "aws_iam_openid_connect_provider" "github" {
  count          = var.oidc_provider_arn == "" ? 1 : 0
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
}
locals {
  oidc = var.oidc_provider_arn != "" ? var.oidc_provider_arn : aws_iam_openid_connect_provider.github[0].arn
}
resource "aws_iam_policy" "runtime_boundary" {
  for_each = local.environments
  name     = "${local.names[each.key]}-runtime-boundary"
  policy = jsonencode({
    Version = "2012-10-17", Statement = [
      { Effect = "Allow", Action = ["ec2:DescribeInstances", "ec2:DescribeInstanceStatus", "rds:DescribeDBInstances"], Resource = "*" },
      { Effect = "Allow", Action = ["ssm:StartAutomationExecution"], Resource = ["${local.arn}:ssm:${var.region}::automation-definition/AWS-StopEC2Instance:*", "${local.arn}:ssm:${var.region}::automation-definition/AWS-StopRdsInstance:*"] },
      { Effect = "Allow", Action = ["ec2:StopInstances", "rds:StopDBInstance"], Resource = ["${local.arn}:ec2:${var.region}:${local.account}:instance/*", "${local.arn}:rds:${var.region}:${local.account}:db:*"], Condition = { StringEquals = { "aws:ResourceTag/Application" = var.app, "aws:ResourceTag/Environment" = each.key } } },

      { Effect = "Allow", Action = ["tag:GetResources", "ce:GetCostAndUsage", "ce:GetCostAndUsageWithResources", "budgets:ViewBudget"], Resource = "*" },
      { Effect = "Allow", Action = ["lambda:GetFunctionConcurrency", "lambda:ListTags", "lambda:PutFunctionConcurrency", "lambda:DeleteFunctionConcurrency"], Resource = "${local.arn}:lambda:${var.region}:${local.account}:function:${local.names[each.key]}" },
      {
        Effect    = "Allow", Action = ["cognito-idp:AdminDisableUser", "cognito-idp:AdminEnableUser", "cognito-idp:AdminCreateUser", "cognito-idp:AdminGetUser", "cognito-idp:AdminSetUserPassword", "cognito-idp:AdminSetUserMFAPreference", "cognito-idp:AdminUserGlobalSignOut", "cognito-idp:AdminUpdateUserAttributes"], Resource = "${local.arn}:cognito-idp:${var.region}:${local.account}:userpool/*"
        Condition = { StringEquals = { "aws:ResourceTag/Application" = local.names[each.key] } }
      },
      {
        Effect = "Allow", Action = ["logs:CreateLogStream", "logs:PutLogEvents"], Resource = "${local.arn}:logs:${var.region}:${local.account}:log-group:/aws/lambda/${local.names[each.key]}:*"
      },
      {
        Effect = "Allow", Action = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem", "dynamodb:Query", "dynamodb:TransactWriteItems"], Resource = "${local.arn}:dynamodb:${var.region}:${local.account}:table/${local.names[each.key]}-application"
      },
      {
        Effect = "Allow", Action = ["secretsmanager:GetSecretValue", "secretsmanager:PutSecretValue"], Resource = "${local.arn}:secretsmanager:${var.region}:${local.account}:secret:${local.names[each.key]}/*"
      },
      {
        Effect = "Allow", Action = ["ses:SendEmail"], Resource = "${local.arn}:ses:${var.region}:${local.account}:identity/*"
      }
    ]
    }
  )
}
resource "aws_iam_policy" "amplify_boundary" {
  for_each = local.environments
  name     = "${local.names[each.key]}-amplify-boundary"
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Action = ["logs:DescribeLogGroups"], Resource = "*" },
    { Effect = "Allow", Action = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"], Resource = "${local.arn}:logs:${var.region}:${local.account}:log-group:/aws/amplify/*" }
  ] })
}
resource "aws_iam_role" "deploy" {
  for_each = local.environments
  name     = "${local.names[each.key]}-github"
  assume_role_policy = jsonencode({
    Version = "2012-10-17", Statement = [{
      Effect = "Allow", Principal = {
        Federated = local.oidc
      },
      Action = "sts:AssumeRoleWithWebIdentity",
      Condition = {
        StringEquals = {
          "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com",
          "token.actions.githubusercontent.com:sub" = "repo:${var.repository}:ref:refs/heads/${each.key == "prod" ? "main" : each.key}"
        }
      }
      }
    ]
    }
  )
}
resource "aws_iam_role_policy" "deploy" {
  for_each = local.environments
  role     = aws_iam_role.deploy[each.key].id
  policy = jsonencode({
    Version = "2012-10-17", Statement = [
      { Effect = "Allow", Action = ["events:PutRule", "events:DescribeRule", "events:DeleteRule", "events:PutTargets", "events:RemoveTargets", "events:ListTargetsByRule", "events:ListTagsForResource", "events:TagResource", "events:UntagResource"], Resource = "${local.arn}:events:${var.region}:${local.account}:rule/${local.names[each.key]}-subscriptions" },
      { Effect = "Allow", Action = ["budgets:*"], Resource = "${local.arn}:budgets::${local.account}:budget/${local.names[each.key]}-guard-*" },
      { Effect = "Allow", Action = ["iam:CreateRole"], Resource = "${local.arn}:iam::${local.account}:role/${local.names[each.key]}-budget-*", Condition = { StringEquals = { "iam:PermissionsBoundary" = aws_iam_policy.runtime_boundary[each.key].arn } } },
      { Effect = "Allow", Action = ["iam:GetRole", "iam:DeleteRole", "iam:UpdateAssumeRolePolicy", "iam:PutRolePolicy", "iam:GetRolePolicy", "iam:DeleteRolePolicy", "iam:ListRolePolicies", "iam:ListAttachedRolePolicies", "iam:TagRole", "iam:UntagRole"], Resource = "${local.arn}:iam::${local.account}:role/${local.names[each.key]}-budget-*" },
      { Effect = "Allow", Action = ["iam:PassRole"], Resource = "${local.arn}:iam::${local.account}:role/${local.names[each.key]}-budget-*", Condition = { StringEquals = { "iam:PassedToService" = "budgets.amazonaws.com" } } },

      { Effect = "Allow", Action = ["amplify:CreateApp"], Resource = "*", Condition = { StringEquals = { "aws:RequestTag/Application" = var.app, "aws:RequestTag/Environment" = each.key } } },
      { Effect = "Allow", Action = ["amplify:GetApp", "amplify:UpdateApp", "amplify:DeleteApp", "amplify:TagResource", "amplify:UntagResource", "amplify:ListTagsForResource", "amplify:CreateBranch", "amplify:GetBranch", "amplify:UpdateBranch", "amplify:DeleteBranch", "amplify:StartJob", "amplify:GetJob", "amplify:ListJobs"], Resource = "${local.arn}:amplify:${var.region}:${local.account}:apps/*" },
      { Effect = "Allow", Action = ["iam:CreateRole"], Resource = "${local.arn}:iam::${local.account}:role/${local.names[each.key]}-amplify", Condition = { StringEquals = { "iam:PermissionsBoundary" = aws_iam_policy.amplify_boundary[each.key].arn } } },
      { Effect = "Allow", Action = ["iam:GetRole", "iam:DeleteRole", "iam:UpdateAssumeRolePolicy", "iam:PutRolePolicy", "iam:GetRolePolicy", "iam:DeleteRolePolicy", "iam:ListRolePolicies", "iam:ListAttachedRolePolicies", "iam:TagRole", "iam:UntagRole"], Resource = "${local.arn}:iam::${local.account}:role/${local.names[each.key]}-amplify" },
      { Effect = "Allow", Action = ["iam:PassRole"], Resource = "${local.arn}:iam::${local.account}:role/${local.names[each.key]}-amplify", Condition = { StringEquals = { "iam:PassedToService" = "amplify.amazonaws.com" } } },

      { Effect = "Allow", Action = ["cognito-idp:CreateUserPool"], Resource = "*", Condition = { StringEquals = { "aws:RequestTag/Application" = local.names[each.key] } } },
      { Effect = "Allow", Action = ["cognito-idp:DescribeUserPool", "cognito-idp:UpdateUserPool", "cognito-idp:DeleteUserPool", "cognito-idp:TagResource", "cognito-idp:UntagResource", "cognito-idp:ListTagsForResource", "cognito-idp:CreateUserPoolClient", "cognito-idp:DescribeUserPoolClient", "cognito-idp:UpdateUserPoolClient", "cognito-idp:DeleteUserPoolClient"], Resource = "${local.arn}:cognito-idp:${var.region}:${local.account}:userpool/*", Condition = { StringEquals = { "aws:ResourceTag/Application" = local.names[each.key] } } },
      { Effect = "Allow", Action = ["iam:CreateServiceLinkedRole"], Resource = "${local.arn}:iam::${local.account}:role/aws-service-role/email.cognito-idp.amazonaws.com/*", Condition = { StringEquals = { "iam:AWSServiceName" = "email.cognito-idp.amazonaws.com" } } },
      {
        Effect = "Allow", Action = ["s3:ListBucket", "s3:GetBucketLocation"], Resource = aws_s3_bucket.state.arn
      },
      {
        Effect = "Allow", Action = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"], Resource = "${aws_s3_bucket.state.arn}/${each.key}/*"
      },
      {
        Effect = "Allow", Action = ["s3:*"], Resource = ["${local.arn}:s3:::${local.names[each.key]}-${local.account}-*", "${local.arn}:s3:::${local.names[each.key]}-${local.account}-*/*"]
      },
      {
        Effect = "Allow", Action = ["lambda:*"], Resource = ["${local.arn}:lambda:${var.region}:${local.account}:function:${local.names[each.key]}", "${local.arn}:lambda:${var.region}:${local.account}:function:${local.names[each.key]}:*"]
      },
      {
        Effect = "Allow", Action = ["dynamodb:*"], Resource = "${local.arn}:dynamodb:${var.region}:${local.account}:table/${local.names[each.key]}-application"
      },
      {
        Effect = "Allow", Action = ["secretsmanager:*"], Resource = "${local.arn}:secretsmanager:${var.region}:${local.account}:secret:${local.names[each.key]}/*"
      },
      {
        Effect = "Allow", Action = ["logs:*"], Resource = "${local.arn}:logs:${var.region}:${local.account}:log-group:/aws/lambda/${local.names[each.key]}:*"
      },
      {
        Effect = "Allow", Action = ["apigateway:GET", "apigateway:POST", "apigateway:PUT", "apigateway:PATCH", "apigateway:DELETE"], Resource = "${local.arn}:apigateway:${var.region}::/*"
      },
      {
        Effect = "Allow", Action = ["cloudfront:CreateDistribution", "cloudfront:CreateDistributionWithTags", "cloudfront:GetDistribution", "cloudfront:GetDistributionConfig", "cloudfront:UpdateDistribution", "cloudfront:DeleteDistribution", "cloudfront:TagResource", "cloudfront:UntagResource", "cloudfront:ListTagsForResource", "cloudfront:CreateOriginAccessControl", "cloudfront:GetOriginAccessControl", "cloudfront:GetOriginAccessControlConfig", "cloudfront:UpdateOriginAccessControl", "cloudfront:DeleteOriginAccessControl", "cloudfront:CreateInvalidation", "cloudfront:GetInvalidation"], Resource = "*"
      },
      {
        Effect = "Allow", Action = ["iam:CreateRole"], Resource = "${local.arn}:iam::${local.account}:role/${local.names[each.key]}-lambda", Condition = {
          StringEquals = {
            "iam:PermissionsBoundary" = aws_iam_policy.runtime_boundary[each.key].arn
          }
        }
      },
      {
        Effect = "Allow", Action = ["iam:GetRole", "iam:DeleteRole", "iam:UpdateAssumeRolePolicy", "iam:PutRolePolicy", "iam:GetRolePolicy", "iam:DeleteRolePolicy", "iam:ListRolePolicies", "iam:ListAttachedRolePolicies", "iam:TagRole", "iam:UntagRole"], Resource = "${local.arn}:iam::${local.account}:role/${local.names[each.key]}-lambda"
      },
      {
        Effect = "Allow", Action = ["iam:PassRole"], Resource = "${local.arn}:iam::${local.account}:role/${local.names[each.key]}-lambda", Condition = {
          StringEquals = {
            "iam:PassedToService" = "lambda.amazonaws.com"
          }
        }
      },
      {
        Effect = "Allow", Action = ["iam:GetPolicy", "iam:GetPolicyVersion"], Resource = aws_iam_policy.runtime_boundary[each.key].arn
      }
    ]
    }
  )
}
output "bootstrap" {
  value = {
    StateBucket = aws_s3_bucket.state.id
    DevelopRole = try(aws_iam_role.deploy["develop"].arn, null)
    StageRole   = try(aws_iam_role.deploy["stage"].arn, null)
    ProdRole    = aws_iam_role.deploy["prod"].arn
  }
}
