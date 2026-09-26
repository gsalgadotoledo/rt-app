output "plans" {
  description = "Stripe ids per plan. `npm run stripe:link` stores them in the subscriptions settings."
  value = { for id, p in local.paid : id => {
    product_id = stripe_product.plan[id].id
    price_id   = stripe_price.plan[id].id
    interval   = "${local.recurring[id].count} ${local.recurring[id].interval}"
  } }
}
