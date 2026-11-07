/**
 * BL-941: the reply's note when the agent's record made a Claude run tighter than the
 * mode its send carried (`metadata.modeLimitedByAgentSettings`, saved by send-routed at every way
 * a reply ends). The words are the chat bar's names for the modes, since the sent mode came from a
 * chat bar (this agent's, or the sender's in a group chat).
 */

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
  const words = program === 'Claude Code' ? CLAUDE_MODE_WORDS : null
  if (!program || !words) return null
  const wordFor = (mode: unknown) =>
    typeof mode === 'string' && Object.hasOwn(words, mode) ? words[mode] : undefined
  const ran = wordFor(record.ranMode)
  const sent = wordFor(record.sentMode)
  if (!ran || !sent) return null
  return `${program} ran as ${ran} because Agent Settings holds that for this agent; the chat bar sent ${sent}.`
}
