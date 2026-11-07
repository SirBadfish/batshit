import { MODEL_PRESET_COPY_ID, type ModelSelectionReview } from '$lib/appActions/settings/modelSelectionPreferences'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { APP_ACTIONS_NATIVE_CHANGE_CONTROL_ID, type AppActionsApprovalPreview } from '$lib/appActions/settings/managementContract'
import { MCP_CONFIGURATION_ID, MCP_CONFIGURATION_EFFECTS, MCP_CONFIGURATION_STAGES } from '$lib/appActions/settings/mcpConfiguration'

/**
 * SA-120 P7 (Josh's review, 2026-09-17) — the origin line on an Approve card.
 *
 * A chat a DM, a wake-up webhook, or a schedule started is driven by text the user did not
 * write, and this card is where they decide whether to let it act. So every approval card
 * of such a turn says at the top who started it, flagged or not. The Jev flag itself is a
 * SEPARATE notice card (`JevJuiceFlagNotice`), never a line here: a flag on the approval
 * card made Approve feel like approving the flag.
 *
 * The pin that matters more than the wording (DL-120-12): the line is information. It
 * cannot approve, deny, delay, or pre-select anything. Both buttons stay rendered, stay
 * enabled, and still call `onApprovalAction` exactly as they do with no wake at all.
 */

const briefs = new Map<string, unknown>()
const requestDmBrief = vi.fn()

vi.mock('$lib/stores/dmBriefs.svelte', () => ({
  getDmBrief: (dmId: string | null | undefined) => (dmId ? (briefs.get(dmId) ?? null) : null),
  getJevJuiceDmScreen: (dmId: string | null | undefined) =>
    (dmId ? ((briefs.get(dmId) as { screen?: unknown } | undefined)?.screen ?? null) : null),
  requestDmBrief: (dmId: string | null | undefined) => requestDmBrief(dmId)
}))

const MessageApprovalPanel = (await import('./MessageApprovalPanel.svelte')).default

const FLAG = {
  status: 'flagged' as const,
  severity: 'serious' as const,
  findings: [{ id: 'override' as const, probability: 0.98 }],
  harm: 2,
  clipped: false,
  source: 'agent_dm' as const
}

const APPROVAL = {
  approvalId: 'appr_1',
  toolName: 'bash',
  status: 'pending',
  input: { command: 'rm -rf /tmp/thing' },
  control: null
}

function mount(props: Record<string, unknown> = {}) {
  const onApprovalAction = vi.fn()
  render(MessageApprovalPanel, {
    props: {
      approvals: [APPROVAL],
      approvalSubmitting: false,
      approvalError: null,
      describeApproval: () => 'Run a shell command',
      formatApprovalInput: (input: unknown) => JSON.stringify(input),
      getApprovalRemainingSeconds: () => null,
      onApprovalAction,
      ...props
    }
  })
  return { onApprovalAction }
}

beforeEach(() => {
  briefs.clear()
  requestDmBrief.mockClear()
})

describe('I1 MCP native resource disclosure', () => {
  function approval() {
    const input = { op: 'change', requestId: `${'a'.repeat(24)}:mcp`, reportId: `asr_${'a'.repeat(24)}_mcp_${'b'.repeat(32)}`,
      semanticId: MCP_CONFIGURATION_ID, changes: { source: { candidateId: `mcpc_${'c'.repeat(32)}` } } }
    const settingsPreview: AppActionsApprovalPreview = { controlId: APP_ACTIONS_NATIVE_CHANGE_CONTROL_ID, input,
      operationId: `aso_${'a'.repeat(24)}_mcp_config_${'d'.repeat(32)}`, intentDigest: 'e'.repeat(64), reviewExpiresAt: '2026-10-18T00:10:00.000Z',
      hardDeadlineAt: null, executionBudgetMs: 180_000, initialOutcomes: [], preview: { semanticId: MCP_CONFIGURATION_ID, targets: [], excluded: [], effects: [...MCP_CONFIGURATION_EFFECTS],
        resource: { kind: 'mcp-configuration', planId: `mcpp_${'f'.repeat(32)}`, candidateId: input.changes.source.candidateId, mode: 'create',
          resource: { kind: 'mcp-gateway', gatewayId: 'assigned' }, before: null, after: { id: 'assigned', slug: 'source', name: '<b>Literal source</b>', type: 'custom', enabled: true,
            url: 'https://source.example/mcp', savedKeyRef: 'custom-mcp', evidence: { kind: 'supplied', uri: 'https://source.example/docs', version: '1.2.3' } }, stages: [...MCP_CONFIGURATION_STAGES] } } }
    return { approvalId: 'mcp_approval', status: 'pending', control: { controlId: APP_ACTIONS_NATIVE_CHANGE_CONTROL_ID, controlTitle: 'MCP gateway save', riskLevel: 'confirm', lane: 'cli', input, settingsPreview } }
  }
  it('shows complete escaped resource/source/destination/reference facts before the existing buttons', async () => {
    const { onApprovalAction } = mount({ approvals: [approval()] })
    const view = screen.getByTestId('approval-mcp-review')
    expect(view.textContent).toContain('https://source.example/mcp')
    expect(view.textContent).toContain('custom-mcp')
    expect(view.textContent).toContain('https://source.example/docs')
    expect(view.textContent).toContain('1.2.3')
    expect(view.querySelector('b')).toBeNull()
    expect(screen.getByRole('button', { name: 'Approve' })).not.toBeDisabled()
    await fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    expect(onApprovalAction).toHaveBeenCalledWith('mcp_approval', true)
  })
  it('a foreign or absent resource disables Approve while Deny remains available', async () => {
    const bad = approval()
    ;(bad.control.settingsPreview.preview as any).resource.resource.gatewayId = 'foreign'
    const { onApprovalAction } = mount({ approvals: [bad] })
    expect(screen.queryByTestId('approval-mcp-review')).toBeNull()
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Deny' })).not.toBeDisabled()
    await fireEvent.click(screen.getByRole('button', { name: 'Deny' }))
    expect(onApprovalAction).toHaveBeenCalledWith('mcp_approval', false)
  })
})

describe('A3 held clear and voice selection disclosure', () => {
  function selected(mode: 'clear-api' | 'clear-cli' | 'voice') {
    const clearing = mode !== 'voice'
    const native = { claudeModel: { state: 'set' as const, value: '<b>literal-native</b>' }, claudeLegacyModel: { state: 'null' as const } }
    const facts: ModelSelectionReview = { intent: clearing ? 'clear' : 'select', role: mode === 'clear-cli' ? 'cli-subagent' : clearing ? 'api-subagent' : 'api-primary',
      presetBefore: { state: 'set', value: 'old' }, presetAfter: { state: 'set', value: clearing ? '' : 'voice' }, legacyModel: clearing ? { state: 'set', value: '<b>legacy</b>' } : { state: 'unknown' },
      inheritance: mode === 'clear-api' ? 'legacy-model-requires-selection' : 'no-replacement-promised',
      native: mode === 'clear-cli' ? { before: native, after: structuredClone(native) } : null,
      voice: clearing ? null : { runtime: 'livekit', mode: 'speech-to-speech', providerId: 'openai', adapterId: 'livekit-openai-realtime', supportStatus: 'supported', locksVoiceModeSettings: true } }
    const input = { ...CHANGE_INPUT, semanticId: 'agent.model.selection', changes: clearing ? { clear: true } : { presetId: 'voice' } }
    const preview: AppActionsApprovalPreview = { ...SETTINGS_PREVIEW, input, preview: { semanticId: 'agent.model.selection', targets: [{ subject: { kind: clearing ? 'subagent' : 'primary', id: 'chosen' }, label: 'Chosen',
      changes: [{ field: 'presetId', label: 'Saved Model', before: 'old', after: clearing ? null : 'voice' }], modelSelection: facts }], excluded: [], effects: ['Only the captured selection.'] } }
    const approval = nativeApproval(preview)
    return { ...approval, control: { ...approval.control, input, settingsPreview: preview } }
  }
  it.each(['clear-api', 'clear-cli', 'voice'] as const)('renders complete escaped %s facts before the existing exact-bound approval', async mode => {
    const { onApprovalAction } = mount({ approvals: [selected(mode)] })
    const review = screen.getByTestId('approval-model-selection-review')
    expect(review.textContent).toContain(mode === 'voice' ? 'Unobserved, preserved' : '<b>legacy</b>'); expect(review.querySelector('b')).toBeNull()
    if (mode === 'voice') {
      expect(review.textContent).toContain('Next Connect: LiveKit Speech-to-speech')
      expect(review.textContent).toContain('Locked by this preset'); expect(review.textContent).toContain('No room start, stop, reconnect')
    } else {
      expect(review.textContent).toContain('Empty (no saved selection)')
      expect(review.textContent).toContain(mode === 'clear-api' ? 'prevents parent inheritance' : 'No next-run program or model is promised')
    }
    await fireEvent.click(screen.getByRole('button', { name: 'Approve', exact: true }))
    expect(onApprovalAction).toHaveBeenCalledOnce()
  })
  it('missing typed clear facts disables approval without hiding Deny', () => {
    const approval = selected('clear-api')
    delete approval.control.settingsPreview.preview.targets[0].modelSelection
    mount({ approvals: [approval] })
    expect(screen.getByRole('button', { name: 'Approve', exact: true })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Deny', exact: true })).not.toBeDisabled()
  })
})

describe('MessageApprovalPanel: the origin line of a woken turn', () => {
  it('asks for the brief of the DM that woke this turn', async () => {
    mount({ wakeDmId: 'dm_woke_me' })
    await waitFor(() => expect(requestDmBrief).toHaveBeenCalledWith('dm_woke_me'))
  })

  it('says who started the turn, from the DM record and not from any flag', async () => {
    briefs.set('dm_woke_me', { from: { kind: 'webhook', name: 'Nightly build' }, subject: 'x', snippet: 'y', screen: null })
    mount({ wakeDmId: 'dm_woke_me' })
    const line = await screen.findByTestId('approval-wake-origin')
    expect(line.textContent).toBe('This turn was started by a wake-up message from webhook "Nightly build", not by you.')
  })

  it('names an agent and a schedule the same way', async () => {
    briefs.set('dm_agent', { from: { kind: 'agent', name: 'Cooper' }, subject: '', snippet: '', screen: FLAG })
    mount({ wakeDmId: 'dm_agent' })
    expect((await screen.findByTestId('approval-wake-origin')).textContent).toContain('from agent "Cooper"')

    briefs.set('dm_clock', { from: { kind: 'schedule', name: 'Morning check' }, subject: '', snippet: '', screen: null })
    mount({ wakeDmId: 'dm_clock' })
    await waitFor(() =>
      expect(screen.getAllByTestId('approval-wake-origin').map((node) => node.textContent)).toContain(
        'This turn was started by a wake-up message from the schedule "Morning check", not by you.'
      )
    )
  })

  it('never draws the flag on this card, even for a flagged wake-up message', async () => {
    briefs.set('dm_woke_me', { from: { kind: 'webhook', name: 'Nightly build' }, subject: 'x', snippet: 'y', screen: FLAG })
    mount({ wakeDmId: 'dm_woke_me' })
    await screen.findByTestId('approval-wake-origin')
    expect(screen.queryByText(/Flagged by/)).toBeNull()
    expect(screen.queryByText(/confidence/)).toBeNull()
    expect(screen.queryByText(/Judge Juice/)).toBeNull()
  })

  it('leaves BOTH buttons enabled and acting exactly as they do without a wake', async () => {
    briefs.set('dm_woke_me', { from: { kind: 'webhook', name: 'Nightly build' }, subject: 'x', snippet: 'y', screen: FLAG })
    const { onApprovalAction } = mount({ wakeDmId: 'dm_woke_me' })
    await screen.findByTestId('approval-wake-origin')

    const approve = screen.getByRole('button', { name: 'Approve' })
    const deny = screen.getByRole('button', { name: 'Deny' })
    expect(approve).not.toBeDisabled()
    expect(deny).not.toBeDisabled()

    await fireEvent.click(approve)
    expect(onApprovalAction).toHaveBeenCalledWith('appr_1', true)
    await fireEvent.click(deny)
    expect(onApprovalAction).toHaveBeenCalledWith('appr_1', false)
    expect(onApprovalAction).toHaveBeenCalledTimes(2)
  })

  it('draws no origin line for a typed turn, or while the brief has not landed', async () => {
    mount({})
    mount({ wakeDmId: 'dm_unknown' })
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Approve' })).toHaveLength(2))
    expect(screen.queryByTestId('approval-wake-origin')).toBeNull()
    expect(requestDmBrief).toHaveBeenCalledWith('dm_unknown')
  })
})

const CHANGE_INPUT = {
  op: 'change', requestId: `${'a'.repeat(24)}:human-reviewed`, reportId: `asr_${'a'.repeat(24)}_${'b'.repeat(32)}`,
  semanticId: 'agent.memory.preferences', changes: { triggers: 0 }
}
const SETTINGS_PREVIEW: AppActionsApprovalPreview = {
  controlId: APP_ACTIONS_NATIVE_CHANGE_CONTROL_ID, input: CHANGE_INPUT,
  operationId: `aso_${'a'.repeat(24)}_${'c'.repeat(32)}`, intentDigest: 'd'.repeat(64),
  preview: { semanticId: 'agent.memory.preferences', targets: [{ subject: { kind: 'primary', id: 'chosen' }, label: 'Chosen Agent',
    changes: [{ field: 'triggers', label: 'Trigger Memory Budget', before: 1500, after: 0 }] }],
    excluded: [{ kind: 'subagent', id: 'excluded' }], effects: ['Change only the chosen memory preference.'] },
  initialOutcomes: [],
  reviewExpiresAt: '2026-10-17T04:10:00.000Z', hardDeadlineAt: '2026-10-17T04:11:00.000Z', executionBudgetMs: 30000
}
function nativeApproval(preview: unknown = SETTINGS_PREVIEW) {
  return { ...APPROVAL, toolName: 'native_batshit_tool_use', control: {
    approvalId: 'apr_server_record', controlId: APP_ACTIONS_NATIVE_CHANGE_CONTROL_ID,
    controlTitle: 'Change Agent Settings', riskLevel: 'confirm', lane: 'api', input: CHANGE_INPUT, settingsPreview: preview
  } }
}
const CLI_INPUT = { ...CHANGE_INPUT, semanticId: 'agent.reasoning.cli', changes: { displayReasoning: false, preserveReasoning: false } }
const CLI_PREVIEW: AppActionsApprovalPreview = {
  ...SETTINGS_PREVIEW, input: CLI_INPUT,
  preview: { semanticId: 'agent.reasoning.cli', targets: [{ subject: { kind: 'primary', id: 'chosen' }, label: 'Chosen CLI',
    changes: [{ field: 'displayReasoning', label: 'Display Reasoning', before: true, after: false },
      { field: 'preserveReasoning', label: 'Preserve Reasoning In Chat History', before: true, after: false }] }], excluded: [], effects: ['Hiding reasoning also turns preservation off.'] },
  initialOutcomes: [
    { subject: { kind: 'primary', id: 'blocked_cli' }, status: 'blocked', reason: 'context_management_blocked', saved: 'not_requested', readback: 'not_requested', visible: 'unchanged' },
    { subject: { kind: 'subagent', id: 'not_a_primary' }, status: 'unavailable', reason: 'cli_primary_only', saved: 'not_requested', readback: 'not_requested', visible: 'unchanged' },
    { subject: { kind: 'primary', id: 'already_hidden' }, status: 'unchanged', reason: 'no_op', saved: 'not_requested', readback: 'not_requested', visible: 'unchanged' },
    { subject: { kind: 'primary', id: 'ordinary_blocked' }, status: 'blocked', reason: 'ordinary_changes_blocked', saved: 'not_requested', readback: 'not_requested', visible: 'unchanged' },
    { subject: { kind: 'primary', id: 'unavailable_plan' }, status: 'unavailable', reason: 'cli_reasoning_plan_unavailable', saved: 'not_requested', readback: 'not_requested', visible: 'unchanged' },
    { subject: { kind: 'primary', id: 'odd.id' }, status: 'unavailable', reason: 'unsupported_subject_id', saved: 'not_requested', readback: 'not_requested', visible: 'unchanged' }
  ]
}
function cliApproval(preview: unknown = CLI_PREVIEW) {
  const approval = nativeApproval(preview)
  return { ...approval, control: { ...approval.control, input: CLI_INPUT } }
}
describe('MessageApprovalPanel: server-held native Settings preview', () => {
  it('shows complete escaped deduplicated instruction text, every typed target, inclusion and exclusions', () => {
    const before = `  <script>alert('kept as text')</script>\n${'Long prior prose '.repeat(30)}END BEFORE  `
    const after = `\n${'Replacement prose '.repeat(30)}<img src=x onerror=alert(1)> END AFTER\n`
    const input = { ...CHANGE_INPUT, semanticId: 'agent.instructions', changes: { customPrompt: after, includeGlobalPrompt: false } }
    const preview = { ...SETTINGS_PREVIEW, input, preview: {
      semanticId: 'agent.instructions',
      targets: [
        { subject: { kind: 'primary', id: 'chosen' }, label: 'Chosen Agent', changes: [{ field: 'customPrompt', label: 'Custom System Prompt', before: 'text_0', after: 'text_1' }, { field: 'includeGlobalPrompt', label: 'Include Global Custom Prompt', before: 'absent', after: false }] },
        { subject: { kind: 'subagent', id: 'workflow' }, label: 'Workflow Helper', changes: [{ field: 'customPrompt', label: 'Custom System Prompt', before: 'text_0', after: 'text_1' }] }
      ], excluded: [{ kind: 'primary', id: 'excluded' }], effects: ['Later compilation only.'],
      instructions: { version: 1, texts: [{ id: 'text_0', text: before }, { id: 'text_1', text: after }], targets: [
        { subject: { kind: 'primary', id: 'chosen' }, customPrompt: { before: { state: 'set', textId: 'text_0' }, after: { state: 'set', textId: 'text_1' } }, includeGlobalPrompt: { before: { state: 'absent' }, after: { state: 'set', value: false }, effectiveBefore: true, effectiveAfter: false } },
        { subject: { kind: 'subagent', id: 'workflow' }, customPrompt: { before: { state: 'set', textId: 'text_0' }, after: { state: 'set', textId: 'text_1' } } }
      ] }
    }, initialOutcomes: [] }
    const approval = nativeApproval(preview)
    mount({ approvals: [{ ...approval, control: { ...approval.control, input } }] })
    const review = screen.getByTestId('approval-instructions-review')
    expect(screen.getAllByTestId('approval-instructions-text').map(node => node.textContent)).toEqual([before, after])
    expect(review.querySelector('script, img')).toBeNull()
    expect(review.textContent).toContain('Chosen Agent (Primary Agent)')
    expect(review.textContent).toContain('Workflow Helper (Subagent)')
    expect(review.textContent).toContain('Before: Not stored (effective: On)')
    expect(review.textContent).toContain('After: Off (effective: Off)')
    expect(review.textContent).toContain('Primary Agent: excluded')
    expect(screen.getByRole('button', { name: 'Approve', exact: true })).not.toBeDisabled()
  })
  it.each([
    undefined,
    [{ ...CLI_PREVIEW.initialOutcomes![0], status: 'applied', saved: 'saved' }],
    [{ ...CLI_PREVIEW.initialOutcomes![0], subject: { kind: 'primary', id: 'chosen' } }],
    Array.from({ length: 256 }, (_, index) => ({ ...CLI_PREVIEW.initialOutcomes![0], subject: { kind: 'primary', id: `blocked_${index}` } }))
  ])('refuses a CLI preview with missing or misleading nonexecuting rows (%#)', async initialOutcomes => {
    const { onApprovalAction } = mount({ approvals: [cliApproval({ ...CLI_PREVIEW, initialOutcomes })] })
    expect(screen.queryByTestId('approval-settings-preview')).toBeNull()
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Deny' })).not.toBeDisabled()
    await fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    expect(onApprovalAction).not.toHaveBeenCalled()
  })
  it('keeps Deny available but refuses Approve for the new Settings control without a bound preview', async () => {
    const approval = nativeApproval(); delete (approval.control as any).settingsPreview
    const { onApprovalAction } = mount({ approvals: [approval] })
    expect(screen.queryByTestId('approval-settings-preview')).toBeNull()
    expect(screen.getByText('Settings changes could not be confirmed. Refresh this request or ask for a new one before approving.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Deny' })).not.toBeDisabled()
    await fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    expect(onApprovalAction).not.toHaveBeenCalled()
    await fireEvent.click(screen.getByRole('button', { name: 'Deny' }))
    expect(onApprovalAction).toHaveBeenCalledWith('appr_1', false)
  })
  it('displays exact targets, exclusions, zero values, effects and returned clocks without making authority', async () => {
    const { onApprovalAction } = mount({ approvals: [nativeApproval()] })
    const preview = screen.getByTestId('approval-settings-preview')
    expect(preview.textContent).toContain('Chosen Agent (Primary Agent)')
    expect(preview.textContent).toContain('chosen')
    expect(preview.textContent).toContain('Subagent: excluded')
    expect(preview.textContent).toContain('Before: 1500')
    expect(preview.textContent).toContain('After: 0')
    expect(preview.textContent).toContain('Change only the chosen memory preference.')
    expect(preview.textContent).toContain('Review expires:')
    expect(preview.textContent).toContain('Time limit: 30 seconds')
    expect(preview.textContent).toContain('Request deadline:')
    expect(preview.textContent).not.toContain(SETTINGS_PREVIEW.operationId)
    expect(preview.textContent).not.toContain(SETTINGS_PREVIEW.intentDigest)
    expect(preview.textContent).not.toContain(CHANGE_INPUT.reportId)
    expect(onApprovalAction).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Approve' })).not.toBeDisabled()
    await fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    expect(onApprovalAction).toHaveBeenCalledWith('appr_1', true)
    await fireEvent.click(screen.getByRole('button', { name: 'Deny' }))
    expect(onApprovalAction).toHaveBeenCalledWith('appr_1', false)
    expect(onApprovalAction).toHaveBeenCalledTimes(2)
  })
  it.each([
    { ...SETTINGS_PREVIEW, executionBudgetMs: -1 },
    { ...SETTINGS_PREVIEW, input: { ...CHANGE_INPUT, requestId: `${'a'.repeat(24)}:different-request` } },
    { ...SETTINGS_PREVIEW, input: { ...CHANGE_INPUT, changes: { triggers: 100 } } },
    { ...SETTINGS_PREVIEW, preview: { ...SETTINGS_PREVIEW.preview, semanticId: 'agent.identity' } }
  ])('never displays malformed or foreign supplemental input (%j)', bad => {
    const { onApprovalAction } = mount({ approvals: [nativeApproval(bad)] })
    expect(screen.queryByTestId('approval-settings-preview')).toBeNull()
    expect(screen.getByText('Settings changes could not be confirmed. Refresh this request or ask for a new one before approving.')).toBeTruthy()
    expect(onApprovalAction).not.toHaveBeenCalled()
    expect(screen.getAllByRole('button', { name: 'Approve' })).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Deny' })).not.toBeDisabled()
  })
  it('does not read model input fallback or decorate an unrelated control with Settings changes', () => {
    const native = nativeApproval()
    const approval = { ...native, control: { ...native.control, controlId: 'sys.schedule.create' } }
    const { onApprovalAction } = mount({ approvals: [{ ...approval, input: { settingsPreview: SETTINGS_PREVIEW } }] })
    expect(screen.queryByTestId('approval-settings-preview')).toBeNull()
    expect(screen.queryByText('Settings changes could not be confirmed. Refresh this request or ask for a new one before approving.')).toBeNull()
    expect(screen.getByRole('button', { name: 'Approve' })).not.toBeDisabled()
    expect(onApprovalAction).not.toHaveBeenCalled()
  })
  it('does not accept a model-input preview as the new Settings control display', () => {
    const approval = nativeApproval(); delete (approval.control as any).settingsPreview
    const { onApprovalAction } = mount({ approvals: [{ ...approval, input: { ...CHANGE_INPUT, settingsPreview: SETTINGS_PREVIEW } }] })
    expect(screen.queryByTestId('approval-settings-preview')).toBeNull()
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled()
    expect(onApprovalAction).not.toHaveBeenCalled()
  })
  it('creates no approval buttons from supplemental data without an existing approval entry', () => {
    const { onApprovalAction } = mount({ approvals: [], settingsPreview: SETTINGS_PREVIEW })
    expect(screen.queryByTestId('approval-settings-preview')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()
    expect(onApprovalAction).not.toHaveBeenCalled()
  })
})


describe('A12 native named-copy disclosure under the actual shared input validator', () => {
  function approval() {
    const input = { op: 'change', requestId: `${'a'.repeat(24)}:copy`, reportId: `asr_${'a'.repeat(24)}_${'b'.repeat(32)}`, semanticId: MODEL_PRESET_COPY_ID,
      changes: { sourcePresetId: 'original', copyName: '<b>Named copy</b>', parameters: [{ name: 'temperature', op: 'set', value: 0 }] } }
    const settingsPreview: AppActionsApprovalPreview = { controlId: APP_ACTIONS_NATIVE_CHANGE_CONTROL_ID, input, operationId: `aso_${'a'.repeat(24)}_${'d'.repeat(32)}`, intentDigest: 'e'.repeat(64), reviewExpiresAt: '2026-10-18T00:10:00.000Z', hardDeadlineAt: null, executionBudgetMs: 30000,
      initialOutcomes: [{ subject: { kind: 'subagent', id: 'workflow' }, status: 'unavailable', saved: 'not_requested', readback: 'not_requested', visible: 'unchanged', reason: 'Workflow model settings belong to its n8n workflow.' }],
      preview: { semanticId: MODEL_PRESET_COPY_ID, effects: ['One copy, then exact selected assignment.'], targets: [{ subject: { kind: 'primary', id: 'chosen' }, label: 'Chosen', changes: [{ field: 'presetId', label: 'Saved Model', before: 'original', after: 'reserved-copy' }] }], excluded: [{ kind: 'primary', id: 'excluded' }],
        presetCopy: { planId: 'f'.repeat(32), sourcePresetId: 'original', copyPresetId: 'reserved-copy', copyName: input.changes.copyName, parameters: [{ name: 'temperature', label: 'Temperature', before: { state: 'unset' }, after: { state: 'set', value: 0 } }] } } }
    return { approvalId: 'copy_approval', status: 'pending', control: { controlId: APP_ACTIONS_NATIVE_CHANGE_CONTROL_ID, controlTitle: 'Copy model preset', riskLevel: 'confirm', lane: 'cli', input, settingsPreview } }
  }
  it('shows escaped copy identity, exact parameter/default and selected/excluded/Workflow facts before one real Approve action', async () => {
    const { onApprovalAction } = mount({ approvals: [approval()] })
    const view = screen.getByTestId('approval-preset-copy-review')
    expect(view.textContent).toContain('<b>Named copy</b>'); expect(view.querySelector('b')).toBeNull()
    expect(view.textContent).toContain('Original unchanged'); expect(view.textContent).toContain('reserved-copy')
    expect(view.textContent).toContain('Before: Not set (provider default)'); expect(view.textContent).toContain('After: 0')
    expect(screen.getByText('Primary Agent: excluded')).toBeTruthy(); expect(screen.getByText(/Workflow model settings belong/)).toBeTruthy()
    await fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    expect(onApprovalAction).toHaveBeenCalledExactlyOnceWith('copy_approval', true)
  })
  it('a changed input/disclosure or destination refuses Approve without losing Deny', async () => {
    const bad = approval(); bad.control.input.changes.parameters[0].value = 1
    const { onApprovalAction } = mount({ approvals: [bad] })
    expect(screen.queryByTestId('approval-preset-copy-review')).toBeNull()
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled()
    await fireEvent.click(screen.getByRole('button', { name: 'Deny' }))
    expect(onApprovalAction).toHaveBeenCalledExactlyOnceWith('copy_approval', false)
  })
})
