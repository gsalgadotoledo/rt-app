import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { createProject, templates } from "@gsalgadotoledo/rt-app-create";

export const USAGE = `Create an RT-App application in a new folder of the current directory.

  npm create @gsalgadotoledo/rt-app <name> [-- options]
  npx @gsalgadotoledo/create-rt-app <name> [options]

Options:
  --template <id>    fullstack (default); list them with --list
  --backend <id>     node-ts (default), python, go, java
  --dir <path>       parent folder (default: current directory)
  --no-install       skip npm install
  --no-git           skip git init and the initial commit
  --list             print the available templates`;

/** Parse `<name> --flag value` arguments. Unknown flags fail so typos never create a wrong project. */
export function parseArgs(argv) {
  const options = { template: "fullstack", backend: "node-ts", dir: ".", install: true, git: true, list: false, help: false };
  const values = { "--template": "template", "--backend": "backend", "--dir": "dir" };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--no-install") options.install = false;
    else if (arg === "--no-git") options.git = false;
    else if (arg === "--list") options.list = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (values[arg]) {
      if (argv[i + 1] === undefined || argv[i + 1].startsWith("--")) throw new Error(`${arg} needs a value\n\n${USAGE}`);
      options[values[arg]] = argv[++i];
    } else if (arg.startsWith("-")) throw new Error(`Unknown option ${arg}\n\n${USAGE}`);
    else if (options.name) throw new Error(`Only one project name is allowed\n\n${USAGE}`);
    else options.name = arg;
  }
  return options;
}

/**
 * Initialize git with one initial commit so the project can be pushed to GitHub right away.
 * Returns false (and leaves the files untouched) when git is missing or has no identity.
 */
export function initGit(path, run = spawnSync) {
  const git = (...args) => run("git", args, { cwd: path, encoding: "utf8" });
  if (git("--version").status !== 0) return false;
  if (git("init", "-b", "main").status !== 0) return false;
  git("add", "-A");
  return git("commit", "-m", "Create application with RT-App").status === 0;
}

/** CLI entry: returns the process exit code. Output goes through `out`/`err` for tests. */
export async function main(argv, { cwd = process.cwd(), out = console.log, err = console.error, create = createProject, list = templates, git = initGit } = {}) {
  try {
    const options = parseArgs(argv);
    if (options.help) return out(USAGE), 0;
    if (options.list) return out(JSON.stringify(await list(), null, 2)), 0;
    if (!options.name) return err(USAGE), 1;
    const result = await create({
      workspace: resolve(cwd, options.dir),
      name: options.name,
      templateId: options.template,
      backendId: options.backend,
      install: options.install,
      onLog: (line) => err(line),
    });
    const committed = options.git && git(result.path);
    out(`\nCreated ${result.name} in ${result.path}\n`);
    out("Next steps:");
    out(`  cd ${options.dir === "." ? result.name : result.path}`);
    if (!options.install) out("  npm install");
    out("  npm run dev");
    if (committed) out("\nPublish to GitHub (private):\n  gh repo create --private --source . --push");
    else if (options.git) out("\nGit was not initialized (git missing or no user.name/user.email). Run: git init && git add -A && git commit -m init");
    return 0;
  } catch (error) {
    err(error.message);
    return 1;
  }
}
