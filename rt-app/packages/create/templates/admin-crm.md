---
id: admin-crm
name: Admin CRM
description: Contacts and opportunities managed in the admin, with explicit permissions.
kind: fullstack
requirements: [node]
crud:
  - name: contacts
    title: Contacts
    fields: { name: string, email: string, company: string?, phone: string? }
  - name: opportunities
    title: Opportunities
    fields: { title: string, value: number, stage: string, contactId: string? }
    actions: [win, lose]
---
# Admin CRM

The base project plus `packages/contacts` and `packages/opportunities` (admin UI, migrations, faker seeds). Access is denied until an owner grants `contacts.*` / `opportunities.*` permissions.

## What to build

1. **Pipeline:** stages are a fixed list (`lead`, `qualified`, `proposal`, `won`, `lost`). Validate `stage` against it in the module and add a migration that backfills existing records.
2. **Actions:** implement `win` and `lose` in `packages/opportunities/src/actions.js` (they currently answer 501). Use conditional writes with `row.version`.
3. **Relations:** an opportunity may reference a contact; validate the contact exists and show its name in the admin.
4. **Dashboard:** an admin page with the pipeline value per stage (integers in minor units).
5. **Team:** sales users get explicit grants; they only see what they are granted.

## Done when

Owners manage the whole CRM, sales users work only with granted resources, actions are tested, and `rta seed` produces a believable pipeline.
