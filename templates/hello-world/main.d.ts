export {createApplication, createProductionApplication, createPortableApplication, seedDemo, loadProductionApplication} from "@gsalgadotoledo/rt-app-framework";

export function runtimeSettings(): ReturnType<typeof import('@gsalgadotoledo/rt-app-config').runtimeConfig>;
