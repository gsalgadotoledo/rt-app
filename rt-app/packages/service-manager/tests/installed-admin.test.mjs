import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { manifestFixture } from './manifest-fixture.mjs';
import { manifest } from '../client.mjs';

test('an installed admin is launched through the core CLI without a copied workspace', async t => {
  const root = await manifestFixture(t);
  const path = join(root, 'package.json');
  const pkg = JSON.parse(await readFile(path, 'utf8'));
  pkg.rtApp.admin = '@gsalgadotoledo/rt-app-myadmin';
  await writeFile(path, JSON.stringify(pkg));
  const result = await manifest(root, {noBuild:true, noMail:true});
  const admin = result.services.find(service => service.id === 'admin');
  assert.equal(admin.command[2], 'admin');
  assert.ok(isAbsolute(admin.command[1]));
  assert.deepEqual(admin.dependencies, ['api']);
});
