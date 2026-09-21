import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { apiError } from '$lib/server/services/apiResponses'
import { requireUser } from '$lib/server/services/routeSecurity'
import { getDm } from '$lib/server/services/dm/dmStore'
import type { DmRecord } from '$lib/types/dm'
import { readUntrustedTextScreen, type UntrustedTextScreenView, type WakeOrigin } from '$lib/utils/jevJuice'

/**
 * SA-120 P7 — a chat page's short read of some DMs, keyed by DM id: who wrote each one (the
 * origin line on an approval card in a woken turn), its subject and the start of its body (the
 * quote on the Jev Juice notice card), and what the incoming-text screen said about it, if
 * anything may be drawn.
 *
 * READ ONLY, and deliberately the BROWSER's read. The notice card and the origin line are put
 * together in the page from this route; the risk gate (`decideRiskGate`, `executeCliTool`)
 * never sees a screen and nothing here can reach it (DL-120-12).
 *
 * `screen` is a flag, the note that the screen could not run, or `null`. "No flag" and "never
 * screened" are the same `null`, so no caller can turn a missing flag into "clean". A DM that
 * does not exist or that another user owns is absent.
 */
const DM_ID_PATTERN = /^dm_[A-Za-z0-9_]{1,64}$/
const MAX_DM_IDS = 50
const SNIPPET_CHARS = 240

export interface DmBrief {
  from: WakeOrigin
  subject: string
  snippet: string
  screen: UntrustedTextScreenView | null
}

function originOf(record: DmRecord): WakeOrigin {
  const from = record.from as { kind?: unknown; name?: unknown } | undefined
  const kind = from?.kind === 'webhook' || from?.kind === 'schedule' ? from.kind : 'agent'
  const name = typeof from?.name === 'string' ? from.name : ''
  return { kind, name }
}

function snippetOf(body: unknown): string {
  const text = typeof body === 'string' ? body.replace(/\s+/g, ' ').trim() : ''
  return text.length <= SNIPPET_CHARS ? text : `${text.slice(0, SNIPPET_CHARS - 1).trimEnd()}…`
}

function briefOf(record: DmRecord): DmBrief {
  return {
    from: originOf(record),
    subject: typeof record.subject === 'string' ? record.subject : '',
    snippet: snippetOf(record.body),
    screen: readUntrustedTextScreen(record.screen)
  }
}

export const GET: RequestHandler = async ({ url, locals }) => {
  const user = requireUser(locals)
  if (!user.ok) return user.response

  const ids = Array.from(
    new Set(
      (url.searchParams.get('ids') ?? '')
        .split(',')
        .map((id) => id.trim())
        .filter((id) => DM_ID_PATTERN.test(id))
    )
  ).slice(0, MAX_DM_IDS)

  try {
    const briefs: Record<string, DmBrief> = {}
    for (const dmId of ids) {
      const record = await getDm(dmId)
      if (!record || record.userId !== user.value.id) continue
      briefs[dmId] = briefOf(record)
    }
    return json({ briefs })
  } catch (error) {
    console.error('[Agent DMs] Failed to read DM briefs:', error)
    return apiError('Failed to read DM briefs.', 500)
  }
}
