terraform {
  required_providers {
    aws = { source = "hashicorp/aws", version = "= 6.36.0" }
  }
}

variable "name" { type = string }
variable "account_id" { type = string }
variable "protect" {
  description = "Keep the admin bucket on destroy (true). false lets terraform destroy empty it; apply it first."
  type        = bool
  default     = true
}
variable "domain" {
  description = "Optional custom domain for the admin, for example admin.example.com."
  type        = string
  default     = ""
}
variable "certificate_arn" {
  description = "ACM certificate for domain in us-east-1. Required when domain is set."
  type        = string
  default     = ""
}
variable "zone_id" {
  description = "Optional Route53 hosted zone for domain (A/AAAA alias records)."
  type        = string
  default     = ""
}
module "site" {
  source          = "../site"
  name            = var.name
  site            = "admin"
  account_id      = var.account_id
  protect         = var.protect
  domain          = var.domain
  certificate_arn = var.certificate_arn
  zone_id         = var.zone_id
}
output "site" { value = module.site.site }
