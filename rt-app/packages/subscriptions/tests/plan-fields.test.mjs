import test from 'node:test';
import assert from 'node:assert/strict';
import {planIdFromName} from '../dist/plan-id.js';
import {currencyCodes,currencyDecimals,majorAmount,validCurrency,validMinorAmount} from '../dist/currency.js';
test('name-derived IDs normalize accents, stay bounded and avoid collisions',()=>{
 assert.equal(planIdFromName('Plan Élite +'), 'plan-elite');
 assert.equal(planIdFromName('Team Plus',['team-plus','team-plus-2']),'team-plus-3');
 assert.equal(planIdFromName('!!!'),'new-plan');
 assert.ok(planIdFromName('a'.repeat(500)).length<=100);
});
test('currency catalog and minor units cover zero, two and three decimal currencies',()=>{
 assert.ok(currencyCodes.length>140);assert.equal(validCurrency('jpy'),true);assert.equal(validCurrency('fake'),false);
 assert.equal(majorAmount(500000,'cop'),5000);assert.equal(currencyDecimals('cop'),2);
 assert.equal(majorAmount(2000,'usd'),20);assert.equal(majorAmount(2000,'jpy'),2000);
 assert.equal(currencyDecimals('kwd'),3);assert.equal(majorAmount(1000,'kwd'),1);
 assert.equal(majorAmount(500,'isk'),5);assert.equal(validMinorAmount(501,'isk'),false);
 assert.equal(currencyDecimals('mga'),0);
});
