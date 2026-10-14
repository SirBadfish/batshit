import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { redis } from '$lib/server/redis'
import { nativeToolService } from '../nativeTools'

/**
 * BL-878, step 1 — the dispatch REFUSES what the CLI lane is no longer offered (Josh, 2026-09-28,
 * 19:50 EDT: Codex and Claude agents have their own Bash; Batshit does not give them its own as
 * well). Hiding the helper is not enough: tool discovery is an authorization contract, so a call
 * that arrives anyway is refused with `ACTION_DISABLED`, and nothing runs.
 *
 * Two doors start a process under Batshit's rules: `bash_execute`, and `native_skill` with
 * `script_run`. Each is refused on the AGENT lane, the lane a run credential authenticates on
 * (only `CodexBridge` and `ClaudeBridge` mint one; the route passes it as `actorType`). The lane
 * is never read from the body: `context.mode` and `primary_agent_type` are claims.
 *
 * The skill refusal reads the action the way `nativeTools.ts` PARSES it (Cooper's condition):
 * the wrapped forms (`input`, `arguments`, `value`, a JSON string) and the aliases (`run`,
 * `run_script`, `script-run`) all end as `script_run`, and each is refused; a check of the raw
 * `action` alone would let them through. Session and service callers are not changed.
 *
 * The saved settings below GRANT Bash (on, Dangerous mode, local backend), so a refusal is the
 * dispatch's own doing and not a missing grant, and a marker file proves whether a process ran.
 */

const skillMocks = vi.hoisted(() => ({ resolveSkillRuntimeForTool: vi.fn() }))

vi.mock('../skillRuntimeToolService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../skillRuntimeToolService')>()),
  resolveSkillRuntimeForTool: skillMocks.resolveSkillRuntimeForTool
}))

const AGENT_ID = 'agent-bl878-refusal'
const BASH_REFUSAL =
  "Batshit's Bash helper is not offered to Codex and Claude agents. Use your own shell tool."
const SCRIPT_REFUSAL =
  'Batshit does not run skill scripts for Codex and Claude agents. Read the skill with native_skill (invoke or read), then run its script with your own shell tool.'

let workspace = ''
let marker = ''

beforeEach(async () => {
  vi.clearAllMocks()
  workspace = await mkdtemp(path.join(os.tmpdir(), 'bl878-refusal-'))
  marker = path.join(workspace, 'ran')
  // A real skill bundle: `scripts/run.sh` writes the marker, so a run is visible on disk.
  const cacheDir = path.join(workspace, 'skill-cache')
  await mkdir(path.join(cacheDir, 'scripts'), { recursive: true })
  await writeFile(path.join(cacheDir, 'scripts', 'run.sh'), `printf ran > '${marker}'\n`)
  skillMocks.resolveSkillRuntimeForTool.mockResolvedValue({
    runtime: {
      skill: { id: 'skill-alpha', name: 'skill-alpha', displayName: 'Skill Alpha' },
      cacheDir,
      bundleFiles: [
        { path: 'scripts/run.sh', kind: 'script', encoding: 'utf8', content: '', sha256: 'abc', size: 1 }
      ]
    },
    error: null
  })
  await redis.set(`agent:${AGENT_ID}`, {
    id: AGENT_ID,
    user_id: 'josh',
    provider_specific_settings: {
      nativeTools: { executionBackend: 'local', bashEnabled: true, bashAccessMode: 'dangerous' }
    }
  } as any)
})

afterEach(async () => {
  vi.restoreAllMocks()
  await redis.del(`agent:${AGENT_ID}`)
  if (workspace) await rm(workspace, { recursive: true, force: true })
})

const ranMarker = async () => (await readFile(marker, 'utf8').catch(() => null)) === 'ran'

function dispatch(
  lane: string | undefined,
  action: string,
  payloadInput: unknown,
  context: Record<string, unknown> = {},
  extra: Record<string, unknown> = {}
) {
  return nativeToolService.dispatchNativeAutomationPackAction({
    userId: 'josh',
    action,
    payloadInput,
    context: {
      session_id: 'session-bl878',
      agent_id: AGENT_ID,
      mode: 'mode4',
      actor_type: 'primary',
      ...context
    },
    projectPath: workspace,
    actorType: lane,
    ...extra
  } as any) as Promise<Record<string, any>>
}

const bashInput = () => ({ command: `printf ran > '${marker}'` })
const skillInput = (action: string) => ({ skillId: 'skill-alpha', action, path: 'scripts/run.sh' })

function expectRefused(result: Record<string, any>, message: string) {
  expect(result.success).toBe(false)
  expect(result.error).toMatchObject({ code: 'ACTION_DISABLED', message })
}

describe('BL-878: Bash through the dispatch, on the agent lane', () => {
  it('refuses bash_execute for a credential-bound run, though its saved settings grant Bash', async () => {
    const result = await dispatch('agent', 'bash_execute', bashInput())

    expectRefused(result, BASH_REFUSAL)
    expect(await ranMarker()).toBe(false)
  })

  it('refuses before any settings read that could grant it', async () => {
    const getAgent = vi.spyOn(redis, 'get')
    const getJson = vi.spyOn(redis.json, 'get')

    const result = await dispatch('agent', 'bash_execute', bashInput())

    expectRefused(result, BASH_REFUSAL)
    expect(getAgent).not.toHaveBeenCalled()
    expect(getJson).not.toHaveBeenCalled()
  })

  it('refuses a delegated run (a CLI Subagent or a Worker) whose credential says Bash is on', async () => {
    const result = await dispatch('agent', 'bash_execute', bashInput(), {}, {
      delegatedRun: true,
      delegatedBashEnabled: true,
      processOwner: { userId: 'josh', kind: 'subagent', id: 'sub-bl878' }
    })

    expectRefused(result, BASH_REFUSAL)
    expect(await ranMarker()).toBe(false)
  })

  it.each([
    { mode: 'mode1' },
    { mode: 'mode2' },
    { mode: 'mode3' },
    { mode: 'mode3', primary_agent_type: 'api' },
    { mode: undefined, primary_agent_type: 'api' },
    { actor_type: 'subagent', parent_agent_id: AGENT_ID }
  ])('still refuses an agent-lane call whose body claims another lane (%j)', async (claim) => {
    const result = await dispatch('agent', 'bash_execute', bashInput(), claim)

    expectRefused(result, BASH_REFUSAL)
    expect(await ranMarker()).toBe(false)
  })

  it.each(['service', 'session', 'n8n-callback', undefined])(
    'does not change the %s caller: the same settings still run the command',
    async (lane) => {
      const result = await dispatch(lane, 'bash_execute', bashInput())

      expect(result.error).toBeUndefined()
      expect(result.success).toBe(true)
      expect(await ranMarker()).toBe(true)
    }
  )

  it.each([
    { mode: 'mode4', primary_agent_type: 'cli' },
    { mode: undefined, primary_agent_type: 'cli' }
  ])('never refuses a caller that is not on the agent lane because its body says cli (%j)', async (claim) => {
    const result = await dispatch('service', 'bash_execute', bashInput(), claim)

    expect(result.error).toBeUndefined()
    expect(result.success).toBe(true)
    expect(await ranMarker()).toBe(true)
  })
})

describe('BL-878: a skill script through the dispatch, on the agent lane', () => {
  // Every spelling `nativeTools.ts` parses as `script_run`: the action's aliases (also with
  // spaces, dashes, and capitals), and the wrappers a model or a client puts around the input.
  const aliases = ['script_run', 'run', 'run_script', 'script-run', 'Run Script', 'SCRIPT_RUN', ' script_run ']
  const wrappers: Array<[string, (inner: Record<string, unknown>) => unknown]> = [
    ['top level', (inner) => inner],
    ['input', (inner) => ({ input: inner })],
    ['arguments', (inner) => ({ arguments: inner })],
    ['value (object)', (inner) => ({ value: inner })],
    ['value (JSON text)', (inner) => ({ value: JSON.stringify(inner) })],
    ['arguments.value (object)', (inner) => ({ arguments: { value: inner } })],
    ['arguments.value (JSON text)', (inner) => ({ arguments: { value: JSON.stringify(inner) } })]
  ]

  for (const alias of aliases) {
    for (const [wrapperName, wrap] of wrappers) {
      it(`refuses action ${JSON.stringify(alias)} sent as ${wrapperName}`, async () => {
        const result = await dispatch('agent', 'native_skill', wrap(skillInput(alias)))

        expectRefused(result, SCRIPT_REFUSAL)
        // Before any skill runtime, cache, or process work.
        expect(skillMocks.resolveSkillRuntimeForTool).not.toHaveBeenCalled()
        expect(await ranMarker()).toBe(false)
      })
    }
  }

  it('refuses a delegated run the same way', async () => {
    const result = await dispatch('agent', 'native_skill', skillInput('script_run'), {}, {
      delegatedRun: true,
      scopeAgentId: 'sub-bl878',
      delegatedBashEnabled: true,
      processOwner: { userId: 'josh', kind: 'subagent', id: 'sub-bl878' }
    })

    expectRefused(result, SCRIPT_REFUSAL)
    expect(skillMocks.resolveSkillRuntimeForTool).not.toHaveBeenCalled()
    expect(await ranMarker()).toBe(false)
  })

  it.each([{ mode: 'mode3' }, { mode: 'mode3', primary_agent_type: 'api' }, { actor_type: 'subagent', parent_agent_id: AGENT_ID }])(
    'still refuses when the body claims another lane (%j)',
    async (claim) => {
      const result = await dispatch('agent', 'native_skill', skillInput('script_run'), claim)

      expectRefused(result, SCRIPT_REFUSAL)
      expect(skillMocks.resolveSkillRuntimeForTool).not.toHaveBeenCalled()
      expect(await ranMarker()).toBe(false)
    }
  )

  it.each(['script_list', 'script_read'])('leaves %s on the agent lane as it was (a read, no process)', async (action) => {
    const result = await dispatch('agent', 'native_skill', skillInput(action))

    expect(result.success).toBe(true)
    expect(skillMocks.resolveSkillRuntimeForTool).toHaveBeenCalledTimes(1)
    expect(await ranMarker()).toBe(false)
  })

  it.each(['service', 'session', undefined])(
    'does not change the %s caller: the same settings still run the script',
    async (lane) => {
      const result = await dispatch(lane, 'native_skill', skillInput('script_run'))

      expect(result.error).toBeUndefined()
      expect(result.success).toBe(true)
      expect(result.data).toMatchObject({ runSucceeded: true })
      expect(await ranMarker()).toBe(true)
    }
  )

  it.each(['run', 'run_script', 'script-run'])(
    'does not change a service caller that sends the alias %s',
    async (alias) => {
      const result = await dispatch('service', 'native_skill', { input: skillInput(alias) })

      expect(result.success).toBe(true)
      expect(result.data).toMatchObject({ runSucceeded: true })
      expect(await ranMarker()).toBe(true)
    }
  )

  it('never refuses a caller that is not on the agent lane because its body says cli', async () => {
    const result = await dispatch('service', 'native_skill', skillInput('script_run'), {
      mode: 'mode4',
      primary_agent_type: 'cli'
    })

    expect(result.success).toBe(true)
    expect(await ranMarker()).toBe(true)
  })
})
