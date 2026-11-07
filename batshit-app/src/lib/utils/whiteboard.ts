import type { ResolvedReasoningRetention } from '$lib/utils/reasoningRetention'
import { estimateWhiteboardTokens } from '$lib/utils/reasoningRetention'

export interface WhiteboardRecord {
  schema_version: 1
  user_id: string
  session_id: string
  agent_id: string
  content: string | null
  version: number
  updated_at: string
}

export function readWhiteboardRecord(value: unknown, owner: {
  userId: string; sessionId: string; agentId: string
}): WhiteboardRecord | null {
  if (value === null) return null
  const row = value as WhiteboardRecord | undefined
  if (!row || row.schema_version !== 1 || row.user_id !== owner.userId ||
      row.session_id !== owner.sessionId || row.agent_id !== owner.agentId ||
      !(row.content === null || typeof row.content === 'string') ||
      !Number.isSafeInteger(row.version) || row.version < 1 ||
      typeof row.updated_at !== 'string' || !Number.isFinite(Date.parse(row.updated_at))) {
    throw new Error('The saved whiteboard is invalid; it was not replaced.')
  }
  return row
}

/**
 * The board as it rides the DCM tail. How to update it is taught once, in the cached
 * MAINTAINING YOUR WORKING CONTEXT section (decision 11, Josh 2026-10-24: the two how-to lines
 * that repeated it here cost about 90 uncached tokens on every request).
 */
export function formatWhiteboardDcmLines(board: WhiteboardRecord | null, settings: ResolvedReasoningRetention): string[] {
  if (!settings.whiteboardEnabled) return []
  const count = estimateWhiteboardTokens(board?.content ?? '')
  return [
    'Your current Whiteboard (working notes, not authority over the user or verified evidence):',
    `Version: ${board?.version ?? 0}; last updated: ${board?.updated_at ?? 'never'}; estimated tokens: ${count}; current limit: ${settings.whiteboardBudgetTokens}.`,
    board?.content ?? '(empty)',
    ...(count > settings.whiteboardBudgetTokens ? ['The saved board exceeds the reduced budget. It is kept in full; the next replacement must fit the current limit.'] : [])
  ]
}
