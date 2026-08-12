import { describe, expect, it, vi } from 'vitest'

import { APPEARANCE_DIAL_VALUES_CONTRACT } from '$lib/goons/appearanceDials'
import { createHairState } from '$lib/goons/hairAssets'
import { HAIR_MOTION_PAINT_CONTRACT } from '$lib/goons/hairMotionPaint'
import {
  acceptHairImportInspection,
  acceptHairImportProposals,
  advanceHairImportStep,
  buildHairImportFinalizeRequest,
  buildHairImportPreviewRequest,
  chooseHairImportFile,
  createHairImportUiState,
  revealHairImportEditor,
  snapshotHairImportEditorContext,
  toggleHairImportObject,
  updateHairImportMotionPaint,
  updateHairImportMotionRegion,
  updateHairImportTransform,
  type HairImportInspection,
  type HairImportProposalSet
} from './hairImportUiState'

function inspection(): HairImportInspection {
  return {
    sessionId: 'hair-import-session-1',
    previewGeometryUrl: '/uploads/goon_hair_imports/preview.glb',
    sourceModeLabel: 'Generic OBJ',
    sourceSummary: 'Three ordinary polygon objects were inspected without using their filenames.',
    objects: [
      {
        id: 'hair-main',
        name: 'Main clumps',
        triangleCount: 12_000,
        materialCount: 2,
        recommendedHair: true,
        reason: 'Connected clumps sit around the scalp opening.'
      },
      {
        id: 'guide-head',
        name: 'Reference head',
        triangleCount: 5_000,
        materialCount: 1,
        recommendedHair: false,
        reason: 'Closed head-shaped geometry is unrelated to the hairstyle.'
      }
    ],
    proposedTransform: {
      move: { x: 4, y: Number.NaN, z: -4 },
      rotate: { x: -250, y: 45, z: 250 },
      uniformScale: 12,
      axisScale: { x: 0.1, y: 1, z: 3 }
    },
    initialTransform: {
      move: { x: 4, y: Number.NaN, z: -4 },
      rotate: { x: -250, y: 45, z: 250 },
      uniformScale: 12,
      axisScale: { x: 0.1, y: 1, z: 3 }
    },
    notices: ['One reference object is proposed for removal.']
  }
}

function proposals(): HairImportProposalSet {
  return {
    material: {
      title: 'Neutral Hair material',
      summary: 'Generate a recolorable neutral value texture and Highlight mask.',
      details: ['Keep the imported roughness as authoring input.']
    },
    follower: {
      title: 'Appearance following',
      summary: 'Anchor the roots strongly and reduce following toward the tips.',
      details: ['Review head and forehead extremes.']
    },
    physics: {
      title: 'Root-weighted motion',
      summary: 'Propose two clump chains and the shared head and shoulder colliders.',
      details: ['The proposal requires review before save.']
    },
    motionReview: {
      anchoredLength: 0.5,
      weightCurve: 'root-to-tip-smoothstep/v1',
      defaultIntensity: 1,
      regions: [
        {
          id: 'hair-main:region-001',
          meshNode: 'Main clumps',
          label: 'Loose strands',
          moving: true,
          recommendedMoving: true,
          supportsMotion: true,
          lengthMeters: 0.2,
          vertexCount: 2000,
          explanation: 'This section hangs below its root.'
        }
      ]
    },
    validationSummary: 'All current geometry and ownership checks are ready for visual review.',
    receipt: {
      kept: ['Main clumps'],
      removed: ['Reference head'],
      generated: ['Canonical GLB', 'Fit receipt']
    }
  }
}

function physicsState() {
  let state = chooseHairImportFile(createHairImportUiState(), {
    name: 'style.obj',
    size: 100,
    type: 'text/plain'
  })
  state = acceptHairImportInspection(state, inspection())
  state = advanceHairImportStep(state)
  state = acceptHairImportProposals(state, proposals())
  return state
}

describe('Hair import UI state', () => {
  it('reveals the Hair editor inside its scroller without moving the app viewport', () => {
    const editor = document.createElement('div')
    const review = document.createElement('div')
    Object.defineProperty(editor, 'scrollTop', {
      configurable: true,
      value: 240
    })
    editor.getBoundingClientRect = () => ({ top: 100 }) as DOMRect
    review.getBoundingClientRect = () => ({ top: 460 }) as DOMRect
    editor.scrollTo = vi.fn()
    review.focus = vi.fn()

    revealHairImportEditor(editor, review)

    expect(editor.scrollTo).toHaveBeenCalledWith({
      top: 588,
      behavior: 'auto'
    })
    expect(review.focus).toHaveBeenCalledWith({ preventScroll: true })
  })

  it('detaches rollback state from reactive proxies before the packaged WebKit handoff', () => {
    const hairTarget = createHairState(null)
    const dialTarget = {
      contract: APPEARANCE_DIAL_VALUES_CONTRACT,
      definitionSha256: 'a'.repeat(64),
      neutralId: 'batshit-base-female-neutral',
      neutralRecipeSha256: 'b'.repeat(64),
      values: { head_size: 0.25 },
      unlockedDialIds: ['head_size']
    }
    const hairProxy = new Proxy(hairTarget, {})
    const dialProxy = new Proxy(dialTarget, {})

    expect(() => structuredClone(hairProxy)).toThrow()
    expect(() => structuredClone(dialProxy)).toThrow()

    const snapshot = snapshotHairImportEditorContext(hairProxy, dialProxy)
    hairTarget.baseColor = '#ffffff'
    dialTarget.values.head_size = -0.5
    dialTarget.unlockedDialIds.push('head_width')

    expect(snapshot.hairState.baseColor).toBe('#2a1738')
    expect(snapshot.appearanceDials).toMatchObject({
      values: { head_size: 0.25 },
      unlockedDialIds: ['head_size']
    })
    expect(() => structuredClone(snapshot)).not.toThrow()
  })

  it('selects proposed Hair objects and clamps the server fit proposal to UI limits', () => {
    let state = chooseHairImportFile(createHairImportUiState(), {
      name: 'style.obj',
      size: 2048,
      type: 'text/plain'
    })
    state = acceptHairImportInspection(state, inspection())

    expect(state.step).toBe('inspect')
    expect(state.selectedObjectIds).toEqual(['hair-main'])
    expect(state.transform).toEqual({
      move: { x: 4, y: 0, z: -4 },
      rotate: { x: -180, y: 45, z: 180 },
      uniformScale: 12,
      axisScale: { x: 0.5, y: 1, z: 2 }
    })
  })

  it('invalidates generated authoring when kept objects or fit change', () => {
    let state = physicsState()
    state = advanceHairImportStep(state)
    expect(state.step).toBe('finalize')

    state = toggleHairImportObject(state, 'guide-head', true)
    expect(state.step).toBe('inspect')
    expect(state.proposals).toBeNull()

    state = acceptHairImportProposals(state, proposals())
    state = updateHairImportTransform(state, {
      ...state.transform,
      uniformScale: 1.15
    })
    expect(state.step).toBe('fit')
    expect(state.proposals).toBeNull()
  })

  it('builds deterministic requests and permits finalization only from the Save step', () => {
    let state = physicsState()
    expect(() => buildHairImportFinalizeRequest(state)).toThrow(/finish Hair Physics/i)
    state = advanceHairImportStep(state)

    expect(buildHairImportPreviewRequest(state)).toEqual({
      sessionId: 'hair-import-session-1',
      selectedObjectIds: ['hair-main'],
      transform: state.transform,
      motionRegionSelections: [{ id: 'hair-main:region-001', moving: true }],
      motionPaint: null
    })
    expect(buildHairImportFinalizeRequest(state)).toEqual({
      sessionId: 'hair-import-session-1'
    })
  })

  it('makes painted motion authoritative and clears automatic region selections', () => {
    const physics = physicsState()
    const state = updateHairImportMotionPaint(physics, {
      contract: HAIR_MOTION_PAINT_CONTRACT,
      regions: [
        {
          id: 'front-strand',
          label: 'Front strand',
          enabled: true,
          meshes: [
            {
              meshNode: 'Hair main',
              triangleCount: 100,
              triangleRanges: [[50, 99]]
            }
          ]
        }
      ]
    })

    expect(state.motionRegionSelections).toBeNull()
    expect(state.motionPaint?.regions[0]?.label).toBe('Front strand')
  })

  it('updates one broad motion region without leaving the Physics step', () => {
    const state = updateHairImportMotionRegion(
      acceptHairImportProposals(
        advanceHairImportStep(acceptHairImportInspection(createHairImportUiState(), inspection())),
        proposals()
      ),
      'hair-main:region-001',
      false
    )
    expect(state.motionRegionSelections).toEqual([
      { id: 'hair-main:region-001', moving: false }
    ])
    expect(state.proposals?.motionReview.regions[0]?.moving).toBe(false)
    expect(state.step).toBe('physics')
  })

  it('does not let an anchored detail become a motion region', () => {
    const proposal = proposals()
    proposal.motionReview.regions[0] = {
      ...proposal.motionReview.regions[0]!,
      moving: false,
      recommendedMoving: false,
      supportsMotion: false,
      lengthMeters: 0.003
    }
    const state = acceptHairImportProposals(
      advanceHairImportStep(acceptHairImportInspection(createHairImportUiState(), inspection())),
      proposal
    )

    expect(updateHairImportMotionRegion(state, 'hair-main:region-001', true)).toBe(state)
  })

  it('replacing the source file clears the entire downstream review', () => {
    let state = physicsState()
    state = chooseHairImportFile(state, {
      name: 'replacement.glb',
      size: 4096,
      type: 'model/gltf-binary'
    })

    expect(state).toMatchObject({
      step: 'choose',
      file: { name: 'replacement.glb' },
      inspection: null,
      selectedObjectIds: [],
      proposals: null
    })
  })
})
