import { schemaMigration } from '@gsalgadotoledo/rt-app-contracts';
import schema from './schema.json' with {type:'json'};

// Migrations of this module, tracked in git and applied with `rta migrate up`.
// Append new entries with the next id (<module>:002, :003…). Never edit, reorder or delete an applied one:
// its checksum is recorded and a change stops the deployment. Write through ctx.store so the same step
// runs on DynamoDB (AWS), JSON and memory. Add `down` when the change can be reverted.
//
// Example:
// {
//   id: schema.name + ':002',
//   checksum: schema.name + '-default-status-v1',
//   description: 'Backfill status=draft',
//   up: async ({ store }) => { /* list 'CRUD#' + schema.name and transact each row with expected: row.version */ },
// },
export const migrations = [
  schemaMigration(schema.name),
];
