/**
 * SA-104 P3 — inline `<batshit-memory>` save processing (DL-104-05 hot path).
 *
 * The single finalize path in `+page.svelte` extracts memory blocks from the finished
 * assistant message (all three primary-agent types finalize there) and POSTs the parsed
 * payloads here. Each payload runs through the SAME ops layer as the `sys.memory.save`
 * Fabric control, so inline saves and tool saves produce identical records. Per-block
 * failures come back loudly and land in `metadata.controlErrors`; successes land in
 * `metadata.memorySaves`.
 */

import { json, type RequestHandler } from '@sveltejs/kit'
import { redis } from '$lib/server/redis'
import { processInlineMemorySaves } from '$lib/server/services/memory/memoryTools'

const MAX_INLINE_SAVE_BLOCKS = 12

type InlineSavesRequest = {
  sessionId?: string
  messageId?: string
  agentId?: string
  payloads?: unknown[]
}

export const POST: RequestHandler = async ({ locals, request }) => {
  if (!locals.user?.id) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: InlineSavesRequest
  try {
    body = (await request.json()) as InlineSavesRequest
  } catch {
    return json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
  const agentId = typeof body.agentId === 'string' ? body.agentId.trim() : ''
  const messageId = typeof body.messageId === 'string' ? body.messageId.trim() : ''
  const payloads = Array.isArray(body.payloads) ? body.payloads : []

  if (!sessionId || !agentId) {
    return json({ error: 'sessionId and agentId are required' }, { status: 400 })
  }
  if (payloads.length === 0) {
    return json({ error: 'payloads must contain at least one memory save payload' }, { status: 400 })
  }
  if (payloads.length > MAX_INLINE_SAVE_BLOCKS) {
    return json(
      { error: `At most ${MAX_INLINE_SAVE_BLOCKS} memory save blocks are processed per message.` },
      { status: 400 }
    )
  }

  const session = await redis.getSession(sessionId).catch(() => null)
  if (!session || (typeof session.user_id === 'string' && session.user_id !== locals.user.id)) {
    return json({ error: 'Session not found for this user' }, { status: 404 })
  }

  try {
    const results = await processInlineMemorySaves({
      userId: locals.user.id,
      agentId,
      sessionId,
      messageId: messageId || null,
      payloads
    })
    return json({ results })
  } catch (error) {
    console.error('[Memory Inline Saves] Processing failed:', error)
    return json(
      { error: error instanceof Error ? error.message : 'Memory save processing failed' },
      { status: 500 }
    )
  }
}
