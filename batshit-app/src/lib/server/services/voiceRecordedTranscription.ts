import { bytesToBlob } from '$lib/utils/binary'
import { readBoundedSpeechJson, speechProviderStatusError } from './boundedSpeechJson'

const asyncLanguages = new Set(['en', 'fr', 'es', 'de', 'it', 'pt', 'ar', 'ru', 'ro', 'ja', 'he', 'hy', 'tr', 'hi', 'zh'])
const openaiLanguage = (code: string) => /^(?:[a-z]{2,3}|zh-(?:cn|tw|hk))$/i.test(code)

/** The two fixed, single-upload recorded contracts. Never accepts an endpoint from a caller. */
export function recordedTranscriptionForm(
  provider: 'openai' | 'async', audio: Uint8Array, model: string, language?: string
): FormData {
  const form = new FormData()
  form.append(provider === 'openai' ? 'model' : 'model_id', model)
  form.append('file', bytesToBlob(audio, { type: 'audio/wav' }), 'speech.wav')
  if (language) {
    const hint = provider === 'async' ? language.toLowerCase() : language
    if (!(provider === 'openai' ? openaiLanguage(hint) : asyncLanguages.has(hint))) {
      throw new Error(`${provider === 'openai' ? 'OpenAI' : 'Async'} transcription language must be an ISO language code.`)
    }
    form.append(provider === 'openai' ? 'languages[]' : 'language', hint)
  }
  return form
}

export function recordedTranscriptionResult(provider: 'openai' | 'async', value: unknown): { text: string; language?: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof (value as Record<string, unknown>).text !== 'string') {
    throw new Error(`${provider === 'openai' ? 'OpenAI' : 'Async'} transcription returned an invalid response.`)
  }
  const payload = value as Record<string, unknown>
  if (provider === 'async') return { text: payload.text as string }
  const languages = payload.languages
  if (languages !== undefined && (!Array.isArray(languages) || languages.some(item =>
    !item || typeof item !== 'object' || Array.isArray(item) || typeof item.code !== 'string' || !openaiLanguage(item.code)
  ))) throw new Error('OpenAI transcription returned invalid detected languages.')
  // The existing result has room for one language, so multiple detections remain unknown.
  const language = Array.isArray(languages) && languages.length === 1 ? languages[0].code as string : undefined
  return { text: payload.text as string, language }
}

/** The deadline covers the request and response body; provider content is never echoed in errors. */
export async function fetchRecordedTranscription(provider: 'openai' | 'async', apiKey: string, form: FormData, headers: Record<string, string> = {}): Promise<{ text: string; language?: string }> {
  const label = provider === 'openai' ? 'OpenAI' : 'Async'
  const controller = new AbortController()
  let timeout: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => { controller.abort(); reject(new Error(`${label} transcription timed out.`)) }, 120_000)
  })
  const run = async () => {
    let response: Response
    try {
      response = await fetch(provider === 'openai' ? 'https://api.openai.com/v1/audio/transcriptions' : 'https://api.async.com/speech_to_text', {
        method: 'POST', redirect: 'error', signal: controller.signal,
        headers: provider === 'openai' ? { ...headers, Authorization: `Bearer ${apiKey}` } : { 'x-api-key': apiKey, version: 'v1' }, body: form
      })
    } catch { throw new Error(`${label} transcription request failed.`) }
    if (!response.ok) throw speechProviderStatusError(response, `${label} transcription failed.`)
    let payload: unknown
    try { payload = await readBoundedSpeechJson(response, 2 * 1024 * 1024) }
    catch { throw new Error(`${label} transcription returned an invalid or oversized response.`) }
    return recordedTranscriptionResult(provider, payload)
  }
  try { return await Promise.race([run(), deadline]) }
  finally { if (timeout !== undefined) clearTimeout(timeout) }
}
