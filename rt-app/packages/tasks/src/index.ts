import type { NoSQL as Store } from "@gsalgadotoledo/rt-app-nosql";
import { migrations } from "./migrations.js";
import { seeds } from "./seeds.js";
import admin from "./admin.json" with { type: "json" };
import { randomUUID } from "node:crypto";
import {
  auditCreate, auditUpdate, auditDelete, auditRestore,
  type Data, type Feature,
  type Context,
  HttpError,
  text,
  searchPage,
  schemaMigration,
} from "@gsalgadotoledo/rt-app-contracts";
export function tasksFeature(store: Store): Feature {
  async function list(c: Context, all: boolean) {
    return searchPage(store,'TASKS',c.request.query,['id','title','done','ownerId'],row=>all||row.data.ownerId===c.actor!.id?row.data:undefined);
  }

  async function edit(c: Context, remove: boolean, restore = false) {
    const row = await store.get("TASKS", c.params.id);
    if (!row || (restore ? !row.data.deletedAt : row.data.deletedAt)) throw new HttpError(404, "Task not found");
    if (
      row.data.ownerId !== c.actor!.id &&
      c.actor!.role !== "owner" &&
      !c.actor!.grants.includes("tasks.manage")
    )
      throw new HttpError(403, "This task belongs to another user");
    const data: Data = { ...row.data, ...(restore ? auditRestore(c.actor!.id) : remove ? auditDelete(c.actor!.id) : auditUpdate(c.actor!.id)) };
    if (!remove && !restore) {
      if (c.request.body.title !== undefined)
        data.title = text(c.request.body.title, "title");
      if (c.request.body.done !== undefined) {
        if (typeof c.request.body.done !== "boolean")
          throw new HttpError(400, "done must be a boolean");
        data.done = c.request.body.done;
      }
    }
    await store.transact([
      {
        row: { ...row, version: row.version + 1, data },
        expected: row.version,

      },
    ]);
    return remove ? { ok: true } : data;
  }
  return {
    id: "tasks",
    migrations,
    seeds,
    admin: admin,
    endpoints: [
      {method:"POST",path:"/tasks/:id/restore",resource:"tasks.restore",access:"authenticated",handle:c=>edit(c,false,true)},
      {method:"POST",path:"/tasks/admin/:id/restore",resource:"tasks.restore",access:"permission",handle:c=>edit(c,false,true)},

      {
        method: "GET",
        path: "/tasks",
        resource: "tasks.mine",
        access: "authenticated",
        handle: (c) => list(c, false),
      },
      {
        method: "GET",
        path: "/tasks/admin",
        resource: "tasks.list",
        access: "permission",
        handle: (c) => list(c, true),
      },
      {
        method: "POST",
        path: "/tasks",
        resource: "tasks.create",
        access: "authenticated",
        handle: async (c) => {
          const id = randomUUID(),
            data = {
              id,
              title: text(c.request.body.title, "title"),
              done: false,
              ownerId: c.actor!.id,
              ...auditCreate(c.actor!.id),
            };
          await store.transact([
            { row: { pk: "TASKS", sk: id, version: 1, data }, expected: null },
          ]);
          return data;
        },
      },
      {
        method: "PATCH",
        path: "/tasks/:id",
        resource: "tasks.edit",
        access: "authenticated",
        handle: (c) => edit(c, false),
      },
      {
        method: "DELETE",
        path: "/tasks/:id",
        resource: "tasks.delete",
        access: "authenticated",
        handle: (c) => edit(c, true),
      },
      {
        method: "PATCH",
        path: "/tasks/admin/:id",
        resource: "tasks.manage",
        access: "permission",
        handle: (c) => edit(c, false),
      },
      {
        method: "DELETE",
        path: "/tasks/admin/:id",
        resource: "tasks.remove",
        access: "permission",
        handle: async (c) => {
          if (
            c.actor!.role !== "owner" &&
            !c.actor!.grants.includes("tasks.manage")
          )
            throw new HttpError(403, "Requires tasks.manage");
          return edit(c, true);
        },
      },
    ],
  };
}
