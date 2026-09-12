import type { DmSender } from '$lib/types/dm'

/**
 * PR #106 review F-13 — THE label for a DM's sender, keyed by kind.
 *
 * The inbox drawer used a two-way ternary over a three-member union: anything that was not
 * an agent read "<name> (webhook)", so every schedule-sent DM was a webhook in the drawer
 * and in its `aria-label`. TypeScript cannot catch the falsy arm of a ternary, and `name`
 * exists on every variant. A lookup keyed on the kind is a compile error for a fourth kind
 * — the same shape `sessionOrigin.ts` and `sessionOriginIcons.ts` were converted to.
 */
const DM_SENDER_LABELS: Record<DmSender['kind'], (from: DmSender) => string> = {
  agent: (from) => (from.kind === 'agent' ? from.name || from.agentId : from.name),
  webhook: (from) => `${from.name} (webhook)`,
  schedule: (from) => `${from.name} (schedule)`
}

export function dmSenderLabel(from: DmSender): string {
  const label = DM_SENDER_LABELS[from.kind]
  return label ? label(from) : from.name
}
