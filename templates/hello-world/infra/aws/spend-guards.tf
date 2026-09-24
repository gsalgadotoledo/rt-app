variable "spend_guards" {
  description = "Monthly account/service budgets; configured in spend-guards.auto.tfvars.json. No rules means no automatic action."
  type = map(object({
    service      = string
    monthly_usd  = number
    emails       = set(string)
    action       = optional(string, "notify")
    instance_ids = optional(set(string), [])
  }))
  default = {}
}
module "spend_guards" {
  source       = "../../node_modules/@gsalgadotoledo/rt-app-infra/terraform/aws/spend-guards"
  name         = local.name
  application  = var.app
  environment  = var.environment
  region       = var.region
  boundary_arn = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:policy/${local.name}-runtime-boundary"
  rules        = var.spend_guards
}
