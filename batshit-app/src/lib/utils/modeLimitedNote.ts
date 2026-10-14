import { CODEX_SANDBOX_LABELS, sanitizeCodexSandbox } from '$lib/utils/codexRunAccess'

/**
 * BL-941: the reply's note when the agent's record made a Codex or Claude run tighter than the
 * mode its send carried (`metadata.modeLimitedByAgentSettings`, saved by send-routed at every way
 * a reply ends). The words are the chat bar's names for the modes, since the sent mode came from a
 * chat bar (this agent's, or the sender's in a group chat).
 */

const CODEX_MODE_WORDS: Record<string, string> = {
  chat: 'Chat',
  agent: 'Agent',
  agent_full: 'Agent (full access)'
}

const CLAUDE_MODE_WORDS: Record<string, string> = {
  plan: 'Plan',
  default: 'Ask before edits',
  acceptEdits: 'Edit automatically',
  bypassPermissions: 'Bypass permissions'
}

export function modeLimitedNoteText(note: unknown): string | null {
  if (!note || typeof note !== 'object' || Array.isArray(note)) return null
  const record = note as Record<string, unknown>
  const program = typeof record.program === 'string' && record.program.trim() ? record.program.trim() : null
  const words = program === 'Codex' ? CODEX_MODE_WORDS : program === 'Claude Code' ? CLAUDE_MODE_WORDS : null
  if (!program || !words) return null
  const wordFor = (mode: unknown) =>
    typeof mode === 'string' && Object.hasOwn(words, mode) ? words[mode] : undefined
  const ran = wordFor(record.ranMode)
  const sent = wordFor(record.sentMode)
  if (!ran || !sent) return null
  const sandbox = program === 'Codex' ? sanitizeCodexSandbox(record.sandbox) : undefined
  const ranWords = sandbox ? `${ran}, ${CODEX_SANDBOX_LABELS[sandbox]},` : ran
  return `${program} ran as ${ranWords} because Agent Settings holds that for this agent; the chat bar sent ${sent}.`
}
