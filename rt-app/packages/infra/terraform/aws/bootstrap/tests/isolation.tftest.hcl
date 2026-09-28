mock_provider "aws" {}
override_data {
  target = data.aws_caller_identity.current
  values = { account_id = "123456789012" }
}
override_data {
  target = data.aws_partition.current
  values = { partition = "aws" }
}
run "branch_bound_roles" {
  command = plan
  variables {
    multi_environment = true
    region            = "us-east-1"
    app               = "rt-app-test"
    repository        = "example/project"
    oidc_provider_arn = "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com"
  }
  assert {
    condition     = jsondecode(aws_iam_role.deploy["prod"].assume_role_policy).Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:sub"] == "repo:example/project:ref:refs/heads/main"
    error_message = "Production role must trust only main."
  }
  assert {
    condition     = jsondecode(aws_iam_role.deploy["develop"].assume_role_policy).Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:sub"] == "repo:example/project:ref:refs/heads/develop"
    error_message = "Development role must trust only dev."
  }
  assert {
    condition     = length(aws_iam_openid_connect_provider.github) == 0
    error_message = "An existing OIDC provider must not be recreated."
  }
}

run "production_only_by_default" {
  command = plan
  variables {
    region     = "us-east-1"
    app        = "rt-app-test"
    repository = "example/project"
  }
  assert {
    condition     = length(aws_iam_role.deploy) == 1 && aws_iam_role.deploy["prod"].name == "rt-app-test-github"
    error_message = "Default must create only production, without a prod suffix."
  }
}
run "stage_role_is_branch_bound" {
  command = plan
  variables {
    region            = "us-east-1"
    app               = "rt-app-test"
    repository        = "example/project"
    oidc_provider_arn = "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com"
    multi_environment = true
  }
  assert {
    condition     = jsondecode(aws_iam_role.deploy["stage"].assume_role_policy).Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:sub"] == "repo:example/project:ref:refs/heads/stage"
    error_message = "Stage must trust only the stage branch."
  }
  assert {
    condition     = one([for statement in jsondecode(aws_iam_policy.runtime_boundary["prod"].policy).Statement : statement.Resource if contains(statement.Action, "dynamodb:GetItem")]) == "arn:aws:dynamodb:us-east-1:123456789012:table/rt-app-test-application"
    error_message = "Production's table permissions must not include develop/stage tables."
  }
}
run "operator_and_gitlab_scope" {
  command = plan
  variables {
    region                   = "us-east-1"
    app                      = "rt-app-test"
    repository               = "example/project"
    operator_principal_arn   = "arn:aws:iam::123456789012:role/Operator"
    gitlab_project           = "example/project"
    gitlab_oidc_provider_arn = "arn:aws:iam::123456789012:oidc-provider/gitlab.com"
    multi_environment        = true
  }
  assert {
    condition     = jsondecode(aws_iam_role.operator[0].assume_role_policy).Statement[0].Principal.AWS == "arn:aws:iam::123456789012:role/Operator"
    error_message = "Operator trust must be bound to the selected principal."
  }
  assert {
    condition     = local.monitor_policy.Statement[2].Condition.StringEquals["aws:ResourceTag/Application"] == "rt-app-test"
    error_message = "EC2 stop permissions must be application-tag scoped."
  }
  assert {
    condition     = jsondecode(aws_iam_role.gitlab["prod"].assume_role_policy).Statement[0].Condition.StringEquals["gitlab.com:sub"] == "project_path:example/project:ref_type:branch:ref:main" && length(aws_iam_openid_connect_provider.gitlab) == 0
    error_message = "GitLab must reuse the provider and pin production to main."
  }
}
run "custom_domains_without_route53_by_default" {
  command = plan
  override_resource {
    target          = aws_s3_bucket.state
    values          = { arn = "arn:aws:s3:::rt-app-test-123456789012-tfstate" }
    override_during = plan
  }
  override_resource {
    target          = aws_iam_policy.runtime_boundary
    values          = { arn = "arn:aws:iam::123456789012:policy/rt-app-test-runtime-boundary" }
    override_during = plan
  }
  override_resource {
    target          = aws_iam_policy.amplify_boundary
    values          = { arn = "arn:aws:iam::123456789012:policy/rt-app-test-amplify-boundary" }
    override_during = plan
  }
  variables {
    region            = "us-east-1"
    app               = "rt-app-test"
    repository        = "example/project"
    oidc_provider_arn = "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com"
  }
  assert {
    condition     = length([for statement in jsondecode(aws_iam_role_policy.deploy["prod"].policy).Statement : statement if contains(statement.Action, "route53:ChangeResourceRecordSets")]) == 0
    error_message = "Deploy roles get no Route53 access unless zones are listed."
  }
  assert {
    condition     = length([for statement in jsondecode(aws_iam_role_policy.deploy["prod"].policy).Statement : statement if contains(statement.Action, "amplify:CreateDomainAssociation")]) == 1
    error_message = "Deploy roles can associate SSR domains."
  }
}
run "route53_access_is_scoped_to_listed_zones" {
  command = plan
  override_resource {
    target          = aws_s3_bucket.state
    values          = { arn = "arn:aws:s3:::rt-app-test-123456789012-tfstate" }
    override_during = plan
  }
  override_resource {
    target          = aws_iam_policy.runtime_boundary
    values          = { arn = "arn:aws:iam::123456789012:policy/rt-app-test-runtime-boundary" }
    override_during = plan
  }
  override_resource {
    target          = aws_iam_policy.amplify_boundary
    values          = { arn = "arn:aws:iam::123456789012:policy/rt-app-test-amplify-boundary" }
    override_during = plan
  }
  variables {
    region            = "us-east-1"
    app               = "rt-app-test"
    repository        = "example/project"
    route53_zone_ids  = ["Z123ABC"]
    oidc_provider_arn = "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com"
  }
  assert {
    condition     = one([for statement in jsondecode(aws_iam_role_policy.deploy["prod"].policy).Statement : statement.Resource if contains(statement.Action, "route53:ChangeResourceRecordSets")]) == ["arn:aws:route53:::hostedzone/Z123ABC"]
    error_message = "Route53 writes must be limited to the listed zones."
  }
}
