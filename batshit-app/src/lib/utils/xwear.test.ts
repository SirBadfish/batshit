import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  buildStoredXWear,
  getPrimaryXWearMaterialName,
  getXWearMaterials,
  parseXWearFile,
  resolveXWearLayersForMaterial,
  xwearMaterialTargetsMatch
} from './xwear'

// The real-archive fixture lives under a gitignored local fixture path because
// licensed clothing assets cannot be committed. The parse test runs wherever the
// local fixture exists and reports as skipped elsewhere.
const XWEAR_FIXTURE_PATH = resolve(
  process.cwd(),
  process.env.BATSHIT_XWEAR_FIXTURE_PATH || '../_local/fixtures/xwear/red-dress.xwear'
)

describe('xwear utils', () => {
  it.runIf(existsSync(XWEAR_FIXTURE_PATH))('parses every material from an XWear archive', async () => {
    const bytes = readFileSync(XWEAR_FIXTURE_PATH)
    const file = {
      name: 'red-dress.xwear',
      async arrayBuffer() {
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
      }
    } as File

    const parsed = await parseXWearFile(file)
    expect(parsed.materials).toHaveLength(5)
    expect(parsed.materials.map((material) => material.materialName)).toEqual([
      'N00_002_01_Tops_01_CLOTH',
      'N00_010_01_Onepiece_00_CLOTH',
      'N00_002_01_Tops_01_CLOTH',
      'N00_007_01_Tops_01_CLOTH',
      'N00_002_01_Tops_01_CLOTH'
    ])
    expect(parsed.materials.some((material) => Object.keys(material.textures ?? {}).length > 0)).toBe(true)
  })

  it('builds and resolves stored XWear materials', () => {
    const stored = buildStoredXWear([
      {
        materialName: 'N00_004_01_Tops_01_CLOTH',
        textures: {
          _MainTex: {
            url: '/a.png',
            filename: 'a.png'
          }
        }
      },
      {
        materialName: 'N00_010_01_Onepiece_00_CLOTH'
      }
    ])

    expect(getPrimaryXWearMaterialName(stored)).toBe('N00_004_01_Tops_01_CLOTH')
    expect(getXWearMaterials(stored).map((entry) => entry.materialName)).toEqual([
      'N00_004_01_Tops_01_CLOTH',
      'N00_010_01_Onepiece_00_CLOTH'
    ])
    expect(resolveXWearLayersForMaterial(stored, 'N00_010_01_Onepiece_00_CLOTH_07 (Instance)')).toEqual([
      {
        materialName: 'N00_010_01_Onepiece_00_CLOTH'
      }
    ])
    expect(resolveXWearLayersForMaterial(stored, 'N00_999_99_Unknown_01_CLOTH (Instance)')).toEqual([
      {
        materialName: 'N00_004_01_Tops_01_CLOTH',
        textures: {
          _MainTex: {
            url: '/a.png',
            filename: 'a.png'
          }
        }
      }
    ])
  })

  it('matches XWear targets against live VRM slot names with instance and duplicate suffix drift', () => {
    expect(
      xwearMaterialTargetsMatch(
        'N00_010_01_Onepiece_00_CLOTH',
        'N00_010_01_Onepiece_00_CLOTH_07 (Instance)'
      )
    ).toBe(true)
    expect(
      xwearMaterialTargetsMatch(
        'N00_004_01_Tops_01_CLOTH',
        'N00_004_01_Tops_01_CLOTH (Instance)'
      )
    ).toBe(true)
    expect(
      xwearMaterialTargetsMatch(
        'N00_000_00_Body_00_SKIN(Clone) (Instance)',
        'N00_000_00_Body_00_SKIN (Instance)'
      )
    ).toBe(true)
  })
})
