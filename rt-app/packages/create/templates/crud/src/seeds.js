import { auditCreate } from '@gsalgadotoledo/rt-app-contracts';
import schema from './schema.json' with {type:'json'};

// Example data for this module, applied with `rta seed` (local, develop and stage; never prod).
// Seeds must be idempotent: ensureRows only inserts missing records. Bump `version` to apply a changed seed.
const COUNT = 12;

/** Example value per field type; faker is seeded from the seed id, so data is the same everywhere. */
function example(faker, field, index) {
  if (field.type === 'number') return faker.number.int({ min: 1, max: 1000 });
  if (field.type === 'boolean') return faker.datatype.boolean();
  if (['name', 'title'].includes(field.name)) return faker.commerce.productName() + ' ' + (index + 1);
  if (field.name === 'email') return faker.internet.email().toLowerCase();
  return faker.lorem.sentence({ min: 3, max: 8 });
}

export const seeds = [
  {
    id: schema.name + ':examples',
    description: COUNT + ' example ' + schema.title.toLowerCase(),
    version: '1',
    environments: ['local', 'develop', 'stage'],
    run: async ({ ensureRows, faker }) => {
      const f = await faker();
      await ensureRows(Array.from({ length: COUNT }, (_, index) => {
        const id = 'example-' + String(index + 1).padStart(3, '0');
        const values = Object.fromEntries(schema.fields.map(field => [field.name, example(f, field, index)]));
        return { pk: 'CRUD#' + schema.name, sk: id, data: { ...values, id, ...auditCreate('seed') } };
      }));
    },
  },
];
