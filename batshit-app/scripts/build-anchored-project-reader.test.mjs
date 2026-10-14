import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFile, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildAnchoredProjectReader, buildOptions, compilerArgs } from './build-anchored-project-reader.mjs';

test('the anchored reader build refuses unsupported and cross-arch Linux targets', () => {
  assert.throws(() => buildOptions([], 'win32', 'x64'), /cannot be built/);
  assert.throws(() => buildOptions(['--target-arch', 'arm64'], 'linux', 'x64'), /native target/);
  assert.deepEqual(
    compilerArgs({ output: '/tmp/reader', platform: 'darwin', targetArch: 'arm64' }).slice(0, 9),
    ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', '-arch', 'arm64', '-mmacosx-version-min=14.0', '-o']
  );
});

test('automatic hooks skip unsupported Windows while explicit builds still reject it', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'batshit-anchored-reader-windows-'));
  try {
    const output = join(folder, 'anchored-project-reader');
    const options = buildOptions(['--if-supported', '--output', output], 'win32', 'x64');
    assert.equal(options.skipped, true);
    assert.equal(await buildAnchoredProjectReader(options), null);
    await assert.rejects(stat(output), { code: 'ENOENT' });

    const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    assert.equal(packageJson.scripts.predev, 'npm run build:anchored-reader -- --if-supported');
    const require = createRequire(import.meta.url);
    const pinokioInstall = require(fileURLToPath(new URL('../../pinokio/install.js', import.meta.url)));
    assert.ok(pinokioInstall.run.some(step =>
      step.method === 'shell.run' && step.params?.message === 'npm run build:anchored-reader -- --if-supported'
    ));
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test('the production flags compile a native executable in a disposable folder', {
  skip: !['darwin', 'linux'].includes(process.platform)
}, async () => {
  const folder = await mkdtemp(join(tmpdir(), 'batshit-anchored-reader-build-'));
  try {
    const output = join(folder, 'anchored-project-reader');
    await buildAnchoredProjectReader(buildOptions(['--output', output]));
    const info = await stat(output);
    assert.equal(info.isFile(), true);
    assert.ok(info.size > 0 && (info.mode & 0o111));
    const magic = (await readFile(output)).subarray(0, 4).toString('hex');
    assert.ok(process.platform === 'darwin'
      ? ['cffaedfe', 'feedfacf'].includes(magic)
      : magic === '7f454c46', `unexpected executable format: ${magic}`);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test('a missing compiler stops installation with actionable platform guidance', {
  skip: !['darwin', 'linux'].includes(process.platform)
}, async () => {
  const folder = await mkdtemp(join(tmpdir(), 'batshit-anchored-reader-no-cc-'));
  const output = join(folder, 'anchored-project-reader');
  try {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('./build-anchored-project-reader.mjs', import.meta.url)), '--output', output], {
      env: { ...process.env, PATH: '' },
      encoding: 'utf8'
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /No cc compiler was found on PATH/);
    assert.match(result.stderr, process.platform === 'darwin'
      ? /xcode-select --install/
      : /sudo apt install build-essential/);
    await assert.rejects(stat(output), { code: 'ENOENT' });
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
