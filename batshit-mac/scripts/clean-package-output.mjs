import { rm } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const macRoot = resolve(__dirname, '..');
const packageRoot = resolve(macRoot, 'zig-out', 'package');
const target = resolve(macRoot, process.argv[2] || '');

if (!target.startsWith(`${packageRoot}${sep}`)) {
  throw new Error(`Refusing to clean package output outside ${packageRoot}: ${target}`);
}

await rm(target, { recursive: true, force: true });
