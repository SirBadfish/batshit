import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const zigVersion = '0.16.0';
const platformName = 'zig-aarch64-macos-0.16.0';
const installDir = join(root, '.zig', platformName);
const zigPath = join(installDir, 'zig');
const archivePath = join(root, '.zig', `${platformName}.tar.xz`);
const tarballUrl = 'https://ziglang.org/download/0.16.0/zig-aarch64-macos-0.16.0.tar.xz';
const expectedSha256 = 'b23d70deaa879b5c2d486ed3316f7eaa53e84acf6fc9cc747de152450d401489';

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(' ')} exited with code ${code}`));
    });
  });
}

async function download() {
  await mkdir(join(root, '.zig'), { recursive: true });
  const response = await fetch(tarballUrl);
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download Zig ${zigVersion}: HTTP ${response.status}`);
  }
  await pipeline(response.body, createWriteStream(archivePath));
}

async function verifyArchive() {
  const data = await readFile(archivePath);
  const actual = createHash('sha256').update(data).digest('hex');
  if (actual !== expectedSha256) {
    await rm(archivePath, { force: true });
    throw new Error(`Zig ${zigVersion} checksum mismatch: expected ${expectedSha256}, got ${actual}`);
  }
}

if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  throw new Error('batshit-mac currently pins Zig 0.16.0 for Apple Silicon macOS only.');
}

if (!(await exists(zigPath))) {
  console.log(`Installing Zig ${zigVersion} for batshit-mac...`);
  await rm(installDir, { recursive: true, force: true });
  await download();
  await verifyArchive();
  await run('tar', ['-xJf', archivePath, '-C', join(root, '.zig')]);
  await rm(archivePath, { force: true });
}
