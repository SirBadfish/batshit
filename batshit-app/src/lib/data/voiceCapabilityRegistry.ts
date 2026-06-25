import type {
  VoiceProviderOptionBlock,
  VoiceProviderOptionValue,
  VoiceProviderId,
  VoiceSttCapabilityProfile
} from '$lib/types/voice'

export type VoiceFieldScope = 'tts' | 'stt'
export type VoiceFieldSurface = 'global' | 'agent' | 'both'
export type VoiceFieldType = 'string' | 'number' | 'boolean' | 'select'

export type VoiceCapabilityField = {
  id: string
  scope: VoiceFieldScope
  surface: VoiceFieldSurface
  type: VoiceFieldType
  path: string
  label: string
  help?: string
  required?: boolean
  defaultValue?: unknown
  options?: string[]
  min?: number
  max?: number
  step?: number
}

export type VoiceProviderCapability = {
  providerId: VoiceProviderId
  label: string
  supports: {
    tts: boolean
    stt: boolean
    listVoices: boolean
    clone: boolean
    streaming: boolean
  }
  sttCapabilities?: VoiceSttCapabilityProfile
  modelSource: 'static' | 'remote' | 'manual'
  voiceSource: 'none' | 'static' | 'remote' | 'profile'
  fields: VoiceCapabilityField[]
}

export type VoiceValidationScope = 'tts' | 'stt'

export type ValidatedVoiceOptions = {
  common?: VoiceProviderOptionBlock
  providerOptions?: VoiceProviderOptionBlock
  language?: string
}

const OPENAI_FORMAT_OPTIONS = ['mp3', 'opus', 'aac', 'flac', 'wav', 'pcm']
const BASIC_AUDIO_FORMAT_OPTIONS = ['mp3', 'wav', 'flac']
const DEEPGRAM_ENCODING_OPTIONS = ['linear16', 'mulaw', 'alaw', 'mp3', 'opus', 'flac']
const DEEPGRAM_CONTAINER_OPTIONS = ['wav', 'ogg', 'none']
const FISH_FORMAT_OPTIONS = ['pcm']
const FISH_SAMPLE_RATE_OPTIONS = ['16000', '24000', '32000', '44100']
const FISH_LATENCY_OPTIONS = ['balanced', 'low', 'normal']
const INWORLD_AUDIO_ENCODING_OPTIONS = ['LINEAR16', 'MP3', 'OGG_OPUS']
const INWORLD_DELIVERY_MODE_OPTIONS = ['DELIVERY_MODE_UNSPECIFIED', 'STABLE', 'BALANCED', 'CREATIVE']
const INWORLD_TEXT_NORMALIZATION_OPTIONS = ['APPLY_TEXT_NORMALIZATION_UNSPECIFIED', 'ON', 'OFF']
const INWORLD_TIMESTAMP_TYPE_OPTIONS = ['TIMESTAMP_TYPE_UNSPECIFIED', 'WORD', 'CHARACTER']
const INWORLD_TIMESTAMP_TRANSPORT_OPTIONS = [
  'TIMESTAMP_TRANSPORT_STRATEGY_UNSPECIFIED',
  'SYNC',
  'ASYNC'
]
const CARTESIA_CONTAINER_OPTIONS = ['mp3', 'wav', 'raw']
const CARTESIA_LANGUAGE_OPTIONS = ['en', 'fr', 'de', 'es', 'pt', 'zh', 'ja', 'hi', 'it', 'ko', 'nl', 'pl', 'ru', 'sv', 'tr', 'tl']
const ASYNC_CONTAINER_OPTIONS = ['mp3', 'wav', 'raw']
const ASYNC_ENCODING_OPTIONS = ['pcm_f32le', 'pcm_s16le', 'pcm_mulaw']
const STEPFUN_SAMPLE_RATE_OPTIONS = ['8000', '16000', '22050', '24000', '48000']
const AZURE_OUTPUT_FORMAT_OPTIONS = [
  'audio-24khz-48kbitrate-mono-mp3',
  'audio-24khz-96kbitrate-mono-mp3',
  'riff-24khz-16bit-mono-pcm',
  'riff-16khz-16bit-mono-pcm',
  'ogg-24khz-16bit-mono-opus'
]
const QWEN_SUITE_PROVIDER_ID = 'byo:qwen3-tts' as const

export const BROWSER_STT_CAPABILITIES: VoiceSttCapabilityProfile = {
  recorded: false,
  realtime: true,
  turnDetection: true,
  vad: true,
  partialResults: true,
  finalResults: true,
  wordTimestamps: false,
  diarization: false,
  languageDetection: false,
  keyterms: false,
  transport: 'browser-api',
  runtimeSupport: 'supported',
  cost: 'free',
  privacy: 'browser-dependent',
  setupWeight: 'none',
  runtimeLabel: 'Free browser voice input',
  notes: [
    'Continuous Voice Mode uses the browser speech-recognition engine, so support and privacy behavior vary by browser.'
  ]
}

export const OPENAI_STT_CAPABILITIES: VoiceSttCapabilityProfile = {
  recorded: true,
  realtime: false,
  turnDetection: true,
  vad: true,
  partialResults: true,
  finalResults: true,
  wordTimestamps: true,
  diarization: true,
  languageDetection: true,
  keyterms: false,
  transport: 'provider-realtime-session',
  runtimeSupport: 'candidate',
  cost: 'paid',
  privacy: 'cloud',
  setupWeight: 'light',
  runtimeLabel: 'Recorded now; realtime candidate',
  unsupportedReason: 'Batshit has not wired OpenAI realtime transcription sessions into Voice Mode yet.',
  notes: [
    'The recorded transcription lane uses OpenAI audio transcription models.',
    'Realtime transcription sessions are tracked as a separate future voice-session lane.'
  ]
}

export const DEEPGRAM_STT_CAPABILITIES: VoiceSttCapabilityProfile = {
  recorded: true,
  realtime: true,
  turnDetection: true,
  vad: true,
  partialResults: true,
  finalResults: true,
  wordTimestamps: true,
  diarization: false,
  languageDetection: true,
  keyterms: true,
  transport: 'provider-websocket',
  runtimeSupport: 'supported',
  cost: 'paid',
  privacy: 'cloud',
  setupWeight: 'light',
  runtimeLabel: 'Recorded STT plus Flux realtime voice input',
  notes: [
    'Nova-family models are the current recorded-audio STT lane.',
    'Flux is the first direct cloud realtime STT lane because it includes model-integrated end-of-turn behavior.',
    'Browser Voice Mode uses a short-lived Deepgram token for the Flux WebSocket so the saved API key stays server-side.'
  ]
}

export const FISH_STT_CAPABILITIES: VoiceSttCapabilityProfile = {
  recorded: true,
  realtime: false,
  turnDetection: false,
  vad: false,
  partialResults: false,
  finalResults: true,
  wordTimestamps: true,
  diarization: false,
  languageDetection: false,
  keyterms: false,
  transport: 'http-upload',
  runtimeSupport: 'supported',
  cost: 'paid',
  privacy: 'cloud',
  setupWeight: 'light',
  runtimeLabel: 'Recorded Fish ASR',
  unsupportedReason: 'Fish ASR is an uploaded-audio endpoint in current docs, not a realtime microphone session.',
  notes: ['Fish ASR is available for uploaded audio. It should not be presented as realtime STT.']
}

export const ELEVENLABS_STT_CAPABILITIES: VoiceSttCapabilityProfile = {
  recorded: true,
  realtime: false,
  turnDetection: false,
  vad: false,
  partialResults: false,
  finalResults: true,
  wordTimestamps: true,
  diarization: true,
  languageDetection: true,
  keyterms: true,
  transport: 'http-upload',
  runtimeSupport: 'supported',
  cost: 'paid',
  privacy: 'cloud',
  setupWeight: 'light',
  runtimeLabel: 'Recorded ElevenLabs Scribe STT',
  unsupportedReason:
    'ElevenLabs Scribe realtime still needs a Batshit-owned token bridge and live microphone smoke before it is offered as direct Voice Mode STT.',
  notes: [
    'ElevenLabs Scribe supports uploaded audio/video transcription through the speech-to-text endpoint.',
    'Realtime Scribe is tracked separately from recorded STT because it needs a different browser/session bridge.'
  ]
}

export const MISTRAL_STT_CAPABILITIES: VoiceSttCapabilityProfile = {
  recorded: true,
  realtime: false,
  turnDetection: false,
  vad: false,
  partialResults: false,
  finalResults: true,
  wordTimestamps: true,
  diarization: true,
  languageDetection: true,
  keyterms: true,
  transport: 'http-upload',
  runtimeSupport: 'supported',
  cost: 'paid',
  privacy: 'cloud',
  setupWeight: 'light',
  runtimeLabel: 'Recorded Mistral Voxtral STT',
  unsupportedReason:
    'Mistral realtime transcription has a separate realtime SDK/session contract; Batshit has not built that direct Voice Mode bridge yet.',
  notes: [
    'Mistral Voxtral transcription is available for uploaded audio through /v1/audio/transcriptions.',
    'Mistral realtime transcription should be added only after a dedicated bridge and smoke proof.'
  ]
}

export const BYO_STT_CAPABILITIES: VoiceSttCapabilityProfile = {
  recorded: true,
  realtime: false,
  turnDetection: false,
  vad: false,
  partialResults: false,
  finalResults: true,
  wordTimestamps: false,
  diarization: false,
  languageDetection: false,
  keyterms: false,
  transport: 'byo-runtime',
  runtimeSupport: 'supported',
  cost: 'varies',
  privacy: 'byo',
  setupWeight: 'medium',
  runtimeLabel: 'BYO recorded STT',
  unsupportedReason: 'Realtime BYO STT requires an explicit engine contract; Batshit only owns uploaded-audio BYO STT today.',
  notes: ['BYO STT behavior depends on the registered engine contract and verified request shape.']
}

const openaiFields: VoiceCapabilityField[] = [
  {
    id: 'speed',
    scope: 'tts',
    surface: 'both',
    type: 'number',
    path: 'common.speed',
    label: 'Speed',
    help: 'Speech speed multiplier for OpenAI TTS.',
    defaultValue: 1,
    min: 0.25,
    max: 4,
    step: 0.05
  },
  {
    id: 'instructions',
    scope: 'tts',
    surface: 'both',
    type: 'string',
    path: 'common.instructions',
    label: 'Instructions',
    help: 'Style guidance for OpenAI voices.'
  },
  {
    id: 'format',
    scope: 'tts',
    surface: 'both',
    type: 'select',
    path: 'providerOptions.openai.format',
    label: 'Audio format',
    options: OPENAI_FORMAT_OPTIONS,
    defaultValue: 'mp3'
  },
  {
    id: 'language',
    scope: 'stt',
    surface: 'global',
    type: 'string',
    path: 'language',
    label: 'Language',
    help: 'Optional language hint for transcription.'
  }
]

const elevenLabsFields: VoiceCapabilityField[] = [
  {
    id: 'speed',
    scope: 'tts',
    surface: 'both',
    type: 'number',
    path: 'common.speed',
    label: 'Speed',
    help: 'Speech speed multiplier for ElevenLabs.',
    defaultValue: 1,
    min: 0.25,
    max: 4,
    step: 0.05
  },
  {
    id: 'language',
    scope: 'tts',
    surface: 'both',
    type: 'string',
    path: 'common.language',
    label: 'Language code',
    help: 'Optional language code for multilingual voice output.'
  },
  {
    id: 'stability',
    scope: 'tts',
    surface: 'both',
    type: 'number',
    path: 'providerOptions.elevenlabs.stability',
    label: 'Stability',
    min: 0,
    max: 1,
    step: 0.01
  },
  {
    id: 'similarityBoost',
    scope: 'tts',
    surface: 'both',
    type: 'number',
    path: 'providerOptions.elevenlabs.similarityBoost',
    label: 'Similarity boost',
    min: 0,
    max: 1,
    step: 0.01
  },
  {
    id: 'style',
    scope: 'tts',
    surface: 'both',
    type: 'number',
    path: 'providerOptions.elevenlabs.style',
    label: 'Style',
    min: 0,
    max: 1,
    step: 0.01
  },
  {
    id: 'speakerBoost',
    scope: 'tts',
    surface: 'both',
    type: 'boolean',
    path: 'providerOptions.elevenlabs.speakerBoost',
    label: 'Speaker boost'
  },
  {
    id: 'language',
    scope: 'stt',
    surface: 'global',
    type: 'string',
    path: 'language',
    label: 'Language',
    help: 'Optional language hint for ElevenLabs Scribe transcription.'
  }
]

const deepgramFields: VoiceCapabilityField[] = [
  {
    id: 'encoding',
    scope: 'tts',
    surface: 'both',
    type: 'select',
    path: 'providerOptions.deepgram.encoding',
    label: 'Encoding',
    options: DEEPGRAM_ENCODING_OPTIONS
  },
  {
    id: 'container',
    scope: 'tts',
    surface: 'both',
    type: 'select',
    path: 'providerOptions.deepgram.container',
    label: 'Container',
    options: DEEPGRAM_CONTAINER_OPTIONS
  },
  {
    id: 'language',
    scope: 'stt',
    surface: 'global',
    type: 'string',
    path: 'language',
    label: 'Language',
    help: 'Optional language hint for transcription.'
  }
]

const fishFields: VoiceCapabilityField[] = [
  {
    id: 'format',
    scope: 'tts',
    surface: 'both',
    type: 'select',
    path: 'providerOptions.fish.format',
    label: 'Audio format',
    options: FISH_FORMAT_OPTIONS,
    defaultValue: 'pcm'
  },
  {
    id: 'sampleRate',
    scope: 'tts',
    surface: 'both',
    type: 'select',
    path: 'providerOptions.fish.sample_rate',
    label: 'Sample rate',
    options: FISH_SAMPLE_RATE_OPTIONS,
    defaultValue: '24000'
  },
  {
    id: 'latency',
    scope: 'tts',
    surface: 'both',
    type: 'select',
    path: 'providerOptions.fish.latency',
    label: 'Latency',
    options: FISH_LATENCY_OPTIONS,
    defaultValue: 'balanced'
  },
  {
    id: 'chunkLength',
    scope: 'tts',
    surface: 'both',
    type: 'number',
    path: 'providerOptions.fish.chunk_length',
    label: 'Chunk length',
    help: 'Lower values start sooner; higher values may sound smoother.',
    defaultValue: 200,
    min: 100,
    max: 300,
    step: 10
  },
  {
    id: 'temperature',
    scope: 'tts',
    surface: 'both',
    type: 'number',
    path: 'providerOptions.fish.temperature',
    label: 'Temperature',
    min: 0,
    max: 1,
    step: 0.05
  },
  {
    id: 'topP',
    scope: 'tts',
    surface: 'both',
    type: 'number',
    path: 'providerOptions.fish.top_p',
    label: 'Top P',
    min: 0,
    max: 1,
    step: 0.05
  },
  {
    id: 'speed',
    scope: 'tts',
    surface: 'both',
    type: 'number',
    path: 'common.speed',
    label: 'Speed',
    min: 0.5,
    max: 2,
    step: 0.05
  },
  {
    id: 'volume',
    scope: 'tts',
    surface: 'both',
    type: 'number',
    path: 'common.volume',
    label: 'Volume',
    min: -20,
    max: 20,
    step: 1
  },
  {
    id: 'language',
    scope: 'stt',
    surface: 'global',
    type: 'string',
    path: 'language',
    label: 'Language',
    help: 'Optional language hint for Fish uploaded-audio transcription.'
  }
]

const mistralFields: VoiceCapabilityField[] = [
  {
    id: 'language',
    scope: 'stt',
    surface: 'global',
    type: 'string',
    path: 'language',
    label: 'Language',
    help: 'Optional language hint for Mistral transcription.'
  },
  {
    id: 'responseFormat',
    scope: 'tts',
    surface: 'both',
    type: 'select',
    path: 'providerOptions.mistral.response_format',
    label: 'Audio format',
    options: ['mp3', 'wav', 'pcm', 'flac', 'opus'],
    defaultValue: 'mp3'
  }
]

const minimaxFields: VoiceCapabilityField[] = [
  {
    id: 'speed',
    scope: 'tts',
    surface: 'both',
    type: 'number',
    path: 'common.speed',
    label: 'Speed',
    defaultValue: 1,
    min: 0.5,
    max: 2,
    step: 0.05
  },
  {
    id: 'volume',
    scope: 'tts',
    surface: 'both',
    type: 'number',
    path: 'common.volume',
    label: 'Volume',
    defaultValue: 1,
    min: 0.1,
    max: 2,
    step: 0.05
  },
  {
    id: 'pitch',
    scope: 'tts',
    surface: 'both',
    type: 'number',
    path: 'providerOptions.minimax.pitch',
    label: 'Pitch',
    defaultValue: 0,
    min: -12,
    max: 12,
    step: 1
  },
  {
    id: 'format',
    scope: 'tts',
    surface: 'both',
    type: 'select',
    path: 'providerOptions.minimax.format',
    label: 'Audio format',
    options: BASIC_AUDIO_FORMAT_OPTIONS,
    defaultValue: 'mp3'
  },
  {
    id: 'sampleRate',
    scope: 'tts',
    surface: 'both',
    type: 'select',
    path: 'providerOptions.minimax.sample_rate',
    label: 'Sample rate',
    options: ['16000', '24000', '32000', '44100'],
    defaultValue: '32000'
  },
  {
    id: 'bitrate',
    scope: 'tts',
    surface: 'both',
    type: 'number',
    path: 'providerOptions.minimax.bitrate',
    label: 'Bitrate',
    defaultValue: 128000,
    min: 32000,
    max: 256000,
    step: 1000
  },
  {
    id: 'languageBoost',
    scope: 'tts',
    surface: 'both',
    type: 'string',
    path: 'providerOptions.minimax.language_boost',
    label: 'Language boost',
    help: 'Optional MiniMax language boost, such as English, Chinese, Japanese, or auto.'
  }
]

const mimoFields: VoiceCapabilityField[] = [
  {
    id: 'instructions',
    scope: 'tts',
    surface: 'both',
    type: 'string',
    path: 'common.instructions',
    label: 'Instructions',
    help: 'Natural-language style guidance sent as the optional MiMo user message.'
  },
  {
    id: 'format',
    scope: 'tts',
    surface: 'both',
    type: 'select',
    path: 'providerOptions.mimo.format',
    label: 'Audio format',
    options: ['wav', 'pcm16'],
    defaultValue: 'wav'
  }
]

const alibabaFields: VoiceCapabilityField[] = [
  {
    id: 'language',
    scope: 'tts',
    surface: 'both',
    type: 'string',
    path: 'common.language',
    label: 'Language type',
    help: 'Optional Qwen TTS language_type value, such as English or Chinese.'
  },
  {
    id: 'instructions',
    scope: 'tts',
    surface: 'both',
    type: 'string',
    path: 'common.instructions',
    label: 'Instructions',
    help: 'Instruction text for Qwen instruct TTS models.'
  }
]

const inworldFields: VoiceCapabilityField[] = [
  {
    id: 'language',
    scope: 'tts',
    surface: 'both',
    type: 'string',
    path: 'common.language',
    label: 'Language code',
    help: 'Optional BCP-47 language hint, such as en-US or ja-JP.'
  },
  {
    id: 'audioEncoding',
    scope: 'tts',
    surface: 'both',
    type: 'select',
    path: 'providerOptions.inworld.audioEncoding',
    label: 'Audio encoding',
    options: INWORLD_AUDIO_ENCODING_OPTIONS,
    defaultValue: 'LINEAR16'
  },
  {
    id: 'sampleRate',
    scope: 'tts',
    surface: 'both',
    type: 'number',
    path: 'providerOptions.inworld.sampleRateHertz',
    label: 'Sample rate',
    defaultValue: 22050,
    min: 8000,
    max: 48000,
    step: 50
  },
  {
    id: 'deliveryMode',
    scope: 'tts',
    surface: 'both',
    type: 'select',
    path: 'providerOptions.inworld.deliveryMode',
    label: 'Delivery mode',
    options: INWORLD_DELIVERY_MODE_OPTIONS,
    defaultValue: 'BALANCED'
  },
  {
    id: 'textNormalization',
    scope: 'tts',
    surface: 'both',
    type: 'select',
    path: 'providerOptions.inworld.applyTextNormalization',
    label: 'Text normalization',
    options: INWORLD_TEXT_NORMALIZATION_OPTIONS,
    defaultValue: 'ON'
  },
  {
    id: 'timestampType',
    scope: 'tts',
    surface: 'both',
    type: 'select',
    path: 'providerOptions.inworld.timestampType',
    label: 'Timestamps',
    help: 'WORD enables word timing plus phoneme/viseme details for TTS 1.5 and TTS-2.',
    options: INWORLD_TIMESTAMP_TYPE_OPTIONS,
    defaultValue: 'WORD'
  },
  {
    id: 'timestampTransport',
    scope: 'tts',
    surface: 'both',
    type: 'select',
    path: 'providerOptions.inworld.timestampTransportStrategy',
    label: 'Timestamp transport',
    help: 'SYNC keeps audio and timing together for live lip sync. ASYNC can start audio sooner but timing arrives later.',
    options: INWORLD_TIMESTAMP_TRANSPORT_OPTIONS,
    defaultValue: 'SYNC'
  }
]

const cartesiaFields: VoiceCapabilityField[] = [
  {
    id: 'speed',
    scope: 'tts',
    surface: 'both',
    type: 'number',
    path: 'common.speed',
    label: 'Speed',
    defaultValue: 1,
    min: 0.5,
    max: 2,
    step: 0.05
  },
  {
    id: 'volume',
    scope: 'tts',
    surface: 'both',
    type: 'number',
    path: 'common.volume',
    label: 'Volume',
    defaultValue: 1,
    min: 0,
    max: 2,
    step: 0.05
  },
  {
    id: 'language',
    scope: 'tts',
    surface: 'both',
    type: 'select',
    path: 'common.language',
    label: 'Language',
    options: CARTESIA_LANGUAGE_OPTIONS
  },
  {
    id: 'container',
    scope: 'tts',
    surface: 'both',
    type: 'select',
    path: 'providerOptions.cartesia.container',
    label: 'Audio container',
    options: CARTESIA_CONTAINER_OPTIONS,
    defaultValue: 'mp3'
  }
]

const asyncFields: VoiceCapabilityField[] = [
  {
    id: 'container',
    scope: 'tts',
    surface: 'both',
    type: 'select',
    path: 'providerOptions.async.container',
    label: 'Audio container',
    options: ASYNC_CONTAINER_OPTIONS,
    defaultValue: 'mp3'
  },
  {
    id: 'encoding',
    scope: 'tts',
    surface: 'both',
    type: 'select',
    path: 'providerOptions.async.encoding',
    label: 'Raw encoding',
    options: ASYNC_ENCODING_OPTIONS,
    defaultValue: 'pcm_f32le'
  },
  {
    id: 'sampleRate',
    scope: 'tts',
    surface: 'both',
    type: 'number',
    path: 'providerOptions.async.sample_rate',
    label: 'Sample rate',
    defaultValue: 44100,
    min: 8000,
    max: 48000,
    step: 1000
  }
]

const stepfunFields: VoiceCapabilityField[] = [
  {
    id: 'speed',
    scope: 'tts',
    surface: 'both',
    type: 'number',
    path: 'common.speed',
    label: 'Speed',
    defaultValue: 1,
    min: 0.5,
    max: 2,
    step: 0.05
  },
  {
    id: 'volume',
    scope: 'tts',
    surface: 'both',
    type: 'number',
    path: 'common.volume',
    label: 'Volume',
    defaultValue: 1,
    min: 0.1,
    max: 2,
    step: 0.05
  },
  {
    id: 'instructions',
    scope: 'tts',
    surface: 'both',
    type: 'string',
    path: 'common.instructions',
    label: 'Instructions',
    help: 'Global guidance for stepaudio-2.5-tts.'
  },
  {
    id: 'responseFormat',
    scope: 'tts',
    surface: 'both',
    type: 'select',
    path: 'providerOptions.stepfun.response_format',
    label: 'Audio format',
    options: ['mp3', 'wav', 'flac', 'opus', 'pcm'],
    defaultValue: 'mp3'
  },
  {
    id: 'sampleRate',
    scope: 'tts',
    surface: 'both',
    type: 'select',
    path: 'providerOptions.stepfun.sample_rate',
    label: 'Sample rate',
    options: STEPFUN_SAMPLE_RATE_OPTIONS,
    defaultValue: '24000'
  }
]

const azureFields: VoiceCapabilityField[] = [
  {
    id: 'language',
    scope: 'tts',
    surface: 'both',
    type: 'string',
    path: 'common.language',
    label: 'Language',
    help: 'SSML language tag, such as en-US.'
  },
  {
    id: 'outputFormat',
    scope: 'tts',
    surface: 'both',
    type: 'select',
    path: 'providerOptions.azure.output_format',
    label: 'Output format',
    options: AZURE_OUTPUT_FORMAT_OPTIONS,
    defaultValue: 'audio-24khz-48kbitrate-mono-mp3'
  }
]

const byoTtsFields: VoiceCapabilityField[] = [
  {
    id: 'speed',
    scope: 'tts',
    surface: 'both',
    type: 'number',
    path: 'common.speed',
    label: 'Speed',
    help: 'Optional speed hint forwarded to your BYO adapter.',
    defaultValue: 1,
    min: 0.25,
    max: 4,
    step: 0.05
  },
  {
    id: 'language',
    scope: 'tts',
    surface: 'both',
    type: 'string',
    path: 'common.language',
    label: 'Language',
    help: 'Optional language hint forwarded to your BYO adapter.'
  },
  {
    id: 'instructions',
    scope: 'tts',
    surface: 'both',
    type: 'string',
    path: 'common.instructions',
    label: 'Instructions',
    help: 'Optional style notes forwarded to your BYO adapter.'
  }
]

const qwenSuiteTtsFields: VoiceCapabilityField[] = [
  {
    id: 'qwenMode',
    scope: 'tts',
    surface: 'both',
    type: 'select',
    path: `providerOptions.${QWEN_SUITE_PROVIDER_ID}.qwen_mode`,
    label: 'Qwen feature',
    help:
      'Use preset speakers, or switch to VoiceDesign to create a voice from the Instructions field. Qwen clone profiles route automatically.',
    options: ['custom_voice', 'voice_design'],
    defaultValue: 'custom_voice'
  },
  {
    id: 'speed',
    scope: 'tts',
    surface: 'both',
    type: 'number',
    path: 'common.speed',
    label: 'Speed',
    help: 'Optional speed hint forwarded to the active Qwen lane.',
    defaultValue: 1,
    min: 0.25,
    max: 4,
    step: 0.05
  },
  {
    id: 'language',
    scope: 'tts',
    surface: 'both',
    type: 'string',
    path: 'common.language',
    label: 'Language',
    help: 'Optional language hint forwarded to the active Qwen lane.'
  },
  {
    id: 'instructions',
    scope: 'tts',
    surface: 'both',
    type: 'string',
    path: 'common.instructions',
    label: 'Instructions',
    help:
      'For CustomVoice, use this for emotion/style. For VoiceDesign, describe the voice you want Batshit to create.'
  }
]

const byoSttFields: VoiceCapabilityField[] = [
  {
    id: 'language',
    scope: 'stt',
    surface: 'global',
    type: 'string',
    path: 'language',
    label: 'Language',
    help: 'Optional language hint forwarded to your BYO adapter.'
  }
]

const baseRegistry: VoiceProviderCapability[] = [
  {
    providerId: 'browser',
    label: 'Browser (Web Speech API)',
    supports: {
      tts: true,
      stt: true,
      listVoices: false,
      clone: false,
      streaming: false
    },
    sttCapabilities: BROWSER_STT_CAPABILITIES,
    modelSource: 'manual',
    voiceSource: 'none',
    fields: []
  },
  {
    providerId: 'google',
    label: 'Google Gemini',
    supports: {
      tts: true,
      stt: false,
      listVoices: true,
      clone: false,
      streaming: false
    },
    modelSource: 'static',
    voiceSource: 'static',
    fields: []
  },
  {
    providerId: 'openai',
    label: 'OpenAI',
    supports: {
      tts: true,
      stt: true,
      listVoices: true,
      clone: false,
      streaming: false
    },
    sttCapabilities: OPENAI_STT_CAPABILITIES,
    modelSource: 'static',
    voiceSource: 'static',
    fields: openaiFields
  },
  {
    providerId: 'elevenlabs',
    label: 'ElevenLabs',
    supports: {
      tts: true,
      stt: true,
      listVoices: true,
      clone: true,
      streaming: false
    },
    sttCapabilities: ELEVENLABS_STT_CAPABILITIES,
    modelSource: 'static',
    voiceSource: 'remote',
    fields: elevenLabsFields
  },
  {
    providerId: 'deepgram',
    label: 'Deepgram',
    supports: {
      tts: true,
      stt: true,
      listVoices: true,
      clone: false,
      streaming: false
    },
    sttCapabilities: DEEPGRAM_STT_CAPABILITIES,
    modelSource: 'static',
    voiceSource: 'static',
    fields: deepgramFields
  },
  {
    providerId: 'fish',
    label: 'Fish Audio',
    supports: {
      tts: true,
      stt: true,
      listVoices: true,
      clone: false,
      streaming: true
    },
    sttCapabilities: FISH_STT_CAPABILITIES,
    modelSource: 'static',
    voiceSource: 'remote',
    fields: fishFields
  },
  {
    providerId: 'mistral',
    label: 'Mistral Voxtral',
    supports: {
      tts: true,
      stt: true,
      listVoices: true,
      clone: true,
      streaming: false
    },
    sttCapabilities: MISTRAL_STT_CAPABILITIES,
    modelSource: 'static',
    voiceSource: 'remote',
    fields: mistralFields
  },
  {
    providerId: 'minimax',
    label: 'MiniMax',
    supports: {
      tts: true,
      stt: false,
      listVoices: true,
      clone: false,
      streaming: false
    },
    modelSource: 'static',
    voiceSource: 'remote',
    fields: minimaxFields
  },
  {
    providerId: 'mimo',
    label: 'MiMo',
    supports: {
      tts: true,
      stt: false,
      listVoices: true,
      clone: false,
      streaming: false
    },
    modelSource: 'static',
    voiceSource: 'static',
    fields: mimoFields
  },
  {
    providerId: 'alibaba',
    label: 'Alibaba Cloud Qwen TTS',
    supports: {
      tts: true,
      stt: false,
      listVoices: true,
      clone: false,
      streaming: false
    },
    modelSource: 'static',
    voiceSource: 'static',
    fields: alibabaFields
  },
  {
    providerId: 'inworld',
    label: 'Inworld',
    supports: {
      tts: true,
      stt: false,
      listVoices: true,
      clone: false,
      streaming: true
    },
    modelSource: 'static',
    voiceSource: 'remote',
    fields: inworldFields
  },
  {
    providerId: 'cartesia',
    label: 'Cartesia',
    supports: {
      tts: true,
      stt: false,
      listVoices: true,
      clone: false,
      streaming: false
    },
    modelSource: 'static',
    voiceSource: 'remote',
    fields: cartesiaFields
  },
  {
    providerId: 'async',
    label: 'Async Voice',
    supports: {
      tts: true,
      stt: false,
      listVoices: true,
      clone: false,
      streaming: false
    },
    modelSource: 'static',
    voiceSource: 'remote',
    fields: asyncFields
  },
  {
    providerId: 'stepfun',
    label: 'StepFun',
    supports: {
      tts: true,
      stt: false,
      listVoices: true,
      clone: false,
      streaming: false
    },
    modelSource: 'static',
    voiceSource: 'static',
    fields: stepfunFields
  },
  {
    providerId: 'azure',
    label: 'Microsoft Azure Speech',
    supports: {
      tts: true,
      stt: false,
      listVoices: true,
      clone: false,
      streaming: false
    },
    modelSource: 'static',
    voiceSource: 'remote',
    fields: azureFields
  },
  {
    providerId: 'byo',
    label: 'BYO Speech Adapter',
    supports: {
      tts: true,
      stt: true,
      listVoices: false,
      clone: false,
      streaming: false
    },
    sttCapabilities: BYO_STT_CAPABILITIES,
    modelSource: 'manual',
    voiceSource: 'none',
    fields: [...byoTtsFields, ...byoSttFields]
  }
]

export const VOICE_CAPABILITY_REGISTRY_V1: VoiceProviderCapability[] = [...baseRegistry]

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function validateFieldValue(field: VoiceCapabilityField, value: unknown): VoiceProviderOptionValue {
  if (field.type === 'boolean') {
    if (typeof value !== 'boolean') {
      throw new Error(`${field.label} must be true or false.`)
    }
    return value
  }

  if (field.type === 'number') {
    const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
    if (!Number.isFinite(parsed)) {
      throw new Error(`${field.label} must be a valid number.`)
    }
    if (typeof field.min === 'number' && parsed < field.min) {
      throw new Error(`${field.label} must be ${field.min} or higher.`)
    }
    if (typeof field.max === 'number' && parsed > field.max) {
      throw new Error(`${field.label} must be ${field.max} or lower.`)
    }
    return parsed
  }

  if (field.type === 'select') {
    const normalized = normalizeString(value)
    if (!normalized) {
      throw new Error(`${field.label} must be selected.`)
    }
    if (Array.isArray(field.options) && !field.options.includes(normalized)) {
      throw new Error(`${field.label} value "${normalized}" is not supported.`)
    }
    return normalized
  }

  const normalized = normalizeString(value)
  if (!normalized) {
    throw new Error(`${field.label} cannot be empty.`)
  }
  return normalized
}

function validateByoPassthroughValue(
  optionLabel: string,
  value: unknown
): VoiceProviderOptionValue {
  if (typeof value === 'boolean') return value

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`BYO ${optionLabel} must be a valid number.`)
    }
    return value
  }

  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) {
      throw new Error(`BYO ${optionLabel} cannot be empty.`)
    }
    return trimmed
  }

  throw new Error(`BYO ${optionLabel} must be a string, number, or boolean.`)
}

export function getVoiceProviderCapability(providerId: string): VoiceProviderCapability | undefined {
  const direct = VOICE_CAPABILITY_REGISTRY_V1.find((capability) => capability.providerId === providerId)
  if (direct) return direct

  if (providerId === QWEN_SUITE_PROVIDER_ID) {
    return {
      providerId,
      label: 'Qwen3 TTS Suite',
      supports: {
        tts: true,
        stt: false,
        listVoices: true,
        clone: true,
        streaming: false
      },
      modelSource: 'manual',
      voiceSource: 'static',
      fields: qwenSuiteTtsFields
    }
  }

  if (providerId.startsWith('byo:')) {
    const template = VOICE_CAPABILITY_REGISTRY_V1.find((capability) => capability.providerId === 'byo')
    if (!template) return undefined

    return {
      ...template,
      providerId: providerId as VoiceProviderId,
      label: 'BYO Speech Provider'
    }
  }

  return undefined
}

export function getVoiceCapabilityFields(
  providerId: string,
  scope: VoiceFieldScope,
  surface: VoiceFieldSurface
): VoiceCapabilityField[] {
  const capability = getVoiceProviderCapability(providerId)
  if (!capability) return []

  return capability.fields.filter((field) => {
    if (field.scope !== scope) return false
    if (surface === 'global') {
      return field.surface === 'global' || field.surface === 'both'
    }
    if (surface === 'agent') {
      return field.surface === 'agent' || field.surface === 'both'
    }
    return true
  })
}

export function validateVoiceOptionsForProvider(
  providerId: string,
  scope: VoiceValidationScope,
  payload: {
    common?: unknown
    providerOptions?: unknown
    language?: unknown
  }
): ValidatedVoiceOptions {
  const isByoProvider = providerId === 'byo' || providerId.startsWith('byo:')
  const capability = getVoiceProviderCapability(providerId)
  if (!capability) {
    throw new Error(`Voice provider "${providerId}" is not supported.`)
  }

  if (scope === 'tts' && !capability.supports.tts) {
    throw new Error(`${capability.label} does not support text-to-speech.`)
  }
  if (scope === 'stt' && !capability.supports.stt) {
    throw new Error(`${capability.label} does not support speech-to-text.`)
  }

  const fields = getVoiceCapabilityFields(providerId, scope, 'both')
  const commonFieldMap = new Map<string, VoiceCapabilityField>()
  const providerFieldMap = new Map<string, VoiceCapabilityField>()
  const directFieldMap = new Map<string, VoiceCapabilityField>()

  for (const field of fields) {
    if (field.path.startsWith('common.')) {
      commonFieldMap.set(field.path.replace('common.', ''), field)
      continue
    }

    const providerPrefix = `providerOptions.${providerId}.`
    if (field.path.startsWith(providerPrefix)) {
      providerFieldMap.set(field.path.replace(providerPrefix, ''), field)
      continue
    }

    if (!field.path.includes('.')) {
      directFieldMap.set(field.path, field)
    }
  }

  const validated: ValidatedVoiceOptions = {}

  if (isObject(payload.common)) {
    const commonOutput: VoiceProviderOptionBlock = {}
    for (const [key, value] of Object.entries(payload.common)) {
      const field = commonFieldMap.get(key)
      if (!field) {
        if (!isByoProvider) {
          throw new Error(`${capability.label} does not support the common option "${key}".`)
        }
        commonOutput[key] = validateByoPassthroughValue(`common option "${key}"`, value)
        continue
      }
      commonOutput[key] = validateFieldValue(field, value)
    }
    if (Object.keys(commonOutput).length > 0) {
      validated.common = commonOutput
    }
  }

  let providerInput: Record<string, unknown> | null = null
  if (isObject(payload.providerOptions)) {
    if (isObject(payload.providerOptions[providerId])) {
      providerInput = payload.providerOptions[providerId] as Record<string, unknown>
    } else {
      providerInput = payload.providerOptions
    }
  }

  if (providerInput) {
    const providerOutput: VoiceProviderOptionBlock = {}
    for (const [key, value] of Object.entries(providerInput)) {
      const field = providerFieldMap.get(key)
      if (!field) {
        if (!isByoProvider) {
          throw new Error(`${capability.label} does not support provider option "${key}".`)
        }
        providerOutput[key] = validateByoPassthroughValue(`provider option "${key}"`, value)
        continue
      }
      providerOutput[key] = validateFieldValue(field, value)
    }
    if (Object.keys(providerOutput).length > 0) {
      validated.providerOptions = providerOutput
    }
  }

  const languageField = directFieldMap.get('language')
  if (languageField) {
    const sourceLanguage = payload.language
    if (sourceLanguage !== undefined && sourceLanguage !== null && sourceLanguage !== '') {
      validated.language = validateFieldValue(languageField, sourceLanguage) as string
    }
  }

  return validated
}
