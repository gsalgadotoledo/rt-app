import { NoSQLCache } from "@gsalgadotoledo/rt-app-cache-nosql";
import { JsonStore } from "@gsalgadotoledo/rt-app-json";
/** Use a dedicated cache file, not the application's database file. */
export class FileCache extends NoSQLCache {
  constructor(file = ".rt-app/cache.json", namespace = "default") {
    super(new JsonStore(file), namespace);
  }
}
