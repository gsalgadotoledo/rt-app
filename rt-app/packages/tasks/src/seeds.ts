import type { Row, Seed } from "@gsalgadotoledo/rt-app-contracts";

/** What the tasks seed needs from the users module, read through the shared seed services. */
interface UserDirectory {
  demoUsers(): Promise<Row[]>;
}

/** One welcome task per demo user. Runs after users:demo-identities because users is registered first. */
export const seeds: Seed[] = [
  {
    id: "tasks:welcome",
    description: "A welcome task for each demo user",
    environments: ["local", "develop", "stage"],
    run: async ({ service, ensureRows }) => {
      const users = await service<UserDirectory>("users").demoUsers();
      await ensureRows(
        users.map((user) => ({
          pk: "TASKS",
          sk: `welcome-${user.data.id}`,
          data: {
            id: `welcome-${user.data.id}`,
            title: "Explore my first task in RT-App",
            done: false,
            ownerId: user.data.id,
            createdAt: new Date().toISOString(),
          },
        })),
      );
    },
  },
];
