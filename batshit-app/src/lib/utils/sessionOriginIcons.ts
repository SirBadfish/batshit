import { Clock, Mail, Sparkles, Webhook } from '@lucide/svelte'
import type { SessionOrigin, SessionOriginKind } from '$lib/utils/sessionOrigin'

/**
 * SA-115 P2 (DL-115-09) — THE icon for a session origin, keyed by kind.
 *
 * Two surfaces show this pill: the sidebar row (`SessionItem.svelte`) and the chat banner
 * (`routes/+page.svelte`). Both used to read `if (kind === 'dm') Mail else Webhook`, so
 * adding a third origin kind shipped a **webhook icon for every schedule** without
 * touching either file and without failing anything — the exact drift Part 2.4 of the
 * story flagged before P1 was written.
 *
 * A lookup cannot do that, and one shared lookup means a fourth kind is one line here
 * rather than two edits that can disagree. An unknown kind gets the neutral `Sparkles`:
 * "something started this chat" is honest, where a confident wrong icon is not.
 *
 * `sessionOrigin.ts` stays free of component imports; this is the one module that pairs
 * the kinds with pictures.
 */
const SESSION_ORIGIN_ICONS: Record<SessionOriginKind, typeof Mail> = {
  dm: Mail,
  webhook: Webhook,
  schedule: Clock
}

export function sessionOriginIcon(origin: Pick<SessionOrigin, 'kind'>): typeof Mail {
  return SESSION_ORIGIN_ICONS[origin.kind] ?? Sparkles
}
