import test from 'node:test';
import assert from 'node:assert/strict';
import { AwsInfraDriver } from '@gsalgadotoledo/rt-app-aws';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { STSClient } from '@aws-sdk/client-sts';
import { SQSClient } from '@aws-sdk/client-sqs';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';

test('AWS vault uses a fixed secret version; cloud commands carry constrained specifications', async t => {
  const secret = { accessKeyId: 'A'.repeat(20), secretAccessKey: 's'.repeat(40) };
  const vault = [];
  t.mock.method(SecretsManagerClient.prototype, 'send', async command => {
    vault.push(command.input);
    return command.constructor.name === 'PutSecretValueCommand'
      ? { VersionId: 'immutable-version' } : { SecretString: JSON.stringify(secret) };
  });
  t.mock.method(STSClient.prototype, 'send', async function () {
    assert.equal((await this.config.credentials()).accessKeyId, secret.accessKeyId);
    return { Account: '123', Arn: 'arn:aws:iam::123:user/test' };
  });
  const driver = new AwsInfraDriver('arn:test:vault');
  assert.equal(await driver.saveCredentials(secret), 'immutable-version');
  const settings = { mode: 'keys', region: 'us-east-1', secretVersion: 'immutable-version' };
  assert.equal((await driver.identity(settings)).account, '123');
  assert.equal(vault[1].VersionId, 'immutable-version');
  assert.equal(vault[1].SecretId, 'arn:test:vault');
  let queue;
  t.mock.method(SQSClient.prototype, 'send', async command => {
    if (command.constructor.name === 'GetQueueUrlCommand')
      throw Object.assign(new Error('absent'), { name: 'QueueDoesNotExist' });
    queue = command.input;
    return { QueueUrl: 'https://sqs.test/queue' };
  });
  await driver.create(settings, { kind: 'queue', name: 'rt-app-test' }, 'plan-1');
  assert.equal(queue.tags['rt-app:plan'], 'plan-1');
  assert.equal(queue.Attributes.SqsManagedSseEnabled, 'true');
  let table;
  t.mock.method(DynamoDBClient.prototype, 'send', async command => {
    table = command.input;
    return { TableDescription: { TableArn: 'arn:test:table', TableStatus: 'CREATING' } };
  });
  assert.equal((await driver.create(settings, { kind: 'table', name: 'rt-app-table' }, 'plan-2')).status, 'CREATING');
  assert.equal(table.BillingMode, 'PAY_PER_REQUEST');
  assert.deepEqual(table.KeySchema.map(k => k.AttributeName), ['pk', 'sk']);
});

test('AWS adapter refuses root identities and existing queues without mutating them', async t => {
  const driver = new AwsInfraDriver();
  const settings = { mode: 'role', region: 'us-east-1' };
  t.mock.method(STSClient.prototype, 'send', async () => ({ Account: '123', Arn: 'arn:aws:iam::123:root' }));
  await assert.rejects(driver.identity(settings), e => e.status === 400);
  const commands = [];
  t.mock.method(SQSClient.prototype, 'send', async c => { commands.push(c.constructor.name); return { QueueUrl: 'exists' }; });
  await assert.rejects(driver.create(settings, { kind: 'queue', name: 'rt-app-existing' }, 'id'), e => e.status === 409);
  assert.deepEqual(commands, ['GetQueueUrlCommand']);
});
