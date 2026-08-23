import type { GoonRecord } from '$lib/types/goons'

export type GoonSettingsPreviewMode = 'editor' | 'library'
export type GoonSettingsPreviewLoadPriority = 'automatic' | 'strict'

export function shouldAdmitGoonSettingsPreviewLoad(options: {
  activePriority: GoonSettingsPreviewLoadPriority | null
  requestedPriority: GoonSettingsPreviewLoadPriority
}): boolean {
  return !(
    options.activePriority === 'strict' &&
    options.requestedPriority === 'automatic'
  )
}

export function resolveGoonSettingsPreviewTarget(options: {
  explicitTarget?: GoonRecord | null
  mode: GoonSettingsPreviewMode
  editorGoon: GoonRecord | null
  recipeSourceGoon: GoonRecord | null
  recipePreviewGoon?: GoonRecord | null
}): GoonRecord | null {
  if (options.explicitTarget) return options.explicitTarget
  if (options.mode === 'library') return options.editorGoon
  return options.recipePreviewGoon ?? options.recipeSourceGoon
}
