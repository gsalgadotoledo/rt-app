/** Server-only output transport. Never include destination credentials in diagnostics. */
export async function postOutput(
  url: string,
  body: string,
  headers: Record<string, string>,
  signal?: AbortSignal,
  transport: typeof fetch = fetch,
): Promise<void> {
  const destination = new URL(url);
  if (
    destination.protocol !== "https:" ||
    destination.password ||
    destination.username
  )
    throw new Error(
      "Observer destinations require HTTPS without URL credentials",
    );
  const response = await transport(destination, {
    method: "POST",
    headers,
    body,
    signal,
    redirect: "error",
  });
  await response.body?.cancel();
  if (!response.ok)
    throw new Error(`Observer destination returned HTTP ${response.status}`);
}
