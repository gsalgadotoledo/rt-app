import type { NoSQL as Store } from "@gsalgadotoledo/rt-app-nosql";
import { migrations } from "./migrations.js";
import { seeds, DEMO_USERS } from "./seeds.js";
export { DEMO_USERS };
import admin from "./admin.json" with { type: "json" };
import {
  randomUUID,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import {
  auditCreate, auditUpdate, auditDelete, auditRestore,
  type Row,
  type Feature,
  type Data,
  HttpError,
  text,
  emailAddress,
  viewUser,
  searchPage,
  schemaMigration,
} from "@gsalgadotoledo/rt-app-contracts";
const scrypt = (password: string, salt: string) =>
  new Promise<Buffer>((resolve, reject) => {
    scryptCallback(
      password,
      salt,
      64,
      { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 },
      (error, key) => (error ? reject(error) : resolve(key)),
    );
  });
export function validatePassword(password: unknown): asserts password is string {
  if (
    typeof password !== "string" ||
    password.length < 12 ||
    password.length > 128
  )
    throw new HttpError(
      400,
      "The password must contain 12 to 128 characters",
    );
}
export async function hashPassword(password: unknown) {
  validatePassword(password);
  const salt = randomBytes(16).toString("hex");
  const hash = (await scrypt(password, salt)) as Buffer;
  return `scrypt$${salt}$${hash.toString("hex")}`;
}
export async function verifyPassword(password: unknown, stored: string) {
  if (typeof password !== "string" || password.length > 128) return false;
  const [, salt, encoded] = stored.split("$");
  const hash = (await scrypt(password, salt)) as Buffer;
  const expected = Buffer.from(encoded, "hex");
  return expected.length === hash.length && timingSafeEqual(hash, expected);
}
export interface CredentialProvider {
  readonly id: string;
  provision(id: string, email: string, password: string): Promise<void>;
  disable(id: string): Promise<void>;
  enable?(id: string): Promise<void>;
}
export class Users {
  constructor(public store: Store, private credentials?: CredentialProvider) {}
  get(id: string) {
    return this.store.get("USERS", id);
  }
  async byEmail(email: string) {
    const index = await this.store.get("EMAIL", email);
    return index ? this.get(index.data.id) : undefined;
  }
  /** Demo identities that exist in this store, in declaration order. */
  async demoUsers() {
    const rows = await Promise.all(DEMO_USERS.map((user) => this.byEmail(user.email)));
    return rows.filter((row): row is Row => Boolean(row));
  }

  async bootstrapOwner(input: Data) {
    if ((await this.store.list("USERS")).items.length)
      throw new HttpError(409, "The application already has users");
    return this.insert(input, "owner", true);
  }
  async create(input: Data, role: "owner" | "admin" | "user" = "user", actor: string | null = null) {
    return this.insert(input, role, false, actor);
  }
  private async insert(
    input: Data,
    role: "owner" | "admin" | "user",
    bootstrap: boolean,
    actor: string | null = null,
  ) {
    const email = emailAddress(input.email), name = text(input.name, "name");
    validatePassword(input.password);
    // Reserve the local identity before calling a remote provider. A partial account
    // is inactive and can be retried by the administrator using the same email.
    if (this.credentials) {
      const existing = await this.byEmail(email);
      if (existing?.data.provisioning && !existing.data.deletedAt && existing.data.credentialProvider === this.credentials.id) {
        await this.credentials.provision(existing.data.id, email, input.password);
        const next = {...existing, version: existing.version + 1, data:{...existing.data, active:true, provisioning:false}};
        await this.store.transact([{row:next,expected:existing.version}]);
        return next;
      }
    }
    const passwordHash = this.credentials ? undefined : await hashPassword(input.password), id = randomUUID();
    const row: Row = {
      pk: "USERS",
      sk: id,
      version: 1,
      data: {
        id,
        email,
        name,
        ...(passwordHash ? {passwordHash} : {}),
        ...(this.credentials ? {credentialProvider:this.credentials.id, provisioning:true} : {}),
        role,
        grants: [],
        active: !this.credentials,
        tokenVersion: 1,
        ...auditCreate(actor ?? id),
      },
    };
    await this.store.transact([
      ...(bootstrap
        ? [
            {
              row: {
                pk: "INSTALLATION",
                sk: "owner",
                version: 1,
                data: { id },
              },
              expected: null,
            },
          ]
        : []),
      { row, expected: null },
      {
        row: { pk: "EMAIL", sk: email, version: 1, data: { id } },
        expected: null,
      },
    ]);
    if (this.credentials) {
      await this.credentials.provision(id, email, input.password);
      const next = {...row,version:2,data:{...row.data,active:true,provisioning:false}};
      await this.store.transact([{row:next,expected:1}]);
      return next;
    }
    return row;
  }
  async profile(id: string, input: Data, actor = id) {
    const row = await this.get(id);
    if (!row || row.data.deletedAt) throw new HttpError(404, "User not found");
    // Email changes require a separate verified-email flow; never bypass it via profile.
    if (Object.keys(input).some((k) => k !== "name"))
      throw new HttpError(
        400,
        "Only name can be edited; email requires verification",
      );
    const next = {
      ...row,
      version: row.version + 1,
      data: { ...row.data, name: text(input.name, "name"), ...auditUpdate(actor) },
    };
    await this.store.transact([{ row: next, expected: row.version }]);
    return viewUser(next.data);
  }
  feature(): Feature {
    return {
      id: "users",
      migrations,
      seeds: seeds(this),
      admin: admin,
      endpoints: [
        {
          method: "GET",
          path: "/users/me",
          resource: "users.me.read",
          access: "authenticated",
          handle: async (c) => viewUser(c.actor!),
        },
        {
          method: "PATCH",
          path: "/users/me",
          resource: "users.me.edit",
          access: "authenticated",
          handle: async (c) => this.profile(c.actor!.id, c.request.body),
        },
        {
          method: "GET",
          path: "/users",
          resource: "users.list",
          access: "permission",
          handle: async (c) => {
            return searchPage(
              this.store,
              "USERS",
              c.request.query,
              ["id", "email", "name", "role", "active"],
              (row) => viewUser(row.data),
            );
          },
        },
        {
          method: "POST",
          path: "/users",
          resource: "users.create",
          access: "permission",
          handle: async (c) =>
            viewUser((await this.create(c.request.body, "user", c.actor!.id)).data),
        },
        {
          method: "GET",
          path: "/users/:id",
          resource: "users.read",
          access: "permission",
          handle: async (c) => {
            const row = await this.get(c.params.id);
            if (!row || row.data.deletedAt) throw new HttpError(404, "User not found");
            return viewUser(row.data);
          },
        },
        {
          method: "PATCH",
          path: "/users/:id",
          resource: "users.edit",
          access: "permission",
          handle: async (c) => {
            const row = await this.get(c.params.id);
            if (row?.data.role === "owner" && c.actor!.role !== "owner")
              throw new HttpError(403, "Owner role required");
            return this.profile(c.params.id, c.request.body, c.actor!.id);
          },
        },
        {
          method: "POST", path: "/users/:id/restore", resource: "users.restore", access: "permission",
          handle: async c => {
            const row=await this.get(c.params.id);
            if(!row?.data.deletedAt)throw new HttpError(404,"Deleted user not found");
            if(this.credentials&&!this.credentials.enable)throw new HttpError(409,"This identity provider does not support restoration");
            // Enable the provider first; the local tombstone continues to reject login until committed.
            if(this.credentials)await this.credentials.enable!(row.data.id);
            const next={...row,version:row.version+1,data:{...row.data,...auditRestore(c.actor!.id),active:!row.data.provisioning,tokenVersion:row.data.tokenVersion+1}};
            await this.store.transact([{row:next,expected:row.version}]);return viewUser(next.data);
          },
        },
        {
          method: "DELETE",
          path: "/users/:id",
          resource: "users.delete",
          access: "permission",
          handle: async (c) => {
            const row = await this.get(c.params.id);
            if (!row || row.data.deletedAt) throw new HttpError(404, "User not found");
            if (row.data.role === "owner" || row.data.id === c.actor!.id)
              throw new HttpError(403, "You cannot deactivate this account");
            await this.store.transact([
              {
                row: {
                  ...row,
                  version: row.version + 1,
                  data: {
                    ...row.data,
                    ...auditDelete(c.actor!.id),
                    active: false,
                    tokenVersion: row.data.tokenVersion + 1,
                  },
                },
                expected: row.version,
              },
            ]);
            if(this.credentials) await this.credentials.disable(row.data.id);
            return { ok: true };
          },
        },
      ],
    };
  }
}
