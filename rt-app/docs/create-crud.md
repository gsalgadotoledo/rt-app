# Create a CRUD module

Run from the application root:

```sh
npm exec -- rta create crud products \
  --title "Products" \
  --fields "name:string,price:number,active:boolean,notes:string?" \
  --actions publish,archive \
  --json
npm install --ignore-scripts
npm run dev
```

The command is a local CLI tool for humans and agents, discoverable with `rta tools --json`. It generates source; it does not require an LLM API key, run a model, apply Terraform, or deploy. Its compact JSON response gives the package path, permissions, edit points, and next commands. Use `--dry-run` to preview without writing. A repeated name fails instead of overwriting your changes.

## Specification

Without `--fields`, the default is `name:string`. Supported scalar types are string, number and boolean. Fields are required unless suffixed with `?`. Names use kebab-case for modules/actions and camelCase for fields. No code is evaluated from names or labels.

For an agent or a larger schema, use `rta create crud --spec ./products.json --json`:

```json
{
  "name": "products",
  "title": "Products",
  "fields": [
    {"name": "name", "type": "string", "required": true},
    {"name": "price", "type": "number", "required": true},
    {"name": "active", "type": "boolean", "required": true}
  ],
  "actions": ["publish", "archive"]
}
```

`id`, `version`, `createdAt` and `updatedAt` are managed metadata. The generator refuses duplicate/reserved fields, path traversal, overwrites and edited generated registries. Do not invoke it while another process is editing registration files. If a process is killed mid-generation, inspect partial files and the `.rt-app-crud.lock` before retrying; the multi-file operation is not crash-atomic.

## Generated application code

`packages/products/` contains its own backend, field schema, search implementation, custom-action handlers, React admin UI, README and colocated tests. Backend JavaScript is native ESM; admin UI is TSX. The files are copied from `rt-app/cli/templates/crud/`, and subsequent changes belong to your application. Edit those files directly; do not regenerate to change an existing module.

The command also updates `modules.json`, `packages/index.js` and `packages/admin.js`. The registries contain static imports, not runtime discovery. Keep the two generated registries intact. Local server, Lambda, migrations and installer use the same module factories with the selected database. The admin shell loads the application UI registry through Vite (`RT_APP_PROJECT_ROOT` can specify another application root); core does not depend on your module.

After generating, install workspace links and commit the resulting lockfile along with the source. Restart local processes. For cloud, deploy through the existing build/migration pipeline.

## API and permissions

| Operation | Endpoint | Required grant |
| --- | --- | --- |
| List/search | `GET /products` | `products.list` |
| Detail | `GET /products/:id` | `products.read` |
| Create | `POST /products` | `products.create` |
| Edit | `PATCH /products/:id` | `products.edit` |
| Delete | `DELETE /products/:id` | `products.delete` |
| Custom action | `POST /products/:id/actions/publish` | `products.publish` |

Every application endpoint requires an explicit grant, even for application owners. New users receive none. Admin root is a separate principal and can manage data and assign permissions in **Usuarios → user → Permisos por recurso**. The generated module appears in the admin sidebar. Its admin routes live below `/admin/app/products` and accept admin sessions only.

Permissions are independent: grant list/read as well as edit when a user needs an editor. Records are module-wide: this template is not tenant-isolated or per-owner. Add row-level restrictions before using it for private multi-tenant data. All schema fields are readable by a user with list/read permission; do not add secrets without safe response projections.

PATCH, DELETE and custom actions require `version` from the last read in the JSON body. A stale version returns 409. Unknown fields and invalid types return 400. The database also enforces conditional writes, so concurrent modifications are not silently overwritten.

Custom actions have individual permissions and buttons but deliberately return 501 until implemented in `src/actions.js`. Implement domain validation and use `store.transact` with `expected: row.version` for mutations; external side effects may additionally require the idempotency module.

## Search, pagination and storage

The admin has a list/detail layout, create/edit/delete controls, global text search, combined filters, numeric ranges and next/previous pagination. Example:

```text
GET /products?q=keyboard&price__gte=10&price__lte=100&active=true
GET /products?name__contains=board
GET /products?name=Keyboard
```

Filters combine with AND; global text searches fields with OR. Search accepts only declared fields plus id. It uses bounded partition queries (up to 10 storage pages), preserving an opaque continuation cursor even when a result page is empty. Changing filters restarts pagination. This is not indexed full-text search or an arbitrary SQL query engine. Large collections need explicit access patterns and DynamoDB indexes.

AWS uses the existing DynamoDB application table under a separate `CRUD#products` partition. Local development uses JSON by default, with the same API and migrations; no AWS keys are required. No additional table or Terraform resource is created by scaffolding. Initial field types are scalar, without file uploads, relations, unique-field indexes or relational master/detail children. The master/detail UI means selecting a list record to edit its detail.
