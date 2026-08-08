import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  createLipArtworkPresenceState,
  lipArtworkHexToRgb,
  lipArtworkRgbToHex,
  parseLipArtworkDefinition,
  parseLipArtworkPresenceState,
  parseLipArtworkState,
  reconcileLipArtworkState
} from './lipArtwork'

function definition() {
  return parseLipArtworkDefinition(
    JSON.parse(
      readFileSync(
        resolve(process.cwd(), 'static/goons/lip-artwork/v2/lip-artwork-v2.json'),
        'utf8'
      )
    )
  )
}

function state() {
  const contract = definition()
  return {
    schemaVersion: 'lip-artwork-state/v2',
    definitionSha256: contract.definitionSha256,
    artwork: {
      url: '/uploads/goon_facial_artwork/lips.png',
      filename: 'lips.png',
      size: 123,
      mimeType: 'image/png',
      sha256: '1'.repeat(64),
      definitionSha256: contract.definitionSha256,
      template: {
        id: contract.template.id,
        version: contract.template.version,
        guideSha256: contract.template.guide.sha256,
        maskSha256: contract.template.safePaintMask.sha256,
        baseLipReferenceMaskSha256: contract.template.baseLipReferenceMask.sha256
      },
      provenance: {
        sourceKind: 'user-authored',
        author: 'Fixture Artist',
        license: 'User-owned',
        rightsConfirmed: true
      }
    },
    tint: [0.8, 0.4, 0.5],
    opacity: 0.75
  }
}

describe('lip-artwork/v2', () => {
  it('parses the canonical template and independent artwork state', () => {
    const contract = definition()
    expect(contract.definitionSha256).toBe(
      '88f32b6bf1992547e72e838660ca1484e645bab7f2915d28fad45098c11d708c'
    )
    expect(contract.runtimeBinding.node).toBe('bs_f1_lip_artwork_overlay_v1')
    expect(contract.template).toMatchObject({
      id: 'batshit-base-f-lips-v5',
      version: '5.0.0'
    })
    expect(contract.template.dimensions).toEqual([2048, 2048])
    expect(parseLipArtworkState(contract, state())).toMatchObject({
      tint: [0.8, 0.4, 0.5],
      opacity: 0.75
    })
    expect(lipArtworkRgbToHex([1, 0.5, 0])).toBe('#ff8000')
    expect(lipArtworkHexToRgb('#804020')).toEqual([0.501961, 0.25098, 0.12549])
    expect(lipArtworkHexToRgb('#ebebeb')).toEqual([0.921569, 0.921569, 0.921569])
    expect(lipArtworkRgbToHex(lipArtworkHexToRgb('#ebebeb')!)).toBe('#ebebeb')
  })

  it('rejects stale package proof, unsafe fields, and invalid opacity', () => {
    const contract = definition()
    const value = state() as any
    value.definitionSha256 = 'a'.repeat(64)
    expect(reconcileLipArtworkState(contract, value)).toMatchObject({
      state: null,
      incompatible: true
    })
    value.definitionSha256 = contract.definitionSha256
    value.artwork.template.maskSha256 = 'b'.repeat(64)
    expect(() => parseLipArtworkState(contract, value)).toThrow(/template proof/)
    value.artwork.template.maskSha256 = contract.template.safePaintMask.sha256
    value.opacity = 1.1
    expect(() => parseLipArtworkState(contract, value)).toThrow(/inside \[0, 1\]/)
    value.opacity = 1
    value.transform = {}
    expect(() => parseLipArtworkState(contract, value)).toThrow(/unsupported fields/)
  })

  it('normalizes RGB channels before Recipe state is hashed or persisted', () => {
    const contract = definition()
    const value = state() as any
    value.tint = [
      0.9215686274509804,
      0.9215686274509803,
      0.3764705882352941
    ]
    expect(parseLipArtworkState(contract, value).tint).toEqual([
      0.921569,
      0.921569,
      0.376471
    ])
  })

  it('binds an explicit off state to this package without changing package defaults', () => {
    const contract = definition()
    const presence = createLipArtworkPresenceState(contract, false)
    expect(parseLipArtworkPresenceState(contract, presence)).toEqual({
      schemaVersion: 'lip-artwork-presence-state/v1',
      definitionSha256: contract.definitionSha256,
      enabled: false
    })
    expect(() =>
      parseLipArtworkPresenceState(contract, { ...presence, enabled: 'no' })
    ).toThrow(/must be boolean/)
  })
})
