import type { Observer, ViewOptions } from "@gsalgadotoledo/rt-app-observer";
/** Product analytics uses the same filtered delivery pipeline, with a distinct event kind. */
export class Analytics {
  constructor(private observer: Observer) {}
  pageView(title: string, options: ViewOptions) {
    return this.observer.withContext({ category: "analytics" }, () =>
      this.observer.countView(title, options),
    );
  }
  track(
    name: string,
    properties: Record<string, unknown> = {},
    source = "app",
  ) {
    if (!/^[a-zA-Z][a-zA-Z0-9._-]{0,79}$/.test(name))
      throw new TypeError("Use a stable analytics event name");
    return this.observer.withContext({ category: "analytics" }, () =>
      this.observer.emit("info", "analytics", source, name, properties),
    );
  }
}
