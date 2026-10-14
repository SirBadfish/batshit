import { redis } from '$lib/server/redis'
import { isToolSharedForGroup } from '$lib/services/messageCompiler'
import {
  collectTrustedZipIdsFromMetadata,
  extractTrustedZipIdsFromContent
} from '$lib/utils/zipReferenceSafety'
import { TOOL_MODEL_TEXT_MAX_CHARS } from '$lib/utils/toolModelTextSizeGuard'
import { normalizeGroupChatConfig } from './groupChatUtils'
import { canAccessZipData } from './routeSecurity'
import { getActiveStream } from './streamAbortRegistry'

export const DEFAULT_FETCH_ZIP_CHARS = 16_000
export const MAX_FETCH_ZIP_CHARS = 250_000
/**
 * BL-676: room for each lane's envelope around a Fetch Zip record (the API broker's lines,
 * the controls route's and the managed helper's keys, one more level of JSON indent).
 */
export const FETCH_ZIP_ENVELOPE_RESERVE_CHARS = 2_000
/**
 * BL-676: a page, as the pretty JSON the CLI lanes deliver (the API broker's text is shorter),
 * fits one model result with its envelope, so the size guard never cuts a Fetch Zip page and
 * `nextOffset` always names the first character the agent has not seen.
 */
export const FETCH_ZIP_PAGE_MAX_CHARS = TOOL_MODEL_TEXT_MAX_CHARS - FETCH_ZIP_ENVELOPE_RESERVE_CHARS

export interface ModelZipFetchContext {
  userId: string
  /** The authenticated run's chat, not a tool argument. */
  sessionId?: string | null
  /** The authenticated acting agent, not a tool argument. */
  agentId?: string | null
  /** The authenticated assistant reply, needed for a raw zip before its message is saved. */
  messageId?: string | null
}

export interface ModelZipFetchInput {
  zipId: string
  includeContent?: boolean
  maxChars?: number
  offset?: number
}

function stringId(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function messageAuthor(message: any): string | null {
  return stringId(message?.agent_id) ?? stringId(message?.agentId)
}

function messageHasTrustedZip(message: any, zipId: string): boolean {
  return collectTrustedZipIdsFromMetadata(message?.metadata).includes(zipId)
}

function messageHasCompilableZip(message: any, zipId: string): boolean {
  const content = String(message?.content ?? '')
  const trustedIds = collectTrustedZipIdsFromMetadata(message?.metadata)
  return extractTrustedZipIdsFromContent(content, {
    ...(trustedIds.length > 0
      ? { trustedZipIds: new Set(trustedIds) }
      : { allowConcreteWithoutTrustedSet: true })
  }).includes(zipId)
}

/**
 * BL-680: whether the run with this reply id can fetch a size-guard copy kept under that id.
 * The one rule: `fetchZipForModel` admits an unsaved kept copy by it, and the guard asks it before
 * it names an id. Outside a group chat the chat's own copy is readable. In a group chat an
 * unsaved copy is readable only by the chat's running reply that kept it, which a delegated run's
 * own reply id (`subagent-…`) never is: its cut line must not promise an id and an offset that
 * the fetch then refuses.
 */
export function canRunFetchItsKeptCopy(session: any, sessionId: string, messageId: string | null | undefined): boolean {
  if (!stringId(session?.metadata?.group_chat?.group_id)) return true
  // The chat's running reply is the one reply that may read its unsaved kept copy.
  const replyId = stringId(messageId)
  return Boolean(replyId) && getActiveStream(sessionId)?.messageId === replyId
}

function refusal(zipId: string, reason: string, code = 'ZIP_NOT_ACCESSIBLE') {
  return { found: false as const, zipId, reason, code }
}

/**
 * Read-only Fetch Zip admission for model callers. The chat and actor are supplied by an
 * authenticated run or an in-process turn; no zip ID or tool input can change that scope.
 */
export async function fetchZipForModel(
  context: ModelZipFetchContext,
  input: ModelZipFetchInput
): Promise<Record<string, any>> {
  const zipId = stringId(input.zipId) ?? ''
  if (!zipId) return refusal('', 'zipId is required.', 'INVALID_ZIP_ID')

  const sessionId = stringId(context.sessionId)
  const agentId = stringId(context.agentId)
  if (!sessionId || !agentId) {
    return refusal(zipId, 'Fetch Zip requires a verified agent and chat.', 'MODEL_SCOPE_REQUIRED')
  }

  const offset = input.offset === undefined ? 0 : input.offset
  if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0) {
    return refusal(zipId, 'offset must be a non-negative integer.', 'INVALID_OFFSET')
  }
  const maxChars = input.maxChars === undefined ? DEFAULT_FETCH_ZIP_CHARS : input.maxChars
  if (
    typeof maxChars !== 'number' || !Number.isSafeInteger(maxChars) ||
    maxChars < 64 || maxChars > MAX_FETCH_ZIP_CHARS
  ) {
    return refusal(
      zipId,
      `maxChars must be an integer from 64 to ${MAX_FETCH_ZIP_CHARS}.`,
      'INVALID_MAX_CHARS'
    )
  }

  const session = await redis.getSession(sessionId)
  if (!session || session.user_id !== context.userId) {
    return refusal(zipId, 'Chat is not available to this caller.')
  }

  const zipData = await redis.getZip(zipId)
  if (!zipData || typeof zipData !== 'object' || !(await canAccessZipData(zipData, context.userId))) {
    return refusal(zipId, 'Zip is not available to this caller.')
  }

  const metadata = (zipData as any).metadata && typeof (zipData as any).metadata === 'object'
    ? (zipData as any).metadata as Record<string, any>
    : {}
  const zipSessionIds = [metadata.sessionId, metadata.session_id,
    (zipData as any).sessionId, (zipData as any).session_id]
    .map(stringId).filter((id): id is string => Boolean(id))
  const zipUserIds = [metadata.userId, metadata.user_id,
    (zipData as any).userId, (zipData as any).user_id]
    .map(stringId).filter((id): id is string => Boolean(id))
  if (zipUserIds.some((id) => id !== context.userId)) {
    return refusal(zipId, 'Zip belongs to a different user.')
  }
  const zipSessionId = zipSessionIds[0] ?? null
  if (zipSessionIds.some((id) => id !== zipSessionId)) {
    return refusal(zipId, 'Zip has conflicting chat ownership.')
  }
  if (zipSessionId && zipSessionId !== sessionId) {
    return refusal(zipId, 'Zip belongs to a different chat.')
  }

  const groupId = stringId((session.metadata as any)?.group_chat?.group_id)
  const needsSavedMessages = !zipSessionId || Boolean(groupId)
  const messages = needsSavedMessages ? await redis.getAllMessages(sessionId) : []
  let sourceMessage: any = null

  if (!zipSessionId) {
    // Legacy user-only zips get a narrow exception: this chat must have saved a trusted
    // reference in message metadata. Browser repair or model text does not count.
    sourceMessage = messages.find((message) => messageHasTrustedZip(message, zipId)) ?? null
    if (!sourceMessage) {
      return refusal(zipId, 'Legacy zip has no saved trusted reference in this chat.')
    }
  }

  if (groupId) {
    const group = await redis.getGroup(groupId)
    if (!group || group.user_id !== context.userId) {
      return refusal(zipId, 'Group chat is not available to this caller.')
    }
    const groupConfig = normalizeGroupChatConfig({ enabled: true, ...group })
    const zipMessageId = stringId(metadata.messageId) ?? stringId(metadata.message_id)
    sourceMessage ??= zipMessageId
      ? messages.find((message) => message.id === zipMessageId) ?? null
      : messages.find((message) => messageHasCompilableZip(message, zipId)) ?? null

    let sourceAgentId = sourceMessage ? messageAuthor(sourceMessage) : null
    if (sourceMessage && sourceMessage.user_id !== context.userId) {
      return refusal(zipId, 'Zip source message is not owned by this user.')
    }
    const hasSavedLink = sourceMessage && (
      messageHasCompilableZip(sourceMessage, zipId) ||
      (!zipSessionId && messageHasTrustedZip(sourceMessage, zipId))
    )
    if (sourceMessage && !hasSavedLink &&
      metadata.retainedForSizeGuard !== true) {
      return refusal(zipId, 'Zip is not linked to a saved group message.')
    }

    if (!sourceAgentId && (zipData as any).type === 'tool_raw' &&
      metadata.retainedForSizeGuard === true && zipSessionId === sessionId &&
      zipMessageId === stringId(context.messageId) && canRunFetchItsKeptCopy(session, sessionId, zipMessageId)) {
      sourceAgentId = stringId(metadata.agentId)
    }
    const userSharedZip = sourceMessage?.role === 'user' && hasSavedLink
    if (!sourceAgentId && !userSharedZip) {
      return refusal(zipId, 'Zip source agent is not verified for this group chat.')
    }

    if (!userSharedZip && sourceAgentId !== agentId) {
      // A raw sidecar has no visible card/ref in the persisted message. Until such a link is
      // saved, only its verified author may read it; tool metadata alone grants no sharing.
      if (metadata.retainedForSizeGuard === true || !hasSavedLink) {
        return refusal(zipId, 'This tool result is not shared with this group agent.')
      }
      const shared = isToolSharedForGroup({
        zipType: String((zipData as any).type ?? ''),
        toolCandidates: [
          stringId(metadata.toolName) ?? undefined,
          stringId(metadata.operationKind) ?? undefined,
          stringId((zipData as any).name) ?? undefined
        ]
      }, groupConfig?.shared_tools ?? [])
      if (!shared) {
        return refusal(zipId, 'This tool result is not shared with this group agent.')
      }
    }
  }

  const fullContent = typeof (zipData as any).content === 'string' ? (zipData as any).content : ''
  if (offset > 0 && offset >= fullContent.length) {
    return refusal(zipId, 'offset is past the end of this zip.', 'OFFSET_PAST_END')
  }
  const record = {
    found: true as const,
    zipId: (zipData as any).id ?? zipId,
    type: (zipData as any).type ?? 'unknown',
    tokens: (zipData as any).tokens ?? null,
    description: (zipData as any).description ?? null,
    createdAt: (zipData as any).created_at ?? (zipData as any).createdAt ?? null,
    metadata
  }
  if (input.includeContent === false) return record

  const safeEnd = (end: number) =>
    end > offset && end < fullContent.length &&
      /[\uD800-\uDBFF]/.test(fullContent[end - 1]) && /[\uDC00-\uDFFF]/.test(fullContent[end])
      ? end - 1
      : end
  const requestedEnd = safeEnd(Math.min(fullContent.length, offset + maxChars))
  const pageFor = (end: number) => {
    const nextOffset = end < fullContent.length ? end : null
    const shortened = end < requestedEnd
      ? `This page holds ${(end - offset).toLocaleString('en-US')} characters, so that it fits one result. `
      : ''
    return {
      ...record,
      content: fullContent.slice(offset, end),
      contentLength: fullContent.length,
      offset,
      nextOffset,
      contentTruncated: nextOffset !== null,
      ...(nextOffset !== null
        ? { readMore: `${shortened}Call Fetch Zip with zipId ${zipId}, offset ${nextOffset}, and maxChars ${maxChars}.` }
        : {})
    }
  }
  // Measure the escaped JSON, not the raw characters: quotes, line ends, and control
  // characters grow when a lane serializes the page.
  const fits = (end: number) => JSON.stringify(pageFor(end), null, 2).length <= FETCH_ZIP_PAGE_MAX_CHARS
  if (fits(requestedEnd)) return pageFor(requestedEnd)

  let low = offset
  let high = requestedEnd
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (fits(safeEnd(middle))) low = middle
    else high = middle - 1
  }
  const end = safeEnd(low)
  if (end <= offset || !fits(end)) {
    // Never hand back an empty page with a next offset that does not move.
    return refusal(
      zipId,
      'This zip page cannot fit one result: its details alone are too large.',
      'PAGE_DOES_NOT_FIT'
    )
  }
  return pageFor(end)
}
