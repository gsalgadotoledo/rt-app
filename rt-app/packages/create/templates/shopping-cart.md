---
id: shopping-cart
name: Shopping cart
description: Store with products, cart items and example data. Payments are left as the next step.
kind: fullstack
requirements: [node]
crud:
  - name: products
    title: Products
    fields: { name: string, price: number, description: string?, active: boolean }
  - name: cart-items
    title: Cart items
    fields: { productId: string, quantity: number }
---
# Shopping cart

The base project (API, SPA, SSR, admin) is generated, plus two editable modules: `packages/products` and `packages/cart-items`, each with migrations and faker seeds (`rta seed`).

## Where things go

The store is a **customer site**: the whole customer journey lives in the SSR app (`apps/ssr`), including catalog, search, product detail, sign-in, cart, checkout, payment result and order history. Server components render catalog pages for SEO. Client components handle the signed-in parts, with the session per tab and dropped on a 401. The SPA is for internal tools (back office, CRM-style); it is not part of the customer journey. Managers use the admin.

## What to build

1. **Catalog (SSR):** `apps/ssr` lists active products with SEO-friendly pages (`/products/[id]`). Only active products are public; add a guest read endpoint for them in the products module.
2. **Cart (SSR):** signed-in customers add items from listings and product pages, change quantities and see totals. Cart items belong to their owner: add ownership checks to every cart endpoint (a user never reads another user's cart).
3. **Prices** are integers in minor units (cents). Never use floats for money. Show them with the user's locale.
4. **Checkout:** stop at an order summary. Payments are a separate decision (Stripe through the subscriptions module, or a dedicated payments module); ask before adding one.
5. **Admin:** products are managed in the admin with explicit `products.*` permissions.

## Done when

A visitor browses products, signs in, builds a cart and checks out, all on the SSR site. The admin manages products, and tests cover ownership and price math.
