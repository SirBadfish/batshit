export const ARTIFACT_ZONES = ['header', 'panel', 'trigger'] as const

export type ArtifactZone = (typeof ARTIFACT_ZONES)[number]
export type ArtifactZoneProfile = 'single-zone' | 'multi-zone'
export type ArtifactZoneFitStatus = 'fit' | 'warn' | 'blocked'

export interface ArtifactZoneFitEntry {
  status: ArtifactZoneFitStatus
  note?: string
}

export interface ArtifactZoneCompatibility {
  profile: ArtifactZoneProfile
  primaryZone: ArtifactZone | null
  compatibleZones: ArtifactZone[]
  fitReport: Partial<Record<ArtifactZone, ArtifactZoneFitEntry>>
}

export interface ArtifactZonePublishEvaluation {
  ok: boolean
  zone: ArtifactZone | null
  reason: string | null
  recommendedZones: ArtifactZone[]
}

function toTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export function normalizeArtifactZone(value: unknown): ArtifactZone | null {
  const zone = toTrimmedString(value).toLowerCase()
  if (!zone) return null
  return ARTIFACT_ZONES.includes(zone as ArtifactZone) ? (zone as ArtifactZone) : null
}

function normalizeZoneList(value: unknown): ArtifactZone[] {
  if (!Array.isArray(value)) return []
  const zones = value
    .map((entry) => normalizeArtifactZone(entry))
    .filter((entry): entry is ArtifactZone => Boolean(entry))
  return Array.from(new Set(zones))
}

function normalizeFitEntry(value: unknown): ArtifactZoneFitEntry | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const rawStatus = toTrimmedString((value as Record<string, unknown>).status).toLowerCase()
  const status: ArtifactZoneFitStatus =
    rawStatus === 'warn' ? 'warn' : rawStatus === 'blocked' ? 'blocked' : 'fit'
  const note = toTrimmedString((value as Record<string, unknown>).note)
  return {
    status,
    ...(note ? { note } : {})
  }
}

function buildDefaultFitReport(zones: ArtifactZone[]): Partial<Record<ArtifactZone, ArtifactZoneFitEntry>> {
  return ARTIFACT_ZONES.reduce((report, zone) => {
    if (zones.includes(zone)) {
      report[zone] = { status: 'fit' }
    } else {
      report[zone] = {
        status: 'blocked',
        note: 'Not included in compatible zones.'
      }
    }
    return report
  }, {} as Partial<Record<ArtifactZone, ArtifactZoneFitEntry>>)
}

export function normalizeArtifactZoneCompatibility(
  input: unknown,
  fallbackZone?: unknown
): ArtifactZoneCompatibility {
  const source =
    input && typeof input === 'object' && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {}

  const profileValue =
    toTrimmedString(source.profile).toLowerCase() ||
    toTrimmedString(source.zone_profile).toLowerCase()
  const profile: ArtifactZoneProfile =
    profileValue === 'single-zone' || profileValue === 'single_zone' || profileValue === 'single'
      ? 'single-zone'
      : 'multi-zone'

  const inputPrimary =
    normalizeArtifactZone(source.primaryZone) ||
    normalizeArtifactZone(source.primary_zone) ||
    normalizeArtifactZone(fallbackZone)

  const compatibilityCandidates = [source.compatibleZones, source.compatible_zones, source.zones]
  let explicitCompatible: ArtifactZone[] = []
  for (const candidate of compatibilityCandidates) {
    const normalized = normalizeZoneList(candidate)
    if (normalized.length > 0) {
      explicitCompatible = normalized
      break
    }
  }
  let compatibleZones = explicitCompatible.length > 0 ? explicitCompatible : [...ARTIFACT_ZONES]
  if (inputPrimary && !compatibleZones.includes(inputPrimary)) {
    compatibleZones = [inputPrimary, ...compatibleZones]
  }

  const fitSource =
    source.fitReport && typeof source.fitReport === 'object'
      ? (source.fitReport as Record<string, unknown>)
      : source.fit_report && typeof source.fit_report === 'object'
        ? (source.fit_report as Record<string, unknown>)
        : {}

  const fitReport = buildDefaultFitReport(compatibleZones)
  for (const zone of ARTIFACT_ZONES) {
    const parsed = normalizeFitEntry(fitSource[zone])
    if (parsed) fitReport[zone] = parsed
  }

  if (profile === 'single-zone') {
    const primaryZone = inputPrimary || compatibleZones[0] || ARTIFACT_ZONES[0]
    const strictFit: Partial<Record<ArtifactZone, ArtifactZoneFitEntry>> = {}
    for (const zone of ARTIFACT_ZONES) {
      strictFit[zone] =
        zone === primaryZone
          ? { status: 'fit' }
          : {
              status: 'blocked',
              note: `Single-zone artifacts can only publish to "${primaryZone}".`
            }
    }
    return {
      profile,
      primaryZone,
      compatibleZones: [primaryZone],
      fitReport: strictFit
    }
  }

  return {
    profile,
    primaryZone: inputPrimary,
    compatibleZones,
    fitReport
  }
}

export function evaluateArtifactZonePublish(
  compatibilityInput: unknown,
  zoneInput: unknown
): ArtifactZonePublishEvaluation {
  const zone = normalizeArtifactZone(zoneInput)
  const compatibility = normalizeArtifactZoneCompatibility(compatibilityInput, zone)
  const recommendedZones = compatibility.compatibleZones.filter((candidate) => {
    const fit = compatibility.fitReport[candidate]
    return fit?.status !== 'blocked'
  })

  if (!zone) {
    return {
      ok: false,
      zone: null,
      reason: 'Publish requires a zone selection.',
      recommendedZones
    }
  }

  const fit = compatibility.fitReport[zone]
  if (!compatibility.compatibleZones.includes(zone)) {
    return {
      ok: false,
      zone,
      reason: `This artifact is not compatible with the "${zone}" zone.`,
      recommendedZones
    }
  }

  if (fit?.status === 'blocked') {
    return {
      ok: false,
      zone,
      reason: fit.note || `The "${zone}" zone is blocked by this artifact's compatibility profile.`,
      recommendedZones
    }
  }

  if (compatibility.profile === 'single-zone' && compatibility.primaryZone && zone !== compatibility.primaryZone) {
    return {
      ok: false,
      zone,
      reason: `Single-zone artifacts can only publish to "${compatibility.primaryZone}".`,
      recommendedZones
    }
  }

  return {
    ok: true,
    zone,
    reason: null,
    recommendedZones
  }
}

export function buildArtifactZonePublishError(evaluation: ArtifactZonePublishEvaluation): string {
  const base = evaluation.reason || 'Publish is blocked by zone compatibility.'
  if (!evaluation.recommendedZones.length) {
    return `${base} Update this artifact's compatibility declaration and try again.`
  }
  return `${base} Choose one of: ${evaluation.recommendedZones.join(', ')}.`
}
