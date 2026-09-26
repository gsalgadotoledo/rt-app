mock_provider "stripe" {
  mock_resource "stripe_product" {
    defaults = { id = "prod_mock" }
  }
  mock_resource "stripe_price" {
    defaults = { id = "price_mock" }
  }
}

variables {
  stripe_api_key = "sk_test_mock"
  plans = [
    { id = "starter", name = "Starter", amount = 0, currency = "usd", periodDays = 30 },
    { id = "pro", name = "Pro", amount = 2000, currency = "USD", periodDays = 30, description = "For professionals" },
    { id = "yearly", name = "Yearly", amount = 20000, currency = "usd", periodDays = 365 },
    { id = "quarter", name = "Quarter", amount = 5000, currency = "usd", periodDays = 90 },
    { id = "fortnight", name = "Fortnight", amount = 900, currency = "eur", periodDays = 14 },
    { id = "trial", name = "Ten days", amount = 500, currency = "usd", periodDays = 10 },
    { id = "old", name = "Old", amount = 1000, currency = "usd", periodDays = 30, enabled = false },
  ]
}

run "only_paid_enabled_plans_become_prices" {
  command = apply
  assert {
    condition     = sort(keys(stripe_price.plan)) == sort(["pro", "yearly", "quarter", "fortnight", "trial"])
    error_message = "Free and disabled plans must be skipped."
  }
  assert {
    condition     = stripe_price.plan["pro"].unit_amount == 2000 && stripe_price.plan["pro"].currency == "usd"
    error_message = "Amount is in minor units and currency lowercase."
  }
  assert {
    condition     = stripe_product.plan["pro"].description == "For professionals" && stripe_price.plan["pro"].lookup_key == "rt-app_pro_2000_usd_30d"
    error_message = "Descriptions and lookup keys come from the plan."
  }
  assert {
    condition     = output.plans["pro"].price_id == "price_mock"
    error_message = "Outputs expose the price ids."
  }
}

run "period_days_map_to_stripe_intervals" {
  command = plan
  assert {
    condition = (
      local.recurring["pro"] == { interval = "month", count = 1 } &&
      local.recurring["yearly"] == { interval = "year", count = 1 } &&
      local.recurring["quarter"] == { interval = "month", count = 3 } &&
      local.recurring["fortnight"] == { interval = "week", count = 2 } &&
      local.recurring["trial"] == { interval = "day", count = 10 }
    )
    error_message = "periodDays must map to the closest Stripe interval."
  }
}

run "namespace_is_validated" {
  command = plan
  variables { namespace = "Not Valid" }
  expect_failures = [var.namespace]
}
