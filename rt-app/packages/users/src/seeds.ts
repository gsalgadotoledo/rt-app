import type { Seed } from "@gsalgadotoledo/rt-app-contracts";
import type { Users } from "./index.js";

/**
 * Demo identities for local, develop and stage. Never declared for prod. The demo customers are
 * test users (`testUser: true`), so reports that exclude test users skip their activity.
 */
export const DEMO_USERS = [
  { email: "owner@example.test", name: "Owner", role: "owner" as const, testUser: false },
  { email: "ana@example.test", name: "Ana", role: "user" as const, testUser: true },
  { email: "leo@example.test", name: "Leo", role: "user" as const, testUser: true },
];

/**
 * Create missing demo identities with DEMO_PASSWORD. Existing accounts (and their passwords)
 * are left untouched, so re-running is safe.
 */
export function seeds(users: Users): Seed[] {
  return [
    {
      id: "users:demo-identities",
      description: "Demo owner and two test users (DEMO_PASSWORD)",
      environments: ["local", "develop", "stage"],
      run: async ({ secret, log }) => {
        for (const user of DEMO_USERS) {
          if (await users.byEmail(user.email)) continue;
          await users.create({ ...user, password: secret("DEMO_PASSWORD") }, user.role);
          log("created demo user " + user.email);
        }
      },
    },
  ];
}
