
import { RTAppIdempotentModule } from '../dist/index.js';
class IdempotentChild extends RTAppIdempotentModule {
  init() {}
  charge() {
    const result: Promise<{ amount: number }> = this.executeIdempotent(
      { scope: 'app:actor:charge:v1', key: 'order-id', input: { amount: 100 } },
      async ({ input, idempotencyKey }) => {
        const providerKey: string = idempotencyKey;
        void providerKey;
        return { amount: input.amount };
      },
    );
    return result;
  }
  invalid() {
    // @ts-expect-error Non-JSON input cannot be fingerprinted portably.
    return this.executeIdempotent({scope:'app',key:'order',input:new Date()}, async () => null);
  }
}
void IdempotentChild;
