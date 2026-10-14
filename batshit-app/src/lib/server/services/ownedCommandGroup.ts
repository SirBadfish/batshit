import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import path from 'node:path'
import type { Readable } from 'node:stream'
import {
  pinHostCommandOwner,
  prepareHostCommand,
  validateHostCommandOwner,
  type HostCommandLease,
  type HostCommandPin
} from './hostCommandOwnership'
import { readHostProcessTable } from './hostProcessIdentity'
import { registerRuntimeShutdownTask } from './runtimeShutdown'

type Owner = {
  token: string
  guardian: ChildProcess
  phase: 'active' | 'ending' | 'retired' | 'lost'
  closed: Promise<void>
  end: () => boolean
  lease: HostCommandLease | null
}
type Registry = { owners: Map<string, Owner>; commands: WeakMap<object, Owner> }
type OwnerGlobal = typeof globalThis & { __batshitOwnedCommandGroupsV1?: Registry }
function registry(): Registry {
  return ((globalThis as OwnerGlobal).__batshitOwnedCommandGroupsV1 ??= {
    owners: new Map(), commands: new WeakMap()
  })
}

/** Command events/output are separate from its guardian's lifetime (background work may remain). */
export class OwnedCommand extends EventEmitter {
  readonly stdout: Readable
  readonly stderr: Readable
  pid: number | undefined
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  constructor(stdout: Readable, stderr: Readable) {
    super()
    this.stdout = stdout
    this.stderr = stderr
  }
  kill(_signal?: NodeJS.Signals): boolean { return endOwnedCommand(this) }
}

/** Spawn exact argv/env through an isolated control channel; never register a bare PID. */
export function spawnOwnedCommandGroup(executable: string, args: string[], options: {
  cwd?: string
  env: NodeJS.ProcessEnv
  /** Pinned before the caller's asynchronous setup; direct host calls use administration. */
  ownerPin?: HostCommandPin
  sessionId?: string | null
  messageId?: string | null
}): OwnedCommand {
  if (process.platform === 'win32') throw new Error('POSIX command guardians are unavailable on Windows.')
  const pin = options.ownerPin ?? pinHostCommandOwner({ userId: 'host', kind: 'host', id: 'administration' })
  const token = randomUUID()
  const guardian = spawn(process.execPath, [path.join(process.cwd(), 'scripts/command-group-guardian.mjs')], {
    // Do not let a command-supplied NODE_OPTIONS preload code into its guardian.
    env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' },
    // Keep the guardian's standard descriptors valid. Closing both 1 and 2 before a
    // later process scan aborts official Node builds; command output has its own pipes.
    detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc', 'pipe', 'pipe']
  })
  // Node's declaration caps the stdio tuple at five entries; our explicit pipe layout
  // has six. Both extra descriptors are readable parent ends, never command inputs.
  const outputPipes = guardian.stdio as Array<Readable | null | undefined>
  const command = new OwnedCommand(outputPipes[4]!, outputPipes[5]!)
  const registered = registry()
  let resolveClosed!: () => void
  let exited = false
  let closed = false
  let outputClosed = false
  let errorClosed = false
  let ready = false
  let initialized = false
  let startSent = false
  let setupFailed = false
  const owner: Owner = {
    token, guardian, phase: 'active', lease: null,
    closed: new Promise<void>(resolve => { resolveClosed = resolve }),
    end: () => {
      // Exact object/token identity, including every delayed call after retirement or reload.
      if (registered.owners.get(token) !== owner || owner.phase !== 'active') return false
      owner.phase = 'ending'
      if (initialized) send('end')
      return true
    }
  }
  registered.owners.set(token, owner)
  registered.commands.set(command, owner)
  registerRuntimeShutdownTask('command-groups', async () => { await endLiveOwnedCommandGroups() })

  // The guardian may exist before the async boot/ledger read, but it cannot execute anything
  // until `ready` has awaited this durable prepare and a verified birth/group observation.
  const prepared = prepareHostCommand(pin, {
    kind: 'guardian', program: executable,
    sessionId: options.sessionId, messageId: options.messageId
  }).then(lease => {
    owner.lease = lease
    lease.onCleanup(async () => { owner.end(); await owner.closed })
    return lease
  })
  // `ready` may arrive after preparation fails; mark the rejection handled immediately.
  void prepared.catch(() => {})

  function send(type: string, fields = {}) {
    if (!guardian.connected) return
    guardian.send!({ version: 1, token, type, ...fields }, error => {
      if (error && owner.phase !== 'retired' && owner.phase !== 'lost') {
        console.warn('[Command ownership] Guardian control write failed; no numeric signal fallback.', error.message)
        // Closing the endpoint asks the live guardian to clean its own group.
        if (guardian.connected) guardian.disconnect()
      }
    })
  }
  function maybeClose() {
    if (!closed && exited && outputClosed && errorClosed) {
      closed = true
      command.emit('close', command.exitCode, command.signalCode)
    }
  }
  function finish(code: number | null, signal: NodeJS.Signals | null) {
    if (exited) return
    exited = true
    command.exitCode = code
    command.signalCode = signal
    command.emit('exit', code, signal)
    maybeClose()
  }
  function fail(message: string) {
    console.warn('[Command ownership]', message)
    if (!closed) command.emit('error', new Error(message))
  }
  function leaveUnresolved(message: string) {
    console.warn('[Command ownership]', message)
    try { owner.lease?.unresolved() } catch (error) {
      console.error('[Command ownership] Could not persist unresolved guardian state:', error)
    }
    owner.lease?.lostController()
  }
  async function groupIsEmpty(): Promise<boolean> {
    const group = guardian.pid
    if (!Number.isSafeInteger(group) || !group || group <= 0) return false
    const table = await readHostProcessTable()
    return ![...table.values()].some(row => row.group === group && !row.state.startsWith('Z'))
  }
  async function startAfterRecordedReady() {
    try {
      const lease = await prepared
      if (owner.phase !== 'active' || !guardian.connected) return
      // A stale request can arrive after deletion already advanced the generation. The
      // durable admission now excludes deletion while we revalidate its actual owner.
      await validateHostCommandOwner(pin.owner)
      if (owner.phase !== 'active' || !guardian.connected) return
      const guardianPid = guardian.pid
      if (!Number.isSafeInteger(guardianPid) || !guardianPid || guardianPid <= 0) {
        throw new Error('Guardian has no verifiable process identity.')
      }
      const guardianIdentity = (await readHostProcessTable()).get(guardianPid)
      if (!guardianIdentity || guardianIdentity.group !== guardianPid || guardianIdentity.state.startsWith('Z')) {
        throw new Error('Guardian birth and process group could not be verified.')
      }
      // No executable has started. The saved birth/group lets recovery inspect this exact
      // group after an app crash without ever treating its numeric PID as signal authority.
      lease.observe([guardianIdentity], guardianPid)
      if (owner.phase !== 'active' || !guardian.connected) return
      startSent = true
      send('start')
    } catch (error) {
      setupFailed = true
      fail(`Command guardian ownership was not recorded: ${error instanceof Error ? error.message : String(error)}`)
      owner.end()
    }
  }
  command.stdout.once('close', () => { outputClosed = true; maybeClose() })
  command.stderr.once('close', () => { errorClosed = true; maybeClose() })

  const startupTimer = setTimeout(() => {
    if (ready || owner.phase !== 'active') return
    setupFailed = true
    fail('Command guardian did not become ready; the command was not confirmed started.')
    owner.end()
  }, 5_000)
  guardian.on('message', (raw: unknown) => {
    if (!raw || typeof raw !== 'object') return
    const message = raw as Record<string, unknown>
    if (message.version !== 1 || message.token !== token || registered.owners.get(token) !== owner) return
    switch (message.type) {
      case 'ready':
        ready = true
        clearTimeout(startupTimer)
        if (owner.phase === 'active') void startAfterRecordedReady()
        break
      case 'command-started':
        if (typeof message.pid !== 'number' || !Number.isSafeInteger(message.pid) || message.pid <= 0) return
        command.pid = message.pid
        command.emit('spawn')
        break
      case 'command-exit':
        if (message.code !== null && (!Number.isInteger(message.code) || typeof message.code !== 'number')) return
        if (message.signal !== null && typeof message.signal !== 'string') return
        finish(message.code as number | null, message.signal as NodeJS.Signals | null)
        break
      case 'spawn-error':
      case 'failure':
        fail(typeof message.message === 'string' ? message.message : 'Command guardian failed.')
        break
      case 'warning':
        console.warn('[Command ownership]', message.message, message.pids ?? '')
        break
      case 'idle':
        // Guardian has already frozen signals. Revoke before sending retire, even if Stop was
        // queued concurrently. The channel is ordered; neither side may revive this owner.
        try {
          if (!startSent || !owner.lease) throw new Error('Guardian idled without a recorded start.')
          owner.lease.complete()
        } catch (error) {
          leaveUnresolved(`Guardian idled but its durable completion failed: ${error instanceof Error ? error.message : String(error)}`)
        }
        owner.phase = 'retired'
        registered.owners.delete(token)
        send('retire')
        break
    }
  })
  guardian.once('error', error => {
    registered.owners.delete(token)
    owner.phase = 'lost'
    clearTimeout(startupTimer)
    fail(`Command guardian failed to spawn: ${error.message}`)
    finish(null, null)
    command.stdout.destroy()
    command.stderr.destroy()
    void prepared.then(lease => {
      // Only absence of a spawned PID proves no guardian executed. ChildProcess may also
      // emit errors for a control operation after spawn; those cannot authorize completion.
      if (guardian.pid !== undefined) {
        leaveUnresolved('Guardian control failed after spawn; its record remains for recovery.')
        if (guardian.connected) guardian.disconnect()
        return
      }
      try { lease.complete() } catch (failure) {
        leaveUnresolved(`Could not clear a failed guardian spawn: ${failure instanceof Error ? failure.message : String(failure)}`)
      }
    }).catch(failure => {
      console.warn('[Command ownership] Guardian preparation also failed:', failure)
    }).finally(resolveClosed)
  })
  guardian.once('exit', (_code, signal) => {
    clearTimeout(startupTimer)
    const priorPhase = owner.phase
    const expected = priorPhase === 'ending' || priorPhase === 'retired'
    registered.owners.delete(token)
    owner.phase = 'lost'
    if (!expected) fail('Command guardian exited unexpectedly. Cleanup is unverified; no saved process number was signalled.')
    finish(null, signal)
    // A process outside the group may hold a pipe after guardian loss. Do not conceal the
    // failure by waiting forever, and never signal that process by a saved number.
    if (!expected) {
      command.stdout.destroy()
      command.stderr.destroy()
    }
    void prepared.then(async lease => {
      if (priorPhase === 'retired') return // The trusted idle event completed or retained it.
      if (!startSent) {
        // This live controller never sent start, and its exact guardian has now exited.
        // Unlike recovery after a crash, it can certify no user executable was launched.
        try { lease.complete() } catch (error) {
          leaveUnresolved(`Could not record cancelled command admission: ${error instanceof Error ? error.message : String(error)}`)
        }
        return
      }
      if (!expected || setupFailed) {
        leaveUnresolved('Guardian control ended without verified cleanup; its record remains for recovery.')
        return
      }
      try {
        if (!(await groupIsEmpty())) throw new Error('The guardian group is not verified empty.')
        lease.complete()
      } catch (error) {
        leaveUnresolved(`Guardian ended, but cleanup is unverified: ${error instanceof Error ? error.message : String(error)}`)
      }
    }).catch(error => {
      console.warn('[Command ownership] Guardian preparation failed before completion:', error)
    }).finally(resolveClosed)
  })
  guardian.once('spawn', () => {
    send('init', { executable, args, cwd: options.cwd, env: options.env })
    initialized = true
    if (owner.phase === 'ending') send('end')
  })
  return command
}

export function endOwnedCommand(command: OwnedCommand | ChildProcess): boolean {
  const owner = registry().commands.get(command)
  if (!owner) throw new Error('Command has no live guardian ownership; numeric group signalling is forbidden.')
  return owner.end()
}

export function liveOwnedCommandCount(): number { return registry().owners.size }

export async function endLiveOwnedCommandGroups(): Promise<number> {
  const owners = [...registry().owners.values()]
  for (const owner of owners) owner.end()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      Promise.all(owners.map(owner => owner.closed)),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Command guardian cleanup did not finish within 3 seconds.')), 3_000)
        timer.unref()
      })
    ])
  } finally { clearTimeout(timer) }
  return owners.length
}
