import { describe, expect, it } from 'vitest'
import { LOCAL_AI_SERVER_DEFINITIONS } from '../localAiServers'
import { getLocalAiIconRef } from '../localAiIcons'
import { BRAND_ICON_MAP } from '../brand-icons.generated'

/**
 * SA-124 P7. Every local AI program now has a real brand mark. The generic
 * `server` glyph is still a legal fallback for a program added later, but a
 * program that USED to have a mark and silently lost one — a renamed asset, a
 * typo in a slug — should fail here rather than quietly downgrade in Settings.
 */
describe('SA-124 local AI program icons', () => {
  it('gives every program a brand mark, not the generic fallback', () => {
    for (const definition of LOCAL_AI_SERVER_DEFINITIONS) {
      const ref = getLocalAiIconRef(definition.id)
      expect(ref.kind, `${definition.id} should have a brand mark`).toBe('brand')
    }
  })

  it('points every brand slug at an asset that actually exists', () => {
    for (const definition of LOCAL_AI_SERVER_DEFINITIONS) {
      const ref = getLocalAiIconRef(definition.id)
      if (ref.kind !== 'brand') continue
      expect(
        BRAND_ICON_MAP[ref.slug as keyof typeof BRAND_ICON_MAP],
        `${definition.id} → "${ref.slug}" is missing from the generated brand icon map`
      ).toBeTruthy()
    }
  })
})
