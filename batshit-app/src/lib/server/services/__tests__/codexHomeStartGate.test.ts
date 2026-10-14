import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter, getEventListeners } from 'node:events'
import { PassThrough } from 'node:stream'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * BL-7 — one Codex start at a time per Batshit-managed Codex home.
 *
 * Measured live (2026-09-22, codex-cli 0.139.0, `_local/bug-batch-2026-09-22/codex/`): four
 * turns of one agent started at once on a fresh home, and three Codex processes exited at
 * startup with `failed to initialize sqlite state runtime … duplicate column name` / `table …
 * already exists`. The first half of this file pins the gate itself; the second half pins
 * that the bridge actually holds it around the app-server start and lets the lane free it.
 */

import {
  acquireCodexHomeStart,
  countCodexHomeStartsInFlight
} from '../codexHomeStartGate'

const settleTicks = async (count = 5) => {
  for (let index = 0; index < count; index += 1) await Promise.resolve()
}

describe('acquireCodexHomeStart', () => {
  it('lets the second start in one home begin only after the first releases it', async () => {
    const order: string[] = []
    const releaseFirst = await acquireCodexHomeStart('/tmp/bl7-home-a')
    order.push('first acquired')

    const second = acquireCodexHomeStart('/tmp/bl7-home-a').then((release) => {
      order.push('second acquired')
      return release
    })
    await settleTicks()
    expect(order).toEqual(['first acquired'])

    releaseFirst()
    const releaseSecond = await second
    expect(order).toEqual(['first acquired', 'second acquired'])
    releaseSecond()
    await settleTicks()
    expect(countCodexHomeStartsInFlight()).toBe(0)
  })

  it('never makes a start wait for a different home', async () => {
    const releaseA = await acquireCodexHomeStart('/tmp/bl7-home-a')
    const releaseB = await acquireCodexHomeStart('/tmp/bl7-home-b')
    releaseA()
    releaseB()
    await settleTicks()
    expect(countCodexHomeStartsInFlight()).toBe(0)
  })

  it('treats two spellings of one folder as one home', async () => {
    const order: string[] = []
    const releaseFirst = await acquireCodexHomeStart('/tmp/bl7-home-c/')
    const second = acquireCodexHomeStart('/tmp/bl7-home-c/../bl7-home-c').then((release) => {
      order.push('second acquired')
      return release
    })
    await settleTicks()
    expect(order).toEqual([])
    releaseFirst()
    ;(await second)()
    expect(order).toEqual(['second acquired'])
  })

  // BL-156: the key was `path.resolve`, which leaves a symlink on the way in place, so one home
  // reached by two spellings (a linked HOME, `/tmp` against `/private/tmp`) was two homes and
  // two starts ran at once in it.
  it('treats a home reached through a symlink as the same home', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'bl156-gate-'))
    try {
      const realHome = path.join(root, 'agents', 'batshit_agent_probe', '.codex')
      mkdirSync(realHome, { recursive: true })
      const linkedRoot = path.join(root, 'linked-agents')
      symlinkSync(path.join(root, 'agents'), linkedRoot)
      const linkedHome = path.join(linkedRoot, 'batshit_agent_probe', '.codex')

      const order: string[] = []
      const releaseFirst = await acquireCodexHomeStart(realHome)
      const second = acquireCodexHomeStart(linkedHome).then((release) => {
        order.push('second acquired')
        return release
      })
      try {
        await settleTicks()
        expect(order).toEqual([])
      } finally {
        releaseFirst()
        ;(await second)()
      }
      expect(order).toEqual(['second acquired'])
      await settleTicks()
      expect(countCodexHomeStartsInFlight()).toBe(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('frees a start that never settles once its hold limit passes', async () => {
    vi.useFakeTimers()
    try {
      await acquireCodexHomeStart('/tmp/bl7-home-d', { holdLimitMs: 1000 })
      let secondAcquired = false
      const second = acquireCodexHomeStart('/tmp/bl7-home-d').then((release) => {
        secondAcquired = true
        return release
      })
      await vi.advanceTimersByTimeAsync(999)
      expect(secondAcquired).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(secondAcquired).toBe(true)
      ;(await second)()
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignores a second release', async () => {
    const releaseFirst = await acquireCodexHomeStart('/tmp/bl7-home-e')
    const secondAcquisition = acquireCodexHomeStart('/tmp/bl7-home-e')
    const third = acquireCodexHomeStart('/tmp/bl7-home-e')
    let thirdAcquired = false
    void third.then(() => {
      thirdAcquired = true
    })
    releaseFirst()
    releaseFirst()
    const releaseSecond = await secondAcquisition
    await settleTicks()
    // The first holder's double release must not also free the second holder's turn.
    expect(thirdAcquired).toBe(false)
    releaseSecond()
    ;(await third)()
    await settleTicks()
    expect(countCodexHomeStartsInFlight()).toBe(0)
  })

  /* BL-7 review: a Stop reaches a start that is still waiting its turn. */

  it('ends the wait at once on a Stop, and the start behind it waits only for the one ahead', async () => {
    const releaseFirst = await acquireCodexHomeStart('/tmp/bl7-home-f')
    const stop = new AbortController()
    const second = acquireCodexHomeStart('/tmp/bl7-home-f', { signal: stop.signal })
    let thirdAcquired = false
    const third = acquireCodexHomeStart('/tmp/bl7-home-f').then((release) => {
      thirdAcquired = true
      return release
    })
    await settleTicks()

    stop.abort()
    await expect(within(second, 100)).rejects.toMatchObject({ name: 'AbortError' })

    // The first start still holds the home; the third waits for it, not for the stopped one.
    await settleTicks()
    expect(thirdAcquired).toBe(false)
    releaseFirst()
    const releaseThird = await within(third, 100)
    expect(thirdAcquired).toBe(true)
    ;(releaseThird as () => void)()
    await settleTicks()
    expect(countCodexHomeStartsInFlight()).toBe(0)
  })

  it('never joins the queue for a start whose Stop came first', async () => {
    const stop = new AbortController()
    stop.abort()

    await expect(
      within(acquireCodexHomeStart('/tmp/bl7-home-g', { signal: stop.signal }), 100)
    ).rejects.toMatchObject({ name: 'AbortError' })

    // Nothing holds the home: the next start goes straight through.
    const release = await within(acquireCodexHomeStart('/tmp/bl7-home-g'), 100)
    expect(typeof release).toBe('function')
    ;(release as () => void)()
    await settleTicks()
    expect(countCodexHomeStartsInFlight()).toBe(0)
  })

  it('keeps the hold of a start whose Stop came only after it got its turn', async () => {
    // The Stop of a run that is already starting is the lane's to handle (it frees the gate
    // when the process is gone); acquire() has returned by then and must not let go early.
    const stop = new AbortController()
    const releaseFirst = await acquireCodexHomeStart('/tmp/bl7-home-h', { signal: stop.signal })
    // It left nothing listening on the run's signal, which lives as long as the run.
    expect(getEventListeners(stop.signal, 'abort')).toHaveLength(0)
    stop.abort()
    let secondAcquired = false
    const second = acquireCodexHomeStart('/tmp/bl7-home-h').then((release) => {
      secondAcquired = true
      return release
    })
    await settleTicks()
    expect(secondAcquired).toBe(false)
    releaseFirst()
    ;(await second)()
    await settleTicks()
    expect(countCodexHomeStartsInFlight()).toBe(0)
  })
})

/** Settles with `promise`, or with 'still waiting' after `ms`. */
function within<T>(promise: Promise<T>, ms: number): Promise<T | 'still waiting'> {
  return Promise.race([
    promise,
    new Promise<'still waiting'>((resolve) => setTimeout(() => resolve('still waiting'), ms))
  ])
}

/* ---------------------------------------------------------------------------------------- *
 * The bridge: `runViaAppServer` holds the home until the lane says the start settled.
 * ---------------------------------------------------------------------------------------- */

const laneStarts = vi.hoisted(
  () => [] as Array<{ env: NodeJS.ProcessEnv; onStartupSettled?: () => void }>
)
const spawnMock = vi.hoisted(() => vi.fn())

vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>()
  const spawn = (...args: any[]) => spawnMock(...args)
  return {
    ...original,
    spawn,
    default: { ...((original as any).default ?? original), spawn }
  }
})
// The real gate, wrapped so one test can stand in for the moment its turn is handed over.
vi.mock('../codexHomeStartGate', async (importOriginal) => {
  const original = await importOriginal<typeof import('../codexHomeStartGate')>()
  return { ...original, acquireCodexHomeStart: vi.fn(original.acquireCodexHomeStart) }
})

vi.mock('$lib/server/redis', () => ({ redis: {} }))
vi.mock('../codexProfileManager', () => ({
  ensureManagedCodexHome: vi.fn(),
  // BL-152: the stand-in homes hold no config, so no helper launch to fill.
  readManagedCodexHelperLaunchOverrides: vi.fn(async () => []),
  buildAgentProfileId: (id: string) => `batshit_agent_${id}`,
  DOCKER_AUTH_ENV_VAR: 'BATSHIT_DOCKER_MCP_TOKEN',
  N8N_INSTANCE_MCP_TOKEN_ENV: 'BATSHIT_N8N_INSTANCE_MCP_TOKEN'
}))
// The gate is keyed by stand-in homes such as `/tmp/bl7-bridge-home`. The managed-home check
// (BL-7 review) has its own suite on a throwaway HOME, `codexManagedHome.test.ts`. The
// fallback home would create folders under the REAL `~/.batshit/agents`, so reaching it here
// fails loudly instead.
vi.mock('../codexManagedHome', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../codexManagedHome')>()),
  assertBatshitManagedCodexHome: vi.fn(async () => {}),
  ensureManagedCodexFallbackHome: vi.fn(async () => {
    throw new Error('codexHomeStartGate.test reached the managed fallback home')
  })
}))
vi.mock('../codexAppServerLane', async (importOriginal) => {
  const original = await importOriginal<typeof import('../codexAppServerLane')>()
  return {
    ...original,
    startCodexAppServerRun: (input: any) => {
      laneStarts.push({ env: input.env, onStartupSettled: input.onStartupSettled })
      return {
        events: (async function* () {})(),
        cleanup: async () => {},
        steer: async () => ({ accepted: false, reason: 'test' }),
        process: { lane: laneStarts.length }
      }
    }
  }
})

let CodexBridgeClass: typeof import('../codexBridge').CodexBridge
let codexCliStatusModule: typeof import('../codexCliStatus')

beforeAll(async () => {
  ;({ CodexBridge: CodexBridgeClass } = await import('../codexBridge'))
  codexCliStatusModule = await import('../codexCliStatus')
})

function appServerOptions(managedConfigHome: string | null) {
  return {
    // These private-lane gate tests use fake children. Give each launch an admitted
    // host boundary while the ownership ledger itself is covered in its own suite.
    hostCommandLease: {
      pin: { owner: { userId: 'josh', kind: 'host', id: 'start-gate-test' } },
      markSpawnAttempt: () => {}, complete: () => {}, abortBeforeSpawn: () => {},
      onCleanup: () => {}, observe: () => {}, unresolved: () => {}
    },
    model: 'gpt-5.5',
    permissionMode: 'chat',
    sandboxMode: 'read-only',
    workingDirectory: process.cwd(),
    allowFileEdits: false,
    allowNetwork: false,
    approvalPolicy: 'never',
    webSearchEnabled: false,
    addDirectories: [],
    enableFeatures: [],
    disableFeatures: [],
    configOverrides: [],
    defaultGateways: null,
    profileName: 'batshit_agent_test',
    configScope: managedConfigHome ? 'managed' : 'global',
    managedConfigHome,
    historyPersistence: 'none',
    serviceTier: 'standard',
    unifiedExec: true,
    imagePaths: [],
    sessionId: 'sess-one',
    developerInstructions: 'Stable Batshit system prompt',
    nativeSkillDisablePaths: []
  }
}

describe('CodexBridge app-server start and the BL-7 gate', () => {
  beforeEach(() => {
    laneStarts.length = 0
    vi.spyOn(codexCliStatusModule, 'detectCodexCliStatus').mockResolvedValue({
      available: true,
      executable: '/usr/local/bin/codex',
      version: 'codex-cli 0.139.0'
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('starts the second run of one agent only after the first has settled its start', async () => {
    const bridge = new CodexBridgeClass()
    const home = '/tmp/bl7-bridge-home'

    // Which of the two reaches the gate first depends on their own async setup, so the
    // test only asserts that ONE starts, the other waits, and the settle lets it through.
    const runs = Promise.all([
      (bridge as any).runViaAppServer('first', appServerOptions(home)),
      (bridge as any).runViaAppServer('second', appServerOptions(home))
    ])
    await vi.waitFor(() => expect(laneStarts).toHaveLength(1))
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(laneStarts).toHaveLength(1)
    expect(laneStarts[0]!.env.CODEX_HOME).toBe(home)

    laneStarts[0]!.onStartupSettled?.()
    await runs
    expect(laneStarts).toHaveLength(2)
    laneStarts[1]!.onStartupSettled?.()
  })

  it('does not hold two different agents against each other', async () => {
    const bridge = new CodexBridgeClass()

    const a = await (bridge as any).runViaAppServer('a', appServerOptions('/tmp/bl7-bridge-home-a'))
    const b = await (bridge as any).runViaAppServer('b', appServerOptions('/tmp/bl7-bridge-home-b'))

    expect(laneStarts).toHaveLength(2)
    // BL-287: each runner carries its own lane's process.
    expect([a.process, b.process]).toEqual([{ lane: 1 }, { lane: 2 }])
    laneStarts.forEach((start) => start.onStartupSettled?.())
  })

  it('holds the exec escape hatch the same way, until the first run prints its first line', async () => {
    const children: any[] = []
    spawnMock.mockImplementation(() => {
      const child = new EventEmitter() as any
      child.stdin = new PassThrough()
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      child.killed = false
      child.exitCode = null
      child.signalCode = null
      child.kill = () => {
        child.killed = true
        return true
      }
      children.push(child)
      return child
    })
    const bridge = new CodexBridgeClass()
    const home = '/tmp/bl7-exec-home'

    const runs = Promise.all([
      (bridge as any).runViaCli('first', appServerOptions(home)),
      (bridge as any).runViaCli('second', appServerOptions(home))
    ])
    await vi.waitFor(() => expect(children).toHaveLength(1))
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(children).toHaveLength(1)

    children[0].stdout.write('{"type":"thread.started","thread_id":"thread-1"}\n')
    const runners = await runs
    expect(children).toHaveLength(2)

    children[1].emit('close', 0, null)
    // BL-287: the exec lane's runner carries the process it spawned.
    expect(runners.map((runner: any) => runner.process)).toEqual(expect.arrayContaining(children))
    expect(runners[0].process).not.toBe(runners[1].process)
    for (const runner of runners) await runner.cleanup()
  })

  /* BL-7 review: a Stop reaches a run that waits at the gate, before a runner exists. */

  it('ends an app-server run at once when its Stop lands while it waits, and starts nothing for it', async () => {
    const bridge = new CodexBridgeClass()
    const home = '/tmp/bl7-bridge-stop-home'
    const first = (bridge as any).runViaAppServer('first', appServerOptions(home))
    await vi.waitFor(() => expect(laneStarts).toHaveLength(1))

    const stop = new AbortController()
    const stopped = (bridge as any).runViaAppServer('stopped', {
      ...appServerOptions(home),
      signal: stop.signal
    })
    const next = (bridge as any).runViaAppServer('next', appServerOptions(home))
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(laneStarts).toHaveLength(1)

    stop.abort()
    await expect(within(stopped, 100)).rejects.toMatchObject({ name: 'AbortError' })
    expect(laneStarts).toHaveLength(1)

    // The run behind the stopped one still gets the home once the first start settles.
    laneStarts[0]!.onStartupSettled?.()
    await first
    await within(next, 1000)
    expect(laneStarts).toHaveLength(2)
    laneStarts[1]!.onStartupSettled?.()
  })

  it('ends an exec run at once when its Stop lands while it waits, and spawns nothing for it', async () => {
    const children: any[] = []
    spawnMock.mockImplementation(() => {
      const child = new EventEmitter() as any
      child.stdin = new PassThrough()
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      child.killed = false
      child.exitCode = null
      child.signalCode = null
      child.kill = () => {
        child.killed = true
        return true
      }
      children.push(child)
      return child
    })
    const bridge = new CodexBridgeClass()
    const home = '/tmp/bl7-exec-stop-home'
    const first = (bridge as any).runViaCli('first', appServerOptions(home))
    await vi.waitFor(() => expect(children).toHaveLength(1))

    const stop = new AbortController()
    const stopped = (bridge as any).runViaCli('stopped', {
      ...appServerOptions(home),
      signal: stop.signal
    })
    await new Promise((resolve) => setTimeout(resolve, 30))
    stop.abort()
    await expect(within(stopped, 100)).rejects.toMatchObject({ name: 'AbortError' })
    expect(children).toHaveLength(1)

    const runner = await first
    children[0].emit('close', 0, null)
    await runner.cleanup()
  })

  it('starts nothing for a run whose Stop came before it reached the gate', async () => {
    const bridge = new CodexBridgeClass()
    const stop = new AbortController()
    stop.abort()

    await expect(
      (bridge as any).runViaAppServer('stopped', {
        ...appServerOptions('/tmp/bl7-bridge-prestopped'),
        signal: stop.signal
      })
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(laneStarts).toHaveLength(0)
  })

  it('lets the gate go and starts nothing when the Stop lands just as the turn is handed over', async () => {
    for (const lane of ['runViaAppServer', 'runViaCli'] as const) {
      const stop = new AbortController()
      const release = vi.fn()
      vi.mocked(acquireCodexHomeStart).mockImplementationOnce(async () => {
        // The turn came; the Stop landed before the run could use it.
        stop.abort()
        return release
      })
      spawnMock.mockClear()
      const bridge = new CodexBridgeClass()

      await expect(
        (bridge as any)[lane]('late', { ...appServerOptions('/tmp/bl7-bridge-late'), signal: stop.signal })
      ).rejects.toMatchObject({ name: 'AbortError' })
      expect(release, lane).toHaveBeenCalledTimes(1)
      expect(laneStarts, lane).toHaveLength(0)
      expect(spawnMock, lane).not.toHaveBeenCalled()
    }
  })

  it("leaves a run in the user's own Codex home ungated", async () => {
    const bridge = new CodexBridgeClass()

    await (bridge as any).runViaAppServer('a', appServerOptions(null))
    await (bridge as any).runViaAppServer('b', appServerOptions(null))

    expect(laneStarts).toHaveLength(2)
    expect(laneStarts.every((start) => start.onStartupSettled === undefined)).toBe(true)
  })
})
