/** Browser copy of server-owned, after-reply Codex cleanup warnings. */
import { readCodexCleanupWarning, type CodexCleanupWarning } from '$lib/utils/codexCleanupWarning'

let recordsBySession = $state<Record<string, Record<string, CodexCleanupWarning>>>({})
const refreshGeneration = new Map<string, number>()

function normalized(value?: string | null): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

export function getCodexCleanupWarning(sessionId?: string | null, messageId?: string | null): CodexCleanupWarning | null {
  const session = normalized(sessionId)
  const message = normalized(messageId)
  return session && message ? recordsBySession[session]?.[message] ?? null : null
}

export function applyCodexCleanupWarnings(sessionId: string, records: unknown): void {
  const session = normalized(sessionId)
  if (!session) return
  const next: Record<string, CodexCleanupWarning> = {}
  if (records && typeof records === 'object' && !Array.isArray(records)) {
    for (const [messageId, value] of Object.entries(records)) {
      const record = readCodexCleanupWarning(value, messageId)
      if (record) next[messageId] = record
    }
  }
  recordsBySession[session] = next
}

export async function refreshCodexCleanupWarnings(sessionId?: string | null, fetcher: typeof fetch = fetch): Promise<void> {
  const session = normalized(sessionId)
  if (!session) return
  const generation = (refreshGeneration.get(session) ?? 0) + 1
  refreshGeneration.set(session, generation)
  try {
    const response = await fetcher(`/api/codex/cleanup-warnings?sessionId=${encodeURIComponent(session)}`)
    if (!response.ok) {
      if (response.status !== 404) console.warn('[Codex cleanup] Could not read warnings:', response.status)
      return
    }
    const payload = await response.json().catch(() => null)
    // An open-chat hydration may have started before a newer user-channel refresh.
    if (refreshGeneration.get(session) === generation) applyCodexCleanupWarnings(session, payload?.records)
  } catch (error) {
    console.warn('[Codex cleanup] Could not read warnings:', error)
  }
}

export function forgetCodexCleanupWarnings(sessionId?: string | null): void {
  const session = normalized(sessionId)
  if (!session) return
  refreshGeneration.set(session, (refreshGeneration.get(session) ?? 0) + 1)
  if (!(session in recordsBySession)) return
  const { [session]: _gone, ...rest } = recordsBySession
  recordsBySession = rest
}
