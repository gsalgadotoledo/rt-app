import { RTAppIdempotencyError, type RTAppIdempotencyExecutor, type RTAppIdempotencyRequest, type RTAppIdempotencyContext, type RTAppJson } from "./idempotency.js";
import { RTAppBaseModule } from "@gsalgadotoledo/rt-app-core";
/** Optional convenience base; implementing the interface directly remains supported. */
export abstract class RTAppIdempotentModule extends RTAppBaseModule {
  idempotency: RTAppIdempotencyExecutor | undefined = undefined;
  protected executeIdempotent<I extends RTAppJson, O extends RTAppJson>(
    request: RTAppIdempotencyRequest<I>,
    work: (context: RTAppIdempotencyContext<I>) => Promise<O>,
  ): Promise<O> {
    if (!this.idempotency) return Promise.reject(new RTAppIdempotencyError("NOT_CONFIGURED"));
    return this.idempotency.execute(request, work);
  }
}
