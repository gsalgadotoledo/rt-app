import { NoSQLCache } from "@gsalgadotoledo/rt-app-cache-nosql";
import { DynamoStore } from "@gsalgadotoledo/rt-app-dynamodb";
/** Existing table with pk/sk keys and ttl enabled; this adapter never creates infrastructure. */
export class DynamoCache extends NoSQLCache {
  constructor(
    table: string,
    options: { region?: string; endpoint?: string } = {},
    namespace = "default",
  ) {
    super(new DynamoStore(table, options), namespace);
  }
}
