import { Clock, Mail, Sparkles, Webhook } from '@lucide/svelte'
import type { DmSender } from '$lib/types/dm'

/**
 * PR #106 review F-13 — THE icon for a DM's sender, keyed by kind (the `sessionOriginIcons`
 * shape). An unknown kind gets the neutral `Sparkles` rather than a confident wrong picture.
 */
const DM_SENDER_ICONS: Record<DmSender['kind'], typeof Mail> = {
  agent: Mail,
  webhook: Webhook,
  schedule: Clock
}

export function dmSenderIcon(from: Pick<DmSender, 'kind'>): typeof Mail {
  return DM_SENDER_ICONS[from.kind] ?? Sparkles
}
