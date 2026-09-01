import { getCurrentSessionId, subscribe as subscribeToSessions } from '$lib/stores/session.svelte'
import type { ClipRow } from '$lib/types/database'
import {
  LIVE_SETTINGS_EVENTS,
  type SessionClipStateChangedDetail
} from '$lib/utils/liveSettingsEvents'

export type DesktopControlsClip = Pick<
  ClipRow,
  | 'id'
  | 'filename'
  | 'fileType'
  | 'mimeType'
  | 'externalUrl'
  | 'displayUrl'
  | 'localUrl'
  | 'thumbnailUrl'
  | 'externalTokens'
  | 'localTokens'
  | 'storageMode'
  | 'description'
  | 'created_at'
> & {
  systemClip: boolean
  attached: boolean
  unclipAfter: number | null
  messagesUntilUnclip: number | null
}

export type DesktopControlsClipStateStatus =
  'detached' | 'loading' | 'ready' | 'mutating' | 'error' | 'closed'

export type DesktopControlsClipState = {
  status: DesktopControlsClipStateStatus
  sessionId: string | null
  clips: DesktopControlsClip[]
  attachedClips: DesktopControlsClip[]
  error: DesktopControlsClipErrorShape | null
}

export type DesktopControlsClipErrorCode =
  | 'SESSION_REQUIRED'
  | 'CLIP_NOT_FOUND'
  | 'REQUEST_IN_PROGRESS'
  | 'REQUEST_FAILED'
  | 'INVALID_RESPONSE'
  | 'BROKEN_CLIP_REFERENCE'
  | 'CLOSED'

export type DesktopControlsClipErrorShape = {
  code: DesktopControlsClipErrorCode
  message: string
}

export class DesktopControlsClipError extends Error {
  readonly code: DesktopControlsClipErrorCode

  constructor(code: DesktopControlsClipErrorCode, message: string) {
    super(message)
    this.name = 'DesktopControlsClipError'
    this.code = code
  }
}

type DesktopControlsFetchResponse = {
  ok: boolean
  status: number
  json(): Promise<unknown>
}

export type DesktopControlsFetch = (
  input: string,
  init?: RequestInit
) => Promise<DesktopControlsFetchResponse>

export type DesktopControlsSessionSource = {
  getCurrentSessionId(): string | null
  subscribe(listener: (sessionId: string | null) => void): () => void
}

export type DesktopControlsClipEventTarget = Pick<
  EventTarget,
  'addEventListener' | 'removeEventListener' | 'dispatchEvent'
>

type SessionClipEntry = {
  clipId: string
  unclipAfter: number | null
  messagesUntilUnclip: number | null
}

type SessionClipRecord = {
  sessionId: string
  clips: SessionClipEntry[]
}

type RawClip = Partial<ClipRow> & { systemClip?: unknown }

const defaultSessionSource: DesktopControlsSessionSource = {
  getCurrentSessionId,
  subscribe(listener) {
    return subscribeToSessions((state) => listener(state.currentSessionId))
  }
}

function resolveEventTarget(): DesktopControlsClipEventTarget | null {
  return typeof window === 'undefined' ? null : window
}

function cloneClip(clip: DesktopControlsClip): DesktopControlsClip {
  return { ...clip }
}

function cloneState(state: DesktopControlsClipState): DesktopControlsClipState {
  const clips = state.clips.map(cloneClip)
  const attachedIds = new Set(state.attachedClips.map((clip) => clip.id))
  return {
    ...state,
    clips,
    attachedClips: clips.filter((clip) => attachedIds.has(clip.id)),
    error: state.error ? { ...state.error } : null
  }
}

function errorShape(error: DesktopControlsClipError): DesktopControlsClipErrorShape {
  return { code: error.code, message: error.message }
}

function resolveClipError(error: unknown): DesktopControlsClipError {
  return error instanceof DesktopControlsClipError
    ? error
    : new DesktopControlsClipError(
        'REQUEST_FAILED',
        error instanceof Error ? error.message : 'Desktop Clip state request failed.'
      )
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new DesktopControlsClipError('INVALID_RESPONSE', `${label} is missing.`)
  }
  return value.trim()
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function optionalNullableString(value: unknown): string | null | undefined {
  if (value === null) return null
  return optionalString(value)
}

function optionalFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function countdown(value: unknown): number | null {
  if (value === null || value === undefined) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null
}

function parseClip(value: unknown): DesktopControlsClip {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DesktopControlsClipError('INVALID_RESPONSE', 'Clip API returned a non-object clip.')
  }
  const input = value as RawClip
  const storageMode = input.storageMode
  if (storageMode !== 'local') {
    throw new DesktopControlsClipError(
      'INVALID_RESPONSE',
      'Clip API returned an unsupported storage mode.'
    )
  }
  return {
    id: requiredString(input.id, 'Clip id'),
    filename: requiredString(input.filename, 'Clip filename'),
    fileType: optionalString(input.fileType),
    mimeType: optionalString(input.mimeType),
    externalUrl: optionalNullableString(input.externalUrl),
    displayUrl: optionalString(input.displayUrl),
    localUrl: optionalString(input.localUrl),
    thumbnailUrl: optionalString(input.thumbnailUrl),
    externalTokens: optionalFiniteNumber(input.externalTokens),
    localTokens: optionalFiniteNumber(input.localTokens),
    storageMode,
    description: optionalString(input.description),
    created_at: requiredString(input.created_at, 'Clip creation timestamp'),
    systemClip: input.systemClip === true,
    attached: false,
    unclipAfter: null,
    messagesUntilUnclip: null
  }
}

function parseSessionClipRecord(value: unknown, sessionId: string): SessionClipRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DesktopControlsClipError(
      'INVALID_RESPONSE',
      'Session Clip API returned a non-object state.'
    )
  }
  const input = value as { sessionId?: unknown; clips?: unknown }
  if (input.sessionId !== undefined && input.sessionId !== sessionId) {
    throw new DesktopControlsClipError(
      'INVALID_RESPONSE',
      'Session Clip API returned state for another session.'
    )
  }
  if (!Array.isArray(input.clips)) {
    throw new DesktopControlsClipError(
      'INVALID_RESPONSE',
      'Session Clip API response is missing its clip list.'
    )
  }
  const clips = input.clips.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new DesktopControlsClipError(
        'INVALID_RESPONSE',
        'Session Clip API returned an invalid clip entry.'
      )
    }
    const candidate = entry as Record<string, unknown>
    return {
      clipId: requiredString(candidate.clipId, 'Session clip id'),
      unclipAfter: countdown(candidate.unclipAfter),
      messagesUntilUnclip: countdown(candidate.messagesUntilUnclip ?? candidate.unclipAfter)
    }
  })
  return { sessionId, clips }
}

function applySessionState(
  clips: DesktopControlsClip[],
  record: SessionClipRecord
): DesktopControlsClip[] {
  const stateByClip = new Map(record.clips.map((entry) => [entry.clipId, entry]))
  const knownClipIds = new Set(clips.map((clip) => clip.id))
  const brokenReference = [...stateByClip.keys()].find((clipId) => !knownClipIds.has(clipId))
  if (brokenReference) {
    throw new DesktopControlsClipError(
      'BROKEN_CLIP_REFERENCE',
      `Session ${record.sessionId} references missing clip ${brokenReference}.`
    )
  }
  return clips.map((clip) => {
    const entry = stateByClip.get(clip.id)
    return {
      ...clip,
      attached: Boolean(entry),
      unclipAfter: entry?.unclipAfter ?? null,
      messagesUntilUnclip: entry?.messagesUntilUnclip ?? null
    }
  })
}

async function responseError(response: DesktopControlsFetchResponse, fallback: string) {
  const body = await response.json().catch(() => null)
  if (body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string') {
    return (body as { error: string }).error
  }
  return `${fallback} (HTTP ${response.status}).`
}

export class DesktopControlsClipStateController {
  private state: DesktopControlsClipState = {
    status: 'detached',
    sessionId: null,
    clips: [],
    attachedClips: [],
    error: null
  }
  private readonly listeners = new Set<(state: DesktopControlsClipState) => void>()
  private readonly fetcher: DesktopControlsFetch
  private readonly sessionSource: DesktopControlsSessionSource
  private readonly eventTarget: DesktopControlsClipEventTarget | null
  private sessionUnsubscribe: (() => void) | null = null
  private started = false
  private closed = false
  private requestSerial = 0
  private mutating = false
  private suppressOwnInvalidation = false

  constructor(
    options: {
      fetcher?: DesktopControlsFetch
      sessionSource?: DesktopControlsSessionSource
      eventTarget?: DesktopControlsClipEventTarget | null
    } = {}
  ) {
    this.fetcher = options.fetcher ?? (fetch as DesktopControlsFetch)
    this.sessionSource = options.sessionSource ?? defaultSessionSource
    this.eventTarget =
      options.eventTarget === undefined ? resolveEventTarget() : options.eventTarget
  }

  start(): void {
    if (this.closed) throw new DesktopControlsClipError('CLOSED', 'Desktop Clip state is closed.')
    if (this.started) return
    this.started = true
    this.eventTarget?.addEventListener(
      LIVE_SETTINGS_EVENTS.sessionClipStateChanged,
      this.handleSessionClipStateChanged
    )
    let emittedCurrentSession = false
    this.sessionUnsubscribe = this.sessionSource.subscribe((sessionId) => {
      emittedCurrentSession = true
      void this.setSession(sessionId).catch(() => {
        // setSession records the explicit error state; session changes never retry or poll.
      })
    })
    if (!emittedCurrentSession) {
      void this.setSession(this.sessionSource.getCurrentSessionId()).catch(() => {
        // setSession records the explicit error state; initial attachment never retries or polls.
      })
    }
  }

  getState(): DesktopControlsClipState {
    return cloneState(this.state)
  }

  subscribe(listener: (state: DesktopControlsClipState) => void): () => void {
    listener(this.getState())
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async setSession(sessionId: string | null): Promise<void> {
    this.assertOpen()
    const normalizedSessionId = sessionId?.trim() || null
    const serial = ++this.requestSerial
    if (!normalizedSessionId) {
      this.setState({
        status: 'detached',
        sessionId: null,
        clips: [],
        attachedClips: [],
        error: null
      })
      return
    }
    this.setState({
      status: 'loading',
      sessionId: normalizedSessionId,
      clips: [],
      attachedClips: [],
      error: null
    })
    try {
      const [clipsResponse, sessionResponse] = await Promise.all([
        this.fetcher('/api/clips'),
        this.fetcher(`/api/session-clips/state/${encodeURIComponent(normalizedSessionId)}`)
      ])
      if (!clipsResponse.ok) {
        throw new DesktopControlsClipError(
          'REQUEST_FAILED',
          await responseError(clipsResponse, 'Failed to load Clips')
        )
      }
      if (!sessionResponse.ok) {
        throw new DesktopControlsClipError(
          'REQUEST_FAILED',
          await responseError(sessionResponse, 'Failed to load session Clip state')
        )
      }
      const rawClips = await clipsResponse.json()
      const rawSession = await sessionResponse.json()
      if (!Array.isArray(rawClips)) {
        throw new DesktopControlsClipError(
          'INVALID_RESPONSE',
          'Clip API response must be an array.'
        )
      }
      const clips = rawClips.map(parseClip)
      const record = parseSessionClipRecord(rawSession, normalizedSessionId)
      const resolved = applySessionState(clips, record)
      if (serial !== this.requestSerial || this.closed) return
      this.commitReady(normalizedSessionId, resolved)
    } catch (error) {
      if (serial !== this.requestSerial || this.closed) return
      const resolved = resolveClipError(error)
      this.fail(resolved)
      throw resolved
    }
  }

  async refresh(): Promise<void> {
    this.assertOpen()
    await this.setSession(this.state.sessionId ?? this.sessionSource.getCurrentSessionId())
  }

  async attach(clipId: string): Promise<void> {
    await this.mutate(clipId, 'attach')
  }

  async detach(clipId: string): Promise<void> {
    await this.mutate(clipId, 'detach')
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.requestSerial += 1
    this.mutating = false
    this.sessionUnsubscribe?.()
    this.sessionUnsubscribe = null
    this.eventTarget?.removeEventListener(
      LIVE_SETTINGS_EVENTS.sessionClipStateChanged,
      this.handleSessionClipStateChanged
    )
    this.setState({
      status: 'closed',
      sessionId: null,
      clips: [],
      attachedClips: [],
      error: null
    })
    this.listeners.clear()
  }

  private readonly handleSessionClipStateChanged = (event: Event) => {
    if (this.closed || this.suppressOwnInvalidation) return
    const detail = (event as CustomEvent<SessionClipStateChangedDetail>).detail
    if (!detail?.sessionId || detail.sessionId !== this.state.sessionId) return
    void this.refresh().catch(() => {
      // refresh() stores the explicit error state; there is no hidden retry loop.
    })
  }

  private async mutate(clipIdInput: string, action: 'attach' | 'detach'): Promise<void> {
    this.assertOpen()
    if (this.mutating) {
      throw new DesktopControlsClipError(
        'REQUEST_IN_PROGRESS',
        'Another Desktop Clip update is still in progress.'
      )
    }
    const sessionId = this.state.sessionId
    if (!sessionId) {
      throw new DesktopControlsClipError(
        'SESSION_REQUIRED',
        'Select an active chat before changing Clips.'
      )
    }
    const clipId = clipIdInput.trim()
    if (!clipId || !this.state.clips.some((clip) => clip.id === clipId)) {
      throw new DesktopControlsClipError(
        'CLIP_NOT_FOUND',
        `Clip ${clipId || '(empty)'} is not in the current Clip Vault.`
      )
    }
    this.mutating = true
    this.setState({ ...this.state, status: 'mutating', error: null })
    try {
      const response = await this.fetcher('/api/session-clips/state', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          clipId,
          action,
          ...(action === 'attach' ? { unclipAfter: null } : {})
        })
      })
      if (!response.ok) {
        throw new DesktopControlsClipError(
          'REQUEST_FAILED',
          await responseError(response, `Failed to ${action} Clip`)
        )
      }
      const record = parseSessionClipRecord(await response.json(), sessionId)
      if (this.closed) return
      if (this.state.sessionId === sessionId) {
        const resolved = applySessionState(this.state.clips, record)
        this.commitReady(sessionId, resolved)
      }
      this.dispatchInvalidation({ sessionId, clipId, source: 'runtime' })
    } catch (error) {
      const resolved = resolveClipError(error)
      if (!this.closed && this.state.sessionId === sessionId) this.fail(resolved)
      throw resolved
    } finally {
      this.mutating = false
    }
  }

  private dispatchInvalidation(detail: SessionClipStateChangedDetail): void {
    if (!this.eventTarget) return
    this.suppressOwnInvalidation = true
    try {
      this.eventTarget.dispatchEvent(
        new CustomEvent(LIVE_SETTINGS_EVENTS.sessionClipStateChanged, {
          detail
        })
      )
    } finally {
      this.suppressOwnInvalidation = false
    }
  }

  private commitReady(sessionId: string, clips: DesktopControlsClip[]): void {
    this.setState({
      status: 'ready',
      sessionId,
      clips,
      attachedClips: clips.filter((clip) => clip.attached),
      error: null
    })
  }

  private fail(error: unknown): void {
    const resolved = resolveClipError(error)
    this.setState({
      ...this.state,
      status: 'error',
      error: errorShape(resolved)
    })
  }

  private assertOpen(): void {
    if (this.closed) throw new DesktopControlsClipError('CLOSED', 'Desktop Clip state is closed.')
  }

  private setState(state: DesktopControlsClipState): void {
    this.state = cloneState(state)
    for (const listener of this.listeners) listener(this.getState())
  }
}
