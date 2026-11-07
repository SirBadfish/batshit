import { describe, expect, it } from 'vitest'
import { defaultAppActionsPolicy, parseAppActionsPolicy, parseAppActionsPortableGrant, isAppActionsOperationResponse, isAppActionsNativePolicyResponse, isAppActionsApprovalPreviewForControl, APP_ACTIONS_NATIVE_CHANGE_CONTROL_ID, type AppActionsOperationResponse, type AppActionsApprovalPreview } from './managementContract'
import { CONFIGURED_TTS_FIELDS, type ConfiguredTtsSelection } from './configuredTtsPreferences'
import { parseManagedSettingsChangeInput, parseManagedSettingsReportInput } from './managementInput'
import { validateOwnRead } from './validation'
import { parseSettingsSubjectSelector } from './reportContract'
import { policyContainsSubject } from '$lib/server/services/appActions/settings/authority'
import { buildInstructionsPreview } from '$lib/server/services/appActions/settings/instructionPreview'
import { planInstructionsChanges } from '$lib/server/services/appActions/settings/instructionAdapter'
import { MCP_CONFIGURATION_ID, MCP_CONFIGURATION_EFFECTS, MCP_CONFIGURATION_STAGES, isMcpReportId, isMcpOperationId, composeMcpManagementMode, parseMcpConfigurationChanges, parseMcpConfigurationQuery, isMcpConfigurationReview, mcpConfigurationEffects, type McpPrerequisiteReview } from './mcpConfiguration'

const inheritedTts: ConfiguredTtsSelection = { providerId: null, modelId: null, voiceId: null, profileId: null }
const providerTts: ConfiguredTtsSelection = { providerId: 'openai', modelId: null, voiceId: 'alloy', profileId: null }
function mcpResponse(): AppActionsOperationResponse {
  return { success: true, operation: { operationId: `aso_${'a'.repeat(24)}_mcp_config_${'b'.repeat(32)}`, intentDigest: 'c'.repeat(64),
    status: 'awaiting_approval', actor: { kind: 'portable', label: 'MCP helper' }, reviewExpiresAt: '2026-10-18T00:10:00.000Z', hardDeadlineAt: null,
    executionBudgetMs: 180_000, executionDeadlineAt: null, canDecide: true, outcomes: [], resourceOutcomes: [],
    preview: { semanticId: MCP_CONFIGURATION_ID, targets: [], excluded: [], effects: [...MCP_CONFIGURATION_EFFECTS], resource: {
      kind: 'mcp-configuration', planId: `mcpp_${'d'.repeat(32)}`, candidateId: `mcpc_${'e'.repeat(32)}`, mode: 'create', resource: { kind: 'mcp-gateway', gatewayId: 'assigned' },
      before: null, after: { id: 'assigned', slug: 'gateway', name: 'Gateway', type: 'custom', enabled: true, url: 'https://source.example/mcp',
        evidence: { kind: 'supplied', uri: 'https://source.example/docs', version: '1.2.3' } }, stages: [...MCP_CONFIGURATION_STAGES] } } } }
}
describe('I1 resource wire and complete human disclosure', () => {
  it.each(['before', 'after'] as const)('BL1804 refuses stored %s secret argv in the complete resource disclosure', side => {
    const response = mcpResponse() as any, resource = response.operation.preview.resource
    const safe = { id: 'assigned', slug: 'gateway', name: 'Gateway', type: 'stdio', enabled: true, stdio: {
      command: 'npx', args: ['--mode=read'], allowedLocations: [], cwdPolicy: 'none', envRefs: [{ envVar: 'SOURCE_API_KEY', savedKeyRef: 'custom-mcp' }],
      startupTimeoutMs: 10_000, toolCallTimeoutMs: 60_000 } }
    resource.mode = 'update'; resource.before = structuredClone(safe); resource.after = structuredClone(safe)
    expect(isAppActionsOperationResponse(response)).toBe(true)
    resource[side].stdio.args = ['--api-key=LEGACY_SECRET']
    expect(isAppActionsOperationResponse(response)).toBe(false)
  })
  it('keeps strict65/72-byte MCP IDs, numeric deadlines, report-only paging and outcomeOffset-only lookup', () => {
    const reportId = `asr_${'a'.repeat(24)}_mcp_${'b'.repeat(32)}`, operationId = mcpResponse().operation.operationId
    expect(isMcpReportId(reportId)).toBe(true); expect(reportId).toHaveLength(65)
    expect(isMcpOperationId(operationId)).toBe(true); expect(operationId).toHaveLength(72)
    expect(parseManagedSettingsReportInput({ reportId, cursor: `mcp1:${'c'.repeat(32)}:0` })).toHaveProperty('reportId', reportId)
    const change = { op: 'change', requestId: `${'a'.repeat(24)}:mcp`, reportId, semanticId: MCP_CONFIGURATION_ID, changes: { source: { candidateId: `mcpc_${'e'.repeat(32)}` } }, hardDeadlineAt: 1_800_000_000_000 }
    expect(parseManagedSettingsChangeInput(change)).toEqual(change)
    expect(parseManagedSettingsChangeInput({ op: 'outcome', operationId, outcomeOffset: 0 })).toEqual({ op: 'outcome', operationId, outcomeOffset: 0 })
    for (const input of [{ ...change, hardDeadlineAt: '2026-10-18T00:00:00.000Z' }, { op: 'outcome', operationId, cursor: 'old' }, { op: 'cancel', operationId, outcomeOffset: 0 }, { ...change, reportId: reportId + 'x' }]) {
      expect(() => parseManagedSettingsChangeInput(input)).toThrow()
    }
    for (const input of [{ op: 'page', reportId }, { reportId, domain: 'mcp-configuration' }, { domain: 'mcp-configuration', targets: { allAgents: true } }]) {
      expect(() => parseManagedSettingsReportInput(input)).toThrow()
    }
  })
  it('requires matching input/candidate/resource/boot/budget and refuses missing, secret-bearing or incomplete disclosure', () => {
    const response = mcpResponse(), operation = response.operation
    expect(isAppActionsOperationResponse(response)).toBe(true)
    const input = { op: 'change', requestId: `${'a'.repeat(24)}:mcp`, reportId: `asr_${'a'.repeat(24)}_mcp_${'f'.repeat(32)}`, semanticId: MCP_CONFIGURATION_ID,
      changes: { source: { candidateId: `mcpc_${'e'.repeat(32)}` } } }
    const preview = { controlId: APP_ACTIONS_NATIVE_CHANGE_CONTROL_ID, input, operationId: operation.operationId, intentDigest: operation.intentDigest,
      preview: operation.preview, reviewExpiresAt: operation.reviewExpiresAt, hardDeadlineAt: null, executionBudgetMs: 180_000, initialOutcomes: [] }
    expect(isAppActionsApprovalPreviewForControl(preview, { controlId: preview.controlId, input })).toBe(true)
    for (const corrupt of [
      { ...preview, executionBudgetMs: 30_000 }, { ...preview, initialOutcomes: undefined },
      { ...preview, operationId: operation.operationId.replace('a'.repeat(24), '9'.repeat(24)) },
      { ...preview, preview: { ...operation.preview, resource: undefined } },
      { ...preview, preview: { ...operation.preview, resource: { ...(operation.preview as any).resource, candidateId: `mcpc_${'0'.repeat(32)}` } } },
      { ...preview, preview: { ...operation.preview, resource: { ...(operation.preview as any).resource, after: { ...(operation.preview as any).resource.after, url: 'https://source.example/mcp?token=secret' } } } },
      { ...preview, preview: { ...operation.preview, targets: [{ subject: { kind: 'primary', id: 'fake' }, label: 'Fake resource', changes: [] }] } }
    ]) expect(isAppActionsApprovalPreviewForControl(corrupt, { controlId: preview.controlId, input })).toBe(false)
    const oversized = structuredClone(response) as any
    oversized.operation.preview.resource.after.stdio = { command: 'npx', args: ['x'.repeat(70_000)] }
    expect(isAppActionsOperationResponse(oversized)).toBe(false)
  })
})
function ttsResponse(after: ConfiguredTtsSelection = providerTts): AppActionsOperationResponse {
  return { success: true, operation: { operationId: `aso_${'a'.repeat(24)}_${'b'.repeat(32)}`, intentDigest: 'c'.repeat(64), status: 'awaiting_approval',
    actor: { kind: 'portable', label: 'Helper' }, preview: { semanticId: 'agent.voice.tts-selection', targets: [{ subject: { kind: 'primary', id: 'a' }, label: 'A',
      changes: CONFIGURED_TTS_FIELDS.map(field => ({ field, label: `${field} (effective before → after)`, before: null, after: after[field] })) }], excluded: [], effects: ['Next reply voice selection only.'] },
    reviewExpiresAt: '2026-10-18T00:10:00.000Z', hardDeadlineAt: null, executionBudgetMs: 30000, executionDeadlineAt: null, canDecide: true, outcomes: [] } }
}
function nativeTtsPreview(changes: unknown, after: ConfiguredTtsSelection = providerTts) {
  const operation = ttsResponse(after).operation
  const input = { op: 'change', requestId: `${'a'.repeat(24)}:tts`, reportId: `asr_${'a'.repeat(24)}_${'b'.repeat(32)}`, semanticId: operation.preview.semanticId, changes }
  const preview: AppActionsApprovalPreview = { controlId: APP_ACTIONS_NATIVE_CHANGE_CONTROL_ID, input, operationId: operation.operationId, intentDigest: operation.intentDigest,
    preview: operation.preview, reviewExpiresAt: operation.reviewExpiresAt, hardDeadlineAt: null, executionBudgetMs: 30000, initialOutcomes: [] }
  return { preview, control: { controlId: APP_ACTIONS_NATIVE_CHANGE_CONTROL_ID, input } }
}

describe('shared App Actions management policy/input boundary', () => {
  it('admits complete CLI selection review, binds its preset to input and requires every unavailable target', () => {
    const response = ttsResponse()
    response.operation.preview.semanticId = 'agent.model.selection'
    response.operation.preview.targets[0].changes = [
      { field: 'presetId', label: 'Saved Model', before: 'old', after: 'new' }, { field: 'program', label: 'CLI Program', before: 'claude', after: 'claude' },
      { field: 'nativeStorage', label: 'Native Storage', before: 'retained', after: 'retained' }, { field: 'nativeModel', label: 'Effective Native Model', before: 'alias', after: 'alias' },
      { field: 'fast', label: 'Native Speed', before: null, after: null }
    ]
    const native = { claudeModel: { state: 'set' as const, value: 'alias' }, claudeLegacyModel: { state: 'absent' as const } }
    response.operation.preview.targets[0].modelSelection = { intent: 'select', role: 'cli-primary', presetBefore: { state: 'set', value: 'old' },
      presetAfter: { state: 'set', value: 'new' }, legacyModel: { state: 'unknown' }, inheritance: 'no-replacement-promised',
      native: { before: native, after: structuredClone(native) }, voice: null }
    expect(isAppActionsOperationResponse(response)).toBe(true)
    const { preview, control } = nativeTtsPreview({ presetId: 'new' })
    preview.preview = response.operation.preview
    preview.input.semanticId = 'agent.model.selection'
    expect(isAppActionsApprovalPreviewForControl(preview, control)).toBe(true)
    preview.preview.targets[0].changes[0].after = 'another'
    expect(isAppActionsApprovalPreviewForControl(preview, control)).toBe(false)
    preview.preview.targets[0].changes[0].after = 'new'
    delete preview.initialOutcomes
    expect(isAppActionsApprovalPreviewForControl(preview, control)).toBe(false)
  })
  it('requires explicit single-Primary Fish opt-in and rejects mixed/local/provider parameters', () => {
    const input = { targets: { subjects: [{ kind: 'primary', id: 'fish_target' }] }, focus: ['agent.voice.tts-selection'], detail: 'choices', query: { ttsCatalog: 'account', ttsProviderId: 'fish' } }
    expect(parseManagedSettingsReportInput(input)).toEqual(input)
    for (const change of [{ targets: undefined }, { targets: { allAgents: true } }, { targets: { subjects: [{ kind: 'subagent', id: 'fish_target' }] } },
      { targets: { subjects: [{ kind: 'primary', id: 'a' }, { kind: 'primary', id: 'a' }] } }, { focus: ['agent.identity'] }, { detail: 'summary' },
      { query: { ...input.query, ttsOffset: 0 } }, { query: { ...input.query, instructionText: true } }, { query: { ...input.query, ttsProviderId: 'other' } }]) {
      expect(() => parseManagedSettingsReportInput({ ...input, ...change })).toThrow()
    }
    const reportId = `asr_${'a'.repeat(24)}_${'b'.repeat(32)}`, cursor = `sv1:${'c'.repeat(64)}:1`
    expect(parseManagedSettingsReportInput({ reportId, cursor })).toEqual({ reportId, cursor })
    expect(() => parseManagedSettingsReportInput({ reportId, cursor, query: input.query })).toThrow()
  })
  it('validates four expanded reply-voice facts without treating them as tagged mutation inputs', () => {
    for (const after of [inheritedTts, providerTts, { ...providerTts, profileId: 'saved_voice' }]) {
      expect(isAppActionsOperationResponse(ttsResponse(after))).toBe(true)
    }
    for (const variant of ['missing', 'duplicate', 'unknown', 'extra'] as const) {
      const response = ttsResponse(), rows = response.operation.preview.targets[0].changes
      if (variant === 'missing') rows.pop()
      if (variant === 'duplicate') rows[3].field = 'voiceId'
      if (variant === 'unknown') rows[3].field = 'runtime'
      if (variant === 'extra') rows.push({ field: 'runtime', label: 'Runtime', before: null, after: 'local' })
      expect(isAppActionsOperationResponse(response), variant).toBe(false)
    }
    const subagent = ttsResponse(); subagent.operation.preview.targets[0].subject.kind = 'subagent'
    expect(isAppActionsOperationResponse(subagent)).toBe(false)
  })
  it('retains sparse legacy reply-voice BEFORE facts while requiring a coherent AFTER tuple', () => {
    const response = ttsResponse()
    response.operation.preview.targets[0].changes[3].before = 'legacy_profile_without_provider'
    expect(isAppActionsOperationResponse(response)).toBe(true)
    for (const after of [{ ...inheritedTts, modelId: 'orphan_model' }, { ...inheritedTts, voiceId: 'orphan_voice' },
      { ...inheritedTts, profileId: 'orphan_profile' }, { ...providerTts, profileId: 'saved_voice', voiceId: null }]) {
      expect(isAppActionsOperationResponse(ttsResponse(after))).toBe(false)
    }
    for (const fact of [false, 1, '', ' leading', 'control\nvalue', '\ud800']) {
      for (const side of ['before', 'after'] as const) {
        const invalid = ttsResponse(); invalid.operation.preview.targets[0].changes[2][side] = fact
        expect(isAppActionsOperationResponse(invalid), `${side}:${JSON.stringify(fact)}`).toBe(false)
      }
    }
  })
  it('uses literal null for inheritance without confusing a real reply-voice ID named (inherit)', () => {
    const literalId = { ...providerTts, voiceId: '(inherit)' }
    const provider = nativeTtsPreview({ selection: 'provider', providerId: 'openai', modelId: null, voiceId: '(inherit)' }, literalId)
    expect(isAppActionsApprovalPreviewForControl(provider.preview, provider.control)).toBe(true)
    const inherit = nativeTtsPreview({ selection: 'inherit' }, inheritedTts)
    expect(isAppActionsApprovalPreviewForControl(inherit.preview, inherit.control)).toBe(true)
    const falseInherit = nativeTtsPreview({ selection: 'inherit' }, literalId)
    expect(isAppActionsApprovalPreviewForControl(falseInherit.preview, falseInherit.control)).toBe(false)
  })
  it('binds each native reply-voice AFTER tuple to its original strict tagged request', () => {
    const provider = nativeTtsPreview({ selection: 'provider', providerId: 'openai', modelId: null, voiceId: 'alloy' })
    expect(isAppActionsApprovalPreviewForControl(provider.preview, provider.control)).toBe(true)
    for (const after of [{ ...providerTts, providerId: 'browser' }, { ...providerTts, modelId: 'tts-1' },
      { ...providerTts, voiceId: 'echo' }, { ...providerTts, profileId: 'saved_voice' }]) {
      const mismatch = nativeTtsPreview(provider.preview.input.changes, after)
      expect(isAppActionsApprovalPreviewForControl(mismatch.preview, mismatch.control)).toBe(false)
    }
    const profile = nativeTtsPreview({ selection: 'profile', profileId: 'saved_voice' }, { ...providerTts, profileId: 'saved_voice' })
    expect(isAppActionsApprovalPreviewForControl(profile.preview, profile.control)).toBe(true)
    profile.preview.preview.targets[0].changes[3].after = 'different_saved_voice'
    expect(isAppActionsApprovalPreviewForControl(profile.preview, profile.control)).toBe(false)
    for (const changes of [{ providerId: 'openai' }, { selection: 'inherit', voiceId: null }, { selection: 'provider', providerId: 'openai', voiceId: 'alloy' },
      { selection: 'profile', profileId: 'saved_voice', providerId: 'openai' }]) {
      const invalid = nativeTtsPreview(changes)
      expect(isAppActionsApprovalPreviewForControl(invalid.preview, invalid.control)).toBe(false)
    }
  })
  it('requires captured nonexecuting native reply-voice outcomes without adding execution authority', () => {
    const native = nativeTtsPreview({ selection: 'inherit' }, inheritedTts)
    delete native.preview.initialOutcomes
    expect(isAppActionsApprovalPreviewForControl(native.preview, native.control)).toBe(false)
    native.preview.initialOutcomes = [{ subject: { kind: 'primary', id: 'b' }, status: 'unavailable', reason: 'tts_source_unavailable', saved: 'not_requested', readback: 'not_requested', visible: 'unchanged' }]
    expect(isAppActionsApprovalPreviewForControl(native.preview, native.control)).toBe(true)
    native.preview.initialOutcomes[0].subject.id = 'a'
    expect(isAppActionsApprovalPreviewForControl(native.preview, native.control)).toBe(false)
  })
  it('preserves complete 256-UTF8 reply-voice facts and finite effective labels without widening other previews', () => {
    const voiceId = '😀'.repeat(64), modelId = 'm'.repeat(256)
    const native = nativeTtsPreview({ selection: 'provider', providerId: 'openai', modelId, voiceId }, { ...providerTts, modelId, voiceId })
    const rows = native.preview.preview.targets[0].changes
    rows[1].before = 'b'.repeat(256)
    rows[1].label = `modelId (effective ${'b'.repeat(256)} → ${modelId})`
    expect(isAppActionsApprovalPreviewForControl(native.preview, native.control)).toBe(true)
    rows[1].label = 'é'.repeat(300)
    expect(isAppActionsApprovalPreviewForControl(native.preview, native.control)).toBe(true)
    rows[1].label += 'x'
    expect(isAppActionsApprovalPreviewForControl(native.preview, native.control)).toBe(false)
    for (const side of ['before', 'after'] as const) {
      const over = ttsResponse(); over.operation.preview.targets[0].changes[2][side] = `${voiceId}x`
      expect(isAppActionsOperationResponse(over)).toBe(false)
    }
    const generic = ttsResponse()
    generic.operation.preview.semanticId = 'agent.identity'
    generic.operation.preview.targets[0].changes = [{ field: 'name', label: 'x'.repeat(201), before: 'A', after: 'B' }]
    expect(isAppActionsOperationResponse(generic)).toBe(false)
  })
  it('validates the complete eight-row Memory review and requires both automatic mode rows together', () => {
    const changes = [
      { field: 'enabled', label: 'Memory Enabled', before: false, after: true },
      { field: 'floorMode', label: 'Floor', before: 'custom', after: 'auto' },
      { field: 'ceilingHeadroomMode', label: 'Headroom', before: 'auto', after: 'auto' },
      ...['onMyMind', 'triggers', 'recalled', 'triggerLingerTurns', 'recallLingerTurns'].map(field => ({ field, label: field, before: 1, after: 0 }))
    ]
    const response = { success: true, operation: { operationId: `aso_${'a'.repeat(24)}_${'b'.repeat(32)}`, intentDigest: 'c'.repeat(64), status: 'awaiting_approval',
      actor: { kind: 'portable', label: 'Helper' }, preview: { semanticId: 'agent.memory.preferences', targets: [{ subject: { kind: 'primary', id: 'a' }, label: 'A', changes }], excluded: [], effects: ['Memory preferences only.'] },
      reviewExpiresAt: '2026-10-17T00:10:00.000Z', hardDeadlineAt: null, executionBudgetMs: 30000, executionDeadlineAt: null, canDecide: true, outcomes: [] } }
    expect(isAppActionsOperationResponse(response)).toBe(true)
    const half = structuredClone(response); half.operation.preview.targets[0].changes.splice(2, 1)
    expect(isAppActionsOperationResponse(half)).toBe(false)
    const custom = structuredClone(response); custom.operation.preview.targets[0].changes[1].after = 'custom'
    expect(isAppActionsOperationResponse(custom)).toBe(false)
    const duplicate = structuredClone(response); duplicate.operation.preview.targets[0].changes[2].field = 'floorMode'
    expect(isAppActionsOperationResponse(duplicate)).toBe(false)
    const collapsed = structuredClone(response); collapsed.operation.preview.targets[0].changes.splice(1, 2, { field: 'windowMode', label: 'Window', before: 'custom', after: 'auto' })
    expect(isAppActionsOperationResponse(collapsed)).toBe(false)
  })
  it('admits full instruction text only as an explicit single-subject values query', () => {
    const request = { targets: { subjects: [{ kind: 'primary', id: 'a' }] }, focus: ['agent.instructions'], detail: 'values', query: { instructionText: true } }
    expect(parseManagedSettingsReportInput(request)).toEqual(request)
    for (const bad of [{ targets: { allAgents: true } }, { targets: { subjects: [{ kind: 'primary', id: 'a' }, { kind: 'subagent', id: 'b' }] } },
      { detail: 'summary' }, { focus: ['agent.identity'] }, { query: { instructionText: true, presetText: 'x' } }, { query: { instructionText: false } }]) {
      expect(() => parseManagedSettingsReportInput({ ...request, ...bad })).toThrow()
    }
  })
  it('validates the fixed complete instruction review table rather than the 200-character scalar limit', () => {
    const entry = { subject: { kind: 'primary' as const, id: 'a' }, status: 'available' as const, type: 'api' as const }
    const before = { system_prompt: '<script>private before</script>\n'.repeat(30) }
    const preview = buildInstructionsPreview([{ subject: entry.subject, label: 'A', before, plan: planInstructionsChanges(entry, before, { customPrompt: '' }) }], [], ['Next compilation only.'])
    const response = { success: true, operation: { operationId: `aso_${'a'.repeat(24)}_${'b'.repeat(32)}`, intentDigest: 'c'.repeat(64), status: 'awaiting_approval',
      actor: { kind: 'portable', label: 'Helper' }, preview, reviewExpiresAt: '2026-10-17T00:10:00.000Z', hardDeadlineAt: null,
      executionBudgetMs: 30000, executionDeadlineAt: null, canDecide: true, outcomes: [] } }
    expect(isAppActionsOperationResponse(response)).toBe(true)
    const missing = structuredClone(response); delete (missing.operation.preview as { instructions?: unknown }).instructions
    expect(isAppActionsOperationResponse(missing)).toBe(false)
    const wrong = structuredClone(response); (wrong.operation.preview.instructions!.targets[0] as any).subject = { kind: 'primary', id: 'b' }
    expect(isAppActionsOperationResponse(wrong)).toBe(false)
    const huge = structuredClone(response); (huge.operation.preview.effects as string[]).push('x'.repeat(65536))
    expect(isAppActionsOperationResponse(huge)).toBe(false)
  })
  it('defaults native policy off/self and all protected categories to Ask first', () => {
    expect(defaultAppActionsPolicy()).toMatchObject({ enabled: false, scope: { mode: 'self', subjects: [], except: [] },
      protected: { instructions: 'ask', memorySettings: 'ask', contextManagement: 'ask' } })
    expect(defaultAppActionsPolicy(true).scope.mode).toBe('selected')
  })
  it('portable holders cannot claim self, invent categories, or copy unknown storage keys into policy', () => {
    expect(() => parseAppActionsPolicy(defaultAppActionsPolicy(), true)).toThrow('policy')
    expect(() => parseAppActionsPolicy({ ...defaultAppActionsPolicy(), provider_specific_settings: {} })).toThrow()
    expect(() => parseAppActionsPolicy({ ...defaultAppActionsPolicy(), protected: { ...defaultAppActionsPolicy().protected, arbitrary: 'allow' } })).toThrow()
    expect(() => parseAppActionsPortableGrant({ policy: defaultAppActionsPolicy(true), expiresAt: 'tomorrow' })).toThrow('expiry')
  })
  it('preserves typed subjects/exclusions and never confuses a same-ID Subagent with self', () => {
    const policy = { ...defaultAppActionsPolicy(), enabled: true }
    expect(policyContainsSubject(policy, { kind: 'primary', id: 'a' }, 'a')).toBe(true)
    expect(policyContainsSubject(policy, { kind: 'subagent', id: 'a' }, 'a')).toBe(false)
    policy.scope = { mode: 'all', subjects: [], except: [{ kind: 'primary', id: 'a' }] }
    expect(policyContainsSubject(policy, { kind: 'primary', id: 'a' }, 'a')).toBe(false)
    expect(policyContainsSubject(policy, { kind: 'subagent', id: 'a' }, 'a')).toBe(true)
    expect(policyContainsSubject(policy, { kind: 'worker', id: 'a' }, 'a')).toBe(false)
  })
  it('admits only adopted scalar changes and explicit held reports', () => {
    const input = { op: 'change', requestId: `${'a'.repeat(24)}:one`, reportId: `asr_${'a'.repeat(24)}_${'b'.repeat(32)}`, semanticId: 'agent.memory.preferences', changes: { recalled: 0 } }
    expect(parseManagedSettingsChangeInput(input)).toMatchObject({ changes: { recalled: 0 } })
    expect(parseManagedSettingsChangeInput({ ...input, changes: { enabled: true, windowMode: 'auto' } })).toMatchObject({ changes: { enabled: true, windowMode: 'auto' } })
    for (const field of ['app_action_policy', 'allowRisky', 'actor', 'path']) expect(() => parseManagedSettingsChangeInput({ ...input, changes: { [field]: true } })).toThrow()
    expect(() => parseManagedSettingsChangeInput({ ...input, settingsPreview: {} })).toThrow()
    expect(() => parseManagedSettingsReportInput({ focus: ['system_prompt'] })).toThrow()
  })
  it('keeps finite read domains separate from subjects, scalar fields and operation custody', () => {
    expect(parseManagedSettingsReportInput({ domain: 'runtime-inspection' })).toEqual({ domain: 'runtime-inspection' })
    for (const field of ['targets', 'focus', 'query', 'detail', 'operationId']) expect(() => parseManagedSettingsReportInput({ domain: 'runtime-inspection', [field]: {} })).toThrow()
    expect(parseManagedSettingsReportInput({ domain: 'skill-access' })).toEqual({ domain: 'skill-access', query: {} })
    expect(() => parseManagedSettingsReportInput({ domain: 'skill-access', focus: ['agent.identity'] })).toThrow()
    expect(() => parseManagedSettingsReportInput({ domain: 'unknown' })).toThrow()
    const input = { op: 'change', requestId: `${'a'.repeat(24)}:skill`, reportId: `asr_${'a'.repeat(24)}_${'b'.repeat(32)}`,
      semanticId: 'agent.skills.access', changes: { assignments: [{ skillId: 'my_skill', enabled: false }] } }
    expect(parseManagedSettingsChangeInput(input)).toMatchObject({ changes: { assignments: [{ skillId: 'my_skill', enabled: false }] } })
    expect(() => parseManagedSettingsChangeInput({ ...input, semanticId: 'runtime.inspection' })).toThrow()
    expect(() => parseManagedSettingsChangeInput({ ...input, changes: { displayName: 'No' } })).toThrow()
    expect(() => parseManagedSettingsReportInput({ reportId: input.reportId, domain: 'skill-access' })).toThrow()
  })
  it('validates complete bounded alias previews with canonical skill IDs, booleans and no scalar-parser fallback', () => {
    const changes = Array.from({ length: 32 }, (_, index) => ({ field: `skill_${index}`, label: `Skill ${index}`, before: true, after: false }))
    const response = { success: true, operation: { operationId: `aso_${'a'.repeat(24)}_${'b'.repeat(32)}`, intentDigest: 'c'.repeat(64), status: 'awaiting_approval',
      actor: { kind: 'portable', label: 'Outside helper' }, preview: { semanticId: 'agent.skills.access',
        targets: [{ subject: { kind: 'primary', id: 'a' }, label: 'A', changes }], excluded: [], effects: ['Changes existing skill access.'] },
      reviewExpiresAt: '2026-10-17T00:10:00.000Z', hardDeadlineAt: null, executionBudgetMs: 30000, executionDeadlineAt: null, canDecide: true, outcomes: [] } }
    expect(isAppActionsOperationResponse(response)).toBe(true)
    for (const bad of [{ field: 'not canonical' }, { after: 'false' }, { before: null }]) {
      const copy = structuredClone(response)
      Object.assign(copy.operation.preview.targets[0].changes[0], bad)
      expect(isAppActionsOperationResponse(copy)).toBe(false)
    }
    const duplicate = structuredClone(response)
    duplicate.operation.preview.targets[0].changes[1].field = changes[0].field
    expect(isAppActionsOperationResponse(duplicate)).toBe(false)
    const tooMany = structuredClone(response)
    tooMany.operation.preview.targets[0].changes.push({ field: 'extra', label: 'Extra', before: false, after: true })
    expect(isAppActionsOperationResponse(tooMany)).toBe(false)
  })

  it('shares actual canonical agent IDs without a token cap and keeps legacy chooser entries diagnostic-only', () => {
    const id = 'long_'.repeat(40)
    expect(validateOwnRead({ subjectAgentId: id })).toEqual({ subjectAgentId: id })
    expect(parseSettingsSubjectSelector({ subjects: [{ kind: 'primary', id }] })).toEqual({ subjects: [{ kind: 'primary', id }] })
    const response = { success: true, agentId: id, generation: 0, subjectRevision: `sha256:${'a'.repeat(64)}`, policy: defaultAppActionsPolicy(), subjects: [
      { subject: { kind: 'primary', id }, label: 'Long primary', type: 'api', available: true },
      { subject: { kind: 'subagent', id: 'odd.id' }, label: 'Legacy Subagent', type: 'api', available: false, reason: 'unsupported_subject_id' }
    ] }
    expect(isAppActionsNativePolicyResponse(response)).toBe(true)
    expect(() => parseAppActionsPolicy({ ...defaultAppActionsPolicy(), scope: { mode: 'selected', subjects: [{ kind: 'subagent', id: 'odd.id' }], except: [] } })).toThrow()
    const forged = structuredClone(response)
    forged.subjects[1].available = true
    expect(isAppActionsNativePolicyResponse(forged)).toBe(false)
  })

})

// Pure finite contract proof only; the actual prepareSettingsControl/SDK/Redis
// approval lineage is owned by the existing integrated producer fixtures.
function fullMcpReview(remove = false): McpPrerequisiteReview {
  const intent = { subject: { kind: 'primary' as const, id: 'chosen' }, gatewayId: 'assigned', membership: remove ? 'disable' as const : 'enable' as const,
    zip: { toolName: 'remote_tool', mode: 'inherit' as const } }
  const resource: McpPrerequisiteReview = { kind: 'mcp-configuration', variant: 'prerequisite', planId: `mcpp_${'d'.repeat(32)}`, candidateId: `mcpc_${'e'.repeat(32)}`,
    resource: { kind: 'mcp-gateway', gatewayId: 'assigned' }, mode: remove ? 'remove' : 'configure', sourceAction: remove ? 'absent' : 'save', before: null,
    after: remove ? null : { id: 'assigned', slug: 'source', name: 'Source', type: 'custom', enabled: true, url: 'https://source.example/mcp' }, intent,
    target: { subject: intent.subject, label: 'Chosen Primary', settingsIdentity: 'remote_tool',
      changes: [{ field: 'membership', label: 'Source selected', before: remove, after: !remove },
        ...['buffer_size','zip_threshold','auto_zip','zip_disabled'].map(field => ({ field: `zip.${field}`, label: field, before: 'unset', after: null }))],
      effectiveZip: { before: { buffer_size: 'unlimited', zip_threshold: 0, auto_zip: false, zip_disabled: false },
        after: { buffer_size: 'unlimited', zip_threshold: 0, auto_zip: false, zip_disabled: false } } }, stages: [...MCP_CONFIGURATION_STAGES] }
  return resource
}
describe('full MCP prerequisite finite intent and complete consent', () => {
  it.each([
    ['block','block','block'], ['block','ask','block'], ['block','allow','block'],
    ['ask','block','block'], ['ask','ask','ask'], ['ask','allow','ask'],
    ['allow','block','block'], ['allow','ask','ask'], ['allow','allow','allow']
  ] as const)('composes explicit Zip intent with MCP %s and Context %s into %s before projection', (mcp, context, expected) => {
    for (const zip of [{ toolName: 'remote_tool', autoZip: false }, { toolName: 'remote_tool', zipThreshold: 0 }, { toolName: 'remote_tool', mode: 'inherit' }]) {
      const parsed = parseMcpConfigurationChanges({ target: { subject: { kind: 'primary', id: 'chosen' }, gatewayId: 'assigned', membership: 'enable', zip } })
      expect(parsed.target?.zip).toEqual(zip)
      expect(composeMcpManagementMode(mcp, context, parsed.target?.zip !== undefined)).toBe(expected)
    }
    expect(composeMcpManagementMode(mcp, context, false)).toBe(mcp)
  })
  it.each([false, true])('requires the same complete source/target/explicit Zip intent in configure/removal=%s review', remove => {
    const resource = fullMcpReview(remove)
    expect(isMcpConfigurationReview(resource)).toBe(true)
    const response = mcpResponse()
    response.operation.preview = { semanticId: MCP_CONFIGURATION_ID, resource, targets: [{ ...resource.target, changes: resource.target.changes.map(row => ({ ...row })) }],
      excluded: [], effects: [...mcpConfigurationEffects(resource)] }
    expect(isAppActionsOperationResponse(response)).toBe(true)
    const input = { op: 'change', requestId: `${'a'.repeat(24)}:full`, reportId: `asr_${'a'.repeat(24)}_mcp_${'b'.repeat(32)}`, semanticId: MCP_CONFIGURATION_ID,
      changes: { ...(remove ? {} : { source: { candidateId: resource.candidateId } }), target: resource.intent } }
    const preview: AppActionsApprovalPreview = { controlId: APP_ACTIONS_NATIVE_CHANGE_CONTROL_ID, input, operationId: response.operation.operationId,
      intentDigest: response.operation.intentDigest, preview: response.operation.preview, reviewExpiresAt: response.operation.reviewExpiresAt,
      hardDeadlineAt: null, executionBudgetMs: 180000, initialOutcomes: [] }
    expect(isAppActionsApprovalPreviewForControl(preview, { controlId: APP_ACTIONS_NATIVE_CHANGE_CONTROL_ID, input })).toBe(true)
    const changed = structuredClone(input); changed.changes.target.subject.id = 'another'
    expect(isAppActionsApprovalPreviewForControl(preview, { controlId: APP_ACTIONS_NATIVE_CHANGE_CONTROL_ID, input: changed })).toBe(false)
    response.operation.preview.targets = []
    expect(isAppActionsOperationResponse(response)).toBe(false)
  })
  it.each([false, true])('discloses only saved installed STDIO enablement/no-op, beforeEnabled=%s', enabled => {
    const source = { id: 'assigned', slug: 'source', name: 'Source', type: 'stdio' as const, enabled,
      stdio: { command: '/usr/local/bin/node', args: ['/opt/owned/server.cjs'], allowedLocations: [], cwdPolicy: 'none' as const,
        envRefs: [{ envVar: 'SERVER_TOKEN', savedKeyRef: 'server-token' }], startupTimeoutMs: 1000, toolCallTimeoutMs: 5000 } }
    const review = { ...fullMcpReview(), before: source, after: { ...source, enabled: true }, sourceAction: enabled ? 'unchanged' : 'save' }
    expect(isMcpConfigurationReview(review)).toBe(true)
    for (const changed of [{ ...review, before: null }, { ...review, sourceAction: enabled ? 'save' : 'unchanged' },
      { ...review, after: { ...review.after, stdio: { ...source.stdio, args: ['/opt/different/server.cjs'] } } },
      { ...review, after: { ...review.after, stdio: { ...source.stdio, envRefs: [] } } }]) expect(isMcpConfigurationReview(changed)).toBe(false)
    expect(parseMcpConfigurationQuery({ kind: 'prerequisite', target: review.intent })).toEqual({ kind: 'prerequisite', target: review.intent })
  })
  it('rejects ambiguous/raw-empty/posted-identity forms without silently dropping intent', () => {
    const target = { subject: { kind: 'primary', id: 'chosen' }, gatewayId: 'assigned', membership: 'enable' }
    for (const zip of [{}, { toolName: 'remote_tool' }, { toolName: 'remote_tool', mode: 'inherit', zipThreshold: 0 },
      { toolName: 'remote_tool', mode: 'auto', autoZip: false }, { settingsIdentity: 'some_row', autoZip: false }]) {
      expect(() => parseMcpConfigurationChanges({ target: { ...target, zip } })).toThrow()
    }
    expect(() => parseMcpConfigurationChanges({ target: { ...target, zip: { toolName: 'remote_tool', bufferSize: 0 } } })).toThrow()
    expect(() => parseMcpConfigurationQuery({ kind: 'prerequisite', candidate: { kind: 'http', name: 'Source', url: 'https://source.example/mcp',
      evidence: { kind: 'supplied', uri: 'https://source.example/docs' } }, target })).toThrow('assigned ID')
    const removal = fullMcpReview(true)
    expect(parseMcpConfigurationChanges({ target: removal.intent })).toEqual({ target: removal.intent })
    expect(removal.after).toBeNull()
  })
})
