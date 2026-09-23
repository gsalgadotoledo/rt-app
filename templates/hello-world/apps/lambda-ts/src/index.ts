import { loadProductionApplication, runtimeSettings } from "../../../main.js";
// Reused on warm invocations. No migration, seed or database connection per request.
export function createLambdaHandler(
  factory: () =>
    | ReturnType<typeof loadProductionApplication>
    | Awaited<
        ReturnType<typeof loadProductionApplication>
      > = loadProductionApplication,
) {
  let app: ReturnType<typeof loadProductionApplication> | undefined;
  return async function handler(event: any) {
    if(event.source==='rt-app.subscriptions'){app??=Promise.resolve().then(factory);try{return await (await app).subscriptions.maintenance();}catch(error){app=undefined;throw error;}}
    const headers = {
      "content-type": "application/json",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    };
    let body = {};
    let raw = "";
    try {
      raw = event.isBase64Encoded
        ? Buffer.from(event.body ?? "", "base64").toString("utf8")
        : (event.body ?? "");
      if (Buffer.byteLength(raw) > (event.rawPath === "/subscriptions/webhook" ? 262144 : 16384))
        return {
          statusCode: 413,
          headers,
          body: JSON.stringify({ error: "Request body too large" }),
        };
      body = raw ? JSON.parse(raw) : {};
      if (!body || Array.isArray(body) || typeof body !== "object") throw 0;
    } catch {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: "Invalid JSON" }),
      };
    }
    app ??= Promise.resolve().then(factory);
    let backend;
    try {
      backend = await app;
    } catch {
      app = undefined;
      return {
        statusCode: 503,
        headers,
        body: JSON.stringify({ error: "Service temporarily unavailable" }),
      };
    }
    const result = await backend.handle({
      method: event.requestContext.http.method,
      path: event.rawPath,
      query: event.queryStringParameters ?? {},
      body,
      rawBody: raw,
      headers: Object.fromEntries(
        Object.entries(event.headers ?? {}).map(([k, v]) => [
          k.toLowerCase(),
          v as string,
        ]),
      ),
      ip: event.requestContext.http.sourceIp,
    });
    return {
      statusCode: result.status,
      headers,
      body: JSON.stringify(result.body),
    };
  };
}
export const handler = createLambdaHandler(async () => {
  const runtime = runtimeSettings();
  if (runtime.target !== "aws") throw new Error("The Lambda entrypoint requires AWS runtime settings");
  return loadProductionApplication();
});
