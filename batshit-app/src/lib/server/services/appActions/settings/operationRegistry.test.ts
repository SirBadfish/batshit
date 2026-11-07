import { normalizeCompactTool } from '$lib/utils/toolActivityContract'
import { MODEL_PRESET_COPY_ID, type ModelPresetCopyOutcome } from '$lib/appActions/settings/modelSelectionPreferences'
import { isAppActionsOperationResponse } from '$lib/appActions/settings/managementContract'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSettingsOperationRegistry, type SettingsOperationRecipe } from './operationRegistry'
import { MCP_CONFIGURATION_ID, MCP_CONFIGURATION_EFFECTS, MCP_CONFIGURATION_STAGES, type McpConfigurationReview, type McpConfigurationJournal, mcpConfigurationEffects, type McpPrerequisiteReview } from '$lib/appActions/settings/mcpConfiguration'

function fixture(permission: 'ask' | 'allow' = 'ask') {
  const registry = createSettingsOperationRegistry(() => Date.now())
  const actor = { userId: 'owner', kind: 'portable' as const, id: 'token', generation: 2, label: 'Outside agent' }
  const refresh = vi.fn(async () => {})
  const execute = vi.fn<SettingsOperationRecipe['execute']>(async () => [{ subject: { kind: 'primary' as const, id: 'a' }, status: 'applied' as const,
    saved: 'saved' as const, readback: 'verified' as const, visible: 'unknown' as const }])
  const recipe: SettingsOperationRecipe = { actor, requestId: `${registry.boot}:one`, input: { op: 'change', reportId: 'held', changes: { recalled: 2 } },
    preview: { semanticId: 'agent.memory.preferences', targets: [{ subject: { kind: 'primary', id: 'a' }, label: 'A', changes: [{ field: 'recalled', label: 'Recall budget', before: 1, after: 2 }] }], excluded: [], effects: ['Save recall budget.'] },
    preimages: { generation: 2, recalled: 1 }, permission, refresh, execute }
  return { registry, actor, recipe, refresh, execute }
}
afterEach(() => vi.useRealTimers())
describe('boot-scoped exact Settings operation custody', () => {
  it('GET reviews never execute; only the owning human decision releases one exact operation', async () => {
    const f = fixture()
    const captured = f.registry.capture(f.recipe)
    const review = await f.registry.humanReview('owner', captured.operationId)
    expect(review.canDecide).toBe(true)
    expect(f.execute).not.toHaveBeenCalled()
    await expect(f.registry.decide('other', captured.operationId, captured.intentDigest, 'approve')).rejects.toThrow('identity')
    await expect(f.registry.decide('owner', captured.operationId, '0'.repeat(64), 'approve')).rejects.toThrow('identity')
    const finished = await f.registry.decide('owner', captured.operationId, captured.intentDigest, 'approve')
    expect(finished.status).toBe('completed')
    expect(f.execute).toHaveBeenCalledTimes(1)
    await expect(f.registry.decide('owner', captured.operationId, captured.intentDigest, 'approve')).rejects.toThrow('already')
  })
  it('denial and cancellation are final and cannot become a later approval', async () => {
    const denied = fixture()
    const d = denied.registry.capture(denied.recipe)
    expect((await denied.registry.decide('owner', d.operationId, d.intentDigest, 'deny')).status).toBe('denied')
    await expect(denied.registry.decide('owner', d.operationId, d.intentDigest, 'approve')).rejects.toThrow('already')
    const cancelled = fixture()
    const c = cancelled.registry.capture(cancelled.recipe)
    expect(cancelled.registry.cancel(c.operationId, cancelled.actor).status).toBe('cancelled')
    expect((await cancelled.registry.portableExecute(c.operationId, cancelled.actor)).status).toBe('cancelled')
    expect(denied.execute).not.toHaveBeenCalled(); expect(cancelled.execute).not.toHaveBeenCalled()
  })
  it('binds request IDs to boot, actor generation and exact intent without replay', async () => {
    const f = fixture('allow')
    const first = f.registry.capture(f.recipe)
    expect(f.registry.capture({ ...f.recipe })).toEqual(first)
    expect(() => f.registry.capture({ ...f.recipe, input: { different: true } })).toThrow('different changes')
    expect(() => f.registry.outcome(first.operationId, { ...f.actor, generation: 3 })).toThrow('different authority')
    expect(() => createSettingsOperationRegistry().outcome(first.operationId, f.actor)).toThrow('different app start')
    await f.registry.portableExecute(first.operationId, f.actor)
    await f.registry.portableExecute(first.operationId, f.actor)
    expect(f.execute).toHaveBeenCalledTimes(1)
  })
  it('keeps human review lifetime separate from the execution budget and never extends a hard deadline', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-17T03:00:00.000Z'))
    const f = fixture()
    const hard = Date.now() + 120_000
    const captured = f.registry.capture({ ...f.recipe, hardDeadlineAt: hard })
    const waiting = await f.registry.humanReview('owner', captured.operationId)
    expect(waiting.executionDeadlineAt).toBeNull()
    expect(Date.parse(waiting.reviewExpiresAt)).toBe(hard)
    vi.setSystemTime(hard - 10_000)
    const complete = await f.registry.decide('owner', captured.operationId, captured.intentDigest, 'approve')
    expect(Date.parse(complete.executionDeadlineAt!)).toBe(hard)
    expect(f.execute.mock.calls[0][0].deadlineAt).toBe(hard)
    const expired = fixture()
    const old = expired.registry.capture({ ...expired.recipe, hardDeadlineAt: Date.now() + 1 })
    vi.advanceTimersByTime(2)
    await expect(expired.registry.decide('owner', old.operationId, old.intentDigest, 'approve')).rejects.toThrow('already')
    expect(expired.execute).not.toHaveBeenCalled()
  })
  it('checks current captured authority/preimages before approval and executes nothing after refusal', async () => {
    const f = fixture()
    const captured = f.registry.capture(f.recipe)
    f.refresh.mockRejectedValue(new Error('revoked or changed'))
    await expect(f.registry.decide('owner', captured.operationId, captured.intentDigest, 'approve')).rejects.toThrow('revoked')
    expect(f.registry.outcome(captured.operationId, f.actor).status).toBe('blocked')
    expect(f.execute).not.toHaveBeenCalled()
  })
  it('retains unknown issued custody, prevents another execution and detaches earlier returned results', async () => {
    vi.useFakeTimers()
    const f = fixture('allow')
    let settle!: (value: any) => void
    f.execute.mockImplementation(() => new Promise(resolve => { settle = resolve }))
    const captured = f.registry.capture(f.recipe)
    const running = f.registry.portableExecute(captured.operationId, f.actor)
    await vi.advanceTimersByTimeAsync(30_001)
    const unknown = await running
    expect(unknown.status).toBe('unknown_outcome')
    await f.registry.portableExecute(captured.operationId, f.actor)
    expect(f.execute).toHaveBeenCalledTimes(1)
    settle([{ subject: { kind: 'primary', id: 'a' }, status: 'applied', saved: 'saved', readback: 'verified', visible: 'unknown' }])
    await Promise.resolve(); await Promise.resolve()
    expect(f.registry.outcome(captured.operationId, f.actor).status).toBe('completed')
    expect(unknown.status).toBe('unknown_outcome')
  })
  it('keeps the first confirmed save visible while a later target remains unsettled across deadline', async () => {
    vi.useFakeTimers()
    const f = fixture('allow')
    const second = { kind: 'primary' as const, id: 'b' }
    f.recipe.preview.targets.push({ subject: second, label: 'B', changes: [{ field: 'recalled', label: 'Recall budget', before: 1, after: 2 }] })
    let settle!: () => void
    f.execute.mockImplementation(async execution => {
      execution.targetStarted({ kind: 'primary', id: 'a' })
      execution.recordOutcome({ subject: { kind: 'primary', id: 'a' }, status: 'applied', saved: 'saved', readback: 'verified', visible: 'unknown' })
      execution.targetStarted(second)
      await new Promise<void>(resolve => { settle = resolve })
      // Even a later blanket unknown response cannot erase already confirmed evidence.
      return [{ subject: { kind: 'primary', id: 'a' }, status: 'unknown', saved: 'unknown', readback: 'unavailable', visible: 'unknown' },
        { subject: second, status: 'unknown', saved: 'unknown', readback: 'unavailable', visible: 'unknown' }]
    })
    const captured = f.registry.capture(f.recipe)
    const pending = f.registry.portableExecute(captured.operationId, f.actor)
    await vi.advanceTimersByTimeAsync(30_001)
    const atDeadline = await pending
    expect(atDeadline).toMatchObject({ status: 'unknown_outcome', totalTargets: 2, outcomesPending: 0, outcomes: [
      { subject: { id: 'a' }, status: 'applied', saved: 'saved' }, { subject: { id: 'b' }, status: 'unknown', saved: 'unknown', reason: 'target_execution_pending' }
    ] })
    expect(f.registry.outcome(captured.operationId, f.actor).outcomes[0]).toMatchObject({ status: 'applied', saved: 'saved' })
    await f.registry.portableExecute(captured.operationId, f.actor)
    expect(f.execute).toHaveBeenCalledOnce()
    settle(); await Promise.resolve(); await Promise.resolve()
    expect(f.registry.outcome(captured.operationId, f.actor).outcomes[0]).toMatchObject({ status: 'applied', saved: 'saved' })
  })
})

function resourceFixture(permission: 'ask' | 'allow' = 'ask') {
  const f = fixture(permission)
  const resource = { kind: 'mcp-gateway' as const, gatewayId: 'assigned_gateway' }
  const review: McpConfigurationReview = { kind: 'mcp-configuration', planId: `mcpp_${'1'.repeat(32)}`, candidateId: `mcpc_${'2'.repeat(32)}`,
    mode: 'create', resource, before: null, after: { id: resource.gatewayId, slug: 'source', name: 'Source', type: 'custom', enabled: true, url: 'https://source.example/mcp' }, stages: [...MCP_CONFIGURATION_STAGES] }
  const stages = Object.fromEntries(MCP_CONFIGURATION_STAGES.map(stage => [stage, 'not_started'])) as McpConfigurationJournal
  stages.keyReference = 'not_requested'
  const execute = vi.fn<SettingsOperationRecipe['execute']>(async execution => {
    execution.recordResourceOutcome!({ resource, status: 'applied', saved: 'saved', stages: { ...stages, registry: 'saved' } })
    return []
  })
  const recipe: SettingsOperationRecipe = { ...f.recipe, resource, preview: { semanticId: MCP_CONFIGURATION_ID, targets: [], excluded: [], effects: [...MCP_CONFIGURATION_EFFECTS], resource: review },
    input: { op: 'change', semanticId: MCP_CONFIGURATION_ID, reportId: `asr_${f.registry.boot}_mcp_${'3'.repeat(32)}`, changes: { source: { candidateId: review.candidateId } } },
    preimages: { planId: review.planId, disclosure: review }, execute }
  return { ...f, resource, review, recipe, execute, stages }
}
describe('MCP resource recipes in the existing boot ledger', () => {
  it('requires the exact human decision despite zero scalar targets and retains separate save/stage facts', async () => {
    const f = resourceFixture(), op = f.registry.capture(f.recipe)
    expect(op.operationId).toMatch(/^aso_[a-f0-9]{24}_mcp_config_[a-f0-9]{32}$/)
    expect(op.operationId).toHaveLength(72)
    expect(op).toMatchObject({ status: 'awaiting_approval', totalTargets: 0, totalResources: 1, executionBudgetMs: 180_000, executionDeadlineAt: null })
    await f.registry.humanReview('owner', op.operationId)
    await f.registry.portableExecute(op.operationId, f.actor)
    expect(f.execute).not.toHaveBeenCalled()
    await expect(f.registry.decide('owner', op.operationId, '0'.repeat(64), 'approve')).rejects.toThrow('identity')
    const done = await f.registry.decide('owner', op.operationId, op.intentDigest, 'approve')
    expect(done).toMatchObject({ status: 'completed', outcomes: [], resourceOutcomes: [{ saved: 'saved', stages: { registry: 'saved', verification: 'not_started', originalTaskUse: 'not_started', zip: 'not_started' } }] })
    await expect(f.registry.decide('owner', op.operationId, op.intentDigest, 'approve')).rejects.toThrow('already')
    expect(f.execute).toHaveBeenCalledOnce()
  })
  it('portable waits at most5s while repeated observers retain one180s first-start deadline and one execution', async () => {
    vi.useFakeTimers()
    const f = resourceFixture('allow')
    let settle!: () => void
    f.execute.mockImplementation(async execution => {
      execution.recordResourceOutcome!({ resource: f.resource, status: 'unknown', saved: 'unknown', stages: { ...f.stages, registry: 'issued' } })
      await new Promise<void>(resolve => { settle = resolve })
      execution.recordResourceOutcome!({ resource: f.resource, status: 'applied', saved: 'saved', stages: { ...f.stages, registry: 'saved' } })
      return []
    })
    const op = f.registry.capture(f.recipe), start = Date.now(), first = f.registry.portableExecute(op.operationId, f.actor)
    await vi.advanceTimersByTimeAsync(5000)
    expect(await first).toMatchObject({ status: 'running', executionDeadlineAt: new Date(start + 180_000).toISOString() })
    const second = f.registry.portableExecute(op.operationId, f.actor)
    await vi.advanceTimersByTimeAsync(5000)
    expect((await second).executionDeadlineAt).toBe(new Date(start + 180_000).toISOString())
    expect(f.execute).toHaveBeenCalledOnce()
    settle(); await vi.advanceTimersByTimeAsync(0)
    expect(f.registry.outcome(op.operationId, f.actor).resourceOutcomes?.[0].saved).toBe('saved')
  })
  it('the portable human decision starts one retained flight before an unresolved authority read and answers within5s', async () => {
    vi.useFakeTimers()
    const f = resourceFixture()
    let release!: () => void
    f.refresh.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve }))
    const op = f.registry.capture(f.recipe), started = Date.now()
    const decision = f.registry.decide('owner', op.operationId, op.intentDigest, 'approve')
    await vi.advanceTimersByTimeAsync(5000)
    const waiting = await decision
    expect(waiting).toMatchObject({ status: 'running', canDecide: false, executionDeadlineAt: new Date(started + 180_000).toISOString() })
    expect(f.execute).not.toHaveBeenCalled()
    await expect(f.registry.decide('owner', op.operationId, op.intentDigest, 'approve')).rejects.toThrow('already')
    release(); await vi.advanceTimersByTimeAsync(0)
    expect(f.execute).toHaveBeenCalledOnce()
    expect(f.registry.outcome(op.operationId, f.actor)).toMatchObject({ status: 'completed', resourceOutcomes: [{ saved: 'saved' }] })
  })
  it('native resumed observations join the same flight without resetting its clock or losing a known save', async () => {
    vi.useFakeTimers()
    const f = resourceFixture('allow'), actor = { ...f.actor, kind: 'native' as const, sessionId: 'chat' }, stop = new AbortController()
    let settle!: () => void
    f.execute.mockImplementation(async execution => {
      execution.recordResourceOutcome!({ resource: f.resource, status: 'applied', saved: 'saved', stages: { ...f.stages, registry: 'saved' } })
      await new Promise<void>(resolve => { settle = resolve })
      execution.recordResourceOutcome!({ resource: f.resource, status: 'unknown', saved: 'unknown', stages: { ...f.stages, registry: 'unknown' } })
      return []
    })
    const op = f.registry.capture({ ...f.recipe, actor }), first = f.registry.nativeExecute(op.operationId, actor, stop.signal, () => {})
    await vi.advanceTimersByTimeAsync(90_000)
    const held = f.registry.outcome(op.operationId, actor), second = f.registry.nativeExecute(op.operationId, actor, stop.signal, () => {})
    await vi.advanceTimersByTimeAsync(90_001)
    expect((await first).executionDeadlineAt).toBe(held.executionDeadlineAt)
    expect((await second).executionDeadlineAt).toBe(held.executionDeadlineAt)
    expect(f.registry.outcome(op.operationId, actor)).toMatchObject({ status: 'unknown_outcome', resourceOutcomes: [{ saved: 'saved' }] })
    expect(f.execute).toHaveBeenCalledOnce()
    settle(); await vi.advanceTimersByTimeAsync(0)
    expect(f.registry.outcome(op.operationId, actor).resourceOutcomes?.[0].saved).toBe('saved')
  })
  it('rejects resource/scalar masquerading before ledger capture and never hashes private closure material', async () => {
    const f = resourceFixture()
    expect(() => f.registry.capture({ ...f.recipe, resource: undefined })).toThrow('resource recipe')
    const scalar = fixture()
    expect(() => scalar.registry.capture({ ...scalar.recipe, resource: f.resource })).toThrow('resource recipe')
    const privateHandle = Object.freeze({}), owns = new WeakSet([privateHandle])
    f.execute.mockImplementation(async () => { expect(owns.has(privateHandle)).toBe(true); return [] })
    const op = f.registry.capture(f.recipe)
    const clone = structuredClone(privateHandle)
    expect(owns.has(clone)).toBe(false)
    await f.registry.decide('owner', op.operationId, op.intentDigest, 'approve')
    expect(f.execute).toHaveBeenCalledOnce()
    expect(JSON.stringify(await f.registry.humanReview('owner', op.operationId))).not.toContain('preimages')
  })
})


it('captures native nonexecuting rows immutably and binds their exact facts into the digest', () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-17T12:00:00.000Z'))
  const f = fixture()
  const actor = { kind: 'native' as const, userId: 'owner', id: 'actor', generation: 0, sessionId: 'chat', label: 'Actor' }
  const blocked = { subject: { kind: 'primary' as const, id: 'b' }, status: 'blocked' as const, reason: 'context_management_blocked',
    saved: 'not_requested' as const, readback: 'not_requested' as const, visible: 'unchanged' as const }
  const first = f.registry.capture({ ...f.recipe, actor, initialOutcomes: [blocked] })
  blocked.reason = 'mutated after capture'
  const native = f.registry.nativeApprovalPreview('owner', 'actor', 'chat', f.recipe.requestId)!
  expect(native.initialOutcomes).toEqual([{ ...blocked, reason: 'context_management_blocked' }])
  native.initialOutcomes![0].reason = 'foreign returned mutation'
  expect(f.registry.nativeApprovalPreview('owner', 'actor', 'chat', f.recipe.requestId)!.initialOutcomes![0].reason).toBe('context_management_blocked')
  const second = f.registry.capture({ ...f.recipe, actor, requestId: `${f.registry.boot}:two`, initialOutcomes: [{ ...blocked, reason: 'ordinary_changes_blocked' }] })
  expect(second.intentDigest).not.toBe(first.intentDigest)
  expect(f.execute).not.toHaveBeenCalled()
})


describe('A12 copy fact and target progress share the existing scalar operation', () => {
  function copyFixture() {
    const f = fixture('allow')
    let fact: ModelPresetCopyOutcome = { presetId: 'reserved-copy', name: 'Named copy', creation: 'not_requested', source: 'not_requested', assignment: 'not_started' }
    f.recipe.preview = { semanticId: MODEL_PRESET_COPY_ID, targets: [{ subject: { kind: 'primary', id: 'a' }, label: 'A', changes: [{ field: 'presetId', label: 'Saved Model', before: null, after: 'reserved-copy' }] }], excluded: [], effects: ['One named copy.'],
      presetCopy: { planId: '1'.repeat(32), sourcePresetId: 'original', copyPresetId: 'reserved-copy', copyName: 'Named copy', parameters: [{ name: 'temperature', label: 'Temperature', before: { state: 'unset' }, after: { state: 'set', value: 0 } }] } }
    f.recipe.preimages = { planId: '1'.repeat(32) }
    f.recipe.presetCopy = { current: () => ({ ...fact }) }
    return { ...f, setFact(next: ModelPresetCopyOutcome) { fact = next }, fact: () => fact }
  }
  it('keeps one identity/flight, the scalar30s clock and a named saved orphan without exposing private recipe cuts', async () => {
    const f = copyFixture()
    f.execute.mockImplementation(async () => { f.setFact({ ...f.fact(), creation: 'saved', source: 'unavailable', assignment: 'blocked', reason: 'saved_copy_source_unavailable' }); return [] })
    const first = f.registry.capture(f.recipe)
    expect(f.registry.capture(f.recipe).operationId).toBe(first.operationId)
    const result = await f.registry.portableExecute(first.operationId, f.actor)
    expect(result).toMatchObject({ executionBudgetMs: 30000, presetCopyOutcome: { creation: 'saved', source: 'unavailable', assignment: 'blocked', presetId: 'reserved-copy' } })
    expect(result).not.toHaveProperty('resourceOutcomes')
    // Native tool dispatch and the Zip adapter keep this complete generic result; this
    // actual compact owner must not discard the new nested named-copy fact.
    const compact = normalizeCompactTool({ toolName: 'native_batshit_tool_use', toolArgs: { ref: 'fabric:sys.app_settings.native.change', input: { op: 'change' } },
      toolResult: { success: true, controlId: 'sys.app_settings.native.change', result, ref: 'fabric:sys.app_settings.native.change', family: 'fabric', target: 'sys.app_settings.native.change', operationKind: 'fabric_use', rendererFamily: 'generic_tool' } })
    expect(compact.operationKind).toBe('fabric_use')
    expect(JSON.stringify(compact.toolResult)).toContain(JSON.stringify(f.fact()))

    const review = await f.registry.humanReview('owner', first.operationId)
    expect(isAppActionsOperationResponse({ success: true, operation: review })).toBe(true)
    await f.registry.portableExecute(first.operationId, f.actor); expect(f.execute).toHaveBeenCalledOnce()
  })
  it('unknown creation remains unknown even with no target save, and malformed copy/target identity cannot be reviewed', async () => {
    const f = copyFixture()
    f.execute.mockImplementation(async () => { f.setFact({ ...f.fact(), creation: 'unknown', assignment: 'blocked' }); return [] })
    const first = f.registry.capture(f.recipe)
    expect((await f.registry.portableExecute(first.operationId, f.actor)).status).toBe('unknown_outcome')
    expect(() => f.registry.capture({ ...f.recipe, requestId: `${f.registry.boot}:other`, presetCopy: undefined })).toThrow('copy recipe')
    const review = await f.registry.humanReview('owner', first.operationId)
    review.presetCopyOutcome!.presetId = 'wrong'
    expect(isAppActionsOperationResponse({ success: true, operation: review })).toBe(false)
  })
})


it('copy custody cannot be attached to an MCP resource or an ordinary scalar recipe', () => {
  const f = fixture(), mcp = resourceFixture()
  const copy = { current: (): ModelPresetCopyOutcome => ({ presetId: 'copy', name: 'Copy', creation: 'not_requested', source: 'not_requested', assignment: 'not_started' }) }
  expect(() => f.registry.capture({ ...f.recipe, presetCopy: copy })).toThrow('copy recipe')
  expect(() => mcp.registry.capture({ ...mcp.recipe, presetCopy: copy })).toThrow('copy recipe')
  const captured = mcp.registry.capture(mcp.recipe)
  expect(captured.executionBudgetMs).toBe(180000)
  expect(captured).toMatchObject({ totalTargets: 0, totalResources: 1, resourceOutcomes: [] })
  expect(captured).not.toHaveProperty('presetCopyOutcome')
})

describe('full MCP recipe data in the same existing operation ledger', () => {
  it('binds the full Primary/removal/Zip review and spends one exact Ask without a positive producer certificate', async () => {
    const f = fixture(), subject = { kind: 'primary' as const, id: 'a' }
    const review: McpPrerequisiteReview = { kind: 'mcp-configuration', variant: 'prerequisite', planId: `mcpp_${'1'.repeat(32)}`, candidateId: `mcpc_${'2'.repeat(32)}`,
      mode: 'remove', sourceAction: 'absent', resource: { kind: 'mcp-gateway', gatewayId: 'absent' }, before: null, after: null,
      intent: { subject, gatewayId: 'absent', membership: 'disable' }, target: { subject, label: 'A', changes: [{ field: 'membership', label: 'Source selected', before: true, after: false }] }, stages: [...MCP_CONFIGURATION_STAGES] }
    const execute = vi.fn<SettingsOperationRecipe['execute']>(async execution => {
      execution.recordOutcome({ subject, status: 'unchanged', saved: 'not_requested', readback: 'verified', visible: 'unchanged' })
      execution.recordResourceOutcome!({ variant: 'prerequisite', resource: review.resource, status: 'unchanged', saved: 'not_requested', stages: {
        installation: 'not_requested', registry: 'not_requested', keyReference: 'not_requested', dockerFile: 'not_requested',
        verification: 'not_requested', discoverability: 'verified', originalTaskUse: 'not_started', zip: 'not_requested' } })
      return []
    })
    const recipe: SettingsOperationRecipe = { ...f.recipe, resource: review.resource,
      input: { ...(f.recipe.input as Record<string, unknown>), semanticId: MCP_CONFIGURATION_ID, changes: { target: review.intent } },
      preimages: { disclosure: review }, execute,
      preview: { semanticId: MCP_CONFIGURATION_ID, resource: review, targets: [{ ...review.target, changes: review.target.changes.map(row => ({ ...row })) }], excluded: [], effects: [...mcpConfigurationEffects(review)] } }
    const captured = f.registry.capture(recipe)
    const pending = await f.registry.humanReview('owner', captured.operationId)
    expect(pending.preview.resource).toEqual(review); expect(execute).not.toHaveBeenCalled()
    expect(isAppActionsOperationResponse({ success: true, operation: pending })).toBe(true)
    expect(() => f.registry.capture({ ...recipe, input: { different: true } })).toThrow('different changes')
    const result = await f.registry.decide('owner', captured.operationId, captured.intentDigest, 'approve')
    expect(result.status).toBe('completed'); expect(result.totalTargets).toBe(1); expect(result.outcomesPending).toBe(0)
    expect(result.resourceOutcomes?.[0]).toMatchObject({ variant: 'prerequisite', saved: 'not_requested', stages: { verification: 'not_requested', originalTaskUse: 'not_started' } })
    await expect(f.registry.decide('owner', captured.operationId, captured.intentDigest, 'approve')).rejects.toThrow('already')
    expect(execute).toHaveBeenCalledOnce()
    // This scalar fixture is not an API original or a running private recipe.
    await expect(f.registry.readP5ExecutingApiMcpRecipe(Object.freeze({}) as import('../mcp/originalTask').P5ApiOriginalRun,
      { operationId: captured.operationId, requestId: recipe.requestId })).rejects.toThrow('genuine executing API owner')
    const broken = fixture()
    expect(() => broken.registry.capture({ ...recipe, requestId: `${broken.registry.boot}:full`, preview: { ...recipe.preview, targets: [] } })).toThrow('resource recipe')
  })
})
