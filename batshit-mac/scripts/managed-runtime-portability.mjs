import { spawnSync } from 'node:child_process';
import { closeSync, openSync, readSync } from 'node:fs';
import { lstat, open, readdir, stat } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';

export const MAC_RUNTIME_MINIMUM_VERSION = '14.0';

function runCaptured(command, args) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 15_000
  });
  return {
    ok: result.status === 0,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error
  };
}

export function parseOtoolLibraries(output) {
  return String(output)
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim().match(/^(.*?)\s+\(compatibility version /)?.[1]?.trim())
    .filter(Boolean);
}

export function parseOtoolInstallName(output) {
  return String(output)
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim())
    .find(Boolean) || null;
}

export function parseMacosMinimumVersion(output) {
  const buildVersion = String(output).match(/\bcmd LC_BUILD_VERSION\b[\s\S]*?\bminos\s+([0-9.]+)/);
  if (buildVersion) return buildVersion[1];
  const legacyVersion = String(output).match(
    /\bcmd LC_VERSION_MIN_MACOSX\b[\s\S]*?\bversion\s+([0-9.]+)/
  );
  return legacyVersion?.[1] || null;
}

export function parseOtoolRpaths(output) {
  const lines = String(output).split(/\r?\n/);
  const rpaths = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!/\bcmd LC_RPATH\b/.test(lines[index])) continue;
    for (let cursor = index + 1; cursor < Math.min(index + 6, lines.length); cursor += 1) {
      const match = lines[cursor].trim().match(/^path\s+(.+?)\s+\(offset\s+\d+\)$/);
      if (match) {
        rpaths.push(match[1]);
        break;
      }
    }
  }
  return rpaths;
}

export function compareVersions(left, right) {
  const leftParts = String(left).split('.').map(Number);
  const rightParts = String(right).split('.').map(Number);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftParts[index] || 0) - (rightParts[index] || 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

function isAppleSystemDependency(dependency) {
  return dependency.startsWith('/System/Library/') || dependency.startsWith('/usr/lib/');
}

function isInside(root, candidate) {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(`${resolvedRoot}${sep}`);
}

function resolveRuntimePathBase(recordPath, runtimePath) {
  if (runtimePath === '@loader_path') return dirname(recordPath);
  if (runtimePath.startsWith('@loader_path/')) {
    return resolve(dirname(recordPath), runtimePath.slice('@loader_path/'.length));
  }
  if (runtimePath.startsWith('/')) return resolve(runtimePath);
  return null;
}

export async function validateMachOPortabilityRecord(
  record,
  {
    runtimeRoot,
    maximumMinimumVersion = MAC_RUNTIME_MINIMUM_VERSION,
    requiredArchitecture = null,
    requireSignature = false
  }
) {
  const issues = [];
  const label = relative(runtimeRoot, record.path) || record.path;
  if (!record.minimumVersion) {
    issues.push(`${label} does not declare a macOS minimum deployment version.`);
  } else if (compareVersions(record.minimumVersion, maximumMinimumVersion) > 0) {
    issues.push(
      `${label} requires macOS ${record.minimumVersion}; the Batshit Mac runtime target is ${maximumMinimumVersion}.`
    );
  }

  if (
    requiredArchitecture &&
    (!Array.isArray(record.architectures) || !record.architectures.includes(requiredArchitecture))
  ) {
    issues.push(`${label} does not contain the required ${requiredArchitecture} architecture.`);
  }
  if (requireSignature && record.signatureValid !== true) {
    issues.push(`${label} does not have a valid code signature.`);
  }

  for (const dependency of record.dependencies) {
    if (dependency === record.installName || isAppleSystemDependency(dependency)) continue;
    if (dependency.startsWith('@loader_path/')) {
      const target = resolve(dirname(record.path), dependency.slice('@loader_path/'.length));
      if (!isInside(runtimeRoot, target)) {
        issues.push(`${label} resolves outside the packaged runtime: ${dependency}`);
        continue;
      }
      if (!(await stat(target).catch(() => null))) {
        issues.push(`${label} references a missing bundled library: ${dependency}`);
      }
      continue;
    }
    if (dependency.startsWith('@rpath/')) {
      const suffix = dependency.slice('@rpath/'.length);
      const candidates = (record.rpaths || [])
        .map((runtimePath) => resolveRuntimePathBase(record.path, runtimePath))
        .filter(Boolean)
        .map((base) => resolve(base, suffix));
      const packagedCandidates = candidates.filter((candidate) => isInside(runtimeRoot, candidate));
      let resolvedInsidePackage = false;
      for (const candidate of packagedCandidates) {
        if (await stat(candidate).catch(() => null)) {
          resolvedInsidePackage = true;
          break;
        }
      }
      if (resolvedInsidePackage) continue;
      if (candidates.length > 0 && packagedCandidates.length === 0) {
        issues.push(`${label} resolves outside the packaged runtime: ${dependency}`);
      } else if (packagedCandidates.length > 0) {
        issues.push(`${label} references a missing bundled library: ${dependency}`);
      } else {
        issues.push(`${label} uses an unresolved runtime dependency: ${dependency}`);
      }
      continue;
    }
    if (dependency.startsWith('@')) {
      issues.push(`${label} uses an unresolved runtime dependency: ${dependency}`);
      continue;
    }
    issues.push(`${label} depends on a build-machine path: ${dependency}`);
  }
  return issues;
}

async function collectFiles(root) {
  const files = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) files.push(path);
    }
  }
  await walk(root);
  return files;
}

export async function isMachOFile(path) {
  const handle = await open(path, 'r').catch(() => null);
  if (!handle) return false;
  try {
    const magic = Buffer.alloc(4);
    const { bytesRead } = await handle.read(magic, 0, magic.length, 0);
    if (bytesRead !== magic.length) return false;
    return new Set([
      'feedface',
      'feedfacf',
      'cefaedfe',
      'cffaedfe',
      'cafebabe',
      'bebafeca',
      'cafebabf',
      'bfbafeca'
    ]).has(magic.toString('hex'));
  } finally {
    await handle.close();
  }
}

export function isMachOFileSync(path) {
  let descriptor;
  try {
    descriptor = openSync(path, 'r');
    const magic = Buffer.alloc(4);
    if (readSync(descriptor, magic, 0, magic.length, 0) !== magic.length) return false;
    return new Set([
      'feedface',
      'feedfacf',
      'cefaedfe',
      'cffaedfe',
      'cafebabe',
      'bebafeca',
      'cafebabf',
      'bfbafeca'
    ]).has(magic.toString('hex'));
  } catch {
    return false;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function shouldIgnoreNonCodeSigningPath(path) {
  if (['.app', '.framework'].includes(extname(path))) return false;
  return !isMachOFileSync(path);
}

export async function inspectManagedRuntimePortability(
  runtimeRoot,
  {
    maximumMinimumVersion = MAC_RUNTIME_MINIMUM_VERSION,
    requiredArchitecture = null,
    requireSignature = false
  } = {}
) {
  const resolvedRoot = resolve(runtimeRoot);
  const rootInfo = await lstat(resolvedRoot).catch(() => null);
  if (!rootInfo?.isDirectory()) {
    return {
      ok: false,
      records: [],
      issues: [`Managed runtime folder is missing: ${resolvedRoot}`]
    };
  }

  const records = [];
  const issues = [];
  for (const path of await collectFiles(resolvedRoot)) {
    if (!(await isMachOFile(path))) continue;
    const libraries = runCaptured('otool', ['-L', path]);
    const installName = runCaptured('otool', ['-D', path]);
    const loadCommands = runCaptured('otool', ['-l', path]);
    const architectureProbe = requiredArchitecture ? runCaptured('lipo', ['-archs', path]) : null;
    const signatureProbe = requireSignature
      ? runCaptured('codesign', ['--verify', '--strict', path])
      : null;
    if (!libraries.ok || !loadCommands.ok) {
      issues.push(
        `${relative(resolvedRoot, path)} could not be inspected with otool: ${
          libraries.stderr || loadCommands.stderr || libraries.error?.message || loadCommands.error?.message
        }`
      );
      continue;
    }
    const record = {
      path,
      dependencies: parseOtoolLibraries(libraries.stdout),
      installName: installName.ok ? parseOtoolInstallName(installName.stdout) : null,
      minimumVersion: parseMacosMinimumVersion(loadCommands.stdout),
      rpaths: parseOtoolRpaths(loadCommands.stdout),
      architectures: architectureProbe?.ok
        ? architectureProbe.stdout.trim().split(/\s+/).filter(Boolean)
        : [],
      signatureValid: signatureProbe ? signatureProbe.ok : null
    };
    records.push(record);
    issues.push(
      ...(await validateMachOPortabilityRecord(record, {
        runtimeRoot: resolvedRoot,
        maximumMinimumVersion,
        requiredArchitecture,
        requireSignature
      }))
    );
  }
  return { ok: issues.length === 0, records, issues };
}
