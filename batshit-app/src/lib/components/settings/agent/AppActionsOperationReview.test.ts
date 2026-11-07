import { MODEL_PRESET_COPY_ID, type ModelSelectionReview } from '$lib/appActions/settings/modelSelectionPreferences'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AppActionsOperationReview from './AppActionsOperationReview.svelte'
import type { AppActionsOperationReview as Review } from '$lib/appActions/settings/managementContract'
import ReviewPage from '../../../../routes/app-actions/review/[operationId]/+page.svelte'
import { page } from '$app/state'
import { MCP_CONFIGURATION_ID, MCP_CONFIGURATION_EFFECTS, MCP_CONFIGURATION_STAGES, mcpConfigurationEffects, type McpPrerequisiteReview } from '$lib/appActions/settings/mcpConfiguration'

const ID = `aso_${'a'.repeat(24)}_${'b'.repeat(32)}`
const DIGEST = 'c'.repeat(64)
function fixture(): Review {
  return { operationId: ID, intentDigest: DIGEST, status: 'awaiting_approval', actor: { kind: 'portable', label: 'Outside helper' },
    preview: { semanticId: 'agent.identity', targets: [{ subject: { kind: 'primary', id: 'chosen' }, label: 'Chosen Agent', changes: [{ field: 'displayName', label: 'Display Name', before: 'Before', after: 'After' }] }], excluded: [{ kind: 'subagent', id: 'excluded' }], effects: ['Change the chosen display name.'] },
    reviewExpiresAt: '2026-10-17T03:10:00.000Z', hardDeadlineAt: '2026-10-17T03:11:00.000Z', executionBudgetMs: 30000, executionDeadlineAt: null, canDecide: true, outcomes: [] }
}
function reply(payload: unknown, status = 200) { return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } }) }
function install() {
  const state = { operation: fixture() }
  const writes: any[] = []
  const decide = vi.fn(async (approved = true) => { state.operation = { ...state.operation, status: approved ? 'completed' : 'denied', canDecide: false, outcomes: approved ? [{ subject: { kind: 'primary', id: 'chosen' }, status: 'applied', saved: 'saved', readback: 'verified', visible: 'unknown' }] : [] }; return reply({ success: true, operation: state.operation }) })
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method !== 'POST') return reply({ success: true, operation: state.operation })
    writes.push({ url: String(input), body: JSON.parse(String(init.body)) }); return decide(writes.at(-1).body.decision === 'approve')
  })
  vi.stubGlobal('fetch', fetchMock)
  return { state, writes, decide, fetchMock }
}
afterEach(() => { cleanup(); delete page.params.operationId; vi.restoreAllMocks(); vi.unstubAllGlobals() })
describe('portable one-operation human review', () => {
  it.each(['clear', 'voice'] as const)('shows exact typed %s facts and sends only one digest decision, with no room effect', async mode => {
    const { state, writes, fetchMock } = install()
    const clearing = mode === 'clear'
    const facts: ModelSelectionReview = { intent: clearing ? 'clear' : 'select', role: clearing ? 'api-subagent' : 'api-primary',
      presetBefore: { state: 'set', value: 'old' }, presetAfter: { state: 'set', value: clearing ? '' : 'voice' }, legacyModel: clearing ? { state: 'absent' } : { state: 'unknown' },
      inheritance: clearing ? 'parent-model-and-connection-at-run' : 'no-replacement-promised', native: null,
      voice: clearing ? null : { runtime: 'livekit', mode: 'speech-to-speech', providerId: 'openai', adapterId: 'livekit-openai-realtime', supportStatus: 'supported', locksVoiceModeSettings: true } }
    state.operation = { ...fixture(), preview: { semanticId: 'agent.model.selection', targets: [{ subject: { kind: clearing ? 'subagent' : 'primary', id: 'chosen' }, label: 'Chosen',
      changes: [{ field: 'presetId', label: 'Saved Model', before: 'old', after: clearing ? null : 'voice' }], modelSelection: facts }], excluded: [], effects: ['Configuration only.'] } }
    render(AppActionsOperationReview, { props: { operationId: ID } })
    const review = await screen.findByTestId('approval-model-selection-review')
    expect(review.textContent).toContain(clearing ? 'parent model and connection supplied at run time' : 'Next Connect: LiveKit Speech-to-speech')
    expect(writes).toEqual([])
    await fireEvent.click(screen.getByRole('button', { name: 'Approve', exact: true }))
    await screen.findByText('Finished')
    expect(writes).toEqual([{ url: `/api/app/settings/operations/${ID}/decision`, body: { decision: 'approve', intentDigest: DIGEST } }])
    expect(fetchMock.mock.calls.every(([url]) => String(url).includes('/api/app/settings/operations/'))).toBe(true)
    expect(screen.getByTestId('approval-model-selection-review')).toBeTruthy()
  })
  it('I1 renders the same complete resource disclosure and sends only one exact digest decision', async () => {
    const { state, writes, decide } = install()
    const operationId = `aso_${'a'.repeat(24)}_mcp_config_${'b'.repeat(32)}`
    state.operation = { ...fixture(), operationId, executionBudgetMs: 180_000, outcomes: [], resourceOutcomes: [],
      preview: { semanticId: MCP_CONFIGURATION_ID, targets: [], excluded: [], effects: [...MCP_CONFIGURATION_EFFECTS], resource: {
        kind: 'mcp-configuration', planId: `mcpp_${'d'.repeat(32)}`, candidateId: `mcpc_${'e'.repeat(32)}`, mode: 'create', resource: { kind: 'mcp-gateway', gatewayId: 'assigned' },
        before: null, after: { id: 'assigned', slug: 'source', name: 'Portable source', type: 'custom', enabled: true, url: 'https://source.example/mcp', savedKeyRef: 'custom-mcp' }, stages: [...MCP_CONFIGURATION_STAGES] } } }
    decide.mockImplementationOnce(async () => {
      state.operation = { ...state.operation, status: 'completed', canDecide: false, resourceOutcomes: [{ resource: { kind: 'mcp-gateway', gatewayId: 'assigned' }, status: 'applied', saved: 'saved',
        stages: { installation: 'not_started', registry: 'saved', keyReference: 'verified', dockerFile: 'not_started', verification: 'not_started', discoverability: 'not_started', originalTaskUse: 'not_started', zip: 'not_started' } }] }
      return reply({ success: true, operation: state.operation })
    })
    render(AppActionsOperationReview, { props: { operationId } })
    const view = await screen.findByTestId('approval-mcp-review')
    expect(view.textContent).toContain('https://source.example/mcp'); expect(view.textContent).toContain('custom-mcp')
    expect(writes).toEqual([])
    await fireEvent.click(screen.getByRole('button', { name: 'Approve', exact: true }))
    await screen.findByText('Finished')
    expect(writes).toEqual([{ url: `/api/app/settings/operations/${operationId}/decision`, body: { decision: 'approve', intentDigest: DIGEST } }])
    expect(screen.getByTestId('approval-mcp-review')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Approve', exact: true })).toBeNull()
  })
  it.each([false, true])('shows complete full/removal=%s MCP source and exact Primary/Zip consent without claiming use', async remove => {
    const { state, writes, decide } = install()
    const intent = { subject: { kind: 'primary' as const, id: 'chosen' }, gatewayId: 'assigned', membership: remove ? 'disable' as const : 'enable' as const,
      zip: { toolName: 'remote_tool', mode: 'inherit' as const } }
    const resource: McpPrerequisiteReview = { kind: 'mcp-configuration', variant: 'prerequisite', planId: `mcpp_${'d'.repeat(32)}`, candidateId: `mcpc_${'e'.repeat(32)}`,
      mode: remove ? 'remove' : 'configure', resource: { kind: 'mcp-gateway', gatewayId: 'assigned' }, sourceAction: remove ? 'absent' : 'unchanged',
      before: null, after: remove ? null : { id: 'assigned', slug: 'source', name: 'Exact Source', type: 'custom', enabled: true, url: 'https://source.example/mcp' }, intent,
      target: { subject: intent.subject, label: 'Exact Primary', settingsIdentity: 'C_remote_tool', changes: [{ field: 'membership', label: 'Source selected', before: remove, after: !remove },
        ...['buffer_size','zip_threshold','auto_zip','zip_disabled'].map(field => ({ field: `zip.${field}`, label: field, before: 'unset', after: null }))],
        effectiveZip: { before: { buffer_size: 0, zip_threshold: 0, auto_zip: false, zip_disabled: false }, after: { buffer_size: 0, zip_threshold: 0, auto_zip: false, zip_disabled: false } } },
      stages: [...MCP_CONFIGURATION_STAGES] }
    const operationId = `aso_${'a'.repeat(24)}_mcp_config_${'b'.repeat(32)}`
    state.operation = { ...fixture(), operationId, executionBudgetMs: 180000, resourceOutcomes: [], outcomes: [],
      preview: { semanticId: MCP_CONFIGURATION_ID, targets: [{ ...resource.target, changes: resource.target.changes.map(row => ({ ...row })) }], excluded: [], effects: [...mcpConfigurationEffects(resource)], resource } }
    decide.mockImplementationOnce(async () => { state.operation = { ...state.operation, status: 'denied', canDecide: false }; return reply({ success: true, operation: state.operation }) })
    render(AppActionsOperationReview, { props: { operationId } })
    const view = await screen.findByTestId('approval-mcp-review')
    expect(view.textContent).toContain('Exact Primary'); expect(view.textContent).toContain('remote_tool'); expect(view.textContent).toContain('Tool Zip row: C_remote_tool'); expect(view.textContent).toContain('inherit')
    expect(view.textContent).toContain('Setup consent grants no tool effect')
    expect(view.textContent).not.toContain('This saves the gateway record only')
    if (remove) expect(view.textContent).toContain('does not require the source to exist')
    else expect(view.textContent).toContain('https://source.example/mcp')
    expect(writes).toEqual([])
    await fireEvent.click(screen.getByRole('button', { name: 'Deny', exact: true }))
    await screen.findByText('Denied')
    expect(writes).toEqual([{ url: `/api/app/settings/operations/${operationId}/decision`, body: { decision: 'deny', intentDigest: DIGEST } }])
  })
  it('uses the shared complete escaped instructions table before and after the decision', async () => {
    const { state, writes } = install()
    const before = `  <b>before</b>\n${'full prior prose '.repeat(30)}last before  `
    const after = `\n${'full replacement prose '.repeat(30)}<script>literal</script> last after\n`
    state.operation = { ...fixture(), preview: { semanticId: 'agent.instructions', targets: [{ subject: { kind: 'primary', id: 'chosen' }, label: 'Chosen Agent', changes: [{ field: 'customPrompt', label: 'Custom System Prompt', before: 'text_0', after: 'text_1' }] }], excluded: [{ kind: 'subagent', id: 'excluded' }], effects: ['Later compilation.'], instructions: { version: 1, texts: [{ id: 'text_0', text: before }, { id: 'text_1', text: after }], targets: [{ subject: { kind: 'primary', id: 'chosen' }, customPrompt: { before: { state: 'set', textId: 'text_0' }, after: { state: 'set', textId: 'text_1' } } }] } } } as Review
    render(AppActionsOperationReview, { props: { operationId: ID } })
    await screen.findByTestId('approval-instructions-review')
    expect(screen.getAllByTestId('approval-instructions-text').map(node => node.textContent)).toEqual([before, after])
    expect(screen.getByTestId('approval-instructions-review').querySelector('b, script')).toBeNull()
    expect(screen.getByText('Subagent: excluded')).toBeTruthy()
    expect(writes).toEqual([])
    await fireEvent.click(screen.getByRole('button', { name: 'Approve', exact: true }))
    await screen.findByText('Finished')
    expect(screen.getAllByTestId('approval-instructions-text').map(node => node.textContent)).toEqual([before, after])
    expect(writes).toHaveLength(1)
  })
  it('shows captured blocked, unavailable and unchanged rows before consent without claiming any save', async () => {
    const { state, writes } = install()
    // SA-139 R4: the CLI reasoning control and its per-target access reasons were removed; the
    // blocked row carries a reason the settings owner still returns (`conditionalAgentSettings.ts`).
    state.operation = { ...fixture(), outcomes: [
      { subject: { kind: 'primary', id: 'blocked' }, status: 'blocked', reason: 'memory_readiness_unavailable', saved: 'not_requested', readback: 'not_requested', visible: 'unchanged' },
      { subject: { kind: 'primary', id: 'same' }, status: 'unchanged', saved: 'not_requested', readback: 'not_requested', visible: 'unchanged' },
      { subject: { kind: 'primary', id: 'odd.id' }, status: 'unavailable', reason: 'unsupported_subject_id', saved: 'not_requested', readback: 'not_requested', visible: 'unchanged' },
      { subject: { kind: 'primary', id: 'other_code' }, status: 'unavailable', reason: 'target-unavailable_before_write', saved: 'not_requested', readback: 'not_requested', visible: 'unchanged' },
      { subject: { kind: 'primary', id: 'human_reason' }, status: 'conflict', reason: 'Saved setting alpha_beta was changed by another request.', saved: 'not_requested', readback: 'not_requested', visible: 'unchanged' }
    ] }
    const outcomes = structuredClone(state.operation.outcomes)
    render(AppActionsOperationReview, { props: { operationId: ID } })
    expect(await screen.findByText('primary:blocked')).toBeTruthy()
    expect(screen.getByText('blocked: memory readiness unavailable')).toBeTruthy()
    expect(screen.getByText('unavailable: This saved agent ID is unsupported.')).toBeTruthy()
    expect(screen.getByText('unavailable: target unavailable before write')).toBeTruthy()
    expect(screen.getByText('conflict: Saved setting alpha_beta was changed by another request.')).toBeTruthy()
    expect(screen.getByText('unchanged')).toBeTruthy()
    expect(screen.getAllByText(/Save: Not requested/)).toHaveLength(5)
    expect(state.operation.outcomes).toEqual(outcomes)
    expect(state.operation.outcomes[0].reason).toBe('memory_readiness_unavailable')
    expect(screen.queryByText(/Save: Saved/)).toBeNull()
    expect(screen.getByRole('button', { name: 'Approve', exact: true })).not.toBeDisabled()
    expect(writes).toEqual([])
  })
  it('mounts the real review page using only its route operation identity', async () => {
    const { writes, fetchMock } = install()
    page.params.operationId = ID
    render(ReviewPage)
    expect(await screen.findByText('Chosen Agent')).toBeTruthy()
    expect(fetchMock).toHaveBeenCalledWith(`/api/app/settings/operations/${ID}`, { cache: 'no-store' })
    expect(writes).toEqual([])
  })
  it('reads and shows exact frozen targets, changes, effects and returned times without deciding', async () => {
    const { writes } = install(); render(AppActionsOperationReview, { props: { operationId: ID } })
    expect(await screen.findByText('Chosen Agent')).toBeTruthy()
    expect(screen.getByText('primary:chosen')).toBeTruthy()
    expect(screen.getByText('subagent:excluded')).toBeTruthy()
    expect(screen.getByText('Before → After')).toBeTruthy()
    expect(screen.getByText('Change the chosen display name.')).toBeTruthy()
    expect(screen.getByText('30 seconds')).toBeTruthy()
    expect(screen.getByText('Review Expires')).toBeTruthy()
    expect(screen.getByText('Request Deadline')).toBeTruthy()
    expect(writes).toEqual([])
  })
  it.each([['Approve', 'approve'], ['Deny', 'deny']])('posts only captured identity and digest for %s', async (label, decision) => {
    const { writes } = install(); render(AppActionsOperationReview, { props: { operationId: ID } })
    await fireEvent.click(await screen.findByRole('button', { name: label, exact: true }))
    await waitFor(() => expect(writes).toHaveLength(1))
    expect(writes[0]).toEqual({ url: `/api/app/settings/operations/${ID}/decision`, body: { decision, intentDigest: DIGEST } })
    if (decision === 'approve') {
      expect(await screen.findByText(/Save: Saved/)).toBeTruthy()
      expect(screen.getByText(/Saved value checked: Yes/)).toBeTruthy()
      expect(screen.getByText(/On-screen update: Unconfirmed/)).toBeTruthy()
    } else expect(await screen.findByText('Denied')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Approve', exact: true })).toBeNull()
  })
  it.each(['denied', 'cancelled', 'expired', 'blocked', 'running', 'unknown_outcome'] as const)('never offers a decision for %s', async status => {
    const { state, writes } = install(); state.operation = { ...fixture(), status, canDecide: false, hardDeadlineAt: null }
    render(AppActionsOperationReview, { props: { operationId: ID } })
    await screen.findByText('Chosen Agent')
    expect(screen.queryByRole('button', { name: 'Approve', exact: true })).toBeNull()
    expect(screen.queryByText('Request Deadline')).toBeNull()
    expect(writes).toEqual([])
  })
  it('does not resend after an unknown decision and reads the same operation on request', async () => {
    const { writes, decide, fetchMock, state } = install(); decide.mockRejectedValueOnce(new Error('Answer lost'))
    render(AppActionsOperationReview, { props: { operationId: ID } })
    await fireEvent.click(await screen.findByRole('button', { name: 'Approve', exact: true }))
    expect(await screen.findByText('Answer lost')).toBeTruthy()
    expect(writes).toHaveLength(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('button', { name: 'Approve', exact: true })).toBeNull()
    state.operation = { ...fixture(), status: 'running', canDecide: false }
    await fireEvent.click(screen.getByRole('button', { name: 'Check Operation Outcome' }))
    expect(await screen.findByText('Running')).toBeTruthy()
    expect(writes).toHaveLength(1)
  })
  it('rejects a returned operation identity mismatch without rendering approval', async () => {
    const { state, writes } = install(); state.operation = { ...fixture(), operationId: `aso_${'d'.repeat(24)}_${'e'.repeat(32)}` }
    render(AppActionsOperationReview, { props: { operationId: ID } })
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Approve', exact: true })).toBeNull()
    expect(writes).toEqual([])
  })
  it('never installs an approval response for a different frozen intent', async () => {
    const { state, writes, decide } = install()
    decide.mockImplementationOnce(async () => reply({ success: true, operation: { ...state.operation, intentDigest: 'f'.repeat(64), status: 'completed', canDecide: false } }))
    render(AppActionsOperationReview, { props: { operationId: ID } })
    await fireEvent.click(await screen.findByRole('button', { name: 'Approve', exact: true }))
    expect(await screen.findByText('The decision response could not be confirmed. Check the operation outcome; no decision will be sent again automatically.')).toBeTruthy()
    expect(writes).toHaveLength(1)
    expect(screen.queryByText('Finished')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Approve', exact: true })).toBeNull()
  })
})


it('A12 portable exact digest consent retains complete disclosure and a surviving named orphan receipt', async () => {
  const { state, writes, decide } = install()
  state.operation = { ...fixture(), preview: { semanticId: MODEL_PRESET_COPY_ID, targets: [{ subject: { kind: 'primary', id: 'chosen' }, label: 'Chosen', changes: [{ field: 'presetId', label: 'Saved Model', before: 'original', after: 'reserved-copy' }] }], excluded: [], effects: ['One copy then selected assignment.'],
    presetCopy: { planId: 'f'.repeat(32), sourcePresetId: 'original', copyPresetId: 'reserved-copy', copyName: '<b>Literal copy</b>', parameters: [{ name: 'temperature', label: 'Temperature', before: { state: 'set', value: 1 }, after: { state: 'set', value: 0 } }] } },
    presetCopyOutcome: { presetId: 'reserved-copy', name: '<b>Literal copy</b>', creation: 'not_requested', source: 'not_requested', assignment: 'not_started' } }
  decide.mockImplementationOnce(async () => {
    state.operation = { ...state.operation, status: 'completed', canDecide: false, presetCopyOutcome: { ...state.operation.presetCopyOutcome!, creation: 'saved', source: 'unavailable', assignment: 'blocked', reason: 'saved_copy_source_unavailable' }, outcomes: [] }
    return reply({ success: true, operation: state.operation })
  })
  render(AppActionsOperationReview, { props: { operationId: ID } })
  const disclosure = await screen.findByTestId('approval-preset-copy-review')
  expect(disclosure.textContent).toContain('Before: 1'); expect(disclosure.textContent).toContain('After: 0'); expect(disclosure.querySelector('b')).toBeNull()
  expect(writes).toEqual([])
  await fireEvent.click(screen.getByRole('button', { name: 'Approve', exact: true }))
  await screen.findByText('Finished')
  expect(screen.getByTestId('approval-preset-copy-review')).toBeTruthy()
  expect(screen.getByTestId('approval-preset-copy-outcome').textContent).toContain('Creation: saved')
  expect(screen.getByTestId('approval-preset-copy-outcome').textContent).toContain('not been rolled back or deleted')
  expect(writes).toEqual([{ url: `/api/app/settings/operations/${ID}/decision`, body: { decision: 'approve', intentDigest: DIGEST } }])
})
