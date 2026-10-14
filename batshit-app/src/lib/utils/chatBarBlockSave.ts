import {
  diffAgentBlock,
  type AgentBlockSaveByField,
  type AgentFieldByFieldBlock
} from '$lib/utils/agentBlockFieldSettings'

/**
 * BL-848: what a chat-bar control sends for `codex_settings` or `claude_settings`. The control
 * reads the store's copy of the block through its own defaults (`viewed`: what it shows) and builds
 * `next`, that block with its change (and whatever its defaults imply for that change). Only the
 * keys where they differ go out, so a control never carries the other keys of a copy that may be
 * older than the record (another window saved since), and never a default the copy did not hold.
 *
 * `group` names the keys the control itself sets: one choice, whatever number of keys it takes (a
 * Codex mode is a mode, a sandbox and an approval). They are ALWAYS sent, with the values of
 * `next` (a key `next` leaves out is sent as `null`, a removal), even where they equal the copy:
 * the copy may be older than the record, and a pick the copy already shows must still write the
 * whole choice, or the record ends up holding a mix of this pick and another window's (a Codex
 * sandbox and approval from another mode). Only keys outside the group are sent by difference.
 *
 * The store copy has no block at all (`stored` is null or missing): the control creates it, and the
 * whole `next` goes out. `{}` (a control with no group, and nothing changed) has no block to send:
 * the caller sends the rest of its save, or nothing.
 */
export function chatBarBlockSave<Field extends AgentFieldByFieldBlock>(
  field: Field,
  stored: unknown,
  viewed: unknown,
  next: unknown,
  options: { group?: readonly string[] } = {}
): { [Key in Field]?: NonNullable<AgentBlockSaveByField[Field]> | null } {
  type Save = { [Key in Field]?: NonNullable<AgentBlockSaveByField[Field]> | null }
  const creates = stored === null || stored === undefined
  const change = diffAgentBlock(field, creates ? null : viewed, next)
  if (change === null) return { [field]: null } as Save
  const group = creates ? [] : (options.group ?? [])
  if (group.length === 0) return (change === undefined ? {} : { [field]: change }) as Save

  const nextBlock = (next ?? {}) as Record<string, unknown>
  const merged: Record<string, unknown> = { ...(change ?? {}) }
  for (const key of group) merged[key] = nextBlock[key] ?? null
  return { [field]: merged } as Save
}
