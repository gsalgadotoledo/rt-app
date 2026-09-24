import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { relative, resolve } from "node:path";

const root = fileURLToPath(new URL("../../", import.meta.url));
const summary = JSON.parse(
  readFileSync(resolve(root, "coverage/coverage-summary.json"), "utf8"),
);
const baseline = JSON.parse(
  readFileSync(new URL("../coverage-baseline.json", import.meta.url), "utf8"),
);
const metrics = ["lines", "statements", "branches", "functions"];
const components = {};

/** Aggregate counters, never average percentages: a small file cannot outweigh a large one. */
for (const [file, coverage] of Object.entries(summary)) {
  if (file === "total") continue;
  const path = relative(root, file).replaceAll("\\", "/");
  const name =
    path.match(/^rt-app\/packages\/([^/]+)\//)?.[1] ??
    (path.startsWith("rt-app/core-ts/")
      ? "core-ts"
      : path.startsWith("rt-app/admin/")
        ? "admin-backend"
        : path.startsWith("rt-app/installer/")
          ? "installer"
          : "framework");
  const counters = (components[name] ??= Object.fromEntries(
    metrics.map((metric) => [metric, { covered: 0, total: 0 }]),
  ));
  for (const metric of metrics) {
    counters[metric].covered += coverage[metric].covered;
    counters[metric].total += coverage[metric].total;
  }
}

const failures = [];
const report = {};
for (const [name, counters] of Object.entries(components).sort(([a], [b]) =>
  a.localeCompare(b),
)) {
  const minimum = baseline.components[name] ?? baseline.newComponentMinimum;
  report[name] = {};
  for (const metric of metrics) {
    const { covered, total } = counters[metric];
    const percent = total ? Math.floor((10000 * covered) / total) / 100 : 100;
    report[name][metric] = percent;
    if (percent < minimum[metric])
      failures.push(`${name}: ${metric} ${percent}% < ${minimum[metric]}%`);
  }
}

// Missing baseline components indicate a scope/configuration regression, not success.
for (const name of Object.keys(baseline.components)) {
  if (!components[name]) failures.push(`${name}: missing from coverage report`);
}
if (!Object.keys(components).length)
  failures.push("No backend components were measured");

// Discover new backend packages too: a missing build/report cannot silently pass.
const packagesRoot = resolve(root, "rt-app/packages");
for (const name of readdirSync(packagesRoot)) {
  const source = resolve(packagesRoot, name, "src");
  if (["admin-ui", "service-manager"].includes(name) || !existsSync(source))
    continue;
  if (
    !readdirSync(source).some(
      (file) => file.endsWith(".ts") && !file.endsWith(".d.ts"),
    )
  )
    continue;
  const manifest = JSON.parse(
    readFileSync(resolve(packagesRoot, name, "package.json"), "utf8"),
  );
  if (!manifest.scripts?.test)
    failures.push(`${name}: missing package-owned test command`);
  if (!components[name])
    failures.push(`${name}: backend source is absent from coverage`);
}
writeFileSync(
  resolve(root, "coverage/components.json"),
  JSON.stringify(report, null, 2) + "\n",
);
console.table(report);
if (failures.length) {
  console.error(`Coverage gate failed:\n${failures.join("\n")}`);
  process.exitCode = 1;
} else {
  console.log(
    `Coverage floors passed for ${Object.keys(components).length} backend components.`,
  );
}
