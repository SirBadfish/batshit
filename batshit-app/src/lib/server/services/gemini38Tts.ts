export const GEMINI_38_TTS_MODELS = ['gemini-3.8-flash-tts', 'gemini-3.8-flash-lite-tts'] as const
export const isGemini38TtsModel = (model: string) => (GEMINI_38_TTS_MODELS as readonly string[]).includes(model)

/** One complete single-speaker request, using Google's default WAV output. */
export function buildGemini38TtsRequest(model: string, text: string, voice: string) {
  if (!isGemini38TtsModel(model)) throw new Error('Unsupported Gemini 3.8 speech model.')
  return {
    model,
    input: [{ type: 'user_input', content: [{ type: 'text', text }] }],
    response_format: { type: 'audio', mime_type: 'audio/wav' },
    generation_config: { speech_config: [{ voice }] }
  }
}

export function parseGemini38TtsAudio(payload: unknown): Uint8Array {
  if (!payload || typeof payload !== 'object' || !Array.isArray((payload as { steps?: unknown }).steps)) throw new Error('Gemini returned no speech audio.')
  let encoded: unknown
  for (const step of (payload as { steps: unknown[] }).steps) {
    if (!step || typeof step !== 'object') continue
    const row = step as { type?: unknown; content?: unknown }
    if (row.type !== 'model_output' || !Array.isArray(row.content)) continue
    for (const content of row.content) {
      if (content && typeof content === 'object' && (content as { type?: unknown }).type === 'audio') encoded = (content as { data?: unknown }).data
    }
  }
  if (typeof encoded !== 'string' || encoded.length > 64 * 1024 * 1024 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw new Error('Gemini returned invalid speech audio.')
  const bytes = Buffer.from(encoded, 'base64')
  if (bytes.length < 12 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Gemini returned invalid WAV audio.')
  return new Uint8Array(bytes)
}
