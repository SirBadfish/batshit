import * as THREE from 'three'
import { logger } from '$lib/utils/logger'
import { WebGPURenderer, type PointsNodeMaterial } from 'three/webgpu'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js'
import { GroundedSkybox } from 'three/addons/objects/GroundedSkybox.js'
import {
  VRM,
  MToonMaterialLoaderPlugin,
  VRMLoaderPlugin,
  VRMExpressionPresetName,
  VRMHumanBoneName,
  type VRMLookAtBoneApplier
} from '@pixiv/three-vrm'
import { MToonNodeMaterial } from '@pixiv/three-vrm/nodes'
import {
  VRMAnimationLoaderPlugin,
  VRMLookAtQuaternionProxy,
  createVRMAnimationClip
} from '@pixiv/three-vrm-animation'
import type {
  GoonBasePosture,
  GoonCamera,
  GoonCameraMode,
  GoonCompatibilityReport,
  GoonCueKind,
  GoonCueDefinition,
  GoonEyeContactMode,
  GoonEyeContactTuning,
  ResolvedGoonEyeContactTuning,
  GoonEmoteStep,
  GoonEnvelopeEasing,
  GoonExpressionPreset,
  GoonExpressionTarget,
  GoonFileRef,
  GoonGuidedOutfitPiece,
  GoonPaintedConcealMask,
  GoonPosture,
  GoonPostureMap,
  GoonRawMorphTarget,
  GoonRoomShellBuilder,
  GoonSceneAmbience,
  GoonScenePlacement,
  GoonSceneRoomShellTransform,
  GoonSceneCameraBoundary,
  GoonSceneMarker,
  GoonSceneMarkers,
  GoonSceneProp,
  GoonXWearData
} from '$lib/types/goons'
import type { GoonLipSyncMode } from '$lib/types/voice'
import {
  resolveEyeContactChannels,
  resolveEyeLookRuntimeLane as resolveEyeLookRuntimeLaneRule,
  resolveEyeLookExpressionWeights
} from '$lib/goons/eyeContact'
import type { EyeContactTravelDirection } from '$lib/goons/eyeContact'
import {
  BUILTIN_GOON_POSTURES,
  resolveBasePosture
} from '$lib/goons/postures'
import { DEFAULT_TRIM_TEXTURE } from '$lib/goons/roomTextures'
import {
  RoomShellGeometryBuilder,
  normalizeGoonRoomShellBuilder,
  type NormalizedRoomShellBuilder,
  type NormalizedRoomSurfaceSide,
  type RoomShellTextureSet
} from '$lib/goons/roomShellGeometry'
import { createAmbientBlinkState, updateAmbientBlinkState } from '$lib/goons/ambientBlink'
import { GOON_SEMANTIC_EXPRESSION_CONTROLS } from '$lib/goons/semanticExpressions'
import {
  normalizeGoonSceneAmbience,
  type NormalizedGoonSceneAmbience
} from '$lib/goons/sceneAmbience'
import {
  createGoonSceneAmbienceSpriteLayer,
  resolveGoonSceneAmbienceBounds,
  type GoonSceneAmbienceBounds
} from '$lib/goons/sceneAmbienceRuntime'
import {
  normalizeRoomShellTransform,
  type NormalizedRoomShellTransform
} from '$lib/goons/roomShellTransform'
import {
  normalizeRoomCameraBoundary,
  type NormalizedGoonSceneCameraBoundary
} from '$lib/goons/roomCameraBoundary'
import {
  DEFAULT_GROUND_PROJECTION_LINE,
  normalizeGroundProjectionLine,
  reapplyGroundProjectionLineToGeometry
} from '$lib/goons/sceneSkybox'
import {
  GOON_CINEMATIC_WHEEL_ZOOM_SENSITIVITY,
  clampCameraPositionToPaddedBox,
  pointerClientToNdc,
  resolveCinematicGoonZoomTarget,
  resolveGoonRelativeRecenter,
  resolveGoonFraming,
  resolveHybridCameraZoom,
  resolveHybridCameraZoomAtPosition,
  resolvePerspectivePinnedPointZoom,
  resolvePerspectiveNearPlaneClearance,
  resolvePerspectiveScreenPanDelta,
  resolveSceneAwareFreeCameraDistanceLimits,
  type GoonFramingPreset
} from '$lib/goons/cameraNavigation'
import { resolveGoonSkyboxTextureBudget } from '$lib/goons/skyboxQuality'
import {
  type GoonFaceControl,
  type FaceControlMapping,
  type VRMSourceType,
  detectVRMSource,
  getFaceControlMapping,
  resolveMappedFaceControls,
  resolveRawMorphTargets,
  resolveFaceControls,
  resolveSpeakingFaceControl,
  shouldApplyMoodFaceLayer,
  stepFaceLayerBlend,
  getEyelidsValue,
  isDirectionControl
} from '$lib/goons/faceControls'
import {
  hexToLinearRgb,
  isBodySkinClosetSlotMaterialName,
  linearRgbToHex
} from '$lib/goons/closetMaterials'
import {
  expandPaintedTriangleRanges,
  normalizePaintedConcealMask
} from '$lib/goons/paintedConcealMasks'
import {
  DEFAULT_GOON_LIP_SYNC_MODE,
  downmixGoonLipSyncFrameToLegacy,
  getGoonLipSyncOpenness,
  getLegacyGoonLipSyncOpenness,
  isTimelineOwnedGoonLipSyncSource,
  sampleGoonLipSyncTimeline,
  type GoonLipSyncAnalyzerId,
  type GoonLipSyncTimeline,
  type LegacyGoonLipSyncWeights
} from '$lib/utils/goonLipSync'
import {
  RHUBARB_9_SPEECH_FACE_PROFILE,
  createEmptyGoonSpeechFaceFrame,
  scaleGoonSpeechFaceFrame,
  type Arkit52Channel,
  type Audio2FaceTongueChannel,
  type GoonSpeechFaceFrame
} from '$lib/goons/speechFaceProfiles'
import { getXWearMaterials, resolveXWearLayersForMaterial } from '$lib/utils/xwear'
import { findNearestValidStandingPoint } from '$lib/goons/standing'
import {
  probeNearestStandingSurfaceY,
  probeStandingSurfaceY
} from '$lib/goons/standingSurface'
import {
  captureMarkerFromAvatarPlacement,
  rebindMarkerPreservingWorldPlacement,
  resolveMarkerWorldPosition as resolveMarkerWorldPositionFromParent,
  resolveMarkerWorldYaw
} from '$lib/goons/markerTransforms'
import {
  extractEmbeddedCustomAvatarManifest,
  resolveCustomPerformanceRigBlock,
  resolveCustomNamedNode,
  resolveCustomFaceControlBindings,
  resolveCustomExpressionBindingContract,
  resolveCustomFaceMeshes,
  resolveCustomFaceMeshNames,
  resolveCustomMorphDefinitions,
  resolveCustomArkitFaceBindings,
  resolveCustomSpeechFaceProfile,
  sanitizeCustomRuntimeNodeName,
  type GoonCustomAvatarManifest,
  type ResolvedCustomExpressionBinding
} from '$lib/goons/customAvatar'
import {
  isCustomCompatibleMouthPreset,
  resolveDirectCustomArkitFaceDriverWeights,
  resolveCustomLipSyncPresetWeights,
  resolveCustomMouthPresetSupport,
  resolveCustomRigCompatibilityCoverage,
  type CustomMouthPresetSupport
} from '$lib/goons/customCompatibility'
import {
  bindCustomPerformanceRig,
  composeCustomPerformanceEyeContact,
  hasCustomPerformanceAuthoredEyeDirection,
  NEUTRAL_CUSTOM_PERFORMANCE_DIRECTION,
  resolveCustomPerformanceDirection,
  resolveCustomPerformanceEyeContactState,
  resolveCustomPerformanceRigManifest,
  resolveFaceControlEyeLookPresetWeights,
  resolveFinalCustomTargetWeights,
  resolveSocketEyeBlinkClosureTargetWeights,
  shouldApplyCustomExpressionMorphPreset,
  type CustomPerformanceDirection,
  type CustomPerformanceRigRuntime
} from '$lib/goons/customPerformanceRig'
import {
  normalizeBodyDialValues,
  parseBodyDialsManifest,
  resolveBodyDialState,
  type BodyDialsManifest
} from '$lib/goons/bodyDials'
import {
  AppearanceDialsEngineRuntime
} from '$lib/goons/appearanceDials.engine'
import type {
  AppearanceDialValueState,
  AppearanceDialsManifest
} from '$lib/goons/appearanceDials'
import { FacialArtworkEngineRuntime } from '$lib/goons/facialArtwork.engine'
import {
  type FacialArtworkDefinitionV4,
  type FacialArtworkStateV4
} from '$lib/goons/facialArtwork'
import { EyeAppearanceEngineRuntime } from '$lib/goons/eyeAppearance.engine'
import {
  type EyeAppearanceDefinitionV3,
  type EyeAppearanceStateV3
} from '$lib/goons/eyeAppearance'
import { OralAppearanceEngineRuntime } from '$lib/goons/oralAppearance.engine'
import {
  parseOralAppearanceDefinition,
  type OralAppearanceDefinitionV1,
  type OralAppearanceStateV1
} from '$lib/goons/oralAppearance'
import { classifyFacialArtworkPackageCapability } from '$lib/goons/facialArtwork.package'
import { parseFirstPartySocketEyePackage } from '$lib/goons/socketEyePackage'
import {
  SocketEyeSurfaceEngineRuntime,
  type SocketEyeCompositeVisualState
} from '$lib/goons/socketEyeSurface.engine'
import type { SocketEyeSurfaceDefinitionV1 } from '$lib/goons/socketEyeSurface'
import type { EyeApertureSeamDefinitionV1 } from '$lib/goons/eyeApertureSeam'
import {
  resolveSocketEyeLookTargetWeights,
  resolveSocketEyeGaze,
  resolveSocketEyeHeadAssist,
  smoothSocketEyeHeadAssist,
  SOCKET_EYE_LOOK_TARGETS,
  type SocketEyeCoordinates
} from '$lib/goons/socketEyeGaze'
import {
  resolveSocketEyeContactSettings,
  socketEyeContactResponseLerp,
  type SocketEyeContactSettingsV2
} from '$lib/goons/socketEyeContact'
import {
  buildGoonRendererConstructionOptions,
  shouldRetryGoonRendererWithWebGL2
} from '$lib/goons/goonRendererRequirements'
import {
  evaluateJointCorrectives,
  parseJointCorrectives,
  resolveDriverAngleDeg,
  type CorrectiveQuat,
  type JointCorrectiveDriver,
  type JointCorrectivesSpec
} from '$lib/goons/jointCorrectives'
import {
  evaluateLiveJointCorrectiveAngles,
  parseLiveJointCorrectivesFromManifest,
  type LiveJointCorrectivesSpec
} from '$lib/goons/liveJointCorrectives'
import {
  parseGoonLiveManifestFromAvatarManifest,
  verifyGoonLiveManifest
} from '$lib/goons/recipe/liveManifestContracts'
import { cloneGeometryForBodyConceal } from '$lib/goons/bodyConcealGeometry'
import type { GoonStageHost } from '$lib/goons/stageScene'

const VRM_PRESET_NAMES = new Set(Object.values(VRMExpressionPresetName))
const ORBIT_FLOOR_CLEARANCE_ANGLE = THREE.MathUtils.degToRad(1)
const ORBIT_FLOOR_BUFFER = THREE.MathUtils.degToRad(8)
const STANDING_BLOCKER_MARGIN = 0.18
const STANDING_VERTICAL_MARGIN = 0.08
const STANDING_SEARCH_STEP = 0.16
const STANDING_SEARCH_DIRECTIONS = 24
const BODY_CONCEAL_NAME_RE = /(^|[\s_.-])(body|skin|torso)([\s_.-]|$)/i
const BODY_CONCEAL_EXCLUDED_NAME_RE =
  /(^|[\s_.-])(hair|brow|brows|lash|lashes|eye|eyes|teeth|tooth|tongue|cloth|clothes|outfit|jacket|shirt|top|bottom|pants|skirt|shoe|shoes|boot|boots|hat|glove|gloves|earphone|swim|suit|dress)([\s_.-]|$)/i
const STANDING_SURFACE_CLEARANCE = 0.01
const STANDING_SURFACE_MIN_NORMAL_Y = 0.35
const STANDING_SURFACE_PROBE_PADDING = 0.6
const GROUNDED_SKYBOX_HEIGHT = 2
const GROUNDED_SKYBOX_RESOLUTION = 128
const POSTURE_TRANSITION_MS = 180
const AMBIENT_BLINK_SUPPRESS_THRESHOLD = 0.3
const FAST_LIP_SYNC_NOISE_FLOOR = 0.02
const FAST_LIP_SYNC_NOISE_CEILING = 0.17
const FAST_LIP_SYNC_ATTACK = 0.34
const FAST_LIP_SYNC_RELEASE = 0.18
const PRECOMPUTED_LIP_SYNC_VRM_INTENSITY_SCALE = 0.7
const PRECOMPUTED_LIP_SYNC_CUSTOM_INTENSITY_SCALE = 1
const MOOD_FACE_BLEND_DURATION_MS = 500
const VRM_MOUTH_PRESET_ORDER: GoonExpressionPreset[] = [
  VRMExpressionPresetName.Aa,
  VRMExpressionPresetName.Ih,
  VRMExpressionPresetName.Ou,
  VRMExpressionPresetName.Ee,
  VRMExpressionPresetName.Oh
]
export type GoonEngineQuality = 'auto' | 'low' | 'high' | 'ultra'
export type GoonZoomTarget = 'hips' | 'head' | 'feet'
export type GoonStageAnchorName = GoonZoomTarget
export type GoonRendererBackend = 'webgpu' | 'fallback-webgl2' | 'unsupported'
export type GoonRendererEnvironment = {
  navigatorGpuAvailable: boolean
  embeddedWebKitRuntime: boolean
  userAgent: string
}
export type GoonRendererRuntime = {
  backend: GoonRendererBackend
  label: string
  message?: string
  environment?: GoonRendererEnvironment
}

export type GoonEditTransform = {
  position: [number, number, number]
  rotation: [number, number, number]
  scale: [number, number, number]
}

export type GoonMarkerSnapshot = {
  position: [number, number, number]
  rotation: [number, number, number]
}

export type GoonBodyConcealTopologyMesh = {
  mesh: string
  topologySignature: string
  triangleCount: number
  vertexCount: number
}

export type GoonBodyConcealTopology = {
  topologySignature: string
  meshes: GoonBodyConcealTopologyMesh[]
}

export type GoonBodyConcealMeshPick = {
  mesh: string
  topologySignature: string
  triangleCount: number
  vertexCount: number
  faceIndex: number
  triangleIndices: number[]
}

export type GoonBodyConcealPick = GoonBodyConcealMeshPick & {
  mirroredPicks?: GoonBodyConcealMeshPick[]
}

export type GoonEngineOptions = {
  quality?: GoonEngineQuality
  lipSyncEnabled?: boolean
  eyeContactMode?: GoonEyeContactMode
  eyeContactTuning?: GoonEyeContactTuning
  socketEyeContact?: SocketEyeContactSettingsV2 | null
  cameraFov?: number
  forceWebGL2?: boolean
  debugRootMotion?: boolean
  onRuntimeStatus?: (status: GoonRendererRuntime) => void
  onCompatibility?: (report: GoonCompatibilityReport) => void
  onPerformance?: (stats: { fps: number }) => void
  onCameraChange?: (camera: GoonCamera) => void
  onEditTransformChange?: (transform: GoonEditTransform | null) => void
}

type GoonZoomPointer = {
  clientX: number
  clientY: number
}

type GoonZoomGesture =
  | { kind: 'default'; lastWheelAt: number }
  | {
      kind: 'goon'
      lastWheelAt: number
      pinnedPoint: THREE.Vector3
      pointerNdc: THREE.Vector2
    }

export type GoonAnimationSyncOptions = {
  deferredFiles?: GoonFileRef[]
}

export type GoonMountedRuntimeState = {
  camera: GoonCamera | null
  baseLoop: {
    name: string
    definition: GoonCueDefinition | null
    clipName: string | null
    time: number
  }
  oneShot: {
    clipName: string
    time: number
    restorePosture: GoonPosture | null
    preserveCamera: boolean
    overridePosture: GoonPosture | null
  } | null
  eyeContact: {
    enabled: boolean
    mode: GoonEyeContactMode
    tuning: ResolvedGoonEyeContactTuning
    applied: DirectionLookState
    socket?: SocketEyeContactSettingsV2
  }
  performance: {
    direction: CustomPerformanceDirection
    moodFaceBlend: number
    activeEmoteRemainingMs: number
    expressions: Array<
      Omit<ActiveExpression, 'endsAt' | 'startTime' | 'stepStartTime'> & {
        remainingMs: number
        elapsedMs: number
        stepElapsedMs: number
      }
    >
  }
  speech: {
    speaking: boolean
    pausedForCue: boolean
    timeline: GoonLipSyncTimeline | null
    analyzerId: GoonLipSyncAnalyzerId
    durationMs: number | null
    elapsedMs: number
  }
}

type GoonMaterialColorInfo = {
  baseHex?: string
  shadeHex?: string
  emissiveHex?: string
  outlineHex?: string
}

type BoneMap = Partial<Record<VRMHumanBoneName, THREE.Object3D>>

type BoneLookAtRangeMapScales = {
  horizontalInner: number
  horizontalOuter: number
  verticalDown: number
  verticalUp: number
}

type LookAtRangeMapApplier = Pick<
  VRMLookAtBoneApplier,
  'rangeMapHorizontalInner' | 'rangeMapHorizontalOuter' | 'rangeMapVerticalDown' | 'rangeMapVerticalUp'
>

type MaterialOriginalState = {
  map?: THREE.Texture | null
  shadeMultiplyTexture?: THREE.Texture | null
  normalMap?: THREE.Texture | null
  emissiveMap?: THREE.Texture | null
  matcapTexture?: THREE.Texture | null
  rimMultiplyTexture?: THREE.Texture | null
  outlineWidthMultiplyTexture?: THREE.Texture | null
  uvAnimationMaskTexture?: THREE.Texture | null
  shadingShiftTexture?: THREE.Texture | null
  color?: THREE.Color
  shadeColorFactor?: THREE.Color
  emissive?: THREE.Color
  matcapFactor?: THREE.Color
  parametricRimColorFactor?: THREE.Color
  outlineColorFactor?: THREE.Color
  normalScale?: THREE.Vector2
  shadingShiftFactor?: number
  shadingShiftTextureScale?: number
  shadingToonyFactor?: number
  giEqualizationFactor?: number
  rimLightingMixFactor?: number
  parametricRimFresnelPowerFactor?: number
  parametricRimLiftFactor?: number
  outlineWidthMode?: string
  outlineWidthFactor?: number
  outlineLightingMixFactor?: number
  uvAnimationScrollXSpeedFactor?: number
  uvAnimationScrollYSpeedFactor?: number
  uvAnimationRotationSpeedFactor?: number
  side?: THREE.Side
  transparent?: boolean
  opacity?: number
  alphaTest?: number
  alphaToCoverage?: boolean
}

const MATERIAL_TEXTURE_STATE_KEYS = [
  'map',
  'shadeMultiplyTexture',
  'normalMap',
  'emissiveMap',
  'matcapTexture',
  'rimMultiplyTexture',
  'outlineWidthMultiplyTexture',
  'uvAnimationMaskTexture',
  'shadingShiftTexture'
] as const satisfies readonly (keyof MaterialOriginalState)[]

type MaterialTextureStateKey = (typeof MATERIAL_TEXTURE_STATE_KEYS)[number]

const MATERIAL_RUNTIME_TEXTURE_KEYS = [
  ...MATERIAL_TEXTURE_STATE_KEYS,
  'alphaMap',
  'aoMap',
  'bumpMap',
  'displacementMap',
  'lightMap',
  'metalnessMap',
  'roughnessMap',
  'envMap'
] as const

type BodyConcealRuntimeMesh = {
  meshName: string
  mesh: THREE.Mesh | THREE.SkinnedMesh
  originalIndexArray: Uint16Array | Uint32Array
  topologySignature: string
  triangleCount: number
  vertexCount: number
  mirrorCenterX: number
}

type BodyConcealTriangleCollection = {
  faceIndex: number
  triangleIndices: number[]
}

type ActiveExpressionStep = {
  targets: Array<{ preset: ResolvedExpressionPreset; weight: number }>
  faceControls: GoonFaceControl[]
  rawMorphTargets: GoonRawMorphTarget[]
  attackMs: number
  holdMs: number
  releaseMs: number
}

type ActiveExpression = {
  name: string
  kind: GoonCueKind
  intensity: number
  endsAt: number
  targets: Array<{ preset: ResolvedExpressionPreset; weight: number }>
  faceControls: GoonFaceControl[]
  rawMorphTargets: GoonRawMorphTarget[]
  startTime: number
  attackMs: number
  holdMs: number
  releaseMs: number
  easing: GoonEnvelopeEasing
  /** Multi-step data — when present, steps play sequentially instead of using top-level targets */
  steps?: ActiveExpressionStep[]
  currentStep: number
  stepStartTime: number
}

type FaceMorphBinding = {
  mesh: THREE.Mesh
  dict: Record<string, number>
}

type AnimationSource = 'vrm' | 'goon' | 'vrma'

type ResolvedExpressionPreset = GoonExpressionPreset

type DirectionLookState = {
  headYaw: number
  headPitch: number
  eyeYaw: number
  eyePitch: number
}

function applyExpressionDirection(
  look: DirectionLookState,
  preset: ResolvedExpressionPreset,
  weight: number
) {
  if (preset === 'lookLeftHead') {
    look.headYaw += weight
    return true
  }
  if (preset === 'lookRightHead') {
    look.headYaw -= weight
    return true
  }
  if (preset === 'lookUpHead') {
    look.headPitch -= weight
    return true
  }
  if (preset === 'lookDownHead') {
    look.headPitch += weight
    return true
  }
  if (preset === VRMExpressionPresetName.LookLeft) {
    look.eyeYaw += weight
    return true
  }
  if (preset === VRMExpressionPresetName.LookRight) {
    look.eyeYaw -= weight
    return true
  }
  if (preset === VRMExpressionPresetName.LookUp) {
    look.eyePitch -= weight
    return true
  }
  if (preset === VRMExpressionPresetName.LookDown) {
    look.eyePitch += weight
    return true
  }
  return false
}

function applyFaceControlDirection(
  look: DirectionLookState,
  control: GoonFaceControl['control'],
  value: number
) {
  if (control === 'head_leftright') {
    look.headYaw -= value
    return true
  }
  if (control === 'head_updown') {
    look.headPitch -= value
    return true
  }
  if (control === 'eyes_leftright') {
    look.eyeYaw -= value
    return true
  }
  if (control === 'eyes_updown') {
    look.eyePitch -= value
    return true
  }
  return false
}

type PendingAnimationRequest = {
  kind: 'mood' | 'generic'
  cueName: string
  definition?: GoonCueDefinition
  requestedAt: number
}

type PropLocalBounds = {
  min: THREE.Vector3
  max: THREE.Vector3
}

type RoomBounds = {
  minX: number
  maxX: number
  minY: number
  maxY: number
  minZ: number
  maxZ: number
}

type PosturePlacement = {
  position: THREE.Vector3
  rotationY?: number
}

type PlacementOptions = {
  preserveCamera?: boolean
  preservePlacement?: boolean
}

type AnchorTransition = {
  startTime: number
  durationMs: number
  fromPosition: THREE.Vector3
  toPosition: THREE.Vector3
  fromRotationY: number
  toRotationY: number
  fromTarget: THREE.Vector3
  toTarget: THREE.Vector3
  fromCamera: THREE.Vector3
  toCamera: THREE.Vector3
  preserveCamera: boolean
}

type AmbienceDirection = 'fall' | 'rise' | 'float'

type AmbiencePresetRuntime = {
  color: number
  count: [number, number]
  size: [number, number]
  opacity: number
  verticalSpeed: number
  horizontalSpeed: number
  direction: AmbienceDirection
  jitter: number
  pulse?: boolean
  additive?: boolean
}

type SceneAmbienceRuntime = {
  config: NormalizedGoonSceneAmbience
  preset: AmbiencePresetRuntime
  object: THREE.Sprite
  material: PointsNodeMaterial
  positionAttribute: THREE.InstancedBufferAttribute
  sprite: THREE.Texture | null
  positions: Float32Array
  velocities: Float32Array
  phases: Float32Array
  bounds: GoonSceneAmbienceBounds
  random: () => number
}

const AMBIENCE_PRESET_RUNTIME: Record<
  NormalizedGoonSceneAmbience['preset'],
  AmbiencePresetRuntime
> = {
  rain: {
    color: 0x9fb7c8,
    count: [220, 620],
    size: [0.024, 0.18],
    opacity: 0.5,
    verticalSpeed: 8,
    horizontalSpeed: 0.8,
    direction: 'fall',
    jitter: 0.12
  },
  snow: {
    color: 0xdbe7ef,
    count: [140, 420],
    size: [0.075, 0.075],
    opacity: 0.72,
    verticalSpeed: 0.7,
    horizontalSpeed: 0.45,
    direction: 'fall',
    jitter: 0.6
  },
  embers: {
    color: 0xff8a3d,
    count: [45, 160],
    size: [0.06, 0.085],
    opacity: 0.78,
    verticalSpeed: 0.9,
    horizontalSpeed: 0.35,
    direction: 'rise',
    jitter: 0.8,
    pulse: true,
    additive: true
  },
  fireflies: {
    color: 0xdfff8a,
    count: [24, 90],
    size: [0.1, 0.1],
    opacity: 0.82,
    verticalSpeed: 0.18,
    horizontalSpeed: 0.42,
    direction: 'float',
    jitter: 1,
    pulse: true,
    additive: true
  },
  dust: {
    color: 0xd4c6a4,
    count: [60, 210],
    size: [0.055, 0.055],
    opacity: 0.35,
    verticalSpeed: 0.12,
    horizontalSpeed: 0.18,
    direction: 'float',
    jitter: 0.55
  },
  petals: {
    color: 0xffb5c6,
    count: [35, 140],
    size: [0.08, 0.12],
    opacity: 0.66,
    verticalSpeed: 0.55,
    horizontalSpeed: 0.38,
    direction: 'fall',
    jitter: 1.1
  },
  magic_sparks: {
    color: 0x9cc7ff,
    count: [55, 180],
    size: [0.07, 0.07],
    opacity: 0.82,
    verticalSpeed: 0.42,
    horizontalSpeed: 0.5,
    direction: 'float',
    jitter: 1.2,
    pulse: true,
    additive: true
  },
  mist: {
    color: 0xc7d0d6,
    count: [70, 190],
    size: [0.22, 0.12],
    opacity: 0.22,
    verticalSpeed: 0.08,
    horizontalSpeed: 0.22,
    direction: 'float',
    jitter: 0.3
  }
}

export class GoonEngine implements GoonStageHost {
  private transparentTexture: THREE.DataTexture | null = null
  private goonVisible = true
  private container: HTMLElement
  private renderer?: WebGPURenderer
  private initPromise: Promise<void> | null = null
  private requiredMaxTextureArrayLayers = 0
  private activeMaxTextureArrayLayersRequirement = 0
  private sceneLightingInitialized = false
  private scene = new THREE.Scene()
  private sceneRoot = new THREE.Group()
  private skyboxScene = new THREE.Scene()
  private skyboxCamera = new THREE.PerspectiveCamera(70, 1, 0.1, 200)
  private groundedSkyboxScene = new THREE.Scene()
  private groundedSkyboxCamera = new THREE.PerspectiveCamera(30, 1, 0.03, 200)
  private skyboxMesh: THREE.Mesh | null = null
  private skyboxTexture: THREE.Texture | null = null
  private skyboxUrl: string | null = null
  private skyboxToken = 0
  private skyboxYaw = 0
  private skyboxPitch = 0
  private skyboxPitchOffset = 0
  private skyboxActive = false
  private groundedSkybox: GroundedSkybox | null = null
  private groundedSkyboxCanonicalUv: Float32Array | null = null
  private groundedSkyboxEnabled = false
  private groundedSkyboxRadius = 0
  private groundProjectionLine = DEFAULT_GROUND_PROJECTION_LINE
  private roomShell: THREE.Object3D | null = null
  private roomShellUrl: string | null = null
  private roomShellToken = 0
  private roomShellTransform: NormalizedRoomShellTransform = normalizeRoomShellTransform()
  private roomCameraBoundary: NormalizedGoonSceneCameraBoundary | null = null
  private roomShellBuilder: GoonRoomShellBuilder | null = null
  private roomShellBuilderObject: THREE.Group | null = null
  private roomShellBuilderTextures: THREE.Texture[] = []
  private roomShellBuilderToken = 0
  private roomShellGeometry = new RoomShellGeometryBuilder()
  private sceneProps: GoonSceneProp[] = []
  private sceneMarkers: GoonSceneMarkers = {}
  private sceneAmbienceRuntime: SceneAmbienceRuntime | null = null
  private postureDefinitions: GoonPostureMap = { ...BUILTIN_GOON_POSTURES }
  private propObjects = new Map<string, THREE.Object3D>()
  private propLocalBounds = new Map<string, PropLocalBounds>()
  private propToken = 0
  private panOffset = new THREE.Vector3()
  private markerAnchor = new THREE.Vector3()
  private markerAuthoringVerticalOffset = 0
  private hasMarkerAnchor = false
  private anchorTransition: AnchorTransition | null = null
  private builderBounds: RoomBounds | null = null
  private shellBounds: RoomBounds | null = null
  private panEdgeMargin = 0.2
  private goonTargetOffset = new THREE.Vector3(0, 1.2, 0)
  private sceneRootOffsetY = 0
  private lookActive = false
  private peekState: { position: THREE.Vector3; target: THREE.Vector3 } | null = null
  private dragMode: 'none' | 'view' | 'goon' | 'pan' | 'camera-pan' = 'none'
  private dragLast = new THREE.Vector2()
  private dragPointerId: number | null = null
  private goonRotation = 0
  private camera = new THREE.PerspectiveCamera(30, 1, 0.03, 100)
  private controls?: any
  private transformControls?: any
  private transformControlsHelper?: THREE.Object3D
  private scaleAspectLock = true
  private scaleDragBaseline: THREE.Vector3 | null = null
  private suppressTransformObjectChange = false
  private editTarget:
    | { type: 'prop'; id: string }
    | { type: 'marker'; id: string; posture: GoonPosture }
    | null = null
  private markerEditHelper: THREE.Object3D | null = null
  private markerEditParent: THREE.Object3D | null = null
  private clock = new THREE.Timer()
  private vrm: VRM | null = null
  private customAvatarRoot: THREE.Object3D | null = null
  private customAvatarManifest: GoonCustomAvatarManifest | null = null
  private guidedDufOverlayRoot: THREE.Group | null = null
  private guidedOutfitPieceNodes = new Map<string, THREE.Object3D[]>()
  private guidedDufOverlayBonePairs: Array<{ baseBone: THREE.Bone; overlayBone: THREE.Bone }> = []
  private bodyConcealMeshes = new Map<string, BodyConcealRuntimeMesh>()
  private activeBodyConcealPaintedMasks: GoonPaintedConcealMask[] = []
  private bodyConcealRaycaster = new THREE.Raycaster()
  private bodyConcealPointer = new THREE.Vector2()
  private customStageAnchors: {
    head?: THREE.Object3D
    hips?: THREE.Object3D
    feet?: THREE.Object3D
    leftFoot?: THREE.Object3D
    rightFoot?: THREE.Object3D
  } = {}
  private mixer: THREE.AnimationMixer | null = null
  private animationMap = new Map<string, THREE.AnimationClip>()
  private animationMetadata = new Map<string, GoonFileRef['motionMeta'] | undefined>()
  private animationSources = new Map<string, AnimationSource>()
  private loadedAnimationUrls = new Set<string>()
  private baseAnimations: THREE.AnimationClip[] = []
  private materialMap = new Map<string, THREE.Material[]>()
  private originalMaterialState = new Map<string, MaterialOriginalState>()
  private materialRuntimeTextures = new Set<THREE.Texture>()
  private embeddedWebKitRuntime = false
  private textureBudgetLogCount = 0
  private textureLoader = new THREE.TextureLoader()
  private baseLoopAction: THREE.AnimationAction | null = null
  private baseLoopIsFallback = false
  private oneShotAction: THREE.AnimationAction | null = null
  private authoringPoseAction: THREE.AnimationAction | null = null
  private authoringPoseAnimationName: string | null = null
  private oneShotRestorePosture: GoonPosture | null = null
  private oneShotRestorePreserveCamera = false
  private animationOverrideActive = false
  private animationOverridePosture: GoonPosture | null = null
  private authoringPoseMode = false
  private animationWarnings: string[] = []
  private bones: BoneMap = {}
  private restRotations = new Map<VRMHumanBoneName, THREE.Quaternion>()
  private restPositions = new Map<VRMHumanBoneName, THREE.Vector3>()
  private rawRestRotations = new Map<VRMHumanBoneName, THREE.Quaternion>()
  private rawRestPositions = new Map<VRMHumanBoneName, THREE.Vector3>()
  private rootMotionTrackHints = new Set<string>()
  private rootMotionLockNodes: Array<{ node: THREE.Object3D; restX: number; restZ: number }> = []
  private forceWebGL2 = false
  private debugRootMotionEnabled = false
  private lastRootMotionDriftLogAt = 0
  private eyeLookDebugEnabled = false
  private eyeLookFreezeHeadEnabled = false
  private eyeLookDirectBoneDebugEnabled = false
  private lastEyeLookDebugAt = 0
  private loadToken = 0
  private goonLoadToken = 0
  private deferredAnimationQueue: GoonFileRef[] = []
  private deferredAnimationUrls = new Set<string>()
  private deferredLoading = false
  private deferredLoadRequested = false
  private deferredLoadToken = 0
  private deferredLoadBaseToken = 0
  private pendingAnimationRequests = new Map<string, PendingAnimationRequest>()
  private resizeObserver?: ResizeObserver
  private quality: GoonEngineQuality
  private lipSyncEnabled: boolean
  private lipSyncMode: GoonLipSyncMode = DEFAULT_GOON_LIP_SYNC_MODE
  private speaking = false
  private speechPausedForCue = false
  private activeEmoteUntil = 0
  private moodFaceBlend = 1
  private moodFaceBlendUpdatedAt = performance.now()
  private zoomTarget: GoonZoomTarget = 'hips'
  private zoomRaycaster = new THREE.Raycaster()
  private zoomGesture: GoonZoomGesture | null = null
  private baseLoop: string = 'base_stand'
  private baseLoopAnimationName: string | null = null
  private baseLoopPosture: GoonPosture = 'stand'
  private activeMood: GoonCueDefinition | null = null
  private moodExpressionTargets: Array<{ preset: ResolvedExpressionPreset; weight: number }> = []
  private moodExpressionIntensity = 1
  private activeExpressions: ActiveExpression[] = []
  private ambientBlinkState = createAmbientBlinkState(performance.now())
  private eyeContactEnabled = true
  private eyeContactMode: GoonEyeContactMode
  private eyeContactTuning: ResolvedGoonEyeContactTuning
  private eyeContactBlend = 1
  private lookAtOverrideActive = false
  private lookAtRestoreAutoUpdate = true
  private lookAtRestoreTarget: THREE.Object3D | null = null
  private lookAtRangeMapBaseScales = new WeakMap<
    LookAtRangeMapApplier,
    BoneLookAtRangeMapScales
  >()
  private hasBodyAnimations = false
  private hasMouthBlendshapes = false
  private hasExpressionBlendshapes = false
  private availableMouthPresets = new Set<GoonExpressionPreset>()
  private customMouthPresetSupport: CustomMouthPresetSupport = {
    mode: 'none',
    profile: null,
    availablePresets: []
  }
  private faceMorphBindings: FaceMorphBinding[] = []
  private faceMorphTargetNames: string[] = []
  private authorableRawMorphTargetNames: string[] = []
  private faceControlMorphNames: string[] = []
  private mouthExpressionMorphTargetNames = new Set<string>()
  private customExpressionMorphMap = new Map<
    GoonExpressionPreset,
    ResolvedCustomExpressionBinding[]
  >()
  private customFaceControlMap: Record<string, FaceControlMapping> | null = null
  private customMorphDefinitions: Array<{ id: string; morphTargets: string[] }> = []
  private customArkitFaceDriverBindings: {
    face: Map<Arkit52Channel, string[]>
    tongue: Map<Audio2FaceTongueChannel, string[]> | null
  } | null = null
  private customFaceManifestIssues: string[] = []
  private customPerformanceRigRuntime: CustomPerformanceRigRuntime | null = null
  private customPerformanceDirection: CustomPerformanceDirection = {
    ...NEUTRAL_CUSTOM_PERFORMANCE_DIRECTION
  }
  private customPerformanceTargetWeights = new Map<string, number>()
  private guidedManifestOverlay: GoonCustomAvatarManifest | null = null
  private faceControlSummaryLog = ''
  private lastAppliedRawMorphTargets: string[] = []
  private vrmSource: VRMSourceType = 'unknown'
  private moodFaceControls: GoonFaceControl[] = []
  private moodRawMorphTargets: GoonRawMorphTarget[] = []
  private authoringPreviewExpressionTargets: Array<{ preset: ResolvedExpressionPreset; weight: number }> = []
  private authoringPreviewIntensity = 1
  private authoringPreviewFaceControls: GoonFaceControl[] = []
  private authoringPreviewRawMorphTargets: GoonRawMorphTarget[] = []
  // -------------------------------------------------- body dials (SA-090)
  private bodyDialsManifest: BodyDialsManifest | null = null
  private bodyDialsValues: Record<string, number> | null = null
  private bodyDialsBindings: Array<{ mesh: THREE.Mesh; rawDict: Record<string, number> }> = []
  private bodyDialsOwnedTargets = new Set<string>()
  private bodyDialsAppliedTargets = new Set<string>()
  private bodyDialsRawMorphWarned = new Set<string>()
  private bodyDialsBones: Map<
    string,
    {
      node: THREE.Object3D
      baseLocalPosition: THREE.Vector3
      parentBaseRelQuaternion: THREE.Quaternion
      parentKey: string | null
    }
  > | null = null
  private bodyDialsSkins: Array<{ mesh: THREE.SkinnedMesh; baseInverses: THREE.Matrix4[] }> = []
  private bodyDialsHipsRemap: {
    node: THREE.Object3D
    baseRest: THREE.Vector3
    newRest: THREE.Vector3
    ratio: number
    lastOutput: THREE.Vector3 | null
  } | null = null
  private bodyDialsHeadFollow: Array<{
    node: THREE.Object3D
    basePosition: THREE.Vector3
    baseScale: THREE.Vector3
    pivotLocal: THREE.Vector3
  }> = []
  private bodyDialsRootBase: { scale: THREE.Vector3; positionY: number } | null = null
  // dial-resolved state cached for the per-frame corrective composition
  private bodyDialsResolvedInfluences = new Map<string, number>()
  private bodyDialsNormalizedValues: Record<string, number> = {}
  // ------------------------------- appearance dials v2 (first-party lane)
  private appearanceDialsRuntime: AppearanceDialsEngineRuntime | null = null
  private appearanceDialsManifest: AppearanceDialsManifest | null = null
  private appearanceDialsValues: AppearanceDialValueState | null = null
  private appearanceDialsOwnedTargets = new Set<string>()
  private facialArtworkRuntime: FacialArtworkEngineRuntime | null = null
  private facialArtworkDefinition: FacialArtworkDefinitionV4 | null = null
  private facialArtworkState: FacialArtworkStateV4 | null = null
  private eyeAppearanceRuntime: EyeAppearanceEngineRuntime | null = null
  private eyeAppearanceDefinition: EyeAppearanceDefinitionV3 | null = null
  private eyeAppearanceState: EyeAppearanceStateV3 | null = null
  private socketEyeSurfaceRuntime: SocketEyeSurfaceEngineRuntime | null = null
  private socketEyeSurfaceDefinition: SocketEyeSurfaceDefinitionV1 | null = null
  private eyeApertureSeamDefinition: EyeApertureSeamDefinitionV1 | null = null
  private socketEyeContact: SocketEyeContactSettingsV2
  private socketEyeGaze: Record<'left' | 'right', SocketEyeCoordinates> = {
    left: { horizontal: 0, vertical: 0 },
    right: { horizontal: 0, vertical: 0 }
  }
  private socketEyeHeadAssist = { headYaw: 0, headPitch: 0 }
  private oralAppearanceRuntime: OralAppearanceEngineRuntime | null = null
  private oralAppearanceDefinition: OralAppearanceDefinitionV1 | null = null
  private oralAppearanceState: OralAppearanceStateV1 | null = null
  // ------------------------------------ joint-driven correctives (SA-090)
  private jointCorrectivesSpec: JointCorrectivesSpec | null = null
  private liveJointCorrectivesSpec: LiveJointCorrectivesSpec | null = null
  private liveJointCorrectiveBindings = new Map<
    string,
    { mesh: THREE.Mesh; index: number }
  >()
  private jointCorrectivesDrivers: Array<{
    driver: JointCorrectiveDriver
    nodes: THREE.Object3D[]
  }> = []
  private jointCorrectivesActive = false
  private boneCoveragePresent = 0
  private boneCoverageTotal = 0
  private defaultCamera: GoonCamera | null = null
  private cameraFov = 30
  private baseCameraFov = 30
  private cameraZoomPosition: number | null = null
  private cameraMode: GoonCameraMode = 'free'
  private loadedSkyboxTextureMaxSize = 0
  private viewOffset: {
    fullWidth: number
    fullHeight: number
    offsetX: number
    offsetY: number
  } | null = null

  private audioElement: HTMLAudioElement | null = null
  private audioContext: AudioContext | null = null
  private audioSource: MediaElementAudioSourceNode | MediaStreamAudioSourceNode | null = null
  private audioOutputNode: AudioNode | null = null
  private analyser: AnalyserNode | null = null
  private analyserData: Uint8Array<ArrayBuffer> | null = null
  private speechLipSyncTimeline: GoonLipSyncTimeline | null = null
  private speechLipSyncAnalyzerId: GoonLipSyncAnalyzerId = 'batshit-text-timing'
  private speechLipSyncDurationMs: number | null = null
  private speechLipSyncStartedAt = 0
  private smoothedLipSyncAmplitude = 0
  private speechAudioGate = 0
  private speechAudioPeak = 0
  private speechAudioStartOffsetSec: number | null = null

  private handleTransformDragging = (event: any) => {
    if (this.controls) {
      this.controls.enabled = !event.value
    }
    if (event.value) {
      this.dragMode = 'none'
      this.dragPointerId = null
    }
  }

  private handleTransformMouseDown = (event: any) => {
    if (event?.mode !== 'scale' || this.editTarget?.type !== 'prop') {
      this.scaleDragBaseline = null
      return
    }
    const object = this.propObjects.get(this.editTarget.id)
    this.scaleDragBaseline = object ? object.scale.clone() : null
  }

  private handleTransformMouseUp = () => {
    this.scaleDragBaseline = null
    this.emitEditTransformChange()
  }

  private handleTransformObjectChange = () => {
    if (this.suppressTransformObjectChange) return
    this.enforcePropScaleAspectLock()
    this.emitEditTransformChange()
  }

  private onCompatibility?: (report: GoonCompatibilityReport) => void
  private onPerformance?: (stats: { fps: number }) => void
  private onCameraChange?: (camera: GoonCamera) => void
  private onEditTransformChange?: (transform: GoonEditTransform | null) => void
  private onRuntimeStatus?: (status: GoonRendererRuntime) => void
  private runtimeStatus: GoonRendererRuntime = { backend: 'unsupported', label: 'Unavailable' }
  private materialDisposeErrorCount = 0
  private readonly rootMotionDriftLogIntervalMs = 250
  private frameCounter = 0
  private lastFpsTime = performance.now()
  private targetFrameIntervalMs = 1000 / 60
  private lastFrameTime = performance.now()
  private paused = false
  private renderFailed = false
  private renderScale = 1
  private poseUpdateIntervalMs = 0
  private coveragePoseIntervalMs = 0
  private lastPoseUpdateTime = performance.now()
  private cameraChangeTimer: ReturnType<typeof setTimeout> | null = null
  private suppressCameraUntil = 0
  private tempEuler = new THREE.Euler(0, 0, 0, 'YXZ')
  private tempBox = new THREE.Box3()
  private eyeContactLocalFrontZ: 1 | -1 = 1
  private eyeContactLastYawAbs: number | null = null
  private eyeContactLastPitchAbs: number | null = null
  private eyeContactYawTravel: EyeContactTravelDirection = 'out'
  private eyeContactPitchTravel: EyeContactTravelDirection = 'out'
  private eyeContactAmbient = {
    eyeYaw: 0,
    eyePitch: 0,
    headYaw: 0,
    headPitch: 0
  }
  private eyeContactApplied = {
    eyeYaw: 0,
    eyePitch: 0,
    headYaw: 0,
    headPitch: 0
  }

  constructor(container: HTMLElement, options: GoonEngineOptions = {}) {
    this.container = container
    this.quality = options.quality ?? 'auto'
    this.lipSyncEnabled = options.lipSyncEnabled ?? true
    this.eyeContactMode = options.eyeContactMode ?? 'bone'
    this.eyeContactTuning = this.normalizeEyeContactTuning(options.eyeContactTuning)
    this.socketEyeContact = resolveSocketEyeContactSettings(options.socketEyeContact)
    this.onRuntimeStatus = options.onRuntimeStatus
    this.onCompatibility = options.onCompatibility
    this.onPerformance = options.onPerformance
    this.onCameraChange = options.onCameraChange
    this.onEditTransformChange = options.onEditTransformChange
    this.embeddedWebKitRuntime = this.resolveEmbeddedWebKitRuntime()
    this.forceWebGL2 =
      options.forceWebGL2 ?? this.resolveDebugToggle('goonForceWebGL2', 'batshit:goonForceWebGL2')
    this.debugRootMotionEnabled =
      options.debugRootMotion ?? this.resolveDebugToggle('goonRootMotionDebug', 'batshit:goonRootMotionDebug')
    this.eyeLookDebugEnabled = this.resolveDebugToggle('goonEyeLookDebug', 'batshit:goonEyeLookDebug')
    this.eyeLookFreezeHeadEnabled = this.resolveDebugToggle(
      'goonEyeLookFreezeHead',
      'batshit:goonEyeLookFreezeHead'
    )
    this.eyeLookDirectBoneDebugEnabled = this.resolveDebugToggle(
      'goonEyeLookDirectBone',
      'batshit:goonEyeLookDirectBone'
    )
    if (this.forceWebGL2) {
      console.debug('[GoonRendererDebug] Forcing the WebGL2 fallback backend.', {
        enableByQueryParam: 'goonForceWebGL2=1',
        enableByLocalStorage: 'batshit:goonForceWebGL2=1'
      })
    }
    if (this.debugRootMotionEnabled) {
      this.logRootMotionDebug('Enabled', {
        enableByQueryParam: 'goonRootMotionDebug=1',
        enableByLocalStorage: 'batshit:goonRootMotionDebug=1'
      })
    }
    if (this.eyeLookDebugEnabled) {
      console.debug('[GoonEyeLookDebug] Enabled', {
        enableByQueryParam: 'goonEyeLookDebug=1',
        enableByLocalStorage: 'batshit:goonEyeLookDebug=1'
      })
    }
    if (this.eyeLookFreezeHeadEnabled) {
      console.debug('[GoonEyeLookDebug] Head freeze enabled', {
        enableByQueryParam: 'goonEyeLookFreezeHead=1',
        enableByLocalStorage: 'batshit:goonEyeLookFreezeHead=1'
      })
    }
    if (this.eyeLookDirectBoneDebugEnabled) {
      console.debug('[GoonEyeLookDebug] Direct eye bone debug enabled', {
        enableByQueryParam: 'goonEyeLookDirectBone=1',
        enableByLocalStorage: 'batshit:goonEyeLookDirectBone=1'
      })
    }
    if (typeof options.cameraFov === 'number') {
      this.setCameraFov(options.cameraFov)
    }
  }

  setCompatibilityHandler(handler?: (report: GoonCompatibilityReport) => void) {
    this.onCompatibility = handler
  }

  setPerformanceHandler(handler?: (stats: { fps: number }) => void) {
    this.onPerformance = handler
  }

  setCameraChangeHandler(handler?: (camera: GoonCamera) => void) {
    this.onCameraChange = handler
  }

  setEditTransformChangeHandler(handler?: (transform: GoonEditTransform | null) => void) {
    this.onEditTransformChange = handler
    if (handler) {
      handler(this.getEditTransform())
    }
  }

  setRuntimeStatusHandler(handler?: (status: GoonRendererRuntime) => void) {
    this.onRuntimeStatus = handler
    if (handler) {
      handler({ ...this.runtimeStatus })
    }
  }

  getRuntimeStatus(): GoonRendererRuntime {
    return { ...this.runtimeStatus }
  }

  setScaleAspectLock(enabled: boolean) {
    this.scaleAspectLock = enabled
    if (enabled) {
      this.enforcePropScaleAspectLock()
    }
    this.emitEditTransformChange()
  }

  private setRuntimeStatus(status: GoonRendererRuntime) {
    this.runtimeStatus = status
    this.onRuntimeStatus?.({ ...status })
  }

  private resolveRendererEnvironment(): GoonRendererEnvironment {
    if (typeof navigator === 'undefined') {
      return {
        navigatorGpuAvailable: false,
        embeddedWebKitRuntime: false,
        userAgent: ''
      }
    }

    return {
      navigatorGpuAvailable: 'gpu' in navigator,
      embeddedWebKitRuntime: this.embeddedWebKitRuntime,
      userAgent: navigator.userAgent || ''
    }
  }

  private resolveEmbeddedWebKitRuntime() {
    if (typeof navigator === 'undefined') return false
    const userAgent = navigator.userAgent || ''
    if (!userAgent.includes('AppleWebKit')) return false
    return !/(Chrome|Chromium|CriOS|Firefox|FxiOS|Edg|OPR|Version\/|Safari\/)/.test(userAgent)
  }

  private resolveDebugToggle(queryKey: string, storageKey: string) {
    try {
      const location = (globalThis as { location?: Location }).location
      const query = location?.search
        ? new URLSearchParams(location.search).get(queryKey)
        : null
      if (query === '1' || query === 'true') return true
    } catch {
      // no-op
    }

    try {
      const storage = (globalThis as { localStorage?: Storage }).localStorage
      const stored = storage?.getItem(storageKey)
      if (stored === '1' || stored === 'true') return true
    } catch {
      // no-op
    }

    return false
  }

  private logRootMotionDebug(event: string, details?: Record<string, unknown>) {
    if (!this.debugRootMotionEnabled) return
    if (!details) {
      console.debug(`[GoonRootMotionDebug] ${event}`)
      return
    }
    try {
      console.debug(`[GoonRootMotionDebug] ${event} ${JSON.stringify(details)}`)
    } catch {
      console.debug(`[GoonRootMotionDebug] ${event}`)
    }
  }

  private resolveRendererRuntime(renderer: WebGPURenderer): GoonRendererRuntime {
    const backend = renderer.backend as { isWebGPUBackend?: boolean } | undefined
    if (backend?.isWebGPUBackend) {
      return { backend: 'webgpu', label: 'WebGPU', environment: this.resolveRendererEnvironment() }
    }
    return {
      backend: 'fallback-webgl2',
      label: 'WebGL2 fallback',
      environment: this.resolveRendererEnvironment()
    }
  }

  private buildUnsupportedRuntimeStatus(error: unknown): GoonRendererRuntime {
    const reason = error instanceof Error ? error.message : String(error)
    const message =
      'Goon rendering is unavailable in this environment. WebGPU and WebGL2 could not initialize.'
    return {
      backend: 'unsupported',
      label: 'Unsupported',
      message: `${message} ${reason || ''}`.trim(),
      environment: this.resolveRendererEnvironment()
    }
  }

  private handleRenderFailure(error: unknown) {
    if (this.renderFailed) return
    this.renderFailed = true
    const reason = error instanceof Error ? error.message : String(error)
    const message = 'Goon renderer encountered an unrecoverable error and was stopped. Reopen the preview to retry.'
    this.setRuntimeStatus({
      backend: 'unsupported',
      label: 'Renderer error',
      message: `${message} ${reason || ''}`.trim(),
      environment: this.resolveRendererEnvironment()
    })
    console.error('[GoonEngine] Fatal render error:', error)
    this.setPaused(true)
  }

  setViewOffset(value?: { fullWidth: number; fullHeight: number; offsetX?: number; offsetY?: number } | null) {
    if (!value) {
      if (!this.viewOffset) return
      this.viewOffset = null
      this.handleResize()
      return
    }
    const fullWidth = Math.max(1, Math.round(value.fullWidth))
    const fullHeight = Math.max(1, Math.round(value.fullHeight))
    const offsetX = Math.max(0, Math.round(value.offsetX ?? 0))
    const offsetY = Math.max(0, Math.round(value.offsetY ?? 0))
    this.viewOffset = { fullWidth, fullHeight, offsetX, offsetY }
    this.handleResize()
  }

  clearViewOffset() {
    if (!this.viewOffset) return
    this.viewOffset = null
    this.handleResize()
  }

  setCameraFov(fov: number) {
    if (!Number.isFinite(fov)) return
    const next = THREE.MathUtils.clamp(fov, 15, 100)
    this.baseCameraFov = next
    this.cameraZoomPosition = null
    this.applyRenderedCameraFov(next)
    this.applyIndoorCameraConstraint()
    this.handleCameraChange()
  }

  private applyRenderedCameraFov(fov: number) {
    const next = THREE.MathUtils.clamp(fov, 15, 100)
    if (next === this.cameraFov) return
    this.cameraFov = next
    this.camera.fov = next
    this.camera.updateProjectionMatrix()
    this.skyboxCamera.fov = next
    this.skyboxCamera.updateProjectionMatrix()
    this.groundedSkyboxCamera.fov = next
    this.groundedSkyboxCamera.updateProjectionMatrix()
  }

  setCameraMode(mode: GoonCameraMode) {
    const nextMode = mode === 'indoor' ? 'indoor' : 'free'
    if (nextMode === 'indoor' && !this.canUseIndoorCamera()) return false
    this.cameraMode = nextMode
    if (this.cameraMode === 'indoor' && this.applyIndoorCameraConstraint()) {
      this.controls?.update()
    }
    this.handleCameraChange()
    return true
  }

  getCameraMode() {
    return this.cameraMode
  }

  canUseIndoorCamera() {
    return Boolean(
      (this.roomShellBuilderObject && this.builderBounds) ||
      (this.roomShell && this.roomCameraBoundary)
    )
  }

  setSkyboxPitchOffset(offset: number) {
    if (!Number.isFinite(offset)) return
    this.skyboxPitchOffset = THREE.MathUtils.clamp(offset, -1.1, 1.1)
  }

  setSceneRootOffsetY(offset: number) {
    if (!Number.isFinite(offset)) return
    if (offset === this.sceneRootOffsetY) return
    this.sceneRootOffsetY = offset
    this.sceneRoot.position.y = offset
    if (this.roomShellBuilder) {
      this.updateBuilderBounds(normalizeGoonRoomShellBuilder(this.roomShellBuilder))
    }
    this.syncGroundedSkybox()
  }

  setGroundProjectionLine(line: number) {
    const normalized = normalizeGroundProjectionLine(line)
    if (normalized === this.groundProjectionLine) return
    this.groundProjectionLine = normalized
    this.applyGroundProjectionLine()
  }

  setScenePlacement(placement: GoonScenePlacement, radius: number) {
    const enabled = placement === 'ground'
    const normalizedRadius = enabled
      ? Math.max(1, Number.isFinite(radius) ? radius : 1)
      : 0
    if (
      enabled === this.groundedSkyboxEnabled &&
      normalizedRadius === this.groundedSkyboxRadius
    ) {
      return
    }
    this.groundedSkyboxEnabled = enabled
    this.groundedSkyboxRadius = normalizedRadius
    this.syncGroundedSkybox()
  }

  setDefaultCamera(camera?: GoonCamera | null) {
    if (!camera) {
      this.defaultCamera = this.getCameraState()
      return
    }
    this.defaultCamera = {
      orbitTarget: camera.orbitTarget ? { ...camera.orbitTarget } : undefined,
      distance: camera.distance,
      yaw: camera.yaw,
      pitch: camera.pitch,
      zoom: camera.zoom,
      fov: camera.fov,
      mode: camera.mode
    }
  }

  private releaseRendererSurface() {
    const renderer = this.renderer
    if (!renderer) return
    const element = renderer.domElement
    element.removeEventListener('pointerdown', this.handlePointerDown)
    element.removeEventListener('pointermove', this.handlePointerMove)
    element.removeEventListener('pointerup', this.handlePointerUp)
    element.removeEventListener('pointerleave', this.handlePointerUp)
    element.removeEventListener('pointercancel', this.handlePointerUp)
    element.removeEventListener('contextmenu', this.handleContextMenu)
    element.removeEventListener('wheel', this.handleWheel)
    element.removeEventListener('keyup', this.handleKeyUp)
    renderer.setAnimationLoop(null)
    if (this.controls) {
      this.controls.removeEventListener('change', this.handleCameraChange)
      this.controls.dispose()
      this.controls = undefined
    }
    this.clearEditTarget()
    if (this.transformControls) {
      this.transformControls.removeEventListener('dragging-changed', this.handleTransformDragging)
      this.transformControls.removeEventListener('mouseDown', this.handleTransformMouseDown)
      this.transformControls.removeEventListener('mouseUp', this.handleTransformMouseUp)
      this.transformControls.removeEventListener('objectChange', this.handleTransformObjectChange)
      this.transformControls.dispose()
      this.transformControls = undefined
    }
    if (this.transformControlsHelper) {
      this.scene.remove(this.transformControlsHelper)
      this.transformControlsHelper = undefined
    }
    this.resizeObserver?.disconnect()
    this.resizeObserver = undefined
    renderer.dispose()
    element.parentElement?.removeChild(element)
    this.renderer = undefined
  }

  private async ensureRendererTextureArrayLayers(required: number) {
    if (!Number.isInteger(required) || required <= 0) {
      throw new Error('Socket-eye renderer requirement must be a positive integer.')
    }
    if (required <= this.activeMaxTextureArrayLayersRequirement) return
    this.requiredMaxTextureArrayLayers = required
    if (this.renderer) this.releaseRendererSurface()
    await this.init()
  }

  async init() {
    if (this.renderer) return
    if (this.initPromise) {
      await this.initPromise
      return
    }

    const initPromise = (async () => {
      this.renderFailed = false
      const createRenderer = (forceWebGL: boolean) => new WebGPURenderer(
        buildGoonRendererConstructionOptions(forceWebGL, this.requiredMaxTextureArrayLayers)
      )
      let renderer = createRenderer(this.forceWebGL2)
      try {
        await renderer.init()
      } catch (error) {
        renderer.dispose()
        if (
          shouldRetryGoonRendererWithWebGL2(
            this.forceWebGL2,
            this.requiredMaxTextureArrayLayers
          )
        ) {
          console.warn(
            '[GoonEngine] WebGPU could not satisfy the socket-eye texture-array requirement; retrying with WebGL2.',
            error
          )
          renderer = createRenderer(true)
          try {
            await renderer.init()
          } catch (fallbackError) {
            renderer.dispose()
            const unsupported = this.buildUnsupportedRuntimeStatus(fallbackError)
            this.setRuntimeStatus(unsupported)
            throw new Error(unsupported.message ?? 'Goon rendering is unavailable.')
          }
        } else {
          const unsupported = this.buildUnsupportedRuntimeStatus(error)
          this.setRuntimeStatus(unsupported)
          throw new Error(unsupported.message ?? 'Goon rendering is unavailable.')
        }
      }
      this.activeMaxTextureArrayLayersRequirement = this.requiredMaxTextureArrayLayers
      this.setRuntimeStatus(this.resolveRendererRuntime(renderer))
      renderer.setClearColor(0x000000, 1)
      renderer.outputColorSpace = THREE.SRGBColorSpace
      renderer.autoClear = false
      this.renderer = renderer
      if (typeof document !== 'undefined') {
        this.clock.connect(document)
        this.clock.reset()
      }
      for (const existingCanvas of Array.from(this.container.querySelectorAll('canvas'))) {
        if (existingCanvas !== renderer.domElement) {
          existingCanvas.parentElement?.removeChild(existingCanvas)
        }
      }
      this.container.appendChild(renderer.domElement)
      renderer.domElement.tabIndex = 0
      renderer.domElement.style.outline = 'none'
      renderer.domElement.style.touchAction = 'none'
      renderer.domElement.style.display = 'block'
      renderer.domElement.style.width = '100%'
      renderer.domElement.style.height = '100%'
      renderer.domElement.addEventListener('pointerdown', this.handlePointerDown)
      renderer.domElement.addEventListener('pointermove', this.handlePointerMove)
      renderer.domElement.addEventListener('pointerup', this.handlePointerUp)
      renderer.domElement.addEventListener('pointerleave', this.handlePointerUp)
      renderer.domElement.addEventListener('pointercancel', this.handlePointerUp)
      renderer.domElement.addEventListener('contextmenu', this.handleContextMenu)
      renderer.domElement.addEventListener('wheel', this.handleWheel, { passive: false })
      renderer.domElement.addEventListener('keyup', this.handleKeyUp)

      this.camera.position.set(0, 1.4, 2.2)
      this.controls = new OrbitControls(this.camera, renderer.domElement)
      this.controls.enableDamping = true
      this.controls.minDistance = 0.8
      this.controls.maxDistance = 6
      this.controls.minPolarAngle = 0.05
      this.controls.maxPolarAngle = Math.PI / 2 - ORBIT_FLOOR_CLEARANCE_ANGLE
      this.controls.enablePan = false
      this.controls.enableRotate = false
      this.controls.enableZoom = false
      this.controls.enabled = false
      this.controls.mouseButtons = {
        LEFT: THREE.MOUSE.ROTATE,
        MIDDLE: THREE.MOUSE.DOLLY,
        RIGHT: THREE.MOUSE.PAN
      }
      this.controls.addEventListener('change', this.handleCameraChange)

      this.transformControls = new TransformControls(this.camera, renderer.domElement)
      this.transformControls.enabled = false
      this.transformControls.setSize(0.85)
      this.transformControls.setMode('translate')
      this.transformControls.addEventListener('dragging-changed', this.handleTransformDragging)
      this.transformControls.addEventListener('mouseDown', this.handleTransformMouseDown)
      this.transformControls.addEventListener('mouseUp', this.handleTransformMouseUp)
      this.transformControls.addEventListener('objectChange', this.handleTransformObjectChange)
      const helper =
        typeof this.transformControls.getHelper === 'function'
          ? this.transformControls.getHelper()
          : (this.transformControls as THREE.Object3D)
      this.transformControlsHelper = helper
      this.scene.add(helper)

      this.skyboxCamera.rotation.order = 'YXZ'
      this.skyboxCamera.fov = this.camera.fov

      if (!this.sceneLightingInitialized) {
        const ambient = new THREE.AmbientLight(0xffffff, 0.6)
        const key = new THREE.DirectionalLight(0xffffff, 0.8)
        key.position.set(1, 2, 2)
        this.scene.add(ambient, key)
        this.scene.add(this.sceneRoot)
        this.sceneLightingInitialized = true
      }

      this.resizeObserver = new ResizeObserver(() => this.handleResize())
      this.resizeObserver.observe(this.container)
      this.handleResize()
      this.setQuality(this.quality)

      if (this.paused) {
        this.renderer.setAnimationLoop(null)
      } else {
        this.renderer.setAnimationLoop(() => this.update())
      }
    })()

    this.initPromise = initPromise
    try {
      await initPromise
    } finally {
      if (this.initPromise === initPromise) {
        this.initPromise = null
      }
    }
  }

  async loadGoon(url: string, guidedManifest: GoonCustomAvatarManifest | null = null) {
    if (!this.renderer) {
      await this.init()
    }
    const goonLoadToken = ++this.goonLoadToken
    const shouldResumeAfterLoad = !this.paused
    if (shouldResumeAfterLoad) {
      this.setPaused(true)
    }
    try {
      this.loadToken += 1
      this.clearLoadedGoonState()

      const loader = new GLTFLoader()
      loader.register((parser: any) => {
        const mtoonMaterialPlugin = new MToonMaterialLoaderPlugin(parser, {
          materialType: MToonNodeMaterial
        })
        return new VRMLoaderPlugin(parser, { mtoonMaterialPlugin })
      })
      const gltf = await loader.loadAsync(url)
      if (goonLoadToken !== this.goonLoadToken) {
        if (gltf?.scene) {
          this.disposeVrmScene(gltf.scene)
        }
        return
      }
      const vrm = gltf.userData.vrm as VRM
      if (!vrm) {
        throw new Error('Failed to load VRM')
      }
      const embeddedManifest = extractEmbeddedCustomAvatarManifest((gltf as any)?.parser?.json)
      const effectiveGuidedManifest = guidedManifest ?? embeddedManifest

      this.vrm = vrm
      if (vrm.lookAt) {
        const existingProxy = vrm.scene.children.find(
          (child) => child instanceof VRMLookAtQuaternionProxy
        )
        if (!existingProxy) {
          const proxy = new VRMLookAtQuaternionProxy(vrm.lookAt)
          proxy.name = 'VRMLookAtQuaternionProxy'
          vrm.scene.add(proxy)
        }
      }
      this.disableAvatarMeshCulling(vrm.scene)
      this.scene.add(vrm.scene)
      this.mixer = new THREE.AnimationMixer(vrm.scene)
      this.mixer.addEventListener('finished', this.handleAnimationFinished)
      this.animationMap.clear()
      this.animationSources.clear()
      this.loadedAnimationUrls.clear()
      this.baseAnimations = Array.isArray(gltf.animations) ? gltf.animations : []
      this.animationWarnings = []
      this.hasBodyAnimations = this.registerAnimations(this.baseAnimations, 'vrm', 'vrm')
      this.guidedManifestOverlay =
        effectiveGuidedManifest?.face || effectiveGuidedManifest?.body ? effectiveGuidedManifest : null
      this.configureBodyConcealManifest(vrm.scene, effectiveGuidedManifest)

      this.captureBones()
      this.captureRestPose()
      this.captureRootMotionLockNodes()
      this.emitCompatibility()
      this.applyRuntimeTextureBudget(vrm.scene)
      this.collectMaterials()
      this.applyMaterialEdgeSmoothing()

      if (this.controls) {
        this.applyDefaultCamera()
        this.calibrateEyeContactReference()
      }

      this.syncBaseLoopAnimation()
    } finally {
      if (shouldResumeAfterLoad && !this.renderFailed && this.renderer && goonLoadToken === this.goonLoadToken) {
        this.setPaused(false)
      }
    }
  }

  async loadCustomGoon(
    url: string,
    manifest: GoonCustomAvatarManifest,
    options: {
      bodyDialValues?: Record<string, number> | null
      appearanceDialValues?: AppearanceDialValueState | null
      facialArtworkState?: FacialArtworkStateV4 | null
      eyeAppearanceState?: EyeAppearanceStateV3 | null
      oralAppearanceState?: OralAppearanceStateV1 | null
    } = {}
  ) {
    const socketEyePackage = parseFirstPartySocketEyePackage(manifest)
    if (socketEyePackage) {
      await this.ensureRendererTextureArrayLayers(
        socketEyePackage.socketEyeSurface.rendering.requiredMaxTextureArrayLayers
      )
    }
    if (!this.renderer) {
      await this.init()
    }
    const goonLoadToken = ++this.goonLoadToken
    const shouldResumeAfterLoad = !this.paused
    if (shouldResumeAfterLoad) {
      this.setPaused(true)
    }
    try {
      this.loadToken += 1
      this.clearLoadedGoonState()

      const loader = new GLTFLoader()
      const gltf = await loader.loadAsync(url)
      if (goonLoadToken !== this.goonLoadToken) {
        if (gltf?.scene) {
          this.disposeObject3D(gltf.scene)
        }
        return
      }

      const scene = gltf.scene ?? gltf.scenes?.[0]
      if (!scene) {
        throw new Error('Custom avatar model is missing a scene root.')
      }

      this.customAvatarRoot = scene
      this.customAvatarManifest = manifest
      this.disableAvatarMeshCulling(scene)
      scene.visible = this.goonVisible

      // GLB-lane animation bootstrap: same mixer/clip machinery as the VRM
      // path — clips bind to skeleton nodes by track name (mixamorig core +
      // bs_* twist bones on first-party rigs).
      this.mixer = new THREE.AnimationMixer(scene)
      this.mixer.addEventListener('finished', this.handleAnimationFinished)
      this.animationMap.clear()
      this.animationSources.clear()
      this.loadedAnimationUrls.clear()
      this.baseAnimations = Array.isArray(gltf.animations) ? gltf.animations : []
      this.animationWarnings = []
      this.hasBodyAnimations = this.registerAnimations(this.baseAnimations, 'custom', 'goon')

      this.configureBodyConcealManifest(scene, manifest)
      this.captureCustomStageAnchors(manifest)
      this.discoverCustomFaceSupport(manifest)
      const appearanceDials = manifest.appearanceDials
      if (manifest.liveBuild !== undefined && manifest.liveBuild !== null) {
        await verifyGoonLiveManifest(parseGoonLiveManifestFromAvatarManifest(manifest))
        this.resetBodyDialsState()
        this.setupLiveJointCorrectives(manifest)
      } else if (appearanceDials !== undefined && appearanceDials !== null) {
        this.setupAppearanceDials(manifest, options.appearanceDialValues ?? null)
      } else {
        this.setupBodyDials(manifest, options.bodyDialValues ?? null)
      }
      if (socketEyePackage) {
        this.setupSocketEyeAppearance(
          socketEyePackage,
          options.eyeAppearanceState ?? null
        )
        await this.setupFacialArtwork(
          socketEyePackage.facialArtwork,
          options.facialArtworkState ?? null
        )
      } else {
        const facialArtworkCapability = classifyFacialArtworkPackageCapability(manifest)
        if (facialArtworkCapability.status === 'retired') {
          this.customFaceManifestIssues.push(facialArtworkCapability.notice)
        }
        if (options.eyeAppearanceState || options.facialArtworkState) {
          throw new Error(
            'Saved socket-eye appearance state targets a Goon package without the current first-party eye tuple.'
          )
        }
      }
      this.setupOralAppearance(manifest, options.oralAppearanceState ?? null)
      // Performance-rig/v2 depends on the socket-eye surface. Bind it only
      // after every appearance runtime has completed so a failed eye setup
      // cannot leave a half-active performance driver behind.
      this.setupCustomPerformanceRig(manifest)
      this.emitCustomCompatibility()
      this.applyRuntimeTextureBudget(scene)

      // Do not expose a partially configured appearance package to a queued
      // WebGPU frame. Appearance setup bakes recipe-only identity targets out
      // of renderer geometry and remaps the compact live face inventory; only
      // the finished scene may enter the render graph.
      this.scene.add(scene)

      if (this.controls) {
        this.applyDefaultCamera()
        this.calibrateEyeContactReference()
      }

      this.syncBaseLoopAnimation()
    } catch (error) {
      // Loading is transactional. A failed package must not leave the render
      // loop holding a mixer, performance rig, or partially bound eye runtime.
      if (goonLoadToken === this.goonLoadToken) {
        this.clearLoadedGoonState()
      }
      throw error
    } finally {
      if (shouldResumeAfterLoad && !this.renderFailed && this.renderer && goonLoadToken === this.goonLoadToken) {
        this.setPaused(false)
      }
    }
  }

  unloadGoon() {
    this.loadToken += 1
    this.clearLoadedGoonState()
  }

  getBodyConcealTopology(): GoonBodyConcealTopology | null {
    const meshes = [...this.bodyConcealMeshes.values()]
      .map((runtimeMesh) => ({
        mesh: runtimeMesh.meshName,
        topologySignature: runtimeMesh.topologySignature,
        triangleCount: runtimeMesh.triangleCount,
        vertexCount: runtimeMesh.vertexCount
      }))
      .sort((left, right) => left.mesh.localeCompare(right.mesh))
    if (meshes.length === 0) return null

    return {
      topologySignature: meshes
        .map((mesh) => `${mesh.mesh}:${mesh.topologySignature}`)
        .join('|'),
      meshes
    }
  }

  isPaintedConcealMaskCompatible(mask?: GoonPaintedConcealMask | null) {
    const normalized = normalizePaintedConcealMask(mask)
    const topology = this.getBodyConcealTopology()
    if (!normalized || !topology) return false
    return normalized.topologySignature === topology.topologySignature
  }

  applyBodyConceal({
    paintedMasks = []
  }: {
    paintedMasks?: Array<GoonPaintedConcealMask | null | undefined>
  } = {}) {
    this.activeBodyConcealPaintedMasks = paintedMasks
      .map((mask) => normalizePaintedConcealMask(mask))
      .filter((mask): mask is GoonPaintedConcealMask => Boolean(mask))

    const topology = this.getBodyConcealTopology()
    const paintedTrianglesByMesh = new Map<string, Set<number>>()
    if (topology) {
      for (const mask of this.activeBodyConcealPaintedMasks) {
        if (mask.topologySignature !== topology.topologySignature) continue
        for (const meshMask of mask.meshes) {
          const runtimeMesh = this.bodyConcealMeshes.get(meshMask.mesh)
          if (!runtimeMesh || runtimeMesh.topologySignature !== meshMask.topologySignature) continue
          const bucket = paintedTrianglesByMesh.get(meshMask.mesh) ?? new Set<number>()
          for (const triangleIndex of expandPaintedTriangleRanges(meshMask.triangleRanges, runtimeMesh.triangleCount)) {
            bucket.add(triangleIndex)
          }
          paintedTrianglesByMesh.set(meshMask.mesh, bucket)
        }
      }
    }

    for (const runtimeMesh of this.bodyConcealMeshes.values()) {
      const hiddenTriangles = new Set<number>()
      for (const triangleIndex of paintedTrianglesByMesh.get(runtimeMesh.meshName) ?? []) {
        hiddenTriangles.add(triangleIndex)
      }

      const geometry = runtimeMesh.mesh.geometry
      if (!geometry.getIndex()) continue

      if (hiddenTriangles.size === 0) {
        geometry.setIndex(
          new THREE.BufferAttribute(runtimeMesh.originalIndexArray.slice(), 1)
        )
      } else {
        const keptIndices: number[] = []
        for (let triangleIndex = 0; triangleIndex < runtimeMesh.originalIndexArray.length / 3; triangleIndex += 1) {
          if (hiddenTriangles.has(triangleIndex)) continue
          const base = triangleIndex * 3
          keptIndices.push(
            runtimeMesh.originalIndexArray[base] ?? 0,
            runtimeMesh.originalIndexArray[base + 1] ?? 0,
            runtimeMesh.originalIndexArray[base + 2] ?? 0
          )
        }
        const IndexArrayCtor = runtimeMesh.originalIndexArray.constructor as
          | Uint16ArrayConstructor
          | Uint32ArrayConstructor
        geometry.setIndex(new THREE.BufferAttribute(new IndexArrayCtor(keptIndices), 1))
      }

      geometry.computeBoundingBox()
      geometry.computeBoundingSphere()
    }

    return this.bodyConcealMeshes.size > 0
  }

  pickBodyConcealTriangles(
    clientX: number,
    clientY: number,
    brushRadiusPx = 1,
    options: { mirrorX?: boolean } = {}
  ): GoonBodyConcealPick | null {
    const canvas = this.renderer?.domElement as HTMLCanvasElement | undefined
    if (!canvas || this.bodyConcealMeshes.size === 0) return null

    const rect = canvas.getBoundingClientRect()
    if (!rect.width || !rect.height) return null
    this.bodyConcealPointer.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1
    )

    const previousIndices = new Map<THREE.BufferGeometry, THREE.BufferAttribute | null>()
    for (const runtimeMesh of this.bodyConcealMeshes.values()) {
      const geometry = runtimeMesh.mesh.geometry
      previousIndices.set(geometry, geometry.getIndex())
      geometry.setIndex(new THREE.BufferAttribute(runtimeMesh.originalIndexArray.slice(), 1))
    }

    try {
      this.bodyConcealRaycaster.setFromCamera(this.bodyConcealPointer, this.camera)
      const intersections = this.bodyConcealRaycaster.intersectObjects(
        [...this.bodyConcealMeshes.values()].map((runtimeMesh) => runtimeMesh.mesh),
        false
      )
      const first = intersections[0]
      if (!first || typeof first.faceIndex !== 'number') return null
      const runtimeMesh = [...this.bodyConcealMeshes.values()].find((candidate) => candidate.mesh === first.object)
      if (!runtimeMesh) return null
      const faceIndex = Math.max(0, Math.min(runtimeMesh.triangleCount - 1, first.faceIndex))
      const primaryCollection = this.collectBodyConcealBrushTriangles(
        runtimeMesh,
        first.point,
        faceIndex,
        brushRadiusPx,
        rect
      )
      if (!primaryCollection) return null
      return {
        mesh: runtimeMesh.meshName,
        topologySignature: runtimeMesh.topologySignature,
        triangleCount: runtimeMesh.triangleCount,
        vertexCount: runtimeMesh.vertexCount,
        faceIndex: primaryCollection.faceIndex,
        triangleIndices: primaryCollection.triangleIndices,
        ...(options.mirrorX
          ? {
              mirroredPicks: this.collectBodyConcealMirroredBrushPicks(
                runtimeMesh,
                first.point,
                brushRadiusPx,
                rect
              )
            }
          : {})
      }
    } finally {
      for (const [geometry, index] of previousIndices) {
        geometry.setIndex(index)
      }
    }
  }

  private collectBodyConcealBrushTriangles(
    runtimeMesh: BodyConcealRuntimeMesh,
    hitPoint: THREE.Vector3,
    seedFaceIndex: number | null,
    brushRadiusPx: number,
    rect: DOMRect
  ): BodyConcealTriangleCollection | null {
    const normalizedRadiusPx = Math.max(1, Math.min(120, Math.round(brushRadiusPx)))
    if (normalizedRadiusPx <= 2 && seedFaceIndex !== null) {
      return { faceIndex: seedFaceIndex, triangleIndices: [seedFaceIndex] }
    }

    const distance = Math.max(0.01, this.camera.position.distanceTo(hitPoint))
    const fov = THREE.MathUtils.degToRad(this.camera.fov)
    const worldRadius = Math.max(
      0.004,
      (normalizedRadiusPx / Math.max(1, rect.height)) * 2 * distance * Math.tan(fov / 2)
    )
    const radiusSq = worldRadius * worldRadius
    const geometry = runtimeMesh.mesh.geometry
    const position = geometry.getAttribute('position')
    if (!position) {
      return seedFaceIndex !== null
        ? { faceIndex: seedFaceIndex, triangleIndices: [seedFaceIndex] }
        : null
    }

    const a = new THREE.Vector3()
    const b = new THREE.Vector3()
    const c = new THREE.Vector3()
    const centroid = new THREE.Vector3()
    const picked = new Set<number>()
    if (seedFaceIndex !== null) {
      picked.add(seedFaceIndex)
    }
    let nearestFaceIndex = seedFaceIndex ?? -1
    let nearestDistanceSq = Number.POSITIVE_INFINITY
    for (let triangleIndex = 0; triangleIndex < runtimeMesh.triangleCount; triangleIndex += 1) {
      const base = triangleIndex * 3
      const aIndex = runtimeMesh.originalIndexArray[base]
      const bIndex = runtimeMesh.originalIndexArray[base + 1]
      const cIndex = runtimeMesh.originalIndexArray[base + 2]
      if (typeof aIndex !== 'number' || typeof bIndex !== 'number' || typeof cIndex !== 'number') continue
      a.fromBufferAttribute(position, aIndex)
      b.fromBufferAttribute(position, bIndex)
      c.fromBufferAttribute(position, cIndex)
      centroid.copy(a).add(b).add(c).multiplyScalar(1 / 3)
      runtimeMesh.mesh.localToWorld(centroid)
      const distanceSq = centroid.distanceToSquared(hitPoint)
      if (distanceSq < nearestDistanceSq) {
        nearestDistanceSq = distanceSq
        nearestFaceIndex = triangleIndex
      }
      if (normalizedRadiusPx > 2 && distanceSq <= radiusSq) {
        picked.add(triangleIndex)
      }
    }

    if (picked.size === 0 && nearestFaceIndex >= 0) {
      picked.add(nearestFaceIndex)
    }
    if (nearestFaceIndex < 0) return null

    return {
      faceIndex: nearestFaceIndex,
      triangleIndices: [...picked].sort((left, right) => left - right)
    }
  }

  private collectBodyConcealMirroredBrushPicks(
    runtimeMesh: BodyConcealRuntimeMesh,
    hitPoint: THREE.Vector3,
    brushRadiusPx: number,
    rect: DOMRect
  ): GoonBodyConcealMeshPick[] {
    const localHitPoint = runtimeMesh.mesh.worldToLocal(hitPoint.clone())
    const mirroredLocalPoint = localHitPoint.clone()
    mirroredLocalPoint.x = runtimeMesh.mirrorCenterX * 2 - localHitPoint.x
    const mirroredWorldPoint = runtimeMesh.mesh.localToWorld(mirroredLocalPoint)
    const collection = this.collectBodyConcealBrushTriangles(
      runtimeMesh,
      mirroredWorldPoint,
      null,
      brushRadiusPx,
      rect
    )
    if (!collection) return []

    return [
      {
        mesh: runtimeMesh.meshName,
        topologySignature: runtimeMesh.topologySignature,
        triangleCount: runtimeMesh.triangleCount,
        vertexCount: runtimeMesh.vertexCount,
        faceIndex: collection.faceIndex,
        triangleIndices: collection.triangleIndices
      }
    ]
  }

  async configureGuidedOutfitPieces(
    pieces: GoonGuidedOutfitPiece[] = [],
    pieceStates: Record<string, boolean> = {},
    dufOverlays: Array<{ id: string; file: GoonFileRef }> = []
  ) {
    this.clearGuidedOutfitRuntime()
    if (!this.vrm) return

    for (const piece of pieces) {
      if (piece.source === 'duf-overlay' && piece.overlayId) continue
      const nodes = this.resolveGuidedRuntimeNodes(this.vrm.scene, piece.runtimeNodeNames)
      if (nodes.length > 0) {
        this.guidedOutfitPieceNodes.set(piece.id, nodes)
      }
    }

    const overlayPiecesById = new Map<string, GoonGuidedOutfitPiece[]>()
    for (const piece of pieces) {
      if (piece.source !== 'duf-overlay' || !piece.overlayId) continue
      const bucket = overlayPiecesById.get(piece.overlayId) ?? []
      bucket.push(piece)
      overlayPiecesById.set(piece.overlayId, bucket)
    }

    for (const overlay of dufOverlays) {
      const overlayPieces = overlayPiecesById.get(overlay.id) ?? []
      if (overlayPieces.length === 0) continue
      await this.loadGuidedDufOverlay(overlay.file.url, overlayPieces)
    }

    for (const piece of pieces) {
      const visible =
        piece.source === 'duf-overlay' ? true : (pieceStates[piece.id] ?? piece.defaultOn ?? true)
      this.setGuidedOutfitPieceVisible(piece.id, visible)
    }

    this.collectMaterials()
  }

  setGuidedOutfitPieceVisible(pieceId: string, visible: boolean) {
    const nodes = this.guidedOutfitPieceNodes.get(pieceId) ?? []
    if (nodes.length === 0) return false
    for (const node of nodes) {
      node.visible = visible
    }
    return true
  }

  getAvatarRootObject() {
    return this.getActiveAvatarRoot()
  }

  getStageAnchor(name: GoonStageAnchorName) {
    if (name === 'head') return this.getHeadTarget()
    if (name === 'feet') return this.getFeetTarget()
    return this.getHipTarget()
  }

  setStagePlacement(position: THREE.Vector3, rotationY?: number) {
    if (!this.getActiveAvatarRoot()) return
    const placement = {
      position: position.clone(),
      rotationY
    }
    this.anchorTransition = null
    this.applyResolvedPlacement(placement)
  }

  setStagePosture(posture: GoonPosture, preferredMarkerId?: string) {
    this.applyMarkerForPosture(posture, preferredMarkerId)
  }

  getCurrentVisualPlacement() {
    const avatarRoot = this.getActiveAvatarRoot()
    if (!avatarRoot) return null
    const position = avatarRoot.getWorldPosition(new THREE.Vector3())
    if (this.hasMarkerAnchor) {
      position.x = this.markerAnchor.x + this.panOffset.x
      position.z = this.markerAnchor.z + this.panOffset.z
    }
    return {
      position,
      rotationY: this.goonRotation
    }
  }

  setMarkerAuthoringVerticalOffset(offset: number) {
    const next = Number.isFinite(offset) ? offset : 0
    if (Math.abs(next - this.markerAuthoringVerticalOffset) < 0.000001) return
    this.markerAuthoringVerticalOffset = next
    this.reapplyCurrentStagePlacement()
  }

  rebindMarkerReference(marker: GoonSceneMarker, nextPropId?: string) {
    const currentParent = marker.propId ? this.propObjects.get(marker.propId) : this.sceneRoot
    const nextParent = nextPropId ? this.propObjects.get(nextPropId) : this.sceneRoot
    return rebindMarkerPreservingWorldPlacement({
      marker,
      currentParent,
      nextParent,
      nextPropId
    })
  }

  private getActiveAvatarRoot() {
    return this.vrm?.scene ?? this.customAvatarRoot
  }

  private clearLoadedGoonState() {
    this.zoomGesture = null
    if (this.mixer) {
      const mixer = this.mixer
      mixer.removeEventListener('finished', this.handleAnimationFinished)
      this.clearLoadedAnimationState()
      try {
        mixer.uncacheRoot(mixer.getRoot())
      } catch (error) {
        console.warn('[GoonEngine] Failed to uncache previous mixer root cleanly:', error)
      }
      this.mixer = null
    } else {
      this.clearLoadedAnimationState()
    }

    this.customPerformanceRigRuntime?.dispose()
    this.customPerformanceRigRuntime = null
    this.customPerformanceDirection = { ...NEUTRAL_CUSTOM_PERFORMANCE_DIRECTION }
    this.customPerformanceTargetWeights = new Map()
    this.socketEyeSurfaceRuntime?.dispose()
    this.socketEyeSurfaceRuntime = null
    this.socketEyeSurfaceDefinition = null
    this.eyeApertureSeamDefinition = null
    this.facialArtworkRuntime?.dispose()
    this.facialArtworkRuntime = null
    this.facialArtworkDefinition = null
    this.facialArtworkState = null
    this.eyeAppearanceRuntime?.dispose()
    this.eyeAppearanceRuntime = null
    this.eyeAppearanceDefinition = null
    this.eyeAppearanceState = null
    this.oralAppearanceRuntime?.dispose()
    this.oralAppearanceRuntime = null
    this.oralAppearanceDefinition = null
    this.oralAppearanceState = null
    this.resetMaterialOverrides()
    this.releaseAllMaterialRuntimeTextures()
    this.clearBodyConcealRuntime()
    this.clearGuidedOutfitRuntime()
    if (this.vrm) {
      this.disposeVrmScene(this.vrm.scene)
      this.scene.remove(this.vrm.scene)
      this.vrm = null
    }
    if (this.customAvatarRoot) {
      this.scene.remove(this.customAvatarRoot)
      this.disposeObject3D(this.customAvatarRoot)
      this.customAvatarRoot = null
    }
    this.customAvatarManifest = null
    this.customStageAnchors = {}

    this.bones = {}
    this.restRotations.clear()
    this.restPositions.clear()
    this.rawRestRotations.clear()
    this.rawRestPositions.clear()
    this.rootMotionTrackHints.clear()
    this.rootMotionLockNodes = []
    this.baseAnimations = []
    this.hasMouthBlendshapes = false
    this.hasExpressionBlendshapes = false
    this.availableMouthPresets.clear()
    this.customMouthPresetSupport = { mode: 'none', profile: null, availablePresets: [] }
    this.faceMorphBindings = []
    this.faceMorphTargetNames = []
    this.authorableRawMorphTargetNames = []
    this.faceControlMorphNames = []
    this.mouthExpressionMorphTargetNames.clear()
    this.customExpressionMorphMap.clear()
    this.customFaceControlMap = null
    this.customMorphDefinitions = []
    this.customArkitFaceDriverBindings = null
    this.customFaceManifestIssues = []
    this.guidedManifestOverlay = null
    this.faceControlSummaryLog = ''
    this.lastAppliedRawMorphTargets = []
    this.resetBodyDialsState()
    this.vrmSource = 'unknown'
    this.authoringPoseMode = false
    this.authoringPoseAction = null
    this.authoringPoseAnimationName = null
    this.activeMood = null
    this.moodExpressionTargets = []
    this.moodExpressionIntensity = 1
    this.activeExpressions = []
    this.moodFaceBlend = 1
    this.moodFaceBlendUpdatedAt = performance.now()
    this.moodFaceControls = []
    this.moodRawMorphTargets = []
    this.clearAuthoringFacePreview()
    this.ambientBlinkState = createAmbientBlinkState(performance.now())
    this.eyeContactLocalFrontZ = 1
    this.eyeContactLastYawAbs = null
    this.eyeContactLastPitchAbs = null
    this.eyeContactYawTravel = 'out'
    this.eyeContactPitchTravel = 'out'
    this.eyeContactAmbient = {
      eyeYaw: 0,
      eyePitch: 0,
      headYaw: 0,
      headPitch: 0
    }
    this.eyeContactApplied = {
      eyeYaw: 0,
      eyePitch: 0,
      headYaw: 0,
      headPitch: 0
    }
    this.eyeContactBlend = this.eyeContactEnabled ? 1 : 0
    this.lookAtOverrideActive = false
    this.lookAtRestoreAutoUpdate = true
    this.lookAtRestoreTarget = null
    this.speaking = false
    this.activeEmoteUntil = 0
    this.materialMap.clear()
    this.originalMaterialState.clear()
    this.releaseAllMaterialRuntimeTextures()
    this.boneCoveragePresent = 0
    this.boneCoverageTotal = 0
    if (this.transparentTexture) {
      this.transparentTexture.dispose()
      this.transparentTexture = null
    }
    this.clearSpeechPlayback()
  }

  private clearGuidedOutfitRuntime() {
    for (const nodes of this.guidedOutfitPieceNodes.values()) {
      for (const node of nodes) {
        node.visible = true
      }
    }
    this.guidedOutfitPieceNodes.clear()
    this.guidedDufOverlayBonePairs = []
    if (this.guidedDufOverlayRoot) {
      this.guidedDufOverlayRoot.parent?.remove(this.guidedDufOverlayRoot)
      this.disposeObject3D(this.guidedDufOverlayRoot)
      this.guidedDufOverlayRoot = null
    }
    this.materialMap.clear()
  }

  private clearBodyConcealRuntime() {
    for (const runtimeMesh of this.bodyConcealMeshes.values()) {
      const geometry = runtimeMesh.mesh.geometry
      geometry.setIndex(new THREE.BufferAttribute(runtimeMesh.originalIndexArray.slice(), 1))
      geometry.computeBoundingBox()
      geometry.computeBoundingSphere()
    }
    this.bodyConcealMeshes.clear()
    this.activeBodyConcealPaintedMasks = []
  }

  private buildBodyConcealIndexHash(indexArray: Uint16Array | Uint32Array) {
    let hash = 2166136261
    for (let index = 0; index < indexArray.length; index += 1) {
      hash ^= indexArray[index] ?? 0
      hash = Math.imul(hash, 16777619) >>> 0
    }
    return hash.toString(36)
  }

  private resolveBodyConcealMirrorCenterX(position: THREE.BufferAttribute | THREE.InterleavedBufferAttribute) {
    let minX = Number.POSITIVE_INFINITY
    let maxX = Number.NEGATIVE_INFINITY
    for (let index = 0; index < position.count; index += 1) {
      const x = position.getX(index)
      if (!Number.isFinite(x)) continue
      minX = Math.min(minX, x)
      maxX = Math.max(maxX, x)
    }
    return Number.isFinite(minX) && Number.isFinite(maxX) ? (minX + maxX) / 2 : 0
  }

  private getBodyConcealMaterialNames(mesh: THREE.Mesh | THREE.SkinnedMesh) {
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    return materials.map((material) => material?.name?.trim()).filter((name): name is string => Boolean(name))
  }

  private resolveBodyConcealMeshName(mesh: THREE.Mesh | THREE.SkinnedMesh) {
    const materialName = this.getBodyConcealMaterialNames(mesh)[0]
    return mesh.name?.trim() || materialName || `body_mesh_${this.bodyConcealMeshes.size + 1}`
  }

  private isLikelyBodyConcealMeshName(name: string | null | undefined) {
    const normalized = String(name ?? '').trim()
    if (!normalized) return false
    if (!BODY_CONCEAL_NAME_RE.test(normalized)) return false
    return !BODY_CONCEAL_EXCLUDED_NAME_RE.test(normalized)
  }

  private resolveManifestBodyConcealFallbackMeshNames(manifest: GoonCustomAvatarManifest | null | undefined) {
    return [
      ...new Set(
        [manifest?.face?.mesh, ...(manifest?.face?.meshes ?? [])]
          .map((name) => String(name ?? '').trim())
          .filter((name) => this.isLikelyBodyConcealMeshName(name))
      )
    ]
  }

  private buildUniqueBodyConcealMeshName(baseName: string) {
    let nextName = baseName
    let suffix = 2
    while (this.bodyConcealMeshes.has(nextName)) {
      nextName = `${baseName}_${suffix}`
      suffix += 1
    }
    return nextName
  }

  private registerBodyConcealMesh(
    meshName: string,
    node: THREE.Mesh | THREE.SkinnedMesh
  ) {
    if ([...this.bodyConcealMeshes.values()].some((runtimeMesh) => runtimeMesh.mesh === node)) return
    const geometry = node.geometry
    const index = geometry.getIndex()
    const position = geometry.getAttribute('position')
    if (!index || !position || index.count === 0 || index.count % 3 !== 0) return

    node.geometry = cloneGeometryForBodyConceal(geometry)
    const clonedIndex = node.geometry.getIndex()
    const clonedPosition = node.geometry.getAttribute('position')
    if (!clonedIndex || !clonedPosition) return

    const originalIndexArray = clonedIndex.array.slice() as Uint16Array | Uint32Array
    const triangleCount = originalIndexArray.length / 3
    const vertexCount = clonedPosition.count
    const mirrorCenterX = this.resolveBodyConcealMirrorCenterX(clonedPosition)
    const runtimeMeshName = this.buildUniqueBodyConcealMeshName(meshName.trim() || this.resolveBodyConcealMeshName(node))
    const topologySignature = `${runtimeMeshName}:v${vertexCount}:t${triangleCount}:i${this.buildBodyConcealIndexHash(originalIndexArray)}`
    this.bodyConcealMeshes.set(runtimeMeshName, {
      meshName: runtimeMeshName,
      mesh: node,
      originalIndexArray,
      topologySignature,
      triangleCount,
      vertexCount,
      mirrorCenterX
    })
  }

  private registerManifestFallbackBodyConcealMeshes(
    root: THREE.Object3D,
    manifest: GoonCustomAvatarManifest | null | undefined
  ) {
    for (const meshName of this.resolveManifestBodyConcealFallbackMeshNames(manifest)) {
      const node = resolveCustomNamedNode(root, meshName)
      if (!(node instanceof THREE.Mesh || node instanceof THREE.SkinnedMesh)) continue
      this.registerBodyConcealMesh(meshName, node)
    }
  }

  private registerSceneFallbackBodyConcealMeshes(root: THREE.Object3D) {
    root.traverse((node) => {
      if (!(node instanceof THREE.Mesh || node instanceof THREE.SkinnedMesh)) return
      if ([...this.bodyConcealMeshes.values()].some((runtimeMesh) => runtimeMesh.mesh === node)) return
      const materialNames = this.getBodyConcealMaterialNames(node)
      const meshName = this.resolveBodyConcealMeshName(node)
      const hasBodySkinMaterial = materialNames.some((materialName) =>
        isBodySkinClosetSlotMaterialName(materialName)
      )
      const hasBodyLikeMeshName = this.isLikelyBodyConcealMeshName(meshName)
      const hasBodyLikeMaterialName = materialNames.some((materialName) =>
        this.isLikelyBodyConcealMeshName(materialName)
      )
      if (!hasBodySkinMaterial && !hasBodyLikeMeshName && !hasBodyLikeMaterialName) return
      this.registerBodyConcealMesh(this.resolveBodyConcealMeshName(node), node)
    })
  }

  private configureBodyConcealManifest(root: THREE.Object3D, manifest: GoonCustomAvatarManifest | null | undefined) {
    this.clearBodyConcealRuntime()
    const concealMeshes = manifest?.body?.conceal?.meshes ?? []
    for (const concealMesh of concealMeshes) {
      const meshName = concealMesh.mesh?.trim()
      if (!meshName) continue
      const node = resolveCustomNamedNode(root, meshName)
      if (!(node instanceof THREE.Mesh || node instanceof THREE.SkinnedMesh)) continue
      const geometry = node.geometry
      const index = geometry.getIndex()
      if (!index || index.count === 0 || index.count % 3 !== 0) continue
      this.registerBodyConcealMesh(meshName, node)
    }

    this.registerManifestFallbackBodyConcealMeshes(root, manifest)
    this.registerSceneFallbackBodyConcealMeshes(root)
    this.applyBodyConceal({
      paintedMasks: this.activeBodyConcealPaintedMasks
    })
  }

  private resolveGuidedRuntimeNodes(root: THREE.Object3D, runtimeNodeNames: string[]) {
    const requested = new Set(runtimeNodeNames.map((name) => name.trim()).filter(Boolean))
    const resolved: THREE.Object3D[] = []
    if (requested.size === 0) return resolved

    root.traverse((node) => {
      if (!requested.has(node.name.trim())) return
      resolved.push(node)
    })

    return resolved
  }

  private buildBaseBoneNameMap() {
    const bones = new Map<string, THREE.Bone>()
    if (!this.vrm) return bones
    this.vrm.scene.traverse((node) => {
      if (!(node instanceof THREE.Bone)) return
      const name = node.name.trim()
      if (!name || bones.has(name)) return
      bones.set(name, node)
    })
    return bones
  }

  private syncGuidedDufOverlayBones() {
    for (const pair of this.guidedDufOverlayBonePairs) {
      pair.overlayBone.position.copy(pair.baseBone.position)
      pair.overlayBone.quaternion.copy(pair.baseBone.quaternion)
      pair.overlayBone.scale.copy(pair.baseBone.scale)
    }
  }

  private async loadGuidedDufOverlay(url: string, pieces: GoonGuidedOutfitPiece[]) {
    if (!this.vrm || !url || pieces.length === 0) return
    const loader = new GLTFLoader()
    loader.register((parser: any) => {
      const mtoonMaterialPlugin = new MToonMaterialLoaderPlugin(parser, {
        materialType: MToonNodeMaterial
      })
      return new VRMLoaderPlugin(parser, { mtoonMaterialPlugin })
    })

    const gltf = await loader.loadAsync(url)
    const sourceScene = gltf.scene ?? gltf.scenes?.[0]
    if (!sourceScene) return
    this.disableAvatarMeshCulling(sourceScene)

    const overlayRoot = this.guidedDufOverlayRoot ?? new THREE.Group()
    overlayRoot.name = 'GuidedDufOverlayRoot'
    overlayRoot.visible = this.goonVisible
    if (!this.guidedDufOverlayRoot) {
      this.guidedDufOverlayRoot = overlayRoot
      this.vrm.scene.add(overlayRoot)
    }

    const baseBones = this.buildBaseBoneNameMap()
    const sourceNodesByName = new Map<string, THREE.Object3D[]>()
    const selectedNodeNames = new Set(
      pieces.flatMap((piece) => piece.runtimeNodeNames.map((name) => name.trim()).filter(Boolean))
    )
    sourceScene.traverse((node) => {
      const name = node.name.trim()
      if (!name) return
      const bucket = sourceNodesByName.get(name) ?? []
      bucket.push(node)
      sourceNodesByName.set(name, bucket)
      if ((node instanceof THREE.Mesh || node instanceof THREE.SkinnedMesh) && !selectedNodeNames.has(name)) {
        node.visible = false
      }
      if (node instanceof THREE.Bone) {
        const baseBone = baseBones.get(name)
        if (baseBone) {
          this.guidedDufOverlayBonePairs.push({ baseBone, overlayBone: node })
        }
      }
    })

    overlayRoot.add(sourceScene)
    this.applyRuntimeTextureBudget(sourceScene)

    for (const piece of pieces) {
      const importedNodes: THREE.Object3D[] = []
      for (const runtimeNodeName of piece.runtimeNodeNames) {
        const sourceNodes = sourceNodesByName.get(runtimeNodeName.trim()) ?? []
        for (const sourceNode of sourceNodes) {
          importedNodes.push(sourceNode)
        }
      }
      if (importedNodes.length > 0) {
        this.guidedOutfitPieceNodes.set(piece.id, importedNodes)
      }
    }
    this.syncGuidedDufOverlayBones()
  }

  private captureCustomStageAnchors(manifest: GoonCustomAvatarManifest) {
    const root = this.customAvatarRoot
    if (!root) {
      throw new Error('Custom avatar root is not loaded.')
    }

    const anchors = manifest.stage?.anchors
    if (!anchors) {
      throw new Error(
        'Custom avatar manifest must define stage anchors for head, hips, and feet.'
      )
    }

    const resolveNode = (label: string, name?: string) => {
      if (!name?.trim()) {
        return null
      }
      const node = resolveCustomNamedNode(root, name)
      if (!node) {
        throw new Error(`Custom avatar anchor "${label}" points to missing node "${name}".`)
      }
      return node
    }

    const head = resolveNode('head', anchors.head)
    const hips = resolveNode('hips', anchors.hips)
    const feet = resolveNode('feet', anchors.feet)
    const leftFoot = resolveNode('leftFoot', anchors.leftFoot)
    const rightFoot = resolveNode('rightFoot', anchors.rightFoot)

    if (!head || !hips || (!feet && !(leftFoot && rightFoot))) {
      throw new Error(
        'Custom avatar manifest must define stage anchors for head, hips, and feet (either feet or leftFoot + rightFoot).'
      )
    }

    this.customStageAnchors = {
      head,
      hips,
      feet: feet ?? undefined,
      leftFoot: leftFoot ?? undefined,
      rightFoot: rightFoot ?? undefined
    }
  }

  private getCustomAnchorPosition(name: GoonStageAnchorName) {
    if (name === 'head') {
      return this.customStageAnchors.head?.getWorldPosition(new THREE.Vector3()) ?? null
    }
    if (name === 'hips') {
      return this.customStageAnchors.hips?.getWorldPosition(new THREE.Vector3()) ?? null
    }
    if (this.customStageAnchors.feet) {
      return this.customStageAnchors.feet.getWorldPosition(new THREE.Vector3())
    }

    const left = this.customStageAnchors.leftFoot?.getWorldPosition(new THREE.Vector3()) ?? null
    const right = this.customStageAnchors.rightFoot?.getWorldPosition(new THREE.Vector3()) ?? null
    if (left && right) {
      return new THREE.Vector3(
        (left.x + right.x) / 2,
        Math.min(left.y, right.y),
        (left.z + right.z) / 2
      )
    }
    return left ?? right ?? null
  }

  // ================================================== body dials (SA-090)

  private resetBodyDialsState() {
    this.bodyDialsManifest = null
    this.bodyDialsValues = null
    this.bodyDialsBindings = []
    this.bodyDialsOwnedTargets = new Set()
    this.bodyDialsAppliedTargets = new Set()
    this.bodyDialsRawMorphWarned = new Set()
    this.bodyDialsBones = null
    this.bodyDialsSkins = []
    this.bodyDialsHipsRemap = null
    this.bodyDialsHeadFollow = []
    this.bodyDialsRootBase = null
    this.bodyDialsResolvedInfluences = new Map()
    this.bodyDialsNormalizedValues = {}
    this.appearanceDialsRuntime = null
    this.appearanceDialsManifest = null
    this.appearanceDialsValues = null
    this.appearanceDialsOwnedTargets = new Set()
    this.jointCorrectivesSpec = null
    this.liveJointCorrectivesSpec = null
    this.liveJointCorrectiveBindings = new Map()
    this.jointCorrectivesDrivers = []
    this.jointCorrectivesActive = false
  }

  getBodyDialsManifest(): BodyDialsManifest | null {
    return this.bodyDialsManifest
  }

  getAppearanceDialsManifest(): AppearanceDialsManifest | null {
    return this.appearanceDialsManifest
  }

  setAppearanceDialValues(values: AppearanceDialValueState | null) {
    const runtime = this.appearanceDialsRuntime
    if (!runtime) return
    this.customPerformanceRigRuntime?.removeOverlay()
    this.appearanceDialsValues = values
    runtime.setValues(values)
    this.socketEyeSurfaceRuntime?.syncIdentitySurfaceFrames()
    this.customPerformanceRigRuntime?.rebaseLookNodePositions()
  }

  getFacialArtworkDefinition() {
    return this.facialArtworkDefinition
  }

  async setFacialArtworkState(value: FacialArtworkStateV4 | null) {
    const runtime = this.facialArtworkRuntime
    if (!runtime) {
      if (value) throw new Error('The loaded Goon package does not support facial artwork.')
      return
    }
    const applied = await runtime.apply(value)
    if (applied) this.facialArtworkState = value
  }

  getEyeAppearanceDefinition() {
    return this.eyeAppearanceDefinition
  }

  getSocketEyeSurfaceDefinition() {
    return this.socketEyeSurfaceDefinition
  }

  setEyeAppearanceState(value: EyeAppearanceStateV3 | null) {
    const runtime = this.eyeAppearanceRuntime
    if (!runtime) {
      if (value) throw new Error('The loaded Goon package does not support Eye Appearance.')
      return
    }
    runtime.setState(value)
    this.eyeAppearanceState = value
  }

  private setupSocketEyeAppearance(
    packageValue: NonNullable<ReturnType<typeof parseFirstPartySocketEyePackage>>,
    initialState: EyeAppearanceStateV3 | null
  ) {
    const root = this.customAvatarRoot
    if (!root) throw new Error('Custom avatar root is missing during socket-eye setup.')
    const eyeRuntime = new EyeAppearanceEngineRuntime(
      packageValue.eyeAppearance,
      initialState,
      () => this.facialArtworkRuntime?.refreshSocketVisualState()
    )
    const initialVisualState = (side: 'left' | 'right'): SocketEyeCompositeVisualState => {
      const physical = eyeRuntime.resolveSide(side)
      return {
        scleraColor: packageValue.eyeAppearance.solidColorDefaults.sclera,
        irisColor: packageValue.eyeAppearance.solidColorDefaults.iris,
        pupilColor: packageValue.eyeAppearance.solidColorDefaults.pupil,
        irisRadiusMeters: physical.irisRadiusMeters,
        pupilRadiusRatio: physical.pupilRadiusRatio,
        irisVerticalOffsetMeters: physical.irisVerticalOffsetMeters,
        edgeSoftnessMeters: physical.edgeSoftnessMeters,
        scleraArtwork: { texture: null, tint: [1, 1, 1, 0], opacity: 0 },
        irisArtwork: { texture: null, tint: [1, 1, 1, 0], opacity: 0 },
        pupilArtwork: { texture: null, tint: [1, 1, 1, 0], opacity: 0 },
        highlight: { texture: null, tint: [1, 1, 1, 0], opacity: 0 },
        cornea: physical.cornea
      }
    }
    const socketRuntime = new SocketEyeSurfaceEngineRuntime(
      root,
      packageValue.socketEyeSurface,
      packageValue.eyeApertureSeam,
      { left: initialVisualState('left'), right: initialVisualState('right') }
    )
    this.eyeAppearanceRuntime = eyeRuntime
    this.eyeAppearanceDefinition = packageValue.eyeAppearance
    this.eyeAppearanceState = initialState
    this.socketEyeSurfaceRuntime = socketRuntime
    this.socketEyeSurfaceDefinition = packageValue.socketEyeSurface
    this.eyeApertureSeamDefinition = packageValue.eyeApertureSeam
    this.socketEyeGaze = {
      left: { horizontal: 0, vertical: 0 },
      right: { horizontal: 0, vertical: 0 }
    }
    this.socketEyeHeadAssist = { headYaw: 0, headPitch: 0 }
  }

  getOralAppearanceDefinition() {
    return this.oralAppearanceDefinition
  }

  setOralAppearanceState(value: OralAppearanceStateV1 | null) {
    const runtime = this.oralAppearanceRuntime
    if (!runtime) {
      if (value) throw new Error('The loaded Goon package does not support Oral Appearance.')
      return
    }
    runtime.setState(value)
    this.oralAppearanceState = value
  }

  private setupOralAppearance(
    manifest: GoonCustomAvatarManifest,
    initialState: OralAppearanceStateV1 | null
  ) {
    const rawDefinition = manifest.oralAppearance
    if (rawDefinition === undefined || rawDefinition === null) {
      if (initialState) {
        throw new Error('Saved Oral Appearance state targets a package without oral-appearance/v1.')
      }
      return
    }
    if (
      (manifest.appearanceDials === undefined || manifest.appearanceDials === null) &&
      (manifest.liveBuild === undefined || manifest.liveBuild === null)
    ) {
      throw new Error('oral-appearance/v1 requires a Recipe Source or verified Live Goon package.')
    }
    const definition = parseOralAppearanceDefinition(rawDefinition)
    const root = this.customAvatarRoot
    if (!root) throw new Error('Custom avatar root is missing during Oral Appearance setup.')
    const runtime = new OralAppearanceEngineRuntime(root, definition, initialState)
    this.oralAppearanceRuntime = runtime
    this.oralAppearanceDefinition = definition
    this.oralAppearanceState = initialState
  }

  private async setupFacialArtwork(
    definition: FacialArtworkDefinitionV4,
    initialState: FacialArtworkStateV4 | null
  ) {
    const root = this.customAvatarRoot
    if (!root) throw new Error('Custom avatar root is missing during facial artwork setup.')
    const socketEyes = this.socketEyeSurfaceRuntime
    const eyeAppearance = this.eyeAppearanceRuntime
    if (!socketEyes || !eyeAppearance) {
      throw new Error('Facial Artwork v4 requires the active socket-eye runtime.')
    }
    const runtime = new FacialArtworkEngineRuntime(
      root,
      definition,
      socketEyes,
      eyeAppearance
    )
    try {
      await runtime.apply(initialState)
    } catch (error) {
      runtime.dispose()
      throw error
    }
    this.facialArtworkRuntime = runtime
    this.facialArtworkDefinition = definition
    this.facialArtworkState = initialState
  }

  private setupAppearanceDials(
    manifest: GoonCustomAvatarManifest,
    initialValues: AppearanceDialValueState | null
  ) {
    this.resetBodyDialsState()
    const root = this.customAvatarRoot
    if (!root) return
    try {
      const runtime = new AppearanceDialsEngineRuntime(root, manifest, {
        faceMeshes: this.faceMorphBindings.map((binding) => binding.mesh),
        initialValues
      })
      this.appearanceDialsRuntime = runtime
      this.appearanceDialsManifest = runtime.manifest
      this.appearanceDialsValues = initialValues
      this.appearanceDialsOwnedTargets = new Set(runtime.ownedFaceMorphNames)
      this.faceMorphBindings = this.faceMorphBindings.map((binding) => ({
        mesh: binding.mesh,
        dict: this.buildNormalizedMorphDict(binding.mesh)
      }))
      this.faceMorphTargetNames = [
        ...new Set(this.faceMorphBindings.flatMap((binding) => Object.keys(binding.dict)))
      ].sort((left, right) => left.localeCompare(right))
      this.authorableRawMorphTargetNames = this.authorableRawMorphTargetNames.filter(
        (name) => !this.appearanceDialsOwnedTargets.has(this.normalizeMorphTargetName(name) ?? name)
      )
      this.setupJointCorrectives(manifest, runtime.manifest)
      logger.debug(
        `[GoonEngine] appearance dials ready: ${runtime.manifest.dials.length} dials, ` +
          `${runtime.manifest.targets ? Object.keys(runtime.manifest.targets).length : 0} targets`
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.customFaceManifestIssues.push(`Appearance package rejected: ${message}`)
      logger.error('[GoonEngine] appearance dials manifest/runtime rejected:', message)
      throw new Error(`Appearance package rejected: ${message}`)
    }
  }

  private setupCustomPerformanceRig(manifest: GoonCustomAvatarManifest) {
    const root = this.customAvatarRoot
    if (!root) throw new Error('Custom avatar root is missing during performance-rig setup.')

    const rawPerformanceRig = resolveCustomPerformanceRigBlock(manifest)
    const resolved = resolveCustomPerformanceRigManifest(rawPerformanceRig, {
      required:
        (manifest.appearanceDials !== undefined && manifest.appearanceDials !== null) ||
        (manifest.liveBuild !== undefined && manifest.liveBuild !== null)
    })
    if (resolved.issues.length > 0) {
      const message = resolved.issues.join('\n- ')
      throw new Error(`Performance rig package rejected:\n- ${message}`)
    }

    const binding = bindCustomPerformanceRig(root, resolved.manifest)
    if (binding.issues.length > 0) {
      const message = binding.issues.join('\n- ')
      throw new Error(`Performance rig package rejected:\n- ${message}`)
    }

    this.customPerformanceRigRuntime = binding.runtime
    this.customPerformanceDirection = { ...NEUTRAL_CUSTOM_PERFORMANCE_DIRECTION }
    this.customPerformanceTargetWeights = new Map()
  }

  /**
   * Discover the avatar's body-dial rig: parse avatar.json#dials, bind the
   * dial morph meshes by RAW morph names, capture the rest skeleton +
   * inverse-bind baselines for joint follow, and apply the initial values.
   */
  private setupBodyDials(
    manifest: GoonCustomAvatarManifest,
    initialValues: Record<string, number> | null
  ) {
    this.resetBodyDialsState()
    const root = this.customAvatarRoot
    if (!root) return

    let parsed: BodyDialsManifest | null = null
    try {
      parsed = parseBodyDialsManifest(manifest)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.customFaceManifestIssues.push(`Body dials disabled: ${message}`)
      logger.error('[GoonEngine] body dials manifest rejected:', message)
      return
    }
    if (!parsed) return

    // morph bindings by RAW names (dial keys like "$md-..." must never go
    // through face-name normalization)
    const dialKeys = new Set(Object.keys(parsed.keys))
    root.traverse((node) => {
      const mesh = node as THREE.Mesh
      if (!(mesh as { isMesh?: boolean }).isMesh) return
      const rawDict = mesh.morphTargetDictionary
      if (!rawDict) return
      let matches = 0
      for (const name of Object.keys(rawDict)) {
        if (dialKeys.has(name)) matches += 1
      }
      if (matches > 0) {
        this.bodyDialsBindings.push({ mesh, rawDict: { ...rawDict } })
      }
    })
    if (this.bodyDialsBindings.length === 0) {
      this.customFaceManifestIssues.push(
        'Body dials disabled: no mesh carries the dial morph targets.'
      )
      return
    }

    // skeleton rest capture, relative to the avatar root (glTF world space)
    root.updateMatrixWorld(true)
    const rootInverse = root.matrixWorld.clone().invert()
    const bones = new Map<
      string,
      {
        node: THREE.Object3D
        baseLocalPosition: THREE.Vector3
        parentBaseRelQuaternion: THREE.Quaternion
        parentKey: string | null
      }
    >()
    const nodeKeys = new Map<THREE.Object3D, string>()
    root.traverse((node) => {
      if (!(node as { isBone?: boolean }).isBone) return
      const key = node.name
      nodeKeys.set(node, key)
      const parent = node.parent
      const parentRel = new THREE.Matrix4()
      if (parent) {
        parent.updateWorldMatrix(true, false)
        parentRel.multiplyMatrices(rootInverse, parent.matrixWorld)
      }
      const parentQuat = new THREE.Quaternion()
      parentRel.decompose(new THREE.Vector3(), parentQuat, new THREE.Vector3())
      bones.set(key, {
        node,
        baseLocalPosition: node.position.clone(),
        parentBaseRelQuaternion: parentQuat,
        parentKey: parent ? (nodeKeys.get(parent) ?? null) : null
      })
    })
    this.bodyDialsBones = bones

    root.traverse((node) => {
      const skinned = node as THREE.SkinnedMesh
      if (!(skinned as { isSkinnedMesh?: boolean }).isSkinnedMesh) return
      if (!skinned.skeleton) return
      this.bodyDialsSkins.push({
        mesh: skinned,
        baseInverses: skinned.skeleton.boneInverses.map((matrix) => matrix.clone())
      })
    })

    // hips clip remap baseline (rest-relative/v1)
    const rigHips =
      (manifest as { rig?: { hips?: string } }).rig?.hips ?? 'mixamorig:Hips'
    const hipsNode = this.resolveBodyDialBone(rigHips)
    if (hipsNode) {
      this.bodyDialsHipsRemap = {
        node: hipsNode.node,
        baseRest: hipsNode.baseLocalPosition.clone(),
        newRest: hipsNode.baseLocalPosition.clone(),
        ratio: 1,
        lastOutput: null
      }
    }

    // rigid head-asset follow baselines
    const follow = parsed.headAssetFollow
    if (follow) {
      for (const nodeName of follow.nodes) {
        const node = resolveCustomNamedNode(root, nodeName)
        if (!node) continue
        const parent = node.parent
        if (!parent) continue
        parent.updateWorldMatrix(true, false)
        const pivotWorld = new THREE.Vector3(...follow.pivotWorld)
        // pivot ships in glTF world (root space); express it in the asset's
        // parent (Head bone) space at rest so it tracks the bone afterward
        const parentRel = new THREE.Matrix4().multiplyMatrices(rootInverse, parent.matrixWorld)
        const pivotLocal = pivotWorld.applyMatrix4(parentRel.clone().invert())
        this.bodyDialsHeadFollow.push({
          node,
          basePosition: node.position.clone(),
          baseScale: node.scale.clone(),
          pivotLocal
        })
      }
    }

    this.bodyDialsRootBase = {
      scale: root.scale.clone(),
      positionY: root.position.y
    }
    this.bodyDialsOwnedTargets = dialKeys
    this.bodyDialsManifest = parsed
    this.bodyDialsValues = initialValues ? { ...initialValues } : null
    this.applyBodyDials()
    logger.debug(
      `[GoonEngine] body dials ready: ${parsed.dials.length} dials, ` +
        `${dialKeys.size} morph keys, ${bones.size} bones captured`
    )
    this.setupJointCorrectives(manifest, parsed)
  }

  /**
   * Discover the joint-driven correctives rig (avatar.json#rig.correctives,
   * `joint-angle-corrective/v1`): parse + cross-validate against the dials
   * block and resolve the driver bones. Rest rotations + flexion axes come
   * from the manifest (measured at export); the runtime only reads posed
   * quaternions. Runs after setupBodyDials because correctives compose onto
   * dial-resolved influences.
   */
  private setupJointCorrectives(
    manifest: GoonCustomAvatarManifest,
    dials: BodyDialsManifest | AppearanceDialsManifest
  ) {
    let spec: JointCorrectivesSpec | null = null
    try {
      spec = parseJointCorrectives(manifest, dials)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.customFaceManifestIssues.push(`Joint correctives disabled: ${message}`)
      logger.error('[GoonEngine] joint correctives manifest rejected:', message)
      return
    }
    if (!spec) return

    const drivers: Array<{ driver: JointCorrectiveDriver; nodes: THREE.Object3D[] }> = []
    for (const driver of spec.drivers) {
      const nodes: THREE.Object3D[] = []
      for (const bone of driver.bones) {
        const node = this.resolveActiveDialBone(bone.bone)
        if (!node) {
          this.customFaceManifestIssues.push(
            `Joint correctives disabled: driver bone ${bone.bone} not found in the skeleton.`
          )
          logger.error('[GoonEngine] joint correctives driver bone missing:', bone.bone)
          return
        }
        // the loaded rest pose must match the export-measured rest frame —
        // warn on drift (the emitted frame stays authoritative per contract)
        const q = node.quaternion
        const dot = Math.abs(
          q.x * bone.restRotation[0] +
            q.y * bone.restRotation[1] +
            q.z * bone.restRotation[2] +
            q.w * bone.restRotation[3]
        )
        if (dot < 0.9999) {
          logger.warn(
            `[GoonEngine] joint correctives: loaded rest for ${bone.bone} drifts from the ` +
              `manifest rest frame (|dot| ${dot.toFixed(5)}) — using the manifest frame`
          )
        }
        nodes.push(node)
      }
      drivers.push({ driver, nodes })
    }
    this.jointCorrectivesSpec = spec
    this.jointCorrectivesDrivers = drivers
    logger.debug(
      `[GoonEngine] joint correctives ready: ${spec.drivers.length} driver(s), ` +
        `${spec.entries.length} entries`
    )
  }

  /** Bind the baker-projected, authoring-free corrective contract in a Live Goon. */
  private setupLiveJointCorrectives(manifest: GoonCustomAvatarManifest) {
    const root = this.customAvatarRoot
    if (!root) throw new Error('Custom avatar root is missing during Live corrective setup.')
    const spec = parseLiveJointCorrectivesFromManifest(manifest)
    if (!spec) return
    const drivers: Array<{ driver: JointCorrectiveDriver; nodes: THREE.Object3D[] }> = []
    for (const driver of spec.drivers) {
      const nodes = driver.bones.map((bone) => {
        const node = resolveCustomNamedNode(root, bone.bone)
        if (!node) {
          throw new Error(`Live corrective driver bone ${bone.bone} is missing from avatar.glb.`)
        }
        return node
      })
      drivers.push({ driver, nodes })
    }
    const bindings = new Map<string, { mesh: THREE.Mesh; index: number }>()
    for (const entry of spec.entries) {
      const node = resolveCustomNamedNode(root, entry.node)
      const mesh = node as THREE.Mesh | null
      if (!mesh || !(mesh as { isMesh?: boolean }).isMesh) {
        throw new Error(`Live corrective node ${entry.node} is missing or is not a mesh.`)
      }
      const index = mesh.morphTargetDictionary?.[entry.morph]
      if (index === undefined || !Array.isArray(mesh.morphTargetInfluences)) {
        throw new Error(`Live corrective morph ${entry.node}/${entry.morph} is missing from avatar.glb.`)
      }
      bindings.set(`${entry.node}\u0000${entry.morph}`, { mesh, index })
    }
    this.liveJointCorrectivesSpec = spec
    this.liveJointCorrectiveBindings = bindings
    this.jointCorrectivesDrivers = drivers
    logger.debug(
      `[GoonEngine] Live joint correctives ready: ${spec.drivers.length} driver(s), ` +
        `${spec.entries.length} entries`
    )
  }

  private resolveBodyDialBone(name: string) {
    if (!this.bodyDialsBones) return null
    const direct = this.bodyDialsBones.get(name)
    if (direct) return direct
    return this.bodyDialsBones.get(sanitizeCustomRuntimeNodeName(name)) ?? null
  }

  private resolveActiveDialBone(name: string): THREE.Object3D | null {
    const appearanceBone = this.appearanceDialsRuntime?.resolveBone(name)
    if (appearanceBone) return appearanceBone
    return this.resolveBodyDialBone(name)?.node ?? null
  }

  /** Live-update the body dial values (Settings sliders, record changes). */
  setBodyDialValues(values: Record<string, number> | null) {
    if (!this.bodyDialsManifest) return
    this.customPerformanceRigRuntime?.removeOverlay()
    this.bodyDialsValues = values ? { ...values } : null
    this.applyBodyDials()
  }

  private applyBodyDials() {
    const manifest = this.bodyDialsManifest
    if (!manifest) return
    const state = resolveBodyDialState(manifest, this.bodyDialsValues)
    // cache for the per-frame corrective composition (base + delta, clamped)
    this.bodyDialsResolvedInfluences = state.influences
    this.bodyDialsNormalizedValues = normalizeBodyDialValues(manifest, this.bodyDialsValues)

    // ---- morph influences (raw-name writes; dial system owns these targets)
    const nextApplied = new Set<string>()
    for (const binding of this.bodyDialsBindings) {
      const influences = binding.mesh.morphTargetInfluences
      if (!Array.isArray(influences)) continue
      for (const [key, influence] of state.influences) {
        const index = binding.rawDict[key]
        if (index === undefined) continue
        influences[index] = influence
        if (influence !== 0) nextApplied.add(key)
      }
      for (const key of this.bodyDialsAppliedTargets) {
        if (state.influences.has(key)) continue
        const index = binding.rawDict[key]
        if (index !== undefined) influences[index] = 0
      }
    }
    this.bodyDialsAppliedTargets = nextApplied

    // ---- joint follow: bone rest translations + inverse-bind updates
    if (this.bodyDialsBones) {
      const offsets = new Map<THREE.Object3D, THREE.Vector3>()
      const offsetByKey = new Map<string, THREE.Vector3>()
      for (const [boneName, delta] of state.jointOffsets) {
        const entry = this.resolveBodyDialBone(boneName)
        if (!entry) continue
        const offset = new THREE.Vector3(delta[0], delta[1], delta[2])
        offsets.set(entry.node, offset)
        offsetByKey.set(boneName, offset)
      }
      const zero = new THREE.Vector3()
      const scratch = new THREE.Vector3()
      const inverseParentQuat = new THREE.Quaternion()
      for (const entry of this.bodyDialsBones.values()) {
        const own = offsets.get(entry.node) ?? zero
        const parentEntry = entry.parentKey ? this.bodyDialsBones.get(entry.parentKey) : null
        const parentOffset = parentEntry ? (offsets.get(parentEntry.node) ?? zero) : zero
        scratch.subVectors(own, parentOffset)
        if (scratch.lengthSq() === 0) {
          entry.node.position.copy(entry.baseLocalPosition)
          continue
        }
        inverseParentQuat.copy(entry.parentBaseRelQuaternion).invert()
        scratch.applyQuaternion(inverseParentQuat)
        entry.node.position.copy(entry.baseLocalPosition).add(scratch)
      }
      // bind translation correction: inv(T(p+d)R) = inv(T(p)R) * T(-d)
      const translation = new THREE.Matrix4()
      for (const skin of this.bodyDialsSkins) {
        const skeletonBones = skin.mesh.skeleton.bones
        for (let i = 0; i < skeletonBones.length; i += 1) {
          const offset = offsets.get(skeletonBones[i] as THREE.Object3D)
          const inverse = skin.mesh.skeleton.boneInverses[i]
          if (!inverse || !skin.baseInverses[i]) continue
          if (!offset || offset.lengthSq() === 0) {
            inverse.copy(skin.baseInverses[i])
            continue
          }
          translation.makeTranslation(-offset.x, -offset.y, -offset.z)
          inverse.copy(skin.baseInverses[i]).multiply(translation)
        }
      }
      // hips remap parameters (rest-relative/v1)
      if (this.bodyDialsHipsRemap) {
        const remap = this.bodyDialsHipsRemap
        const hipsEntry = [...this.bodyDialsBones.values()].find(
          (candidate) => candidate.node === remap.node
        )
        if (hipsEntry) {
          remap.newRest.copy(hipsEntry.node.position)
          remap.ratio =
            Math.abs(remap.baseRest.y) > 1e-6 ? remap.newRest.y / remap.baseRest.y : 1
          remap.lastOutput = remap.node.position.clone()
        }
      }
    }

    // ---- rigid head-asset follow (Head Size)
    for (const entry of this.bodyDialsHeadFollow) {
      const f = state.headAssetScale
      entry.node.scale.copy(entry.baseScale).multiplyScalar(f)
      entry.node.position
        .copy(entry.basePosition)
        .sub(entry.pivotLocal)
        .multiplyScalar(f)
        .add(entry.pivotLocal)
    }

    // ---- overall height (uniform root scale) + data-driven re-grounding
    const root = this.customAvatarRoot
    if (root && this.bodyDialsRootBase) {
      root.scale.copy(this.bodyDialsRootBase.scale).multiplyScalar(state.rootScale)
      root.position.y =
        this.bodyDialsRootBase.positionY - state.soleOffsetY * state.rootScale
      root.updateMatrixWorld(true)
    }
  }

  /**
   * Post-mixer hips remap (rest-relative/v1): clips are authored against the
   * export-time rest skeleton; when dials move the hips rest, clip hips
   * translations re-express as newRest + ratio * (clip - baseRest). Skips
   * when the mixer wrote nothing new (idle keeps the joint-follow rest).
   */
  private applyBodyDialHipsRemap() {
    const remap = this.bodyDialsHipsRemap
    if (!remap || !this.bodyDialsManifest) return
    if (remap.ratio === 1 && remap.newRest.equals(remap.baseRest)) return
    const position = remap.node.position
    if (remap.lastOutput && position.equals(remap.lastOutput)) return
    position.set(
      remap.newRest.x + remap.ratio * (position.x - remap.baseRest.x),
      remap.newRest.y + remap.ratio * (position.y - remap.baseRest.y),
      remap.newRest.z + remap.ratio * (position.z - remap.baseRest.z)
    )
    remap.lastOutput = remap.lastOutput
      ? remap.lastOutput.copy(position)
      : position.clone()
  }

  /**
   * Post-mixer joint-driven correctives (`joint-angle-corrective/v1`): read
   * the posed driver bones, resolve each driver's combined angle, and write
   * the corrective-driven keys as dial-resolved base + additive delta,
   * clamped to the key's influence bounds. Zero angle writes the base back,
   * then the evaluator goes idle until a driver moves again.
   */
  private applyJointCorrectives() {
    const spec = this.jointCorrectivesSpec
    const liveSpec = this.liveJointCorrectivesSpec
    const bodyManifest = this.bodyDialsManifest
    const appearanceRuntime = this.appearanceDialsRuntime
    const appearanceManifest = this.appearanceDialsManifest
    if (
      (!spec && !liveSpec) ||
      (spec && !bodyManifest && (!appearanceRuntime || !appearanceManifest)) ||
      this.jointCorrectivesDrivers.length === 0
    ) return

    const angles: Record<string, number> = {}
    let maxAngle = 0
    for (const entry of this.jointCorrectivesDrivers) {
      const quats: CorrectiveQuat[] = entry.nodes.map((node) => [
        node.quaternion.x,
        node.quaternion.y,
        node.quaternion.z,
        node.quaternion.w
      ])
      const combined = resolveDriverAngleDeg(entry.driver, quats)
      angles[entry.driver.id] = combined
      maxAngle = Math.max(maxAngle, Math.abs(combined))
    }
    const active = maxAngle >= 0.05
    if (!active && !this.jointCorrectivesActive) return

    if (liveSpec) {
      const finals = evaluateLiveJointCorrectiveAngles(liveSpec, angles)
      for (const [key, value] of finals) {
        const binding = this.liveJointCorrectiveBindings.get(key)
        if (!binding || !Array.isArray(binding.mesh.morphTargetInfluences)) {
          throw new Error(`Live corrective runtime binding ${key} disappeared after package validation.`)
        }
        binding.mesh.morphTargetInfluences[binding.index] = value
      }
    } else if (spec && appearanceRuntime && appearanceManifest) {
      const appearanceState = appearanceRuntime.getState()
      const finals = evaluateJointCorrectives(
        spec,
        angles,
        appearanceState.values,
        (target) => appearanceState.influences.get(target) ?? 0,
        appearanceManifest.targets
      )
      appearanceRuntime.applyTargetInfluences(finals)
    } else if (spec && bodyManifest) {
      const finals = evaluateJointCorrectives(
        spec,
        angles,
        this.bodyDialsNormalizedValues,
        (key) => this.bodyDialsResolvedInfluences.get(key) ?? 0,
        bodyManifest.keys
      )
      for (const binding of this.bodyDialsBindings) {
        const influences = binding.mesh.morphTargetInfluences
        if (!Array.isArray(influences)) continue
        for (const [key, value] of finals) {
          const index = binding.rawDict[key]
          if (index !== undefined) influences[index] = value
        }
      }
    }
    this.jointCorrectivesActive = active
  }

  private discoverManifestDrivenFaceSupport(
    root: THREE.Object3D,
    manifest: GoonCustomAvatarManifest
  ) {
    this.faceMorphBindings = []
    this.faceMorphTargetNames = []
    this.authorableRawMorphTargetNames = []
    this.faceControlMorphNames = []
    this.mouthExpressionMorphTargetNames.clear()
    this.customExpressionMorphMap.clear()
    this.customFaceControlMap = null
    this.customMorphDefinitions = []
    this.customArkitFaceDriverBindings = null
    this.customFaceManifestIssues = []
    this.faceControlSummaryLog = ''
    this.faceControlDebugLogged = false
    this.lastAppliedRawMorphTargets = []
    this.vrmSource = 'unknown'

    const requestedMeshNames = resolveCustomFaceMeshNames(manifest)
    const resolvedFaceMeshes = resolveCustomFaceMeshes(root, requestedMeshNames)
    const morphMeshes = resolvedFaceMeshes.meshes
    this.customFaceManifestIssues.push(...resolvedFaceMeshes.issues)

    if (manifest.face && requestedMeshNames.length === 0) {
      this.customFaceManifestIssues.push(
        'Custom face contract does not name specific face meshes; using all morph-enabled meshes in the model.'
      )
    }

    if (morphMeshes.length === 0) {
      if (manifest.face) {
        this.customFaceManifestIssues.push(
          'Custom face contract did not resolve to any morph-enabled meshes.'
        )
      }
      return
    }

    this.faceMorphBindings = morphMeshes.map((mesh) => ({
      mesh,
      dict: this.buildNormalizedMorphDict(mesh)
    }))

    const normalizedNames = new Set<string>()
    const rawNames = new Set<string>()
    for (const binding of this.faceMorphBindings) {
      for (const name of Object.keys(binding.dict)) {
        normalizedNames.add(name)
      }
      for (const name of Object.keys(binding.mesh.morphTargetDictionary ?? {})) {
        rawNames.add(name)
      }
    }

    this.faceMorphTargetNames = [...normalizedNames].sort((a, b) => a.localeCompare(b))
    this.authorableRawMorphTargetNames = [...rawNames].sort((a, b) => a.localeCompare(b))

    const expressionContract = resolveCustomExpressionBindingContract(manifest)
    const manifestExpressions = expressionContract.bindings
    const speechFaceProfile = resolveCustomSpeechFaceProfile(manifest)
    const arkitFaceBindings = resolveCustomArkitFaceBindings(manifest)
    this.customFaceManifestIssues.push(...speechFaceProfile.issues)
    this.customFaceManifestIssues.push(...arkitFaceBindings.issues)
    this.customFaceManifestIssues.push(...expressionContract.issues)

    const resolveAvailableArkitBindings = <TChannel extends string>(
      bindings: Map<TChannel, string[]> | null,
      path: string
    ): Map<TChannel, string[]> | null => {
      if (!bindings) return null
      const resolved = new Map<TChannel, string[]>()
      let complete = true
      for (const [channel, targetNames] of bindings) {
        const missingTargets = targetNames.filter(
          (targetName) =>
            !this.faceMorphBindings.some((binding) => binding.dict[targetName] !== undefined)
        )
        if (missingTargets.length > 0) {
          complete = false
          this.customFaceManifestIssues.push(
            `${path}.${channel} does not resolve morph targets in the model: ${missingTargets.join(', ')}.`
          )
          continue
        }
        resolved.set(channel, targetNames)
      }
      return complete ? resolved : null
    }

    const resolvedArkitFace = resolveAvailableArkitBindings(
      arkitFaceBindings.face,
      'face.arkit52'
    )
    const resolvedArkitTongue = resolveAvailableArkitBindings(
      arkitFaceBindings.tongue,
      'face.tongue16'
    )
    this.customArkitFaceDriverBindings = resolvedArkitFace
      ? { face: resolvedArkitFace, tongue: resolvedArkitTongue }
      : null
    if (manifest.face && Object.keys(manifestExpressions).length === 0) {
      this.customFaceManifestIssues.push(
        'Custom face contract is missing semantic expression/viseme mappings.'
      )
    }

    for (const [preset, targetBindings] of Object.entries(manifestExpressions)) {
      const missingTargets = targetBindings
        .map((binding) => binding.target)
        .filter(
          (targetName) =>
            !this.faceMorphBindings.some((binding) => binding.dict[targetName] !== undefined)
        )

      if (missingTargets.length > 0) {
        this.customFaceManifestIssues.push(
          `Custom face preset "${preset}" does not resolve every mapped morph target in the model: ${missingTargets.join(', ')}.`
        )
        continue
      }

      this.customExpressionMorphMap.set(preset as GoonExpressionPreset, targetBindings)
      if (isCustomCompatibleMouthPreset(preset as GoonExpressionPreset)) {
        for (const binding of targetBindings) {
          this.mouthExpressionMorphTargetNames.add(binding.target)
        }
      }
    }

    const manifestControls = resolveCustomFaceControlBindings(manifest)
    const resolvedControlMap: Record<string, FaceControlMapping> = {}
    const controlTargetNames = new Set<string>()
    for (const [controlId, binding] of Object.entries(manifestControls)) {
      const negativeTargets = [
        ...new Set(
          (binding.negative ?? []).filter((targetName) =>
            this.faceMorphBindings.some((entry) => entry.dict[targetName] !== undefined)
          )
        )
      ]
      const positiveTargets = [
        ...new Set(
          (binding.positive ?? []).filter((targetName) =>
            this.faceMorphBindings.some((entry) => entry.dict[targetName] !== undefined)
          )
        )
      ]

      if (negativeTargets.length === 0 && positiveTargets.length === 0) {
        this.customFaceManifestIssues.push(
          `Custom face control "${controlId}" does not resolve to any morph targets in the model.`
        )
        continue
      }

      resolvedControlMap[controlId] = {
        positive: positiveTargets.map((target) => ({ target, scale: 1 })),
        ...(negativeTargets.length > 0
          ? {
              negative: negativeTargets.map((target) => ({ target, scale: 1 }))
            }
          : {})
      }

      for (const targetName of negativeTargets) {
        controlTargetNames.add(targetName)
      }
      for (const targetName of positiveTargets) {
        controlTargetNames.add(targetName)
      }
    }

    this.customFaceControlMap =
      Object.keys(resolvedControlMap).length > 0 ? resolvedControlMap : null
    this.faceControlMorphNames = [...controlTargetNames].sort((a, b) => a.localeCompare(b))
    this.customMorphDefinitions = resolveCustomMorphDefinitions(manifest)
      .map((definition) => ({
        id: definition.id,
        morphTargets: [
          ...new Set(
            definition.morphTargets.filter((targetName) =>
              this.faceMorphBindings.some((entry) => entry.dict[targetName] !== undefined)
            )
          )
        ]
      }))
      .filter((definition) => {
        if (definition.morphTargets.length > 0) return true
        this.customFaceManifestIssues.push(
          `Custom Morph "${definition.id}" does not resolve to any morph targets in the model.`
        )
        return false
      })

    this.customMouthPresetSupport = resolveCustomMouthPresetSupport(
      this.customExpressionMorphMap.keys(),
      speechFaceProfile.profile
    )
    if (speechFaceProfile.profile && this.customMouthPresetSupport.mode === 'none') {
      this.customFaceManifestIssues.push(
        `Custom face speech profile "${speechFaceProfile.profile}" does not resolve every required moving channel in the model.`
      )
    }
    this.hasMouthBlendshapes = this.customMouthPresetSupport.mode !== 'none'
    this.availableMouthPresets = new Set(this.customMouthPresetSupport.availablePresets)
    this.hasExpressionBlendshapes = this.customExpressionMorphMap.size > 0

    const summary = `[GoonEngine] Manifest face support: ${this.faceMorphBindings.length} morph meshes, ${this.faceMorphTargetNames.length} morph names, ${this.customExpressionMorphMap.size} mapped presets, ${this.faceControlMorphNames.length} mapped control morphs, ${this.customMorphDefinitions.length} custom morphs, Audio2Face ${this.customArkitFaceDriverBindings ? 'ready' : 'not declared'}`
    if (summary !== this.faceControlSummaryLog) {
      this.faceControlSummaryLog = summary
      logger.debug(summary)
    }
  }

  private discoverCustomFaceSupport(manifest: GoonCustomAvatarManifest) {
    const root = this.customAvatarRoot
    if (!root) return
    this.discoverManifestDrivenFaceSupport(root, manifest)
  }

  private discoverGuidedManifestFaceSupport(manifest: GoonCustomAvatarManifest) {
    const root = this.vrm?.scene
    if (!root) return
    this.discoverManifestDrivenFaceSupport(root, manifest)
  }

  private emitCustomCompatibility() {
    const root = this.customAvatarRoot
    const manifest = this.customAvatarManifest
    if (!root || !manifest) return

    const coverage = resolveCustomRigCompatibilityCoverage(root, manifest)
    const hasBlink =
      this.customExpressionMorphMap.has(VRMExpressionPresetName.Blink) ||
      this.customExpressionMorphMap.has(VRMExpressionPresetName.BlinkLeft) ||
      this.customExpressionMorphMap.has(VRMExpressionPresetName.BlinkRight)
    const hasCoreExpressions =
      hasBlink ||
      [
        VRMExpressionPresetName.Happy,
        VRMExpressionPresetName.Sad,
        VRMExpressionPresetName.Angry,
        VRMExpressionPresetName.Surprised,
        VRMExpressionPresetName.Relaxed,
        VRMExpressionPresetName.Neutral
      ].some((preset) => this.customExpressionMorphMap.has(preset))

    const issues = [...this.customFaceManifestIssues]

    if (!this.hasMouthBlendshapes) {
      issues.push('Missing mouth viseme mappings (lip sync unavailable).')
    }
    if (!hasCoreExpressions) {
      issues.push('Missing core Custom expression mappings.')
    }
    if (coverage.present < coverage.total) {
      issues.push(`Rig coverage: ${coverage.present}/${coverage.total} key bones detected.`)
    }
    if (coverage.missingCoreBones.length > 0) {
      issues.push(`Missing core bones: ${coverage.missingCoreBones.join(', ')}.`)
    }
    if (coverage.missingUpperBody.length > 0) {
      issues.push(`Missing upper-body bones: ${coverage.missingUpperBody.join(', ')}.`)
    }
    if (coverage.missingArms.length > 0) {
      issues.push(`Missing arm bones: ${coverage.missingArms.join(', ')}.`)
    }
    if (!this.hasBodyAnimations) {
      issues.push('No animations detected (procedural motions only).')
    }
    for (const warning of this.animationWarnings) {
      if (!issues.includes(warning)) issues.push(warning)
    }

    this.boneCoveragePresent = coverage.present
    this.boneCoverageTotal = coverage.total
    const animationNames = Array.from(this.animationMap.keys())
    const criticalBonesMissing = coverage.missingCoreBones.length > 0
    this.onCompatibility?.({
      tier:
        criticalBonesMissing
          ? 'C'
          : this.hasMouthBlendshapes && hasCoreExpressions
            ? 'A'
            : this.hasMouthBlendshapes
              ? 'B'
              : 'C',
      issues,
      hasMouth: this.hasMouthBlendshapes,
      hasExpressions: this.hasExpressionBlendshapes,
      hasBodyAnimations: this.hasBodyAnimations,
      runtimeBackend: this.runtimeStatus.backend,
      boneCoverage: {
        present: this.boneCoveragePresent,
        total: this.boneCoverageTotal
      },
      animationNames: animationNames.length > 0 ? animationNames : undefined,
      updated_at: new Date().toISOString()
    })
  }

  private emitActiveCompatibility() {
    if (this.customAvatarRoot) {
      this.emitCustomCompatibility()
      return
    }
    this.emitCompatibility()
  }

  private applyDefaultCamera() {
    const avatarRoot = this.getActiveAvatarRoot()
    if (!this.controls || !avatarRoot) return

    avatarRoot.updateMatrixWorld(true)
    const box = new THREE.Box3().setFromObject(avatarRoot)
    const size = new THREE.Vector3()
    box.getSize(size)
    const height = size.y

    if (Number.isFinite(height) && height > 0.01) {
      const center = new THREE.Vector3()
      box.getCenter(center)
      const targetRatio = 0.5
      const targetY = box.min.y + height * targetRatio
      const target = new THREE.Vector3(center.x, targetY, center.z)
      const fov = THREE.MathUtils.degToRad(this.camera.fov)
      const marginFactor = 1.1
      const distance = Math.max(0.1, (height * marginFactor) / (2 * Math.tan(fov / 2)))
      const position = new THREE.Vector3(target.x, target.y, target.z + distance)

      this.controls.target.copy(target)
      this.camera.position.copy(position)
      this.camera.updateProjectionMatrix()
      this.suppressCameraUntil = performance.now() + 120
      this.controls.update()
      this.syncSkyboxZoomFromCamera()
      this.goonTargetOffset.copy(target).sub(avatarRoot.position)
      this.defaultCamera = this.getCameraState()
      return
    }

    const head = this.getStageAnchor('head')
    if (head) {
      this.controls.target.copy(head)
    } else {
      this.controls.target.set(0, 1.4, 0)
    }
    this.suppressCameraUntil = performance.now() + 120
    this.controls.update()
    this.syncSkyboxZoomFromCamera()
    this.goonTargetOffset.copy(this.controls.target).sub(avatarRoot.position)
    this.defaultCamera = this.getCameraState()
  }

  private calibrateEyeContactReference() {
    if (!this.vrm && !this.customPerformanceRigRuntime) return
    const focusPoint = this.getEyeContactFocusPoint()
    if (!focusPoint) return

    const directionWorld = this.camera.position.clone().sub(focusPoint)
    if (directionWorld.lengthSq() < 0.0001) return
    directionWorld.normalize()

    const referenceQuaternion = this.getEyeContactReferenceQuaternion()
    const localDirection = directionWorld.applyQuaternion(referenceQuaternion.invert())
    this.eyeContactLocalFrontZ = localDirection.z >= 0 ? 1 : -1
  }

  private getEyeContactReferenceObject() {
    if (this.customPerformanceRigRuntime) {
      const neck = this.customPerformanceRigRuntime.getLookNode('neck')
      const head = this.customPerformanceRigRuntime.getLookNode('head')
      return neck.parent ?? head.parent ?? this.customAvatarRoot
    }
    if (!this.vrm) return null
    return (
      this.bones[VRMHumanBoneName.Neck]?.parent ??
      this.bones[VRMHumanBoneName.Head]?.parent ??
      this.bones[VRMHumanBoneName.UpperChest] ??
      this.bones[VRMHumanBoneName.Chest] ??
      this.bones[VRMHumanBoneName.Spine] ??
      this.vrm.scene
    )
  }

  private getEyeContactReferenceQuaternion() {
    const reference =
      this.getEyeContactReferenceObject() ?? this.vrm?.scene ?? this.customAvatarRoot
    return reference?.getWorldQuaternion(new THREE.Quaternion()) ?? new THREE.Quaternion()
  }

  applyCamera(camera?: GoonCamera) {
    if (!this.controls || !camera) return

    if (typeof camera.fov === 'number') {
      this.baseCameraFov = THREE.MathUtils.clamp(camera.fov, 15, 100)
    }
    if (camera.mode) {
      this.cameraMode = camera.mode === 'indoor' && this.canUseIndoorCamera() ? 'indoor' : 'free'
    }

    const baseTarget = {
      x: this.controls.target.x,
      y: this.controls.target.y,
      z: this.controls.target.z
    }
    const target = new THREE.Vector3(
      camera.orbitTarget?.x ?? baseTarget.x,
      camera.orbitTarget?.y ?? baseTarget.y,
      camera.orbitTarget?.z ?? baseTarget.z
    )
    this.controls.target.copy(target)

    const currentOffset = this.camera.position.clone().sub(this.controls.target)
    const currentSpherical = new THREE.Spherical().setFromVector3(currentOffset)
    const currentYaw = currentSpherical.theta
    const currentPitch = Math.PI / 2 - currentSpherical.phi

    const { minDistance, maxDistance } = this.resolveCameraDistanceLimits(target)
    this.controls.minDistance = minDistance
    this.controls.maxDistance = maxDistance
    let distance = typeof camera.distance === 'number'
      ? THREE.MathUtils.clamp(camera.distance, minDistance, maxDistance)
      : currentSpherical.radius
    let renderedFov = this.baseCameraFov
    if (typeof camera.zoom === 'number') {
      const zoom = resolveHybridCameraZoomAtPosition({
        logicalPosition: camera.zoom,
        minDistance,
        maxDistance,
        minFov: 15,
        baseFov: this.baseCameraFov,
        maxFov: 100
      })
      distance = zoom.distance
      renderedFov = zoom.fov
      this.cameraZoomPosition = zoom.logicalPosition
    } else {
      this.cameraZoomPosition = null
    }

    const yaw = typeof camera.yaw === 'number' ? camera.yaw : currentYaw
    const pitch = typeof camera.pitch === 'number' ? camera.pitch : currentPitch
    const clampedPitch = THREE.MathUtils.clamp(pitch, -Math.PI / 2 + 0.05, Math.PI / 2 - 0.05)
    const polar = Math.PI / 2 - clampedPitch

    const next = new THREE.Spherical(distance, polar, yaw)
    const position = new THREE.Vector3().setFromSpherical(next).add(target)
    this.camera.position.copy(position)
    this.applyRenderedCameraFov(renderedFov)
    this.camera.updateProjectionMatrix()
    this.suppressCameraUntil = performance.now() + 120
    this.controls.update()
    this.applyIndoorCameraConstraint()
    this.syncSkyboxZoomFromCamera()
  }

  getCameraState(): GoonCamera | null {
    if (!this.controls) return null
    const target = this.controls.target
    const offset = this.camera.position.clone().sub(target)
    const spherical = new THREE.Spherical().setFromVector3(offset)
    const yaw = spherical.theta
    const pitch = Math.PI / 2 - spherical.phi
    return {
      orbitTarget: { x: target.x, y: target.y, z: target.z },
      distance: spherical.radius,
      yaw,
      pitch,
      zoom: this.cameraZoomPosition ?? undefined,
      fov: this.baseCameraFov,
      mode: this.cameraMode
    }
  }

  resetCamera() {
    if (!this.controls) return
    if (this.defaultCamera) {
      this.applyCamera(this.defaultCamera)
      return
    }
    this.controls.target.set(0, 1.4, 0)
    this.camera.position.set(0, 1.4, 2.2)
    this.camera.updateProjectionMatrix()
    this.suppressCameraUntil = performance.now() + 120
    this.controls.update()
    this.syncSkyboxZoomFromCamera()
  }

  resetView() {
    if (!this.controls) return
    const avatarRoot = this.getActiveAvatarRoot()
    if (avatarRoot) {
      if (this.hasMarkerAnchor) {
        this.resetPanOffset()
        avatarRoot.position.copy(this.markerAnchor)
      }
      this.applyDefaultCamera()
      return
    }
    this.resetCamera()
  }

  private handleCameraChange = () => {
    const avatarRoot = this.getActiveAvatarRoot()
    if (this.controls && avatarRoot) {
      this.goonTargetOffset.copy(this.controls.target).sub(avatarRoot.position)
    }
    if (!this.onCameraChange) return
    if (performance.now() < this.suppressCameraUntil) return

    if (this.cameraChangeTimer) {
      clearTimeout(this.cameraChangeTimer)
    }

    this.cameraChangeTimer = setTimeout(() => {
      if (!this.onCameraChange) return
      if (performance.now() < this.suppressCameraUntil) return
      const camera = this.getCameraState()
      if (!camera) return
      this.onCameraChange(camera)
    }, 220)
  }

  private syncLookFromCamera() {
    const euler = new THREE.Euler().setFromQuaternion(this.camera.quaternion, 'YXZ')
    const maxPitch = Math.PI / 2 - 0.05
    this.skyboxPitch = THREE.MathUtils.clamp(euler.x, -maxPitch, maxPitch)
    this.skyboxYaw = euler.y
  }

  private applyLookRotation() {
    this.camera.rotation.set(this.skyboxPitch, this.skyboxYaw, 0, 'YXZ')
  }

  private getCameraDistance() {
    const target = this.controls?.target ?? new THREE.Vector3()
    return this.camera.position.distanceTo(target)
  }

  private setCameraDistance(distance: number) {
    const target = this.controls?.target ?? new THREE.Vector3()
    const offset = this.camera.position.clone().sub(target)
    if (offset.lengthSq() < 0.0001) {
      offset.set(0, 0, 1)
    }
    offset.setLength(distance)
    this.camera.position.copy(target).add(offset)
  }

  private syncSkyboxZoomFromCamera() {
    this.skyboxCamera.fov = this.camera.fov
    this.updateSkyboxCamera()
  }

  private getHipTarget() {
    const hips = this.bones[VRMHumanBoneName.Hips]
    if (hips) {
      return hips.getWorldPosition(new THREE.Vector3())
    }
    if (this.customAvatarRoot) {
      return this.getCustomAnchorPosition('hips')
    }
    return null
  }

  private getHeadTarget() {
    const head = this.bones[VRMHumanBoneName.Head]
    if (head) {
      return head.getWorldPosition(new THREE.Vector3())
    }
    if (this.customAvatarRoot) {
      return this.getCustomAnchorPosition('head')
    }
    return null
  }

  private getFeetTarget() {
    const left = this.bones[VRMHumanBoneName.LeftFoot]
    const right = this.bones[VRMHumanBoneName.RightFoot]
    if (left && right) {
      const leftPos = left.getWorldPosition(new THREE.Vector3())
      const rightPos = right.getWorldPosition(new THREE.Vector3())
      return new THREE.Vector3(
        (leftPos.x + rightPos.x) / 2,
        Math.min(leftPos.y, rightPos.y),
        (leftPos.z + rightPos.z) / 2
      )
    }
    if (left) {
      return left.getWorldPosition(new THREE.Vector3())
    }
    if (right) {
      return right.getWorldPosition(new THREE.Vector3())
    }
    if (this.customAvatarRoot) {
      return this.getCustomAnchorPosition('feet')
    }
    return null
  }

  private getZoomTargetPoint() {
    if (this.zoomTarget === 'head') {
      return this.getHeadTarget() ?? this.getHipTarget()
    }
    if (this.zoomTarget === 'feet') {
      return this.getFeetTarget() ?? this.getHipTarget()
    }
    return this.getHipTarget()
  }

  private getCinematicZoomTargetPoint() {
    const head = this.getHeadTarget()
    const hips = this.getHipTarget()
    const feet = this.getFeetTarget()
    if (!head || !hips || !feet) return this.getZoomTargetPoint()

    this.camera.updateMatrixWorld()
    const projectedHead = head.clone().project(this.camera)
    const projectedFeet = feet.clone().project(this.camera)
    const projectedBodyHeightFraction = Math.abs(projectedHead.y - projectedFeet.y) / 2
    if (!Number.isFinite(projectedBodyHeightFraction)) return this.getZoomTargetPoint()
    return resolveCinematicGoonZoomTarget({
      head,
      hips,
      feet,
      projectedBodyHeightFraction
    })
  }

  private pickGoonZoomPoint(pointer: GoonZoomPointer) {
    const canvas = this.renderer?.domElement as HTMLCanvasElement | undefined
    const avatarRoot = this.getActiveAvatarRoot()
    if (!canvas || !avatarRoot || this.editTarget) return null
    const pointerNdc = pointerClientToNdc(pointer, canvas.getBoundingClientRect())
    if (!pointerNdc) return null

    avatarRoot.updateWorldMatrix(true, true)
    this.camera.updateMatrixWorld()
    this.zoomRaycaster.setFromCamera(pointerNdc, this.camera)
    const hit = this.zoomRaycaster
      .intersectObject(avatarRoot, true)
      .find((intersection) => {
        if (!Number.isFinite(intersection.distance)) return false
        let node: THREE.Object3D | null = intersection.object
        while (node) {
          if (!node.visible) return false
          if (node === avatarRoot) break
          node = node.parent
        }
        const mesh = intersection.object as THREE.Mesh
        const materials = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : []
        return materials.length === 0 || materials.some((material) => material.visible && material.opacity > 0.02)
      })
    if (!hit) return null
    return { point: hit.point.clone(), pointerNdc }
  }

  private resolveZoomGesture(pointer: GoonZoomPointer, allowGoonTarget: boolean) {
    const now = performance.now()
    if (!allowGoonTarget) {
      this.zoomGesture = { kind: 'default', lastWheelAt: now }
      return this.zoomGesture
    }
    if (this.zoomGesture && now - this.zoomGesture.lastWheelAt <= 220) {
      if (this.zoomGesture.kind === 'default') {
        this.zoomGesture.lastWheelAt = now
        return this.zoomGesture
      }
      this.zoomGesture.lastWheelAt = now
      return this.zoomGesture
    }
    const hit = this.pickGoonZoomPoint(pointer)
    this.zoomGesture = hit
      ? {
          kind: 'goon',
          lastWheelAt: now,
          pinnedPoint: hit.point,
          pointerNdc: hit.pointerNdc
        }
      : { kind: 'default', lastWheelAt: now }
    return this.zoomGesture
  }

  private disableAvatarMeshCulling(root: THREE.Object3D | null | undefined) {
    if (!root) return
    root.traverse((node) => {
      const mesh = node as THREE.Mesh | THREE.SkinnedMesh
      if (!((mesh as any).isMesh || (mesh as any).isSkinnedMesh)) return
      mesh.frustumCulled = false
    })
  }

  private alignOrbitTarget(target: THREE.Vector3) {
    if (!this.controls) return
    const offset = this.camera.position.clone().sub(this.controls.target)
    this.controls.target.copy(target)
    this.camera.position.copy(target.clone().add(offset))
  }

  private applyCameraPanDelta(delta: THREE.Vector3) {
    if (!this.controls || delta.lengthSq() < 0.0000000001) return
    const previousPosition = this.camera.position.clone()
    const previousTarget = this.controls.target.clone()
    this.camera.position.add(delta)
    this.controls.target.add(delta)
    this.applyIndoorCameraConstraint()
    const appliedDelta = this.camera.position.clone().sub(previousPosition)
    this.controls.target.copy(previousTarget.add(appliedDelta))
    this.camera.updateMatrixWorld()
    this.controls.update()
    this.syncSkyboxZoomFromCamera()
    this.handleCameraChange()
  }

  private getSceneCameraBounds() {
    const bounds = this.getActiveRoomBounds()
    if (bounds) {
      return new THREE.Box3(
        new THREE.Vector3(bounds.minX, bounds.minY, bounds.minZ),
        new THREE.Vector3(bounds.maxX, bounds.maxY, bounds.maxZ)
      )
    }
    const avatarRoot = this.getActiveAvatarRoot()
    return avatarRoot ? new THREE.Box3().setFromObject(avatarRoot, true) : null
  }

  private resolveCameraDistanceLimits(target = this.controls?.target ?? new THREE.Vector3()) {
    return resolveSceneAwareFreeCameraDistanceLimits({
      target,
      sceneBounds: this.getSceneCameraBounds(),
      minDistance: 0.35,
      minimumMaxDistance: 6,
      exteriorMarginScale: 2
    })
  }

  private applyIndoorCameraConstraint() {
    if (this.cameraMode !== 'indoor') return false
    const clearance = resolvePerspectiveNearPlaneClearance({
      near: this.camera.near,
      verticalFovDegrees: this.camera.fov,
      aspect: this.camera.aspect,
      extraPadding: 0.035
    }).radius

    if (this.roomShellBuilderObject && this.builderBounds) {
      const bounds = new THREE.Box3(
        new THREE.Vector3(this.builderBounds.minX, this.builderBounds.minY, this.builderBounds.minZ),
        new THREE.Vector3(this.builderBounds.maxX, this.builderBounds.maxY, this.builderBounds.maxZ)
      )
      const clamped = clampCameraPositionToPaddedBox({
        position: this.camera.position,
        bounds,
        padding: clearance
      })
      if (!clamped || clamped.position.equals(this.camera.position)) return false
      this.camera.position.copy(clamped.position)
      this.camera.updateMatrixWorld()
      return true
    }

    if (!this.roomShell || !this.roomCameraBoundary) return false
    const localPosition = this.roomShell.worldToLocal(this.camera.position.clone())
    const center = new THREE.Vector3(...this.roomCameraBoundary.center)
    const halfSize = new THREE.Vector3(...this.roomCameraBoundary.size).multiplyScalar(0.5)
    const rotation = this.roomCameraBoundary.rotationY
    localPosition.sub(center).applyAxisAngle(new THREE.Vector3(0, 1, 0), -rotation)
    const worldScale = this.roomShell.getWorldScale(new THREE.Vector3())
    const localPadding = new THREE.Vector3(
      clearance / Math.max(Math.abs(worldScale.x), 0.0001),
      clearance / Math.max(Math.abs(worldScale.y), 0.0001),
      clearance / Math.max(Math.abs(worldScale.z), 0.0001)
    )
    const clamped = clampCameraPositionToPaddedBox({
      position: localPosition,
      bounds: new THREE.Box3(halfSize.clone().negate(), halfSize),
      padding: localPadding
    })
    if (!clamped) return false
    const constrainedWorld = this.roomShell.localToWorld(
      clamped.position
        .applyAxisAngle(new THREE.Vector3(0, 1, 0), rotation)
        .add(center)
    )
    if (constrainedWorld.equals(this.camera.position)) return false
    this.camera.position.copy(constrainedWorld)
    this.camera.updateMatrixWorld()
    return true
  }

  private applyUnifiedZoom(delta: number, pointer?: GoonZoomPointer) {
    const limits = this.resolveCameraDistanceLimits()
    const minDistance = limits.minDistance
    const maxDistance = limits.maxDistance
    if (this.controls) {
      this.controls.minDistance = minDistance
      this.controls.maxDistance = maxDistance
    }
    const currentDistance = this.getCameraDistance()
    const nextZoom = resolveHybridCameraZoom({
      currentDistance,
      currentFov: this.camera.fov,
      minDistance,
      maxDistance,
      minFov: 15,
      baseFov: this.baseCameraFov,
      maxFov: 100,
      delta,
      sensitivity: GOON_CINEMATIC_WHEEL_ZOOM_SENSITIVITY
    })
    const nextDistance = nextZoom.distance

    const gesture = pointer && !this.editTarget
      ? this.resolveZoomGesture(pointer, delta < 0)
      : null
    const cursorDolly = gesture?.kind === 'goon'
      ? resolvePerspectivePinnedPointZoom({
          camera: this.camera,
          pointerNdc: gesture.pointerNdc,
          pinnedPoint: gesture.pinnedPoint,
          nextDistance,
          nextFovDegrees: nextZoom.fov
        })
      : null

    if (cursorDolly && this.controls) {
      this.camera.position.copy(cursorDolly.nextPosition)
      this.controls.target.copy(cursorDolly.nextTarget)
    } else {
      if (!this.editTarget) {
        const focusPoint = this.getCinematicZoomTargetPoint()
        if (focusPoint) {
          this.alignOrbitTarget(focusPoint)
        }
      }
      this.setCameraDistance(nextDistance)
    }

    this.cameraZoomPosition = nextZoom.logicalPosition
    this.applyRenderedCameraFov(nextZoom.fov)
    this.applyIndoorCameraConstraint()

    this.camera.updateMatrixWorld()
    this.camera.updateProjectionMatrix()

    if (!this.lookActive) {
      this.controls?.update()
    }
    this.syncSkyboxZoomFromCamera()
    this.handleCameraChange()
  }

  frameAvatar(preset: GoonFramingPreset) {
    if (!this.controls) return false
    const avatarRoot = this.getActiveAvatarRoot()
    if (!avatarRoot) return false
    // Preset framing is user-triggered, so pay the one-time precise bounds cost.
    // The fast Box3 path includes dormant morph-target extremes and can turn a
    // portrait request into an almost-full-body frame on morph-heavy Goons.
    const bounds = new THREE.Box3().setFromObject(avatarRoot, true)
    const headTarget = this.customAvatarRoot
      ? this.getCustomAnchorPosition('head')
      : this.getHeadTarget()
    const hipsTarget = this.customAvatarRoot
      ? this.getCustomAnchorPosition('hips')
      : this.getHipTarget()
    const feetTarget = this.customAvatarRoot
      ? this.getCustomAnchorPosition('feet')
      : this.getFeetTarget()
    const anchors = headTarget && hipsTarget && feetTarget
      ? { headY: headTarget.y, hipsY: hipsTarget.y, feetY: feetTarget.y }
      : null
    const provisionalLimits = this.resolveCameraDistanceLimits()
    const framing = resolveGoonFraming({
      bounds,
      preset,
      verticalFovDegrees: this.camera.fov,
      aspect: this.camera.aspect,
      minDistance: provisionalLimits.minDistance,
      maxDistance: provisionalLimits.maxDistance,
      anchors
    })
    if (!framing) return false

    const finalLimits = this.resolveCameraDistanceLimits(framing.target)
    this.controls.minDistance = finalLimits.minDistance
    this.controls.maxDistance = finalLimits.maxDistance
    const framingDistance = THREE.MathUtils.clamp(
      framing.distance,
      finalLimits.minDistance,
      finalLimits.maxDistance
    )

    const forward = new THREE.Vector3()
    this.camera.getWorldDirection(forward)
    if (forward.lengthSq() < 0.999) {
      forward.set(0, 0, -1)
    }
    this.controls.target.copy(framing.target)
    this.camera.position.copy(framing.target).addScaledVector(forward, -framingDistance)
    // A preset establishes a new physical frame. Do not persist a stale
    // hybrid-wheel logical zoom that would override this distance on reload.
    this.cameraZoomPosition = null
    this.camera.updateMatrixWorld()
    this.controls.update()
    this.syncSkyboxZoomFromCamera()
    return true
  }

  private shouldHandleZoom(event: {
    shiftKey?: boolean
    metaKey?: boolean
    altKey?: boolean
    ctrlKey?: boolean
  }) {
    if (event.shiftKey || event.metaKey || event.altKey || event.ctrlKey) {
      return false
    }
    return true
  }

  private resolveControlMode(event: {
    shiftKey?: boolean
    metaKey?: boolean
    altKey?: boolean
    ctrlKey?: boolean
  }): 'view' | 'goon' | 'pan' | 'none' {
    if (event.metaKey || event.altKey || event.ctrlKey) {
      return this.getActiveRoomBounds() ? 'pan' : 'none'
    }
    return 'view'
  }

  private enterLookAround() {
    if (this.lookActive || !this.controls) return
    this.lookActive = true
    this.peekState = {
      position: this.camera.position.clone(),
      target: this.controls.target.clone()
    }
    this.syncLookFromCamera()
  }

  private exitLookAround() {
    if (!this.lookActive) return
    this.lookActive = false
    if (this.peekState && this.controls) {
      // programmatic restore of the pre-peek camera: never treat as a user move
      this.suppressCameraUntil = performance.now() + 120
      this.camera.position.copy(this.peekState.position)
      this.controls.target.copy(this.peekState.target)
      this.camera.updateProjectionMatrix()
      this.controls.update()
    }
    this.peekState = null
  }

  private focusRendererCanvas() {
    const canvas = this.renderer?.domElement as HTMLCanvasElement | undefined
    if (!canvas || typeof canvas.focus !== 'function') return
    try {
      canvas.focus({ preventScroll: true })
    } catch {
      canvas.focus()
    }
  }

  private handlePointerDown = (event: PointerEvent) => {
    if (this.transformControls?.dragging) return
    if (this.transformControls?.enabled && this.transformControls.axis) return
    if ((event.buttons & 3) === 3) {
      if (this.lookActive) this.exitLookAround()
      this.dragMode = 'camera-pan'
      this.dragPointerId = event.pointerId
      this.dragLast.set(event.clientX, event.clientY)
      this.focusRendererCanvas()
      this.renderer?.domElement.setPointerCapture?.(event.pointerId)
      event.preventDefault()
      return
    }
    if (event.button === 1) {
      if (!this.getActiveRoomBounds()) return
      this.dragMode = 'pan'
      this.dragPointerId = event.pointerId
      this.dragLast.set(event.clientX, event.clientY)
      this.focusRendererCanvas()
      this.renderer?.domElement.setPointerCapture?.(event.pointerId)
      event.preventDefault()
      return
    }
    if (event.button === 2) {
      this.dragMode = 'goon'
      this.dragPointerId = event.pointerId
      this.dragLast.set(event.clientX, event.clientY)
      this.focusRendererCanvas()
      this.renderer?.domElement.setPointerCapture?.(event.pointerId)
      event.preventDefault()
      return
    }
    if (event.button !== 0) return
    const mode = this.resolveControlMode(event)
    if (mode === 'none') return
    this.dragMode = mode
    if (mode === 'view' && event.shiftKey) {
      this.enterLookAround()
    }
    this.dragPointerId = event.pointerId
    this.dragLast.set(event.clientX, event.clientY)
    this.focusRendererCanvas()
    this.renderer?.domElement.setPointerCapture?.(event.pointerId)
    event.preventDefault()
  }

  private handleContextMenu = (event: MouseEvent) => {
    event.preventDefault()
  }

  private handlePointerMove = (event: PointerEvent) => {
    if (this.transformControls?.dragging) return
    if (this.dragPointerId !== null && event.pointerId !== this.dragPointerId) return
    if ((event.buttons & 3) === 3 && this.dragMode !== 'camera-pan') {
      if (this.lookActive) this.exitLookAround()
      this.dragMode = 'camera-pan'
      this.dragLast.set(event.clientX, event.clientY)
      event.preventDefault()
      return
    }
    if (this.dragMode === 'none') return
    if (this.dragMode === 'camera-pan' && (event.buttons & 3) !== 3) {
      this.dragMode = 'none'
      this.dragPointerId = null
      return
    }
    const dx = event.clientX - this.dragLast.x
    const dy = event.clientY - this.dragLast.y
    this.dragLast.set(event.clientX, event.clientY)
    const element = this.renderer?.domElement
    const baseScale = (Math.PI * 2) / Math.max(1, element?.clientHeight ?? 1)
    const viewScale = baseScale * 0.5
    const goonScale = baseScale

    if (this.dragMode === 'camera-pan') {
      const delta = resolvePerspectiveScreenPanDelta({
        camera: this.camera,
        deltaX: dx,
        deltaY: dy,
        viewportHeight: Math.max(1, element?.clientHeight ?? 1),
        targetDistance: this.getCameraDistance()
      })
      this.applyCameraPanDelta(delta)
    } else if (this.dragMode === 'view') {
      if (!this.lookActive && this.controls) {
        this.controls._rotateLeft(viewScale * dx)
        this.controls._rotateUp(viewScale * dy)
        this.controls.update()
      } else {
        this.skyboxYaw -= dx * viewScale
        this.skyboxPitch -= dy * viewScale
        const maxPitch = Math.PI / 2 + ORBIT_FLOOR_BUFFER
        this.skyboxPitch = THREE.MathUtils.clamp(this.skyboxPitch, -maxPitch, maxPitch)
        this.applyLookRotation()
      }
    } else if (this.dragMode === 'pan') {
      const height = Math.max(1, element?.clientHeight ?? 1)
      const distance = this.getCameraDistance()
      const panScale = (distance * 2) / height
      const forward = new THREE.Vector3()
      this.camera.getWorldDirection(forward)
      forward.y = 0
      if (forward.lengthSq() < 0.0001) {
        forward.set(0, 0, -1)
      }
      forward.normalize()
      const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize()
      const delta = right.multiplyScalar(dx * panScale).add(forward.multiplyScalar(-dy * panScale))
      delta.y = 0
      this.applyPanDelta(delta)
    } else if (this.dragMode === 'goon') {
      this.goonRotation += dx * goonScale
      const avatarRoot = this.getActiveAvatarRoot()
      if (avatarRoot) {
        avatarRoot.rotation.y = this.goonRotation
      }
    }
    event.preventDefault()
  }

  private handlePointerUp = (event: PointerEvent) => {
    if (this.dragPointerId !== null && event.pointerId !== this.dragPointerId) return
    this.dragMode = 'none'
    this.dragPointerId = null
    if (this.lookActive) {
      this.exitLookAround()
    }
    this.renderer?.domElement.releasePointerCapture?.(event.pointerId)
  }

  private handleKeyUp = (event: KeyboardEvent) => {
    if (event.key !== 'Shift') return
    if (this.lookActive) {
      this.exitLookAround()
    }
  }

  private handleWheel = (event: WheelEvent) => {
    if (!this.shouldHandleZoom(event)) return
    event.preventDefault()
    const rawDelta = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX
    const delta = Math.sign(rawDelta) * Math.min(Math.abs(rawDelta), 120)
    if (!delta) return
    this.applyUnifiedZoom(delta, { clientX: event.clientX, clientY: event.clientY })
  }

  private updateSkyboxCamera() {
    this.skyboxCamera.fov = this.camera.fov
    this.skyboxCamera.updateProjectionMatrix()
  }

  private ensureSkyboxMesh() {
    if (this.skyboxMesh) return
    const geometry = new THREE.SphereGeometry(50, 64, 32)
    const material = new THREE.MeshBasicMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false
    })
    this.skyboxMesh = new THREE.Mesh(geometry, material)
    this.skyboxScene.add(this.skyboxMesh)
  }

  private syncGroundedSkybox() {
    this.clearGroundedSkybox()
    if (!this.groundedSkyboxEnabled || !this.skyboxActive || !this.skyboxTexture) return

    const groundedSkybox = new GroundedSkybox(
      this.skyboxTexture,
      GROUNDED_SKYBOX_HEIGHT,
      this.groundedSkyboxRadius,
      GROUNDED_SKYBOX_RESOLUTION
    )
    groundedSkybox.position.y = this.sceneRootOffsetY + GROUNDED_SKYBOX_HEIGHT
    groundedSkybox.renderOrder = -1000

    const uv = groundedSkybox.geometry.getAttribute('uv')
    this.groundedSkyboxCanonicalUv = uv
      ? new Float32Array(uv.array as ArrayLike<number>)
      : null
    if (this.groundedSkyboxCanonicalUv) {
      reapplyGroundProjectionLineToGeometry(
        groundedSkybox.geometry,
        this.groundedSkyboxCanonicalUv,
        this.groundProjectionLine
      )
    }

    const material = groundedSkybox.material as THREE.MeshBasicMaterial
    material.depthTest = false
    material.depthWrite = false

    this.groundedSkybox = groundedSkybox
    this.groundedSkyboxScene.add(groundedSkybox)
  }

  private applyGroundProjectionLine() {
    const groundedSkybox = this.groundedSkybox
    const canonicalUv = this.groundedSkyboxCanonicalUv
    if (!groundedSkybox || !canonicalUv) return
    const uv = groundedSkybox.geometry.getAttribute('uv')
    if (!uv || uv.array.length !== canonicalUv.length) return
    reapplyGroundProjectionLineToGeometry(
      groundedSkybox.geometry,
      canonicalUv,
      this.groundProjectionLine
    )
  }

  private clearGroundedSkybox() {
    if (this.groundedSkybox) {
      this.groundedSkyboxScene.remove(this.groundedSkybox)
      this.groundedSkybox.geometry.dispose()
      const material = this.groundedSkybox.material
      if (Array.isArray(material)) {
        material.forEach((mat) => mat.dispose())
      } else {
        material.dispose()
      }
      this.groundedSkybox = null
    }
    this.groundedSkyboxCanonicalUv = null
  }

  private syncGroundedSkyboxCamera() {
    this.groundedSkyboxCamera.position.copy(this.camera.position)
    this.groundedSkyboxCamera.quaternion.copy(this.camera.quaternion)
    this.groundedSkyboxCamera.fov = this.camera.fov
    this.groundedSkyboxCamera.near = this.camera.near
    this.groundedSkyboxCamera.far = Math.max(this.camera.far, this.groundedSkyboxRadius * 2)
    this.groundedSkyboxCamera.updateProjectionMatrix()
  }

  setGoonVisible(visible: boolean) {
    this.goonVisible = visible
    const avatarRoot = this.getActiveAvatarRoot()
    if (avatarRoot) {
      avatarRoot.visible = visible
    }
    if (this.guidedDufOverlayRoot) {
      this.guidedDufOverlayRoot.visible = visible
    }
  }

  async setSkyboxBackground(url: string | null, options: { forceReload?: boolean } = {}) {
    if (!url) {
      this.skyboxToken += 1
      this.clearSkybox()
      return
    }
    if (url === this.skyboxUrl && !options.forceReload) return

    if (!this.renderer) {
      await this.init()
    }

    const token = ++this.skyboxToken
    this.skyboxUrl = url
    this.syncSkyboxZoomFromCamera()

    try {
      let texture: THREE.Texture = await this.textureLoader.loadAsync(url)
      if (token !== this.skyboxToken) {
        texture.dispose()
        return
      }
      texture.colorSpace = THREE.SRGBColorSpace
      const maxTextureSize = this.getRuntimeSkyboxTextureMaxSize()
      if (maxTextureSize > 0) {
        texture = this.downsampleTextureForRuntime(texture, maxTextureSize, new Map())
      }
      this.ensureSkyboxMesh()
      const material = this.skyboxMesh!.material as THREE.MeshBasicMaterial
      this.clearGroundedSkybox()
      const previousTexture = this.skyboxTexture
      material.map = null
      previousTexture?.dispose()
      material.map = texture
      material.needsUpdate = true
      this.skyboxTexture = texture
      this.loadedSkyboxTextureMaxSize = maxTextureSize
      this.skyboxActive = true
      this.skyboxMesh!.visible = true
      this.syncGroundedSkybox()
    } catch (error) {
      console.warn('[GoonEngine] Failed to load skybox background:', error)
      if (token === this.skyboxToken) {
        this.clearSkybox()
      }
    }
  }

  clearSkybox() {
    this.skyboxActive = false
    this.skyboxUrl = null
    this.clearGroundedSkybox()
    const texture = this.skyboxTexture
    this.skyboxTexture = null
    if (this.skyboxMesh) {
      const material = this.skyboxMesh.material as THREE.MeshBasicMaterial
      material.map = null
      material.needsUpdate = true
      this.skyboxMesh.visible = false
    }
    texture?.dispose()
    this.loadedSkyboxTextureMaxSize = 0
  }

  private disposeMaterial(material: THREE.Material, disposedTextures: Set<THREE.Texture>) {
    const anyMaterial = material as THREE.Material & Record<string, any>
    const maps = [
      'map',
      'normalMap',
      'roughnessMap',
      'metalnessMap',
      'emissiveMap',
      'aoMap',
      'alphaMap',
      'envMap',
      'lightMap',
      'displacementMap',
      'bumpMap'
    ]
    for (const key of maps) {
      const texture = anyMaterial[key]
      if (
        texture &&
        texture.isTexture &&
        typeof texture.dispose === 'function' &&
        !disposedTextures.has(texture)
      ) {
        disposedTextures.add(texture)
        try {
          texture.dispose()
        } catch (error) {
          this.materialDisposeErrorCount += 1
          if (this.materialDisposeErrorCount <= 3) {
            console.warn('[GoonEngine] Failed to dispose texture cleanly:', error)
          } else if (this.materialDisposeErrorCount === 4) {
            console.warn('[GoonEngine] Additional material dispose warnings suppressed.')
          }
        }
      }
    }
    try {
      material.dispose()
    } catch (error) {
      this.materialDisposeErrorCount += 1
      if (this.materialDisposeErrorCount <= 3) {
        console.warn('[GoonEngine] Failed to dispose material cleanly:', error)
      } else if (this.materialDisposeErrorCount === 4) {
        console.warn('[GoonEngine] Additional material dispose warnings suppressed.')
      }
    }
  }

  private disposeObject3D(object: THREE.Object3D) {
    const disposedGeometries = new Set<THREE.BufferGeometry>()
    const disposedMaterials = new Set<THREE.Material>()
    const disposedTextures = new Set<THREE.Texture>()

    object.traverse((child) => {
      const mesh = child as THREE.Mesh
      if (!mesh.isMesh) return
      if (mesh.geometry && !disposedGeometries.has(mesh.geometry)) {
        disposedGeometries.add(mesh.geometry)
        mesh.geometry.dispose()
      }
      const material = mesh.material
      if (Array.isArray(material)) {
        material.forEach((mat) => disposedMaterials.add(mat))
      } else if (material) {
        disposedMaterials.add(material)
      }
    })

    for (const material of disposedMaterials) {
      this.disposeMaterial(material, disposedTextures)
    }
  }

  private disposeVrmScene(scene: THREE.Object3D | null | undefined) {
    if (!scene) return
    this.disposeObject3D(scene)
  }

  setRoomShellTransform(transform: GoonSceneRoomShellTransform | null) {
    this.roomShellTransform = normalizeRoomShellTransform(transform)
    this.applyRoomShellTransform()
  }

  setRoomCameraBoundary(boundary: GoonSceneCameraBoundary | null) {
    this.roomCameraBoundary = normalizeRoomCameraBoundary(boundary)
    if (!this.canUseIndoorCamera() && this.cameraMode === 'indoor') {
      this.cameraMode = 'free'
    } else if (this.cameraMode === 'indoor') {
      this.applyIndoorCameraConstraint()
      this.controls?.update()
    }
  }

  getSuggestedRoomCameraBoundary(): GoonSceneCameraBoundary | null {
    if (!this.roomShell) return null
    this.roomShell.updateWorldMatrix(true, true)
    const worldBounds = new THREE.Box3().setFromObject(this.roomShell)
    if (worldBounds.isEmpty()) return null
    const localBounds = new THREE.Box3().makeEmpty()
    for (const x of [worldBounds.min.x, worldBounds.max.x]) {
      for (const y of [worldBounds.min.y, worldBounds.max.y]) {
        for (const z of [worldBounds.min.z, worldBounds.max.z]) {
          localBounds.expandByPoint(this.roomShell.worldToLocal(new THREE.Vector3(x, y, z)))
        }
      }
    }
    const center = localBounds.getCenter(new THREE.Vector3())
    const size = localBounds.getSize(new THREE.Vector3())
    if (size.x < 0.1 || size.y < 0.1 || size.z < 0.1) return null
    return {
      center: [center.x, center.y, center.z],
      size: [size.x, size.y, size.z],
      rotationY: 0
    }
  }

  private applyRoomShellTransform() {
    const roomShell = this.roomShell
    if (!roomShell) return
    const { position, rotationY, uniformScale } = this.roomShellTransform
    roomShell.position.set(position[0], position[1], position[2])
    roomShell.rotation.set(0, rotationY, 0)
    roomShell.scale.setScalar(uniformScale)
    roomShell.updateWorldMatrix(true, true)
    this.updateShellBounds(roomShell)
    this.reapplyCurrentStagePlacement()
  }

  getRoomShellFloorAlignmentDelta() {
    const roomShell = this.roomShell
    if (!roomShell) return null

    roomShell.updateWorldMatrix(true, true)
    const bounds = new THREE.Box3().setFromObject(roomShell)
    if (
      !Number.isFinite(bounds.min.y) ||
      !Number.isFinite(bounds.max.y) ||
      bounds.max.y <= bounds.min.y
    ) {
      return null
    }

    const stageOrigin = this.sceneRoot.localToWorld(new THREE.Vector3(0, 0, 0))
    const avatarPosition =
      this.getActiveAvatarRoot()?.getWorldPosition(new THREE.Vector3()) ?? stageOrigin
    const sampleRadius = Math.min(
      0.35,
      Math.max(0.05, Math.min(bounds.max.x - bounds.min.x, bounds.max.z - bounds.min.z) * 0.03)
    )
    const samples: Array<[number, number]> = [
      [avatarPosition.x, avatarPosition.z],
      [avatarPosition.x + sampleRadius, avatarPosition.z],
      [avatarPosition.x - sampleRadius, avatarPosition.z],
      [avatarPosition.x, avatarPosition.z + sampleRadius],
      [avatarPosition.x, avatarPosition.z - sampleRadius]
    ]

    let surfaceY: number | null = null
    let surfaceDistance = Number.POSITIVE_INFINITY
    for (const [x, z] of samples) {
      if (x < bounds.min.x || x > bounds.max.x || z < bounds.min.z || z > bounds.max.z) {
        continue
      }
      const candidate = probeNearestStandingSurfaceY({
        objects: [roomShell],
        x,
        z,
        minY: bounds.min.y - 0.5,
        maxY: bounds.max.y + 0.5,
        targetY: stageOrigin.y,
        minNormalY: 0.8
      })
      if (candidate === null) continue
      const distance = Math.abs(candidate - stageOrigin.y)
      if (distance < surfaceDistance) {
        surfaceDistance = distance
        surfaceY = candidate
      }
    }

    if (surfaceY === null) return null
    const parentScale = this.sceneRoot.getWorldScale(new THREE.Vector3())
    if (!Number.isFinite(parentScale.y) || Math.abs(parentScale.y) < 0.0001) return null
    return (stageOrigin.y - surfaceY) / parentScale.y
  }

  async setRoomShell(url: string | null) {
    if (!url) {
      this.roomShellToken += 1
      this.clearRoomShell()
      return
    }
    if (url === this.roomShellUrl) return

    if (!this.renderer) {
      await this.init()
    }

    const token = ++this.roomShellToken
    this.roomShellUrl = url

    try {
      const loader = new GLTFLoader()
      const gltf = await loader.loadAsync(url)
      if (token !== this.roomShellToken) {
        if (gltf?.scene) {
          this.disposeObject3D(gltf.scene)
        }
        return
      }
      const importedScene = gltf.scene ?? gltf.scenes?.[0]
      if (!importedScene) {
        throw new Error('Room shell missing scene')
      }
      if (this.roomShell) {
        this.sceneRoot.remove(this.roomShell)
        this.disposeObject3D(this.roomShell)
      }
      const wrapper = new THREE.Group()
      wrapper.name = 'BatshitRoomShell'
      wrapper.add(importedScene)
      this.roomShell = wrapper
      this.sceneRoot.add(wrapper)
      this.applyRoomShellTransform()
    } catch (error) {
      console.warn('[GoonEngine] Failed to load room shell:', error)
      if (token === this.roomShellToken) {
        this.clearRoomShell()
      }
    }
  }

  clearRoomShell() {
    this.roomShellUrl = null
    if (this.roomShell) {
      this.sceneRoot.remove(this.roomShell)
      this.disposeObject3D(this.roomShell)
      this.roomShell = null
    }
    this.roomShellTransform = normalizeRoomShellTransform()
    this.clearShellBounds()
  }

  async setRoomShellBuilder(builder: GoonRoomShellBuilder | null) {
    this.roomShellBuilder = builder
    const token = ++this.roomShellBuilderToken
    this.clearRoomShellBuilder()
    this.clearBuilderBounds()
    if (!builder) return

    const normalizedBuilder = normalizeGoonRoomShellBuilder(builder)

    if (!this.renderer) {
      await this.init()
    }

    const textureSet = await this.loadRoomShellTextures(normalizedBuilder, token)
    if (token !== this.roomShellBuilderToken) {
      textureSet.textures.forEach((texture) => texture.dispose())
      return
    }

    const group = this.roomShellGeometry.buildRoomShellGeometry(normalizedBuilder, textureSet)
    if (!group) {
      textureSet.textures.forEach((texture) => texture.dispose())
      return
    }

    this.updateBuilderBounds(normalizedBuilder)
    this.roomShellBuilderObject = group
    this.roomShellBuilderTextures = textureSet.textures
    this.sceneRoot.add(group)
  }

  clearRoomShellBuilder() {
    if (this.roomShellBuilderObject) {
      this.sceneRoot.remove(this.roomShellBuilderObject)
      this.disposeObject3D(this.roomShellBuilderObject)
      this.roomShellBuilderObject = null
      for (const texture of this.roomShellBuilderTextures) {
        texture.dispose()
      }
      this.roomShellBuilderTextures = []
    } else if (this.roomShellBuilderTextures.length) {
      for (const texture of this.roomShellBuilderTextures) {
        texture.dispose()
      }
      this.roomShellBuilderTextures = []
    }
    this.roomShellGeometry.clearCutoutGeometryCache()
    this.clearBuilderBounds()
  }

  private getActiveRoomBounds() {
    if (this.roomShellBuilderObject && this.builderBounds) return this.builderBounds
    return this.shellBounds
  }

  private resolvePanMargin(bounds: { minX: number; maxX: number; minZ: number; maxZ: number }) {
    const maxMarginX = Math.max(0, (bounds.maxX - bounds.minX) / 2 - 0.02)
    const maxMarginZ = Math.max(0, (bounds.maxZ - bounds.minZ) / 2 - 0.02)
    return Math.min(this.panEdgeMargin, maxMarginX, maxMarginZ)
  }

  private clampRoomPosition(position: THREE.Vector3) {
    const bounds = this.getActiveRoomBounds()
    if (!bounds) return position
    const margin = this.resolvePanMargin(bounds)
    const clampedX = THREE.MathUtils.clamp(position.x, bounds.minX + margin, bounds.maxX - margin)
    const clampedZ = THREE.MathUtils.clamp(position.z, bounds.minZ + margin, bounds.maxZ - margin)
    return new THREE.Vector3(clampedX, position.y, clampedZ)
  }

  private resetPanOffset() {
    this.panOffset.set(0, 0, 0)
  }

  private setMarkerAnchor(position: THREE.Vector3) {
    this.markerAnchor.copy(position)
    this.hasMarkerAnchor = true
  }

  private resolveCurrentPlacementPosture() {
    return this.animationOverridePosture ?? this.baseLoopPosture
  }

  private getStandingBaseY() {
    return this.sceneRootOffsetY
  }

  private resolveStandingSurfaceProbeCeiling(baseY: number) {
    let ceiling = baseY + 1.5
    for (const object of this.propObjects.values()) {
      object.updateWorldMatrix(true, true)
      const box = this.tempBox.setFromObject(object)
      if (!Number.isFinite(box.max.y)) continue
      ceiling = Math.max(ceiling, box.max.y + STANDING_SURFACE_PROBE_PADDING)
    }
    return ceiling
  }

  private resolveDraggedStandingPosition(desired: THREE.Vector3) {
    const clamped = this.clampRoomPosition(desired)
    const baseY = this.getStandingBaseY()
    const surfaceY = probeStandingSurfaceY({
      objects: Array.from(this.propObjects.values()),
      x: clamped.x,
      z: clamped.z,
      minY: baseY - STANDING_SURFACE_CLEARANCE,
      maxY: this.resolveStandingSurfaceProbeCeiling(baseY),
      clearance: STANDING_SURFACE_CLEARANCE,
      minNormalY: STANDING_SURFACE_MIN_NORMAL_Y
    })
    clamped.y = surfaceY ?? baseY
    return clamped
  }

  private applyPanDelta(delta: THREE.Vector3) {
    const avatarRoot = this.getActiveAvatarRoot()
    if (!avatarRoot || !this.hasMarkerAnchor) return
    const previousVisualPosition = avatarRoot.position.clone()
    this.anchorTransition = null
    const target = this.markerAnchor.clone().add(this.panOffset).add(delta)
    const currentPlacementPosture = this.resolveCurrentPlacementPosture()
    const clamped =
      currentPlacementPosture === 'stand'
        ? this.resolveDraggedStandingPosition(target)
        : this.clampRoomPosition(target)
    this.panOffset.set(clamped.x - this.markerAnchor.x, 0, clamped.z - this.markerAnchor.z)
    const visualPosition = clamped.clone()
    visualPosition.y += this.markerAuthoringVerticalOffset
    avatarRoot.position.copy(visualPosition)
    this.recenterCameraTo(visualPosition, previousVisualPosition)
    this.suppressCameraUntil = performance.now() + 120
  }

  private reapplyCurrentStagePlacement() {
    const avatarRoot = this.getActiveAvatarRoot()
    if (!avatarRoot || !this.hasMarkerAnchor) return
    const target = this.markerAnchor.clone().add(this.panOffset)
    const currentPlacementPosture = this.resolveCurrentPlacementPosture()
    const clamped =
      currentPlacementPosture === 'stand'
        ? this.resolveDraggedStandingPosition(target)
        : this.clampRoomPosition(target)
    const visualPosition = clamped.clone()
    visualPosition.y += this.markerAuthoringVerticalOffset
    avatarRoot.position.copy(visualPosition)
    this.recenterCameraTo(visualPosition)
  }

  private updateBuilderBounds(builder: NormalizedRoomShellBuilder) {
    const halfWidth = builder.width / 2
    const halfDepth = builder.depth / 2
    const offsetX = this.sceneRoot.position.x
    const offsetY = this.sceneRoot.position.y
    const offsetZ = this.sceneRoot.position.z
    this.builderBounds = {
      minX: offsetX - halfWidth,
      maxX: offsetX + halfWidth,
      minY: offsetY,
      maxY: offsetY + builder.height,
      minZ: offsetZ - halfDepth,
      maxZ: offsetZ + halfDepth
    }
  }

  private clearBuilderBounds() {
    this.builderBounds = null
  }

  private updateShellBounds(object: THREE.Object3D) {
    object.updateWorldMatrix(true, true)
    const box = new THREE.Box3().setFromObject(object)
    if (!Number.isFinite(box.min.x) || !Number.isFinite(box.max.x)) {
      this.shellBounds = null
      return
    }
    this.shellBounds = {
      minX: box.min.x,
      maxX: box.max.x,
      minY: box.min.y,
      maxY: box.max.y,
      minZ: box.min.z,
      maxZ: box.max.z
    }
  }

  private clearShellBounds() {
    this.shellBounds = null
  }

  private getStandingBounds() {
    const bounds = this.getActiveRoomBounds()
    if (!bounds) return null
    const margin = this.resolvePanMargin(bounds)
    return {
      minX: bounds.minX + margin,
      maxX: bounds.maxX - margin,
      minZ: bounds.minZ + margin,
      maxZ: bounds.maxZ - margin
    }
  }

  private measureObjectLocalBounds(object: THREE.Object3D): PropLocalBounds | null {
    const savedPosition = object.position.clone()
    const savedQuaternion = object.quaternion.clone()
    const savedScale = object.scale.clone()

    object.position.set(0, 0, 0)
    object.quaternion.identity()
    object.scale.set(1, 1, 1)
    object.updateWorldMatrix(true, true)

    const box = new THREE.Box3().setFromObject(object)

    object.position.copy(savedPosition)
    object.quaternion.copy(savedQuaternion)
    object.scale.copy(savedScale)
    object.updateWorldMatrix(true, true)

    if (!Number.isFinite(box.min.x) || !Number.isFinite(box.max.x)) return null
    return {
      min: box.min.clone(),
      max: box.max.clone()
    }
  }

  private isStandingPointBlocked(position: THREE.Vector3) {
    for (const [propId, object] of this.propObjects.entries()) {
      const bounds = this.propLocalBounds.get(propId)
      if (!bounds) continue
      const local = object.worldToLocal(position.clone())
      const withinVerticalSpan =
        local.y >= bounds.min.y - STANDING_VERTICAL_MARGIN &&
        local.y <= bounds.max.y + STANDING_VERTICAL_MARGIN
      if (!withinVerticalSpan) continue
      const withinX =
        local.x >= bounds.min.x - STANDING_BLOCKER_MARGIN &&
        local.x <= bounds.max.x + STANDING_BLOCKER_MARGIN
      const withinZ =
        local.z >= bounds.min.z - STANDING_BLOCKER_MARGIN &&
        local.z <= bounds.max.z + STANDING_BLOCKER_MARGIN
      if (withinX && withinZ) return true
    }
    return false
  }

  private resolveNearestStandingPosition(desired: THREE.Vector3) {
    const bounds = this.getStandingBounds()
    const point = findNearestValidStandingPoint({
      desired: { x: desired.x, z: desired.z },
      bounds,
      isBlocked: (candidate) =>
        this.isStandingPointBlocked(new THREE.Vector3(candidate.x, desired.y, candidate.z)),
      step: STANDING_SEARCH_STEP,
      directions: STANDING_SEARCH_DIRECTIONS
    })
    if (!point) {
      return this.clampRoomPosition(desired)
    }
    return new THREE.Vector3(point.x, desired.y, point.z)
  }

  private async loadRoomShellTextures(
    builder: NormalizedRoomShellBuilder,
    token: number
  ): Promise<RoomShellTextureSet> {
    const textures: THREE.Texture[] = []
    const textureCache = new Map<string, Promise<THREE.Texture | null>>()
    const trackedTextures = new Set<THREE.Texture>()
    const trackTexture = (texture: THREE.Texture) => {
      if (trackedTextures.has(texture)) return
      trackedTextures.add(texture)
      textures.push(texture)
    }
    const loadBaseTexture = async (file: GoonFileRef) => {
      try {
        let texture: THREE.Texture = await this.textureLoader.loadAsync(file.url)
        if (token !== this.roomShellBuilderToken) {
          texture.dispose()
          return null
        }
        texture.colorSpace = THREE.SRGBColorSpace
        texture.format = THREE.RGBAFormat
        texture.needsUpdate = true
        const maxTextureSize = this.getRuntimeTextureMaxSize()
        if (maxTextureSize > 0) {
          texture = this.downsampleTextureForRuntime(texture, maxTextureSize, new Map())
          texture.colorSpace = THREE.SRGBColorSpace
          texture.format = THREE.RGBAFormat
          texture.needsUpdate = true
        }
        trackTexture(texture)
        return texture
      } catch {
        return null
      }
    }
    const loadTexture = async (file?: GoonFileRef | null) => {
      if (!file?.url) return null
      if (!textureCache.has(file.url)) {
        textureCache.set(file.url, loadBaseTexture(file))
      }
      const baseTexture = await textureCache.get(file.url)
      if (!baseTexture || token !== this.roomShellBuilderToken) return null
      const texture = baseTexture.clone()
      texture.colorSpace = THREE.SRGBColorSpace
      texture.format = THREE.RGBAFormat
      texture.needsUpdate = true
      trackTexture(texture)
      return texture
    }

    const { floor, ceiling, walls } = builder.surfaces
    const { exteriorAprons, terrainSkirt } = builder
    const resolveTrim = (side: NormalizedRoomSurfaceSide) =>
      side.transparency === 'cutout' ? side.trimTexture ?? DEFAULT_TRIM_TEXTURE : null
    const floorTexture = await loadTexture(floor.interior.texture)
    const floorExteriorTexture = await loadTexture(floor.exterior.texture)
    const ceilingTexture = await loadTexture(ceiling.interior.texture)
    const ceilingExteriorTexture = await loadTexture(ceiling.exterior.texture)
    const northTexture = await loadTexture(walls.north.interior.texture)
    const northTrimTexture = await loadTexture(resolveTrim(walls.north.interior))
    const northExteriorTexture = await loadTexture(walls.north.exterior.texture)
    const southTexture = await loadTexture(walls.south.interior.texture)
    const southTrimTexture = await loadTexture(resolveTrim(walls.south.interior))
    const southExteriorTexture = await loadTexture(walls.south.exterior.texture)
    const eastTexture = await loadTexture(walls.east.interior.texture)
    const eastTrimTexture = await loadTexture(resolveTrim(walls.east.interior))
    const eastExteriorTexture = await loadTexture(walls.east.exterior.texture)
    const westTexture = await loadTexture(walls.west.interior.texture)
    const westTrimTexture = await loadTexture(resolveTrim(walls.west.interior))
    const westExteriorTexture = await loadTexture(walls.west.exterior.texture)
    const northApronTexture = await loadTexture(exteriorAprons.north.surface.texture)
    const southApronTexture = await loadTexture(exteriorAprons.south.surface.texture)
    const eastApronTexture = await loadTexture(exteriorAprons.east.surface.texture)
    const westApronTexture = await loadTexture(exteriorAprons.west.surface.texture)
    const terrainSkirtTexture =
      terrainSkirt.projection === 'skybox-ground'
        ? null
        : await loadTexture(terrainSkirt.surface.texture)

    return {
      textures,
      floorTexture,
      ceilingTexture,
      northTexture,
      southTexture,
      eastTexture,
      westTexture,
      northTrimTexture,
      southTrimTexture,
      eastTrimTexture,
      westTrimTexture,
      floorExteriorTexture,
      ceilingExteriorTexture,
      northExteriorTexture,
      southExteriorTexture,
      eastExteriorTexture,
      westExteriorTexture,
      northApronTexture,
      southApronTexture,
      eastApronTexture,
      westApronTexture,
      terrainSkirtTexture
    }
  }

  async setSceneProps(props: GoonSceneProp[] = []) {
    this.sceneProps = Array.isArray(props) ? props : []
    const token = ++this.propToken
    for (const object of this.propObjects.values()) {
      this.sceneRoot.remove(object)
      this.disposeObject3D(object)
    }
    this.propObjects.clear()
    this.propLocalBounds.clear()
    if (this.editTarget?.type === 'prop') {
      this.clearEditTarget()
    }

    if (!this.sceneProps.length) {
      this.applyMarkerForPosture(this.resolveCurrentPlacementPosture())
      return
    }

    const loader = new GLTFLoader()
    for (const prop of this.sceneProps) {
      if (token !== this.propToken) return
      const url = prop?.fileRef?.url
      if (!url) continue
      try {
        const gltf = await loader.loadAsync(url)
        if (token !== this.propToken) {
          if (gltf?.scene) {
            this.disposeObject3D(gltf.scene)
          }
          return
        }
        const object = gltf.scene ?? gltf.scenes?.[0]
        if (!object) continue
        const localBounds = this.measureObjectLocalBounds(object)
        const position = prop.position ?? [0, 0, 0]
        const rotation = prop.rotation ?? [0, 0, 0]
        const scale = prop.scale ?? [1, 1, 1]
        object.position.set(position[0], position[1], position[2])
        object.rotation.set(rotation[0], rotation[1], rotation[2])
        object.scale.set(scale[0], scale[1], scale[2])
        this.sceneRoot.add(object)
        this.propObjects.set(prop.id, object)
        if (localBounds) {
          this.propLocalBounds.set(prop.id, localBounds)
        }
      } catch (error) {
        console.warn('[GoonEngine] Failed to load scene prop:', error)
      }
    }

    this.applyMarkerForPosture(this.resolveCurrentPlacementPosture())
  }

  setSceneMarkers(
    markers: GoonSceneMarkers = {},
    options: { reapplyPlacement?: boolean } = {}
  ) {
    this.sceneMarkers = { ...markers }
    if (
      this.editTarget?.type === 'marker' &&
      !this.findMarker(this.editTarget.posture, this.editTarget.id)
    ) {
      this.clearEditTarget()
    }
    if (options.reapplyPlacement !== false) {
      this.applyMarkerForPosture(this.resolveCurrentPlacementPosture())
    }
  }

  setSceneAmbience(ambience: GoonSceneAmbience | null) {
    const config = normalizeGoonSceneAmbience(ambience)
    this.clearSceneAmbience()
    if (!config.enabled || config.intensity <= 0) return

    const preset = AMBIENCE_PRESET_RUNTIME[config.preset]
    const particleCount = Math.round(
      THREE.MathUtils.lerp(preset.count[0], preset.count[1], config.intensity)
    )
    if (particleCount <= 0) return

    const bounds = this.resolveAmbienceBounds(config)
    const positions = new Float32Array(particleCount * 3)
    const velocities = new Float32Array(particleCount * 3)
    const phases = new Float32Array(particleCount)
    const random = this.createSeededRandom(config.seed)
    const sprite = this.createAmbienceSpriteTexture()
    const layer = createGoonSceneAmbienceSpriteLayer({
      positions,
      color: preset.color,
      size: preset.size,
      opacity: preset.opacity,
      texture: sprite,
      additive: preset.additive
    })

    const runtime: SceneAmbienceRuntime = {
      config,
      preset,
      object: layer.object,
      material: layer.material,
      positionAttribute: layer.positionAttribute,
      sprite,
      positions,
      velocities,
      phases,
      bounds,
      random
    }
    for (let index = 0; index < particleCount; index += 1) {
      this.resetAmbienceParticle(runtime, index, false)
    }
    this.sceneRoot.add(layer.object)
    this.sceneAmbienceRuntime = runtime
  }

  private clearSceneAmbience() {
    const runtime = this.sceneAmbienceRuntime
    if (!runtime) return
    this.sceneRoot.remove(runtime.object)
    runtime.material.dispose()
    runtime.sprite?.dispose()
    this.sceneAmbienceRuntime = null
  }

  private createSeededRandom(seed: number) {
    let state = seed >>> 0
    return () => {
      state += 0x6d2b79f5
      let value = state
      value = Math.imul(value ^ (value >>> 15), value | 1)
      value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
      return ((value ^ (value >>> 14)) >>> 0) / 4294967296
    }
  }

  private createAmbienceSpriteTexture() {
    if (typeof document === 'undefined') return null
    const canvas = document.createElement('canvas')
    canvas.width = 32
    canvas.height = 32
    const context = canvas.getContext('2d')
    if (!context) return null
    const gradient = context.createRadialGradient(16, 16, 1, 16, 16, 16)
    gradient.addColorStop(0, 'rgba(255,255,255,1)')
    gradient.addColorStop(0.45, 'rgba(255,255,255,0.8)')
    gradient.addColorStop(1, 'rgba(255,255,255,0)')
    context.fillStyle = gradient
    context.fillRect(0, 0, 32, 32)
    const texture = new THREE.CanvasTexture(canvas)
    texture.colorSpace = THREE.SRGBColorSpace
    texture.needsUpdate = true
    return texture
  }

  private resolveAmbienceBounds(config: NormalizedGoonSceneAmbience) {
    return resolveGoonSceneAmbienceBounds(this.roomShellBuilder, config.placement)
  }

  private resetAmbienceParticle(
    runtime: SceneAmbienceRuntime,
    index: number,
    fromBoundary: boolean
  ) {
    const { bounds, config, preset, positions, velocities, phases, random } = runtime
    const offset = index * 3
    let x = THREE.MathUtils.lerp(bounds.minX, bounds.maxX, random())
    let z = THREE.MathUtils.lerp(bounds.minZ, bounds.maxZ, random())
    if (config.placement === 'outside') {
      for (let attempt = 0; attempt < 12; attempt += 1) {
        if (Math.abs(x) > bounds.innerHalfX || Math.abs(z) > bounds.innerHalfZ) break
        x = THREE.MathUtils.lerp(bounds.minX, bounds.maxX, random())
        z = THREE.MathUtils.lerp(bounds.minZ, bounds.maxZ, random())
      }
      if (Math.abs(x) <= bounds.innerHalfX && Math.abs(z) <= bounds.innerHalfZ) {
        x = Math.sign(x || 1) * bounds.innerHalfX
      }
    }

    const y =
      fromBoundary && preset.direction === 'fall'
        ? bounds.maxY
        : fromBoundary && preset.direction === 'rise'
          ? bounds.minY
          : THREE.MathUtils.lerp(bounds.minY, bounds.maxY, random())
    const drift = preset.horizontalSpeed * config.speed
    const fall = preset.verticalSpeed * config.speed
    positions[offset] = x
    positions[offset + 1] = y
    positions[offset + 2] = z
    velocities[offset] = config.wind[0] * drift + (random() - 0.5) * preset.jitter
    velocities[offset + 1] =
      preset.direction === 'fall'
        ? -fall * (0.75 + random() * 0.5)
        : preset.direction === 'rise'
          ? fall * (0.75 + random() * 0.5)
          : (random() - 0.5) * fall
    velocities[offset + 2] = config.wind[1] * drift + (random() - 0.5) * preset.jitter
    phases[index] = random() * Math.PI * 2
  }

  setPostureDefinitions(postures: GoonPostureMap = {}) {
    this.postureDefinitions = {
      ...BUILTIN_GOON_POSTURES,
      ...postures
    }
    this.applyMarkerForPosture(this.resolveCurrentPlacementPosture())
  }

  finishMarkerAuthoring(position: THREE.Vector3, rotationY?: number) {
    if (!this.getActiveAvatarRoot()) return
    this.markerAuthoringVerticalOffset = 0
    this.anchorTransition = null
    this.resetPanOffset()
    this.applyResolvedPlacement({
      position: position.clone(),
      rotationY
    })
  }

  setEditMode(mode: 'translate' | 'rotate' | 'scale') {
    if (!this.transformControls) return
    this.transformControls.setMode(mode)
    if (mode === 'scale' && this.editTarget?.type === 'prop') {
      const object = this.propObjects.get(this.editTarget.id)
      this.scaleDragBaseline = object ? object.scale.clone() : null
    } else {
      this.scaleDragBaseline = null
    }
    this.emitEditTransformChange()
  }

  async setEditTarget(
    target:
      | { type: 'prop'; id: string }
      | { type: 'marker'; id: string; posture: GoonPosture }
      | null
  ) {
    if (!this.transformControls) return false
    if (!target) {
      this.clearEditTarget()
      return true
    }

    if (target.type === 'prop') {
      const object = this.propObjects.get(target.id)
      if (!object) return false
      this.clearMarkerHelper()
      this.transformControls.attach(object)
      this.transformControls.enabled = true
      if (this.transformControlsHelper) {
        this.transformControlsHelper.visible = true
      }
      const worldPosition = object.getWorldPosition(new THREE.Vector3())
      this.focusCameraOn(worldPosition)
      this.editTarget = target
      this.scaleDragBaseline = object.scale.clone()
      this.emitEditTransformChange()
      return true
    }

    const marker = this.findMarker(target.posture, target.id)
    if (!marker) return false
    this.applyMarkerForPosture(target.posture, target.id)
    this.setGoonVisible(true)
    const helper = this.ensureMarkerHelper(target.posture, marker)
    if (!helper) return false
    this.transformControls.attach(helper)
    this.transformControls.enabled = true
    if (this.transformControlsHelper) {
      this.transformControlsHelper.visible = true
    }
    const worldPosition = this.resolveMarkerWorldPosition(marker)
    this.focusCameraOn(worldPosition)
    this.editTarget = target
    this.scaleDragBaseline = null
    this.emitEditTransformChange()
    return true
  }

  clearEditTarget() {
    if (this.transformControls) {
      this.transformControls.detach()
      this.transformControls.enabled = false
      if (this.transformControlsHelper) {
        this.transformControlsHelper.visible = false
      }
    }
    this.clearMarkerHelper()
    this.editTarget = null
    this.scaleDragBaseline = null
    this.emitEditTransformChange()
  }

  getEditTransform(): GoonEditTransform | null {
    if (!this.editTarget) return null
    if (this.editTarget.type === 'prop') {
      const object = this.propObjects.get(this.editTarget.id)
      if (!object) return null
      return {
        position: [object.position.x, object.position.y, object.position.z] as [number, number, number],
        rotation: [object.rotation.x, object.rotation.y, object.rotation.z] as [number, number, number],
        scale: [object.scale.x, object.scale.y, object.scale.z] as [number, number, number]
      }
    }
    if (!this.markerEditHelper) return null
    return {
      position: [
        this.markerEditHelper.position.x,
        this.markerEditHelper.position.y,
        this.markerEditHelper.position.z
      ] as [number, number, number],
      rotation: [
        this.markerEditHelper.rotation.x,
        this.markerEditHelper.rotation.y,
        this.markerEditHelper.rotation.z
      ] as [number, number, number],
      scale: [1, 1, 1] as [number, number, number]
    }
  }

  private emitEditTransformChange() {
    if (!this.onEditTransformChange) return
    this.onEditTransformChange(this.getEditTransform())
  }

  private enforcePropScaleAspectLock() {
    if (!this.scaleAspectLock || this.transformControls?.mode !== 'scale') return
    if (this.editTarget?.type !== 'prop') return
    const object = this.propObjects.get(this.editTarget.id)
    if (!object) return

    const baseline = this.scaleDragBaseline ?? object.scale.clone()
    this.scaleDragBaseline = baseline
    const ratios = [object.scale.x, object.scale.y, object.scale.z]
      .map((value, index) => {
        const source = index === 0 ? baseline.x : index === 1 ? baseline.y : baseline.z
        return source !== 0 ? value / source : 1
      })
      .filter((value) => Number.isFinite(value) && value > 0)
    if (ratios.length === 0) return

    let uniformRatio = ratios[0] ?? 1
    for (const ratio of ratios) {
      if (Math.abs(ratio - 1) > Math.abs(uniformRatio - 1)) {
        uniformRatio = ratio
      }
    }

    const nextScale = new THREE.Vector3(
      baseline.x * uniformRatio,
      baseline.y * uniformRatio,
      baseline.z * uniformRatio
    )
    if (nextScale.distanceToSquared(object.scale) < 0.000001) return

    this.suppressTransformObjectChange = true
    object.scale.copy(nextScale)
    object.updateMatrixWorld(true)
    this.suppressTransformObjectChange = false
  }

  getGoonMarkerSnapshot(propId?: string) {
    const currentPlacement = this.getCurrentVisualPlacement()
    if (!currentPlacement) return null
    const parent = propId ? this.propObjects.get(propId) ?? this.sceneRoot : this.sceneRoot
    const snapshot = captureMarkerFromAvatarPlacement({
      avatarWorldPosition: currentPlacement.position,
      worldYaw: currentPlacement.rotationY,
      baseY: this.getStandingBaseY(),
      parent
    })
    return snapshot
  }

  private findMarker(posture: GoonPosture, markerId: string) {
    const list = this.getSceneMarkerList(posture)
    return list?.find((marker) => marker.id === markerId) ?? null
  }

  private getSceneMarkerList(posture: GoonPosture) {
    return this.sceneMarkers[posture] ?? []
  }

  private resolveMarkerColor(posture: GoonPosture) {
    const basePosture = resolveBasePosture(posture, undefined, this.postureDefinitions)
    return basePosture === 'stand' ? 0x38bdf8 : basePosture === 'sit' ? 0x34d399 : 0xa78bfa
  }

  private ensureMarkerHelper(posture: GoonPosture, marker: GoonSceneMarker) {
    this.clearMarkerHelper()
    const color = this.resolveMarkerColor(posture)
    const geometry = new THREE.SphereGeometry(0.05, 16, 12)
    const material = new THREE.MeshBasicMaterial({ color })
    const mesh = new THREE.Mesh(geometry, material)
    mesh.position.set(marker.position[0], marker.position[1], marker.position[2])
    if (marker.rotation) {
      mesh.rotation.set(marker.rotation[0] ?? 0, marker.rotation[1] ?? 0, marker.rotation[2] ?? 0)
    }
    const parent = marker.propId ? this.propObjects.get(marker.propId) : null
    if (parent) {
      parent.add(mesh)
      this.markerEditParent = parent
    } else {
      this.sceneRoot.add(mesh)
      this.markerEditParent = this.sceneRoot
    }
    this.markerEditHelper = mesh
    return mesh
  }

  private clearMarkerHelper() {
    if (!this.markerEditHelper) return
    if (this.markerEditParent) {
      this.markerEditParent.remove(this.markerEditHelper)
    } else {
      this.sceneRoot.remove(this.markerEditHelper)
    }
    const geometry = (this.markerEditHelper as THREE.Mesh).geometry
    if (geometry) geometry.dispose()
    const material = (this.markerEditHelper as THREE.Mesh).material
    if (Array.isArray(material)) {
      material.forEach((mat) => mat.dispose())
    } else if (material) {
      material.dispose()
    }
    this.markerEditHelper = null
    this.markerEditParent = null
  }

  private resolveMarkerWorldPosition(marker: GoonSceneMarker): THREE.Vector3 {
    const parent = marker.propId ? this.propObjects.get(marker.propId) ?? this.sceneRoot : this.sceneRoot
    return resolveMarkerWorldPositionFromParent(marker, parent)
  }

  private resolveMarkerWorldRotationY(marker: GoonSceneMarker) {
    const parent = marker.propId ? this.propObjects.get(marker.propId) ?? this.sceneRoot : this.sceneRoot
    return resolveMarkerWorldYaw(marker, parent)
  }

  private applyMarkerForPosture(
    posture: GoonPosture,
    preferredMarkerId?: string,
    options: PlacementOptions = {}
  ) {
    this.resetPanOffset()
    this.anchorTransition = null
    const placement = this.resolvePosturePlacement(posture, preferredMarkerId)
    if (!placement) return
    this.applyResolvedPlacement(placement, options)
  }

  private resolveBuiltInPosturePlacement(
    posture: GoonBasePosture,
    preferredMarkerId?: string
  ): PosturePlacement | null {
    const avatarRoot = this.getActiveAvatarRoot()
    if (!avatarRoot) return null
    const baseY = this.getStandingBaseY()
    const currentPosition = avatarRoot.position.clone()

    if (posture === 'stand') {
      const desiredFloorPosition = new THREE.Vector3(currentPosition.x, baseY, currentPosition.z)
      return {
        position: this.resolveNearestStandingPosition(desiredFloorPosition)
      }
    }

    const postureMarkers = this.getSceneMarkerList(posture)
    const marker =
      (preferredMarkerId
        ? postureMarkers.find((candidate) => candidate.id === preferredMarkerId)
        : null) ??
      postureMarkers[0]

    if (!marker) {
      return {
        position: this.resolveNearestStandingPosition(
          new THREE.Vector3(currentPosition.x, baseY, currentPosition.z)
        )
      }
    }

    const worldPosition = this.resolveMarkerWorldPosition(marker)
    return {
      position: this.clampRoomPosition(
        new THREE.Vector3(worldPosition.x, worldPosition.y + baseY, worldPosition.z)
      ),
      rotationY: this.resolveMarkerWorldRotationY(marker)
    }
  }

  private resolvePosturePlacement(posture: GoonPosture, preferredMarkerId?: string): PosturePlacement | null {
    const exactMarker =
      (preferredMarkerId ? this.findMarker(posture, preferredMarkerId) : null) ??
      this.getSceneMarkerList(posture)[0]

    if (exactMarker) {
      const worldPosition = this.resolveMarkerWorldPosition(exactMarker)
      return {
        position: this.clampRoomPosition(
          new THREE.Vector3(
            worldPosition.x,
            worldPosition.y + this.getStandingBaseY(),
            worldPosition.z
          )
        ),
        rotationY: this.resolveMarkerWorldRotationY(exactMarker)
      }
    }

    const basePosture = resolveBasePosture(posture, undefined, this.postureDefinitions)
    return this.resolveBuiltInPosturePlacement(basePosture)
  }

  private applyResolvedPlacement(placement: PosturePlacement, options: PlacementOptions = {}) {
    const avatarRoot = this.getActiveAvatarRoot()
    if (!avatarRoot) return
    this.setMarkerAnchor(placement.position)
    const visualPosition = placement.position.clone()
    visualPosition.y += this.markerAuthoringVerticalOffset
    avatarRoot.position.copy(visualPosition)
    if (typeof placement.rotationY === 'number') {
      this.goonRotation = placement.rotationY
      avatarRoot.rotation.y = placement.rotationY
    }
    if (!options.preserveCamera) {
      this.recenterCameraTo(visualPosition)
    }
  }

  private transitionToPosture(
    posture: GoonPosture,
    preferredMarkerId?: string,
    durationMs = POSTURE_TRANSITION_MS,
    options: PlacementOptions = {}
  ) {
    this.resetPanOffset()
    const placement = this.resolvePosturePlacement(posture, preferredMarkerId)
    if (!placement) return
    this.transitionToPlacement(placement, durationMs, options)
  }

  private transitionToPlacement(
    placement: PosturePlacement,
    durationMs = POSTURE_TRANSITION_MS,
    options: PlacementOptions = {}
  ) {
    const avatarRoot = this.getActiveAvatarRoot()
    if (!avatarRoot || !this.controls || durationMs <= 0) {
      this.anchorTransition = null
      this.applyResolvedPlacement(placement, options)
      return
    }

    const fromTarget = this.controls.target.clone()
    const fromCamera = this.camera.position.clone()
    const cameraOffset = fromCamera.clone().sub(fromTarget)
    const toTarget = placement.position.clone().add(this.goonTargetOffset)
    const toCamera = toTarget.clone().add(cameraOffset)

    this.anchorTransition = {
      startTime: performance.now(),
      durationMs,
      fromPosition: avatarRoot.position.clone(),
      toPosition: placement.position.clone(),
      fromRotationY: avatarRoot.rotation.y,
      toRotationY: placement.rotationY ?? avatarRoot.rotation.y,
      fromTarget,
      toTarget,
      fromCamera,
      toCamera,
      preserveCamera: options.preserveCamera === true
    }
  }

  private easeAnchorTransition(progress: number) {
    return progress * progress * (3 - 2 * progress)
  }

  private lerpAngle(from: number, to: number, progress: number) {
    const delta = Math.atan2(Math.sin(to - from), Math.cos(to - from))
    return from + delta * progress
  }

  private updateAnchorTransition(now: number) {
    const avatarRoot = this.getActiveAvatarRoot()
    if (!this.anchorTransition || !avatarRoot || !this.controls) return

    const rawProgress = (now - this.anchorTransition.startTime) / this.anchorTransition.durationMs
    const progress = this.easeAnchorTransition(THREE.MathUtils.clamp(rawProgress, 0, 1))

    const position = this.anchorTransition.fromPosition
      .clone()
      .lerp(this.anchorTransition.toPosition, progress)
    const target = this.anchorTransition.fromTarget
      .clone()
      .lerp(this.anchorTransition.toTarget, progress)
    const cameraPosition = this.anchorTransition.fromCamera
      .clone()
      .lerp(this.anchorTransition.toCamera, progress)
    const rotationY = this.lerpAngle(
      this.anchorTransition.fromRotationY,
      this.anchorTransition.toRotationY,
      progress
    )

    this.setMarkerAnchor(position)
    avatarRoot.position.copy(position)
    this.goonRotation = rotationY
    avatarRoot.rotation.y = rotationY
    if (!this.anchorTransition.preserveCamera) {
      // per-frame programmatic move: suppress BEFORE update() — the controls
      // 'change' event fires synchronously inside it
      this.suppressCameraUntil = now + 120
      this.controls.target.copy(target)
      this.camera.position.copy(cameraPosition)
      this.controls.update()
      this.syncSkyboxZoomFromCamera()
    }

    if (rawProgress >= 1) {
      this.anchorTransition = null
      this.suppressCameraUntil = now + 120
    }
  }

  private focusCameraOn(position: THREE.Vector3) {
    if (!this.controls) return
    const offset = this.camera.position.clone().sub(this.controls.target)
    this.controls.target.copy(position)
    this.camera.position.copy(position.clone().add(offset))
    this.camera.updateProjectionMatrix()
    this.suppressCameraUntil = performance.now() + 120
    this.controls.update()
    this.syncSkyboxZoomFromCamera()
  }

  private recenterCameraTo(position: THREE.Vector3, previousGoonPosition?: THREE.Vector3) {
    if (!this.controls) return
    if (previousGoonPosition) {
      const resolved = resolveGoonRelativeRecenter({
        currentCameraPosition: this.camera.position,
        currentOrbitTarget: this.controls.target,
        currentGoonPosition: previousGoonPosition,
        nextGoonPosition: position
      })
      this.controls.target.copy(resolved.nextTarget)
      this.camera.position.copy(resolved.nextCameraPosition)
    } else {
      const target = position.clone().add(this.goonTargetOffset)
      const offset = this.camera.position.clone().sub(this.controls.target)
      this.controls.target.copy(target)
      this.camera.position.copy(target.clone().add(offset))
    }
    this.camera.updateProjectionMatrix()
    this.suppressCameraUntil = performance.now() + 120
    this.controls.update()
    this.syncSkyboxZoomFromCamera()
  }


  setQuality(quality: GoonEngineQuality) {
    const previousSkyboxMaxSize = this.loadedSkyboxTextureMaxSize
    this.quality = quality
    if (!this.renderer) return

    const devicePixelRatio = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1
    const ratio = this.embeddedWebKitRuntime
      ? quality === 'low'
        ? 1
        : quality === 'ultra'
          ? Math.min(Math.max(devicePixelRatio, 1.25), 1.5)
          : Math.min(Math.max(devicePixelRatio * 0.75, 1), 1.25)
      : quality === 'low'
        ? 1
        : quality === 'ultra'
          ? Math.min(Math.max(devicePixelRatio * 1.3, 2.4), 3)
        : quality === 'high'
          ? Math.min(Math.max(devicePixelRatio * 1.15, 1.9), 2.5)
          : Math.min(Math.max(devicePixelRatio * 1.05, 1.5), 2)

    this.renderScale = quality === 'low' ? 0.8 : this.embeddedWebKitRuntime ? 0.9 : 1
    this.renderer.setPixelRatio(ratio)
    this.targetFrameIntervalMs = quality === 'low' || this.embeddedWebKitRuntime ? 1000 / 30 : 1000 / 60
    this.poseUpdateIntervalMs = Math.max(
      this.coveragePoseIntervalMs,
      quality === 'low' || this.embeddedWebKitRuntime ? 1000 / 30 : 0
    )
    this.applyMaterialEdgeSmoothing()
    this.handleResize()
    this.refreshSkyboxBudgetRuntimeStatus()

    const nextSkyboxMaxSize = this.getRuntimeSkyboxTextureMaxSize()
    if (
      this.skyboxUrl &&
      this.skyboxTexture &&
      previousSkyboxMaxSize !== nextSkyboxMaxSize
    ) {
      void this.setSkyboxBackground(this.skyboxUrl, { forceReload: true })
    }
  }

  setPaused(paused: boolean) {
    if (this.paused === paused) return
    this.paused = paused
    if (!this.renderer) return

    if (paused) {
      this.renderer.setAnimationLoop(null)
    } else {
      this.clock.reset()
      this.lastFrameTime = performance.now()
      this.lastFpsTime = this.lastFrameTime
      this.lastPoseUpdateTime = this.lastFrameTime
      this.frameCounter = 0
      this.renderer.setAnimationLoop(() => this.update())
    }
  }

  setLipSyncEnabled(value: boolean) {
    this.lipSyncEnabled = value
  }

  setLipSyncMode(value: GoonLipSyncMode) {
    this.lipSyncMode = value
  }

  setEyeContactEnabled(value: boolean) {
    if (!this.eyeContactEnabled && value) {
      this.eyeContactLastYawAbs = null
      this.eyeContactLastPitchAbs = null
      this.eyeContactYawTravel = 'out'
      this.eyeContactPitchTravel = 'out'
    }
    this.eyeContactEnabled = value
  }

  setSocketEyeContactSettings(value: SocketEyeContactSettingsV2 | null | undefined) {
    this.socketEyeContact = resolveSocketEyeContactSettings(value)
  }

  getSocketEyeContactSettings() {
    return { ...this.socketEyeContact }
  }

  setEyeContactMode(value: GoonEyeContactMode) {
    if (this.eyeContactMode === value) return
    this.eyeContactMode = value
    if (this.vrm?.lookAt) {
      this.clearLookAtOverride(this.vrm.lookAt)
    }
  }

  setEyeContactTuning(value: GoonEyeContactTuning | null | undefined) {
    this.eyeContactTuning = this.normalizeEyeContactTuning(value)
  }

  private normalizeEyeContactTuning(
    value: GoonEyeContactTuning | null | undefined
  ): ResolvedGoonEyeContactTuning {
    const legacy = value as
      | (GoonEyeContactTuning & {
          yawStrength?: number
          pitchStrength?: number
          headStartDeg?: number
          headStrength?: number
        })
      | undefined
    return {
      eyeYawSensitivity: this.normalizeEyeContactTuningNumber(
        value?.eyeYawSensitivity ?? legacy?.yawStrength,
        1,
        0,
        8
      ),
      eyeYawRange: this.normalizeEyeContactTuningNumber(value?.eyeYawRange ?? legacy?.yawStrength, 1, 0, 8),
      eyePitchSensitivity: this.normalizeEyeContactTuningNumber(
        value?.eyePitchSensitivity ?? legacy?.pitchStrength,
        1,
        0,
        8
      ),
      eyePitchRange: this.normalizeEyeContactTuningNumber(
        value?.eyePitchRange ?? legacy?.pitchStrength,
        1,
        0,
        8
      ),
      headYawStartOutDeg: this.normalizeEyeContactTuningNumber(
        value?.headYawStartOutDeg ?? value?.headYawStartDeg ?? legacy?.headStartDeg,
        14,
        0,
        90
      ),
      headYawStartInDeg: this.normalizeEyeContactTuningNumber(value?.headYawStartInDeg, 52, 0, 90),
      headYawSensitivity: this.normalizeEyeContactTuningNumber(
        value?.headYawSensitivity ?? legacy?.headStrength,
        1,
        0,
        8
      ),
      headYawRange: this.normalizeEyeContactTuningNumber(
        value?.headYawRange ?? legacy?.headStrength,
        1,
        0,
        8
      ),
      headYawSpeed: this.normalizeEyeContactTuningNumber(value?.headYawSpeed, 1, 0.05, 3),
      headPitchStartOutDeg: this.normalizeEyeContactTuningNumber(
        value?.headPitchStartOutDeg ?? value?.headPitchStartDeg,
        8,
        0,
        90
      ),
      headPitchStartInDeg: this.normalizeEyeContactTuningNumber(
        value?.headPitchStartInDeg,
        22,
        0,
        90
      ),
      headPitchSensitivity: this.normalizeEyeContactTuningNumber(
        value?.headPitchSensitivity ?? legacy?.headStrength,
        1,
        0,
        8
      ),
      headPitchRange: this.normalizeEyeContactTuningNumber(
        value?.headPitchRange ?? legacy?.headStrength,
        1,
        0,
        8
      ),
      headPitchSpeed: this.normalizeEyeContactTuningNumber(value?.headPitchSpeed, 1, 0.05, 3),
      eyeYawHeadCompensation: this.normalizeEyeContactTuningNumber(
        value?.eyeYawHeadCompensation,
        1,
        0,
        5
      ),
      eyePitchHeadCompensation: this.normalizeEyeContactTuningNumber(
        value?.eyePitchHeadCompensation,
        1,
        0,
        5
      )
    }
  }

  private normalizeEyeContactTuningNumber(
    value: unknown,
    fallback: number,
    min: number,
    max: number
  ) {
    const numeric = typeof value === 'number' ? value : Number(value)
    if (!Number.isFinite(numeric)) return fallback
    return Math.max(min, Math.min(max, numeric))
  }

  setZoomTarget(target: GoonZoomTarget) {
    this.zoomTarget = target
  }

  setSpeaking(value: boolean) {
    this.speaking = value
    if (!value) {
      this.speechPausedForCue = false
      this.smoothedLipSyncAmplitude = 0
      this.speechAudioGate = 0
      this.speechAudioPeak = 0
      this.speechAudioStartOffsetSec = null
    }
  }

  private getMoodFaceBlendTarget(now: number) {
    return shouldApplyMoodFaceLayer({
      speaking: this.speaking,
      emoteActive: this.hasActiveEmote(now)
    })
  }

  private updateMoodFaceBlend(now: number) {
    const deltaMs = Math.max(0, now - this.moodFaceBlendUpdatedAt)
    this.moodFaceBlend = stepFaceLayerBlend(this.moodFaceBlend, {
      active: this.getMoodFaceBlendTarget(now),
      deltaMs,
      durationMs: MOOD_FACE_BLEND_DURATION_MS
    })
    this.moodFaceBlendUpdatedAt = now
  }

  setSpeechPausedForCue(value: boolean) {
    this.speechPausedForCue = value
  }

  setSpeechPlayback(
    timeline: GoonLipSyncTimeline | null,
    durationMs?: number | null,
    analyzerId: GoonLipSyncAnalyzerId = timeline?.analyzerId ?? 'batshit-text-timing'
  ) {
    this.speechLipSyncTimeline = timeline
    this.speechLipSyncAnalyzerId = analyzerId
    this.speechLipSyncDurationMs =
      typeof durationMs === 'number' && durationMs > 0 ? durationMs : (timeline?.durationMs ?? null)
    this.speechLipSyncStartedAt = performance.now()
    this.speechAudioGate = 0
    this.speechAudioPeak = 0
    this.speechAudioStartOffsetSec = null
  }

  updateSpeechLipSyncTimeline(
    timeline: GoonLipSyncTimeline | null,
    durationMs?: number | null,
    analyzerId: GoonLipSyncAnalyzerId = timeline?.analyzerId ?? 'batshit-text-timing'
  ) {
    if (!timeline || !this.speaking) return
    this.speechLipSyncTimeline = timeline
    this.speechLipSyncAnalyzerId = analyzerId
    this.speechLipSyncDurationMs =
      typeof durationMs === 'number' && durationMs > 0
        ? durationMs
        : (timeline.durationMs || this.speechLipSyncDurationMs)
  }

  clearSpeechPlayback() {
    this.speechLipSyncTimeline = null
    this.speechLipSyncAnalyzerId = 'batshit-text-timing'
    this.speechLipSyncDurationMs = null
    this.speechLipSyncStartedAt = 0
    this.speechPausedForCue = false
    this.smoothedLipSyncAmplitude = 0
    this.speechAudioGate = 0
    this.speechAudioPeak = 0
    this.speechAudioStartOffsetSec = null
  }

  getAudioLedCueProgress(): number | null {
    if (
      this.speechLipSyncAnalyzerId === 'batshit-text-timing' ||
      !this.audioElement ||
      !Number.isFinite(this.audioElement.duration) ||
      this.audioElement.duration <= 0
    ) {
      return null
    }

    const audioLedDurationMs = Math.max(
      1,
      this.speechLipSyncTimeline && this.speechLipSyncTimeline.source !== 'text-timing'
        ? this.speechLipSyncTimeline.durationMs
        : (this.speechLipSyncDurationMs ?? Math.round(this.audioElement.duration * 1000))
    )
    return THREE.MathUtils.clamp(this.getSpeechLipSyncElapsedMs() / audioLedDurationMs, 0, 1)
  }

  setBaseLoop(name: string, animationName?: string) {
    this.baseLoop = name
    this.baseLoopAnimationName = animationName ?? name
    this.baseLoopPosture = this.resolvePosture(name)
    this.activeMood = null
    this.moodExpressionTargets = []
    this.moodExpressionIntensity = 1
    this.moodFaceControls = []
    this.moodRawMorphTargets = []
    this.syncBaseLoopAnimation()
    this.applyMarkerForPosture(this.baseLoopPosture)
  }

  setMood(name: string, definition?: GoonCueDefinition, options: PlacementOptions = {}) {
    this.baseLoop = name
    this.baseLoopAnimationName = definition?.animationName ?? name
    this.baseLoopPosture = this.resolvePosture(name, definition)
    this.activeMood = definition ?? null
    this.moodExpressionTargets = this.resolveExpressionTargets(name, definition)
    this.moodExpressionIntensity = definition?.intensity ?? 1
    this.moodFaceControls = definition?.faceControls ?? []
    this.moodRawMorphTargets = definition?.rawMorphTargets ?? []
    this.syncBaseLoopAnimation()
    if (this.baseLoopAnimationName && !this.animationMap.has(this.baseLoopAnimationName)) {
      this.requestDeferredAnimation(this.baseLoopAnimationName, 'mood', definition, name)
    }
    if (!options.preservePlacement) {
      this.applyMarkerForPosture(this.baseLoopPosture, undefined, options)
    }
  }

  setAuthoringFacePreview(name: string, definition?: GoonCueDefinition | GoonEmoteStep | null) {
    if (!definition) {
      this.clearAuthoringFacePreview()
      return
    }

    const cueLike: GoonCueDefinition = 'kind' in definition
      ? definition
      : {
          name,
          kind: 'emote',
          expressionTargets: definition.expressionTargets,
          faceControls: definition.faceControls,
          rawMorphTargets: definition.rawMorphTargets
        }

    this.authoringPreviewExpressionTargets = this.resolveExpressionTargets(name, cueLike)
    this.authoringPreviewIntensity = cueLike.intensity ?? 1
    this.authoringPreviewFaceControls = cueLike.faceControls ?? []
    this.authoringPreviewRawMorphTargets = cueLike.rawMorphTargets ?? []
  }

  clearAuthoringFacePreview() {
    this.authoringPreviewExpressionTargets = []
    this.authoringPreviewIntensity = 1
    this.authoringPreviewFaceControls = []
    this.authoringPreviewRawMorphTargets = []
  }

  /**
   * Capture serializable same-Goon continuity before a mounted Live revision
   * is replaced. No mixer, action, scene-node, material, or runtime object is
   * allowed across the engine boundary.
   */
  captureMountedRuntimeState(): GoonMountedRuntimeState {
    const now = performance.now()
    const baseLoopClip = this.baseLoopAction?.getClip().name ?? null
    return {
      camera: this.getCameraState(),
      baseLoop: {
        name: this.baseLoop,
        definition: this.activeMood ? structuredClone(this.activeMood) : null,
        clipName: baseLoopClip,
        time: this.baseLoopAction?.time ?? 0
      },
      oneShot: this.oneShotAction
        ? {
            clipName: this.oneShotAction.getClip().name,
            time: this.oneShotAction.time,
            restorePosture: this.oneShotRestorePosture,
            preserveCamera: this.oneShotRestorePreserveCamera,
            overridePosture: this.animationOverridePosture
          }
        : null,
      eyeContact: {
        enabled: this.eyeContactEnabled,
        mode: this.eyeContactMode,
        tuning: { ...this.eyeContactTuning },
        applied: { ...this.eyeContactApplied },
        ...(this.socketEyeSurfaceDefinition
          ? { socket: { ...this.socketEyeContact } }
          : {})
      },
      performance: {
        direction: { ...this.customPerformanceDirection },
        moodFaceBlend: this.moodFaceBlend,
        activeEmoteRemainingMs: Math.max(0, this.activeEmoteUntil - now),
        expressions: this.activeExpressions.map((expression) => {
          const {
            endsAt,
            startTime,
            stepStartTime,
            ...rest
          } = structuredClone(expression)
          return {
            ...rest,
            remainingMs: Math.max(0, endsAt - now),
            elapsedMs: Math.max(0, now - startTime),
            stepElapsedMs: Math.max(0, now - stepStartTime)
          }
        })
      },
      speech: {
        speaking: this.speaking,
        pausedForCue: this.speechPausedForCue,
        timeline: this.speechLipSyncTimeline
          ? structuredClone(this.speechLipSyncTimeline)
          : null,
        analyzerId: this.speechLipSyncAnalyzerId,
        durationMs: this.speechLipSyncDurationMs,
        elapsedMs: this.getSpeechLipSyncElapsedMs()
      }
    }
  }

  /** Restore semantic continuity after the incoming engine is fully loaded. */
  restoreMountedRuntimeState(state: GoonMountedRuntimeState) {
    const now = performance.now()
    this.setEyeContactEnabled(state.eyeContact.enabled)
    this.setEyeContactMode(state.eyeContact.mode)
    this.setEyeContactTuning(state.eyeContact.tuning)
    if (state.eyeContact.socket) {
      this.setSocketEyeContactSettings(state.eyeContact.socket)
    }
    this.eyeContactApplied = { ...state.eyeContact.applied }
    this.customPerformanceDirection = { ...state.performance.direction }

    this.setMood(state.baseLoop.name, state.baseLoop.definition ?? undefined, {
      preservePlacement: true,
      preserveCamera: true
    })
    if (
      state.baseLoop.clipName &&
      this.baseLoopAction?.getClip().name === state.baseLoop.clipName
    ) {
      this.baseLoopAction.time = state.baseLoop.time
    }

    if (state.oneShot && this.playOneShotAnimation(state.oneShot.clipName)) {
      if (this.oneShotAction) this.oneShotAction.time = state.oneShot.time
      this.oneShotRestorePosture = state.oneShot.restorePosture
      this.oneShotRestorePreserveCamera = state.oneShot.preserveCamera
      this.animationOverridePosture = state.oneShot.overridePosture
    }

    this.moodFaceBlend = state.performance.moodFaceBlend
    this.moodFaceBlendUpdatedAt = now
    this.activeEmoteUntil = now + state.performance.activeEmoteRemainingMs
    this.activeExpressions = state.performance.expressions.map((expression) => {
      const { remainingMs, elapsedMs, stepElapsedMs, ...rest } = structuredClone(expression)
      return {
        ...rest,
        endsAt: now + remainingMs,
        startTime: now - elapsedMs,
        stepStartTime: now - stepElapsedMs
      }
    })
    this.speaking = state.speech.speaking
    this.speechPausedForCue = state.speech.pausedForCue
    this.speechLipSyncTimeline = state.speech.timeline
      ? structuredClone(state.speech.timeline)
      : null
    this.speechLipSyncAnalyzerId = state.speech.analyzerId
    this.speechLipSyncDurationMs = state.speech.durationMs
    this.speechLipSyncStartedAt = state.speech.timeline
      ? now - state.speech.elapsedMs
      : 0
    if (state.camera) this.applyCamera(state.camera)
  }

  /**
   * Snapshot the single-engine Settings comparison state before swapping a
   * Recipe Source. This is editor-only continuity data; it does not alter the
   * mounted Dock/stage ownership contract handled by Packet R6.
   */
  captureComparisonPreviewState() {
    const actionState = (action: THREE.AnimationAction | null) => action
      ? { clipName: action.getClip().name, time: action.time }
      : null
    return {
      camera: this.getCameraState(),
      baseLoop: actionState(this.baseLoopAction),
      oneShot: actionState(this.oneShotAction),
      authoringPose: actionState(this.authoringPoseAction),
      authoringPoseMode: this.authoringPoseMode,
      authoringPoseAnimationName: this.authoringPoseAnimationName
    }
  }

  /** Restore camera/pose/animation time after a matched Recipe preview swap. */
  restoreComparisonPreviewState(
    state: ReturnType<GoonEngine['captureComparisonPreviewState']>
  ) {
    if (state.camera) this.applyCamera(state.camera)
    if (state.authoringPoseMode) {
      this.setAuthoringPoseMode(true, state.authoringPoseAnimationName)
      if (
        state.authoringPose &&
        this.authoringPoseAction?.getClip().name === state.authoringPose.clipName
      ) {
        this.authoringPoseAction.time = state.authoringPose.time
      }
      return
    }
    if (state.oneShot && this.playOneShotAnimation(state.oneShot.clipName)) {
      if (this.oneShotAction) this.oneShotAction.time = state.oneShot.time
      return
    }
    this.syncBaseLoopAnimation()
    if (state.baseLoop && this.baseLoopAction?.getClip().name === state.baseLoop.clipName) {
      this.baseLoopAction.time = state.baseLoop.time
    }
  }

  setAuthoringPoseMode(enabled: boolean, animationName?: string | null) {
    const nextAnimationName = enabled ? animationName?.trim() || null : null
    if (this.authoringPoseMode === enabled && this.authoringPoseAnimationName === nextAnimationName) return
    this.authoringPoseMode = enabled
    this.authoringPoseAnimationName = nextAnimationName

    if (enabled) {
      if (this.oneShotAction) {
        this.oneShotAction.stop()
        this.oneShotAction = null
      }
      if (this.authoringPoseAction) {
        this.authoringPoseAction.stop()
        this.authoringPoseAction = null
      }
      this.animationOverrideActive = false
      this.animationOverridePosture = null
      if (this.mixer) {
        this.mixer.stopAllAction()
        const clip = nextAnimationName ? this.animationMap.get(nextAnimationName) : null
        if (clip) {
          const action = this.mixer.clipAction(clip)
          action.reset()
          this.resetPlaybackRates(action)
          this.holdStaticPoseAction(action)
          this.authoringPoseAction = action
        } else {
          this.mixer.timeScale = 0
        }
      }
      return
    }

    if (this.authoringPoseAction) {
      this.authoringPoseAction.stop()
      this.authoringPoseAction = null
    }
    this.resetPlaybackRates()
    this.syncBaseLoopAnimation()
  }

  private resolvePosture(name?: string, definition?: GoonCueDefinition): GoonPosture {
    const explicit = definition?.posture
    if (explicit) return explicit
    const animationName = definition?.animationName ?? name
    const motionPosture = animationName ? this.animationMetadata.get(animationName)?.posture : undefined
    if (motionPosture) return motionPosture
    return resolveBasePosture(name as GoonPosture | undefined, undefined, this.postureDefinitions)
  }

  private resolveActionMotionMetadata(action: THREE.AnimationAction | null) {
    if (!action || typeof action.getClip !== 'function') return undefined
    return this.animationMetadata.get(action.getClip().name)
  }

  private isEyeContactSuppressedByMotion() {
    if (this.animationOverrideActive && this.oneShotAction) {
      return this.resolveActionMotionMetadata(this.oneShotAction)?.eyeContact === 'off'
    }
    return this.resolveActionMotionMetadata(this.baseLoopAction)?.eyeContact === 'off'
  }

  private resolveAnimationExtension(file: GoonFileRef): string {
    const candidate = file.filename || file.url || file.originalName || ''
    if (!candidate) return ''
    const cleaned = candidate.split('?')[0]?.split('#')[0] ?? candidate
    const dot = cleaned.lastIndexOf('.')
    if (dot === -1) return ''
    return cleaned.slice(dot).toLowerCase()
  }

  private clearLoadedAnimationState() {
    if (this.mixer) {
      this.mixer.stopAllAction()
      for (const clip of this.animationMap.values()) {
        try {
          this.mixer.uncacheClip(clip)
        } catch (error) {
          console.warn('[GoonEngine] Failed to uncache animation clip cleanly:', clip.name, error)
        }
      }
    }
    this.animationMap.clear()
    this.animationMetadata.clear()
    this.animationSources.clear()
    this.loadedAnimationUrls.clear()
    this.animationWarnings = []
    this.hasBodyAnimations = false
    this.baseLoopAction = null
    this.baseLoopIsFallback = false
    this.oneShotAction = null
    this.authoringPoseAction = null
    this.authoringPoseAnimationName = null
    this.oneShotRestorePosture = null
    this.oneShotRestorePreserveCamera = false
    this.animationOverrideActive = false
    this.animationOverridePosture = null
    this.pendingAnimationRequests.clear()
    this.deferredAnimationQueue = []
    this.deferredAnimationUrls.clear()
    this.deferredLoadRequested = false
    this.deferredLoadToken += 1
    this.deferredLoading = false
  }

  async loadAdditionalAnimations(files: GoonFileRef[] = [], token = this.loadToken) {
    if (!this.vrm && !this.customAvatarRoot) return
    if (!files || files.length === 0) return
    let added = false
    let hadWarnings = false
    const loader = new GLTFLoader()

    const normalizedSceneNames = this.collectNormalizedSceneNames()

    for (const file of files) {
      if (token !== this.loadToken) return
      if (!file?.url) continue
      if (this.loadedAnimationUrls.has(file.url)) continue
      this.loadedAnimationUrls.add(file.url)
      try {
        const sourceLabel = file.originalName || file.filename || 'animation'
        const extension = this.resolveAnimationExtension(file)

        if (extension === '.vrma') {
          const vrmaLoader = new GLTFLoader()
          vrmaLoader.register((parser: any) => new VRMAnimationLoaderPlugin(parser))
          const gltf = await vrmaLoader.loadAsync(file.url)
          if (token !== this.loadToken) return
          const currentVrm = this.vrm
          if (!currentVrm) {
            if (this.addAnimationWarning(
              `VRMA file "${sourceLabel}" targets VRM goons and cannot play on this GLB rig.`
            )) {
              hadWarnings = true
            }
            continue
          }
          const vrmAnimations = Array.isArray(gltf.userData?.vrmAnimations)
            ? (gltf.userData.vrmAnimations as unknown[])
            : []

          if (vrmAnimations.length === 0) {
            if (this.addAnimationWarning(
              `VRMA file "${sourceLabel}" contains no VRM animations.`
            )) {
              hadWarnings = true
            }
            continue
          }

          const baseLabel =
            sourceLabel
              ?.replace(/\.[^/.]+$/, '')
              .replace(/[^a-zA-Z0-9_-]+/g, '_')
              .replace(/_+/g, '_')
              .replace(/^_+|_+$/g, '') || 'vrma'
          const multi = vrmAnimations.length > 1
          const clips = vrmAnimations.map((vrmAnimation, index) => {
            const clip = createVRMAnimationClip(vrmAnimation as any, currentVrm)
            clip.name = multi ? `${baseLabel}_${index + 1}` : baseLabel
            return clip
          })

          if (this.registerAnimations(clips, sourceLabel, 'vrma', file.motionMeta)) {
            added = true
          }
          continue
        }

        const gltf = await loader.loadAsync(file.url)
        if (token !== this.loadToken || (!this.vrm && !this.customAvatarRoot)) return
        if (!Array.isArray(gltf.animations) || gltf.animations.length === 0) {
          if (this.addAnimationWarning(`Animation file "${sourceLabel}" contains no animations.`)) {
            hadWarnings = true
          }
          continue
        }

        const analysis = this.analyzeAnimationTargets(gltf.animations, normalizedSceneNames)
        if (analysis.totalTracks > 0) {
          if (analysis.matchedTracks === 0) {
            if (this.addAnimationWarning(
              `Animation file "${sourceLabel}" may not match this Goon's rig (no matching tracks found).`
            )) {
              hadWarnings = true
            }
          } else if (analysis.matchRatio < 0.15 && analysis.matchedTracks < 4) {
            if (this.addAnimationWarning(
              `Animation file "${sourceLabel}" has low rig overlap (${analysis.matchedTracks}/${analysis.totalTracks} tracks matched).`
            )) {
              hadWarnings = true
            }
          }
        }

        if (this.registerAnimations(gltf.animations, sourceLabel, 'goon', file.motionMeta)) {
          added = true
        }
      } catch (error) {
        if (token !== this.loadToken || (!this.vrm && !this.customAvatarRoot)) return
        console.warn('[GoonEngine] Failed to load animation file:', file.url, error)
      }
    }

    if (added || hadWarnings) {
      this.emitActiveCompatibility()
      this.syncBaseLoopAnimation()
    }
  }

  async syncAnimations(files: GoonFileRef[] = [], options: GoonAnimationSyncOptions = {}) {
    if (!this.vrm && !this.customAvatarRoot) return
    this.loadToken += 1
    const token = this.loadToken
    this.clearLoadedAnimationState()
    this.registerAnimations(this.baseAnimations, this.vrm ? 'vrm' : 'custom', this.vrm ? 'vrm' : 'goon')

    if (files && files.length > 0) {
      await this.loadAdditionalAnimations(files, token)
    } else {
      this.emitActiveCompatibility()
      this.syncBaseLoopAnimation()
    }

    if (options.deferredFiles && options.deferredFiles.length > 0) {
      this.queueDeferredAnimations(options.deferredFiles)
    }
  }

  private queueDeferredAnimations(files: GoonFileRef[]) {
    if (!files || files.length === 0) return
    this.deferredAnimationQueue = []
    this.deferredAnimationUrls.clear()
    this.deferredLoadToken += 1
    this.deferredLoadBaseToken = this.loadToken

    const token = this.deferredLoadToken
    for (const file of files) {
      if (!file?.url) continue
      if (this.loadedAnimationUrls.has(file.url)) continue
      if (this.deferredAnimationUrls.has(file.url)) continue
      this.deferredAnimationUrls.add(file.url)
      this.deferredAnimationQueue.push(file)
    }

    if (this.deferredAnimationQueue.length === 0) return
    this.deferredLoadRequested = true
    void this.loadDeferredAnimations(token)
  }

  private async loadDeferredAnimations(token: number) {
    if (this.deferredLoading) return
    this.deferredLoading = true
    this.deferredLoadRequested = false
    const baseToken = this.deferredLoadBaseToken
    try {
      while (this.deferredAnimationQueue.length > 0) {
        if (token !== this.deferredLoadToken) break
        if (baseToken !== this.loadToken) break
        const next = this.deferredAnimationQueue.shift()
        if (!next) continue
        await this.loadAdditionalAnimations([next], baseToken)
        this.resolvePendingAnimations()
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
    } finally {
      this.deferredLoading = false
    }

    const shouldRestart =
      this.deferredAnimationQueue.length > 0 &&
      (this.deferredLoadRequested || token !== this.deferredLoadToken)

    if (shouldRestart) {
      void this.loadDeferredAnimations(this.deferredLoadToken)
    }
  }

  private hasDeferredAnimations() {
    return this.deferredAnimationQueue.length > 0 || this.deferredLoading
  }

  private requestDeferredAnimation(
    name: string,
    kind: PendingAnimationRequest['kind'],
    definition?: GoonCueDefinition,
    cueName?: string
  ) {
    if (!name || !this.hasDeferredAnimations()) return
    this.pendingAnimationRequests.set(name, {
      kind,
      cueName: cueName ?? definition?.name ?? name,
      definition,
      requestedAt: performance.now()
    })
    this.deferredLoadRequested = true
    void this.loadDeferredAnimations(this.deferredLoadToken)
  }

  private resolvePendingAnimations() {
    if (this.pendingAnimationRequests.size === 0) return
    const now = performance.now()
    const expiryMs = 2500

    for (const [name, request] of this.pendingAnimationRequests.entries()) {
      if (now - request.requestedAt > expiryMs) {
        this.pendingAnimationRequests.delete(name)
        continue
      }
      if (!this.animationMap.has(name)) continue
      this.pendingAnimationRequests.delete(name)
      if (request.kind === 'mood') {
        this.setMood(request.cueName, request.definition)
      } else {
        this.playOneShotAnimation(name)
      }
    }
  }

  private normalizeActionPlayback(action: THREE.AnimationAction | null) {
    if (!action) return
    action.setEffectiveTimeScale(1)
    action.timeScale = 1
  }

  private resetPlaybackRates(action?: THREE.AnimationAction | null) {
    if (this.mixer) {
      this.mixer.timeScale = 1
    }
    if (action) {
      this.normalizeActionPlayback(action)
      return
    }
    this.normalizeActionPlayback(this.baseLoopAction)
    this.normalizeActionPlayback(this.oneShotAction)
  }

  private isStaticPoseClip(clip: THREE.AnimationClip | null | undefined) {
    return Boolean(clip && clip.duration <= 0.05)
  }

  private holdStaticPoseAction(action: THREE.AnimationAction) {
    if (!this.mixer) return
    action.setLoop(THREE.LoopOnce, 1)
    action.clampWhenFinished = true
    action.enabled = true
    action.paused = false
    action.play()
    action.time = 0
    this.mixer.update(0)
    action.paused = true
  }

  private isStaticPoseOverrideActive() {
    if (!this.animationOverrideActive || !this.oneShotAction) return false
    return this.isStaticPoseClip(this.oneShotAction.getClip())
  }

  previewAnimation(name: string) {
    return this.playOneShotAnimation(name)
  }

  previewLoopAnimation(
    name: string,
    definition?: GoonCueDefinition,
    options: { preservePlacement?: boolean; preserveCamera?: boolean } = {}
  ) {
    if (!this.mixer) return false
    const animationClip = this.animationMap.get(name)
    if (!animationClip) return false

    if (this.baseLoopAction) {
      this.baseLoopAction.stop()
      this.baseLoopAction = null
      this.baseLoopIsFallback = false
    }

    if (this.oneShotAction) {
      this.oneShotAction.stop()
      this.oneShotAction = null
    }

    this.mixer.stopAllAction()

    const action = this.mixer.clipAction(animationClip)
    const overridePosture = this.resolvePosture(name, definition)
    const isPose = this.isStaticPoseClip(animationClip)
    action.reset()
    this.resetPlaybackRates(action)
    action.enabled = true
    if (isPose) {
      this.holdStaticPoseAction(action)
    } else {
      action.setLoop(THREE.LoopRepeat, Infinity)
      action.clampWhenFinished = false
      action.fadeIn(0.1)
      action.play()
    }

    this.animationOverridePosture = overridePosture
    if (!options.preservePlacement) {
      this.applyMarkerForPosture(overridePosture, undefined, {
        preserveCamera: options.preserveCamera
      })
    }
    this.oneShotAction = action
    this.animationOverrideActive = true
    return true
  }

  getBaseLoopState() {
    return {
      name: this.baseLoop,
      definition: this.activeMood ?? undefined
    }
  }

  estimateCueDurationMs(name: string, definition?: GoonCueDefinition) {
    const animationName = definition?.animationName ?? name
    const animationDuration = animationName ? this.lookupAnimationDurationMs(animationName) ?? 0 : 0
    const expressionDuration = this.estimateExpressionDurationMs(definition)
    const definitionDuration = definition?.durationMs ?? 0
    const duration = Math.max(animationDuration, expressionDuration, definitionDuration)
    return Math.max(200, duration || 800)
  }

  clearPreviewAnimation() {
    if (!this.mixer) return
    if (this.oneShotAction) {
      this.oneShotAction.stop()
      this.oneShotAction = null
    }
    this.animationOverrideActive = false
    this.animationOverridePosture = null
    this.resetPlaybackRates()
    if (this.baseLoopAction) {
      this.baseLoopAction.enabled = true
      this.baseLoopAction.fadeIn(0.2)
      this.baseLoopAction.play()
    } else {
      this.syncBaseLoopAnimation()
    }
  }

  getAnimationNames(): string[] {
    return Array.from(this.animationMap.keys())
  }

  getAnimationCatalog(): Array<{ name: string; source: AnimationSource }> {
    return Array.from(this.animationMap.keys()).map((name) => ({
      name,
      source: this.animationSources.get(name) ?? 'goon'
    }))
  }

  getAnimationDurationMs(name: string): number | null {
    return this.lookupAnimationDurationMs(name)
  }

  getExpressionPresetNames(): string[] {
    const manager = this.vrm?.expressionManager
    if (!manager) return []
    const result: string[] = []
    for (const preset of VRM_PRESET_NAMES) {
      if (manager.getExpression(preset)) {
        result.push(preset)
      }
    }
    return result.sort((a, b) => a.localeCompare(b))
  }

  getCustomExpressionNames(): string[] {
    const manager = this.vrm?.expressionManager
    if (!manager) return []
    const customMap = manager.customExpressionMap ?? {}
    return Object.keys(customMap).sort((a, b) => a.localeCompare(b))
  }

  getHumanoidBoneNames(): string[] {
    const names = Object.entries(this.bones)
      .filter(([, bone]) => Boolean(bone))
      .map(([name]) => name)
    return names.sort((a, b) => a.localeCompare(b))
  }

  getMaterialNames(): string[] {
    if (this.materialMap.size === 0) {
      this.collectMaterials()
    }
    return Array.from(this.materialMap.keys()).sort((a, b) => a.localeCompare(b))
  }

  getMaterialColorInfo(materialName: string): GoonMaterialColorInfo | null {
    if (!materialName) return null
    if (this.materialMap.size === 0) {
      this.collectMaterials()
    }

    const material = this.materialMap.get(materialName)?.[0]
    if (!material) return null

    const anyMaterial = material as THREE.Material & Record<string, any>
    const originalState = this.originalMaterialState.get(material.uuid)
    const baseColor = originalState?.color ?? anyMaterial.color ?? null
    const shadeColor = originalState?.shadeColorFactor ?? anyMaterial.shadeColorFactor ?? null
    const emissiveColor = originalState?.emissive ?? anyMaterial.emissive ?? null
    const outlineColor =
      originalState?.outlineColorFactor ?? anyMaterial.outlineColorFactor ?? null

    return {
      baseHex: baseColor?.isColor ? linearRgbToHex(baseColor) : undefined,
      shadeHex: shadeColor?.isColor ? linearRgbToHex(shadeColor) : undefined,
      emissiveHex: emissiveColor?.isColor ? linearRgbToHex(emissiveColor) : undefined,
      outlineHex: outlineColor?.isColor ? linearRgbToHex(outlineColor) : undefined
    }
  }

  applyMaterialColorOverride(
    materialName: string,
    colors: { baseHex?: string; shadeHex?: string }
  ): boolean {
    if (!materialName) return false
    if (!this.vrm) return false
    if (this.materialMap.size === 0) {
      this.collectMaterials()
    }

    const materials = this.materialMap.get(materialName)
    if (!materials || materials.length === 0) return false

    const baseColor = hexToLinearRgb(colors.baseHex)
    const shadeColor = hexToLinearRgb(colors.shadeHex)
    if (!baseColor && !shadeColor) return false

    for (const material of materials) {
      this.rememberMaterialState(material)
      const target = material as THREE.Material & Record<string, any>

      if (baseColor && target.color?.isColor) {
        target.color.setRGB(baseColor.r, baseColor.g, baseColor.b)
      }
      if (shadeColor && target.shadeColorFactor?.isColor) {
        target.shadeColorFactor.setRGB(shadeColor.r, shadeColor.g, shadeColor.b)
      }

      material.needsUpdate = true
    }

    return true
  }

  private getTextureImageSource(texture?: THREE.Texture | null) {
    const image = texture?.image as
      | (CanvasImageSource & {
          width?: number
          height?: number
          naturalWidth?: number
          naturalHeight?: number
          videoWidth?: number
          videoHeight?: number
        })
      | undefined
    if (!image) return null
    const width =
      image.width ?? image.naturalWidth ?? image.videoWidth ?? 0
    const height =
      image.height ?? image.naturalHeight ?? image.videoHeight ?? 0
    if (!width || !height) return null
    return { image, width, height }
  }

  private getRuntimeTextureMaxSize() {
    if (!this.embeddedWebKitRuntime) return 0
    if (this.quality === 'low') return 1024
    if (this.quality === 'ultra') return 4096
    return 2048
  }

  private getRendererMaxTextureSize() {
    const backend = (this.renderer as unknown as {
      backend?: {
        device?: { limits?: { maxTextureDimension2D?: number } }
        getContext?: () => WebGL2RenderingContext | GPUCanvasContext | null
      }
    } | undefined)?.backend
    const webGpuLimit = backend?.device?.limits?.maxTextureDimension2D
    if (typeof webGpuLimit === 'number' && Number.isFinite(webGpuLimit)) {
      return webGpuLimit
    }
    const context = backend?.getContext?.()
    if (
      context &&
      'MAX_TEXTURE_SIZE' in context &&
      typeof (context as WebGL2RenderingContext).getParameter === 'function'
    ) {
      const webGlLimit = (context as WebGL2RenderingContext).getParameter(
        (context as WebGL2RenderingContext).MAX_TEXTURE_SIZE
      )
      return typeof webGlLimit === 'number' && Number.isFinite(webGlLimit) ? webGlLimit : 0
    }
    return 0
  }

  private getRuntimeSkyboxTextureBudget() {
    return resolveGoonSkyboxTextureBudget({
      embeddedWebKitRuntime: this.embeddedWebKitRuntime,
      quality: this.quality,
      supportedMaxSize: this.getRendererMaxTextureSize()
    })
  }

  private getRuntimeSkyboxTextureMaxSize() {
    return this.getRuntimeSkyboxTextureBudget().effectiveMaxSize
  }

  private refreshSkyboxBudgetRuntimeStatus() {
    if (!this.renderer) return
    const base = this.resolveRendererRuntime(this.renderer)
    const budget = this.getRuntimeSkyboxTextureBudget()
    if (!budget.deviceCapped) {
      this.setRuntimeStatus(base)
      return
    }
    const effectiveK = Math.round(budget.effectiveMaxSize / 1024)
    const requestedK = Math.round(budget.requestedMaxSize / 1024)
    this.setRuntimeStatus({
      ...base,
      label: `${base.label} · Skybox ${effectiveK}K max`,
      message: `This renderer supports a ${effectiveK}K skybox maximum, below Ultra's requested ${requestedK}K panorama budget.`
    })
  }

  private copyTextureSettings(source: THREE.Texture, target: THREE.Texture) {
    target.name = source.name ? `${source.name} (preview)` : source.name
    target.flipY = source.flipY
    target.colorSpace = source.colorSpace
    target.wrapS = source.wrapS
    target.wrapT = source.wrapT
    target.magFilter = source.magFilter
    target.minFilter = source.minFilter
    target.generateMipmaps = source.generateMipmaps
    target.anisotropy = source.anisotropy
    target.offset.copy(source.offset)
    target.repeat.copy(source.repeat)
    target.center.copy(source.center)
    target.rotation = source.rotation
    target.matrixAutoUpdate = source.matrixAutoUpdate
    target.channel = source.channel
    target.needsUpdate = true
  }

  private downsampleTextureForRuntime(
    texture: THREE.Texture,
    maxSize: number,
    replacements: Map<string, THREE.Texture>
  ) {
    const existingReplacement = replacements.get(texture.uuid)
    if (existingReplacement) return existingReplacement

    const source = this.getTextureImageSource(texture)
    if (!source || Math.max(source.width, source.height) <= maxSize || typeof document === 'undefined') {
      return texture
    }

    const scale = maxSize / Math.max(source.width, source.height)
    const width = Math.max(1, Math.round(source.width * scale))
    const height = Math.max(1, Math.round(source.height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d', { alpha: true })
    if (!context) return texture

    context.imageSmoothingEnabled = true
    context.imageSmoothingQuality = 'high'
    context.drawImage(source.image, 0, 0, width, height)

    const resized = new THREE.CanvasTexture(canvas)
    this.copyTextureSettings(texture, resized)
    replacements.set(texture.uuid, resized)
    try {
      texture.dispose()
    } catch (error) {
      this.materialDisposeErrorCount += 1
      if (this.materialDisposeErrorCount <= 3) {
        console.warn('[GoonEngine] Failed to dispose oversized source texture cleanly:', error)
      }
    }
    return resized
  }

  private applyRuntimeTextureBudget(root: THREE.Object3D | null | undefined) {
    const maxSize = this.getRuntimeTextureMaxSize()
    if (!root || maxSize <= 0) return

    const replacements = new Map<string, THREE.Texture>()
    let resizedCount = 0
    root.traverse((node) => {
      const mesh = node as THREE.Mesh
      if (!((mesh as any).isMesh || (mesh as any).isSkinnedMesh)) return
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      for (const material of materials) {
        if (!material) continue
        const target = material as THREE.Material & Record<string, any>
        for (const key of MATERIAL_RUNTIME_TEXTURE_KEYS) {
          const texture = target[key]
          if (!texture?.isTexture) continue
          const resized = this.downsampleTextureForRuntime(texture, maxSize, replacements)
          if (resized === texture) continue
          target[key] = resized
          material.needsUpdate = true
          resizedCount += 1
        }
      }
    })

    if (resizedCount > 0 && this.textureBudgetLogCount < 3) {
      this.textureBudgetLogCount += 1
      logger.debug(
        `[GoonEngine] Downsampled ${resizedCount} oversized Goon texture reference(s) to ${maxSize}px for embedded WebKit.`
      )
    }
  }

  private buildCompositeTexture(
    baseTexture: THREE.Texture | null | undefined,
    overlayTexture: THREE.Texture,
    colorSpace: THREE.ColorSpace
  ) {
    if (typeof document === 'undefined') return null
    const base = this.getTextureImageSource(baseTexture)
    const overlay = this.getTextureImageSource(overlayTexture)
    if (!overlay) return null

    const width = base?.width ?? overlay.width
    const height = base?.height ?? overlay.height
    if (!width || !height) return null

    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) return null

    if (base) {
      ctx.drawImage(base.image, 0, 0, width, height)
    }
    ctx.drawImage(overlay.image, 0, 0, width, height)

    const composedTexture = new THREE.CanvasTexture(canvas)
    composedTexture.flipY = false
    composedTexture.colorSpace = colorSpace
    composedTexture.needsUpdate = true
    return composedTexture
  }

  private trackMaterialRuntimeTexture(texture: THREE.Texture | null | undefined) {
    if (!texture || texture === this.transparentTexture) return
    this.materialRuntimeTextures.add(texture)
  }

  private releaseMaterialRuntimeTexture(
    texture: THREE.Texture | null | undefined,
    disposedTextures: Set<THREE.Texture>
  ) {
    if (!texture || texture === this.transparentTexture || !this.materialRuntimeTextures.has(texture)) {
      return
    }
    if (disposedTextures.has(texture)) {
      this.materialRuntimeTextures.delete(texture)
      return
    }
    disposedTextures.add(texture)
    this.materialRuntimeTextures.delete(texture)
    try {
      texture.dispose()
    } catch (error) {
      this.materialDisposeErrorCount += 1
      if (this.materialDisposeErrorCount <= 3) {
        console.warn('[GoonEngine] Failed to dispose preview texture cleanly:', error)
      } else if (this.materialDisposeErrorCount === 4) {
        console.warn('[GoonEngine] Additional material dispose warnings suppressed.')
      }
    }
  }

  private releaseMaterialOverrideTextures(
    material: THREE.Material,
    state: MaterialOriginalState,
    disposedTextures: Set<THREE.Texture>
  ) {
    const target = material as THREE.Material & Record<MaterialTextureStateKey, THREE.Texture | null | undefined>
    for (const key of MATERIAL_TEXTURE_STATE_KEYS) {
      const currentTexture = target[key]
      const originalTexture = state[key]
      if (currentTexture && currentTexture !== originalTexture) {
        this.releaseMaterialRuntimeTexture(currentTexture, disposedTextures)
      }
    }
  }

  private releaseAllMaterialRuntimeTextures() {
    const disposedTextures = new Set<THREE.Texture>()
    for (const texture of Array.from(this.materialRuntimeTextures)) {
      this.releaseMaterialRuntimeTexture(texture, disposedTextures)
    }
    this.materialRuntimeTextures.clear()
  }

  private rememberMaterialState(material: THREE.Material) {
    if (this.originalMaterialState.has(material.uuid)) return
    const anyMaterial = material as THREE.Material & Record<string, any>
    const state: MaterialOriginalState = {}
    if ('map' in anyMaterial) state.map = anyMaterial.map ?? null
    if ('shadeMultiplyTexture' in anyMaterial) {
      state.shadeMultiplyTexture = anyMaterial.shadeMultiplyTexture ?? null
    }
    if ('normalMap' in anyMaterial) state.normalMap = anyMaterial.normalMap ?? null
    if ('emissiveMap' in anyMaterial) state.emissiveMap = anyMaterial.emissiveMap ?? null
    if ('matcapTexture' in anyMaterial) state.matcapTexture = anyMaterial.matcapTexture ?? null
    if ('rimMultiplyTexture' in anyMaterial) {
      state.rimMultiplyTexture = anyMaterial.rimMultiplyTexture ?? null
    }
    if ('outlineWidthMultiplyTexture' in anyMaterial) {
      state.outlineWidthMultiplyTexture = anyMaterial.outlineWidthMultiplyTexture ?? null
    }
    if ('uvAnimationMaskTexture' in anyMaterial) {
      state.uvAnimationMaskTexture = anyMaterial.uvAnimationMaskTexture ?? null
    }
    if ('shadingShiftTexture' in anyMaterial) {
      state.shadingShiftTexture = anyMaterial.shadingShiftTexture ?? null
    }
    if (anyMaterial.color?.isColor) state.color = anyMaterial.color.clone()
    if (anyMaterial.shadeColorFactor?.isColor) {
      state.shadeColorFactor = anyMaterial.shadeColorFactor.clone()
    }
    if (anyMaterial.emissive?.isColor) state.emissive = anyMaterial.emissive.clone()
    if (anyMaterial.matcapFactor?.isColor) state.matcapFactor = anyMaterial.matcapFactor.clone()
    if (anyMaterial.parametricRimColorFactor?.isColor) {
      state.parametricRimColorFactor = anyMaterial.parametricRimColorFactor.clone()
    }
    if (anyMaterial.outlineColorFactor?.isColor) {
      state.outlineColorFactor = anyMaterial.outlineColorFactor.clone()
    }
    if (anyMaterial.normalScale?.isVector2) state.normalScale = anyMaterial.normalScale.clone()
    if (typeof anyMaterial.shadingShiftFactor === 'number') {
      state.shadingShiftFactor = anyMaterial.shadingShiftFactor
    }
    if (typeof anyMaterial.shadingShiftTextureScale === 'number') {
      state.shadingShiftTextureScale = anyMaterial.shadingShiftTextureScale
    }
    if (typeof anyMaterial.shadingToonyFactor === 'number') {
      state.shadingToonyFactor = anyMaterial.shadingToonyFactor
    }
    if (typeof anyMaterial.giEqualizationFactor === 'number') {
      state.giEqualizationFactor = anyMaterial.giEqualizationFactor
    }
    if (typeof anyMaterial.rimLightingMixFactor === 'number') {
      state.rimLightingMixFactor = anyMaterial.rimLightingMixFactor
    }
    if (typeof anyMaterial.parametricRimFresnelPowerFactor === 'number') {
      state.parametricRimFresnelPowerFactor = anyMaterial.parametricRimFresnelPowerFactor
    }
    if (typeof anyMaterial.parametricRimLiftFactor === 'number') {
      state.parametricRimLiftFactor = anyMaterial.parametricRimLiftFactor
    }
    if (typeof anyMaterial.outlineWidthMode === 'string') {
      state.outlineWidthMode = anyMaterial.outlineWidthMode
    }
    if (typeof anyMaterial.outlineWidthFactor === 'number') {
      state.outlineWidthFactor = anyMaterial.outlineWidthFactor
    }
    if (typeof anyMaterial.outlineLightingMixFactor === 'number') {
      state.outlineLightingMixFactor = anyMaterial.outlineLightingMixFactor
    }
    if (typeof anyMaterial.uvAnimationScrollXSpeedFactor === 'number') {
      state.uvAnimationScrollXSpeedFactor = anyMaterial.uvAnimationScrollXSpeedFactor
    }
    if (typeof anyMaterial.uvAnimationScrollYSpeedFactor === 'number') {
      state.uvAnimationScrollYSpeedFactor = anyMaterial.uvAnimationScrollYSpeedFactor
    }
    if (typeof anyMaterial.uvAnimationRotationSpeedFactor === 'number') {
      state.uvAnimationRotationSpeedFactor = anyMaterial.uvAnimationRotationSpeedFactor
    }
    if (typeof anyMaterial.side === 'number') state.side = anyMaterial.side
    if (typeof anyMaterial.transparent === 'boolean') state.transparent = anyMaterial.transparent
    if (typeof anyMaterial.opacity === 'number') state.opacity = anyMaterial.opacity
    if (typeof anyMaterial.alphaTest === 'number') state.alphaTest = anyMaterial.alphaTest
    if (typeof anyMaterial.alphaToCoverage === 'boolean') {
      state.alphaToCoverage = anyMaterial.alphaToCoverage
    }

    this.originalMaterialState.set(material.uuid, state)
  }

  private restoreMaterialState(
    material: THREE.Material,
    state: MaterialOriginalState,
    disposedTextures: Set<THREE.Texture>
  ) {
    this.releaseMaterialOverrideTextures(material, state, disposedTextures)
    const anyMaterial = material as THREE.Material & Record<string, any>
    if ('map' in anyMaterial) anyMaterial.map = state.map ?? null
    if ('shadeMultiplyTexture' in anyMaterial) {
      anyMaterial.shadeMultiplyTexture = state.shadeMultiplyTexture ?? null
    }
    if ('normalMap' in anyMaterial) anyMaterial.normalMap = state.normalMap ?? null
    if ('emissiveMap' in anyMaterial) anyMaterial.emissiveMap = state.emissiveMap ?? null
    if ('matcapTexture' in anyMaterial) anyMaterial.matcapTexture = state.matcapTexture ?? null
    if ('rimMultiplyTexture' in anyMaterial) {
      anyMaterial.rimMultiplyTexture = state.rimMultiplyTexture ?? null
    }
    if ('outlineWidthMultiplyTexture' in anyMaterial) {
      anyMaterial.outlineWidthMultiplyTexture = state.outlineWidthMultiplyTexture ?? null
    }
    if ('uvAnimationMaskTexture' in anyMaterial) {
      anyMaterial.uvAnimationMaskTexture = state.uvAnimationMaskTexture ?? null
    }
    if ('shadingShiftTexture' in anyMaterial) {
      anyMaterial.shadingShiftTexture = state.shadingShiftTexture ?? null
    }
    if (anyMaterial.color?.isColor && state.color) anyMaterial.color.copy(state.color)
    if (anyMaterial.shadeColorFactor?.isColor && state.shadeColorFactor) {
      anyMaterial.shadeColorFactor.copy(state.shadeColorFactor)
    }
    if (anyMaterial.emissive?.isColor && state.emissive) {
      anyMaterial.emissive.copy(state.emissive)
    }
    if (anyMaterial.matcapFactor?.isColor && state.matcapFactor) {
      anyMaterial.matcapFactor.copy(state.matcapFactor)
    }
    if (anyMaterial.parametricRimColorFactor?.isColor && state.parametricRimColorFactor) {
      anyMaterial.parametricRimColorFactor.copy(state.parametricRimColorFactor)
    }
    if (anyMaterial.outlineColorFactor?.isColor && state.outlineColorFactor) {
      anyMaterial.outlineColorFactor.copy(state.outlineColorFactor)
    }
    if (anyMaterial.normalScale?.isVector2 && state.normalScale) {
      anyMaterial.normalScale.copy(state.normalScale)
    }
    if (typeof state.shadingShiftFactor === 'number') {
      anyMaterial.shadingShiftFactor = state.shadingShiftFactor
    }
    if (typeof state.shadingShiftTextureScale === 'number') {
      anyMaterial.shadingShiftTextureScale = state.shadingShiftTextureScale
    }
    if (typeof state.shadingToonyFactor === 'number') {
      anyMaterial.shadingToonyFactor = state.shadingToonyFactor
    }
    if (typeof state.giEqualizationFactor === 'number') {
      anyMaterial.giEqualizationFactor = state.giEqualizationFactor
    }
    if (typeof state.rimLightingMixFactor === 'number') {
      anyMaterial.rimLightingMixFactor = state.rimLightingMixFactor
    }
    if (typeof state.parametricRimFresnelPowerFactor === 'number') {
      anyMaterial.parametricRimFresnelPowerFactor = state.parametricRimFresnelPowerFactor
    }
    if (typeof state.parametricRimLiftFactor === 'number') {
      anyMaterial.parametricRimLiftFactor = state.parametricRimLiftFactor
    }
    if (typeof state.outlineWidthMode === 'string') {
      anyMaterial.outlineWidthMode = state.outlineWidthMode
    }
    if (typeof state.outlineWidthFactor === 'number') {
      anyMaterial.outlineWidthFactor = state.outlineWidthFactor
    }
    if (typeof state.outlineLightingMixFactor === 'number') {
      anyMaterial.outlineLightingMixFactor = state.outlineLightingMixFactor
    }
    if (typeof state.uvAnimationScrollXSpeedFactor === 'number') {
      anyMaterial.uvAnimationScrollXSpeedFactor = state.uvAnimationScrollXSpeedFactor
    }
    if (typeof state.uvAnimationScrollYSpeedFactor === 'number') {
      anyMaterial.uvAnimationScrollYSpeedFactor = state.uvAnimationScrollYSpeedFactor
    }
    if (typeof state.uvAnimationRotationSpeedFactor === 'number') {
      anyMaterial.uvAnimationRotationSpeedFactor = state.uvAnimationRotationSpeedFactor
    }
    if (typeof state.side === 'number') anyMaterial.side = state.side
    if (typeof state.transparent === 'boolean') anyMaterial.transparent = state.transparent
    if (typeof state.opacity === 'number') anyMaterial.opacity = state.opacity
    if (typeof state.alphaTest === 'number') anyMaterial.alphaTest = state.alphaTest
    if (typeof state.alphaToCoverage === 'boolean') {
      anyMaterial.alphaToCoverage = state.alphaToCoverage
    }
    material.needsUpdate = true
  }

  async applyMaterialTexture(materialName: string, textureUrl: string): Promise<boolean> {
    if (!materialName || !textureUrl) return false
    if (!this.vrm) return false
    if (this.materialMap.size === 0) {
      this.collectMaterials()
    }
    const materials = this.materialMap.get(materialName)
    if (!materials || materials.length === 0) return false

    const transparentDataUrl =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII='
    let texture: THREE.Texture
    if (textureUrl === transparentDataUrl) {
      if (!this.transparentTexture) {
        const data = new Uint8Array([0, 0, 0, 0])
        const transparent = new THREE.DataTexture(data, 1, 1)
        transparent.flipY = false
        transparent.colorSpace = THREE.SRGBColorSpace
        transparent.needsUpdate = true
        this.transparentTexture = transparent
      }
      texture = this.transparentTexture
    } else {
      texture = await this.textureLoader.loadAsync(textureUrl)
      texture.flipY = false
      texture.colorSpace = THREE.SRGBColorSpace
      const image = texture.image as {
        width?: number
        height?: number
        naturalWidth?: number
        naturalHeight?: number
      }
      const width = image?.width ?? image?.naturalWidth ?? 0
      const height = image?.height ?? image?.naturalHeight ?? 0
      if (!width || !height) {
        texture.dispose()
        return false
      }
      this.trackMaterialRuntimeTexture(texture)
    }

    const disposedTextures = new Set<THREE.Texture>()
    let appliedTexture = false
    for (const material of materials) {
      const target = material as THREE.Material & { map?: THREE.Texture | null }
      if (!('map' in target)) continue
      this.rememberMaterialState(material)
      if (target.map && target.map !== texture) {
        this.releaseMaterialRuntimeTexture(target.map, disposedTextures)
      }
      target.map = texture
      target.needsUpdate = true
      appliedTexture = true
    }
    if (!appliedTexture && texture !== this.transparentTexture) {
      this.releaseMaterialRuntimeTexture(texture, disposedTextures)
    }
    return true
  }

  resetMaterialTexture(materialName?: string) {
    this.resetMaterialOverrides(materialName)
  }

  resetMaterialOverrides(materialName?: string) {
    if (this.materialMap.size === 0) {
      this.collectMaterials()
    }
    const names = materialName ? [materialName] : Array.from(this.materialMap.keys())
    const disposedTextures = new Set<THREE.Texture>()
    for (const name of names) {
      const materials = this.materialMap.get(name) ?? []
      for (const material of materials) {
        const state = this.originalMaterialState.get(material.uuid)
        if (!state) continue
        this.restoreMaterialState(material, state, disposedTextures)
        this.originalMaterialState.delete(material.uuid)
      }
    }
  }

  async applyXWearMaterial(
    materialName: string,
    xwear: GoonXWearData
  ): Promise<boolean> {
    if (!materialName || !xwear) return false
    if (!this.vrm) return false
    if (this.materialMap.size === 0) {
      this.collectMaterials()
    }
    const materials = this.materialMap.get(materialName)
    if (!materials || materials.length === 0) return false

    const colorMap: Record<string, string> = {
      _Color: 'color',
      _ShadeColor: 'shadeColorFactor',
      _EmissionColor: 'emissive',
      _MatcapColor: 'matcapFactor',
      _RimColor: 'parametricRimColorFactor',
      _OutlineColor: 'outlineColorFactor'
    }
    const textureTargetMap: Record<string, string> = {
      _MainTex: 'map',
      _ShadeTex: 'shadeMultiplyTexture',
      _BumpMap: 'normalMap',
      _EmissionMap: 'emissiveMap',
      _MatcapTex: 'matcapTexture',
      _RimTex: 'rimMultiplyTexture',
      _OutlineWidthMultiplyTexture: 'outlineWidthMultiplyTexture',
      _UvAnimMaskTex: 'uvAnimationMaskTexture',
      _ShadingShiftTex: 'shadingShiftTexture'
    }
    const floatMap: Record<string, string> = {
      _ShadingShiftFactor: 'shadingShiftFactor',
      _ShadingShiftTexScale: 'shadingShiftTextureScale',
      _ShadingToonyFactor: 'shadingToonyFactor',
      _GiEqualization: 'giEqualizationFactor',
      _RimFresnelPower: 'parametricRimFresnelPowerFactor',
      _RimLift: 'parametricRimLiftFactor',
      _RimLightingMix: 'rimLightingMixFactor',
      _OutlineWidth: 'outlineWidthFactor',
      _OutlineLightingMix: 'outlineLightingMixFactor',
      _UvAnimScrollXSpeed: 'uvAnimationScrollXSpeedFactor',
      _UvAnimScrollYSpeed: 'uvAnimationScrollYSpeedFactor',
      _UvAnimRotationSpeed: 'uvAnimationRotationSpeedFactor'
    }

    const layers = resolveXWearLayersForMaterial(xwear, materialName)
    if (layers.length === 0) return false

    const disposedTextures = new Set<THREE.Texture>()
    for (const layer of layers) {
      const textureMap = new Map<string, THREE.Texture>()
      for (const [property, ref] of Object.entries(layer.textures ?? {})) {
        const url = ref?.url
        if (!url) continue
        const texture = await this.textureLoader.loadAsync(url)
        texture.flipY = false
        const isColorTexture = [
          '_MainTex',
          '_ShadeTex',
          '_EmissionMap',
          '_MatcapTex',
          '_RimTex',
          '_OutlineWidthMultiplyTexture'
        ].includes(property)
        texture.colorSpace = isColorTexture ? THREE.SRGBColorSpace : THREE.NoColorSpace
        const image = texture.image as {
          width?: number
          height?: number
          naturalWidth?: number
          naturalHeight?: number
        }
        const width = image?.width ?? image?.naturalWidth ?? 0
        const height = image?.height ?? image?.naturalHeight ?? 0
        if (!width || !height) {
          texture.dispose()
          continue
        }
        this.trackMaterialRuntimeTexture(texture)
        textureMap.set(property, texture)
      }

      const assignedLayerTextures = new Set<THREE.Texture>()
      for (const material of materials) {
        this.rememberMaterialState(material)
        const target = material as THREE.Material & Record<string, any>

        for (const [property, color] of Object.entries(layer.colors ?? {})) {
          const targetKey = colorMap[property]
          if (!targetKey) continue
          const targetColor = target[targetKey]
          if (targetColor?.isColor) {
            targetColor.setRGB(color.r, color.g, color.b)
          }
          if (property === '_Color' && typeof target.opacity === 'number') {
            target.opacity = color.a ?? 1
            target.transparent = (color.a ?? 1) < 1
          }
        }

        for (const [property, value] of Object.entries(layer.floats ?? {})) {
          if (property === '_BumpScale' && target.normalScale?.isVector2) {
            target.normalScale.set(value, value)
            continue
          }
          if (property === '_OutlineWidthMode') {
            if (typeof value === 'number') {
              if (value <= 0) target.outlineWidthMode = 'none'
              else if (value <= 1) target.outlineWidthMode = 'worldCoordinates'
              else target.outlineWidthMode = 'screenCoordinates'
            }
            continue
          }
          if (property === '_DoubleSided') {
            if (typeof value === 'number') {
              target.side = value > 0.5 ? THREE.DoubleSide : THREE.FrontSide
            }
            continue
          }
          const targetKey = floatMap[property]
          if (!targetKey) continue
          target[targetKey] = value
        }

        for (const [property, texture] of textureMap.entries()) {
          const targetKey = textureTargetMap[property]
          if (!targetKey) continue
          if (targetKey in target) {
            const compositeTexture =
              isBodySkinClosetSlotMaterialName(materialName) &&
              (property === '_MainTex' || property === '_ShadeTex')
                ? this.buildCompositeTexture(
                    target[targetKey] as THREE.Texture | null | undefined,
                    texture,
                    texture.colorSpace as THREE.ColorSpace
                  )
                : null
            const nextTexture = compositeTexture ?? texture
            if (compositeTexture) {
              this.trackMaterialRuntimeTexture(compositeTexture)
            } else {
              assignedLayerTextures.add(texture)
            }
            if (target[targetKey] && target[targetKey] !== nextTexture) {
              this.releaseMaterialRuntimeTexture(target[targetKey] as THREE.Texture, disposedTextures)
            }
            target[targetKey] = nextTexture
          }
        }

        material.needsUpdate = true
      }

      for (const texture of textureMap.values()) {
        if (!assignedLayerTextures.has(texture)) {
          this.releaseMaterialRuntimeTexture(texture, disposedTextures)
        }
      }
    }
    return true
  }

  resetAnimationWarnings() {
    this.animationWarnings = []
    this.emitActiveCompatibility()
  }

  private registerAnimations(
    animations: THREE.AnimationClip[] = [],
    sourceLabel?: string,
    sourceType: AnimationSource = 'goon',
    motionMeta?: GoonFileRef['motionMeta']
  ) {
    if (!animations || animations.length === 0) return false

    let added = false
    const safeSource =
      sourceLabel
        ?.toLowerCase()
        .replace(/\.[^/.]+$/, '')
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '') || 'animation'

    animations.forEach((animationClip, index) => {
      const preparedClip = this.normalizeClipRootMotionInPlace(animationClip)
      if (sourceType === 'goon') {
        this.enforceGoonClipTransformContract(preparedClip)
      }
      const baseName =
        preparedClip.name && preparedClip.name.trim().length > 0
          ? preparedClip.name
          : `animation_${index + 1}`
      let name = baseName

      if (this.animationMap.has(name)) {
        const suffix = safeSource ? `__${safeSource}` : '__extra'
        let candidate = `${baseName}${suffix}`
        let counter = 1
        while (this.animationMap.has(candidate)) {
          counter += 1
          candidate = `${baseName}${suffix}_${counter}`
        }
        name = candidate
      }

      preparedClip.name = name
      this.animationMap.set(name, preparedClip)
      this.animationMetadata.set(
        name,
        motionMeta
          ? {
              ...motionMeta
            }
          : undefined
      )
      this.animationSources.set(name, sourceType)
      added = true
    })

    if (added) {
      this.hasBodyAnimations = true
    }

    return added
  }

  private addAnimationWarning(message: string) {
    if (!message) return false
    if (this.animationWarnings.includes(message)) return false
    this.animationWarnings = [...this.animationWarnings, message]
    return true
  }

  private isRootMotionTrack(trackName: string) {
    const nodeName = trackName.replace(/\.position$/i, '')
    const lower = nodeName.toLowerCase()
    const normalizedNodeName = this.normalizeName(nodeName)
    if (normalizedNodeName && this.rootMotionTrackHints.has(normalizedNodeName)) return true
    for (const token of nodeName.split(/[|/:]/g)) {
      const normalizedToken = this.normalizeName(token)
      if (!normalizedToken) continue
      if (this.rootMotionTrackHints.has(normalizedToken)) return true
      for (const hint of this.rootMotionTrackHints) {
        if (normalizedToken.endsWith(hint) || hint.endsWith(normalizedToken)) {
          return true
        }
      }
    }
    if (lower.includes('mixamorighips')) return true
    if (lower.includes('j_bip_c_hips')) return true
    if (lower.includes('waist')) return true
    if (lower.includes('armature')) return true
    if (lower.includes('skeleton')) return true
    if (lower.includes('origin')) return true
    if (/(^|[^a-z])hips?([^a-z]|$)/.test(lower)) return true
    if (/(^|[^a-z])pelvis([^a-z]|$)/.test(lower)) return true
    if (/(^|[^a-z])root([^a-z]|$)/.test(lower)) return true
    if (/(^|[^a-z])center([^a-z]|$)/.test(lower)) return true
    if (/(^|[^a-z])centre([^a-z]|$)/.test(lower)) return true
    if (/(^|[^a-z])cog([^a-z]|$)/.test(lower)) return true
    return false
  }

  private normalizeClipRootMotionInPlace(clip: THREE.AnimationClip) {
    const normalized = clip.clone()
    const tinyDriftEpsilon = 0.000001
    const channelsPerKey = 3
    let positionTrackCount = 0
    let rootTrackCount = 0
    let neutralizedTrackCount = 0
    const trackDetails: Array<{
      track: string
      root: boolean
      keyframes: number
      startX?: number
      startZ?: number
      driftX: number
      driftZ: number
      maxAbsDriftX?: number
      maxAbsDriftZ?: number
      rangeX?: number
      rangeZ?: number
      neutralized: boolean
    }> = []

    for (const track of normalized.tracks) {
      if (!(track instanceof THREE.VectorKeyframeTrack)) continue
      if (!track.name.toLowerCase().endsWith('.position')) continue
      positionTrackCount += 1
      const isRootTrack = this.isRootMotionTrack(track.name)
      if (isRootTrack) rootTrackCount += 1

      const values = track.values
      const keyCount = track.times.length
      const availableKeyCount = Math.min(keyCount, Math.floor(values.length / channelsPerKey))
      if (availableKeyCount < 1) {
        if (this.debugRootMotionEnabled) {
          trackDetails.push({
            track: track.name,
            root: isRootTrack,
            keyframes: keyCount,
            driftX: 0,
            driftZ: 0,
            neutralized: false
          })
        }
        continue
      }

      const startX = values[0] ?? 0
      const startZ = values[2] ?? 0
      const endIndex = (availableKeyCount - 1) * channelsPerKey
      const endX = values[endIndex] ?? startX
      const endZ = values[endIndex + 2] ?? startZ
      let rebased = false
      let maxAbsDriftX = 0
      let maxAbsDriftZ = 0
      let minX = startX
      let maxX = startX
      let minZ = startZ
      let maxZ = startZ
      for (let i = 1; i < availableKeyCount; i += 1) {
        const idx = i * channelsPerKey
        const x = values[idx] ?? startX
        const z = values[idx + 2] ?? startZ
        const driftX = Math.abs(x - startX)
        const driftZ = Math.abs(z - startZ)
        if (driftX > maxAbsDriftX) maxAbsDriftX = driftX
        if (driftZ > maxAbsDriftZ) maxAbsDriftZ = driftZ
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (z < minZ) minZ = z
        if (z > maxZ) maxZ = z
      }
      let neutralized = false
      if (isRootTrack) {
        for (let i = 0; i < availableKeyCount; i += 1) {
          const idx = i * channelsPerKey
          // Preserve authored root motion, but remove the initial lateral bind offset.
          // Flattening every key to zero erases legitimate motion and can cause visible skating.
          values[idx] = (values[idx] ?? 0) - startX
          values[idx + 2] = (values[idx + 2] ?? 0) - startZ
        }
        rebased = Math.abs(startX) > tinyDriftEpsilon || Math.abs(startZ) > tinyDriftEpsilon
        neutralized = rebased
        if (neutralized) {
          neutralizedTrackCount += 1
        }
      }
      if (this.debugRootMotionEnabled) {
        trackDetails.push({
          track: track.name,
          root: isRootTrack,
          keyframes: keyCount,
          startX: Number(startX.toFixed(6)),
          startZ: Number(startZ.toFixed(6)),
          driftX: Number((endX - startX).toFixed(6)),
          driftZ: Number((endZ - startZ).toFixed(6)),
          maxAbsDriftX: Number(maxAbsDriftX.toFixed(6)),
          maxAbsDriftZ: Number(maxAbsDriftZ.toFixed(6)),
          rangeX: Number((maxX - minX).toFixed(6)),
          rangeZ: Number((maxZ - minZ).toFixed(6)),
          neutralized
        })
      }
    }

    this.logRootMotionDebug('ClipNormalization', {
      clip: normalized.name || '(unnamed)',
      durationSec: Number(normalized.duration.toFixed(3)),
      positionTracks: positionTrackCount,
      rootTracks: rootTrackCount,
      neutralizedTracks: neutralizedTrackCount,
      trackDetails
    })

    normalized.resetDuration()
    return normalized
  }

  /**
   * GLB-lane clip transform contract (SA-090): converted clips are
   * rotation-only plus root/hips translation. Blender's glTF export bakes
   * constant rest translation + scale tracks onto every bone; playing those
   * back stomps the body-dial joint-follow rest positions every frame while
   * the corrected inverse binds stay dialed, which reads as limbs chopped at
   * the joints. Enforce the contract at registration: keep quaternions and
   * root-motion translations, drop every other position/scale track.
   */
  private enforceGoonClipTransformContract(clip: THREE.AnimationClip) {
    let droppedPositionTracks = 0
    let droppedScaleTracks = 0
    const kept = clip.tracks.filter((track) => {
      const name = track.name.toLowerCase()
      if (name.endsWith('.position')) {
        if (this.isRootMotionTrack(track.name)) return true
        droppedPositionTracks += 1
        return false
      }
      if (name.endsWith('.scale')) {
        droppedScaleTracks += 1
        return false
      }
      return true
    })
    if (droppedPositionTracks === 0 && droppedScaleTracks === 0) return
    clip.tracks = kept
    logger.debug(
      `[GoonEngine] clip contract: dropped ${droppedPositionTracks} bone position and ` +
        `${droppedScaleTracks} scale track(s) from "${clip.name || '(unnamed clip)'}"`
    )
  }

  private collectMaterials() {
    this.materialMap.clear()
    const roots: Array<THREE.Object3D> = []
    if (this.vrm?.scene) roots.push(this.vrm.scene)
    if (this.guidedDufOverlayRoot) roots.push(this.guidedDufOverlayRoot)
    if (roots.length === 0) return
    for (const root of roots) {
      root.traverse((node) => {
      const mesh = node as THREE.Mesh
      if (!((mesh as any).isMesh || (mesh as any).isSkinnedMesh)) return
      if (mesh.visible === false) return
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      for (const material of materials) {
        if (!material) continue
        const name = material.name?.trim()
        if (!name) continue
        const bucket = this.materialMap.get(name) ?? []
        if (!bucket.includes(material)) {
          bucket.push(material)
        }
        this.materialMap.set(name, bucket)
      }
      })
    }
  }

  private applyMaterialEdgeSmoothing() {
    if (this.materialMap.size === 0) return

    const enableCutoutSmoothing = this.quality !== 'low'
    for (const materials of this.materialMap.values()) {
      for (const material of materials) {
        const anyMaterial = material as THREE.Material & Record<string, any>
        if (typeof anyMaterial.alphaToCoverage !== 'boolean') continue
        const usesCutoutAlpha = typeof anyMaterial.alphaTest === 'number' && anyMaterial.alphaTest > 0
        const nextAlphaToCoverage = enableCutoutSmoothing && usesCutoutAlpha
        if (anyMaterial.alphaToCoverage === nextAlphaToCoverage) continue
        anyMaterial.alphaToCoverage = nextAlphaToCoverage
        material.needsUpdate = true
      }
    }
  }

  private analyzeAnimationTargets(
    animations: THREE.AnimationClip[] = [],
    normalizedSceneNames?: Set<string>
  ) {
    if (!this.vrm || animations.length === 0) {
      return { matchedTracks: 0, totalTracks: 0, matchRatio: 0 }
    }

    const sceneNames = normalizedSceneNames ?? this.collectNormalizedSceneNames()
    let matchedTracks = 0
    let totalTracks = 0

    for (const animationClip of animations) {
      for (const track of animationClip.tracks) {
        if (!track?.name) continue
        totalTracks += 1
        if (this.trackMatchesScene(track.name, sceneNames)) {
          matchedTracks += 1
        }
      }
    }

    const matchRatio = totalTracks > 0 ? matchedTracks / totalTracks : 0
    return { matchedTracks, totalTracks, matchRatio }
  }

  private collectNormalizedSceneNames() {
    const names = new Set<string>()
    const root = this.vrm?.scene ?? this.customAvatarRoot
    if (!root) return names

    root.traverse((obj: any) => {
      if (!obj?.name) return
      const normalized = this.normalizeName(obj.name)
      if (normalized) names.add(normalized)
    })

    for (const bone of Object.values(this.bones)) {
      if (!bone?.name) continue
      const normalized = this.normalizeName(bone.name)
      if (normalized) names.add(normalized)
    }

    return names
  }

  private trackMatchesScene(trackName: string, normalizedSceneNames: Set<string>) {
    if (!trackName || normalizedSceneNames.size === 0) return false
    const base = trackName.split('.')[0]
    const candidates = new Set<string>()
    if (base) {
      candidates.add(base)
      candidates.add(base.split('|').pop() || base)
      candidates.add(base.split('/').pop() || base)
      candidates.add(base.split(':').pop() || base)
    }

    for (const candidate of candidates) {
      const normalizedCandidate = this.normalizeName(candidate)
      if (!normalizedCandidate) continue
      if (normalizedSceneNames.has(normalizedCandidate)) return true

      for (const sceneName of normalizedSceneNames) {
        if (!sceneName) continue
        if (normalizedCandidate.endsWith(sceneName) || sceneName.endsWith(normalizedCandidate)) {
          return true
        }
      }
    }

    return false
  }

  private normalizeName(name: string) {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '')
      .trim()
  }

  attachAudio(audio: HTMLAudioElement | null) {
    if (!audio) {
      this.audioElement = null
      this.disconnectAudioAnalyser()
      return
    }

    if (this.audioElement === audio && this.analyser) {
      return
    }

    this.audioElement = audio
    try {
      this.audioContext = this.audioContext || new AudioContext()

      this.disconnectAudioAnalyser()

      const streamSource =
        typeof MediaStream !== 'undefined' && audio.srcObject instanceof MediaStream
          ? audio.srcObject
          : null
      this.audioSource = streamSource
        ? this.audioContext.createMediaStreamSource(streamSource)
        : this.audioContext.createMediaElementSource(audio)
      this.analyser = this.audioContext.createAnalyser()
      this.analyser.fftSize = 256
      this.analyserData = new Uint8Array(new ArrayBuffer(this.analyser.fftSize))
      this.audioSource.connect(this.analyser)
      if (streamSource) {
        const silentOutput = this.audioContext.createGain()
        silentOutput.gain.value = 0
        this.analyser.connect(silentOutput)
        silentOutput.connect(this.audioContext.destination)
        this.audioOutputNode = silentOutput
      } else {
        this.analyser.connect(this.audioContext.destination)
        this.audioOutputNode = this.analyser
      }
      void this.audioContext.resume()
    } catch (error) {
      console.warn('[GoonEngine] Failed to attach audio analyser; using procedural lip sync fallback.', error)
      this.disconnectAudioAnalyser()
    }
  }

  private disconnectAudioAnalyser() {
    const analyser = this.analyser
    const outputNode = this.audioOutputNode

    if (this.audioSource) {
      this.audioSource.disconnect()
      this.audioSource = null
    }
    if (outputNode && outputNode !== analyser) {
      outputNode.disconnect()
    }
    if (analyser) {
      analyser.disconnect()
    }
    this.analyser = null
    this.audioOutputNode = null
    this.analyserData = null
  }

  playCue(name: string, definition?: GoonCueDefinition, options: PlacementOptions = {}) {
    const playback = definition?.playback
    const kind = definition?.kind
    if (playback === 'loop' || kind === 'mood') {
      this.setMood(name, definition, options)
      return
    }

    if (playback === 'oneshot' || kind === 'emote') {
      this.playEmote(name, definition)
      return
    }

    if (
      definition?.expressionTargets ||
      definition?.faceControls ||
      definition?.rawMorphTargets ||
      definition?.steps
    ) {
      this.playEmote(name, definition)
      return
    }

    // Fallback mapping if no definition provided
    if (['smile', 'smirk', 'sad', 'angry', 'surprised', 'blink'].includes(name)) {
      this.triggerExpression(name)
      return
    }

    const fallbackAnimationName = definition?.animationName ?? name
    if (this.playOneShotAnimation(fallbackAnimationName)) {
      return
    }
    this.requestDeferredAnimation(fallbackAnimationName, 'generic', definition)
  }

  dispose() {
    this.loadToken += 1
    this.deferredLoadToken += 1
    const renderer = this.renderer
    if (renderer) {
      const element = renderer.domElement
      element.removeEventListener('pointerdown', this.handlePointerDown)
      element.removeEventListener('pointermove', this.handlePointerMove)
      element.removeEventListener('pointerup', this.handlePointerUp)
      element.removeEventListener('pointerleave', this.handlePointerUp)
      element.removeEventListener('pointercancel', this.handlePointerUp)
      element.removeEventListener('contextmenu', this.handleContextMenu)
      element.removeEventListener('wheel', this.handleWheel)
      element.removeEventListener('keyup', this.handleKeyUp)
      renderer.setAnimationLoop(null)
    }
    if (this.controls) {
      this.controls.removeEventListener('change', this.handleCameraChange)
    }
    this.controls?.dispose()
    this.clearEditTarget()
    if (this.transformControls) {
      this.transformControls.removeEventListener('dragging-changed', this.handleTransformDragging)
      this.transformControls.removeEventListener('mouseDown', this.handleTransformMouseDown)
      this.transformControls.removeEventListener('mouseUp', this.handleTransformMouseUp)
      this.transformControls.removeEventListener('objectChange', this.handleTransformObjectChange)
      this.transformControls.dispose()
      this.transformControls = undefined
    }
    if (this.transformControlsHelper) {
      this.scene.remove(this.transformControlsHelper)
      this.transformControlsHelper = undefined
    }
    if (this.resizeObserver) {
      this.resizeObserver.disconnect()
    }
    if (this.cameraChangeTimer) {
      clearTimeout(this.cameraChangeTimer)
      this.cameraChangeTimer = null
    }
    this.resetMaterialOverrides()
    this.releaseAllMaterialRuntimeTextures()
    if (this.vrm) {
      this.disposeVrmScene(this.vrm.scene)
      this.scene.remove(this.vrm.scene)
      this.vrm = null
    }
    if (this.customAvatarRoot) {
      this.scene.remove(this.customAvatarRoot)
      this.disposeObject3D(this.customAvatarRoot)
      this.customAvatarRoot = null
    }
    this.customStageAnchors = {}
    this.rootMotionTrackHints.clear()
    this.rootMotionLockNodes = []
    if (this.mixer) {
      this.mixer.removeEventListener('finished', this.handleAnimationFinished)
      this.mixer.stopAllAction()
      try {
        this.mixer.uncacheRoot(this.mixer.getRoot())
      } catch (error) {
        console.warn('[GoonEngine] Failed to uncache mixer root during dispose:', error)
      }
      this.mixer = null
    }
    this.propToken += 1
    for (const object of this.propObjects.values()) {
      this.sceneRoot.remove(object)
      this.disposeObject3D(object)
    }
    this.propObjects.clear()
    this.propLocalBounds.clear()
    this.sceneProps = []
    this.sceneMarkers = {}
    this.clearSceneAmbience()
    this.clearRoomShell()
    this.clearRoomShellBuilder()
    this.clearGroundedSkybox()
    if (this.skyboxMesh) {
      this.skyboxScene.remove(this.skyboxMesh)
      this.skyboxMesh.geometry.dispose()
      const material = this.skyboxMesh.material
      if (Array.isArray(material)) {
        material.forEach((mat) => {
          try {
            mat.dispose()
          } catch (error) {
            this.materialDisposeErrorCount += 1
            if (this.materialDisposeErrorCount <= 3) {
              console.warn('[GoonEngine] Failed to dispose skybox material cleanly:', error)
            }
          }
        })
      } else {
        try {
          material.dispose()
        } catch (error) {
          this.materialDisposeErrorCount += 1
          if (this.materialDisposeErrorCount <= 3) {
            console.warn('[GoonEngine] Failed to dispose skybox material cleanly:', error)
          }
        }
      }
      this.skyboxMesh = null
    }
    if (this.skyboxTexture) {
      this.skyboxTexture.dispose()
      this.skyboxTexture = null
    }
    if (this.transparentTexture) {
      this.transparentTexture.dispose()
      this.transparentTexture = null
    }
    this.clearLoadedAnimationState()
    this.materialMap.clear()
    this.originalMaterialState.clear()
    this.releaseAllMaterialRuntimeTextures()
    this.mouthExpressionMorphTargetNames.clear()
    this.availableMouthPresets.clear()
    this.clearSpeechPlayback()
    this.disconnectAudioAnalyser()
    this.clock.dispose()
    if (renderer) {
      renderer.dispose()
      if (renderer.domElement.parentElement) {
        renderer.domElement.parentElement.removeChild(renderer.domElement)
      }
    }
  }

  captureSnapshot(): string | null {
    if (!this.renderer) return null
    try {
      return this.renderer.domElement.toDataURL('image/png')
    } catch {
      return null
    }
  }

  getCanvasElement(): HTMLCanvasElement | null {
    return (this.renderer?.domElement as HTMLCanvasElement | undefined) ?? null
  }

  refreshLayout() {
    this.handleResize()
  }

  private handleResize() {
    if (!this.renderer) return
    const { clientWidth, clientHeight } = this.container
    if (!clientWidth || !clientHeight) return
    if (this.viewOffset) {
      const fullWidth = Math.max(clientWidth, this.viewOffset.fullWidth)
      const fullHeight = Math.max(clientHeight, this.viewOffset.fullHeight)
      const maxOffsetX = Math.max(0, fullWidth - clientWidth)
      const maxOffsetY = Math.max(0, fullHeight - clientHeight)
      const offsetX = Math.min(maxOffsetX, Math.max(0, this.viewOffset.offsetX))
      const offsetY = Math.min(maxOffsetY, Math.max(0, this.viewOffset.offsetY))
      this.camera.aspect = fullWidth / fullHeight
      this.camera.setViewOffset(fullWidth, fullHeight, offsetX, offsetY, clientWidth, clientHeight)
      this.camera.updateProjectionMatrix()
      this.skyboxCamera.aspect = fullWidth / fullHeight
      this.skyboxCamera.setViewOffset(fullWidth, fullHeight, offsetX, offsetY, clientWidth, clientHeight)
      this.skyboxCamera.updateProjectionMatrix()
    } else {
      this.camera.aspect = clientWidth / clientHeight
      this.camera.clearViewOffset()
      this.camera.updateProjectionMatrix()
      this.skyboxCamera.aspect = clientWidth / clientHeight
      this.skyboxCamera.clearViewOffset()
      this.skyboxCamera.updateProjectionMatrix()
    }
    this.groundedSkyboxCamera.aspect = clientWidth / clientHeight
    this.groundedSkyboxCamera.clearViewOffset()
    this.groundedSkyboxCamera.updateProjectionMatrix()
    this.renderer.setSize(clientWidth * this.renderScale, clientHeight * this.renderScale, false)
    this.renderer.domElement.style.width = '100%'
    this.renderer.domElement.style.height = '100%'
  }

  private update() {
    if (this.renderFailed) return
    const now = performance.now()
    const hasExpressions = this.activeExpressions.length > 0
    const hasSceneAmbience = Boolean(this.sceneAmbienceRuntime)
    const idle =
      !this.speaking &&
      !hasExpressions &&
      !hasSceneAmbience &&
      !this.baseLoopAction &&
      !this.animationOverrideActive &&
      !this.oneShotAction
    const idleInterval = 1000 / 20
    const interval = idle
      ? Math.max(this.targetFrameIntervalMs, idleInterval)
      : this.targetFrameIntervalMs

    if (now - this.lastFrameTime < interval) {
      return
    }
    this.clock.update(now)
    const delta = this.clock.getDelta()
    const elapsed = this.clock.getElapsed()
    this.frameCounter += 1
    this.lastFrameTime = now
    if (now - this.lastFpsTime >= 1000) {
      const fps = Math.round((this.frameCounter * 1000) / (now - this.lastFpsTime))
      this.onPerformance?.({ fps })
      this.frameCounter = 0
      this.lastFpsTime = now
    }

    if (this.customAvatarRoot) {
      this.customPerformanceRigRuntime?.removeOverlay()
    }
    if (this.mixer && !this.authoringPoseMode) {
      this.mixer.update(delta)
    }
    if (this.customAvatarRoot && this.bodyDialsHipsRemap) {
      this.applyBodyDialHipsRemap()
    }
    if (this.customAvatarRoot && this.appearanceDialsRuntime) {
      this.appearanceDialsRuntime.applyHipsClipRemap()
    }
    if (this.customAvatarRoot && (this.jointCorrectivesSpec || this.liveJointCorrectivesSpec)) {
      this.applyJointCorrectives()
    }

    if (this.vrm) {
      const shouldUpdatePose =
        this.poseUpdateIntervalMs === 0 || now - this.lastPoseUpdateTime >= this.poseUpdateIntervalMs
      if (shouldUpdatePose) {
        this.applyPose(elapsed)
        this.vrm.update(delta)
        this.applyDirectEyeBoneDebugOverride()
        this.applyFaceControls()
        if (
          this.customExpressionMorphMap.size > 0 ||
          this.customFaceControlMap !== null ||
          this.customMorphDefinitions.length > 0 ||
          this.customArkitFaceDriverBindings !== null
        ) {
          this.applyCustomPerformance(elapsed)
        }
        if (this.baseLoopAction || this.oneShotAction) {
          this.stabilizeRootLateralMotion()
        }
        this.lastPoseUpdateTime = now
      }
    }

    if (this.customAvatarRoot) {
      const shouldUpdatePose =
        this.poseUpdateIntervalMs === 0 || now - this.lastPoseUpdateTime >= this.poseUpdateIntervalMs
      if (shouldUpdatePose) {
        this.applyCustomPerformance(elapsed)
        this.lastPoseUpdateTime = now
      }
      this.applyCustomPerformanceOverlays()
    }

    if (this.guidedDufOverlayBonePairs.length > 0) {
      this.syncGuidedDufOverlayBones()
    }

    this.updateAnchorTransition(now)
    this.updateSceneAmbienceRuntime(delta, elapsed)

    if (!this.lookActive) {
      this.controls?.update()
    } else {
      this.applyLookRotation()
    }
    if (this.applyIndoorCameraConstraint()) {
      this.controls?.update()
    }

    if (this.skyboxActive) {
      this.tempEuler.setFromQuaternion(this.camera.quaternion, 'YXZ')
      this.tempEuler.x = THREE.MathUtils.clamp(
        this.tempEuler.x + this.skyboxPitchOffset,
        -Math.PI / 2 + 0.01,
        Math.PI / 2 - 0.01
      )
      this.skyboxCamera.quaternion.setFromEuler(this.tempEuler)
    }

    if (this.renderer) {
      try {
        const previousAutoClear = this.renderer.autoClear
        if (this.groundedSkybox) {
          this.syncGroundedSkyboxCamera()
          this.renderer.autoClear = true
          this.renderer.render(this.groundedSkyboxScene, this.groundedSkyboxCamera)
          this.renderer.autoClear = false
        } else if (this.skyboxActive && this.skyboxMesh?.visible) {
          this.renderer.autoClear = true
          this.renderer.render(this.skyboxScene, this.skyboxCamera)
          this.renderer.autoClear = false
        } else {
          this.renderer.autoClear = true
        }
        this.renderer.render(this.scene, this.camera)
        this.renderer.autoClear = previousAutoClear
      } catch (error) {
        this.handleRenderFailure(error)
      }
    }
  }

  private updateSceneAmbienceRuntime(delta: number, elapsed: number) {
    const runtime = this.sceneAmbienceRuntime
    if (!runtime) return
    const { bounds, config, material, phases, positions, preset, velocities } = runtime
    const count = phases.length
    for (let index = 0; index < count; index += 1) {
      const offset = index * 3
      positions[offset] += velocities[offset] * delta
      positions[offset + 1] += velocities[offset + 1] * delta
      positions[offset + 2] += velocities[offset + 2] * delta

      if (preset.direction === 'float') {
        const wave = Math.sin(elapsed * (0.8 + config.speed * 0.35) + phases[index])
        positions[offset] += wave * preset.jitter * delta * 0.16
        positions[offset + 2] += Math.cos(elapsed * 0.7 + phases[index]) * preset.jitter * delta * 0.12
      }

      const outOfBounds =
        positions[offset] < bounds.minX ||
        positions[offset] > bounds.maxX ||
        positions[offset + 1] < bounds.minY ||
        positions[offset + 1] > bounds.maxY ||
        positions[offset + 2] < bounds.minZ ||
        positions[offset + 2] > bounds.maxZ
      if (outOfBounds) {
        this.resetAmbienceParticle(runtime, index, true)
      }
    }
    runtime.positionAttribute.needsUpdate = true
    if (preset.pulse) {
      material.opacity = preset.opacity * (0.72 + 0.28 * Math.sin(elapsed * 1.7))
    }
  }

  private captureBones() {
    if (!this.vrm) return
    const humanoid = this.vrm.humanoid
    this.bones = {
      [VRMHumanBoneName.Hips]: humanoid.getNormalizedBoneNode(VRMHumanBoneName.Hips) || undefined,
      [VRMHumanBoneName.Spine]: humanoid.getNormalizedBoneNode(VRMHumanBoneName.Spine) || undefined,
      [VRMHumanBoneName.Chest]: humanoid.getNormalizedBoneNode(VRMHumanBoneName.Chest) || undefined,
      [VRMHumanBoneName.UpperChest]:
        humanoid.getNormalizedBoneNode(VRMHumanBoneName.UpperChest) || undefined,
      [VRMHumanBoneName.Neck]: humanoid.getNormalizedBoneNode(VRMHumanBoneName.Neck) || undefined,
      [VRMHumanBoneName.Head]: humanoid.getNormalizedBoneNode(VRMHumanBoneName.Head) || undefined,
      [VRMHumanBoneName.LeftEye]:
        humanoid.getNormalizedBoneNode(VRMHumanBoneName.LeftEye) || undefined,
      [VRMHumanBoneName.RightEye]:
        humanoid.getNormalizedBoneNode(VRMHumanBoneName.RightEye) || undefined,
      [VRMHumanBoneName.RightUpperArm]:
        humanoid.getNormalizedBoneNode(VRMHumanBoneName.RightUpperArm) || undefined,
      [VRMHumanBoneName.RightLowerArm]:
        humanoid.getNormalizedBoneNode(VRMHumanBoneName.RightLowerArm) || undefined,
      [VRMHumanBoneName.LeftUpperArm]:
        humanoid.getNormalizedBoneNode(VRMHumanBoneName.LeftUpperArm) || undefined,
      [VRMHumanBoneName.LeftLowerArm]:
        humanoid.getNormalizedBoneNode(VRMHumanBoneName.LeftLowerArm) || undefined,
      [VRMHumanBoneName.RightUpperLeg]:
        humanoid.getNormalizedBoneNode(VRMHumanBoneName.RightUpperLeg) || undefined,
      [VRMHumanBoneName.RightLowerLeg]:
        humanoid.getNormalizedBoneNode(VRMHumanBoneName.RightLowerLeg) || undefined,
      [VRMHumanBoneName.LeftUpperLeg]:
        humanoid.getNormalizedBoneNode(VRMHumanBoneName.LeftUpperLeg) || undefined,
      [VRMHumanBoneName.LeftLowerLeg]:
        humanoid.getNormalizedBoneNode(VRMHumanBoneName.LeftLowerLeg) || undefined,
      [VRMHumanBoneName.RightFoot]:
        humanoid.getNormalizedBoneNode(VRMHumanBoneName.RightFoot) || undefined,
      [VRMHumanBoneName.LeftFoot]:
        humanoid.getNormalizedBoneNode(VRMHumanBoneName.LeftFoot) || undefined
    }
  }

  private captureRestPose() {
    this.restRotations.clear()
    this.restPositions.clear()
    this.rawRestRotations.clear()
    this.rawRestPositions.clear()
    for (const [key, bone] of Object.entries(this.bones)) {
      if (!bone) continue
      const name = key as VRMHumanBoneName
      this.restRotations.set(name, bone.quaternion.clone())
      this.restPositions.set(name, bone.position.clone())
      const rawBone = this.vrm?.humanoid.getRawBoneNode(name)
      if (rawBone) {
        this.rawRestRotations.set(name, rawBone.quaternion.clone())
        this.rawRestPositions.set(name, rawBone.position.clone())
      }
    }
  }

  private captureRootMotionLockNodes() {
    this.rootMotionTrackHints.clear()
    this.rootMotionLockNodes = []
    if (!this.vrm) return
    const hips = this.bones[VRMHumanBoneName.Hips]
    if (!hips) return

    const registerHint = (value?: string | null) => {
      if (!value) return
      const full = this.normalizeName(value)
      if (full) this.rootMotionTrackHints.add(full)
      const tokens = value.split(/[|/:]/g)
      for (const token of tokens) {
        const normalized = this.normalizeName(token)
        if (normalized) this.rootMotionTrackHints.add(normalized)
      }
    }

    registerHint(hips.name)
    // Keep hierarchy names as hints for root-track detection.
    // We intentionally avoid runtime lock-node forcing because it can fight authored pose sway.
    let current: THREE.Object3D | null = hips.parent
    while (current && current !== this.vrm.scene) {
      registerHint(current.name)
      current = current.parent
    }

    this.logRootMotionDebug('LockNodesCaptured', {
      hints: Array.from(this.rootMotionTrackHints.values()),
      lockNodes: this.rootMotionLockNodes.map((entry) => ({
        name: entry.node.name || '(unnamed)',
        restX: Number(entry.restX.toFixed(6)),
        restZ: Number(entry.restZ.toFixed(6))
      }))
    })
  }

  private applyRestPose() {
    for (const [name, bone] of Object.entries(this.bones)) {
      if (!bone) continue
      const boneName = name as VRMHumanBoneName
      const restRot = this.restRotations.get(boneName)
      const restPos = this.restPositions.get(boneName)
      if (restRot) bone.quaternion.copy(restRot)
      if (restPos) bone.position.copy(restPos)
    }
  }

  private resetGazeBoneToRest(boneName: VRMHumanBoneName) {
    const normalized = this.bones[boneName] ?? this.vrm?.humanoid.getNormalizedBoneNode(boneName)
    const normalizedRestRot = this.restRotations.get(boneName)
    const normalizedRestPos = this.restPositions.get(boneName)
    if (normalizedRestRot && normalized) {
      normalized.quaternion.copy(normalizedRestRot)
    }
    if (normalizedRestPos && normalized) {
      normalized.position.copy(normalizedRestPos)
    }

    const raw = this.vrm?.humanoid.getRawBoneNode(boneName)
    if (!raw || raw === normalized) return

    const rawRestRot = this.rawRestRotations.get(boneName)
    const rawRestPos = this.rawRestPositions.get(boneName)
    if (rawRestRot) {
      raw.quaternion.copy(rawRestRot)
    }
    if (rawRestPos) {
      raw.position.copy(rawRestPos)
    }
  }

  private neutralizeMotionGazeBones() {
    this.resetGazeBoneToRest(VRMHumanBoneName.Neck)
    this.resetGazeBoneToRest(VRMHumanBoneName.Head)
    this.resetGazeBoneToRest(VRMHumanBoneName.LeftEye)
    this.resetGazeBoneToRest(VRMHumanBoneName.RightEye)
  }

  private applyFallbackPose() {
    const posture = this.baseLoopPosture
    const upperArmAngle = posture === 'lay' ? 0.08 : posture === 'sit' ? 0.12 : 0.18
    const lowerArmAngle = posture === 'lay' ? 0.04 : posture === 'sit' ? 0.06 : 0.1

    const leftUpperArm = this.bones[VRMHumanBoneName.LeftUpperArm]
    const rightUpperArm = this.bones[VRMHumanBoneName.RightUpperArm]
    const leftLowerArm = this.bones[VRMHumanBoneName.LeftLowerArm]
    const rightLowerArm = this.bones[VRMHumanBoneName.RightLowerArm]

    if (leftUpperArm) leftUpperArm.rotation.z -= upperArmAngle
    if (rightUpperArm) rightUpperArm.rotation.z += upperArmAngle
    if (leftLowerArm) leftLowerArm.rotation.z -= lowerArmAngle
    if (rightLowerArm) rightLowerArm.rotation.z += lowerArmAngle
  }

  private applyAuthoringPaintPose() {
    this.applyRestPose()

    const leftUpperArm = this.bones[VRMHumanBoneName.LeftUpperArm]
    const rightUpperArm = this.bones[VRMHumanBoneName.RightUpperArm]
    const leftLowerArm = this.bones[VRMHumanBoneName.LeftLowerArm]
    const rightLowerArm = this.bones[VRMHumanBoneName.RightLowerArm]

    if (leftUpperArm) leftUpperArm.rotation.z -= 1.2
    if (rightUpperArm) rightUpperArm.rotation.z += 1.2
    if (leftLowerArm) leftLowerArm.rotation.z -= 0.08
    if (rightLowerArm) rightLowerArm.rotation.z += 0.08
  }

  private resolveFallbackPoseClip() {
    const posture = this.baseLoopPosture
    const candidates =
      posture === 'sit'
        ? ['base_sit_pose', 'pose_sit', 'sit_pose', 'base_sit']
        : posture === 'lay'
          ? ['base_lay_pose', 'pose_lay', 'lay_pose', 'base_lay']
          : ['base_stand_pose', 'pose_stand', 'stand_pose', 'base_stand']

    for (const name of candidates) {
      const clip = this.animationMap.get(name)
      if (clip) {
        return { name, clip }
      }
    }

    return null
  }

  private applyPose(elapsed: number) {
    if (!this.vrm) return
    const manager = this.vrm.expressionManager
    const now = performance.now()

    if (this.authoringPoseMode) {
      if (!this.authoringPoseAction) {
        this.applyAuthoringPaintPose()
      }
      if (manager) {
        manager.resetValues()
      }
      return
    }

    const usingOverride = this.animationOverrideActive
    const hasBaseLoop = Boolean(this.baseLoopAction)
    const allowProcedural = !usingOverride && (!hasBaseLoop || this.baseLoopIsFallback)

    if (allowProcedural) {
      if (!hasBaseLoop) {
        this.applyRestPose()
        this.applyFallbackPose()
      }
      this.applyBaseLoop(elapsed)
      this.applyIdleMotion(elapsed)

      if (this.speaking) {
        this.applySpeakingMotion(elapsed)
      }

    }

    if (manager) {
      this.updateMoodFaceBlend(now)
      manager.resetValues()
      this.applyExpressions(manager)
      this.applyLipSync(manager, elapsed)
    }
  }

  private applyCustomPerformance(elapsed: number) {
    if (this.faceMorphBindings.length === 0 && !this.customPerformanceRigRuntime) return

    const now = performance.now()
    this.updateMoodFaceBlend(now)

    const expressionWeights = this.buildCustomExpressionWeights(now)
    const directionExpressionTargets = [...expressionWeights].map(([preset, weight]) => ({
      preset,
      weight
    }))
    this.applyCustomAmbientBlink(expressionWeights, now)
    const faceControls = this.collectCustomFaceControls(now)
    const faceControlWeights = this.buildCustomFaceControlWeights(faceControls)
    for (const [preset, value] of resolveFaceControlEyeLookPresetWeights(faceControls)) {
      expressionWeights.set(
        preset as GoonExpressionPreset,
        Math.max(expressionWeights.get(preset as GoonExpressionPreset) ?? 0, value)
      )
    }

    const fullStrengthLipSyncFrame = this.resolveCurrentLipSyncFrame(elapsed, 1)
    const directArkitFaceDriverWeights = this.customArkitFaceDriverBindings
      ? resolveDirectCustomArkitFaceDriverWeights(
          fullStrengthLipSyncFrame,
          this.customArkitFaceDriverBindings
        )
      : null

    if (this.hasMouthBlendshapes && !directArkitFaceDriverWeights) {
      const lipSyncFrame =
        this.lipSyncMode === 'viseme' && this.speechLipSyncTimeline
          ? scaleGoonSpeechFaceFrame(
              fullStrengthLipSyncFrame,
              PRECOMPUTED_LIP_SYNC_CUSTOM_INTENSITY_SCALE
            )
          : fullStrengthLipSyncFrame
      for (const [preset, value] of resolveCustomLipSyncPresetWeights(
        lipSyncFrame,
        this.customMouthPresetSupport
      )) {
        const current = expressionWeights.get(preset) ?? 0
        expressionWeights.set(preset, Math.max(current, value))
      }
    }

    const rawMorphWeights = resolveRawMorphTargets(this.collectCustomRawMorphTargets(now))
    const finalRawMorphWeights = new Map(directArkitFaceDriverWeights ?? [])
    for (const [targetName, value] of rawMorphWeights) {
      finalRawMorphWeights.set(targetName, value)
    }
    const authoredPerformanceDirection = resolveCustomPerformanceDirection({
      expressionTargets: directionExpressionTargets,
      faceControls,
      rawTargetWeights: finalRawMorphWeights
    })
    this.customPerformanceDirection = authoredPerformanceDirection
    if (this.customPerformanceRigRuntime && this.customAvatarRoot) {
      if (this.customPerformanceRigRuntime.usesSocketEyeDriver()) {
        // The socket path owns eye projection and head follow in the overlay
        // phase. Never route it through the shared globe/bone Eye Contact
        // solver or synthesize Look* expression morphs.
        this.eyeContactApplied = resolveCustomPerformanceEyeContactState(
          authoredPerformanceDirection
        )
      } else {
        const authoredEyeContact = resolveCustomPerformanceEyeContactState(
          authoredPerformanceDirection
        )
        const suppressCameraContact =
          this.isStaticPoseOverrideActive() || this.lookActive
        const eyeContactActiveForMotion =
          this.eyeContactEnabled && !this.isEyeContactSuppressedByMotion()

        if (suppressCameraContact) {
          this.eyeContactApplied = { ...authoredEyeContact }
        } else {
          if (eyeContactActiveForMotion) {
            this.customPerformanceRigRuntime.neutralizeMotionLookNodes()
          }
          this.applyEyeContact({
            ...authoredEyeContact,
            authoredEyeOverride: hasCustomPerformanceAuthoredEyeDirection(
              authoredPerformanceDirection
            ),
            enabled: eyeContactActiveForMotion
          })
        }

        if (this.eyeLookFreezeHeadEnabled) {
          this.eyeContactApplied.headYaw = 0
          this.eyeContactApplied.headPitch = 0
        }

        const ambientEyeYaw =
          this.eyeContactApplied.eyeYaw - authoredEyeContact.eyeYaw
        const ambientEyePitch =
          this.eyeContactApplied.eyePitch - authoredEyeContact.eyePitch
        const ambientEyeLookWeights = resolveEyeLookExpressionWeights(
          ambientEyeYaw,
          ambientEyePitch,
          this.eyeContactTuning
        )
        this.mergeExpressionWeight(
          expressionWeights,
          VRMExpressionPresetName.LookLeft,
          ambientEyeLookWeights.lookLeft
        )
        this.mergeExpressionWeight(
          expressionWeights,
          VRMExpressionPresetName.LookRight,
          ambientEyeLookWeights.lookRight
        )
        this.mergeExpressionWeight(
          expressionWeights,
          VRMExpressionPresetName.LookUp,
          ambientEyeLookWeights.lookUp
        )
        this.mergeExpressionWeight(
          expressionWeights,
          VRMExpressionPresetName.LookDown,
          ambientEyeLookWeights.lookDown
        )
        this.customPerformanceDirection = composeCustomPerformanceEyeContact(
          authoredPerformanceDirection,
          this.eyeContactApplied,
          {
            eyeYaw: this.eyeContactTuning.eyeYawRange,
            eyePitch: this.eyeContactTuning.eyePitchRange,
            headYaw: this.eyeContactTuning.headYawRange,
            headPitch: this.eyeContactTuning.headPitchRange
          }
        )
      }
    }
    const resolvedCustomTargetWeights = resolveFinalCustomTargetWeights({
      expressionWeights,
      expressionBindings: this.customExpressionMorphMap,
      faceControlWeights,
      rawTargetWeights: finalRawMorphWeights
    })
    this.customPerformanceTargetWeights = this.eyeApertureSeamDefinition
      ? resolveSocketEyeBlinkClosureTargetWeights(
          resolvedCustomTargetWeights,
          this.eyeApertureSeamDefinition.blinkClosure.fullBlinkSquintFloor
        )
      : resolvedCustomTargetWeights
    const clearTargets = new Set<string>(this.lastAppliedRawMorphTargets)

    for (const bindings of this.customExpressionMorphMap.values()) {
      for (const binding of bindings) {
        clearTargets.add(binding.target)
      }
    }
    for (const targetName of finalRawMorphWeights.keys()) {
      clearTargets.add(targetName)
    }
    if (this.eyeApertureSeamDefinition) {
      clearTargets.add('eyeSquintLeft')
      clearTargets.add('eyeSquintRight')
    }

    if (
      clearTargets.size === 0 &&
      expressionWeights.size === 0 &&
      faceControlWeights.size === 0 &&
      finalRawMorphWeights.size === 0
    ) {
      return
    }

    this.clearMorphTargetWeights(clearTargets)

    const appliedTargets = new Set<string>()
    for (const [preset, value] of expressionWeights.entries()) {
      if (value <= 0.001) continue
      const bindings = this.customExpressionMorphMap.get(preset)
      if (!bindings) continue
      for (const binding of bindings) {
        this.applyMorphTargetWeight(binding.target, value * binding.weight, 'max')
        appliedTargets.add(binding.target)
      }
    }

    for (const [targetName, value] of faceControlWeights.entries()) {
      if (value <= 0.001) continue
      this.applyMorphTargetWeight(targetName, value, 'max')
      appliedTargets.add(targetName)
    }

    for (const [targetName, value] of finalRawMorphWeights.entries()) {
      this.applyMorphTargetWeight(targetName, value, 'set')
      appliedTargets.add(targetName)
    }
    if (this.eyeApertureSeamDefinition) {
      for (const targetName of ['eyeSquintLeft', 'eyeSquintRight'] as const) {
        const value = this.customPerformanceTargetWeights.get(targetName) ?? 0
        this.applyMorphTargetWeight(targetName, value, 'set')
        if (value > 0.001) appliedTargets.add(targetName)
      }
    }

    this.lastAppliedRawMorphTargets = [...appliedTargets]
  }

  private applyCustomPerformanceOverlays() {
    const performance = this.customPerformanceRigRuntime
    if (!performance || !this.customAvatarRoot) return
    const socketEyes = this.socketEyeSurfaceRuntime
    const socketDefinition = this.socketEyeSurfaceDefinition
    if (!performance.usesSocketEyeDriver()) {
      performance.apply(this.customPerformanceDirection, this.customPerformanceTargetWeights)
      return
    }
    if (!socketEyes || !socketDefinition) {
      throw new Error(
        '[socket-eye-runtime] performance-rig/v2 is active without the required socket-eye surface.'
      )
    }

    const contactAllowed =
      this.socketEyeContact.enabled &&
      this.eyeContactEnabled &&
      !this.isStaticPoseOverrideActive() &&
      !this.lookActive &&
      !this.isEyeContactSuppressedByMotion()
    const authored = { ...this.customPerformanceDirection }
    performance.apply(authored, this.customPerformanceTargetWeights)
    this.customAvatarRoot.updateMatrixWorld(true)

    const head = performance.getLookNode('head')
    let targetHeadLocal = head.worldToLocal(this.camera.position.clone())
    let resolution = resolveSocketEyeGaze(
      socketDefinition,
      [targetHeadLocal.x, targetHeadLocal.y, targetHeadLocal.z],
      authored,
      this.socketEyeContact,
      contactAllowed
    )
    const response = socketEyeContactResponseLerp(this.socketEyeContact.response)
    const headAssistTarget =
      !this.eyeLookFreezeHeadEnabled &&
      contactAllowed &&
      resolution.headFollowPressure > 0
        ? resolveSocketEyeHeadAssist(
            [targetHeadLocal.x, targetHeadLocal.y, targetHeadLocal.z],
            resolution.headFollowPressure,
            this.socketEyeContact.headFollow
          )
        : { headYaw: 0, headPitch: 0 }
    this.socketEyeHeadAssist = smoothSocketEyeHeadAssist(
      this.socketEyeHeadAssist,
      headAssistTarget,
      response
    )
    if (
      Math.abs(this.socketEyeHeadAssist.headYaw) > 1e-5 ||
      Math.abs(this.socketEyeHeadAssist.headPitch) > 1e-5
    ) {
      const assisted = {
        ...authored,
        headYaw: THREE.MathUtils.clamp(
          authored.headYaw + this.socketEyeHeadAssist.headYaw,
          -1,
          1
        ),
        headPitch: THREE.MathUtils.clamp(
          authored.headPitch + this.socketEyeHeadAssist.headPitch,
          -1,
          1
        )
      }
      if (this.eyeLookFreezeHeadEnabled) {
        assisted.headYaw = authored.headYaw
        assisted.headPitch = authored.headPitch
      }
      performance.apply(assisted, this.customPerformanceTargetWeights)
      this.customAvatarRoot.updateMatrixWorld(true)
      targetHeadLocal = head.worldToLocal(this.camera.position.clone())
      resolution = resolveSocketEyeGaze(
        socketDefinition,
        [targetHeadLocal.x, targetHeadLocal.y, targetHeadLocal.z],
        authored,
        this.socketEyeContact,
        contactAllowed
      )
    }

    for (const side of ['left', 'right'] as const) {
      const target = resolution.gaze[side]
      const current = this.socketEyeGaze[side]
      current.horizontal = THREE.MathUtils.lerp(current.horizontal, target.horizontal, response)
      current.vertical = THREE.MathUtils.lerp(current.vertical, target.vertical, response)
      socketEyes.setGaze(side, current.horizontal, current.vertical)
    }
    const lookWeights = resolveSocketEyeLookTargetWeights(
      socketDefinition,
      this.socketEyeGaze
    )
    this.clearMorphTargetWeights(SOCKET_EYE_LOOK_TARGETS)
    for (const target of SOCKET_EYE_LOOK_TARGETS) {
      this.applyMorphTargetWeight(target, lookWeights.get(target) ?? 0, 'set')
    }
  }

  private buildCustomExpressionWeights(now: number) {
    this.activeExpressions = this.activeExpressions.filter((exp) => exp.endsAt > now)
    const weights = new Map<GoonExpressionPreset, number>()
    const moodFaceBlend = this.moodFaceBlend

    const pushTarget = (
      preset: GoonExpressionPreset | undefined,
      value: number,
      mode: 'sum' | 'max' = 'max'
    ) => {
      if (!preset) return
      if (
        !shouldApplyCustomExpressionMorphPreset(
          preset,
          Boolean(this.customPerformanceRigRuntime)
        )
      ) {
        return
      }
      const current = weights.get(preset) ?? 0
      weights.set(preset, mode === 'sum' ? current + value : Math.max(current, value))
    }

    if (moodFaceBlend > 0.001 && this.moodExpressionTargets.length > 0) {
      for (const target of this.moodExpressionTargets) {
        pushTarget(
          target.preset as GoonExpressionPreset,
          target.weight * this.moodExpressionIntensity * moodFaceBlend,
          'sum'
        )
      }
    }

    for (const exp of this.activeExpressions) {
      if (exp.steps && exp.steps.length > 0) {
        const stepElapsed = now - exp.stepStartTime
        const step = exp.steps[exp.currentStep]
        if (step) {
          const stepDuration = step.attackMs + step.holdMs + step.releaseMs
          if (stepElapsed >= stepDuration && exp.currentStep < exp.steps.length - 1) {
            exp.currentStep += 1
            exp.stepStartTime = now
          }
        }
      }

      let currentTargets: Array<{ preset: ResolvedExpressionPreset; weight: number }>
      let envelope: number

      if (exp.steps && exp.steps.length > 0) {
        const step = exp.steps[exp.currentStep]
        if (!step) continue
        const stepElapsed = now - exp.stepStartTime
        envelope = this.computeStepEnvelope(stepElapsed, step, exp.easing)
        currentTargets = step.targets
      } else {
        const elapsed = now - exp.startTime
        envelope = this.computeEnvelope(
          elapsed,
          exp.attackMs,
          exp.holdMs,
          exp.releaseMs,
          exp.easing
        )
        currentTargets = exp.targets
      }

      for (const target of currentTargets) {
        pushTarget(
          target.preset as GoonExpressionPreset,
          target.weight * exp.intensity * envelope,
          'max'
        )
      }
    }

    if (this.authoringPreviewExpressionTargets.length > 0) {
      for (const target of this.authoringPreviewExpressionTargets) {
        pushTarget(
          target.preset as GoonExpressionPreset,
          target.weight * this.authoringPreviewIntensity,
          'max'
        )
      }
    }

    return weights
  }

  private collectCustomFaceControls(now: number) {
    const allControls: GoonFaceControl[] = []
    const moodFaceBlend = this.moodFaceBlend
    let authoredEyeYaw = 0
    let authoredEyePitch = 0

    const pushFaceControl = (fc: GoonFaceControl, intensity: number) => {
      const adjusted = resolveSpeakingFaceControl(
        {
          control: fc.control,
          value: fc.value * intensity
        },
        {
          speaking: this.speaking,
          pausedForCue: this.speechPausedForCue
        }
      )
      if (!adjusted) return
      allControls.push(adjusted)
      if (adjusted.control === 'eyes_leftright') {
        authoredEyeYaw -= adjusted.value
      } else if (adjusted.control === 'eyes_updown') {
        authoredEyePitch -= adjusted.value
      }
    }

    if (moodFaceBlend > 0.001) {
      for (const fc of this.moodFaceControls) {
        pushFaceControl(fc, this.moodExpressionIntensity * moodFaceBlend)
      }
    }

    for (const fc of this.authoringPreviewFaceControls) {
      pushFaceControl(fc, this.authoringPreviewIntensity)
    }

    for (const exp of this.activeExpressions) {
      const activeControls = this.resolveActiveExpressionFaceControls(exp, now)
      for (const fc of activeControls) {
        pushFaceControl(fc, exp.intensity)
      }
    }

    const manager = this.vrm?.expressionManager
    const eyeLookLane = manager ? this.resolveEyeLookRuntimeLane(manager) : 'none'
    if (eyeLookLane === 'expression-guided-controls') {
      const ambientEyeYaw =
        (this.eyeContactApplied.eyeYaw - authoredEyeYaw) * this.eyeContactTuning.eyeYawRange
      const ambientEyePitch =
        (this.eyeContactApplied.eyePitch - authoredEyePitch) * this.eyeContactTuning.eyePitchRange

      if (Math.abs(ambientEyeYaw) > 0.001 && this.hasCustomDirectionControlBinding('eyes_leftright')) {
        allControls.push({
          control: 'eyes_leftright',
          value: -ambientEyeYaw
        })
      }

      if (Math.abs(ambientEyePitch) > 0.001 && this.hasCustomDirectionControlBinding('eyes_updown')) {
        allControls.push({
          control: 'eyes_updown',
          value: -ambientEyePitch
        })
      }
    }

    if (allControls.length === 0) {
      return []
    }

    return allControls
  }

  private buildCustomFaceControlWeights(faceControls: readonly GoonFaceControl[]) {
    if (!this.customFaceControlMap || faceControls.length === 0) {
      return new Map<string, number>()
    }
    return resolveMappedFaceControls([...faceControls], this.customFaceControlMap, {
      includeDirectionControls: true
    })
  }

  private hasCustomDirectionControlBinding(controlId: 'eyes_leftright' | 'eyes_updown') {
    const binding = this.customFaceControlMap?.[controlId]
    if (!binding) return false
    return binding.positive.length > 0 || (binding.negative?.length ?? 0) > 0
  }

  private hasGuidedEyeDirectionControls() {
    return (
      this.hasCustomDirectionControlBinding('eyes_leftright') ||
      this.hasCustomDirectionControlBinding('eyes_updown')
    )
  }

  private collectCustomRawMorphTargets(now: number) {
    const rawMorphTargets: GoonRawMorphTarget[] = []
    const moodFaceBlend = this.moodFaceBlend

    if (moodFaceBlend > 0.001) {
      for (const rawMorph of this.moodRawMorphTargets) {
        rawMorphTargets.push({
          target: rawMorph.target,
          value: rawMorph.value * this.moodExpressionIntensity * moodFaceBlend
        })
      }
    }

    for (const rawMorph of this.authoringPreviewRawMorphTargets) {
      rawMorphTargets.push({
        target: rawMorph.target,
        value: rawMorph.value * this.authoringPreviewIntensity
      })
    }

    for (const exp of this.activeExpressions) {
      const activeRawMorphs = this.resolveActiveExpressionRawMorphTargets(exp, now)
      for (const rawMorph of activeRawMorphs) {
        rawMorphTargets.push({
          target: rawMorph.target,
          value: rawMorph.value * exp.intensity
        })
      }
    }

    return rawMorphTargets
  }

  private clearMorphTargetWeights(targetNames: Iterable<string>) {
    for (const binding of this.faceMorphBindings) {
      const influences = binding.mesh.morphTargetInfluences
      if (!Array.isArray(influences)) continue
      for (const targetName of targetNames) {
        // The active appearance contract owns its identity/corrective
        // targets; the face pass must not zero persistent dial-driven morphs.
        if (
          this.bodyDialsOwnedTargets.has(targetName) ||
          this.appearanceDialsOwnedTargets.has(targetName)
        ) continue
        const index = binding.dict[targetName]
        if (index === undefined) continue
        influences[index] = 0
      }
    }
  }

  private applyMorphTargetWeight(targetName: string, value: number, mode: 'set' | 'max') {
    if (
      this.bodyDialsOwnedTargets.has(targetName) ||
      this.appearanceDialsOwnedTargets.has(targetName)
    ) {
      if (!this.bodyDialsRawMorphWarned.has(targetName)) {
        this.bodyDialsRawMorphWarned.add(targetName)
        logger.warn(
          `[GoonEngine] morph target "${targetName}" is owned by the appearance system; ` +
            'cue/raw-morph writes to it are ignored'
        )
      }
      return
    }
    const clamped = THREE.MathUtils.clamp(value, 0, 1)
    for (const binding of this.faceMorphBindings) {
      const influences = binding.mesh.morphTargetInfluences
      if (!Array.isArray(influences)) continue
      const index = binding.dict[targetName]
      if (index === undefined) continue
      influences[index] = mode === 'max' ? Math.max(influences[index] ?? 0, clamped) : clamped
    }
  }

  private applyCustomAmbientBlink(weights: Map<GoonExpressionPreset, number>, now: number) {
    const authoredBlinkWeight = Math.max(
      weights.get(VRMExpressionPresetName.Blink) ?? 0,
      weights.get(VRMExpressionPresetName.BlinkLeft) ?? 0,
      weights.get(VRMExpressionPresetName.BlinkRight) ?? 0
    )
    const eyelidsValue = Math.min(
      getEyelidsValue(this.moodFaceControls),
      getEyelidsValue(this.authoringPreviewFaceControls),
      ...this.activeExpressions.map((exp) =>
        getEyelidsValue(this.resolveActiveExpressionFaceControls(exp, now))
      )
    )
    const canBlink =
      authoredBlinkWeight < AMBIENT_BLINK_SUPPRESS_THRESHOLD &&
      eyelidsValue > -AMBIENT_BLINK_SUPPRESS_THRESHOLD
    const next = updateAmbientBlinkState(this.ambientBlinkState, now, { canBlink })
    this.ambientBlinkState = next.state
    if (next.weight <= 0.001) return

    const blinkPresets: GoonExpressionPreset[] = []
    if (this.customExpressionMorphMap.has(VRMExpressionPresetName.Blink)) {
      blinkPresets.push(VRMExpressionPresetName.Blink)
    } else {
      if (this.customExpressionMorphMap.has(VRMExpressionPresetName.BlinkLeft)) {
        blinkPresets.push(VRMExpressionPresetName.BlinkLeft)
      }
      if (this.customExpressionMorphMap.has(VRMExpressionPresetName.BlinkRight)) {
        blinkPresets.push(VRMExpressionPresetName.BlinkRight)
      }
    }

    for (const preset of blinkPresets) {
      const current = weights.get(preset) ?? 0
      weights.set(preset, Math.max(current, next.weight))
    }
  }

  private stabilizeRootLateralMotion() {
    if (!this.vrm) return
    if (!this.hasMarkerAnchor) return

    const targetX = this.markerAnchor.x + this.panOffset.x
    const targetZ = this.markerAnchor.z + this.panOffset.z
    const driftX = this.vrm.scene.position.x - targetX
    const driftZ = this.vrm.scene.position.z - targetZ
    const drift = Math.hypot(driftX, driftZ)
    if (drift <= 0.0001) return

    this.vrm.scene.position.x = targetX
    this.vrm.scene.position.z = targetZ

    if (!this.debugRootMotionEnabled) return
    const now = performance.now()
    if (now - this.lastRootMotionDriftLogAt < this.rootMotionDriftLogIntervalMs) return
    this.lastRootMotionDriftLogAt = now
    this.logRootMotionDebug('RuntimeCorrection', {
      baseLoop: this.baseLoop,
      baseLoopAnimation: this.baseLoopAnimationName,
      posture: this.baseLoopPosture,
      markerAnchor: {
        x: Number(this.markerAnchor.x.toFixed(4)),
        y: Number(this.markerAnchor.y.toFixed(4)),
        z: Number(this.markerAnchor.z.toFixed(4))
      },
      panOffset: {
        x: Number(this.panOffset.x.toFixed(4)),
        y: Number(this.panOffset.y.toFixed(4)),
        z: Number(this.panOffset.z.toFixed(4))
      },
      drift: Number(drift.toFixed(6))
    })
  }

  private applyBaseLoop(_elapsed: number) {
    const hips = this.bones[VRMHumanBoneName.Hips]
    if (!hips) return
    if (this.baseLoop === 'base_sit') {
      hips.position.y -= 0.2
      hips.position.z += 0.05
    }
  }

  private syncBaseLoopAnimation() {
    if (!this.mixer) return
    const animationName = this.baseLoopAnimationName ?? this.baseLoop
    let animationClip = this.animationMap.get(animationName)
    let usingFallback = false
    if (!animationClip) {
      const fallback = this.resolveFallbackPoseClip()
      if (fallback) {
        animationClip = fallback.clip
        usingFallback = true
      }
    }
    if (!animationClip) {
      this.baseLoopAction?.fadeOut(0.2)
      this.baseLoopAction = null
      this.baseLoopIsFallback = false
      return
    }

    const action = this.mixer.clipAction(animationClip)
    const currentClip =
      this.baseLoopAction && typeof this.baseLoopAction.getClip === 'function'
        ? this.baseLoopAction.getClip()
        : null
    if (this.baseLoopAction === action && currentClip === animationClip && this.baseLoopIsFallback === usingFallback) {
      this.baseLoopAction.enabled = true
      this.baseLoopAction.play()
      this.normalizeActionPlayback(this.baseLoopAction)
      return
    }

    action.reset()
    this.resetPlaybackRates(action)
    const isPose = this.isStaticPoseClip(animationClip)
    if (usingFallback || isPose) {
      action.setLoop(THREE.LoopOnce, 1)
      action.clampWhenFinished = true
    } else {
      action.setLoop(THREE.LoopRepeat, Infinity)
      action.clampWhenFinished = false
    }
    action.enabled = true
    if (isPose) {
      this.holdStaticPoseAction(action)
    } else {
      action.fadeIn(0.2)
      action.play()
    }

    if (this.baseLoopAction && this.baseLoopAction !== action) {
      this.baseLoopAction.fadeOut(0.2)
    }

    this.baseLoopAction = action
    this.baseLoopIsFallback = usingFallback
    this.logRootMotionDebug('BaseLoopSynced', {
      requested: animationName,
      resolved: animationClip.name,
      usingFallback
    })
  }

  private applyIdleMotion(elapsed: number) {
    const spine = this.bones[VRMHumanBoneName.Spine]
    const chest = this.bones[VRMHumanBoneName.UpperChest] || this.bones[VRMHumanBoneName.Chest]
    if (spine) spine.rotation.x += Math.sin(elapsed * 0.6) * 0.02
    if (chest) chest.rotation.x += Math.sin(elapsed * 0.6 + 1) * 0.015
  }

  private applySpeakingMotion(elapsed: number) {
    const head = this.bones[VRMHumanBoneName.Head]
    const neck = this.bones[VRMHumanBoneName.Neck]
    if (head) head.rotation.x += Math.sin(elapsed * 3.2) * 0.05
    if (neck) neck.rotation.y += Math.sin(elapsed * 2.1) * 0.03
  }

  private triggerExpression(name: string, definition?: GoonCueDefinition) {
    if (!this.hasExpressionBlendshapes && !this.hasFaceControls() && !this.hasRawMorphTargets()) return
    const kind = definition?.kind ?? 'emote'
    const intensity = definition?.kind === 'emote' ? 1 : definition?.intensity ?? 1
    const targets = this.resolveExpressionTargets(name, definition)
    const faceControls = definition?.faceControls ?? []
    const rawMorphTargets = definition?.rawMorphTargets ?? []
    if (
      targets.length === 0 &&
      faceControls.length === 0 &&
      rawMorphTargets.length === 0 &&
      !definition?.steps?.length
    )
      return
    const now = performance.now()
    const easing = definition?.easing ?? 'linear'

    // Check for multi-step emote
    if (definition?.steps && definition.steps.length > 0) {
      const steps: ActiveExpressionStep[] = definition.steps.map((step) => ({
        targets: this.resolveExpressionTargets(name, {
          ...definition,
          expressionTargets: step.expressionTargets
        }),
        faceControls: step.faceControls ?? [],
        rawMorphTargets: step.rawMorphTargets ?? [],
        attackMs: step.attackMs ?? 120,
        holdMs: step.holdMs ?? 200,
        releaseMs: step.releaseMs ?? 180
      }))

      const totalDuration = steps.reduce(
        (sum, s) => sum + s.attackMs + s.holdMs + s.releaseMs,
        0
      )

      this.activeExpressions = this.activeExpressions.filter((exp) => exp.name !== name)
      this.activeExpressions.push({
        name,
        kind,
        intensity,
        endsAt: now + totalDuration,
        targets: steps[0]?.targets ?? [],
        faceControls: steps[0]?.faceControls ?? [],
        rawMorphTargets: steps[0]?.rawMorphTargets ?? [],
        startTime: now,
        attackMs: steps[0]?.attackMs ?? 0,
        holdMs: steps[0]?.holdMs ?? 0,
        releaseMs: steps[0]?.releaseMs ?? 0,
        easing,
        steps,
        currentStep: 0,
        stepStartTime: now
      })
      return
    }

    // Single-step expression (existing behavior + face controls)
    const hasEnvelope =
      definition?.attackMs !== undefined ||
      definition?.holdMs !== undefined ||
      definition?.releaseMs !== undefined

    let attackMs = 0
    let holdMs = 0
    let releaseMs = 0

    if (hasEnvelope) {
      attackMs = definition?.attackMs ?? 120
      releaseMs = definition?.releaseMs ?? 180
      const providedHold = definition?.holdMs
      if (typeof providedHold === 'number') {
        holdMs = providedHold
      } else if (definition?.durationMs) {
        holdMs = Math.max(0, definition.durationMs - attackMs - releaseMs)
      } else {
        holdMs = 200
      }
    } else {
      const durationMs = definition?.durationMs ?? 800
      attackMs = 0
      releaseMs = 0
      holdMs = durationMs
    }

    const endsAt = now + attackMs + holdMs + releaseMs
    this.activeExpressions = this.activeExpressions.filter((exp) => exp.name !== name)
    this.activeExpressions.push({
      name,
      kind,
      intensity,
      endsAt,
      targets,
      faceControls,
      rawMorphTargets,
      startTime: now,
      attackMs,
      holdMs,
      releaseMs,
      easing,
      currentStep: 0,
      stepStartTime: now
    })
  }

  private playEmote(name: string, definition?: GoonCueDefinition) {
    this.activeEmoteUntil = Math.max(
      this.activeEmoteUntil,
      performance.now() + this.estimateCueDurationMs(name, definition)
    )
    this.triggerExpression(name, definition)
  }

  private estimateExpressionDurationMs(definition?: GoonCueDefinition) {
    if (!definition) return 0
    if (definition.steps && definition.steps.length > 0) {
      return definition.steps.reduce(
        (sum, step) =>
          sum +
          (step.attackMs ?? 120) +
          (step.holdMs ?? 200) +
          (step.releaseMs ?? 180),
        0
      )
    }

    const hasFacePayload = Boolean(
      definition.expressionTargets?.length ||
      definition.faceControls?.length ||
      definition.rawMorphTargets?.length
    )
    if (!hasFacePayload) {
      return definition.durationMs ?? 0
    }

    const hasEnvelope =
      definition.attackMs !== undefined ||
      definition.holdMs !== undefined ||
      definition.releaseMs !== undefined

    if (!hasEnvelope) {
      return definition.durationMs ?? 800
    }

    const attackMs = definition.attackMs ?? 120
    const releaseMs = definition.releaseMs ?? 180
    const holdMs =
      typeof definition.holdMs === 'number'
        ? definition.holdMs
        : definition.durationMs
          ? Math.max(0, definition.durationMs - attackMs - releaseMs)
          : 200

    return attackMs + holdMs + releaseMs
  }

  private playOneShotAnimation(name: string) {
    if (!this.mixer) return false
    const animationClip = this.animationMap.get(name)
    if (!animationClip) return false

    const isPose = this.isStaticPoseClip(animationClip)

    if (this.baseLoopAction) {
      if (isPose) {
        this.baseLoopAction.stop()
      } else {
        this.baseLoopAction.enabled = true
        this.baseLoopAction.play()
      }
    }

    if (this.oneShotAction) {
      this.oneShotAction.stop()
    }

    const action = this.mixer.clipAction(animationClip)
    action.reset()
    this.resetPlaybackRates(action)
    action.enabled = true
    if (isPose) {
      this.holdStaticPoseAction(action)
    } else {
      action.setLoop(THREE.LoopOnce, 1)
      action.clampWhenFinished = true
      action.fadeIn(0.15)
      if (this.baseLoopAction) {
        action.crossFadeFrom(this.baseLoopAction, 0.15, true)
      }
      action.play()
    }

    this.oneShotAction = action
    this.animationOverrideActive = true
    this.logRootMotionDebug('OneShotPlayed', {
      name: animationClip.name,
      isPose,
      durationSec: Number(animationClip.duration.toFixed(3))
    })
    return true
  }

  private lookupAnimationDurationMs(name: string): number | null {
    const clip = this.animationMap.get(name)
    if (!clip || !Number.isFinite(clip.duration)) return null
    return Math.max(200, Math.round(clip.duration * 1000))
  }

  private handleAnimationFinished = (event: any) => {
    if (event?.action !== this.oneShotAction) return
    this.animationOverrideActive = false
    this.animationOverridePosture = null
    this.resetPlaybackRates()
    if (this.oneShotRestorePosture) {
      this.transitionToPosture(this.oneShotRestorePosture, undefined, undefined, {
        preserveCamera: this.oneShotRestorePreserveCamera
      })
      this.oneShotRestorePosture = null
    }
    this.oneShotRestorePreserveCamera = false
    if (this.baseLoopAction) {
      this.baseLoopAction.enabled = true
      this.baseLoopAction.fadeIn(0.2)
      this.baseLoopAction.play()
    }
    this.oneShotAction?.stop()
    this.oneShotAction = null
    if (!this.baseLoopAction) {
      this.syncBaseLoopAnimation()
    }
  }

  private applyExpressions(manager: NonNullable<VRM['expressionManager']>) {
    const now = performance.now()
    this.activeExpressions = this.activeExpressions.filter((exp) => exp.endsAt > now)
    const moodFaceBlend = this.moodFaceBlend
    const weights = new Map<ResolvedExpressionPreset, number>()
    const look: DirectionLookState = {
      headYaw: 0,
      headPitch: 0,
      eyeYaw: 0,
      eyePitch: 0
    }
    const lookAt = this.vrm?.lookAt
    const eyeLookLane = this.resolveEyeLookRuntimeLane(manager)
    const canApplyLookAt = lookAt ? this.canApplyLookAt(lookAt, manager) : false

    // Resolve mood direction face controls into headYaw/headPitch/eyeYaw/eyePitch.
    // Convention matches existing expression system: negative slider = left/down, positive = right/up.
    // head_leftright: -1=left → headYaw+1, +1=right → headYaw-1 → headYaw -= v
    // head_updown: +1=up → headPitch-1, -1=down → headPitch+1 → headPitch -= v
    // (same pattern for eyes)
    if (moodFaceBlend > 0.001) {
      for (const fc of this.moodFaceControls) {
        const v = fc.value * this.moodExpressionIntensity * moodFaceBlend
        applyFaceControlDirection(look, fc.control, v)
      }
    }

    if (moodFaceBlend > 0.001 && this.moodExpressionTargets.length > 0) {
      for (const target of this.moodExpressionTargets) {
        const weighted = target.weight * this.moodExpressionIntensity * moodFaceBlend
        if (applyExpressionDirection(look, target.preset, weighted)) continue
        const current = weights.get(target.preset) ?? 0
        weights.set(target.preset, current + weighted)
      }
    }

    for (const exp of this.activeExpressions) {
      // Multi-step: advance steps when current step envelope completes
      if (exp.steps && exp.steps.length > 0) {
        const stepElapsed = now - exp.stepStartTime
        const step = exp.steps[exp.currentStep]
        if (step) {
          const stepDuration = step.attackMs + step.holdMs + step.releaseMs
          if (stepElapsed >= stepDuration && exp.currentStep < exp.steps.length - 1) {
            exp.currentStep++
            exp.stepStartTime = now
          }
        }
      }

      // Resolve current targets and envelope
      let currentTargets: Array<{ preset: ResolvedExpressionPreset; weight: number }>
      let envelope: number

      if (exp.steps && exp.steps.length > 0) {
        const step = exp.steps[exp.currentStep]
        if (!step) continue
        const stepElapsed = now - exp.stepStartTime
        envelope = this.computeStepEnvelope(stepElapsed, step, exp.easing)
        currentTargets = step.targets
      } else {
        const elapsed = now - exp.startTime
        const attackEnd = exp.attackMs
        const holdEnd = exp.attackMs + exp.holdMs
        envelope = 1

        if (exp.attackMs > 0 && elapsed < attackEnd) {
          envelope = this.applyEasing(elapsed / exp.attackMs, exp.easing)
        } else if (exp.releaseMs > 0 && elapsed > holdEnd) {
          const releaseElapsed = Math.min(exp.releaseMs, elapsed - holdEnd)
          envelope = 1 - this.applyEasing(releaseElapsed / exp.releaseMs, exp.easing)
        } else if (elapsed >= exp.attackMs + exp.holdMs + exp.releaseMs) {
          envelope = 0
        }
        currentTargets = exp.targets
      }

      for (const target of currentTargets) {
        const weight = target.weight * exp.intensity * envelope
        if (applyExpressionDirection(look, target.preset, weight)) continue
        const current = weights.get(target.preset) ?? 0
        weights.set(target.preset, Math.max(current, weight))
      }

      // Resolve direction face controls for this active expression
      const activeFcs = this.resolveActiveExpressionFaceControls(exp, now)
      for (const fc of activeFcs) {
        applyFaceControlDirection(look, fc.control, fc.value * exp.intensity)
      }
    }

    if (this.authoringPreviewExpressionTargets.length > 0) {
      for (const target of this.authoringPreviewExpressionTargets) {
        const weight = target.weight * this.authoringPreviewIntensity
        if (applyExpressionDirection(look, target.preset, weight)) continue
        const current = weights.get(target.preset) ?? 0
        weights.set(target.preset, Math.max(current, weight))
      }
    }

    for (const fc of this.authoringPreviewFaceControls) {
      const value = fc.value * this.authoringPreviewIntensity
      applyFaceControlDirection(look, fc.control, value)
    }

    this.applyAmbientBlink(manager, weights, now)
    let { headYaw, headPitch, eyeYaw, eyePitch } = look
    const authoredEyeOverride = Math.max(Math.abs(eyeYaw), Math.abs(eyePitch)) >= 0.05
    const freezePoseLookControls = this.isStaticPoseOverrideActive()
    if (freezePoseLookControls) {
      this.eyeContactApplied = {
        eyeYaw: 0,
        eyePitch: 0,
        headYaw: 0,
        headPitch: 0
      }
      if (lookAt) {
        this.clearLookAtOverride(lookAt)
      }
    } else {
      const eyeContactActiveForMotion = this.eyeContactEnabled && !this.isEyeContactSuppressedByMotion()
      if (eyeContactActiveForMotion) {
        this.neutralizeMotionGazeBones()
      }
      this.applyEyeContact({
        eyeYaw,
        eyePitch,
        headYaw,
        headPitch,
        authoredEyeOverride,
        enabled: eyeContactActiveForMotion
      })
    }
    eyeYaw = this.eyeContactApplied.eyeYaw
    eyePitch = this.eyeContactApplied.eyePitch
    headYaw = this.eyeContactApplied.headYaw
    headPitch = this.eyeContactApplied.headPitch
    if (this.eyeLookFreezeHeadEnabled) {
      headYaw = 0
      headPitch = 0
    }

    if (eyeLookLane === 'expression-presets') {
      const expressionWeights = resolveEyeLookExpressionWeights(eyeYaw, eyePitch, this.eyeContactTuning)
      this.mergeExpressionWeight(weights, VRMExpressionPresetName.LookLeft, expressionWeights.lookLeft)
      this.mergeExpressionWeight(weights, VRMExpressionPresetName.LookRight, expressionWeights.lookRight)
      this.mergeExpressionWeight(weights, VRMExpressionPresetName.LookUp, expressionWeights.lookUp)
      this.mergeExpressionWeight(weights, VRMExpressionPresetName.LookDown, expressionWeights.lookDown)
    }

    for (const [preset, weight] of weights.entries()) {
      if (manager.getExpression(preset as VRMExpressionPresetName | string)) {
        manager.setValue(preset as VRMExpressionPresetName | string, weight)
      }
    }

    if (this.lookActive) {
      if (lookAt) {
        this.clearLookAtOverride(lookAt)
      }
      return
    }

    if (lookAt && canApplyLookAt) {
      this.applyEyeLook(lookAt, eyeYaw, eyePitch)
    } else if (lookAt) {
      this.clearLookAtOverride(lookAt)
    }

    this.logEyeLookDebug(manager, eyeLookLane, {
      eyeYaw,
      eyePitch,
      headYaw,
      headPitch
    })

    if (Math.abs(headYaw) < 0.001 && Math.abs(headPitch) < 0.001) return
    const maxYaw = 0.72 * this.eyeContactTuning.headYawRange
    const maxPitch = (headPitch < 0 ? 1.15 : 0.63) * this.eyeContactTuning.headPitchRange
    const yaw = THREE.MathUtils.clamp(headYaw, -1, 1) * maxYaw
    const pitch = THREE.MathUtils.clamp(headPitch, -1, 1) * maxPitch
    const head = this.bones[VRMHumanBoneName.Head]
    const neck = this.bones[VRMHumanBoneName.Neck]
    if (head) {
      head.rotation.y += yaw * 0.7
      head.rotation.x += pitch * 0.7
    }
    if (neck) {
      neck.rotation.y += yaw * 0.3
      neck.rotation.x += pitch * 0.3
    }
  }

  private applyAmbientBlink(
    manager: NonNullable<VRM['expressionManager']>,
    weights: Map<ResolvedExpressionPreset, number>,
    now: number
  ) {
    const authoredBlinkWeight = Math.max(
      weights.get(VRMExpressionPresetName.Blink) ?? 0,
      weights.get(VRMExpressionPresetName.BlinkLeft) ?? 0,
      weights.get(VRMExpressionPresetName.BlinkRight) ?? 0
    )
    // Also suppress ambient blink when eyelids face control is partially closed
    const eyelidsValue = Math.min(
      getEyelidsValue(this.moodFaceControls),
      getEyelidsValue(this.authoringPreviewFaceControls),
      ...this.activeExpressions.map((exp) =>
        getEyelidsValue(this.resolveActiveExpressionFaceControls(exp, now))
      )
    )
    const canBlink =
      authoredBlinkWeight < AMBIENT_BLINK_SUPPRESS_THRESHOLD &&
      eyelidsValue > -AMBIENT_BLINK_SUPPRESS_THRESHOLD
    const next = updateAmbientBlinkState(this.ambientBlinkState, now, { canBlink })
    this.ambientBlinkState = next.state
    if (next.weight <= 0.001) return

    const blinkPresets = this.resolveAmbientBlinkPresets(manager)
    for (const preset of blinkPresets) {
      const current = weights.get(preset) ?? 0
      weights.set(preset, Math.max(current, next.weight))
    }
  }

  private resolveAmbientBlinkPresets(manager: NonNullable<VRM['expressionManager']>) {
    if (manager.getExpression(VRMExpressionPresetName.Blink)) {
      return [VRMExpressionPresetName.Blink as ResolvedExpressionPreset]
    }

    const presets: ResolvedExpressionPreset[] = []
    if (manager.getExpression(VRMExpressionPresetName.BlinkLeft)) {
      presets.push(VRMExpressionPresetName.BlinkLeft)
    }
    if (manager.getExpression(VRMExpressionPresetName.BlinkRight)) {
      presets.push(VRMExpressionPresetName.BlinkRight)
    }
    return presets
  }

  private applyEyeContact(input: {
    eyeYaw: number
    eyePitch: number
    headYaw: number
    headPitch: number
    authoredEyeOverride: boolean
    enabled: boolean
  }) {
    let eyeYaw = input.eyeYaw
    let eyePitch = input.eyePitch
    let headYaw = input.headYaw
    let headPitch = input.headPitch

    const contact = this.resolveCameraEyeContact()
    const targetBlend = input.enabled ? (contact?.amount ?? 0) : 0
    this.eyeContactBlend = THREE.MathUtils.lerp(
      this.eyeContactBlend,
      targetBlend,
      targetBlend > this.eyeContactBlend ? 0.2 : 0.24
    )
    if (this.eyeContactBlend < 0.001) {
      this.eyeContactBlend = 0
    }

    const ambientTarget = {
      eyeYaw: contact && this.eyeContactBlend > 0 ? contact.eyeYaw * this.eyeContactBlend : 0,
      eyePitch: contact && this.eyeContactBlend > 0 ? contact.eyePitch * this.eyeContactBlend : 0,
      headYaw: contact && this.eyeContactBlend > 0 ? contact.headYaw * this.eyeContactBlend : 0,
      headPitch: contact && this.eyeContactBlend > 0 ? contact.headPitch * this.eyeContactBlend : 0
    }

    const eyeFollowRate = 0.18
    const headYawFollowRate = THREE.MathUtils.clamp(
      0.14 * this.eyeContactTuning.headYawSpeed,
      0.01,
      1
    )
    const headPitchFollowRate = THREE.MathUtils.clamp(
      0.14 * this.eyeContactTuning.headPitchSpeed,
      0.01,
      1
    )
    this.eyeContactAmbient.eyeYaw = THREE.MathUtils.lerp(
      this.eyeContactAmbient.eyeYaw,
      ambientTarget.eyeYaw,
      eyeFollowRate
    )
    this.eyeContactAmbient.eyePitch = THREE.MathUtils.lerp(
      this.eyeContactAmbient.eyePitch,
      ambientTarget.eyePitch,
      eyeFollowRate
    )
    this.eyeContactAmbient.headYaw = THREE.MathUtils.lerp(
      this.eyeContactAmbient.headYaw,
      ambientTarget.headYaw,
      headYawFollowRate
    )
    this.eyeContactAmbient.headPitch = THREE.MathUtils.lerp(
      this.eyeContactAmbient.headPitch,
      ambientTarget.headPitch,
      headPitchFollowRate
    )

    if (!input.authoredEyeOverride) {
      eyeYaw += this.eyeContactAmbient.eyeYaw
      eyePitch += this.eyeContactAmbient.eyePitch
    }
    headYaw += this.eyeContactAmbient.headYaw
    headPitch += this.eyeContactAmbient.headPitch

    this.eyeContactApplied = {
      eyeYaw,
      eyePitch,
      headYaw,
      headPitch
    }
  }

  private resolveEyeContactTravel(
    currentAbsDeg: number,
    lastAbsDeg: number | null,
    previousTravel: EyeContactTravelDirection
  ): EyeContactTravelDirection {
    if (lastAbsDeg === null) return previousTravel
    const delta = currentAbsDeg - lastAbsDeg
    if (Math.abs(delta) < 0.15) return previousTravel
    return delta < 0 ? 'in' : 'out'
  }

  private resolveCameraEyeContact() {
    if (!this.vrm && !this.customPerformanceRigRuntime) return null
    const focusPoint = this.getEyeContactFocusPoint()
    if (!focusPoint) return null

    const directionWorld = this.camera.position.clone().sub(focusPoint)
    if (directionWorld.lengthSq() < 0.0001) return null
    directionWorld.normalize()

    const referenceQuaternion = this.getEyeContactReferenceQuaternion()
    const localDirection = directionWorld.applyQuaternion(referenceQuaternion.invert())
    const horizontal = Math.max(0.0001, Math.hypot(localDirection.x, localDirection.z))
    const yawDeg = THREE.MathUtils.radToDeg(
      Math.atan2(localDirection.x, localDirection.z * this.eyeContactLocalFrontZ)
    )
    const pitchDeg = -THREE.MathUtils.radToDeg(Math.atan2(localDirection.y, horizontal))
    const yawAbs = Math.abs(yawDeg)
    const pitchAbs = Math.abs(pitchDeg)

    this.eyeContactYawTravel = this.resolveEyeContactTravel(
      yawAbs,
      this.eyeContactLastYawAbs,
      this.eyeContactYawTravel
    )
    this.eyeContactPitchTravel = this.resolveEyeContactTravel(
      pitchAbs,
      this.eyeContactLastPitchAbs,
      this.eyeContactPitchTravel
    )
    this.eyeContactLastYawAbs = yawAbs
    this.eyeContactLastPitchAbs = pitchAbs

    return resolveEyeContactChannels(yawDeg, pitchDeg, this.eyeContactTuning, {
      yawTravel: this.eyeContactYawTravel,
      pitchTravel: this.eyeContactPitchTravel
    })
  }

  private getEyeContactFocusPoint() {
    if (this.customPerformanceRigRuntime) {
      if (
        this.customPerformanceRigRuntime.usesSocketEyeDriver() &&
        this.socketEyeSurfaceDefinition
      ) {
        const head = this.customPerformanceRigRuntime.getLookNode('head')
        const left = this.socketEyeSurfaceDefinition.runtimeBindings.left.gazeAnchorHeadLocal
        const right = this.socketEyeSurfaceDefinition.runtimeBindings.right.gazeAnchorHeadLocal
        const midpoint = new THREE.Vector3(
          (left[0] + right[0]) / 2,
          (left[1] + right[1]) / 2,
          (left[2] + right[2]) / 2
        )
        head.updateWorldMatrix(true, false)
        return head.localToWorld(midpoint)
      }
      const leftEye = this.customPerformanceRigRuntime.getLookNode('leftEye')
      const rightEye = this.customPerformanceRigRuntime.getLookNode('rightEye')
      const left = leftEye.getWorldPosition(new THREE.Vector3())
      const right = rightEye.getWorldPosition(new THREE.Vector3())
      return left.add(right).multiplyScalar(0.5)
    }
    const head = this.bones[VRMHumanBoneName.Head]
    if (head) {
      return head.getWorldPosition(new THREE.Vector3())
    }
    return this.controls?.target.clone() ?? null
  }

  private applyEasing(t: number, easing: GoonEnvelopeEasing) {
    const clamped = Math.max(0, Math.min(1, t))
    switch (easing) {
      case 'easeIn':
        return clamped * clamped
      case 'easeOut':
        return 1 - Math.pow(1 - clamped, 2)
      case 'easeInOut':
        return clamped < 0.5
          ? 2 * clamped * clamped
          : 1 - Math.pow(-2 * clamped + 2, 2) / 2
      default:
        return clamped
    }
  }

  private resolveCurrentLipSyncFrame(
    elapsed: number,
    intensityScale = PRECOMPUTED_LIP_SYNC_VRM_INTENSITY_SCALE
  ): GoonSpeechFaceFrame {
    const audioActivity = this.measureSpeechAudioActivity()
    let frame = createEmptyGoonSpeechFaceFrame(RHUBARB_9_SPEECH_FACE_PROFILE)

    if (this.lipSyncEnabled && this.speaking) {
      if (this.lipSyncMode === 'viseme' && this.speechLipSyncTimeline) {
        frame = sampleGoonLipSyncTimeline(
          this.speechLipSyncTimeline,
          this.getSpeechLipSyncElapsedMs()
        )
        const gate = isTimelineOwnedGoonLipSyncSource(this.speechLipSyncTimeline.source)
          ? 1
          : this.resolveSpeechAudioGate(audioActivity, this.speechLipSyncTimeline.source)
        frame = scaleGoonSpeechFaceFrame(frame, gate * intensityScale)
      } else {
        if (frame.profile !== RHUBARB_9_SPEECH_FACE_PROFILE) {
          throw new Error('Amplitude lip sync must use the Rhubarb-9 fallback frame.')
        }
        frame.weights.wide_open = this.computeFastLipSyncOpenness(elapsed)
      }
    }

    return frame
  }

  private applyLipSync(manager: NonNullable<VRM['expressionManager']>, elapsed: number) {
    if (!this.hasMouthBlendshapes) return
    const frame = this.resolveCurrentLipSyncFrame(elapsed)
    const legacyWeights = downmixGoonLipSyncFrameToLegacy(frame)

    if (this.lipSyncMode === 'viseme' && this.availableMouthPresets.size > 1) {
      this.applyDetailedMouthWeights(manager, legacyWeights)
      return
    }

    this.applyBasicMouthWeight(manager, legacyWeights)
  }

  private applyEyeLook(
    lookAt: NonNullable<VRM['lookAt']>,
    eyeYaw: number,
    eyePitch: number
  ) {
    const active = Math.abs(eyeYaw) >= 0.001 || Math.abs(eyePitch) >= 0.001
    if (!active) {
      this.clearLookAtOverride(lookAt)
      return
    }
    this.beginLookAtOverride(lookAt)
    this.configureLookAtOutputScale(
      lookAt,
      this.eyeContactTuning.eyeYawRange,
      this.eyeContactTuning.eyePitchRange
    )
    const maxYaw = 160
    const maxPitch = 110
    lookAt.yaw = THREE.MathUtils.clamp(eyeYaw, -1, 1) * maxYaw
    lookAt.pitch = THREE.MathUtils.clamp(eyePitch, -1, 1) * maxPitch
  }

  private resolveLookAtRangeMapApplier(
    lookAt: NonNullable<VRM['lookAt']>
  ): LookAtRangeMapApplier | null {
    const applierType = this.resolveLookAtApplierType(lookAt)
    if (applierType !== 'bone' && applierType !== 'expression') return null
    const applier = lookAt.applier as Partial<LookAtRangeMapApplier>
    if (
      !applier.rangeMapHorizontalInner ||
      !applier.rangeMapHorizontalOuter ||
      !applier.rangeMapVerticalDown ||
      !applier.rangeMapVerticalUp
    ) {
      return null
    }
    return applier as LookAtRangeMapApplier
  }

  private resolveLookAtRangeMapBaseScales(applier: LookAtRangeMapApplier): BoneLookAtRangeMapScales {
    const existing = this.lookAtRangeMapBaseScales.get(applier)
    if (existing) return existing

    const scales = {
      horizontalInner: applier.rangeMapHorizontalInner.outputScale,
      horizontalOuter: applier.rangeMapHorizontalOuter.outputScale,
      verticalDown: applier.rangeMapVerticalDown.outputScale,
      verticalUp: applier.rangeMapVerticalUp.outputScale
    }
    this.lookAtRangeMapBaseScales.set(applier, scales)
    return scales
  }

  private configureLookAtOutputScale(
    lookAt: NonNullable<VRM['lookAt']>,
    yawStrength: number,
    pitchStrength: number
  ) {
    const applier = this.resolveLookAtRangeMapApplier(lookAt)
    if (!applier) return

    const base = this.resolveLookAtRangeMapBaseScales(applier)
    const horizontalMultiplier = THREE.MathUtils.clamp(yawStrength, 0, 8)
    const verticalMultiplier = THREE.MathUtils.clamp(pitchStrength, 0, 8)

    applier.rangeMapHorizontalInner.outputScale = base.horizontalInner * horizontalMultiplier
    applier.rangeMapHorizontalOuter.outputScale = base.horizontalOuter * horizontalMultiplier
    applier.rangeMapVerticalDown.outputScale = base.verticalDown * verticalMultiplier
    applier.rangeMapVerticalUp.outputScale = base.verticalUp * verticalMultiplier
  }

  private resetLookAtOutputScale(lookAt: NonNullable<VRM['lookAt']>) {
    this.configureLookAtOutputScale(lookAt, 1, 1)
  }

  private applyDirectEyeBoneDebugOverride() {
    if (!this.eyeLookDirectBoneDebugEnabled) return
    const humanoid = this.vrm?.humanoid
    if (!humanoid) return

    const yaw = THREE.MathUtils.clamp(this.eyeContactApplied.eyeYaw, -1, 1)
    const pitch = THREE.MathUtils.clamp(this.eyeContactApplied.eyePitch, -1, 1)
    if (Math.abs(yaw) < 0.001 && Math.abs(pitch) < 0.001) return

    const yawRad = THREE.MathUtils.degToRad(yaw * 60)
    const pitchRad = THREE.MathUtils.degToRad(pitch * 45)
    const targets = [
      humanoid.getRawBoneNode(VRMHumanBoneName.LeftEye),
      humanoid.getRawBoneNode(VRMHumanBoneName.RightEye)
    ]

    for (const target of targets) {
      if (!target) continue
      target.rotation.x += pitchRad
      target.rotation.y += yawRad
    }
  }

  private logEyeLookDebug(
    manager: NonNullable<VRM['expressionManager']>,
    eyeLookLane: ReturnType<typeof resolveEyeLookRuntimeLaneRule>,
    values: {
      eyeYaw: number
      eyePitch: number
      headYaw: number
      headPitch: number
    }
  ) {
    if (!this.eyeLookDebugEnabled) return
    const now = performance.now()
    if (now - this.lastEyeLookDebugAt < 250) return
    this.lastEyeLookDebugAt = now

    const lookAt = this.vrm?.lookAt ?? null
    const details = {
      requestedMode: this.eyeContactMode,
      lane: eyeLookLane,
      applierType: lookAt ? this.resolveLookAtApplierType(lookAt) : null,
      motionEyeContactSuppressed: this.isEyeContactSuppressedByMotion(),
      eyeContactBlend: Number(this.eyeContactBlend.toFixed(3)),
      headFrozen: this.eyeLookFreezeHeadEnabled,
      directBoneDebug: this.eyeLookDirectBoneDebugEnabled,
      tuning: this.eyeContactTuning,
      eyeYaw: Number(values.eyeYaw.toFixed(3)),
      eyePitch: Number(values.eyePitch.toFixed(3)),
      headYaw: Number(values.headYaw.toFixed(3)),
      headPitch: Number(values.headPitch.toFixed(3)),
      lookAtYaw: lookAt ? Number(lookAt.yaw.toFixed(3)) : null,
      lookAtPitch: lookAt ? Number(lookAt.pitch.toFixed(3)) : null,
      lookAtRangeMap: lookAt ? this.serializeLookAtRangeMaps(lookAt) : null,
      hasUsableLookAtEyeBones: this.hasUsableLookAtEyeBones(),
      hasUsableLookExpressions: this.hasUsableLookExpressionPresets(manager),
      hasGuidedDirectionControls: this.hasGuidedEyeDirectionControls(),
      leftEyeRotationDeg: this.serializeEyeBoneRotation(VRMHumanBoneName.LeftEye),
      rightEyeRotationDeg: this.serializeEyeBoneRotation(VRMHumanBoneName.RightEye)
    }
    console.debug('[GoonEyeLookDebug]', JSON.stringify(details))
  }

  private canApplyLookAt(
    lookAt: NonNullable<VRM['lookAt']>,
    manager: NonNullable<VRM['expressionManager']>
  ) {
    const eyeLookLane = this.resolveEyeLookRuntimeLane(manager, lookAt)
    return eyeLookLane === 'bone-look-at' || eyeLookLane === 'expression-look-at'
  }

  private resolveLookAtApplierType(lookAt: NonNullable<VRM['lookAt']>) {
    const type = (lookAt.applier?.constructor as { type?: string } | undefined)?.type
    if (type === 'bone' || type === 'expression') return type
    return 'unknown'
  }

  private resolveEyeLookRuntimeLane(
    manager: NonNullable<VRM['expressionManager']>,
    lookAt: NonNullable<VRM['lookAt']> | null = this.vrm?.lookAt ?? null
  ) {
    return resolveEyeLookRuntimeLaneRule({
      requestedMode: this.eyeContactMode,
      lookAtApplierType: lookAt ? this.resolveLookAtApplierType(lookAt) : null,
      hasUsableLookAtEyeBones: this.hasUsableLookAtEyeBones(),
      hasUsableLookExpressions: this.hasUsableLookExpressionPresets(manager),
      hasGuidedDirectionControls: this.hasGuidedEyeDirectionControls()
    })
  }

  private hasUsableLookAtEyeBones() {
    const humanoid = this.vrm?.humanoid
    if (!humanoid) return false
    return Boolean(
      humanoid.getRawBoneNode(VRMHumanBoneName.LeftEye) &&
        humanoid.getNormalizedBoneNode(VRMHumanBoneName.LeftEye) &&
        humanoid.getRawBoneNode(VRMHumanBoneName.RightEye) &&
        humanoid.getNormalizedBoneNode(VRMHumanBoneName.RightEye)
    )
  }

  private serializeLookAtRangeMaps(lookAt: NonNullable<VRM['lookAt']>) {
    const applier = this.resolveLookAtRangeMapApplier(lookAt)
    if (!applier) return null

    const serializeRangeMap = (rangeMap: VRMLookAtBoneApplier['rangeMapHorizontalInner']) => ({
      inputMaxValue: Number(rangeMap.inputMaxValue.toFixed(3)),
      outputScale: Number(rangeMap.outputScale.toFixed(3))
    })

    return {
      horizontalInner: serializeRangeMap(applier.rangeMapHorizontalInner),
      horizontalOuter: serializeRangeMap(applier.rangeMapHorizontalOuter),
      verticalDown: serializeRangeMap(applier.rangeMapVerticalDown),
      verticalUp: serializeRangeMap(applier.rangeMapVerticalUp)
    }
  }

  private serializeEyeBoneRotation(
    boneName: typeof VRMHumanBoneName.LeftEye | typeof VRMHumanBoneName.RightEye
  ) {
    const humanoid = this.vrm?.humanoid
    const tracked = this.bones[boneName]
    const raw = humanoid?.getRawBoneNode(boneName) ?? null
    const normalized = humanoid?.getNormalizedBoneNode(boneName) ?? null
    if (!tracked && !raw && !normalized) return null
    return {
      tracked: this.serializeObjectRotation(tracked),
      raw: this.serializeObjectRotation(raw),
      normalized: this.serializeObjectRotation(normalized)
    }
  }

  private serializeObjectRotation(bone: THREE.Object3D | null | undefined) {
    if (!bone) return null
    return {
      x: Number(THREE.MathUtils.radToDeg(bone.rotation.x).toFixed(2)),
      y: Number(THREE.MathUtils.radToDeg(bone.rotation.y).toFixed(2)),
      z: Number(THREE.MathUtils.radToDeg(bone.rotation.z).toFixed(2))
    }
  }

  private hasUsableLookExpressionPresets(manager: NonNullable<VRM['expressionManager']>) {
    return [
      VRMExpressionPresetName.LookLeft,
      VRMExpressionPresetName.LookRight,
      VRMExpressionPresetName.LookUp,
      VRMExpressionPresetName.LookDown
    ].some((preset) => {
      const expression = manager.getExpression(preset)
      const binds = (expression as { binds?: readonly unknown[] } | null)?.binds
      return Array.isArray(binds) && binds.length > 0
    })
  }

  private mergeExpressionWeight(
    weights: Map<ResolvedExpressionPreset, number>,
    preset: VRMExpressionPresetName,
    value: number
  ) {
    if (value <= 0) return
    const current = weights.get(preset) ?? 0
    weights.set(preset, Math.max(current, value))
  }

  private beginLookAtOverride(lookAt: NonNullable<VRM['lookAt']>) {
    if (!this.lookAtOverrideActive) {
      this.lookAtOverrideActive = true
      this.lookAtRestoreAutoUpdate = lookAt.autoUpdate
      this.lookAtRestoreTarget = lookAt.target ?? null
    }
    lookAt.autoUpdate = false
    lookAt.target = null
  }

  private clearLookAtOverride(lookAt: NonNullable<VRM['lookAt']>) {
    this.resetLookAtOutputScale(lookAt)
    if (!this.lookAtOverrideActive) return
    lookAt.yaw = 0
    lookAt.pitch = 0
    lookAt.autoUpdate = this.lookAtRestoreAutoUpdate
    lookAt.target = this.lookAtRestoreTarget ?? null
    this.lookAtOverrideActive = false
    this.lookAtRestoreAutoUpdate = true
    this.lookAtRestoreTarget = null
  }

  private resolveExpressionPreset(name: string) {
    switch (name) {
      case 'smile':
        return VRMExpressionPresetName.Happy
      case 'smirk':
        return VRMExpressionPresetName.Relaxed
      case 'sad':
        return VRMExpressionPresetName.Sad
      case 'angry':
        return VRMExpressionPresetName.Angry
      case 'surprised':
        return VRMExpressionPresetName.Surprised
      case 'blink':
        return VRMExpressionPresetName.Blink
      default:
        return null
    }
  }

  private resolveExpressionTargets(name: string, definition?: GoonCueDefinition) {
    const targets: Array<{ preset: ResolvedExpressionPreset; weight: number }> = []
    const manager = this.vrm?.expressionManager
    const hasLookAt = Boolean(this.vrm?.lookAt)

    if (definition?.expressionTargets && definition.expressionTargets.length > 0) {
      for (const target of definition.expressionTargets as GoonExpressionTarget[]) {
        const preset = target.preset as ResolvedExpressionPreset
        if (!preset) continue
        if (
          preset === 'lookUpHead' ||
          preset === 'lookDownHead' ||
          preset === 'lookLeftHead' ||
          preset === 'lookRightHead'
        ) {
          targets.push({
            preset,
            weight: typeof target.weight === 'number' ? target.weight : 1
          })
          continue
        }
        if (
          preset === VRMExpressionPresetName.LookUp ||
          preset === VRMExpressionPresetName.LookDown ||
          preset === VRMExpressionPresetName.LookLeft ||
          preset === VRMExpressionPresetName.LookRight
        ) {
          const hasExpression =
            manager?.getExpression(preset as VRMExpressionPresetName | string) ?? false
          const hasCustomOverlayExpression = this.customExpressionMorphMap.has(
            preset as GoonExpressionPreset
          )
          if (!hasExpression && !hasLookAt && !hasCustomOverlayExpression) continue
          targets.push({
            preset: preset as VRMExpressionPresetName,
            weight: typeof target.weight === 'number' ? target.weight : 1
          })
          continue
        }
        if (!this.supportsExpressionPreset(preset as GoonExpressionPreset)) {
          continue
        }
        targets.push({
          preset: preset as GoonExpressionPreset,
          weight: typeof target.weight === 'number' ? target.weight : 1
        })
      }
      return targets
    }

    const fallback = this.resolveExpressionPreset(name)
    if (fallback) {
      if (this.supportsExpressionPreset(fallback)) {
        targets.push({ preset: fallback, weight: 1 })
      }
    }

    return targets
  }

  private emitCompatibility() {
    if (!this.vrm) return
    const manager = this.vrm.expressionManager

    const boneGroups = [
      { label: 'hips', bones: [VRMHumanBoneName.Hips] },
      { label: 'spine', bones: [VRMHumanBoneName.Spine] },
      { label: 'chest', bones: [VRMHumanBoneName.Chest, VRMHumanBoneName.UpperChest] },
      { label: 'neck', bones: [VRMHumanBoneName.Neck] },
      { label: 'head', bones: [VRMHumanBoneName.Head] },
      { label: 'rightUpperArm', bones: [VRMHumanBoneName.RightUpperArm] },
      { label: 'rightLowerArm', bones: [VRMHumanBoneName.RightLowerArm] }
    ]

    const presentBoneGroups = boneGroups.filter((group) =>
      group.bones.some((bone) => Boolean(this.bones[bone]))
    ).length

    this.boneCoveragePresent = presentBoneGroups
    this.boneCoverageTotal = boneGroups.length
    const coverageRatio =
      this.boneCoverageTotal > 0 ? this.boneCoveragePresent / this.boneCoverageTotal : 1
    this.coveragePoseIntervalMs = coverageRatio < 1 ? 1000 / 30 : 0
    this.poseUpdateIntervalMs = Math.max(
      this.coveragePoseIntervalMs,
      this.quality === 'low' ? 1000 / 30 : 0
    )

    if (!manager) {
      this.hasMouthBlendshapes = false
      this.hasExpressionBlendshapes = false
      this.availableMouthPresets.clear()
      const issues: string[] = ['Missing VRM expression manager (facial controls unavailable).']
      if (!this.hasBodyAnimations) {
        issues.push('No animations detected (procedural motions only).')
      }
      for (const warning of this.animationWarnings) {
        if (!issues.includes(warning)) {
          issues.push(warning)
        }
      }
      const animationNames = Array.from(this.animationMap.keys())
      this.onCompatibility?.({
        tier: 'C',
        issues,
        hasMouth: false,
        hasExpressions: false,
        hasBodyAnimations: this.hasBodyAnimations,
        runtimeBackend: this.runtimeStatus.backend,
        boneCoverage: {
          present: this.boneCoveragePresent,
          total: this.boneCoverageTotal
        },
        animationNames: animationNames.length > 0 ? animationNames : undefined,
        updated_at: new Date().toISOString()
      })
      return
    }

    const hasMouth =
      manager.mouthExpressionNames?.some((name) => manager.getExpression(name)) ?? false
    const hasExpressions =
      [
        VRMExpressionPresetName.Happy,
        VRMExpressionPresetName.Sad,
        VRMExpressionPresetName.Angry,
        VRMExpressionPresetName.Surprised,
        VRMExpressionPresetName.Blink
      ].some((name) => manager.getExpression(name)) ?? false

    this.hasMouthBlendshapes = hasMouth
    this.hasExpressionBlendshapes = hasExpressions
    this.availableMouthPresets = new Set(
      VRM_MOUTH_PRESET_ORDER.filter((name) => Boolean(manager.getExpression(name)))
    )
    this.discoverFaceMesh()
    this.mouthExpressionMorphTargetNames = this.collectExpressionMorphTargetNames(
      manager.mouthExpressionNames ?? []
    )
    if (this.guidedManifestOverlay?.face) {
      this.discoverGuidedManifestFaceSupport(this.guidedManifestOverlay)
    }

    const effectiveHasMouth = this.hasMouthBlendshapes
    const effectiveHasExpressions = this.hasExpressionBlendshapes

    const issues: string[] = []

    const missingCoreBones: string[] = []
    const missingUpperBody: string[] = []
    const missingArms: string[] = []

    if (!this.bones[VRMHumanBoneName.Hips]) missingCoreBones.push('hips')
    if (!this.bones[VRMHumanBoneName.Head]) missingCoreBones.push('head')

    if (!this.bones[VRMHumanBoneName.Spine]) missingUpperBody.push('spine')
    const hasChest = Boolean(
      this.bones[VRMHumanBoneName.Chest] || this.bones[VRMHumanBoneName.UpperChest]
    )
    if (!hasChest) missingUpperBody.push('chest')
    if (!this.bones[VRMHumanBoneName.Neck]) missingUpperBody.push('neck')

    if (!this.bones[VRMHumanBoneName.RightUpperArm]) missingArms.push('rightUpperArm')
    if (!this.bones[VRMHumanBoneName.RightLowerArm]) missingArms.push('rightLowerArm')
    if (!effectiveHasMouth) issues.push('Missing mouth blendshapes (lip sync degraded).')
    if (!effectiveHasExpressions) issues.push('Missing core expression blendshapes.')
    if (presentBoneGroups < boneGroups.length) {
      issues.push(`Rig coverage: ${presentBoneGroups}/${boneGroups.length} key bones detected.`)
    }
    if (missingCoreBones.length > 0) {
      issues.push(`Missing core bones: ${missingCoreBones.join(', ')}.`)
    }
    if (missingUpperBody.length > 0) {
      issues.push(`Missing upper-body bones: ${missingUpperBody.join(', ')}.`)
    }
    if (missingArms.length > 0) {
      issues.push(`Missing arm bones: ${missingArms.join(', ')}.`)
    }
    if (!this.hasBodyAnimations) {
      issues.push('No animations detected (procedural motions only).')
    }
    for (const warning of this.animationWarnings) {
      if (!issues.includes(warning)) {
        issues.push(warning)
      }
    }

    const criticalBonesMissing = missingCoreBones.length > 0
    const tier =
      criticalBonesMissing
        ? 'C'
        : effectiveHasMouth && effectiveHasExpressions
          ? 'A'
          : effectiveHasMouth
            ? 'B'
            : 'C'
    const animationNames = Array.from(this.animationMap.keys())

    this.onCompatibility?.({
      tier,
      issues,
      hasMouth: effectiveHasMouth,
      hasExpressions: effectiveHasExpressions,
      hasBodyAnimations: this.hasBodyAnimations,
      runtimeBackend: this.runtimeStatus.backend,
      boneCoverage: {
        present: this.boneCoveragePresent,
        total: this.boneCoverageTotal
      },
      animationNames: animationNames.length > 0 ? animationNames : undefined,
      updated_at: new Date().toISOString()
    })
  }

  // ---------------------------------------------------------------------------
  // Face Control System (Batshit Abstraction Layer)
  // ---------------------------------------------------------------------------

  /**
   * Discover the face mesh and its morph targets after VRM load.
   */
  private discoverFaceMesh() {
    this.faceMorphBindings = []
    this.faceMorphTargetNames = []
    this.authorableRawMorphTargetNames = []
    this.faceControlMorphNames = []
    this.mouthExpressionMorphTargetNames.clear()
    this.faceControlDebugLogged = false
    this.lastAppliedRawMorphTargets = []
    this.vrmSource = 'unknown'
    this.customFaceControlMap = null
    this.customMorphDefinitions = []

    if (!this.vrm) return

    // Find the face mesh (mesh with most morph targets)
    const morphMeshes: THREE.Mesh[] = []
    let bestCount = 0

    this.vrm.scene.traverse((obj: THREE.Object3D) => {
      if (obj instanceof THREE.Mesh && obj.morphTargetDictionary) {
        const count = Object.keys(obj.morphTargetDictionary).length
        if (count <= 0) return
        morphMeshes.push(obj)
        if (count > bestCount) bestCount = count
      }
    })

    const bestMesh = morphMeshes.find(
      (mesh) => Object.keys(mesh.morphTargetDictionary ?? {}).length === bestCount
    )
    if (!bestMesh || bestCount === 0) return

    const rawDict = (bestMesh as THREE.Mesh).morphTargetDictionary ?? {}
    const rawNames = Object.keys(rawDict)

    // Build normalized dictionary (full name + short Fcl_ suffix)
    const normalizedDict = this.buildNormalizedMorphDict(bestMesh)

    this.faceMorphTargetNames = Object.keys(normalizedDict)
    this.authorableRawMorphTargetNames = [...new Set(rawNames.map((name) => {
      const fclIdx = name.indexOf('Fcl_')
      return fclIdx >= 0 ? name.substring(fclIdx) : name
    }))].sort((a, b) => a.localeCompare(b))
    this.vrmSource = detectVRMSource(this.faceMorphTargetNames)

    const targetNameSet = new Set(this.faceMorphTargetNames)
    this.faceMorphBindings = morphMeshes
      .filter((mesh) => Object.keys(mesh.morphTargetDictionary ?? {}).length === bestCount)
      .map((mesh) => ({ mesh, dict: this.buildNormalizedMorphDict(mesh) }))
      .filter((binding) => {
        const keys = Object.keys(binding.dict)
        return keys.length === targetNameSet.size && keys.every((key) => targetNameSet.has(key))
      })

    const mapping = getFaceControlMapping(this.vrmSource)
    if (mapping) {
      const names = new Set<string>()
      for (const controlMapping of Object.values(mapping)) {
        for (const binding of controlMapping.negative ?? []) {
          if (this.faceMorphBindings.some((entry) => entry.dict[binding.target] !== undefined)) {
            names.add(binding.target)
          }
        }
        for (const binding of controlMapping.positive) {
          if (this.faceMorphBindings.some((entry) => entry.dict[binding.target] !== undefined)) {
            names.add(binding.target)
          }
        }
      }
      this.faceControlMorphNames = [...names]
    }

    const summary = `[GoonEngine] Face controls: ${this.vrmSource} source, ${rawNames.length} morph targets, ${this.faceMorphBindings.length} face primitives, ${this.faceControlMorphNames.length} mapped morphs`
    if (summary !== this.faceControlSummaryLog) {
      this.faceControlSummaryLog = summary
      logger.debug(summary)
    }
  }

  /**
   * Apply Batshit face controls directly to morphTargetInfluences after
   * vrm.update() so granular controls can override the broad VRM presets.
   */
  private faceControlDebugLogged = false

  private applyFaceControls() {
    if (this.faceMorphBindings.length === 0) {
      return
    }
    const mapping =
      this.vrmSource !== 'unknown' && this.faceControlMorphNames.length > 0
        ? getFaceControlMapping(this.vrmSource)
        : null

    // Collect all active face controls: mood + active expressions
    const allControls: GoonFaceControl[] = []
    const allRawMorphTargets: GoonRawMorphTarget[] = []
    const now = performance.now()
    const moodFaceBlend = this.moodFaceBlend
    const pushFaceControl = (fc: GoonFaceControl, intensity: number) => {
      if (isDirectionControl(fc.control)) return
      const adjusted = resolveSpeakingFaceControl(
        {
          control: fc.control,
          value: fc.value * intensity
        },
        {
          speaking: this.speaking,
          pausedForCue: this.speechPausedForCue
        }
      )
      if (!adjusted) return
      allControls.push(adjusted)
    }

    // Mood face controls (constant, no envelope)
    if (moodFaceBlend > 0.001) {
      for (const fc of this.moodFaceControls) {
        pushFaceControl(fc, this.moodExpressionIntensity * moodFaceBlend)
      }
      for (const rawMorph of this.moodRawMorphTargets) {
        allRawMorphTargets.push({
          target: rawMorph.target,
          value: rawMorph.value * this.moodExpressionIntensity * moodFaceBlend
        })
      }
    }

    for (const fc of this.authoringPreviewFaceControls) {
      pushFaceControl(fc, this.authoringPreviewIntensity)
    }
    for (const rawMorph of this.authoringPreviewRawMorphTargets) {
      allRawMorphTargets.push({
        target: rawMorph.target,
        value: rawMorph.value * this.authoringPreviewIntensity
      })
    }

    // Active expression face controls (with envelope)
    for (const exp of this.activeExpressions) {
      const fcs = this.resolveActiveExpressionFaceControls(exp, now)
      for (const fc of fcs) {
        pushFaceControl(fc, exp.intensity)
      }

      const rawMorphs = this.resolveActiveExpressionRawMorphTargets(exp, now)
      for (const rawMorph of rawMorphs) {
        allRawMorphTargets.push({
          target: rawMorph.target,
          value: rawMorph.value * exp.intensity
        })
      }
    }

    const resolvedSemantic = mapping && allControls.length > 0
      ? resolveFaceControls(allControls, mapping)
      : new Map<string, number>()
    const resolvedRaw = resolveRawMorphTargets(allRawMorphTargets)
    const clearTargets = new Set<string>()
    const preserveSpeechTargets = this.speaking ? this.mouthExpressionMorphTargetNames : null
    const shouldPreserveTarget = (targetName: string) =>
      Boolean(
        preserveSpeechTargets?.has(targetName) &&
        !resolvedSemantic.has(targetName) &&
        !resolvedRaw.has(targetName)
      )

    for (const targetName of this.faceControlMorphNames) {
      if (shouldPreserveTarget(targetName)) continue
      clearTargets.add(targetName)
    }
    for (const targetName of this.lastAppliedRawMorphTargets) {
      if (shouldPreserveTarget(targetName)) continue
      clearTargets.add(targetName)
    }
    for (const targetName of resolvedRaw.keys()) {
      clearTargets.add(targetName)
    }

    if (clearTargets.size === 0 && resolvedSemantic.size === 0 && resolvedRaw.size === 0) return

    for (const binding of this.faceMorphBindings) {
      const influences = binding.mesh.morphTargetInfluences
      if (!Array.isArray(influences)) continue
      for (const targetName of clearTargets) {
        const index = binding.dict[targetName]
        if (index !== undefined) influences[index] = 0
      }
    }

    this.lastAppliedRawMorphTargets = [...resolvedRaw.keys()]

    // Debug log once
    if (!this.faceControlDebugLogged && (resolvedSemantic.size > 0 || resolvedRaw.size > 0)) {
      this.faceControlDebugLogged = true
      const entries: string[] = []
      for (const [name, weight] of resolvedSemantic.entries()) {
        entries.push(`${name} weight:${weight.toFixed(2)}`)
      }
      for (const [name, weight] of resolvedRaw.entries()) {
        entries.push(`raw:${name} weight:${weight.toFixed(2)}`)
      }
      logger.debug(`[GoonEngine] Face controls applying via morph targets:`, entries.join(', '))
    }

    // Apply directly to the active face mesh after vrm.update() so these
    // granular controls win for the morph channels they explicitly author.
    for (const [targetName, weight] of resolvedSemantic.entries()) {
      for (const binding of this.faceMorphBindings) {
        const influences = binding.mesh.morphTargetInfluences
        if (!Array.isArray(influences)) continue
        const index = binding.dict[targetName]
        if (index === undefined) continue
        influences[index] = THREE.MathUtils.clamp(weight, 0, 1)
      }
    }

    // Expert raw morphs apply last and therefore win on the targets they author.
    for (const [targetName, weight] of resolvedRaw.entries()) {
      for (const binding of this.faceMorphBindings) {
        const influences = binding.mesh.morphTargetInfluences
        if (!Array.isArray(influences)) continue
        const index = binding.dict[targetName]
        if (index === undefined) continue
        influences[index] = THREE.MathUtils.clamp(weight, 0, 1)
      }
    }
  }

  private buildNormalizedMorphDict(mesh: THREE.Mesh): Record<string, number> {
    const rawDict = mesh.morphTargetDictionary ?? {}
    const normalizedDict: Record<string, number> = {}
    for (const [fullName, index] of Object.entries(rawDict)) {
      normalizedDict[fullName] = index
      const shortName = this.normalizeMorphTargetName(fullName)
      if (shortName) {
        if (!(shortName in normalizedDict)) {
          normalizedDict[shortName] = index
        }
      }
    }
    return normalizedDict
  }

  private normalizeMorphTargetName(name: string) {
    const fclIdx = name.indexOf('Fcl_')
    if (fclIdx >= 0) {
      return name.substring(fclIdx)
    }
    return null
  }

  private collectExpressionMorphTargetNames(expressionNames: string[]) {
    const manager = this.vrm?.expressionManager
    const targets = new Set<string>()
    if (!manager) return targets

    for (const expressionName of expressionNames) {
      const expression = manager.getExpression(expressionName)
      if (!expression) continue
      for (const bind of expression.binds) {
        const bindRecord = bind as {
          index?: number
          primitives?: THREE.Mesh[]
        }
        if (typeof bindRecord.index !== 'number' || !Array.isArray(bindRecord.primitives)) {
          continue
        }
        for (const primitive of bindRecord.primitives) {
          const morphDict = primitive.morphTargetDictionary ?? {}
          for (const [fullName, index] of Object.entries(morphDict)) {
            if (index !== bindRecord.index) continue
            const shortName = this.normalizeMorphTargetName(fullName)
            if (shortName) {
              targets.add(shortName)
            }
          }
        }
      }
    }

    return targets
  }

  private getSpeechLipSyncElapsedMs() {
    if (this.audioElement && Number.isFinite(this.audioElement.currentTime)) {
      const currentTime = this.audioElement.currentTime

      if (this.speechAudioStartOffsetSec !== null) {
        const adjustedCurrent = Math.max(0, currentTime - this.speechAudioStartOffsetSec)
        return adjustedCurrent * 1000
      }

      return currentTime * 1000
    }

    return Math.max(0, performance.now() - this.speechLipSyncStartedAt)
  }

  private hasActiveEmote(now: number) {
    if (this.activeEmoteUntil > now) {
      return true
    }
    return this.activeExpressions.some((exp) => exp.kind === 'emote' && exp.endsAt > now)
  }

  private measureSpeechAudioActivity() {
    if (!this.analyser || !this.analyserData) return null

    this.analyser.getByteTimeDomainData(this.analyserData)
    let sum = 0
    for (let index = 0; index < this.analyserData.length; index += 1) {
      const value = (this.analyserData[index] - 128) / 128
      sum += value * value
    }

    const rms = Math.sqrt(sum / this.analyserData.length)
    const normalized = THREE.MathUtils.clamp(
      (rms - FAST_LIP_SYNC_NOISE_FLOOR) / (FAST_LIP_SYNC_NOISE_CEILING - FAST_LIP_SYNC_NOISE_FLOOR),
      0,
      1
    )
    this.speechAudioPeak = Math.max(this.speechAudioPeak, normalized)

    if (
      this.audioElement &&
      this.speechAudioStartOffsetSec === null &&
      normalized > 0.12
    ) {
      this.speechAudioStartOffsetSec = this.audioElement.currentTime
    }

    if (
      this.audioElement &&
      this.speechAudioStartOffsetSec === null &&
      this.audioElement.currentTime > 0.25
    ) {
      this.speechAudioStartOffsetSec = 0
    }

    return normalized
  }

  private resolveSpeechAudioGate(
    activity: number | null,
    source: GoonLipSyncTimeline['source'] = 'text-timing'
  ) {
    if (activity === null) {
      this.speechAudioGate = 1
      return 1
    }

    let target = Math.pow(activity, 0.82)
    let smoothing = target > this.speechAudioGate ? 0.4 : 0.14

    if (source === 'audio-analysis' || source === 'provider-alignment') {
      const openThreshold = Math.max(0.02, this.speechAudioPeak * 0.18)
      target = activity >= openThreshold ? 1 : 0
      smoothing = target > this.speechAudioGate ? 0.52 : 0.24
    }

    this.speechAudioGate += (target - this.speechAudioGate) * smoothing
    return THREE.MathUtils.clamp(this.speechAudioGate, 0, 1)
  }

  private computeFastLipSyncOpenness(elapsed: number) {
    let target = 0

    const normalized = this.measureSpeechAudioActivity()
    if (normalized !== null) {
      target = Math.pow(normalized, 0.82) * 0.72
    } else if (this.speechLipSyncTimeline) {
      const trackWeights = sampleGoonLipSyncTimeline(
        this.speechLipSyncTimeline,
        this.getSpeechLipSyncElapsedMs()
      )
      target = Math.min(0.72, getGoonLipSyncOpenness(trackWeights))
    } else {
      target = (Math.sin(elapsed * 6) + 1) * 0.18
    }

    const smoothing =
      target > this.smoothedLipSyncAmplitude ? FAST_LIP_SYNC_ATTACK : FAST_LIP_SYNC_RELEASE
    this.smoothedLipSyncAmplitude += (target - this.smoothedLipSyncAmplitude) * smoothing
    return THREE.MathUtils.clamp(this.smoothedLipSyncAmplitude, 0, 1)
  }

  private applyDetailedMouthWeights(
    manager: NonNullable<VRM['expressionManager']>,
    weights: LegacyGoonLipSyncWeights
  ) {
    const presetWeights: Array<[VRMExpressionPresetName, number]> = [
      [VRMExpressionPresetName.Aa, weights.aa],
      [VRMExpressionPresetName.Ih, weights.ih],
      [VRMExpressionPresetName.Ou, weights.ou],
      [VRMExpressionPresetName.Ee, weights.ee],
      [VRMExpressionPresetName.Oh, weights.oh]
    ]

    for (const [preset, value] of presetWeights) {
      if (!this.availableMouthPresets.has(preset)) continue
      manager.setValue(preset as VRMExpressionPresetName, value)
    }
  }

  private applyBasicMouthWeight(
    manager: NonNullable<VRM['expressionManager']>,
    weights: LegacyGoonLipSyncWeights
  ) {
    const openness = getLegacyGoonLipSyncOpenness(weights)
    if (this.availableMouthPresets.has(VRMExpressionPresetName.Aa)) {
      manager.setValue(VRMExpressionPresetName.Aa, openness)
      return
    }

    const fallbackPreset = VRM_MOUTH_PRESET_ORDER.find((preset) =>
      this.availableMouthPresets.has(preset)
    )
    if (fallbackPreset) {
      manager.setValue(fallbackPreset as VRMExpressionPresetName, openness)
    }
  }

  /**
   * Resolve face controls for an active expression, handling multi-step.
   * Returns face controls with envelope applied.
   */
  private resolveActiveExpressionFaceControls(
    exp: ActiveExpression,
    now: number
  ): GoonFaceControl[] {
    if (exp.steps && exp.steps.length > 0) {
      // Multi-step: find current step and compute its envelope
      const stepElapsed = now - exp.stepStartTime
      const step = exp.steps[exp.currentStep]
      if (!step || step.faceControls.length === 0) return []

      const envelope = this.computeStepEnvelope(stepElapsed, step, exp.easing)
      return step.faceControls.map((fc) => ({
        control: fc.control,
        value: fc.value * envelope
      }))
    }

    // Single-step: use top-level face controls with envelope
    if (exp.faceControls.length === 0) return []
    const elapsed = now - exp.startTime
    const envelope = this.computeEnvelope(elapsed, exp.attackMs, exp.holdMs, exp.releaseMs, exp.easing)
    return exp.faceControls.map((fc) => ({
      control: fc.control,
      value: fc.value * envelope
    }))
  }

  private resolveActiveExpressionRawMorphTargets(
    exp: ActiveExpression,
    now: number
  ): GoonRawMorphTarget[] {
    if (exp.steps && exp.steps.length > 0) {
      const stepElapsed = now - exp.stepStartTime
      const step = exp.steps[exp.currentStep]
      if (!step || step.rawMorphTargets.length === 0) return []

      const envelope = this.computeStepEnvelope(stepElapsed, step, exp.easing)
      return step.rawMorphTargets.map((rawMorph) => ({
        target: rawMorph.target,
        value: rawMorph.value * envelope
      }))
    }

    if (exp.rawMorphTargets.length === 0) return []
    const elapsed = now - exp.startTime
    const envelope = this.computeEnvelope(elapsed, exp.attackMs, exp.holdMs, exp.releaseMs, exp.easing)
    return exp.rawMorphTargets.map((rawMorph) => ({
      target: rawMorph.target,
      value: rawMorph.value * envelope
    }))
  }

  /**
   * Compute envelope value for a given elapsed time and ADSR parameters.
   */
  private computeEnvelope(
    elapsed: number,
    attackMs: number,
    holdMs: number,
    releaseMs: number,
    easing: GoonEnvelopeEasing
  ): number {
    const attackEnd = attackMs
    const holdEnd = attackMs + holdMs
    const releaseEnd = attackMs + holdMs + releaseMs

    if (attackMs > 0 && elapsed < attackEnd) {
      return this.applyEasing(elapsed / attackMs, easing)
    } else if (releaseMs > 0 && elapsed > holdEnd && elapsed < releaseEnd) {
      const releaseElapsed = Math.min(releaseMs, elapsed - holdEnd)
      return 1 - this.applyEasing(releaseElapsed / releaseMs, easing)
    } else if (elapsed >= releaseEnd) {
      return 0
    }
    return 1
  }

  /**
   * Compute envelope for a multi-step expression step.
   */
  private computeStepEnvelope(
    stepElapsed: number,
    step: ActiveExpressionStep,
    easing: GoonEnvelopeEasing
  ): number {
    return this.computeEnvelope(stepElapsed, step.attackMs, step.holdMs, step.releaseMs, easing)
  }

  /** Public accessor: check if face controls are available for the loaded VRM */
  hasFaceControls(): boolean {
    return (
      this.faceMorphBindings.length > 0 &&
      this.faceControlMorphNames.length > 0 &&
      (this.vrmSource !== 'unknown' || this.customFaceControlMap !== null)
    )
  }

  /** Public accessor: check if any raw morph targets are available for expert authoring. */
  hasRawMorphTargets(): boolean {
    return this.faceMorphBindings.length > 0 && this.authorableRawMorphTargetNames.length > 0
  }

  /**
   * Check whether the loaded model can actually apply one semantic expression.
   * Advanced packages use explicit avatar.json mappings; Standard/VRoid models
   * use registered VRM expressions.
   */
  supportsExpressionPreset(preset: GoonExpressionPreset): boolean {
    // Neutral is the model's authored rest state. It clears active expression
    // weights and therefore never requires a synthetic morph target.
    if (preset === VRMExpressionPresetName.Neutral) return true
    return Boolean(
      this.customExpressionMorphMap.has(preset) ||
        this.vrm?.expressionManager?.getExpression(preset as VRMExpressionPresetName | string)
    )
  }

  /** Public accessor: list the shared Mood/Emote controls supported by this model. */
  getSupportedSemanticExpressionPresets(): GoonExpressionPreset[] {
    return GOON_SEMANTIC_EXPRESSION_CONTROLS.filter((control) =>
      this.supportsExpressionPreset(control.value)
    ).map((control) => control.value)
  }

  /** Public accessor: plain-language owner used by unavailable-control copy. */
  getSemanticExpressionSourceLabel(): string {
    if (this.guidedManifestOverlay?.face || this.customExpressionMorphMap.size > 0) {
      return 'This Advanced package'
    }
    if (this.vrmSource === 'vroid') return 'This Standard/VRoid model'
    return 'This Goon model'
  }

  /** Public accessor: get the detected VRM source type */
  getVRMSourceType(): VRMSourceType {
    return this.vrmSource
  }

  /** Public accessor: get all raw morph target names on the face mesh */
  getRawMorphTargetNames(): string[] {
    return this.faceMorphTargetNames
  }

  /** Public accessor: get canonical raw morph target names for expert authoring. */
  getAuthorableRawMorphTargetNames(): string[] {
    return this.authorableRawMorphTargetNames
  }

  hasCustomMorphDefinitions(): boolean {
    return this.customMorphDefinitions.length > 0
  }

  getCustomMorphDefinitions(): Array<{ id: string; morphTargets: string[] }> {
    return this.customMorphDefinitions
  }
}
