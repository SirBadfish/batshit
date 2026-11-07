import type { CacheForensicsSegmentType } from '$lib/types/cacheForensics'
import { segmentCompiledUserMessage } from './compiledMessageSegments'
import type { CacheForensicsSegmentInput } from './fingerprint'

/**
 * SA-093 batshit-compiled message segmentation (P4), used by the managed subagent adapter
 * (`subagentAdapter.ts`). It fingerprints RAW inputs, never log-sanitized copies: log redaction
 * replaces distinct base64/image payloads with size markers, which could make two genuinely
 * different requests hash identically. SA-139 R4 removed the CLI Primary's run record that also
 * used it.
 */

interface CliMessageLike {
  role?: string
  content?: unknown
  name?: string
}

function messageSegmentType(
  message: CliMessageLike,
  index: number,
  total: number,
): CacheForensicsSegmentType {
  if (message?.role === 'system') return 'system-prompt'
  if (index === total - 1 && message?.role === 'user') return 'current-user-turn'
  return 'history-message'
}

/**
 * Shared batshit-compiled message segmentation: one ordered segment per
 * compiled message, role-labeled.
 */
export function segmentCompiledMessages(messages: unknown[]): CacheForensicsSegmentInput[] {
  const list = Array.isArray(messages) ? messages : []
  const segments: CacheForensicsSegmentInput[] = []
  list.forEach((message, index) => {
    const entry = (message ?? {}) as CliMessageLike
    const role = typeof entry.role === 'string' && entry.role ? entry.role : 'unknown'
    const label = `prompt.messages[${index}]:${role}`
    // SA-108: Batshit compiles the whole conversation into one user message, so
    // that element is sub-segmented here exactly like the API lane does.
    const compiled =
      typeof entry.content === 'string' ? segmentCompiledUserMessage(entry.content, label) : null
    if (compiled) {
      segments.push(...compiled)
      return
    }
    segments.push({
      type: messageSegmentType(entry, index, list.length),
      label,
      content: message ?? null,
    })
  })
  return segments
}
