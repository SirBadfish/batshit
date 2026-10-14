// @vitest-environment node
import { execFileSync, spawn } from 'node:child_process'
import * as fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { inspectTestProcessState, isTestProcessRunning } from './process-state'

const inspection = vi.hoisted(() => ({ failure: false, stat: null as string | null }))
vi.mock('node:fs', async importActual => {
  const actual = await importActual<typeof import('node:fs')>()
  const readFileSync = (file: fs.PathOrFileDescriptor, options: any) => {
    if (file === `/proc/${process.pid}/stat`) {
      if (inspection.failure) throw Object.assign(new Error('fixture access denied'), { code: 'EACCES' })
      if (inspection.stat !== null) return inspection.stat
    }
    return actual.readFileSync(file, options)
  }
  return { ...actual, readFileSync, default: { ...((actual as any).default ?? actual), readFileSync } }
})

afterEach(() => {
  inspection.failure = false
  inspection.stat = null
  vi.restoreAllMocks()
})

describe.runIf(process.platform === 'linux')('Linux test process observation', () => {
  it('distinguishes a live child, its unreaped zombie, and absence after waitpid', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'batshit-process-observer-'))
    const source = path.join(root, 'fixture.c')
    const executable = path.join(root, 'fixture')
    // The owned parent keeps waitpid behind the second input byte. EOF on any
    // failure path releases and reaps its child; nothing is handed to PID 1.
    fs.writeFileSync(source, `
#include <errno.h>
#include <stdio.h>
#include <sys/prctl.h>
#include <sys/wait.h>
#include <unistd.h>
int main(void) {
  int gate[2];
  if (prctl(PR_SET_NAME, "fixture) name", 0, 0, 0) || pipe(gate)) return 2;
  pid_t child = fork();
  if (child < 0) return 3;
  if (!child) {
    close(gate[1]);
    char byte;
    ssize_t received;
    do {
      received = read(gate[0], &byte, 1);
    } while (received < 0 && errno == EINTR);
    close(gate[0]);
    _exit(received == 1 ? 0 : 6);
  }
  close(gate[0]);
  printf("%ld\\n", (long)child); fflush(stdout);
  int command = getchar();
  ssize_t released;
  do {
    released = write(gate[1], "x", 1);
  } while (released < 0 && errno == EINTR);
  close(gate[1]);
  if (command != EOF) (void)getchar();
  int status;
  if (waitpid(child, &status, 0) != child) return 4;
  puts("REAPED");
  return released == 1 && WIFEXITED(status) && WEXITSTATUS(status) == 0 ? 0 : 5;
}
`)
    try {
      execFileSync('cc', ['-std=c11', '-O2', '-Wall', '-Wextra', '-Werror', source, '-o', executable])
      const parent = spawn(executable, [], { stdio: ['pipe', 'pipe', 'pipe'] })
      let output = '', errors = ''
      parent.stdout.on('data', chunk => { output += String(chunk) })
      parent.stderr.on('data', chunk => { errors += String(chunk) })
      const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        parent.once('error', reject)
        parent.once('close', (code, signal) => resolve({ code, signal }))
      })
      const until = async (ready: () => boolean) => {
        const deadline = Date.now() + 1_000
        while (!ready() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
        expect(ready()).toBe(true)
      }
      try {
        await until(() => output.includes('\n'))
        const pid = Number(output.split('\n')[0])
        expect(pid).toBeGreaterThan(0)
        expect(inspectTestProcessState(pid)).toBe('live')
        expect(isTestProcessRunning(pid)).toBe(true)
        expect(fs.readFileSync(`/proc/${pid}/stat`, 'utf8')).toContain('(fixture) name)')

        parent.stdin.write('x')
        await until(() => inspectTestProcessState(pid) === 'zombie')
        expect(() => process.kill(pid, 0)).not.toThrow() // The old predicate still says running.
        expect(fs.existsSync(`/proc/${pid}`)).toBe(true)
        expect(isTestProcessRunning(pid)).toBe(false)
        console.info('owned-process-observer-proof', { pid, state: 'zombie', pidPresent: true })

        parent.stdin.end('r')
        expect(await closed).toEqual({ code: 0, signal: null })
        expect(output).toContain('REAPED')
        expect(inspectTestProcessState(pid)).toBe('absent')
        expect(fs.existsSync(`/proc/${pid}`)).toBe(false)
        expect(errors).toBe('')
        console.info('owned-process-observer-proof', { pid, state: 'absent', waitedByParent: true })
      } finally {
        if (!parent.stdin.writableEnded) parent.stdin.end()
        await closed
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps unreadable inspection unresolved and blocking', () => {
    inspection.failure = true
    expect(inspectTestProcessState(process.pid)).toBe('unverified')
    expect(isTestProcessRunning(process.pid)).toBe(true)
  })

  it('keeps malformed or mismatched process records unresolved and blocking', () => {
    for (const text of ['broken', `${process.pid} (fixture) ? 1`, '0 (fixture) Z 1', `${process.pid} (fixture) Z `, `${process.pid} (fixture) Z garbage`]) {
      inspection.stat = text
      expect(inspectTestProcessState(process.pid)).toBe('unverified')
      expect(isTestProcessRunning(process.pid)).toBe(true)
    }
  })

  it('never interprets invalid PID values as a successful stop', () => {
    const signal = vi.spyOn(process, 'kill')
    for (const pid of [0, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(inspectTestProcessState(pid)).toBe('unverified')
      expect(isTestProcessRunning(pid)).toBe(true)
    }
    expect(signal).not.toHaveBeenCalled()
  })
})
