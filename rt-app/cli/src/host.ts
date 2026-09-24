import { adminAssets } from '@gsalgadotoledo/rt-app-config/paths';
import {pathToFileURL} from "node:url";
import {resolve} from "node:path";
import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir, rename, readdir } from "node:fs/promises";
import type { InstallHost } from "@gsalgadotoledo/rt-app-installer";
export const host: InstallHost = {
  async applicationModules() {
    const config = JSON.parse(await readFile("modules.json", "utf8"));
    return (config.generatedCrud ?? []).map((entry: {name:string}) => entry.name);
  },
  async migrateApplication() {
    const application = await import(pathToFileURL(resolve("main.js")).href);
    await application.createProductionApplication().migrate();
  },
  async bindInstallation(identity) {
    await mkdir(".rt-app", { recursive: true, mode: 0o700 });
    const path = ".rt-app/identity.json";
    try {
      const previous = JSON.parse(await readFile(path, "utf8"));
      if (["account", "app", "region", "repository"].some(key => previous[key] !== (identity as any)[key]))
        throw new Error(
          "This folder is linked to another account, region, application or repository. Use a copy with separate state.",
        );
    } catch (e: any) {
      if (e.code !== "ENOENT") throw e;
      await writeFile(path, JSON.stringify(identity), {
        mode: 0o600,
        flag: "wx",
      });
    }
    const previous = JSON.parse(await readFile(path, "utf8"));
    if (previous.multiEnvironment && !identity.multiEnvironment)
      throw new Error("Multi-environment is already enabled. Removing environments requires an explicit infrastructure migration.");
    // Persist expansion before provisioning so a failed run cannot later shrink roles.
    await writeFile(path, JSON.stringify(identity), {mode:0o600});
    try {
      const state = JSON.parse(
        await readFile(".rt-app/bootstrap.tfstate", "utf8"),
      );
      if (state.resources?.some((r: any) => r.type === "aws_iam_role" && r.name === "deploy" && r.instances?.some((i: any) => i.index_key === "dev" || (i.index_key === "prod" && i.attributes?.name === identity.app + "-prod-github"))))
        throw new Error("Legacy dev/prod infrastructure detected. Migrate state and data before changing resource names.");
      return {
        managesOidc:
          state.resources?.some(
            (r: any) =>
              r.type === "aws_iam_openid_connect_provider" &&
              r.instances?.length > 0,
          ) ?? false,
      };
    } catch (e: any) {
      if (e.code !== "ENOENT") throw e;
      return { managesOidc: false };
    }
  },
  async run(command, args, env) {
    return await new Promise<string>((resolve, reject) => {
      let output = "",
        errors = "";
      const child = spawn(
        command === "terraform"
          ? (process.env.TF_CLI_PATH ?? "terraform")
          : command,
        args,
        {
          env: env ?? process.env,
          stdio: ["ignore", "pipe", "pipe"],
          shell: false,
        },
      );
      child.stdout.on("data", (chunk) => {
        output += chunk.toString();
        if (output.length > 2000000) output = output.slice(-2000000);
      });
      child.stderr.on("data", (chunk) => {
        errors += chunk.toString();
        if (errors.length > 2000000) errors = errors.slice(-2000000);
      });
      child.on("error", () => reject(new Error(command + " no disponible")));
      child.on("exit", async (code) => {
        if (code === 0) {
          resolve(output);
          return;
        }
        try {
          await mkdir(".rt-app", { recursive: true, mode: 0o700 });
          await writeFile(".rt-app/last-command.log", output + errors, {
            mode: 0o600,
          });
          reject(
            new Error(
              command +
                " failed; check .rt-app/last-command.log (may contain sensitive data)",
            ),
          );
        } catch {
          reject(new Error(command + " failed and the log could not be saved"));
        }
      });
    });
  },
  async configureModules(modules) {
    await mkdir(".rt-app", { recursive: true, mode: 0o700 });
    await writeFile(
      "modules.json",
      JSON.stringify({ ...JSON.parse(await readFile("modules.json", "utf8")), modules }, null, 2) + "\n",
    );
  },
  async assets(site = "admin") {
    const directory = site === "admin" ? adminAssets() + "/" : "apps/spa/dist/";
    const result: { path: string; body: Uint8Array; type: string }[] = [];
    async function walk(prefix = "") {
      for (const entry of await readdir(directory + prefix, {
        withFileTypes: true,
      })) {
        const path = prefix + entry.name;
        if (entry.isDirectory()) await walk(path + "/");
        else
          result.push({
            path,
            body: await readFile(directory + path),
            type: path.endsWith(".html")
              ? "text/html"
              : path.endsWith(".js")
                ? "text/javascript"
                : path.endsWith(".css")
                  ? "text/css"
                  : path.endsWith(".svg")
                    ? "image/svg+xml"
                    : "application/octet-stream",
          });
      }
    }
    await walk();
    return result;
  },
  async save(result) {
    await mkdir(".rt-app", { recursive: true, mode: 0o700 });
    await writeFile(
      ".rt-app/installation.json.tmp",
      JSON.stringify(result, null, 2) + "\n",
      { mode: 0o600 },
    );
    await rename(".rt-app/installation.json.tmp", ".rt-app/installation.json");
  },
  progress(message) {
    process.stdout.write(JSON.stringify({ message }) + "\n");
  },
};
