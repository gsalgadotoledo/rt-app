import { RTAppManager } from "./RTAppManager.js";
import type { RTAppModule, RTAppRegistry } from "./types.js";
export { RTAppManager } from "./RTAppManager.js";
export type {
  RTAppModule,
  RTAppComponent,
  RTAppComponentModule,
  RTAppModuleConfig,
  RTAppModuleParams,
  RTAppRegistry,
  RTAppModuleInstance,
  RTAppResolver,
} from "./types.js";

/**
 * Create a module runner. Call rtApp().loadAll() at startup (async); then rtApp(name) is sync.
 * rtApp() with no args returns the RTAppManager (e.g. await rtApp().loadAll() at startup).
 */
export function createRTApp<Rg extends RTAppRegistry>(modules: Rg): import("./types.js").RTAppResolver<Rg>;
export function createRTApp(): import("./types.js").RTAppResolver<RTAppRegistry>;
export function createRTApp(modules: RTAppRegistry = {}): unknown {
  const manager = new RTAppManager(modules);
  return (name?: string | null) => name == null ? manager : manager.resolve(name);
}

export { RTAppBaseModule } from "./RTAppBaseModule.js";
