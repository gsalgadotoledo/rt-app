mock_provider "aws" {}
variables {
  name       = "rt-app-test"
  account_id = "123456789012"
}
run "protected_by_default" {
  command = plan
  assert {
    condition     = output.site.protected && output.site.domain == null
    error_message = "The admin bucket is protected and keeps its CloudFront domain by default."
  }
}
run "passes_protection_and_domain_to_the_site" {
  command = plan
  variables {
    protect         = false
    domain          = "admin.example.test"
    certificate_arn = "arn:aws:acm:us-east-1:123456789012:certificate/abc"
    zone_id         = "Z123"
  }
  assert {
    condition     = !output.site.protected && output.site.url == "https://admin.example.test"
    error_message = "The admin must forward protect and the domain to its site."
  }
}
