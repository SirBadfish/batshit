/** Read a provider's JSON response without allowing an unbounded audio envelope. */
export async function readBoundedSpeechJson(response: Response, limit: number): Promise<unknown> {
  if (!response.body) throw new Error('Speech provider returned an empty response.')
  const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true })
  let text = '', size = 0
  try {
    for (;;) {
      const part = await reader.read()
      if (part.done) break
      size += part.value.byteLength
      if (size > limit) { await reader.cancel(); throw new Error('Speech provider response exceeds the size limit.') }
      text += decoder.decode(part.value, { stream: true })
    }
    text += decoder.decode()
    try { return JSON.parse(text) } catch { throw new Error('Speech provider returned invalid JSON.') }
  } catch (error) {
    if (error instanceof Error && error.message === 'Speech provider response exceeds the size limit.') throw error
    throw new Error('Speech provider returned invalid or incomplete JSON.')
  } finally { reader.releaseLock() }
}

/** Preserve status without echoing provider data, submitted text, credentials or signed URLs. */
export function speechProviderStatusError(response: Response, message: string): Error & { status: number } {
  try { void response.body?.cancel().catch(() => {}) } catch { /* Nothing from the error body is needed. */ }
  return Object.assign(new Error(message), { status: response.status })
}
