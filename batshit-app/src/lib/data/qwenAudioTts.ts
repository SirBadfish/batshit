/** The bounded, public-system-voice subset of Alibaba's Qwen-Audio HTTP API. */
export const QWEN_AUDIO_TTS_MODELS = [
  'qwen-audio-3.1-tts-plus', 'qwen-audio-3.1-tts-flash',
  'qwen-audio-3.0-tts-plus', 'qwen-audio-3.0-tts-flash'
] as const
export type QwenAudioRegion = 'singapore' | 'beijing'
export const isQwenAudioTtsModel = (model: string) => (QWEN_AUDIO_TTS_MODELS as readonly string[]).includes(model)

// All listed 3.1 Flash voices are in the multilingual group available in both regions.
// Keep the subset explicit: a voice belonging to another model is not transferable.
const voices: Record<(typeof QWEN_AUDIO_TTS_MODELS)[number], readonly string[]> = {
  'qwen-audio-3.1-tts-plus': ['longanlingxin_v3.1', 'xunanchuan_v3.1', 'longanhuan_v3.1', 'longanfengyue_v3.1'],
  'qwen-audio-3.1-tts-flash': ['longanhuan_v3.1', 'longanlingxin_v3.1', 'longanfengyue_v3.1', 'xunanchuan_v3.1'],
  'qwen-audio-3.0-tts-plus': ['longanlingxin', 'longanlufeng'],
  'qwen-audio-3.0-tts-flash': ['longanfengyue', 'longanyuanfei', 'longanlingxi', 'longanxiaoxin', 'longanhuan_v3.6']
}
export function getQwenAudioTtsVoices(model: string, region: QwenAudioRegion): readonly string[] {
  if (!isQwenAudioTtsModel(model) || !['singapore', 'beijing'].includes(region)) return []
  return voices[model as keyof typeof voices]
}

const path = '/api/v1/services/audio/tts/SpeechSynthesizer'
export function parseQwenAudioEndpoint(value: unknown): { endpoint: string; region: QwenAudioRegion } {
  if (typeof value !== 'string' || !value.trim()) throw new Error('A Qwen Audio regional workspace endpoint is required in Voice Engine settings.')
  const input = value.trim()
  let url: URL
  try { url = new URL(input) } catch { throw new Error('Qwen Audio workspace endpoint is invalid.') }
  const match = url.hostname.match(/^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.(ap-southeast-1|cn-beijing)\.maas\.aliyuncs\.com$/)
  if (!match || url.protocol !== 'https:' || url.port || url.username || url.password || url.search || url.hash || url.pathname !== path || input !== url.href) {
    throw new Error('Qwen Audio workspace endpoint is invalid. Use the complete HTTPS workspace endpoint for Singapore or Beijing.')
  }
  return { endpoint: url.href, region: match[2] === 'cn-beijing' ? 'beijing' : 'singapore' }
}

// The 3.1 Flash multilingual table explicitly lists these languages for this subset.
// The 3.1 Plus system-voice table does not specify language hints per voice.
const languages31Flash = ['ja', 'ko', 'fr', 'de', 'pt', 'it', 'vi', 'id']
const languages30 = ['zh', 'en']
export function buildQwenAudioTtsRequest(args: {
  model: string; text: string; voiceId?: string | null; common?: Record<string, unknown>
}) {
  if (!isQwenAudioTtsModel(args.model)) throw new Error('Unsupported Qwen Audio model.')
  const common = args.common ?? {}
  const { endpoint, region } = parseQwenAudioEndpoint(common.endpoint)
  const voiceId = args.voiceId?.trim()
  if (!voiceId || !getQwenAudioTtsVoices(args.model, region).includes(voiceId)) {
    throw new Error('A Qwen Audio system voice supported by this model and region is required.')
  }
  const input: Record<string, unknown> = { text: args.text, voice: voiceId, format: 'wav', sample_rate: 24000 }
  if (common.language !== undefined && common.language !== null && common.language !== '') {
    if (typeof common.language !== 'string') throw new Error('Qwen Audio language is invalid; use a supported language code.')
    const language = common.language.trim().toLowerCase()
    const allowed = args.model === 'qwen-audio-3.1-tts-plus' ? [] : args.model === 'qwen-audio-3.1-tts-flash' ? languages31Flash : languages30
    if (language && !allowed.includes(language)) throw new Error('This Qwen Audio voice does not support the selected language hint.')
    if (language) input.language_hints = [language]
  }
  if (common.instructions !== undefined && common.instructions !== null && common.instructions !== '') {
    if (typeof common.instructions !== 'string') throw new Error('Qwen Audio instructions are invalid; use text.')
    const instruction = common.instructions.trim()
    if (instruction) input.instruction = instruction
  }
  for (const [key, value] of Object.entries(common)) {
    if (!['endpoint', 'language', 'instructions'].includes(key) && value !== undefined && value !== null && value !== '') {
      throw new Error(`Qwen Audio does not support the saved ${key} setting.`)
    }
  }
  return { endpoint, region, voiceId, body: { model: args.model, input } }
}
