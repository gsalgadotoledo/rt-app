# RT-App core: module and agent conventions

## Structure
- packages/contracts defines Feature, Endpoint, Context, Actor, AdminManifest and ToolExposure.
- A Feature declares id, endpoints, migrations and optional admin metadata. Module classes receive adapters through constructors; do not create a parallel runtime or require inheritance.
- packages/nosql defines the storage interface; JsonStore and DynamoDB adapters implement it. Module migrations belong to their package.
- core-ts exports createRTApp and RTAppManager for the component registry. RTAppModule requires init and optionally dispose; RTAppBaseModule is an optional abstract lifecycle base. RTAppModuleConfig declares dependsOn, bindings and preload. RTAppComponentModule.create creates per-view instances with dispose. Domain Feature modules use composition and do not have to extend this base. core-go and core-python follow their language's native composition conventions. Inspect their exported interfaces before adding providers.
- admin hosts shared React UI. cli hosts command adapters. Application configuration stays in main.js and rt-app.settings.json.

## HTTP, CLI and MCP
Declare endpoint.tool = {name, description, example} on an owner/permission endpoint to opt in. Names use module_action, for example subscriptions_plan_history. Describe required fields, pagination, revisions, idempotency keys and external side effects. Example uses {params,query,body}.

Enabled modules register automatically in GET /admin/tools. The catalog is owner-only. rta module list discovers it; rta module NAME '@input.json' calls the existing HTTP route. apps/mcp uses the same catalog over MCP stdio. Restart MCP after changing enabled modules. Never expose arbitrary class methods or infer public tools from endpoint names.

CLI/MCP require the running API. RT_APP_API_URL overrides the project's local API port; RT_APP_ADMIN_TOKEN authenticates remote admin calls. Remote URLs require HTTPS. Do not bypass the route ACL or create a second JSON database writer. Never print tokens. Keep stdout exclusively for MCP protocol; diagnostics go to stderr.

Subscriptions expose settings, plan creation/update/archive/unarchive/version/history/restore/publication, account lookup/grants/resets, local simulation and maintenance. Products are entries in plan.products. Read settings first and pass its version on edits. Stripe publication is a separate explicit action. Keep monetary values in integer minor units and preserve history.

## Readability
Separate methods/functions with a blank line. Add a short purpose comment to public operations and section comments for distinct responsibilities. Use multiline declarations for complex settings and handlers. Explain transactional boundaries and side effects. Avoid duplicated business logic in entry points, decorative comments and compressed multi-operation lines.

## Verification
Test catalog uniqueness, authorization and mutation validation. Test CLI and MCP against the same APIs; do not hit real billing/email/cloud services in automated tests. Keep tests in the owning package. Shared UI uses theme tokens, modest field gaps, semibold labels and muted help text.

## Publication example
```ts
// Inside feature().endpoints: add metadata to the existing, authorized handler.
{
  method: "GET", path: "/inventory/:id", resource: "inventory.read", access: "permission",
  tool: {
    name: "inventory_read",
    description: "Read an inventory record. params.id is required.",
    example: {params: {id: "item-123"}},
  },
  handle: context => this.read(context.params.id),
}
```
No separate CLI/MCP registration is necessary. Use the same service method and validation as the HTTP endpoint. Only the admin route copy is published. Add action-level tests before exposing mutations.
