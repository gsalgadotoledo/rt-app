import { HttpError, type Data } from "@gsalgadotoledo/rt-app-contracts";

// Test users (QA, demo and internal accounts) as stored on the USERS row: `data.testUser`.
// Only `true` marks a test user; a missing or any other value is a real customer. The flag is a
// label for reports and filters: it never changes sign-in, bans, permissions or credits.
// Row format and rules: docs/polyglot/users-test-flag.md; change them only together with
// users.contract.yaml.

/** Whether a user row (its data) is marked as a test user. */
export function isTestUser(data: Data | undefined): boolean {
  return data?.testUser === true;
}

/**
 * Validates an optional testUser input: undefined or null means "not given" (returns undefined),
 * a boolean is returned as is, anything else is 400 "Invalid field: testUser".
 * @example testUserInput(true) // → true
 */
export function testUserInput(value: unknown): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw new HttpError(400, "Invalid field: testUser");
  return value;
}

/**
 * Validates the testUser list filter (`?testUser=true|false`; empty means no filter, like every
 * list filter); 400 "Invalid testUser filter" for any other value.
 */
export function testUserFilter(value: string | undefined) {
  if (value !== undefined && value !== "" && value !== "true" && value !== "false")
    throw new HttpError(400, "Invalid testUser filter");
}

/**
 * Ids of the test users in a users store, for reports that must exclude them (revenue,
 * usage, economics). Reads the whole USERS partition page by page; deleted users are included
 * because their past usage is still test traffic.
 * @example const skip = await testUserIds(store); rows.filter(r => !skip.has(r.userId))
 */
export async function testUserIds(store: {
  list(pk: string, cursor?: string): Promise<{ items: { data: Data }[]; cursor?: string }>;
}): Promise<Set<string>> {
  const ids = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await store.list("USERS", cursor);
    for (const row of page.items) if (isTestUser(row.data) && typeof row.data.id === "string") ids.add(row.data.id);
    cursor = page.cursor;
  } while (cursor);
  return ids;
}
