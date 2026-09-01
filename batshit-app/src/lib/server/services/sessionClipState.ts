export interface SessionClipStateEntry {
  clipId: string
  attachedAt: string
  attachedToMessageId?: string
  unclipAfter?: number | null
  messagesUntilUnclip?: number | null
  firstAppearanceMessageId?: string
}

export interface SessionClipStateRecord {
  sessionId: string
  clips: SessionClipStateEntry[]
}

function clampCountdown(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return null
  return Math.floor(parsed)
}

export function normalizeSessionClipState(
  sessionId: string,
  raw: unknown
): SessionClipStateRecord {
  const clips = Array.isArray((raw as SessionClipStateRecord | null)?.clips)
    ? (raw as SessionClipStateRecord).clips
        .filter((entry): entry is SessionClipStateEntry =>
          Boolean(entry && typeof entry.clipId === 'string' && entry.clipId.trim())
        )
        .map((entry) => ({
          clipId: entry.clipId.trim(),
          attachedAt:
            typeof entry.attachedAt === 'string' && entry.attachedAt.trim().length > 0
              ? entry.attachedAt
              : new Date().toISOString(),
          attachedToMessageId:
            typeof entry.attachedToMessageId === 'string' &&
            entry.attachedToMessageId.trim().length > 0
              ? entry.attachedToMessageId
              : undefined,
          unclipAfter: clampCountdown(entry.unclipAfter),
          messagesUntilUnclip: clampCountdown(
            entry.messagesUntilUnclip ?? entry.unclipAfter
          ),
          firstAppearanceMessageId:
            typeof entry.firstAppearanceMessageId === 'string' &&
            entry.firstAppearanceMessageId.trim().length > 0
              ? entry.firstAppearanceMessageId
              : undefined
        }))
    : []

  return {
    sessionId,
    clips
  }
}

export function listActiveClipIds(state: SessionClipStateRecord): string[] {
  return state.clips.map((entry) => entry.clipId)
}

export function attachSessionClip(
  state: SessionClipStateRecord,
  options: {
    clipId: string
    messageId?: string
    unclipAfter?: number | null
  }
): SessionClipStateRecord {
  const clipId = options.clipId.trim()
  const nextCountdown = clampCountdown(options.unclipAfter)
  const existing = state.clips.find((entry) => entry.clipId === clipId)

  if (!existing) {
    return {
      ...state,
      clips: [
        ...state.clips,
        {
          clipId,
          attachedAt: new Date().toISOString(),
          attachedToMessageId: options.messageId,
          unclipAfter: nextCountdown,
          messagesUntilUnclip: nextCountdown,
          firstAppearanceMessageId: options.messageId
        }
      ]
    }
  }

  return {
    ...state,
    clips: state.clips.map((entry) =>
      entry.clipId === clipId
        ? {
            ...entry,
            attachedToMessageId: options.messageId ?? entry.attachedToMessageId,
            unclipAfter: nextCountdown,
            messagesUntilUnclip: nextCountdown
          }
        : entry
    )
  }
}

export function detachSessionClip(
  state: SessionClipStateRecord,
  clipId: string
): SessionClipStateRecord {
  return {
    ...state,
    clips: state.clips.filter((entry) => entry.clipId !== clipId)
  }
}

export function updateSessionClipDuration(
  state: SessionClipStateRecord,
  clipId: string,
  unclipAfter?: number | null
): SessionClipStateRecord {
  const nextCountdown = clampCountdown(unclipAfter)

  return {
    ...state,
    clips: state.clips.map((entry) =>
      entry.clipId === clipId
        ? {
            ...entry,
            unclipAfter: nextCountdown,
            messagesUntilUnclip: nextCountdown
          }
        : entry
    )
  }
}

export function decrementSessionClipDurations(
  state: SessionClipStateRecord
): SessionClipStateRecord {
  const clips = state.clips
    .map((entry) => {
      const countdown = clampCountdown(entry.messagesUntilUnclip)
      if (!countdown) {
        return entry
      }

      const nextCountdown = countdown - 1
      if (nextCountdown <= 0) {
        return null
      }

      return {
        ...entry,
        messagesUntilUnclip: nextCountdown
      }
    })
    .filter((entry): entry is SessionClipStateEntry => Boolean(entry))

  return {
    ...state,
    clips
  }
}
