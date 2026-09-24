variable "operator_principal_arn" {
  type    = string
  default = ""
  validation {
    condition     = var.operator_principal_arn == "" || can(regex("^arn:aws:iam::[0-9]{12}:(role|user)/.+$", var.operator_principal_arn))
    error_message = "Use a specific IAM role/user ARN, never account root or a wildcard."
  }
}
variable "gitlab_project" {
  type    = string
  default = ""
  validation {
    condition     = var.gitlab_project == "" || can(regex("^[a-zA-Z0-9_.-]+(/[a-zA-Z0-9_.-]+)+$", var.gitlab_project))
    error_message = "Use the exact GitLab.com namespace/project path."
  }
}
variable "gitlab_oidc_provider_arn" {
  type    = string
  default = ""
}
locals {
  monitor_policy = {
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["sts:GetCallerIdentity", "tag:GetResources", "ce:GetCostAndUsage", "ce:GetCostAndUsageWithResources", "ec2:DescribeInstances", "rds:DescribeDBInstances"], Resource = "*" },
      { Effect = "Allow", Action = ["lambda:GetFunctionConcurrency", "lambda:ListTags", "lambda:PutFunctionConcurrency", "lambda:DeleteFunctionConcurrency"], Resource = "${local.arn}:lambda:${var.region}:${local.account}:function:${var.app}*", Condition = { StringEquals = { "aws:ResourceTag/Application" = var.app } } },
      { Effect = "Allow", Action = ["ec2:StopInstances", "ec2:StartInstances"], Resource = "${local.arn}:ec2:${var.region}:${local.account}:instance/*", Condition = { StringEquals = { "aws:ResourceTag/Application" = var.app } } },
      { Effect = "Allow", Action = ["rds:ListTagsForResource", "rds:StopDBInstance", "rds:StartDBInstance"], Resource = "${local.arn}:rds:${var.region}:${local.account}:db:*", Condition = { StringEquals = { "aws:ResourceTag/Application" = var.app } } }
    ]
  }
}
resource "aws_iam_role" "operator" {
  count              = var.operator_principal_arn == "" ? 0 : 1
  name               = "${var.app}-operator"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Principal = { AWS = var.operator_principal_arn }, Action = "sts:AssumeRole" }] })
}
resource "aws_iam_role_policy" "operator" {
  count  = var.operator_principal_arn == "" ? 0 : 1
  role   = aws_iam_role.operator[0].id
  policy = jsonencode(local.monitor_policy)
}
resource "aws_iam_openid_connect_provider" "gitlab" {
  count          = var.gitlab_project != "" && var.gitlab_oidc_provider_arn == "" ? 1 : 0
  url            = "https://gitlab.com"
  client_id_list = ["sts.amazonaws.com"]
}
resource "aws_iam_role" "gitlab" {
  for_each = var.gitlab_project != "" ? local.environments : toset([])
  name     = "${local.names[each.key]}-gitlab"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Principal = { Federated = var.gitlab_oidc_provider_arn != "" ? var.gitlab_oidc_provider_arn : aws_iam_openid_connect_provider.gitlab[0].arn }, Action = "sts:AssumeRoleWithWebIdentity", Condition = { StringEquals = {
    "gitlab.com:aud" = "sts.amazonaws.com",
    "gitlab.com:sub" = "project_path:${var.gitlab_project}:ref_type:branch:ref:${each.key == "prod" ? "main" : each.key}"
  } } }] })
}
resource "aws_iam_role_policy" "gitlab" {
  for_each = aws_iam_role.gitlab
  role     = each.value.id
  policy   = aws_iam_role_policy.deploy[each.key].policy
}
output "operator_role" { value = try(aws_iam_role.operator[0].arn, null) }
output "monitor_policy" { value = local.monitor_policy }
output "gitlab_roles" { value = { for env, role in aws_iam_role.gitlab : env => role.arn } }
