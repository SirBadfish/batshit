import type { AppearanceDialValueState } from '$lib/goons/appearanceDials'
import { parseHairState, type HairStateV2 } from '$lib/goons/hairAssets'
import type { HairMotionPaintV1 } from '$lib/goons/hairMotionPaint'

export type HairImportStepId = 'choose' | 'inspect' | 'fit' | 'physics' | 'finalize'

export const HAIR_IMPORT_TRANSFORM_LIMITS = {
  move: { min: -10, max: 10, step: 0.005 },
  rotate: { min: -180, max: 180, step: 1 },
  uniformScale: { min: 0.01, max: 100, step: 0.01 },
  axisScale: { min: 0.5, max: 2, step: 0.01 }
} as const

export type HairImportFileSelection = {
  name: string
  size: number
  type: string
}

export type HairImportObjectChoice = {
  id: string
  name: string
  triangleCount: number
  materialCount: number
  recommendedHair: boolean
  reason: string
}

export type HairImportTransform = {
  move: { x: number; y: number; z: number }
  rotate: { x: number; y: number; z: number }
  uniformScale: number
  axisScale: { x: number; y: number; z: number }
}

export type HairImportInspection = {
  sessionId: string
  previewGeometryUrl: string
  sourceModeLabel: string
  sourceSummary: string
  objects: HairImportObjectChoice[]
  proposedTransform: HairImportTransform
  initialTransform: HairImportTransform
  notices: string[]
}

export type HairImportProposal = {
  title: string
  summary: string
  details: string[]
}

export type HairImportMotionRegion = {
  id: string
  meshNode: string
  label: string
  moving: boolean
  recommendedMoving: boolean
  supportsMotion: boolean
  lengthMeters: number
  vertexCount: number
  explanation: string
}

export type HairImportProposalSet = {
  material: HairImportProposal
  follower: HairImportProposal
  physics: HairImportProposal
  motionReview: {
    anchoredLength: number
    weightCurve: 'root-to-tip-smoothstep/v1'
    defaultIntensity: number
    regions: HairImportMotionRegion[]
  }
  validationSummary: string
  receipt: {
    kept: string[]
    removed: string[]
    generated: string[]
  }
}

export type HairImportPreviewRequest = {
  sessionId: string
  selectedObjectIds: string[]
  transform: HairImportTransform
  motionRegionSelections: Array<{ id: string; moving: boolean }> | null
  motionPaint: HairMotionPaintV1 | null
}

export type HairImportFinalizeRequest = {
  sessionId: string
}

export type HairImportUiState = {
  step: HairImportStepId
  file: HairImportFileSelection | null
  inspection: HairImportInspection | null
  selectedObjectIds: string[]
  transform: HairImportTransform
  motionRegionSelections: Array<{ id: string; moving: boolean }> | null
  motionPaint: HairMotionPaintV1 | null
  proposals: HairImportProposalSet | null
}

export type HairImportEditorContextSnapshot = {
  hairState: HairStateV2
  appearanceDials: AppearanceDialValueState | null
}

/**
 * Detach the import rollback state from Svelte's reactive proxies.
 *
 * WebKit's structuredClone rejects Proxy objects, so this boundary rebuilds
 * the two persisted contracts explicitly instead of cloning component state.
 */
export function snapshotHairImportEditorContext(
  hairState: HairStateV2,
  appearanceDials: AppearanceDialValueState | null
): HairImportEditorContextSnapshot {
  return {
    hairState: parseHairState(hairState),
    appearanceDials: appearanceDials
      ? {
          contract: appearanceDials.contract,
          definitionSha256: appearanceDials.definitionSha256,
          neutralId: appearanceDials.neutralId,
          neutralRecipeSha256: appearanceDials.neutralRecipeSha256,
          values: { ...appearanceDials.values },
          unlockedDialIds: [...appearanceDials.unlockedDialIds]
        }
      : null
  }
}

export function revealHairImportEditor(
  editorScrollElement: HTMLElement | null,
  reviewElement: HTMLElement | null
): void {
  if (!editorScrollElement || !reviewElement) return
  const editorRect = editorScrollElement.getBoundingClientRect()
  const reviewRect = reviewElement.getBoundingClientRect()
  editorScrollElement.scrollTo({
    top: Math.max(0, editorScrollElement.scrollTop + reviewRect.top - editorRect.top - 12),
    behavior: 'auto'
  })
  reviewElement.focus({ preventScroll: true })
}

export const DEFAULT_HAIR_IMPORT_TRANSFORM: HairImportTransform = {
  move: { x: 0, y: 0, z: 0 },
  rotate: { x: 0, y: 0, z: 0 },
  uniformScale: 1,
  axisScale: { x: 1, y: 1, z: 1 }
}

export function createHairImportUiState(): HairImportUiState {
  return {
    step: 'choose',
    file: null,
    inspection: null,
    selectedObjectIds: [],
    transform: structuredClone(DEFAULT_HAIR_IMPORT_TRANSFORM),
    motionRegionSelections: null,
    motionPaint: null,
    proposals: null
  }
}

function finiteClamped(value: number, min: number, max: number, fallback: number) {
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

export function normalizeHairImportTransform(value: HairImportTransform): HairImportTransform {
  const move = HAIR_IMPORT_TRANSFORM_LIMITS.move
  const rotate = HAIR_IMPORT_TRANSFORM_LIMITS.rotate
  const uniformScale = HAIR_IMPORT_TRANSFORM_LIMITS.uniformScale
  const axisScale = HAIR_IMPORT_TRANSFORM_LIMITS.axisScale
  return {
    move: {
      x: finiteClamped(value.move.x, move.min, move.max, 0),
      y: finiteClamped(value.move.y, move.min, move.max, 0),
      z: finiteClamped(value.move.z, move.min, move.max, 0)
    },
    rotate: {
      x: finiteClamped(value.rotate.x, rotate.min, rotate.max, 0),
      y: finiteClamped(value.rotate.y, rotate.min, rotate.max, 0),
      z: finiteClamped(value.rotate.z, rotate.min, rotate.max, 0)
    },
    uniformScale: finiteClamped(value.uniformScale, uniformScale.min, uniformScale.max, 1),
    axisScale: {
      x: finiteClamped(value.axisScale.x, axisScale.min, axisScale.max, 1),
      y: finiteClamped(value.axisScale.y, axisScale.min, axisScale.max, 1),
      z: finiteClamped(value.axisScale.z, axisScale.min, axisScale.max, 1)
    }
  }
}

function invalidateGeneratedHair(state: HairImportUiState) {
  return {
    ...state,
    proposals: null,
    motionRegionSelections: null,
    motionPaint: null
  }
}

export function chooseHairImportFile(
  state: HairImportUiState,
  file: HairImportFileSelection
): HairImportUiState {
  return {
    ...createHairImportUiState(),
    file
  }
}

export function acceptHairImportInspection(
  state: HairImportUiState,
  inspection: HairImportInspection
): HairImportUiState {
  return {
    ...state,
    step: 'inspect',
    inspection,
    selectedObjectIds: inspection.objects
      .filter((entry) => entry.recommendedHair)
      .map((entry) => entry.id),
    transform: normalizeHairImportTransform(inspection.initialTransform),
    motionRegionSelections: null,
    motionPaint: null,
    proposals: null
  }
}

export function toggleHairImportObject(
  state: HairImportUiState,
  objectId: string,
  selected: boolean
): HairImportUiState {
  if (!state.inspection?.objects.some((entry) => entry.id === objectId)) return state
  const selectedIds = new Set(state.selectedObjectIds)
  if (selected) selectedIds.add(objectId)
  else selectedIds.delete(objectId)
  return {
    ...invalidateGeneratedHair(state),
    step: 'inspect',
    selectedObjectIds: [...selectedIds].sort()
  }
}

export function updateHairImportTransform(
  state: HairImportUiState,
  transform: HairImportTransform
): HairImportUiState {
  return {
    ...invalidateGeneratedHair(state),
    step: 'fit',
    transform: normalizeHairImportTransform(transform)
  }
}

export function acceptHairImportProposals(
  state: HairImportUiState,
  proposals: HairImportProposalSet
): HairImportUiState {
  return {
    ...state,
    step: 'physics',
    proposals,
    motionRegionSelections: state.motionPaint
      ? null
      : proposals.motionReview.regions.map((region) => ({
          id: region.id,
          moving: region.moving
        }))
  }
}

export function updateHairImportMotionRegion(
  state: HairImportUiState,
  regionId: string,
  moving: boolean
): HairImportUiState {
  const proposals = state.proposals
  if (!proposals) return state
  const region = proposals.motionReview.regions.find((entry) => entry.id === regionId)
  if (!region || (moving && !region.supportsMotion)) {
    return state
  }
  return {
    ...state,
    proposals: {
      ...proposals,
      motionReview: {
        ...proposals.motionReview,
        regions: proposals.motionReview.regions.map((region) =>
          region.id === regionId ? { ...region, moving } : region
        )
      }
    },
    motionRegionSelections: proposals.motionReview.regions.map((region) => ({
      id: region.id,
      moving: region.id === regionId ? moving : region.moving
    }))
  }
}

export function updateHairImportMotionPaint(
  state: HairImportUiState,
  motionPaint: HairMotionPaintV1 | null
): HairImportUiState {
  return {
    ...state,
    motionPaint,
    motionRegionSelections: null
  }
}

export function canContinueHairImport(state: HairImportUiState) {
  switch (state.step) {
    case 'choose':
      return state.file !== null
    case 'inspect':
      return state.inspection !== null && state.selectedObjectIds.length > 0
    case 'fit':
      return state.inspection !== null && state.selectedObjectIds.length > 0
    case 'physics':
      return state.proposals !== null
    case 'finalize':
      return false
  }
}

export function advanceHairImportStep(state: HairImportUiState): HairImportUiState {
  if (!canContinueHairImport(state)) return state
  const next: Partial<Record<HairImportStepId, HairImportStepId>> = {
    inspect: 'fit',
    physics: 'finalize'
  }
  const step = next[state.step]
  return step ? { ...state, step } : state
}

export function returnToPreviousHairImportStep(state: HairImportUiState): HairImportUiState {
  const previous: Partial<Record<HairImportStepId, HairImportStepId>> = {
    inspect: 'choose',
    fit: 'inspect',
    physics: 'fit',
    finalize: 'physics'
  }
  const step = previous[state.step]
  return step ? { ...state, step } : state
}

export function buildHairImportPreviewRequest(state: HairImportUiState): HairImportPreviewRequest {
  if (!state.inspection || state.selectedObjectIds.length === 0) {
    throw new Error('Inspect the file and keep at least one Hair object before building a preview.')
  }
  return {
    sessionId: state.inspection.sessionId,
    selectedObjectIds: [...state.selectedObjectIds].sort(),
    transform: normalizeHairImportTransform(state.transform),
    motionRegionSelections: state.motionRegionSelections,
    motionPaint: state.motionPaint
  }
}

export function buildHairImportFinalizeRequest(
  state: HairImportUiState
): HairImportFinalizeRequest {
  if (state.step !== 'finalize' || !state.proposals) {
    throw new Error('Finish Hair Physics before saving the hair style.')
  }
  if (!state.inspection) {
    throw new Error('The finished Hair candidate has no import session.')
  }
  return { sessionId: state.inspection.sessionId }
}
