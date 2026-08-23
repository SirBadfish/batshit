import { describe, expect, it } from 'vitest'

import type { GoonRecord } from '$lib/types/goons'
import {
  resolveGoonSettingsPreviewTarget,
  shouldAdmitGoonSettingsPreviewLoad
} from './recipeEditorPreviewTarget'

function goon(id: string, modelUrl: string): GoonRecord {
  return {
    id,
    user_id: 'user',
    name: id,
    kind: 'custom',
    files: { animations: [] },
    customAvatar: {
      model: { url: modelUrl, filename: modelUrl.split('/').pop()! }
    },
    created_at: '2026-07-19T00:00:00.000Z',
    updated_at: '2026-07-19T00:00:00.000Z'
  }
}

describe('Recipe editor preview target selection', () => {
  const mountedLive = goon('recipe-goon', '/live/avatar.glb')
  const recipeSource = goon('recipe-goon', '/source/avatar.glb')
  const recipeComparison = goon('recipe-goon', '/comparison/avatar.glb')
  const explicit = goon('other-goon', '/other/avatar.glb')

  it('keeps ordinary editor actions on Recipe Source instead of mounted Live refs', () => {
    expect(resolveGoonSettingsPreviewTarget({
      mode: 'editor',
      editorGoon: mountedLive,
      recipeSourceGoon: recipeSource
    })).toBe(recipeSource)
  })

  it('keeps an active Recipe comparison target selected during editor actions', () => {
    expect(resolveGoonSettingsPreviewTarget({
      mode: 'editor',
      editorGoon: mountedLive,
      recipeSourceGoon: recipeSource,
      recipePreviewGoon: recipeComparison
    })).toBe(recipeComparison)
  })

  it('honors explicit and library targets without Recipe projection', () => {
    expect(resolveGoonSettingsPreviewTarget({
      explicitTarget: explicit,
      mode: 'editor',
      editorGoon: mountedLive,
      recipeSourceGoon: recipeSource
    })).toBe(explicit)
    expect(resolveGoonSettingsPreviewTarget({
      mode: 'library',
      editorGoon: mountedLive,
      recipeSourceGoon: recipeSource
    })).toBe(mountedLive)
  })

  it('does not let an automatic editor refresh supersede a strict Recipe comparison load', () => {
    expect(shouldAdmitGoonSettingsPreviewLoad({
      activePriority: 'strict',
      requestedPriority: 'automatic'
    })).toBe(false)
    expect(shouldAdmitGoonSettingsPreviewLoad({
      activePriority: 'automatic',
      requestedPriority: 'strict'
    })).toBe(true)
    expect(shouldAdmitGoonSettingsPreviewLoad({
      activePriority: 'strict',
      requestedPriority: 'strict'
    })).toBe(true)
  })
})
