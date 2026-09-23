import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../../../", import.meta.url));
export async function installationStatus(directory = root) {
  try {
    const result = JSON.parse(
      await readFile(directory + "/.rt-app/installation.json", "utf8"),
    );
    if (result.status !== "ready") return { installed: false as const };
    const url = new URL(result.adminUrl);
    if (url.protocol !== "https:")
      throw new Error("Invalid installed admin URL");
    return {
      installed: true as const,
      loginUrl: url.href,
      ...(result.deployments?.find((d: any) => d.environment === "prod")?.apiUrl
        ? {
            apiUrl: result.deployments.find(
              (d: any) => d.environment === "prod",
            ).apiUrl,
          }
        : {}),
    };
  } catch (error: any) {
    if (error.code === "ENOENT") return { installed: false as const };
    throw error;
  }
}
export async function localSetupStatus() {
  return { local: true, installed: false, adminAuth: "local" };
}
