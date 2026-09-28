mock_provider "aws" {}
override_data {
  target = data.aws_partition.current
  values = { partition = "aws" }
}
override_data {
  target = data.aws_caller_identity.current
  values = { account_id = "123456789012" }
}
variables {
  name        = "rt-app-test"
  environment = "prod"
  region      = "us-east-1"
  api_url     = "https://api.example.test"
  admin_url   = "https://admin.example.test"
  spa_url     = "https://spa.example.test"
  revision    = "abc"
}
run "ssr_uses_matching_api_and_ci_controlled_builds" {
  command = plan
  assert {
    condition     = aws_amplify_app.ssr.platform == "WEB_COMPUTE" && !aws_amplify_branch.ssr.enable_auto_build
    error_message = "SSR must use compute; CI starts builds after the backend."
  }
  assert {
    condition     = aws_amplify_branch.ssr.branch_name == "main" && aws_amplify_branch.ssr.environment_variables.RT_APP_API_URL == var.api_url
    error_message = "Production SSR must use main and its configured API."
  }
  assert {
    condition     = length(keys(aws_amplify_branch.ssr.environment_variables)) == 6 && !contains(keys(aws_amplify_branch.ssr.environment_variables), "AWS_SECRET_ACCESS_KEY")
    error_message = "Only public configuration and the release revision belong in the SSR environment."
  }
}
run "stage_has_an_independent_branch" {
  command = plan
  variables { environment = "stage" }
  assert {
    condition     = aws_amplify_branch.ssr.branch_name == "stage" && aws_amplify_branch.ssr.environment_variables.RT_APP_ENVIRONMENT == "stage"
    error_message = "Stage must not use production configuration."
  }
}
run "no_custom_domain_by_default" {
  command = plan
  assert {
    condition     = length(aws_amplify_domain_association.ssr) == 0 && output.dns_records == null
    error_message = "Without domain the SSR keeps its amplifyapp.com URL."
  }
}
run "custom_domain_in_route53" {
  command = plan
  override_data {
    target = data.aws_route53_zone.domain[0]
    values = { name = "example.test" }
  }
  variables {
    domain        = "example.test"
    domain_prefix = "app"
    zone_id       = "Z123"
  }
  assert {
    condition     = aws_amplify_domain_association.ssr[0].domain_name == "example.test" && aws_amplify_domain_association.ssr[0].wait_for_verification
    error_message = "A Route53 domain is associated and verified by Amplify."
  }
  assert {
    condition     = one(aws_amplify_domain_association.ssr[0].sub_domain).prefix == "app" && one(aws_amplify_domain_association.ssr[0].sub_domain).branch_name == "main"
    error_message = "The prefix must route to this environment's branch."
  }
  assert {
    condition     = output.url == "https://app.example.test" && aws_amplify_branch.ssr.environment_variables.RT_APP_SSR_URL == "https://app.example.test"
    error_message = "The SSR URL must use the custom domain."
  }
}
run "custom_domain_with_external_dns" {
  command = plan
  variables {
    environment = "stage"
    domain      = "stage.example.test"
  }
  assert {
    condition     = !aws_amplify_domain_association.ssr[0].wait_for_verification && one(aws_amplify_domain_association.ssr[0].sub_domain).prefix == "" && output.url == "https://stage.example.test"
    error_message = "External DNS must not block apply; the domain itself serves the branch."
  }
}
run "zone_must_contain_the_domain" {
  command = plan
  override_data {
    target = data.aws_route53_zone.domain[0]
    values = { name = "other.test." }
  }
  variables {
    domain  = "example.test"
    zone_id = "Z123"
  }
  expect_failures = [aws_amplify_domain_association.ssr]
}
run "prefix_requires_domain" {
  command = plan
  variables { domain_prefix = "app" }
  expect_failures = [var.domain_prefix]
}
