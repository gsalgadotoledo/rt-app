terraform {
  required_providers {
    aws = { source = "hashicorp/aws", version = "= 6.36.0" }
  }
}

variable "name" { type = string }
variable "site" { type = string }
variable "account_id" { type = string }
variable "protect" {
  description = "Keep the site bucket when Terraform destroys it (true). false empties the bucket, all versions included, on destroy. Apply protect = false before terraform destroy."
  type        = bool
  default     = true
}
variable "domain" {
  description = "Optional custom domain for the site, for example app.example.com. Empty keeps the CloudFront domain."
  type        = string
  default     = ""
  validation {
    condition     = var.domain == "" || can(regex("^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,63}$", var.domain))
    error_message = "Use a lowercase host name such as app.example.com, without scheme or path."
  }
}
variable "certificate_arn" {
  description = "ACM certificate for domain, issued in us-east-1 (CloudFront only reads certificates from that region). Required when domain is set."
  type        = string
  default     = ""
  validation {
    condition     = var.domain == "" ? var.certificate_arn == "" : can(regex("^arn:aws[a-z-]*:acm:us-east-1:[0-9]{12}:certificate/", var.certificate_arn))
    error_message = "certificate_arn is required with domain, must be an ACM certificate in us-east-1, and must be empty without domain."
  }
}
variable "zone_id" {
  description = "Optional Route53 hosted zone that serves domain. When set, A and AAAA alias records point domain at the distribution; empty means you create the DNS record yourself (CNAME to the CloudFront domain)."
  type        = string
  default     = ""
  validation {
    condition     = var.zone_id == "" || var.domain != ""
    error_message = "zone_id requires domain."
  }
}
locals {
  custom_domain = var.domain != ""
}
resource "aws_s3_bucket" "site" {
  bucket = "${var.name}-${var.account_id}-${var.site}"
  # Protection is a flag in state: apply protect = false before destroying the bucket.
  force_destroy = !var.protect
}
resource "aws_s3_bucket_public_access_block" "site" {
  bucket                  = aws_s3_bucket.site.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
resource "aws_s3_bucket_versioning" "site" {
  bucket = aws_s3_bucket.site.id
  versioning_configuration {
    status = "Enabled"
  }
}
resource "aws_s3_bucket_server_side_encryption_configuration" "site" {
  bucket = aws_s3_bucket.site.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}
resource "aws_cloudfront_origin_access_control" "site" {
  name                              = "${var.name}-${var.site}"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}
resource "aws_cloudfront_distribution" "site" {
  enabled             = true
  default_root_object = "index.html"
  price_class         = "PriceClass_100"
  aliases             = local.custom_domain ? [var.domain] : []
  is_ipv6_enabled     = local.custom_domain
  origin {
    domain_name              = aws_s3_bucket.site.bucket_regional_domain_name
    origin_id                = var.site
    origin_access_control_id = aws_cloudfront_origin_access_control.site.id
    s3_origin_config {
      origin_access_identity = ""
    }
  }
  default_cache_behavior {
    target_origin_id       = var.site
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true
    min_ttl                = 0
    default_ttl            = 60
    max_ttl                = 31536000
    forwarded_values {
      query_string = false
      cookies {
        forward = "none"
      }
    }
  }
  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }
  viewer_certificate {
    cloudfront_default_certificate = !local.custom_domain
    acm_certificate_arn            = local.custom_domain ? var.certificate_arn : null
    ssl_support_method             = local.custom_domain ? "sni-only" : null
    minimum_protocol_version       = local.custom_domain ? "TLSv1.2_2021" : null
  }
  custom_error_response {
    error_code            = 403
    response_code         = 200
    response_page_path    = "/index.html"
    error_caching_min_ttl = 0
  }
  custom_error_response {
    error_code            = 404
    response_code         = 200
    response_page_path    = "/index.html"
    error_caching_min_ttl = 0
  }
}
resource "aws_s3_bucket_policy" "site" {
  bucket = aws_s3_bucket.site.id
  policy = jsonencode({
    Version = "2012-10-17", Statement = [{
      Effect = "Allow", Principal = {
        Service = "cloudfront.amazonaws.com"
      },
      Action = "s3:GetObject", Resource = "${aws_s3_bucket.site.arn}/*",
      Condition = {
        StringEquals = {
          "AWS:SourceArn" = aws_cloudfront_distribution.site.arn
        }
      }
      }
    ]
    }
  )
}
# DNS for the custom domain, only when its Route53 zone is managed here.
resource "aws_route53_record" "site" {
  for_each = var.zone_id == "" ? toset([]) : toset(["A", "AAAA"])
  zone_id  = var.zone_id
  name     = var.domain
  type     = each.key
  alias {
    name                   = aws_cloudfront_distribution.site.domain_name
    zone_id                = aws_cloudfront_distribution.site.hosted_zone_id
    evaluate_target_health = false
  }
}
output "site" {
  value = {
    url             = local.custom_domain ? "https://${var.domain}" : "https://${aws_cloudfront_distribution.site.domain_name}"
    cloudfront_url  = "https://${aws_cloudfront_distribution.site.domain_name}"
    domain          = local.custom_domain ? var.domain : null
    protected       = !aws_s3_bucket.site.force_destroy
    bucket          = aws_s3_bucket.site.id
    distribution_id = aws_cloudfront_distribution.site.id
    private         = aws_s3_bucket_public_access_block.site.block_public_policy && aws_s3_bucket_public_access_block.site.block_public_acls && aws_s3_bucket_public_access_block.site.ignore_public_acls && aws_s3_bucket_public_access_block.site.restrict_public_buckets
  }
}
