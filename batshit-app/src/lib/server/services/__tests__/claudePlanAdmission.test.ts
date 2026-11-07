// @vitest-environment node
/** SA-139 P1 (D1, D12, V1): the Claude plan's one admission owner. */
import { describe, expect, it, vi } from 'vitest'
const redisCalls = vi.hoisted(() => ({ count: 0 }))
vi.mock('$lib/server/redis', () => ({ redis: new Proxy({}, { get: () => { redisCalls.count++; throw new Error('Admission must not touch Redis') } }) }))
import {
  admitClaudePlanSelection, assertClaudePlanApprovalSource, assertClaudePlanPresetSettings, assertClaudePlanRunSettings,
  ClaudePlanError, claudePlanHttpStatus, type ClaudePlanReadiness, planClaudePlanRawSamplingClears } from '../claudePlanAdmission'
import { CLAUDE_PLAN_CONNECTION_ID, CLAUDE_PLAN_MODEL_CHOICES } from '$lib/utils/claudePlanConnection'
import { CLAUDE_CLI_MODEL_CHOICES } from '$lib/data/claude-cli-models'

const connection = { id: CLAUDE_PLAN_CONNECTION_ID, type: 'direct' as const, service: 'claude-plan' }
const ready = async (): Promise<ClaudePlanReadiness> => ({ state: 'ready', version: '2.1.296' })
const admit = (overrides: Partial<Parameters<typeof admitClaudePlanSelection>[0]> = {}) =>
  admitClaudePlanSelection({ connection, modelId: 'opus', settings: {}, consumer: 'primary', readiness: ready, ...overrides })
async function refusal(promise: Promise<unknown>) {
  const error = await promise.then(() => null, failure => failure)
  expect(error).toBeInstanceOf(ClaudePlanError)
  expect(claudePlanHttpStatus(error)).toBe(409)
  return error as ClaudePlanError
}

describe('Claude plan admission', () => {
  it('admits every supported consumer with the exact identity, model and effort', async () => {
    for (const consumer of ['primary', 'subagent', 'worker', 'compact']) {
      const admitted = await admit({ consumer, settings: { anthropicEffort: 'xhigh', nativeTools: { workMode: 'plan' } } })
      expect(admitted).toEqual({ connectionId: CLAUDE_PLAN_CONNECTION_ID, consumer, modelId: 'opus', cliModel: 'opus', effort: 'xhigh', alwaysThinking: null })
      expect(Object.isFrozen(admitted)).toBe(true)
    }
    expect(redisCalls.count).toBe(0)
  })

  it('offers the managed Claude Code list plus CLI default, which sends no --model and no --effort unless set', async () => {
    expect(CLAUDE_PLAN_MODEL_CHOICES.map(choice => choice.value)).toEqual(['default', ...CLAUDE_CLI_MODEL_CHOICES.map(choice => choice.value)])
    expect(await admit({ modelId: 'default' })).toMatchObject({ modelId: 'default', cliModel: null, effort: null })
    expect(await admit({ modelId: ' claude-opus-5-5 ', settings: { anthropicEffort: '' } })).toMatchObject({ cliModel: 'claude-opus-5-5', effort: null })
  })

  it('refuses a half-named or conflicting identity before anything else', async () => {
    const readiness = vi.fn(ready)
    for (const bad of [
      { type: 'direct' as const, service: 'claude-plan' },
      { type: 'direct' as const, id: CLAUDE_PLAN_CONNECTION_ID },
      { ...connection, id: 'claude-plan:other' },
      { ...connection, id: 'direct:claude-plan' },
      { type: 'direct' as const, id: 'direct:claude-plan' },
      { ...connection, service: 'Claude-Plan' },
      { ...connection, type: 'vercel-gateway' as const },
      { id: 'direct:anthropic', type: 'direct' as const, service: 'anthropic' },
      null
    ]) {
      expect((await refusal(admit({ connection: bad, readiness }))).code).toBe('connection_invalid')
    }
    expect(readiness).not.toHaveBeenCalled()
  })

  it('refuses every consumer that cannot hold a run, before reading readiness', async () => {
    const readiness = vi.fn(ready)
    for (const consumer of ['memory-summary', 'graduation', 'judge', 'title', 'voice', 'media', 'embedding', 'artifact', 'n8n']) {
      expect((await refusal(admit({ consumer, readiness }))).message).toMatch(/Primary agent replies, Subagents, Workers and Compact only/)
    }
    expect(readiness).not.toHaveBeenCalled()
  })

  it('honors Thinking only on the models whose thinking Claude Code can turn off (D12, P0 §6)', async () => {
    for (const modelId of ['claude-opus-4-8', 'claude-opus-4-6', 'claude-sonnet-5']) {
      expect(await admit({ modelId, settings: { claudePlanThinking: false } })).toMatchObject({ alwaysThinking: false, effort: null })
      expect(await admit({ modelId, settings: { claudePlanThinking: true, anthropicEffort: 'high' } })).toMatchObject({ alwaysThinking: true, effort: 'high' })
    }
    for (const modelId of ['opus', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1', 'default']) {
      expect((await refusal(admit({ modelId, settings: { claudePlanThinking: false } }))).message).toMatch(/cannot turn thinking on or off/)
    }
    expect((await refusal(admit({ modelId: 'claude-opus-4-6', settings: { claudePlanThinking: 'off' } }))).message).toMatch(/not On or Off/)
    expect((await refusal(admit({ modelId: 'claude-opus-4-6', settings: { claudePlanThinkingBudget: 4000 } }))).code).toBe('setting_unsupported')
    expect(await admit({ modelId: 'claude-opus-5-5', settings: { claudePlanThinking: null } })).toMatchObject({ alwaysThinking: null })
  })

  it('refuses a model off the list', async () => {
    expect((await refusal(admit({ modelId: 'claude-3-opus' }))).code).toBe('model_unavailable')
    expect((await refusal(admit({ modelId: '' }))).code).toBe('model_unavailable')
  })

  it('refuses unsupported saved settings from a raw, preset or restored selection; zero is real, blank is nothing', async () => {
    for (const settings of [{ temperature: 0.2 }, { maxTokens: 0 }, { thinkingMode: 'adaptive' }, { 'anthropic.effort': 'high' }, { anthropicEffort: 'ultra' }, { anthropicEffort: 3 }]) {
      expect((await refusal(admit({ settings }))).code).toBe('setting_unsupported')
    }
    expect((await refusal(admit({ sampling: { temperature: 0 } }))).message).toContain('temperature')
    expect(await admit({ settings: { temperature: null, topP: undefined, seed: '' }, sampling: { temperature: undefined, maxTokens: null } })).toMatchObject({ effort: null })
  })

  it('reads readiness fresh on every admission, so a later change is never hidden by an earlier answer', async () => {
    const states: ClaudePlanReadiness[] = [
      { state: 'unavailable', code: 'signed_out', reason: 'Claude Code is not signed in. Run `claude auth login`, then refresh.' },
      { state: 'ready' },
      { state: 'unavailable', code: 'not_installed', reason: 'Claude Code is not installed.' }
    ]
    const readiness = vi.fn(async () => states.shift()!)
    expect((await refusal(admit({ readiness }))).message).toMatch(/not signed in/)
    expect(await admit({ readiness })).toMatchObject({ modelId: 'opus' })
    expect((await refusal(admit({ readiness }))).code).toBe('connection_unavailable')
    expect(readiness).toHaveBeenCalledTimes(3)
  })
})

describe('Claude plan settings at save and approval resume', () => {
  it('save accepts only the connection settings; the run also allows the agent own runtime keys', () => {
    expect(assertClaudePlanPresetSettings({ anthropicEffort: 'max' }, 'opus')).toEqual({ effort: 'max', alwaysThinking: null })
    expect(() => assertClaudePlanPresetSettings({ nativeTools: { workMode: 'plan' } }, 'opus')).toThrow(/does not support nativeTools/)
    expect(assertClaudePlanRunSettings({ nativeTools: { workMode: 'plan' }, claude_permission_mode: 'default' }, 'opus')).toEqual({ effort: null, alwaysThinking: null })
  })

  it('resumes a Claude plan approval only on the Claude plan, and never moves another reply onto it', () => {
    expect(() => assertClaudePlanApprovalSource('direct:anthropic', 'direct:anthropic')).not.toThrow()
    expect(() => assertClaudePlanApprovalSource(null, undefined)).not.toThrow()
    expect(() => assertClaudePlanApprovalSource(CLAUDE_PLAN_CONNECTION_ID, CLAUDE_PLAN_CONNECTION_ID)).not.toThrow()
    for (const [source, expected] of [[CLAUDE_PLAN_CONNECTION_ID, 'direct:anthropic'], ['direct:anthropic', CLAUDE_PLAN_CONNECTION_ID],
      ['claude-plan:other', CLAUDE_PLAN_CONNECTION_ID], [CLAUDE_PLAN_CONNECTION_ID, null], [null, CLAUDE_PLAN_CONNECTION_ID]]) {
      expect(() => assertClaudePlanApprovalSource(source, expected)).toThrow(expect.objectContaining({ code: 'resume_connection_changed' }))
    }
  })
})

describe('SA-139 (Faye S13): a raw Claude plan pick\'s save removes what admission would refuse', () => {
  const plan = { id: CLAUDE_PLAN_CONNECTION_ID, type: 'direct', service: 'claude-plan' }
  const paid = { primary_model_preset_id: '', primary_model_connection: { id: 'openai', type: 'direct', service: 'openai' },
    primary_model_temperature: 0.4, primary_model_max_tokens: 4096, primary_model_stop_sequences: ['END'] }
  const onPlan = { primary_model_connection: plan, primary_model_provider: 'anthropic', primary_model_name: 'claude-haiku-5-5' }

  it('a save that moves a raw paid agent onto the Claude plan removes every stored copy, and says which in one sentence', () => {
    const planned = planClaudePlanRawSamplingClears(paid, onPlan)
    expect(planned?.clears).toEqual({ primary_model_temperature: null, primary_model_max_tokens: null, primary_model_stop_sequences: null })
    expect(planned?.blockClears).toEqual({})
    expect(planned?.notice).toBe("The Claude plan connection cannot take the agent's temperature, max tokens and stop sequences, so this save removed them.")
  })

  it('the settings block\'s other model keys and an effort or Thinking the model cannot take go too; own keys, a valid effort and blanks stay', () => {
    const block = { temperature: 1.2, customKnob: 5, reasoningEffort: 'minimal', anthropicEffort: 'high', claudePlanThinking: true, nativeTools: { bashAccessMode: 'plan' }, blank: '' }
    const planned = planClaudePlanRawSamplingClears({ primary_model_connection: plan }, onPlan, block)
    expect(planned?.clears).toEqual({})
    // Haiku 5.5 takes High; it decides Thinking itself, so a saved Thinking choice is refused.
    expect(planned?.blockClears).toEqual({ temperature: null, customKnob: null, reasoningEffort: null, claudePlanThinking: null })
    expect(planned?.fields).toEqual(['provider_specific_settings.temperature', 'provider_specific_settings.customKnob', 'provider_specific_settings.reasoningEffort', 'provider_specific_settings.claudePlanThinking'])
    expect(planned?.notice).toBe('The Claude plan connection cannot take the agent\'s model setting "temperature", model setting "customKnob", model setting "reasoningEffort" and Thinking setting, so this save removed them.')
    // An effort the picked model does not take (Opus 4.6 has no Extra High) is removed; with the remainder, admission passes.
    const opus = planClaudePlanRawSamplingClears({ primary_model_connection: plan }, { ...onPlan, primary_model_name: 'claude-opus-4-6' }, { anthropicEffort: 'xhigh', claudePlanThinking: false })
    expect(opus?.blockClears).toEqual({ anthropicEffort: null })
    expect(opus?.notice).toBe("The Claude plan connection cannot take the agent's reasoning effort, so this save removed it.")
    expect(assertClaudePlanRunSettings({ claudePlanThinking: false, nativeTools: {} }, 'claude-opus-4-6')).toEqual({ effort: null, alwaysThinking: false })
    // Delta review: in the block an empty list is set (admission refuses it), unlike a sampling copy's.
    const listed = planClaudePlanRawSamplingClears({ primary_model_connection: plan }, onPlan, { stopSequences: [] })
    expect(listed?.blockClears).toEqual({ stopSequences: null })
    expect(() => assertClaudePlanRunSettings({ stopSequences: [] }, 'claude-haiku-5-5')).toThrow(/does not support stopSequences/)
  })

  it('the values the save itself writes count, a real 0 is a value, and a field the save clears is not named', () => {
    const planned = planClaudePlanRawSamplingClears({ primary_model_connection: plan, primary_model_temperature: 0.7 },
      { primary_model_connection: plan, primary_model_seed: 0, primary_model_top_p: null, primary_model_temperature: null })
    expect(planned?.clears).toEqual({ primary_model_seed: null })
    expect(planned?.notice).toBe("The Claude plan connection cannot take the agent's seed, so this save removed it.")
  })

  it('nothing to remove: a preset pick, another connection, nothing set, an empty stop list or a blank (admission reads both as unset)', () => {
    expect(planClaudePlanRawSamplingClears(paid, { primary_model_preset_id: 'preset-plan', primary_model_connection: plan }, { temperature: 1 })).toBeNull()
    expect(planClaudePlanRawSamplingClears(paid, { primary_model_name: 'gpt-6' }, { temperature: 1 })).toBeNull()
    expect(planClaudePlanRawSamplingClears({ primary_model_connection: plan }, { primary_model_name: 'claude-haiku-5-5' }, { nativeTools: {} })).toBeNull()
    expect(planClaudePlanRawSamplingClears({ primary_model_connection: plan, primary_model_stop_sequences: [], primary_model_temperature: '' }, { primary_model_name: 'claude-haiku-5-5' })).toBeNull()
    // A preset cleared in the same save makes the pick raw.
    expect(planClaudePlanRawSamplingClears({ ...paid, primary_model_preset_id: 'preset-paid', primary_model_connection: plan }, { primary_model_preset_id: '' })?.fields)
      .toEqual(['primary_model_temperature', 'primary_model_max_tokens', 'primary_model_stop_sequences'])
  })
})
