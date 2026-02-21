import assert from 'node:assert/strict';
import test from 'node:test';
import { inferBackendKindForPort } from '../src/discovery.ts';

test('known datastore ports default to tcp backend', () => {
  assert.equal(inferBackendKindForPort(3306), 'tcp');
  assert.equal(inferBackendKindForPort(3307), 'tcp');
  assert.equal(inferBackendKindForPort(6379), 'tcp');
  assert.equal(inferBackendKindForPort(8080), 'http');
});
