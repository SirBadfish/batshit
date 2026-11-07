// @vitest-environment node
/**
 * SA-139 P4 (D11, V9): plain Compact on the Claude plan connection, and every other summary caller
 * refused. The actual summary path (`generateModelSummary`), central admission, P2's Claude plan
 * model and the AI SDK, on the Claude Code test double (`fixtures/claude-plan/fake-claude.mjs`,
 * through `BATSHIT_CLAUDE_CLI_PATH`); only live readiness is faked. No model call is made.
 */
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.unmock('ai')
vi.mock('../claudePlanReadiness', () => ({ readClaudePlanReadiness: vi.fn(async () => ({ state: 'ready' })) }))

import { redis } from '$lib/server/redis'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { CLAUDE_PLAN_CONNECTION_ID, CLAUDE_PLAN_SERVICE } from '$lib/utils/claudePlanConnection'
import { ProviderManager } from '../providers'
import { generateModelSummary } from '../summaryGeneration'
import { ClaudePlanError } from '../claudePlanAdmission'
import { listClaudePlanRuns, resetClaudePlanRunRegistryForTests } from '../claudePlanRunRegistry'
import { ClaudePlanRun } from '../claudePlanRun'
import { startCompactRun } from '../compactRunRegistry'
import { deleteSessionAfterItsTurn } from '../sessionDeleteTurnStop'

useRedisTestServer()
const FAKE = path.resolve(__dirname, 'fixtures/claude-plan/fake-claude.mjs')
const USER = 'sa139-compact-user', SESSION = 'sa139-compact-session', AGENT = 'sa139-compact-agent', PRESET = 'sa139-compact-preset'
const CONNECTION = { id: CLAUDE_PLAN_CONNECTION_ID, type: 'direct', service: CLAUDE_PLAN_SERVICE }
let project: string, started: ClaudePlanRun[], agent: Record<string, any>
const originalProjectPreferences = (redis as any).getProjectPreferences

const scenario = (turns: unknown[]) => writeFileSync(path.join(project, 'scenario.json'), JSON.stringify({ turns }))
const fakeLog = (): any[] => existsSync(path.join(project, 'fake-log.jsonl'))
  ? readFileSync(path.join(project, 'fake-log.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
const preset = (settings: Record<string, unknown> = {}) =>
  redis.set(`model:${PRESET}`, { id: PRESET, modelName: 'Plan Haiku', provider: 'anthropic', modelId: 'claude-haiku-5-5', effectiveModelId: 'claude-haiku-5-5', connection: CONNECTION, settings, pricing: {} })
const summarize = (extra: Record<string, unknown> = {}) => generateModelSummary({
  userId: USER, agent: agent as any, choice: { modelMode: 'current', modelPresetId: null }, prompt: 'Summarize the earlier conversation.',
  summaryHardMaxTokens: 400, claudePlanCompact: { sessionId: SESSION }, ...extra
} as any)
async function refusal(promise: Promise<unknown>): Promise<any> {
  return promise.then(() => { throw new Error('expected a refusal') }, error => error)
}

beforeEach(async () => {
  vi.stubEnv('BATSHIT_CLAUDE_CLI_PATH', FAKE)
  project = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'sa139-compact-')))
  // A spare turn keeps the double waiting for another prompt, as the real Claude Code does, so only
  // the summary's own end (endReply) ends the run.
  scenario([{ blocks: [{ type: 'text', text: 'The user asked about the build; it passed.' }] }, { blocks: [{ type: 'text', text: 'never' }] }])
  started = []
  const start = ClaudePlanRun.prototype.start
  vi.spyOn(ClaudePlanRun.prototype, 'start').mockImplementation(function(this: ClaudePlanRun, input) { started.push(this); return start.call(this, input) })
  vi.spyOn(ProviderManager, 'createForUser')
  await preset({ anthropicEffort: 'low' })
  agent = { id: AGENT, user_id: USER, name: 'Fixture', agentType: 'api', primary_model_preset_id: PRESET, primary_model_provider: 'anthropic', primary_model_name: 'claude-haiku-5-5', primary_model_connection: CONNECTION }
  ;(redis as any).getProjectPreferences = vi.fn(async (userId: string) => userId === USER ? { user_id: USER, default_workspace_path: project } : null)
})

afterEach(async () => {
  await Promise.all(listClaudePlanRuns().map(run => run.settled))
  resetClaudePlanRunRegistryForTests()
  ;(redis as any).getProjectPreferences = originalProjectPreferences
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  rmSync(project, { recursive: true, force: true })
})

describe('SA-139 P4: Compact on the Claude plan connection', () => {
  it('plain Compact admits as consumer compact, summarizes on its own Claude Code run with no tools, and ends that run', async () => {
    const result = await summarize()
    expect(result).toMatchObject({ summary: 'The user asked about the build; it passed.', provider: CLAUDE_PLAN_SERVICE, modelId: 'claude-haiku-5-5' })
    expect(ProviderManager.createForUser).not.toHaveBeenCalled()
    expect(started).toHaveLength(1)
    // The chat owns the run, so the chat's delete or a restore ends it.
    expect(started[0].owner).toMatchObject({ userId: USER, sessionId: SESSION, agentId: AGENT, kind: 'primary' })
    await vi.waitFor(() => expect(started[0].isEnded).toBe(true), { timeout: 5000 })
    expect(await started[0].settled).toBe('exited')
    // Claude Code is offered no Batshit tool, and the preset's effort reaches it.
    expect(fakeLog().find(entry => entry.kind === 'tools')?.tools).toEqual([])
    expect(fakeLog().find(entry => entry.kind === 'start')?.argv?.join(' ')).toMatch(/--effort low/)
  }, 30_000)

  it('runs from a saved compact preset too', async () => {
    const result = await summarize({ choice: { modelMode: 'preset', modelPresetId: PRESET } })
    expect(result).toMatchObject({ provider: CLAUDE_PLAN_SERVICE, modelLabel: 'Plan Haiku' })
    expect(started).toHaveLength(1)
  }, 30_000)

  it('every other summary caller (memory graduation, naps) is refused readably before any run', async () => {
    const error = await refusal(summarize({ claudePlanCompact: undefined }))
    expect(error).toBeInstanceOf(ClaudePlanError)
    expect(error).toMatchObject({ code: 'consumer_unsupported' })
    expect(error.message).toMatch(/cannot use the Claude plan/)
    expect(started).toHaveLength(0)
    expect(ProviderManager.createForUser).not.toHaveBeenCalled()
  })

  it('a summary past its budget compacts nothing and ends the run', async () => {
    // The over-long text comes first, then Claude Code pauses mid-reply: only the summary's own end stops the run.
    scenario([{ gapMs: 20_000, blocks: [{ type: 'text', text: 'word '.repeat(2000) }, { type: 'text', text: 'never' }] }])
    const error = await refusal(summarize({ summaryHardMaxTokens: 50 }))
    expect(error).toMatchObject({ code: 'summary_output_limit' })
    expect(error.message).toMatch(/exceeded the Compact summary budget\. Nothing was compacted/)
    await vi.waitFor(() => expect(started[0].isEnded).toBe(true), { timeout: 5000 })
  }, 30_000)

  it('BL-2368: a misnamed tool call during Compact compacts nothing, even with words before it, and ends the run', async () => {
    // Compact offers no tools; Claude Code answers the misnamed call itself and the run lets that through.
    scenario([{ blocks: [{ type: 'text', text: 'Partial summary so far.' }, { type: 'tool_use', name: 'batshit__get_weather', input: { city: 'Paris' } }] }, { blocks: [{ type: 'text', text: 'never' }] }])
    const error = await refusal(summarize())
    expect(error).toMatchObject({ code: 'summary_tool_call' })
    expect(error.message).toMatch(/asked for a tool during Compact.*nothing was compacted/)
    await vi.waitFor(() => expect(started[0].isEnded).toBe(true), { timeout: 5000 })
  }, 30_000)

  it('a raw agent selection carrying a sampling value Claude Code cannot take is refused by name, nothing dropped', async () => {
    agent = { ...agent, primary_model_preset_id: null, primary_model_temperature: 0.4 }
    const error = await refusal(summarize())
    expect(error).toMatchObject({ code: 'setting_unsupported' })
    expect(error.message).toMatch(/temperature/)
    expect(started).toHaveLength(0)
  })

  it('Claude Code not ready: refused with its own words before any run', async () => {
    const { readClaudePlanReadiness } = await import('../claudePlanReadiness')
    vi.mocked(readClaudePlanReadiness).mockResolvedValueOnce({ state: 'unavailable', code: 'signed_out', reason: 'Claude Code is not signed in.' } as any)
    const error = await refusal(summarize())
    expect(error).toMatchObject({ code: 'connection_unavailable' })
    expect(error.message).toContain('Claude Code is not signed in.')
    expect(started).toHaveLength(0)
  })

  it('a chat delete during the Compact\'s setup stops it before any Claude Code run starts (review A, S1)', async () => {
    const { readClaudePlanReadiness } = await import('../claudePlanReadiness')
    let release!: () => void
    vi.mocked(readClaudePlanReadiness).mockImplementationOnce(() => new Promise(resolve => { release = () => resolve({ state: 'ready' }) }))
    const compactRun = startCompactRun(SESSION)
    const outcome = refusal(summarize({ abortSignal: compactRun.signal }))
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    const swept: string[] = []
    await deleteSessionAfterItsTurn(SESSION, async () => { swept.push(SESSION) })
    expect(compactRun.signal.aborted).toBe(true)
    release()
    await outcome
    expect(swept).toEqual([SESSION])
    expect(started).toHaveLength(0)
    compactRun.end()
  })

  it("the Compact's Stop ends the summary run", async () => {
    scenario([{ stallMs: 20_000, blocks: [{ type: 'text', text: 'never' }] }])
    const stop = new AbortController()
    const outcome = refusal(summarize({ abortSignal: stop.signal }))
    await vi.waitFor(() => expect(started).toHaveLength(1), { timeout: 5000 })
    stop.abort(new Error('User pressed Stop'))
    await outcome
    await vi.waitFor(() => expect(started[0].isEnded).toBe(true), { timeout: 5000 })
    expect(await started[0].settled).toBe('exited')
  }, 30_000)
})
