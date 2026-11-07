import type { QwenAudioRegion } from '$lib/data/qwenAudioTts'

/** The response URL is untrusted. Admit only Alibaba's public OSS bucket domain for the chosen region. */
export function qwenAudioResultUrl(payload: unknown, region: QwenAudioRegion): string {
  if (!payload || typeof payload !== 'object') throw new Error('Qwen Audio returned no completed audio.')
  const output = (payload as { output?: { finish_reason?: unknown; audio?: { url?: unknown } } }).output
  if (output?.finish_reason !== 'stop' || typeof output.audio?.url !== 'string') throw new Error('Qwen Audio returned no completed audio.')
  const raw = output.audio.url
  let url: URL
  try { url = new URL(raw) } catch { throw new Error('Qwen Audio returned an invalid audio URL.') }
  const suffix = region === 'beijing' ? 'oss-cn-beijing.aliyuncs.com' : 'oss-ap-southeast-1.aliyuncs.com'
  const hostPattern = new RegExp(`^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]\\.${suffix.replaceAll('.', '\\.')}$`)
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port || url.hash || !hostPattern.test(url.hostname) || raw !== url.href) {
    throw new Error('Qwen Audio returned an unsupported audio URL.')
  }
  if (url.protocol === 'http:') {
    // OSS V1 and V4 URL signatures cover the request/resource, not the URL scheme.
    // Upgrade only an identifiable signed OSS URL, preserving the signed bytes exactly.
    const one = (key: string) => url.searchParams.getAll(key).length === 1 && Boolean(url.searchParams.get(key))
    const v1 = one('OSSAccessKeyId') && one('Expires') && one('Signature')
    const v4 = one('x-oss-credential') && one('x-oss-date') && one('x-oss-expires') && one('x-oss-signature')
      && url.searchParams.getAll('x-oss-signature-version').length === 1 && url.searchParams.get('x-oss-signature-version') === 'OSS4-HMAC-SHA256'
    if (!v1 && !v4) throw new Error('Qwen Audio returned an unsupported audio URL.')
    return 'https:' + raw.slice('http:'.length)
  }
  return raw
}

/** Do not follow provider-supplied redirects or buffer an unbounded file. */
export async function downloadQwenAudio(url: string): Promise<Uint8Array> {
  let response: Response
  try { response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(60_000) }) }
  catch { throw new Error('Failed to download Qwen Audio speech.') }
  if (!response.ok || !response.body) {
    try { void response.body?.cancel().catch(() => {}) } catch { /* Discard the provider response. */ }
    throw new Error('Failed to download Qwen Audio speech.')
  }
  const reader = response.body.getReader(), chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const part = await reader.read()
      if (part.done) break
      size += part.value.byteLength
      if (size > 64 * 1024 * 1024) { void reader.cancel().catch(() => {}); throw new Error('Qwen Audio speech exceeds the download limit.') }
      chunks.push(part.value)
    }
  } catch (error) {
    if (error instanceof Error && error.message === 'Qwen Audio speech exceeds the download limit.') throw error
    throw new Error('Failed to download Qwen Audio speech.')
  } finally { reader.releaseLock() }
  const result = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength }
  if (size < 12 || String.fromCharCode(...result.subarray(0, 4)) !== 'RIFF' || String.fromCharCode(...result.subarray(8, 12)) !== 'WAVE') throw new Error('Qwen Audio returned invalid WAV audio.')
  return result
}
