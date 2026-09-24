import { createHash } from "node:crypto";
import { HttpError, type Feature } from "@gsalgadotoledo/rt-app-contracts";
import type { NoSQL } from "@gsalgadotoledo/rt-app-nosql";
export interface Flag {
  key: string;
  description: string;
  enabled: boolean;
  public: boolean;
  rollout: number;
  subjects: string[];
  version: number;
  updatedAt: string;
  updatedBy: string;
}
export interface FlagDefinition {
  description: string;
  enabled: boolean;
  public: boolean;
  rollout: number;
  subjects: string[];
}
const validKey = (key: string) => {
  if (!/^[a-z][a-z0-9._-]{0,79}$/.test(key))
    throw new HttpError(400, "Invalid flag key");
};

/** Boolean features, deterministic percentage rollouts and explicit subject targeting. */
export class FeatureFlags {
  constructor(private store: NoSQL) {}
  /** Return one storage page of admin-only definitions; forward the opaque cursor unchanged. */
  async list(cursor?: string) {
    const page = await this.store.list("FLAGS", cursor);
    return {
      items: page.items.map((row) => ({ ...row.data, version: row.version })),
      cursor: page.cursor,
    };
  }
  /** Read a validated key; missing definitions return undefined. */
  async get(key: string): Promise<Flag | undefined> {
    validKey(key);
    const row = await this.store.get("FLAGS", key);
    return row ? ({ ...row.data, version: row.version } as Flag) : undefined;
  }
  /** Create with version:null or update with the current revision; audit the actor and reject stale writes. */
  async save(
    key: string,
    definition: FlagDefinition,
    version: number | null,
    actorId: string,
  ): Promise<Flag> {
    validKey(key);
    if (
      typeof definition.description !== "string" ||
      definition.description.length > 400 ||
      typeof definition.enabled !== "boolean" ||
      typeof definition.public !== "boolean" ||
      !Number.isFinite(definition.rollout) ||
      definition.rollout < 0 ||
      definition.rollout > 100 ||
      !Array.isArray(definition.subjects) ||
      definition.subjects.length > 100 ||
      definition.subjects.some(
        (s) => typeof s !== "string" || s.length > 120,
      ) ||
      !(version === null || (Number.isSafeInteger(version) && version > 0))
    )
      throw new HttpError(400, "Invalid flag configuration");
    const data = {
      key,
      description: definition.description,
      enabled: definition.enabled,
      public: definition.public,
      rollout: definition.rollout,
      subjects: [...new Set(definition.subjects)],
      updatedAt: new Date().toISOString(),
      updatedBy: actorId,
    };
    const next = (version ?? 0) + 1;
    await this.store.transact([
      { row: { pk: "FLAGS", sk: key, version: next, data }, expected: version },
    ]);
    return { ...data, version: next };
  }
  /** Unknown/disabled flags fail closed. Public evaluation never reveals targeting rules. */
  async enabled(
    key: string,
    subject = "",
    publicOnly = false,
  ): Promise<boolean> {
    if (typeof subject !== "string" || subject.length > 120)
      throw new HttpError(400, "Invalid flag subject");
    const flag = await this.get(key);
    if (!flag?.enabled || (publicOnly && !flag.public)) return false;
    if (subject && flag.subjects.includes(subject)) return true;
    if (flag.rollout === 100) return true;
    if (!subject || flag.rollout === 0) return false;
    const bucket =
      (createHash("sha256")
        .update(key + "\0" + subject)
        .digest()
        .readUInt32BE(0) /
        0x100000000) *
      100;
    return bucket < flag.rollout;
  }
  /** Expose owner-only editing and a public boolean evaluator; no private rules leave that evaluator. */
  feature(): Feature {
    return {
      id: "feature-flags",
      migrations: [],
      admin: {
        id: "feature-flags",
        title: "Feature flags",
        resource: "flags.manage",
        path: "/feature-flags",
        component: "feature-flags",
        ownerOnly: true,
        fields: [],
        actions: [],
      },
      endpoints: [
        {
          method: "GET",
          path: "/feature-flags",
          resource: "flags.manage",
          access: "owner",
          handle: (c) => this.list(c.request.query.cursor),
        },
        {
          method: "PUT",
          path: "/feature-flags/:key",
          resource: "flags.manage",
          access: "owner",
          tool: {
            name: "flags_save",
            description:
              "Create or update a boolean flag. Pass version:null for creation; use the current version to update. Flags do not grant permissions.",
            example: {
              params: { key: "new-checkout" },
              body: {
                version: null,
                enabled: false,
                public: true,
                rollout: 100,
                subjects: [],
                description: "New checkout UI",
              },
            },
          },
          handle: (c) =>
            this.save(
              c.params.key,
              c.request.body as FlagDefinition,
              c.request.body.version,
              c.actor!.id,
            ),
        },
        {
          method: "POST",
          path: "/feature-flags/evaluate",
          resource: "flags.evaluate",
          access: "guest",
          handle: async (c) => {
            const { keys, subject = "" } = c.request.body;
            if (
              !Array.isArray(keys) ||
              keys.length > 20 ||
              keys.some((k) => typeof k !== "string")
            )
              throw new HttpError(400, "Provide up to 20 flag keys");
            const values = await Promise.all(
              keys.map(async (key) => [
                key,
                await this.enabled(key, subject, true),
              ]),
            );
            return Object.fromEntries(values);
          },
        },
      ],
    };
  }
}
