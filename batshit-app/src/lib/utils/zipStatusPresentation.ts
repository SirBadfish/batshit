/**
 * Who holds a zip open. `inferred` (SA-120 P5) is Batshit acting on a Jev Juice judgment: the
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
  /** Jev Juice opened it, or zipped it after a reply (`source: 'inferred'`). */
  inferredControlled?: boolean
  aboutToZip?: boolean
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

function buildUnzippedTooltip(
  actor: ZipStatusActor,
  duration: ZipStatusDuration,
  remainingMessages: number | null
) {
  if (duration === 'permanent') {
    if (actor === 'agent') return 'Agent kept this unzipped always'
    if (actor === 'user') return 'You kept this unzipped always'
    return 'Unzipped always'
  }

  if (duration === 'countdown' && remainingMessages !== null) {
    const count = pluralizeMessage(remainingMessages)
    if (actor === 'agent') return `Agent kept this unzipped for ${count}`
    if (actor === 'inferred') return `Jev unzipped this for ${count}`
    if (actor === 'user') return `You kept this unzipped for ${count}`
    return `Auto-managed: zips in ${count}`
  }

  if (actor === 'agent') return 'Agent kept this unzipped'
  if (actor === 'inferred') return 'Jev unzipped this'
  if (actor === 'user') return 'You kept this unzipped'
  return 'Auto-managed: currently unzipped by buffer and threshold rules'
}

export function buildZipStatusPresentation(
  input: ZipStatusPresentationInput
): ZipStatusPresentation {
  if (input.isZipped) {
    const agentMarker = input.agentControlled ? ' after agent zip control' : ''
    const tooltip = input.manualZip && input.inferredControlled && !input.agentControlled
      ? 'Zipped by Jev: the agent seemed done with it'
      : input.manualZip
      ? `Zipped manually${agentMarker}`
      : input.autoZip
        ? `Auto-zipped${agentMarker}`
        : `Zipped${agentMarker}`

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
  const tooltip = buildUnzippedTooltip(actor, duration, remainingMessages)

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

