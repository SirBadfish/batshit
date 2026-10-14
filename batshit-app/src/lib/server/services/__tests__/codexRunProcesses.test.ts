import { spawn, type ChildProcess } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CODEX_PROCESS_KILL_GRACE_MS, CodexRunProcesses, getCodexRunProcesses } from '../codexRunProcesses'
import { closeRegisteredRuntimeResources } from '../runtimeShutdown'

// These are disposable OS children, not Codex mocks. Each wrapper is its own process group;
// its native command may deliberately create another group, as the installed CLI can.
const ownedGroups = new Set<number>()

function launch(script: string): ChildProcess {
  const child = spawn(process.execPath, ['-e', script], {
    detached: true,
    stdio: ['pipe', 'pipe', 'ignore']
  })
  if (child.pid) ownedGroups.add(child.pid)
  child.on('error', () => {})
  return child
}

function lineFrom(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = ''
    const timer = setTimeout(() => reject(new Error('Disposable child did not announce readiness.')), 4_000)
    child.stdout!.on('data', (chunk) => {
      text += String(chunk)
      const index = text.indexOf('\n')
      if (index < 0) return
      clearTimeout(timer)
      resolve(text.slice(0, index))
    })
    child.once('error', reject)
    child.once('exit', () => {
      if (!text.includes('\n')) reject(new Error('Disposable child exited before readiness.'))
    })
  })
}

function running(pid: number): boolean {
  try {
    const state = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'stat='], {
      encoding: 'utf8', timeout: 2_000
    }).trim()
    return Boolean(state) && !state.startsWith('Z')
  } catch {
    return false
  }
}

async function eventuallyStopped(pid: number): Promise<void> {
  const until = Date.now() + 3_000
  while (running(pid) && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  expect(running(pid), `pid ${pid} still ran after cleanup`).toBe(false)
}

function wrapperWithNative(detachedNative: boolean): string {
  const native = "process.on('SIGTERM', () => {}); console.log('native ready'); setInterval(() => {}, 1000)"
  return `
    const { spawn } = require('node:child_process')
    const native = spawn(process.execPath, ['-e', ${JSON.stringify(native)}], {
      detached: ${detachedNative}, stdio: ['ignore', 'pipe', 'ignore']
    })
    native.stdout.once('data', () => process.stdout.write('NATIVE ' + native.pid + '\\n'))
    process.on('SIGTERM', () => process.exit(0))
    process.stdin.on('data', (chunk) => { if (String(chunk).includes('finish')) process.exit(0) })
    setInterval(() => {}, 1000)
  `
}

function nativePid(line: string, detached: boolean, wrapperPid: number): number {
  expect(line).toMatch(/^NATIVE \d+$/)
  const pid = Number(line.slice('NATIVE '.length))
  expect(running(pid)).toBe(true)
  if (detached) ownedGroups.add(pid)
  else expect(pid).not.toBe(wrapperPid)
  return pid
}

afterEach(async () => {
  for (const group of ownedGroups) {
    try { process.kill(-group, 'SIGKILL') } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
  }
  ownedGroups.clear()
})

describe.runIf(process.platform !== 'win32')('Codex run process ownership (real children)', () => {
  it('stops a stubborn native command in its own detached group, without touching a bystander', async () => {
    const wrapper = launch(wrapperWithNative(true))
    const nativeReady = lineFrom(wrapper)
    const processes = new CodexRunProcesses(wrapper, { rootGraceMs: 150 })
    await processes.ready
    expect(getCodexRunProcesses(wrapper)).toBe(processes)
    const native = nativePid(await nativeReady, true, wrapper.pid!)

    const bystander = launch("console.log('bystander ready'); setInterval(() => {}, 1000)")
    const bystanderReady = lineFrom(bystander)
    await bystanderReady
    expect(running(bystander.pid!)).toBe(true)

    await processes.prepareStop()
    const started = Date.now()
    await processes.end()
    expect(Date.now() - started).toBeGreaterThanOrEqual(CODEX_PROCESS_KILL_GRACE_MS - 50)
    await eventuallyStopped(wrapper.pid!)
    await eventuallyStopped(native)
    expect(running(bystander.pid!)).toBe(true)
    await expect(processes.end()).resolves.toBeUndefined()
  }, 10_000)

  it('waits for a native same-group command after its wrapper exits on TERM', async () => {
    const wrapper = launch(wrapperWithNative(false))
    const nativeReady = lineFrom(wrapper)
    const processes = new CodexRunProcesses(wrapper, { rootGraceMs: 150 })
    await processes.ready
    const native = nativePid(await nativeReady, false, wrapper.pid!)

    await processes.prepareStop()
    const started = Date.now()
    await processes.end()
    expect(Date.now() - started).toBeGreaterThanOrEqual(CODEX_PROCESS_KILL_GRACE_MS - 50)
    await eventuallyStopped(wrapper.pid!)
    await eventuallyStopped(native)
  }, 10_000)

  it('captures a TERM-handler native child while its verified wrapper is still alive', async () => {
    const nativeScript = "process.on('SIGTERM', () => {}); console.log('native ready'); setInterval(() => {}, 1000)"
    const wrapper = launch(`
      const { spawn } = require('node:child_process')
      process.on('SIGTERM', () => {
        const native = spawn(process.execPath, ['-e', ${JSON.stringify(nativeScript)}], {
          detached: true, stdio: ['ignore', 'pipe', 'ignore']
        })
        native.stdout.once('data', () => process.stdout.write('NATIVE ' + native.pid + '\\n'))
        setTimeout(() => process.exit(0), 300)
      })
      console.log('wrapper ready')
      setInterval(() => {}, 1000)
    `)
    const ready = lineFrom(wrapper)
    const processes = new CodexRunProcesses(wrapper, { rootGraceMs: 150 })
    await processes.ready
    expect(await ready).toBe('wrapper ready')
    const nativeReady = lineFrom(wrapper)

    await processes.prepareStop()
    const ending = processes.end()
    const native = nativePid(await nativeReady, true, wrapper.pid!)
    await ending
    await eventuallyStopped(wrapper.pid!)
    await eventuallyStopped(native)
  }, 10_000)

  it('preserves a separately grouped background command on normal wrapper completion', async () => {
    const wrapper = launch(wrapperWithNative(true))
    const nativeReady = lineFrom(wrapper)
    const processes = new CodexRunProcesses(wrapper)
    await processes.ready
    const native = nativePid(await nativeReady, true, wrapper.pid!)

    wrapper.stdin!.end('finish\n')
    await new Promise<void>((resolve) => wrapper.once('exit', () => resolve()))
    await processes.end()
    expect(running(native)).toBe(true)
  }, 10_000)

  it('drains a stubborn same-group native before the Mac supervisor shutdown deadline', async () => {
    const wrapper = launch(wrapperWithNative(false))
    const nativeReady = lineFrom(wrapper)
    const processes = new CodexRunProcesses(wrapper)
    await processes.ready
    const native = nativePid(await nativeReady, false, wrapper.pid!)

    const started = Date.now()
    await closeRegisteredRuntimeResources('test shutdown')
    expect(Date.now() - started).toBeLessThan(4_000)
    await eventuallyStopped(wrapper.pid!)
    await eventuallyStopped(native)
  }, 10_000)

  it('does not signal after failed ownership inspection and retries once inspection recovers', async () => {
    const wrapper = launch("console.log('wrapper ready'); setInterval(() => {}, 1000)")
    const ready = lineFrom(wrapper)
    const processes = new CodexRunProcesses(wrapper, { rootGraceMs: 150 })
    await processes.ready
    expect(await ready).toBe('wrapper ready')

    const inspection = vi.spyOn(processes as unknown as { capture: (...args: unknown[]) => Promise<void> }, 'capture')
      .mockRejectedValueOnce(new Error('process inspection unavailable'))
    await expect(processes.prepareStop()).rejects.toThrow('process inspection unavailable')
    await expect(processes.end()).rejects.toThrow('process inspection unavailable')
    expect(running(wrapper.pid!)).toBe(true)

    inspection.mockRestore()
    await expect(processes.retryEnd()).resolves.toBeUndefined()
    await eventuallyStopped(wrapper.pid!)
  }, 10_000)

  it('establishes ownership before a fast protocol reply can finish', async () => {
    const child = launch(`
      let input = ''
      process.stdin.on('data', (chunk) => {
        input += String(chunk)
        if (input.includes('hello\\n')) { process.stdout.write('DONE\\n'); process.exit(0) }
      })
    `)
    const reply = lineFrom(child)
    const processes = new CodexRunProcesses(child)
    await processes.ready
    child.stdin!.end('hello\n')
    expect(await reply).toBe('DONE')
    await processes.end()
    await eventuallyStopped(child.pid!)
  }, 10_000)

  it('does not invent process ownership when spawn failed before a PID existed', async () => {
    const child = spawn('/nonexistent/batshit-codex-process-proof', [], { stdio: 'ignore' })
    child.on('error', () => {})
    const kill = vi.spyOn(child, 'kill')
    const processes = new CodexRunProcesses(child)
    await processes.ready
    expect(child.pid).toBeUndefined()
    await expect(processes.end()).resolves.toBeUndefined()
    expect(kill).not.toHaveBeenCalled()
  })
})
