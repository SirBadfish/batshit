export type ArtifactOrderItem = Record<string, any> & {
  id: string
  isDndShadowItem?: boolean
}

export function getArtifactHydrationKey(artifact: Record<string, any> | null | undefined) {
  return JSON.stringify([
    artifact?.id ?? '',
    artifact?.name ?? '',
    artifact?.icon_ref ?? null,
    artifact?.icon ?? null,
    artifact?.mode ?? null,
    artifact?.zone ?? null,
    artifact?.ai_enabled ?? null,
    artifact?.updated_at ?? artifact?.updatedAt ?? null,
    artifact?.version ?? null
  ])
}

export function hydrateArtifactOrder<T extends ArtifactOrderItem>(
  artifacts: T[],
  currentItems: T[],
  preferredIds?: string[]
): T[] {
  const byId = new Map(artifacts.map((artifact) => [artifact.id, artifact]))
  const baseIds = preferredIds ?? currentItems.map((item) => item.id)
  const seen = new Set<string>()
  const next: T[] = []

  for (const id of baseIds) {
    if (seen.has(id)) continue
    const found = byId.get(id)
    if (found) {
      seen.add(id)
      next.push(found)
    }
  }

  for (const artifact of artifacts) {
    if (!seen.has(artifact.id)) {
      seen.add(artifact.id)
      next.push(artifact)
    }
  }

  return next
}

export function artifactOrderChanged<T extends ArtifactOrderItem>(currentItems: T[], nextItems: T[]) {
  const currentIds = currentItems.map((item) => item.id)
  const nextIds = nextItems.map((item) => item.id)
  if (currentIds.length !== nextIds.length) return true
  if (currentIds.some((id, index) => id !== nextIds[index])) return true

  const currentKeys = currentItems.map(getArtifactHydrationKey)
  const nextKeys = nextItems.map(getArtifactHydrationKey)
  return currentKeys.some((key, index) => key !== nextKeys[index])
}

export function realArtifactIds<T extends ArtifactOrderItem>(items: T[]) {
  return items
    .filter((item) => !item?.isDndShadowItem)
    .map((item) => item.id)
}

export function mergeVisibleDndItems<T extends ArtifactOrderItem>(
  currentItems: T[],
  visibleItems: T[]
): T[] {
  const visibleIds = new Set(visibleItems.map((item) => item.id))
  const hiddenTail = currentItems.filter(
    (item) => !item?.isDndShadowItem && !visibleIds.has(item.id)
  )
  return [...visibleItems, ...hiddenTail]
}
