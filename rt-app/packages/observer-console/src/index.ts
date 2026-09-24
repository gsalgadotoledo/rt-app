import type {
  ObserverOutputHandler,
  ObserverEvent,
} from "@gsalgadotoledo/rt-app-observer";
export class ConsoleOutput implements ObserverOutputHandler {
  readonly id = "console";
  write(event: ObserverEvent) {
    console[event.level](JSON.stringify(event));
  }
}
