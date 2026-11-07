/**
 * The optional tool-step limit one Subagent's calls run under (Josh, 2026-10-24, decision 3),
 * like Claude Code's per-agent `maxTurns`. Blank means no limit. A step is one tool call the
 * run makes, the unit every lane can count the same way (an API run's tool calls, a Claude
 * CLI run's finished tool calls). At the limit Batshit stops the run and returns its
 * work so far marked `partial` (`subagentRunner.ts`). No `$lib/server` imports: Agent Settings
 * loads this in the browser.
 */
export const MIN_SUBAGENT_MAX_TOOL_STEPS = 1
export const MAX_SUBAGENT_MAX_TOOL_STEPS = 10_000

export function normalizeSubagentMaxToolSteps(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined

  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) return undefined
  if (parsed < MIN_SUBAGENT_MAX_TOOL_STEPS || parsed > MAX_SUBAGENT_MAX_TOOL_STEPS) {
    return undefined
  }

  return parsed
}

export function getSubagentMaxToolStepsValidationError(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null
  if (normalizeSubagentMaxToolSteps(value) !== undefined) return null

  return `Max tool steps must be blank (no limit) or a whole number from ${MIN_SUBAGENT_MAX_TOOL_STEPS} to ${MAX_SUBAGENT_MAX_TOOL_STEPS.toLocaleString('en-US')}.`
}
