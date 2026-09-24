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
