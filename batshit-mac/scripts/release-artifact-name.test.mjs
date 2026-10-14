import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { readAppVersion, releaseArtifactBaseName } from './release-artifact-name.mjs';

const scriptPath = fileURLToPath(new URL('./release-artifact-name.mjs', import.meta.url));
const repoRoot = resolve(dirname(scriptPath), '..', '..');

test('a release file carries the app version and the chip: Batshit-<version>-arm64', () => {
  const version = readAppVersion();
  assert.match(version, /^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/);
  assert.equal(releaseArtifactBaseName(), `Batshit-${version}-arm64`);
  assert.equal(releaseArtifactBaseName('0.1.0-alpha.2'), 'Batshit-0.1.0-alpha.2-arm64');
});

test('the name uses the same version the packaged app reports', () => {
  // The supervisor's default is what an installed app shows and the update check compares, so a
  // release file named from a different version would be a second, wrong version.
  const supervisor = readFileSync(join(repoRoot, 'batshit-mac', 'scripts', 'mac-runtime-supervisor.mjs'), 'utf8');
  const reported = supervisor.match(/^const DEFAULT_APP_VERSION = '([^']+)';$/m)?.[1];
  assert.equal(reported, readAppVersion());
});

test('a missing or unreadable version stops the build instead of guessing a name', () => {
  const root = mkdtempSync(join(tmpdir(), 'batshit-release-name-'));
  try {
    mkdirSync(join(root, 'batshit-app', 'src', 'lib'), { recursive: true });
    writeFileSync(join(root, 'batshit-app', 'src', 'lib', 'version.ts'), "export const BATSHIT_APP_CHANNEL = 'alpha'\n");
    assert.throws(() => readAppVersion(root), /must export BATSHIT_APP_VERSION/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('run as a script, it prints the name for the build scripts', () => {
  const printed = execFileSync(process.execPath, [scriptPath], { encoding: 'utf8' }).trim();
  assert.equal(printed, releaseArtifactBaseName());
});
