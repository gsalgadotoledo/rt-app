import type { RTAppModule } from "./types.js";
/** Optional lifecycle base; domain capabilities belong to specialized packages. */
export abstract class RTAppBaseModule implements RTAppModule {
  declare __rtApp?: (name: string) => unknown;
  abstract init(): void | Promise<void>;
  dispose(): void | Promise<void> {}
}
