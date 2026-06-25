import type { GoonRawMorphTarget } from '$lib/types/goons'

export type CustomMorphDefinition = {
  id: string
  morphTargets: string[]
}

function normalizeMorphTargetNames(morphTargets: string[]) {
  return [...new Set(morphTargets.map((target) => target.trim()).filter(Boolean))]
}

export function getCustomMorphValue(
  rawMorphTargets: GoonRawMorphTarget[] | undefined,
  morphTargets: string[]
) {
  const targetNames = new Set(normalizeMorphTargetNames(morphTargets))
  if (targetNames.size === 0) return 0
  return Math.max(
    0,
    ...(rawMorphTargets ?? [])
      .filter((entry) => targetNames.has(entry.target))
      .map((entry) => entry.value)
  )
}

export function applyCustomMorphValue(
  rawMorphTargets: GoonRawMorphTarget[],
  morphTargets: string[],
  value: number
) {
  const targetNames = normalizeMorphTargetNames(morphTargets)
  if (targetNames.length === 0) return rawMorphTargets

  const next = rawMorphTargets.filter((entry) => !targetNames.includes(entry.target))
  if (value === 0) {
    return next.sort((a, b) => a.target.localeCompare(b.target))
  }

  for (const targetName of targetNames) {
    next.push({ target: targetName, value })
  }

  return next.sort((a, b) => a.target.localeCompare(b.target))
}
