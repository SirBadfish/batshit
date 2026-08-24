import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { env } from '$env/dynamic/private'
import {
  BROWSER_STT_CAPABILITIES,
  BYO_STT_CAPABILITIES,
  DEEPGRAM_STT_CAPABILITIES,
  ELEVENLABS_STT_CAPABILITIES,
  FISH_STT_CAPABILITIES,
  MISTRAL_STT_CAPABILITIES,
  OPENAI_STT_CAPABILITIES,
  validateVoiceOptionsForProvider
} from '$lib/data/voiceCapabilityRegistry'
import {
  apiKeyService,
  isUserFacingApiKeyService,
  normalizeApiKeyServiceName
} from '$lib/services/apiKey.server'
import { redis } from '$lib/server/redis'
import {
  createVoiceProfile as createVoiceProfileRecord,
  deleteVoiceProfile as deleteVoiceProfileRecord,
  listVoiceProfiles as listVoiceProfileRecords,
  saveReferenceAudioForByoClone
} from '$lib/server/services/voiceProfileRecords'
import {
  getVoiceEngineSuiteId,
  getVoiceEngineSuiteRole,
  getVoiceEngineRecordByProviderId,
  isVoiceEngineHidden,
  listVoiceEngineRecords,
  listVoiceEngineSummaries
} from '$lib/server/services/voiceEngineRegistry'
import {
  flattenLegacyVoiceStyle,
  getProviderOptionsFor,
  getSttEngineSettingsFor,
  getTtsEngineSettingsFor,
  mergeVoiceCommon,
  mergeVoiceProviderBlocks,
  normalizeAgentVoiceProfile,
  normalizeVoiceProviderId,
  normalizeVoiceSettings,
  normalizeVoiceTtsConfig
} from '$lib/utils/voiceSchema'
import { createOpenAI } from '@ai-sdk/openai'
import { generateSpeech, transcribe } from 'ai'
import type { AgentRow, UserSettingsRow } from '$lib/types/database'
import type {
  AgentVoiceProfile,
  VoiceByoAuthMode,
  VoiceEngineClientSummary,
  VoiceEngineRecord,
  VoiceEngineVoiceSurface,
  VoiceProviderOptionBlock,
  VoiceProviderOptionValue,
  VoiceProviderId,
  VoiceProviderSummary,
  VoiceProfileRecord,
  VoiceSettings,
  VoiceSttCapabilityProfile,
  VoiceTtsConfig,
  VoiceSummary
} from '$lib/types/voice'
import type { VoiceRealtimeTtsEvent } from '$lib/types/voiceRealtime'
import {
  DEFAULT_OPENAI_TTS_MODEL,
  getOpenAITtsVoicesForModel,
  OPENAI_TTS_MODELS,
  OPENAI_TTS_VOICES
} from '$lib/server/services/voiceModelCatalog'
import { bytesToBlob, toOwnedBytes } from '$lib/utils/binary'

const DEFAULT_OPENAI_STT_MODEL = 'gpt-4o-mini-transcribe'
const OPENAI_STT_MODELS = [
  'gpt-4o-mini-transcribe',
  'gpt-4o-transcribe',
  'gpt-4o-transcribe-diarize',
  'whisper-1'
]
const DEFAULT_OPENAI_REALTIME_STT_MODEL = 'gpt-realtime-whisper'
const OPENAI_REALTIME_STT_MODELS = [DEFAULT_OPENAI_REALTIME_STT_MODEL]
const DEFAULT_GEMINI_TTS_MODEL = 'gemini-3.1-flash-tts-preview'
const GEMINI_TTS_MODELS = [
  'gemini-3.1-flash-tts-preview',
  'gemini-2.5-flash-preview-tts',
  'gemini-2.5-pro-preview-tts'
]
const DEFAULT_GEMINI_TTS_VOICE = 'Kore'
const GEMINI_TTS_VOICES = [
  'Zephyr',
  'Puck',
  'Charon',
  'Kore',
  'Fenrir',
  'Leda',
  'Orus',
  'Aoede',
  'Callirrhoe',
  'Autonoe',
  'Enceladus',
  'Iapetus',
  'Umbriel',
  'Algieba',
  'Despina',
  'Erinome',
  'Algenib',
  'Rasalgethi',
  'Laomedeia',
  'Achernar',
  'Alnilam',
  'Schedar',
  'Gacrux',
  'Pulcherrima',
  'Achird',
  'Zubenelgenubi',
  'Vindemiatrix',
  'Sadachbia',
  'Sadaltager',
  'Sulafat'
] as const
const DEFAULT_DEEPGRAM_TTS_MODEL = 'aura-2-asteria-en'
const DEFAULT_DEEPGRAM_STT_MODEL = 'nova-3'
const DEEPGRAM_STT_MODELS = [
  'nova-3',
  'nova-3-general',
  'nova-3-medical',
  'nova-2',
  'nova-2-general',
  'nova-2-meeting',
  'nova-2-phonecall',
  'nova-2-finance',
  'nova-2-conversationalai',
  'nova-2-voicemail',
  'nova-2-video',
  'nova-2-medical',
  'nova-2-drivethru',
  'nova-2-automotive',
  'nova-2-atc',
  'whisper',
  'whisper-tiny',
  'whisper-base',
  'whisper-small',
  'whisper-medium',
  'whisper-large'
]
const DEFAULT_DEEPGRAM_REALTIME_STT_MODEL = 'flux-general-en'
const DEEPGRAM_REALTIME_STT_MODELS = ['flux-general-en', 'flux-general-multi']
const DEFAULT_ELEVENLABS_TTS_MODEL = 'eleven_multilingual_v2'
const DEFAULT_ELEVENLABS_STT_MODEL = 'scribe_v2'
const ELEVENLABS_STT_MODELS = ['scribe_v2']
const DEFAULT_ELEVENLABS_REALTIME_STT_MODEL = 'scribe_v2_realtime'
const ELEVENLABS_REALTIME_STT_MODELS = [DEFAULT_ELEVENLABS_REALTIME_STT_MODEL]
// `s2.1-pro` is Fish Audio's current recommended production TTS model; `s2.1-pro-free`
// is the same model under fair-use limits with no service guarantees. Both S2 generations
// share the `[bracket]` emotion syntax; legacy `s1` uses `(parentheses)` instead.
const DEFAULT_FISH_TTS_MODEL = 's2.1-pro'
const FISH_TTS_MODELS = ['s2.1-pro', 's2.1-pro-free', 's2-pro', 's1']
const DEFAULT_FISH_STT_MODEL = 'transcribe-1'
const FISH_STT_MODELS = [DEFAULT_FISH_STT_MODEL]
const DEFAULT_MISTRAL_TTS_MODEL = 'voxtral-mini-tts-2603'
const MISTRAL_TTS_MODELS = ['voxtral-mini-tts-2603']
const DEFAULT_MISTRAL_STT_MODEL = 'voxtral-mini-latest'
const MISTRAL_STT_MODELS = ['voxtral-mini-latest', 'voxtral-mini-2602']
const DEFAULT_MISTRAL_REALTIME_STT_MODEL = 'voxtral-mini-transcribe-realtime-2602'
const MISTRAL_REALTIME_STT_MODELS = [DEFAULT_MISTRAL_REALTIME_STT_MODEL]
const DEFAULT_MINIMAX_TTS_MODEL = 'speech-2.8-hd'
const DEFAULT_MINIMAX_TTS_VOICE = 'English_expressive_narrator'
const MINIMAX_TTS_MODELS = [
  'speech-2.8-hd',
  'speech-2.8-turbo',
  'speech-2.6-hd',
  'speech-2.6-turbo',
  'speech-02-hd',
  'speech-02-turbo',
  'speech-01-hd',
  'speech-01-turbo'
]
const DEFAULT_MIMO_TTS_MODEL = 'mimo-v2.5-tts'
const DEFAULT_MIMO_TTS_VOICE = 'Chloe'
const MIMO_TTS_MODELS = ['mimo-v2.5-tts', 'mimo-v2.5-tts-voicedesign', 'mimo-v2.5-tts-voiceclone']
const MIMO_TTS_VOICES = [
  'mimo_default',
  '冰糖',
  '茉莉',
  '苏打',
  '白桦',
  'Mia',
  'Chloe',
  'Milo',
  'Dean'
]
const DEFAULT_ALIBABA_TTS_MODEL = 'qwen3-tts-flash'
const DEFAULT_ALIBABA_TTS_VOICE = 'Cherry'
const ALIBABA_TTS_MODELS = [
  'qwen3-tts-flash',
  'qwen3-tts-instruct-flash',
  'qwen3-tts-vd-2026-01-26',
  'qwen3-tts-vc-2026-01-22'
]
const ALIBABA_TTS_VOICES = [
  'Cherry',
  'Serena',
  'Ethan',
  'Chelsie',
  'Momo',
  'Dylan',
  'Jada',
  'Sunny',
  'Serene',
  'Ethan'
]
const DEFAULT_INWORLD_TTS_MODEL = 'inworld-tts-2'
const DEFAULT_INWORLD_TTS_VOICE = 'Alex'
const INWORLD_TTS_MODELS = [
  'inworld-tts-2',
  'inworld-tts-1.5-max',
  'inworld-tts-1.5-mini',
  'inworld-tts-1',
  'inworld-tts-1-max'
]
const DEFAULT_CARTESIA_TTS_MODEL = 'sonic-3.5'
const DEFAULT_CARTESIA_TTS_VOICE = 'db6b0ed5-d5d3-463d-ae85-518a07d3c2b4'
const CARTESIA_TTS_MODELS = ['sonic-3.5', 'sonic-3', 'sonic-latest']
const CARTESIA_VERSION = '2026-03-01'
const DEFAULT_ASYNC_TTS_MODEL = 'async_flash_v1.0'
const DEFAULT_ASYNC_TTS_VOICE = 'e0f39dc4-f691-4e78-bba5-5c636692cc04'
const ASYNC_TTS_MODELS = ['async_flash_v1.0', 'async_flash_v1.5', 'async_pro_v1.0']
const ASYNC_VERSION = 'v1'
const DEFAULT_STEPFUN_TTS_MODEL = 'step-tts-2'
const DEFAULT_STEPFUN_TTS_VOICE = 'lively-girl'
const STEPFUN_TTS_MODELS = ['step-tts-2', 'stepaudio-2.5-tts']
const STEPFUN_TTS_VOICES = ['lively-girl', 'cixingnansheng']
const DEFAULT_AZURE_TTS_MODEL = 'azure-neural-tts'
const DEFAULT_AZURE_TTS_VOICE = 'en-US-AvaMultilingualNeural'
const AZURE_TTS_MODELS = [DEFAULT_AZURE_TTS_MODEL]
const FISH_MODEL_LIST_PAGE_SIZE = 100
const FISH_PUBLIC_MODEL_LIST_PAGE_SIZE = 50
const FISH_USER_MODEL_PAGE_LIMIT = 5
const ELEVENLABS_VOICE_LIST_PAGE_SIZE = 100
const ELEVENLABS_VOICE_LIST_PAGE_LIMIT = 10
const MISTRAL_VOICE_LIST_PAGE_SIZE = 100
const MISTRAL_VOICE_LIST_PAGE_LIMIT = 10
const CARTESIA_VOICE_LIST_PAGE_SIZE = 100
const CARTESIA_VOICE_LIST_PAGE_LIMIT = 10
const INWORLD_VOICE_LIST_PAGE_SIZE = 100
const INWORLD_VOICE_LIST_PAGE_LIMIT = 10
const ASYNC_VOICE_LIST_PAGE_SIZE = 100
const ASYNC_VOICE_LIST_PAGE_LIMIT = 10
const FISH_REALTIME_FORMAT = 'pcm'
const FISH_REALTIME_DEFAULT_SAMPLE_RATE = 24000
const FISH_REALTIME_CHANNELS = 1
const INWORLD_REALTIME_DEFAULT_SAMPLE_RATE = 22050
const INWORLD_REALTIME_CHANNELS = 1
const INWORLD_REALTIME_BYTES_PER_SAMPLE = 2
const INWORLD_AUDIO_ENCODINGS = ['LINEAR16', 'MP3', 'OGG_OPUS'] as const
const INWORLD_DELIVERY_MODES = ['DELIVERY_MODE_UNSPECIFIED', 'STABLE', 'BALANCED', 'CREATIVE'] as const
const INWORLD_TEXT_NORMALIZATION_MODES = ['APPLY_TEXT_NORMALIZATION_UNSPECIFIED', 'ON', 'OFF'] as const
const INWORLD_TIMESTAMP_TYPES = ['TIMESTAMP_TYPE_UNSPECIFIED', 'WORD', 'CHARACTER'] as const
const INWORLD_TIMESTAMP_TRANSPORT_STRATEGIES = [
  'TIMESTAMP_TRANSPORT_STRATEGY_UNSPECIFIED',
  'SYNC',
  'ASYNC'
] as const
const BYO_DEFAULT_TIMEOUT_MS = 30_000
const BYO_STATUS_CACHE_TTL_MS = 10_000
const BYO_PROVIDER_ID_PREFIX = 'byo:'
const QWEN_SUITE_ID = 'qwen3-tts'
const QWEN_MODE_CUSTOM_VOICE = 'custom_voice'
const QWEN_MODE_VOICE_DESIGN = 'voice_design'
const NORMALIZED_REF_AUDIO_SUFFIX = '.batshit-normalized.wav'
const REF_AUDIO_PASSTHROUGH_EXTENSIONS = new Set(['.wav'])

const DEEPGRAM_AURA2_VOICE_IDS = [
  'aura-2-agathe-fr',
  'aura-2-agustina-es',
  'aura-2-alvaro-es',
  'aura-2-ama-ja',
  'aura-2-amalthea-en',
  'aura-2-andromeda-en',
  'aura-2-antonia-es',
  'aura-2-apollo-en',
  'aura-2-aquila-es',
  'aura-2-arcas-en',
  'aura-2-aries-en',
  'aura-2-asteria-en',
  'aura-2-athena-en',
  'aura-2-atlas-en',
  'aura-2-aurelia-de',
  'aura-2-aurora-en',
  'aura-2-beatrix-nl',
  'aura-2-callista-en',
  'aura-2-carina-es',
  'aura-2-celeste-es',
  'aura-2-cesare-it',
  'aura-2-cinzia-it',
  'aura-2-cora-en',
  'aura-2-cordelia-en',
  'aura-2-cornelia-nl',
  'aura-2-daphne-nl',
  'aura-2-delia-en',
  'aura-2-demetra-it',
  'aura-2-diana-es',
  'aura-2-dionisio-it',
  'aura-2-draco-en',
  'aura-2-ebisu-ja',
  'aura-2-elara-de',
  'aura-2-electra-en',
  'aura-2-elio-it',
  'aura-2-estrella-es',
  'aura-2-fabian-de',
  'aura-2-flavio-it',
  'aura-2-fujin-ja',
  'aura-2-gloria-es',
  'aura-2-harmonia-en',
  'aura-2-hector-fr',
  'aura-2-helena-en',
  'aura-2-hera-en',
  'aura-2-hermes-en',
  'aura-2-hestia-nl',
  'aura-2-hyperion-en',
  'aura-2-iris-en',
  'aura-2-izanami-ja',
  'aura-2-janus-en',
  'aura-2-javier-es',
  'aura-2-julius-de',
  'aura-2-juno-en',
  'aura-2-jupiter-en',
  'aura-2-kara-de',
  'aura-2-lara-de',
  'aura-2-lars-nl',
  'aura-2-leda-nl',
  'aura-2-livia-it',
  'aura-2-luciano-es',
  'aura-2-luna-en',
  'aura-2-maia-it',
  'aura-2-mars-en',
  'aura-2-melia-it',
  'aura-2-minerva-en',
  'aura-2-neptune-en',
  'aura-2-nestor-es',
  'aura-2-odysseus-en',
  'aura-2-olivia-es',
  'aura-2-ophelia-en',
  'aura-2-orion-en',
  'aura-2-orpheus-en',
  'aura-2-pandora-en',
  'aura-2-perseo-it',
  'aura-2-phoebe-en',
  'aura-2-pluto-en',
  'aura-2-rhea-nl',
  'aura-2-roman-nl',
  'aura-2-sander-nl',
  'aura-2-saturn-en',
  'aura-2-selena-es',
  'aura-2-selene-en',
  'aura-2-silvia-es',
  'aura-2-sirio-es',
  'aura-2-thalia-en',
  'aura-2-theia-en',
  'aura-2-uzume-ja',
  'aura-2-valerio-es',
  'aura-2-vesta-en',
  'aura-2-viktoria-de',
  'aura-2-zeus-en'
]

const DEEPGRAM_AURA1_VOICE_IDS = [
  'aura-asteria-en',
  'aura-luna-en',
  'aura-stella-en',
  'aura-athena-en',
  'aura-hera-en',
  'aura-orion-en',
  'aura-zeus-en',
  'aura-perseus-en',
  'aura-helios-en',
  'aura-angus-en',
  'aura-orpheus-en',
  'aura-arcas-en'
]

const formatDeepgramVoiceName = (id: string) => {
  const isAura2 = id.startsWith('aura-2-')
  const stripped = id.replace(/^aura-2-/, '').replace(/^aura-/, '')
  const parts = stripped.split('-')
  const lang = parts.pop()?.toUpperCase() ?? ''
  const name = parts.map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' ')
  return `${name}${isAura2 ? ' 2' : ''} (${lang})`
}

const DEEPGRAM_TTS_VOICES: Array<{ id: string; name: string }> = [
  ...DEEPGRAM_AURA2_VOICE_IDS.map((id) => ({ id, name: formatDeepgramVoiceName(id) })),
  ...DEEPGRAM_AURA1_VOICE_IDS.map((id) => ({ id, name: formatDeepgramVoiceName(id) }))
]

const ELEVENLABS_TTS_MODELS = [
  'eleven_v3',
  'eleven_multilingual_v2',
  'eleven_flash_v2_5',
  'eleven_flash_v2'
]

const MAX_TTS_CHARS = 5000
const MAX_TRANSCRIBE_BYTES = 25 * 1024 * 1024

const MEDIA_TYPE_MAP: Record<string, string> = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  opus: 'audio/opus',
  aac: 'audio/aac',
  flac: 'audio/flac',
  pcm: 'audio/pcm',
  pcm16: 'audio/pcm',
  raw: 'application/octet-stream'
}

const OPENAI_FORMATS = ['mp3', 'opus', 'aac', 'flac', 'wav', 'pcm']

const PROVIDER_SUMMARIES: VoiceProviderSummary[] = [
  {
    id: 'browser',
    label: 'Browser (Web Speech API)',
    type: 'browser',
    supports: {
      tts: true,
      stt: true,
      listVoices: false,
      clone: false,
      streaming: false,
      styles: false,
      emotions: false
    },
    sttCapabilities: BROWSER_STT_CAPABILITIES,
    defaultVoice: 'system'
  },
  {
    id: 'google',
    label: 'Google Gemini (TTS)',
    type: 'cloud',
    requiresKey: true,
    supports: {
      tts: true,
      stt: false,
      listVoices: true,
      clone: false,
      streaming: false,
      styles: false,
      emotions: false
    },
    defaultModel: DEFAULT_GEMINI_TTS_MODEL,
    defaultTtsModel: DEFAULT_GEMINI_TTS_MODEL,
    defaultVoice: DEFAULT_GEMINI_TTS_VOICE,
    ttsModels: GEMINI_TTS_MODELS
  },
  {
    id: 'openai',
    label: 'OpenAI',
    type: 'cloud',
    requiresKey: true,
    supports: {
      tts: true,
      stt: true,
      listVoices: true,
      clone: false,
      streaming: false,
      styles: true,
      emotions: false
    },
    defaultModel: DEFAULT_OPENAI_TTS_MODEL,
    defaultTtsModel: DEFAULT_OPENAI_TTS_MODEL,
    defaultSttModel: DEFAULT_OPENAI_STT_MODEL,
    defaultRealtimeSttModel: DEFAULT_OPENAI_REALTIME_STT_MODEL,
    defaultVoice: OPENAI_TTS_VOICES[0],
    ttsModels: [...OPENAI_TTS_MODELS],
    sttModels: OPENAI_STT_MODELS,
    realtimeSttModels: OPENAI_REALTIME_STT_MODELS,
    sttCapabilities: OPENAI_STT_CAPABILITIES
  },
  {
    id: 'elevenlabs',
    label: 'ElevenLabs',
    type: 'cloud',
    requiresKey: true,
    supports: {
      tts: true,
      stt: true,
      listVoices: true,
      clone: true,
      streaming: false,
      styles: true,
      emotions: true
    },
    defaultModel: DEFAULT_ELEVENLABS_TTS_MODEL,
    defaultTtsModel: DEFAULT_ELEVENLABS_TTS_MODEL,
    defaultSttModel: DEFAULT_ELEVENLABS_STT_MODEL,
    defaultRealtimeSttModel: DEFAULT_ELEVENLABS_REALTIME_STT_MODEL,
    ttsModels: ELEVENLABS_TTS_MODELS,
    sttModels: ELEVENLABS_STT_MODELS,
    realtimeSttModels: ELEVENLABS_REALTIME_STT_MODELS,
    sttCapabilities: ELEVENLABS_STT_CAPABILITIES
  },
  {
    id: 'deepgram',
    label: 'Deepgram',
    type: 'cloud',
    requiresKey: true,
    supports: {
      tts: true,
      stt: true,
      listVoices: true,
      clone: false,
      streaming: false,
      styles: false,
      emotions: false
    },
    defaultModel: DEFAULT_DEEPGRAM_TTS_MODEL,
    defaultTtsModel: DEFAULT_DEEPGRAM_TTS_MODEL,
    defaultSttModel: DEFAULT_DEEPGRAM_STT_MODEL,
    defaultRealtimeSttModel: DEFAULT_DEEPGRAM_REALTIME_STT_MODEL,
    defaultVoice: DEFAULT_DEEPGRAM_TTS_MODEL,
    ttsModels: [DEFAULT_DEEPGRAM_TTS_MODEL],
    sttModels: DEEPGRAM_STT_MODELS,
    realtimeSttModels: DEEPGRAM_REALTIME_STT_MODELS,
    sttCapabilities: DEEPGRAM_STT_CAPABILITIES
  },
  {
    id: 'fish',
    label: 'Fish Audio',
    type: 'cloud',
    requiresKey: true,
    supports: {
      tts: true,
      stt: true,
      listVoices: true,
      clone: false,
      streaming: true,
      styles: false,
      emotions: false
    },
    defaultModel: DEFAULT_FISH_TTS_MODEL,
    defaultTtsModel: DEFAULT_FISH_TTS_MODEL,
    defaultSttModel: DEFAULT_FISH_STT_MODEL,
    ttsModels: FISH_TTS_MODELS,
    sttModels: FISH_STT_MODELS,
    sttCapabilities: FISH_STT_CAPABILITIES
  },
  {
    id: 'mistral',
    label: 'Mistral Voxtral',
    type: 'cloud',
    requiresKey: true,
    supports: {
      tts: true,
      stt: true,
      listVoices: true,
      clone: true,
      streaming: false,
      styles: false,
      emotions: false
    },
    defaultModel: DEFAULT_MISTRAL_TTS_MODEL,
    defaultTtsModel: DEFAULT_MISTRAL_TTS_MODEL,
    defaultSttModel: DEFAULT_MISTRAL_STT_MODEL,
    defaultRealtimeSttModel: DEFAULT_MISTRAL_REALTIME_STT_MODEL,
    ttsModels: MISTRAL_TTS_MODELS,
    sttModels: MISTRAL_STT_MODELS,
    realtimeSttModels: MISTRAL_REALTIME_STT_MODELS,
    sttCapabilities: MISTRAL_STT_CAPABILITIES,
    voiceSurface: {
      kind: 'clone_profiles',
      summary:
        'Mistral Voxtral TTS uses saved voice_id values or reference audio. Batshit lists saved Mistral voices from the Audio Voices API when a key is configured, and still allows a manual voice_id entry.',
      requiresDiscussion: true
    }
  },
  {
    id: 'minimax',
    label: 'MiniMax',
    type: 'cloud',
    requiresKey: true,
    supports: {
      tts: true,
      stt: false,
      listVoices: true,
      clone: false,
      streaming: false,
      styles: true,
      emotions: true
    },
    defaultModel: DEFAULT_MINIMAX_TTS_MODEL,
    defaultTtsModel: DEFAULT_MINIMAX_TTS_MODEL,
    defaultVoice: DEFAULT_MINIMAX_TTS_VOICE,
    ttsModels: MINIMAX_TTS_MODELS
  },
  {
    id: 'mimo',
    label: 'MiMo',
    type: 'cloud',
    requiresKey: true,
    supports: {
      tts: true,
      stt: false,
      listVoices: true,
      clone: false,
      streaming: false,
      styles: true,
      emotions: true
    },
    defaultModel: DEFAULT_MIMO_TTS_MODEL,
    defaultTtsModel: DEFAULT_MIMO_TTS_MODEL,
    defaultVoice: DEFAULT_MIMO_TTS_VOICE,
    ttsModels: MIMO_TTS_MODELS
  },
  {
    id: 'alibaba',
    label: 'Alibaba Cloud Qwen TTS',
    type: 'cloud',
    requiresKey: true,
    supports: {
      tts: true,
      stt: false,
      listVoices: true,
      clone: false,
      streaming: false,
      styles: true,
      emotions: true
    },
    defaultModel: DEFAULT_ALIBABA_TTS_MODEL,
    defaultTtsModel: DEFAULT_ALIBABA_TTS_MODEL,
    defaultVoice: DEFAULT_ALIBABA_TTS_VOICE,
    ttsModels: ALIBABA_TTS_MODELS
  },
  {
    id: 'inworld',
    label: 'Inworld',
    type: 'cloud',
    requiresKey: true,
    supports: {
      tts: true,
      stt: false,
      listVoices: true,
      clone: false,
      streaming: true,
      styles: true,
      emotions: true
    },
    defaultModel: DEFAULT_INWORLD_TTS_MODEL,
    defaultTtsModel: DEFAULT_INWORLD_TTS_MODEL,
    defaultVoice: DEFAULT_INWORLD_TTS_VOICE,
    ttsModels: INWORLD_TTS_MODELS
  },
  {
    id: 'cartesia',
    label: 'Cartesia',
    type: 'cloud',
    requiresKey: true,
    supports: {
      tts: true,
      stt: false,
      listVoices: true,
      clone: false,
      streaming: false,
      styles: true,
      emotions: false
    },
    defaultModel: DEFAULT_CARTESIA_TTS_MODEL,
    defaultTtsModel: DEFAULT_CARTESIA_TTS_MODEL,
    defaultVoice: DEFAULT_CARTESIA_TTS_VOICE,
    ttsModels: CARTESIA_TTS_MODELS
  },
  {
    id: 'async',
    label: 'Async Voice',
    type: 'cloud',
    requiresKey: true,
    supports: {
      tts: true,
      stt: false,
      listVoices: true,
      clone: false,
      streaming: false,
      styles: false,
      emotions: false
    },
    defaultModel: DEFAULT_ASYNC_TTS_MODEL,
    defaultTtsModel: DEFAULT_ASYNC_TTS_MODEL,
    defaultVoice: DEFAULT_ASYNC_TTS_VOICE,
    ttsModels: ASYNC_TTS_MODELS
  },
  {
    id: 'stepfun',
    label: 'StepFun',
    type: 'cloud',
    requiresKey: true,
    supports: {
      tts: true,
      stt: false,
      listVoices: true,
      clone: false,
      streaming: false,
      styles: true,
      emotions: true
    },
    defaultModel: DEFAULT_STEPFUN_TTS_MODEL,
    defaultTtsModel: DEFAULT_STEPFUN_TTS_MODEL,
    defaultVoice: DEFAULT_STEPFUN_TTS_VOICE,
    ttsModels: STEPFUN_TTS_MODELS
  },
  {
    id: 'azure',
    label: 'Microsoft Azure Speech',
    type: 'cloud',
    requiresKey: true,
    supports: {
      tts: true,
      stt: false,
      listVoices: true,
      clone: false,
      streaming: false,
      styles: false,
      emotions: false
    },
    defaultModel: DEFAULT_AZURE_TTS_MODEL,
    defaultTtsModel: DEFAULT_AZURE_TTS_MODEL,
    defaultVoice: DEFAULT_AZURE_TTS_VOICE,
    ttsModels: AZURE_TTS_MODELS,
    voiceSurface: {
      kind: 'static_catalog',
      summary:
        'Azure REST TTS is available now. Viseme and detailed lip-sync events require the Azure Speech SDK event path and are tracked as a separate future bridge.',
      requiresDiscussion: true
    }
  }
]

export type VoiceSynthesisRequest = {
  text: string
  sourceText?: string | null
  provider?: VoiceProviderId | null
  model?: string | null
  voiceId?: string | null
  profileId?: string | null
  options?: Record<string, any>
  agentId?: string | null
  userId: string
}

export type VoiceSynthesisResult = {
  audio: Uint8Array
  mediaType: string
  voiceId?: string | null
  provider: VoiceProviderId
  model?: string | null
}

export type VoiceTranscribeRequest = {
  audio: Uint8Array
  provider?: VoiceProviderId | null
  model?: string | null
  language?: string | null
  options?: Record<string, any>
  contentType?: string | null
  userId: string
}

export type VoiceTranscribeResult = {
  text: string
  language?: string
  segments?: any[]
  confidence?: number
}

export type VoiceCloneRequest = {
  audio: Uint8Array
  provider: VoiceProviderId
  name: string
  description?: string
  filename?: string | null
  contentType?: string | null
  referenceText?: string
  userId: string
}

export type VoiceCloneResult = {
  voiceId: string
  profile: VoiceProfileRecord
}

const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  schemaVersion: 2,
  stt: {
    providerId: 'browser'
  },
  tts: {
    providerId: 'browser'
  }
}

const normalizeProviderId = (provider?: string | null): VoiceProviderId | null => {
  return normalizeVoiceProviderId(provider) ?? null
}

const normalizeBaseUrl = (url: string) => url.replace(/\/+$/, '')
const toByoProviderId = (providerKey: string): VoiceProviderId =>
  `${BYO_PROVIDER_ID_PREFIX}${providerKey}` as VoiceProviderId

const parseByoProviderKey = (providerId: string): string | null => {
  const normalized = providerId.trim().toLowerCase()
  if (!normalized.startsWith(BYO_PROVIDER_ID_PREFIX)) return null
  const key = normalized.slice(BYO_PROVIDER_ID_PREFIX.length)
  return key ? key : null
}

type ByoSuiteRuntime = {
  publicRecord: VoiceEngineRecord
  members: VoiceEngineRecord[]
  primaryRecord: VoiceEngineRecord
  cloneRecord?: VoiceEngineRecord
  voiceDesignRecord?: VoiceEngineRecord
}

function buildStaticVoiceSummaries(providerId: VoiceProviderId, voices?: string[]): VoiceSummary[] {
  return Array.isArray(voices)
    ? voices
        .map((voice) => voice.trim())
        .filter((voice) => voice.length > 0)
        .map((voice) => ({
          id: voice,
          name: voice,
          provider: providerId
        }))
    : []
}

function hasReferenceAudioOptions(options?: ByoSpeechRuntimeOptions): boolean {
  return typeof options?.providerOptions?.ref_audio === 'string' && options.providerOptions.ref_audio.trim().length > 0
}

function resolveQwenMode(options?: ByoSpeechRuntimeOptions): string | null {
  const value = options?.providerOptions?.qwen_mode
  if (typeof value !== 'string' || value.trim().length === 0) {
    return null
  }

  const normalized = value.trim().toLowerCase()
  if (normalized === QWEN_MODE_CUSTOM_VOICE || normalized === QWEN_MODE_VOICE_DESIGN) {
    return normalized
  }

  return null
}

async function resolveByoSuiteRuntime(
  userId: string,
  providerId: VoiceProviderId
): Promise<ByoSuiteRuntime> {
  const providerKey = parseByoProviderKey(providerId)
  if (!providerKey) {
    throw new Error('Invalid BYO provider selection.')
  }

  const publicRecord = await getVoiceEngineRecordByProviderId(userId, providerId)
  if (!publicRecord) {
    throw new Error(`BYO provider "${providerKey}" is not configured.`)
  }

  const records = await listVoiceEngineRecords(userId)
  const allRecords =
    records.some((record) => record.id === publicRecord.id) ? records : [...records, publicRecord]

  const suiteId = getVoiceEngineSuiteId(publicRecord)
  const members = allRecords.filter((record) => getVoiceEngineSuiteId(record) === suiteId)
  const primaryRecord =
    members.find((record) => !isVoiceEngineHidden(record) && getVoiceEngineSuiteRole(record) === 'primary') ??
    publicRecord
  const cloneRecord = members.find((record) => getVoiceEngineSuiteRole(record) === 'clone')
  const voiceDesignRecord = members.find((record) => getVoiceEngineSuiteRole(record) === 'voice_design')

  return {
    publicRecord,
    members,
    primaryRecord,
    cloneRecord,
    voiceDesignRecord
  }
}

function resolveByoSynthesisRecord(
  runtime: ByoSuiteRuntime,
  options?: ByoSpeechRuntimeOptions
): VoiceEngineRecord {
  if (hasReferenceAudioOptions(options) && runtime.cloneRecord) {
    return runtime.cloneRecord
  }

  if (getVoiceEngineSuiteId(runtime.publicRecord) === QWEN_SUITE_ID) {
    const qwenMode = resolveQwenMode(options)
    if (qwenMode === QWEN_MODE_VOICE_DESIGN && runtime.voiceDesignRecord) {
      return runtime.voiceDesignRecord
    }
  }

  return runtime.primaryRecord
}

async function resolveApiKey(userId: string, service: string, envKeys: string[]): Promise<string | null> {
  const stored = await apiKeyService.retrieve(service, userId).catch(() => null)
  if (stored) return stored
  for (const key of envKeys) {
    const value = env[key]
    if (value) return value
  }
  return null
}

export async function getVoiceSettings(userId: string): Promise<VoiceSettings> {
  const settings = await redis.getUserSettings(userId)
  const normalized = normalizeVoiceSettings(settings?.voice_settings)
  const { byoProviders: _ignored, ...sanitized } = normalized
  return {
    ...DEFAULT_VOICE_SETTINGS,
    ...sanitized
  }
}

export function resolveAgentVoiceProfile(agent?: AgentRow | null): AgentVoiceProfile | null {
  return normalizeAgentVoiceProfile(agent?.voice_profile)
}

export async function buildVoiceProviderSummary(userId: string): Promise<VoiceProviderSummary[]> {
  const openaiKey = await resolveApiKey(userId, 'openai', ['OPENAI_API_KEY'])
  const googleKey = await resolveApiKey(userId, 'google', ['GEMINI_API_KEY', 'GOOGLE_API_KEY'])
  const elevenKey = await resolveApiKey(userId, 'elevenlabs', ['ELEVENLABS_API_KEY'])
  const deepgramKey = await resolveApiKey(userId, 'deepgram', ['DEEPGRAM_API_KEY'])
  const fishKey = await resolveApiKey(userId, 'fish', ['FISH_AUDIO_API_KEY', 'FISH_API_KEY'])
  const mistralKey = await resolveApiKey(userId, 'mistral', ['MISTRAL_API_KEY'])
  const minimaxKey = await resolveApiKey(userId, 'minimax', ['MINIMAX_API_KEY'])
  const mimoKey = await resolveApiKey(userId, 'mimo', ['MIMO_API_KEY'])
  const alibabaKey = await resolveApiKey(userId, 'alibaba', ['ALIBABA_CLOUD_API_KEY', 'DASHSCOPE_API_KEY'])
  const inworldKey = await resolveApiKey(userId, 'inworld', ['INWORLD_API_KEY'])
  const cartesiaKey = await resolveApiKey(userId, 'cartesia', ['CARTESIA_API_KEY'])
  const asyncKey = await resolveApiKey(userId, 'async', ['ASYNC_API_KEY'])
  const stepfunKey = await resolveApiKey(userId, 'stepfun', ['STEPFUN_API_KEY', 'STEP_API_KEY'])
  const azureKey = await resolveApiKey(userId, 'azure_speech_key', ['AZURE_SPEECH_KEY'])
  const azureRegion = await resolveApiKey(userId, 'azure_speech_region', ['AZURE_SPEECH_REGION'])
  const byoProviders = await listVoiceEngineSummaries(userId)

  const withStatus = PROVIDER_SUMMARIES.map((provider) => {
    if (provider.id === 'openai') {
      return { ...provider, ready: Boolean(openaiKey), statusHint: openaiKey ? undefined : 'API key missing' }
    }
    if (provider.id === 'google') {
      return { ...provider, ready: Boolean(googleKey), statusHint: googleKey ? undefined : 'API key missing' }
    }
    if (provider.id === 'elevenlabs') {
      return { ...provider, ready: Boolean(elevenKey), statusHint: elevenKey ? undefined : 'API key missing' }
    }
    if (provider.id === 'deepgram') {
      return { ...provider, ready: Boolean(deepgramKey), statusHint: deepgramKey ? undefined : 'API key missing' }
    }
    if (provider.id === 'fish') {
      return { ...provider, ready: Boolean(fishKey), statusHint: fishKey ? undefined : 'API key missing' }
    }
    if (provider.id === 'mistral') {
      return { ...provider, ready: Boolean(mistralKey), statusHint: mistralKey ? undefined : 'API key missing' }
    }
    if (provider.id === 'minimax') {
      return { ...provider, ready: Boolean(minimaxKey), statusHint: minimaxKey ? undefined : 'API key missing' }
    }
    if (provider.id === 'mimo') {
      return { ...provider, ready: Boolean(mimoKey), statusHint: mimoKey ? undefined : 'API key missing' }
    }
    if (provider.id === 'alibaba') {
      return { ...provider, ready: Boolean(alibabaKey), statusHint: alibabaKey ? undefined : 'API key missing' }
    }
    if (provider.id === 'inworld') {
      return { ...provider, ready: Boolean(inworldKey), statusHint: inworldKey ? undefined : 'API key missing' }
    }
    if (provider.id === 'cartesia') {
      return { ...provider, ready: Boolean(cartesiaKey), statusHint: cartesiaKey ? undefined : 'API key missing' }
    }
    if (provider.id === 'async') {
      return { ...provider, ready: Boolean(asyncKey), statusHint: asyncKey ? undefined : 'API key missing' }
    }
    if (provider.id === 'stepfun') {
      return { ...provider, ready: Boolean(stepfunKey), statusHint: stepfunKey ? undefined : 'API key missing' }
    }
    if (provider.id === 'azure') {
      const ready = Boolean(azureKey && azureRegion)
      return {
        ...provider,
        ready,
        statusHint: ready
          ? undefined
          : azureKey
            ? 'Azure Speech region missing'
            : 'Azure Speech key missing'
      }
    }
    return { ...provider, ready: true }
  })

  const byoProviderStatuses = await Promise.all(
    byoProviders.map(async (provider) => {
      const providerId = toByoProviderId(provider.id)
      if (provider.enabled === false) {
        return {
          provider,
          providerId,
          status: {
            ready: false,
            statusHint: 'Disabled in Engine Manager'
          }
        }
      }
      const status = await checkByoSpeechStatus(userId, providerId, { useCache: true })
      return { provider, providerId, status }
    })
  )

  const byoProviderSummaries: VoiceProviderSummary[] = byoProviderStatuses.map(({ provider, providerId, status }) => {
    const defaultTtsModel = resolveTtsDefaultModel(provider.ttsDefaults) ?? undefined
    const defaultSttModel = resolveByoDefaultSttModel(provider) ?? undefined
    const defaultVoice = resolveOptionalString(provider.ttsDefaults?.voiceId ?? undefined) ?? undefined
    const installedSttModels = resolveInstalledSttCatalogModels(provider)
    const sttModels = Array.from(
      new Set([...(defaultSttModel ? [defaultSttModel] : []), ...installedSttModels])
    )
    const sttCapabilities = resolveByoRealtimeSttCapabilities(provider)
    const defaultRealtimeSttModel =
      sttCapabilities.realtime ? defaultSttModel ?? sttModels[0] : undefined
    const voiceSurface = resolveVoiceSurfaceSummary(provider, defaultVoice)
    const hasVoiceList =
      provider.voiceDiscovery?.mode === 'http' ||
      Boolean(provider.voicesPath) ||
      Boolean(voiceSurface?.voices && voiceSurface.voices.length > 0)

    return {
      id: providerId,
      label: provider.name,
      type: 'byo' as const,
      supports: {
        tts: provider.supportsTts !== false,
        stt: provider.supportsStt !== false,
        listVoices: hasVoiceList,
        clone: provider.supportsClone === true,
        streaming: false,
        styles: provider.expression?.strategy != null && provider.expression.strategy !== 'none',
        emotions: provider.expression?.strategy != null && provider.expression.strategy !== 'none'
      },
      defaultModel: defaultTtsModel ?? defaultSttModel,
      defaultVoice,
      ttsModels: defaultTtsModel ? [defaultTtsModel] : [],
      sttModels,
      realtimeSttModels: sttCapabilities.realtime ? sttModels : [],
      defaultTtsModel,
      defaultSttModel,
      defaultRealtimeSttModel,
      sttCapabilities,
      ready: status.ready,
      statusHint: status.statusHint,
      voiceSurface,
      suite: provider.suite
    }
  })
    .filter((provider) => provider.supports.tts || provider.supports.stt)

  return [...withStatus, ...byoProviderSummaries]
}

const resolveOptionalString = (...values: Array<string | null | undefined>) => {
  for (const value of values) {
    if (typeof value === 'string') {
      const trimmed = value.trim()
      if (trimmed) return trimmed
    }
  }
  return null
}

function resolveCatalogModelRequestValue(
  model: NonNullable<VoiceEngineClientSummary['sttModelCatalog']>['models'][number]
): string | null {
  return resolveOptionalString(model.requestModel, model.filename, model.id)
}

function resolveInstalledSttCatalogModels(provider: VoiceEngineClientSummary): string[] {
  const models = provider.sttModelCatalog?.models ?? []
  const installedModels = models
    .filter((model) => model.installed === true)
    .map((model) => resolveCatalogModelRequestValue(model))
    .filter((model): model is string => Boolean(model))
  return Array.from(new Set(installedModels))
}

function resolveByoDefaultSttModel(provider: VoiceEngineClientSummary): string | null {
  const configuredDefault = resolveSttDefaultModel(provider.sttDefaults)
  if (configuredDefault) return configuredDefault

  const activeModelId = provider.sttModelCatalog?.activeModelId
  const activeModel = provider.sttModelCatalog?.models.find((model) => model.id === activeModelId)
  const activeModelValue = activeModel?.installed === true ? resolveCatalogModelRequestValue(activeModel) : null
  if (activeModelValue) return activeModelValue

  return resolveInstalledSttCatalogModels(provider)[0] ?? null
}

function resolveByoRealtimeSttCapabilities(provider: VoiceEngineClientSummary): VoiceSttCapabilityProfile {
  const realtime = provider.realtimeStt
  if (!realtime?.enabled || realtime.transport !== 'websocket') {
    return BYO_STT_CAPABILITIES
  }

  const finalResults = realtime.finalResults !== false
  const partialResults = realtime.partialResults === true
  const turnDetection = realtime.turnDetection !== false
  const vad = realtime.vad !== false
  return {
    ...BYO_STT_CAPABILITIES,
    recorded: true,
    realtime: true,
    turnDetection,
    vad,
    partialResults,
    finalResults,
    transport: 'byo-runtime',
    runtimeSupport: 'supported',
    cost: 'local',
    privacy: 'local',
    runtimeLabel: `${provider.name} local realtime STT`,
    unsupportedReason: partialResults
      ? undefined
      : 'This local realtime lane streams microphone audio to a local WebSocket and returns final turn transcripts, but it does not provide token-by-token partial transcripts.',
    notes: [
      ...(realtime.notes ?? []),
      'BYO realtime STT uses a local WebSocket endpoint; no cloud STT key is sent to the browser.'
    ]
  }
}

function resolveTtsDefaultModel(
  defaults?: VoiceEngineRecord['ttsDefaults'] | null
): string | null {
  return resolveOptionalString(
    defaults?.modelId,
    typeof defaults?.providerOptions?.model === 'string' ? defaults.providerOptions.model : undefined
  )
}

function resolveSttDefaultModel(
  defaults?: VoiceEngineRecord['sttDefaults'] | null
): string | null {
  return resolveOptionalString(
    defaults?.modelId,
    typeof defaults?.providerOptions?.model === 'string' ? defaults.providerOptions.model : undefined
  )
}

function resolveVoiceSurfaceSummary(
  provider: Pick<
    VoiceEngineClientSummary,
    'supportsTts' | 'supportsClone' | 'voiceSurface' | 'voiceDiscovery' | 'voicesPath'
  >,
  defaultVoice?: string
): VoiceEngineVoiceSurface | undefined {
  if (provider.supportsTts === false) {
    return provider.voiceSurface
  }

  if (provider.voiceSurface?.kind) {
    return provider.voiceSurface
  }

  if (provider.voiceDiscovery?.mode === 'http' || provider.voicesPath) {
    return {
      kind: 'dynamic_catalog',
      summary: 'Voice catalog available from the engine.',
      requiresDiscussion: false
    }
  }

  if (provider.supportsClone === true) {
    return {
      kind: 'clone_profiles',
      summary:
        'No remote voice catalog is published here; voice variety comes from Batshit voice profiles or engine-specific cloning flows.',
      requiresDiscussion: false
    }
  }

  if (defaultVoice) {
    return {
      kind: 'single_voice',
      summary: `Only one configured default voice is currently available here (${defaultVoice}).`,
      requiresDiscussion: true,
      voices: [defaultVoice]
    }
  }

  return {
    kind: 'unknown',
    summary: 'Voice coverage is not described in the engine record yet.',
    requiresDiscussion: true
  }
}

function requireOpenAICompatibleByoModel(options: {
  providerId: VoiceProviderId
  mode: 'tts' | 'stt'
  requestedModel?: string | null
  defaultModel?: string | null
}): string {
  const resolved = resolveOptionalString(options.requestedModel, options.defaultModel)
  if (resolved) return resolved

  const action = options.mode === 'tts' ? 'speech synthesis' : 'speech transcription'
  const field = options.mode === 'tts' ? 'ttsDefaults.modelId' : 'sttDefaults.modelId'

  throw new Error(
    `BYO provider "${options.providerId}" uses the OpenAI-compatible ${action} lane but has no model configured. Save ${field} on the engine or pass a model explicitly.`
  )
}

const FALLBACK_DISABLED_NOTE = 'Automatic fallback is disabled.'
const UPLOADED_STT_INPUT_EXTENSIONS: Record<string, string> = {
  'audio/webm': '.webm',
  'video/webm': '.webm',
  'audio/mp4': '.m4a',
  'video/mp4': '.mp4',
  'audio/mpeg': '.mp3',
  'audio/mp3': '.mp3',
  'audio/wav': '.wav',
  'audio/wave': '.wav',
  'audio/x-wav': '.wav',
  'audio/ogg': '.ogg',
  'audio/flac': '.flac',
  'audio/aac': '.aac'
}

function expandHomePath(targetPath: string): string {
  if (targetPath === '~') {
    return os.homedir()
  }

  if (targetPath.startsWith('~/')) {
    return path.join(os.homedir(), targetPath.slice(2))
  }

  return targetPath
}

function shouldNormalizeLocalReferenceAudioPath(value: string): boolean {
  const trimmed = value.trim()
  if (!trimmed) return false
  if (trimmed.includes('://') || trimmed.startsWith('data:')) return false
  return path.isAbsolute(trimmed) || trimmed === '~' || trimmed.startsWith('~/')
}

function buildNormalizedReferenceAudioPath(sourcePath: string): string {
  const parsed = path.parse(sourcePath)
  return path.join(parsed.dir, `${parsed.name}${NORMALIZED_REF_AUDIO_SUFFIX}`)
}

async function runReferenceAudioNormalization(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'ignore', 'pipe']
    })

    let stderr = ''
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString()
    })

    child.once('error', (error) => {
      reject(error instanceof Error ? error : new Error(`Failed to launch ${command}.`))
    })

    child.once('close', (code) => {
      if (code === 0) {
        resolve()
        return
      }

      reject(new Error(stderr.trim() || `${command} exited with code ${code ?? 'unknown'}.`))
    })
  })
}

function stripContentTypeParameters(contentType?: string | null): string {
  return contentType?.split(';')[0]?.trim().toLowerCase() ?? ''
}

function isPcmWavAudio(audio: Uint8Array): boolean {
  return (
    audio.byteLength >= 12 &&
    audio[0] === 0x52 &&
    audio[1] === 0x49 &&
    audio[2] === 0x46 &&
    audio[3] === 0x46 &&
    audio[8] === 0x57 &&
    audio[9] === 0x41 &&
    audio[10] === 0x56 &&
    audio[11] === 0x45
  )
}

function isWavContentType(contentType?: string | null): boolean {
  return ['audio/wav', 'audio/wave', 'audio/x-wav'].includes(
    stripContentTypeParameters(contentType)
  )
}

function resolveUploadedSttInputExtension(contentType?: string | null): string {
  return UPLOADED_STT_INPUT_EXTENSIONS[stripContentTypeParameters(contentType)] ?? '.audio'
}

async function runFfmpegAudioNormalization(args: string[]): Promise<void> {
  await runReferenceAudioNormalization(env.FFMPEG_PATH || 'ffmpeg', args)
}

async function normalizeUploadedAudioToPcmWav(options: {
  audio: Uint8Array
  contentType?: string | null
  providerLabel: string
}): Promise<Uint8Array> {
  if (isWavContentType(options.contentType) || isPcmWavAudio(options.audio)) {
    return options.audio
  }

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'batshit-stt-'))
  const inputPath = path.join(tempRoot, `input${resolveUploadedSttInputExtension(options.contentType)}`)
  const outputPath = path.join(tempRoot, 'speech.wav')

  try {
    await fs.writeFile(inputPath, options.audio)
    await runFfmpegAudioNormalization([
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      inputPath,
      '-vn',
      '-ar',
      '24000',
      '-ac',
      '1',
      '-c:a',
      'pcm_s16le',
      outputPath
    ])
    return new Uint8Array(await fs.readFile(outputPath))
  } catch (error) {
    const detail =
      error instanceof Error && error.message.trim()
        ? error.message.trim()
        : 'Unknown audio normalization error.'
    if (detail.includes('ENOENT')) {
      throw new Error(
        `Batshit needs ffmpeg in PATH to normalize microphone recordings for ${options.providerLabel} speech-to-text. Install ffmpeg or use Browser STT in a normal browser.`
      )
    }

    throw new Error(
      `Batshit could not normalize the microphone recording for ${options.providerLabel} speech-to-text. ${detail}`
    )
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {})
  }
}

async function normalizeLocalReferenceAudioPath(refAudioPath: string): Promise<string> {
  if (!shouldNormalizeLocalReferenceAudioPath(refAudioPath)) {
    return refAudioPath
  }

  const resolvedSourcePath = path.resolve(expandHomePath(refAudioPath.trim()))
  const sourceStats = await fs.stat(resolvedSourcePath).catch(() => null)
  if (!sourceStats?.isFile()) {
    return refAudioPath
  }

  if (REF_AUDIO_PASSTHROUGH_EXTENSIONS.has(path.extname(resolvedSourcePath).toLowerCase())) {
    return resolvedSourcePath
  }

  const normalizedPath = buildNormalizedReferenceAudioPath(resolvedSourcePath)
  const normalizedStats = await fs.stat(normalizedPath).catch(() => null)
  if (normalizedStats?.isFile() && normalizedStats.mtimeMs >= sourceStats.mtimeMs) {
    return normalizedPath
  }

  await fs.mkdir(path.dirname(normalizedPath), { recursive: true })

  try {
    await runReferenceAudioNormalization(env.FFMPEG_PATH || 'ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      resolvedSourcePath,
      '-ar',
      '24000',
      '-ac',
      '1',
      '-c:a',
      'pcm_s16le',
      normalizedPath
    ])
  } catch (error) {
    const detail =
      error instanceof Error && error.message.trim()
        ? error.message.trim()
        : 'Unknown normalization error.'
    if (detail.includes('ENOENT')) {
      throw new Error(
        `Batshit needs ffmpeg in PATH to use non-WAV ref_audio files for BYO voice cloning. Install ffmpeg or use a WAV reference clip.`
      )
    }

    throw new Error(
      `Batshit could not normalize ref_audio "${resolvedSourcePath}" to PCM WAV for BYO voice cloning. ${detail}`
    )
  }

  return normalizedPath
}

function extractVoiceErrorMessage(error: unknown): string {
  if (error instanceof Error && typeof error.message === 'string' && error.message.trim()) {
    return error.message.trim()
  }
  if (typeof error === 'string' && error.trim()) {
    return error.trim()
  }
  return 'Unknown provider error.'
}

function createPrimaryProviderFailureError(
  mode: 'STT' | 'TTS',
  provider: string | null | undefined,
  error: unknown
): Error {
  const detail = extractVoiceErrorMessage(error)
  if (detail.includes(FALLBACK_DISABLED_NOTE)) {
    return error instanceof Error ? error : new Error(detail)
  }
  const providerLabel = provider ?? 'configured'
  return new Error(`Primary ${mode} provider "${providerLabel}" failed. ${FALLBACK_DISABLED_NOTE} ${detail}`)
}

type FishModelListItem = {
  _id?: unknown
  id?: unknown
  title?: unknown
  name?: unknown
  state?: unknown
  visibility?: unknown
  languages?: unknown
}

function mapFishModelToVoice(
  item: FishModelListItem,
  source: 'user' | 'public'
): VoiceSummary | null {
  const id = resolveOptionalString(
    typeof item._id === 'string' ? item._id : undefined,
    typeof item.id === 'string' ? item.id : undefined
  )
  if (!id) return null

  const state = typeof item.state === 'string' ? item.state.toLowerCase() : ''
  if (state === 'failed' || state === 'training') return null

  const title = resolveOptionalString(
    typeof item.title === 'string' ? item.title : undefined,
    typeof item.name === 'string' ? item.name : undefined
  )
  const visibility = typeof item.visibility === 'string' ? item.visibility : ''
  const languages = Array.isArray(item.languages)
    ? item.languages.filter((language): language is string => typeof language === 'string')
    : []

  return {
    id,
    name: title ?? id,
    provider: 'fish',
    category: source === 'user' ? 'Your Fish models' : visibility || 'Fish model',
    language: languages[0],
    isClone: source === 'user' || visibility === 'private'
  }
}

async function fetchFishModelPage(
  apiKey: string,
  params: Record<string, string>
): Promise<{ voices: VoiceSummary[]; hasMore: boolean }> {
  const url = new URL('https://api.fish.audio/model')
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value)
  }

  const response = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json'
    }
  })

  if (!response.ok) {
    throw new Error(await readProviderError(response, 'Failed to fetch Fish Audio voices.'))
  }

  const payload = (await response.json().catch(() => null)) as
    | { items?: unknown; has_more?: unknown }
    | null
  const items = Array.isArray(payload?.items) ? payload.items : []
  const source = params.self === 'true' ? 'user' : 'public'
  const voices = items
    .map((item) =>
      item && typeof item === 'object'
        ? mapFishModelToVoice(item as FishModelListItem, source)
        : null
    )
    .filter((voice): voice is VoiceSummary => Boolean(voice))

  return {
    voices,
    hasMore: payload?.has_more === true
  }
}

async function listFishVoices(userId: string): Promise<VoiceSummary[]> {
  const apiKey = await resolveApiKey(userId, 'fish', ['FISH_AUDIO_API_KEY', 'FISH_API_KEY'])
  if (!apiKey) throw new Error('Fish Audio API key not configured')

  const merged = new Map<string, VoiceSummary>()
  for (let page = 1; page <= FISH_USER_MODEL_PAGE_LIMIT; page += 1) {
    const result = await fetchFishModelPage(apiKey, {
      self: 'true',
      page_size: String(FISH_MODEL_LIST_PAGE_SIZE),
      page_number: String(page),
      sort_by: 'created_at'
    })
    result.voices.forEach((voice) => merged.set(voice.id, voice))
    if (!result.hasMore) break
  }

  const publicResult = await fetchFishModelPage(apiKey, {
    page_size: String(FISH_PUBLIC_MODEL_LIST_PAGE_SIZE),
    page_number: '1',
    sort_by: 'score'
  })
  publicResult.voices.forEach((voice) => {
    if (!merged.has(voice.id)) {
      merged.set(voice.id, voice)
    }
  })

  return Array.from(merged.values())
}

function mapElevenLabsVoiceToSummary(voice: any): VoiceSummary | null {
  const id = typeof voice?.voice_id === 'string'
    ? voice.voice_id
    : typeof voice?.id === 'string'
      ? voice.id
      : ''
  if (!id) return null

  const category = typeof voice?.category === 'string' ? voice.category : undefined
  return {
    id,
    name: typeof voice?.name === 'string' && voice.name.trim() ? voice.name : id,
    category,
    previewUrl: typeof voice?.preview_url === 'string' ? voice.preview_url : undefined,
    isClone: category === 'cloned' || category === 'custom' || category === 'generated',
    provider: 'elevenlabs'
  }
}

async function listElevenLabsVoices(userId: string): Promise<VoiceSummary[]> {
  const apiKey = await resolveApiKey(userId, 'elevenlabs', ['ELEVENLABS_API_KEY'])
  if (!apiKey) throw new Error('ElevenLabs API key not configured')

  const merged = new Map<string, VoiceSummary>()
  let nextPageToken: string | null = null

  for (let page = 0; page < ELEVENLABS_VOICE_LIST_PAGE_LIMIT; page += 1) {
    const url = new URL('https://api.elevenlabs.io/v2/voices')
    url.searchParams.set('page_size', String(ELEVENLABS_VOICE_LIST_PAGE_SIZE))
    url.searchParams.set('include_total_count', 'false')
    if (nextPageToken) {
      url.searchParams.set('next_page_token', nextPageToken)
    }

    const response = await fetch(url.toString(), {
      headers: {
        'xi-api-key': apiKey,
        Accept: 'application/json'
      }
    })

    if (!response.ok) {
      const errorText = await response.text().catch(() => '')
      throw new Error(errorText || 'Failed to fetch ElevenLabs voices')
    }

    const payload = await response.json().catch(() => null)
    const voices = (Array.isArray(payload?.voices) ? payload.voices : []) as unknown[]
    voices
      .map(mapElevenLabsVoiceToSummary)
      .filter((voice): voice is VoiceSummary => Boolean(voice))
      .forEach((voice) => merged.set(voice.id, voice))

    const nextToken = typeof payload?.next_page_token === 'string'
      ? payload.next_page_token.trim()
      : ''
    if (payload?.has_more !== true || !nextToken) break
    nextPageToken = nextToken
  }

  return Array.from(merged.values())
}

function mapMistralVoiceToSummary(voice: any): VoiceSummary | null {
  const id = typeof voice?.id === 'string' ? voice.id.trim() : ''
  if (!id) return null

  const languages = Array.isArray(voice?.languages)
    ? voice.languages.filter((language: unknown): language is string => typeof language === 'string')
    : []
  const isUserVoice = typeof voice?.user_id === 'string' && voice.user_id.trim().length > 0
  const tags = Array.isArray(voice?.tags)
    ? voice.tags.filter((tag: unknown): tag is string => typeof tag === 'string')
    : []

  return {
    id,
    name: typeof voice?.name === 'string' && voice.name.trim() ? voice.name : id,
    category: isUserVoice
      ? 'Your Mistral voices'
      : tags.length > 0
        ? tags.join(', ')
        : 'Mistral voice',
    language: languages[0],
    isClone: isUserVoice,
    provider: 'mistral'
  }
}

async function listMistralVoices(userId: string): Promise<VoiceSummary[]> {
  const apiKey = await resolveApiKey(userId, 'mistral', ['MISTRAL_API_KEY'])
  if (!apiKey) throw new Error('Mistral API key not configured')

  const merged = new Map<string, VoiceSummary>()
  let offset = 0

  for (let page = 0; page < MISTRAL_VOICE_LIST_PAGE_LIMIT; page += 1) {
    const url = new URL('https://api.mistral.ai/v1/audio/voices')
    url.searchParams.set('limit', String(MISTRAL_VOICE_LIST_PAGE_SIZE))
    url.searchParams.set('offset', String(offset))

    const response = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json'
      }
    })

    if (!response.ok) {
      const errorText = await response.text().catch(() => '')
      throw new Error(errorText || 'Failed to fetch Mistral voices')
    }

    const payload = await response.json().catch(() => null)
    const items = (Array.isArray(payload?.items) ? payload.items : []) as unknown[]
    items
      .map(mapMistralVoiceToSummary)
      .filter((voice): voice is VoiceSummary => Boolean(voice))
      .forEach((voice) => merged.set(voice.id, voice))

    offset += items.length
    const total = typeof payload?.total === 'number' ? payload.total : null
    if (items.length === 0 || (total !== null && offset >= total)) break
  }

  return Array.from(merged.values())
}

function mapMiniMaxVoiceToSummary(voice: any, category: string): VoiceSummary | null {
  const id = typeof voice?.voice_id === 'string' ? voice.voice_id.trim() : ''
  if (!id) return null
  const description = Array.isArray(voice?.description)
    ? voice.description.filter((item: unknown): item is string => typeof item === 'string').join(' ')
    : ''
  return {
    id,
    name: typeof voice?.voice_name === 'string' && voice.voice_name.trim() ? voice.voice_name : id,
    category,
    previewUrl: undefined,
    isClone: category !== 'System voices',
    language: description.match(/\b(English|Chinese|Japanese|Korean|Spanish|French|German)\b/i)?.[1],
    provider: 'minimax'
  }
}

async function listMiniMaxVoices(userId: string): Promise<VoiceSummary[]> {
  const apiKey = await resolveApiKey(userId, 'minimax', ['MINIMAX_API_KEY'])
  if (!apiKey) throw new Error('MiniMax API key not configured')

  const response = await fetch('https://api.minimax.io/v1/get_voice', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify({ voice_type: 'all' })
  })

  if (!response.ok) {
    throw new Error(await readProviderError(response, 'Failed to fetch MiniMax voices'))
  }

  const payload = await response.json().catch(() => null)
  const sections: Array<[string, unknown[]]> = [
    ['System voices', Array.isArray(payload?.system_voice) ? payload.system_voice : []],
    ['Your MiniMax cloned voices', Array.isArray(payload?.voice_cloning) ? payload.voice_cloning : []],
    ['Your MiniMax generated voices', Array.isArray(payload?.voice_generation) ? payload.voice_generation : []]
  ]

  const merged = new Map<string, VoiceSummary>()
  for (const [category, voices] of sections) {
    voices
      .map((voice) => mapMiniMaxVoiceToSummary(voice, category))
      .filter((voice): voice is VoiceSummary => Boolean(voice))
      .forEach((voice) => merged.set(voice.id, voice))
  }

  return Array.from(merged.values())
}

function mapInworldVoiceToSummary(voice: any): VoiceSummary | null {
  const id = typeof voice?.voiceId === 'string' ? voice.voiceId.trim() : ''
  if (!id) return null
  const categories = Array.isArray(voice?.categories)
    ? voice.categories.filter((category: unknown): category is string => typeof category === 'string')
    : []
  const source = typeof voice?.source === 'string' ? voice.source : ''
  return {
    id,
    name: typeof voice?.displayName === 'string' && voice.displayName.trim() ? voice.displayName : id,
    category: source === 'IVC' ? 'Your Inworld voices' : categories.join(', ') || 'Inworld voice',
    language: typeof voice?.langCode === 'string' ? voice.langCode.replace('_', '-') : undefined,
    isClone: source === 'IVC',
    provider: 'inworld'
  }
}

async function listInworldVoices(userId: string): Promise<VoiceSummary[]> {
  const apiKey = await resolveApiKey(userId, 'inworld', ['INWORLD_API_KEY'])
  if (!apiKey) throw new Error('Inworld API key not configured')

  const merged = new Map<string, VoiceSummary>()
  let pageToken: string | null = null

  for (let page = 0; page < INWORLD_VOICE_LIST_PAGE_LIMIT; page += 1) {
    const url = new URL('https://api.inworld.ai/voices/v1/voices')
    url.searchParams.set('pageSize', String(INWORLD_VOICE_LIST_PAGE_SIZE))
    url.searchParams.set('orderBy', 'display_name asc')
    if (pageToken) {
      url.searchParams.set('pageToken', pageToken)
    }

    const response = await fetch(url.toString(), {
      headers: {
        Authorization: `Basic ${apiKey}`,
        Accept: 'application/json'
      }
    })

    if (!response.ok) {
      throw new Error(await readProviderError(response, 'Failed to fetch Inworld voices'))
    }

    const payload = await response.json().catch(() => null)
    const voices: unknown[] = Array.isArray(payload?.voices) ? payload.voices : []
    voices
      .map(mapInworldVoiceToSummary)
      .filter((voice): voice is VoiceSummary => Boolean(voice))
      .forEach((voice) => merged.set(voice.id, voice))

    const nextPageToken = typeof payload?.nextPageToken === 'string' ? payload.nextPageToken.trim() : ''
    if (!nextPageToken) break
    pageToken = nextPageToken
  }

  return Array.from(merged.values())
}

function mapCartesiaVoiceToSummary(voice: any): VoiceSummary | null {
  const id = typeof voice?.id === 'string' ? voice.id.trim() : ''
  if (!id) return null
  return {
    id,
    name: typeof voice?.name === 'string' && voice.name.trim() ? voice.name : id,
    category: voice?.is_owner === true ? 'Your Cartesia voices' : 'Cartesia voice',
    language: typeof voice?.language === 'string' ? voice.language : undefined,
    isClone: voice?.is_owner === true,
    previewUrl: typeof voice?.preview_file_url === 'string' ? voice.preview_file_url : undefined,
    provider: 'cartesia'
  }
}

async function listCartesiaVoices(userId: string): Promise<VoiceSummary[]> {
  const apiKey = await resolveApiKey(userId, 'cartesia', ['CARTESIA_API_KEY'])
  if (!apiKey) throw new Error('Cartesia API key not configured')

  const merged = new Map<string, VoiceSummary>()
  let startingAfter: string | null = null

  for (let page = 0; page < CARTESIA_VOICE_LIST_PAGE_LIMIT; page += 1) {
    const url = new URL('https://api.cartesia.ai/voices')
    url.searchParams.set('limit', String(CARTESIA_VOICE_LIST_PAGE_SIZE))
    url.searchParams.append('expand[]', 'preview_file_url')
    if (startingAfter) {
      url.searchParams.set('starting_after', startingAfter)
    }

    const response = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Cartesia-Version': CARTESIA_VERSION,
        Accept: 'application/json'
      }
    })

    if (!response.ok) {
      throw new Error(await readProviderError(response, 'Failed to fetch Cartesia voices'))
    }

    const payload = await response.json().catch(() => null)
    const voices: unknown[] = Array.isArray(payload?.data) ? payload.data : []
    voices
      .map(mapCartesiaVoiceToSummary)
      .filter((voice): voice is VoiceSummary => Boolean(voice))
      .forEach((voice) => merged.set(voice.id, voice))

    const nextPage = typeof payload?.next_page === 'string' ? payload.next_page.trim() : ''
    if (payload?.has_more !== true || !nextPage) break
    startingAfter = nextPage
  }

  return Array.from(merged.values())
}

function mapAsyncVoiceToSummary(voice: any): VoiceSummary | null {
  const id = typeof voice?.voice_id === 'string' ? voice.voice_id.trim() : ''
  if (!id) return null
  return {
    id,
    name: typeof voice?.name === 'string' && voice.name.trim() ? voice.name : id,
    category: voice?.voice_type === 'CUSTOM' ? 'Your Async voices' : 'Async voice',
    language: typeof voice?.language === 'string' ? voice.language : undefined,
    isClone: voice?.voice_type === 'CUSTOM',
    provider: 'async'
  }
}

async function listAsyncVoices(userId: string): Promise<VoiceSummary[]> {
  const apiKey = await resolveApiKey(userId, 'async', ['ASYNC_API_KEY'])
  if (!apiKey) throw new Error('Async API key not configured')

  const merged = new Map<string, VoiceSummary>()
  let cursor: string | null = null

  for (let page = 0; page < ASYNC_VOICE_LIST_PAGE_LIMIT; page += 1) {
    const body: Record<string, unknown> = { limit: ASYNC_VOICE_LIST_PAGE_SIZE }
    if (cursor) body.cursor = cursor

    const response = await fetch('https://api.async.com/voices', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        version: ASYNC_VERSION,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify(body)
    })

    if (!response.ok) {
      throw new Error(await readProviderError(response, 'Failed to fetch Async voices'))
    }

    const payload = await response.json().catch(() => null)
    const voices: unknown[] = Array.isArray(payload?.voices) ? payload.voices : []
    voices
      .map(mapAsyncVoiceToSummary)
      .filter((voice): voice is VoiceSummary => Boolean(voice))
      .forEach((voice) => merged.set(voice.id, voice))

    const nextCursor = typeof payload?.next_cursor === 'string' ? payload.next_cursor.trim() : ''
    if (!nextCursor) break
    cursor = nextCursor
  }

  return Array.from(merged.values())
}

function resolveAzureSpeechRegion(value: string | null): string {
  const region = value?.trim().toLowerCase()
  if (!region) {
    throw new Error('Azure Speech region not configured')
  }
  return region
}

async function listAzureVoices(userId: string): Promise<VoiceSummary[]> {
  const apiKey = await resolveApiKey(userId, 'azure_speech_key', ['AZURE_SPEECH_KEY'])
  if (!apiKey) throw new Error('Azure Speech key not configured')
  const region = resolveAzureSpeechRegion(
    await resolveApiKey(userId, 'azure_speech_region', ['AZURE_SPEECH_REGION'])
  )

  const response = await fetch(
    `https://${region}.tts.speech.microsoft.com/cognitiveservices/voices/list`,
    {
      headers: {
        'Ocp-Apim-Subscription-Key': apiKey,
        Accept: 'application/json'
      }
    }
  )

  if (!response.ok) {
    throw new Error(await readProviderError(response, 'Failed to fetch Azure Speech voices'))
  }

  const payload = await response.json().catch(() => null)
  const voices: unknown[] = Array.isArray(payload) ? payload : []
  return voices
    .map((voice): VoiceSummary | null => {
      const entry = voice as Record<string, unknown> | null
      const shortName = entry?.ShortName
      const displayName = entry?.DisplayName
      const gender = entry?.Gender
      const locale = entry?.Locale
      const id = typeof shortName === 'string' ? shortName.trim() : ''
      if (!id) return null
      return {
        id,
        name: typeof displayName === 'string' && displayName.trim()
          ? `${displayName} (${id})`
          : id,
        category: typeof gender === 'string' ? gender : 'Azure neural voice',
        language: typeof locale === 'string' ? locale : undefined,
        provider: 'azure'
      }
    })
    .filter((voice): voice is VoiceSummary => Boolean(voice))
}

export async function listVoices({
  userId,
  provider,
  model
}: {
  userId: string
  provider: VoiceProviderId
  model?: string | null
}): Promise<VoiceSummary[]> {
  if (provider === 'openai') {
    return getOpenAITtsVoicesForModel(model).map((voice) => ({
      id: voice,
      name: voice,
      provider
    }))
  }

  if (provider === 'google') {
    return GEMINI_TTS_VOICES.map((voice) => ({
      id: voice,
      name: voice,
      provider
    }))
  }

  if (provider === 'deepgram') {
    return DEEPGRAM_TTS_VOICES.map((voice) => ({
      id: voice.id,
      name: voice.name,
      provider
    }))
  }

  if (provider === 'fish') {
    return listFishVoices(userId)
  }

  if (provider === 'elevenlabs') {
    return listElevenLabsVoices(userId)
  }

  if (provider === 'mistral') {
    return listMistralVoices(userId)
  }

  if (provider === 'minimax') {
    return listMiniMaxVoices(userId)
  }

  if (provider === 'mimo') {
    return MIMO_TTS_VOICES.map((voice) => ({
      id: voice,
      name: voice,
      provider
    }))
  }

  if (provider === 'alibaba') {
    return ALIBABA_TTS_VOICES.map((voice) => ({
      id: voice,
      name: voice,
      provider
    }))
  }

  if (provider === 'inworld') {
    return listInworldVoices(userId)
  }

  if (provider === 'cartesia') {
    return listCartesiaVoices(userId)
  }

  if (provider === 'async') {
    return listAsyncVoices(userId)
  }

  if (provider === 'stepfun') {
    return STEPFUN_TTS_VOICES.map((voice) => ({
      id: voice,
      name: voice,
      provider
    }))
  }

  if (provider === 'azure') {
    return listAzureVoices(userId)
  }

  if (provider.startsWith(BYO_PROVIDER_ID_PREFIX)) {
    const config = await resolveByoEndpointConfig(userId, provider)
    return listByoVoicesForConfig(config)
  }

  return []
}

export async function synthesizeSpeech(request: VoiceSynthesisRequest): Promise<VoiceSynthesisResult> {
  const { text, userId } = request
  if (!text || text.trim().length === 0) {
    throw new Error('Text is required for speech synthesis')
  }
  if (text.length > MAX_TTS_CHARS) {
    throw new Error(`Text exceeds ${MAX_TTS_CHARS} characters`)
  }

  const resolved = await resolveVoiceConfig(request)
  if (!resolved.provider) {
    throw new Error('No voice provider configured')
  }

  if (resolved.provider === 'browser') {
    throw new Error('Browser TTS is only available on the client')
  }

  const textForSynthesis = text.trim() || text
  const resolvedOptions = resolved.options

  const resolvedModel = resolveOptionalString(resolved.model ?? undefined)
  const resolvedVoiceId = resolveOptionalString(resolved.voiceId ?? undefined)
  try {
    if (resolved.provider === 'google') {
      return synthesizeGemini({
        text: textForSynthesis,
        userId,
        model: resolvedModel ?? DEFAULT_GEMINI_TTS_MODEL,
        voiceId: resolvedVoiceId
      })
    }

    if (resolved.provider === 'openai') {
      return synthesizeOpenAI({
        text: textForSynthesis,
        userId,
        model: resolvedModel ?? DEFAULT_OPENAI_TTS_MODEL,
        voiceId: resolvedVoiceId,
        options: resolvedOptions
      })
    }

    if (resolved.provider === 'elevenlabs') {
      return synthesizeElevenLabs({
        text: textForSynthesis,
        userId,
        model: resolvedModel ?? DEFAULT_ELEVENLABS_TTS_MODEL,
        voiceId: resolvedVoiceId,
        options: resolvedOptions
      })
    }

    if (resolved.provider === 'deepgram') {
      return synthesizeDeepgram({
        text: textForSynthesis,
        userId,
        model: resolvedModel ?? DEFAULT_DEEPGRAM_TTS_MODEL,
        voiceId: resolvedVoiceId,
        options: resolvedOptions
      })
    }

    if (resolved.provider === 'mistral') {
      return synthesizeMistral({
        text: textForSynthesis,
        userId,
        model: resolvedModel ?? DEFAULT_MISTRAL_TTS_MODEL,
        voiceId: resolvedVoiceId,
        options: resolvedOptions
      })
    }

    if (resolved.provider === 'minimax') {
      return synthesizeMiniMax({
        text: textForSynthesis,
        userId,
        model: resolvedModel ?? DEFAULT_MINIMAX_TTS_MODEL,
        voiceId: resolvedVoiceId,
        options: resolvedOptions
      })
    }

    if (resolved.provider === 'mimo') {
      return synthesizeMiMo({
        text: textForSynthesis,
        userId,
        model: resolvedModel ?? DEFAULT_MIMO_TTS_MODEL,
        voiceId: resolvedVoiceId,
        options: resolvedOptions
      })
    }

    if (resolved.provider === 'alibaba') {
      return synthesizeAlibaba({
        text: textForSynthesis,
        userId,
        model: resolvedModel ?? DEFAULT_ALIBABA_TTS_MODEL,
        voiceId: resolvedVoiceId,
        options: resolvedOptions
      })
    }

    if (resolved.provider === 'inworld') {
      return synthesizeInworld({
        text: textForSynthesis,
        userId,
        model: resolvedModel ?? DEFAULT_INWORLD_TTS_MODEL,
        voiceId: resolvedVoiceId,
        options: resolvedOptions
      })
    }

    if (resolved.provider === 'cartesia') {
      return synthesizeCartesia({
        text: textForSynthesis,
        userId,
        model: resolvedModel ?? DEFAULT_CARTESIA_TTS_MODEL,
        voiceId: resolvedVoiceId,
        options: resolvedOptions
      })
    }

    if (resolved.provider === 'async') {
      return synthesizeAsync({
        text: textForSynthesis,
        userId,
        model: resolvedModel ?? DEFAULT_ASYNC_TTS_MODEL,
        voiceId: resolvedVoiceId,
        options: resolvedOptions
      })
    }

    if (resolved.provider === 'stepfun') {
      return synthesizeStepFun({
        text: textForSynthesis,
        userId,
        model: resolvedModel ?? DEFAULT_STEPFUN_TTS_MODEL,
        voiceId: resolvedVoiceId,
        options: resolvedOptions
      })
    }

    if (resolved.provider === 'azure') {
      return synthesizeAzure({
        text: textForSynthesis,
        userId,
        model: resolvedModel ?? DEFAULT_AZURE_TTS_MODEL,
        voiceId: resolvedVoiceId,
        options: resolvedOptions
      })
    }

    if (resolved.provider === 'fish') {
      throw new Error('Fish TTS is realtime-only and cannot be used through batch speech synthesis.')
    }

    if (resolved.provider.startsWith(BYO_PROVIDER_ID_PREFIX)) {
      return synthesizeByo({
        text: textForSynthesis,
        providerId: resolved.provider,
        userId,
        model: resolvedModel ?? undefined,
        voiceId: resolvedVoiceId,
        profileId: resolveOptionalString(resolved.profileId ?? undefined),
        options: resolvedOptions
      })
    }

    throw new Error(`Unsupported voice provider: ${resolved.provider}`)
  } catch (error) {
    throw createPrimaryProviderFailureError('TTS', resolved.provider, error)
  }
}

const realtimeTtsEncoder = new TextEncoder()

function encodeRealtimeTtsEvent(event: VoiceRealtimeTtsEvent): Uint8Array {
  return realtimeTtsEncoder.encode(`${JSON.stringify(event)}\n`)
}

function normalizeFishRealtimeSampleRate(value: unknown): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
  if ([8000, 16000, 24000, 32000, 44100].includes(parsed)) return parsed
  return FISH_REALTIME_DEFAULT_SAMPLE_RATE
}

function normalizeFishRealtimeLatency(value: unknown): 'low' | 'normal' | 'balanced' {
  return value === 'low' || value === 'normal' || value === 'balanced' ? value : 'balanced'
}

function normalizeFishRealtimeChunkLength(value: unknown): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
  if (!Number.isFinite(parsed)) return 200
  return Math.min(300, Math.max(100, Math.round(parsed)))
}

function setNumberIfFinite(target: Record<string, unknown>, key: string, value: unknown): void {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
  if (Number.isFinite(parsed)) {
    target[key] = parsed
  }
}

function buildRealtimeErrorEvent(error: unknown): VoiceRealtimeTtsEvent {
  return {
    type: 'error',
    error: extractVoiceErrorMessage(error),
    fallback: false
  }
}

async function readProviderError(response: Response, fallback: string): Promise<string> {
  const body = await response.text().catch(() => '')
  return body.trim() || fallback
}

async function* parseSseJsonStream(
  body: ReadableStream<Uint8Array>
): AsyncGenerator<Record<string, unknown>> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  const emitFrame = function* (frame: string): Generator<Record<string, unknown>> {
    const dataLines = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.replace(/^data:\s?/, ''))

    if (dataLines.length === 0) return
    const data = dataLines.join('\n').trim()
    if (!data || data === '[DONE]') return
    const parsed = JSON.parse(data)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      yield parsed as Record<string, unknown>
    }
  }

  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      let delimiterIndex = buffer.search(/\r?\n\r?\n/)
      while (delimiterIndex >= 0) {
        const frame = buffer.slice(0, delimiterIndex)
        const delimiterLength =
          buffer.slice(delimiterIndex, delimiterIndex + 4) === '\r\n\r\n' ? 4 : 2
        buffer = buffer.slice(delimiterIndex + delimiterLength)
        for (const event of emitFrame(frame)) {
          yield event
        }
        delimiterIndex = buffer.search(/\r?\n\r?\n/)
      }
    }

    buffer += decoder.decode()
    if (buffer.trim()) {
      for (const event of emitFrame(buffer)) {
        yield event
      }
    }
  } finally {
    reader.releaseLock()
  }
}

function parseJsonObjectsFromBuffer(buffer: string): {
  objects: Record<string, unknown>[]
  remainder: string
} {
  const objects: Record<string, unknown>[] = []
  let startIndex = -1
  let depth = 0
  let inString = false
  let escaped = false
  let consumedUntil = 0

  for (let index = 0; index < buffer.length; index += 1) {
    const char = buffer[index]

    if (startIndex < 0) {
      if (!char || /\s/.test(char)) {
        consumedUntil = index + 1
        continue
      }
      if (char !== '{') {
        throw new Error('Realtime speech returned a non-JSON stream chunk.')
      }
      startIndex = index
      depth = 0
      inString = false
      escaped = false
    }

    if (inString) {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }

    if (char === '"') {
      inString = true
      continue
    }
    if (char === '{') {
      depth += 1
      continue
    }
    if (char === '}') {
      depth -= 1
      if (depth === 0) {
        const raw = buffer.slice(startIndex, index + 1)
        const parsed = JSON.parse(raw)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('Realtime speech returned an invalid JSON object.')
        }
        objects.push(parsed as Record<string, unknown>)
        startIndex = -1
        consumedUntil = index + 1
      }
    }
  }

  return {
    objects,
    remainder: startIndex >= 0 ? buffer.slice(startIndex) : buffer.slice(consumedUntil)
  }
}

async function* parseJsonObjectStream(
  body: ReadableStream<Uint8Array>
): AsyncGenerator<Record<string, unknown>> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const parsed = parseJsonObjectsFromBuffer(buffer)
      buffer = parsed.remainder
      for (const object of parsed.objects) {
        yield object
      }
    }

    buffer += decoder.decode()
    const parsed = parseJsonObjectsFromBuffer(buffer)
    buffer = parsed.remainder
    for (const object of parsed.objects) {
      yield object
    }

    if (buffer.trim()) {
      throw new Error('Realtime speech ended with an incomplete JSON object.')
    }
  } finally {
    reader.releaseLock()
  }
}

function resolveFishRealtimeReferenceId(options: {
  voiceId?: string | null
}): string {
  const referenceId = resolveOptionalString(options.voiceId)
  if (!referenceId) {
    throw new Error(
      'Fish Audio voice is required for realtime TTS. Pick a Fish voice in Voice Settings before using realtime speech.'
    )
  }
  return referenceId
}

async function streamFishRealtimeSpeech(options: {
  text: string
  userId: string
  model: string
  voiceId?: string | null
  options?: ResolvedVoiceRuntimeOptions
  signal?: AbortSignal | null
}): Promise<ReadableStream<Uint8Array>> {
  const apiKey = await resolveApiKey(options.userId, 'fish', ['FISH_AUDIO_API_KEY', 'FISH_API_KEY'])
  if (!apiKey) throw new Error('Fish Audio API key not configured')

  const providerOptions = options.options?.providerOptions
  const referenceId = resolveFishRealtimeReferenceId({
    voiceId: options.voiceId
  })
  const sampleRate = normalizeFishRealtimeSampleRate(providerOptions?.sample_rate)
  const latency = normalizeFishRealtimeLatency(providerOptions?.latency)
  const chunkLength = normalizeFishRealtimeChunkLength(providerOptions?.chunk_length)
  const requestModel =
    resolveOptionalString(
      options.model,
      typeof providerOptions?.model === 'string' ? providerOptions.model : undefined
    ) ?? DEFAULT_FISH_TTS_MODEL

  const body: Record<string, unknown> = {
    text: options.text,
    reference_id: referenceId,
    format: FISH_REALTIME_FORMAT,
    sample_rate: sampleRate,
    latency,
    chunk_length: chunkLength,
    normalize: true
  }

  const prosody: Record<string, unknown> = {}
  setNumberIfFinite(prosody, 'speed', options.options?.common?.speed)
  setNumberIfFinite(prosody, 'volume', options.options?.common?.volume)
  if (Object.keys(prosody).length > 0) {
    body.prosody = prosody
  }
  setNumberIfFinite(body, 'temperature', providerOptions?.temperature)
  setNumberIfFinite(body, 'top_p', providerOptions?.top_p)

  const startedAt = performance.now()
  const upstreamAbortController = new AbortController()
  const abortFromCaller = () => upstreamAbortController.abort()
  options.signal?.addEventListener('abort', abortFromCaller, { once: true })

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let chunkCount = 0
      let audioBytes = 0

      try {
        const response = await fetch('https://api.fish.audio/v1/tts/stream/with-timestamp', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            Accept: 'text/event-stream',
            model: requestModel
          },
          body: JSON.stringify(body),
          signal: upstreamAbortController.signal
        })

        if (!response.ok) {
          throw new Error(await readProviderError(response, 'Fish Audio realtime TTS request failed.'))
        }
        if (!response.body) {
          throw new Error('Fish Audio realtime TTS did not return a stream.')
        }

        controller.enqueue(
          encodeRealtimeTtsEvent({
            type: 'start',
            provider: 'fish',
            model: requestModel,
            voiceId: referenceId,
            mediaType: `audio/pcm; codecs=pcm_s16le; rate=${sampleRate}`,
            audioFormat: 'pcm_s16le',
            sampleRate,
            channels: FISH_REALTIME_CHANNELS
          })
        )

        for await (const event of parseSseJsonStream(response.body)) {
          if (upstreamAbortController.signal.aborted) break
          const audioBase64 = typeof event.audio_base64 === 'string' ? event.audio_base64 : ''
          if (!audioBase64) continue

          const byteLength = Buffer.byteLength(audioBase64, 'base64')
          chunkCount += 1
          audioBytes += byteLength
          controller.enqueue(
            encodeRealtimeTtsEvent({
              type: 'audio',
              sequence: chunkCount,
              audioBase64,
              byteLength,
              content: typeof event.content === 'string' ? event.content : null,
              alignment: event.alignment ?? null,
              chunkSeq: typeof event.chunk_seq === 'number' ? event.chunk_seq : null,
              chunkAudioOffsetSec:
                typeof event.chunk_audio_offset_sec === 'number'
                  ? event.chunk_audio_offset_sec
                  : null
            })
          )
        }

        if (!upstreamAbortController.signal.aborted) {
          controller.enqueue(
            encodeRealtimeTtsEvent({
              type: 'end',
              chunkCount,
              audioBytes,
              elapsedMs: Math.round(performance.now() - startedAt)
            })
          )
        }
      } catch (error) {
        if (!upstreamAbortController.signal.aborted) {
          controller.enqueue(encodeRealtimeTtsEvent(buildRealtimeErrorEvent(error)))
        }
      } finally {
        options.signal?.removeEventListener('abort', abortFromCaller)
        controller.close()
      }
    },
    cancel() {
      upstreamAbortController.abort()
      options.signal?.removeEventListener('abort', abortFromCaller)
    }
  })
}

function normalizeInworldEnum<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  fallback: T[number]
): T[number] {
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) {
    return value as T[number]
  }
  return fallback
}

function normalizeInworldSampleRate(value: unknown): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
  if (!Number.isFinite(parsed)) return INWORLD_REALTIME_DEFAULT_SAMPLE_RATE
  return Math.max(8000, Math.min(48000, Math.round(parsed)))
}

function readAscii(bytes: Uint8Array, start: number, length: number): string {
  let value = ''
  for (let index = start; index < start + length && index < bytes.byteLength; index += 1) {
    value += String.fromCharCode(bytes[index] ?? 0)
  }
  return value
}

function readUInt32Le(bytes: Uint8Array, offset: number): number {
  if (offset + 4 > bytes.byteLength) return 0
  return (
    (bytes[offset] ?? 0) |
    ((bytes[offset + 1] ?? 0) << 8) |
    ((bytes[offset + 2] ?? 0) << 16) |
    ((bytes[offset + 3] ?? 0) << 24)
  ) >>> 0
}

function extractWavDataBytes(bytes: Uint8Array): Uint8Array {
  if (!isPcmWavAudio(bytes)) return bytes

  let offset = 12
  while (offset + 8 <= bytes.byteLength) {
    const chunkId = readAscii(bytes, offset, 4)
    const chunkSize = readUInt32Le(bytes, offset + 4)
    const dataStart = offset + 8
    const dataEnd = Math.min(bytes.byteLength, dataStart + chunkSize)
    if (chunkId === 'data') {
      return bytes.slice(dataStart, dataEnd)
    }
    offset = dataEnd + (chunkSize % 2)
  }

  return bytes
}

function buildInworldSpeechBody(options: {
  text: string
  model: string
  voiceId?: string | null
  runtimeOptions?: ResolvedVoiceRuntimeOptions
  mode: 'batch' | 'realtime'
}): { body: Record<string, unknown>; audioEncoding: string; sampleRate: number; voiceId: string } {
  const providerOptions = options.runtimeOptions?.providerOptions
  const voiceId = options.voiceId ?? DEFAULT_INWORLD_TTS_VOICE
  const audioEncoding =
    options.mode === 'realtime'
      ? 'LINEAR16'
      : normalizeInworldEnum(
          providerOptions?.audioEncoding,
          INWORLD_AUDIO_ENCODINGS,
          'LINEAR16'
        )
  const sampleRate = normalizeInworldSampleRate(providerOptions?.sampleRateHertz)
  const timestampType = normalizeInworldEnum(
    providerOptions?.timestampType,
    INWORLD_TIMESTAMP_TYPES,
    options.mode === 'realtime' ? 'WORD' : 'TIMESTAMP_TYPE_UNSPECIFIED'
  )
  const body: Record<string, unknown> = {
    text: options.text,
    voiceId,
    modelId: options.model,
    audioConfig: {
      audioEncoding,
      sampleRateHertz: sampleRate
    },
    deliveryMode: normalizeInworldEnum(
      providerOptions?.deliveryMode,
      INWORLD_DELIVERY_MODES,
      'BALANCED'
    ),
    applyTextNormalization: normalizeInworldEnum(
      providerOptions?.applyTextNormalization,
      INWORLD_TEXT_NORMALIZATION_MODES,
      'ON'
    )
  }

  const language = resolveOptionalString(
    typeof options.runtimeOptions?.common?.language === 'string'
      ? options.runtimeOptions.common.language
      : undefined,
    typeof providerOptions?.language === 'string' ? providerOptions.language : undefined
  )
  if (language) body.language = language

  setNumberIfFinite(body, 'temperature', providerOptions?.temperature)

  if (timestampType !== 'TIMESTAMP_TYPE_UNSPECIFIED') {
    body.timestampType = timestampType
  }

  if (options.mode === 'realtime') {
    body.timestampTransportStrategy = normalizeInworldEnum(
      providerOptions?.timestampTransportStrategy,
      INWORLD_TIMESTAMP_TRANSPORT_STRATEGIES,
      'SYNC'
    )
  }

  return {
    body,
    audioEncoding,
    sampleRate,
    voiceId
  }
}

function normalizeInworldPhone(phone: unknown): Record<string, unknown> | null {
  if (!phone || typeof phone !== 'object' || Array.isArray(phone)) return null
  const item = phone as Record<string, unknown>
  const phoneSymbol = typeof item.phoneSymbol === 'string' ? item.phoneSymbol : ''
  const visemeSymbol = typeof item.visemeSymbol === 'string' ? item.visemeSymbol : ''
  const startTimeSeconds =
    typeof item.startTimeSeconds === 'number'
      ? item.startTimeSeconds
      : Number(item.startTimeSeconds)
  const durationSeconds =
    typeof item.durationSeconds === 'number'
      ? item.durationSeconds
      : Number(item.durationSeconds)

  if (!phoneSymbol && !visemeSymbol) return null
  return {
    ...(phoneSymbol ? { phoneSymbol } : {}),
    ...(Number.isFinite(startTimeSeconds) ? { startTimeSeconds } : {}),
    ...(Number.isFinite(durationSeconds) ? { durationSeconds } : {}),
    ...(visemeSymbol ? { visemeSymbol } : {})
  }
}

function buildInworldPhoneticDetailsByWord(value: unknown): Map<number, Record<string, unknown>[]> {
  const map = new Map<number, Record<string, unknown>[]>()
  if (!Array.isArray(value)) return map

  for (const detail of value) {
    if (!detail || typeof detail !== 'object' || Array.isArray(detail)) continue
    const item = detail as Record<string, unknown>
    const wordIndex = typeof item.wordIndex === 'number' ? item.wordIndex : Number(item.wordIndex)
    if (!Number.isInteger(wordIndex) || wordIndex < 0) continue
    const phones = Array.isArray(item.phones)
      ? item.phones.map(normalizeInworldPhone).filter((phone): phone is Record<string, unknown> => Boolean(phone))
      : []
    if (phones.length > 0) {
      map.set(wordIndex, phones)
    }
  }

  return map
}

function buildInworldAlignment(timestampInfo: unknown): {
  content: string | null
  alignment: Record<string, unknown> | null
} {
  if (!timestampInfo || typeof timestampInfo !== 'object' || Array.isArray(timestampInfo)) {
    return { content: null, alignment: null }
  }

  const wordAlignment = (timestampInfo as { wordAlignment?: unknown }).wordAlignment
  if (!wordAlignment || typeof wordAlignment !== 'object' || Array.isArray(wordAlignment)) {
    return { content: null, alignment: null }
  }

  const raw = wordAlignment as Record<string, unknown>
  const words = Array.isArray(raw.words) ? raw.words : []
  const starts = Array.isArray(raw.wordStartTimeSeconds) ? raw.wordStartTimeSeconds : []
  const ends = Array.isArray(raw.wordEndTimeSeconds) ? raw.wordEndTimeSeconds : []
  const phoneticDetailsByWord = buildInworldPhoneticDetailsByWord(raw.phoneticDetails)
  const segments: Record<string, unknown>[] = []

  for (let index = 0; index < words.length; index += 1) {
    const text = typeof words[index] === 'string' ? words[index] : ''
    const start = typeof starts[index] === 'number' ? starts[index] : Number(starts[index])
    const end = typeof ends[index] === 'number' ? ends[index] : Number(ends[index])
    if (!text.trim() || !Number.isFinite(start) || !Number.isFinite(end)) continue
    segments.push({
      text,
      start,
      end,
      ...(phoneticDetailsByWord.has(index)
        ? { phoneticDetails: phoneticDetailsByWord.get(index) }
        : {})
    })
  }

  return {
    content: words.filter((word): word is string => typeof word === 'string').join('') || null,
    alignment: segments.length > 0 ? { segments } : null
  }
}

function extractInworldStreamResult(payload: Record<string, unknown>): Record<string, unknown> {
  const error = payload.error
  if (error && typeof error === 'object' && !Array.isArray(error)) {
    const message = (error as { message?: unknown }).message
    throw new Error(typeof message === 'string' && message.trim() ? message.trim() : 'Inworld realtime TTS stream failed.')
  }

  const result = payload.result
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    return result as Record<string, unknown>
  }

  return payload
}

async function streamInworldRealtimeSpeech(options: {
  text: string
  userId: string
  model: string
  voiceId?: string | null
  options?: ResolvedVoiceRuntimeOptions
  signal?: AbortSignal | null
}): Promise<ReadableStream<Uint8Array>> {
  if (options.text.length > 2000) {
    throw new Error('Inworld TTS input cannot exceed 2,000 characters')
  }
  const apiKey = await resolveApiKey(options.userId, 'inworld', ['INWORLD_API_KEY'])
  if (!apiKey) throw new Error('Inworld API key not configured')

  const request = buildInworldSpeechBody({
    text: options.text,
    model: options.model,
    voiceId: options.voiceId,
    runtimeOptions: options.options,
    mode: 'realtime'
  })

  const startedAt = performance.now()
  const upstreamAbortController = new AbortController()
  const abortFromCaller = () => upstreamAbortController.abort()
  options.signal?.addEventListener('abort', abortFromCaller, { once: true })

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let chunkCount = 0
      let audioBytes = 0

      try {
        const response = await fetch('https://api.inworld.ai/tts/v1/voice:stream', {
          method: 'POST',
          headers: {
            Authorization: `Basic ${apiKey}`,
            'Content-Type': 'application/json',
            Accept: 'application/json'
          },
          body: JSON.stringify(request.body),
          signal: upstreamAbortController.signal
        })

        if (!response.ok) {
          throw new Error(await readProviderError(response, 'Inworld realtime TTS request failed.'))
        }
        if (!response.body) {
          throw new Error('Inworld realtime TTS did not return a stream.')
        }

        controller.enqueue(
          encodeRealtimeTtsEvent({
            type: 'start',
            provider: 'inworld',
            model: options.model,
            voiceId: request.voiceId,
            mediaType: `audio/pcm; codecs=pcm_s16le; rate=${request.sampleRate}`,
            audioFormat: 'pcm_s16le',
            sampleRate: request.sampleRate,
            channels: INWORLD_REALTIME_CHANNELS
          })
        )

        for await (const object of parseJsonObjectStream(response.body)) {
          if (upstreamAbortController.signal.aborted) break
          const result = extractInworldStreamResult(object)
          const audioBase64 = typeof result.audioContent === 'string' ? result.audioContent : ''
          if (!audioBase64) continue

          const providerBytes = Uint8Array.from(Buffer.from(audioBase64, 'base64'))
          const pcmBytes = extractWavDataBytes(providerBytes)
          const eventAudioBase64 = Buffer.from(pcmBytes).toString('base64')
          const timestampInfo = result.timestampInfo ?? object.timestampInfo
          const { content, alignment } = buildInworldAlignment(timestampInfo)
          const chunkAudioOffsetSec =
            audioBytes /
            (request.sampleRate * INWORLD_REALTIME_CHANNELS * INWORLD_REALTIME_BYTES_PER_SAMPLE)

          chunkCount += 1
          audioBytes += pcmBytes.byteLength
          controller.enqueue(
            encodeRealtimeTtsEvent({
              type: 'audio',
              sequence: chunkCount,
              audioBase64: eventAudioBase64,
              byteLength: pcmBytes.byteLength,
              content,
              alignment,
              chunkSeq: chunkCount - 1,
              chunkAudioOffsetSec
            })
          )
        }

        if (!upstreamAbortController.signal.aborted) {
          controller.enqueue(
            encodeRealtimeTtsEvent({
              type: 'end',
              chunkCount,
              audioBytes,
              elapsedMs: Math.round(performance.now() - startedAt)
            })
          )
        }
      } catch (error) {
        if (!upstreamAbortController.signal.aborted) {
          controller.enqueue(encodeRealtimeTtsEvent(buildRealtimeErrorEvent(error)))
        }
      } finally {
        options.signal?.removeEventListener('abort', abortFromCaller)
        controller.close()
      }
    },
    cancel() {
      upstreamAbortController.abort()
      options.signal?.removeEventListener('abort', abortFromCaller)
    }
  })
}

export async function streamSpeechRealtime(
  request: VoiceSynthesisRequest,
  signal?: AbortSignal | null
): Promise<ReadableStream<Uint8Array>> {
  const { text, userId } = request
  if (!text || text.trim().length === 0) {
    throw new Error('Text is required for realtime speech synthesis')
  }
  if (text.length > MAX_TTS_CHARS) {
    throw new Error(`Text exceeds ${MAX_TTS_CHARS} characters`)
  }

  const resolved = await resolveVoiceConfig(request)
  if (!resolved.provider) {
    throw new Error('No voice provider configured')
  }
  if (resolved.provider === 'browser') {
    throw new Error('Browser TTS is only available on the client')
  }

  const textForSynthesis = text.trim() || text
  const resolvedOptions = resolved.options
  const resolvedModel = resolveOptionalString(resolved.model ?? undefined)
  const resolvedVoiceId = resolveOptionalString(resolved.voiceId ?? undefined)

  try {
    if (resolved.provider === 'fish') {
      return streamFishRealtimeSpeech({
        text: textForSynthesis,
        userId,
        model: resolvedModel ?? DEFAULT_FISH_TTS_MODEL,
        voiceId: resolvedVoiceId,
        options: resolvedOptions,
        signal
      })
    }

    if (resolved.provider === 'inworld') {
      return streamInworldRealtimeSpeech({
        text: textForSynthesis,
        userId,
        model: resolvedModel ?? DEFAULT_INWORLD_TTS_MODEL,
        voiceId: resolvedVoiceId,
        options: resolvedOptions,
        signal
      })
    }

    throw new Error(`Realtime TTS is not implemented for provider "${resolved.provider}".`)
  } catch (error) {
    throw createPrimaryProviderFailureError('TTS', resolved.provider, error)
  }
}

export async function transcribeAudio(request: VoiceTranscribeRequest): Promise<VoiceTranscribeResult> {
  const { audio, userId } = request
  if (!audio || audio.byteLength === 0) {
    throw new Error('Audio input is required for transcription')
  }
  if (audio.byteLength > MAX_TRANSCRIBE_BYTES) {
    throw new Error('Audio file is too large for transcription')
  }

  const userSettings = await redis.getUserSettings(userId)
  const normalizedSettings = normalizeVoiceSettings(userSettings?.voice_settings)
  const sttDefaults = normalizedSettings.stt

  const provider =
    normalizeProviderId(request.provider) ||
    normalizeProviderId(sttDefaults?.providerId)
  if (!provider) {
    throw new Error('No STT provider is configured.')
  }
  const byoProviderConfig = await getVoiceEngineRecordByProviderId(userId, provider)
  const engineSettings = getSttEngineSettingsFor(normalizedSettings, provider)
  const resolvedModel = resolveOptionalString(
    request.model,
    sttDefaults?.modelId,
    resolveSttDefaultModel(byoProviderConfig?.sttDefaults)
  )
  const resolvedLanguage = resolveOptionalString(
    request.language,
    engineSettings?.language,
    sttDefaults?.language,
    byoProviderConfig?.sttDefaults?.language
  )
  const mergedProviderOptions = mergeVoiceProviderBlocks(
    getProviderOptionsFor(sttDefaults?.providerOptions, provider),
    engineSettings?.providerOptions,
    byoProviderConfig?.sttDefaults?.providerOptions,
    toPlainObject(request.options?.providerOptions) as VoiceProviderOptionBlock | undefined
  )

  const validated = validateVoiceOptionsForProvider(provider, 'stt', {
    language: resolvedLanguage,
    providerOptions: mergedProviderOptions
  })

  try {
    if (provider === 'openai') {
      return transcribeOpenAI({
        audio,
        userId,
        model: resolvedModel ?? DEFAULT_OPENAI_STT_MODEL,
        language: validated.language,
        contentType: request.contentType ?? undefined
      })
    }

    if (provider === 'deepgram') {
      return transcribeDeepgram({
        audio,
        userId,
        model: resolvedModel ?? DEFAULT_DEEPGRAM_STT_MODEL,
        language: validated.language,
        contentType: request.contentType ?? undefined
      })
    }

    if (provider === 'fish') {
      return transcribeFish({
        audio,
        userId,
        model: resolvedModel ?? DEFAULT_FISH_STT_MODEL,
        language: validated.language,
        contentType: request.contentType ?? undefined
      })
    }

    if (provider === 'elevenlabs') {
      return transcribeElevenLabs({
        audio,
        userId,
        model: resolvedModel ?? DEFAULT_ELEVENLABS_STT_MODEL,
        language: validated.language,
        contentType: request.contentType ?? undefined
      })
    }

    if (provider === 'mistral') {
      return transcribeMistral({
        audio,
        userId,
        model: resolvedModel ?? DEFAULT_MISTRAL_STT_MODEL,
        language: validated.language,
        contentType: request.contentType ?? undefined
      })
    }

    if (provider.startsWith(BYO_PROVIDER_ID_PREFIX)) {
      return transcribeByo({
        audio,
        providerId: provider,
        userId,
        model: resolvedModel ?? undefined,
        language: validated.language,
        contentType: request.contentType ?? undefined,
        providerOptions: validated.providerOptions
      })
    }

    throw new Error(`Unsupported STT provider: ${provider}`)
  } catch (error) {
    throw createPrimaryProviderFailureError('STT', provider, error)
  }
}

export async function cloneVoice(request: VoiceCloneRequest): Promise<VoiceCloneResult> {
  const { provider, userId } = request
  if (!request.audio || request.audio.byteLength === 0) {
    throw new Error('Audio sample is required for cloning')
  }

  if (provider === 'elevenlabs') {
    const result = await cloneElevenLabs(request)
    return result
  }

  if (provider.startsWith(BYO_PROVIDER_ID_PREFIX)) {
    return cloneByoReferenceProfile(request)
  }

  throw new Error(`Voice cloning is not supported for provider: ${provider}`)
}

export async function createVoiceProfile(profile: VoiceProfileRecord): Promise<VoiceProfileRecord> {
  return createVoiceProfileRecord(profile)
}

export async function listVoiceProfiles(userId: string): Promise<VoiceProfileRecord[]> {
  return listVoiceProfileRecords(userId)
}

export async function deleteVoiceProfile(userId: string, profileId: string): Promise<void> {
  return deleteVoiceProfileRecord(userId, profileId)
}

type ResolvedVoiceRuntimeOptions = {
  common?: VoiceProviderOptionBlock
  providerOptions?: VoiceProviderOptionBlock
}

export type ByoSpeechRuntimeState = 'ready' | 'initializing' | 'error' | 'unreachable'

export type ByoSpeechRuntimeStatus = {
  ready: boolean
  reachable: boolean
  state: ByoSpeechRuntimeState
  statusHint?: string
  voicesDiscovered?: number
}

export type ByoSpeechRuntimeOptions = {
  common?: VoiceProviderOptionBlock
  providerOptions?: VoiceProviderOptionBlock
}

type ResolvedByoEndpointConfig = {
  providerId: VoiceProviderId
  name: string
  supportsTts: boolean
  supportsStt: boolean
  supportsClone: boolean
  adapterId?: string
  endpointId?: string
  baseUrl: string
  ttsPath: string
  sttPath: string
  healthPath: string
  voicesPath?: string
  requestFormat: 'batshit-byo' | 'openai-compatible'
  timeoutMs: number
  authMode: VoiceByoAuthMode
  authHeader: string
  authToken?: string
  expression?: VoiceEngineRecord['expression']
  voiceDiscovery?: VoiceEngineRecord['voiceDiscovery']
  voiceSurface?: VoiceEngineRecord['voiceSurface']
  readiness?: VoiceEngineRecord['readiness']
  runtimeCompatibility?: VoiceEngineRecord['runtimeCompatibility']
  ttsDefaults?: VoiceEngineRecord['ttsDefaults']
  sttDefaults?: VoiceEngineRecord['sttDefaults']
}

const byoSpeechStatusCache = new Map<
  string,
  {
    expiresAt: number
    status: ByoSpeechRuntimeStatus
  }
>()

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

const normalizePathWithDefault = (value: string | undefined, fallback: string) => {
  const trimmed = value?.trim()
  if (!trimmed) return fallback
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`
}

function isContainerizedRuntime(): boolean {
  return (
    env.BATSHIT_CONTAINERIZED === '1' ||
    process.env.BATSHIT_CONTAINERIZED === '1' ||
    env.BATSHIT_RUNTIME_ENV === 'docker' ||
    process.env.BATSHIT_RUNTIME_ENV === 'docker'
  )
}

function rewriteLoopbackByoBaseUrlForRuntime(value: string): string {
  if (!isContainerizedRuntime()) return value

  try {
    const parsed = new URL(value)
    if (!LOOPBACK_HOSTS.has(parsed.hostname)) return value
    parsed.hostname =
      env.BATSHIT_DOCKER_HOST_GATEWAY_HOST?.trim() ||
      process.env.BATSHIT_DOCKER_HOST_GATEWAY_HOST?.trim() ||
      'host.docker.internal'
    return parsed.toString().replace(/\/+$/, '')
  } catch {
    return value
  }
}

function buildByoAuthHeaders(config: ResolvedByoEndpointConfig): Record<string, string> {
  if (!config.authToken) return {}
  if (config.authMode === 'none') return {}

  if (config.authMode === 'header') {
    return { [config.authHeader]: config.authToken }
  }

  if (
    config.authHeader.toLowerCase() === 'authorization' &&
    /^bearer\s+/i.test(config.authToken)
  ) {
    return { [config.authHeader]: config.authToken }
  }

  return { [config.authHeader]: `Bearer ${config.authToken}` }
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timeout)
  }
}

async function resolveByoEndpointConfig(
  userId: string,
  providerId: VoiceProviderId,
  options?: { allowDisabled?: boolean }
): Promise<ResolvedByoEndpointConfig> {
  const providerKey = parseByoProviderKey(providerId)
  if (!providerKey) {
    throw new Error('Invalid BYO provider selection.')
  }

  const byo = await getVoiceEngineRecordByProviderId(userId, providerId)
  if (!byo) {
    throw new Error(`BYO provider "${providerKey}" is not configured.`)
  }
  return resolveByoEndpointConfigFromRecord(byo, {
    userId,
    providerId,
    allowDisabled: options?.allowDisabled
  })
}

async function resolveStoredByoAuthToken(
  record: VoiceEngineRecord,
  userId?: string
): Promise<string | undefined> {
  const direct = resolveOptionalString(record.authToken) ?? undefined
  if (direct) return direct

  const savedKeyRef = resolveOptionalString(record.authSavedKeyRef)
  if (!savedKeyRef) return undefined

  if (!userId) {
    throw new Error(
      `BYO provider "${record.name}" requires saved-key auth, but no user context was provided.`
    )
  }

  const normalizedService = normalizeApiKeyServiceName(savedKeyRef)
  if (!isUserFacingApiKeyService(normalizedService)) {
    throw new Error(
      `BYO provider "${record.name}" references unsupported saved API key "${savedKeyRef}".`
    )
  }

  const stored = await apiKeyService.retrieve(normalizedService, userId).catch(() => null)
  const trimmed = stored?.trim()
  if (!trimmed) {
    throw new Error(
      `BYO provider "${record.name}" is missing the saved API key "${normalizedService}" in Settings.`
    )
  }

  return trimmed
}

async function resolveByoEndpointConfigFromRecord(
  record: VoiceEngineRecord,
  options?: { providerId?: VoiceProviderId; allowDisabled?: boolean; userId?: string }
): Promise<ResolvedByoEndpointConfig> {
  const providerId = options?.providerId ?? (`byo:${record.id}` as VoiceProviderId)

  if (record.enabled === false && options?.allowDisabled !== true) {
    throw new Error(`BYO provider "${record.name}" is disabled.`)
  }

  const baseUrl = rewriteLoopbackByoBaseUrlForRuntime(normalizeBaseUrl(record.baseUrl ?? ''))
  if (!baseUrl) {
    throw new Error(`BYO provider "${record.name}" is missing a base URL.`)
  }

  const timeoutMsRaw =
    typeof record.timeoutMs === 'number' ? Math.floor(record.timeoutMs) : BYO_DEFAULT_TIMEOUT_MS
  const timeoutMs = Math.min(Math.max(timeoutMsRaw, 500), 120_000)

  const authToken = await resolveStoredByoAuthToken(record, options?.userId)
  const authMode: VoiceByoAuthMode = record.authMode ?? (authToken ? 'bearer' : 'none')
  const authHeader = resolveOptionalString(record.authHeader) ?? 'Authorization'
  const voicesPath = record.voiceDiscovery?.path ?? record.voicesPath

  return {
    providerId,
    name: record.name,
    supportsTts: record.supportsTts !== false,
    supportsStt: record.supportsStt !== false,
    supportsClone: record.supportsClone === true,
    adapterId: resolveOptionalString(record.adapterId) ?? undefined,
    endpointId: resolveOptionalString(record.endpointId) ?? undefined,
    baseUrl,
    ttsPath: normalizePathWithDefault(record.ttsPath, '/tts'),
    sttPath: normalizePathWithDefault(record.sttPath, '/stt'),
    healthPath: normalizePathWithDefault(record.healthPath, '/health'),
    voicesPath: voicesPath ? normalizePathWithDefault(voicesPath, '/voices') : undefined,
    requestFormat: record.requestFormat ?? 'batshit-byo',
    timeoutMs,
    authMode,
    authHeader,
    authToken,
    expression: record.expression,
    voiceDiscovery: record.voiceDiscovery,
    voiceSurface: record.voiceSurface,
    readiness: record.readiness,
    runtimeCompatibility: record.runtimeCompatibility,
    ttsDefaults: record.ttsDefaults,
    sttDefaults: record.sttDefaults
  }
}

function coerceByoHealthStatus(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim().toLowerCase() : null
}

function buildByoHealthHint(payload: Record<string, unknown>): string | undefined {
  const candidates = [
    payload.initialization_error,
    payload.error,
    payload.initialization_progress,
    payload.message
  ]

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate.trim()
    }
    const message =
      candidate && typeof candidate === 'object' && !Array.isArray(candidate)
        ? (candidate as Record<string, unknown>).message
        : undefined
    if (
      typeof message === 'string' &&
      message.trim().length > 0
    ) {
      return message.trim()
    }
  }

  return undefined
}

function interpretByoHealthPayload(
  payload: unknown
): Pick<ByoSpeechRuntimeStatus, 'ready' | 'state' | 'statusHint'> | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return null
  }

  const record = payload as Record<string, unknown>
  const status =
    coerceByoHealthStatus(record.status) ??
    coerceByoHealthStatus(record.initialization_state)
  const hint = buildByoHealthHint(record)
  const modelLoaded = typeof record.model_loaded === 'boolean' ? record.model_loaded : undefined

  if (status && ['healthy', 'ready', 'ok', 'up', 'pass', 'passed'].includes(status)) {
    return {
      ready: modelLoaded !== false,
      state: modelLoaded === false ? 'initializing' : 'ready',
      statusHint: modelLoaded === false ? hint ?? 'Health endpoint responded, but the model is not loaded yet.' : hint
    }
  }

  if (status && ['initializing', 'loading', 'starting', 'warming', 'booting'].includes(status)) {
    return {
      ready: false,
      state: 'initializing',
      statusHint: hint ?? `Health endpoint reached ${status}.`
    }
  }

  if (status && ['error', 'failed', 'unhealthy'].includes(status)) {
    return {
      ready: false,
      state: 'error',
      statusHint: hint ?? `Health endpoint reached ${status}.`
    }
  }

  if (modelLoaded === false) {
    return {
      ready: false,
      state: 'initializing',
      statusHint: hint ?? 'Health endpoint responded, but the model is not loaded yet.'
    }
  }

  if (modelLoaded === true) {
    return {
      ready: true,
      state: 'ready',
      statusHint: hint
    }
  }

  return null
}

function getValueAtPath(value: unknown, path: string | undefined): unknown {
  if (!path) return value
  return path.split('.').reduce<unknown>((current, segment) => {
    if (!current || typeof current !== 'object' || Array.isArray(current)) {
      return undefined
    }
    return (current as Record<string, unknown>)[segment]
  }, value)
}

function toConfiguredVoiceSummary(
  entry: unknown,
  providerId: VoiceProviderId,
  config: ResolvedByoEndpointConfig
): VoiceSummary | null {
  if (typeof entry === 'string') {
    const trimmed = entry.trim()
    if (!trimmed) return null
    return {
      id: trimmed,
      name: trimmed,
      provider: providerId
    }
  }

  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return null
  }

  const source = entry as Record<string, unknown>
  const configuredId = getValueAtPath(source, config.voiceDiscovery?.idField)
  const configuredName = getValueAtPath(source, config.voiceDiscovery?.nameField)
  const configuredCategory = getValueAtPath(source, config.voiceDiscovery?.categoryField)
  const configuredLanguage = getValueAtPath(source, config.voiceDiscovery?.languageField)
  const id =
    resolveOptionalString(
      typeof configuredId === 'string'
        ? configuredId
        : typeof source.id === 'string'
          ? source.id
          : typeof source.voice_id === 'string'
            ? source.voice_id
            : typeof source.voiceId === 'string'
              ? source.voiceId
              : typeof source.name === 'string'
                ? source.name
                : undefined
    ) ?? ''
  if (!id) return null

  const name =
    resolveOptionalString(
      typeof configuredName === 'string'
        ? configuredName
        : typeof source.name === 'string'
          ? source.name
          : typeof source.voice_id === 'string'
            ? source.voice_id
            : typeof source.voiceId === 'string'
              ? source.voiceId
              : typeof source.id === 'string'
                ? source.id
                : undefined
    ) ?? id

  return {
    id,
    name,
    category:
      resolveOptionalString(
        typeof configuredCategory === 'string'
          ? configuredCategory
          : typeof source.category === 'string'
            ? source.category
            : undefined
      ) ?? undefined,
    language:
      resolveOptionalString(
        typeof configuredLanguage === 'string'
          ? configuredLanguage
          : typeof source.language === 'string'
            ? source.language
            : undefined
      ) ?? undefined,
    provider: providerId
  }
}

async function listByoVoicesForConfig(config: ResolvedByoEndpointConfig): Promise<VoiceSummary[]> {
  const staticVoices = buildStaticVoiceSummaries(config.providerId, config.voiceSurface?.voices)

  if (config.voiceDiscovery?.mode !== 'http' && !config.voicesPath) {
    return staticVoices
  }
  if (!config.voicesPath) {
    return staticVoices
  }

  const response = await fetchWithTimeout(
    `${config.baseUrl}${config.voicesPath}`,
    {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        ...buildByoAuthHeaders(config)
      }
    },
    Math.min(config.timeoutMs, 10_000)
  )

  if (!response.ok) {
    const errorText = await response.text().catch(() => '')
    throw new Error(errorText || `Voice list request failed (${response.status})`)
  }

  const payload = (await response.json().catch(() => null)) as unknown
  const entries =
    getValueAtPath(payload, config.voiceDiscovery?.responsePath) ??
    (payload && typeof payload === 'object' && !Array.isArray(payload)
      ? ((payload as Record<string, unknown>).voices ??
          (payload as Record<string, unknown>).data)
      : payload)

  if (!Array.isArray(entries)) {
    return staticVoices
  }

  const discovered = entries
    .map((entry) => toConfiguredVoiceSummary(entry, config.providerId, config))
    .filter((entry): entry is VoiceSummary => Boolean(entry))

  return discovered.length > 0 ? discovered : staticVoices
}

export async function listByoVoicesForRecord(
  record: VoiceEngineRecord,
  options?: { providerId?: VoiceProviderId; allowDisabled?: boolean; userId?: string }
): Promise<VoiceSummary[]> {
  const config = await resolveByoEndpointConfigFromRecord(record, options)
  return listByoVoicesForConfig(config)
}

async function probeByoHealth(config: ResolvedByoEndpointConfig): Promise<ByoSpeechRuntimeStatus> {
  const url = `${config.baseUrl}${config.healthPath}`
  try {
    const response = await fetchWithTimeout(
      url,
      {
        method: 'GET',
        headers: buildByoAuthHeaders(config)
      },
      Math.min(config.timeoutMs, 10_000)
    )

    if (response.ok) {
      const body = await response.text().catch(() => '')
      if (body.trim()) {
        try {
          const interpreted = interpretByoHealthPayload(JSON.parse(body))
          if (interpreted) {
            return {
              ...interpreted,
              reachable: true
            }
          }
        } catch {
          // Non-JSON health payloads are treated as generic success below.
        }
      }
      return {
        ready: true,
        reachable: true,
        state: 'ready'
      }
    }

    if ([404, 405].includes(response.status)) {
      return {
        ready: true,
        reachable: true,
        state: 'ready',
        statusHint: 'Host reachable (health route not found)'
      }
    }

    const body = await response.text().catch(() => '')
    return {
      ready: false,
      reachable: true,
      state: 'error',
      statusHint: body?.trim() || `Health check failed (${response.status})`
    }
  } catch (error) {
    return {
      ready: false,
      reachable: false,
      state: 'unreachable',
      statusHint: error instanceof Error ? error.message : 'BYO endpoint not reachable'
    }
  }
}

async function inspectByoSpeechRuntimeForConfig(
  config: ResolvedByoEndpointConfig
): Promise<ByoSpeechRuntimeStatus> {
  const healthStatus = await probeByoHealth(config)
  if (!healthStatus.ready) {
    return healthStatus
  }

  const requiresVoiceList =
    config.readiness?.mode === 'health_and_voice_list' ||
    config.readiness?.requireVoices === true
  if (!requiresVoiceList) {
    return healthStatus
  }

  try {
    const voices = await listByoVoicesForConfig(config)
    if (config.readiness?.requireVoices && voices.length === 0) {
      return {
        ready: false,
        reachable: true,
        state: 'error',
        statusHint: 'Health check passed, but the configured voice list returned no voices.',
        voicesDiscovered: 0
      }
    }

    return {
      ready: true,
      reachable: true,
      state: 'ready',
      statusHint:
        voices.length > 0
          ? `Health check passed (${voices.length} voices discovered).`
          : healthStatus.statusHint ?? 'Health check passed.',
      voicesDiscovered: voices.length
    }
  } catch (error) {
    return {
      ready: false,
      reachable: true,
      state: 'error',
      statusHint: error instanceof Error ? error.message : 'Voice list check failed'
    }
  }
}

function buildByoSpeechStatusCacheKey(config: ResolvedByoEndpointConfig): string {
  return JSON.stringify({
    providerId: config.providerId,
    baseUrl: config.baseUrl,
    healthPath: config.healthPath,
    voicesPath: config.voicesPath ?? null,
    readiness: config.readiness ?? null,
    voiceDiscovery: config.voiceDiscovery ?? null,
    requestFormat: config.requestFormat,
    timeoutMs: config.timeoutMs,
    authMode: config.authMode,
    authHeader: config.authHeader,
    hasAuthToken: Boolean(config.authToken)
  })
}

async function inspectByoSpeechRuntimeForConfigCached(
  config: ResolvedByoEndpointConfig
): Promise<ByoSpeechRuntimeStatus> {
  const cacheKey = buildByoSpeechStatusCacheKey(config)
  const now = Date.now()
  const cached = byoSpeechStatusCache.get(cacheKey)
  if (cached && cached.expiresAt > now) {
    return { ...cached.status }
  }

  const status = await inspectByoSpeechRuntimeForConfig(config)
  byoSpeechStatusCache.set(cacheKey, {
    expiresAt: now + BYO_STATUS_CACHE_TTL_MS,
    status: { ...status }
  })
  return status
}

export async function inspectByoSpeechRuntimeForRecord(
  record: VoiceEngineRecord,
  options?: { providerId?: VoiceProviderId; allowDisabled?: boolean; userId?: string }
): Promise<ByoSpeechRuntimeStatus> {
  const config = await resolveByoEndpointConfigFromRecord(record, options)
  return inspectByoSpeechRuntimeForConfig(config)
}

export async function checkByoSpeechStatus(
  userId: string,
  providerId: VoiceProviderId,
  options?: { useCache?: boolean }
): Promise<{ ready: boolean; statusHint?: string }> {
  let status: ByoSpeechRuntimeStatus
  try {
    const config = await resolveByoEndpointConfig(userId, providerId, { allowDisabled: true })
    status = options?.useCache
      ? await inspectByoSpeechRuntimeForConfigCached(config)
      : await inspectByoSpeechRuntimeForConfig(config)
  } catch (error) {
    return {
      ready: false,
      statusHint: error instanceof Error ? error.message : 'BYO Speech is not configured'
    }
  }

  return {
    ready: status.ready,
    statusHint: status.statusHint
  }
}

export function __clearByoSpeechStatusCacheForTests(): void {
  byoSpeechStatusCache.clear()
}

function toPlainObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function normalizeRequestProviderOptions(
  providerId: VoiceProviderId | null,
  value: unknown
): Record<string, unknown> | undefined {
  const providerOptions = toPlainObject(value)
  if (!providerOptions) return undefined

  if (providerId && toPlainObject(providerOptions[providerId])) {
    return providerOptions
  }

  if (providerId) {
    return {
      [providerId]: providerOptions
    }
  }

  return providerOptions
}

function normalizeRequestTtsConfig(
  providerId: VoiceProviderId | null,
  payload: {
    model?: string | null
    voiceId?: string | null
    profileId?: string | null
    options?: Record<string, any>
  }
): VoiceTtsConfig | undefined {
  const options = payload.options ?? {}
  return normalizeVoiceTtsConfig({
    providerId: providerId ?? undefined,
    modelId: payload.model ?? undefined,
    voiceId: payload.voiceId ?? undefined,
    profileId: payload.profileId ?? undefined,
    common: toPlainObject(options.common),
    providerOptions: normalizeRequestProviderOptions(providerId, options.providerOptions),
    style: options
  })
}

function flattenResolvedStyle(
  providerId: VoiceProviderId | null,
  common?: VoiceProviderOptionBlock,
  providerOptions?: VoiceProviderOptionBlock
) {
  const tts: VoiceTtsConfig = {
    providerId: providerId ?? undefined,
    common: common as VoiceTtsConfig['common'] | undefined,
    providerOptions: providerId && providerOptions
      ? { [providerId]: providerOptions }
      : undefined
  }
  return flattenLegacyVoiceStyle(tts)
}

function voiceTtsConfigAppliesToProvider(
  config: VoiceTtsConfig | undefined,
  provider: VoiceProviderId | null | undefined
): config is VoiceTtsConfig {
  if (!config || !provider) return false
  const configProvider = normalizeProviderId(config.providerId)
  return !configProvider || configProvider === provider
}

async function resolveVoiceProfileTtsConfig(
  profileId: string | null | undefined,
  provider: VoiceProviderId | null
): Promise<{
  model?: string | null
  voiceId?: string | null
  tts?: VoiceTtsConfig
}> {
  if (!profileId) return {}

  const profile = await redis.getVoiceProfile(profileId)
  if (!profile) return {}

  return {
    model: resolveOptionalString(profile.model) ?? null,
    voiceId: resolveOptionalString(profile.voiceId) ?? null,
    tts: normalizeVoiceTtsConfig({
      providerId: provider ?? undefined,
      modelId: profile.model ?? undefined,
      voiceId: profile.voiceId ?? undefined,
      common: toPlainObject((profile.settings as Record<string, unknown> | undefined)?.common),
      providerOptions: toPlainObject((profile.settings as Record<string, unknown> | undefined)?.providerOptions),
      style: profile.settings
    })
  }
}

export async function resolveVoiceConfigForMetadata({
  userSettings,
  agent,
  metadata
}: {
  userSettings?: UserSettingsRow | null
  agent?: AgentRow | null
  metadata?: Record<string, any> | null
}) {
  const voiceSettings = normalizeVoiceSettings(userSettings?.voice_settings)
  const baseTts = voiceSettings.tts
  const agentVoice = normalizeAgentVoiceProfile(agent?.voice_profile)
  const agentTts = agentVoice?.tts
  const requestProvider = normalizeProviderId(metadata?.voiceProvider) ?? normalizeProviderId(metadata?.ttsProvider)

  const provider =
    requestProvider ||
    normalizeProviderId(agentTts?.providerId) ||
    normalizeProviderId(baseTts?.providerId) ||
    'browser'

  const profileId = resolveOptionalString(
    metadata?.voiceProfileId,
    agentTts?.profileId,
    baseTts?.profileId
  )

  const byoProviderConfig =
    userSettings?.user_id && provider
      ? await getVoiceEngineRecordByProviderId(userSettings.user_id, provider)
      : null
  const baseTtsForProvider = voiceTtsConfigAppliesToProvider(baseTts, provider)
    ? baseTts
    : undefined
  const agentTtsForProvider = voiceTtsConfigAppliesToProvider(agentTts, provider)
    ? agentTts
    : undefined
  const engineSettings = getTtsEngineSettingsFor(voiceSettings, provider)
  const profileTtsConfig = await resolveVoiceProfileTtsConfig(profileId, provider)

  const model = resolveOptionalString(
    metadata?.voiceModel,
    metadata?.ttsModel,
    agentTtsForProvider?.modelId,
    baseTtsForProvider?.modelId,
    profileTtsConfig.model,
    resolveTtsDefaultModel(byoProviderConfig?.ttsDefaults)
  )

  const voiceId = resolveOptionalString(
    metadata?.voiceId,
    metadata?.ttsVoiceId,
    agentTtsForProvider?.voiceId,
    baseTtsForProvider?.voiceId,
    profileTtsConfig.voiceId,
    byoProviderConfig?.ttsDefaults?.voiceId
  )

  const metadataTts = normalizeVoiceTtsConfig({
    providerId: provider,
    modelId: model ?? undefined,
    voiceId: voiceId ?? undefined,
    profileId: profileId ?? undefined,
    common:
      toPlainObject(metadata?.voice?.common) ??
      toPlainObject(metadata?.voiceCommon),
    providerOptions:
      normalizeRequestProviderOptions(provider, metadata?.voice?.providerOptions) ??
      normalizeRequestProviderOptions(provider, metadata?.voiceProviderOptions),
    style: metadata?.voice?.style ?? metadata?.voiceStyle ?? metadata?.voice_style
  })

  const mergedCommon = mergeVoiceCommon(
    baseTtsForProvider?.common,
    engineSettings?.common,
    byoProviderConfig?.ttsDefaults?.common,
    profileTtsConfig.tts?.common,
    metadataTts?.common
  )

  const mergedProviderOptions = mergeVoiceProviderBlocks(
    getProviderOptionsFor(baseTtsForProvider?.providerOptions, provider),
    engineSettings?.providerOptions,
    byoProviderConfig?.ttsDefaults?.providerOptions,
    getProviderOptionsFor(profileTtsConfig.tts?.providerOptions, provider),
    getProviderOptionsFor(metadataTts?.providerOptions, provider)
  )

  let validated: ResolvedVoiceRuntimeOptions = {
    common: mergedCommon as VoiceProviderOptionBlock | undefined,
    providerOptions: mergedProviderOptions
  }

  if (provider) {
    validated = validateVoiceOptionsForProvider(provider, 'tts', {
      common: mergedCommon,
      providerOptions: mergedProviderOptions
    })
  }

  const style = flattenResolvedStyle(provider, validated.common, validated.providerOptions)

  return {
    provider,
    model,
    voiceId,
    profileId,
    common: validated.common,
    providerOptions: validated.providerOptions,
    style
  }
}

async function resolveVoiceConfig(request: VoiceSynthesisRequest): Promise<{
  provider: VoiceProviderId | null
  model?: string | null
  voiceId?: string | null
  profileId?: string | null
  options?: ResolvedVoiceRuntimeOptions
}> {
  const userSettings = await redis.getUserSettings(request.userId)
  const baseSettings = normalizeVoiceSettings(userSettings?.voice_settings)
  const baseTts = baseSettings.tts

  const agent: AgentRow | null = request.agentId ? await redis.get(`agent:${request.agentId}`) : null
  const agentVoice = resolveAgentVoiceProfile(agent)
  const agentTts = agentVoice?.tts

  const provider =
    normalizeProviderId(request.provider) ||
    normalizeProviderId(agentTts?.providerId) ||
    normalizeProviderId(baseTts?.providerId) ||
    null
  const byoProviderConfig = await getVoiceEngineRecordByProviderId(request.userId, provider)
  const baseTtsForProvider = voiceTtsConfigAppliesToProvider(baseTts, provider)
    ? baseTts
    : undefined
  const agentTtsForProvider = voiceTtsConfigAppliesToProvider(agentTts, provider)
    ? agentTts
    : undefined
  const engineSettings = getTtsEngineSettingsFor(baseSettings, provider ?? undefined)

  let model = resolveOptionalString(
    request.model,
    agentTtsForProvider?.modelId,
    baseTtsForProvider?.modelId
  )
  let voiceId = resolveOptionalString(
    request.voiceId,
    agentTtsForProvider?.voiceId,
    baseTtsForProvider?.voiceId
  )
  let profileId = resolveOptionalString(
    request.profileId,
    agentTtsForProvider?.profileId,
    baseTtsForProvider?.profileId
  )

  const requestTts = normalizeRequestTtsConfig(provider, {
    model: request.model,
    voiceId: request.voiceId,
    profileId: request.profileId,
    options: request.options
  })

  let profileTts: VoiceTtsConfig | undefined
  if (profileId) {
    const resolvedProfile = await resolveVoiceProfileTtsConfig(profileId, provider)
    model = model ?? resolvedProfile.model ?? null
    voiceId = voiceId ?? resolvedProfile.voiceId ?? null
    profileTts = resolvedProfile.tts
  }

  model = model ?? resolveTtsDefaultModel(byoProviderConfig?.ttsDefaults) ?? null
  voiceId = voiceId ?? byoProviderConfig?.ttsDefaults?.voiceId ?? null

  const mergedCommon = mergeVoiceCommon(
    baseTtsForProvider?.common,
    engineSettings?.common,
    byoProviderConfig?.ttsDefaults?.common,
    profileTts?.common,
    requestTts?.common
  )

  const mergedProviderOptions = mergeVoiceProviderBlocks(
    getProviderOptionsFor(baseTtsForProvider?.providerOptions, provider ?? undefined),
    engineSettings?.providerOptions,
    byoProviderConfig?.ttsDefaults?.providerOptions,
    getProviderOptionsFor(profileTts?.providerOptions, provider ?? undefined),
    getProviderOptionsFor(requestTts?.providerOptions, provider ?? undefined)
  )

  let options: ResolvedVoiceRuntimeOptions | undefined
  if (provider) {
    const validated = validateVoiceOptionsForProvider(provider, 'tts', {
      common: mergedCommon,
      providerOptions: mergedProviderOptions
    })
    options = {
      common: validated.common,
      providerOptions: validated.providerOptions
    }
  } else {
    options = {
      common: mergedCommon as VoiceProviderOptionBlock | undefined,
      providerOptions: mergedProviderOptions
    }
  }

  return { provider, model, voiceId, profileId, options }
}

async function synthesizeOpenAI({
  text,
  userId,
  model,
  voiceId,
  options
}: {
  text: string
  userId: string
  model: string
  voiceId?: string | null
  options?: ResolvedVoiceRuntimeOptions
}): Promise<VoiceSynthesisResult> {
  const apiKey = await resolveApiKey(userId, 'openai', ['OPENAI_API_KEY'])
  if (!apiKey) throw new Error('OpenAI API key not configured')

  const openai = createOpenAI({ apiKey })
  const speechModel = openai.speech(model)

  const responseFormatRaw = options?.providerOptions?.format
  const responseFormat = typeof responseFormatRaw === 'string' && OPENAI_FORMATS.includes(responseFormatRaw)
    ? responseFormatRaw
    : 'mp3'

  const providerOptions: Record<string, any> = {
    openai: {
      response_format: responseFormat
    }
  }

  if (typeof options?.common?.instructions === 'string' && options.common.instructions.trim()) {
    providerOptions.openai.instructions = options.common.instructions.trim()
  }
  if (typeof options?.common?.speed === 'number') {
    providerOptions.openai.speed = options.common.speed
  }

  const result = await generateSpeech({
    model: speechModel,
    text,
    voice: voiceId ?? OPENAI_TTS_VOICES[0],
    providerOptions
  })

  const audioFile = result.audio
  const audio = audioFile?.uint8Array
    ? audioFile.uint8Array
    : audioFile?.base64
      ? Uint8Array.from(Buffer.from(audioFile.base64, 'base64'))
      : Uint8Array.from(Buffer.from(audioFile as any))

  return {
    audio,
    mediaType: MEDIA_TYPE_MAP[responseFormat] ?? 'audio/mpeg',
    voiceId: voiceId ?? OPENAI_TTS_VOICES[0],
    provider: 'openai',
    model
  }
}

const GEMINI_PCM_SAMPLE_RATE = 24000
const GEMINI_PCM_CHANNELS = 1
const GEMINI_PCM_BYTES_PER_SAMPLE = 2

const wrapPcmAsWav = (
  pcm: Uint8Array,
  sampleRate = GEMINI_PCM_SAMPLE_RATE,
  channels = GEMINI_PCM_CHANNELS,
  bytesPerSample = GEMINI_PCM_BYTES_PER_SAMPLE
) => {
  const blockAlign = channels * bytesPerSample
  const byteRate = sampleRate * blockAlign
  const headerSize = 44
  const buffer = Buffer.alloc(headerSize + pcm.length)

  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(36 + pcm.length, 4)
  buffer.write('WAVE', 8)
  buffer.write('fmt ', 12)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20) // PCM format
  buffer.writeUInt16LE(channels, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(byteRate, 28)
  buffer.writeUInt16LE(blockAlign, 32)
  buffer.writeUInt16LE(bytesPerSample * 8, 34)
  buffer.write('data', 36)
  buffer.writeUInt32LE(pcm.length, 40)

  Buffer.from(pcm).copy(buffer, headerSize)
  return new Uint8Array(buffer)
}

async function synthesizeGemini({
  text,
  userId,
  model,
  voiceId
}: {
  text: string
  userId: string
  model: string
  voiceId?: string | null
}): Promise<VoiceSynthesisResult> {
  const apiKey = await resolveApiKey(userId, 'google', ['GEMINI_API_KEY', 'GOOGLE_API_KEY'])
  if (!apiKey) throw new Error('Google Gemini API key not configured')

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text }] }],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: voiceId ?? DEFAULT_GEMINI_TTS_VOICE
              }
            }
          }
        }
      })
    }
  )

  if (!response.ok) {
    const errorText = await response.text().catch(() => '')
    throw new Error(errorText || 'Failed to synthesize speech with Gemini')
  }

  const payload = await response.json()
  const inlineData = payload?.candidates?.[0]?.content?.parts?.[0]?.inlineData
  const audioBase64 = inlineData?.data
  if (!audioBase64) {
    throw new Error('Gemini did not return audio data')
  }

  const rawAudio = Uint8Array.from(Buffer.from(audioBase64, 'base64'))
  const mimeType = typeof inlineData?.mimeType === 'string' ? inlineData.mimeType : ''

  const audio = mimeType.includes('wav') ? rawAudio : wrapPcmAsWav(rawAudio)
  const mediaType = mimeType.includes('wav') ? mimeType : 'audio/wav'

  return {
    audio,
    mediaType,
    voiceId: voiceId ?? DEFAULT_GEMINI_TTS_VOICE,
    provider: 'google',
    model
  }
}

async function synthesizeElevenLabs({
  text,
  userId,
  model,
  voiceId,
  options
}: {
  text: string
  userId: string
  model: string
  voiceId?: string | null
  options?: ResolvedVoiceRuntimeOptions
}): Promise<VoiceSynthesisResult> {
  const apiKey = await resolveApiKey(userId, 'elevenlabs', ['ELEVENLABS_API_KEY'])
  if (!apiKey) throw new Error('ElevenLabs API key not configured')

  if (!voiceId) throw new Error('ElevenLabs voiceId is required')

  const body: Record<string, any> = {
    text,
    model_id: model
  }

  const voiceSettings: Record<string, any> = {}
  if (typeof options?.providerOptions?.stability === 'number') {
    voiceSettings.stability = options.providerOptions.stability
  }
  if (typeof options?.providerOptions?.similarityBoost === 'number') {
    voiceSettings.similarity_boost = options.providerOptions.similarityBoost
  }
  if (typeof options?.providerOptions?.style === 'number') {
    voiceSettings.style = options.providerOptions.style
  }
  if (typeof options?.providerOptions?.speakerBoost === 'boolean') {
    voiceSettings.use_speaker_boost = options.providerOptions.speakerBoost
  }
  if (Object.keys(voiceSettings).length > 0) {
    body.voice_settings = voiceSettings
  }

  if (typeof options?.common?.language === 'string' && options.common.language.trim()) {
    body.language_code = options.common.language.trim()
  }
  if (typeof options?.common?.speed === 'number') {
    body.speed = options.common.speed
  }

  const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'audio/mpeg',
      'xi-api-key': apiKey
    },
    body: JSON.stringify(body)
  })

  if (!response.ok) {
    const errorText = await response.text().catch(() => '')
    throw new Error(errorText || 'Failed to synthesize speech with ElevenLabs')
  }

  const audioBuffer = new Uint8Array(await response.arrayBuffer())
  const mediaType = response.headers.get('content-type') || 'audio/mpeg'

  return {
    audio: audioBuffer,
    mediaType,
    voiceId,
    provider: 'elevenlabs',
    model
  }
}

async function synthesizeDeepgram({
  text,
  userId,
  model,
  voiceId,
  options
}: {
  text: string
  userId: string
  model: string
  voiceId?: string | null
  options?: ResolvedVoiceRuntimeOptions
}): Promise<VoiceSynthesisResult> {
  const apiKey = await resolveApiKey(userId, 'deepgram', ['DEEPGRAM_API_KEY'])
  if (!apiKey) throw new Error('Deepgram API key not configured')

  const targetModel = voiceId || model || DEFAULT_DEEPGRAM_TTS_MODEL
  const query = new URLSearchParams({
    model: targetModel
  })

  if (typeof options?.providerOptions?.encoding === 'string') {
    query.set('encoding', options.providerOptions.encoding)
  }
  if (typeof options?.providerOptions?.container === 'string') {
    query.set('container', options.providerOptions.container)
  }

  const response = await fetch(`https://api.deepgram.com/v1/speak?${query.toString()}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'audio/wav',
      Authorization: `Token ${apiKey}`
    },
    body: JSON.stringify({ text })
  })

  if (!response.ok) {
    const errorText = await response.text().catch(() => '')
    throw new Error(errorText || 'Failed to synthesize speech with Deepgram')
  }

  const audioBuffer = new Uint8Array(await response.arrayBuffer())
  const mediaType = response.headers.get('content-type') || 'audio/wav'

  return {
    audio: audioBuffer,
    mediaType,
    voiceId: targetModel,
    provider: 'deepgram',
    model: targetModel
  }
}

async function synthesizeMistral({
  text,
  userId,
  model,
  voiceId,
  options
}: {
  text: string
  userId: string
  model: string
  voiceId?: string | null
  options?: ResolvedVoiceRuntimeOptions
}): Promise<VoiceSynthesisResult> {
  const apiKey = await resolveApiKey(userId, 'mistral', ['MISTRAL_API_KEY'])
  if (!apiKey) throw new Error('Mistral API key not configured')

  const resolvedVoiceId = resolveOptionalString(
    voiceId,
    typeof options?.providerOptions?.voice_id === 'string'
      ? options.providerOptions.voice_id
      : undefined
  )
  if (!resolvedVoiceId) {
    throw new Error(
      'Mistral voice_id is required for Voxtral TTS. Save or enter a Mistral voice ID before using this provider.'
    )
  }

  const requestedFormat =
    typeof options?.providerOptions?.response_format === 'string'
      ? options.providerOptions.response_format
      : 'mp3'
  const responseFormat = ['mp3', 'wav', 'pcm', 'flac', 'opus'].includes(requestedFormat)
    ? requestedFormat
    : 'mp3'
  const body: Record<string, unknown> = {
    input: text,
    model,
    voice_id: resolvedVoiceId,
    response_format: responseFormat,
    stream: false
  }

  const response = await fetch('https://api.mistral.ai/v1/audio/speech', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify(body)
  })

  if (!response.ok) {
    const errorText = await response.text().catch(() => '')
    throw new Error(errorText || 'Failed to synthesize speech with Mistral')
  }

  const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null
  const audioBase64 =
    typeof payload?.audio_data === 'string' && payload.audio_data.trim()
      ? payload.audio_data.trim()
      : ''
  if (!audioBase64) {
    throw new Error('Mistral did not return audio data')
  }

  return {
    audio: Uint8Array.from(Buffer.from(audioBase64, 'base64')),
    mediaType: MEDIA_TYPE_MAP[responseFormat] ?? 'audio/mpeg',
    voiceId: resolvedVoiceId,
    provider: 'mistral',
    model
  }
}

function hexToBytes(hex: string): Uint8Array {
  const normalized = hex.trim()
  if (!/^[0-9a-f]+$/i.test(normalized) || normalized.length % 2 !== 0) {
    throw new Error('Provider returned invalid hex audio data')
  }
  return Uint8Array.from(Buffer.from(normalized, 'hex'))
}

function azureOutputFormatToMediaType(format: string): string {
  if (format.includes('mp3')) return 'audio/mpeg'
  if (format.startsWith('riff-')) return 'audio/wav'
  if (format.startsWith('ogg-')) return 'audio/ogg'
  if (format.includes('opus')) return 'audio/opus'
  return 'application/octet-stream'
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

async function downloadProviderAudio(url: string, fallbackMediaType: string): Promise<{
  audio: Uint8Array
  mediaType: string
}> {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(await readProviderError(response, 'Failed to download synthesized audio'))
  }
  return {
    audio: new Uint8Array(await response.arrayBuffer()),
    mediaType: response.headers.get('content-type') || fallbackMediaType
  }
}

async function synthesizeMiniMax({
  text,
  userId,
  model,
  voiceId,
  options
}: {
  text: string
  userId: string
  model: string
  voiceId?: string | null
  options?: ResolvedVoiceRuntimeOptions
}): Promise<VoiceSynthesisResult> {
  const apiKey = await resolveApiKey(userId, 'minimax', ['MINIMAX_API_KEY'])
  if (!apiKey) throw new Error('MiniMax API key not configured')

  const format =
    typeof options?.providerOptions?.format === 'string' &&
    ['mp3', 'wav', 'flac'].includes(options.providerOptions.format)
      ? options.providerOptions.format
      : 'mp3'
  const sampleRate =
    typeof options?.providerOptions?.sample_rate === 'string'
      ? Number(options.providerOptions.sample_rate)
      : 32000
  const bitrate =
    typeof options?.providerOptions?.bitrate === 'number'
      ? options.providerOptions.bitrate
      : 128000

  const body: Record<string, unknown> = {
    model,
    text,
    stream: false,
    output_format: 'hex',
    voice_setting: {
      voice_id: voiceId ?? DEFAULT_MINIMAX_TTS_VOICE,
      speed: typeof options?.common?.speed === 'number' ? options.common.speed : 1,
      vol: typeof options?.common?.volume === 'number' ? options.common.volume : 1,
      pitch: typeof options?.providerOptions?.pitch === 'number' ? options.providerOptions.pitch : 0
    },
    audio_setting: {
      sample_rate: Number.isFinite(sampleRate) ? sampleRate : 32000,
      bitrate,
      format,
      channel: 1
    }
  }

  if (typeof options?.providerOptions?.language_boost === 'string') {
    body.language_boost = options.providerOptions.language_boost
  }

  const baseUrl = (env.MINIMAX_API_BASE_URL ?? 'https://api.minimax.io/v1').replace(/\/+$/, '')
  const response = await fetch(`${baseUrl}/t2a_v2`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify(body)
  })

  if (!response.ok) {
    throw new Error(await readProviderError(response, 'Failed to synthesize speech with MiniMax'))
  }

  const payload = await response.json().catch(() => null)
  const audioHex = typeof payload?.data?.audio === 'string' ? payload.data.audio : ''
  if (!audioHex) {
    throw new Error('MiniMax did not return audio data')
  }

  const returnedFormat =
    typeof payload?.extra_info?.audio_format === 'string' ? payload.extra_info.audio_format : format

  return {
    audio: hexToBytes(audioHex),
    mediaType: MEDIA_TYPE_MAP[returnedFormat] ?? MEDIA_TYPE_MAP[format] ?? 'audio/mpeg',
    voiceId: voiceId ?? DEFAULT_MINIMAX_TTS_VOICE,
    provider: 'minimax',
    model
  }
}

async function synthesizeMiMo({
  text,
  userId,
  model,
  voiceId,
  options
}: {
  text: string
  userId: string
  model: string
  voiceId?: string | null
  options?: ResolvedVoiceRuntimeOptions
}): Promise<VoiceSynthesisResult> {
  const apiKey = await resolveApiKey(userId, 'mimo', ['MIMO_API_KEY'])
  if (!apiKey) throw new Error('MiMo API key not configured')

  const format =
    typeof options?.providerOptions?.format === 'string' &&
    ['wav', 'pcm16'].includes(options.providerOptions.format)
      ? options.providerOptions.format
      : 'wav'
  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = []
  if (typeof options?.common?.instructions === 'string' && options.common.instructions.trim()) {
    messages.push({ role: 'user', content: options.common.instructions.trim() })
  }
  messages.push({ role: 'assistant', content: text })

  const baseUrl = (env.MIMO_API_BASE_URL ?? 'https://api.xiaomimimo.com/v1').replace(/\/+$/, '')
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify({
      model,
      messages,
      audio: {
        format,
        voice: voiceId ?? DEFAULT_MIMO_TTS_VOICE
      }
    })
  })

  if (!response.ok) {
    throw new Error(await readProviderError(response, 'Failed to synthesize speech with MiMo'))
  }

  const payload = await response.json().catch(() => null)
  const audioBase64 = payload?.choices?.[0]?.message?.audio?.data
  if (typeof audioBase64 !== 'string' || !audioBase64.trim()) {
    throw new Error('MiMo did not return audio data')
  }

  return {
    audio: Uint8Array.from(Buffer.from(audioBase64, 'base64')),
    mediaType: MEDIA_TYPE_MAP[format] ?? 'audio/wav',
    voiceId: voiceId ?? DEFAULT_MIMO_TTS_VOICE,
    provider: 'mimo',
    model
  }
}

async function synthesizeAlibaba({
  text,
  userId,
  model,
  voiceId,
  options
}: {
  text: string
  userId: string
  model: string
  voiceId?: string | null
  options?: ResolvedVoiceRuntimeOptions
}): Promise<VoiceSynthesisResult> {
  const apiKey = await resolveApiKey(userId, 'alibaba', ['ALIBABA_CLOUD_API_KEY', 'DASHSCOPE_API_KEY'])
  if (!apiKey) throw new Error('Alibaba Cloud API key not configured')

  const input: Record<string, unknown> = {
    text,
    voice: voiceId ?? DEFAULT_ALIBABA_TTS_VOICE
  }
  if (typeof options?.common?.language === 'string' && options.common.language.trim()) {
    input.language_type = options.common.language.trim()
  }
  if (model.includes('instruct') && typeof options?.common?.instructions === 'string' && options.common.instructions.trim()) {
    input.instruction = options.common.instructions.trim()
  }

  const baseUrl = (env.ALIBABA_CLOUD_TTS_BASE_URL ?? env.DASHSCOPE_TTS_BASE_URL ?? 'https://dashscope-intl.aliyuncs.com/api/v1')
    .replace(/\/+$/, '')
  const response = await fetch(`${baseUrl}/services/aigc/multimodal-generation/generation`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify({ model, input })
  })

  if (!response.ok) {
    throw new Error(await readProviderError(response, 'Failed to synthesize speech with Alibaba Cloud'))
  }

  const payload = await response.json().catch(() => null)
  const audioUrl = resolveOptionalString(
    payload?.output?.audio?.url,
    payload?.output?.url,
    payload?.audio?.url,
    payload?.url
  )
  if (!audioUrl) {
    throw new Error('Alibaba Cloud did not return an audio URL')
  }

  const downloaded = await downloadProviderAudio(audioUrl, 'audio/wav')
  return {
    audio: downloaded.audio,
    mediaType: downloaded.mediaType,
    voiceId: voiceId ?? DEFAULT_ALIBABA_TTS_VOICE,
    provider: 'alibaba',
    model
  }
}

async function synthesizeInworld({
  text,
  userId,
  model,
  voiceId,
  options
}: {
  text: string
  userId: string
  model: string
  voiceId?: string | null
  options?: ResolvedVoiceRuntimeOptions
}): Promise<VoiceSynthesisResult> {
  if (text.length > 2000) {
    throw new Error('Inworld TTS input cannot exceed 2,000 characters')
  }
  const apiKey = await resolveApiKey(userId, 'inworld', ['INWORLD_API_KEY'])
  if (!apiKey) throw new Error('Inworld API key not configured')

  const request = buildInworldSpeechBody({
    text,
    model,
    voiceId,
    runtimeOptions: options,
    mode: 'batch'
  })

  const response = await fetch('https://api.inworld.ai/tts/v1/voice', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify(request.body)
  })

  if (!response.ok) {
    throw new Error(await readProviderError(response, 'Failed to synthesize speech with Inworld'))
  }

  const payload = await response.json().catch(() => null)
  const audioBase64 = typeof payload?.audioContent === 'string' ? payload.audioContent : ''
  if (!audioBase64) {
    throw new Error('Inworld did not return audio data')
  }

  const mediaType =
    request.audioEncoding === 'MP3'
      ? 'audio/mpeg'
      : request.audioEncoding === 'OGG_OPUS'
        ? 'audio/ogg'
        : 'audio/wav'

  return {
    audio: Uint8Array.from(Buffer.from(audioBase64, 'base64')),
    mediaType,
    voiceId: request.voiceId,
    provider: 'inworld',
    model
  }
}

async function synthesizeCartesia({
  text,
  userId,
  model,
  voiceId,
  options
}: {
  text: string
  userId: string
  model: string
  voiceId?: string | null
  options?: ResolvedVoiceRuntimeOptions
}): Promise<VoiceSynthesisResult> {
  const apiKey = await resolveApiKey(userId, 'cartesia', ['CARTESIA_API_KEY'])
  if (!apiKey) throw new Error('Cartesia API key not configured')

  const container =
    typeof options?.providerOptions?.container === 'string' &&
    ['mp3', 'wav', 'raw'].includes(options.providerOptions.container)
      ? options.providerOptions.container
      : 'mp3'
  const generationConfig: Record<string, unknown> = {}
  if (typeof options?.common?.speed === 'number') generationConfig.speed = options.common.speed
  if (typeof options?.common?.volume === 'number') generationConfig.volume = options.common.volume

  const body: Record<string, unknown> = {
    model_id: model,
    transcript: text,
    voice: {
      mode: 'id',
      id: voiceId ?? DEFAULT_CARTESIA_TTS_VOICE
    },
    output_format: {
      container
    }
  }
  if (Object.keys(generationConfig).length > 0) {
    body.generation_config = generationConfig
  }
  if (typeof options?.common?.language === 'string' && options.common.language.trim()) {
    body.language = options.common.language.trim()
  }

  const response = await fetch('https://api.cartesia.ai/tts/bytes', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Cartesia-Version': CARTESIA_VERSION,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  })

  if (!response.ok) {
    throw new Error(await readProviderError(response, 'Failed to synthesize speech with Cartesia'))
  }

  return {
    audio: new Uint8Array(await response.arrayBuffer()),
    mediaType: response.headers.get('content-type') || MEDIA_TYPE_MAP[container] || 'audio/mpeg',
    voiceId: voiceId ?? DEFAULT_CARTESIA_TTS_VOICE,
    provider: 'cartesia',
    model
  }
}

async function synthesizeAsync({
  text,
  userId,
  model,
  voiceId,
  options
}: {
  text: string
  userId: string
  model: string
  voiceId?: string | null
  options?: ResolvedVoiceRuntimeOptions
}): Promise<VoiceSynthesisResult> {
  const apiKey = await resolveApiKey(userId, 'async', ['ASYNC_API_KEY'])
  if (!apiKey) throw new Error('Async API key not configured')

  const container =
    typeof options?.providerOptions?.container === 'string' &&
    ['mp3', 'wav', 'raw'].includes(options.providerOptions.container)
      ? options.providerOptions.container
      : 'mp3'
  const outputFormat: Record<string, unknown> = { container }
  if (container === 'raw') {
    outputFormat.encoding =
      typeof options?.providerOptions?.encoding === 'string'
        ? options.providerOptions.encoding
        : 'pcm_f32le'
    outputFormat.sample_rate =
      typeof options?.providerOptions?.sample_rate === 'number'
        ? options.providerOptions.sample_rate
        : 44100
  }

  const response = await fetch('https://api.async.com/text_to_speech', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      version: ASYNC_VERSION,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model_id: model,
      transcript: text,
      voice: {
        mode: 'id',
        id: voiceId ?? DEFAULT_ASYNC_TTS_VOICE
      },
      output_format: outputFormat
    })
  })

  if (!response.ok) {
    throw new Error(await readProviderError(response, 'Failed to synthesize speech with Async'))
  }

  return {
    audio: new Uint8Array(await response.arrayBuffer()),
    mediaType: response.headers.get('content-type') || MEDIA_TYPE_MAP[container] || 'audio/mpeg',
    voiceId: voiceId ?? DEFAULT_ASYNC_TTS_VOICE,
    provider: 'async',
    model
  }
}

async function synthesizeStepFun({
  text,
  userId,
  model,
  voiceId,
  options
}: {
  text: string
  userId: string
  model: string
  voiceId?: string | null
  options?: ResolvedVoiceRuntimeOptions
}): Promise<VoiceSynthesisResult> {
  if (text.length > 1000) {
    throw new Error('StepFun TTS input cannot exceed 1,000 characters')
  }
  const apiKey = await resolveApiKey(userId, 'stepfun', ['STEPFUN_API_KEY', 'STEP_API_KEY'])
  if (!apiKey) throw new Error('StepFun API key not configured')

  const responseFormat =
    typeof options?.providerOptions?.response_format === 'string' &&
    ['mp3', 'wav', 'flac', 'opus', 'pcm'].includes(options.providerOptions.response_format)
      ? options.providerOptions.response_format
      : 'mp3'
  const body: Record<string, unknown> = {
    model,
    input: text,
    voice: voiceId ?? DEFAULT_STEPFUN_TTS_VOICE,
    response_format: responseFormat
  }
  if (typeof options?.common?.speed === 'number') body.speed = options.common.speed
  if (typeof options?.common?.volume === 'number') body.volume = options.common.volume
  if (typeof options?.providerOptions?.sample_rate === 'string') {
    body.sample_rate = Number(options.providerOptions.sample_rate)
  }
  if (model === 'stepaudio-2.5-tts' && typeof options?.common?.instructions === 'string' && options.common.instructions.trim()) {
    body.instruction = options.common.instructions.trim()
  }

  const baseUrl = (env.STEPFUN_API_BASE_URL ?? 'https://api.stepfun.ai/v1').replace(/\/+$/, '')
  const response = await fetch(`${baseUrl}/audio/speech`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  })

  if (!response.ok) {
    throw new Error(await readProviderError(response, 'Failed to synthesize speech with StepFun'))
  }

  return {
    audio: new Uint8Array(await response.arrayBuffer()),
    mediaType: response.headers.get('content-type') || MEDIA_TYPE_MAP[responseFormat] || 'audio/mpeg',
    voiceId: voiceId ?? DEFAULT_STEPFUN_TTS_VOICE,
    provider: 'stepfun',
    model
  }
}

async function synthesizeAzure({
  text,
  userId,
  model,
  voiceId,
  options
}: {
  text: string
  userId: string
  model: string
  voiceId?: string | null
  options?: ResolvedVoiceRuntimeOptions
}): Promise<VoiceSynthesisResult> {
  const apiKey = await resolveApiKey(userId, 'azure_speech_key', ['AZURE_SPEECH_KEY'])
  if (!apiKey) throw new Error('Azure Speech key not configured')
  const region = resolveAzureSpeechRegion(
    await resolveApiKey(userId, 'azure_speech_region', ['AZURE_SPEECH_REGION'])
  )

  const outputFormat =
    typeof options?.providerOptions?.output_format === 'string'
      ? options.providerOptions.output_format
      : 'audio-24khz-48kbitrate-mono-mp3'
  const language =
    typeof options?.common?.language === 'string' && options.common.language.trim()
      ? options.common.language.trim()
      : 'en-US'
  const resolvedVoice = voiceId ?? DEFAULT_AZURE_TTS_VOICE
  const ssml = `<speak version="1.0" xml:lang="${escapeXml(language)}"><voice xml:lang="${escapeXml(language)}" name="${escapeXml(resolvedVoice)}">${escapeXml(text)}</voice></speak>`

  const response = await fetch(`https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
    method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': apiKey,
      'Content-Type': 'application/ssml+xml',
      'X-Microsoft-OutputFormat': outputFormat,
      'User-Agent': 'Batshit'
    },
    body: ssml
  })

  if (!response.ok) {
    throw new Error(await readProviderError(response, 'Failed to synthesize speech with Azure Speech'))
  }

  return {
    audio: new Uint8Array(await response.arrayBuffer()),
    mediaType: response.headers.get('content-type') || azureOutputFormatToMediaType(outputFormat),
    voiceId: resolvedVoice,
    provider: 'azure',
    model
  }
}

async function synthesizeByo({
  text,
  providerId,
  userId,
  model,
  voiceId,
  profileId,
  options
}: {
  text: string
  providerId: VoiceProviderId
  userId: string
  model?: string
  voiceId?: string | null
  profileId?: string | null
  options?: ResolvedVoiceRuntimeOptions
}): Promise<VoiceSynthesisResult> {
  const runtime = await resolveByoSuiteRuntime(userId, providerId)
  const targetRecord = resolveByoSynthesisRecord(runtime, options)
  const publicDefaultModel = resolveTtsDefaultModel(runtime.publicRecord.ttsDefaults)
  const routedModel =
    targetRecord.id !== runtime.publicRecord.id && model === publicDefaultModel ? undefined : model
  const config = await resolveByoEndpointConfigFromRecord(targetRecord, {
    providerId,
    userId
  })
  return synthesizeByoWithConfig({
    config,
    text,
    providerId,
    model: routedModel,
    voiceId,
    profileId,
    options
  })
}

async function synthesizeByoWithConfig({
  config,
  text,
  providerId,
  model,
  voiceId,
  profileId,
  options
}: {
  config: ResolvedByoEndpointConfig
  text: string
  providerId: VoiceProviderId
  model?: string
  voiceId?: string | null
  profileId?: string | null
  options?: ByoSpeechRuntimeOptions
}): Promise<VoiceSynthesisResult> {
  if (!config.supportsTts) {
    throw new Error(`BYO provider "${providerId}" does not support text-to-speech.`)
  }
  const url = `${config.baseUrl}${config.ttsPath}`
  const mergedCommon =
    config.ttsDefaults?.common || options?.common
      ? {
          ...(config.ttsDefaults?.common ?? {}),
          ...(options?.common ?? {})
        }
      : undefined
  const mergedProviderOptions =
    config.ttsDefaults?.providerOptions || options?.providerOptions
      ? {
          ...(config.ttsDefaults?.providerOptions ?? {}),
          ...(options?.providerOptions ?? {})
        }
      : undefined
  const responseFormat =
    typeof mergedProviderOptions?.response_format === 'string'
      ? mergedProviderOptions.response_format
      : typeof mergedProviderOptions?.format === 'string'
        ? mergedProviderOptions.format
      : 'mp3'
  const configuredDefaultModel = resolveOptionalString(model, resolveTtsDefaultModel(config.ttsDefaults))
  const defaultModel =
    config.requestFormat === 'openai-compatible'
      ? requireOpenAICompatibleByoModel({
          providerId,
          mode: 'tts',
          requestedModel: model,
          defaultModel: resolveTtsDefaultModel(config.ttsDefaults)
        })
      : configuredDefaultModel
  const defaultVoiceId =
    resolveOptionalString(voiceId ?? undefined, config.ttsDefaults?.voiceId) ?? 'alloy'
  const instructions =
    typeof mergedCommon?.instructions === 'string' && mergedCommon.instructions.trim()
      ? mergedCommon.instructions.trim()
      : undefined
  const openAiCompatibleRequestOptions: Record<string, VoiceProviderOptionValue> = {}
  for (const key of [
    'gender',
    'pitch',
    'lang_code',
    'language',
    'ref_audio',
    'ref_text',
    'num_steps',
    'guidance_scale',
    'speaker_scale',
    'seed',
    'temperature',
    'top_p',
    'top_k',
    'repetition_penalty',
    'stream',
    'streaming_interval',
    'max_tokens',
    'verbose'
  ] as const) {
    let value = mergedProviderOptions?.[key]
    if (key === 'ref_audio' && typeof value === 'string' && value.trim()) {
      value = await normalizeLocalReferenceAudioPath(value)
    }
    if (typeof value === 'string' && value.trim().length === 0) continue
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      openAiCompatibleRequestOptions[key] = value
    }
  }
  const requestBody =
    config.requestFormat === 'openai-compatible'
      ? {
          model: defaultModel,
          input: text,
          voice: defaultVoiceId,
          response_format: responseFormat,
          speed: typeof mergedCommon?.speed === 'number' ? mergedCommon.speed : undefined,
          instructions,
          instruct: instructions,
          ...openAiCompatibleRequestOptions
        }
      : {
          text,
          model: model ?? undefined,
          voiceId: voiceId ?? undefined,
          profileId: profileId ?? undefined,
          adapterId: config.adapterId ?? undefined,
          endpointId: config.endpointId ?? undefined,
          options: {
            common: mergedCommon,
            providerOptions: mergedProviderOptions
          }
        }

  const response = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...buildByoAuthHeaders(config)
      },
      body: JSON.stringify(requestBody)
    },
    config.timeoutMs
  )

  if (!response.ok) {
    const errorText = await response.text().catch(() => '')
    throw new Error(errorText || `BYO Speech TTS failed (${response.status})`)
  }

  const contentType = response.headers.get('content-type') || ''
  if (contentType.startsWith('audio/')) {
    const audio = new Uint8Array(await response.arrayBuffer())
    return {
      audio,
      mediaType: contentType || 'audio/mpeg',
      voiceId: defaultVoiceId,
      provider: providerId,
      model: defaultModel
    }
  }

  let payload: Record<string, unknown> | null = null
  try {
    payload = (await response.json()) as Record<string, unknown>
  } catch {
    payload = null
  }

  const base64Value = payload?.audioBase64 ?? payload?.audio ?? payload?.base64Audio ?? payload?.data
  if (typeof base64Value !== 'string' || !base64Value.trim()) {
    throw new Error('BYO Speech TTS response did not include audio data.')
  }

  const mediaType =
    (typeof payload?.mediaType === 'string' && payload.mediaType.trim()) ||
    (typeof payload?.mimeType === 'string' && payload.mimeType.trim()) ||
    'audio/mpeg'
  const resolvedVoiceId =
    (typeof payload?.voiceId === 'string' && payload.voiceId.trim()) ||
    defaultVoiceId ||
    null
  const resolvedModel =
    (typeof payload?.model === 'string' && payload.model.trim()) ||
    defaultModel ||
    null

  return {
    audio: Uint8Array.from(Buffer.from(base64Value, 'base64')),
    mediaType,
    voiceId: resolvedVoiceId,
    provider: providerId,
    model: resolvedModel
  }
}

export async function synthesizeByoSpeechForRecord({
  record,
  text,
  providerId,
  model,
  voiceId,
  profileId,
  options,
  userId
}: {
  record: VoiceEngineRecord
  text: string
  providerId?: VoiceProviderId
  model?: string
  voiceId?: string | null
  profileId?: string | null
  options?: ByoSpeechRuntimeOptions
  userId?: string
}): Promise<VoiceSynthesisResult> {
  const resolvedProviderId = providerId ?? (`byo:${record.id}` as VoiceProviderId)
  const config = await resolveByoEndpointConfigFromRecord(record, {
    providerId: resolvedProviderId,
    allowDisabled: true,
    userId
  })

  return synthesizeByoWithConfig({
    config,
    text,
    providerId: resolvedProviderId,
    model,
    voiceId,
    profileId,
    options
  })
}

export async function transcribeByoSpeechForRecord({
  record,
  audio,
  providerId,
  model,
  language,
  contentType,
  userId
}: {
  record: VoiceEngineRecord
  audio: Uint8Array
  providerId?: VoiceProviderId
  model?: string
  language?: string
  contentType?: string
  userId?: string
}): Promise<VoiceTranscribeResult> {
  const resolvedProviderId = providerId ?? (`byo:${record.id}` as VoiceProviderId)
  const config = await resolveByoEndpointConfigFromRecord(record, {
    providerId: resolvedProviderId,
    allowDisabled: true,
    userId
  })

  return transcribeByoWithConfig({
    config,
    audio,
    providerId: resolvedProviderId,
    model,
    language,
    contentType,
    providerOptions: config.sttDefaults?.providerOptions
  })
}

async function transcribeOpenAI({
  audio,
  userId,
  model,
  language,
  contentType
}: {
  audio: Uint8Array
  userId: string
  model: string
  language?: string
  contentType?: string
}): Promise<VoiceTranscribeResult> {
  const apiKey = await resolveApiKey(userId, 'openai', ['OPENAI_API_KEY'])
  if (!apiKey) throw new Error('OpenAI API key not configured')

  const openai = createOpenAI({ apiKey })
  const normalizedAudio = await normalizeUploadedAudioToPcmWav({
    audio,
    contentType,
    providerLabel: 'OpenAI'
  })

  const result = await transcribe({
    model: openai.transcription(model),
    audio: normalizedAudio,
    providerOptions: language
      ? {
          openai: {
            language
          }
        }
      : undefined
  })

  return {
    text: result.text,
    language: result.language,
    segments: result.segments
  }
}

async function transcribeDeepgram({
  audio,
  userId,
  model,
  language,
  contentType
}: {
  audio: Uint8Array
  userId: string
  model: string
  language?: string
  contentType?: string
}): Promise<VoiceTranscribeResult> {
  const apiKey = await resolveApiKey(userId, 'deepgram', ['DEEPGRAM_API_KEY'])
  if (!apiKey) throw new Error('Deepgram API key not configured')
  if (model.startsWith('flux-')) {
    throw new Error(
      'Deepgram Flux models are realtime-only in Batshit. Use Voice Mode for Flux, or choose a non-Flux Deepgram model for uploaded-audio transcription.'
    )
  }

  const query = new URLSearchParams({
    model
  })
  if (language) query.set('language', language)

  const response = await fetch(`https://api.deepgram.com/v1/listen?${query.toString()}`, {
    method: 'POST',
    headers: {
      Authorization: `Token ${apiKey}`,
      'Content-Type': contentType || 'audio/wav'
    },
    body: toOwnedBytes(audio)
  })

  if (!response.ok) {
    const errorText = await response.text().catch(() => '')
    throw new Error(errorText || 'Deepgram transcription failed')
  }

  const data = await response.json()
  const transcript = data?.results?.channels?.[0]?.alternatives?.[0]

  return {
    text: transcript?.transcript ?? '',
    confidence: transcript?.confidence,
    segments: transcript?.words ?? data?.results?.channels?.[0]?.alternatives?.[0]?.words ?? undefined
  }
}

async function transcribeFish({
  audio,
  userId,
  model,
  language,
  contentType
}: {
  audio: Uint8Array
  userId: string
  model: string
  language?: string
  contentType?: string
}): Promise<VoiceTranscribeResult> {
  const apiKey = await resolveApiKey(userId, 'fish', ['FISH_AUDIO_API_KEY', 'FISH_API_KEY'])
  if (!apiKey) throw new Error('Fish Audio API key not configured')
  const normalizedAudio = await normalizeUploadedAudioToPcmWav({
    audio,
    contentType,
    providerLabel: 'Fish Audio'
  })

  const form = new FormData()
  form.append('audio', bytesToBlob(normalizedAudio, { type: 'audio/wav' }), 'speech.wav')
  if (model && model !== DEFAULT_FISH_STT_MODEL) {
    throw new Error(`Fish Audio ASR only supports ${DEFAULT_FISH_STT_MODEL} in Batshit today.`)
  }
  if (language) form.append('language', language)

  const response = await fetch('https://api.fish.audio/v1/asr', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`
    },
    body: form
  })

  if (!response.ok) {
    const errorText = await response.text().catch(() => '')
    throw new Error(errorText || 'Fish Audio transcription failed')
  }

  const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null
  if (!payload) {
    throw new Error('Fish Audio transcription returned an empty response.')
  }

  const text =
    (typeof payload.text === 'string' && payload.text) ||
    (typeof payload.transcript === 'string' && payload.transcript) ||
    ''
  const resultLanguage =
    (typeof payload.language === 'string' && payload.language) ||
    language
  const confidence =
    typeof payload.confidence === 'number' && Number.isFinite(payload.confidence)
      ? payload.confidence
      : undefined
  const segments = Array.isArray(payload.segments)
    ? payload.segments
    : Array.isArray(payload.chunks)
      ? payload.chunks
      : Array.isArray(payload.words)
        ? payload.words
        : undefined

  return {
    text,
    language: resultLanguage,
    segments,
    confidence
  }
}

async function transcribeElevenLabs({
  audio,
  userId,
  model,
  language,
  contentType
}: {
  audio: Uint8Array
  userId: string
  model: string
  language?: string
  contentType?: string
}): Promise<VoiceTranscribeResult> {
  const apiKey = await resolveApiKey(userId, 'elevenlabs', ['ELEVENLABS_API_KEY'])
  if (!apiKey) throw new Error('ElevenLabs API key not configured')

  const normalizedAudio = await normalizeUploadedAudioToPcmWav({
    audio,
    contentType,
    providerLabel: 'ElevenLabs'
  })

  const form = new FormData()
  form.append('model_id', model)
  form.append('file', bytesToBlob(normalizedAudio, { type: 'audio/wav' }), 'speech.wav')
  if (language) form.append('language_code', language)

  const response = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
    method: 'POST',
    headers: {
      'xi-api-key': apiKey
    },
    body: form
  })

  if (!response.ok) {
    const errorText = await response.text().catch(() => '')
    throw new Error(errorText || 'ElevenLabs transcription failed')
  }

  const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null
  if (!payload) {
    throw new Error('ElevenLabs transcription returned an empty response.')
  }

  return {
    text: typeof payload.text === 'string' ? payload.text : '',
    language:
      (typeof payload.language_code === 'string' && payload.language_code) ||
      (typeof payload.language === 'string' && payload.language) ||
      language,
    confidence:
      typeof payload.language_probability === 'number' && Number.isFinite(payload.language_probability)
        ? payload.language_probability
        : undefined,
    segments: Array.isArray(payload.words) ? payload.words : undefined
  }
}

async function transcribeMistral({
  audio,
  userId,
  model,
  language,
  contentType
}: {
  audio: Uint8Array
  userId: string
  model: string
  language?: string
  contentType?: string
}): Promise<VoiceTranscribeResult> {
  const apiKey = await resolveApiKey(userId, 'mistral', ['MISTRAL_API_KEY'])
  if (!apiKey) throw new Error('Mistral API key not configured')

  const normalizedAudio = await normalizeUploadedAudioToPcmWav({
    audio,
    contentType,
    providerLabel: 'Mistral'
  })

  const form = new FormData()
  form.append('model', model)
  form.append('file', bytesToBlob(normalizedAudio, { type: 'audio/wav' }), 'speech.wav')
  if (language) {
    form.append('language', language)
  } else {
    form.append('timestamp_granularities[]', 'segment')
  }

  const response = await fetch('https://api.mistral.ai/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`
    },
    body: form
  })

  if (!response.ok) {
    const errorText = await response.text().catch(() => '')
    throw new Error(errorText || 'Mistral transcription failed')
  }

  const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null
  if (!payload) {
    throw new Error('Mistral transcription returned an empty response.')
  }

  return {
    text:
      (typeof payload.text === 'string' && payload.text) ||
      (typeof payload.transcript === 'string' && payload.transcript) ||
      '',
    language:
      (typeof payload.language === 'string' && payload.language) ||
      (typeof payload.language_code === 'string' && payload.language_code) ||
      language,
    segments: Array.isArray(payload.segments)
      ? payload.segments
      : Array.isArray(payload.words)
        ? payload.words
        : undefined
  }
}

const BYO_STT_RESERVED_FORM_KEYS = new Set([
  'file',
  'audio',
  'model',
  'language',
  'adapterId',
  'endpointId'
])

function appendByoSttProviderOptions(
  form: FormData,
  providerOptions: VoiceProviderOptionBlock | undefined
): void {
  if (!providerOptions) return
  for (const [key, value] of Object.entries(providerOptions)) {
    if (BYO_STT_RESERVED_FORM_KEYS.has(key)) continue
    if (
      typeof value !== 'string' &&
      typeof value !== 'number' &&
      typeof value !== 'boolean'
    ) {
      throw new Error(`BYO STT provider option "${key}" must be a string, number, or boolean.`)
    }
    form.append(key, String(value))
  }
}

async function transcribeByo({
  audio,
  providerId,
  userId,
  model,
  language,
  contentType,
  providerOptions
}: {
  audio: Uint8Array
  providerId: VoiceProviderId
  userId: string
  model?: string
  language?: string
  contentType?: string
  providerOptions?: VoiceProviderOptionBlock
}): Promise<VoiceTranscribeResult> {
  const config = await resolveByoEndpointConfig(userId, providerId)
  return transcribeByoWithConfig({
    config,
    audio,
    providerId,
    model,
    language,
    contentType,
    providerOptions
  })
}

async function transcribeByoWithConfig({
  config,
  audio,
  providerId,
  model,
  language,
  contentType,
  providerOptions
}: {
  config: ResolvedByoEndpointConfig
  audio: Uint8Array
  providerId: VoiceProviderId
  model?: string
  language?: string
  contentType?: string
  providerOptions?: VoiceProviderOptionBlock
}): Promise<VoiceTranscribeResult> {
  if (!config.supportsStt) {
    throw new Error(`BYO provider "${providerId}" does not support speech-to-text.`)
  }
  const url = `${config.baseUrl}${config.sttPath}`
  const normalizedAudio = await normalizeUploadedAudioToPcmWav({
    audio,
    contentType,
    providerLabel: `BYO provider "${providerId}"`
  })
  let response: Response

  if (config.requestFormat === 'openai-compatible') {
    const configuredModel = requireOpenAICompatibleByoModel({
      providerId,
      mode: 'stt',
      requestedModel: model,
      defaultModel: resolveSttDefaultModel(config.sttDefaults)
    })
    const form = new FormData()
    form.append('file', bytesToBlob(normalizedAudio, { type: 'audio/wav' }), 'speech.wav')
    form.append('model', configuredModel)
    if (language) form.append('language', language)
    appendByoSttProviderOptions(form, providerOptions)
    response = await fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: {
          ...buildByoAuthHeaders(config)
        },
        body: form
      },
      config.timeoutMs
    )
  } else {
    const form = new FormData()
    form.append('audio', bytesToBlob(normalizedAudio, { type: 'audio/wav' }), 'speech.wav')
    if (model) form.append('model', model)
    if (language) form.append('language', language)
    if (config.adapterId) form.append('adapterId', config.adapterId)
    if (config.endpointId) form.append('endpointId', config.endpointId)
    appendByoSttProviderOptions(form, providerOptions)

    response = await fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: {
          ...buildByoAuthHeaders(config)
        },
        body: form
      },
      config.timeoutMs
    )
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => '')
    throw new Error(errorText || `BYO Speech STT failed (${response.status})`)
  }

  const contentTypeHeader = response.headers.get('content-type') || ''
  if (!contentTypeHeader.includes('application/json')) {
    const rawText = (await response.text().catch(() => '')).trim()
    return {
      text: rawText,
      language
    }
  }

  const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null
  if (!payload) {
    throw new Error('BYO Speech STT returned an empty response.')
  }

  const text =
    (typeof payload.text === 'string' && payload.text) ||
    (typeof payload.transcript === 'string' && payload.transcript) ||
    ''
  const resultLanguage =
    (typeof payload.language === 'string' && payload.language) ||
    language
  const confidence =
    typeof payload.confidence === 'number' && Number.isFinite(payload.confidence)
      ? payload.confidence
      : undefined

  return {
    text,
    language: resultLanguage,
    segments: Array.isArray(payload.segments) ? payload.segments : undefined,
    confidence
  }
}

async function cloneElevenLabs({
  audio,
  name,
  description,
  userId
}: VoiceCloneRequest): Promise<VoiceCloneResult> {
  const apiKey = await resolveApiKey(userId, 'elevenlabs', ['ELEVENLABS_API_KEY'])
  if (!apiKey) throw new Error('ElevenLabs API key not configured')

  const form = new FormData()
  form.append('name', name)
  if (description) form.append('description', description)
  form.append('files', bytesToBlob(audio), 'voice-sample.wav')

  const response = await fetch('https://api.elevenlabs.io/v1/voices/add', {
    method: 'POST',
    headers: {
      'xi-api-key': apiKey
    },
    body: form
  })

  if (!response.ok) {
    const errorText = await response.text().catch(() => '')
    throw new Error(errorText || 'Failed to clone voice via ElevenLabs')
  }

  const payload = await response.json()
  const voiceId = payload?.voice_id || payload?.voiceId
  if (!voiceId) {
    throw new Error('ElevenLabs did not return a voice ID')
  }

  const now = new Date().toISOString()
  const profile: VoiceProfileRecord = {
    id: `voice_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    user_id: userId,
    name,
    description,
    provider: 'elevenlabs',
    voiceId,
    isClone: true,
    created_at: now,
    updated_at: now
  }

  await redis.createVoiceProfile(profile)

  return {
    voiceId,
    profile
  }
}

async function cloneByoReferenceProfile(request: VoiceCloneRequest): Promise<VoiceCloneResult> {
  const runtime = await resolveByoSuiteRuntime(request.userId, request.provider)
  const record = runtime.cloneRecord ?? runtime.publicRecord
  if (!record) {
    throw new Error(`BYO provider "${request.provider}" is not configured.`)
  }

  if (record.supportsClone !== true) {
    throw new Error(`Voice cloning is not enabled for provider: ${request.provider}`)
  }

  if ((record.requestFormat ?? 'batshit-byo') !== 'openai-compatible') {
    throw new Error(
      `BYO provider "${request.provider}" does not use the reference-audio clone path Batshit supports today.`
    )
  }

  const now = new Date().toISOString()
  const profileId = `voice_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const { audioPath, dirPath } = await saveReferenceAudioForByoClone({
    profileId,
    audio: request.audio,
    filename: request.filename,
    contentType: request.contentType
  })
  const referenceText = resolveOptionalString(request.referenceText)
  const profile: VoiceProfileRecord = {
    id: profileId,
    user_id: request.userId,
    name: request.name,
    description: request.description,
    provider: request.provider,
    voiceId: profileId,
    model: resolveTtsDefaultModel(record.ttsDefaults) ?? undefined,
    isClone: true,
    settings: {
      providerOptions: {
        [request.provider]: {
          ref_audio: audioPath,
          ...(referenceText ? { ref_text: referenceText } : {})
        }
      },
      batshitManagedReferenceAudioPath: audioPath,
      cloneMethod: 'reference-audio'
    },
    created_at: now,
    updated_at: now
  }

  try {
    await redis.createVoiceProfile(profile)
  } catch (error) {
    if (dirPath && !isContainerizedRuntime()) {
      await fs.rm(dirPath, { recursive: true, force: true })
    }
    throw error
  }

  return {
    voiceId: profile.voiceId,
    profile
  }
}
