import * as THREE from 'three'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  extractEmbeddedCustomAvatarManifest,
  hasRenderableGoonAvatar,
  loadAvatarIntoEngine,
  loadCustomAvatarManifest,
  getCustomRuntimeNodeNameCandidates,
  resolveCustomFaceControlBindings,
  resolveCustomExpressionBindings,
  resolveCustomFaceMeshes,
  resolveCustomFaceMeshNames,
  resolveGuidedManifestFile,
  resolveCustomMorphDefinitions,
  resolveGoonEyeContactMode,
  resolveGoonEyeContactTuning,
  resolveGoonSourceProfile,
  sanitizeCustomRuntimeNodeName,
  resolveGoonAvatarSignature,
  resolveGoonAvatarUrl,
  resolveGoonManifestFile
} from '$lib/goons/customAvatar'
import type { GoonRecord, GoonsSettings } from '$lib/types/goons'

const baseGoon: GoonRecord = {
  id: 'goon_1',
  user_id: 'josh',
  name: 'Test Goon',
  files: {
    animations: []
  },
  created_at: '2026-03-24T00:00:00.000Z',
  updated_at: '2026-03-24T00:00:00.000Z'
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('customAvatar helpers', () => {
  it('resolves the renderable avatar url for both lanes', () => {
    const vrmGoon: GoonRecord = {
      ...baseGoon,
      files: {
        vrm: { url: '/avatars/a.vrm', filename: 'a.vrm' },
        vrmPending: { url: '/avatars/a-pending.vrm', filename: 'a-pending.vrm' },
        animations: []
      }
    }
    const customGoon: GoonRecord = {
      ...baseGoon,
      kind: 'custom',
      customAvatar: {
        model: { url: '/avatars/custom.glb', filename: 'custom.glb' },
        manifest: { url: '/avatars/custom.json', filename: 'custom.json' }
      },
      files: {
        animations: []
      }
    }

    expect(resolveGoonAvatarUrl(vrmGoon)).toBe('/avatars/a-pending.vrm')
    expect(resolveGoonAvatarUrl(customGoon)).toBe('/avatars/custom.glb')
    expect(hasRenderableGoonAvatar(customGoon)).toBe(true)
  })

  it('defaults and resolves source profiles across vrm, guided, and expert lanes', () => {
    const guidedGoon: GoonRecord = {
      ...baseGoon,
      sourceProfile: 'guided-custom-vrm',
      files: {
        vrm: { url: '/avatars/guided.vrm', filename: 'guided.vrm' },
        animations: []
      }
    }
    const expertGoon: GoonRecord = {
      ...baseGoon,
      kind: 'custom',
      files: { animations: [] }
    }

    expect(resolveGoonSourceProfile(baseGoon)).toBe('standard-vrm')
    expect(resolveGoonSourceProfile(guidedGoon)).toBe('guided-custom-vrm')
    expect(resolveGoonSourceProfile(expertGoon)).toBe('expert-custom-glb')
    expect(resolveGoonEyeContactMode(baseGoon)).toBe('bone')
    expect(resolveGoonEyeContactMode(guidedGoon)).toBe('expression')
    const globalSettings: GoonsSettings = {
      kitchen: {
        eyeContact: {
          vroid: {
            mode: 'expression',
            tuning: {
              eyeYawSensitivity: 1.5,
              eyeYawRange: 2,
              eyePitchRange: 0.25
            }
          },
          blender: {
            mode: 'bone',
            tuning: {
              eyeYawSensitivity: 3,
              eyeYawRange: 4,
              eyePitchRange: 0.5
            }
          }
        }
      }
    }
    expect(resolveGoonEyeContactMode(baseGoon, globalSettings)).toBe('expression')
    expect(resolveGoonEyeContactMode(guidedGoon, globalSettings)).toBe('bone')
    expect(resolveGoonEyeContactTuning(baseGoon, globalSettings)).toMatchObject({
      eyeYawSensitivity: 1.5,
      eyeYawRange: 2,
      eyePitchRange: 0.25
    })
    expect(resolveGoonEyeContactTuning(guidedGoon, globalSettings)).toMatchObject({
      eyeYawSensitivity: 3,
      eyeYawRange: 4,
      eyePitchRange: 0.5
    })
    expect(resolveGoonEyeContactMode({ ...guidedGoon, defaults: { eyeContactMode: 'bone' } })).toBe(
      'bone'
    )
    expect(
      resolveGoonEyeContactTuning({
        ...guidedGoon,
        defaults: {
          eyeContactTuning: {
            eyeYawSensitivity: 2.345,
            eyeYawRange: 99,
            eyePitchSensitivity: -1,
            eyePitchRange: 0.75,
            headYawStartDeg: 44.7,
            headYawSensitivity: 0.6,
            headYawRange: 1.25,
            headYawSpeed: 9,
            headPitchStartDeg: 7.4,
            headPitchSensitivity: 0.5,
            headPitchRange: 1.5,
            headPitchSpeed: 0,
            eyeYawHeadCompensation: 2,
            eyePitchHeadCompensation: -1
          }
        }
      })
    ).toEqual({
      eyeYawSensitivity: 2.35,
      eyeYawRange: 8,
      eyePitchSensitivity: 0,
      eyePitchRange: 0.75,
      headYawStartOutDeg: 45,
      headYawStartInDeg: 52,
      headYawSensitivity: 0.6,
      headYawRange: 1.25,
      headYawSpeed: 3,
      headPitchStartOutDeg: 7,
      headPitchStartInDeg: 22,
      headPitchSensitivity: 0.5,
      headPitchRange: 1.5,
      headPitchSpeed: 0.05,
      eyeYawHeadCompensation: 2,
      eyePitchHeadCompensation: 0
    })
    expect(resolveGoonAvatarUrl(guidedGoon)).toBe('/avatars/guided.vrm')
  })

  it('includes the manifest url in the custom avatar signature', () => {
    const customGoon: GoonRecord = {
      ...baseGoon,
      kind: 'custom',
      customAvatar: {
        model: { url: '/avatars/custom.glb', filename: 'custom.glb' },
        manifest: { url: '/avatars/custom.json', filename: 'custom.json' }
      },
      files: {
        animations: []
      }
    }

    expect(resolveGoonAvatarSignature(customGoon)).toBe(
      'custom::/avatars/custom.glb::/avatars/custom.json'
    )
  })

  it('includes the guided manifest url in the avatar signature', () => {
    const guidedGoon: GoonRecord = {
      ...baseGoon,
      sourceProfile: 'guided-custom-vrm',
      guidedAvatar: {
        manifest: { url: '/avatars/guided.json', filename: 'guided.json' }
      },
      files: {
        vrm: { url: '/avatars/guided.vrm', filename: 'guided.vrm' },
        animations: []
      }
    }

    expect(resolveGoonAvatarSignature(guidedGoon)).toBe(
      'vrm::guided-custom-vrm::/avatars/guided.vrm::/avatars/guided.json'
    )
  })

  it('includes guided DUF overlay state in the avatar signature when present', () => {
    const guidedGoon: GoonRecord = {
      ...baseGoon,
      sourceProfile: 'guided-custom-vrm',
      guidedAvatar: {
        manifest: { url: '/avatars/guided.json', filename: 'guided.json' },
        pieceStates: {
          duf_overlay_top: true
        },
        dufOverlays: [
          {
            id: 'overlay_1',
            label: 'DUF Outfit',
            file: { url: '/avatars/duf-outfit.vrm', filename: 'duf-outfit.vrm' },
            pieceIds: ['duf_overlay_top']
          }
        ]
      },
      files: {
        vrm: { url: '/avatars/guided.vrm', filename: 'guided.vrm' },
        animations: []
      }
    }

    expect(resolveGoonAvatarSignature(guidedGoon)).toBe(
      'vrm::guided-custom-vrm::/avatars/guided.vrm::/avatars/guided.json::/avatars/duf-outfit.vrm::{"duf_overlay_top":true}'
    )
  })

  it('resolves guided and custom manifest files through one helper', () => {
    const guidedGoon: GoonRecord = {
      ...baseGoon,
      sourceProfile: 'guided-custom-vrm',
      guidedAvatar: {
        manifest: { url: '/avatars/guided.json', filename: 'guided.json' }
      },
      files: {
        vrm: { url: '/avatars/guided.vrm', filename: 'guided.vrm' },
        animations: []
      }
    }
    const customGoon: GoonRecord = {
      ...baseGoon,
      kind: 'custom',
      customAvatar: {
        manifest: { url: '/avatars/custom.json', filename: 'custom.json' }
      },
      files: {
        animations: []
      }
    }

    expect(resolveGuidedManifestFile(guidedGoon)?.url).toBe('/avatars/guided.json')
    expect(resolveGoonManifestFile(guidedGoon)?.url).toBe('/avatars/guided.json')
    expect(resolveGoonManifestFile(customGoon)?.url).toBe('/avatars/custom.json')
    expect(resolveGoonManifestFile(baseGoon)).toBeNull()
  })

  it('loads and caches the custom avatar manifest', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        contractVersion: 1,
        stage: {
          anchors: {
            head: 'Head',
            hips: 'Hips',
            leftFoot: 'LeftFoot',
            rightFoot: 'RightFoot'
          }
        }
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const fileRef = { url: '/avatars/cache-test.json', filename: 'cache-test.json' }
    const first = await loadCustomAvatarManifest(fileRef)
    const second = await loadCustomAvatarManifest(fileRef)

    expect(first.stage?.anchors?.head).toBe('Head')
    expect(second.stage?.anchors?.hips).toBe('Hips')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('extracts an embedded Batshit manifest from a glTF extension payload', () => {
    const manifest = extractEmbeddedCustomAvatarManifest({
      asset: { version: '2.0' },
      extensions: {
        BATSHIT_avatar: {
          marker: 'BATSHIT_avatar_v1',
          embedVersion: 1,
          manifest: {
            contractVersion: 1,
            stage: {
              anchors: {
                head: 'head.x',
                hips: 'root.x',
                feet: 'feet_anchor'
              }
            },
            face: {
              mesh: 'RigMaster_Body',
              expressions: {
                blink: 'blink'
              }
            }
          }
        }
      }
    })

    expect(manifest).toEqual({
      contractVersion: 1,
      stage: {
        anchors: {
          head: 'head.x',
          hips: 'root.x',
          feet: 'feet_anchor'
        }
      },
      face: {
        mesh: 'RigMaster_Body',
        expressions: {
          blink: 'blink'
        }
      }
    })
  })

  it('falls back to embedded asset extras when no Batshit extension payload exists', () => {
    const manifest = extractEmbeddedCustomAvatarManifest({
      asset: {
        version: '2.0',
        extras: {
          batshitAvatar: {
            contractVersion: 1,
            face: {
              meshes: ['RigMaster_Body', 'RigMaster_Brows'],
              controls: {
                eyes_left_open: 'eyes_left_open'
              }
            }
          }
        }
      }
    })

    expect(manifest).toEqual({
      contractVersion: 1,
      face: {
        meshes: ['RigMaster_Body', 'RigMaster_Brows'],
        controls: {
          eyes_left_open: 'eyes_left_open'
        }
      }
    })
  })

  it('normalizes optional custom face mesh names and expression bindings', () => {
    const manifest = {
      contractVersion: 1,
      face: {
        mesh: ' FaceMesh ',
        meshes: ['FaceMesh', ' TeethMesh ', '', 'EyesMesh'],
        expressions: {
          happy: ' Smile ',
          aa: [' Viseme_AA ', 'Viseme_AA', '', 'JawOpen'],
          blink: []
        }
      }
    }

    expect(resolveCustomFaceMeshNames(manifest)).toEqual(['FaceMesh', 'TeethMesh', 'EyesMesh'])
    expect(resolveCustomExpressionBindings(manifest)).toEqual({
      happy: ['Smile'],
      aa: ['Viseme_AA', 'JawOpen']
    })
  })

  it('matches the Three.js runtime node-name sanitization used by Custom avatars', () => {
    expect(sanitizeCustomRuntimeNodeName('c_head.x')).toBe('c_headx')
    expect(sanitizeCustomRuntimeNodeName('Kiriko Body')).toBe('Kiriko_Body')
    expect(getCustomRuntimeNodeNameCandidates(' foot.l ')).toEqual(['foot.l', 'footl'])
  })

  it('normalizes structured custom face control bindings', () => {
    const manifest = {
      contractVersion: 1,
      face: {
        controls: {
          eyelids_left: {
            negative: [' blinkLeft ', 'blinkLeft', ''],
            positive: ' leftEyeOpen '
          },
          mouth_width: {
            negative: ' mouthNarrow ',
            positive: [' mouthWide ', 'mouthWide']
          },
          eyes_widen: [' widen ', '', 'widen']
        }
      }
    }

    expect(resolveCustomFaceControlBindings(manifest)).toEqual({
      eyelids_left: {
        negative: ['blinkLeft'],
        positive: ['leftEyeOpen']
      },
      mouth_width: {
        negative: ['mouthNarrow'],
        positive: ['mouthWide']
      },
      eyes_widen: {
        positive: ['widen']
      }
    })
  })

  it('fills eyelid shut targets from blink expressions when controls only define open', () => {
    const manifest = {
      contractVersion: 1,
      face: {
        expressions: {
          blink: 'blink',
          blinkLeft: 'blinkLeft',
          blinkRight: 'blinkRight'
        },
        controls: {
          eyelids_left: 'eyes_left_open',
          eyelids_right: 'eyes_right_open'
        }
      }
    }

    expect(resolveCustomFaceControlBindings(manifest)).toEqual({
      eyelids_left: {
        negative: ['blinkLeft'],
        positive: ['eyes_left_open']
      },
      eyelids_right: {
        negative: ['blinkRight'],
        positive: ['eyes_right_open']
      }
    })
  })

  it('normalizes curated custom morph definitions', () => {
    const manifest = {
      contractVersion: 1,
      face: {
        customMorphs: {
          ' Smile Boost ': ' smile_boost ',
          EarWiggle: [' ear_left ', 'ear_right', 'ear_left', '']
        }
      }
    }

    expect(resolveCustomMorphDefinitions(manifest)).toEqual([
      {
        id: 'Smile Boost',
        morphTargets: ['smile_boost']
      },
      {
        id: 'EarWiggle',
        morphTargets: ['ear_left', 'ear_right']
      }
    ])
  })

  it('resolves named custom face nodes through grouped mesh descendants', () => {
    const root = new THREE.Group()

    const bodyGroup = new THREE.Group()
    bodyGroup.name = 'Kiriko Body Export'
    const bodyMesh = new THREE.Mesh()
    bodyMesh.name = 'Body Primitive'
    bodyMesh.morphTargetDictionary = { aa: 0, blink: 1 }
    bodyMesh.morphTargetInfluences = [0, 0]
    bodyGroup.add(bodyMesh)
    root.add(bodyGroup)

    const browGroup = new THREE.Group()
    browGroup.name = 'Kiriko Eyebrows Export'
    const browMesh = new THREE.Mesh()
    browMesh.name = 'Brow Primitive'
    browMesh.morphTargetDictionary = { blink: 0, blinkLeft: 1, blinkRight: 2 }
    browMesh.morphTargetInfluences = [0, 0, 0]
    browGroup.add(browMesh)
    root.add(browGroup)

    const result = resolveCustomFaceMeshes(root, ['Kiriko Body Export', 'Kiriko Eyebrows Export'])

    expect(result.issues).toEqual([])
    expect(result.meshes).toEqual([bodyMesh, browMesh])
  })

  it('can resolve face meshes when the manifest still uses raw Blender-style names', () => {
    const root = new THREE.Group()

    const bodyGroup = new THREE.Group()
    bodyGroup.name = 'Kiriko_Body'
    const bodyMesh = new THREE.Mesh()
    bodyMesh.name = 'Body Primitive'
    bodyMesh.morphTargetDictionary = { aa: 0, blink: 1 }
    bodyMesh.morphTargetInfluences = [0, 0]
    bodyGroup.add(bodyMesh)
    root.add(bodyGroup)

    const result = resolveCustomFaceMeshes(root, ['Kiriko Body'])

    expect(result.issues).toEqual([])
    expect(result.meshes).toEqual([bodyMesh])
  })

  it('routes custom goons through engine.loadCustomGoon', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        contractVersion: 1,
        stage: {
          anchors: {
            head: 'Head',
            hips: 'Hips',
            feet: 'Feet'
          }
        }
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const engine = {
      loadGoon: vi.fn(),
      loadCustomGoon: vi.fn().mockResolvedValue(undefined)
    }
    const customGoon: GoonRecord = {
      ...baseGoon,
      kind: 'custom',
      appearanceDials: {
        contract: 'appearance-dial-values/v2',
        definitionSha256: 'a'.repeat(64),
        neutralId: 'batshit-base-f-v1-neutral',
        neutralRecipeSha256: 'b'.repeat(64),
        values: { head_size: 0.5 },
        unlockedDialIds: []
      },
      customAvatar: {
        model: { url: '/avatars/custom-e3.glb', filename: 'custom-e3.glb' },
        manifest: { url: '/avatars/custom-e3.json', filename: 'custom-e3.json' }
      },
      files: {
        animations: []
      }
    }

    const result = await loadAvatarIntoEngine(engine as any, customGoon)

    expect(result.kind).toBe('custom')
    expect(engine.loadCustomGoon).toHaveBeenCalledWith(
      '/avatars/custom-e3.glb',
      {
        contractVersion: 1,
        stage: {
          anchors: {
            head: 'Head',
            hips: 'Hips',
            feet: 'Feet'
          }
        }
      },
      {
        appearanceDialValues: customGoon.appearanceDials,
        eyeAppearanceState: null,
        facialArtworkState: null
      }
    )
    expect(engine.loadGoon).not.toHaveBeenCalled()
  })

  it('routes guided vrms through engine.loadGoon with the guided manifest', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        contractVersion: 1,
        face: {
          mesh: 'RigMaster_Body',
          expressions: {
            blink: 'blink'
          }
        }
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const engine = {
      loadGoon: vi.fn().mockResolvedValue(undefined),
      loadCustomGoon: vi.fn(),
      configureGuidedOutfitPieces: vi.fn().mockResolvedValue(undefined)
    }
    const guidedGoon: GoonRecord = {
      ...baseGoon,
      sourceProfile: 'guided-custom-vrm',
      guidedAvatar: {
        manifest: { url: '/avatars/guided-face.json', filename: 'guided-face.json' },
        outfitPieces: [
          {
            id: 'piece_1',
            label: 'Top',
            runtimeNodeNames: ['Top_01'],
            defaultOn: true
          }
        ],
        pieceStates: {
          piece_1: true
        },
        dufOverlays: [
          {
            id: 'overlay_1',
            label: 'DUF Outfit',
            file: { url: '/avatars/duf-outfit.vrm', filename: 'duf-outfit.vrm' },
            pieceIds: ['piece_1']
          }
        ]
      },
      files: {
        vrm: { url: '/avatars/guided-face.vrm', filename: 'guided-face.vrm' },
        animations: []
      }
    }

    const result = await loadAvatarIntoEngine(engine as any, guidedGoon)

    expect(result.kind).toBe('vrm')
    expect(engine.loadGoon).toHaveBeenCalledWith('/avatars/guided-face.vrm', {
      contractVersion: 1,
      face: {
        mesh: 'RigMaster_Body',
        expressions: {
          blink: 'blink'
        }
      }
    })
    expect(engine.configureGuidedOutfitPieces).toHaveBeenCalledWith(
      [
        {
          id: 'piece_1',
          label: 'Top',
          runtimeNodeNames: ['Top_01'],
          defaultOn: true
        }
      ],
      {
        piece_1: true
      },
      [
        {
          id: 'overlay_1',
          file: { url: '/avatars/duf-outfit.vrm', filename: 'duf-outfit.vrm' }
        }
      ]
    )
    expect(engine.loadCustomGoon).not.toHaveBeenCalled()
  })
})
