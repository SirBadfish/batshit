import assert from 'node:assert/strict';
import test from 'node:test';

import { settleShutdownPreparations } from './shutdown-lifecycle.mjs';

test('shutdown preparation is bounded and one failed window cannot block runtime teardown', async () => {
  const failures = [];
  let completed = false;
  const results = await settleShutdownPreparations([
    {
      name: 'Desktop Goon',
      run: () => new Promise(() => {})
    },
    {
      name: 'Desktop Controls',
      run: async () => { completed = true; }
    }
  ], {
    timeoutMs: 10,
    onFailure: (name, error) => failures.push([name, error.message])
  });

  assert.equal(completed, true);
  assert.equal(results[0].status, 'rejected');
  assert.equal(results[1].status, 'fulfilled');
  assert.deepEqual(failures, [[
    'Desktop Goon',
    'Desktop Goon shutdown preparation timed out after 10ms.'
  ]]);
});

test('shutdown preparation validates its bounded contract', async () => {
  await assert.rejects(
    () => settleShutdownPreparations([{ name: 'bad' }]),
    /named functions/
  );
  await assert.rejects(
    () => settleShutdownPreparations([], { timeoutMs: 0 }),
    /between 1 and 60000/
  );
});
