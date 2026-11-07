import {
  isRetiredSubagentType,
  normalizeSubagentType,
  retiredSubagentTypeSentences,
  type SubagentLike,
  type SubagentType,
} from '$lib/utils/subagentType'
import { formatDelegationDuration, normalizeSubagentTimeoutSeconds } from '$lib/utils/subagentTimeout'
import { normalizeSubagentMaxToolSteps } from '$lib/utils/subagentToolSteps'

type RuntimePromptSubagent = SubagentLike & {
  displayName?: string | null
  name?: string | null
  timeout_seconds?: unknown
  max_tool_steps?: unknown
}

/**
 * Delegation limits (Josh, 2026-10-24). The run's own limits as its runtime block states them:
 * none unless its Subagent sets one, and the stall guard (`DELEGATED_RUN_STALL_MS` in
 * `delegatedRunWatch.ts`, 10 minutes; restated here because this module is browser-safe). Only
 * values the record actually sets are named, so the text is stable for a given record.
 */
const STALL_GUARD_SENTENCE =
  'Batshit stops a run that shows no progress for 10 minutes; a tool call that is still running counts as progress.'

function describeDelegationLimits(
  record: { timeout_seconds?: unknown; max_tool_steps?: unknown } | null | undefined,
): string {
  const timeoutSeconds = normalizeSubagentTimeoutSeconds(record?.timeout_seconds)
  const maxToolSteps = normalizeSubagentMaxToolSteps(record?.max_tool_steps)
  const time =
    timeoutSeconds !== undefined
      ? `a time limit of ${formatDelegationDuration(timeoutSeconds)} (return your result before it)`
      : 'no time limit'
  const steps =
    maxToolSteps !== undefined
      ? `a limit of ${maxToolSteps} tool step${maxToolSteps === 1 ? '' : 's'}, one per tool call (at the limit Batshit stops you and returns your work so far, marked partial)`
      : 'no tool-step limit'
  return `${time} and ${steps}. ${STALL_GUARD_SENTENCE}`
}

function resolveDisplayName(subagent?: RuntimePromptSubagent | null): string | null {
  const candidate = subagent?.displayName ?? subagent?.name ?? null
  return typeof candidate === 'string' && candidate.trim().length > 0
    ? candidate.trim()
    : null
}

function buildRuntimeSpecificLines(
  type: SubagentType,
  subagent?: RuntimePromptSubagent | null,
): string[] {
  switch (type) {
    case 'api':
      return [
        'runtime: Batshit direct subagent runner.',
        'tool_surface: use only the native Batshit tools and Dynamic Tool Search/Use entries configured for this subagent and shown in your runtime context.',
        `limits: this call has ${describeDelegationLimits(subagent)} Avoid open-ended loops and return a clear blocker if the task needs another delegated call.`,
      ]
    default:
      return []
  }
}

/**
 * SA-111 P4 (DL-111-10) — the worker case. A Worker is not a subagent: it is ephemeral,
 * memory-less, and cannot be steered mid-run, so it gets its OWN runtime block rather than
 * the subagent one. The base system prompt is `batshit:worker_prompt` for the same reason
 * (the subagent base prompt tells its reader that subagent memory persists, which is false
 * for a worker) — that was the judgment call DL-111-10 left to this packet.
 *
 * `baseLabel` is set only for a `base` clone, so the run knows which specialist it is a
 * throwaway copy of. A Worker runs on its parent's or its base Subagent's connection (SA-139 R5 removed the
 * CLI lane; P7 took the lane out of the runtime line).
 */
export function buildWorkerRuntimePrompt(options: {
  lane: 'api'
  role?: string | null
  baseLabel?: string | null
  /**
   * Delegation limits: the record the worker runs as. A built-in worker's record sets none (its
   * Primary has none to give); a `base` clone's carries its Subagent's time and step limits.
   */
  limits?: { timeout_seconds?: unknown; max_tool_steps?: unknown } | null
}): string {
  const role = typeof options.role === 'string' ? options.role.trim() : ''
  const baseLabel = typeof options.baseLabel === 'string' ? options.baseLabel.trim() : ''

  return [
    '==== WORKER RUNTIME CONTEXT ====',
    'type: worker (Worker)',
    ...(role ? [`role: ${role}`] : []),
    ...(baseLabel
      ? [
          `based_on: ${baseLabel}. You are a throwaway copy of that subagent — same prompt, model, tools, and skills, but no memory of its past calls.`,
        ]
      : []),
    `runtime: Batshit ephemeral worker run, inheriting ${baseLabel ? "the named specialist's" : "the Primary Agent's"} model and tool scope.`,
    'tool_surface: use only the tools shown in your runtime context. Batshit control-plane (Fabric) actions, memory tools, subagents, and worker spawning are deliberately unavailable to you.',
    'memory: none. Nothing from an earlier run is loaded, and nothing you write here is stored for a later one.',
    `limits: one shot with no approval pauses. This run has ${describeDelegationLimits(options.limits)} Return your result when the task is done rather than stopping mid-thought.`,
    'caller: a Batshit Primary Agent spawned you for this single task. Return your result to that Primary Agent.',
    'return: the finished answer for the delegated task plus the evidence behind it. If a tool or policy fails, say so plainly and do not describe it as completed.',
  ].join('\n')
}

export function buildSubagentRuntimePrompt(
  subagent?: RuntimePromptSubagent | null,
  explicitType?: unknown,
): string {
  const type = normalizeSubagentType(subagent, explicitType)
  const displayName = resolveDisplayName(subagent)
  // SA-139 R2/R5 (D14): the runner refuses a removed type before any prompt is built.
  if (isRetiredSubagentType(type)) throw new Error(retiredSubagentTypeSentences(type, { ...subagent, displayName }).details)

  const lines = [
    '==== SUBAGENT RUNTIME CONTEXT ====',
    ...(displayName ? [`name: ${displayName}`] : []),
    ...buildRuntimeSpecificLines(type, subagent),
    'caller: a Batshit Primary Agent delegated this task to you. Return your result to that Primary Agent.',
    'memory: subagent memory may persist within the current Batshit session. Use it for continuity when relevant, but the current task and latest instructions win.',
    'scope: use only this subagent\'s configured tools and context. Do not assume nested subagents or the Primary Agent\'s full Tool Grid.',
    'return: match the delegated task, your subagent prompt, and the conversation style. Roleplay or friendly conversational answers are fine when that is the point; normal work should return clear results, useful evidence, blockers, and any recommended next action. If a tool or policy fails, say so and do not describe it as completed.',
  ]

  return lines.join('\n')
}
