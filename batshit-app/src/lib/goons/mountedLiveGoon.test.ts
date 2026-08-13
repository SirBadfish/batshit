import { describe, expect, it, vi } from 'vitest'

import type { GoonEngine } from '$lib/goons/engine'
import {
  applyMountedLiveGoonClosetAssignments,
  buildMountedLiveGoonLoadPlan,
  loadMountedLiveGoon
} from '$lib/goons/mountedLiveGoon'
import type { GoonFileRef, GoonRecord, GoonsSettings } from '$lib/types/goons'

const baseGoon: GoonRecord = {
  id: 'goon-mounted-live',
  user_id: 'josh',
  name: 'Mounted Live Goon',
  files: {
    vrm: { url: '/goons/mounted-live.vrm', filename: 'mounted-live.vrm' },
    animations: []
  },
  cues: {
    enabled: ['calm'],
    overrides: {
      calm: {
        name: 'Calm',
        kind: 'mood',
        animationName: 'calm_idle',
        intensity: 0.65
      }
    }
  },
  camera: {
    distance: 2.4,
    fov: 42,
    mode: 'free'
  },
  defaults: {
    baseLoop: 'calm',
    sceneId: 'studio'
  },
  closetAssignments: {},
  created_at: '2026-08-12T00:00:00.000Z',
  updated_at: '2026-08-12T00:00:00.000Z'
}

const goonsSettings: GoonsSettings = {
  kitchen: {
    scenes: {
      studio: {
        id: 'studio',
        name: 'Studio',
        groundProjectionLine: 0.72
      }
    }
  }
}

const animationFiles: GoonFileRef[] = [
  {
    url: '/motions/wave.vrma',
    filename: 'wave.vrma',
    originalName: 'wave.vrma',
    size: 100
  },
  {
    url: '/motions/calm-idle.vrma',
    filename: 'calm_idle.vrma',
    originalName: 'calm_idle.vrma',
    size: 100
  },
  {
    url: '/motions/custom.glb',
    filename: 'custom.glb',
    originalName: 'custom.glb',
    size: 100
  }
]

function createEngineHarness() {
  const calls = {
    init: vi.fn().mockResolvedValue(undefined),
    setCameraFov: vi.fn(),
    loadGoon: vi.fn().mockResolvedValue(undefined),
    setMood: vi.fn(),
    applyCamera: vi.fn(),
    setDefaultCamera: vi.fn(),
    resetCamera: vi.fn(),
    syncAnimations: vi.fn().mockResolvedValue(undefined),
    getMaterialNames: vi.fn(() => []),
    applyMaterialTexture: vi.fn().mockResolvedValue(true),
    applyMaterialColorOverride: vi.fn(),
    applyXWearMaterial: vi.fn().mockResolvedValue(true),
    resetMaterialOverrides: vi.fn(),
    applyBodyConceal: vi.fn(),
    setGuidedOutfitPieceVisible: vi.fn(),
    setGoonVisible: vi.fn(),
    getAnimationCatalog: vi.fn(() => [
      { name: 'calm_idle', source: 'vrma' as const }
    ]),
    restoreMountedRuntimeState: vi.fn(),
    setPostureDefinitions: vi.fn(),
    setGroundProjectionLine: vi.fn(),
    setSkyboxBackground: vi.fn().mockResolvedValue(undefined),
    setRoomShellTransform: vi.fn(),
    setRoomCameraBoundary: vi.fn(),
    setRoomShell: vi.fn().mockResolvedValue(undefined),
    setRoomShellBuilder: vi.fn().mockResolvedValue(undefined),
    setSceneRootOffsetY: vi.fn(),
    setScenePlacement: vi.fn(),
    setSceneProps: vi.fn().mockResolvedValue(undefined),
    setSceneMarkers: vi.fn(),
    setSceneAmbience: vi.fn()
  }
  return { calls, engine: calls as unknown as GoonEngine }
}

describe('mounted Live Goon planning', () => {
  it('keeps scene-free Desktop planning explicit without changing avatar parity inputs', () => {
    const dockPlan = buildMountedLiveGoonLoadPlan(baseGoon, {
      goonsSettings,
      animationFiles,
      sceneMode: 'saved',
      initialFov: 50
    })
    const desktopPlan = buildMountedLiveGoonLoadPlan(baseGoon, {
      goonsSettings,
      animationFiles,
      sceneMode: 'none',
      initialFov: 50
    })

    expect(dockPlan.scene).toEqual(goonsSettings.kitchen?.scenes?.studio)
    expect(dockPlan.sceneSignature).not.toBe('none')
    expect(desktopPlan.scene).toBeNull()
    expect(desktopPlan.sceneSignature).toBe('none')
    expect(desktopPlan.baseLoopSignature).toBe(dockPlan.baseLoopSignature)
    expect(desktopPlan.animationSignature).toBe(dockPlan.animationSignature)
    expect(desktopPlan.closetSignature).toBe(dockPlan.closetSignature)
    expect(desktopPlan.viewFov).toBe(42)
    expect(desktopPlan.cameraMode).toBe('free')
    expect(desktopPlan.animationPlan.eager.map((file) => file.url)).toEqual([
      '/motions/calm-idle.vrma',
      '/motions/wave.vrma'
    ])
  })

  it('selects the GLB animation lane and records live-edit signatures for non-Recipe custom Goons', () => {
    const customGoon: GoonRecord = {
      ...baseGoon,
      kind: 'custom',
      files: { animations: [] },
      customAvatar: {
        model: { url: '/goons/custom.glb', filename: 'custom.glb' },
        manifest: { url: '/goons/avatar.json', filename: 'avatar.json' }
      },
      appearanceDials: null,
      facialArtwork: null,
      eyeAppearance: null,
      oralAppearance: null
    }
    const plan = buildMountedLiveGoonLoadPlan(customGoon, {
      goonsSettings,
      animationFiles,
      sceneMode: 'none'
    })

    expect(plan.kind).toBe('custom')
    expect(plan.animationPlan.eager.map((file) => file.url)).toEqual(['/motions/custom.glb'])
    expect(plan.closetSignature).toBe('')
    expect(plan.appearanceDialsSignature).toBe('null')
    expect(plan.facialArtworkSignature).toBe('null')
    expect(plan.eyeAppearanceSignature).toBe('null')
    expect(plan.oralAppearanceSignature).toBe('null')
  })
})

describe('mounted Live Goon loading', () => {
  it('loads the canonical avatar/camera/mood/animation/outfit path while skipping every scene call in scene-free mode', async () => {
    const { engine, calls } = createEngineHarness()
    const plan = buildMountedLiveGoonLoadPlan(baseGoon, {
      goonsSettings,
      animationFiles,
      sceneMode: 'none',
      initialFov: 50
    })

    const result = await loadMountedLiveGoon(engine, plan)

    expect(calls.init).toHaveBeenCalledOnce()
    expect(calls.loadGoon).toHaveBeenCalledWith('/goons/mounted-live.vrm', null)
    expect(calls.setMood).toHaveBeenCalledWith('calm', plan.baseLoopDefinition)
    expect(calls.applyCamera).toHaveBeenCalledWith(baseGoon.camera)
    expect(calls.setDefaultCamera).toHaveBeenCalledWith(baseGoon.camera)
    expect(calls.syncAnimations).toHaveBeenCalledWith([
      animationFiles[1],
      animationFiles[0]
    ])
    expect(calls.applyBodyConceal).toHaveBeenCalledWith({ paintedMasks: [] })
    expect(calls.setGoonVisible).toHaveBeenCalledWith(true)
    expect(calls.setPostureDefinitions).not.toHaveBeenCalled()
    expect(calls.setSkyboxBackground).not.toHaveBeenCalled()
    expect(calls.setRoomShell).not.toHaveBeenCalled()
    expect(result.sceneSignature).toBe('none')
    expect(result.viewFov).toBe(42)
  })

  it('applies the saved Dock scene through the same loader when requested', async () => {
    const { engine, calls } = createEngineHarness()
    const plan = buildMountedLiveGoonLoadPlan(baseGoon, {
      goonsSettings,
      animationFiles,
      sceneMode: 'saved'
    })

    await loadMountedLiveGoon(engine, plan)

    expect(calls.setPostureDefinitions).toHaveBeenCalledWith({})
    expect(calls.setGroundProjectionLine).toHaveBeenCalledWith(0.72)
    expect(calls.setSkyboxBackground).toHaveBeenCalledWith(null)
    expect(calls.setSceneProps).toHaveBeenCalledWith([])
  })

  it('applies wardrobe textures, painted conceal, and guided piece visibility through the shared path', async () => {
    const { engine, calls } = createEngineHarness()
    calls.getMaterialNames.mockReturnValue([
      'N00_004_01_Tops_01_CLOTH',
      'N00_000_00_Body_00_SKIN'
    ])
    const guidedGoon: GoonRecord = {
      ...baseGoon,
      sourceProfile: 'guided-custom-vrm',
      guidedAvatar: {
        outfitPieces: [
          {
            id: 'cape',
            label: 'Cape',
            runtimeNodeNames: ['Cape'],
            source: 'base',
            defaultOn: true
          }
        ],
        pieceStates: { cape: false }
      },
      closet: {
        items: {
          hoodie: {
            id: 'hoodie',
            name: 'Hoodie',
            category: 'top',
            texture: { url: '/closet/hoodie.png', filename: 'hoodie.png' },
            materialColors: { baseHex: '#336699' },
            paintedConcealMask: {
              version: 1,
              topologySignature: 'topology:body',
              meshes: [
                {
                  mesh: 'Body',
                  topologySignature: 'mesh:body',
                  triangleCount: 12,
                  vertexCount: 8,
                  triangleRanges: [[2, 4]]
                }
              ]
            }
          }
        }
      },
      closetAssignments: {
        N00_004_01_Tops_01_CLOTH: { mode: 'item', itemId: 'hoodie' }
      }
    }

    await applyMountedLiveGoonClosetAssignments(engine, {
      goon: guidedGoon,
      goonsSettings: null
    })

    expect(calls.applyMaterialTexture).toHaveBeenCalledWith(
      'N00_004_01_Tops_01_CLOTH',
      '/closet/hoodie.png'
    )
    expect(calls.applyMaterialColorOverride).toHaveBeenCalledWith(
      'N00_004_01_Tops_01_CLOTH',
      { baseHex: '#336699', shadeHex: undefined }
    )
    expect(calls.applyBodyConceal).toHaveBeenCalledWith({
      paintedMasks: [guidedGoon.closet?.items?.hoodie?.paintedConcealMask]
    })
    expect(calls.setGuidedOutfitPieceVisible).toHaveBeenCalledWith('cape', false)
  })
})
