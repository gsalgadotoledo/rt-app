import { readFile } from "node:fs/promises";

/** Resolve the running project's API. Credentials remain in the environment. */
export async function moduleClient(root = process.cwd()) {
  let settings = {};
  try {
    settings = JSON.parse(
      await readFile(`${root}/rt-app.settings.json`, "utf8"),
    );
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const base = new URL(
    process.env.RT_APP_API_URL ??
      `http://localhost:${settings.local?.ports?.api ?? 4010}`,
  );
  if (
    base.protocol !== "https:" &&
    !(
      base.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname)
    )
  )
    throw new Error("Use HTTPS for remote APIs");

  async function api(path, method = "GET", body) {
    const response = await fetch(new URL(path, base), {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(30000),
      headers: {
        "content-type": "application/json",
        ...(process.env.RT_APP_ADMIN_TOKEN
          ? { authorization: `Bearer ${process.env.RT_APP_ADMIN_TOKEN}` }
          : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok)
      throw new Error(
        `${response.status}: ${data.error ?? "API request failed"}`,
      );
    return data;
  }

  // The backend publishes only opted-in actions and authorizes every invocation.
  const tools = await api("/admin/tools");
  async function call(name, input = {}) {
    const tool = tools.find((t) => t.name === name);
    if (!tool) throw new Error(`Unknown module action: ${name}`);
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new Error("Input must be an object");
    const path = tool.path.replace(/:([a-zA-Z0-9_]+)/g, (_, key) => {
      if (
        typeof input.params?.[key] !== "string" ||
        !input.params[key] ||
        [".", ".."].includes(input.params[key])
      )
        throw new Error(`Missing params.${key}`);
      return encodeURIComponent(input.params[key]);
    });
    const query = new URLSearchParams(input.query ?? {});
    return api(
      path + (query.size ? `?${query}` : ""),
      tool.method,
      tool.method === "GET" ? undefined : (input.body ?? {}),
    );
  }
  return { tools, call };
}

/** JSON output keeps the CLI usable by both humans and agents. */
export async function runModuleCommand(args) {
  const client = await moduleClient();
  const [name = "list", payload] = args;
  if (name === "list" || name === "--help")
    return console.log(JSON.stringify(client.tools, null, 2));
  const raw = payload?.startsWith("@")
    ? await readFile(payload.slice(1), "utf8")
    : (payload ?? "{}");
  console.log(
    JSON.stringify(await client.call(name, JSON.parse(raw)), null, 2),
  );
}
