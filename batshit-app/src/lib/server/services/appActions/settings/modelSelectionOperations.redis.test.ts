// @vitest-environment node
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { redis } from '$lib/server/redis'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { createSettingsRedisAdmission } from '$lib/test-utils/settingsRedisAdmission'
import { defaultAppActionsPolicy } from '$lib/appActions/settings/managementContract'
import { apiKeyService } from '$lib/services/apiKey.server'
import { createPortableSkillToken, validatePortableSkillToken } from '../../portableSkillTokens'
import { portableGrantResponse, savePortableGrant } from './authority'
import { createSettingsOperationRegistry } from './operationRegistry'
import { createSettingsManagementReports } from './managementReports'
import { createSettingsChanges } from './changeOperations'
import { managedSettingsStore } from './managedStore'
import { withSettingsRecordReplacement, acquireSettingsMutation, captureSettingsLifecycle } from './lifecycle'
import { ModelSelectionSaveUnconfirmedError } from '$lib/server/modelSelectionGuard'
import { POST as useControlsRoute } from '../../../../../routes/api/controls/use/+server'
import * as presetOwner from '../../modelPresetSelectionOwner'

vi.mock('../runtime', () => ({ requireAppActionTopology() {} }))
const REAL = process.env.VITEST_USE_REAL_REDIS === 'true'
const strictAdmission = createSettingsRedisAdmission(redis)
useRedisTestServer({ beforeCleanupAdmission: strictAdmission.beforeCleanupAdmission })
afterAll(() => strictAdmission.close())
afterAll(async () => { if (REAL) await redis.disconnect() })
const user = 'a3_operation_owner'
const agentId = 'a3_operation_target'
const subId = 'a3_operation_sub'
const presetId = 'a3_operation_preset'
const preset = { id: presetId, modelName: 'Selected API', modelId: 'claude-sonnet-4-6', provider: 'anthropic', purpose: 'chat',
  connection: { id: 'direct:anthropic', type: 'direct', service: 'anthropic' }, settings: { temperature: 0 },
  pricing: {}, createdAt: '2026-10-17', updatedAt: '2026-10-17' }
async function fixture() {
  const token = await createPortableSkillToken({ userId: user, families: ['app-actions'] })
  const baseline = await portableGrantResponse(user, token.record.id)
  const saved = await savePortableGrant(user, token.record.id, { expectedAuthorityGeneration: baseline.authorityGeneration,
    grant: { policy: { ...defaultAppActionsPolicy(), enabled: true, scope: { mode: 'all', subjects: [], except: [] } }, expiresAt: new Date(Date.now() + 60000).toISOString() } })
  expect((await validatePortableSkillToken(token.token)).valid).toBe(true)
  const context = { userId: user, actorType: 'portable-skill', portableSettingsActor: { tokenId: token.record.id, authorityGeneration: saved.authorityGeneration } }
  const registry = createSettingsOperationRegistry()
  const store = { ...managedSettingsStore }
  const reports = createSettingsManagementReports(registry.boot, store)
  const changes = createSettingsChanges(registry, reports, store)
  const report = await reports.report(context, 'portable', { targets: { allAgents: true }, focus: ['agent.model.selection'] })
  const input = { op: 'change', requestId: `${registry.boot}:choose`, reportId: report.reportId, semanticId: 'agent.model.selection', changes: { presetId } }
  return { context, registry, store, reports, changes, report, input, token }
}

// SA-139 R5: the CLI selection consumer (the held CLI plan, its profile stage and stage admission)
// went with the Claude Code CLI Subagent; its default-lane cases went with it.
describe.runIf(REAL)('A3 real held report/change operation boundary without model execution', () => {
  afterEach(() => vi.restoreAllMocks())
  beforeEach(async () => {
    await redis.createAgent({ id: agentId, user_id: user, agentType: 'api', displayName: 'Primary', created_at: '2026-10-17',
      primary_model_capabilities: { vision: true }, provider_specific_settings: { nativeTools: { bashEnabled: false } } })
    await redis.json.set(`subagent:${subId}`, '$', { id: subId, user_id: user, subagentType: 'api', displayName: 'Subagent', created_at: '2026-10-17', provider_specific_settings: { native: 'keep' } })
    await redis.sAdd(`user:${user}:subagents`, subId)
    await redis.json.set(`model:${presetId}`, '$', preset)
    await redis.sAdd(`user:${user}:models`, presetId)
    await apiKeyService.store('anthropic', 'sk-ant-' + 'x'.repeat(48), user)
  })
  it.each(['absent', 'null', 'empty', 'null-model-key', 'zero-model-key', 'false-model-key'] as const)('a real %s clear distinguishes unchanged raw storage from an owned nonempty model-key write', async variant => {
    const modelKey = variant.endsWith('model-key')
    const nonempty = variant === 'zero-model-key' || variant === 'false-model-key'
    const parameter = variant === 'false-model-key' ? 'customFlag' : 'temperature'
    // SA-139 R4: the null clear rode on a Claude Code CLI Primary, a retired subject now; an API Primary carries it.
    const row = { id: agentId, user_id: user, created_at: 'original', displayName: 'Already clear',
      agentType: 'api',
      ...(variant === 'absent' ? {} : { primary_model_preset_id: variant === 'null' ? null : '', primary_model_provider: variant === 'null' ? null : '',
        primary_model_name: variant === 'null' ? null : '', primary_model_connection: null }),
      model: 'legacy-kept', claude_settings: { permissionMode: 'plan', model: 'native-kept', alwaysThinkingEnabled: true }, voice_profile: null,
      provider_specific_settings: modelKey ? { [parameter]: variant === 'null-model-key' ? null : variant === 'zero-model-key' ? 0 : false,
        claude_model: 'native-kept', nativeTools: { bashAccessMode: 'plan' } } : null }
    await redis.json.set(`agent:${agentId}`, '$', row)
    const before = await redis.json.getRaw(`agent:${agentId}`, '$'), update = vi.spyOn(redis, 'updateAgent'), subUpdate = vi.spyOn(redis, 'updateSubagent')
    const actualExecute = redis.execute.bind(redis)
    let selectionEvals = 0
    vi.spyOn(redis, 'execute').mockImplementation(operation => actualExecute(client => {
      const handler: ProxyHandler<typeof client> = { get(target, property) {
        if (property === 'withAbortSignal') return (signal: AbortSignal) => new Proxy(target.withAbortSignal(signal), handler)
        if (property === 'eval') return (script: string, options: any) => {
          if (script.includes("local guard = ARGV[5]") && script.includes('MODEL_SELECTION_CHANGED')) selectionEvals += 1
          return target.eval(script, options)
        }
        const member = Reflect.get(target, property); return typeof member === 'function' ? member.bind(target) : member
      } }
      return operation(new Proxy(client, handler))
    }))
    const f = await fixture(), input = { ...f.input, changes: { clear: true } }
    const result = await f.changes.change(f.context, 'portable', input)
    expect(result.outcomes).toHaveLength(2)
    expect(subUpdate).not.toHaveBeenCalled()
    if (nonempty) {
      expect(result).toMatchObject({ outcomesSummary: { applied: 1, unchanged: 1 } })
      expect(update).toHaveBeenCalledOnce(); expect(selectionEvals).toBe(1)
      const after = await redis.json.get(`agent:${agentId}`) as Record<string, any>
      expect(after).toMatchObject({ model: row.model, claude_settings: row.claude_settings, voice_profile: null,
        provider_specific_settings: { claude_model: 'native-kept', nativeTools: { bashAccessMode: 'plan' } } })
      expect(after.provider_specific_settings).not.toHaveProperty(parameter)
    } else {
      expect(result.outcomes.every(outcome => outcome.status === 'unchanged' && outcome.saved === 'not_requested')).toBe(true)
      expect(update).not.toHaveBeenCalled(); expect(selectionEvals).toBe(0)
      expect(await redis.json.getRaw(`agent:${agentId}`, '$')).toBe(before)
    }
  })
  it('reports safe choices, selects both API owners once, and reuses the original operation receipt', async () => {
    await redis.json.set(`agent:${agentId}`, '$.voice_profile', null)
    await redis.json.set(`agent:${agentId}`, '$.goon_id', null)
    const f = await fixture()
    const choices = await f.reports.report(f.context, 'portable', { targets: { allAgents: true }, focus: ['agent.model.selection'], detail: 'choices' })
    const serialized = JSON.stringify(choices)
    expect(serialized).toContain('Selected API'); expect(serialized).not.toContain('sk-ant-'); expect(serialized).not.toContain('api_keys:')
    const result = await f.changes.change(f.context, 'portable', f.input)
    expect(result).toMatchObject({ status: 'completed', outcomesSummary: { applied: 2, unknown: 0 } })
    expect((await redis.json.get(`agent:${agentId}`))).toMatchObject({ primary_model_preset_id: presetId, primary_model_capabilities: null, provider_specific_settings: { nativeTools: { bashEnabled: false } } })
    expect((await redis.json.get(`subagent:${subId}`))).toMatchObject({ primary_model_preset_id: presetId, provider_specific_settings: { native: 'keep' } })
    expect(await redis.json.get(`agent:${agentId}`)).toMatchObject({ voice_profile: null, goon_id: null })
    const spy = vi.spyOn(redis, 'updateAgent')
    try { expect((await f.changes.change(f.context, 'portable', f.input)).operationId).toBe(result.operationId); expect(spy).not.toHaveBeenCalled() }
    finally { spy.mockRestore() }
  })
  // SA-139 R4/R5: a leftover Claude Code CLI Primary (R4) or CLI Subagent (R5) is a retired type, so it is
  // not an admitted subject and is never written.
  it('clears only the admitted API Primary and API Subagent groups, refuses a retired CLI Primary and CLI Subagent, without a destination or replay', async () => {
    const cliAgent = 'a3_clear_cli', cliSubagent = 'a3_clear_cli_sub'
    await redis.createAgent({ id: cliAgent, user_id: user, agentType: 'cli', displayName: 'CLI Primary', created_at: '2026-10-18' })
    await redis.json.set(`subagent:${cliSubagent}`, '$', { id: cliSubagent, user_id: user, subagentType: 'cli', displayName: 'CLI Subagent', created_at: '2026-10-18' })
    await redis.sAdd(`user:${user}:subagents`, cliSubagent)
    const ids = [['agent', agentId], ['subagent', subId]] as const
    const retired = [['agent', cliAgent], ['subagent', cliSubagent]] as const
    const native = { permissionMode: 'plan', model: 'literal-native', alwaysThinkingEnabled: true, maxThinkingTokens: 4096 }
    for (const [kind, id] of [...ids, ...retired]) {
      const key = `${kind}:${id}`
      await redis.json.set(key, '$.primary_model_preset_id', `missing_${id}`)
      await redis.json.set(key, '$.primary_model_name', 'old')
      await redis.json.set(key, '$.primary_model_provider', 'openai')
      await redis.json.set(key, '$.primary_model_connection', { id: 'direct:openai', type: 'direct', service: 'openai' })
      await redis.json.set(key, '$.claude_settings', native)
      await redis.json.set(key, '$.model', 'legacy-retained')
      await redis.json.set(key, '$.voice_profile', null)
      await redis.json.set(key, '$.goon_id', null)
    }
    const leftovers = await Promise.all(retired.map(([kind, id]) => redis.json.getRaw(`${kind}:${id}`, '$')))
    const f = await fixture(), input = { ...f.input, changes: { clear: true } }
    const sourceRead = vi.spyOn(presetOwner, 'readOwnedModelPresetSelection')
    const prepared = await f.changes.prepare(f.context, 'portable', input)
    const review = await f.registry.humanReview(user, prepared.operation.operationId)
    expect(review.preview.targets).toHaveLength(2)
    expect(review.preview.targets.some(target => target.subject.id === cliAgent || target.subject.id === cliSubagent)).toBe(false)
    expect(review.outcomes).toContainEqual(expect.objectContaining({ subject: { kind: 'primary', id: cliAgent }, status: 'unavailable', reason: 'unsupported_subject_type' }))
    expect(review.outcomes).toContainEqual(expect.objectContaining({ subject: { kind: 'subagent', id: cliSubagent }, status: 'unavailable', reason: 'unsupported_subject_type' }))
    expect(review.preview.targets.every(target => target.modelSelection?.intent === 'clear')).toBe(true)
    expect(review.preview.targets.find(target => target.subject.id === subId)?.modelSelection?.inheritance).toBe('legacy-model-requires-selection')
    const result = await f.changes.change(f.context, 'portable', input)
    expect(result).toMatchObject({ status: 'completed', outcomesSummary: { applied: 2, unavailable: 2, unknown: 0 } })
    for (const [kind, id] of ids) expect(await redis.json.get(`${kind}:${id}`)).toMatchObject({ primary_model_preset_id: '', primary_model_name: '', primary_model_provider: '', primary_model_connection: null,
      claude_settings: native, model: 'legacy-retained', voice_profile: null, goon_id: null })
    for (const [index, [kind, id]] of retired.entries()) expect(await redis.json.getRaw(`${kind}:${id}`, '$')).toBe(leftovers[index])
    expect(sourceRead).not.toHaveBeenCalled()
    const writes = vi.spyOn(redis, 'updateAgent'), subWrites = vi.spyOn(redis, 'updateSubagent')
    expect((await f.changes.change(f.context, 'portable', input)).operationId).toBe(result.operationId)
    expect(writes).not.toHaveBeenCalled(); expect(subWrites).not.toHaveBeenCalled()
  })
  it('selects supported voice configuration only for API Primary and retains raw Voice state without profile/room work', async () => {
    await redis.json.set(`model:${presetId}`, '$', { ...preset, provider: 'openai', modelId: 'gpt-realtime-2', connection: { id: 'direct:openai', type: 'direct', service: 'openai' },
      voiceSession: { runtime: 'livekit', mode: 'speech-to-speech', providerId: 'openai', supportStatus: 'supported', locksVoiceModeSettings: true } })
    await apiKeyService.store('openai', 'sk-' + 'x'.repeat(48), user)
    await redis.json.set(`agent:${agentId}`, '$.voice_profile', null)
    const f = await fixture()
    const prepared = await f.changes.prepare(f.context, 'portable', f.input)
    const review = await f.registry.humanReview(user, prepared.operation.operationId)
    expect(review.preview.targets).toHaveLength(1)
    expect(review.preview.targets[0].modelSelection).toMatchObject({ role: 'api-primary', voice: { runtime: 'livekit', mode: 'speech-to-speech', supportStatus: 'supported', locksVoiceModeSettings: true } })
    expect(review.outcomes).toContainEqual(expect.objectContaining({ subject: { kind: 'subagent', id: subId }, status: 'unavailable', reason: expect.stringContaining('Primary configuration') }))
    const result = await f.changes.change(f.context, 'portable', f.input)
    expect(result).toMatchObject({ outcomesSummary: { applied: 1, unavailable: 1 } })
    expect(await redis.json.get(`agent:${agentId}`)).toMatchObject({ primary_model_preset_id: presetId, voice_profile: null })
    expect(await redis.json.get(`subagent:${subId}`)).not.toHaveProperty('primary_model_preset_id')
  })
  it.each(['voiceSession', 'settings', 'connection', 'membership'] as const)('binds the held voice %s source through actual physical selection issue', async changed => {
    await redis.json.set(`model:${presetId}`, '$', { ...preset, provider: 'openai', modelId: 'gpt-realtime-2', connection: { id: 'direct:openai', type: 'direct', service: 'openai' },
      voiceSession: { runtime: 'livekit', mode: 'speech-to-speech', providerId: 'openai', supportStatus: 'supported' } })
    await apiKeyService.store('openai', 'sk-' + 'x'.repeat(48), user)
    const f = await fixture(), execute = redis.execute.bind(redis)
    let issued = false
    const spy = vi.spyOn(redis, 'execute').mockImplementation(operation => execute(client => {
      const handler: ProxyHandler<typeof client> = { get(target, property) {
      if (property === 'withAbortSignal') return (signal: AbortSignal) => new Proxy(target.withAbortSignal(signal), handler)
      if (property === 'eval') return async (script: string, options: any) => {
        if (!issued && script.includes("local guard = ARGV[5]") && script.includes('MODEL_SELECTION_CHANGED')) {
          issued = true
          if (changed === 'membership') await target.sRem(`user:${user}:models`, presetId)
          else await target.json.set(`model:${presetId}`, `$.${changed}`, changed === 'connection' ? { id: 'direct:google', type: 'direct', service: 'google' }
            : changed === 'settings' ? { temperature: 0.9, voiceSession: { runtime: 'livekit', mode: 'speech-to-speech', providerId: 'google' } }
            : { runtime: 'livekit', mode: 'speech-to-speech', providerId: 'openai', locksVoiceModeSettings: false })
        }
        return target.eval(script, options)
      }
      const member = Reflect.get(target, property); return typeof member === 'function' ? member.bind(target) : member
    } }
      return operation(new Proxy(client, handler))
    }))
    try {
      const result = await f.changes.change(f.context, 'portable', f.input)
      expect(issued).toBe(true)
      expect(result).toMatchObject({ outcomesSummary: { applied: 0, conflict: 1, unavailable: 1 } })
      expect(await redis.json.get(`agent:${agentId}`)).not.toHaveProperty('primary_model_preset_id')
    } finally { spy.mockRestore() }
  })
  it('refuses a preset replaced with identical raw data after operation capture', async () => {
    const f = await fixture(); await f.changes.prepare(f.context, 'portable', f.input)
    await withSettingsRecordReplacement(`model:${presetId}`, async () => { await redis.json.set(`model:${presetId}`, '$', preset) })
    await expect(f.changes.change(f.context, 'portable', f.input)).rejects.toMatchObject({ status: 409 })
    expect(await redis.json.get(`agent:${agentId}`)).not.toHaveProperty('primary_model_preset_id')
  })
  it('uses the actual portable fixed report/change wrappers for one model-free selection', async () => {
    const f = await fixture()
    const call = async (controlId: string, input: unknown) => {
      const response = await useControlsRoute({ request: new Request('http://localhost/api/controls/use', { method: 'POST',
        headers: { 'content-type': 'application/json', 'x-batshit-portable-token': f.token.token }, body: JSON.stringify({ controlId, input }) }), locals: {} } as never)
      const body = await response.json(); expect(response.status).toBe(200); expect(body.success).toBe(true); return body.result
    }
    const report = await call('sys.app_settings.portable.report', { targets: { subjects: [{ kind: 'primary', id: agentId }] }, focus: ['agent.model.selection'] })
    const result = await call('sys.app_settings.portable.change', { op: 'change', requestId: `${report.bootNamespace}:wrapper-model`, reportId: report.reportId,
      semanticId: 'agent.model.selection', changes: { presetId } })
    expect(result).toMatchObject({ outcomesSummary: { applied: 1 } })
    expect((await redis.json.get(`agent:${agentId}`))).toMatchObject({ primary_model_preset_id: presetId })
  })
  it('retains known saved evidence across a late failure and blocks the remaining target without replay', async () => {
    const f = await fixture()
    const actual = redis.updateAgent.bind(redis)
    const spy = vi.spyOn(redis, 'updateAgent').mockImplementation(async (...args) => { await actual(...args); throw new ModelSelectionSaveUnconfirmedError() })
    try {
      const result = await f.changes.change(f.context, 'portable', f.input)
      // The writer's synchronous onSaved is stronger than a later transport failure.
      expect(result).toMatchObject({ outcomesSummary: { applied: 1, blocked: 1 } })
      expect((await redis.json.get(`agent:${agentId}`))).toMatchObject({ primary_model_preset_id: presetId })
      expect(await redis.json.get(`subagent:${subId}`)).not.toHaveProperty('primary_model_preset_id')
      await f.changes.change(f.context, 'portable', f.input); expect(spy).toHaveBeenCalledOnce()
    } finally { spy.mockRestore() }
  })
  it('records known save while its caller is held before readback and keeps it after cancellation', async () => {
    const f = await fixture(); const prepared = await f.changes.prepare(f.context, 'portable', f.input)
    let release!: () => void; let saved!: () => void
    const hold = new Promise<void>(resolve => { release = resolve }); const seenSave = new Promise<void>(resolve => { saved = resolve })
    const actual = redis.updateAgent.bind(redis)
    const spy = vi.spyOn(redis, 'updateAgent').mockImplementation(async (...args) => { await actual(...args); saved(); await hold })
    const flight = f.changes.change(f.context, 'portable', f.input)
    try {
      await seenSave
      expect(f.registry.outcome(prepared.operation.operationId, prepared.admission.actor).outcomes).toContainEqual(expect.objectContaining({ status: 'applied', saved: 'saved', readback: 'unavailable' }))
      const cancelled = await f.changes.change(f.context, 'portable', { op: 'cancel', operationId: prepared.operation.operationId })
      expect(cancelled.outcomes).toContainEqual(expect.objectContaining({ saved: 'saved' }))
    } finally { release(); await flight; spy.mockRestore() }
  })
  it('retains an issued unknown receipt and never starts the remaining target or replays', async () => {
    const f = await fixture()
    const spy = vi.spyOn(redis, 'updateAgent').mockRejectedValue(new ModelSelectionSaveUnconfirmedError())
    try {
      const result = await f.changes.change(f.context, 'portable', f.input)
      expect(result).toMatchObject({ outcomesSummary: { unknown: 1, blocked: 1 } })
      expect(await redis.json.get(`subagent:${subId}`)).not.toHaveProperty('primary_model_preset_id')
      await f.changes.change(f.context, 'portable', f.input); expect(spy).toHaveBeenCalledOnce()
    } finally { spy.mockRestore() }
  })
})


describe.runIf(REAL)('A12 one copy and original-target assignment in the actual operation', () => {
  beforeEach(async () => {
    await redis.createAgent({ id: agentId, user_id: user, agentType: 'api', displayName: 'Primary', created_at: '2026-10-17', provider_specific_settings: { nativeTools: { bashEnabled: false } } })
    await redis.json.set(`subagent:${subId}`, '$', { id: subId, user_id: user, subagentType: 'api', displayName: 'Subagent', created_at: '2026-10-17' })
    await redis.sAdd(`user:${user}:subagents`, subId)
    await redis.json.set(`model:${presetId}`, '$', { ...preset, privateInherited: { zero: 0, off: false } })
    await redis.sAdd(`user:${user}:models`, presetId)
    await apiKeyService.store('anthropic', 'sk-ant-' + 'x'.repeat(48), user)
  })
  afterEach(() => vi.restoreAllMocks())
  async function copyFixture(targets: Record<string, unknown> = { allAgents: true }) {
    const f = await fixture()
    const original = await redis.json.getRaw(`model:${presetId}`, '$')
    const report = await f.reports.report(f.context, 'portable', { targets, focus: ['agent.model.preset-copy'], detail: 'choices', query: { sourcePresetId: presetId } })
    const input = { ...f.input, reportId: report.reportId, semanticId: 'agent.model.preset-copy', changes: { sourcePresetId: presetId, copyName: 'A12 visible copy', parameters: [{ name: 'maxTokens', op: 'set', value: 2048 }] } }
    return { ...f, original, input }
  }
  it('creates once, assigns both actual API owner kinds, and retains the same request identity without exposing inherited/private cuts', async () => {
    await redis.json.set(`agent:${agentId}`, '$.voice_profile', null)
    await redis.json.set(`agent:${agentId}`, '$.goon_id', null)
    const f = await copyFixture()
    const prepared = await f.changes.prepare(f.context, 'portable', f.input)
    const copyId = prepared.operation.presetCopyOutcome!.presetId
    expect(JSON.stringify(prepared.operation)).not.toMatch(/privateInherited|sk-ant-|api_keys:/)
    const result = await f.changes.change(f.context, 'portable', f.input)
    expect(result).toMatchObject({ status: 'completed', presetCopyOutcome: { presetId: copyId, creation: 'saved', source: 'confirmed', assignment: 'finished' }, outcomesSummary: { applied: 2 } })
    expect((await redis.get(`model:${copyId}`))).toMatchObject({ settings: { temperature: 0, maxTokens: 2048 }, privateInherited: { zero: 0, off: false } })
    expect(await redis.json.getRaw(`model:${presetId}`, '$')).toBe(f.original)
    for (const key of [`agent:${agentId}`, `subagent:${subId}`]) expect(await redis.get(key)).toHaveProperty('primary_model_preset_id', copyId)
    expect(await redis.get(`agent:${agentId}`)).toMatchObject({ voice_profile: null, goon_id: null })
    const copyWriter = vi.spyOn(presetOwner, 'createModelPresetCopy')
    expect((await f.changes.change(f.context, 'portable', f.input)).operationId).toBe(result.operationId)
    expect(copyWriter).not.toHaveBeenCalled()
  })
  it('a removed n8n Workflow Subagent is an unsupported subject and never creates a copy', async () => {
    const f = await fixture()
    // SA-139 R2: the n8n Workflow Subagent type was removed, so the stored record resolves to no supported type.
    await redis.json.set(`subagent:${subId}`, '$.subagentType', 'n8n-workflow')
    const report = await f.reports.report(f.context, 'portable', { targets: { subjects: [{ kind: 'subagent', id: subId }] }, focus: ['agent.model.preset-copy'], detail: 'choices', query: { sourcePresetId: presetId } })
    const before = await redis.sMembers(`user:${user}:models`)
    const result = await f.changes.change(f.context, 'portable', { ...f.input, reportId: report.reportId, semanticId: 'agent.model.preset-copy', changes: { sourcePresetId: presetId, copyName: 'Must not create', parameters: [{ name: 'maxTokens', op: 'set', value: 2048 }] } })
    expect(result).toMatchObject({ presetCopyOutcome: { creation: 'not_requested' }, outcomes: [{ status: 'unavailable', reason: 'unsupported_subject_type' }] })
    expect(await redis.sMembers(`user:${user}:models`)).toEqual(before)
  })
  it('the genuine authenticated portable wrappers produce one original-source copy and assignment without a second grant or operation', async () => {
    const f = await fixture()
    const call = async (controlId: string, input: unknown) => {
      const response = await useControlsRoute({ request: new Request('http://localhost/api/controls/use', { method: 'POST', headers: { 'content-type': 'application/json', 'x-batshit-portable-token': f.token.token }, body: JSON.stringify({ controlId, input }) }), locals: {} } as never)
      const body = await response.json(); expect(response.status).toBe(200); expect(body.success).toBe(true); return body.result
    }
    const report = await call('sys.app_settings.portable.report', { targets: { subjects: [{ kind: 'primary', id: agentId }] }, focus: ['agent.model.preset-copy'], detail: 'choices', query: { sourcePresetId: presetId } })
    const result = await call('sys.app_settings.portable.change', { op: 'change', requestId: `${report.bootNamespace}:wrapper-copy`, reportId: report.reportId, semanticId: 'agent.model.preset-copy', changes: { sourcePresetId: presetId, copyName: 'Wrapper named copy', parameters: [{ name: 'maxTokens', op: 'set', value: 2048 }] } })
    expect(result).toMatchObject({ presetCopyOutcome: { creation: 'saved', assignment: 'finished' }, outcomesSummary: { applied: 1 } })
    expect(await redis.get(`agent:${agentId}`)).toHaveProperty('primary_model_preset_id', result.presetCopyOutcome.presetId)
    expect(result.operationId).toMatch(/^aso_[a-f0-9]{24}_[a-f0-9]{32}$/)
  })
  it('does not create when its sole original target model group changes while the destination drain is held', async () => {
    const f = await copyFixture({ subjects: [{ kind: 'primary', id: agentId }] })
    const prepared = await f.changes.prepare(f.context, 'portable', f.input)
    const copyId = prepared.operation.presetCopyOutcome!.presetId
    const lease = acquireSettingsMutation(captureSettingsLifecycle([`model:${copyId}`]))
    const running = f.changes.change(f.context, 'portable', f.input)
    void running.catch(() => {})
    try {
      await vi.waitFor(() => expect(() => captureSettingsLifecycle([`model:${copyId}`])).toThrow())
      await redis.json.set(`agent:${agentId}`, '$.primary_model_name', 'human-newer-primary')
      lease.settle()
      const result = await running
      expect(result.presetCopyOutcome!.creation).toBe('not_requested')
      expect(await redis.get(`model:${copyId}`)).toBeNull()
      expect(await redis.sismember(`user:${user}:models`, copyId)).toBeFalsy()
      expect(await redis.json.getRaw(`model:${presetId}`, '$')).toBe(f.original)
    } finally { lease.settle(); await running.catch(() => undefined) }
  }, 30000)
  it('uses original target preimages after creation: a later target edit leaves a named partial copy and does not rebase or delete', async () => {
    const f = await copyFixture(), actual = redis.updateAgent.bind(redis)
    vi.spyOn(redis, 'updateAgent').mockImplementation(async (...args) => { const saved = await actual(...args); await redis.json.set(`subagent:${subId}`, '$.primary_model_name', 'human-newer'); return saved })
    const result = await f.changes.change(f.context, 'portable', f.input)
    expect(result).toMatchObject({ presetCopyOutcome: { creation: 'saved', assignment: 'partial' }, outcomesSummary: { applied: 1, conflict: 1 } })
    expect(await redis.get(`model:${result.presetCopyOutcome!.presetId}`)).not.toBeNull()
    expect(await redis.get(`subagent:${subId}`)).toMatchObject({ primary_model_name: 'human-newer' })
    expect(await redis.json.getRaw(`model:${presetId}`, '$')).toBe(f.original)
  })
  it('unknown real creation stops all target writes and keeps one reserved ID/unknown receipt on repeated observation', async () => {
    const f = await copyFixture(), originalExecute = redis.execute.bind(redis)
    let creates = 0
    const spy = vi.spyOn(redis, 'execute').mockImplementation(operation => originalExecute(client => operation(new Proxy(client, { get(target, property) {
      if (property === 'eval') return async (script: string, options: any) => { const result = await target.eval(script, options); if (script === presetOwner.MUTATE_MODEL_PRESET_SCRIPT && options.arguments[4]) { creates += 1; throw new Error('Lost actual copy reply') }; return result }
      const member = Reflect.get(target, property); return typeof member === 'function' ? member.bind(target) : member
    } }))))
    let result: Awaited<ReturnType<typeof f.changes.change>>
    try { result = await f.changes.change(f.context, 'portable', f.input) } finally { spy.mockRestore() }
    expect(result!).toMatchObject({ status: 'unknown_outcome', presetCopyOutcome: { creation: 'unknown', assignment: 'blocked' }, outcomesSummary: { blocked: 2 } })
    expect(await redis.get(`model:${result!.presetCopyOutcome!.presetId}`)).not.toBeNull()
    expect(await redis.get(`agent:${agentId}`)).not.toHaveProperty('primary_model_preset_id')
    expect((await f.changes.change(f.context, 'portable', f.input)).operationId).toBe(result!.operationId); expect(creates).toBe(1)
  })
})
