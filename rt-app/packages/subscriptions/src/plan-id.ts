/** Stable, URL-safe draft IDs; collision suffixes include archived plans. */
export function planIdFromName(name: string, existing: string[] = []): string {
  const base = name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80).replace(/-$/,'') || 'new-plan';
  const ids = new Set(existing);
  let value = base, suffix = 2;
  while (ids.has(value)) value = `${base}-${suffix++}`;
  return value;
}
