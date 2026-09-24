/** Public UI hints only. Backend authorization and paid entitlements stay server-side. */
export async function evaluateFlags(
  apiUrl,
  keys,
  subject = "",
  fetcher = fetch,
) {
  const response = await fetcher(
    apiUrl.replace(/\/$/, "") + "/feature-flags/evaluate",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ keys, subject }),
      credentials: "omit",
      signal: AbortSignal.timeout(5000),
    },
  );
  if (!response.ok) throw new Error("Feature flags unavailable");
  return response.json();
}
