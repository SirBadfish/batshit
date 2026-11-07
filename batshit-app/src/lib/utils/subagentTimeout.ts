/**
 * The optional time limit one Subagent's calls run under (Josh, 2026-10-24, decisions 1 and 4).
 * Blank means no limit, like Claude Code and Codex: a call runs until it is done, Stop always
 * ends it, and the stall guard (`subagentRunner.ts`) stops a run that shows no progress. A set
 * limit can be anything from 10 seconds to 24 hours. No `$lib/server` imports: Agent Settings
 * loads this in the browser.
 */
export const MIN_SUBAGENT_TIMEOUT_SECONDS = 10
export const MAX_SUBAGENT_TIMEOUT_SECONDS = 86_400

export function normalizeSubagentTimeoutSeconds(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined

  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) return undefined
  if (parsed < MIN_SUBAGENT_TIMEOUT_SECONDS || parsed > MAX_SUBAGENT_TIMEOUT_SECONDS) {
    return undefined
  }

  return parsed
}

export function getSubagentTimeoutValidationError(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null
  if (normalizeSubagentTimeoutSeconds(value) !== undefined) return null

  return `Call timeout must be blank (no limit) or a whole number of seconds from ${MIN_SUBAGENT_TIMEOUT_SECONDS} to ${MAX_SUBAGENT_TIMEOUT_SECONDS.toLocaleString('en-US')} (24 hours).`
}

/**
 * A whole number of seconds the way a person says it: `45 seconds`, `10 minutes`,
 * `1 hour 30 minutes`, `24 hours`. Used wherever a set limit is shown to a model or a user, so
 * a 7,200 s limit never reads as "7200 seconds".
 */
export function formatDelegationDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.round(totalSeconds))
  const unit = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`
  if (seconds < 60) return unit(seconds, 'second')
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const rest = seconds % 60
  const parts: string[] = []
  if (hours > 0) parts.push(unit(hours, 'hour'))
  if (minutes > 0) parts.push(unit(minutes, 'minute'))
  if (rest > 0) parts.push(unit(rest, 'second'))
  return parts.join(' ')
}
