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
