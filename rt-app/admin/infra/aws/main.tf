terraform {
  required_providers {
    aws = { source = "hashicorp/aws", version = "= 6.36.0" }
  }
}

variable "name" { type = string }
variable "account_id" { type = string }
module "site" {
  source     = "../../../infra/aws/site"
  name       = var.name
  site       = "admin"
  account_id = var.account_id
}
output "site" { value = module.site.site }
