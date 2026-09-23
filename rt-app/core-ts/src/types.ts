import type { RTAppManager } from "./RTAppManager.js";

/**
 * Base interface for modules run by RT-App.
 * RT-App injects __rtApp at runtime so modules can resolve other modules.
 */
export interface RTAppModule {
  /** Sync or async. Use async for DB connections, pools, and other async setup. */
  init(): void | Promise<void>;
  /** Release resources; must tolerate partial initialization. */
  dispose?(): void | Promise<void>;
  /** Resolve another module by name. Returns Promise when getModule is async; await it in async init() if needed. */
  __rtApp?(name: string): unknown | Promise<unknown>;
}

export type RTAppModuleParams = Record<string, unknown>;

export type RTAppModuleConfig<T extends RTAppModule = RTAppModule> = {
  module: new () => T;
  dependsOn?: readonly string[];
  preload?: boolean;
  /** Bind instance fields to root providers; implies initialization dependencies. */
  bindings?: Readonly<Record<string, string>>;
} & RTAppModuleParams;

export type RTAppRegistry = Record<string, RTAppModuleConfig>;

/** Extract the instance type for a registry entry (e.g. SubscriptionsEngine from { module: SubscriptionsEngineModule }). */
export type RTAppModuleInstance<
  Rg extends RTAppRegistry,
  K extends keyof Rg,
> = Rg[K] extends RTAppModuleConfig<infer T> ? T : RTAppModule;

/**
 * Build the type of the runner function rtApp from a module registry.
 * rtApp() returns RTAppManager; rtApp(name) returns instance of that module (sync after loadAll()).
 */
export type RTAppResolver<Rg extends RTAppRegistry> =
  (() => RTAppManager) &
    (<K extends keyof Rg>(name: K) => RTAppModuleInstance<Rg, K>);

/** Per-view/session state. Never implicitly shared across users or windows. */
export interface RTAppComponent { dispose(): void; }
export interface RTAppComponentModule<Options, Component extends RTAppComponent> extends RTAppModule {
  create(options: Options): Component;
}
