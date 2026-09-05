import {
  getSubagentTypeDisplayLabel,
  normalizeSubagentType,
  type SubagentLike,
} from '$lib/utils/subagentType'

type RuntimePromptSubagent = SubagentLike & {
  displayName?: string | null
  name?: string | null
}

function resolveDisplayName(subagent?: RuntimePromptSubagent | null): string | null {
  const candidate = subagent?.displayName ?? subagent?.name ?? null
  return typeof candidate === 'string' && candidate.trim().length > 0
    ? candidate.trim()
    : null
}

function buildRuntimeSpecificLines(type: ReturnType<typeof normalizeSubagentType>): string[] {
  switch (type) {
    case 'n8n-subnode':
      return [
        'runtime: retired n8n Subnode Subagent record.',
        'tool_surface: unavailable. This record must be deleted from Agent Settings.',
        'limits: execution is not supported.',
      ]
    case 'n8n-workflow':
      return [
        'runtime: dedicated n8n workflow called by a Batshit-managed Primary Agent as a subagent tool.',
        'tool_surface: use this workflow\'s connected tools, including Batshit Subagent Tools when wired.',
        'limits: n8n AI Agent nodes default to 10 max iterations. Treat the 10th iteration as the danger line; keep model/tool loops to 9 or fewer and return progress before the node hits the limit.',
      ]
    case 'api':
      return [
        'runtime: Batshit direct API subagent runner.',
        'tool_surface: use only the API/native Batshit tools and Dynamic Tool Search/Use entries configured for this subagent and shown in your runtime context.',
        'limits: API subagent calls have bounded tool rounds, normally 10 for a single call. Avoid open-ended loops and return a clear blocker if the task needs another delegated call.',
      ]
    case 'cli':
      return [
        'runtime: Batshit-managed Codex or Claude CLI one-shot subagent run.',
        'tool_surface: use only the CLI-native tools and Batshit helper bridge available in this run.',
        'limits: CLI subagents are non-interactive one-shot calls. Approval or policy boundary hits fail instead of pausing for the user; report them clearly and keep work scoped to the delegated task.',
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
 * throwaway copy of; `lane` follows that specialist, or the parent for a general worker.
 */
export function buildWorkerRuntimePrompt(options: {
  lane: 'api' | 'cli'
  role?: string | null
  baseLabel?: string | null
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
    `runtime: Batshit ephemeral worker run on the ${options.lane === 'cli' ? 'managed CLI' : 'direct API'} lane, inheriting ${baseLabel ? "the named specialist's" : "the Primary Agent's"} model and tool scope.`,
    'tool_surface: use only the tools shown in your runtime context. Batshit control-plane (Fabric) actions, memory tools, subagents, and worker spawning are deliberately unavailable to you.',
    'memory: none. Nothing from an earlier run is loaded, and nothing you write here is stored for a later one.',
    'limits: one shot, no approval pauses, bounded tool rounds (normally 10), and a hard time limit. Return your result before you run out of room rather than stopping mid-thought.',
    'caller: a Batshit Primary Agent spawned you for this single task. Return your result to that Primary Agent.',
    'return: the finished answer for the delegated task plus the evidence behind it. If a tool or policy fails, say so plainly and do not describe it as completed.',
  ].join('\n')
}

export function buildSubagentRuntimePrompt(
  subagent?: RuntimePromptSubagent | null,
  explicitType?: unknown,
): string {
  const type = normalizeSubagentType(subagent, explicitType)
  const label = getSubagentTypeDisplayLabel(type)
  const displayName = resolveDisplayName(subagent)

  const lines = [
    '==== SUBAGENT RUNTIME CONTEXT ====',
    `type: ${type} (${label})`,
    ...(displayName ? [`name: ${displayName}`] : []),
    ...buildRuntimeSpecificLines(type),
    'caller: a Batshit Primary Agent delegated this task to you. Return your result to that Primary Agent.',
    'memory: subagent memory may persist within the current Batshit session. Use it for continuity when relevant, but the current task and latest instructions win.',
    'scope: use only this subagent\'s configured tools and context. Do not assume nested subagents or the Primary Agent\'s full Tool Grid.',
    'return: match the delegated task, your subagent prompt, and the conversation style. Roleplay or friendly conversational answers are fine when that is the point; normal work should return clear results, useful evidence, blockers, and any recommended next action. If a tool or policy fails, say so and do not describe it as completed.',
  ]

  return lines.join('\n')
}
