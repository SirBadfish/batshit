import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const source = join(scriptsDir, 'anchored-project-reader.c');

export function buildOptions(argv = process.argv.slice(2), platform = process.platform, arch = process.arch) {
  let output = join(scriptsDir, 'anchored-project-reader');
  let targetArch = arch;
  let ifSupported = false;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--output' && argv[index + 1]) output = resolve(argv[++index]);
    else if (argv[index] === '--target-arch' && argv[index + 1]) targetArch = argv[++index];
    else if (argv[index] === '--if-supported') ifSupported = true;
    else throw new Error(`Unknown anchored reader build argument: ${argv[index]}`);
  }
  if (!['darwin', 'linux'].includes(platform)) {
    if (ifSupported) return { output, platform, targetArch, skipped: true };
    throw new Error(`Anchored project reads cannot be built on ${platform}.`);
  }
  if (!['arm64', 'x64'].includes(targetArch)) throw new Error(`Unsupported anchored reader architecture: ${targetArch}.`);
  if (platform === 'linux' && targetArch !== arch) {
    throw new Error('Linux anchored reader builds must use a native target architecture.');
  }
  return { output, platform, targetArch };
}

export function compilerArgs({ output, platform, targetArch }) {
  const args = ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror'];
  if (platform === 'darwin') args.push('-arch', targetArch, '-mmacosx-version-min=14.0');
  return [...args, '-o', output, source];
}

function compilerPrerequisite(platform) {
  return platform === 'darwin'
    ? 'Install Xcode Command Line Tools with xcode-select --install, then retry.'
    : 'Install a C11 compiler and libc development headers (Debian/Ubuntu: sudo apt install build-essential; Fedora: sudo dnf install gcc glibc-devel kernel-headers), then retry.';
}

export async function buildAnchoredProjectReader(options = buildOptions()) {
  if (options.skipped) {
    console.log(`Anchored project reads are unavailable on ${options.platform}; skipping the native reader build.`);
    return null;
  }
  await stat(source);
  await mkdir(dirname(options.output), { recursive: true });
  const temporaryDirectory = await mkdtemp(join(dirname(options.output), '.anchored-reader-build-'));
  const temporary = join(temporaryDirectory, 'anchored-project-reader');
  try {
    const result = spawnSync('cc', compilerArgs({ ...options, output: temporary }), {
      cwd: scriptsDir,
      stdio: 'inherit'
    });
    if (result.error || result.status !== 0) {
      const cause = result.error?.code === 'ENOENT'
        ? 'No cc compiler was found on PATH.'
        : result.error?.message || `cc exit ${result.status}`;
      throw new Error(`Anchored project reader compile failed: ${cause} ${compilerPrerequisite(options.platform)}`);
    }
    await chmod(temporary, 0o755);
    await rename(temporary, options.output);
    const built = await stat(options.output);
    if (!built.isFile() || built.size === 0 || !(built.mode & 0o111)) {
      throw new Error('Anchored project reader compiler produced no executable.');
    }
    return options.output;
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildAnchoredProjectReader();
}
