// @vitest-environment node
/**
 * SA-139 P2 Part 2: Claude plan replies through the REAL `VercelAIBrain` (`streamNativeMode`,
 * `processNativeMode`), the REAL readable wrapper and the REAL `ai` loop, on the Claude Code test
 * double (`fixtures/claude-plan/fake-claude.mjs`, found through `BATSHIT_CLAUDE_CLI_PATH`). Only the
 * provider lookup (which must never be reached), Redis, live readiness and the size guard's zip
 * store are faked. No model call is made anywhere here.
 */
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { tool } from 'ai'
import { z } from 'zod'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The real AI SDK loop, not the shared test mock.
vi.unmock('ai')

const providerGetModel = vi.hoisted(() => vi.fn(() => { throw new Error('ProviderManager was reached') }))
vi.mock('$lib/server/services/providers', () => {
  const factory = () => ({ getModel: providerGetModel, listAvailableModels: () => [] })
  const ProviderManager = vi.fn(function MockProviderManager(this: Record<string, unknown>) {
    Object.assign(this, factory())
  })
  ;(ProviderManager as any).createForUser = vi.fn(async () => factory())
  return { ProviderManager, resolveProviderAccess: vi.fn().mockResolvedValue({ apiKeys: {} }) }
})

vi.mock('$lib/server/redis', () => ({
  redis: {
    get: vi.fn().mockResolvedValue(null),
    getUserSettings: vi.fn().mockResolvedValue(null),
    getProjectPreferences: vi.fn().mockResolvedValue(null)
  }
}))

const readiness = vi.hoisted(() => ({ value: { state: 'ready' } as Record<string, unknown> }))
vi.mock('../claudePlanReadiness', () => ({ readClaudePlanReadiness: vi.fn(async () => readiness.value) }))

// Counts every model-facing guard pass; a large text is cut without the zip store.
const guarded = vi.hoisted(() => ({ lengths: [] as number[] }))
vi.mock('../toolModelResultGuard', async importOriginal => ({
  ...(await importOriginal<typeof import('../toolModelResultGuard')>()),
  guardToolModelText: vi.fn(async (text: string) => {
    guarded.lengths.push(text.length)
    return text.length > 50_000 ? `Output cut here by the test guard after ${text.length} characters.` : text
  })
}))

import { VercelAIBrain, moveP5ImagesForRun, type NativeModeRequest } from '../vercelBrain'
import { ClaudePlanError, admitClaudePlanSelection } from '../claudePlanAdmission'
import { resolveRuntimeModelSelection } from '$lib/utils/modelPresetRuntime'
import { reasoningOverrideKey } from '$lib/utils/modelReasoningControls'
import { claimHeldClaudePlanRun, endClaudePlanRuns, isClaudePlanRunHeld, listClaudePlanRuns, resetClaudePlanRunRegistryForTests } from '../claudePlanRunRegistry'
import { withToolResultsOnStop } from '../lateToolResults'
import { EPHEMERAL_IMAGE_MESSAGE_MARKER, createEphemeralImageRegistry, restoreCompletedToolImages, takeCompletedToolImages } from '../toolResultImageDelivery'
import { CLAUDE_PLAN_CONNECTION_ID, CLAUDE_PLAN_SERVICE } from '$lib/utils/claudePlanConnection'
import { resolveClaudePlanWorkingDirectory } from '../claudePlanModel'
import { CLAUDE_PLAN_APPROVAL_REFUSAL, ClaudePlanRunError } from '../claudePlanProtocol'
import { TYPED_READ_FILE_MARKER } from '../typedFileTools'
import { createSkillDcmUpdate } from '../skillDcmUpdate'
import { ApiImageInputCollector } from '../imageAddressApiInput'
import type { DeliveredSteer } from '$lib/utils/steerControl'

const FAKE = path.resolve(__dirname, 'fixtures/claude-plan/fake-claude.mjs')
const CONNECTION = { id: CLAUDE_PLAN_CONNECTION_ID, type: 'direct', service: CLAUDE_PLAN_SERVICE } as const
const folders: string[] = []

beforeEach(() => {
  vi.stubEnv('BATSHIT_CLAUDE_CLI_PATH', FAKE)
  readiness.value = { state: 'ready' }
  guarded.lengths.length = 0
  providerGetModel.mockClear()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(async () => {
  await endClaudePlanRuns({}, 'test over')
  resetClaudePlanRunRegistryForTests()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
})

function project(scenario: Record<string, unknown>): string {
  const folder = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'sa139-p2b-')))
  folders.push(folder)
  writeFileSync(path.join(folder, 'scenario.json'), JSON.stringify(scenario))
  return folder
}

function fakeLog(folder: string): any[] {
  const file = path.join(folder, 'fake-log.jsonl')
  return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : []
}

type Raw = Record<string, any>

/** A brain whose tool list is `raw` through the REAL readable wrapper, as `buildToolsForMode3` builds it. */
function brainWith(raw: Raw = {}, toolApprovals: Record<string, unknown> = {}) {
  const brain = new VercelAIBrain()
  ;(brain as any).buildToolsForMode3 = vi.fn(async (...args: any[]) => ({
    tools: Object.keys(raw).length
      ? (brain as any).wrapToolsWithReadableModelOutput(raw, { userId: 'u1', sessionId: 's1', messageId: 'm1', agentId: 'a1' }, args[9]?.skillReadDelivery)
      : undefined,
    maps: { workflowTools: new Map(), gatewayTools: new Map(), subagentTools: new Map() },
    toolApprovals,
    ephemeralImages: null
  }))
  return brain
}

/** Every part, and the failure that ended the stream (an `error` part or an error the read raised). */
async function collectToEnd(result: any): Promise<{ parts: any[]; failure: unknown }> {
  const parts: any[] = []
  try {
    for await (const part of result.stream) parts.push(part)
  } catch (error) {
    return { parts, failure: error }
  }
  return { parts, failure: parts.find(p => p.type === 'error')?.error ?? null }
}

const saveNote = (saved: string[] = []) => tool({ description: 'Save a note.', inputSchema: z.object({ title: z.string() }), execute: async ({ title }) => { saved.push(title); return `saved ${title}` } })

function request(folder: string, extra: Partial<NativeModeRequest> & Record<string, unknown> = {}): NativeModeRequest {
  return {
    model: 'claude-haiku-5-5',
    connection: CONNECTION,
    claudePlanConsumer: 'primary',
    messages: [
      { role: 'system', content: 'You are a test agent.' },
      { role: 'user', content: 'Please help.' }
    ],
    sessionId: 's1',
    messageId: 'm1',
    userId: 'u1',
    agentId: 'a1',
    projectPath: folder,
    maxToolRounds: 5,
    ...extra
  } as unknown as NativeModeRequest
}

async function collect(result: any, stop?: AbortSignal) {
  const parts: any[] = []
  const stream = stop ? withToolResultsOnStop(result.stream, stop, { waitMs: 200 }) : result.stream
  for await (const part of stream) parts.push(part)
  return parts
}

const textOf = (parts: any[]) => parts.filter(p => p.type === 'text-delta').map(p => p.text).join('')
const settledAll = () => Promise.all(listClaudePlanRuns().map(run => run.settled))

describe('SA-139 P2 Part 2: a Claude plan reply through VercelAIBrain', () => {
  it('a Primary reply runs on the user\'s Claude Code, never ProviderManager, in the project folder', async () => {
    const folder = project({ turns: [{ blocks: [{ type: 'text', text: 'Hello from the plan.' }] }] })
    const seen: any[] = []
    const result = await brainWith().streamNativeMode(request(folder, {
      // The chat-bar effort reaches admission as the merged settings carry it.
      providerSettings: { anthropicEffort: 'high', claude_model: 'LEFTOVER-7731', codex_reasoning_effort: 'LEFTOVER-7732', claude_settings: { note: 'LEFTOVER-7733' } },
      // Every request-level sampling field (a preset-backed agent's copies, the operational output cap): never sent.
      temperature: 0.3, topP: 0.9, topK: 40, presencePenalty: 0.1, frequencyPenalty: 0.1, seed: 7, stopSequences: ['END'], maxTokens: 4096,
      onApiModelInput: (input: any) => { seen.push(input) }
    }))
    expect(textOf(await collect(result))).toBe('Hello from the plan.')
    await settledAll()
    expect(providerGetModel).not.toHaveBeenCalled()
    const start = fakeLog(folder).find(e => e.kind === 'start')
    // The fake writes its log in its own working folder: Claude Code ran in the project (P0 S8).
    expect(start).toBeTruthy()
    expect(start.argv.slice(start.argv.indexOf('--effort'), start.argv.indexOf('--effort') + 2)).toEqual(['--effort', 'high'])
    expect(start.argv[start.argv.indexOf('--model') + 1]).toBe('claude-haiku-5-5')
    // Josh (2026-10-27): leftover CLI keys are ignored, never read into argv, env or the settings file.
    expect(JSON.stringify(start)).not.toContain('LEFTOVER')
    // Cache policy: the lane names no provider kind, so nothing is marked (D12; Claude Code owns caching).
    expect(result.__runtimeInfo.promptCachePolicy).toMatchObject({ provider: 'unknown', applied: [] })
    expect(JSON.stringify(seen)).not.toMatch(/cacheControl|cache_control|promptCacheBreakpoint/)
    expect(seen[0].promptMessages.length).toBeGreaterThan(0)
  })

  it('a Primary reply that reaches its step limit ends its Claude Code run (onEnd, D10)', async () => {
    const folder = project({ turns: [
      { blocks: [{ type: 'tool_use', name: 'mcp__batshit__save_note', input: { title: 'One' } }] },
      { blocks: [{ type: 'text', text: 'never' }] }
    ] })
    const result = await brainWith({
      save_note: tool({ description: 'Save a note.', inputSchema: z.object({ title: z.string() }), execute: async ({ title }) => `saved ${title}` })
    }).streamNativeMode(request(folder, { maxToolRounds: 1 }))
    await collect(result)
    const [run] = listClaudePlanRuns()
    await vi.waitFor(() => expect(run.isEnded).toBe(true), { timeout: 2000 })
    await run.settled
    expect(fakeLog(folder).filter(e => e.kind === 'model-call')).toHaveLength(1)
  })

  it('Part 3: the stream result carries its Claude plan model, so send-routed\'s finalize can end the run as a backstop', async () => {
    const folder = project({ turns: [{ blocks: [{ type: 'text', text: 'ok' }] }] })
    const result = await brainWith().streamNativeMode(request(folder))
    const model = (result as any).__claudePlanModel
    expect(model?.provider).toBe('claude-plan')
    await collect(result)
    expect(() => model.endReply()).not.toThrow()
    expect(await model.currentRun.settled).toBe('exited')
  })

  it('Part 3 review: a reader that stops mid-reply, then the finalize backstop, ends the run at once', async () => {
    const folder = project({ turns: [
      { blocks: [{ type: 'tool_use', name: 'mcp__batshit__save_note', input: { title: 'One' } }] },
      { blocks: [{ type: 'text', text: 'never read' }] }
    ] })
    const result = await brainWith({ save_note: saveNote() }).streamNativeMode(request(folder))
    // Stop reading without cancelling the stream: only the backstop can end the run now.
    const reader = (result.stream as AsyncIterable<any>)[Symbol.asyncIterator]()
    for (;;) { const { value, done } = await reader.next(); if (done || value.type === 'tool-call') break }
    const model = (result as any).__claudePlanModel
    const run = model.currentRun
    expect(run.isEnded).toBe(false)
    model.endReply()
    await vi.waitFor(() => expect(run.isEnded).toBe(true), { timeout: 2000 })
    expect(await run.settled).toBe('exited')
    expect(fakeLog(folder).filter(e => e.kind === 'model-call')).toHaveLength(1)
  })

  it('Part 3 review: an empty stop-sequence list on a raw record is blank, never refused', async () => {
    const folder = project({ turns: [{ blocks: [{ type: 'text', text: 'ok' }] }] })
    const result = await brainWith().streamNativeMode(request(folder, { claudePlanSampling: { stopSequences: [] } }))
    expect(textOf(await collect(result))).toBe('ok')
    await settledAll()
  })

  it('an API Subagent (consumer subagent, a process owner, no delegatedRun flag) runs on the plan', async () => {
    const folder = project({ turns: [{ blocks: [{ type: 'text', text: 'Delegated answer.' }] }] })
    const response = await brainWith().processNativeMode(request(folder, { claudePlanConsumer: 'subagent', processOwner: { userId: 'u1', kind: 'subagent', id: 'sub-1' } }))
    expect(response.content).toBe('Delegated answer.')
    await settledAll()
    expect(listClaudePlanRuns().every(run => run.owner.kind === 'delegated')).toBe(true)
  })

  it('a delegated run (processNativeMode) ends its Claude Code run when the loop returns (D10)', async () => {
    const folder = project({ turns: [
      { blocks: [{ type: 'tool_use', name: 'mcp__batshit__save_note', input: { title: 'One' } }] },
      { blocks: [{ type: 'text', text: 'never' }] }
    ] })
    // The Subagent's one-call limit ends the loop while Claude Code still waits for its next step.
    await brainWith({
      save_note: tool({ description: 'Save a note.', inputSchema: z.object({ title: z.string() }), execute: async ({ title }) => `saved ${title}` })
    }).processNativeMode(request(folder, { claudePlanConsumer: 'subagent', processOwner: { userId: 'u1', kind: 'subagent', id: 'sub-1' }, delegatedMaxToolSteps: 1 }))
    const [run] = listClaudePlanRuns()
    expect(run.isEnded).toBe(true)
    await run.settled
    expect(fakeLog(folder).filter(e => e.kind === 'model-call')).toHaveLength(1)
    expect(providerGetModel).not.toHaveBeenCalled()
  })
})

describe('SA-139 P2 Part 2: the working folder (P0 S8)', () => {
  it('is the chat\'s project, else the Default Project Directory, else the run-as home', async () => {
    const projectFolder = project({})
    const home = project({})
    expect(await resolveClaudePlanWorkingDirectory({ userId: 'u1', projectPath: projectFolder, runAs: { home } })).toBe(projectFolder)
    expect(await resolveClaudePlanWorkingDirectory({ userId: 'u1', projectPath: null, runAs: { home } })).toBe(home)
    // A project folder that is gone is the Bash tool's refusal, not Claude Code's: the reply still runs, in the home.
    expect(await resolveClaudePlanWorkingDirectory({ userId: 'u1', projectPath: path.join(home, 'gone'), runAs: { home } })).toBe(home)
    const { redis } = await import('$lib/server/redis')
    vi.mocked(redis.getProjectPreferences).mockResolvedValueOnce({ default_workspace_path: projectFolder } as any)
    expect(await resolveClaudePlanWorkingDirectory({ userId: 'u1', projectPath: null, runAs: { home } })).toBe(projectFolder)
    // Faye N9: a configured run-as home that is gone is refused by name, never swapped for the app user's home.
    await expect(resolveClaudePlanWorkingDirectory({ userId: 'u1', projectPath: null, runAs: { uid: 1001, home: path.join(home, 'no-such-home') } }))
      .rejects.toMatchObject({ code: 'startup_refused', message: expect.stringContaining('no-such-home') })
  })
})

describe('SA-139 P2 Part 2: the settings admission sees (Faye, lead)', () => {
  it('the chat-bar effort reaches admission through the real selection resolver, and nothing else is added', async () => {
    const identity = { presetId: 'plan-preset', connection: CONNECTION, effectiveModelId: 'claude-haiku-5-5' }
    const selection = resolveRuntimeModelSelection({
      preset: { id: 'plan-preset', provider: CLAUDE_PLAN_SERVICE, modelId: 'claude-haiku-5-5', connection: CONNECTION, settings: { anthropicEffort: 'low' } } as any,
      // The agent's own bag: its lane keys survive the merge, its stale sampling does not.
      settings: { claude_model: 'LEFTOVER', codex_reasoning_effort: 'LEFTOVER', temperature: 0.9 },
      reasoningOverrides: { [reasoningOverrideKey(identity as any, 'effort')]: { mode: 'value', value: 'high' } } as any,
      transport: 'api'
    })
    expect(Object.keys(selection.settings ?? {}).sort()).toEqual(['anthropicEffort', 'claude_model', 'codex_reasoning_effort'])
    const admission = await admitClaudePlanSelection({
      connection: selection.connection, modelId: selection.modelId, settings: selection.settings,
      consumer: 'primary', readiness: async () => ({ state: 'ready' })
    })
    expect(admission).toMatchObject({ modelId: 'claude-haiku-5-5', cliModel: 'claude-haiku-5-5', effort: 'high' })
  })
})

describe('SA-139 P2 Part 2: review round (2026-10-27)', () => {
  it('send-path S1: Thinking Off on claude-opus-4-6 writes alwaysThinkingEnabled false into the run\'s settings file', async () => {
    const folder = project({ turns: [{ blocks: [{ type: 'text', text: 'ok' }] }] })
    const result = await brainWith().streamNativeMode(request(folder, { model: 'claude-opus-4-6', providerSettings: { claudePlanThinking: false } }))
    expect(textOf(await collect(result))).toBe('ok')
    await settledAll()
    expect(fakeLog(folder).find(e => e.kind === 'start').settings.alwaysThinkingEnabled).toBe(false)
  })

  it('send-path S2: processNativeMode keeps a Claude plan refusal and run failure whole, never "provider" words', async () => {
    readiness.value = { state: 'unavailable', code: 'signed_out', reason: 'Claude Code would use an API key, not your Claude plan.' }
    const refusal = brainWith().processNativeMode(request(project({}), { claudePlanConsumer: 'subagent', processOwner: { userId: 'u1', kind: 'subagent', id: 'sub-1' } }))
    await expect(refusal).rejects.toBeInstanceOf(ClaudePlanError)
    await expect(refusal).rejects.toMatchObject({ code: 'connection_unavailable', message: 'Claude Code would use an API key, not your Claude plan.' })

    readiness.value = { state: 'ready' }
    // Claude Code's own startup check refuses an API key source; its words name "API key" too.
    const folder = project({ account: { subscriptionType: 'Claude Max', apiProvider: 'firstParty', apiKeySource: 'an API key' }, turns: [{ blocks: [{ type: 'text', text: 'never' }] }] })
    const failure = brainWith().processNativeMode(request(folder, { claudePlanConsumer: 'subagent', processOwner: { userId: 'u1', kind: 'subagent', id: 'sub-1' } }))
    await expect(failure).rejects.toBeInstanceOf(ClaudePlanRunError)
    await expect(failure).rejects.toMatchObject({ code: 'startup_refused' })
    await settledAll()
  })

  it('send-path S3: a later step\'s prepareStep failure ends the run through the loop\'s end hooks (onError, then onEnd), without the idle backstop', async () => {
    const folder = project({ turns: [
      { blocks: [{ type: 'tool_use', name: 'mcp__batshit__save_note', input: { title: 'One' } }] },
      { blocks: [{ type: 'text', text: 'never' }] }
    ] })
    const takeSteers = vi.fn(() => { throw new Error('The steer store is down.') })
    const result = await brainWith({ save_note: saveNote() }).streamNativeMode(request(folder, { takeSteers }))
    const { failure } = await collectToEnd(result)
    expect(String((failure as Error)?.message ?? failure)).toContain('The steer store is down.')
    const [run] = listClaudePlanRuns()
    await vi.waitFor(() => expect(run.isEnded).toBe(true), { timeout: 2000 })
    expect(await run.settled).toBe('exited')
    expect(fakeLog(folder).filter(e => e.kind === 'model-call')).toHaveLength(1)
  })

  it('send-path N5: a compact consumer is refused here (Compact has its own path)', async () => {
    const folder = project({})
    await expect(brainWith().streamNativeMode(request(folder, { claudePlanConsumer: 'compact' }))).rejects.toMatchObject({ code: 'consumer_unsupported' })
    expect(fakeLog(folder)).toEqual([])
    expect(providerGetModel).not.toHaveBeenCalled()
  })

  it('send-path N6: a service field spelled like the connection id reaches admission, never ProviderManager', async () => {
    for (const service of ['claude-plan:local', 'direct:claude-plan', ' Claude-Plan ']) {
      const folder = project({})
      await expect(brainWith().streamNativeMode(request(folder, { connection: { type: 'direct', id: 'anthropic', service } as any })))
        .rejects.toMatchObject({ code: 'connection_invalid' })
      expect(fakeLog(folder)).toEqual([])
    }
    expect(providerGetModel).not.toHaveBeenCalled()
  })

  it('P3 Part 3 (D6): a card ends the reply with its run held by the brain\'s end hook; the click\'s continuation runs the call once in the same run', async () => {
    const folder = project({ turns: [
      { blocks: [{ type: 'tool_use', name: 'mcp__batshit__save_note', input: { title: 'Needs a click' } }] },
      { blocks: [{ type: 'text', text: 'Saved after the click.' }] }
    ] })
    const saved: string[] = []
    const approvals = { save_note: async () => 'user-approval' as const }
    const result = await brainWith({ save_note: saveNote(saved) }, approvals).streamNativeMode(request(folder, { claudePlanApprovalVersion: 0 }))
    const { parts, failure } = await collectToEnd(result)
    expect(failure).toBeNull()
    const card = parts.find(p => p.type === 'tool-approval-request')
    expect(card?.toolCall.toolName).toBe('save_note')
    expect(saved).toEqual([])
    const key = { sessionId: 's1', replyId: 'm1', version: '0' }
    await vi.waitFor(() => expect(isClaudePlanRunHeld(key)).toBe(true), { timeout: 2000 })
    const [run] = listClaudePlanRuns()
    // send-routed's finalize backstop leaves the held run to the registry.
    ;(result as any).__claudePlanModel.endReply()
    expect(run.isEnded).toBe(false)

    const held = claimHeldClaudePlanRun(key, { userId: 'u1', agentId: 'a1' })
    expect(held?.run).toBe(run)
    const messages = [...request(folder).messages, ...(await result.response).messages,
      { role: 'tool', content: [{ type: 'tool-approval-response', approvalId: card.approvalId, approved: true }] }]
    const resumed = await brainWith({ save_note: saveNote(saved) }, approvals).streamNativeMode(request(folder, { messages, claudePlanApprovalVersion: 1, claudePlanHeld: held } as any))
    const after = await collectToEnd(resumed)
    expect(after.failure).toBeNull()
    expect(saved).toEqual(['Needs a click'])
    expect(textOf(after.parts)).toBe('Saved after the click.')
    const log = fakeLog(folder)
    expect(log.filter(e => e.kind === 'start')).toHaveLength(1)
    expect(log.filter(e => e.kind === 'model-call')).toHaveLength(2)
    expect(await run.settled).toBe('exited')
  })

  it('P3 Part 3 (D6): a delegated run never holds (no hold key): its reply ends and its run ends with it', async () => {
    const folder = project({ turns: [
      { blocks: [{ type: 'tool_use', name: 'mcp__batshit__save_note', input: { title: 'x' } }] },
      { blocks: [{ type: 'text', text: 'never' }] }
    ] })
    const result = await brainWith({ save_note: saveNote() }, { save_note: async () => 'user-approval' }).streamNativeMode(request(folder, { claudePlanApprovalVersion: null }))
    await collectToEnd(result)
    const [run] = listClaudePlanRuns()
    expect(await run.settled).toBe('exited')
  })

  it('tools nit 3: a Claude plan connection maps to the tool-result image lane through the brain\'s own provider id', async () => {
    const { resolveToolResultImageDelivery } = await import('../toolResultImageDelivery')
    const providerId = (new VercelAIBrain() as any).resolveRuntimeProviderId('claude-haiku-5-5', CONNECTION)
    expect(providerId).toBe('claude-plan')
    expect(resolveToolResultImageDelivery({ providerId, modelId: 'claude-haiku-5-5' }).lane).toBe('tool_result')
  })

  it('tools N2: only the registered typed reader is offered read-only; a workflow named read_file is not', async () => {
    const reader = Object.assign(tool({ description: 'Read a file.', inputSchema: z.object({ path: z.string() }), execute: async () => 'text' }), { [TYPED_READ_FILE_MARKER]: true })
    const lookalike = tool({ description: 'An n8n workflow.', inputSchema: z.object({ path: z.string() }), execute: async () => 'text' })
    for (const [definition, readOnly] of [[reader, true], [lookalike, false]] as const) {
      const folder = project({ turns: [{ blocks: [{ type: 'text', text: 'ok' }] }] })
      const result = await brainWith({ read_file: definition }).streamNativeMode(request(folder))
      await collect(result)
      await settledAll()
      const listed = fakeLog(folder).find(e => e.kind === 'tools').tools.find((t: any) => t.name === 'read_file')
      expect(listed.annotations.readOnlyHint).toBe(readOnly)
    }
  })
})

describe('SA-139 P2 Part 2: refusals before any process or provider client', () => {
  const refused = async (extra: Record<string, unknown>, code: string, words?: RegExp) => {
    const folder = project({ turns: [{ blocks: [{ type: 'text', text: 'never' }] }] })
    const attempt = brainWith().streamNativeMode(request(folder, extra))
    await expect(attempt).rejects.toBeInstanceOf(ClaudePlanError)
    await expect(attempt).rejects.toMatchObject({ code, ...(words ? { message: expect.stringMatching(words) } : {}) })
    expect(fakeLog(folder)).toEqual([])
    expect(listClaudePlanRuns()).toEqual([])
    expect(providerGetModel).not.toHaveBeenCalled()
  }

  it('Faye S3: an id-only selection never reaches the paid Anthropic key', () =>
    refused({ connection: { id: CLAUDE_PLAN_CONNECTION_ID } }, 'connection_invalid'))

  it('a service-only selection is refused the same way', () =>
    refused({ connection: { type: 'direct', service: CLAUDE_PLAN_SERVICE } }, 'connection_invalid'))

  it('D11: a caller that names no consumer is refused', () =>
    refused({ claudePlanConsumer: undefined }, 'consumer_unsupported'))

  // SA-139 R5: the `delegatedRun` flag went with the CLI Subagent run (the one path that set it),
  // so a process owner is what marks a delegated run.
  it('Faye S10: the API Subagent path (a process owner, no delegatedRun flag) counts as delegated; a Primary consumer there is refused', () =>
    refused({ claudePlanConsumer: 'primary', processOwner: { userId: 'u1', kind: 'subagent', id: 'sub-1' } }, 'consumer_unsupported', /named a primary run but is a delegated run/))

  it('Faye S10: a Subagent or Worker consumer on a run that is not delegated is refused', async () => {
    await refused({ claudePlanConsumer: 'subagent' }, 'consumer_unsupported', /named a subagent run but is not a delegated run/)
    await refused({ claudePlanConsumer: 'worker' }, 'consumer_unsupported', /named a worker run/)
  })

  it('Faye S4: raw sampling is refused by name', () =>
    refused({ claudePlanSampling: { temperature: 0.2 } }, 'setting_unsupported', /temperature/))

  it('Faye: a provider default inside the settings is refused, so nothing may add one before admission', () =>
    refused({ providerSettings: { anthropicEffort: 'high', temperature: 0.7 } }, 'setting_unsupported', /temperature/))

  it('an effort Claude Code does not take is refused', () =>
    refused({ providerSettings: { anthropicEffort: 'turbo' } }, 'setting_unsupported'))

  it('Claude Code that is not ready is refused with its reason', async () => {
    readiness.value = { state: 'unavailable', code: 'signed_out', reason: 'Claude Code is not signed in.' }
    await refused({}, 'connection_unavailable', /not signed in/)
  })
})

describe('SA-139 P2 Part 2: tools through the real readable wrapper (B-S5)', () => {
  it('(a) a Stop while a call waits for admission records only the call that ran (BL-1959 order)', async () => {
    const folder = project({ turns: [
      { blocks: ['Paris', 'Oslo'].map(city => ({ type: 'tool_use', name: 'mcp__batshit__get_weather', input: { city } })) },
      { blocks: [{ type: 'text', text: 'never' }] }
    ] })
    const stop = new AbortController()
    const ran: string[] = []
    const result = await brainWith({
      get_weather: tool({ description: 'Weather.', inputSchema: z.object({ city: z.string() }), execute: async ({ city }, options) => {
        ran.push(city)
        setTimeout(() => stop.abort(new Error('Stop')), 50)
        await new Promise((_, reject) => options.abortSignal?.addEventListener('abort', () => reject(options.abortSignal!.reason), { once: true }))
        return 'never'
      } })
    }).streamNativeMode(request(folder, { abortSignal: stop.signal }))
    const parts = await collect(result, stop.signal)
    expect(ran).toEqual(['Paris'])
    expect(parts.filter(p => p.type === 'tool-result' || p.type === 'tool-error').map(p => p.input?.city)).toEqual(['Paris'])
    await settledAll()
  })

  it('(b) an invalid write call is refused with the SDK\'s words, and the valid call after it runs', async () => {
    const folder = project({ turns: [
      { blocks: [
        { type: 'tool_use', name: 'mcp__batshit__save_note', input: { titel: 'typo' } },
        { type: 'tool_use', name: 'mcp__batshit__save_note', input: { title: 'Groceries' } }
      ] },
      { blocks: [{ type: 'text', text: 'Saved one note.' }] }
    ] })
    const saved: string[] = []
    const result = await brainWith({
      save_note: tool({ description: 'Save a note.', inputSchema: z.object({ title: z.string() }), execute: async ({ title }) => {
        saved.push(title)
        return `saved ${title}`
      } })
    }).streamNativeMode(request(folder))
    const parts = await collect(result)
    expect(saved).toEqual(['Groceries'])
    expect(parts.filter(p => p.type === 'tool-error')).toHaveLength(1)
    expect(parts.find(p => p.type === 'tool-result')?.output).toBe('saved Groceries')
    expect(textOf(parts)).toBe('Saved one note.')
    await settledAll()
    expect(fakeLog(folder).filter(e => e.kind === 'batch-passed')).toHaveLength(1)
  })

  it('(c) object and large results pass the guard once; Claude and the SDK hold the same bytes', async () => {
    const folder = project({ turns: [
      { blocks: [
        { type: 'tool_use', name: 'mcp__batshit__read_file', input: { path: 'big.txt' } },
        { type: 'tool_use', name: 'mcp__batshit__stats', input: { name: 'repo' } }
      ] },
      { blocks: [{ type: 'text', text: 'Read both.' }] }
    ] })
    const big = 'x'.repeat(120_000)
    const seen: any[] = []
    const result = await brainWith({
      read_file: tool({ description: 'Read a file.', inputSchema: z.object({ path: z.string() }), execute: async () => big }),
      stats: tool({ description: 'Stats.', inputSchema: z.object({ name: z.string() }), execute: async () => ({ files: 3, nested: { lines: [1, 2] } }) })
    }).streamNativeMode(request(folder, { onApiModelInput: (input: any) => { seen.push(input) } }))
    const parts = await collect(result)
    // A second format pass would guard again, and a released answer that differed from the SDK's
    // record would end the run as an integrity failure before "Read both." streamed.
    expect(textOf(parts)).toBe('Read both.')
    // The guard cuts only large text: it ran once, for the large result, not again when the SDK asked.
    expect(guarded.lengths).toEqual([big.length])
    // The second step's prompt holds exactly what Claude was given (the run checks both sides).
    const held = JSON.stringify(seen.at(-1).promptMessages.filter((m: any) => m.role === 'tool'))
    expect(held).toContain('Output cut here by the test guard after 120000 characters.')
    expect(held).toContain('nested')
    expect(held).not.toContain('x'.repeat(1000))
    await settledAll()
  })

  it('(c) a skill read is delivered once, though Claude needs its answer at once', async () => {
    const folder = project({ turns: [
      { blocks: [{ type: 'tool_use', name: 'mcp__batshit__open_skill', input: { id: 'notes' } }] },
      { blocks: [{ type: 'text', text: 'Skill read.' }] }
    ] })
    const skillOutput = { skill: 'notes', body: 'Use short notes.' }
    const delivered = vi.fn(async () => {})
    const skillReadDelivery = { owns: (output: unknown) => output === skillOutput, hasReads: () => true, execute: vi.fn(), delivered }
    const result = await brainWith({
      open_skill: tool({ description: 'Open a skill.', inputSchema: z.object({ id: z.string() }), execute: async () => skillOutput })
    }).streamNativeMode(request(folder, { skillReadDelivery } as any))
    expect(textOf(await collect(result))).toBe('Skill read.')
    expect(delivered).toHaveBeenCalledTimes(1)
    await settledAll()
  })
})

describe('SA-139 P3 Part 2: additions between steps reach Claude Code append-only (D5, D9)', () => {
  const steer = (step: number, extra: Partial<DeliveredSteer>): DeliveredSteer =>
    ({ steerId: `s${step}${extra.source ?? 'user'}`, messageId: 'm1', text: 'Also say hi.', at: '', source: 'user', step, lane: 'api', ...extra }) as DeliveredSteer
  const twoSteps = () => project({ turns: [
    { blocks: [{ type: 'tool_use', name: 'mcp__batshit__save_note', input: { title: 'One' } }] },
    { blocks: [{ type: 'text', text: 'Done.' }] }
  ] })
  const answerOf = (parts: any[]) => parts.filter(p => p.type === 'text-delta').map(p => p.text).join('')

  it('a person\'s steer at a tool boundary is a user message Claude Code takes into the next call; the SDK prompt is untouched', async () => {
    const folder = twoSteps()
    const takeSteers = vi.fn((step: number) => step === 1 ? [steer(step, {})] : [])
    const seen: any[] = []
    const result = await brainWith({ save_note: saveNote() }).streamNativeMode(request(folder, { takeSteers, onApiModelInput: (input: any) => { seen.push(input) } }))
    const { parts, failure } = await collectToEnd(result)
    expect(failure).toBeNull()
    expect(answerOf(parts)).toBe('Done.')
    const log = fakeLog(folder)
    const queued = log.find(e => e.kind === 'queued-user')
    expect(queued?.beforeCall).toBe(2)
    expect(JSON.stringify(queued.content)).toContain('[The user said, mid-reply: Also say hi.]')
    expect(log.find(e => e.kind === 'batch-passed')?.note).toBeNull()
    // Nothing earlier changed: the SDK's second request carries no steer message (Claude Code got it natively).
    expect(seen.length).toBeGreaterThan(1)
    expect(JSON.stringify(seen.at(-1).promptMessages)).not.toContain('Also say hi.')
    const model = (result as any).__claudePlanModel
    expect(model.handoffs).toEqual([expect.objectContaining({ step: 1, carrier: 'user_message', source: 'user_steer', steerId: 's1user', handedAt: expect.any(String) })])
    await settledAll()
  })

  it('a DM steer and a same-reply skill update are the step\'s note: DM provenance kept, the new skill list replaces the earlier one', async () => {
    const folder = twoSteps()
    let refreshes = 0
    const refreshOpenSkills = vi.fn(async () => (++refreshes === 2 ? createSkillDcmUpdate('abc', 0, 'a', 'z', '<open_skills>Recipe skill</open_skills>') : undefined))
    const takeSteers = vi.fn((step: number) => step === 1 ? [steer(step, { source: 'dm', label: 'Ashe', text: 'Ping from Ashe.' })] : [])
    const result = await brainWith({ save_note: saveNote() }).streamNativeMode(request(folder, { takeSteers, refreshOpenSkills }))
    const { failure } = await collectToEnd(result)
    expect(failure).toBeNull()
    const log = fakeLog(folder)
    const note = log.find(e => e.kind === 'batch-passed')?.note as string
    expect(note).toBe([
      'Batshit updated the skills open in this reply. This list replaces any earlier one:\n<open_skills>Recipe skill</open_skills>',
      '[Agent DM — from Ashe, not from the user, delivered mid-reply: Ping from Ashe.]'
    ].join('\n\n'))
    expect(log.some(e => e.kind === 'queued-user')).toBe(false)
    // The compiled opening Claude Code read is unchanged (no DCM edit after it began).
    expect(JSON.stringify(log.filter(e => e.kind === 'prompt'))).not.toContain('Recipe skill')
    await settledAll()
  })

  it('review N4: successive skill updates are successive notes, each replacing the last; a closed list says so', async () => {
    const folder = project({ turns: [
      { blocks: [{ type: 'tool_use', name: 'mcp__batshit__save_note', input: { title: 'One' } }] },
      { blocks: [{ type: 'tool_use', name: 'mcp__batshit__save_note', input: { title: 'Two' } }] },
      { blocks: [{ type: 'text', text: 'Done.' }] }
    ] })
    let refreshes = 0
    const refreshOpenSkills = vi.fn(async () => {
      refreshes += 1
      if (refreshes === 2) return createSkillDcmUpdate('abc', 0, 'a', 'z', '<open_skills>Recipe skill</open_skills>')
      if (refreshes === 3) return createSkillDcmUpdate('abc', 0, 'a', 'z', '')
      return undefined
    })
    const result = await brainWith({ save_note: saveNote() }).streamNativeMode(request(folder, { refreshOpenSkills }))
    const { failure } = await collectToEnd(result)
    expect(failure).toBeNull()
    const notes = fakeLog(folder).filter(e => e.kind === 'batch-passed').map(e => e.note)
    expect(notes).toEqual([
      'Batshit updated the skills open in this reply. This list replaces any earlier one:\n<open_skills>Recipe skill</open_skills>',
      'Batshit closed the skills that were open in this reply. None is open now.'
    ])
    await settledAll()
  })

  it('review B M2, S1: what Claude reads natively counts for the picture-address record, and a skill update leaves it complete', async () => {
    const folder = twoSteps()
    let refreshes = 0
    const refreshOpenSkills = vi.fn(async () => (++refreshes === 2 ? createSkillDcmUpdate('abc', 0, 'a', 'z', '<open_skills>Recipe skill</open_skills>') : undefined))
    const takeSteers = vi.fn((step: number) => step === 1 ? [
      steer(step, { text: 'Use https://example.com/cat.png please.' }),
      steer(step, { source: 'dm', label: 'Ashe', text: 'See https://example.com/dog.png.' })
    ] : [])
    const collector = new ApiImageInputCollector()
    const result = await brainWith({ save_note: saveNote() }).streamNativeMode(request(folder, {
      takeSteers, refreshOpenSkills, imageOriginInput: { compiledPrefixCount: 2, userSources: [] },
      onApiModelInput: (input: any) => collector.observe(input)
    } as any))
    const { failure } = await collectToEnd(result)
    expect(failure).toBeNull()
    expect(collector.run.unaccountedInputs).toBe(0)
    const pieces = collector.run.pieces.map(piece => [piece.source, piece.text])
    expect(pieces).toEqual(expect.arrayContaining([
      ['user', '[The user said, mid-reply: Use https://example.com/cat.png please.]'],
      ['agent_note', '[Agent DM — from Ashe, not from the user, delivered mid-reply: See https://example.com/dog.png.]'],
      ['batshit', 'Batshit updated the skills open in this reply. This list replaces any earlier one:\n<open_skills>Recipe skill</open_skills>']
    ]))
    await settledAll()
  })

  it('a skill update before the first step edits the compiled message itself (Claude Code has not read it yet)', async () => {
    const folder = project({ turns: [{ blocks: [{ type: 'text', text: 'ok' }] }] })
    const refreshOpenSkills = vi.fn(async () => createSkillDcmUpdate('Please help.', 7, 'help.', 'help, with the open skill.', '<open_skills>x</open_skills>'))
    const result = await brainWith().streamNativeMode(request(folder, { refreshOpenSkills }))
    const { failure } = await collectToEnd(result)
    expect(failure).toBeNull()
    expect(JSON.stringify(fakeLog(folder).filter(e => e.kind === 'prompt'))).toContain('Please help, with the open skill.')
    await settledAll()
  })

  it('BL-450: a steer at a tool-error boundary still reaches Claude Code', async () => {
    const folder = twoSteps()
    const takeSteers = vi.fn((step: number) => step === 1 ? [steer(step, {})] : [])
    const failing = tool({ description: 'Save a note.', inputSchema: z.object({ title: z.string() }), execute: async () => { throw new Error('disk full') } })
    const result = await brainWith({ save_note: failing }).streamNativeMode(request(folder, { takeSteers }))
    const { failure } = await collectToEnd(result)
    expect(failure).toBeNull()
    expect(fakeLog(folder).find(e => e.kind === 'queued-user')?.beforeCall).toBe(2)
    await settledAll()
  })

  it('D5 budget: the context check counts what the native run holds (the prompt plus every addition), never the SDK prompt alone', async () => {
    const folder = twoSteps()
    let refreshes = 0
    const huge = `<open_skills>${'skill text '.repeat(40_000)}</open_skills>`
    const refreshOpenSkills = vi.fn(async () => (++refreshes === 2 ? createSkillDcmUpdate('abc', 0, 'a', 'z', huge) : undefined))
    const skillReadDelivery = { hasReads: () => true, owns: () => false, execute: async (_args: unknown, run: () => unknown) => run() }
    const result = await brainWith({ save_note: saveNote() }).streamNativeMode(request(folder, {
      refreshOpenSkills, skillReadDelivery, skillContextBudget: { contextLimit: 20_000, outputReserveTokens: 1_000 }
    } as any))
    const { failure } = await collectToEnd(result)
    expect(String((failure as Error)?.message ?? failure)).toContain('do not fit this model context')
    // Refused before the note reached Claude Code: no second model call.
    expect(fakeLog(folder).filter(e => e.kind === 'model-call')).toHaveLength(1)
    await settledAll()
  })
})

describe('SA-139 P3 Part 4: the App Actions P5 pause ends the run; its continuation starts a fresh one (D8, lead 2026-10-27)', () => {
  /** A stand-in for the App Actions P5 owner: a management call in the step closes it (as `captureP5ApiManagement` does). */
  function withP5(brain: VercelAIBrain, state: { paused: boolean }) {
    const owner = {
      assertP5ApiRunCurrent: () => {},
      p5ApiRunMustPause: () => state.paused,
      holdP5ApiToolImages: vi.fn(),
      observeP5ApiStepTools: () => {},
      notifyP5ApiStreamSettlement: () => {}
    }
    const prepare = (brain as any).prepareApiToolset.bind(brain)
    ;(brain as any).prepareApiToolset = async (req: NativeModeRequest) => {
      const prepared = await prepare(req)
      Object.assign((brain as any).preparedApiToolsets.get(prepared), { p5ApiRun: Object.freeze({}), p5Owner: owner })
      return prepared
    }
    return owner
  }

  /** The pictures a pause held, moved as `moveP5ApiToolImages` moves them: taken, then admitted for the run's own lane. */
  function heldPictures(toolCallId: string, png: string) {
    const original = createEphemeralImageRegistry()
    original.register(toolCallId, 'native_bash_execute', [{ mediaType: 'image/png', data: png }], 'Agent Browser screenshot', 'tool_result')
    const destination = createEphemeralImageRegistry()
    const moved = restoreCompletedToolImages(destination, takeCompletedToolImages(original, [toolCallId]), 'tool_result')
    return { registry: destination, ...moved }
  }

  it('review B S1: a resumed held run takes the pictures its card held and sends none (Claude read them in the held step\'s results); any other run gets them', () => {
    const calls: unknown[] = []
    const owner = { moveP5ApiToolImages: (_run: unknown, registry: unknown, lane: unknown) => { calls.push({ registry, lane }); return { ids: ['call-1'], deferred: ['[deferred]'] } } }
    const real = createEphemeralImageRegistry()
    expect(moveP5ImagesForRun(owner as any, {} as any, real, 'tool_result', true)).toEqual({ ids: [], deferred: [] })
    // Taken from the original task, into a registry no step reads.
    expect(calls).toHaveLength(1)
    expect((calls[0] as any).registry).not.toBe(real)
    expect(moveP5ImagesForRun(owner as any, {} as any, real, 'tool_result', false)).toEqual({ ids: ['call-1'], deferred: ['[deferred]'] })
    expect((calls[1] as any).registry).toBe(real)
  })

  it('at the pause the loop stops after the management step, and the run ends: no hold, no second model call', async () => {
    const folder = project({ turns: [
      { blocks: [{ type: 'tool_use', name: 'mcp__batshit__save_note', input: { title: 'Gateway' } }] },
      { blocks: [{ type: 'text', text: 'never' }] }
    ] })
    const state = { paused: false }
    const brain = brainWith({ save_note: tool({ description: 'Save a note.', inputSchema: z.object({ title: z.string() }), execute: async ({ title }) => { state.paused = true; return `saved ${title}` } }) })
    const owner = withP5(brain, state)
    const result = await brain.streamNativeMode(request(folder, { claudePlanApprovalVersion: 0 }))
    const { failure } = await collectToEnd(result)
    expect(failure).toBeNull()
    const [run] = listClaudePlanRuns()
    await vi.waitFor(() => expect(run.isEnded).toBe(true), { timeout: 2000 })
    await run.settled
    expect(owner.holdP5ApiToolImages).toHaveBeenCalled()
    expect(isClaudePlanRunHeld({ sessionId: 's1', replyId: 'm1', version: '0' })).toBe(false)
    expect(fakeLog(folder).filter(e => e.kind === 'model-call')).toHaveLength(1)
  })

  it('the lead\'s check: the pause\'s run is ended and settled, then the continuation starts a different run whose opening carries the pictures once', async () => {
    const folder = project({ turns: [
      { blocks: [{ type: 'tool_use', name: 'mcp__batshit__save_note', input: { title: 'Gateway' } }] },
      { blocks: [{ type: 'text', text: 'Done.' }] }
    ] })
    // The click's segment: the management step closes the original task, so the loop pauses.
    const state = { paused: false }
    const first = brainWith({ save_note: tool({ description: 'Save a note.', inputSchema: z.object({ title: z.string() }), execute: async ({ title }) => { state.paused = true; return `saved ${title}` } }) })
    withP5(first, state)
    const paused = await first.streamNativeMode(request(folder, { claudePlanApprovalVersion: 0 }))
    expect((await collectToEnd(paused)).failure).toBeNull()
    const [old] = listClaudePlanRuns()
    await vi.waitFor(() => expect(old.isEnded).toBe(true), { timeout: 2000 })
    await old.settled
    expect(listClaudePlanRuns()).toHaveLength(0)
    // The continuation: send-routed's next segment under a new reply id, with the pictures the pause held.
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 9]).toString('base64')
    const { registry: images } = heldPictures('call-gateway', png)
    const next = brainWith({ save_note: saveNote() })
    const build = (next as any).buildToolsForMode3
    ;(next as any).buildToolsForMode3 = vi.fn(async (...args: any[]) => ({ ...(await build(...args)), ephemeralImages: images, initialImageToolIds: ['call-gateway'], imageDeferrals: [] }))
    const continued = await next.streamNativeMode(request(folder, { messageId: 'm2', claudePlanApprovalVersion: 0 }))
    const { parts, failure } = await collectToEnd(continued)
    expect(failure).toBeNull()
    expect(parts.filter(p => p.type === 'text-delta').map(p => p.text).join('')).toBe('Done.')
    const [fresh] = listClaudePlanRuns()
    expect(fresh).toBeDefined()
    expect(fresh).not.toBe(old)
    expect(fresh.id).not.toBe(old.id)
    const log = fakeLog(folder)
    const starts = log.filter(e => e.kind === 'start')
    expect(starts).toHaveLength(2)
    expect(starts[0].pid).not.toBe(starts[1].pid)
    const openings = log.filter(e => e.kind === 'prompt' && e.prompt !== 'batshit-handshake')
    expect(openings.map(e => e.content.filter((block: any) => block.type === 'image').length)).toEqual([0, 1])
    await settledAll()
  })

  it('the lead\'s check: Claude ending its turn in the pause\'s step (no tool call) ends the reply cleanly, and its run exits by itself', async () => {
    const folder = project({ turns: [{ blocks: [{ type: 'text', text: 'All set.' }] }] })
    const state = { paused: false }
    const brain = brainWith({ save_note: saveNote() })
    withP5(brain, state)
    // The management call ran in the click's replay, so the task is closed while this step streams.
    const result = await brain.streamNativeMode(request(folder, { claudePlanApprovalVersion: 0, onApiModelInput: () => { state.paused = true } }))
    const { parts, failure } = await collectToEnd(result)
    expect(state.paused).toBe(true)
    expect(failure).toBeNull()
    expect(parts.filter(p => p.type === 'text-delta').map(p => p.text).join('')).toBe('All set.')
    const [run] = listClaudePlanRuns()
    expect(await run.settled).toBe('exited')
    expect(run.failure).toBeNull()
    expect(isClaudePlanRunHeld({ sessionId: 's1', replyId: 'm1', version: '0' })).toBe(false)
  })

  it('the continuation\'s moved pictures join the fresh run\'s opening user message once, in order, as real images', async () => {
    const folder = project({ turns: [
      { blocks: [{ type: 'tool_use', name: 'mcp__batshit__save_note', input: { title: 'Next' } }] },
      { blocks: [{ type: 'text', text: 'Done.' }] }
    ] })
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]).toString('base64')
    const { registry: images, ids } = heldPictures('call-p5', png)
    expect(ids).toEqual(['call-p5'])
    const deferral = '[Tool images from recall were not shown to the current model: too_many.]'
    const brain = brainWith({ save_note: saveNote() })
    const build = (brain as any).buildToolsForMode3
    ;(brain as any).buildToolsForMode3 = vi.fn(async (...args: any[]) => ({ ...(await build(...args)), ephemeralImages: images, initialImageToolIds: ['call-p5'], imageDeferrals: [deferral] }))
    const result = await brain.streamNativeMode(request(folder, { messageId: 'm2', claudePlanApprovalVersion: 0 }))
    const { parts, failure } = await collectToEnd(result)
    // Delivered once: the second step adds nothing, so Claude Code's opening is never edited (no unsupported_addition).
    expect(failure).toBeNull()
    expect(parts.filter(p => p.type === 'text-delta').map(p => p.text).join('')).toBe('Done.')
    // The startup handshake's prompt aside (D2), Claude Code reads one opening user message.
    const prompts = fakeLog(folder).filter(e => e.kind === 'prompt' && e.prompt !== 'batshit-handshake')
    expect(prompts).toHaveLength(1)
    expect(prompts[0].content).toEqual([
      { type: 'text', text: 'Please help.' },
      { type: 'text', text: `${EPHEMERAL_IMAGE_MESSAGE_MARKER} Images returned by native_bash_execute (Agent Browser screenshot):` },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } },
      { type: 'text', text: deferral }
    ])
    expect(images.pending()).toBe(0)
    await settledAll()
  })
})
