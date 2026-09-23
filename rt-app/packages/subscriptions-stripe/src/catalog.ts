import {createHash} from 'node:crypto';
import Stripe from 'stripe';
import type {CatalogPublisher, Plan} from '@gsalgadotoledo/rt-app-subscriptions';
import {HttpError} from '@gsalgadotoledo/rt-app-contracts';

/** Versioned catalog publisher. Uses stable remote IDs to resume partial work. */
export class StripeCatalog implements CatalogPublisher {
  private stripe: Stripe;
  constructor(secret: string) {
    if (!/^(sk|rk)_(test|live)_/.test(secret)) throw new HttpError(400, 'Configure STRIPE_SECRET_KEY or enter a Stripe secret/restricted key');
    this.stripe = new Stripe(secret, {maxNetworkRetries: 1, timeout: 10000});
  }
  async publish(plan: Plan, namespace: string, previous?: Plan) {
    const token = createHash('sha256').update(`${namespace}:${plan.id}:${plan.version ?? '0.0.1'}`).digest('hex').slice(0,40);
    const productId = 'rt_' + token, lookupKey = 'rt_price_' + token;
    const metadata = {...plan.metadata, B_version:plan.version ?? '0.0.1', State:plan.enabled ? 'Enabled' : 'Disabled', family:plan.family ?? plan.id, rtAppPlanId:plan.id, rtAppCatalog:namespace};
    let product;
    try { product = await this.stripe.products.retrieve(productId); }
    catch (error: any) {
      if (error.code !== 'resource_missing') throw error;
      product = await this.stripe.products.create({id:productId, name:plan.name, description:plan.description || undefined, active:plan.enabled, metadata}, {idempotencyKey:productId});
    }
    if (product.metadata.rtAppCatalog !== namespace) throw new HttpError(409, 'Stripe catalog ownership mismatch');
    const found = await this.stripe.prices.list({lookup_keys:[lookupKey],limit:2});
    if (found.data.length > 1) throw new HttpError(409, 'Multiple Stripe prices match this version');
    let price = found.data[0];
    if (!price) price = await this.stripe.prices.create({product:productId, unit_amount:plan.amount, currency:plan.currency,
      recurring:{interval:'day',interval_count:plan.periodDays}, lookup_key:lookupKey, active:plan.enabled, metadata}, {idempotencyKey:lookupKey});
    if (price.product !== productId || price.unit_amount !== plan.amount || price.currency !== plan.currency || price.recurring?.interval !== 'day' || price.recurring.interval_count !== plan.periodDays)
      throw new HttpError(409, 'Existing Stripe price does not match this immutable plan version');
    await this.stripe.products.update(productId,{name:plan.name,description:plan.description ?? '',active:plan.enabled,metadata,default_price:price.id});
    await this.stripe.prices.update(price.id,{active:plan.enabled,metadata});
    // Archive only resources previously created by this catalog, never unrelated products.
    if (previous?.stripeProductId && previous.stripeProductId !== productId) {
      const old = await this.stripe.products.retrieve(previous.stripeProductId);
      if (old.metadata.rtAppCatalog !== namespace) throw new HttpError(409, 'Previous Stripe product belongs to another catalog');
      if (previous.stripePriceId) {
        const oldPrice = await this.stripe.prices.retrieve(previous.stripePriceId);
        if (oldPrice.product !== old.id) throw new HttpError(409, 'Previous Stripe price ownership mismatch');
        await this.stripe.prices.update(oldPrice.id,{active:false,metadata:{State:'Disabled'}});
      }
      await this.stripe.products.update(old.id,{active:false,metadata:{State:'Disabled'}});
    }
    return {stripeProductId:productId,stripePriceId:price.id};
  }
}
