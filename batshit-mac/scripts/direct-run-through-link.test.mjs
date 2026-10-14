// BL-148: a script run through a symbolic link (or any path that is not its real one, such as
// macOS's /var for /private/var) must still run. Each of these scripts decides "was I run directly"
// by comparing the path it was started with to its own module path. Node gives the module its REAL
// path, so comparing the unresolved start path with it made a run through a link exit 0 having done
// nothing at all.
//
// Each case starts the real script through a link in a temporary folder, with arguments that make it
// fail at once, before it can build, package, or touch any runtime: the proof that it ran is its own
// error. Nothing it could act on exists in the temporary folder.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

const scriptsRoot = dirname(fileURLToPath(import.meta.url));
// Deliberately NOT realpath'd: on macOS tmpdir() is under /var, a link to /private/var.
const workDir = mkdtempSync(join(tmpdir(), 'batshit-direct-run-link-'));
after(() => rmSync(workDir, { recursive: true, force: true }));

function runThroughLink(scriptName, args) {
  const linkDir = join(workDir, scriptName.replace(/\W/g, '-'));
  mkdirSync(linkDir, { recursive: true });
  const link = join(linkDir, scriptName);
  symlinkSync(join(scriptsRoot, scriptName), link);
  const result = spawnSync(process.execPath, [link, ...args], {
    cwd: workDir,
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      ...process.env,
      // Folders of its own, in case the supervisor reaches for any.
      BATSHIT_MAC_DATA_DIR: join(workDir, 'data'),
      BATSHIT_MAC_LOG_DIR: join(workDir, 'logs'),
      BATSHIT_MAC_CACHE_DIR: join(workDir, 'cache')
    }
  });
  return { code: result.status, output: `${result.stdout}${result.stderr}` };
}

test('the Mac runtime supervisor runs when started through a link', () => {
  const { code, output } = runThroughLink('mac-runtime-supervisor.mjs', ['zblaunch-not-an-action']);
  assert.match(output, /Unknown supervisor action: zblaunch-not-an-action/);
  assert.equal(code, 1);
});

test('the Mac package builder runs when started through a link', () => {
  const { code, output } = runThroughLink('package-mac-app.mjs', ['--zblaunch-not-an-option']);
  assert.match(output, /Unknown Mac package argument: --zblaunch-not-an-option/);
  assert.notEqual(code, 0);
});

test('the package resource step runs when started through a link', () => {
  const missingPackage = join(workDir, 'zblaunch-missing.app');
  const { code, output } = runThroughLink('prepare-package-resources.mjs', [missingPackage]);
  assert.match(output, /Package resources path does not exist/);
  assert.notEqual(code, 0);
});

test('the release file name script prints the name when started through a link', () => {
  // rebuild-mac-app.sh names every ZIP and DMG with this output; empty, a release would be ".zip".
  const { code, output } = runThroughLink('release-artifact-name.mjs', []);
  assert.equal(code, 0);
  assert.match(output, /^Batshit-\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?-arm64\n$/);
});
