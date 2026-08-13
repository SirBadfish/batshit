export type DesktopControlsVoiceRuntime = 'direct' | 'livekit'
export type DesktopControlsVoiceInputKind = 'continuous' | 'recorded' | 'text' | 'livekit' | null
export type DesktopControlsVoicePhase =
  'inactive' | 'starting' | 'listening' | 'ready' | 'processing' | 'speaking' | 'stopping' | 'error'

export type DesktopControlsVoiceIntent =
  { type: 'start' } | { type: 'end' } | { type: 'toggle-listening' }

export type DesktopControlsVoiceIntentType = DesktopControlsVoiceIntent['type']

export type DesktopControlsVoiceOwnerState = {
  active: boolean
  listening: boolean
  runtime: DesktopControlsVoiceRuntime
  inputKind: DesktopControlsVoiceInputKind
  phase: DesktopControlsVoicePhase
  label: string
  modeLabel: string
  error: string | null
  allowedIntents: DesktopControlsVoiceIntentType[]
}

export type DesktopControlsVoiceState = DesktopControlsVoiceOwnerState & {
  ownerAvailable: boolean
  revision: number
  pendingIntent: DesktopControlsVoiceIntentType | null
  intentError: DesktopControlsVoiceErrorShape | null
}

export type DesktopControlsVoiceErrorCode =
  | 'OWNER_ALREADY_ATTACHED'
  | 'OWNER_UNAVAILABLE'
  | 'STALE_OWNER'
  | 'INVALID_STATE'
  | 'INTENT_NOT_ALLOWED'
  | 'INTENT_IN_PROGRESS'
  | 'INTENT_FAILED'

export type DesktopControlsVoiceErrorShape = {
  code: DesktopControlsVoiceErrorCode
  message: string
}

export class DesktopControlsVoiceError extends Error {
  readonly code: DesktopControlsVoiceErrorCode

  constructor(code: DesktopControlsVoiceErrorCode, message: string) {
    super(message)
    this.name = 'DesktopControlsVoiceError'
    this.code = code
  }
}

export type DesktopControlsVoiceOwner = {
  publish(state: DesktopControlsVoiceOwnerState): void
  detach(): void
}

export type DesktopControlsVoiceOwnerOptions = {
  initialState: DesktopControlsVoiceOwnerState
  handleIntent(intent: DesktopControlsVoiceIntent): void | Promise<void>
}

const OWNER_STATE_KEYS = new Set<keyof DesktopControlsVoiceOwnerState>([
  'active',
  'listening',
  'runtime',
  'inputKind',
  'phase',
  'label',
  'modeLabel',
  'error',
  'allowedIntents'
])

const VOICE_PHASES = new Set<DesktopControlsVoicePhase>([
  'inactive',
  'starting',
  'listening',
  'ready',
  'processing',
  'speaking',
  'stopping',
  'error'
])

const INTENT_TYPES = new Set<DesktopControlsVoiceIntentType>(['start', 'end', 'toggle-listening'])

const INACTIVE_OWNER_STATE: DesktopControlsVoiceOwnerState = Object.freeze({
  active: false,
  listening: false,
  runtime: 'direct',
  inputKind: null,
  phase: 'inactive',
  label: 'Voice Mode unavailable',
  modeLabel: '',
  error: null,
  allowedIntents: []
})

function cloneOwnerState(state: DesktopControlsVoiceOwnerState): DesktopControlsVoiceOwnerState {
  return { ...state, allowedIntents: [...state.allowedIntents] }
}

function cloneState(state: DesktopControlsVoiceState): DesktopControlsVoiceState {
  return {
    ...state,
    allowedIntents: [...state.allowedIntents],
    intentError: state.intentError ? { ...state.intentError } : null
  }
}

function errorShape(error: DesktopControlsVoiceError): DesktopControlsVoiceErrorShape {
  return { code: error.code, message: error.message }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  )
}

function validateOwnerState(input: DesktopControlsVoiceOwnerState): DesktopControlsVoiceOwnerState {
  if (!isPlainRecord(input)) {
    throw new DesktopControlsVoiceError(
      'INVALID_STATE',
      'Desktop Voice state must be clone-safe plain data.'
    )
  }
  if (
    Object.keys(input).some(
      (key) => !OWNER_STATE_KEYS.has(key as keyof DesktopControlsVoiceOwnerState)
    )
  ) {
    throw new DesktopControlsVoiceError(
      'INVALID_STATE',
      'Desktop Voice state contains an unsupported field.'
    )
  }
  if (typeof input.active !== 'boolean' || typeof input.listening !== 'boolean') {
    throw new DesktopControlsVoiceError(
      'INVALID_STATE',
      'Desktop Voice active and listening flags are required.'
    )
  }
  if (input.runtime !== 'direct' && input.runtime !== 'livekit') {
    throw new DesktopControlsVoiceError('INVALID_STATE', 'Desktop Voice runtime is invalid.')
  }
  if (
    input.inputKind !== null &&
    input.inputKind !== 'continuous' &&
    input.inputKind !== 'recorded' &&
    input.inputKind !== 'text' &&
    input.inputKind !== 'livekit'
  ) {
    throw new DesktopControlsVoiceError('INVALID_STATE', 'Desktop Voice input kind is invalid.')
  }
  if (!VOICE_PHASES.has(input.phase)) {
    throw new DesktopControlsVoiceError('INVALID_STATE', 'Desktop Voice phase is invalid.')
  }
  if (
    typeof input.label !== 'string' ||
    input.label.length > 200 ||
    typeof input.modeLabel !== 'string' ||
    input.modeLabel.length > 200 ||
    !(input.error === null || (typeof input.error === 'string' && input.error.length <= 500))
  ) {
    throw new DesktopControlsVoiceError('INVALID_STATE', 'Desktop Voice labels are invalid.')
  }
  if (
    !Array.isArray(input.allowedIntents) ||
    input.allowedIntents.some((intent) => !INTENT_TYPES.has(intent)) ||
    new Set(input.allowedIntents).size !== input.allowedIntents.length
  ) {
    throw new DesktopControlsVoiceError(
      'INVALID_STATE',
      'Desktop Voice allowed intents are invalid.'
    )
  }
  if (!input.active && input.listening) {
    throw new DesktopControlsVoiceError(
      'INVALID_STATE',
      'Desktop Voice cannot listen while Voice Mode is inactive.'
    )
  }
  if (input.phase === 'listening' && (!input.active || !input.listening)) {
    throw new DesktopControlsVoiceError(
      'INVALID_STATE',
      'Desktop Voice listening phase requires active listening state.'
    )
  }
  if (!input.active && !['inactive', 'starting', 'error'].includes(input.phase)) {
    throw new DesktopControlsVoiceError(
      'INVALID_STATE',
      'Desktop Voice inactive state has an incompatible phase.'
    )
  }
  return cloneOwnerState(input)
}

export class DesktopControlsVoiceCoordinator {
  private state: DesktopControlsVoiceState = {
    ...cloneOwnerState(INACTIVE_OWNER_STATE),
    ownerAvailable: false,
    revision: 0,
    pendingIntent: null,
    intentError: null
  }
  private readonly listeners = new Set<(state: DesktopControlsVoiceState) => void>()
  private ownerGeneration = 0
  private ownerHandler: DesktopControlsVoiceOwnerOptions['handleIntent'] | null = null
  private intentSerial = 0

  getState(): DesktopControlsVoiceState {
    return cloneState(this.state)
  }

  subscribe(listener: (state: DesktopControlsVoiceState) => void): () => void {
    listener(this.getState())
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  attachOwner(options: DesktopControlsVoiceOwnerOptions): DesktopControlsVoiceOwner {
    if (this.ownerHandler) {
      throw new DesktopControlsVoiceError(
        'OWNER_ALREADY_ATTACHED',
        'The main ChatInput already owns Desktop Voice coordination.'
      )
    }
    const initialState = validateOwnerState(options.initialState)
    const generation = ++this.ownerGeneration
    this.ownerHandler = options.handleIntent
    this.setOwnerState(initialState, {
      ownerAvailable: true,
      intentError: null
    })

    return {
      publish: (state) => {
        this.assertCurrentOwner(generation)
        this.setOwnerState(validateOwnerState(state), { ownerAvailable: true })
      },
      detach: () => {
        if (generation !== this.ownerGeneration || !this.ownerHandler) return
        this.ownerGeneration += 1
        this.ownerHandler = null
        this.intentSerial += 1
        this.state = {
          ...cloneOwnerState(INACTIVE_OWNER_STATE),
          ownerAvailable: false,
          revision: this.state.revision + 1,
          pendingIntent: null,
          intentError: null
        }
        this.notify()
      }
    }
  }

  requestStart(): Promise<void> {
    return this.request({ type: 'start' })
  }

  requestEnd(): Promise<void> {
    return this.request({ type: 'end' })
  }

  requestListeningToggle(): Promise<void> {
    return this.request({ type: 'toggle-listening' })
  }

  private async request(intent: DesktopControlsVoiceIntent): Promise<void> {
    const handler = this.ownerHandler
    if (!handler) {
      throw new DesktopControlsVoiceError(
        'OWNER_UNAVAILABLE',
        'The main ChatInput Voice Mode owner is not mounted.'
      )
    }
    if (this.state.pendingIntent) {
      throw new DesktopControlsVoiceError(
        'INTENT_IN_PROGRESS',
        `Desktop Voice ${this.state.pendingIntent} is still in progress.`
      )
    }
    if (!this.state.allowedIntents.includes(intent.type)) {
      throw new DesktopControlsVoiceError(
        'INTENT_NOT_ALLOWED',
        `Desktop Voice ${intent.type} is not available in the current Voice Mode state.`
      )
    }
    const serial = ++this.intentSerial
    this.state = {
      ...this.state,
      revision: this.state.revision + 1,
      pendingIntent: intent.type,
      intentError: null
    }
    this.notify()
    try {
      await handler({ ...intent })
      if (serial !== this.intentSerial) return
      this.state = {
        ...this.state,
        revision: this.state.revision + 1,
        pendingIntent: null,
        intentError: null
      }
      this.notify()
    } catch (error) {
      if (serial !== this.intentSerial) return
      const resolved = new DesktopControlsVoiceError(
        'INTENT_FAILED',
        error instanceof Error ? error.message : `Desktop Voice ${intent.type} failed.`
      )
      this.state = {
        ...this.state,
        revision: this.state.revision + 1,
        pendingIntent: null,
        intentError: errorShape(resolved)
      }
      this.notify()
      throw resolved
    }
  }

  private assertCurrentOwner(generation: number): void {
    if (generation !== this.ownerGeneration || !this.ownerHandler) {
      throw new DesktopControlsVoiceError(
        'STALE_OWNER',
        'A stale ChatInput owner cannot publish Desktop Voice state.'
      )
    }
  }

  private setOwnerState(
    ownerState: DesktopControlsVoiceOwnerState,
    updates: Partial<Pick<DesktopControlsVoiceState, 'ownerAvailable' | 'intentError'>> = {}
  ): void {
    this.state = {
      ...cloneOwnerState(ownerState),
      ownerAvailable: updates.ownerAvailable ?? this.state.ownerAvailable,
      revision: this.state.revision + 1,
      pendingIntent: this.state.pendingIntent,
      intentError: updates.intentError === undefined ? this.state.intentError : updates.intentError
    }
    this.notify()
  }

  private notify(): void {
    for (const listener of this.listeners) listener(this.getState())
  }
}

export const desktopControlsVoiceCoordinator = new DesktopControlsVoiceCoordinator()
