import { loadProductionApplication, seedDemo } from "../../../main.js";
if (process.env.CONFIRM_DEMO_SEED !== "yes" || !process.env.DEMO_PASSWORD)
  throw new Error(
    "Set CONFIRM_DEMO_SEED=yes and a strong DEMO_PASSWORD explicitly. Never seed demo identities in production.",
  );
console.log(
  await seedDemo(await loadProductionApplication(), process.env.DEMO_PASSWORD),
);
