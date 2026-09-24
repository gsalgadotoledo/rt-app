import { seedCommand } from "@gsalgadotoledo/rt-app-migrations/cli";
import { runtimeSettings } from "../../../main.js";
import { openDataApplication } from "./data-application.js";

// rta seed [status|run] [--module <id>] [--rerun] [--json]
// Each module decides where its seeds may run; demo seeds never declare prod.
try {
  const argv = process.argv.slice(2);
  if (runtimeSettings().mode === "aws" && argv[0] !== "status" && process.env.CONFIRM_DEMO_SEED !== "yes")
    throw new Error("Set CONFIRM_DEMO_SEED=yes to seed a deployed environment.");
  await seedCommand(await openDataApplication(), argv, {
    DEMO_PASSWORD: process.env.DEMO_PASSWORD,
  });
} catch (error: any) {
  console.error(error.message);
  process.exitCode = 1;
}
