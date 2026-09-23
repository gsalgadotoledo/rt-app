moved {
  from = aws_dynamodb_table.data["application"]
  to   = aws_dynamodb_table.application
}
moved {
  from = aws_secretsmanager_secret.jwt
  to   = module.api.aws_secretsmanager_secret.jwt
}
moved {
  from = aws_secretsmanager_secret.infra
  to   = module.api.aws_secretsmanager_secret.infra
}
moved {
  from = aws_cloudwatch_log_group.api
  to   = module.api.aws_cloudwatch_log_group.api
}
moved {
  from = aws_iam_role.lambda
  to   = module.api.aws_iam_role.lambda
}
moved {
  from = aws_iam_role_policy.lambda
  to   = module.api.aws_iam_role_policy.lambda
}
moved {
  from = aws_lambda_function.api
  to   = module.api.aws_lambda_function.api
}
moved {
  from = aws_lambda_alias.live
  to   = module.api.aws_lambda_alias.live
}
moved {
  from = aws_apigatewayv2_api.api
  to   = module.api.aws_apigatewayv2_api.api
}
moved {
  from = aws_apigatewayv2_integration.api
  to   = module.api.aws_apigatewayv2_integration.api
}
moved {
  from = aws_apigatewayv2_route.api
  to   = module.api.aws_apigatewayv2_route.api
}
moved {
  from = aws_apigatewayv2_stage.live
  to   = module.api.aws_apigatewayv2_stage.live
}
moved {
  from = aws_lambda_permission.api
  to   = module.api.aws_lambda_permission.api
}
moved {
  from = aws_s3_bucket.site["admin"]
  to   = module.admin.module.site.aws_s3_bucket.site
}
moved {
  from = aws_s3_bucket.site["public"]
  to   = module.public.aws_s3_bucket.site
}
moved {
  from = aws_s3_bucket_public_access_block.site["admin"]
  to   = module.admin.module.site.aws_s3_bucket_public_access_block.site
}
moved {
  from = aws_s3_bucket_public_access_block.site["public"]
  to   = module.public.aws_s3_bucket_public_access_block.site
}
moved {
  from = aws_s3_bucket_versioning.site["admin"]
  to   = module.admin.module.site.aws_s3_bucket_versioning.site
}
moved {
  from = aws_s3_bucket_versioning.site["public"]
  to   = module.public.aws_s3_bucket_versioning.site
}
moved {
  from = aws_s3_bucket_server_side_encryption_configuration.site["admin"]
  to   = module.admin.module.site.aws_s3_bucket_server_side_encryption_configuration.site
}
moved {
  from = aws_s3_bucket_server_side_encryption_configuration.site["public"]
  to   = module.public.aws_s3_bucket_server_side_encryption_configuration.site
}
moved {
  from = aws_cloudfront_origin_access_control.site["admin"]
  to   = module.admin.module.site.aws_cloudfront_origin_access_control.site
}
moved {
  from = aws_cloudfront_origin_access_control.site["public"]
  to   = module.public.aws_cloudfront_origin_access_control.site
}
moved {
  from = aws_cloudfront_distribution.site["admin"]
  to   = module.admin.module.site.aws_cloudfront_distribution.site
}
moved {
  from = aws_cloudfront_distribution.site["public"]
  to   = module.public.aws_cloudfront_distribution.site
}
moved {
  from = aws_s3_bucket_policy.site["admin"]
  to   = module.admin.module.site.aws_s3_bucket_policy.site
}
moved {
  from = aws_s3_bucket_policy.site["public"]
  to   = module.public.aws_s3_bucket_policy.site
}

# Existing installations may retain their old admin table for manual backup/review.
removed {
  from = module.admin.aws_dynamodb_table.data
  lifecycle { destroy = false }
}
