import type { NoSQL as Store } from "@gsalgadotoledo/rt-app-nosql";
import {
  type Feature,
  HttpError,
  Conflict,
  text,
  schemaMigration,
} from "@gsalgadotoledo/rt-app-contracts";
export const defaultHome = {
  title: "Welcome to RT-App",
  content: "A small starting point for building great applications.",
};
export function contentFeature(store: Store): Feature {
  const settings = async () => {
    const row = await store.get("CONTENT", "home");
    return {
      version: row?.version ?? 0,
      values: row?.data ?? defaultHome,
      fields: [
        { name: "title", label: "Title", type: "text", maxLength: 120 },
        {
          name: "content",
          label: "Description",
          type: "textarea",
          maxLength: 2000,
        },
      ],
    };
  };
  return {
    id: "content",
    migrations: [schemaMigration("content")],
    admin: {
      id: "content",
      group: "content",
      title: "Home",
      resource: "content.read",
      path: "/content/settings",
      component: "content",
      fields: [],
      actions: [],
      settings: { path: "/content/settings", resource: "content.write" },
    },
    endpoints: [
      {
        method: "GET",
        path: "/",
        resource: "content.home",
        access: "guest",
        handle: async () => {
          const s = await settings();
          return { title: s.values.title, content: s.values.content };
        },
      },
      {
        method: "GET",
        path: "/content/settings",
        resource: "content.read",
        access: "permission",
        handle: settings,
      },
      {
        method: "PUT",
        path: "/content/settings",
        resource: "content.write",
        access: "permission",
        handle: async (c) => {
          const row = await store.get("CONTENT", "home"),
            body = c.request.body;
          if (!Number.isInteger(body.version))
            throw new HttpError(400, "Version is required");
          if (body.version !== (row?.version ?? 0)) throw new Conflict();
          const values = {
            title: text(body.values?.title, "title", 120),
            content: text(body.values?.content, "content", 2000),
          };
          await store.transact([
            {
              row: {
                pk: "CONTENT",
                sk: "home",
                version: body.version + 1,
                data: values,
              },
              expected: row?.version ?? null,
            },
          ]);
          return settings();
        },
      },
    ],
  };
}
