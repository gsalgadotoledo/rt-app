import test from 'node:test';import assert from 'node:assert/strict';import {DynamoCache} from '../dist/index.js';import {NoSQLCache} from '@gsalgadotoledo/rt-app-cache-nosql';
test('Dynamo adapter requires a table and uses the tested NoSQL cache contract',()=>{assert.throws(()=>new DynamoCache(''),/TABLE_NAME/);assert.ok(new DynamoCache('test',{region:'us-east-1'}) instanceof NoSQLCache);});
