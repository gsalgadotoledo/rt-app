import { PostgresStore } from "@gsalgadotoledo/rt-app-postgres";

/**
 * Local Postgres (for example the one the Service Manager installs). DATABASE_URL is required and
 * must point to this machine: remote databases are only used by portable deployments.
 */
export function localPostgres() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("Set DATABASE_URL (e.g. postgres://postgres:postgres@127.0.0.1:5432/rt_app) for RT_APP_MODE=postgres");
  if (!["localhost", "127.0.0.1", "::1"].includes(new URL(url).hostname))
    throw new Error("RT_APP_MODE=postgres only accepts a local database; deployed processes use RT_APP_TARGET=portable");
  return PostgresStore.connect(url, { ssl: false });
}
