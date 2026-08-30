#!/usr/bin/env node

import { readFile, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptRoot, '..');
const manifestPath = join(scriptRoot, 'dependency-audit-roots.json');

async function loadRoots() {
  const payload = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (payload?.version !== 1 || !Array.isArray(payload.roots) || payload.roots.length === 0) {
    throw new Error('tools/dependency-audit-roots.json must declare a non-empty version 1 roots array.');
  }

  const roots = payload.roots.map((value) => String(value).trim());
  if (roots.some((value) => !value || value.startsWith('/') || value.split('/').includes('..'))) {
    throw new Error('Dependency audit roots must be non-empty repository-relative paths.');
  }
  if (new Set(roots).size !== roots.length) {
    throw new Error('Dependency audit roots must be unique.');
  }
  return roots;
}

export async function validateDependencyAuditRoots() {
  const roots = await loadRoots();
  const missing = [];
  for (const root of roots) {
    for (const filename of ['package.json', 'package-lock.json']) {
      const manifest = join(repoRoot, root, filename);
      if (!(await stat(manifest).catch(() => null))?.isFile()) {
        missing.push(relative(repoRoot, manifest));
      }
    }
  }
  if (missing.length > 0) {
    throw new Error(`Declared live dependency roots are incomplete:\n- ${missing.join('\n- ')}`);
  }
  return roots;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const roots = await validateDependencyAuditRoots();
    if (process.argv.includes('--lines')) {
      process.stdout.write(`${roots.join('\n')}\n`);
    } else {
      process.stdout.write(`${JSON.stringify({ ok: true, roots })}\n`);
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
