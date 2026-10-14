import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { copyAppRuntimeScripts, pruneForeignBcryptPrebuilds } from './prepare-package-resources.mjs';

test('Mac runtime assembly carries the standalone command guardian and anchored reader source', async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const sourceApp = join(here, '..', '..', 'batshit-app');
  const packageRoot = await mkdtemp(join(tmpdir(), 'batshit-guardian-package-'));
  try {
    const destinationApp = join(packageRoot, 'Contents', 'Resources', 'runtime', 'batshit-app');
    await copyAppRuntimeScripts(sourceApp, destinationApp);
    const sourceGuardian = join(sourceApp, 'scripts', 'command-group-guardian.mjs');
    const packagedGuardian = join(destinationApp, 'scripts', 'command-group-guardian.mjs');
    assert.equal((await stat(packagedGuardian)).isFile(), true);
    assert.deepEqual(await readFile(packagedGuardian), await readFile(sourceGuardian));
    for (const name of ['anchored-project-reader.c', 'build-anchored-project-reader.mjs']) {
      const source = join(sourceApp, 'scripts', name);
      const packaged = join(destinationApp, 'scripts', name);
      assert.equal((await stat(packaged)).isFile(), true);
      assert.deepEqual(await readFile(packaged), await readFile(source));
    }
  } finally {
    await rm(packageRoot, { recursive: true, force: true });
  }
});

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

// A packaged supervisor that imports a sibling the packaging step never copies
// crashes on load, and only in the packaged app — every unpackaged test stays
// green. Derive the requirement from the supervisor's own imports so a new
// sibling cannot be added without its copy line.
test('every supervisor sibling import is copied into the packaged resources', async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const supervisor = await readFile(join(here, 'mac-runtime-supervisor.mjs'), 'utf8');
  const packaging = await readFile(join(here, 'prepare-package-resources.mjs'), 'utf8');

  const siblings = [...supervisor.matchAll(/from '\.\/([A-Za-z0-9._-]+\.mjs)'/g)].map(
    (match) => match[1]
  );
  assert.ok(siblings.length >= 3, `expected sibling imports, found ${siblings.length}`);

  for (const sibling of siblings) {
    assert.ok(
      packaging.includes(`'scripts', '${sibling}'`),
      `prepare-package-resources.mjs does not copy ${sibling} into the packaged scripts folder`
    );
  }
});
