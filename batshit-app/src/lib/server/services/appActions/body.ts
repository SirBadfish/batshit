import { refuse } from '../../../appActions/catalog'
import { APP_ACTION_MAX_BYTES } from '../../../appActions/protocol'

/** Let an already-finished upload reach EOF before cancellation destroys its Node socket. */
async function refuseLargeBody(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<never> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  let ended = false
  try {
    // One terminal read only: do not drain a continuing or indefinitely stalled upload.
    ended = await Promise.race([
      reader.read().then(part => part.done === true, () => false),
      new Promise<boolean>(resolve => { timeout = setTimeout(() => resolve(false), 250) })
    ])
  } finally { if (timeout !== undefined) clearTimeout(timeout) }
  if (!ended) await reader.cancel()
  refuse('payload_too_large')
}

/** Bound actual streamed UTF-8 bytes, not an untrusted Content-Length header. */
export async function readAppActionBody(request: Request): Promise<unknown> {
  const reader = request.body?.getReader()
  if (!reader) refuse('invalid_request')
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    for (;;) {
      const part = await reader.read()
      if (part.done) break
      length += part.value.byteLength
      if (length > APP_ACTION_MAX_BYTES) return await refuseLargeBody(reader)
      chunks.push(part.value)
    }
  } finally { reader.releaseLock() }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }
  catch { refuse('invalid_request') }
}
