terraform {
  required_providers {
    aws = { source = "hashicorp/aws", version = "= 6.36.0" }
  }
}

variable "name" { type = string }
variable "site" { type = string }
variable "account_id" { type = string }
resource "aws_s3_bucket" "site" {
  bucket = "${var.name}-${var.account_id}-${var.site}"
  lifecycle {
    prevent_destroy = true
  }
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
    cloudfront_default_certificate = true
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
output "site" {
  value = {
    url             = "https://${aws_cloudfront_distribution.site.domain_name}"
    bucket          = aws_s3_bucket.site.id
    distribution_id = aws_cloudfront_distribution.site.id
    private         = aws_s3_bucket_public_access_block.site.block_public_policy && aws_s3_bucket_public_access_block.site.block_public_acls && aws_s3_bucket_public_access_block.site.ignore_public_acls && aws_s3_bucket_public_access_block.site.restrict_public_buckets
  }
}
