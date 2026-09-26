# One Stripe product and one recurring price per paid, enabled plan of the subscriptions module.
# Stripe prices are immutable: changing amount, currency or period creates a new price.

locals {
  paid = { for p in var.plans : p.id => p if p.enabled && p.amount > 0 }

  # periodDays → Stripe interval: yearly, monthly (and multiples of 30 days), weekly, else days.
  recurring = { for id, p in local.paid : id => (
    p.periodDays >= 365 ? { interval = "year", count = 1 } :
    p.periodDays >= 28 && p.periodDays <= 31 ? { interval = "month", count = 1 } :
    p.periodDays % 30 == 0 ? { interval = "month", count = p.periodDays / 30 } :
    p.periodDays % 7 == 0 ? { interval = "week", count = p.periodDays / 7 } :
    { interval = "day", count = p.periodDays }
  ) }
}

resource "stripe_product" "plan" {
  for_each    = local.paid
  name        = each.value.name
  description = each.value.description != "" ? each.value.description : null
  metadata = {
    rt_app_namespace = var.namespace
    rt_app_plan      = each.key
  }
}

resource "stripe_price" "plan" {
  for_each    = local.paid
  product     = stripe_product.plan[each.key].id
  currency    = lower(each.value.currency)
  unit_amount = each.value.amount
  nickname    = each.value.name
  lookup_key  = "${var.namespace}_${each.key}_${each.value.amount}_${lower(each.value.currency)}_${each.value.periodDays}d"
  recurring {
    interval       = local.recurring[each.key].interval
    interval_count = local.recurring[each.key].count
  }
  metadata = {
    rt_app_namespace = var.namespace
    rt_app_plan      = each.key
  }
}
