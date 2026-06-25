import type {
  GoonBasePosture,
  GoonPosture,
  GoonPostureDefinition,
  GoonPostureMap,
  GoonsSettings
} from '$lib/types/goons'

export const BUILTIN_GOON_POSTURES: GoonPostureMap = {
  stand: {
    id: 'stand',
    name: 'Standing',
    basePosture: 'stand',
    builtIn: true
  },
  sit: {
    id: 'sit',
    name: 'Sitting',
    basePosture: 'sit',
    builtIn: true
  },
  lay: {
    id: 'lay',
    name: 'Lying',
    basePosture: 'lay',
    builtIn: true
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function normalizeWhitespace(value: string) {
  return value.trim().replace(/\s+/g, ' ')
}

function slugify(value: string) {
  return (
    normalizeWhitespace(value)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '') || 'posture'
  )
}

export function isBuiltInPosture(posture?: string | null): posture is GoonBasePosture {
  return posture === 'stand' || posture === 'sit' || posture === 'lay'
}

export function buildCustomPostureId(name: string, takenIds: Set<string>) {
  const base = slugify(name)
  if (!takenIds.has(base)) {
    takenIds.add(base)
    return base
  }

  let index = 2
  let candidate = `${base}_${index}`
  while (takenIds.has(candidate)) {
    index += 1
    candidate = `${base}_${index}`
  }
  takenIds.add(candidate)
  return candidate
}

export function normalizeCustomPostureMap(input?: GoonPostureMap | null): GoonPostureMap {
  const next: GoonPostureMap = {}
  for (const [rawId, rawDefinition] of Object.entries(input ?? {})) {
    if (!rawDefinition) continue
    const id = normalizeWhitespace(rawDefinition.id || rawId)
    if (!id || isBuiltInPosture(id)) continue
    const name = normalizeWhitespace(rawDefinition.name || id)
    const basePosture = isBuiltInPosture(rawDefinition.basePosture)
      ? rawDefinition.basePosture
      : 'stand'
    next[id] = {
      id,
      name,
      description: normalizeWhitespace(rawDefinition.description || '') || undefined,
      basePosture
    }
  }
  return next
}

export function resolveStagePostures(goonsSettings?: GoonsSettings | null): GoonPostureMap {
  return {
    ...clone(BUILTIN_GOON_POSTURES),
    ...normalizeCustomPostureMap(goonsSettings?.kitchen?.postures)
  }
}

export function listStagePostures(goonsSettings?: GoonsSettings | null): GoonPostureDefinition[] {
  const postures = resolveStagePostures(goonsSettings)
  const builtIns = Object.values(postures).filter((posture) => posture.builtIn)
  const custom = Object.values(postures)
    .filter((posture) => !posture.builtIn)
    .sort((left, right) => left.name.localeCompare(right.name))
  return [...builtIns, ...custom]
}

export function resolvePostureDefinition(
  posture: GoonPosture | '' | null | undefined,
  goonsSettings?: GoonsSettings | null,
  postureMap?: GoonPostureMap | null
): GoonPostureDefinition | null {
  if (!posture) return null
  const map = postureMap ?? resolveStagePostures(goonsSettings)
  return map[posture] ?? null
}

export function resolveBasePosture(
  posture: GoonPosture | '' | null | undefined,
  goonsSettings?: GoonsSettings | null,
  postureMap?: GoonPostureMap | null
): GoonBasePosture {
  if (!posture) return 'stand'
  if (isBuiltInPosture(posture)) return posture

  const definition = resolvePostureDefinition(posture, goonsSettings, postureMap)
  if (definition && isBuiltInPosture(definition.basePosture)) {
    return definition.basePosture
  }

  const lowered = posture.toLowerCase()
  if (/(^|[_\s-])sit|seat|seated/.test(lowered)) return 'sit'
  if (/(^|[_\s-])lay|lie|lying/.test(lowered)) return 'lay'
  return 'stand'
}

export function getPostureLabel(
  posture: GoonPosture | '' | null | undefined,
  goonsSettings?: GoonsSettings | null,
  postureMap?: GoonPostureMap | null
) {
  if (!posture) return 'Standing'
  const definition = resolvePostureDefinition(posture, goonsSettings, postureMap)
  if (definition?.name) return definition.name
  if (posture === 'stand') return 'Standing'
  if (posture === 'sit') return 'Sitting'
  if (posture === 'lay') return 'Lying'
  return posture
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (match) => match.toUpperCase())
}

export function mergeImportedCustomPostures(
  goonsSettings: GoonsSettings | null | undefined,
  importedPostures: GoonPostureDefinition[] = []
) {
  const mergedCustom = normalizeCustomPostureMap(goonsSettings?.kitchen?.postures)
  const resolvedExisting = resolveStagePostures(goonsSettings)
  const takenIds = new Set(Object.keys(resolvedExisting))
  const existingNames = new Map<string, GoonPosture>()

  for (const posture of Object.values(resolvedExisting)) {
    existingNames.set(normalizeWhitespace(posture.name).toLowerCase(), posture.id)
  }

  const idMap: Record<string, GoonPosture> = {}

  for (const rawPosture of importedPostures) {
    if (!rawPosture) continue
    const sourceId = normalizeWhitespace(rawPosture.id || '')
    const name = normalizeWhitespace(rawPosture.name || rawPosture.id || 'Custom Posture')
    const description = normalizeWhitespace(rawPosture.description || '') || undefined
    const basePosture = isBuiltInPosture(rawPosture.basePosture) ? rawPosture.basePosture : 'stand'

    if (isBuiltInPosture(sourceId)) {
      idMap[sourceId] = sourceId
      continue
    }

    const existingById = sourceId ? mergedCustom[sourceId] : undefined
    if (
      existingById &&
      existingById.name === name &&
      existingById.basePosture === basePosture &&
      existingById.description === description
    ) {
      idMap[sourceId] = sourceId
      continue
    }

    const existingByNameId = existingNames.get(name.toLowerCase())
    const existingByName = existingByNameId
      ? mergedCustom[existingByNameId] ?? resolvedExisting[existingByNameId]
      : null
    if (
      existingByName &&
      existingByName.name === name &&
      existingByName.basePosture === basePosture &&
      existingByName.description === description
    ) {
      if (sourceId) idMap[sourceId] = existingByName.id
      continue
    }

    const nextId =
      sourceId && !takenIds.has(sourceId)
        ? (() => {
            takenIds.add(sourceId)
            return sourceId
          })()
        : buildCustomPostureId(name, takenIds)

    mergedCustom[nextId] = {
      id: nextId,
      name,
      description,
      basePosture
    }
    existingNames.set(name.toLowerCase(), nextId)
    if (sourceId) {
      idMap[sourceId] = nextId
    }
  }

  return {
    postures: mergedCustom,
    idMap
  }
}
