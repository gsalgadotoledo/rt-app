import type {
  ObserverOutputHandler,
  ObserverEvent,
  LogLevel,
} from "@gsalgadotoledo/rt-app-observer";

/** Where each severity is written; the global console by default (tests inject a sink). */
export type ConsoleSink = Pick<Console, LogLevel>;

export class ConsoleOutput implements ObserverOutputHandler {
  readonly id = "console";
  constructor(private sink: ConsoleSink = console) {}

  /** One JSON line per event through the console method matching its level. */
  write(event: ObserverEvent) {
    this.sink[event.level](JSON.stringify(event));
  }
}
