// @vitest-environment node
/**
 * SA-139 P1 (D1, V1): the Claude plan connection is an API connection. It never reads as the Claude
 * Code CLI lane, and no consumer reaches a paid Anthropic key, a cached client or a fallback through it.
 */
import { describe, expect, it, vi } from 'vitest'
vi.unmock('ai')
import { ProviderManager } from '../providers'
import { assertPresetEmbeddingConnection } from '../memory/memoryEmbedder'
import { ClaudePlanError } from '../claudePlanAdmission'
import { claudePlanCatalogModels, claudePlanConnectionOptions } from '../claudePlanCatalog'
import { VercelAIBrain } from '../vercelBrain'
import { primaryCliRuntimeCandidates, subagentCliRuntimeCandidates } from '$lib/utils/cliRuntimeIdentity'
import { autoSelectConnectionForModel, isModelAllowedForConnection, resolveConnectionServiceFromId } from '$lib/utils/modelConnections'
import { getModelPresetAvailability } from '$lib/utils/modelPresetAvailability'
import { normalizePrimaryAgentType } from '$lib/utils/primaryAgentType'
import { CLAUDE_PLAN_CONNECTION_ID, CLAUDE_PLAN_MODEL_CHOICES, isClaudePlanSelection } from '$lib/utils/claudePlanConnection'
import { filterParameters, resolveParameterProvider } from '$lib/utils/parameterFilter'
import { buildRuntimeModelSettings } from '$lib/utils/modelSettingsMapper'
import type { CatalogConnectionOption, CatalogModel } from '$lib/types/modelCatalog'
import type { SavedModel } from '$lib/types/savedModels'

const connection = { id: CLAUDE_PLAN_CONNECTION_ID, type: 'direct' as const, service: 'claude-plan' }
const preset = (modelId: string): SavedModel => ({ id: `plan-${modelId}`, modelName: modelId, provider: 'anthropic', modelId, effectiveModelId: modelId,
  connection, purpose: 'chat', pricing: {}, settings: { anthropicEffort: 'high' } })
const ready = { state: 'ready' as const, installed: true }
const [planOption] = claudePlanConnectionOptions(ready)
const anthropicOption: CatalogConnectionOption = { id: 'direct:anthropic', label: 'Anthropic', transport: 'direct', service: 'anthropic', providers: ['anthropic'], status: 'ready' }

describe('Claude plan is never the Claude CLI lane', () => {
  it('Primary candidates (send-routed classification, configured CLI presets) see no CLI lane', () => {
    for (const id of [CLAUDE_PLAN_CONNECTION_ID, 'claude-plan']) {
      expect(primaryCliRuntimeCandidates('anthropic', id)).toEqual({ codex: false, claude: false })
    }
  })

  it('a Subagent record that names the Claude plan never resolves to the Claude CLI lane, whatever its model name', () => {
    for (const name of ['opus', 'claude-opus-5-5', 'claude-cli']) {
      const row = { primary_model_provider: 'anthropic', primary_model_name: name, primary_model_connection: connection }
      expect(subagentCliRuntimeCandidates(row)).toEqual({ codex: false, claude: false })
    }
    // A leftover CLI Subagent's own Claude hint is still recognized (SA-139 R5 refuses it as retired).
    expect(subagentCliRuntimeCandidates({ primary_model_provider: 'claude-cli', primary_model_name: 'opus' })).toEqual({ codex: false, claude: true })
  })

  it('every spelling of the plan (including direct:claude-plan) is recognized, so it is refused rather than routed elsewhere', () => {
    for (const id of [CLAUDE_PLAN_CONNECTION_ID, 'claude-plan', 'direct:claude-plan', 'DIRECT:Claude-Plan:x']) {
      expect(isClaudePlanSelection({ id })).toBe(true)
      expect(() => assertPresetEmbeddingConnection({ connection: { type: 'direct', id } })).toThrow(/Claude plan presets cannot provide memory embeddings/)
    }
    expect(resolveConnectionServiceFromId('direct:claude-plan')).toBe('claude-plan')
    for (const id of ['direct:anthropic', 'claude-cli', 'claude-planner', 'direct:claude-planx']) expect(isClaudePlanSelection({ id })).toBe(false)
  })

  it('runtime provider id, service lookup and agent type read it as the API connection it is', () => {
    const resolve = (VercelAIBrain.prototype as any).resolveRuntimeProviderId
    expect(resolve.call({}, 'opus', connection)).toBe('claude-plan')
    expect(resolveConnectionServiceFromId(CLAUDE_PLAN_CONNECTION_ID)).toBe('claude-plan')
    expect(normalizePrimaryAgentType({ primary_model_provider: 'anthropic', primary_model_name: 'claude-opus-5-5', primary_model_connection: connection } as any)).toBe('api')
  })

  // SA-139 R5 removed the Claude Code CLI Subagent picker, the one picker that refused the plan.
  it('pickers allow it for API agents; a locked connection disables it with its reason', () => {
    for (const modelId of ['opus', 'claude-opus-5-5', 'default']) {
      expect(getModelPresetAvailability({ model: preset(modelId), agentType: 'api', connectionOptions: [planOption] })).toMatchObject({ disabled: false })
    }
    const [locked] = claudePlanConnectionOptions({ state: 'unavailable', code: 'signed_out', reason: 'Claude Code is not signed in.', installed: true })
    expect(getModelPresetAvailability({ model: preset('opus'), agentType: 'api', connectionOptions: [locked] }))
      .toMatchObject({ disabled: true, disabledBecause: 'locked', reason: 'Claude Code is not signed in.' })
  })

  it('catalog rows stay on their own connection; an Anthropic row never auto-selects the plan', () => {
    const rows = claudePlanCatalogModels(ready)
    expect(rows[0]).toMatchObject({ id: `${CLAUDE_PLAN_CONNECTION_ID}/default`, provider: 'anthropic', connectionId: CLAUDE_PLAN_CONNECTION_ID })
    for (const row of rows) expect(row.features).toMatchObject({ vision: true })
    for (const row of rows) {
      expect(isModelAllowedForConnection(row, planOption)).toBe(true)
      expect(isModelAllowedForConnection(row, anthropicOption)).toBe(false)
      expect(autoSelectConnectionForModel([anthropicOption, planOption], row)?.id).toBe(CLAUDE_PLAN_CONNECTION_ID)
    }
    const paidRow: CatalogModel = { id: 'anthropic/claude-opus-5-5', provider: 'anthropic', name: 'claude-opus-5-5', displayName: 'Opus 5.5',
      connectionId: 'direct:anthropic', availableConnections: ['direct:anthropic'], transport: 'direct' }
    expect(isModelAllowedForConnection(paidRow, planOption)).toBe(false)
    expect(autoSelectConnectionForModel([anthropicOption, planOption], paidRow)?.id).toBe('direct:anthropic')
    expect(claudePlanCatalogModels({ installed: false })).toEqual([])
    expect(claudePlanConnectionOptions({ state: 'unavailable', code: 'not_installed', reason: 'x', installed: false })).toEqual([])
  })
})

describe('Claude plan preset parameters (D12)', () => {
  const offered = (modelId: string) => filterParameters({ provider: resolveParameterProvider('anthropic', connection), modelId, connectionInfo: connection, purpose: 'chat' }).map(definition => definition.name)
  it('offers effort everywhere and Thinking only where Claude Code can turn it off; no sampling parameter', () => {
    for (const modelId of ['default', 'opus', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']) expect(offered(modelId)).toEqual(['anthropicEffort'])
    for (const modelId of ['claude-opus-4-8', 'claude-opus-4-6', 'claude-sonnet-5']) expect(offered(modelId)).toEqual(['anthropicEffort', 'claudePlanThinking'])
  })
  it('puts nothing on the wire: effort and Thinking reach the run only through admission', () => {
    const mapped = buildRuntimeModelSettings({ provider: 'anthropic', modelId: 'claude-opus-4-6', connection, settings: { anthropicEffort: 'high', claudePlanThinking: false, nativeTools: { workMode: 'plan' } } as any })
    expect(mapped.providerOptions).toEqual({})
    expect(Object.values(mapped.standard).filter(value => value !== undefined)).toEqual([])
  })
})

describe('the plan check runs at Send and in the chat-bar preview too (data review S1)', () => {
  it('refuses unsupported settings, Thinking on an alias and a level the model does not take, with the admission words', async () => {
    const { previewRuntimeReasoningSettings } = await import('$lib/utils/modelSettingsMapper')
    const { ModelReasoningSettingError } = await import('$lib/utils/modelReasoningControls')
    const cases: [string, Record<string, unknown>, RegExp][] = [
      ['claude-opus-5-5', { temperature: 0.5, anthropicEffort: 'high' }, /does not support temperature/],
      ['opus', { claudePlanThinking: false }, /cannot turn thinking on or off for opus/],
      ['claude-opus-4-6', { anthropicEffort: 'xhigh' }, /does not take Extra High effort on claude-opus-4-6/]
    ]
    for (const [modelId, settings, words] of cases) {
      expect(previewRuntimeReasoningSettings({ provider: 'anthropic', modelId, connection, settings: settings as any }).error).toMatch(words)
      expect(() => buildRuntimeModelSettings({ provider: 'anthropic', modelId, connection, settings: settings as any })).toThrow(ModelReasoningSettingError)
    }
    expect(previewRuntimeReasoningSettings({ provider: 'anthropic', modelId: 'claude-opus-4-6', connection,
      settings: { anthropicEffort: 'max', claudePlanThinking: false, nativeTools: { workMode: 'plan' }, claude_permission_mode: 'default' } as any })).toEqual({ values: { effort: 'max', thinking: false }, error: null })
  })
  it('offers Opus 4.6 only the four levels Claude Code takes; an unknown model gets no binding', async () => {
    const { reviewedReasoningBinding } = await import('$lib/data/reasoning-controls')
    expect(reviewedReasoningBinding({ modelId: 'claude-opus-4-6', connection })?.descriptor.controls[0]).toMatchObject({ values: ['low', 'medium', 'high', 'max'] })
    expect(reviewedReasoningBinding({ modelId: 'claude-opus-5-5', connection })?.descriptor.controls[0]).toMatchObject({ values: ['low', 'medium', 'high', 'xhigh', 'max'] })
    expect(reviewedReasoningBinding({ modelId: 'claude-3-opus', connection })).toBeNull()
    const effort = filterParameters({ provider: resolveParameterProvider('anthropic', connection), modelId: 'claude-opus-4-6', connectionInfo: connection, purpose: 'chat' })
      .find(definition => definition.name === 'anthropicEffort')!
    expect(effort.options?.map(option => option.value)).toEqual(['low', 'medium', 'high', 'max'])
  })
  it('never reads image transport for a Claude plan preset: no plan model resolves to a local AI provider (Faye nit)', async () => {
    const { resolveModelIds } = await import('$lib/utils/modelIdResolver')
    const { isLocalProviderId } = await import('../localImageTransportPolicy')
    for (const choice of CLAUDE_PLAN_MODEL_CHOICES) {
      const ids = resolveModelIds({ developerId: 'anthropic', modelId: choice.value, effectiveModelId: choice.value, connection })
      expect(isLocalProviderId(ids?.providerId ?? 'anthropic')).toBe(false)
      expect(isLocalProviderId(connection.service)).toBe(false)
    }
  })
})

describe('no paid fallback', () => {
  it('ProviderManager refuses the Claude plan before its cache, its fallback model or its automatic fallback', () => {
    const manager = new ProviderManager({ apiKeys: { anthropic: 'sk-ant-fixture' } } as any)
    const paid = manager.getModel('claude-opus-5-5', { transport: 'direct', service: 'anthropic' })
    expect(paid).toBeTruthy()
    for (const service of ['claude-plan', 'Claude-Plan', 'claude-plan:local']) {
      expect(() => manager.getModel('claude-opus-5-5', { transport: 'direct', service, allowAutoFallback: true,
        fallbackModel: { modelName: 'claude-opus-5-5', transport: 'direct', service: 'anthropic' } }))
        .toThrow(ClaudePlanError)
    }
    // A selection that carries only the id (no service) is refused too, before the paid Anthropic key (M1).
    for (const connectionId of ['claude-plan:local', 'direct:claude-plan']) {
      expect(() => manager.getModel('claude-opus-5-5', { transport: 'direct', connectionId, allowAutoFallback: true,
        fallbackModel: { modelName: 'claude-opus-5-5', transport: 'direct', service: 'anthropic' } })).toThrow(ClaudePlanError)
    }
  })

  it('the API brain refuses any Claude plan spelling before it builds a ProviderManager or a paid client (M1)', async () => {
    const getModel = (VercelAIBrain.prototype as any).getModel
    for (const spelling of [{ type: 'direct', id: CLAUDE_PLAN_CONNECTION_ID }, { type: 'direct', service: 'claude-plan' }, { type: 'direct', id: 'direct:claude-plan' }, connection]) {
      const owner = { getProviderManagerForUser: vi.fn() }
      const failure = await getModel.call(owner, 'claude-opus-5-5', spelling, 'user').then(() => null, (error: unknown) => error)
      expect(failure).toBeInstanceOf(ClaudePlanError)
      expect((failure as ClaudePlanError).status).toBe(409)
      expect((failure as ClaudePlanError).message).toMatch(/runs only through its own Claude Code run, not a provider client/)
      expect(owner.getProviderManagerForUser).not.toHaveBeenCalled()
    }
  })
})
