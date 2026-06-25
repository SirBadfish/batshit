import { describe, expect, it } from 'vitest'

import { BRAND_ICON_MAP } from '$lib/data/brand-icons.generated'
import {
  BATSHIT_ICON_CATALOG,
  BRAND_ICON_CATALOG,
  DEFAULT_AGENT_ICON_REF,
  DEFAULT_ARTIFACT_ICON_REF,
  DEFAULT_CLI_TOOL_ICON_REF,
  DEFAULT_GROUP_ICON_REF,
  DEFAULT_PROMPT_ICON_REF,
  DEFAULT_PROJECT_ICON_REF,
  DEFAULT_SKILL_ICON_REF,
  DEFAULT_SUBAGENT_ICON_REF,
  DEFAULT_VOICE_ENGINE_ICON_REF,
  GENERAL_ICON_CATALOG,
  isCatalogIconRef,
  searchIconCatalog
} from './iconCatalog'

describe('brand icon catalog', () => {
  it('exposes every generated brand icon in the picker catalog', () => {
    const catalogSlugs = new Set(
      BRAND_ICON_CATALOG.map((entry) => (entry.ref.kind === 'brand' ? entry.ref.slug : null)).filter(Boolean)
    )

    expect(catalogSlugs.size).toBe(BRAND_ICON_CATALOG.length)
    for (const slug of Object.keys(BRAND_ICON_MAP)) {
      expect(catalogSlugs.has(slug)).toBe(true)
    }
  })

  it('keeps brand variants searchable with readable labels', () => {
    expect(searchIconCatalog('hugging face', BRAND_ICON_CATALOG).some((entry) => entry.id === 'huggingface-color')).toBe(
      true
    )
    expect(searchIconCatalog('llama.cpp', BRAND_ICON_CATALOG).some((entry) => entry.id === 'llamacpp-color')).toBe(true)
    expect(searchIconCatalog('anthropic mono', BRAND_ICON_CATALOG).some((entry) => entry.id === 'anthropic-mono')).toBe(
      true
    )
  })
})

describe('Batshit icon catalog', () => {
  it('exposes the custom system icons needed for core product concepts', () => {
    const ids = new Set(BATSHIT_ICON_CATALOG.map((entry) => entry.id))

    expect(Array.from(ids)).toEqual(
      expect.arrayContaining([
        'agents',
        'subagents',
        'groups',
        'models',
        'artifacts',
        'skills',
        'zip',
        'unzip',
        'zones',
        'zone-headerbar',
        'zone-trigger-menu',
        'zone-top-panel',
        'zone-side-panel',
        'fabric',
        'goons',
        'voice-engine-manager',
        'local-ai'
      ])
    )
  })

  it('uses Batshit icons for Batshit-owned default identities', () => {
    expect(DEFAULT_AGENT_ICON_REF).toEqual({ kind: 'batshit', id: 'agents' })
    expect(DEFAULT_SUBAGENT_ICON_REF).toEqual({ kind: 'batshit', id: 'subagents' })
    expect(DEFAULT_GROUP_ICON_REF).toEqual({ kind: 'batshit', id: 'groups' })
    expect(DEFAULT_ARTIFACT_ICON_REF).toEqual({ kind: 'batshit', id: 'artifacts' })
    expect(DEFAULT_SKILL_ICON_REF).toEqual({ kind: 'batshit', id: 'skills' })
    expect(DEFAULT_PROMPT_ICON_REF).toEqual({ kind: 'batshit', id: 'prompts' })
    expect(DEFAULT_CLI_TOOL_ICON_REF).toEqual({ kind: 'batshit', id: 'cli-tools' })
    expect(DEFAULT_PROJECT_ICON_REF).toEqual({ kind: 'batshit', id: 'projects' })
    expect(DEFAULT_VOICE_ENGINE_ICON_REF).toEqual({ kind: 'batshit', id: 'voice-engine-manager' })
  })

  it('keeps Batshit-specific icon search language discoverable', () => {
    expect(searchIconCatalog('gadget', BATSHIT_ICON_CATALOG).some((entry) => entry.id === 'artifacts')).toBe(true)
    expect(searchIconCatalog('unzipped', BATSHIT_ICON_CATALOG).some((entry) => entry.id === 'unzip')).toBe(true)
    expect(searchIconCatalog('top panel', BATSHIT_ICON_CATALOG).some((entry) => entry.id === 'zone-top-panel')).toBe(
      true
    )
  })

  it('does not expose duplicate or Lucide-owned Batshit icon entries', () => {
    const ids = new Set(BATSHIT_ICON_CATALOG.map((entry) => entry.id))

    expect(ids.has('artifact')).toBe(false)
    expect(ids.has('goon')).toBe(false)
    expect(ids.has('tools')).toBe(false)
    expect(ids.has('tool-grid')).toBe(false)
    expect(ids.has('themes')).toBe(false)
    expect(ids.has('clips')).toBe(false)
    expect(ids.has('clip')).toBe(false)
    expect(ids.has('voice')).toBe(false)
    expect(GENERAL_ICON_CATALOG.some((entry) => entry.id === 'layout-grid')).toBe(true)
  })

  it('checks whether structured icon refs point at available picker entries', () => {
    expect(isCatalogIconRef({ kind: 'lucide', id: 'image' })).toBe(true)
    expect(isCatalogIconRef({ kind: 'brand', slug: 'huggingface-color' })).toBe(true)
    expect(isCatalogIconRef({ kind: 'batshit', id: 'artifacts' })).toBe(true)

    expect(isCatalogIconRef({ kind: 'lucide', id: 'smile' })).toBe(false)
    expect(isCatalogIconRef({ kind: 'brand', slug: 'made-up-runtime-color' })).toBe(false)
  })
})
