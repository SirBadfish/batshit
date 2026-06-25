export type ZipStatusActor = 'auto' | 'user' | 'agent' | null
export type ZipStatusDuration = 'countdown' | 'permanent' | 'none'
export type ZipStatusTone = 'zipped' | 'unzipped' | 'warning'

export interface ZipStatusPresentationInput {
  isZipped?: boolean
  isUnzipped?: boolean
  expandedReason?: 'buffer' | 'user' | 'agent'
  isPermanent?: boolean
  remainingMessages?: number | null
  manualZip?: boolean
  autoZip?: boolean
  agentControlled?: boolean
  aboutToZip?: boolean
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
  if (input.expandedReason === 'user') return 'user'
  if (input.isUnzipped && input.agentControlled) return 'agent'
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
    if (actor === 'user') return `You kept this unzipped for ${count}`
    return `Auto-managed: zips in ${count}`
  }

  if (actor === 'agent') return 'Agent kept this unzipped'
  if (actor === 'user') return 'You kept this unzipped'
  return 'Auto-managed: currently unzipped by buffer and threshold rules'
}

export function buildZipStatusPresentation(
  input: ZipStatusPresentationInput
): ZipStatusPresentation {
  if (input.isZipped) {
    const agentMarker = input.agentControlled ? ' after agent zip control' : ''
    const tooltip = input.manualZip
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

