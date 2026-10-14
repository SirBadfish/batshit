import type { ModelMessage } from 'ai'
import type { CurrentMessageFrom } from '$lib/utils/compiledChatTags'
import { buildSteerInjectionText, type DeliveredSteer } from '$lib/utils/steerControl'
import { resolveCurrentMessageFrom } from './sendRoutedHistory'
import { isChatgptPlanConnection } from '$lib/utils/chatgptPlanConnection'

/**
 * BL-322: an API-lane approval resume is the paused call, CONTINUED.
 *
 * The AI SDK pauses a reply at a tool that needs approval and carries on only when it is handed
 * the same conversation back with the user's answer at the end. Batshit used to hand it a
 * different one: the paused reply moved into `<conversation>` as history, the compile had no
 * current message, so it built no `<dynamic_info>` at all (no `tool_discovery`, no `Clips
 * attached` roster, no zip state, DMs, or memory context), and only the ONE step that asked for
 * approval was replayed, so every tool the agent ran before the card was reduced to a zip label.
 * Live, the SA-072 P2 offline OCR chat lost its Clip id that way and the agent guessed it three
 * times before digging it out of a log (26 model calls).
 *
 * So the resume compiles what the paused call compiled: the history BEFORE the paused turn's
 * own message, that message as the current message again (so the compiler builds its
 * `<dynamic_info>` in its usual place), then every step the paused run took, in order, then the
 * answer. The rules for each part live here; `send-routed` only wires them.
 */

type HistoryMessage = Record<string, any>

export type PausedApprovalTurn<T extends HistoryMessage> = {
  /** Every message before the paused turn's own message: what the paused call compiled as history. */
  history: T[]
  /** The message that started the paused turn. The resume compiles it as the current message again. */
  currentMessage: T
  /** Its text, exactly as it was compiled the first time. */
  currentText: string
  /** Who wrote it (`resolveCurrentMessageFrom` on its stored metadata): a woken turn's DM is a note. */
  from: CurrentMessageFrom
  /** When it was written, for its `time` attribute; the paused call stamped the same minute. */
  at: Date | null
  /** The project and files the paused send carried, as the browser stored them on the message. */
  projectPath: string | null
  fileReferences: unknown[]
}

function messageText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => {
      if (typeof part === 'string') return part
      if (part && typeof part === 'object' && typeof (part as HistoryMessage).text === 'string') {
        return (part as HistoryMessage).text as string
      }
      return ''
    })
    .join('')
}

/**
 * The paused turn inside the request's history: the assistant message the card is on, and the
 * user message directly before it (a typed message, a woken turn's DM, a share: every turn that
 * can raise a card starts with one). Anything after the paused reply is not part of the turn
 * being continued, so it is not compiled. Null when the history does not hold that shape; the
 * caller refuses the resume rather than compile a different conversation.
 */
export function findPausedApprovalTurn<T extends HistoryMessage>(
  messages: readonly T[],
  pausedMessageId: string | null | undefined,
): PausedApprovalTurn<T> | null {
  const id = typeof pausedMessageId === 'string' ? pausedMessageId.trim() : ''
  if (!id || !Array.isArray(messages)) return null

  let pausedIndex = -1
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role === 'assistant' && message.id === id) {
      pausedIndex = index
      break
    }
  }
  if (pausedIndex < 1) return null

  const currentMessage = messages[pausedIndex - 1]
  if (currentMessage?.role !== 'user') return null
  const currentText = messageText(currentMessage.content)
  if (!currentText.trim()) return null

  const metadata =
    currentMessage.metadata && typeof currentMessage.metadata === 'object'
      ? (currentMessage.metadata as HistoryMessage)
      : {}
  const writtenAt = Date.parse(String(currentMessage.created_at ?? currentMessage.timestamp ?? ''))
  return {
    history: messages.slice(0, pausedIndex - 1),
    currentMessage,
    currentText,
    from: resolveCurrentMessageFrom({ metadata }),
    at: Number.isFinite(writtenAt) ? new Date(writtenAt) : null,
    projectPath:
      typeof metadata.projectPath === 'string' && metadata.projectPath.trim()
        ? metadata.projectPath
        : null,
    fileReferences: Array.isArray(metadata.fileReferences) ? metadata.fileReferences : [],
  }
}

export type ApprovalResumeReplayFailure =
  | 'APPROVAL_RESUME_CONTEXT_MISSING'
  | 'APPROVAL_RESUME_MODEL_CHANGED'

export class ApprovalResumeReplayError extends Error {
  readonly code: ApprovalResumeReplayFailure
  readonly status = 409

  constructor(code: ApprovalResumeReplayFailure, message: string) {
    super(message)
    this.name = 'ApprovalResumeReplayError'
    this.code = code
  }
}

function coerceModelMessages(value: unknown): ModelMessage[] {
  if (!Array.isArray(value)) return []
  return value.filter(
    (entry): entry is ModelMessage =>
      Boolean(entry) &&
      typeof entry === 'object' &&
      typeof (entry as HistoryMessage).role === 'string' &&
      (entry as HistoryMessage).content !== undefined,
  )
}

function approvalRequestIds(messages: readonly ModelMessage[]): Set<string> {
  const ids = new Set<string>()
  for (const message of messages) {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) continue
    for (const part of message.content as HistoryMessage[]) {
      if (part?.type !== 'tool-approval-request') continue
      const approvalId = typeof part.approvalId === 'string' ? part.approvalId.trim() : ''
      if (approvalId) ids.add(approvalId)
    }
  }
  return ids
}

function sameIdentity(expected: string | null | undefined, stored: unknown): boolean {
  const want = typeof expected === 'string' ? expected.trim().toLowerCase() : ''
  const have = typeof stored === 'string' ? stored.trim().toLowerCase() : ''
  // A side that names nothing cannot disagree; the replay's own check still applies.
  return !want || !have || want === have
}

export function assertPlanApprovalSource(record: { metadata?: unknown } | null | undefined, expected: { connectionId?: string | null; planBinding?: string | null }) {
  const metadata = record?.metadata as HistoryMessage | undefined
  const source = metadata?.providerMessageSource as HistoryMessage | undefined
  if (!isChatgptPlanConnection(expected.connectionId) && !isChatgptPlanConnection(source?.connectionId) && !expected.planBinding && !source?.planBinding) return
  if (!isChatgptPlanConnection(expected.connectionId) || source?.connectionId !== expected.connectionId || typeof expected.planBinding !== 'string' || !/^[a-f0-9]{64}$/.test(expected.planBinding) || source?.planBinding !== expected.planBinding) {
    throw new ApprovalResumeReplayError('APPROVAL_RESUME_MODEL_CHANGED', 'This approval belongs to a different ChatGPT account session. It did not run. Ask the agent again.')
  }
}

/**
 * Every step the paused run took, in order, from the paused message's own stored record (read
 * from Redis, never from the browser's copy), ready to follow the compiled messages.
 *
 * The record's `providerMessages` are the run's transcript after the compiled messages (see
 * `buildReplayableTranscript`), so they already hold every earlier step, each steer where the
 * model read it, and, for a reply that asked more than once, every earlier resume. A leading
 * tool message has no call before it (a record written before BL-322 by a resume) and is
 * dropped, since a provider refuses a result with no call.
 *
 * Refuses when the record cannot continue the call: no approval request for an answered id
 * (the SDK would throw a less useful error of its own), or a record written by another provider
 * or connection than the agent uses now (its steps are in that provider's shape). The model id
 * alone may differ: aliases and dated ids of one model are the same model.
 */
export function buildApprovalResumeReplay(input: {
  record: { metadata?: unknown } | null | undefined
  approvalIds: Iterable<string>
  expected: { providerId?: string | null; connectionId?: string | null; planBinding?: string | null }
}): ModelMessage[] {
  assertPlanApprovalSource(input.record, input.expected)
  const metadata =
    input.record?.metadata && typeof input.record.metadata === 'object'
      ? (input.record.metadata as HistoryMessage)
      : {}
  const source =
    metadata.providerMessageSource && typeof metadata.providerMessageSource === 'object'
      ? (metadata.providerMessageSource as HistoryMessage)
      : {}
  if (
    !sameIdentity(input.expected.providerId, source.providerId) ||
    !sameIdentity(input.expected.connectionId, source.connectionId)
  ) {
    throw new ApprovalResumeReplayError(
      'APPROVAL_RESUME_MODEL_CHANGED',
      "The agent's model connection changed after it asked for approval, so Batshit could not continue that reply. Ask the agent again.",
    )
  }

  const replay = coerceModelMessages(metadata.providerMessages).filter(
    (message) => message.role !== 'system',
  )
  while (replay.length > 0 && replay[0]?.role === 'tool') replay.shift()

  const requested = approvalRequestIds(replay)
  const wanted = Array.from(input.approvalIds)
    .map((id) => (typeof id === 'string' ? id.trim() : ''))
    .filter(Boolean)
  if (wanted.length === 0 || wanted.some((id) => !requested.has(id))) {
    throw new ApprovalResumeReplayError(
      'APPROVAL_RESUME_CONTEXT_MISSING',
      'Batshit could not find the step this approval answers in the saved reply, so it did not run it. Ask the agent again.',
    )
  }
  return replay
}

/**
 * The steers a run delivered, put back where the model read them.
 *
 * The API lane's `prepareStep` hands every waiting steer to the model as ONE user message
 * before step `step`, and the SDK never puts that message in `response.messages`, so a replay
 * built from the transcript alone would drop the user's mid-reply words. Step `s` begins after
 * the approved results the run started with (`responseMessages` minus every step's messages)
 * and the messages of steps `0 … s-1`; the words are rebuilt with `buildSteerInjectionText`,
 * the function the hook used. Steers another lane delivered are not in this transcript.
 */
export function interleaveDeliveredSteers(
  responseMessages: readonly ModelMessage[],
  stepMessageCounts: readonly number[],
  steers: readonly DeliveredSteer[],
): ModelMessage[] {
  const messages = [...responseMessages]
  const apiSteers = steers.filter((steer) => steer.lane === 'api' && Number.isInteger(steer.step))
  if (apiSteers.length === 0) return messages

  const counts = stepMessageCounts.map((count) => (Number.isInteger(count) && count > 0 ? count : 0))
  const stepTotal = counts.reduce((sum, count) => sum + count, 0)
  const initialCount = messages.length - stepTotal
  if (initialCount < 0) {
    throw new Error(
      `interleaveDeliveredSteers: ${stepTotal} step messages but only ${messages.length} response messages`,
    )
  }

  const byStep = new Map<number, typeof apiSteers>()
  for (const steer of apiSteers) {
    const group = byStep.get(steer.step) ?? []
    group.push(steer)
    byStep.set(steer.step, group)
  }

  // Latest position first, so an insertion never moves one still to come.
  const positions = Array.from(byStep.keys()).sort((a, b) => b - a)
  for (const step of positions) {
    const before = counts.slice(0, Math.max(0, Math.min(step, counts.length)))
    const at = initialCount + before.reduce((sum, count) => sum + count, 0)
    messages.splice(at, 0, {
      role: 'user',
      content: [{ type: 'text', text: buildSteerInjectionText(byStep.get(step) ?? []) }],
    })
  }
  return messages
}

/**
 * What a run stores as `metadata.providerMessages`: everything the model read after the
 * compiled messages, so the next approval resume can replay it whole. A fresh run stores its own
 * transcript; a resume stores the replay it was given, the answer it resumed with, and its own
 * transcript after them, which is the conversation the SDK itself carried between its steps.
 */
export function buildReplayableTranscript(input: {
  replay: readonly ModelMessage[]
  approvalResponse: ModelMessage | null
  responseMessages: readonly ModelMessage[]
  stepMessageCounts: readonly number[]
  steers: readonly DeliveredSteer[]
}): ModelMessage[] {
  return [
    ...input.replay,
    ...(input.approvalResponse ? [input.approvalResponse] : []),
    ...interleaveDeliveredSteers(input.responseMessages, input.stepMessageCounts, input.steers),
  ]
}
