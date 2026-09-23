export {createApplication, createProductionApplication, seedDemo, loadProductionApplication} from "@gsalgadotoledo/rt-app-framework";

export function runtimeSettings(): ReturnType<typeof import('@gsalgadotoledo/rt-app-config').runtimeConfig>;
