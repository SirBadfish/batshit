import { json, type RequestHandler } from '@sveltejs/kit'
import { resolveNativeToolUser } from '$lib/server/services/nativeToolAuth'
import { resolveToolTextBudget } from '$lib/server/services/toolTextBudget'
import { guardToolModelText } from '$lib/server/services/toolModelResultGuard'
import { TOOL_MODEL_RAW_MAX_CHARS } from '$lib/utils/toolModelTextSizeGuard'

// JSON may escape one UTF-16 character as six ASCII bytes (for example an unpaired surrogate).
// Leave room for the bounded tool name and the two metadata fields; unknown fields share it.
const MAX_GUARD_BODY_BYTES = TOOL_MODEL_RAW_MAX_CHARS * 6 + 4_096

async function readBoundedGuardBody(request: Request): Promise<{ body: any } | { status: 400 | 413 }> {
  const declaredBytes = Number(request.headers.get('content-length'))
  if (Number.isFinite(declaredBytes) && declaredBytes > MAX_GUARD_BODY_BYTES) return { status: 413 }
  if (!request.body) return { status: 400 }
  const reader = request.body.getReader()
  const chunks: Buffer[] = []
  let bytes = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > MAX_GUARD_BODY_BYTES) {
        await reader.cancel().catch(() => {})
        return { status: 413 }
      }
      chunks.push(Buffer.from(value))
    }
    return { body: JSON.parse(Buffer.concat(chunks, bytes).toString('utf8')) }
  } catch {
    return { status: 400 }
  } finally {
    reader.releaseLock()
  }
}

/** Final helper text only. Identity and tool permissions belong to the minted run. */
export const POST: RequestHandler = async ({ request }) => {
  const auth = await resolveNativeToolUser({ request })
  if (!auth || auth.auth !== 'agent' || !auth.sessionId || !auth.messageId || !auth.agentId) {
    return json({ success: false, error: 'A live model run with a chat and reply is required.' }, { status: 403 })
  }
  const parsed = await readBoundedGuardBody(request)
  if ('status' in parsed) {
    return json({ success: false, error: parsed.status === 413 ? 'Final tool text exceeds the transfer limit.' : 'Invalid final tool text.' }, { status: parsed.status })
  }
  const body = parsed.body
  if (!body || typeof body.text !== 'string') {
    return json({ success: false, error: 'Final tool text is required.' }, { status: 400 })
  }
  if (body.text.length > TOOL_MODEL_RAW_MAX_CHARS) {
    return json({ success: false, error: 'Final tool text exceeds the transfer limit.' }, { status: 413 })
  }
  if (!Number.isSafeInteger(body.originalTextChars) || body.originalTextChars < body.text.length) {
    return json({ success: false, error: 'Original tool text length is missing or invalid.' }, { status: 400 })
  }
  // No spread from JSON: even a supplied zip id, actor, message, or scope is inert.
  const toolName = typeof body.toolName === 'string' ? body.toolName.slice(0, 256) : undefined
  try {
    const text = await guardToolModelText(body.text, {
      userId: auth.userId, sessionId: auth.sessionId, messageId: auth.messageId,
      agentId: auth.agentId, fetchZipAllowed: auth.fetchZipAllowed === true, toolName,
      originalTextChars: body.originalTextChars, modelTextBudget: resolveToolTextBudget(auth)
    })
    return json({ success: true, text })
  } catch (error) {
    console.error('[Tool result guard] Retention failed.', error)
    return json({ success: false, error: 'The oversized tool result could not be kept. Run the tool again for a smaller part.' }, { status: 500 })
  }
}
