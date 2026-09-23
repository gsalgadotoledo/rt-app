import { loadProductionApplication } from "../../../main.js";
await (await loadProductionApplication()).migrate();
console.log("Module migrations applied.");
