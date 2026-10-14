import { describeTooLargeToolResult, type ToolResultSizeGuard } from './toolResultSizeGuard'
import { UNKNOWN_JUDGE_NAME } from './judgeProviders'

/**
 * Who holds a zip open. `inferred` (SA-120 P5) is Batshit acting on a Judge Juice judgment: the
 * weakest actor, always temporary, never a lock.
 */
export type ZipStatusActor = 'auto' | 'user' | 'agent' | 'inferred' | null
export type ZipExpandedReason = 'buffer' | 'user' | 'agent' | 'inferred'
export type ZipStatusDuration = 'countdown' | 'permanent' | 'none'
export type ZipStatusTone = 'zipped' | 'unzipped' | 'warning'

export interface ZipStatusPresentationInput {
  isZipped?: boolean
  isUnzipped?: boolean
  expandedReason?: ZipExpandedReason
  isPermanent?: boolean
  remainingMessages?: number | null
  manualZip?: boolean
  autoZip?: boolean
  agentControlled?: boolean
  /** Judge Juice opened it, or zipped it after a reply (`source: 'inferred'`). */
  inferredControlled?: boolean
  aboutToZip?: boolean
  /**
   * SA-129 P2 (D1): who holds it, in the user's words ("Held by you", "Held by you (3 messages
   * left)", "Held by Opie"), from `describeHoldForUser`. Absent when nobody holds it.
   */
  holdLabel?: string | null
  /** SA-129 P2 (BL-333): the prompt compresses this read as a dead copy, and why. */
  deadCopyReason?: 'superseded' | 'stale' | null
  sizeGuard?: ToolResultSizeGuard
  tokens?: number
  /**
   * BL-1485 (SA-120 P10b): the judge that opened or zipped it, named by `judgeModelName` /
   * `judgeNameOfCallRecord` ("Clef Flash", "Jev"). The stored zip state keeps no judge, so every
   * caller today leaves it out and the words say "the judge" (`UNKNOWN_JUDGE_NAME`), never a guess.
   */
  judgeName?: string | null
}

/**
 * The one reading of stored zip-state sources for every surface that draws a zip badge (the
 * chat and the Zip Manager). An unknown or absent unzip source is the user's, as it always
 * was; `inferred` is never shown as a user lock.
 */
export function resolveZipStateActors(
  unzippedSource: string | null | undefined,
  rezippedSource: string | null | undefined,
  isUnzipped: boolean
): { expandedReason: 'user' | 'agent' | 'inferred' | undefined; agentControlled: boolean; inferredControlled: boolean } {
  const expandedReason = !isUnzipped
    ? undefined
    : unzippedSource === 'agent'
      ? 'agent'
      : unzippedSource === 'inferred'
        ? 'inferred'
        : 'user'
  return {
    expandedReason,
    agentControlled: (isUnzipped && unzippedSource === 'agent') || rezippedSource === 'agent',
    inferredControlled: (isUnzipped && unzippedSource === 'inferred') || rezippedSource === 'inferred'
  }
}

export interface ZipStatusPresentation {
  state: 'zipped' | 'unzipped'
  actor: ZipStatusActor
  duration: ZipStatusDuration
  remainingMessages: number | null
  tone: ZipStatusTone
  tooltip: string
  ariaLabel: string
}

function pluralizeMessage(count: number) {
  return `${count} message${count === 1 ? '' : 's'}`
}

function normalizeRemainingMessages(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  const normalized = Math.max(0, Math.ceil(value))
  return normalized > 0 ? normalized : null
}

function resolveActor(input: ZipStatusPresentationInput): ZipStatusActor {
  if (input.expandedReason === 'agent') return 'agent'
  if (input.expandedReason === 'inferred') return 'inferred'
  if (input.expandedReason === 'user') return 'user'
  if (input.isUnzipped && input.agentControlled) return 'agent'
  if (input.isUnzipped && input.inferredControlled) return 'inferred'
  if (input.isUnzipped) return 'user'
  return 'auto'
}

/** The reason a dead copy is compressed, in the words its zip reference uses (SA-129 DL-01). */
const DEAD_COPY_TOOLTIP: Record<'superseded' | 'stale', string> = {
  superseded: 'superseded by a later read',
  stale: 'stale, edited since'
}

function judgeOf(input: ZipStatusPresentationInput): string {
  const name = typeof input.judgeName === 'string' ? input.judgeName.trim() : ''
  return name || UNKNOWN_JUDGE_NAME
}

function buildUnzippedTooltip(
  actor: ZipStatusActor,
  duration: ZipStatusDuration,
  remainingMessages: number | null,
  holdLabel: string | null,
  judge: string
) {
  // SA-129 P2 (D1): a hold says who holds it, in one vocabulary for the chat and the Zip Manager.
  if (holdLabel && (actor === 'user' || actor === 'agent')) return holdLabel

  if (duration === 'permanent') {
    if (actor === 'agent') return 'Held by the agent'
    if (actor === 'user') return 'Held by you'
    return 'Held'
  }

  // BL-1485: a Judge Juice open is a hold for a number of messages, said like the user's.
  if (duration === 'countdown' && remainingMessages !== null) {
    const count = pluralizeMessage(remainingMessages)
    if (actor === 'agent') return `Held by the agent (${count} left)`
    if (actor === 'inferred') return `Held by ${judge} (${count} left)`
    if (actor === 'user') return `Held by you (${count} left)`
    return `Expanded: compresses in ${count}`
  }

  if (actor === 'agent') return 'Held by the agent'
  if (actor === 'inferred') return `Held by ${judge}`
  if (actor === 'user') return 'Held by you'
  return 'Expanded by the automatic rules (buffer and threshold)'
}

export function buildZipStatusPresentation(
  input: ZipStatusPresentationInput
): ZipStatusPresentation {
  if (input.sizeGuard === 'too_large') {
    const tooltip = describeTooLargeToolResult(input.tokens ?? 0)
    return {
      state: 'zipped',
      actor: null,
      duration: 'none',
      remainingMessages: null,
      tone: 'zipped',
      tooltip,
      ariaLabel: tooltip
    }
  }
  if (input.isZipped) {
    const deadCopy = input.deadCopyReason ? DEAD_COPY_TOOLTIP[input.deadCopyReason] : null
    // BL-1485: one vocabulary. The state is "Compressed"; who zipped it, when someone did, follows.
    const tooltip = deadCopy
      ? input.holdLabel
        ? `Compressed: ${deadCopy}. ${input.holdLabel}; the hold moves to the next whole read`
        : `Compressed: ${deadCopy}`
      : input.manualZip && input.inferredControlled && !input.agentControlled
      ? `Compressed by ${judgeOf(input)}: the agent seemed done with it`
      : input.agentControlled
      ? 'Compressed: the agent zipped it'
      : input.manualZip
      ? 'Compressed: you zipped it'
      : input.autoZip
        ? 'Compressed at once (Auto)'
        : 'Compressed'

    return {
      state: 'zipped',
      actor: null,
      duration: 'none',
      remainingMessages: null,
      tone: 'zipped',
      tooltip,
      ariaLabel: tooltip
    }
  }

  const actor = resolveActor(input)
  const remainingMessages = normalizeRemainingMessages(input.remainingMessages)
  const duration: ZipStatusDuration = input.isPermanent
    ? 'permanent'
    : remainingMessages !== null
      ? 'countdown'
      : 'none'
  const tooltip = buildUnzippedTooltip(actor, duration, remainingMessages, input.holdLabel ?? null, judgeOf(input))

  return {
    state: 'unzipped',
    actor,
    duration,
    remainingMessages,
    tone: input.aboutToZip || remainingMessages === 1 ? 'warning' : 'unzipped',
    tooltip,
    ariaLabel: tooltip
  }
}
