import { execFile } from "node:child_process";
import { writeFile, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { openDataApplication } from "./data-application.js";

/**
 * Bridge between the subscriptions module and infra/stripe (Terraform):
 *   npm run stripe:plans  → write infra/stripe/plans.auto.tfvars.json from the current plans
 *   npm run stripe:link   → store the product/price ids of `terraform output plans` in the plans
 * Uses the same database as the server (RT_APP_MODE / RT_APP_TARGET).
 */
const STACK = fileURLToPath(new URL("../../../infra/stripe/", import.meta.url));
const USAGE = "Usage: npm run stripe:plans  |  npm run stripe:link [-- --from <terraform-output.json>]";

type Output = Record<string, { product_id: string; price_id: string }>;

async function terraformOutput(from?: string): Promise<Output> {
  if (from) {
    const parsed = JSON.parse(await readFile(from, "utf8"));
    return parsed.plans?.value ?? parsed.value ?? parsed;
  }
  const { stdout } = await promisify(execFile)(process.env.TF_CLI_PATH ?? "terraform", ["output", "-json", "plans"], { cwd: STACK });
  return JSON.parse(stdout);
}

try {
  const [action = "export", flag, from] = process.argv.slice(2);
  if (!["export", "link"].includes(action) || (flag && flag !== "--from")) throw new Error(USAGE);
  const app: any = await openDataApplication();
  if (!app.subscriptions) throw new Error("The subscriptions module is not enabled in this project.");
  const settings = await app.subscriptions.settings();
  if (action === "export") {
    const plans = settings.values.plans
      .filter((p: any) => !p.archived)
      .map((p: any) => ({ id: p.id, name: p.name, amount: p.amount, currency: p.currency, periodDays: p.periodDays, description: p.description ?? "", enabled: p.enabled }));
    await writeFile(STACK + "plans.auto.tfvars.json", JSON.stringify({ plans }, null, 2) + "\n");
    const paid = plans.filter((p: any) => p.enabled && p.amount > 0);
    console.log(`Wrote infra/stripe/plans.auto.tfvars.json: ${plans.length} plans, ${paid.length} paid (${paid.map((p: any) => p.id).join(", ") || "none"}).`);
    console.log("Next: Plan and Apply infra/stripe (Service Manager → Terraform), then npm run stripe:link.");
  } else {
    const output = await terraformOutput(from);
    const links = Object.fromEntries(Object.entries(output).map(([id, ids]) => [id, { productId: ids.product_id, priceId: ids.price_id }]));
    const linked: string[] = await app.subscriptions.linkStripePrices(links, "terraform");
    console.log(linked.length ? `Linked Stripe prices to: ${linked.join(", ")}.` : "Plans already linked; nothing to change.");
  }
} catch (error: any) {
  console.error(error.message);
  process.exitCode = 1;
}
