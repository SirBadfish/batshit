type VoiceApiMode = 'tts' | 'stt'

export type VoiceApiErrorDetails = {
  status: number
  error: string
  setupHint?: string
  logLevel: 'warn' | 'error'
}

const NETWORK_FAILURE_PATTERNS = [
  'aborted',
  'econnrefused',
  'enotfound',
  'etimedout',
  'networkerror',
  'network error',
  'socket hang up',
  'fetch failed',
  'timed out'
]

const USER_FIXABLE_PATTERNS = [
  'is required',
  'missing',
  'invalid',
  'unsupported',
  'disabled',
  'no voice provider configured',
  'only available on the client',
  'too large',
  'does not support'
]

function normalizeMessage(error: unknown): string {
  if (error instanceof Error && typeof error.message === 'string') {
    const trimmed = error.message.trim()
    if (trimmed) return trimmed
  }

  if (typeof error === 'string') {
    const trimmed = error.trim()
    if (trimmed) return trimmed
  }

  return ''
}

function resolveApiKeyHint(message: string): string | undefined {
  const match = message.match(/([A-Za-z0-9 ._-]+)\s+API key not configured/i)
  if (!match?.[1]) return 'Add the required provider API key in Settings -> API Keys, then retry.'
  const provider = match[1].trim()
  return `Add your ${provider} API key in Settings -> API Keys, then retry.`
}

function resolveSetupHint(message: string, mode: VoiceApiMode): string | undefined {
  const lower = message.toLowerCase()

  if (lower.includes('api key not configured')) {
    return resolveApiKeyHint(message)
  }

  if (mode === 'tts' && lower.includes('voiceid is required')) {
    return 'Pick a voice in Voice Settings -> Text-to-speech -> Voice, or pass voiceId in the request.'
  }

  if (
    mode === 'tts' &&
    (lower.includes('fish audio voice is required') ||
      lower.includes('fish audio reference voice id is required'))
  ) {
    return 'Pick a Fish voice in Voice Settings -> Text-to-speech -> Voice, or pass voiceId in the realtime speech request.'
  }

  if (mode === 'tts' && lower.includes('no voice provider configured')) {
    return 'Select a TTS provider in Voice Settings before previewing or enabling auto-speak.'
  }

  if (mode === 'stt' && lower.includes('unsupported stt provider')) {
    return 'Select a supported STT provider in Voice Settings, or register a BYO STT engine first.'
  }

  if (mode === 'tts' && lower.includes('unsupported voice provider')) {
    return 'Select a supported TTS provider in Voice Settings, or register a BYO TTS engine first.'
  }

  if (mode === 'stt' && lower.includes('audio input is required')) {
    return 'Attach an audio file (or record audio) before trying transcription.'
  }

  return undefined
}

function isUserFixableMessage(lowerMessage: string): boolean {
  return USER_FIXABLE_PATTERNS.some((pattern) => lowerMessage.includes(pattern))
}

function isNetworkMessage(lowerMessage: string): boolean {
  return NETWORK_FAILURE_PATTERNS.some((pattern) => lowerMessage.includes(pattern))
}

export function classifyVoiceApiError(error: unknown, mode: VoiceApiMode): VoiceApiErrorDetails {
  const fallback = mode === 'tts' ? 'Failed to synthesize speech' : 'Failed to transcribe audio'
  const message = normalizeMessage(error) || fallback
  const lower = message.toLowerCase()

  if (lower.includes('api key not configured')) {
    return {
      status: 412,
      error: message,
      setupHint: resolveSetupHint(message, mode),
      logLevel: 'warn'
    }
  }

  if (isUserFixableMessage(lower)) {
    return {
      status: 400,
      error: message,
      setupHint: resolveSetupHint(message, mode),
      logLevel: 'warn'
    }
  }

  if (isNetworkMessage(lower)) {
    return {
      status: 502,
      error: message,
      setupHint: resolveSetupHint(message, mode),
      logLevel: 'error'
    }
  }

  return {
    status: 500,
    error: message,
    setupHint: resolveSetupHint(message, mode),
    logLevel: 'error'
  }
}
