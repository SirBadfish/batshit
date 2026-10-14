// The name of a release file (the DMG, a ZIP, and the `.sha256` beside them):
// `Batshit-<app version>-<arch>`, the usual desktop-app pattern, for example
// `Batshit-0.1.0-alpha.2-arm64.dmg`, so every release's download carries its own version.
// The version is the app's (`batshit-app/src/lib/version.ts`); the bundle's
// CFBundleShortVersionString stays numeric (`package.json`), as macOS requires.
// Run as a script, it prints the name without an extension.
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Apple Silicon only: the Mac app targets arm64 (macOS 14 or later).
export const RELEASE_ARCH = 'arm64';

const VERSION_EXPORT = /^export const BATSHIT_APP_VERSION = '(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)'$/m;

export function readAppVersion(root = repoRoot) {
  const source = readFileSync(join(root, 'batshit-app', 'src', 'lib', 'version.ts'), 'utf8');
  const match = source.match(VERSION_EXPORT);
  if (!match) {
    throw new Error('batshit-app/src/lib/version.ts must export BATSHIT_APP_VERSION as a version string.');
  }
  return match[1];
}

export function releaseArtifactBaseName(version = readAppVersion()) {
  return `Batshit-${version}-${RELEASE_ARCH}`;
}

// Run only when started directly, not when imported. Node gives this module its REAL path, so the
// start path is compared as a real path too: started through a link (or macOS's /var, a link to
// /private/var) it used to print nothing, and rebuild-mac-app.sh would name a release ".zip" (BL-148).
function startedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
if (startedDirectly()) {
  process.stdout.write(`${releaseArtifactBaseName()}\n`);
}
