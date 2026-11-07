import type { VoiceProviderSummary } from '../types/voice'
import { BROWSER_STT_CAPABILITIES, GOOGLE_STT_CAPABILITIES, OPENAI_STT_CAPABILITIES, ELEVENLABS_STT_CAPABILITIES, DEEPGRAM_STT_CAPABILITIES, FISH_STT_CAPABILITIES, MISTRAL_STT_CAPABILITIES, MIMO_STT_CAPABILITIES, ASYNC_STT_CAPABILITIES } from './voiceCapabilityRegistry'
import { DEFAULT_OPENAI_TTS_MODEL, OPENAI_TTS_MODELS, OPENAI_TTS_VOICES } from './openaiVoiceModelCatalog'

export const DEFAULT_OPENAI_STT_MODEL = 'gpt-4o-mini-transcribe'

export const OPENAI_STT_MODELS = [
  'gpt-4o-mini-transcribe',
  'gpt-4o-transcribe',
  'gpt-4o-transcribe-diarize',
  'whisper-1'
]

export const DEFAULT_OPENAI_REALTIME_STT_MODEL = 'gpt-realtime-whisper'

export const OPENAI_REALTIME_STT_MODELS = [DEFAULT_OPENAI_REALTIME_STT_MODEL]

export const DEFAULT_GEMINI_TTS_MODEL = 'gemini-3.1-flash-tts-preview'

export const GEMINI_TTS_MODELS = [
  'gemini-3.1-flash-tts-preview',
  'gemini-2.5-flash-preview-tts',
  'gemini-2.5-pro-preview-tts'
]

export const DEFAULT_GEMINI_TTS_VOICE = 'Kore'

export const DEFAULT_GEMINI_STT_MODEL = 'gemini-3.5-transcribe'

export const GEMINI_STT_MODELS = [DEFAULT_GEMINI_STT_MODEL]

export const DEFAULT_DEEPGRAM_TTS_MODEL = 'aura-2-asteria-en'

export const DEFAULT_DEEPGRAM_FLUX_TTS_MODEL = 'flux-hannah-en'

export const DEFAULT_DEEPGRAM_STT_MODEL = 'nova-3'

export const DEEPGRAM_STT_MODELS = [
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

export const DEFAULT_DEEPGRAM_REALTIME_STT_MODEL = 'flux-general-en'

export const DEEPGRAM_REALTIME_STT_MODELS = ['flux-general-en', 'flux-general-multi']

export const DEFAULT_ELEVENLABS_TTS_MODEL = 'eleven_multilingual_v2'

export const DEFAULT_ELEVENLABS_STT_MODEL = 'scribe_v2'

export const ELEVENLABS_STT_MODELS = ['scribe_v2']

export const DEFAULT_ELEVENLABS_REALTIME_STT_MODEL = 'scribe_v2_realtime'

export const ELEVENLABS_REALTIME_STT_MODELS = [DEFAULT_ELEVENLABS_REALTIME_STT_MODEL]

export const DEFAULT_FISH_TTS_MODEL = 's2.1-pro'

export const FISH_TTS_MODELS = ['s2.1-pro', 's2.1-pro-free', 's2-pro', 's1']

export const DEFAULT_FISH_STT_MODEL = 'transcribe-1'

export const FISH_STT_MODELS = [DEFAULT_FISH_STT_MODEL]

export const DEFAULT_MISTRAL_TTS_MODEL = 'voxtral-mini-tts-2603'

export const MISTRAL_TTS_MODELS = ['voxtral-mini-tts-2603']

export const DEFAULT_MISTRAL_STT_MODEL = 'voxtral-mini-latest'

export const MISTRAL_STT_MODELS = ['voxtral-mini-latest', 'voxtral-mini-2602']

export const DEFAULT_MISTRAL_REALTIME_STT_MODEL = 'voxtral-mini-transcribe-realtime-2602'

export const MISTRAL_REALTIME_STT_MODELS = [DEFAULT_MISTRAL_REALTIME_STT_MODEL]

export const DEFAULT_MINIMAX_TTS_MODEL = 'speech-2.8-hd'

export const DEFAULT_MINIMAX_TTS_VOICE = 'English_expressive_narrator'

export const MINIMAX_TTS_MODELS = [
  'speech-2.8-hd',
  'speech-2.8-turbo',
  'speech-2.6-hd',
  'speech-2.6-turbo',
  'speech-02-hd',
  'speech-02-turbo',
  'speech-01-hd',
  'speech-01-turbo'
]

export const DEFAULT_MIMO_TTS_MODEL = 'mimo-v2.5-tts'

export const DEFAULT_MIMO_STT_MODEL = 'mimo-v2.5-asr'

export const DEFAULT_MIMO_TTS_VOICE = 'Chloe'

export const MIMO_TTS_MODELS = ['mimo-v2.5-tts', 'mimo-v2.5-tts-voicedesign', 'mimo-v2.5-tts-voiceclone']

export const MIMO_STT_MODELS = [DEFAULT_MIMO_STT_MODEL]

export const DEFAULT_ALIBABA_TTS_MODEL = 'qwen3-tts-flash'

export const DEFAULT_ALIBABA_TTS_VOICE = 'Cherry'

export const ALIBABA_TTS_MODELS = [
  'qwen3-tts-flash',
  'qwen3-tts-instruct-flash',
  'qwen3-tts-vd-2026-01-26',
  'qwen3-tts-vc-2026-01-22'
]

export const DEFAULT_INWORLD_TTS_MODEL = 'inworld-tts-2'

export const DEFAULT_INWORLD_TTS_VOICE = 'Alex'

export const INWORLD_TTS_MODELS = [
  'inworld-tts-2',
  'inworld-tts-1.5-max',
  'inworld-tts-1.5-mini',
  'inworld-tts-1',
  'inworld-tts-1-max'
]

export const DEFAULT_CARTESIA_TTS_MODEL = 'sonic-3.5'

export const DEFAULT_CARTESIA_TTS_VOICE = 'db6b0ed5-d5d3-463d-ae85-518a07d3c2b4'

export const CARTESIA_TTS_MODELS = ['sonic-3.5', 'sonic-3', 'sonic-latest']

export const DEFAULT_ASYNC_TTS_MODEL = 'async_flash_v1.0'

export const DEFAULT_ASYNC_TTS_VOICE = 'e0f39dc4-f691-4e78-bba5-5c636692cc04'

export const ASYNC_TTS_MODELS = ['async_flash_v1.0', 'async_flash_v1.5', 'async_pro_v1.0']

export const DEFAULT_STEPFUN_TTS_MODEL = 'step-tts-2'

export const DEFAULT_STEPFUN_TTS_VOICE = 'lively-girl'

export const STEPFUN_TTS_MODELS = ['step-tts-2', 'stepaudio-2.5-tts']

export const DEFAULT_AZURE_TTS_MODEL = 'azure-neural-tts'

export const DEFAULT_AZURE_TTS_VOICE = 'en-US-AvaMultilingualNeural'

export const AZURE_TTS_MODELS = [DEFAULT_AZURE_TTS_MODEL]

export const ELEVENLABS_TTS_MODELS = [
  'eleven_v3',
  'eleven_multilingual_v2',
  'eleven_flash_v2_5',
  'eleven_flash_v2'
]

export const BUNDLED_VOICE_PROVIDER_SUMMARIES: VoiceProviderSummary[] = [
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
    label: 'Google Gemini',
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
    defaultModel: DEFAULT_GEMINI_TTS_MODEL,
    defaultTtsModel: DEFAULT_GEMINI_TTS_MODEL,
    defaultSttModel: DEFAULT_GEMINI_STT_MODEL,
    defaultVoice: DEFAULT_GEMINI_TTS_VOICE,
    ttsModels: GEMINI_TTS_MODELS,
    sttModels: GEMINI_STT_MODELS,
    sttCapabilities: GOOGLE_STT_CAPABILITIES
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
    ttsModels: [DEFAULT_DEEPGRAM_TTS_MODEL, DEFAULT_DEEPGRAM_FLUX_TTS_MODEL],
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
      stt: true,
      listVoices: true,
      clone: false,
      streaming: false,
      styles: true,
      emotions: true
    },
    defaultModel: DEFAULT_MIMO_TTS_MODEL,
    defaultTtsModel: DEFAULT_MIMO_TTS_MODEL,
    defaultSttModel: DEFAULT_MIMO_STT_MODEL,
    defaultVoice: DEFAULT_MIMO_TTS_VOICE,
    ttsModels: MIMO_TTS_MODELS,
    sttModels: MIMO_STT_MODELS,
    sttCapabilities: MIMO_STT_CAPABILITIES
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
      stt: true,
      listVoices: true,
      clone: false,
      streaming: false,
      styles: false,
      emotions: false
    },
    defaultModel: DEFAULT_ASYNC_TTS_MODEL,
    defaultTtsModel: DEFAULT_ASYNC_TTS_MODEL,
    defaultSttModel: 'async_asr_v1.0',
    sttModels: [],
    sttCapabilities: ASYNC_STT_CAPABILITIES,
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
