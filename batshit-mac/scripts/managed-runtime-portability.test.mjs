import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  compareVersions,
  isMachOFile,
  isMachOFileSync,
  parseMacosMinimumVersion,
  parseOtoolInstallName,
  parseOtoolLibraries,
  shouldIgnoreNonCodeSigningPath,
  validateMachOPortabilityRecord
} from './managed-runtime-portability.mjs';

test('recognizes Mach-O magic bytes without invoking build-machine file classifiers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'batshit-runtime-magic-'));
  const machO = join(root, 'native-bin');
  const text = join(root, 'plain.txt');
  await writeFile(machO, Buffer.from('cffaedfe00000000', 'hex'));
  await writeFile(text, 'not native');
  assert.equal(await isMachOFile(machO), true);
  assert.equal(await isMachOFile(text), false);
  assert.equal(isMachOFileSync(machO), true);
  assert.equal(isMachOFileSync(text), false);
  assert.equal(shouldIgnoreNonCodeSigningPath(machO), false);
  assert.equal(shouldIgnoreNonCodeSigningPath(text), true);
  assert.equal(shouldIgnoreNonCodeSigningPath(join(root, 'Nested.app')), false);
});

test('parses Mach-O dependencies, install names, and both minimum-version command forms', () => {
  assert.deepEqual(
    parseOtoolLibraries(`fixture:\n\t@rpath/libssl.3.dylib (compatibility version 3.0.0, current version 3.5.0)\n\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1356.0.0)\n`),
    ['@rpath/libssl.3.dylib', '/usr/lib/libSystem.B.dylib']
  );
  assert.equal(parseOtoolInstallName('fixture:\n@rpath/libssl.3.dylib\n'), '@rpath/libssl.3.dylib');
  assert.equal(
    parseMacosMinimumVersion('cmd LC_BUILD_VERSION\n    minos 14.0\n'),
    '14.0'
  );
  assert.equal(
    parseMacosMinimumVersion('cmd LC_VERSION_MIN_MACOSX\n  version 12.3\n'),
    '12.3'
  );
  assert.equal(compareVersions('14.0', '14'), 0);
  assert.equal(compareVersions('14.1', '14.0'), 1);
});

test('accepts only Apple system libraries and package-owned loader-path dependencies', async () => {
  const root = await mkdtemp(join(tmpdir(), 'batshit-runtime-portability-'));
  const bin = join(root, 'redis', 'bin');
  const lib = join(root, 'redis', 'lib');
  await mkdir(bin, { recursive: true });
  await mkdir(lib, { recursive: true });
  await writeFile(join(lib, 'libssl.3.dylib'), 'fixture');

  const issues = await validateMachOPortabilityRecord(
    {
      path: join(bin, 'redis-server'),
      dependencies: [
        '/usr/lib/libSystem.B.dylib',
        '@loader_path/../lib/libssl.3.dylib'
      ],
      installName: null,
      minimumVersion: '14.0'
    },
    { runtimeRoot: root }
  );
  assert.deepEqual(issues, []);
});

test('rejects Homebrew, missing, unresolved, escaping, and newer-mac dependencies', async () => {
  const root = await mkdtemp(join(tmpdir(), 'batshit-runtime-portability-bad-'));
  const bin = join(root, 'redis', 'bin');
  await mkdir(bin, { recursive: true });
  const issues = await validateMachOPortabilityRecord(
    {
      path: join(bin, 'redis-server'),
      dependencies: [
        '/opt/homebrew/opt/openssl@3/lib/libssl.3.dylib',
        '@loader_path/../lib/missing.dylib',
        '@loader_path/../../../outside.dylib',
        '@rpath/unowned.dylib'
      ],
      installName: null,
      minimumVersion: '26.0'
    },
    { runtimeRoot: root }
  );
  assert.equal(issues.length, 5);
  assert.match(issues.join('\n'), /requires macOS 26\.0/);
  assert.match(issues.join('\n'), /Homebrew|build-machine path/);
  assert.match(issues.join('\n'), /missing bundled library/);
  assert.match(issues.join('\n'), /resolves outside/);
  assert.match(issues.join('\n'), /unresolved runtime dependency/);
});
