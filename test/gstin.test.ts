import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gstinCheckChar, gstinProblem } from '../src/core/gstin.ts';

test('GSTIN: format, check digit and state code are checked', () => {
  // published examples with valid check digits
  for (const g of ['27AAPFU0939F1ZV', '29AAGCB7383J1Z4']) assert.equal(gstinProblem(g), null, g);
  assert.equal(gstinCheckChar('27AAPFU0939F1Z'), 'V');
  assert.match(gstinProblem('27AAPFU0939F1ZW')!, /check digit/);
  assert.match(gstinProblem('27AAPFU0939F1Z')!, /15 characters/);
  assert.match(gstinProblem('27aapfu0939f1zv')!, /capital letters/);
  assert.match(gstinProblem('99AAPFU0939F1ZV')!, /state code/);
  assert.match(gstinProblem('2AAAPFU0939F1ZV')!, /format/);
});
