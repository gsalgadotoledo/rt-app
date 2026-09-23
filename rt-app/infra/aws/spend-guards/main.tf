terraform {
  required_providers {
    aws = { source = "hashicorp/aws", version = "= 6.36.0" }
  }
}
variable "name" { type = string }
variable "application" { type = string }
variable "environment" { type = string }
variable "region" { type = string }
variable "boundary_arn" { type = string }
variable "rules" {
  description = "Account-wide monthly service budgets. Optional stop targets are explicitly named and application/environment-tagged."
  type = map(object({
    service      = string
    monthly_usd  = number
    emails       = set(string)
    action       = optional(string, "notify")
    instance_ids = optional(set(string), [])
  }))
  default = {}
  validation {
    condition = alltrue([for key, rule in var.rules :
      can(regex("^[a-z][a-z0-9-]{0,25}$", key)) &&
      length(trimspace(rule.service)) > 0 &&
      rule.monthly_usd >= 0.01 &&
      length(rule.emails) > 0 && length(rule.emails) <= 10 &&
      alltrue([for email in rule.emails : can(regex("^[^ @]+@[^ @]+\\.[^ @]+$", email))]) &&
      contains(["notify", "stop-ec2", "stop-rds"], rule.action) &&
      (rule.action == "notify" ? length(rule.instance_ids) == 0 : length(rule.instance_ids) > 0) &&
      alltrue([for id in rule.instance_ids : rule.action == "stop-ec2" ? can(regex("^i-[a-f0-9]+$", id)) : can(regex("^[a-zA-Z][a-zA-Z0-9-]{0,62}$", id))])
    ])
    error_message = "Use a valid rule name, service, positive USD amount, 1–10 emails and explicit instance IDs only for stop-ec2/stop-rds."
  }
}
data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}
locals {
  stop_rules = { for key, rule in var.rules : key => rule if rule.action != "notify" }
  arn        = "arn:${data.aws_partition.current.partition}"
}
resource "aws_budgets_budget" "rule" {
  for_each     = var.rules
  name         = "${var.name}-guard-${each.key}"
  budget_type  = "COST"
  limit_amount = tostring(each.value.monthly_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"
  cost_filter {
    name   = "Service"
    values = [each.value.service]
  }
  cost_filter {
    name   = "LinkedAccount"
    values = [data.aws_caller_identity.current.account_id]
  }
  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = each.value.monthly_usd
    threshold_type             = "ABSOLUTE_VALUE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = each.value.emails
  }
}
resource "aws_iam_role" "stop" {
  for_each             = local.stop_rules
  name                 = "${var.name}-budget-${substr(sha256(each.key), 0, 8)}"
  permissions_boundary = var.boundary_arn
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow", Principal = { Service = "budgets.amazonaws.com" }, Action = "sts:AssumeRole"
      Condition = {
        StringEquals = { "aws:SourceAccount" = data.aws_caller_identity.current.account_id }
        ArnEquals    = { "aws:SourceArn" = aws_budgets_budget.rule[each.key].arn }
      }
    }]
  })
}
resource "aws_iam_role_policy" "stop" {
  for_each = local.stop_rules
  role     = aws_iam_role.stop[each.key].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["ec2:DescribeInstanceStatus", "ec2:DescribeInstances", "rds:DescribeDBInstances"], Resource = "*" },
      { Effect = "Allow", Action = ["ssm:StartAutomationExecution"], Resource = [
        "${local.arn}:ssm:${var.region}::automation-definition/AWS-StopEC2Instance:*",
        "${local.arn}:ssm:${var.region}::automation-definition/AWS-StopRdsInstance:*"
      ] },
      { Effect    = "Allow", Action = each.value.action == "stop-ec2" ? ["ec2:StopInstances"] : ["rds:StopDBInstance"],
        Resource  = [for id in each.value.instance_ids : each.value.action == "stop-ec2" ? "${local.arn}:ec2:${var.region}:${data.aws_caller_identity.current.account_id}:instance/${id}" : "${local.arn}:rds:${var.region}:${data.aws_caller_identity.current.account_id}:db:${id}"]
        Condition = { StringEquals = { "aws:ResourceTag/Application" = var.application, "aws:ResourceTag/Environment" = var.environment } }
      }
    ]
  })
}
resource "aws_budgets_budget_action" "stop" {
  for_each           = local.stop_rules
  budget_name        = aws_budgets_budget.rule[each.key].name
  action_type        = "RUN_SSM_DOCUMENTS"
  approval_model     = "AUTOMATIC"
  notification_type  = "ACTUAL"
  execution_role_arn = aws_iam_role.stop[each.key].arn
  action_threshold {
    action_threshold_type  = "ABSOLUTE_VALUE"
    action_threshold_value = each.value.monthly_usd
  }
  definition {
    ssm_action_definition {
      action_sub_type = each.value.action == "stop-ec2" ? "STOP_EC2_INSTANCES" : "STOP_RDS_INSTANCES"
      instance_ids    = each.value.instance_ids
      region          = var.region
    }
  }
  dynamic "subscriber" {
    for_each = each.value.emails
    content {
      address           = subscriber.value
      subscription_type = "EMAIL"
    }
  }
  depends_on = [aws_iam_role_policy.stop]
}
output "budgets" {
  value = { for key, budget in aws_budgets_budget.rule : key => { name = budget.name, action = var.rules[key].action, limit_usd = var.rules[key].monthly_usd } }
}
