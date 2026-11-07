import type { ReasoningControlSelection } from '$lib/types/reasoningControls'
import { applyReasoningOverridesPatch, isReasoningSelection, validateReasoningOverridesPatch } from '$lib/utils/modelReasoningControls'
import { sameJsonValue } from '$lib/utils/agentBlockFieldSettings'
import { markAgentReasoningLeafChanged } from '$lib/utils/agentReasoningReadGuard'
import { createPendingSaves } from '$lib/utils/pendingSaves'
import * as agents from './agents.svelte'

interface ReasoningSaveState {
  selection: ReasoningControlSelection | null
  pending: boolean
  error: string | null
  generation: number
}
let states = $state<Record<string, ReasoningSaveState>>({})
const tails = new Map<string, Promise<void>>()
const pending = new Map<string, ReturnType<typeof createPendingSaves>>()
const failed = new Set<string>()
const stateKey = (agentId: string, key: string) => JSON.stringify([agentId, key])

function trackPending(agentId: string, task: Promise<void>) {
  let owner = pending.get(agentId)
  if (!owner) { owner = createPendingSaves(); pending.set(agentId, owner) }
  owner.track(task)
  const tracked = owner
  const settled = () => { if (tracked.size === 0 && pending.get(agentId) === tracked) pending.delete(agentId) }
  task.then(settled, settled)
}

/** Shared by mounted chat and Settings; navigation never transfers ownership of a late save. */
export function getAgentReasoningSave(agentId: string, key: string): ReasoningSaveState | undefined {
  return states[stateKey(agentId, key)]
}

export function saveAgentReasoningControl(agentId: string, key: string, selection: ReasoningControlSelection | null): Promise<void> {
  const patch = { [key]: selection }
  const invalid = validateReasoningOverridesPatch(patch)
  if (invalid) return Promise.reject(new Error(invalid))
  const id = stateKey(agentId, key)
  const generation = (states[id]?.generation ?? 0) + 1
  markAgentReasoningLeafChanged(agentId, key)
  states[id] = { selection, generation, pending: true, error: null }
  const task = (tails.get(id) ?? Promise.resolve()).catch(() => {}).then(async () => {
    try {
      if (failed.has(id)) {
        // A deliberate new choice reconciles a failed/unknown outcome first. It never
        // replaces a still-pending request; the per-leaf tail above owns that flight.
        const read = await fetch(`/api/agents/${agentId}`)
        const record = await read.json().catch(() => null)
        if (!read.ok || record?.id !== agentId) throw new Error('Could not confirm the previous reasoning save. Try again after the connection recovers.')
        const actual = record.model_reasoning_overrides?.[key] ?? null
        if (actual !== null && !isReasoningSelection(actual)) throw new Error('The saved reasoning setting is invalid. Reload Settings before trying again.')
        const agent = agents.getAgentById(agentId)
        if (agent) agents.updateAgent(agentId, { model_reasoning_overrides: applyReasoningOverridesPatch(agent.model_reasoning_overrides, { [key]: actual }) })
      }
      const response = await fetch(`/api/agents/${agentId}`, { method: 'PUT',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model_reasoning_overrides: patch }) })
      const body = await response.json().catch(() => null)
      if (!response.ok) throw new Error(body?.error || 'Could not save the reasoning setting.')
      const acknowledgment = body?.model_reasoning_override
      if (body?.success !== true || acknowledgment?.key !== key ||
        acknowledgment.selection !== null && !isReasoningSelection(acknowledgment.selection) ||
        !sameJsonValue(acknowledgment?.selection, selection)) {
        throw new Error('The reasoning save could not be confirmed. Choose the setting again before sending.')
      }
      const agent = agents.getAgentById(agentId)
      markAgentReasoningLeafChanged(agentId, key)
      if (agent) agents.updateAgent(agentId, {
        model_reasoning_overrides: applyReasoningOverridesPatch(agent.model_reasoning_overrides, { [key]: acknowledgment.selection })
      })
      failed.delete(id)
      if (states[id]?.generation === generation) delete states[id]
    } catch (error) {
      failed.add(id)
      const message = error instanceof Error && error.name !== 'TimeoutError' && error.name !== 'AbortError'
        ? error.message : 'The reasoning save outcome is unknown. Choose the setting again before sending.'
      if (states[id]?.generation === generation) states[id] = { selection, generation, pending: false, error: message }
      throw error
    }
  })
  tails.set(id, task)
  trackPending(agentId, task)
  const settled = () => {
    if (tails.get(id) === task) tails.delete(id)
  }
  task.then(settled, settled)
  return task
}

/** Wait for this agent's writes, including writes from another mounted surface. No polling. */
export async function waitForAgentReasoningSaves(agentId: string, limitMs = 10_000): Promise<void> {
  const deadline = Date.now() + limitMs
  while (pending.has(agentId)) {
    const owner = pending.get(agentId)!
    if (!(await owner.settled(Math.max(0, deadline - Date.now())))) {
      throw new Error('Your reasoning setting is still saving. Wait for it to finish before sending.')
    }
    if (pending.get(agentId) === owner && owner.size === 0) return
  }
}

/** An inactive model's failed save cannot block a different model or another agent. */
export function assertAgentReasoningSaveAcknowledged(agentId: string, key: string): void {
  const state = getAgentReasoningSave(agentId, key)
  if (state?.pending || state?.error) throw new Error(state.error || 'Your reasoning setting is still saving.')
}
