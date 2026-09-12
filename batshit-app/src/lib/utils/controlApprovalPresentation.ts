/**
 * SA-116 (DL-116-06) — how a risky control's approval card reads.
 *
 * Split out of `ChatMessage.svelte` so it can be pinned against a payload captured from a
 * live run. The P4 lesson from SA-113: a broker step is COMPACTED before it reaches a
 * renderer, so a card that looks right against a hand-written fixture can still be blank
 * against the real thing.
 *
 * Text only. Nothing here is ever rendered as HTML.
 */

import { formatBatshitToolTargetDisplayName, formatToolDisplayName } from './toolNameFormatter'
import type { ToolApprovalControl, ToolApprovalEntry } from '$lib/types/tool-approvals'

type ApprovalLike = Partial<ToolApprovalEntry> & Record<string, any>

/**
 * The card's title for a control.
 *
 * `formatBatshitToolTargetDisplayName` returns null for a `cli_tool:` id — it is not a
 * Fabric control id — which is why the tool's own title is the fallback rather than the raw
 * id run through title case ("Cli Tool:repo Snapshot").
 */
export function formatControlApprovalTitle(control: ToolApprovalControl | null | undefined): string {
  const controlId = typeof control?.controlId === 'string' ? control.controlId : ''
  return (
    formatBatshitToolTargetDisplayName(controlId) ||
    (typeof control?.controlTitle === 'string' && control.controlTitle.trim().length > 0
      ? control.controlTitle.trim()
      : formatToolDisplayName(controlId || 'tool'))
  )
}

/**
 * Read one named value out of whichever shape the entry actually has.
 *
 * Four sources in order: the exact payload the server hashed (`control.input`, F-P2-2), its
 * `inputSummary` (keys plus short values, capped at 2 KB), the entry's own input, and the
 * tool call's input. Each is checked at the top level AND one level down under `input`,
 * because the broker wraps a control payload as `{ ref, input: { … } }`.
 */
export function readControlApprovalValue(approval: ApprovalLike, ...keys: string[]): string {
  const sources = [
    approval?.control?.input,
    approval?.control?.inputSummary,
    approval?.input,
    approval?.toolCall?.input
  ]
  for (const source of sources) {
    if (!source || typeof source !== 'object') continue
    const nested =
      (source as any).input && typeof (source as any).input === 'object'
        ? (source as any).input
        : null
    for (const key of keys) {
      const value = (source as any)[key] ?? nested?.[key]
      if (typeof value === 'string' && value.trim()) return value.trim()
      if (typeof value === 'number' && Number.isFinite(value)) return String(value)
    }
  }
  return ''
}

/**
 * One plain line saying what the click authorises, per control family.
 *
 * The card used to read "wants to use Dynamic Tool Use", because the title came from the
 * BROKER tool's display name and the control appeared only inside the raw input (measured,
 * SA-116 Part 2.10 (b)).
 */
export function describeControlApproval(approval: ApprovalLike): string {
  const control = approval?.control as ToolApprovalControl | undefined
  const controlId: string = typeof control?.controlId === 'string' ? control.controlId : ''
  const title = formatControlApprovalTitle(control ?? null)

  if (controlId.startsWith('cli_tool:')) {
    return `run CLI tool ${title}`
  }
  if (controlId === 'sys.skill.import') {
    const source = readControlApprovalValue(approval, 'source', 'url', 'repo', 'path')
    return source ? `install skill from ${source}` : 'install a skill'
  }
  if (controlId === 'sys.memory.delete') {
    const memoryId = readControlApprovalValue(approval, 'memory_id', 'memoryId', 'id')
    return memoryId ? `delete memory ${memoryId}` : 'delete a memory'
  }
  if (controlId === 'sys.runtime_addon.start' || controlId === 'sys.runtime_addon.stop') {
    const addon = readControlApprovalValue(approval, 'addonId', 'addon_id', 'name', 'id')
    const verb = controlId.endsWith('.start') ? 'start' : 'stop'
    return addon ? `${verb} Docker add-on ${addon}` : `${verb} a Docker add-on`
  }
  if (controlId === 'sys.artifact.rollback') {
    const artifact = readControlApprovalValue(approval, 'artifactId', 'artifact_id', 'slug')
    const version = readControlApprovalValue(approval, 'targetVersion', 'target_version', 'version')
    if (artifact && version) return `roll artifact ${artifact} back to v${version}`
    return artifact ? `roll artifact ${artifact} back` : 'roll an artifact back'
  }
  if (controlId === 'sys.artifact.delete_version') {
    const artifact = readControlApprovalValue(approval, 'artifactId', 'artifact_id', 'slug')
    const version = readControlApprovalValue(approval, 'version', 'targetVersion', 'target_version')
    if (artifact && version) return `delete version ${version} of artifact ${artifact}`
    return 'delete an artifact version'
  }
  if (controlId.startsWith('sys.voice.engine.')) {
    const engine = readControlApprovalValue(approval, 'engineId', 'engine_id', 'name')
    return engine ? `${title.toLowerCase()} for ${engine}` : title.toLowerCase()
  }
  if (controlId === 'sys.cli_tool.delete' || controlId === 'sys.cli_tool.test') {
    const toolId = readControlApprovalValue(approval, 'toolId', 'tool_id')
    return toolId ? `${title.toLowerCase()} ${toolId}` : title.toLowerCase()
  }

  return `run ${title}`
}

/**
 * SA-116 P4 (DL-116-13) — what the MODEL is told when a risky control pauses, in one place.
 *
 * Guidance and runtime are one contract, and this string is the runtime half. Before
 * SA-116 it taught `allowRisky: true`, which the gate now ignores — a model following it
 * loops against a wall, minting a fresh pending record on every retry. Two things make the
 * new text lane-aware rather than one flat sentence, and both were measured:
 *
 *  - **`api`**: the AI SDK paused the call BEFORE it ran, and the click re-executes that
 *    very call with the very same input — so on that path the model never sees a tool
 *    result at all. The only time a model READS this text on the API lane is when the gate
 *    paused a call the policy had let through (a transient resolver failure; F-P3-1 raises
 *    no card there). The text says so, rather than promise a button that is not there, and
 *    still says not to retry: the next attempt pauses at the policy and earns a real card.
 *  - **`cli`**: a managed Codex or Claude call has already been made by the time the gate
 *    answers, so there is nothing to un-pause. The click starts a resume turn carrying an
 *    approval message, and the model's own retry is what runs the control. Telling it "do
 *    not retry" there would strand the approval.
 *  - **`service`**: an n8n workflow, a raw-token script, or any caller with no chat message
 *    to pin a card to. There is no Approve button anywhere for this call. Saying "asked the
 *    user to approve it" was untrue (P2-EVIDENCE §6); the honest line names where a click
 *    is possible.
 *
 * `formatBatshitToolUseModelOutput` appends these under `approval_hint:`, and the gate's own
 * refusal message opens with the first line, so the two can never drift.
 */
export function buildControlApprovalPauseGuidance(options: {
  lane?: string | null
  controlTitle?: string | null
  approvalId?: string | null
}): string[] {
  const lane = typeof options.lane === 'string' ? options.lane.trim() : ''
  const title =
    typeof options.controlTitle === 'string' && options.controlTitle.trim().length > 0
      ? options.controlTitle.trim()
      : 'this action'
  const approvalId =
    typeof options.approvalId === 'string' && options.approvalId.trim().length > 0
      ? options.approvalId.trim()
      : ''
  const suffix = approvalId ? ` (approval ${approvalId})` : ''

  if (lane === 'service') {
    return [
      `Batshit paused "${title}" for the user's approval${suffix}, but this call has no chat to show an Approve button in.`,
      'Tell the user what it does and why, then stop.',
      'Never pass allowRisky — it is ignored.',
      'The user can approve it by asking for the same action in a normal chat with this agent, where Batshit shows the card.'
    ]
  }

  if (lane === 'cli') {
    return [
      `Batshit paused "${title}" for the user's approval${suffix}.`,
      'Tell the user what it does and why, then stop. Do not retry it in this turn.',
      'Never pass allowRisky — it is ignored.',
      'When the user clicks Approve you are resumed with an approval message; retry the same ref with the same input then. A different input earns a new approval card.'
    ]
  }

  return [
    `Batshit paused "${title}" for the user's approval${suffix}, but no Approve button could be shown for this call.`,
    'Tell the user what it does and why, then stop. Do not retry it yourself.',
    'Never pass allowRisky — it is ignored.',
    'If the user asks for it again, Batshit shows the Approve card and the click runs it.'
  ]
}

/** The word the risk badge shows (DL-116-11: one tier of click, the word says which). */
export function formatControlApprovalRiskWord(
  riskLevel: string | null | undefined
): 'Restricted' | 'Confirm' {
  return riskLevel === 'restricted' ? 'Restricted' : 'Confirm'
}

/**
 * Which mechanism answers this click — the Claude permission bridge, or send-routed.
 *
 * SA-116 P3: the ENTRY decides, and the summary is only the fallback. A message's summary
 * carries one coarse label, and a managed Claude turn overwrites it with `claude` the moment
 * any Bash approval appears. A Fabric control card in that same turn would then be answered
 * through the Claude permission bridge, which has never heard of it — the click would go
 * nowhere at all.
 */
export function resolveApprovalSubmitSource(
  approval: Record<string, any> | null | undefined,
  summarySource?: string | null
): string {
  const entrySource = typeof approval?.source === 'string' ? approval.source.trim() : ''
  if (entrySource) return entrySource
  return typeof summarySource === 'string' ? summarySource.trim() : ''
}
