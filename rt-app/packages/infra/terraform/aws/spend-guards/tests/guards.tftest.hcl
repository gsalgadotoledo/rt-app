mock_provider "aws" {}
override_data {
 target = data.aws_caller_identity.current
 values = { account_id = "123456789012" }
}
override_data {
 target = data.aws_partition.current
 values = { partition = "aws" }
}
variables {
 name = "rt-app-test"
 application = "rt-app-test"
 environment = "prod"
 region = "us-east-1"
 boundary_arn = "arn:aws:iam::123456789012:policy/rt-app-test-runtime-boundary"
}
run "disabled_by_default" {
 command = plan
 assert {
  condition = length(aws_budgets_budget.rule) == 0 && length(aws_iam_role.stop) == 0
  error_message = "No budget or stop action without explicit configuration."
 }
}
run "notify_only" {
 command = plan
 variables {
  rules = { lambda = {service="AWS Lambda",monthly_usd=10,emails=["admin@example.com"]} }
 }
 assert {
  condition = length(aws_budgets_budget.rule) == 1 && length(aws_budgets_budget_action.stop) == 0 && length(aws_iam_role.stop) == 0
  error_message = "Notifications must not create stop roles."
 }
}
run "explicit_stop_targets" {
 command = plan
 variables {
  rules = { worker = {service="Amazon Elastic Compute Cloud - Compute",monthly_usd=25,emails=["admin@example.com"],action="stop-ec2",instance_ids=["i-abcdef123"]} }
 }
 assert {
  condition = aws_budgets_budget_action.stop["worker"].approval_model == "AUTOMATIC"
  error_message = "Stop action must run without an open admin."
 }
 assert {
  condition = jsondecode(aws_iam_role_policy.stop["worker"].policy).Statement[2].Resource == ["arn:aws:ec2:us-east-1:123456789012:instance/i-abcdef123"]
  error_message = "Stop permission must only cover the selected instance."
 }
 assert {
  condition = jsondecode(aws_iam_role_policy.stop["worker"].policy).Statement[2].Condition.StringEquals["aws:ResourceTag/Environment"] == "prod"
  error_message = "Stop actions must stay inside their environment."
 }
}
run "reject_unsupported_stop" {
 command = plan
 variables {
  rules = { lambda = {service="AWS Lambda",monthly_usd=10,emails=["admin@example.com"],action="stop-lambda"} }
 }
 expect_failures = [var.rules]
}
