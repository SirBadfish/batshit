import type { AgentReasoningOverrides } from '$lib/types/reasoningControls'

// The existing Settings read-counter pattern, scoped to the new independently saved leaves.
const generations = new Map<string, number>()
const leaves = new Map<string, Map<string, number>>()
export const agentReasoningReadGeneration = (agentId: string): number => generations.get(agentId) ?? 0
export const captureAgentReasoningReads = (): Map<string, number> => new Map(generations)

export function markAgentReasoningLeafChanged(agentId: string, key: string): void {
  const generation = agentReasoningReadGeneration(agentId) + 1
  generations.set(agentId, generation)
  let changed = leaves.get(agentId)
  if (!changed) { changed = new Map(); leaves.set(agentId, changed) }
  changed.set(key, generation)
}

/** A read predating a request or its acknowledgment cannot take that leaf back. */
export function preserveNewerReasoningLeaves(agentId: string, read: AgentReasoningOverrides | undefined,
  current: AgentReasoningOverrides | undefined, readGeneration: number): AgentReasoningOverrides | undefined {
  const newer = [...(leaves.get(agentId) ?? [])].filter(([, generation]) => generation > readGeneration)
  if (!newer.length) return read
  const merged = { ...read }
  for (const [key] of newer) {
    if (current?.[key] === undefined) delete merged[key]
    else merged[key] = current[key]
  }
  return Object.keys(merged).length ? merged : undefined
}
