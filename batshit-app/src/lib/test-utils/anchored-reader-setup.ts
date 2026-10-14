import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** Direct `vitest run` proves the current C source, never an ignored developer binary. */
export default async function setup() {
  if (!['darwin', 'linux'].includes(process.platform)) return;
  const root = await mkdtemp(path.join(os.tmpdir(), 'batshit-reader-test-'));
  const executable = path.join(root, 'anchored-project-reader');
  const previous = process.env.BATSHIT_TEST_ANCHORED_READER;
  try {
    execFileSync(process.execPath, ['scripts/build-anchored-project-reader.mjs', '--output', executable], {
      timeout: 30_000, stdio: 'pipe',
    });
    process.env.BATSHIT_TEST_ANCHORED_READER = executable;
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
  return async () => {
    if (previous === undefined) delete process.env.BATSHIT_TEST_ANCHORED_READER;
    else process.env.BATSHIT_TEST_ANCHORED_READER = previous;
    await rm(root, { recursive: true, force: true });
  };
}
