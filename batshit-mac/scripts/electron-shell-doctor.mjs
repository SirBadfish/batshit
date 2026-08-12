import { access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const checks = [
  ['Electron binary', join(root, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron')],
  ['Electron main process', join(root, 'src-electron', 'main.mjs')],
  ['Electron preload bridge', join(root, 'src-electron', 'preload.cjs')],
  ['Runtime supervisor', join(root, 'scripts', 'mac-runtime-supervisor.mjs')],
  ['Mac icon', join(root, 'assets', 'icon.icns')]
];

const results = [];
for (const [label, path] of checks) {
  const available = await access(path).then(() => true).catch(() => false);
  results.push({ label, path, available });
}
const ok = process.platform === 'darwin' && ['arm64', 'x64'].includes(process.arch) && results.every((entry) => entry.available);
console.log(JSON.stringify({ ok, platform: process.platform, arch: process.arch, results }, null, 2));
if (!ok) process.exitCode = 1;
