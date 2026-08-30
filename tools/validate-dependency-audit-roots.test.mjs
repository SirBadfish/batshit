import assert from 'node:assert/strict';
import test from 'node:test';

import { validateDependencyAuditRoots } from './validate-dependency-audit-roots.mjs';

test('every declared public dependency-audit root has a lockfile', async () => {
  assert.deepEqual(await validateDependencyAuditRoots(), [
    'batshit-app',
    'batshit-server/server',
    'batshit-mac',
    'batshit-mac/frontend',
    'tools/livekit-agent-sidecar'
  ]);
});
