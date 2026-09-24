import { migrateCommand } from "@gsalgadotoledo/rt-app-migrations/cli";
import { openDataApplication } from "./data-application.js";

// rta migrate [status|up|down] [--to <id>] [--step <n>] [--json]
try {
  await migrateCommand(await openDataApplication(), process.argv.slice(2));
} catch (error: any) {
  console.error(error.message);
  process.exitCode = 1;
}
