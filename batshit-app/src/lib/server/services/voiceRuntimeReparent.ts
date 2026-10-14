import { spawn } from 'node:child_process'

// Starting a local runtime so that no launcher's process-tree kill can reach it (BL-1252, BL-1258).
//
// A runtime spawned `detached` leads its own session and process group, which keeps it out of
// every stop that signals a process group (the Mac supervisor, launchd, the Docker operator). It
// does not keep it out of a stop that walks parent links: Pinokio's Stop SIGKILLs every process
// whose parent chain leads to the step's shell (kill-sync's tree mode), and the native launcher's
// teardown walks the app's tree the same way. A runtime whose parent was still the app died there
// even with "Stop with Batshit" off. So a short-lived intermediate starts the runtime and exits:
// the runtime's parent becomes launchd (or init), and only its launch record and its "Stop with
// Batshit" choice decide when it stops.
//
// Until its launch record exists, the runtime belongs to the intermediate. As long as it is the
// runtime's parent and has not reaped it, the runtime's pid cannot belong to anyone else, so the
// intermediate can stop the runtime's group with no pid-reuse risk; the app never kills by pid.
// One launch per intermediate:
// - the app spawns `node -e INTERMEDIATE_SOURCE` with only PATH and LC_ALL in its environment (no
//   NODE_OPTIONS can preload code into it, no secret is in it) and an IPC channel. Its first
//   message is `ready`;
// - the app sends `launch`: the runtime's command, args, cwd and environment. The environment can
//   carry saved API keys, so it travels only over the channel, never on argv;
// - the intermediate spawns the runtime `detached` (it leads its own group, so its pid is the group
//   every stopper signals), answers `spawned` with its pid and writes that pid to the runtime's log,
//   waits for `spawn` and then 200 ms, and answers `started`, or `exited` when the runtime ended
//   inside that window, or `failed` when it could not start;
// - the app writes the launch record (`adopt`), sends `adopted`, and the intermediate exits 0. Only
//   then does the app answer the pid.
// Whatever ends the handover early and the intermediate can catch (the app aborts or dies; a
// SIGTERM, SIGINT, SIGHUP, SIGQUIT, SIGUSR2 or SIGALRM to it; an error in it), it stops the runtime's
// group first and exits 3. The gap: an end it cannot catch (a SIGKILL of the intermediate alone, a
// fatal abort of its Node) before the record leaves a runtime that nothing records. The app then
// names its pid when the intermediate had reported it, and the runtime's log names it once it ran.
//
// This module imports only Node built-ins, so a test can load it in a plain Node process.

const INTERMEDIATE_SOURCE = String.raw`
'use strict'
const { spawn } = require('node:child_process')
const { openSync } = require('node:fs')
const HANDED_OVER = 0
const ENDED = 3
let child = null
let handedOver = false
function childRuns() {
  return child !== null && typeof child.pid === 'number' && child.exitCode === null && child.signalCode === null
}
function stopChildAndExit() {
  if (!handedOver && childRuns()) {
    // Still this process's own, unreaped child: its group is the runtime's and nobody else's.
    try { process.kill(-child.pid, 'SIGKILL') } catch {}
    try { process.stderr.write('[Batshit] stopped engine process ' + child.pid + ': it was not handed over.\n') } catch {}
  }
  process.exit(ENDED)
}
function tell(message, then) {
  try { process.send(message, then) } catch { stopChildAndExit() }
}
process.once('disconnect', () => { if (!handedOver) stopChildAndExit() })
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGQUIT', 'SIGUSR2', 'SIGALRM']) process.once(signal, stopChildAndExit)
process.once('uncaughtException', stopChildAndExit)
tell({ type: 'ready', node: process.versions.node })
process.on('message', (message) => {
  if (message && message.type === 'launch' && child === null) {
    launch(message)
  } else if (message && message.type === 'abort') {
    stopChildAndExit()
  } else if (message && message.type === 'adopted' && child !== null) {
    handedOver = true
    child.unref()
    process.exit(HANDED_OVER)
  }
})
function launch(spec) {
  try {
    // Slot 3 holds this process's channel to the app. /dev/null there keeps the channel out of the
    // runtime on systems where a child would otherwise inherit it (Linux).
    const empty = openSync('/dev/null', 'r')
    child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
      detached: true,
      stdio: ['ignore', 1, 2, empty]
    })
  } catch (error) {
    child = null
    tell({ type: 'failed', message: String((error && error.message) || error), code: error && error.code }, () => process.exit(ENDED))
    return
  }
  let answered = false
  child.once('error', (error) => {
    if (answered) return
    answered = true
    // Exit 3 always means "stopped, or had none": stop it if it runs at all.
    tell({ type: 'failed', message: error.message, code: error.code }, stopChildAndExit)
  })
  child.once('exit', (code, signal) => {
    if (answered) return
    answered = true
    tell({ type: 'exited', code, signal }, () => process.exit(ENDED))
  })
  child.once('spawn', () => {
    try { process.stderr.write('[Batshit] engine launcher started process ' + child.pid + ': ' + spec.command + '\n') } catch {}
    tell({ type: 'spawned', pid: child.pid })
    setTimeout(() => {
      if (answered || !childRuns()) return
      answered = true
      tell({ type: 'started', pid: child.pid })
    }, 200)
  })
}
`

// The intermediate's exit code when it stopped its runtime, or had none (0 means handed over).
const ENDED = 3

// The intermediate's whole environment: enough for Node to run, nothing to preload, no secret.
const INTERMEDIATE_ENV = { PATH: '/usr/bin:/bin', LC_ALL: 'C' }

// The intermediate runs on `process.execPath`, so that must be plain Node. It is in every lane that
// launches runtimes: the Mac app's bundled `bin/node` under its supervisor, Pinokio's Node under
// `cli.mjs run app`, and the Node of `npm run dev` in the native lane. Anything else fails fast:
// inside Electron before spawning, otherwise when no `ready` arrives in time.
export type ReparentTiming = {
  readyTimeoutMs: number
  /** From the intermediate's start to `started`: covers its own start and the 200 ms window. */
  startedTimeoutMs: number
  /** After `adopted`, for the intermediate to exit. */
  handOverTimeoutMs: number
  /** After the app gives up, for the intermediate to stop its runtime and exit. */
  abortGraceMs: number
}

const DEFAULT_TIMING: ReparentTiming = {
  readyTimeoutMs: 5_000,
  startedTimeoutMs: 10_000,
  handOverTimeoutMs: 5_000,
  abortGraceMs: 2_000
}

export type ReparentedRuntimeLaunch = {
  command: string
  args: string[]
  cwd: string
  /** The runtime's whole environment. Sent over the IPC channel, never on argv. */
  env: NodeJS.ProcessEnv
  /** Open file descriptors the runtime writes its stdout and stderr to. */
  stdoutFd: number
  stderrFd: number
}

type IntermediateMessage =
  | { type: 'ready'; node: string }
  | { type: 'spawned'; pid: number }
  | { type: 'started'; pid: number }
  | { type: 'exited'; code: number | null; signal: string | null }
  | { type: 'failed'; message: string; code?: string }

function describeEnd(code: number | null, signal: string | null): string {
  return code !== null ? `code ${code}` : signal ?? 'unknown'
}

function isPid(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

/**
 * Start a local runtime whose parent is not this process. `adopt(pid)` writes its launch record
 * while the intermediate still owns it; the pid (the runtime's own, leading its own process group)
 * is answered only once that record exists and the intermediate has exited. Rejects when the
 * runtime could not start or ended inside the first 200 ms, when `adopt` fails, and when the
 * intermediate fails. The runtime is never started any other way. When the intermediate confirms
 * the stop (exit 3), the error says nothing more; otherwise it names the pid that may still run.
 */
export function spawnReparentedRuntime(
  launch: ReparentedRuntimeLaunch,
  adopt: (pid: number) => Promise<void>,
  timing: Partial<ReparentTiming> = {}
): Promise<number> {
  const limits = { ...DEFAULT_TIMING, ...timing }
  if (process.versions.electron) {
    return Promise.reject(
      new Error(
        `Batshit cannot start local engines from inside Electron (${process.execPath}): its engine launcher needs plain Node.`
      )
    )
  }
  return new Promise<number>((resolve, reject) => {
    let phase: 'starting' | 'adopting' | 'handing-over' = 'starting'
    let settled = false
    // The runtime's pid once the intermediate reported it, while it may still run.
    let spawnedPid: number | null = null
    let recorded = false
    let failure: Error | null = null
    // How the intermediate ended while the record was being written, if it did.
    let endedDuringAdopt: { code: number | null; signal: string | null } | null = null
    const timers = new Set<ReturnType<typeof setTimeout>>()

    const intermediate = spawn(process.execPath, ['-e', INTERMEDIATE_SOURCE], {
      env: { ...INTERMEDIATE_ENV },
      stdio: ['ignore', launch.stdoutFd, launch.stderrFd, 'ipc']
    })

    function after(ms: number, then: () => void) {
      const timer = setTimeout(() => {
        timers.delete(timer)
        then()
      }, ms)
      timers.add(timer)
      return timer
    }

    function clearTimers() {
      for (const timer of timers) clearTimeout(timer)
      timers.clear()
    }

    function settle(outcome: number | Error) {
      if (settled) return
      settled = true
      clearTimers()
      if (intermediate.connected) intermediate.disconnect()
      intermediate.unref()
      if (typeof outcome === 'number') resolve(outcome)
      else reject(outcome)
    }

    // What may still run when the intermediate did not stop it: its pid, and whether a record names it.
    function withLeftover(error: Error): Error {
      if (spawnedPid === null) return error
      error.message += recorded
        ? ` Engine process ${spawnedPid} may still be running; its launch record names it.`
        : ` Engine process ${spawnedPid} may still be running, and Batshit has no record of it: stop it with "kill -TERM -${spawnedPid}".`
      return error
    }

    // The launch has failed. When `askToStop`, `abort` tells the intermediate to stop its runtime
    // and exit 3. (Not a `disconnect()` from this side: after one, Node never emits `close`.)
    // Either way it must end within the grace, or it is killed and the error names what may run.
    function fail(error: Error, askToStop: boolean) {
      if (settled || failure) return
      failure = error
      clearTimers()
      if (askToStop) {
        try {
          intermediate.send({ type: 'abort' }, () => undefined)
        } catch {
          // The channel is already closed: the intermediate is gone or going, and its end answers.
        }
      }
      after(limits.abortGraceMs, () => {
        intermediate.kill('SIGKILL')
        settle(withLeftover(error))
      })
    }

    const readyTimer = after(limits.readyTimeoutMs, () => {
      fail(
        new Error(
          `The local engine launcher did not start within ${limits.readyTimeoutMs / 1000} seconds (${process.execPath} must be Node).`
        ),
        true
      )
    })
    after(limits.startedTimeoutMs, () => {
      fail(
        new Error(`The local engine launcher did not report the engine within ${limits.startedTimeoutMs / 1000} seconds.`),
        true
      )
    })

    intermediate.once('error', (error) => {
      // It never ran, so there is nothing of it to stop.
      settle(new Error(`The local engine launcher could not start: ${error.message}`))
    })

    // `close`, not `exit`: it comes only after the channel has delivered everything the
    // intermediate sent, so nothing it said before it exited is missed. Once the launch has
    // failed nothing it says matters, so `exit` is enough then.
    intermediate.once('close', ended)
    intermediate.once('exit', (code, signal) => {
      if (failure) ended(code, signal)
    })

    function ended(code: number | null, signal: string | null) {
      if (phase === 'adopting' && !failure) {
        // The record is still being written: decide when it is done.
        endedDuringAdopt = { code, signal }
        return
      }
      if (phase === 'handing-over' && !failure && code !== ENDED) {
        // The record exists and the intermediate is gone: the runtime's parent is launchd or init.
        settle(spawnedPid as number)
        return
      }
      if (code === ENDED) {
        // The intermediate stopped its runtime, or it had none.
        settle(failure ?? new Error('The local engine launcher stopped the engine before it was handed over.'))
        return
      }
      settle(
        withLeftover(
          failure ??
            new Error(`The local engine launcher ended before it handed over the engine (${describeEnd(code, signal)}).`)
        )
      )
    }

    function handOver(pid: number) {
      recorded = true
      if (settled || failure) return
      const ended = endedDuringAdopt
      if (ended) {
        // It ended while the record was written. Exit 3 means it stopped the runtime first; any
        // other end (a SIGKILL) left the runtime to launchd or init, and the record now names it.
        if (ended.code === ENDED) {
          settle(new Error('The local engine launcher stopped the engine before it was handed over.'))
        } else {
          settle(pid)
        }
        return
      }
      phase = 'handing-over'
      // From here only the intermediate's end decides: exit 3 means it stopped the runtime (its
      // `close` may still be on its way while this send fails); any other end leaves the recorded
      // runtime to launchd or init. One that does not end in time is killed, which is the second.
      after(limits.handOverTimeoutMs, () => intermediate.kill('SIGKILL'))
      try {
        intermediate.send({ type: 'adopted' }, () => undefined)
      } catch {
        // The channel is already closed; its `close` answers.
      }
    }

    function adoptFailed(error: unknown) {
      const reason = error instanceof Error ? error : new Error(String(error))
      if (endedDuringAdopt) {
        // Nothing records the runtime, and its intermediate is already gone.
        settle(endedDuringAdopt.code === ENDED ? reason : withLeftover(reason))
        return
      }
      fail(reason, true)
    }

    intermediate.on('message', (message: IntermediateMessage) => {
      if (settled) return
      if (failure) {
        // Nothing it says changes the outcome now, but its runtime's pid lets the error name it.
        if (message?.type === 'spawned' && spawnedPid === null && isPid(message.pid) && message.pid !== intermediate.pid) {
          spawnedPid = message.pid
        }
        return
      }
      switch (message?.type) {
        case 'ready':
          clearTimeout(readyTimer)
          timers.delete(readyTimer)
          return
        case 'spawned':
          if (spawnedPid === null && isPid(message.pid) && message.pid !== intermediate.pid) {
            spawnedPid = message.pid
            return
          }
          fail(new Error('The local engine launcher reported no usable process id for the engine.'), true)
          return
        case 'exited':
          // The runtime is gone, and the intermediate exits by itself.
          spawnedPid = null
          fail(new Error(`Local engine launch exited immediately (${describeEnd(message.code, message.signal)}).`), false)
          return
        case 'failed': {
          const error = new Error(message.message || 'Local engine launch failed.') as NodeJS.ErrnoException
          if (message.code) error.code = message.code
          fail(error, false)
          return
        }
        case 'started': {
          const pid = message.pid
          if (phase !== 'starting' || !isPid(pid) || pid !== spawnedPid) {
            fail(new Error('The local engine launcher reported no usable process id for the engine.'), true)
            return
          }
          phase = 'adopting'
          clearTimers()
          Promise.resolve()
            .then(() => adopt(pid))
            .then(() => handOver(pid), adoptFailed)
          return
        }
        default:
          fail(new Error('The local engine launcher sent an answer Batshit does not know.'), true)
      }
    })

    try {
      intermediate.send(
        {
          type: 'launch',
          version: 1,
          command: launch.command,
          args: launch.args,
          cwd: launch.cwd,
          env: launch.env
        },
        (error) => {
          if (error) fail(new Error(`Batshit could not hand the engine to its launcher: ${error.message}`), true)
        }
      )
    } catch (error) {
      fail(
        new Error(
          `Batshit could not hand the engine to its launcher: ${error instanceof Error ? error.message : String(error)}`
        ),
        true
      )
    }
  })
}
