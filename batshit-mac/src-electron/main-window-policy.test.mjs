import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveMainWindowSizePolicy } from './main-window-policy.mjs';

test('main window preserves the narrow chat column between both persistent rails', () => {
  const policy = resolveMainWindowSizePolicy();

  assert.deepEqual(policy, {
    width: 1600,
    height: 1000,
    minWidth: 576,
    minHeight: 720
  });
  assert.equal(policy.minWidth - 48 - 48, 480);
});
