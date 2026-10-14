import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CodexReplyBaseline as Baseline } from '../codexReplyBaseline';
let CodexReplyBaseline: typeof import('../codexReplyBaseline').CodexReplyBaseline;
import type { AnchoredProjectReader as Reader } from '../anchoredProjectReader';
let AnchoredProjectReader: typeof import('../anchoredProjectReader').AnchoredProjectReader;

// Only the test build has scheduling barriers. All file operations and the actual
// baseline/client/reader protocol run unchanged against disposable fixture roots.
const hooks = vi.hoisted(() => ({ stage: null as null | ((stage: string) => void), children: [] as any[], diagnostics: [] as string[] }));
vi.mock('node:child_process', async importActual => {
  const actual = await importActual<typeof import('node:child_process')>();
  const spawn = (file: string, args: string[], options: any) => {
    const child = actual.spawn(file, args, { ...options, stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
    hooks.children.push(child);
    child.once('close', (code, signal) => hooks.diagnostics.push(`close:${code}:${signal}`));
    child.stderr!.on('data', chunk => hooks.diagnostics.push(chunk.toString()));
    let buffered = '';
    child.stdio[3]!.on('data', (chunk: Buffer) => {
      buffered += chunk.toString();
      let end: number;
      while ((end = buffered.indexOf('\n')) >= 0) {
        const stage = buffered.slice(0, end); buffered = buffered.slice(end + 1);
        hooks.stage?.(stage);
        (child.stdio[3] as NodeJS.WritableStream).write('+');
      }
    });
    return child;
  };
  return { ...actual, spawn, default: { ...((actual as any).default ?? actual), spawn } };
});

describe.runIf(process.platform === 'darwin' || process.platform === 'linux')('anchored baseline on real temporary files', () => {
  let buildRoot: string, fixture: string, project: string, outside: string;
  let baseline: Baseline | null;
  const readers: Reader[] = [];
  beforeAll(async () => {
    vi.resetModules();
    ({ CodexReplyBaseline } = await import('../codexReplyBaseline'));
    ({ AnchoredProjectReader } = await import('../anchoredProjectReader'));
    buildRoot = mkdtempSync(path.join(os.tmpdir(), 'bl320-client-build-'));
    const executable = path.join(buildRoot, 'reader');
    execFileSync('cc', ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', '-DBL320_TEST_BARRIERS',
      'scripts/anchored-project-reader.c', '-o', executable], { timeout: 30_000 });
    vi.stubEnv('BATSHIT_TEST_ANCHORED_READER', executable);
  });
  afterAll(() => { vi.unstubAllEnvs(); rmSync(buildRoot, { recursive: true, force: true }); });
  beforeEach(() => {
    hooks.diagnostics = [];
    fixture = mkdtempSync(path.join(os.tmpdir(), 'bl320-baseline-'));
    project = path.join(fixture, 'project'); outside = path.join(fixture, 'outside');
    mkdirSync(path.join(project, 'folder'), { recursive: true }); mkdirSync(outside);
    writeFileSync(path.join(project, 'folder/note.txt'), 'inside-marker\n');
    writeFileSync(path.join(outside, 'note.txt'), 'outside-marker\n');
    const git = (...args: string[]) => execFileSync('/usr/bin/git', ['-C', project, ...args], { stdio: 'ignore' });
    git('init', '-q'); git('add', '.');
    baseline = null;
  });
  afterEach(async () => {
    hooks.stage = null;
    await baseline?.dispose();
    await Promise.all(readers.splice(0).map(reader => reader.close()));
    for (const child of hooks.children.splice(0) as ChildProcess[]) {
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    }
    rmSync(fixture, { recursive: true, force: true });
  });

  it('refuses a parent replaced before its anchored open', async () => {
    baseline = await CodexReplyBaseline.take({ projectPath: project });
    expect(baseline.ready, baseline.unavailableReason + JSON.stringify({ diagnostics: hooks.diagnostics, children: hooks.children.length })).toBe(true);
    let swapped = false;
    hooks.stage = stage => {
      if (swapped || stage !== (process.platform === 'darwin' ? 'before-directory' : 'before-leaf')) return;
      swapped = true;
      renameSync(path.join(project, 'folder'), path.join(project, 'held'));
      symlinkSync(outside, path.join(project, 'folder'));
    };
    expect(await baseline.readDiff('folder/note.txt')).toMatchObject({ kind: 'unvouched' });
    expect(swapped).toBe(true);
  });

  it('a swap and restoration after the file is held never selects the outside bytes', async () => {
    baseline = await CodexReplyBaseline.take({ projectPath: project });
    let swapped = false;
    hooks.stage = stage => {
      if (stage === 'file-held') {
        swapped = true;
        renameSync(path.join(project, 'folder'), path.join(project, 'held'));
        symlinkSync(outside, path.join(project, 'folder'));
      } else if (stage === 'read-finished' && swapped) {
        unlinkSync(path.join(project, 'folder'));
        renameSync(path.join(project, 'held'), path.join(project, 'folder'));
      }
    };
    expect(await baseline.readDiff('folder/note.txt')).toEqual({ kind: 'unchanged' });
    expect(swapped).toBe(true);
  });

  it('retains the admitted root across later replacement of its configured name', async () => {
    baseline = await CodexReplyBaseline.take({ projectPath: project });
    renameSync(project, path.join(fixture, 'held-project'));
    symlinkSync(outside, project);
    expect(await baseline.readDiff('folder/note.txt')).toEqual({ kind: 'unchanged' });
  });

  it('serializes concurrent requests and continues after a refused path', async () => {
    const reader = await AnchoredProjectReader.open(project, { timeoutMs: 1000 }); readers.push(reader);
    const results = await Promise.allSettled([
      reader.readText('../outside/note.txt', 100, { timeoutMs: 1000 }),
      reader.readText('folder/note.txt', 100, { timeoutMs: 1000 }),
      reader.stat('folder/note.txt', { timeoutMs: 1000 }),
    ]);
    expect(results[0].status).toBe('rejected');
    expect(results[1]).toMatchObject({ status: 'fulfilled', value: 'inside-marker\n' });
    expect(results[2]).toMatchObject({ status: 'fulfilled', value: { size: 14n } });
  });

  it('discards pending bytes on Stop and leaves no live reader', async () => {
    const reader = await AnchoredProjectReader.open(project, { timeoutMs: 1000 }); readers.push(reader);
    const stop = new AbortController();
    hooks.stage = stage => { if (stage === 'file-held') stop.abort(); };
    await expect(reader.readText('folder/note.txt', 100, { timeoutMs: 1000, signal: stop.signal })).rejects.toThrow(/stopped/);
    await reader.close();
    await expect(reader.readText('folder/note.txt', 100, { timeoutMs: 1000 })).rejects.toThrow();
  });

  it('releases a retained reader during runtime shutdown', async () => {
    const { closeRegisteredRuntimeResources } = await import('../runtimeShutdown');
    const reader = await AnchoredProjectReader.open(project, { timeoutMs: 1000 }); readers.push(reader);
    await closeRegisteredRuntimeResources('fixture shutdown');
    await expect(reader.readText('folder/note.txt', 100, { timeoutMs: 1000 })).rejects.toThrow(/released/);
  });

  it('reports unverified cleanup when an admitted helper dies abruptly', async () => {
    const reader = await AnchoredProjectReader.open(project, { timeoutMs: 1000 });
    readers.push(reader); // Teardown owns the helper if the pre-kill request fails.
    // READY precedes the test-only root-held barrier. A completed request proves
    // its acknowledgement was consumed before this deliberately idle-helper kill.
    expect(await reader.stat('folder/note.txt', { timeoutMs: 1000 })).toMatchObject({ size: 14n });
    const child = hooks.children.at(-1) as ChildProcess;
    const closed = new Promise(resolve => child.once('close', resolve));
    child.kill('SIGKILL'); // Disposable reader is idle; no fixture Git child is running.
    await closed;
    readers.splice(readers.indexOf(reader), 1); // Its death is known; close must now refuse cleanup proof.
    await expect(reader.close()).rejects.toThrow(/cleanup is unverified/);
  });
});
