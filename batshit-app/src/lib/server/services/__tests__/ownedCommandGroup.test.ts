import { afterEach, describe, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import type { Readable } from 'node:stream'
import { randomUUID } from 'node:crypto'
import { access, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  endLiveOwnedCommandGroups,
  liveOwnedCommandCount,
  spawnOwnedCommandGroup,
  type OwnedCommand
} from '../ownedCommandGroup'
import { pinHostCommandOwner } from '../hostCommandOwnership'
import { redis } from '$lib/server/redis'

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const outputPipe = (guardian: ReturnType<typeof spawn>, fd: 4 | 5) => guardian.stdio[fd] as Readable

async function until(check: () => boolean | Promise<boolean>, timeoutMs = 4_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await delay(25)
  }
  throw new Error('Timed out waiting for the owned process state')
}

function collect(command: OwnedCommand) {
  let stdout = ''
  let stderr = ''
  command.stdout.on('data', chunk => { stdout += chunk.toString() })
  command.stderr.on('data', chunk => { stderr += chunk.toString() })
  const errors: Error[] = []
  command.on('error', error => errors.push(error))
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
    command.once('close', (code, signal) => resolve({ code, signal }))
  })
  return { closed, errors, output: () => ({ stdout, stderr }) }
}

async function processIsRunning(pid: number) {
  try {
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn('/bin/ps', ['-p', String(pid), '-o', 'stat='], { stdio: ['ignore', 'pipe', 'pipe'] })
      let text = ''
      child.stdout.on('data', chunk => { text += chunk.toString() })
      child.once('error', reject)
      child.once('close', () => resolve(text))
    })
    return Boolean(output.trim()) && !output.trim().startsWith('Z')
  } catch {
    return true // An inspection failure is not proof of exit.
  }
}

function directGuardian(extraEnv: NodeJS.ProcessEnv = {}) {
  const guardian = spawn(process.execPath, [path.join(process.cwd(), 'scripts/command-group-guardian.mjs')], {
    detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc', 'pipe', 'pipe'],
    env: { PATH: '/usr/bin:/bin', LC_ALL: 'C', ...extraEnv }
  })
  const token = randomUUID()
  const messages: Array<Record<string, unknown>> = []
  let stdout = ''
  guardian.on('message', message => { messages.push(message as Record<string, unknown>) })
  outputPipe(guardian, 4).on('data', chunk => { stdout += chunk.toString() })
  outputPipe(guardian, 5).resume()
  const send = (type: string, fields: Record<string, unknown> = {}, asToken = token) =>
    guardian.send({ version: 1, token: asToken, type, ...fields })
  const exited = new Promise<void>(resolve => guardian.once('exit', () => resolve()))
  return { guardian, token, messages, send, exited, stdout: () => stdout }
}

afterEach(async () => {
  await endLiveOwnedCommandGroups()
})

describe.runIf(process.platform !== 'win32')('owned local command groups (real processes)', () => {
  it('records guardian birth before command start and completes only after group cleanup', async () => {
    const pin = pinHostCommandOwner({ userId: `test-${randomUUID()}`, kind: 'host', id: 'administration' })
    const command = spawnOwnedCommandGroup('/bin/sh', ['-c', 'sleep 30'], {
      env: { PATH: '/usr/bin:/bin' }, ownerPin: pin, sessionId: 'test-session'
    })
    const observed = collect(command)
    await until(() => command.pid !== undefined)
    const [running] = pin.store.records(pin.resources)
    expect(running).toMatchObject({ kind: 'guardian', phase: 'running', sessionId: 'test-session' })
    expect(running.guardianGroup).toBe(running.processes[0]?.pid)
    expect(running.processes[0]?.group).toBe(running.guardianGroup)
    expect(command.kill()).toBe(true)
    await observed.closed
    await until(() => pin.store.records(pin.resources).length === 0)
  })

  it('passes exact argv, cwd, env and output without giving the command guardian IPC', async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'batshit-owned-argv-'))
    try {
      const script = `process.stdout.write(JSON.stringify({argv:process.argv.slice(1),cwd:process.cwd(),env:process.env,ipc:Boolean(process.channel)})+'\\n');process.stderr.write('stderr-marker\\n')`
      const command = spawnOwnedCommandGroup(process.execPath, ['-e', script, '--', 'alpha', 'two words'], {
        cwd, env: { PATH: '/usr/bin:/bin', ONLY_TEST_VALUE: 'exact-value' }
      })
      const observed = collect(command)
      const result = await observed.closed
      expect(result).toEqual({ code: 0, signal: null })
      const { stdout, stderr } = observed.output()
      const payload = JSON.parse(stdout.trim())
      expect(payload.argv).toEqual(['alpha', 'two words'])
      expect(payload.cwd).toBe(await realpath(cwd))
      expect(payload.env.PATH).toBe('/usr/bin:/bin')
      expect(payload.env.ONLY_TEST_VALUE).toBe('exact-value')
      // macOS inserts this encoding variable during exec, independent of Batshit's env.
      expect(Object.keys(payload.env).filter(key => !['PATH', 'ONLY_TEST_VALUE', '__CF_USER_TEXT_ENCODING'].includes(key))).toEqual([])
      expect(payload.ipc).toBe(false)
      expect(command.pid).toBeGreaterThan(0)
      expect(stderr).toBe('stderr-marker\n')
      expect(observed.errors).toEqual([])
      await until(() => liveOwnedCommandCount() === 0)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('keeps a redirected background member owned after foreground exit, then ends it', async () => {
    const command = spawnOwnedCommandGroup('/bin/sh', ['-c', 'sleep 30 </dev/null >/dev/null 2>&1 & printf "BACKGROUND=%s\\n" "$!"'], {
      env: { PATH: '/usr/bin:/bin' }
    })
    const observed = collect(command)
    expect(await observed.closed).toEqual({ code: 0, signal: null })
    const pid = Number(/^BACKGROUND=(\d+)\s*$/.exec(observed.output().stdout)?.[1])
    expect(pid).toBeGreaterThan(0)
    expect(await processIsRunning(pid)).toBe(true)
    expect(liveOwnedCommandCount()).toBe(1)
    expect(command.kill()).toBe(true)
    await until(async () => !(await processIsRunning(pid)))
    await until(() => liveOwnedCommandCount() === 0)
  })

  it('retires a foreground-only group and refuses a late End after its token is gone', async () => {
    const pin = pinHostCommandOwner({ userId: `test-${randomUUID()}`, kind: 'host', id: 'administration' })
    const command = spawnOwnedCommandGroup(process.execPath, ['-e', 'process.stdout.write("done\\n")'], {
      env: { PATH: '/usr/bin:/bin' }, ownerPin: pin
    })
    const observed = collect(command)
    expect(await observed.closed).toEqual({ code: 0, signal: null })
    expect(observed.output().stdout).toBe('done\n')
    await until(() => liveOwnedCommandCount() === 0)
    expect(pin.store.records(pin.resources)).toEqual([])
    expect(command.kill()).toBe(false)
    expect(await endLiveOwnedCommandGroups()).toBe(0)
  })

  it('honors a synchronous End before guardian spawn/readiness without starting the command', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'batshit-owned-early-end-'))
    const marker = path.join(dir, 'must-not-run')
    const pin = pinHostCommandOwner({ userId: `test-${randomUUID()}`, kind: 'host', id: 'administration' })
    try {
      const command = spawnOwnedCommandGroup(process.execPath,
        ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)},'ran')`],
        { env: { PATH: '/usr/bin:/bin' }, ownerPin: pin })
      const observed = collect(command)
      let spawned = false
      command.once('spawn', () => { spawned = true })
      expect(command.kill()).toBe(true)
      await observed.closed
      expect(spawned).toBe(false)
      expect(command.pid).toBeUndefined()
      await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' })
      await until(() => liveOwnedCommandCount() === 0)
      await until(() => pin.store.records(pin.resources).length === 0)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('refuses a deleted owner after pinning and clears the never-started admission', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'batshit-owned-deleted-owner-'))
    const marker = path.join(dir, 'must-not-run')
    const userId = `test-${randomUUID()}`
    const ownerId = `agent-${randomUUID()}`
    const key = `agent:${ownerId}`
    await redis.json.set(key, '$', { user_id: userId })
    const pin = pinHostCommandOwner({ userId, kind: 'agent', id: ownerId })
    const prepare = vi.spyOn(pin.store, 'prepare')
    try {
      // This pin is now stale even though it can still pass the ledger generation check:
      // deletion finished before the guardian's durable admission and final owner check.
      await redis.del(key)
      const command = spawnOwnedCommandGroup(process.execPath,
        ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`],
        { env: { PATH: '/usr/bin:/bin' }, ownerPin: pin })
      const observed = collect(command)
      await observed.closed
      expect(prepare).toHaveBeenCalledOnce()
      expect(command.pid).toBeUndefined()
      expect(observed.errors.some(error => /owner was deleted or is no longer available/i.test(error.message))).toBe(true)
      await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' })
      await until(() => liveOwnedCommandCount() === 0)
      await until(() => pin.store.records(pin.resources).length === 0)
    } finally {
      prepare.mockRestore()
      try {
        await redis.del(key)
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    }
  }, 10_000)

  it('drains large stdout and stderr completely when a foreground guardian retires', async () => {
    const size = 1024 * 1024
    const script = `process.stdout.write('A'.repeat(${size})+'OUT-END');process.stderr.write('B'.repeat(${size})+'ERR-END')`
    const command = spawnOwnedCommandGroup(process.execPath, ['-e', script], { env: { PATH: '/usr/bin:/bin' } })
    const observed = collect(command)
    expect(await observed.closed).toEqual({ code: 0, signal: null })
    expect(observed.output().stdout).toBe('A'.repeat(size) + 'OUT-END')
    expect(observed.output().stderr).toBe('B'.repeat(size) + 'ERR-END')
    expect(observed.errors).toEqual([])
    await until(() => liveOwnedCommandCount() === 0)
  })

  it('makes guardian IPC EOF end its still-running group', async () => {
    const guardian = spawn(process.execPath, [path.join(process.cwd(), 'scripts/command-group-guardian.mjs')], {
      detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' }
    })
    const token = randomUUID()
    let commandPid = 0
    const messages: Array<Record<string, unknown>> = []
    guardian.on('message', message => { messages.push(message as Record<string, unknown>) })
    outputPipe(guardian, 4).resume()
    outputPipe(guardian, 5).resume()
    guardian.send({ version: 1, token, type: 'init', executable: '/bin/sh', args: ['-c', 'sleep 30'], env: { PATH: '/usr/bin:/bin' } })
    try {
      await until(() => messages.some(message => message.type === 'ready'))
      guardian.send({ version: 1, token, type: 'start' })
      await until(() => messages.some(message => message.type === 'command-started'))
      commandPid = Number(messages.find(message => message.type === 'command-started')?.pid)
      expect(await processIsRunning(commandPid)).toBe(true)
      const exited = new Promise<void>(resolve => guardian.once('exit', () => resolve()))
      guardian.disconnect()
      await exited
      await until(async () => !(await processIsRunning(commandPid)))
    } finally {
      if (guardian.connected) guardian.disconnect()
      guardian.kill('SIGKILL')
      outputPipe(guardian, 4).destroy()
      outputPipe(guardian, 5).destroy()
    }
  }, 10_000)

  it('ignores invalid-token control and fake idle/end text written to command stdout', async () => {
    const direct = directGuardian()
    const fake = '{"version":1,"type":"idle","token":"forged"}\n{"type":"end"}\n'
    direct.send('init', {
      executable: process.execPath,
      args: ['-e', `process.stdout.write(${JSON.stringify(fake)});setTimeout(()=>{},5000)`],
      env: { PATH: '/usr/bin:/bin' }
    })
    try {
      await until(() => direct.messages.some(message => message.type === 'ready'))
      direct.send('start', {}, randomUUID())
      await delay(75)
      expect(direct.messages.some(message => message.type === 'command-started')).toBe(false)
      direct.send('start')
      await until(() => direct.messages.some(message => message.type === 'command-started'))
      const pid = Number(direct.messages.find(message => message.type === 'command-started')?.pid)
      await until(() => direct.stdout().includes(fake))
      direct.send('end', {}, randomUUID())
      direct.send('retire', {}, randomUUID())
      await delay(75)
      expect(await processIsRunning(pid)).toBe(true)
      expect(direct.messages.some(message => message.type === 'idle')).toBe(false)
      direct.send('end')
      await direct.exited
      await until(async () => !(await processIsRunning(pid)))
    } finally {
      if (direct.guardian.connected) direct.guardian.disconnect()
      direct.guardian.kill('SIGKILL')
      outputPipe(direct.guardian, 4).destroy()
      outputPipe(direct.guardian, 5).destroy()
    }
  }, 10_000)

  it('freezes signalling on idle: both late End and Retire only exit the guardian', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'batshit-owned-idle-'))
    const calls = path.join(dir, 'group-signals')
    const preload = path.join(dir, 'observe-kill.cjs')
    await writeFile(preload,
      `const fs=require('node:fs');const original=process.kill;process.kill=function(pid,signal){if(pid===0)fs.appendFileSync(${JSON.stringify(calls)},String(signal)+'\\n');return original.call(this,pid,signal)};`)
    try {
      for (const action of ['end', 'retire']) {
        const direct = directGuardian({ NODE_OPTIONS: `--require=${preload}` })
        direct.send('init', { executable: process.execPath, args: ['-e', 'process.stdout.write("finished\\n")'], env: { PATH: '/usr/bin:/bin' } })
        try {
          await until(() => direct.messages.some(message => message.type === 'ready'))
          direct.send('start')
          await until(() => direct.messages.some(message => message.type === 'idle'))
          expect(direct.stdout()).toBe('finished\n')
          direct.send(action)
          await direct.exited
          await expect(access(calls)).rejects.toMatchObject({ code: 'ENOENT' })
        } finally {
          if (direct.guardian.connected) direct.guardian.disconnect()
          direct.guardian.kill('SIGKILL')
          outputPipe(direct.guardian, 4).destroy()
          outputPipe(direct.guardian, 5).destroy()
        }
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 10_000)

  it('handles End before idle by ending the live group and never publishing idle', async () => {
    const direct = directGuardian()
    direct.send('init', {
      executable: process.execPath,
      args: ['-e', 'setTimeout(()=>{},5000)'],
      env: { PATH: '/usr/bin:/bin' }
    })
    try {
      await until(() => direct.messages.some(message => message.type === 'ready'))
      direct.send('start')
      await until(() => direct.messages.some(message => message.type === 'command-started'))
      const pid = Number(direct.messages.find(message => message.type === 'command-started')?.pid)
      expect(await processIsRunning(pid)).toBe(true)
      direct.send('end')
      await direct.exited
      expect(direct.messages.some(message => message.type === 'idle')).toBe(false)
      await until(async () => !(await processIsRunning(pid)))
    } finally {
      if (direct.guardian.connected) direct.guardian.disconnect()
      direct.guardian.kill('SIGKILL')
      outputPipe(direct.guardian, 4).destroy()
      outputPipe(direct.guardian, 5).destroy()
    }
  }, 10_000)

  it('reports unexpected guardian loss without signalling the orphan by a saved group number', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'batshit-owned-loss-'))
    const marker = path.join(dir, 'survived')
    const pin = pinHostCommandOwner({ userId: `test-${randomUUID()}`, kind: 'host', id: 'administration' })
    try {
      const script = `process.kill(process.ppid,'SIGKILL');setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'survived'),300)`
      const command = spawnOwnedCommandGroup(process.execPath, ['-e', script], {
        env: { PATH: '/usr/bin:/bin' }, ownerPin: pin
      })
      const observed = collect(command)
      await observed.closed
      expect(observed.errors.some(error => /guardian exited unexpectedly/i.test(error.message))).toBe(true)
      await until(async () => { try { await access(marker); return true } catch { return false } }, 2_000)
      expect(await readFile(marker, 'utf8')).toBe('survived')
      expect(liveOwnedCommandCount()).toBe(0)
      expect(pin.store.records(pin.resources)).toMatchObject([{ phase: 'unresolved', kind: 'guardian' }])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
