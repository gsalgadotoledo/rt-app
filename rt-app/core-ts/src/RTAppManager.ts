import type { RTAppModule, RTAppModuleConfig, RTAppRegistry } from "./types.js";

export class RTAppManager {
  private modules: RTAppRegistry = Object.create(null);
  private moduleInstances: Record<string, RTAppModule> = Object.create(null);
  private initialization = new Map<string, Promise<void>>();
  private started = false;
  private closing = false;
  private disposed = false;
  private disposal?: Promise<void>;
  private queue: Promise<void> = Promise.resolve();

  constructor(modules: RTAppRegistry = {}) {
    for (const [name, params] of Object.entries(modules)) this.setModule(name, params);
  }

  setModule(name: string, params: RTAppModuleConfig): void {
    if (this.started || this.closing) throw new Error("Cannot change modules after initialization starts");
    if (!params || typeof params.module !== "function") throw new Error(`Invalid module: ${name}`);
    const bindings = { ...params.bindings };
    this.modules[name] = { ...params, bindings, dependsOn: [...new Set([
      ...(params.dependsOn ?? []), ...Object.values(bindings),
    ])] };
  }

  private order(names: string[]): string[] {
    const done = new Set<string>(), active = new Set<string>(), result: string[] = [];
    const visit = (name: string, path: string[]) => {
      if (active.has(name)) throw new Error(`Module dependency cycle: ${[...path, name].join(" -> ")}`);
      if (done.has(name)) return;
      const config = this.modules[name];
      if (!config) throw new Error(`Unknown module dependency: ${[...path, name].join(" -> ")}`);
      active.add(name);
      for (const dependency of config.dependsOn ?? []) visit(dependency, [...path, name]);
      active.delete(name); done.add(name); result.push(name);
    };
    for (const name of names) visit(name, []);
    return result;
  }

  private createInstance(name: string): void {
    if (this.moduleInstances[name]) return;
    const { module: ModuleClass, dependsOn, preload, bindings, ...params } = this.modules[name];
    const instance = new ModuleClass();
    if (typeof instance.init !== "function") throw new Error(`RT-App module ${name} must implement init()`);
    for (const [key, value] of Object.entries(params)) {
      if (Object.prototype.hasOwnProperty.call(instance, key)) {
        (instance as unknown as Record<string, unknown>)[key] = value;
      }
    }
    for (const [field, provider] of Object.entries(bindings ?? {})) {
      if (!Object.prototype.hasOwnProperty.call(instance, field) || field.startsWith("__")) {
        throw new Error(`Invalid binding field ${name}.${field}`);
      }
      (instance as unknown as Record<string, unknown>)[field] = this.getModule(provider);
    }
    instance.__rtApp = (n: string) => this.getModule(n);
    (instance as RTAppModule & { __rtAppModuleId: string }).__rtAppModuleId = name;
    this.moduleInstances[name] = instance;
  }

  private load(preloadOnly: boolean): Promise<void> {
    if (this.closing) return Promise.reject(new Error("RT-App is closing or disposed"));
    this.started = true;
    // Serialize overlapping preload/load calls; a failure remains sticky. Build a new
    // runner to retry, avoiding duplicate connections and partially repeated side effects.
    this.queue = this.queue.then(async () => {
      this.order(Object.keys(this.modules)); // Validate the whole graph before side effects.
      const names = Object.keys(this.modules).filter(name => !preloadOnly || this.modules[name].preload);
      const order = this.order(names);
      for (const name of order) this.createInstance(name);
      for (const name of order) {
        let promise = this.initialization.get(name);
        if (!promise) {
          promise = Promise.resolve().then(() => this.moduleInstances[name].init());
          this.initialization.set(name, promise);
        }
        await promise;
      }
    });
    return this.queue;
  }

  /** Preload marked modules and their declared dependencies exactly once. */
  preloadAll(): Promise<void> { return this.load(true); }

  /** Initialize in dependency order. Undeclared legacy dependencies retain insertion order. */
  loadAll(): Promise<void> { return this.load(false); }

  /** Legacy synchronous resolution; callers must await startup before handling requests. */
  getModule<T extends RTAppModule = RTAppModule>(name: string): T {
    if (this.disposed) throw new Error("RT-App is disposed");
    const instance = this.moduleInstances[name];
    if (!instance) throw new Error(`Module ${name} not loaded. Call loadAll() first.`);
    return instance as T;
  }

  /** Stop new work before calling. Releases constructed modules once, in reverse order. */
  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.closing = true;
    this.disposal = this.queue.catch(() => undefined).then(async () => {
      const failures: unknown[] = [];
      for (const instance of Object.values(this.moduleInstances).reverse()) {
        try { await instance.dispose?.(); } catch (error) { failures.push(error); }
      }
      this.disposed = true;
      if (failures.length) throw new AggregateError(failures, "RT-App disposal failed");
    });
    return this.disposal;
  }

  resolve<T extends RTAppModule = RTAppModule>(name: string): T { return this.getModule<T>(name); }
}
