import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveOverallStatus } from '../src/store.ts';

test('deriveOverallStatus handles all combinations', () => {
  assert.equal(deriveOverallStatus(true, true, 'http'), 'UP');
  assert.equal(deriveOverallStatus(true, false, 'http'), 'DEGRADED');
  assert.equal(deriveOverallStatus(false, true, 'http'), 'DEGRADED');
  assert.equal(deriveOverallStatus(false, false, 'http'), 'DOWN');
  assert.equal(deriveOverallStatus(false, true, 'tcp'), 'UP');
  assert.equal(deriveOverallStatus(true, false, 'tcp'), 'DOWN');
});
