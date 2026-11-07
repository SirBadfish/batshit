/** Compiled anonymous metadata targets only; no default/global fetch or runtime import. */
export const VOICE_SOURCE_HTTP_CONTRACTS = Object.freeze({
  googleSpeech: Object.freeze({ url: 'https://ai.google.dev/gemini-api/docs/speech-generation', maxBytes: 2 * 1024 * 1024, timeoutMs: 15_000 }),
  googleTranscribe: Object.freeze({ url: 'https://ai.google.dev/gemini-api/docs/transcribe', maxBytes: 2 * 1024 * 1024, timeoutMs: 15_000 }),
  openaiSpeech: Object.freeze({ url: 'https://developers.openai.com/api/docs/guides/text-to-speech', maxBytes: 512 * 1024, timeoutMs: 15_000 }),
  openaiTranscribe: Object.freeze({ url: 'https://developers.openai.com/api/docs/guides/transcription', maxBytes: 512 * 1024, timeoutMs: 15_000 }),
  openaiFile: Object.freeze({ url: 'https://developers.openai.com/api/docs/guides/speech-to-text.md', maxBytes: 512 * 1024, timeoutMs: 15_000 }),
  elevenlabsDocs: Object.freeze({ url: 'https://elevenlabs.io/docs/overview/models.md', maxBytes: 512 * 1024, timeoutMs: 15_000 }),
  mistralInventory: Object.freeze({ url: 'https://docs.mistral.ai/studio/audio/overview.md', maxBytes: 256 * 1024, timeoutMs: 15_000 }),
  mistralSmallModel: Object.freeze({ url: 'https://docs.mistral.ai/models/voxtral-small-transcribe-3-0.md', maxBytes: 256 * 1024, timeoutMs: 15_000 }),
  mistralChangelog: Object.freeze({ url: 'https://docs.mistral.ai/resources/changelogs.md', maxBytes: 512 * 1024, timeoutMs: 15_000 }),
  mistralSpeech: Object.freeze({ url: 'https://docs.mistral.ai/studio/audio/text-to-speech/generate-speech.md', maxBytes: 256 * 1024, timeoutMs: 15_000 }),
  mistralTranscribe: Object.freeze({ url: 'https://docs.mistral.ai/studio/audio/speech-to-text/transcribe-files.md', maxBytes: 256 * 1024, timeoutMs: 15_000 }),
  mistralMigration: Object.freeze({ url: 'https://docs.mistral.ai/studio/audio/migrate-from-voxtral-2.md', maxBytes: 256 * 1024, timeoutMs: 15_000 }),
  mistralApi: Object.freeze({ url: 'https://docs.mistral.ai/openapi.yaml', maxBytes: 2 * 1024 * 1024, timeoutMs: 15_000 }),
  minimaxSpeech: Object.freeze({ url: 'https://platform.minimax.io/docs/api-reference/speech-t2a-http.md', maxBytes: 512 * 1024, timeoutMs: 15_000 }),
  mimoSpeech: Object.freeze({ url: 'https://mimo.mi.com/docs/en-US/quick-start/usage-guide/audio/speech-synthesis-v2.5', maxBytes: 1024 * 1024, timeoutMs: 15_000 }),
  alibabaSpeech: Object.freeze({ url: 'https://www.alibabacloud.com/help/en/model-studio/tts-model/', maxBytes: 1024 * 1024, timeoutMs: 15_000 }),
  alibabaAudioHttp: Object.freeze({ url: 'https://help.aliyun.com/en/model-studio/qwen-audio-tts-http-api', maxBytes: 2 * 1024 * 1024, timeoutMs: 15_000 }),
  alibabaAudioVoices: Object.freeze({ url: 'https://www.alibabacloud.com/help/en/model-studio/qwen-audio-tts-voice-list', maxBytes: 2 * 1024 * 1024, timeoutMs: 15_000 }),
  alibabaAudioModels: Object.freeze({ url: 'https://www.alibabacloud.com/help/en/model-studio/non-realtime-tts-user-guide', maxBytes: 2 * 1024 * 1024, timeoutMs: 15_000 }),
  alibabaOssHttps: Object.freeze({ url: 'https://www.alibabacloud.com/help/en/oss/user-guide/access-oss-by-https-protocol', maxBytes: 2 * 1024 * 1024, timeoutMs: 15_000 }),
  alibabaOssV1: Object.freeze({ url: 'https://www.alibabacloud.com/help/en/oss/user-guide/0002-00000075', maxBytes: 2 * 1024 * 1024, timeoutMs: 15_000 }),
  alibabaOssV4: Object.freeze({ url: 'https://www.alibabacloud.com/help/en/oss/developer-reference/add-signatures-to-urls', maxBytes: 2 * 1024 * 1024, timeoutMs: 15_000 }),
  inworldModels: Object.freeze({ url: 'https://docs.inworld.ai/tts/tts-models.md', maxBytes: 256 * 1024, timeoutMs: 15_000 }),
  inworldSpeech: Object.freeze({ url: 'https://docs.inworld.ai/api-reference/ttsAPI/texttospeech/synthesize-speech.md', maxBytes: 512 * 1024, timeoutMs: 15_000 }),
  inworldSteering: Object.freeze({ url: 'https://docs.inworld.ai/tts/capabilities/steering.md', maxBytes: 256 * 1024, timeoutMs: 15_000 }),
  cartesiaModels: Object.freeze({ url: 'https://docs.cartesia.ai/build-with-cartesia/tts-models/latest.md', maxBytes: 256 * 1024, timeoutMs: 15_000 }),
  cartesiaBytes: Object.freeze({ url: 'https://docs.cartesia.ai/api-reference/tts/bytes.md', maxBytes: 512 * 1024, timeoutMs: 15_000 }),
  asyncModels: Object.freeze({ url: 'https://docs.async.com/models-2161359m0', maxBytes: 1024 * 1024, timeoutMs: 15_000 }),
  asyncTranscribe: Object.freeze({ url: 'https://docs.async.com/speech-to-text-39464639e0', maxBytes: 1024 * 1024, timeoutMs: 15_000 }),
  stepfunSpeech: Object.freeze({ url: 'https://platform.stepfun.com/cookbook/stepaudio-3-tts', maxBytes: 1024 * 1024, timeoutMs: 15_000 }),
  stepfunGlobalCookbook: Object.freeze({ url: 'https://platform.stepfun.ai/cookbook/stepaudio-3-tts', maxBytes: 1024 * 1024, timeoutMs: 15_000 }),
  stepfunApi: Object.freeze({ url: 'https://platform.stepfun.ai/docs/en/api-reference/audio/create-audio.md', maxBytes: 512 * 1024, timeoutMs: 15_000 }),
  elevenlabsSpeechV4: Object.freeze({ url: 'https://elevenlabs.io/docs/eleven-creative/playground/text-to-speech.md', maxBytes: 512 * 1024, timeoutMs: 15_000 }),
  elevenlabsSpeechApi: Object.freeze({ url: 'https://elevenlabs.io/docs/api-reference/text-to-speech/convert.md', maxBytes: 512 * 1024, timeoutMs: 15_000 }),
  azureSpeech: Object.freeze({ url: 'https://learn.microsoft.com/en-us/azure/ai-services/speech-service/rest-text-to-speech', maxBytes: 512 * 1024, timeoutMs: 15_000 }),
  installedCatalog: Object.freeze({ url: 'https://api.batshit.ai/registry/voice-model-catalog.json', maxBytes: 1024 * 1024, timeoutMs: 5000 }),
  fishTimestamp: Object.freeze({ url: 'https://docs.fish.audio/api-reference/openapi.json', maxBytes: 2 * 1024 * 1024, timeoutMs: 15_000 }),
  elevenlabsModels: Object.freeze({ url: 'https://api.elevenlabs.io/v1/models', maxBytes: 1024 * 1024, timeoutMs: 15_000 }),
  deepgramLatest: Object.freeze({ url: 'https://api.deepgram.com/v1/models', maxBytes: 1024 * 1024, timeoutMs: 15_000 }),
  deepgramAll: Object.freeze({ url: 'https://api.deepgram.com/v1/models?include_outdated=true', maxBytes: 1024 * 1024, timeoutMs: 15_000 })
} as const)
export type VoiceSourceHttpKey = keyof typeof VOICE_SOURCE_HTTP_CONTRACTS
type Failure = 'unknown-source' | 'network' | 'http' | 'incomplete' | 'mime' | 'oversized' | 'malformed-response' | 'invalid-utf8'
export type VoiceSourceBodyRead = {
  kind: 'body'; sourceKey: VoiceSourceHttpKey; checkedAt: string; body: string
} | {
  kind: 'unavailable'; sourceKey: VoiceSourceHttpKey | null; checkedAt: string; reason: Failure; httpStatus?: number
}

/** The injected port obeys fetch's linked response-body AbortSignal contract. */
export async function readVoiceSourceBody(key: VoiceSourceHttpKey, http: typeof fetch, now: () => number = Date.now): Promise<VoiceSourceBodyRead> {
  const sourceKey = typeof key === 'string' && Object.hasOwn(VOICE_SOURCE_HTTP_CONTRACTS, key) ? key : null
  const unavailable = (reason: Failure, httpStatus?: number): VoiceSourceBodyRead => ({
    kind: 'unavailable', sourceKey, checkedAt: new Date(now()).toISOString(), reason,
    ...(httpStatus !== undefined ? { httpStatus } : {})
  })
  if (sourceKey === null) return unavailable('unknown-source')
  const contract = VOICE_SOURCE_HTTP_CONTRACTS[sourceKey]
  const jsonKeys: readonly VoiceSourceHttpKey[] = ['installedCatalog', 'fishTimestamp', 'elevenlabsModels', 'deepgramLatest', 'deepgramAll']
  const jsonOnly = jsonKeys.includes(sourceKey)
  const acceptedMime = jsonOnly ? ['application/json'] : sourceKey === 'asyncTranscribe' ? ['text/html'] : sourceKey === 'mistralApi' ? ['application/yaml', 'application/x-yaml', 'text/yaml', 'text/plain'] : ['text/markdown', 'text/plain', 'text/html']
  let response: Response
  const discard = (): void => {
    try { void response.body?.cancel().catch(() => {}) } catch { /* A failed source never certifies data. */ }
  }
  try {
    response = await http(contract.url, {
      method: 'GET', headers: { Accept: acceptedMime.join(', ') }, credentials: 'omit', redirect: 'error',
      signal: AbortSignal.timeout(contract.timeoutMs)
    })
  } catch { return unavailable('network') }
  const status = response?.status
  if (!Number.isInteger(status) || status < 100 || status > 599 || typeof response.ok !== 'boolean'
    || response.ok !== (status >= 200 && status < 300)) return unavailable('malformed-response')
  if (!response.ok) { discard(); return unavailable('http', status) }
  if (status !== 200) { discard(); return unavailable('incomplete', status) }
  let contentType: unknown
  try { contentType = response.headers.get('content-type') } catch { discard(); return unavailable('malformed-response', status) }
  if (typeof contentType !== 'string' || !acceptedMime.includes(contentType.split(';', 1)[0].trim().toLowerCase())) {
    discard(); return unavailable('mime', status)
  }
  let reader: ReadableStreamDefaultReader<Uint8Array>
  try {
    if (!response.body) return unavailable('malformed-response', status)
    reader = response.body.getReader()
  } catch { discard(); return unavailable('malformed-response', status) }
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let bytes = 0, body = ''
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      if (!(next.value instanceof Uint8Array)) { void reader.cancel().catch(() => {}); return unavailable('malformed-response', status) }
      bytes += next.value.byteLength
      if (bytes > contract.maxBytes) { void reader.cancel().catch(() => {}); return unavailable('oversized', status) }
      try { body += decoder.decode(next.value, { stream: true }) }
      catch { void reader.cancel().catch(() => {}); return unavailable('invalid-utf8', status) }
    }
    try { body += decoder.decode() } catch { return unavailable('invalid-utf8', status) }
  } catch { void reader.cancel().catch(() => {}); return unavailable('network', status) }
  finally { reader.releaseLock() }
  return { kind: 'body', sourceKey, checkedAt: new Date(now()).toISOString(), body }
}
