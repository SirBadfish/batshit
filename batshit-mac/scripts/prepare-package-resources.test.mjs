import assert from 'node:assert/strict';
import { mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { pruneForeignBcryptPrebuilds } from './prepare-package-resources.mjs';

test('Mac packaging keeps only the target bcrypt prebuild', async () => {
  const root = await mkdtemp(join(tmpdir(), 'batshit-bcrypt-prune-'));
  const prebuilds = join(root, 'node_modules', 'bcrypt', 'prebuilds');
  const arm64 = join(prebuilds, 'darwin-arm64', 'bcrypt.node');
  const x64 = join(prebuilds, 'darwin-x64', 'bcrypt.node');
  await mkdir(join(arm64, '..'), { recursive: true });
  await mkdir(join(x64, '..'), { recursive: true });
  await writeFile(arm64, 'arm64');
  await writeFile(x64, 'x64');

  await pruneForeignBcryptPrebuilds(root, 'arm64');

  assert.equal((await stat(arm64)).isFile(), true);
  await assert.rejects(stat(x64));
});
