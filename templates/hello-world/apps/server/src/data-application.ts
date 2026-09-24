import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { JsonStore } from "@gsalgadotoledo/rt-app-json";
import { LocalMailbox } from "@gsalgadotoledo/rt-app-auth";
import {
  runtimeSettings,
  createApplication,
  loadProductionApplication,
  createPortableApplication,
} from "../../../main.js";
import { localDynamo } from "./local-dynamo.js";
import { localSecret } from "./local-secret.js";
import { localPostgres } from "./local-postgres.js";

/**
 * Open the application against the same database the server uses (RT_APP_MODE), for the
 * migrate and seed commands. No HTTP server, mail delivery or demo seeding happens here.
 */
export async function openDataApplication() {
  const { target, mode } = runtimeSettings();
  if (target === "aws") return loadProductionApplication();
  if (target === "portable") return createPortableApplication();
  if (mode === "memory")
    throw new Error(
      "Memory data lives inside the running server. Use RT_APP_MODE=json or dynamodb-local to migrate or seed from the CLI.",
    );
  if (!["json", "dynamodb-local", "postgres"].includes(mode)) throw new Error("Invalid RT_APP_MODE");
  // The dev server runs inside apps/server (npm --workspace), so resolve from there, not from the caller's cwd.
  const serverDirectory = fileURLToPath(new URL("..", import.meta.url));
  const file = resolve(serverDirectory, process.env.RT_APP_JSON_FILE ?? ".rt-app/local.json");
  return createApplication({
    store: mode === "json" ? new JsonStore(file) : mode === "postgres" ? localPostgres() : await localDynamo(),
    localAdminAccess: true,
    mailer: new LocalMailbox(),
    secret: mode === "json" ? await localSecret(file) : mode === "postgres" ? await localSecret(resolve(serverDirectory, ".rt-app/postgres")) : randomBytes(48).toString("hex"),
    tasks: process.env.ENABLE_TASKS !== "false",
  });
}
