import type {
  BuiltinVoiceCatalogBaselineBinding,
  BuiltinVoiceCatalogContext,
  BuiltinVoiceCatalogProfile,
  BuiltinVoiceCatalogRule,
  BuiltinVoiceCatalogSource,
  BuiltinVoiceLane,
  BuiltinVoiceProviderId
} from '../types/builtinVoiceCatalog'

export const BUILTIN_VOICE_PROVIDER_IDS = Object.freeze([
  'browser', 'google', 'openai', 'elevenlabs', 'deepgram', 'fish', 'mistral',
  'minimax', 'mimo', 'alibaba', 'inworld', 'cartesia', 'async', 'stepfun', 'azure'
] as const satisfies readonly BuiltinVoiceProviderId[])

/** Versioned identities only. No caller or runtime strategy is installed by this table. */
const profileRows = [
  ['google.generate-content.v1', 'google', 'tts-batch'],
  ['google.interactions-tts.v1', 'google', 'tts-batch'],
  ['google.interactions-transcribe.v1', 'google', 'stt-recorded'],
  ['openai.speech-mini.v1', 'openai', 'tts-batch'],
  ['openai.speech-legacy.v1', 'openai', 'tts-batch'],
  ['openai.file-transcription.v1', 'openai', 'stt-recorded'],
  ['openai.file-transcription.v2', 'openai', 'stt-recorded'],
  ['elevenlabs.rest-speech.v1', 'elevenlabs', 'tts-batch'],
  ['elevenlabs.rest-speech-v4.v1', 'elevenlabs', 'tts-batch'],
  ['elevenlabs.scribe-upload.v1', 'elevenlabs', 'stt-recorded'],
  ['deepgram.aura-rest.v1', 'deepgram', 'tts-batch'],
  ['deepgram.flux-rest.v1', 'deepgram', 'tts-batch'],
  ['deepgram.recorded-listen.v1', 'deepgram', 'stt-recorded'],
  ['deepgram.flux-websocket.v1', 'deepgram', 'stt-direct-realtime'],
  ['fish.timestamp-sse.v1', 'fish', 'tts-direct-stream'],
  ['fish.upload-asr.v1', 'fish', 'stt-recorded'],
  ['mistral.audio-speech-json.v1', 'mistral', 'tts-batch'],
  ['mistral.recorded-segments.v1', 'mistral', 'stt-recorded'],
  ['mistral.recorded-segments.v2', 'mistral', 'stt-recorded'],
  ['minimax.http-hex.v1', 'minimax', 'tts-batch'],
  ['mimo.chat-audio.v1', 'mimo', 'tts-batch'],
  ['mimo.chat-voice-design.v1', 'mimo', 'tts-batch'],
  ['mimo.chat-voice-clone.v1', 'mimo', 'tts-batch'],
  ['mimo.chat-asr.v1', 'mimo', 'stt-recorded'],
  ['alibaba.multimodal-tts.v1', 'alibaba', 'tts-batch'],
  ['alibaba.audio-http.v1', 'alibaba', 'tts-batch'],
  ['inworld.voice-json.v1', 'inworld', 'tts-batch'],
  ['inworld.voice-json-flash.v1', 'inworld', 'tts-batch'],
  ['inworld.voice-stream.v1', 'inworld', 'tts-direct-stream'],
  ['cartesia.bytes-20260301.v1', 'cartesia', 'tts-batch'],
  ['cartesia.bytes-20260814.v1', 'cartesia', 'tts-batch'],
  ['async.bytes-v1.v1', 'async', 'tts-batch'],
  ['async.recorded-upload.v1', 'async', 'stt-recorded'],
  ['stepfun.audio-speech.v1', 'stepfun', 'tts-batch'],
  ['stepfun.audio-speech-3.v1', 'stepfun', 'tts-batch'],
  ['azure.ssml-rest.v1', 'azure', 'tts-batch']
] as const satisfies readonly (readonly [string, Exclude<BuiltinVoiceProviderId, 'browser'>, BuiltinVoiceLane])[]

export const BUILTIN_VOICE_CATALOG_PROFILES: readonly BuiltinVoiceCatalogProfile[] = Object.freeze(
  profileRows.map(([id, providerId, lane]) => Object.freeze({ id, providerId, lane, version: 1 }))
)

/** Fixed public provenance. These URLs are never executable runtime endpoints. */
export const BUILTIN_VOICE_CATALOG_SOURCES: readonly BuiltinVoiceCatalogSource[] = Object.freeze(([
  { id: 'browser-runtime-v1', providerId: 'browser', urls: [] },
  { id: 'google-audio-docs-v1', providerId: 'google', urls: [
    'https://ai.google.dev/gemini-api/docs/models?hl=en',
    'https://ai.google.dev/gemini-api/docs/speech-generation',
    'https://ai.google.dev/gemini-api/docs/transcribe'
  ] },
  { id: 'openai-audio-docs-v1', providerId: 'openai', urls: [
    'https://developers.openai.com/api/docs/guides/text-to-speech',
    'https://developers.openai.com/api/docs/guides/transcription',
    'https://developers.openai.com/api/docs/guides/speech-to-text.md'
  ] },
  { id: 'elevenlabs-public-models-v1', providerId: 'elevenlabs', urls: [
    'https://api.elevenlabs.io/v1/models',
    'https://elevenlabs.io/docs/api-reference/models/list',
    'https://elevenlabs.io/docs/overview/models',
    'https://elevenlabs.io/docs/overview/models.md',
    'https://elevenlabs.io/docs/eleven-creative/playground/text-to-speech.md',
    'https://elevenlabs.io/docs/api-reference/text-to-speech/convert.md'
  ] },
  { id: 'deepgram-public-models-v1', providerId: 'deepgram', urls: [
    'https://api.deepgram.com/v1/models',
    'https://api.deepgram.com/v1/models?include_outdated=true',
    'https://developers.deepgram.com/guides/fundamentals/model-metadata',
    'https://developers.deepgram.com/docs/models-languages-overview/'
  ] },
  { id: 'fish-public-voice-api-v1', providerId: 'fish', urls: [
    'https://docs.fish.audio/api-reference/endpoint/openapi-v1/text-to-speech-stream-with-timestamps',
    'https://docs.fish.audio/api-reference/endpoint/openapi-v1/text-to-speech',
    'https://docs.fish.audio/features/text-to-speech/drama-3',
    'https://docs.fish.audio/api-reference/openapi.json'
  ] },
  { id: 'mistral-public-audio-docs-v1', providerId: 'mistral', urls: [
    'https://docs.mistral.ai/studio/audio/overview',
    'https://docs.mistral.ai/studio/audio/migrate-from-voxtral-2',
    'https://docs.mistral.ai/studio/audio/text-to-speech/overview',
    'https://docs.mistral.ai/studio/audio/text-to-speech/generate-speech',
    'https://docs.mistral.ai/studio/audio/overview.md',
    'https://docs.mistral.ai/studio/audio/text-to-speech/generate-speech.md',
    'https://docs.mistral.ai/studio/audio/speech-to-text/transcribe-files.md',
    'https://docs.mistral.ai/studio/audio/migrate-from-voxtral-2.md',
    'https://docs.mistral.ai/openapi.yaml',
    'https://docs.mistral.ai/models/voxtral-small-transcribe-3-0.md',
    'https://docs.mistral.ai/resources/changelogs.md'
  ] },
  { id: 'minimax-public-tts-spec-v1', providerId: 'minimax', urls: [
    'https://platform.minimax.io/docs/api-reference/speech-t2a-http',
    'https://platform.minimax.io/docs/api-reference/speech-t2a-http.md'
  ] },
  { id: 'mimo-public-audio-docs-v1', providerId: 'mimo', urls: [
    'https://mimo.mi.com/docs/en-US/quick-start/usage-guide/audio/speech-synthesis-v2.5',
    'https://platform.xiaomimimo.com/docs/en-US/news/previous-news/v2.5-tts-release'
  ] },
  { id: 'alibaba-public-audio-docs-v1', providerId: 'alibaba', urls: [
    'https://www.alibabacloud.com/help/en/model-studio/tts-model/',
    'https://www.alibabacloud.com/help/en/model-studio/models',
    'https://www.alibabacloud.com/help/en/model-studio/qwen-audio-tts-voice-list',
    'https://help.aliyun.com/en/model-studio/qwen-audio-tts-http-api',
    'https://www.alibabacloud.com/help/en/model-studio/non-realtime-tts-user-guide',
    'https://www.alibabacloud.com/help/en/oss/user-guide/access-oss-by-https-protocol',
    'https://www.alibabacloud.com/help/en/oss/user-guide/0002-00000075',
    'https://www.alibabacloud.com/help/en/oss/developer-reference/add-signatures-to-urls'
  ] },
  { id: 'inworld-public-tts-docs-v1', providerId: 'inworld', urls: [
    'https://docs.inworld.ai/tts/tts-models',
    'https://docs.inworld.ai/release-notes/tts',
    'https://docs.inworld.ai/tts/tts-models.md',
    'https://docs.inworld.ai/api-reference/ttsAPI/texttospeech/synthesize-speech.md',
    'https://docs.inworld.ai/tts/capabilities/steering.md'
  ] },
  { id: 'cartesia-public-sonic-docs-v1', providerId: 'cartesia', urls: [
    'https://docs.cartesia.ai/build-with-cartesia/tts-models/latest',
    'https://docs.cartesia.ai/build-with-cartesia/tts-models/latest.md',
    'https://docs.cartesia.ai/api-reference/tts/bytes.md'
  ] },
  { id: 'async-public-audio-docs-v1', providerId: 'async', urls: [
    'https://docs.async.com/models-2161359m0', 'https://docs.async.com/',
    'https://docs.async.com/speech-to-text-39464639e0'
  ] },
  { id: 'stepfun-public-audio-docs-v1', providerId: 'stepfun', urls: [
    'https://platform.stepfun.com/', 'https://platform.stepfun.com/cookbook/stepaudio-3-tts',
    'https://platform.stepfun.ai/cookbook/stepaudio-3-tts',
    'https://platform.stepfun.ai/docs/en/api-reference/audio/create-audio.md'
  ] },
  { id: 'azure-public-rest-docs-v1', providerId: 'azure', urls: [
    'https://learn.microsoft.com/en-us/azure/ai-services/speech-service/rest-text-to-speech',
    'https://learn.microsoft.com/en-us/azure/ai-services/speech-service/language-support?tabs=text-to-speech'
  ] }
] satisfies BuiltinVoiceCatalogSource[]).map(source => Object.freeze({ ...source, urls: Object.freeze(source.urls) })))

// Extracted exactly from voiceService/voiceModelCatalog arrays at 0556d5257; not new qualification.
export const BUILTIN_VOICE_CATALOG_BASELINE: readonly BuiltinVoiceCatalogBaselineBinding[] = Object.freeze(([
  {"providerId": "google", "lane": "tts-batch", "modelId": "gemini-3.1-flash-tts-preview", "admission": "qualified", "compatibilityProfileId": "google.generate-content.v1"},
  {"providerId": "google", "lane": "tts-batch", "modelId": "gemini-2.5-flash-preview-tts", "admission": "qualified", "compatibilityProfileId": "google.generate-content.v1"},
  {"providerId": "google", "lane": "tts-batch", "modelId": "gemini-2.5-pro-preview-tts", "admission": "qualified", "compatibilityProfileId": "google.generate-content.v1"},
  {"providerId": "google", "lane": "stt-recorded", "modelId": "gemini-3.5-transcribe", "admission": "qualified", "compatibilityProfileId": "google.interactions-transcribe.v1"},
  {"providerId": "openai", "lane": "stt-recorded", "modelId": "gpt-4o-mini-transcribe", "admission": "qualified", "compatibilityProfileId": "openai.file-transcription.v1"},
  {"providerId": "openai", "lane": "stt-recorded", "modelId": "gpt-4o-transcribe", "admission": "qualified", "compatibilityProfileId": "openai.file-transcription.v1"},
  {"providerId": "openai", "lane": "stt-recorded", "modelId": "gpt-4o-transcribe-diarize", "admission": "qualified", "compatibilityProfileId": "openai.file-transcription.v1"},
  {"providerId": "openai", "lane": "stt-recorded", "modelId": "whisper-1", "admission": "qualified", "compatibilityProfileId": "openai.file-transcription.v1"},
  {"providerId": "elevenlabs", "lane": "tts-batch", "modelId": "eleven_v3", "admission": "qualified", "compatibilityProfileId": "elevenlabs.rest-speech.v1"},
  {"providerId": "elevenlabs", "lane": "tts-batch", "modelId": "eleven_multilingual_v2", "admission": "qualified", "compatibilityProfileId": "elevenlabs.rest-speech.v1"},
  {"providerId": "elevenlabs", "lane": "tts-batch", "modelId": "eleven_flash_v2_5", "admission": "qualified", "compatibilityProfileId": "elevenlabs.rest-speech.v1"},
  {"providerId": "elevenlabs", "lane": "tts-batch", "modelId": "eleven_flash_v2", "admission": "qualified", "compatibilityProfileId": "elevenlabs.rest-speech.v1"},
  {"providerId": "elevenlabs", "lane": "stt-recorded", "modelId": "scribe_v2", "admission": "qualified", "compatibilityProfileId": "elevenlabs.scribe-upload.v1"},
  {"providerId": "deepgram", "lane": "stt-recorded", "modelId": "nova-3", "admission": "qualified", "compatibilityProfileId": "deepgram.recorded-listen.v1"},
  {"providerId": "deepgram", "lane": "stt-recorded", "modelId": "nova-3-general", "admission": "qualified", "compatibilityProfileId": "deepgram.recorded-listen.v1"},
  {"providerId": "deepgram", "lane": "stt-recorded", "modelId": "nova-3-medical", "admission": "qualified", "compatibilityProfileId": "deepgram.recorded-listen.v1"},
  {"providerId": "deepgram", "lane": "stt-recorded", "modelId": "nova-2", "admission": "qualified", "compatibilityProfileId": "deepgram.recorded-listen.v1"},
  {"providerId": "deepgram", "lane": "stt-recorded", "modelId": "nova-2-general", "admission": "qualified", "compatibilityProfileId": "deepgram.recorded-listen.v1"},
  {"providerId": "deepgram", "lane": "stt-recorded", "modelId": "nova-2-meeting", "admission": "qualified", "compatibilityProfileId": "deepgram.recorded-listen.v1"},
  {"providerId": "deepgram", "lane": "stt-recorded", "modelId": "nova-2-phonecall", "admission": "qualified", "compatibilityProfileId": "deepgram.recorded-listen.v1"},
  {"providerId": "deepgram", "lane": "stt-recorded", "modelId": "nova-2-finance", "admission": "qualified", "compatibilityProfileId": "deepgram.recorded-listen.v1"},
  {"providerId": "deepgram", "lane": "stt-recorded", "modelId": "nova-2-conversationalai", "admission": "qualified", "compatibilityProfileId": "deepgram.recorded-listen.v1"},
  {"providerId": "deepgram", "lane": "stt-recorded", "modelId": "nova-2-voicemail", "admission": "qualified", "compatibilityProfileId": "deepgram.recorded-listen.v1"},
  {"providerId": "deepgram", "lane": "stt-recorded", "modelId": "nova-2-video", "admission": "qualified", "compatibilityProfileId": "deepgram.recorded-listen.v1"},
  {"providerId": "deepgram", "lane": "stt-recorded", "modelId": "nova-2-medical", "admission": "qualified", "compatibilityProfileId": "deepgram.recorded-listen.v1"},
  {"providerId": "deepgram", "lane": "stt-recorded", "modelId": "nova-2-drivethru", "admission": "qualified", "compatibilityProfileId": "deepgram.recorded-listen.v1"},
  {"providerId": "deepgram", "lane": "stt-recorded", "modelId": "nova-2-automotive", "admission": "qualified", "compatibilityProfileId": "deepgram.recorded-listen.v1"},
  {"providerId": "deepgram", "lane": "stt-recorded", "modelId": "nova-2-atc", "admission": "qualified", "compatibilityProfileId": "deepgram.recorded-listen.v1"},
  {"providerId": "deepgram", "lane": "stt-recorded", "modelId": "whisper", "admission": "qualified", "compatibilityProfileId": "deepgram.recorded-listen.v1"},
  {"providerId": "deepgram", "lane": "stt-recorded", "modelId": "whisper-tiny", "admission": "qualified", "compatibilityProfileId": "deepgram.recorded-listen.v1"},
  {"providerId": "deepgram", "lane": "stt-recorded", "modelId": "whisper-base", "admission": "qualified", "compatibilityProfileId": "deepgram.recorded-listen.v1"},
  {"providerId": "deepgram", "lane": "stt-recorded", "modelId": "whisper-small", "admission": "qualified", "compatibilityProfileId": "deepgram.recorded-listen.v1"},
  {"providerId": "deepgram", "lane": "stt-recorded", "modelId": "whisper-medium", "admission": "qualified", "compatibilityProfileId": "deepgram.recorded-listen.v1"},
  {"providerId": "deepgram", "lane": "stt-recorded", "modelId": "whisper-large", "admission": "qualified", "compatibilityProfileId": "deepgram.recorded-listen.v1"},
  {"providerId": "deepgram", "lane": "stt-direct-realtime", "modelId": "flux-general-en", "admission": "qualified", "compatibilityProfileId": "deepgram.flux-websocket.v1"},
  {"providerId": "deepgram", "lane": "stt-direct-realtime", "modelId": "flux-general-multi", "admission": "qualified", "compatibilityProfileId": "deepgram.flux-websocket.v1"},
  {"providerId": "fish", "lane": "tts-direct-stream", "modelId": "s2.1-pro", "admission": "qualified", "compatibilityProfileId": "fish.timestamp-sse.v1"},
  {"providerId": "fish", "lane": "tts-direct-stream", "modelId": "s2.1-pro-free", "admission": "qualified", "compatibilityProfileId": "fish.timestamp-sse.v1"},
  {"providerId": "fish", "lane": "tts-direct-stream", "modelId": "s2-pro", "admission": "qualified", "compatibilityProfileId": "fish.timestamp-sse.v1"},
  {"providerId": "fish", "lane": "tts-direct-stream", "modelId": "s1", "admission": "qualified", "compatibilityProfileId": "fish.timestamp-sse.v1"},
  {"providerId": "fish", "lane": "stt-recorded", "modelId": "transcribe-1", "admission": "qualified", "compatibilityProfileId": "fish.upload-asr.v1"},
  {"providerId": "mistral", "lane": "tts-batch", "modelId": "voxtral-mini-tts-2603", "admission": "qualified", "compatibilityProfileId": "mistral.audio-speech-json.v1"},
  {"providerId": "mistral", "lane": "stt-recorded", "modelId": "voxtral-mini-latest", "admission": "qualified", "compatibilityProfileId": "mistral.recorded-segments.v1"},
  {"providerId": "mistral", "lane": "stt-recorded", "modelId": "voxtral-mini-2602", "admission": "qualified", "compatibilityProfileId": "mistral.recorded-segments.v1"},
  {"providerId": "minimax", "lane": "tts-batch", "modelId": "speech-2.8-hd", "admission": "qualified", "compatibilityProfileId": "minimax.http-hex.v1"},
  {"providerId": "minimax", "lane": "tts-batch", "modelId": "speech-2.8-turbo", "admission": "qualified", "compatibilityProfileId": "minimax.http-hex.v1"},
  {"providerId": "minimax", "lane": "tts-batch", "modelId": "speech-2.6-hd", "admission": "qualified", "compatibilityProfileId": "minimax.http-hex.v1"},
  {"providerId": "minimax", "lane": "tts-batch", "modelId": "speech-2.6-turbo", "admission": "qualified", "compatibilityProfileId": "minimax.http-hex.v1"},
  {"providerId": "minimax", "lane": "tts-batch", "modelId": "speech-02-hd", "admission": "qualified", "compatibilityProfileId": "minimax.http-hex.v1"},
  {"providerId": "minimax", "lane": "tts-batch", "modelId": "speech-02-turbo", "admission": "qualified", "compatibilityProfileId": "minimax.http-hex.v1"},
  {"providerId": "minimax", "lane": "tts-batch", "modelId": "speech-01-hd", "admission": "qualified", "compatibilityProfileId": "minimax.http-hex.v1"},
  {"providerId": "minimax", "lane": "tts-batch", "modelId": "speech-01-turbo", "admission": "qualified", "compatibilityProfileId": "minimax.http-hex.v1"},
  {"providerId": "mimo", "lane": "tts-batch", "modelId": "mimo-v2.5-tts", "admission": "qualified", "compatibilityProfileId": "mimo.chat-audio.v1"},
  {"providerId": "mimo", "lane": "tts-batch", "modelId": "mimo-v2.5-tts-voicedesign", "admission": "qualified", "compatibilityProfileId": "mimo.chat-voice-design.v1"},
  {"providerId": "mimo", "lane": "tts-batch", "modelId": "mimo-v2.5-tts-voiceclone", "admission": "qualified", "compatibilityProfileId": "mimo.chat-voice-clone.v1"},
  {"providerId": "mimo", "lane": "stt-recorded", "modelId": "mimo-v2.5-asr", "admission": "qualified", "compatibilityProfileId": "mimo.chat-asr.v1"},
  {"providerId": "alibaba", "lane": "tts-batch", "modelId": "qwen3-tts-flash", "admission": "qualified", "compatibilityProfileId": "alibaba.multimodal-tts.v1"},
  {"providerId": "alibaba", "lane": "tts-batch", "modelId": "qwen3-tts-instruct-flash", "admission": "qualified", "compatibilityProfileId": "alibaba.multimodal-tts.v1"},
  {"providerId": "alibaba", "lane": "tts-batch", "modelId": "qwen3-tts-vd-2026-01-26", "admission": "qualified", "compatibilityProfileId": "alibaba.multimodal-tts.v1"},
  {"providerId": "alibaba", "lane": "tts-batch", "modelId": "qwen3-tts-vc-2026-01-22", "admission": "qualified", "compatibilityProfileId": "alibaba.multimodal-tts.v1"},
  {"providerId": "inworld", "lane": "tts-batch", "modelId": "inworld-tts-2", "admission": "qualified", "compatibilityProfileId": "inworld.voice-json.v1"},
  {"providerId": "inworld", "lane": "tts-batch", "modelId": "inworld-tts-1.5-max", "admission": "qualified", "compatibilityProfileId": "inworld.voice-json.v1"},
  {"providerId": "inworld", "lane": "tts-batch", "modelId": "inworld-tts-1.5-mini", "admission": "qualified", "compatibilityProfileId": "inworld.voice-json.v1"},
  {"providerId": "inworld", "lane": "tts-batch", "modelId": "inworld-tts-1", "admission": "qualified", "compatibilityProfileId": "inworld.voice-json.v1"},
  {"providerId": "inworld", "lane": "tts-batch", "modelId": "inworld-tts-1-max", "admission": "qualified", "compatibilityProfileId": "inworld.voice-json.v1"},
  {"providerId": "inworld", "lane": "tts-direct-stream", "modelId": "inworld-tts-2", "admission": "qualified", "compatibilityProfileId": "inworld.voice-stream.v1"},
  {"providerId": "inworld", "lane": "tts-direct-stream", "modelId": "inworld-tts-1.5-max", "admission": "qualified", "compatibilityProfileId": "inworld.voice-stream.v1"},
  {"providerId": "inworld", "lane": "tts-direct-stream", "modelId": "inworld-tts-1.5-mini", "admission": "qualified", "compatibilityProfileId": "inworld.voice-stream.v1"},
  {"providerId": "inworld", "lane": "tts-direct-stream", "modelId": "inworld-tts-1", "admission": "qualified", "compatibilityProfileId": "inworld.voice-stream.v1"},
  {"providerId": "inworld", "lane": "tts-direct-stream", "modelId": "inworld-tts-1-max", "admission": "qualified", "compatibilityProfileId": "inworld.voice-stream.v1"},
  {"providerId": "cartesia", "lane": "tts-batch", "modelId": "sonic-3.5", "admission": "qualified", "compatibilityProfileId": "cartesia.bytes-20260301.v1"},
  {"providerId": "cartesia", "lane": "tts-batch", "modelId": "sonic-3", "admission": "qualified", "compatibilityProfileId": "cartesia.bytes-20260301.v1"},
  {"providerId": "cartesia", "lane": "tts-batch", "modelId": "sonic-latest", "admission": "qualified", "compatibilityProfileId": "cartesia.bytes-20260301.v1"},
  {"providerId": "async", "lane": "tts-batch", "modelId": "async_flash_v1.0", "admission": "qualified", "compatibilityProfileId": "async.bytes-v1.v1"},
  {"providerId": "async", "lane": "tts-batch", "modelId": "async_flash_v1.5", "admission": "qualified", "compatibilityProfileId": "async.bytes-v1.v1"},
  {"providerId": "async", "lane": "tts-batch", "modelId": "async_pro_v1.0", "admission": "qualified", "compatibilityProfileId": "async.bytes-v1.v1"},
  {"providerId": "stepfun", "lane": "tts-batch", "modelId": "step-tts-2", "admission": "qualified", "compatibilityProfileId": "stepfun.audio-speech.v1"},
  {"providerId": "stepfun", "lane": "tts-batch", "modelId": "stepaudio-2.5-tts", "admission": "qualified", "compatibilityProfileId": "stepfun.audio-speech.v1"},
  {"providerId": "azure", "lane": "tts-batch", "modelId": "azure-neural-tts", "admission": "qualified", "compatibilityProfileId": "azure.ssml-rest.v1"},
  {"providerId": "openai", "lane": "tts-batch", "modelId": "gpt-4o-mini-tts", "admission": "qualified", "compatibilityProfileId": "openai.speech-mini.v1"},
  {"providerId": "openai", "lane": "tts-batch", "modelId": "tts-1", "admission": "qualified", "compatibilityProfileId": "openai.speech-legacy.v1"},
  {"providerId": "openai", "lane": "tts-batch", "modelId": "tts-1-hd", "admission": "qualified", "compatibilityProfileId": "openai.speech-legacy.v1"},
  {"providerId": "deepgram", "lane": "tts-batch", "modelId": "aura-2-asteria-en", "admission": "qualified", "compatibilityProfileId": "deepgram.aura-rest.v1"},
  {"providerId": "deepgram", "lane": "tts-batch", "modelId": "flux-hannah-en", "admission": "qualified", "compatibilityProfileId": "deepgram.flux-rest.v1"},
  {"providerId": "openai", "lane": "stt-direct-realtime", "modelId": "gpt-realtime-whisper", "admission": "candidate"},
  {"providerId": "google", "lane": "tts-batch", "modelId": "gemini-3.8-flash-tts", "admission": "candidate"},
  {"providerId": "google", "lane": "tts-batch", "modelId": "gemini-3.8-flash-lite-tts", "admission": "candidate"},
  {"providerId": "openai", "lane": "stt-recorded", "modelId": "gpt-transcribe", "admission": "candidate"},
  {"providerId": "elevenlabs", "lane": "tts-batch", "modelId": "eleven_v4", "admission": "candidate"},
  {"providerId": "elevenlabs", "lane": "stt-recorded", "modelId": "scribe_v2_medical", "admission": "candidate"},
  {"providerId": "alibaba", "lane": "tts-batch", "modelId": "qwen-audio-3.1-tts-plus", "admission": "candidate"},
  {"providerId": "alibaba", "lane": "tts-batch", "modelId": "qwen-audio-3.1-tts-flash", "admission": "candidate"},
  {"providerId": "alibaba", "lane": "tts-batch", "modelId": "qwen-audio-3.0-tts-plus", "admission": "candidate"},
  {"providerId": "alibaba", "lane": "tts-batch", "modelId": "qwen-audio-3.0-tts-flash", "admission": "candidate"},
  {"providerId": "inworld", "lane": "tts-batch", "modelId": "inworld-tts-2-flash", "admission": "candidate"},
  {"providerId": "inworld", "lane": "tts-direct-stream", "modelId": "inworld-tts-2-flash", "admission": "candidate"},
  {"providerId": "cartesia", "lane": "tts-batch", "modelId": "sonic-3.6", "admission": "candidate"},
  {"providerId": "cartesia", "lane": "tts-batch", "modelId": "sonic-3.6-2026-08-27", "admission": "candidate"},
  {"providerId": "async", "lane": "stt-recorded", "modelId": "async_asr_v1.0", "admission": "candidate"},
  {"providerId": "stepfun", "lane": "tts-batch", "modelId": "stepaudio-3-tts", "admission": "candidate"},
  {"providerId": "elevenlabs", "lane": "stt-direct-realtime", "modelId": "scribe_v2_realtime", "admission": "candidate"},
  {"providerId": "mistral", "lane": "stt-direct-realtime", "modelId": "voxtral-mini-transcribe-realtime-2602", "admission": "candidate"},
  {"providerId": "mistral", "lane": "stt-recorded", "modelId": "voxtral-small-transcribe-3-0", "admission": "candidate"},
  {"providerId": "mistral", "lane": "stt-recorded", "modelId": "voxtral-small-transcribe-3", "admission": "candidate"},
  {"providerId": "mistral", "lane": "stt-recorded", "modelId": "voxtral-small-transcribe-latest", "admission": "candidate"}
] satisfies BuiltinVoiceCatalogBaselineBinding[]).map(binding => Object.freeze(binding)))

/** Installed same-contract rules. Source evaluators, not remote fields, issue these stamps. */
export const BUILTIN_VOICE_CATALOG_RULES: readonly BuiltinVoiceCatalogRule[] = Object.freeze(([
  { id: 'fish.timestamp-schema.v1', providerId: 'fish', lane: 'tts-direct-stream', compatibilityProfileId: 'fish.timestamp-sse.v1', sourceId: 'fish-public-voice-api-v1', parserId: 'fish-timestamp-openapi-json-v1' },
  { id: 'mistral.speech-docs.v1', providerId: 'mistral', lane: 'tts-batch', compatibilityProfileId: 'mistral.audio-speech-json.v1', sourceId: 'mistral-public-audio-docs-v1', parserId: 'mistral-audio-markdown-v1' },
  { id: 'mistral.transcribe-segments.v2', providerId: 'mistral', lane: 'stt-recorded', compatibilityProfileId: 'mistral.recorded-segments.v2', sourceId: 'mistral-public-audio-docs-v1', parserId: 'mistral-audio-markdown-v1' },
  { id: 'mistral.small-transcribe-docs.v1', providerId: 'mistral', lane: 'stt-recorded', compatibilityProfileId: 'mistral.recorded-segments.v2', sourceId: 'mistral-public-audio-docs-v1', parserId: 'mistral-small-identity-v1' },
  { id: 'minimax.t2a-schema.v1', providerId: 'minimax', lane: 'tts-batch', compatibilityProfileId: 'minimax.http-hex.v1', sourceId: 'minimax-public-tts-spec-v1', parserId: 'voice-contract-documents-v1' },
  { id: 'deepgram.aura-metadata.v1', providerId: 'deepgram', lane: 'tts-batch', compatibilityProfileId: 'deepgram.aura-rest.v1', sourceId: 'deepgram-public-models-v1', parserId: 'deepgram-public-models-json-v1' },
  { id: 'deepgram.recorded-metadata.v1', providerId: 'deepgram', lane: 'stt-recorded', compatibilityProfileId: 'deepgram.recorded-listen.v1', sourceId: 'deepgram-public-models-v1', parserId: 'deepgram-public-models-json-v1' },
  { id: 'google.interactions-tts-docs.v1', providerId: 'google', lane: 'tts-batch', compatibilityProfileId: 'google.interactions-tts.v1', sourceId: 'google-audio-docs-v1', parserId: 'google-interactions-tts-docs-v1' },
  { id: 'openai.transcribe-docs.v2', providerId: 'openai', lane: 'stt-recorded', compatibilityProfileId: 'openai.file-transcription.v2', sourceId: 'openai-audio-docs-v1', parserId: 'openai-transcribe-docs-v2' },
  { id: 'elevenlabs.scribe-medical-docs.v1', providerId: 'elevenlabs', lane: 'stt-recorded', compatibilityProfileId: 'elevenlabs.scribe-upload.v1', sourceId: 'elevenlabs-public-models-v1', parserId: 'elevenlabs-scribe-docs-v1' },
  { id: 'elevenlabs.speech-v4-docs.v1', providerId: 'elevenlabs', lane: 'tts-batch', compatibilityProfileId: 'elevenlabs.rest-speech-v4.v1', sourceId: 'elevenlabs-public-models-v1', parserId: 'elevenlabs-speech-v4-docs-v1' },
  { id: 'alibaba.audio-http-docs.v1', providerId: 'alibaba', lane: 'tts-batch', compatibilityProfileId: 'alibaba.audio-http.v1', sourceId: 'alibaba-public-audio-docs-v1', parserId: 'alibaba-audio-http-docs-v1' },
  { id: 'inworld.flash-docs.v1', providerId: 'inworld', lane: 'tts-batch', compatibilityProfileId: 'inworld.voice-json-flash.v1', sourceId: 'inworld-public-tts-docs-v1', parserId: 'inworld-flash-docs-v1' },
  { id: 'cartesia.sonic-36-docs.v1', providerId: 'cartesia', lane: 'tts-batch', compatibilityProfileId: 'cartesia.bytes-20260814.v1', sourceId: 'cartesia-public-sonic-docs-v1', parserId: 'cartesia-sonic-36-docs-v1' },
  { id: 'async.asr-docs.v1', providerId: 'async', lane: 'stt-recorded', compatibilityProfileId: 'async.recorded-upload.v1', sourceId: 'async-public-audio-docs-v1', parserId: 'async-asr-docs-v1' },
  { id: 'stepfun.speech-3-docs.v1', providerId: 'stepfun', lane: 'tts-batch', compatibilityProfileId: 'stepfun.audio-speech-3.v1', sourceId: 'stepfun-public-audio-docs-v1', parserId: 'stepfun-speech-3-docs-v1' }
] satisfies Omit<BuiltinVoiceCatalogRule, 'requalifyFrom'>[]).map(rule => Object.freeze({ ...rule, requalifyFrom: Object.freeze(rule.id === 'mistral.transcribe-segments.v2' ? ['mistral.recorded-segments.v1', rule.compatibilityProfileId] : [rule.compatibilityProfileId]) })))

export const BUILTIN_VOICE_CATALOG_CONTEXT: BuiltinVoiceCatalogContext = Object.freeze({
  rules: BUILTIN_VOICE_CATALOG_RULES,
  profiles: BUILTIN_VOICE_CATALOG_PROFILES,
  sources: BUILTIN_VOICE_CATALOG_SOURCES,
  baseline: BUILTIN_VOICE_CATALOG_BASELINE
})
