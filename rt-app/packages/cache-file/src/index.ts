import { NoSQLCache } from "@gsalgadotoledo/rt-app-cache-nosql";
import { JsonStore } from "@gsalgadotoledo/rt-app-json";
/** Use a dedicated cache file, not the application's database file. `clock` (epoch ms) is for tests. */
export class FileCache extends NoSQLCache {
  constructor(
    file = ".rt-app/cache.json",
    namespace = "default",
    clock: () => number = Date.now,
  ) {
    super(new JsonStore(file), namespace, clock);
  }
}
