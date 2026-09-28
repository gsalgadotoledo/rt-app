mock_provider "aws" {}
variables {
  name       = "rt-app-test"
  site       = "public"
  account_id = "123456789012"
}
run "protected_default_site" {
  command = plan
  assert {
    condition     = !aws_s3_bucket.site.force_destroy
    error_message = "A protected site bucket must never be emptied by terraform destroy."
  }
  assert {
    condition     = aws_cloudfront_distribution.site.viewer_certificate[0].cloudfront_default_certificate && length(aws_cloudfront_distribution.site.aliases) == 0 && length(aws_route53_record.site) == 0
    error_message = "Without domain the site keeps the CloudFront certificate and domain."
  }
  assert {
    condition     = output.site.domain == null
    error_message = "The URL must be the CloudFront domain."
  }
}
run "unprotected_site_can_be_emptied" {
  command = plan
  variables { protect = false }
  assert {
    condition     = aws_s3_bucket.site.force_destroy
    error_message = "protect = false must let terraform destroy empty the bucket."
  }
  assert {
    condition     = one(aws_s3_bucket_versioning.site.versioning_configuration).status == "Enabled" && one(one(aws_s3_bucket_server_side_encryption_configuration.site.rule).apply_server_side_encryption_by_default).sse_algorithm == "AES256"
    error_message = "Versioning and encryption stay on without protection."
  }
}
run "custom_domain_with_route53" {
  command = plan
  variables {
    domain          = "app.example.test"
    certificate_arn = "arn:aws:acm:us-east-1:123456789012:certificate/abc"
    zone_id         = "Z123"
  }
  assert {
    condition     = tolist(aws_cloudfront_distribution.site.aliases) == tolist(["app.example.test"]) && aws_cloudfront_distribution.site.is_ipv6_enabled
    error_message = "The distribution must answer on the custom domain."
  }
  assert {
    condition     = !aws_cloudfront_distribution.site.viewer_certificate[0].cloudfront_default_certificate && aws_cloudfront_distribution.site.viewer_certificate[0].acm_certificate_arn == var.certificate_arn && aws_cloudfront_distribution.site.viewer_certificate[0].ssl_support_method == "sni-only" && aws_cloudfront_distribution.site.viewer_certificate[0].minimum_protocol_version == "TLSv1.2_2021"
    error_message = "The custom domain must use the ACM certificate over SNI with TLS 1.2."
  }
  assert {
    condition     = toset(keys(aws_route53_record.site)) == toset(["A", "AAAA"]) && aws_route53_record.site["A"].zone_id == "Z123" && aws_route53_record.site["A"].name == "app.example.test"
    error_message = "Route53 must alias A and AAAA to the distribution."
  }
  assert {
    condition     = output.site.url == "https://app.example.test" && output.site.domain == "app.example.test"
    error_message = "The URL must use the custom domain."
  }
}
run "custom_domain_with_external_dns" {
  command = plan
  variables {
    domain          = "app.example.test"
    certificate_arn = "arn:aws:acm:us-east-1:123456789012:certificate/abc"
  }
  assert {
    condition     = length(aws_route53_record.site) == 0 && output.site.url == "https://app.example.test"
    error_message = "Without zone_id no record is created, but the URL is the domain."
  }
}
run "certificate_must_be_in_us_east_1" {
  command = plan
  variables {
    domain          = "app.example.test"
    certificate_arn = "arn:aws:acm:eu-west-1:123456789012:certificate/abc"
  }
  expect_failures = [var.certificate_arn]
}
run "domain_requires_certificate" {
  command = plan
  variables { domain = "app.example.test" }
  expect_failures = [var.certificate_arn]
}
run "domain_must_be_a_host_name" {
  command = plan
  variables {
    domain          = "https://app.example.test/"
    certificate_arn = "arn:aws:acm:us-east-1:123456789012:certificate/abc"
  }
  expect_failures = [var.domain]
}
