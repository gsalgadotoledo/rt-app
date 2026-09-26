terraform {
  required_version = ">= 1.11.0, < 2.0.0"
  required_providers {
    stripe = {
      source  = "stripe/stripe"
      version = "~> 0.3"
    }
  }
}

# Uses var.stripe_api_key, or the STRIPE_API_KEY environment variable when it is empty
# (set it once under Global variables in the Service Manager's Terraform panel).
provider "stripe" {
  api_key = var.stripe_api_key
}
