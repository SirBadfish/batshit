<script lang="ts">
  import { onDestroy, onMount, tick } from 'svelte'
  import { bytesToBlob, bytesToFile } from '$lib/utils/binary'
  import { downloadBlob } from '$lib/utils/download'
  import * as Card from '$lib/components/ui/card'
  import * as Label from '$lib/components/ui/label'
  import * as Select from '$lib/components/ui/select'
  import * as Switch from '$lib/components/ui/switch'
  import * as Tabs from '$lib/components/ui/tabs'
  import * as Collapsible from '$lib/components/ui/collapsible'
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu'
  import * as Dialog from '$lib/components/ui/dialog'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { Badge } from '$lib/components/ui/badge'
  import * as Tooltip from '$lib/components/ui/tooltip'
  import {
    Armchair,
    ArrowDownUp,
    Check,
    ChevronDown,
    CircleAlert,
    Copy,
    Download,
    Eraser,
    Eye,
    FlipHorizontal2,
    Lock,
    Loader2,
    Paintbrush,
    Palette,
    Pencil,
    PersonStanding,
    Play,
    Plus,
    RefreshCw,
    RotateCcw,
    Save,
    Scissors,
    SlidersHorizontal,
    Trash2,
    Upload,
    X
  } from '@lucide/svelte'
  import { debounce } from '$lib/utils/debounce'
  import { toast } from '$lib/components/ui/sonner/settings-toast'
  import { BATSHIT_SERVER_URL } from '$lib/services/apiClient'
  import type * as THREE from 'three'
  import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
  import GalleryGrid from '$lib/components/ui/gallery/GalleryGrid.svelte'
  import GalleryCard from '$lib/components/ui/gallery/GalleryCard.svelte'
  import SettingsAccordionCard from '$lib/components/settings/SettingsAccordionCard.svelte'
  import SettingsInfoMenu from '$lib/components/settings/SettingsInfoMenu.svelte'
  import SettingsTextEditor from '$lib/components/settings/SettingsTextEditor.svelte'
  import BatshitIcon from '$lib/components/icons/BatshitIcon.svelte'
  import IconRenderer from '$lib/components/icons/IconRenderer.svelte'
  import AnimationPreviewThumb, {
    resolveMotionPreviewTargetKey,
    type MotionPreviewTarget
  } from '$lib/components/goons/AnimationPreviewThumb.svelte'
  import AppearanceDialsEditor from '$lib/components/goons/AppearanceDialsEditor.svelte'
  import FacialArtworkEditor from '$lib/components/goons/FacialArtworkEditor.svelte'
  import OralAppearanceEditor from '$lib/components/goons/OralAppearanceEditor.svelte'
  import LipArtworkEditor from '$lib/components/goons/LipArtworkEditor.svelte'
  import NailSurfaceEditor from '$lib/components/goons/NailSurfaceEditor.svelte'
  import SkinAppearanceEditor from '$lib/components/goons/SkinAppearanceEditor.svelte'
  import SkinSurfaceEditor from '$lib/components/goons/SkinSurfaceEditor.svelte'
  import HairCatalogEditor from '$lib/components/goons/HairCatalogEditor.svelte'
  import HairImportWizard from '$lib/components/goons/hair-import/HairImportWizard.svelte'
  import HairMotionPaintOverlay from '$lib/components/goons/hair-import/HairMotionPaintOverlay.svelte'
  import {
    revealHairImportEditor,
    snapshotHairImportEditorContext
  } from '$lib/components/goons/hair-import/hairImportUiState'
  import type {
    HairImportFinalizeRequest,
    HairImportInspection,
    HairImportPreviewRequest
  } from '$lib/components/goons/hair-import/hairImportUiState'
  import UniversalFaceControlsEditor from '$lib/components/goons/UniversalFaceControlsEditor.svelte'
  import EyeContactTuningEditor from '$lib/components/goons/EyeContactTuningEditor.svelte'
  import SocketEyeContactEditor from '$lib/components/goons/SocketEyeContactEditor.svelte'
  import GoonsFieldLabel from '$lib/components/goons/GoonsFieldLabel.svelte'
  import GoonMotionPicker, { type GoonMotionPickerOption } from '$lib/components/goons/GoonMotionPicker.svelte'
  import GoonsRawMorphEditor from '$lib/components/goons/GoonsRawMorphEditor.svelte'
  import SettingsLivePreviewPane from '$lib/components/goons/SettingsLivePreviewPane.svelte'
  import SettingsPreviewViewControls from '$lib/components/goons/SettingsPreviewViewControls.svelte'
  import GoonsDeleteDialogs from '$lib/components/settings/goons/GoonsDeleteDialogs.svelte'
  import GoonsPackDialogs from '$lib/components/settings/goons/GoonsPackDialogs.svelte'
  import GoonsUnsavedExitDialog from '$lib/components/settings/goons/GoonsUnsavedExitDialog.svelte'
  import RecipeWorkflowController from '$lib/components/settings/goons/recipe/RecipeWorkflowController.svelte'
  import { resolveGoonSettingsPreviewTarget } from '$lib/components/settings/goons/recipe/recipeEditorPreviewTarget'
  import type { RecipeFittedPreviewState } from '$lib/components/settings/goons/recipe/types'
  import {
    normalizeGoonCueMap,
    normalizeGoonsSettings,
    resolveKitchenCues,
    resolveGoonCues,
    resolvePreviewAnimationDefinition
  } from '$lib/goons/resolve'
  import {
    BUILTIN_GOON_POSTURES,
    buildCustomPostureId,
    getPostureLabel as resolvePostureLabel,
    isBuiltInPosture,
    listStagePostures,
    mergeImportedCustomPostures,
    normalizeCustomPostureMap,
    resolveStagePostures
  } from '$lib/goons/postures'
  import { applyClosetSelectionChange } from '$lib/goons/closetAssignments'
  import {
    GOON_STAND_POSE_FALLBACK_NAMES,
    buildGoonAnimationLoadPlan,
    buildGoonAnimationPriorityNames,
    filterGoonAnimationFilesForLane,
    groupGoonMotionLibraryEntries,
    resolveGoonAnimationName,
    resolveGoonMotionLane,
    type GoonMotionLane,
    type UnifiedGoonMotionEntry
  } from '$lib/goons/animationLoadPlan'
  import { STARTER_GOON_ASSETS } from '$lib/goons/starterAssets'
  import {
    applyCustomMorphValue,
    getCustomMorphValue as getCustomMorphValueForTargets,
    type CustomMorphDefinition
  } from '$lib/goons/customMorphs'
  import {
    buildUniversalFaceControlModel,
    type UniversalFaceControlDefinition,
    type UniversalFaceControlModel
  } from '$lib/goons/universalFaceControls'
  import {
    normalizeCueFaceSource,
    prepareCueForPortablePack
  } from '$lib/goons/cueFaceProfiles'
  import {
    parseAppearanceDialsManifest,
    reconcileAppearanceDialValues,
    type AppearanceDialValueState,
    type AppearanceDialsManifest
  } from '$lib/goons/appearanceDials'
  import {
    collectFacialArtworkUploads,
    createDefaultFacialArtworkState,
    parseFacialArtworkState,
    reconcileFacialArtworkState,
    resolveFacialArtworkTemplateVariant,
    type FacialArtworkDefinitionV4,
    type FacialArtworkOrientation,
    type FacialArtworkProvenance,
    type FacialArtworkRoleId,
    type FacialArtworkStateV4,
    type FacialArtworkUpload
  } from '$lib/goons/facialArtwork'
  import { restoreFacialArtworkDraft } from '$lib/goons/facialArtwork.editor'
  import { classifyFacialArtworkPackageCapability } from '$lib/goons/facialArtwork.package'
  import {
    createDefaultFacialArtworkUploadCreditDraft,
    type FacialArtworkUploadCreditDraft
  } from '$lib/goons/facialArtwork.provenance'
  import {
    createDefaultEyeAppearanceState,
    parseEyeAppearanceState,
    reconcileEyeAppearanceState,
    type EyeAppearanceDefinitionV3,
    type EyeAppearanceStateV3
  } from '$lib/goons/eyeAppearance'
  import { parseFirstPartySocketEyePackage } from '$lib/goons/socketEyePackage'
  import {
    DEFAULT_SOCKET_EYE_CONTACT_SETTINGS,
    parseSocketEyeContactSettings,
    resolveSocketEyeContactSettings,
    type SocketEyeContactSettingsV2
  } from '$lib/goons/socketEyeContact'
  import {
    countChangedOralAppearanceControls,
    createDefaultOralAppearanceState,
    parseOralAppearanceDefinition,
    parseOralAppearanceState,
    reconcileOralAppearanceState,
    type OralAppearanceDefinitionV1,
    type OralAppearanceStateV1
  } from '$lib/goons/oralAppearance'
  import {
    createLipArtworkPresenceState,
    parseLipArtworkDefinition,
    parseLipArtworkPresenceState,
    parseLipArtworkState,
    reconcileLipArtworkState,
    type LipArtworkDefinitionV2,
    type LipArtworkPresenceStateV1,
    type LipArtworkStateV2,
    type LipArtworkUpload
  } from '$lib/goons/lipArtwork'
  import {
    countChangedNailSurfaceControls,
    createDefaultNailSurfaceState,
    createNailSurfacePresenceState,
    parseNailSurfaceDefinition,
    parseNailSurfacePresenceState,
    parseNailSurfaceState,
    reconcileNailSurfaceState,
    type NailArtworkUploadV1,
    type NailFamily,
    type NailSurfaceDefinitionV1,
    type NailSurfacePresenceStateV1,
    type NailSurfaceStateV1
  } from '$lib/goons/nailSurface'
  import {
    countChangedSkinAppearanceControls,
    createDefaultSkinAppearanceState,
    parseSkinAppearanceDefinition,
    parseSkinAppearanceState,
    reconcileSkinAppearanceState,
    updateSkinAppearanceRegion,
    type SkinAppearanceDefinitionV1,
    type SkinAppearanceRegionId,
    type SkinAppearanceStateV2
  } from '$lib/goons/skinAppearance'
  import {
    collectSkinSurfaceUploads,
    type SkinSurfaceMapRole,
    type SkinSurfaceUploadV1
  } from '$lib/goons/skinSurface'
  import {
    createHairCatalogSelection,
    classifyHairAssetAvailability,
    hairStateEquals,
    loadHairAssetCatalog,
    resolveHairAssetBrowserUrl,
    resolveHairSelectionCatalogStatus,
    type HairAssetCatalog
  } from '$lib/goons/hairCatalog'
  import {
    createHairState,
    parseHairState,
    verifyHairAsset,
    type HairAssetV1,
    type HairRefitSourceV1,
    type HairStateV2
  } from '$lib/goons/hairAssets'
  import type { HairMotionPaintV1 } from '$lib/goons/hairMotionPaint'
  import {
    HAIR_MOTION_DEFAULT_INTENSITY,
    type SecondaryMotionTuning
  } from '$lib/goons/secondaryMotion'
  import {
    cancelHairImport,
    createHairImport,
    createHairRefit,
    deleteHairAssetRevision,
    finalizeHairImport,
    prepareHairImport,
    selectHairImportFiles,
    type HairImportPreparedCandidate
  } from '$lib/services/hairImports'
  import {
    hasRenderableGoonAvatar,
    loadAvatarIntoEngine,
    loadCustomAvatarManifest,
    resolveGoonAvatarSignature,
    resolveGoonAvatarUrl,
    normalizeGoonGlobalEyeContactSettingsMap,
    normalizeGoonEyeContactTuning,
    resolveGoonEyeContactGlobalProfile,
    resolveGoonEyeContactMode,
    resolveGoonEyeContactTuning,
    resolveGoonSourceProfile
  } from '$lib/goons/customAvatar'
  import {
    buildGuidedPieceOriginalClosetSlot,
    parseGuidedPieceOriginalClosetSlot,
    resolveActiveWearableConceal
  } from '$lib/goons/concealRegions'
  import {
    compressPaintedTriangleRanges,
    countPaintedConcealTriangles,
    expandPaintedTriangleRanges,
    normalizePaintedConcealMask
  } from '$lib/goons/paintedConcealMasks'
  import { analyzeGuidedDufClothesFile } from '$lib/goons/guidedDufClothes'
  import {
    buildGuidedOutfitPieceStates,
    isGuidedOutfitPieceSlotManaged,
    resolveGuidedOutfitManagedSlotName,
    resolveGuidedOutfitPieceVisible
  } from '$lib/goons/guidedOutfits'
  import {
    ALL_ORIGINAL_WARDROBE_OUTFIT_ID,
    NO_WARDROBE_OUTFIT_ID,
    buildWardrobeOutfitId,
    cloneWardrobeGuidedPieceStates,
    cloneWardrobeOutfitAssignments,
    normalizeWardrobeOutfitName,
    sanitizeWardrobeOutfits
  } from '$lib/goons/wardrobeOutfits'
  import {
    ROOM_DEFAULT_HEIGHT,
    ROOM_DEFAULT_SIZE,
    ROOM_HEIGHT_PRESET_SPECS,
    ROOM_HEIGHT_PRESET_VALUES,
    ROOM_LOW_CEILING,
    createDefaultRoomSurface,
    createDefaultRoomSurfaceSide,
    normalizeRoomShellBuilder,
    roomHeightToPercent,
    roomHeightToPresetValue,
    roomPresetValueToHeight
  } from '$lib/goons/roomBuilder'
  import {
    GOON_SCENE_AMBIENCE_PLACEMENT_OPTIONS,
    GOON_SCENE_AMBIENCE_PRESET_OPTIONS,
    normalizeGoonSceneAmbience
  } from '$lib/goons/sceneAmbience'
  import { normalizeRoomShellTransform } from '$lib/goons/roomShellTransform'
  import { normalizeRoomCameraBoundary } from '$lib/goons/roomCameraBoundary'
  import {
    DEFAULT_GROUND_PROJECTION_LINE,
    MAX_GROUND_PROJECTION_LINE,
    MIN_GROUND_PROJECTION_LINE,
    normalizeGroundProjectionLine
  } from '$lib/goons/sceneSkybox'
  import {
    applyGoonSceneDefinition,
    buildGoonSceneSignature,
    resolveGoonScenePlacement
  } from '$lib/goons/stageScene'
  import { BUILTIN_TRIM_TEXTURES } from '$lib/goons/roomTextures'
  import type {
    GoonBasePosture,
    GoonRecord,
    GoonCueDefinition,
    GoonCueKind,
    GoonCueMap,
    GoonEmojiMap,
    GoonClosetAssignment,
    GoonClosetItem,
    GoonClosetLibrary,
    GoonEyeContactMode,
    GoonSceneDefinition,
    GoonSceneAmbience,
    GoonSceneAmbiencePlacement,
    GoonSceneAmbiencePreset,
    GoonScenePlacement,
    GoonSceneRoomShellTransform,
    GoonSceneCameraBoundary,
    GoonSceneMap,
    GoonSceneMarker,
    GoonSceneMarkers,
    GoonSceneProp,
    GoonRoomShellBuilder,
    GoonRoomSurface,
    GoonRoomSurfaceSide,
    GoonRoomTextureLibrary,
    GoonRoomTextureKind,
    GoonExpressionPreset,
    GoonExpressionTarget,
    GoonCamera,
    GoonCameraMode,
    GoonEyeContactGlobalProfile,
    GoonGlobalEyeContactSettingsMap,
    GoonFileRef,
    GoonAnimationLibrary,
    GoonGuidedOutfitPiece,
    GoonGuidedOutfitPreset,
    GoonKind,
    GoonClosetOriginalSource,
    GoonWardrobeOutfit,
    GoonPaintedConcealMeshMask,
    GoonPaintedConcealMask,
    GoonMotionMetadata,
    GoonMotionEyeContact,
    GoonMotionPlayback,
    GoonMaterialColorOverride,
    GoonPosture,
    GoonPostureDefinition,
    GoonPostureMap,
    GoonSourceProfile,
    GoonVrmUpdateReport,
    GoonsSettings,
    GoonXWearData,
    GoonFaceControl,
    GoonCueFaceProfiles,
    GoonArkit52ChannelTarget,
    GoonEmoteStep,
    GoonRawMorphTarget,
    ResolvedGoonEyeContactTuning
  } from '$lib/types/goons'
  import {
    type BatshitFaceControlId,
    type FaceControlSection,
    NORMAL_FACE_CONTROL_SECTIONS,
    getSupportedNormalFaceControlSections,
  } from '$lib/goons/faceControls'
  import {
    GOON_SEMANTIC_EXPRESSION_CONTROLS,
    resolveGoonSemanticExpressionControlStates
  } from '$lib/goons/semanticExpressions'
  import type {
    GoonBodyConcealTopology,
    GoonEditTransform,
    GoonEngine,
    GoonEngineQuality,
    GoonRendererRuntime,
    HairImportMotionPaintTopology
  } from '$lib/goons/engine'
  import type { GoonFramingPreset } from '$lib/goons/cameraNavigation'
  import {
    createGoon,
    deleteGoon,
    loadGoons,
    resetRetiredGoonHair,
    loadGoonAnimationLibrary,
    updateGoon as updateGoonRecord,
    persistGoonCamera,
    uploadGoonAnimation,
    deleteGoonAnimation,
    GoonMotionVersionExistsError,
    uploadGoonAnimationToLibrary,
    uploadGoonAnimationToLibraryFile,
    deleteGoonAnimationFromLibrary,
    updateGoonAnimationLibraryMetadata,
    uploadGoonVrm,
    duplicateGoon,
    uploadGoonClosetImage,
    deleteGoonClosetImage,
    uploadGoonSceneSkybox,
    deleteGoonSceneSkybox,
    uploadGoonRoomShell,
    deleteGoonRoomShell,
    uploadGoonSceneProp,
    deleteGoonSceneProp,
    uploadGoonRoomTexture,
    uploadAdvancedGoonPackage,
    uploadGoonFacialArtwork,
    deleteGoonFacialArtwork,
    uploadGoonLipArtwork,
    deleteGoonLipArtwork,
    uploadGoonNailArtwork,
    deleteGoonNailArtwork,
    uploadGoonSkinSurfaceArtwork,
    deleteGoonSkinSurfaceArtwork,
    uploadGuidedDufClothesVrm
  } from '$lib/services/goons'
  import type { AdvancedGoonPackageUploadResult } from '$lib/services/goons'
  import {
    applyRecipeRevisionProjection,
    findRetiredHairRecipeSibling,
    isRecipePreparationRequired,
    projectGoonRecipeSource,
    resolveRecipeAssetUrl,
    resolveRecipeProductReadiness,
    resolveRecipePreviewGoonAssetUrls,
    type RecipeStageResponse,
    type RecipeStateSnapshot
  } from '$lib/goons/recipe'
  import { persistGoonsSettingsRequest } from '$lib/services/goonsSettingsPersistence'
  import {
    importGoonLibraryExportBundle
  } from '$lib/goons/packs'
  import { getGoons } from '$lib/stores/goons.svelte'
  import { getGoonAnimationLibrary } from '$lib/stores/goonAnimationLibrary.svelte'
  import { goonMotionPreviewGenerationActive } from '$lib/stores/goonMotionPreviewGeneration'
  import { getUserSettings, setUserSettings } from '$lib/stores/userSettings.svelte'
  import { logClientError, logClientEvent } from '$lib/services/clientTelemetry'
  import { buildStoredXWear, getPrimaryXWearMaterialName, getXWearMaterials, parseXWearFile } from '$lib/utils/xwear'
  import {
    buildClosetSlotNames,
    deriveAutoShadeHex,
    getDefaultClosetSlotLabel,
    hasMaterialColorOverride,
    isSkinOverlayClosetSlotKey,
    normalizeHexColor,
    resolveClosetRuntimeMaterialName,
    xwearColorToHex
  } from '$lib/goons/closetMaterials'
  import {
    buildCustomClosetDraft,
    createCustomClosetItemFromGlobal,
    createCustomClosetItemFromOriginal,
    buildGoonRecordCustomClosetCleanup,
    resolveEnabledCustomClosetItems,
    type ClosetPickerItem
  } from '$lib/goons/customClosetLibrary'
  import type { IconRef } from '$lib/icons/iconTypes'

  type GoonsUnsavedState = {
    message: string
    saveLabel: string
    onSave: () => Promise<boolean>
    onDiscard: () => void
  }

  type GoonsTopLevelTab = 'goons' | 'closet' | 'kitchen' | 'scenes' | 'motions'
  type ScenePreviewBodyMode = 'proxy' | 'active-goon'
  type SceneProxyPoseId = 'stand' | 'sit'
  type GoonsExitIntent =
    | { type: 'tab'; nextTab: GoonsTopLevelTab }
    | { type: 'close-editor' }
    | { type: 'close-scene' }
  type SaveCueEditorOptions = {
    successMessage?: string | null
    skipRecipeWorkflow?: boolean
  }
  type RecipeWorkflowControllerHandle = {
    saveRecipeDraftIfNeeded: () => Promise<boolean>
  }
  type RecipeEditorPreviewTarget = {
    goon: GoonRecord
    state: RecipeStateSnapshot
    preview: RecipeFittedPreviewState
    side: 'current' | 'updated'
  }
  type GoonPreviewMode = 'editor' | 'library' | 'recipe-live-candidate'
  const MOTION_LIBRARY_PREVIEW_GOON_ID = '__motion_library_preview__'
  const SCENE_PROXY_PREVIEW_GOON_ID = '__scene_proxy_preview__'

  type GuidedDufOverlayDraft = NonNullable<
    NonNullable<GoonRecord['guidedAvatar']>['dufOverlays']
  >[number]

  type PaintedConcealEditorTarget =
    | { kind: 'closet-item'; itemId: string; slotName?: string }
    | { kind: 'slot-original'; slotName: string }
    | { kind: 'guided-piece-original'; pieceId: string }

  type PaintedConcealPoseId = 't-pose' | 'floating-pose' | 'sitting-pose'
  type PaintedConcealPoseOption = {
    id: PaintedConcealPoseId
    label: string
    animationName: string
    file: GoonFileRef
  }
  type GoonFormatIcon = {
    label: string
    ref: IconRef
    wide?: boolean
  }
  type GoonFormatVisual = {
    label: string
    icons: GoonFormatIcon[]
  }

  const VRM_ICON_REF = { kind: 'brand', slug: 'vrm-color' } satisfies IconRef
  const VROID_ICON_REF = { kind: 'brand', slug: 'vroid-color' } satisfies IconRef
  const BLENDER_ICON_REF = { kind: 'brand', slug: 'blender-color' } satisfies IconRef
  const BATSHIT_BRAND_ICON_REF = { kind: 'brand', slug: 'batshit-icon' } satisfies IconRef
  const GLB_FILE_ICON_REF = { kind: 'lucide', id: 'file-axis-3d' } satisfies IconRef
  const STANDARD_GOON_FORMAT = {
    label: 'Standard/VRoid',
    icons: [
      { label: 'VRoid', ref: VROID_ICON_REF },
      { label: 'VRM', ref: VRM_ICON_REF, wide: true }
    ]
  } satisfies GoonFormatVisual
  const ADVANCED_BLENDER_GOON_FORMAT = {
    label: 'Advanced/Blender',
    icons: [
      { label: 'Blender', ref: BLENDER_ICON_REF },
      { label: 'VRM', ref: VRM_ICON_REF, wide: true }
    ]
  } satisfies GoonFormatVisual
  const ADVANCED_GLB_GOON_FORMAT: GoonFormatVisual = {
    label: 'Advanced/GLB',
    icons: [
      { label: 'Batshit', ref: BATSHIT_BRAND_ICON_REF },
      { label: 'GLB', ref: GLB_FILE_ICON_REF }
    ]
  }

  const PAINTED_CONCEAL_POSES: PaintedConcealPoseOption[] = [
    {
      id: 't-pose',
      label: 'T-Pose',
      animationName: 'batshit-brush-t-pose',
      file: {
        url: '/goons/brush-poses/brush-t-pose.vrma',
        filename: 'batshit-brush-t-pose.vrma',
        originalName: 'batshit-brush-t-pose.vrma',
        size: 36249,
        mimeType: 'model/vrm',
        motionMeta: { posture: 'stand', playback: 'oneshot' }
      }
    },
    {
      id: 'floating-pose',
      label: 'Floating',
      animationName: 'batshit-brush-floating-pose',
      file: {
        url: '/goons/brush-poses/brush-floating-pose.vrma',
        filename: 'batshit-brush-floating-pose.vrma',
        originalName: 'batshit-brush-floating-pose.vrma',
        size: 57732,
        mimeType: 'model/vrm',
        motionMeta: { posture: 'stand', playback: 'oneshot' }
      }
    },
    {
      id: 'sitting-pose',
      label: 'Sitting',
      animationName: 'batshit-brush-sitting-pose',
      file: {
        url: '/goons/brush-poses/brush-sitting-pose.vrma',
        filename: 'batshit-brush-sitting-pose.vrma',
        originalName: 'batshit-brush-sitting-pose.vrma',
        size: 57732,
        mimeType: 'model/vrm',
        motionMeta: { posture: 'sit', playback: 'oneshot' }
      }
    }
  ]
  const PAINTED_CONCEAL_POSE_FILES = PAINTED_CONCEAL_POSES.map((pose) => pose.file)
  const PAINTED_CONCEAL_POSE_ANIMATION_NAMES = new Set(
    PAINTED_CONCEAL_POSES.map((pose) => pose.animationName)
  )
  const DEFAULT_PAINTED_CONCEAL_POSE = PAINTED_CONCEAL_POSES[0]!

  type LegacyConcealRegionItem = GoonClosetItem & {
    concealRegions?: unknown
  }

  type Props = {
    active?: boolean
    onUnsavedStateChange?: (state: GoonsUnsavedState | null) => void
  }

  let { active = false, onUnsavedStateChange = () => {} }: Props = $props()

  let uploadFile = $state<File | null>(null)
  let uploadInput = $state<HTMLInputElement | null>(null)
  let uploadBusy = $state(false)
  let guidedUploadFile = $state<File | null>(null)
  let guidedUploadInput = $state<HTMLInputElement | null>(null)
  let guidedUploadBusy = $state(false)
  let customUploadFile = $state<File | null>(null)
  let customUploadInput = $state<HTMLInputElement | null>(null)
  let customUploadBusy = $state(false)

  type FbxInstallPlatform = 'darwin-x64' | 'linux-x64' | 'windows-x64'
  type FbxInstallStatus = {
    installed: boolean
    supportLevel?: 'native-managed' | 'docker-deferred' | 'docker-worker' | 'docker-worker-missing'
    dockerUnsupported?: boolean
    reason?: string | null
    defaultPlatform?: FbxInstallPlatform
    manifest?: {
      platform?: FbxInstallPlatform
      version?: string
      binaryName?: string
      installedAt?: string
    } | null
    worker?: {
      running: boolean
      url: string
      checkedAt: string
      error: string | null
      health?: {
        version?: string
        fbx2gltfVersion?: string
      } | null
    } | null
  }
  type PackCueScope = 'global' | 'goon'
  type PackCueExportOption = {
    key: string
    kind: 'mood' | 'emote'
    cue: GoonCueDefinition
    emojis: string[]
    scope: PackCueScope
    sourceGoonId?: string
    sourceGoonName?: string
    motionFile: GoonFileRef | null
  }
  type FacePreviewSelection = {
    cueName: string
    stepIndex: number | null
  }
  type FacePreviewScope = 'editor' | 'kitchen'
  type PackCueGroup = {
    key: string
    label: string
    moods: PackCueExportOption[]
    emotes: PackCueExportOption[]
  }
  type PackSceneExportOption = {
    key: string
    sceneId: string
    scene: GoonSceneDefinition
  }
  // One export option per unified motion — selecting it bundles every format
  // version (.vrma + .glb) of that motion into the pack.
  type PackMotionExportOption = {
    key: string
    files: GoonFileRef[]
    label: string
  }
  type PortablePackCueEntry = {
    cue: GoonCueDefinition
    emojis: string[]
    scope: PackCueScope
    sourceGoonId?: string
    sourceGoonName?: string
    motion?: GoonFileRef | null
  }
  type PortablePackManifest = {
    version: 6
    exportedAt: string
    name: string
    postures: GoonPostureDefinition[]
    motions?: GoonFileRef[]
    moods: PortablePackCueEntry[]
    emotes: PortablePackCueEntry[]
    scenes: GoonSceneDefinition[]
  }
  type PendingImportPack = {
    manifest: PortablePackManifest
    entries: Record<string, Uint8Array>
    fileName: string
  }
  type SceneAssetKind = 'skybox' | 'roomShell'
  type SceneAssetUploadTarget =
    | { session: number; mode: 'create' }
    | { session: number; mode: 'edit'; sceneId: string }
  type MotionAccordionItem = {
    id: string
    postureId: GoonPosture | ''
    name: string
    basePosture: GoonBasePosture | null
    builtIn: boolean
    editable: boolean
    usageSummary: string
    entries: UnifiedGoonMotionEntry[]
  }

  const ANY_POSTURE_BUCKET = '__any_posture__'
  type GoonAnimationSource = 'vrm' | 'goon' | 'vrma'
  type AnimationTagFilterMode = 'all' | 'untagged' | 'tags'

  let animationUploadFile = $state<File | null>(null)
  let animationUploadInput = $state<HTMLInputElement | null>(null)
  let animationUploadBusy = $state(false)
  let libraryUploadFiles = $state<File[]>([])
  let libraryUploadInput = $state<HTMLInputElement | null>(null)
  let libraryUploadBusy = $state(false)
  let libraryUploadTotal = $state(0)
  let libraryUploadDone = $state(0)
  let fbxInstallStatus = $state<FbxInstallStatus | null>(null)
  let fbxInstallBusy = $state(false)
  let starterImportBusy = $state<Record<string, boolean>>({})

  let activeTab = $state<GoonsTopLevelTab>('goons')

  let editorGoonId = $state<string | null>(null)
  let sceneEditorMode = $state<'create' | 'edit' | null>(null)
  let sceneEditorId = $state<string | null>(null)
  let editorName = $state('')
  let editorDescription = $state('')
  let editorCueMap = $state<GoonCueMap>({})
  let editorEnabledCueNames = $state<string[]>([])
  let editorEmojiMap = $state<GoonEmojiMap>({})
  let editorBaseLoop = $state('base_stand')
  let editorSceneId = $state('')
  let editorQuality = $state<GoonEngineQuality>('auto')
  let editorLipSync = $state(true)
  let editorEyeContactMode = $state<GoonEyeContactMode>('bone')
  let editorSocketEyeContact = $state<SocketEyeContactSettingsV2>({
    ...DEFAULT_SOCKET_EYE_CONTACT_SETTINGS
  })
  let editorHasSocketEyeContact = $state(false)
  let editorEyeContactEyeYawSensitivity = $state(1)
  let editorEyeContactEyeYawRange = $state(1)
  let editorEyeContactEyePitchSensitivity = $state(1)
  let editorEyeContactEyePitchRange = $state(1)
  let editorEyeContactHeadYawStartOutDeg = $state(14)
  let editorEyeContactHeadYawStartInDeg = $state(52)
  let editorEyeContactHeadYawSensitivity = $state(1)
  let editorEyeContactHeadYawRange = $state(1)
  let editorEyeContactHeadYawSpeed = $state(1)
  let editorEyeContactHeadPitchStartOutDeg = $state(8)
  let editorEyeContactHeadPitchStartInDeg = $state(22)
  let editorEyeContactHeadPitchSensitivity = $state(1)
  let editorEyeContactHeadPitchRange = $state(1)
  let editorEyeContactHeadPitchSpeed = $state(1)
  let editorEyeContactEyeYawHeadCompensation = $state(1)
  let editorEyeContactEyePitchHeadCompensation = $state(1)
  // Deliberately non-reactive. OrbitControls owns the mounted live camera;
  // turning every settled movement into Svelte state invalidates this very
  // large editor even though no rendered control reads the camera object.
  let editorCamera: GoonCamera = {}
  let editorDirty = $state(false)
  let editorSaving = $state(false)
  let editorFacialArtworkUploadBusy = $state(false)
  let editorFacialArtworkCreditDraft = $state<FacialArtworkUploadCreditDraft>(
    createDefaultFacialArtworkUploadCreditDraft()
  )
  let updateVrmInput = $state<HTMLInputElement | null>(null)
  let updateVrmFile = $state<File | null>(null)
  let updateVrmBusy = $state(false)
  let advancedPackageUpdateInput = $state<HTMLInputElement | null>(null)
  let advancedPackageUpdateFile = $state<File | null>(null)
  let advancedPackageUpdateBusy = $state(false)
  let editorPendingAdvancedPackageUpdate = $state<AdvancedGoonPackageUploadResult | null>(null)
  let recipeWorkflowController = $state<RecipeWorkflowControllerHandle | null>(null)
  let recipeWorkflowBusy = $state(false)
  let retiredHairRecoveryBusy = $state(false)
  let recipeEditorPreviewTarget = $state<RecipeEditorPreviewTarget | null>(null)
  let recipeEditorDraftPreview = $state<RecipeFittedPreviewState | null>(null)
  let recipePreviewTransitioning = $state(false)
  let guidedDufClothesInput = $state<HTMLInputElement | null>(null)
  let guidedDufClothesBusy = $state(false)
  let editorPendingVrmFile = $state<GoonFileRef | null>(null)
  let editorPendingVrmUpdate = $state<GoonVrmUpdateReport | null>(null)
  let editorGuidedOutfitPiecesDraft = $state<GoonGuidedOutfitPiece[]>([])
  let editorGuidedDufOverlays = $state<GuidedDufOverlayDraft[]>([])
  let editorGuidedPieceStates = $state<Record<string, boolean>>({})
  let editorGuidedActivePresetId = $state<string | null>(null)
  let editorWardrobeOutfits = $state<Record<string, GoonWardrobeOutfit>>({})
  let editorActiveWardrobeOutfitId = $state<string | null>(null)
  let newWardrobeOutfitName = $state('')
  let editorWardrobeOutfitCreateOpen = $state(false)
  let duplicateGoonBusyId = $state<string | null>(null)
  let kitchenCueMap = $state<GoonCueMap>({})
  let kitchenEmojiMap = $state<GoonEmojiMap>({})
  let kitchenEyeContactOpen = $state(false)
  let kitchenEyeContactProfile = $state<GoonEyeContactGlobalProfile>('vroid')
  let kitchenEyeContactVroidMode = $state<GoonEyeContactMode>('bone')
  let kitchenEyeContactBlenderMode = $state<GoonEyeContactMode>('expression')
  let kitchenEyeContactVroidTuning = $state<ResolvedGoonEyeContactTuning>(
    normalizeGoonEyeContactTuning(null)
  )
  let kitchenEyeContactBlenderTuning = $state<ResolvedGoonEyeContactTuning>(
    normalizeGoonEyeContactTuning(null)
  )
  let globalCloset = $state<GoonClosetLibrary>({ items: {} })
  let kitchenRoomTextures = $state<GoonRoomTextureLibrary>({})
  let kitchenScenes = $state<GoonSceneMap>({})
  let kitchenDirty = $state(false)
  let kitchenSaving = $state(false)
  let closetDirty = $state(false)
  let closetSaving = $state(false)
  let motionsCustomPostures = $state<GoonPostureMap>({})
  let motionsSaving = $state(false)
  let motionsHydrated = $state(false)
  let motionsAppliedSourceSignature = $state('')
  let sceneDirty = $state(false)
  let sceneSaving = $state(false)
  let openMotionPostureId = $state<string | null>(null)
  let editingMotionPostureId = $state<string | null>(null)
  let newEmoteEmoji = $state('')
  let newMoodName = $state('')
  let newEmoteName = $state('')
  let kitchenAddMoodOpen = $state(false)
  let kitchenAddEmoteOpen = $state(false)
  let editorAddMoodOpen = $state(false)
  let editorAddEmoteOpen = $state(false)
  let editorDescriptionEditorOpen = $state(false)
  let editorBasicSettingsOpen = $state(false)
  let editorEyeContactOpen = $state(false)
  let editorCustomGoonBuilderOpen = $state(false)
  let editorHairOpen = $state(false)
  let editorVrmSectionOpen = $state(false)
  let editorAnimationsSectionOpen = $state(false)
  let editorClosetOpen = $state(false)
  let editorCustomClosetOpen = $state(false)
  let editorWardrobeColorEditorKey = $state<string | null>(null)
  let editorDeleteGoonOpen = $state(false)
  let disabledMoodsOpen = $state(false)
  let disabledEmotesOpen = $state(false)
  let newSceneName = $state('')
  let newSceneDescription = $state('')
  let newSceneSkybox = $state<GoonFileRef | null>(null)
  let newSceneRoomShell = $state<GoonFileRef | null>(null)
  let newScenePlacement = $state<GoonScenePlacement>('elevated')
  let newSceneGroundProjectionLine = $state(DEFAULT_GROUND_PROJECTION_LINE)
  let newSceneRoomShellTransform = $state(normalizeRoomShellTransform())
  let newSceneAmbience = $state(normalizeGoonSceneAmbience())
  let sceneUploadInput = $state<HTMLInputElement | null>(null)
  let sceneRoomShellInput = $state<HTMLInputElement | null>(null)
  let scenePropInput = $state<HTMLInputElement | null>(null)
  let roomTextureInput = $state<HTMLInputElement | null>(null)
  let hairAssets = $state<HairAssetV1[]>([])
  let hairRefitSources = $state<HairRefitSourceV1[]>([])
  let hairCatalogLoaded = $state(false)
  let hairCatalogLoading = $state(false)
  let hairCatalogError = $state<string | null>(null)
  let editorHairState = $state<HairStateV2>(createHairState(null))
  let editorHairStateError = $state<string | null>(null)
  let hairPreviewBusy = $state(false)
  let hairPreviewError = $state<string | null>(null)
  let editorHairImportOpen = $state(false)
  let hairImportInitialFile = $state<File | null>(null)
  let hairImportInitialCalibrationFile = $state<File | null>(null)
  let hairImportInitialInspection = $state<HairImportInspection | null>(null)
  let hairImportRefitAsset = $state<HairAssetV1 | null>(null)
  let hairImportRefitSource = $state<HairRefitSourceV1 | null>(null)
  let editorScrollElement = $state<HTMLElement | null>(null)
  let hairImportWizardElement = $state<HTMLElement | null>(null)
  let hairImportCandidate = $state<HairImportPreparedCandidate | null>(null)
  let hairImportFileName = $state('')
  let hairImportOriginalState = $state<HairStateV2 | null>(null)
  let hairImportOriginalDials = $state<AppearanceDialValueState | null>(null)
  let hairImportOriginalCamera = $state<GoonCamera | null>(null)
  let hairMotionPaintEditorOpen = $state(false)
  let hairMotionPaintTopology = $state<HairImportMotionPaintTopology | null>(null)
  let hairMotionPaintInitial = $state<HairMotionPaintV1 | null>(null)
  let hairMotionPaintResolver: ((paint: HairMotionPaintV1 | null) => void) | null = null
  let editorHairMotionTuning = $state<SecondaryMotionTuning>({
    enabled: true,
    intensity: HAIR_MOTION_DEFAULT_INTENSITY
  })
  let hairCatalogPromise: Promise<HairAssetCatalog> | null = null
  let editorHairHydrationGoonId = ''
  let editorHairStoredSignature = ''
  let sceneUploadBusy = $state(false)
  let sceneRoomShellBusy = $state(false)
  let scenePropBusy = $state(false)
  let roomTextureBusy = $state(false)
  let sceneUploadTargetId = $state<string | null>(null)
  let sceneSkyboxUploadTarget: SceneAssetUploadTarget | null = null
  let sceneRoomShellTargetId = $state<string | null>(null)
  let sceneRoomShellUploadTarget: SceneAssetUploadTarget | null = null
  let sceneEditorSession = 0
  const draftSceneAssetUploadFilenames: Record<SceneAssetKind, Set<string>> = {
    skybox: new Set<string>(),
    roomShell: new Set<string>()
  }
  let scenePropTargetId = $state<string | null>(null)
  let roomTextureTargetKind = $state<GoonRoomTextureKind>('floor')
  let activeSceneEdit = $state<
    | {
        type: 'prop'
        sceneId: string
        propId: string
      }
    | {
        type: 'marker'
        sceneId: string
        posture: GoonPosture
        markerId: string
      }
    | null
  >(null)
  let sceneEditMode = $state<'translate' | 'rotate' | 'scale'>('translate')
  let scenePropScaleLock = $state(true)
  let activeSceneEditTransform = $state<GoonEditTransform | null>(null)
  let activeMarkerVerticalOffset = $state(0)
  let activeMarkerRestore = $state<GoonSceneMarker | null>(null)
  let activeMarkerWasNew = $state(false)
  let closetXWearInput = $state<HTMLInputElement | null>(null)
  let closetXWearBusy = $state(false)
  let closetCategoryFilter = $state('all')
  let closetSearchQuery = $state('')
  let editorClosetItems = $state<Record<string, GoonClosetItem>>({})
  let closetDeleteConfirmOpen = $state(false)
  let closetPendingDelete = $state<GoonClosetItem | null>(null)
  let closetDeleteBusyId = $state<string | null>(null)
  let editingClosetItemId = $state<string | null>(null)
  let editingClosetItemNameDraft = $state('')
  let paintedConcealEditorOpen = $state(false)
  let paintedConcealTarget = $state<PaintedConcealEditorTarget | null>(null)
  let paintedConcealTopology = $state<GoonBodyConcealTopology | null>(null)
  let paintedConcealDraftTriangles = $state<Record<string, number[]>>({})
  let paintedConcealHistory = $state<Array<Record<string, number[]>>>([])
  let paintedConcealTool = $state<'paint' | 'erase'>('paint')
  let paintedConcealBrushRadius = $state(18)
  let paintedConcealMirrorX = $state(false)
  let paintedConcealPoseId = $state<PaintedConcealPoseId>('t-pose')
  let paintedConcealPainting = $state(false)
  let paintedConcealPointerId = $state<number | null>(null)
  let paintedConcealPointerCaptureElement: HTMLElement | null = null
  let paintedConcealStatus = $state<string | null>(null)
  let paintedConcealShiftHeld = $state(false)
  let paintedConcealPointerInPreview = $state(false)
  let paintedConcealPointerX = $state(0)
  let paintedConcealPointerY = $state(0)
  let closetItemSlotOverflow = $state<Record<string, boolean>>({})
  let closetItemCategoryOverflow = $state<Record<string, boolean>>({})
  let moodsOpen = $state(false)
  let emotesOpen = $state(false)
  let sceneWorldOpen = $state(false)
  let roomBuilderOpen = $state(false)
  let roomBuilderSurfaceOpen = $state<
    'floor' | 'ceiling' | 'north' | 'south' | 'east' | 'west' | null
  >(null)
  let scenePropsOpen = $state(false)
  let sceneMarkersOpen = $state(false)
  let openMoodName = $state<string | null>(null)
  let openEmoteName = $state<string | null>(null)
  let editorFacePreviewSelection = $state<FacePreviewSelection | null>(null)
  let kitchenFacePreviewSelection = $state<FacePreviewSelection | null>(null)
  let editorFacePreviewSuspended = $state(false)
  let kitchenFacePreviewSuspended = $state(false)
  let kitchenCueNameDrafts = $state<Record<string, string>>({})
  let editorCueNameDrafts = $state<Record<string, string>>({})
  let kitchenEmoteEmojiDrafts = $state<Record<string, string>>({})
  let editorEmoteEmojiDrafts = $state<Record<string, string>>({})
  let previewAnimationName = $state('')
  let previewAnimationActive = $state(false)
  let previewAnimationRestore = $state<{ name: string; definition?: GoonCueDefinition | null } | null>(null)
  let activePreviewId = $state<string | null>(null)
  let motionLibraryPreviewName = $state('')
  let motionLibraryPreviewLoading = $state(false)
  let motionLibraryPreviewError = $state<string | null>(null)
  let motionLibraryPreviewSignature = $state('')
  let motionLibraryPreviewRequestId = 0
  let previewAnimationCatalog = $state<Array<{ name: string; source: 'vrm' | 'goon' | 'vrma' }>>([])
  let previewMaterialNames = $state<string[]>([])
  let previewMaterialColorInfo = $state<
    Record<string, { baseHex?: string; shadeHex?: string; emissiveHex?: string; outlineHex?: string }>
  >({})
  let previewCustomExpressions = $state<string[]>([])
  let closetAssignments = $state<Record<string, GoonClosetAssignment>>({})
  let closetBusy = $state(false)
  let previewContainer = $state<HTMLDivElement | null>(null)
  let previewEngine = $state<GoonEngine | null>(null)
  let previewHost = $state<HTMLDivElement | null>(null)
  let previewEngineInitPromise: Promise<GoonEngine | null> | null = null
  let previewLoading = $state(false)
  let previewReady = $state(false)
  let previewError = $state<string | null>(null)
  let previewRuntimeStatus = $state<GoonRendererRuntime | null>(null)
  let previewGoonId = $state<string | null>(null)
  let previewToken = 0
  let pendingEditorOpeningFrameGoonId: string | null = null
  let previewAnimationSignature = $state('')
  let previewBaseLoopSignature = $state('')
  let previewContextSignature = $state('')
  let previewFailedContextSignature = $state('')
  let previewSceneSignature = $state('none')
  let previewLoadInFlightSignature = $state('')
  let previewVrmUrl = $state('')
  let previewSkyboxOffset = $state(0)
  const DEFAULT_PREVIEW_VIEW_FOV = 50
  const MIN_PREVIEW_VIEW_FOV = 15
  const MAX_PREVIEW_VIEW_FOV = 100
  const EDITOR_OPENING_FRAME_PRESET: GoonFramingPreset = 'portrait'
  let previewViewFov = $state(DEFAULT_PREVIEW_VIEW_FOV)
  let previewCameraMode = $state<GoonCameraMode>('free')
  let kitchenPreviewContainer = $state<HTMLDivElement | null>(null)
  let kitchenPreviewEngine = $state<GoonEngine | null>(null)
  let kitchenPreviewLoading = $state(false)
  let kitchenPreviewReady = $state(false)
  let kitchenPreviewError = $state<string | null>(null)
  let kitchenPreviewRuntimeStatus = $state<GoonRendererRuntime | null>(null)
  let kitchenPreviewGoonId = $state<string | null>(null)
  let kitchenPreviewSceneId = $state<string | null>(null)
  let kitchenPreviewLoadQueue: Promise<void> = Promise.resolve()
  let kitchenPreviewLoadRequestId = 0
  let kitchenPreviewVrmUrl = $state('')
  let kitchenPreviewHost = $state<HTMLDivElement | null>(null)
  let kitchenPreviewEngineInitPromise: Promise<GoonEngine | null> | null = null
  let kitchenPreviewLoadedEngine: GoonEngine | null = null
  let kitchenPreviewLoadedGoonId = $state<string | null>(null)
  let scenePreviewBodyMode = $state<ScenePreviewBodyMode>('proxy')
  let sceneProxyPoseId = $state<SceneProxyPoseId>('stand')
  let kitchenPreviewAnimationName = $state('')
  let kitchenPreviewAnimationActive = $state(false)
  let kitchenPreviewAnimationRestore = $state<{ name: string; definition?: GoonCueDefinition | null } | null>(null)
  let kitchenPreviewAnimationCatalog = $state<
    Array<{ name: string; source: 'vrm' | 'goon' | 'vrma' }>
  >([])
  let kitchenPreviewCustomExpressions = $state<string[]>([])
  let kitchenPreviewAnimationSignature = $state('')
  let kitchenPreviewBaseLoopSignature = $state('')
  let kitchenPreviewSceneSignature = $state('none')
  let kitchenPreviewClosetSignature = $state('')
  let kitchenPreviewQuality = $state<GoonEngineQuality>('auto')
  let editorFacePreviewResumeTimer: ReturnType<typeof setTimeout> | null = null
  let kitchenFacePreviewResumeTimer: ReturnType<typeof setTimeout> | null = null
  let editorFacePreviewResumeToken = 0
  let kitchenFacePreviewResumeToken = 0
  let goonDockPauseActive = false
  const GOON_DOCK_PAUSE_SOURCE = 'goons-settings-preview'
  const TRANSPARENT_TEXTURE_URL =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII='
  const ANIMATION_SORT_OPTIONS = [
    { value: 'alpha', label: 'Alphabetical' },
    { value: 'newest', label: 'Newest first' },
    { value: 'oldest', label: 'Oldest first' }
  ] as const
  const ROOM_SURFACE_FIT_OPTIONS = [
    { value: 'tile', label: 'Repeat' },
    { value: 'stretch', label: 'Single Fit' }
  ] as const
  const ROOM_TRANSPARENCY_OPTIONS = [
    { value: 'opaque', label: 'Opaque' },
    { value: 'cutout', label: 'Cutout (windows)' },
    { value: 'glass', label: 'Glass' }
  ] as const
  const ROOM_WALL_LABELS: Array<{ key: 'north' | 'south' | 'east' | 'west'; label: string }> = [
    { key: 'north', label: 'North Wall' },
    { key: 'south', label: 'South Wall' },
    { key: 'east', label: 'East Wall' },
    { key: 'west', label: 'West Wall' }
  ]
  const EMOJI_REGEX = /\p{Extended_Pictographic}/gu
  const EMOJI_TEST_REGEX = /\p{Extended_Pictographic}/u
  const EMOJI_MODIFIER_REGEX = /\p{Emoji_Modifier}/gu
  const EMOJI_VARIATION_REGEX = /[\uFE0E\uFE0F]/g
  const ROOM_TEXTURE_KIND_OPTIONS: Array<{ value: GoonRoomTextureKind; label: string }> = [
    { value: 'wall', label: 'Wall (interior)' },
    { value: 'floor', label: 'Floor' },
    { value: 'ceiling', label: 'Ceiling' },
    { value: 'exterior', label: 'Exterior (outside)' },
    { value: 'trim', label: 'Trim (window edges)' }
  ]
  const PROP_TRIANGLE_WARN = 50000
  const PROP_TRIANGLE_LIMIT = 250000
  const SHELL_TRIANGLE_WARN = 200000
  const SHELL_TRIANGLE_LIMIT = 1000000
  const STUNT_DUMMY_VRM_URL = '/goons/stunt-dummy.vrm'
  let animationSortMode = $state<'alpha' | 'newest' | 'oldest'>('alpha')
  let animationTagFilterMode = $state<AnimationTagFilterMode>('all')
  let animationTagFilters = $state<string[]>([])
  let animationDisplayNameInputs = $state<Record<string, string>>({})
  let animationTagInputs = $state<Record<string, string>>({})
  let animationPostureInputs = $state<Record<string, GoonPosture | ''>>({})
  let animationPlaybackInputs = $state<Record<string, GoonMotionPlayback | ''>>({})
  let animationEyeContactInputs = $state<Record<string, GoonMotionEyeContact | ''>>({})
  let activeAnimationTagMenu = $state<string | null>(null)
  let newAnimationTagDraft = $state('')
  let deletedMotionPostureBaseMap = $state<Record<string, GoonBasePosture>>({})
  let postureNameInputs = $state<Record<string, string>>({})
  let postureBaseInputs = $state<Record<string, GoonBasePosture>>({})
  let libraryImportInput = $state<HTMLInputElement | null>(null)
  let libraryImportBusy = $state(false)
  let exportPackDialogOpen = $state(false)
  let exportPackBusy = $state(false)
  let exportPackSelections = $state<Record<string, boolean>>({})
  let importPackPreviewOpen = $state(false)
  let pendingImportPack = $state<PendingImportPack | null>(null)
  let deleteConfirmOpen = $state(false)
  let goonPendingDelete = $state<GoonRecord | null>(null)
  let sceneDeleteConfirmOpen = $state(false)
  let scenePendingDelete = $state<GoonSceneDefinition | null>(null)
  let previewWidth = $state(360)
  let previewResizing = $state(false)
  let mainSettingsShellEl = $state<HTMLDivElement | null>(null)
  let editorShellEl = $state<HTMLDivElement | null>(null)
  let sceneShellEl = $state<HTMLDivElement | null>(null)
  let previewWidthContext = $state<'main' | 'editor' | 'scene' | null>(null)
  let previewWidthNeedsInit = $state(false)
  let settingsPreviewEyeContactEnabled = $state(true)
  let libraryPreviewGoonId = $state<string | null>(null)
  let unsavedExitDialogOpen = $state(false)
  let pendingExitIntent = $state<GoonsExitIntent | null>(null)
  let GoonEngineCtor: typeof import('$lib/goons/engine').GoonEngine | null = null

  const goonAccordionHeaderClass =
    'batshit-settings-collapsible-trigger w-full text-left'
  const goonLevel1AccordionClass =
    'goon-level-1-accordion batshit-settings-accordion-card'
  const goonLevel1AccordionHeaderClass =
    'goon-level-1-accordion-header batshit-settings-accordion-card-header'
  const goonLevel1AccordionContentClass =
    'goon-level-1-accordion-content batshit-settings-accordion-card-content'
  const goonLevel2AccordionListClass = 'goon-level-2-accordion-list'
  const goonLevel2AccordionClass = 'goon-level-2-accordion'
  const goonLevel2AccordionHeaderClass =
    'goon-level-2-accordion-header flex w-full items-center justify-between text-left'
  const goonLevel2AccordionContentClass = 'goon-level-2-accordion-content'
  const goonLevel2CueContentClass =
    'goon-level-2-accordion-content batshit-goon-cue-content'
  const goonDashedAccordionTriggerClass =
    'batshit-settings-collapsible-trigger flex w-full items-center justify-between rounded-md border border-dashed px-3 py-2 text-left'

  const userSettings = $derived(getUserSettings())
  const goonsSettings = $derived.by(() => normalizeGoonsSettings(userSettings?.goons_settings ?? null))
  const stagePostureMap = $derived.by(() => resolveStagePostures(goonsSettings))
  const stagePostureOptions = $derived.by(() => listStagePostures(goonsSettings))
  const motionCustomPostureDraftMap = $derived.by(() => {
    const next: GoonPostureMap = {}
    for (const [postureId, posture] of Object.entries(motionsCustomPostures ?? {})) {
      if (!posture || isBuiltInPosture(postureId)) continue
      const name = normalizePostureName(postureNameInputs[postureId] ?? posture.name)
      const basePosture = postureBaseInputs[postureId] ?? posture.basePosture
      next[postureId] = {
        ...posture,
        id: postureId,
        name,
        basePosture: isBuiltInPosture(basePosture) ? basePosture : 'stand'
      }
    }
    return next
  })
  const motionStagePostureMap = $derived.by(() => ({
    ...BUILTIN_GOON_POSTURES,
    ...motionCustomPostureDraftMap
  }))
  const motionStagePostureOptions = $derived.by(() => {
    const builtIns = Object.values(motionStagePostureMap).filter((posture) => posture.builtIn)
    const custom = Object.values(motionStagePostureMap)
      .filter((posture) => !posture.builtIn)
      .sort((left, right) => left.name.localeCompare(right.name))
    return [...builtIns, ...custom]
  })
  const motionCustomStagePostureOptions = $derived.by(() =>
    motionStagePostureOptions.filter((posture) => !posture.builtIn)
  )
  const markerPostures = $derived.by(() =>
    stagePostureOptions.filter((posture) => posture.id !== 'stand').map((posture) => posture.id)
  )
  const goons = $derived(getGoons())
  const animationLibrary = $derived(getGoonAnimationLibrary())
  const vrmaLibrary = $derived.by(() =>
    Array.isArray(animationLibrary?.vrma) ? [...animationLibrary.vrma] : []
  )
  // Unified motion library: one entry per animation name, holding every
  // format version (.vrma / .glb). Metadata reads come from the entry's
  // winner file; staged edits go to every version so pairs stay in lockstep.
  const motionLibraryEntries = $derived.by(() => groupGoonMotionLibraryEntries(vrmaLibrary))
  const sortedMotionEntries = $derived.by(() => {
    const entries = [...motionLibraryEntries]
    const compareAlpha = (a: UnifiedGoonMotionEntry, b: UnifiedGoonMotionEntry) =>
      resolveMotionDisplayName(a.primary).localeCompare(resolveMotionDisplayName(b.primary))
    if (animationSortMode === 'newest') {
      return entries.sort((a, b) => {
        const delta = resolveMotionEntryUploadTime(b) - resolveMotionEntryUploadTime(a)
        return delta !== 0 ? delta : compareAlpha(a, b)
      })
    }
    if (animationSortMode === 'oldest') {
      return entries.sort((a, b) => {
        const delta = resolveMotionEntryUploadTime(a) - resolveMotionEntryUploadTime(b)
        return delta !== 0 ? delta : compareAlpha(a, b)
      })
    }
    return entries.sort(compareAlpha)
  })
  const animationTagOptions = $derived.by(() => {
    const tags = new Set<string>()
    for (const entry of sortedMotionEntries) {
      for (const tag of resolveMotionEntryStagedTags(entry)) {
        if (tag) tags.add(tag)
      }
    }
    return Array.from(tags).sort()
  })
  const untaggedCount = $derived.by(
    () =>
      sortedMotionEntries.filter((entry) => resolveMotionEntryStagedTags(entry).length === 0)
        .length
  )
  const animationSortLabel = $derived.by(
    () => ANIMATION_SORT_OPTIONS.find((option) => option.value === animationSortMode)?.label ?? 'Sort'
  )
  const animationTagFilteringActive = $derived.by(() => animationTagFilterMode !== 'all')
  const filteredMotionEntries = $derived.by(() => {
    if (animationTagFilterMode === 'all') {
      return sortedMotionEntries
    }
    if (animationTagFilterMode === 'untagged') {
      return sortedMotionEntries.filter(
        (entry) => resolveMotionEntryStagedTags(entry).length === 0
      )
    }

    return sortedMotionEntries.filter((entry) => {
      const entryTags = resolveMotionEntryStagedTags(entry)
      return animationTagFilters.every((tag) => entryTags.includes(tag))
    })
  })
  const motionAccordionItems = $derived.by<MotionAccordionItem[]>(() => {
    const grouped = new Map<string, UnifiedGoonMotionEntry[]>()
    const filterActive = animationTagFilteringActive

    for (const entry of filteredMotionEntries) {
      const bucketId = resolveMotionAccordionBucketId(entry.primary)
      const next = grouped.get(bucketId) ?? []
      next.push(entry)
      grouped.set(bucketId, next)
    }

    const items: MotionAccordionItem[] = [
      {
        id: ANY_POSTURE_BUCKET,
        postureId: '',
        name: 'Any Posture',
        basePosture: null,
        builtIn: true,
        editable: false,
        usageSummary: filterActive
          ? formatMotionCountSummary(grouped.get(ANY_POSTURE_BUCKET)?.length ?? 0)
          : formatAnyPostureSummary(grouped.get(ANY_POSTURE_BUCKET)?.length ?? 0),
        entries: grouped.get(ANY_POSTURE_BUCKET) ?? []
      },
      ...motionStagePostureOptions.map((posture) => ({
        id: posture.id,
        postureId: posture.id,
        name: posture.name,
        basePosture: posture.basePosture,
        builtIn: Boolean(posture.builtIn),
        editable: !posture.builtIn,
        usageSummary: formatPostureUsageSummary(
          posture.id,
          grouped.get(posture.id)?.length ?? 0,
          filterActive
        ),
        entries: grouped.get(posture.id) ?? []
      }))
    ]

    return filterActive ? items.filter((section) => section.entries.length > 0) : items
  })
  // The unified motion currently playing on the Motions stage preview (cards
  // use the motion name as the preview id), used for the pane's VRMA/GLB
  // format toggle when the motion has both versions.
  const activeMotionPreviewEntry = $derived.by(() =>
    activePreviewId
      ? motionLibraryEntries.find((entry) => entry.name === activePreviewId) ?? null
      : null
  )
  function sortCueDefinitions(cues: GoonCueDefinition[]) {
    return [...cues].sort((left, right) => left.name.localeCompare(right.name))
  }

  const editorEnabledCueMap = $derived.by(() => {
    const next: GoonCueMap = {}
    for (const name of editorEnabledCueNames) {
      const cue = editorCueMap[name]
      if (!cue) continue
      next[name] = cue
    }
    return next
  })
  const editorDisabledCueMap = $derived.by(() => {
    const enabledSet = new Set(editorEnabledCueNames)
    const next: GoonCueMap = {}
    for (const [name, cue] of Object.entries(editorCueMap)) {
      if (enabledSet.has(name)) continue
      next[name] = cue
    }
    return next
  })
  const activeCueMap = $derived.by(() =>
    activeTab === 'kitchen' ? kitchenCueMap : editorEnabledCueMap
  )
  const baseCueOptions = $derived.by(() =>
    sortCueDefinitions(Object.values(activeCueMap))
      .filter((cue) => cue.kind === 'mood')
      .map((cue) => cue.name)
  )
  const moodCues = $derived.by(() =>
    sortCueDefinitions(Object.values(activeCueMap).filter((cue) => cue.kind === 'mood'))
  )
  const emoteCues = $derived.by(() =>
    sortCueDefinitions(Object.values(activeCueMap).filter((cue) => cue.kind === 'emote'))
  )
  const disabledMoodCues = $derived.by(() =>
    sortCueDefinitions(Object.values(editorDisabledCueMap).filter((cue) => cue.kind === 'mood'))
  )
  const disabledEmoteCues = $derived.by(() =>
    sortCueDefinitions(Object.values(editorDisabledCueMap).filter((cue) => cue.kind === 'emote'))
  )
  const closetItems = $derived.by(() =>
    Object.values(globalCloset.items ?? {}).sort((a, b) => a.name.localeCompare(b.name))
  )
  const closetCategoryOptions = $derived.by(() => {
    const categories = new Set<string>()
    for (const item of closetItems) {
      if (item.category) categories.add(item.category)
    }
    return Array.from(categories).sort()
  })
  const normalizedClosetSearchQuery = $derived.by(() => closetSearchQuery.trim().toLowerCase())
  const filteredClosetItems = $derived.by(() => {
    return closetItems.filter((item) => {
      const categoryMatches = closetCategoryFilter === 'all' || item.category === closetCategoryFilter
      if (!categoryMatches) return false

      const query = normalizedClosetSearchQuery
      if (!query) return true

      return [item.name, formatCategoryLabel(item.category), getClosetItemSlotLabelText(item)].some(
        (value) => value.toLowerCase().includes(query)
      )
    })
  })
  const closetItemsById = $derived.by(() => new Map(closetItems.map((item) => [item.id, item])))
  const editorCustomClosetItems = $derived.by(() =>
    editorGoonId ? resolveEnabledCustomClosetItems(editorClosetItems) : []
  )
  const editorCustomClosetItemsById = $derived.by(
    () => new Map(editorCustomClosetItems.map((item) => [item.id, item]))
  )
  const editorClosetPickerItems = $derived.by(() =>
    buildWardrobePickerItems()
  )
  const closetSlotNames = $derived.by(() => buildClosetSlotNames(previewMaterialNames))
  const sortedScenes = $derived.by(() =>
    Object.values(kitchenScenes ?? {}).sort((a, b) => a.name.localeCompare(b.name))
  )
  const sceneEditorScene = $derived.by(() =>
    sceneEditorId ? kitchenScenes?.[sceneEditorId] ?? null : null
  )
  const editorScene = $derived.by(() =>
    editorSceneId ? kitchenScenes?.[editorSceneId] ?? null : null
  )
  const editorGoon = $derived.by(() =>
    editorGoonId ? goons.find((entry) => entry.id === editorGoonId) ?? null : null
  )
  const RETIRED_RECIPE_RECOVERY_MESSAGE =
    'This experimental Goon uses a retired Recipe format. Batshit will not guess at or silently migrate its appearance state. Delete this Goon below, then create a new Goon from the current package.'
  const RETIRED_HAIR_RECOVERY_MESSAGE =
    'This Goon uses the retired Hair motion state. Reset only its old Hair selection, then refit or re-import Hair. The Goon and every other appearance setting stay intact.'
  const editorRetiredHairSibling = $derived.by(() => {
    if (editorGoon?.recipe?.contract !== 'goon-recipe/v2') return null
    try {
      return findRetiredHairRecipeSibling(editorGoon.recipe.authoringRevision.state)
    } catch {
      return null
    }
  })
  const editorRecipeRecoveryMessage = $derived(
    editorRetiredHairSibling ? RETIRED_HAIR_RECOVERY_MESSAGE : RETIRED_RECIPE_RECOVERY_MESSAGE
  )
  // The editor always owns immutable Recipe Source + authoring Recipe State.
  // Mounted stages continue to consume the store record's active Live refs.
  const editorRecipeSourceProjection = $derived.by(() => {
    if (!editorGoon) return { goon: null, error: null }
    try {
      return {
        goon: resolveRecipePreviewGoonAssetUrls(
          projectGoonRecipeSource(editorGoon),
          BATSHIT_SERVER_URL
        ),
        error: null
      }
    } catch (error) {
      return {
        goon: null,
        error: error instanceof Error ? error.message : 'The saved Recipe state is incompatible.'
      }
    }
  })
  const editorRecipeSourceGoon = $derived(editorRecipeSourceProjection.goon)
  const editorRecipeSourceError = $derived(editorRecipeSourceProjection.error)
  const editorGoonKind = $derived.by<GoonKind>(() => (editorGoon?.kind === 'custom' ? 'custom' : 'vrm'))
  const editorSourceProfile = $derived.by<GoonSourceProfile>(() => resolveGoonSourceProfile(editorGoon))
  const editorHairSupported = $derived(editorSourceProfile === 'expert-custom-glb')
  const editorHairRecipeSource = $derived.by(() =>
    editorGoon?.recipe?.contract === 'goon-recipe/v2'
      ? editorGoon.recipe.authoringRevision.source.identities
      : null
  )
  const editorIsGuidedCustomVrm = $derived.by(() => editorSourceProfile === 'guided-custom-vrm')
  const editorClosetPickerLabel = $derived.by(() =>
    editorGoonId && editorCustomClosetItems.length > 0
      ? 'Global Closet + Goon edits'
      : 'Global Closet'
  )
  const currentVrmLabel = $derived.by(() =>
    editorGoon?.files?.vrm ? resolveFileLabel(editorGoon.files.vrm) : 'No VRM'
  )
  const activePendingVrmFile = $derived.by<GoonFileRef | null>(() =>
    editorPendingVrmFile ?? editorGoon?.files?.vrmPending ?? null
  )
  const pendingVrmLabel = $derived.by(() =>
    activePendingVrmFile ? resolveFileLabel(activePendingVrmFile) : ''
  )
  const backupVrmLabel = $derived.by(() =>
    editorGoon?.files?.vrmBackup ? resolveFileLabel(editorGoon.files.vrmBackup) : ''
  )
  const activeVrmUpdateReport = $derived.by<GoonVrmUpdateReport | null>(() =>
    editorPendingVrmUpdate ?? editorGoon?.vrmUpdate ?? null
  )
  const editorRecipeNeedsSave = $derived(
    editorGoon?.recipe?.contract === 'goon-recipe/v2' &&
      editorGoon.recipe.liveStatus === 'needs_bake'
  )
  const editorHasUnsavedChanges = $derived.by(
    () =>
      editorDirty ||
      editorFacialArtworkUploadBusy ||
      Boolean(editorPendingVrmFile) ||
      Boolean(editorPendingAdvancedPackageUpdate) ||
      editorRecipeNeedsSave
  )
  const currentCustomPackageLabel = $derived.by(() =>
    editorRecipeSourceGoon?.customAvatar?.package
      ? resolveFileLabel(editorRecipeSourceGoon.customAvatar.package)
      : 'No package'
  )
  const currentCustomModelLabel = $derived.by(() =>
    editorRecipeSourceGoon?.customAvatar?.model
      ? resolveFileLabel(editorRecipeSourceGoon.customAvatar.model)
      : 'No model'
  )
  const currentCustomManifestLabel = $derived.by(() =>
    editorRecipeSourceGoon?.customAvatar?.manifest
      ? resolveFileLabel(editorRecipeSourceGoon.customAvatar.manifest)
      : 'No manifest'
  )
  const currentGuidedPackageLabel = $derived.by(() =>
    editorGoon?.guidedAvatar?.package ? resolveFileLabel(editorGoon.guidedAvatar.package) : 'No package'
  )
  const pendingAdvancedPackageLabel = $derived.by(() =>
    editorPendingAdvancedPackageUpdate?.package
      ? resolveFileLabel(editorPendingAdvancedPackageUpdate.package)
      : ''
  )
  const backupGuidedPackageLabel = $derived.by(() =>
    editorGoon?.guidedAvatar?.backup?.package
      ? resolveFileLabel(editorGoon.guidedAvatar.backup.package)
      : ''
  )
  const currentGuidedManifestLabel = $derived.by(() =>
    editorGoon?.guidedAvatar?.manifest ? resolveFileLabel(editorGoon.guidedAvatar.manifest) : 'No manifest'
  )
  const editorGuidedOutfitPieces = $derived.by<GoonGuidedOutfitPiece[]>(() => editorGuidedOutfitPiecesDraft)
  const editorVisibleGuidedOutfitPieces = $derived.by<GoonGuidedOutfitPiece[]>(() =>
    editorGuidedOutfitPiecesDraft.filter((piece) => piece.source !== 'duf-overlay')
  )
  const editorStandaloneGuidedOutfitPieces = $derived.by<GoonGuidedOutfitPiece[]>(() =>
    editorVisibleGuidedOutfitPieces.filter((piece) => !isGuidedPieceSlotManaged(piece))
  )
  const editorGuidedOutfitPresets = $derived.by<GoonGuidedOutfitPreset[]>(
    () => editorGoon?.guidedAvatar?.outfitPresets ?? []
  )
  const editorWardrobeOutfitList = $derived.by<GoonWardrobeOutfit[]>(() =>
    Object.values(editorWardrobeOutfits).sort((a, b) => a.name.localeCompare(b.name))
  )
  const editorCanUseWardrobeOutfits = $derived.by(
    () =>
      editorGoonKind !== 'custom' &&
      Boolean(editorGoon?.files?.vrm?.url) &&
      (closetSlotNames.length > 0 || editorStandaloneGuidedOutfitPieces.length > 0)
  )
  const editorGuidedDufOverlayCount = $derived.by(() => editorGuidedDufOverlays.length)
  const previewGoonUrl = $derived.by(() => {
    const editorUrl = resolveGoonAvatarUrl(editorRecipeSourceGoon)
    if (editorUrl) return editorUrl
    if (editorGoon && editorRecipeSourceError) return ''
    const fallback = goons.find((entry) => hasRenderableGoonAvatar(entry))
    return resolveGoonAvatarUrl(fallback)
  })
  // Per-lane motion preview targets: .vrma clips preview on the VRM stunt
  // dummy; .glb clips bind by skeleton node names and preview on the bundled
  // BSRigV2 GLB stunt dummy by default. Users with GLB clips authored against
  // a non-first-party rig can point GLB previews at one of their own
  // Advanced/GLB Goons instead. No cross-lane fallback.
  const GLB_STUNT_DUMMY_MODEL_URL = '/goons/stunt-dummy-rigv2.glb'
  const GLB_STUNT_DUMMY_MANIFEST_URL = '/goons/stunt-dummy-rigv2.avatar.json'
  const glbPreviewGoonOptions = $derived.by(() =>
    goons
      .filter((entry) => resolveGoonKind(entry) === 'custom' && hasRenderableGoonAvatar(entry))
      .sort((a, b) => (a.name || '').localeCompare(b.name || '') || a.id.localeCompare(b.id))
  )
  const glbPreviewGoonId = $derived(goonsSettings?.motions?.glbPreviewGoonId ?? '')
  const glbMotionPreviewTarget = $derived.by<MotionPreviewTarget>(() => {
    // A stale override (deleted goon) falls back to the bundled dummy.
    const overrideGoon = glbPreviewGoonId
      ? glbPreviewGoonOptions.find((entry) => entry.id === glbPreviewGoonId) ?? null
      : null
    if (overrideGoon) {
      return { kind: 'custom', goon: overrideGoon }
    }
    return {
      kind: 'custom-url',
      modelUrl: GLB_STUNT_DUMMY_MODEL_URL,
      manifestUrl: GLB_STUNT_DUMMY_MANIFEST_URL
    }
  })
  function resolveMotionThumbTarget(file: GoonFileRef): {
    target: MotionPreviewTarget | null
    unavailableReason: string
  } {
    if (resolveGoonMotionLane(file) === 'glb') {
      return { target: glbMotionPreviewTarget, unavailableReason: '' }
    }
    return { target: { kind: 'vrm', url: STUNT_DUMMY_VRM_URL }, unavailableReason: '' }
  }
  function getMotionLaneBadge(lane: GoonMotionLane): { label: string; title: string } {
    return lane === 'glb'
      ? { label: 'GLB', title: 'Plays on Advanced/GLB Goons' }
      : { label: 'VRMA', title: 'Plays on VRM Goons' }
  }
  const editorAnimationFiles = $derived.by(() =>
    Array.isArray(editorGoon?.files?.animations) ? editorGoon?.files?.animations ?? [] : []
  )
  const editorKnownAnimationData = $derived.by(() =>
    collectKnownAnimationData(editorGoon, previewAnimationCatalog)
  )
  const availableAnimationNames = $derived.by(() => {
    return editorKnownAnimationData.names.filter((name) => !PAINTED_CONCEAL_POSE_ANIMATION_NAMES.has(name))
  })
  const libraryPreviewGoon = $derived.by(() => resolveGoonById(libraryPreviewGoonId))
  const kitchenPreviewGoon = $derived.by(() => resolveGoonById(kitchenPreviewGoonId))
  const topLevelLivePreviewActive = $derived.by(() => activeTab === 'kitchen' || activeTab === 'motions')
  const scenePreviewUsingProxy = $derived.by(
    () => Boolean(sceneEditorMode) && scenePreviewBodyMode === 'proxy'
  )
  const kitchenKnownAnimationData = $derived.by(() =>
    collectKnownAnimationData(kitchenPreviewGoon, kitchenPreviewAnimationCatalog)
  )
  const activeMarkerMotionNames = $derived.by(() =>
    activeSceneEdit?.type === 'marker'
      ? resolveMarkerMotionNamesForPosture(activeSceneEdit.posture, kitchenPreviewGoon)
      : []
  )
  const kitchenAvailableAnimationNames = $derived.by(() => {
    return activeSceneEdit?.type === 'marker'
      ? activeMarkerMotionNames
      : kitchenKnownAnimationData.names
  })
  const animationSourceByName = $derived.by(() => editorKnownAnimationData.sourceMap)
  const globalAnimationOptions = $derived.by(() => {
    const names = vrmaLibrary
      .map((file) => resolveAnimationName(file))
      .filter((name) => name.length > 0)
    return Array.from(new Set(names)).sort()
  })
  const globalAnimationSourceByName = $derived.by(() =>
    new Map<string, GoonAnimationSource>(globalAnimationOptions.map((name) => [name, 'vrma']))
  )
  const globalMotionPickerOptions = $derived.by(() =>
    buildMotionPickerOptions(
      globalAnimationOptions,
      globalAnimationSourceByName,
      vrmaLibrary.map((file) => ({ file, source: 'vrma' as const }))
    )
  )
  const editorMotionPickerOptions = $derived.by(() =>
    buildMotionPickerOptions(
      availableAnimationNames,
      animationSourceByName,
      [
        ...vrmaLibrary.map((file) => ({ file, source: 'vrma' as const })),
        ...editorAnimationFiles.map((file) => ({ file, source: 'goon' as const }))
      ]
    )
  )
  const globalPackMoodOptions = $derived.by(() =>
    Object.values(kitchenCueMap)
      .filter((cue) => cue.kind === 'mood')
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((cue) => ({
        key: `global:mood:${cue.name}`,
        kind: 'mood' as const,
        cue,
        emojis: resolveCueEmojis(kitchenEmojiMap, cue.name),
        scope: 'global' as const,
        motionFile: resolveMotionFileForCue(cue, null, 'global')
      }))
  )
  const globalPackEmoteOptions = $derived.by(() =>
    Object.values(kitchenCueMap)
      .filter((cue) => cue.kind === 'emote')
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((cue) => ({
        key: `global:emote:${cue.name}`,
        kind: 'emote' as const,
        cue,
        emojis: resolveCueEmojis(kitchenEmojiMap, cue.name),
        scope: 'global' as const,
        motionFile: null
      }))
  )
  const goonPackCueGroups = $derived.by(() =>
    goons
      .map((goon) => buildLocalPackCueGroup(goon))
      .filter((group) => group.moods.length > 0 || group.emotes.length > 0)
  )
  const packSceneOptions = $derived.by(() =>
    sortedScenes.map((scene) => ({
      key: `scene:${scene.id}`,
      sceneId: scene.id,
      scene
    }))
  )
  const globalPackMotionOptions = $derived.by<PackMotionExportOption[]>(() =>
    motionLibraryEntries
      .map((entry) => ({
        entry,
        files: entry.files.filter((file) => Boolean(file?.url && file?.filename))
      }))
      .filter(({ files }) => files.length > 0)
      .map(({ entry, files }) => ({
        key: `motion:${entry.name}`,
        files,
        label: resolveMotionDisplayName(entry.primary) || entry.name
      }))
      .sort((a, b) => a.label.localeCompare(b.label) || a.key.localeCompare(b.key))
  )
  function getMotionSourceLabel(source: GoonAnimationSource | null | undefined) {
    if (source === 'vrma') return 'Global'
    if (source === 'goon') return 'Goon'
    if (source === 'vrm') return 'Embedded'
    return null
  }

  function getMotionPickerFileTags(file: GoonFileRef) {
    const filename = file.filename ?? ''
    const raw = filename
      ? animationTagInputs[filename] ?? (file.tags ?? []).join(', ')
      : (file.tags ?? []).join(', ')
    return normalizeTagInput(raw)
  }

  function getMotionPickerFilePosture(file: GoonFileRef) {
    const filename = file.filename ?? ''
    const raw = filename
      ? animationPostureInputs[filename] ?? file.motionMeta?.posture ?? ''
      : file.motionMeta?.posture ?? ''
    const posture = rebaseDraftPosture(raw)
    return posture && motionStagePostureMap[posture] ? posture : ''
  }

  function getMotionPickerFileLabel(file: GoonFileRef) {
    const filename = file.filename ?? ''
    const draft = filename ? animationDisplayNameInputs[filename] : ''
    return (draft?.trim() || resolveMotionDisplayName(file)).trim()
  }

  function buildMotionPickerOptions(
    names: string[],
    sourceMap: Map<string, GoonAnimationSource>,
    fileCandidates: Array<{ file: GoonFileRef; source: GoonAnimationSource }>
  ): GoonMotionPickerOption[] {
    const fileByName = new Map<string, { file: GoonFileRef; source: GoonAnimationSource }>()
    for (const candidate of fileCandidates) {
      const name = resolveAnimationName(candidate.file)
      if (!name) continue
      const existing = fileByName.get(name)
      const preferredSource = sourceMap.get(name)
      if (!existing || (preferredSource && candidate.source === preferredSource && existing.source !== preferredSource)) {
        fileByName.set(name, candidate)
      }
    }

    return names
      .map((name) => {
        const match = fileByName.get(name)
        const file = match?.file ?? null
        const source = sourceMap.get(name) ?? match?.source ?? null
        const posture = file ? getMotionPickerFilePosture(file) : ''
        return {
          name,
          label: file ? getMotionPickerFileLabel(file) : name,
          sourceLabel: getMotionSourceLabel(source),
          posture,
          postureLabel: posture ? getPostureLabel(posture, motionStagePostureMap) : 'Any Posture',
          tags: file ? getMotionPickerFileTags(file) : []
        }
      })
      .sort((left, right) => left.label.localeCompare(right.label) || left.name.localeCompare(right.name))
  }

  function getPostureLabel(
    posture?: GoonPosture | '' | null,
    postureMap: GoonPostureMap = stagePostureMap
  ) {
    return resolvePostureLabel(posture, goonsSettings, postureMap)
  }

  function resolveCueEmojis(emojiMap: GoonEmojiMap, cueName: string) {
    return Object.entries(emojiMap)
      .filter(([, mappedCueName]) => mappedCueName === cueName)
      .map(([emoji]) => emoji)
      .sort()
  }

  function isVrmaFile(file: File) {
    return file.name.toLowerCase().endsWith('.vrma')
  }

  function isGlbAnimationLibraryFile(file: File) {
    const name = file.name.toLowerCase()
    return name.endsWith('.glb') || name.endsWith('.gltf')
  }

  function isFbxFile(file: File) {
    return file.name.toLowerCase().endsWith('.fbx')
  }

  function stripFileExtension(label: string) {
    if (!label) return label
    return label.replace(/\.[^/.]+$/, '')
  }

  function resolveFileLabel(file: GoonFileRef) {
    const label = file.originalName ?? file.filename ?? 'Animation'
    return stripFileExtension(label)
  }

  function resolveMotionDisplayName(file: GoonFileRef) {
    const displayName = file.displayName?.trim()
    if (displayName) return displayName
    return resolveFileLabel(file)
  }

  function resolveMotionSourceFilename(file: GoonFileRef) {
    return file.originalName ?? file.filename ?? 'Unknown file'
  }

  function normalizePostureName(value: string) {
    return value.trim().replace(/\s+/g, ' ')
  }

  function rebaseDraftPosture(posture: GoonPosture | '' | null | undefined) {
    if (!posture) return ''
    const rebased = deletedMotionPostureBaseMap[posture]
    return rebased ?? posture
  }

  function resolveMotionAccordionBucketId(file: GoonFileRef) {
    const savedPosture = rebaseDraftPosture(file.motionMeta?.posture ?? '')
    return savedPosture && motionStagePostureMap[savedPosture] ? savedPosture : ANY_POSTURE_BUCKET
  }

  function formatMotionCountSummary(motionCount: number) {
    return `${motionCount} Motion${motionCount === 1 ? '' : 's'}`
  }

  function formatAnyPostureSummary(motionCount: number) {
    if (motionCount <= 0) return 'No Motions Yet.'
    return formatMotionCountSummary(motionCount)
  }

  function resetAnimationTagFilters() {
    animationTagFilterMode = 'all'
    animationTagFilters = []
  }

  function showUntaggedAnimationFilter() {
    animationTagFilterMode = 'untagged'
    animationTagFilters = []
  }

  function toggleAnimationTagFilter(tag: string) {
    if (!tag) return

    if (animationTagFilterMode !== 'tags') {
      animationTagFilterMode = 'tags'
      animationTagFilters = [tag]
      return
    }

    if (animationTagFilters.includes(tag)) {
      const next = animationTagFilters.filter((entry) => entry !== tag)
      if (next.length === 0) {
        resetAnimationTagFilters()
        return
      }
      animationTagFilters = next
      return
    }

    animationTagFilters = [...animationTagFilters, tag].sort((left, right) =>
      left.localeCompare(right)
    )
  }

  function isAnimationTagFilterSelected(tag: string) {
    return animationTagFilterMode === 'tags' && animationTagFilters.includes(tag)
  }

  function cloneAndRebaseCueMap(
    cues: GoonCueMap | undefined,
    deletedBaseMap: Record<string, GoonBasePosture>
  ) {
    const next = cloneCueMap(cues)
    for (const cue of Object.values(next)) {
      const posture = cue?.posture
      if (!posture) continue
      const rebased = deletedBaseMap[posture]
      if (!rebased) continue
      cue.posture = rebased
    }
    return next
  }

  function cloneAndRebaseSceneMap(
    scenes: GoonSceneMap | undefined,
    deletedBaseMap: Record<string, GoonBasePosture>
  ) {
    const next = cloneSceneMap(scenes)

    for (const scene of Object.values(next)) {
      if (!scene.markers) continue
      for (const [deletedPosture, basePosture] of Object.entries(deletedBaseMap)) {
        const deletedMarkers = scene.markers[deletedPosture]
        if (!deletedMarkers || deletedMarkers.length === 0) continue
        scene.markers[basePosture] = [...(scene.markers[basePosture] ?? []), ...deletedMarkers]
        delete scene.markers[deletedPosture]
      }
    }

    return next
  }

  function buildNextSettingsWithPostures(postures: GoonPostureMap): GoonsSettings {
    const restKitchen = { ...(goonsSettings?.kitchen ?? {}) }
    delete (restKitchen as Record<string, unknown>).fallbackPoses

    const nextCues = cloneAndRebaseCueMap(restKitchen.cues, deletedMotionPostureBaseMap)
    const nextScenes = cloneAndRebaseSceneMap(restKitchen.scenes, deletedMotionPostureBaseMap)
    const nextDefaultPack = restKitchen.defaultPack
      ? {
          ...restKitchen.defaultPack,
          cueMap: cloneAndRebaseCueMap(
            restKitchen.defaultPack.cueMap,
            deletedMotionPostureBaseMap
          )
        }
      : restKitchen.defaultPack

    return {
      ...goonsSettings,
      kitchen: {
        ...restKitchen,
        cues: nextCues,
        scenes: nextScenes,
        defaultPack: nextDefaultPack,
        postures
      }
    }
  }

  function hasDuplicatePostureName(name: string, excludeId?: string) {
    const normalized = normalizePostureName(name).toLowerCase()
    if (!normalized) return false
    return motionStagePostureOptions.some(
      (posture) =>
        posture.id !== excludeId && normalizePostureName(posture.name).toLowerCase() === normalized
    )
  }

  function resolvePostureUsage(postureId: string) {
    let motionCount = 0
    for (const file of vrmaLibrary) {
      const draftPosture = rebaseDraftPosture(
        animationPostureInputs[file.filename ?? ''] ?? file.motionMeta?.posture ?? ''
      )
      if (draftPosture === postureId) {
        motionCount += 1
      }
    }

    let kitchenCueCount = 0
    for (const cue of Object.values(goonsSettings?.kitchen?.cues ?? {})) {
      if (cue?.posture === postureId) {
        kitchenCueCount += 1
      }
    }

    let goonCueOverrideCount = 0
    for (const goon of goons) {
      for (const cue of Object.values(goon.cues?.overrides ?? goon.cues?.cueMap ?? {})) {
        if (cue?.posture === postureId) {
          goonCueOverrideCount += 1
        }
      }
    }

    let sceneCount = 0
    let markerCount = 0
    for (const scene of Object.values(goonsSettings?.kitchen?.scenes ?? {})) {
      const markers = scene.markers?.[postureId] ?? []
      if (markers.length > 0) {
        sceneCount += 1
        markerCount += markers.length
      }
    }

    return {
      motionCount,
      kitchenCueCount,
      goonCueOverrideCount,
      sceneCount,
      markerCount,
      total: motionCount + kitchenCueCount + goonCueOverrideCount + markerCount
    }
  }

  function formatPostureUsageSummary(
    postureId: string,
    motionCountOverride?: number | null,
    motionsOnly = false
  ) {
    const usage = resolvePostureUsage(postureId)
    const motionCount = motionCountOverride ?? usage.motionCount
    if (motionsOnly) {
      return formatMotionCountSummary(motionCount)
    }
    const parts: string[] = []
    if (motionCount > 0) {
      parts.push(formatMotionCountSummary(motionCount))
    }
    if (usage.kitchenCueCount > 0) {
      parts.push(
        `${usage.kitchenCueCount} Kitchen Cue${usage.kitchenCueCount === 1 ? '' : 's'}`
      )
    }
    if (usage.goonCueOverrideCount > 0) {
      parts.push(
        `${usage.goonCueOverrideCount} Goon Override${
          usage.goonCueOverrideCount === 1 ? '' : 's'
        }`
      )
    }
    if (usage.markerCount > 0) {
      parts.push(`${usage.markerCount} Marker${usage.markerCount === 1 ? '' : 's'}`)
    }
    if (usage.sceneCount > 0) {
      parts.push(`Across ${usage.sceneCount} Scene${usage.sceneCount === 1 ? '' : 's'}`)
    }
    return parts.length > 0 ? parts.join(' • ') : 'Not in use yet.'
  }

  function buildNewPostureDraftName() {
    const taken = new Set(
      motionStagePostureOptions.map((posture) => normalizePostureName(posture.name).toLowerCase())
    )
    let index = 1
    let candidate = 'New Posture'
    while (taken.has(normalizePostureName(candidate).toLowerCase())) {
      index += 1
      candidate = `New Posture ${index}`
    }
    return candidate
  }

  function addMotionPostureDraft() {
    const name = buildNewPostureDraftName()
    const postureId = buildCustomPostureId(name, new Set(Object.keys(motionStagePostureMap)))
    motionsCustomPostures = {
      ...motionsCustomPostures,
      [postureId]: {
        id: postureId,
        name,
        basePosture: 'stand'
      }
    }
    postureNameInputs = { ...postureNameInputs, [postureId]: name }
    postureBaseInputs = { ...postureBaseInputs, [postureId]: 'stand' }
    const nextDeletedBaseMap = { ...deletedMotionPostureBaseMap }
    delete nextDeletedBaseMap[postureId]
    deletedMotionPostureBaseMap = nextDeletedBaseMap
    openMotionPostureId = postureId
    editingMotionPostureId = postureId
  }

  function startEditingMotionPosture(postureId: string) {
    if (isBuiltInPosture(postureId)) return
    editingMotionPostureId = postureId
  }

  function applyMotionPostureEdits(postureId: string) {
    const current = motionsCustomPostures[postureId]
    if (!current) return

    const nextName = normalizePostureName(postureNameInputs[postureId] ?? current.name)
    const nextBasePosture = postureBaseInputs[postureId] ?? current.basePosture

    if (!nextName) {
      toast.error('Posture name cannot be empty.')
      return
    }
    if (hasDuplicatePostureName(nextName, postureId)) {
      toast.error('That posture name already exists.')
      return
    }
    if (!isBuiltInPosture(nextBasePosture)) {
      toast.error('Choose a valid Base Posture.')
      return
    }

    motionsCustomPostures = {
      ...motionsCustomPostures,
      [postureId]: {
        ...current,
        name: nextName,
        basePosture: nextBasePosture
      }
    }
    postureNameInputs = { ...postureNameInputs, [postureId]: nextName }
    postureBaseInputs = { ...postureBaseInputs, [postureId]: nextBasePosture }
    editingMotionPostureId = null
  }

  function cancelMotionPostureEdits(postureId: string) {
    const current = motionsCustomPostures[postureId]
    if (!current) return
    postureNameInputs = { ...postureNameInputs, [postureId]: current.name }
    postureBaseInputs = { ...postureBaseInputs, [postureId]: current.basePosture }
    if (editingMotionPostureId === postureId) {
      editingMotionPostureId = null
    }
  }

  function deleteMotionPostureDraft(postureId: string) {
    if (isBuiltInPosture(postureId)) return
    const basePosture = postureBaseInputs[postureId] ?? motionsCustomPostures[postureId]?.basePosture ?? 'stand'

    deletedMotionPostureBaseMap = {
      ...deletedMotionPostureBaseMap,
      [postureId]: basePosture
    }

    const nextPostures = { ...motionsCustomPostures }
    delete nextPostures[postureId]
    motionsCustomPostures = nextPostures
    const nextNameInputs = { ...postureNameInputs }
    delete nextNameInputs[postureId]
    postureNameInputs = nextNameInputs
    const nextBaseInputs = { ...postureBaseInputs }
    delete nextBaseInputs[postureId]
    postureBaseInputs = nextBaseInputs

    animationPostureInputs = Object.fromEntries(
      Object.entries(animationPostureInputs).map(([filename, posture]) => [
        filename,
        posture === postureId ? basePosture : posture
      ])
    ) as Record<string, GoonPosture | ''>

    if (editingMotionPostureId === postureId) {
      editingMotionPostureId = null
    }
    openMotionPostureId = basePosture
  }

  function resolveGoonKind(goon: GoonRecord | null | undefined): GoonKind {
    return goon?.kind === 'custom' ? 'custom' : 'vrm'
  }

  function goonFormatVisualForSourceProfile(sourceProfile: GoonSourceProfile): GoonFormatVisual {
    if (sourceProfile === 'guided-custom-vrm') return ADVANCED_BLENDER_GOON_FORMAT
    if (sourceProfile === 'expert-custom-glb') return ADVANCED_GLB_GOON_FORMAT
    return STANDARD_GOON_FORMAT
  }

  function goonFormatVisual(goon: GoonRecord | null | undefined) {
    return goonFormatVisualForSourceProfile(resolveGoonSourceProfile(goon))
  }

  function resolveEditorFileSectionLabel() {
    if (editorSourceProfile === 'guided-custom-vrm' || editorGoonKind === 'custom') {
      return 'Goon File Package'
    }
    return 'VRM File'
  }

  function resolveEditorFileSectionInfo() {
    if (editorSourceProfile === 'guided-custom-vrm') return EDITOR_GUIDED_PACKAGE_INFO
    if (editorGoonKind === 'custom') return EDITOR_CUSTOM_PACKAGE_INFO
    return EDITOR_VRM_FILE_INFO
  }

  function resolveGuidedManagedSlotName(piece: GoonGuidedOutfitPiece) {
    return resolveGuidedOutfitManagedSlotName(piece, closetSlotNames)
  }

  function isGuidedPieceSlotManaged(piece: GoonGuidedOutfitPiece) {
    return isGuidedOutfitPieceSlotManaged(piece, closetSlotNames)
  }

  function resolveGuidedPieceVisible(
    piece: GoonGuidedOutfitPiece,
    pieceStates: Record<string, boolean> = editorGuidedPieceStates,
    assignments: Record<string, GoonClosetAssignment> = closetAssignments
  ) {
    return resolveGuidedOutfitPieceVisible(piece, {
      availableSlotNames: closetSlotNames,
      pieceStates,
      assignments
    })
  }

  function getGuidedPieceState(piece: GoonGuidedOutfitPiece) {
    return resolveGuidedPieceVisible(piece)
  }

  function buildPersistedGuidedPieceStates(
    pieces: GoonGuidedOutfitPiece[],
    assignments: Record<string, GoonClosetAssignment> = closetAssignments
  ) {
    return buildGuidedOutfitPieceStates(pieces, {
      availableSlotNames: closetSlotNames,
      pieceStates: editorGuidedPieceStates,
      assignments
    })
  }

  function buildGuidedDufOverlayId() {
    return `duf_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  }

  function resolveGuidedPiecesForSlot(slotName: string) {
    return editorGuidedOutfitPiecesDraft.filter((piece) =>
      (piece.materialNames ?? []).some((materialName) => materialName === slotName)
    )
  }

  function resolveGuidedBasePiecesForSlot(slotName: string) {
    return resolveGuidedPiecesForSlot(slotName).filter((piece) => piece.source !== 'duf-overlay')
  }

  function getGuidedSlotOriginalState(slotName: string) {
    const pieces = resolveGuidedBasePiecesForSlot(slotName)
    if (pieces.length === 0) return true
    return pieces.every((piece) => resolveGuidedPieceVisible(piece))
  }

  function getStandaloneGuidedPieceValue(piece: GoonGuidedOutfitPiece) {
    const selectedItem = resolveStandaloneGuidedPieceSelectedItem(piece)
    if (selectedItem) return selectedItem.id
    const editedOriginal = resolveEditedOriginalWardrobeItemForGuidedPiece(piece.id)
    if (editedOriginal && getGuidedPieceState(piece)) return editedOriginal.id
    return getGuidedPieceState(piece) ? '__original__' : '__none__'
  }

  function getStandaloneGuidedPieceLabel(piece: GoonGuidedOutfitPiece) {
    const value = getStandaloneGuidedPieceValue(piece)
    if (value === '__none__') return 'None'
    if (value === '__original__') return 'Original'
    const item = resolveClosetItem(value)
    return item ? getWardrobeItemDisplayName(item) : 'Edited Original'
  }

  function getStandaloneGuidedPieceSavedItems(piece: GoonGuidedOutfitPiece) {
    return editorClosetPickerItems.filter(
      (item) =>
        item.pickerSource === 'custom' &&
        item.originalSource?.kind === 'guided-piece-original' &&
        item.originalSource.pieceId === piece.id
    )
  }

  function resolveStandaloneGuidedPieceSelectedItem(piece: GoonGuidedOutfitPiece) {
    const assignment = closetAssignments[buildGuidedPieceOriginalClosetSlot(piece.id)]
    if (assignment?.mode !== 'item') return null
    const item = resolveClosetItem(assignment.itemId)
    if (
      !item ||
      item.originalSource?.kind !== 'guided-piece-original' ||
      item.originalSource.pieceId !== piece.id
    ) {
      return null
    }
    return item
  }

  function resolveStandaloneGuidedPieceLabel(piece: GoonGuidedOutfitPiece) {
    return piece.label?.trim() || 'Blender Outfit Slot'
  }

  function originalSourceMatches(
    source: GoonClosetOriginalSource | null | undefined,
    target: GoonClosetOriginalSource
  ) {
    if (!source || source.kind !== target.kind) return false
    if (source.kind === 'slot-original' && target.kind === 'slot-original') {
      return source.slotName === target.slotName
    }
    if (source.kind === 'guided-piece-original' && target.kind === 'guided-piece-original') {
      return source.pieceId === target.pieceId
    }
    return false
  }

  function resolveSavedOriginalClosetItem(source: GoonClosetOriginalSource) {
    return (
      editorCustomClosetItems.find((item) => originalSourceMatches(item.originalSource, source)) ?? null
    )
  }

  function resolveSavedOriginalClosetItemForSlot(slotName: string) {
    return resolveSavedOriginalClosetItem({ kind: 'slot-original', slotName })
  }

  function resolveSavedOriginalClosetItemForGuidedPiece(pieceId: string) {
    return resolveSavedOriginalClosetItem({ kind: 'guided-piece-original', pieceId })
  }

  function resolveEditedOriginalWardrobeItem(source: GoonClosetOriginalSource) {
    const item = resolveSavedOriginalClosetItem(source)
    return item && isWardrobeItemEdited(item) ? item : null
  }

  function resolveEditedOriginalWardrobeItemForSlot(slotName: string) {
    return resolveEditedOriginalWardrobeItem({ kind: 'slot-original', slotName })
  }

  function resolveEditedOriginalWardrobeItemForGuidedPiece(pieceId: string) {
    return resolveEditedOriginalWardrobeItem({ kind: 'guided-piece-original', pieceId })
  }

  function resolveOriginalSavedItemForConceal(source: GoonClosetOriginalSource) {
    return resolveSavedOriginalClosetItem(source)
  }

  function getClosetSlotConcealCountLabel(
    slotName: string,
    assignment: GoonClosetAssignment = buildClosetSlotWorkingAssignment(slotName)
  ) {
    if (assignment.mode === 'item' && assignment.itemId) {
      const item = resolveClosetItem(assignment.itemId)
      return getPaintedConcealCountLabel(item?.paintedConcealMask)
    }
    return getPaintedConcealCountLabel(null)
  }

  function getGuidedPieceConcealCountLabel(piece: GoonGuidedOutfitPiece) {
    const selectedSavedItem = resolveStandaloneGuidedPieceSelectedItem(piece)
    return getPaintedConcealCountLabel(selectedSavedItem?.paintedConcealMask)
  }

  async function syncEditorGuidedOutfitPreview() {
    if (!editorGoon || editorSourceProfile !== 'guided-custom-vrm') return
    if (previewGoonId !== editorGoon.id || !previewReady || !previewEngine) return
    await previewEngine.configureGuidedOutfitPieces(
      editorGuidedOutfitPiecesDraft,
      buildPersistedGuidedPieceStates(editorGuidedOutfitPiecesDraft),
      editorGuidedDufOverlays.map((overlay) => ({
        id: overlay.id,
        file: overlay.file
      }))
    )
    previewEngine.resetMaterialOverrides()
    await applyClosetAssignments(previewEngine, closetAssignments, {
      guidedOutfitPieces: editorGuidedOutfitPiecesDraft,
      guidedPieceStates: buildPersistedGuidedPieceStates(editorGuidedOutfitPiecesDraft)
    })
  }

  let editorPreviewUpdateQueue = Promise.resolve()

  async function runLoggedEditorPreviewUpdate(
    reason: string,
    update: () => Promise<void>,
    details: Record<string, unknown> = {}
  ) {
    const startedAt = typeof performance !== 'undefined' ? performance.now() : Date.now()
    const baseDetails = {
      reason,
      editorGoonId,
      previewGoonId,
      previewReady,
      guided: editorIsGuidedCustomVrm,
      assignmentCount: Object.keys(closetAssignments).length,
      guidedPieceCount: editorGuidedOutfitPiecesDraft.length,
      ...details
    }
    logClientEvent({
      kind: 'goon-editor-preview-update',
      scope: 'goons',
      phase: 'start',
      details: baseDetails
    })
    try {
      await update()
      const finishedAt = typeof performance !== 'undefined' ? performance.now() : Date.now()
      logClientEvent({
        kind: 'goon-editor-preview-update',
        scope: 'goons',
        phase: 'finish',
        details: {
          ...baseDetails,
          durationMs: Math.round(finishedAt - startedAt)
        }
      })
    } catch (error) {
      const failedAt = typeof performance !== 'undefined' ? performance.now() : Date.now()
      console.error('[GoonsSettings] Preview update failed', { reason, error })
      logClientError('goon-editor-preview-update-failed', error, {
        ...baseDetails,
        durationMs: Math.round(failedAt - startedAt)
      })
      throw error
    }
  }

  function queueLoggedEditorPreviewUpdate(
    reason: string,
    update: () => Promise<void>,
    details: Record<string, unknown> = {}
  ) {
    editorPreviewUpdateQueue = editorPreviewUpdateQueue
      .catch(() => undefined)
      .then(() => runLoggedEditorPreviewUpdate(reason, update, details))
    void editorPreviewUpdateQueue.catch((error: any) => {
      toast.error(error?.message || 'Goon preview update failed')
    })
  }

  function setGuidedPieceState(pieceId: string, nextChecked: boolean) {
    editorGuidedPieceStates = {
      ...editorGuidedPieceStates,
      [pieceId]: nextChecked
    }
    editorGuidedActivePresetId = null
    editorActiveWardrobeOutfitId = null
    editorDirty = true
    queueLoggedEditorPreviewUpdate(
      'guided-piece-state',
      () => syncEditorGuidedOutfitPreview(),
      { pieceId, nextChecked }
    )
  }

  function setStandaloneGuidedPieceValue(piece: GoonGuidedOutfitPiece, value: string) {
    const virtualSlotName = buildGuidedPieceOriginalClosetSlot(piece.id)
    const nextAssignments = { ...closetAssignments }

    if (value === '__none__') {
      delete nextAssignments[virtualSlotName]
      editorGuidedPieceStates = {
        ...editorGuidedPieceStates,
        [piece.id]: false
      }
    } else if (value === '__original__') {
      const editedOriginal = resolveEditedOriginalWardrobeItemForGuidedPiece(piece.id)
      if (editedOriginal) {
        nextAssignments[virtualSlotName] = {
          mode: 'item',
          itemId: editedOriginal.id
        }
      } else {
        delete nextAssignments[virtualSlotName]
      }
      editorGuidedPieceStates = {
        ...editorGuidedPieceStates,
        [piece.id]: true
      }
    } else {
      const item = resolveClosetItem(value)
      if (
        !item ||
        item.originalSource?.kind !== 'guided-piece-original' ||
        item.originalSource.pieceId !== piece.id
      ) {
        return
      }
      nextAssignments[virtualSlotName] = {
        mode: 'item',
        itemId: item.id
      }
      editorGuidedPieceStates = {
        ...editorGuidedPieceStates,
        [piece.id]: true
      }
    }

    closetAssignments = nextAssignments
    editorGuidedActivePresetId = null
    editorActiveWardrobeOutfitId = null
    editorDirty = true
    queueLoggedEditorPreviewUpdate(
      'standalone-guided-piece-selection',
      () => syncEditorGuidedOutfitPreview(),
      { pieceId: piece.id, value }
    )
  }

  function applyGuidedOutfitPreset(presetId: string) {
    const preset = editorGuidedOutfitPresets.find((entry) => entry.id === presetId)
    if (!preset) return

    const nextStates = { ...editorGuidedPieceStates }
    let nextAssignments = { ...closetAssignments }
    for (const pieceId of preset.piecesOn ?? []) {
      const piece = resolveGuidedOutfitPiece(pieceId)
      const slotName = piece ? resolveGuidedManagedSlotName(piece) : null
      if (slotName) {
        const editedOriginal = resolveEditedOriginalWardrobeItemForSlot(slotName)
        nextAssignments = applyClosetSelectionChange(
          nextAssignments,
          slotName,
          editedOriginal?.id ?? '__original__',
          resolveClosetItem,
          closetSlotNames
        )
      } else {
        const editedOriginal = resolveEditedOriginalWardrobeItemForGuidedPiece(pieceId)
        if (editedOriginal) {
          nextAssignments[buildGuidedPieceOriginalClosetSlot(pieceId)] = {
            mode: 'item',
            itemId: editedOriginal.id
          }
        } else {
          delete nextAssignments[buildGuidedPieceOriginalClosetSlot(pieceId)]
        }
        nextStates[pieceId] = true
      }
    }
    for (const pieceId of preset.piecesOff ?? []) {
      const piece = resolveGuidedOutfitPiece(pieceId)
      const slotName = piece ? resolveGuidedManagedSlotName(piece) : null
      if (slotName) {
        nextAssignments = applyClosetSelectionChange(
          nextAssignments,
          slotName,
          '__none__',
          resolveClosetItem,
          closetSlotNames
        )
      } else {
        delete nextAssignments[buildGuidedPieceOriginalClosetSlot(pieceId)]
        nextStates[pieceId] = false
      }
    }

    editorGuidedPieceStates = nextStates
    closetAssignments = nextAssignments
    editorGuidedActivePresetId = preset.id
    editorActiveWardrobeOutfitId = null
    editorDirty = true
    queueLoggedEditorPreviewUpdate(
      'guided-outfit-preset',
      () => syncEditorGuidedOutfitPreview(),
      { presetId }
    )
  }

  function resolveWardrobeOutfitItemFromDraft(itemId?: string | null) {
    if (!itemId) return null
    return editorClosetItems[itemId] ?? null
  }

  function resolveWardrobeOutfitActiveLabel() {
    if (editorActiveWardrobeOutfitId === ALL_ORIGINAL_WARDROBE_OUTFIT_ID) return 'All Original'
    if (editorActiveWardrobeOutfitId === NO_WARDROBE_OUTFIT_ID) return 'None'
    if (!editorActiveWardrobeOutfitId) return 'Custom'
    return editorWardrobeOutfits[editorActiveWardrobeOutfitId]?.name ?? 'Custom'
  }

  function buildWardrobeAssignmentKeys() {
    const keys = new Set<string>(closetSlotNames)
    for (const piece of editorStandaloneGuidedOutfitPieces) {
      keys.add(buildGuidedPieceOriginalClosetSlot(piece.id))
    }
    return keys
  }

  function buildCurrentWardrobeOutfitAssignments(
    assignments: Record<string, GoonClosetAssignment> = closetAssignments
  ) {
    const snapshot: Record<string, GoonClosetAssignment> = {}
    for (const slotName of closetSlotNames) {
      const assignment = assignments[slotName] ?? ({ mode: 'original' } satisfies GoonClosetAssignment)
      const label = assignment.label?.trim()
      if (assignment.mode === 'item' && assignment.itemId) {
        snapshot[slotName] = {
          mode: 'item',
          itemId: assignment.itemId,
          ...(label ? { label } : {})
        }
      } else if (assignment.mode === 'none') {
        snapshot[slotName] = {
          mode: 'none',
          ...(label ? { label } : {})
        }
      } else {
        snapshot[slotName] = {
          mode: 'original',
          ...(label ? { label } : {})
        }
      }
    }

    for (const piece of editorStandaloneGuidedOutfitPieces) {
      const virtualSlotName = buildGuidedPieceOriginalClosetSlot(piece.id)
      const assignment = assignments[virtualSlotName]
      if (assignment?.mode === 'item' && assignment.itemId) {
        snapshot[virtualSlotName] = {
          mode: 'item',
          itemId: assignment.itemId
        }
      }
    }

    return snapshot
  }

  async function materializeGlobalWardrobeItemsForSnapshot(
    assignments: Record<string, GoonClosetAssignment>
  ) {
    let nextAssignments = { ...assignments }
    let nextItems = { ...editorClosetItems }
    let changed = false
    const localByGlobalSource = new Map(
      editorCustomClosetItems
        .filter((item) => item.sourceItemId && !item.originalSource)
        .map((item) => [item.sourceItemId as string, item])
    )

    for (const [slotName, assignment] of Object.entries(assignments)) {
      if (assignment.mode !== 'item' || !assignment.itemId) continue
      if (editorCustomClosetItemsById.has(assignment.itemId)) continue
      const globalItem = closetItemsById.get(assignment.itemId)
      if (!globalItem) continue

      let localItem = localByGlobalSource.get(globalItem.id)
      if (!localItem) {
        localItem = createCustomClosetItemFromGlobal(globalItem)
        nextItems = {
          ...nextItems,
          [localItem.id]: localItem
        }
        localByGlobalSource.set(globalItem.id, localItem)
        changed = true
      }

      nextAssignments = {
        ...nextAssignments,
        [slotName]: {
          ...assignment,
          itemId: localItem.id
        }
      }
      changed = true
    }

    if (changed) {
      editorClosetItems = nextItems
      closetAssignments = nextAssignments
      editorDirty = true
      await tick()
    }

    return nextAssignments
  }

  async function buildCurrentWardrobeOutfitSnapshot() {
    const materializedAssignments = await materializeGlobalWardrobeItemsForSnapshot(closetAssignments)
    const assignments = buildCurrentWardrobeOutfitAssignments(materializedAssignments)
    return {
      assignments: cloneWardrobeOutfitAssignments(assignments),
      guidedPieceStates: cloneWardrobeGuidedPieceStates(
        buildPersistedGuidedPieceStates(editorGuidedOutfitPiecesDraft, assignments)
      )
    }
  }

  async function applyWardrobeOutfitState(
    outfit: Pick<GoonWardrobeOutfit, 'assignments' | 'guidedPieceStates'>,
    activeOutfitId: string | null
  ) {
    if (!editorCanUseWardrobeOutfits) return
    const outfitAssignments = cloneWardrobeOutfitAssignments(outfit.assignments)
    const nextAssignments = { ...closetAssignments }
    for (const key of buildWardrobeAssignmentKeys()) {
      delete nextAssignments[key]
    }
    for (const [slotName, assignment] of Object.entries(outfitAssignments)) {
      if (assignment.mode === 'item' && !resolveClosetItem(assignment.itemId)) {
        nextAssignments[slotName] = {
          mode: 'original',
          ...(assignment.label?.trim() ? { label: assignment.label.trim() } : {})
        }
        continue
      }
      if (assignment.mode === 'original' && !assignment.label) {
        continue
      }
      nextAssignments[slotName] = assignment
    }

    closetAssignments = sanitizeClosetAssignments(nextAssignments)
    editorGuidedPieceStates = {
      ...editorGuidedPieceStates,
      ...cloneWardrobeGuidedPieceStates(outfit.guidedPieceStates)
    }
    editorGuidedActivePresetId = null
    editorActiveWardrobeOutfitId = activeOutfitId
    editorDirty = true
    if (editorIsGuidedCustomVrm) {
      await runLoggedEditorPreviewUpdate(
        'wardrobe-outfit-guided',
        () => syncEditorGuidedOutfitPreview(),
        { activeOutfitId }
      )
    } else {
      await runLoggedEditorPreviewUpdate(
        'wardrobe-outfit-closet',
        () => refreshEditorClosetPreview(),
        { activeOutfitId }
      )
    }
  }

  async function applyBuiltInWardrobeOutfit(outfitId: string) {
    if (outfitId === ALL_ORIGINAL_WARDROBE_OUTFIT_ID) {
      const assignments = Object.fromEntries(
        closetSlotNames.map((slotName) => [
          slotName,
          {
            mode: 'original',
            ...(closetAssignments[slotName]?.label?.trim()
              ? { label: closetAssignments[slotName].label?.trim() }
              : {})
          } satisfies GoonClosetAssignment
        ])
      )
      const guidedPieceStates = Object.fromEntries(
        editorStandaloneGuidedOutfitPieces.map((piece) => [piece.id, true])
      )
      await applyWardrobeOutfitState(
        {
          assignments,
          guidedPieceStates
        },
        ALL_ORIGINAL_WARDROBE_OUTFIT_ID
      )
      return
    }

    if (outfitId === NO_WARDROBE_OUTFIT_ID) {
      const assignments = Object.fromEntries(
        closetSlotNames.map((slotName) => [
          slotName,
          {
            mode: 'none',
            ...(closetAssignments[slotName]?.label?.trim()
              ? { label: closetAssignments[slotName].label?.trim() }
              : {})
          } satisfies GoonClosetAssignment
        ])
      )
      const guidedPieceStates = Object.fromEntries(
        editorStandaloneGuidedOutfitPieces.map((piece) => [piece.id, false])
      )
      await applyWardrobeOutfitState(
        {
          assignments,
          guidedPieceStates
        },
        NO_WARDROBE_OUTFIT_ID
      )
    }
  }

  async function applySavedWardrobeOutfit(outfitId: string) {
    const outfit = editorWardrobeOutfits[outfitId]
    if (!outfit) return
    await applyWardrobeOutfitState(outfit, outfit.id)
  }

  async function saveCurrentWardrobeOutfit() {
    const name = normalizeWardrobeOutfitName(newWardrobeOutfitName)
    if (!name) {
      toast.error('Name the Outfit first.')
      return
    }
    const snapshot = await buildCurrentWardrobeOutfitSnapshot()
    const id = buildWardrobeOutfitId()
    const now = new Date().toISOString()
    editorWardrobeOutfits = {
      ...editorWardrobeOutfits,
      [id]: {
        id,
        name,
        assignments: snapshot.assignments,
        guidedPieceStates: snapshot.guidedPieceStates,
        createdAt: now,
        updatedAt: now
      }
    }
    editorActiveWardrobeOutfitId = id
    newWardrobeOutfitName = ''
    editorWardrobeOutfitCreateOpen = false
    editorGuidedActivePresetId = null
    editorDirty = true
    await saveCueEditor({ successMessage: 'Outfit saved' })
  }

  function cancelWardrobeOutfitCreate() {
    newWardrobeOutfitName = ''
    editorWardrobeOutfitCreateOpen = false
  }

  async function updateWardrobeOutfit(outfitId: string) {
    const outfit = editorWardrobeOutfits[outfitId]
    if (!outfit) return
    const snapshot = await buildCurrentWardrobeOutfitSnapshot()
    editorWardrobeOutfits = {
      ...editorWardrobeOutfits,
      [outfitId]: {
        ...outfit,
        assignments: snapshot.assignments,
        guidedPieceStates: snapshot.guidedPieceStates,
        updatedAt: new Date().toISOString()
      }
    }
    editorActiveWardrobeOutfitId = outfitId
    editorGuidedActivePresetId = null
    editorDirty = true
    await saveCueEditor({ successMessage: 'Outfit updated' })
  }

  async function deleteWardrobeOutfit(outfitId: string) {
    const nextOutfits = { ...editorWardrobeOutfits }
    delete nextOutfits[outfitId]
    editorWardrobeOutfits = nextOutfits
    if (editorActiveWardrobeOutfitId === outfitId) {
      editorActiveWardrobeOutfitId = null
    }
    editorDirty = true
    await saveCueEditor({ successMessage: 'Outfit deleted' })
  }

  function removeGuidedDufOverlay(overlayId: string) {
    const removedPieceIds = new Set(
      editorGuidedOutfitPiecesDraft
        .filter((piece) => piece.overlayId === overlayId)
        .map((piece) => piece.id)
    )
    editorGuidedDufOverlays = editorGuidedDufOverlays.filter((overlay) => overlay.id !== overlayId)
    editorGuidedOutfitPiecesDraft = editorGuidedOutfitPiecesDraft.filter(
      (piece) => piece.overlayId !== overlayId
    )
    editorGuidedPieceStates = Object.fromEntries(
      Object.entries(editorGuidedPieceStates).filter(([pieceId]) => !removedPieceIds.has(pieceId))
    )
    editorGuidedActivePresetId = null
    editorActiveWardrobeOutfitId = null
    editorDirty = true
    queueLoggedEditorPreviewUpdate(
      'guided-duf-overlay-remove',
      () => syncEditorGuidedOutfitPreview(),
      { overlayId, removedPieceCount: removedPieceIds.size }
    )
  }

  async function handleGuidedDufClothesSelection(event: Event) {
    const file = (event.currentTarget as HTMLInputElement)?.files?.[0]
    if (!file) return
    if (!editorGoonId || !editorGoon || editorSourceProfile !== 'guided-custom-vrm') {
      toast.error('DUF clothes import is only available for Advanced/Blender Goons.')
      return
    }
    if (!file.name.toLowerCase().endsWith('.vrm')) {
      toast.error('DUF clothes import requires a .vrm file.')
      return
    }

    guidedDufClothesBusy = true
    try {
      const engine = await ensurePreviewGoonReady()
      const overlayId = buildGuidedDufOverlayId()
      const analysis = await analyzeGuidedDufClothesFile(
        overlayId,
        file,
        engine?.getAvatarRootObject() ?? null
      )
      if (analysis.pieces.length === 0) {
        throw new Error(analysis.warnings[0] ?? 'No supported DUF clothing meshes were found.')
      }

      const uploaded = await uploadGuidedDufClothesVrm(editorGoonId, file)
      const importedAt = new Date().toISOString()
      editorGuidedDufOverlays = [
        ...editorGuidedDufOverlays,
        {
          id: overlayId,
          label: file.name.replace(/\.vrm$/i, ''),
          file: uploaded,
          importedAt,
          pieceIds: analysis.pieces.map((piece) => piece.id)
        }
      ]
      editorGuidedOutfitPiecesDraft = [...editorGuidedOutfitPiecesDraft, ...analysis.pieces]
      editorGuidedPieceStates = {
        ...editorGuidedPieceStates,
        ...Object.fromEntries(analysis.pieces.map((piece) => [piece.id, true]))
      }
      editorGuidedActivePresetId = null
      editorActiveWardrobeOutfitId = null
      editorDirty = true
      await runLoggedEditorPreviewUpdate(
        'guided-duf-overlay-add',
        () => syncEditorGuidedOutfitPreview(),
        { overlayId, pieceCount: analysis.pieces.length }
      )

      if (analysis.warnings.length > 0) {
        toast.success(`DUF clothes added with notes: ${analysis.warnings.join(' ')}`)
      } else {
        toast.success('DUF clothes added')
      }
    } catch (error: any) {
      toast.error(error?.message || 'Failed to add DUF clothes')
    } finally {
      guidedDufClothesBusy = false
      if (guidedDufClothesInput) guidedDufClothesInput.value = ''
    }
  }

  function resolveGuidedPresetButtonLabel() {
    if (!editorGuidedActivePresetId) return 'Apply Preset'
    return (
      editorGuidedOutfitPresets.find((preset) => preset.id === editorGuidedActivePresetId)?.name ??
      'Apply Preset'
    )
  }

  function resolveUploadTime(file: GoonFileRef) {
    const raw = file.uploadedAt
    if (!raw) return 0
    const time = Date.parse(raw)
    return Number.isNaN(time) ? 0 : time
  }

  function resolveAnimationName(file: GoonFileRef) {
    return resolveGoonAnimationName(file, 'animation')
  }

  function resolveMotionFileForCue(
    cue: GoonCueDefinition,
    goon: GoonRecord | null,
    scope: PackCueScope
  ): GoonFileRef | null {
    if (cue.kind === 'emote') return null
    const animationName = cue.animationName?.trim()
    if (!animationName) return null

    const goonFiles = Array.isArray(goon?.files?.animations) ? goon?.files?.animations ?? [] : []
    const candidates =
      scope === 'goon' ? [...goonFiles, ...vrmaLibrary] : [...vrmaLibrary, ...goonFiles]
    return candidates.find((file) => resolveAnimationName(file) === animationName) ?? null
  }

  function buildLocalPackCueGroup(goon: GoonRecord): PackCueGroup {
    const resolved = resolveGoonCues(goon, goonsSettings)
    const overrideNames = Object.keys(goon.cues?.overrides ?? goon.cues?.cueMap ?? {})
    const emojiOverrideNames = Object.values(goon.cues?.emojiOverrides ?? goon.cues?.emojiMap ?? {})
    const localCueNames = Array.from(
      new Set([...overrideNames, ...emojiOverrideNames].filter((name) => Boolean(resolved.cueMap[name])))
    ).sort()

    const options = localCueNames.map((cueName) => {
      const cue = resolved.cueMap[cueName]
      return {
        key: `goon:${goon.id}:${cue.kind}:${cue.name}`,
        kind: cue.kind,
        cue,
        emojis: resolveCueEmojis(resolved.emojiMap, cue.name),
        scope: 'goon' as const,
        sourceGoonId: goon.id,
        sourceGoonName: goon.name,
        motionFile: resolveMotionFileForCue(cue, goon, 'goon')
      }
    })

    return {
      key: `goon:${goon.id}`,
      label: goon.name,
      moods: options
        .filter((option) => option.kind === 'mood')
        .sort((a, b) => a.cue.name.localeCompare(b.cue.name)),
      emotes: options
        .filter((option) => option.kind === 'emote')
        .sort((a, b) => a.cue.name.localeCompare(b.cue.name))
    }
  }

  function collectKnownAnimationData(
    goon: GoonRecord | null,
    runtimeCatalog: Array<{ name: string; source: 'vrm' | 'goon' | 'vrma' }> = []
  ) {
    const names = new Set<string>()
    const sourceMap = new Map<string, 'vrm' | 'goon' | 'vrma'>()

    for (const entry of runtimeCatalog) {
      if (!entry?.name) continue
      names.add(entry.name)
      sourceMap.set(entry.name, entry.source)
    }

    for (const file of vrmaLibrary) {
      const name = resolveAnimationName(file)
      if (!name) continue
      names.add(name)
      if (!sourceMap.has(name)) sourceMap.set(name, 'vrma')
    }

    const goonFiles = Array.isArray(goon?.files?.animations) ? goon?.files?.animations ?? [] : []
    for (const file of goonFiles) {
      const name = resolveAnimationName(file)
      if (!name) continue
      names.add(name)
      if (!sourceMap.has(name)) sourceMap.set(name, 'goon')
    }

    const compatibilityNames = Array.isArray(goon?.compatibility?.animationNames)
      ? goon?.compatibility?.animationNames ?? []
      : []
    for (const name of compatibilityNames) {
      if (!name) continue
      names.add(name)
    }

    return {
      names: Array.from(names).sort(),
      sourceMap
    }
  }

  function resolveRendererBadge(status: GoonRendererRuntime | null) {
    if (!status) return null
    return status.label || 'Renderer'
  }

  function logRendererRuntimeStatus(surface: string, status: GoonRendererRuntime) {
    logClientEvent({
      kind: 'goon-renderer-runtime',
      scope: 'goons',
      details: {
        surface,
        backend: status.backend,
        label: status.label,
        navigatorGpuAvailable: status.environment?.navigatorGpuAvailable ?? null,
        embeddedWebKitRuntime: status.environment?.embeddedWebKitRuntime ?? null
      }
    })
  }

  function toGoonPreviewError(error: unknown, fallback = 'Failed to load preview') {
    if (error instanceof Error && error.message) return error.message
    return fallback
  }

  function setGoonDockPause(paused: boolean) {
    if (typeof window === 'undefined') return
    window.dispatchEvent(
      new CustomEvent('batshit:goon-dock-pause', {
        detail: {
          source: GOON_DOCK_PAUSE_SOURCE,
          paused
        }
      })
    )
  }

  function queueKitchenPreviewLoad<T>(task: () => Promise<T>) {
    const next = kitchenPreviewLoadQueue.then(task, task)
    kitchenPreviewLoadQueue = next.then(
      () => undefined,
      () => undefined
    )
    return next
  }

  function nextKitchenPreviewLoadRequestId() {
    kitchenPreviewLoadRequestId += 1
    return kitchenPreviewLoadRequestId
  }

  function isKitchenPreviewLoadRequestCurrent(requestId: number) {
    return requestId === kitchenPreviewLoadRequestId
  }

  type VrmAnalysis = {
    materials: string[]
    expressions: GoonExpressionPreset[]
    bones: string[]
  }

  function formatWarningItems(items: string[], max = 6) {
    if (!items || items.length === 0) return ''
    const visible = items.slice(0, max).join(', ')
    if (items.length <= max) return visible
    return `${visible} (+${items.length - max} more)`
  }

  async function analyzeVrmUrl(url: string): Promise<VrmAnalysis> {
    const EngineCtor = await getGoonEngineCtor()
    if (!EngineCtor) {
      throw new Error('Goon engine unavailable')
    }
    const container = document.createElement('div')
    container.style.position = 'fixed'
    container.style.width = '1px'
    container.style.height = '1px'
    container.style.opacity = '0'
    container.style.pointerEvents = 'none'
    container.style.left = '-9999px'
    container.style.top = '-9999px'
    document.body.appendChild(container)
    const engine = new EngineCtor(container, {
      quality: 'low',
      lipSyncEnabled: false
    })
    try {
      await engine.init()
      await engine.loadGoon(url)
      const expressionNames = Array.from(
        new Set([
          ...engine.getExpressionPresetNames(),
          ...engine.getCustomExpressionNames()
        ])
      )
      return {
        materials: engine.getMaterialNames(),
        expressions: expressionNames as GoonExpressionPreset[],
        bones: engine.getHumanoidBoneNames()
      }
    } finally {
      engine.dispose()
      container.remove()
    }
  }

  async function analyzeVrmFile(file: File): Promise<VrmAnalysis> {
    const objectUrl = URL.createObjectURL(file)
    try {
      return await analyzeVrmUrl(objectUrl)
    } finally {
      URL.revokeObjectURL(objectUrl)
    }
  }

  async function getCurrentVrmAnalysis(): Promise<VrmAnalysis | null> {
    if (!editorGoon?.files?.vrm?.url) return null
    if (editorGoon.files?.vrmPending?.url) {
      return analyzeVrmUrl(editorGoon.files.vrm.url)
    }
    const engine = await ensurePreviewGoonReady()
    if (engine) {
      const expressionNames = Array.from(
        new Set([
          ...engine.getExpressionPresetNames(),
          ...engine.getCustomExpressionNames()
        ])
      )
      return {
        materials: engine.getMaterialNames(),
        expressions: expressionNames as GoonExpressionPreset[],
        bones: engine.getHumanoidBoneNames()
      }
    }
    return analyzeVrmUrl(editorGoon.files.vrm.url)
  }

  function buildVrmUpdateReport(
    goon: GoonRecord,
    current: VrmAnalysis | null,
    next: VrmAnalysis,
    resolved: ReturnType<typeof resolveGoonCues>
  ): GoonVrmUpdateReport | null {
    const nextMaterials = new Set(next.materials)
    const nextExpressions = new Set(next.expressions)
    const nextBones = new Set(next.bones)

    const missingMaterials =
      current?.materials.filter((name) => !nextMaterials.has(name)) ?? []

    const usedExpressionPresets = new Set<GoonExpressionPreset>()
    for (const cue of Object.values(resolved.cueMap)) {
      const portableTargets = resolveEditorFaceProfiles(
        cue,
        false
      ).portable.expressionTargets
      for (const target of portableTargets ?? []) {
        usedExpressionPresets.add(target.preset)
      }
    }
    const missingExpressions = Array.from(usedExpressionPresets).filter((preset) => {
      if (preset.endsWith('Head')) return false
      return !nextExpressions.has(preset)
    })

    const missingBones = current
      ? current.bones.filter((bone) => !nextBones.has(bone))
      : []

    const disabledCues: string[] = []
    for (const cue of Object.values(resolved.cueMap)) {
      const portableTargets = resolveEditorFaceProfiles(
        cue,
        false
      ).portable.expressionTargets
      if (!portableTargets || portableTargets.length === 0) continue
      if (cue.animationName) continue
      const hasAnyExpression = portableTargets.some((target) =>
        target.preset.endsWith('Head') ? true : nextExpressions.has(target.preset)
      )
      if (hasAnyExpression) continue
      disabledCues.push(cue.name)
    }

    const report: GoonVrmUpdateReport = {
      updated_at: new Date().toISOString()
    }
    if (missingMaterials.length > 0) report.missingMaterials = missingMaterials
    if (missingExpressions.length > 0) report.missingExpressions = missingExpressions
    if (missingBones.length > 0) report.missingBones = missingBones
    if (disabledCues.length > 0) report.disabledCues = disabledCues

    const hasWarnings =
      (report.missingMaterials?.length ?? 0) > 0 ||
      (report.missingExpressions?.length ?? 0) > 0 ||
      (report.missingBones?.length ?? 0) > 0 ||
      (report.disabledCues?.length ?? 0) > 0

    return hasWarnings ? report : null
  }

  function normalizeTagInput(value: string) {
    const entries = value
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean)
    return Array.from(new Set(entries))
  }

  function addAnimationTag(filename: string, tag: string) {
    const current = animationTagInputs[filename] ?? ''
    const tags = normalizeTagInput(current)
    const normalized = tag.trim().toLowerCase()
    if (!normalized || tags.includes(normalized)) return
    tags.push(normalized)
    animationTagInputs = { ...animationTagInputs, [filename]: tags.join(', ') }
  }

  function removeAnimationTag(filename: string, tag: string) {
    const current = animationTagInputs[filename] ?? ''
    const nextTags = normalizeTagInput(current).filter((entry) => entry !== tag.trim().toLowerCase())
    animationTagInputs = { ...animationTagInputs, [filename]: nextTags.join(', ') }
  }

  function getAvailableAnimationTagChoices(currentTags: string[]) {
    return animationTagOptions.filter((tag) => tag && !currentTags.includes(tag))
  }

  function addNewAnimationTag(filename: string) {
    const normalized = newAnimationTagDraft.trim().toLowerCase()
    if (!normalized) return
    addAnimationTag(filename, normalized)
    newAnimationTagDraft = ''
  }

  function ensureAnimationTagInput(file: GoonFileRef) {
    if (!file.filename) return
    if (animationDisplayNameInputs[file.filename] === undefined) {
      animationDisplayNameInputs = {
        ...animationDisplayNameInputs,
        [file.filename]: resolveMotionDisplayName(file)
      }
    }
    if (animationTagInputs[file.filename] === undefined) {
      animationTagInputs = {
        ...animationTagInputs,
        [file.filename]: (file.tags ?? []).join(', ')
      }
    }
    if (animationPostureInputs[file.filename] === undefined) {
      animationPostureInputs = {
        ...animationPostureInputs,
        [file.filename]: file.motionMeta?.posture ?? ''
      }
    }
    if (animationPlaybackInputs[file.filename] === undefined) {
      animationPlaybackInputs = {
        ...animationPlaybackInputs,
        [file.filename]: file.motionMeta?.playback ?? ''
      }
    }
    if (animationEyeContactInputs[file.filename] === undefined) {
      animationEyeContactInputs = {
        ...animationEyeContactInputs,
        [file.filename]: file.motionMeta?.eyeContact ?? ''
      }
    }
  }

  function buildMotionDraftSettings() {
    return buildNextSettingsWithPostures(motionCustomPostureDraftMap)
  }

  function resolveMotionDraftPayload(file: GoonFileRef) {
    const filename = file.filename ?? ''
    const displayName = (animationDisplayNameInputs[filename] ?? resolveMotionDisplayName(file)).trim()
    const tags = normalizeTagInput(animationTagInputs[filename] ?? (file.tags ?? []).join(', '))
    const motionMeta: GoonMotionMetadata = {}
    const posture = animationPostureInputs[filename] ?? file.motionMeta?.posture ?? ''
    if (posture && motionStagePostureMap[posture]) {
      motionMeta.posture = posture
    }
    const playback = animationPlaybackInputs[filename] ?? file.motionMeta?.playback ?? ''
    if (playback === 'loop' || playback === 'oneshot') {
      motionMeta.playback = playback
    }
    const eyeContact = animationEyeContactInputs[filename] ?? file.motionMeta?.eyeContact ?? ''
    if (eyeContact === 'off') {
      motionMeta.eyeContact = eyeContact
    }
    return { displayName, tags, motionMeta }
  }

  function hasMotionMetadataChanges(file: GoonFileRef) {
    const draft = resolveMotionDraftPayload(file)
    const currentDisplayName = resolveMotionDisplayName(file).trim()
    const currentTags = normalizeTagInput((file.tags ?? []).join(', '))
    const currentPosture = file.motionMeta?.posture ?? ''
    const currentPlayback = file.motionMeta?.playback ?? ''
    const currentEyeContact = file.motionMeta?.eyeContact ?? ''
    return (
      draft.displayName !== currentDisplayName ||
      draft.tags.join('|') !== currentTags.join('|') ||
      (draft.motionMeta.posture ?? '') !== currentPosture ||
      (draft.motionMeta.playback ?? '') !== currentPlayback ||
      (draft.motionMeta.eyeContact ?? '') !== currentEyeContact
    )
  }

  // ---- Unified motion entry helpers (one card per animation name) ----

  function resolveMotionEntryUploadTime(entry: UnifiedGoonMotionEntry) {
    return entry.files.reduce((latest, file) => Math.max(latest, resolveUploadTime(file)), 0)
  }

  type MotionEntryDraft = {
    displayName: string
    tags: string
    posture: GoonPosture | ''
    playback: GoonMotionPlayback | ''
    eyeContact: GoonMotionEyeContact | ''
  }

  // Displayed card values: staged edits first, then the metadata winner's
  // stored values. Staged edits are written to every version of the entry,
  // so reading through the winner's filename stays consistent.
  function resolveMotionEntryDraft(entry: UnifiedGoonMotionEntry): MotionEntryDraft {
    const key = entry.primary.filename ?? ''
    return {
      displayName:
        animationDisplayNameInputs[key] ?? resolveMotionDisplayName(entry.primary),
      tags: animationTagInputs[key] ?? (entry.primary.tags ?? []).join(', '),
      posture: animationPostureInputs[key] ?? entry.primary.motionMeta?.posture ?? '',
      playback: animationPlaybackInputs[key] ?? entry.primary.motionMeta?.playback ?? '',
      eyeContact: animationEyeContactInputs[key] ?? entry.primary.motionMeta?.eyeContact ?? ''
    }
  }

  function resolveMotionEntryStagedTags(entry: UnifiedGoonMotionEntry) {
    return normalizeTagInput(resolveMotionEntryDraft(entry).tags)
  }

  // Metadata lockstep: any edit stages the FULL displayed draft onto every
  // version of the motion, so a previously divergent pair unifies to the
  // displayed (winner) values on the next save.
  function stageMotionEntryDraft(entry: UnifiedGoonMotionEntry, patch: Partial<MotionEntryDraft>) {
    const nextDraft: MotionEntryDraft = { ...resolveMotionEntryDraft(entry), ...patch }
    const nextDisplayNames = { ...animationDisplayNameInputs }
    const nextTags = { ...animationTagInputs }
    const nextPostures = { ...animationPostureInputs }
    const nextPlaybacks = { ...animationPlaybackInputs }
    const nextEyeContacts = { ...animationEyeContactInputs }
    for (const file of entry.files) {
      const filename = file.filename ?? ''
      if (!filename) continue
      nextDisplayNames[filename] = nextDraft.displayName
      nextTags[filename] = nextDraft.tags
      nextPostures[filename] = nextDraft.posture
      nextPlaybacks[filename] = nextDraft.playback
      nextEyeContacts[filename] = nextDraft.eyeContact
    }
    animationDisplayNameInputs = nextDisplayNames
    animationTagInputs = nextTags
    animationPostureInputs = nextPostures
    animationPlaybackInputs = nextPlaybacks
    animationEyeContactInputs = nextEyeContacts
  }

  function addMotionEntryTag(entry: UnifiedGoonMotionEntry, tag: string) {
    const tags = resolveMotionEntryStagedTags(entry)
    const normalized = tag.trim().toLowerCase()
    if (!normalized || tags.includes(normalized)) return
    stageMotionEntryDraft(entry, { tags: [...tags, normalized].join(', ') })
  }

  function removeMotionEntryTag(entry: UnifiedGoonMotionEntry, tag: string) {
    const normalized = tag.trim().toLowerCase()
    const tags = resolveMotionEntryStagedTags(entry).filter((value) => value !== normalized)
    stageMotionEntryDraft(entry, { tags: tags.join(', ') })
  }

  function addNewMotionEntryTag(entry: UnifiedGoonMotionEntry) {
    const normalized = newAnimationTagDraft.trim().toLowerCase()
    if (!normalized) return
    addMotionEntryTag(entry, normalized)
    newAnimationTagDraft = ''
  }

  // Per-card preview format: which version (VRMA or GLB) the thumb and the
  // stage preview play. Session-only state keyed by motion name.
  let motionCardPreviewLanes = $state<Record<string, GoonMotionLane>>({})

  function resolveMotionEntryPreviewLane(entry: UnifiedGoonMotionEntry): GoonMotionLane {
    const requested = motionCardPreviewLanes[entry.name]
    if (requested === 'glb' && entry.glb) return 'glb'
    if (requested === 'vrm' && entry.vrma) return 'vrm'
    return entry.vrma ? 'vrm' : 'glb'
  }

  function resolveMotionEntryPreviewFile(entry: UnifiedGoonMotionEntry): GoonFileRef {
    return (resolveMotionEntryPreviewLane(entry) === 'glb' ? entry.glb : entry.vrma) ?? entry.primary
  }

  function setMotionEntryPreviewLane(entry: UnifiedGoonMotionEntry, lane: GoonMotionLane) {
    if (resolveMotionEntryPreviewLane(entry) === lane) return
    motionCardPreviewLanes = { ...motionCardPreviewLanes, [entry.name]: lane }
    // If this motion is playing on the stage, switch the stage to the other
    // format immediately so the toggle verifies both versions.
    if (activePreviewId === entry.name) {
      const laneFile = (lane === 'glb' ? entry.glb : entry.vrma) ?? entry.primary
      void triggerMotionLibraryPreview(laneFile, entry.name, entry.name)
    }
  }

  function postureMapsMatch(left: GoonPostureMap, right: GoonPostureMap) {
    const leftKeys = Object.keys(left).sort()
    const rightKeys = Object.keys(right).sort()
    if (leftKeys.join('|') !== rightKeys.join('|')) return false
    for (const key of leftKeys) {
      const leftPosture = left[key]
      const rightPosture = right[key]
      if (!leftPosture || !rightPosture) return false
      if (
        normalizePostureName(leftPosture.name) !== normalizePostureName(rightPosture.name) ||
        leftPosture.basePosture !== rightPosture.basePosture
      ) {
        return false
      }
    }
    return true
  }

  function resolveMotionLibraryEntries(sourceLibrary: GoonAnimationLibrary | null | undefined) {
    return Array.isArray(sourceLibrary?.vrma) ? sourceLibrary.vrma : []
  }

  function buildMotionsSourceSignature(
    sourceLibrary: GoonAnimationLibrary | null | undefined = animationLibrary,
    sourceSettings: GoonsSettings | null | undefined = goonsSettings
  ) {
    const customPostures = normalizeCustomPostureMap(sourceSettings?.kitchen?.postures)
    const libraryEntries = resolveMotionLibraryEntries(sourceLibrary)
    const postureSignature = JSON.stringify(
      Object.values(customPostures)
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((posture) => ({
          id: posture.id,
          name: normalizePostureName(posture.name),
          basePosture: posture.basePosture
        }))
    )
    const librarySignature = JSON.stringify(
      libraryEntries
        .filter((file) => file.filename)
        .sort((left, right) => (left.filename ?? '').localeCompare(right.filename ?? ''))
        .map((file) => ({
          filename: file.filename,
          displayName: resolveMotionDisplayName(file),
          tags: normalizeTagInput((file.tags ?? []).join(', ')),
          posture: file.motionMeta?.posture ?? '',
          playback: file.motionMeta?.playback ?? '',
          eyeContact: file.motionMeta?.eyeContact ?? ''
        }))
    )
    return `${postureSignature}::${librarySignature}`
  }

  function applyMotionsStateFromSources(
    sourceLibrary: GoonAnimationLibrary | null | undefined = animationLibrary,
    sourceSettings: GoonsSettings | null | undefined = goonsSettings
  ) {
    const customPostures = normalizeCustomPostureMap(sourceSettings?.kitchen?.postures)
    const libraryEntries = resolveMotionLibraryEntries(sourceLibrary)
    motionsCustomPostures = customPostures
    postureNameInputs = Object.fromEntries(
      Object.values(customPostures).map((posture) => [posture.id, posture.name])
    )
    postureBaseInputs = Object.fromEntries(
      Object.values(customPostures).map((posture) => [posture.id, posture.basePosture])
    ) as Record<string, GoonBasePosture>
    animationTagInputs = Object.fromEntries(
      libraryEntries
        .filter((file) => file.filename)
        .map((file) => [file.filename as string, (file.tags ?? []).join(', ')])
    )
    animationDisplayNameInputs = Object.fromEntries(
      libraryEntries
        .filter((file) => file.filename)
        .map((file) => [file.filename as string, resolveMotionDisplayName(file)])
    )
    animationPostureInputs = Object.fromEntries(
      libraryEntries
        .filter((file) => file.filename)
        .map((file) => [file.filename as string, file.motionMeta?.posture ?? ''])
    ) as Record<string, GoonPosture | ''>
    animationPlaybackInputs = Object.fromEntries(
      libraryEntries
        .filter((file) => file.filename)
        .map((file) => [file.filename as string, file.motionMeta?.playback ?? ''])
    ) as Record<string, GoonMotionPlayback | ''>
    animationEyeContactInputs = Object.fromEntries(
      libraryEntries
        .filter((file) => file.filename)
        .map((file) => [file.filename as string, file.motionMeta?.eyeContact ?? ''])
    ) as Record<string, GoonMotionEyeContact | ''>
    deletedMotionPostureBaseMap = {}
    editingMotionPostureId = null
    activeAnimationTagMenu = null
    newAnimationTagDraft = ''
    motionsAppliedSourceSignature = buildMotionsSourceSignature(sourceLibrary, sourceSettings)
    motionsHydrated = true
  }

  function cancelMotionChanges() {
    applyMotionsStateFromSources()
  }

  function validateMotionPostureDrafts() {
    for (const posture of Object.values(motionCustomPostureDraftMap)) {
      const name = normalizePostureName(posture.name)
      if (!name) {
        return 'Posture name cannot be empty.'
      }
      if (!isBuiltInPosture(posture.basePosture)) {
        return `Choose a valid Base Posture for ${posture.name}.`
      }
    }
    const seen = new Set<string>()
    for (const posture of Object.values(motionCustomPostureDraftMap)) {
      const normalized = normalizePostureName(posture.name).toLowerCase()
      if (seen.has(normalized)) {
        return 'Every posture needs a unique name.'
      }
      seen.add(normalized)
    }
    return null
  }

  async function saveMotionsAndPostures() {
    const validationError = validateMotionPostureDrafts()
    if (validationError) {
      toast.error(validationError)
      return false
    }

    motionsSaving = true
    try {
      const currentPostures = normalizeCustomPostureMap(goonsSettings?.kitchen?.postures)
      let savedMotionSettings = goonsSettings
      if (!postureMapsMatch(currentPostures, motionCustomPostureDraftMap)) {
        savedMotionSettings = buildMotionDraftSettings()
        savedMotionSettings = await persistGoonsSettings(savedMotionSettings)
      }

      let savedMotionLibrary: GoonAnimationLibrary = animationLibrary
      const filesToSave = [...vrmaLibrary]
      for (const file of filesToSave) {
        if (!file.filename || !hasMotionMetadataChanges(file)) continue
        const draft = resolveMotionDraftPayload(file)
        savedMotionLibrary = await updateGoonAnimationLibraryMetadata(file.filename, {
          displayName: draft.displayName,
          tags: draft.tags,
          motionMeta: draft.motionMeta
        })
      }

      applyMotionsStateFromSources(savedMotionLibrary, savedMotionSettings)
      toast.success('Motions saved')
      return true
    } catch (error: any) {
      toast.error(error?.message || 'Failed to save Motions')
      return false
    } finally {
      motionsSaving = false
    }
  }

  const motionsDirty = $derived.by(() => {
    if (!motionsHydrated) return false
    const currentPostures = normalizeCustomPostureMap(goonsSettings?.kitchen?.postures)
    if (!postureMapsMatch(currentPostures, motionCustomPostureDraftMap)) {
      return true
    }
    return vrmaLibrary.some((file) => hasMotionMetadataChanges(file))
  })

  const qualityOptions: Array<{ value: GoonEngineQuality; label: string }> = [
    { value: 'auto', label: 'Auto' },
    { value: 'low', label: 'Low' },
    { value: 'high', label: 'High' },
    { value: 'ultra', label: 'Ultra' }
  ]
  const kitchenEyeContactProfileOptions: Array<{
    value: GoonEyeContactGlobalProfile
    label: string
  }> = [
    { value: 'vroid', label: 'Standard/VRoid Goons' },
    { value: 'blender', label: 'Advanced/Blender Goons' }
  ]
  const activeKitchenEyeContactMode = $derived.by(() =>
    kitchenEyeContactProfile === 'vroid'
      ? kitchenEyeContactVroidMode
      : kitchenEyeContactBlenderMode
  )
  const activeKitchenEyeContactTuning = $derived.by(() =>
    kitchenEyeContactProfile === 'vroid'
      ? kitchenEyeContactVroidTuning
      : kitchenEyeContactBlenderTuning
  )

  const CUE_NAME_INFO = [
    'The AI sees this Name when it decides which Mood or Emote to use.',
    'Use a clear, recognizable name so the AI can understand the cue at a glance.'
  ]
  const CUE_DESCRIPTION_INFO = [
    'The AI also sees this Description when you provide one.',
    'Use it to explain the exact feeling, body language, or context so the AI knows what this cue really does.'
  ]
  const CUE_AUTO_ENABLE_INFO =
    'When enabled, this cue is included by default for newly created Goons. Existing Goons can still disable it individually.'
  const CUE_EMOJI_INFO =
    'This emoji mapping helps Batshit and the AI connect emoji-driven reactions to this Emote. You can use one emoji or a short combination.'
  const CUE_POSTURE_INFO = [
    'Choose a specific posture only when this Mood needs its own stage-placement rule.',
    'Leave it blank to inherit the linked Motion posture, and if that custom posture has no Scene Marker Batshit falls back to its Base Posture.'
  ]
  const CUE_LOOP_MOTION_INFO =
    'Moods use Loop Motion. The selected animation repeats for as long as the Mood stays active.'
  const CUE_PAUSE_SPEECH_INFO =
    'Pause Speech temporarily pauses spoken output while the cue plays. Duration controls how long the pause lasts.'
  const CUE_DURATION_INFO =
    'Duration controls how long the one-shot Emote pause lasts when Pause Speech is enabled.'
  const CUE_FACIAL_TIMING_INFO =
    'Facial Timing controls how the face fades in, holds, and fades out. Step-based Emotes get their own timing for each step.'
  const EDITOR_BASIC_SETTINGS_INFO =
    'These are the core saved defaults for this Goon: identity, lip sync, quality, starting Mood, and default Scene.'
  const EDITOR_GOON_NAME_INFO =
    'This is the display name Batshit shows for this Goon across the app.'
  const EDITOR_DESCRIPTION_INFO =
    'Description is optional. Use it for a quick note about the Goon, style, or intended role.'
  const EDITOR_LIP_SYNC_INFO =
    'Lip Sync turns live mouth movement on or off for this Goon.'
  const EDITOR_EYE_CONTACT_MODE_INFO =
    'Choose which eye-contact lane Batshit should use for this Goon. Bone only uses real eye bones. Expression uses VRM eye-look expressions or Advanced/Blender eye-look morph controls.'
  const EDITOR_EYE_CONTACT_TUNING_INFO =
    'Advanced per-Goon tuning for eye contact. Batshit now splits one shared camera target between eyes and head, so the eyes handle whatever target the head has not claimed yet.'
  const KITCHEN_EYE_CONTACT_INFO =
    'Global Eye Contact settings are used as the starting point for Goons that do not have their own per-Goon tuning.'
  const EDITOR_EYE_CONTACT_COORDINATION_INFO =
    'Head Share controls how much head movement counts toward the shared target. Higher values make the eyes back off more once the head joins in.'
  const EDITOR_QUALITY_INFO =
    'Quality sets the saved default render quality Batshit should prefer for this Goon.'
  const EDITOR_CURRENT_MOOD_INFO =
    'Current Mood is the saved default Mood this Goon starts from until something changes it.'
  const EDITOR_DEFAULT_SCENE_INFO =
    'Default Scene chooses which saved Scene Batshit should prefer for this Goon.'
  const EDITOR_VRM_FILE_INFO = [
    'Use this section to replace the current VRM, apply a pending update, discard it, or restore the previous VRM.',
    'Duplicate and Default Pack actions stay here because they belong to this specific Goon file setup.'
  ]
  const EDITOR_GUIDED_PACKAGE_INFO = [
    'Use this section to review or update the Goon File Package that produced this Advanced/Blender Goon’s current VRM and saved outfit metadata.',
    'Raw VRM replacement is intentionally disabled for this lane because the package manifest and the extracted VRM need to stay in sync.',
    'Package updates keep moods, emotes, eye contact, camera, Wardrobe items, Outfits, and DUF clothes where possible. Painted conceal masks are cleared because they are tied to the old mesh topology.'
  ]
  const EDITOR_CUSTOM_PACKAGE_INFO = [
    'Use this section to review the current Custom package files and manage package-level actions for this Goon.',
    'Custom stage preview already runs through the shared Scene system, while motions, outfits, and other Custom runtime/editor steps still continue later.'
  ]
  const EDITOR_GOON_ANIMATIONS_INFO = [
    'These are per-Goon animation files instead of the shared global Motion library.',
    'VRMA works across VRM avatars, while GLB and GLTF motions still need to match this Goon’s rig directly.'
  ]
  const EDITOR_CLOSET_INFO =
    'Wardrobe is this Goon’s clothing workspace: choose what the Goon wears, edit the selected item, and reset per-Goon edits without changing the Global Closet.'
  const EDITOR_CUSTOM_CLOSET_INFO =
    'Wardrobe edits are saved per Goon on the selected item. Global items stay shared until this Goon paints, recolors, or otherwise edits them.'
  const EDITOR_CLOSET_SLOTS_INFO = [
    'Wardrobe is where you decide what this Goon wears right now.',
    'Slot cards use the live VRM material slots when Batshit can detect them, and Advanced/Blender outfit pieces fall back to the same slot-style card layout when they do not map cleanly to a VRM slot.',
    'Import shared XWear items in the Global Closet first, then use these slots to pick Original, None, or a Global/Goon item. Edited items show an Edited badge in the same list.'
  ]
  const EDITOR_DELETE_GOON_INFO = [
    'Deleting a Goon is permanent and removes all of the work saved on that Goon, including its overrides and tuning.',
    'Use this only when you truly want to remove the Goon and start over.'
  ]

  const ANIMATION_TAG_PRESETS = [
    'idle',
    'walk',
    'run',
    'gesture',
    'pose',
    'dance',
    'stretch',
    'cheer',
    'conversation'
  ]

  const CLOSET_CATEGORY_OPTIONS = [
    'top',
    'bottom',
    'dress',
    'inner_top',
    'inner_bottom',
    'shoes',
    'socks',
    'arm_accessory',
    'neck_accessory',
    'accessory',
    'other'
  ]

  function cloneCueMap(cues?: GoonCueMap) {
    return JSON.parse(JSON.stringify(cues ?? {})) as GoonCueMap
  }

  function cloneEmojiMap(map?: GoonEmojiMap) {
    return JSON.parse(JSON.stringify(map ?? {})) as GoonEmojiMap
  }

  function normalizeEmojiInput(value: string) {
    if (!value) return ''
    return value.replace(EMOJI_VARIATION_REGEX, '').replace(EMOJI_MODIFIER_REGEX, '')
  }

  function extractEmojis(value: string) {
    const trimmed = value.trim()
    if (!trimmed) return [] as string[]
    const emojis: string[] = []

    if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
      const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
      for (const segment of segmenter.segment(trimmed)) {
        const part = segment.segment
        if (!part) continue
        if (part.trim() === '') continue
        if (EMOJI_TEST_REGEX.test(part)) {
          emojis.push(normalizeEmojiInput(part))
        }
      }
    } else {
      for (const match of trimmed.matchAll(EMOJI_REGEX)) {
        emojis.push(normalizeEmojiInput(match[0]))
      }
    }

    return emojis
  }

  function normalizeEmoteEmojiInput(value: string) {
    const trimmed = value.trim()
    if (!trimmed) return ''
    const inner =
      trimmed.startsWith('(') && trimmed.endsWith(')') ? trimmed.slice(1, -1).trim() : trimmed
    const emojis = extractEmojis(inner)
    if (emojis.length === 0) return ''
    return emojis.slice(0, 2).join('+')
  }

  function formatEmoteEmojiLabel(value: string) {
    return normalizeEmoteEmojiInput(value)
  }

  function resolveEmoteEmojiFromMap(cueName: string, emojiMap: GoonEmojiMap) {
    for (const [emoji, mapped] of Object.entries(emojiMap)) {
      if (mapped === cueName) {
        return normalizeEmoteEmojiInput(emoji)
      }
    }
    return ''
  }

  function buildEmoteEmojiDrafts(cues: GoonCueMap, emojiMap: GoonEmojiMap) {
    const drafts: Record<string, string> = {}
    for (const cue of Object.values(cues)) {
      if (cue.kind !== 'emote') continue
      const emoji = resolveEmoteEmojiFromMap(cue.name, emojiMap)
      if (emoji) {
        drafts[cue.name] = emoji
      }
    }
    return drafts
  }

  function getActiveEmoteEmojiDrafts() {
    return activeTab === 'kitchen' ? kitchenEmoteEmojiDrafts : editorEmoteEmojiDrafts
  }

  function setActiveEmoteEmojiDrafts(next: Record<string, string>) {
    if (activeTab === 'kitchen') {
      kitchenEmoteEmojiDrafts = next
      return
    }
    editorEmoteEmojiDrafts = next
  }

  function buildEmojiMapFromDrafts(
    cues: GoonCueMap,
    emojiMap: GoonEmojiMap,
    drafts: Record<string, string>
  ) {
    const next: GoonEmojiMap = {}
    const conflicts: string[] = []

    for (const cue of Object.values(cues)) {
      if (cue.kind !== 'emote') continue
      const rawValue =
        cue.name in drafts ? drafts[cue.name] ?? '' : resolveEmoteEmojiFromMap(cue.name, emojiMap)
      const normalized = normalizeEmoteEmojiInput(rawValue)
      if (!normalized) continue
      if (next[normalized] && next[normalized] !== cue.name) {
        conflicts.push(normalized)
        continue
      }
      next[normalized] = cue.name
    }

    return {
      emojiMap: next,
      conflicts
    }
  }

  function cloneClosetLibrary(library?: GoonClosetLibrary) {
    return JSON.parse(JSON.stringify(library ?? { items: {} })) as GoonClosetLibrary
  }

  function cloneRoomTextureLibrary(library?: GoonRoomTextureLibrary) {
    const cloned = JSON.parse(JSON.stringify(library ?? {})) as GoonRoomTextureLibrary
    const existingTrim = cloned.trim ?? []
    const builtIn = new Set(BUILTIN_TRIM_TEXTURES.map((entry) => entry.filename))
    const mergedTrim = [
      ...BUILTIN_TRIM_TEXTURES,
      ...existingTrim.filter((entry) => !builtIn.has(entry.filename))
    ]
    cloned.trim = mergedTrim
    return cloned
  }

  function cloneSceneMap(map?: GoonSceneMap) {
    return JSON.parse(JSON.stringify(map ?? {})) as GoonSceneMap
  }

  function formatCategoryLabel(category: string) {
    if (!category) return 'Uncategorized'
    return category.replace(/_/g, ' ')
  }

  function deriveClosetCategoryFromMaterialName(name: string) {
    const lower = name.toLowerCase()
    if (lower.includes('_shoes_')) return 'shoes'
    if (lower.includes('_socks_')) return 'socks'
    if (lower.includes('_bottoms_')) return 'bottom'
    if (lower.includes('_onepiece_') || lower.includes('_dress_')) return 'dress'
    if (lower.includes('_tops_')) return 'top'
    if (lower.includes('inner') && lower.includes('top')) return 'inner_top'
    if (lower.includes('inner') && lower.includes('bottom')) return 'inner_bottom'
    if (lower.includes('accessory') && lower.includes('arm')) return 'arm_accessory'
    if (lower.includes('accessory') && (lower.includes('tie') || lower.includes('neck'))) {
      return 'neck_accessory'
    }
    if (lower.includes('accessory')) return 'accessory'
    return 'other'
  }

  function getClosetItemPreviewUrl(item: GoonClosetItem) {
    return item.texture?.url ?? item.xwear?.textures?._MainTex?.url ?? null
  }

  function getClosetItemSlotLabels(item: GoonClosetItem) {
    if (item.originalSource?.kind === 'slot-original') {
      return [resolveClosetSlotNickname(item.originalSource.slotName)]
    }
    if (item.originalSource?.kind === 'guided-piece-original') {
      return [resolveGuidedOutfitPiece(item.originalSource.pieceId)?.label ?? 'Original Piece']
    }

    const labels: string[] = []
    const seen = new Set<string>()

    for (const material of getXWearMaterials(item.xwear)) {
      const label = getDefaultClosetSlotLabel(material.materialName)
      if (seen.has(label)) continue
      seen.add(label)
      labels.push(label)
    }

    if (labels.length > 0) return labels
    return [getDefaultClosetSlotLabel(item.xwear?.materialName ?? '')]
  }

  function getClosetItemSlotLabelText(item: GoonClosetItem) {
    return getClosetItemSlotLabels(item).join(' • ')
  }

  function resolveClosetItem(itemId?: string | null) {
    if (!itemId) return null
    const localItem = editorCustomClosetItemsById.get(itemId)
    if (localItem) return localItem
    const globalItem = closetItemsById.get(itemId)
    if (!globalItem) return null
    return resolveEditorClosetItemForGlobalSource(globalItem.id) ?? globalItem
  }

  function resolveGuidedOutfitPiece(pieceId?: string | null) {
    if (!pieceId) return null
    return editorGuidedOutfitPiecesDraft.find((piece) => piece.id === pieceId) ?? null
  }

  function clonePaintedConcealDraft(draft: Record<string, number[]> = paintedConcealDraftTriangles) {
    return Object.fromEntries(
      Object.entries(draft).map(([meshName, triangleIndices]) => [
        meshName,
        [...new Set(triangleIndices)].sort((a, b) => a - b)
      ])
    )
  }

  function getPaintedConcealDraftTriangleCount() {
    return Object.values(paintedConcealDraftTriangles).reduce(
      (total, indices) => total + indices.length,
      0
    )
  }

  function getPaintedConcealDraftCountLabel() {
    const count = getPaintedConcealDraftTriangleCount()
    return `${count} face${count === 1 ? '' : 's'} concealed`
  }

  function getPaintedConcealInstructionLabel() {
    return paintedConcealStatus
      ? `Hold Shift + Drag to Use Brush - ${paintedConcealStatus}`
      : 'Hold Shift + Drag to Use Brush'
  }

  function resolvePaintedConcealPose(id: PaintedConcealPoseId = paintedConcealPoseId) {
    return PAINTED_CONCEAL_POSES.find((pose) => pose.id === id) ?? DEFAULT_PAINTED_CONCEAL_POSE
  }

  async function ensurePaintedConcealPoseAnimations(engine: GoonEngine) {
    await engine.loadAdditionalAnimations(PAINTED_CONCEAL_POSE_FILES)
  }

  function applyPaintedConcealPoseToPreview() {
    const pose = resolvePaintedConcealPose()
    previewEngine?.setAuthoringPoseMode(true, pose.animationName)
  }

  function selectPaintedConcealPose(id: PaintedConcealPoseId) {
    paintedConcealPoseId = id
    if (paintedConcealEditorOpen) {
      applyPaintedConcealPoseToPreview()
    }
  }

  function getPaintedConcealTriangleCount(mask?: GoonPaintedConcealMask | null) {
    return countPaintedConcealTriangles(mask)
  }

  function getPaintedConcealCountLabel(mask?: GoonPaintedConcealMask | null) {
    const count = getPaintedConcealTriangleCount(mask)
    return `${count} painted triangle${count === 1 ? '' : 's'}`
  }

  function buildPaintedConcealDraftFromMask(
    mask: GoonPaintedConcealMask | null | undefined,
    topology: GoonBodyConcealTopology
  ) {
    const normalized = normalizePaintedConcealMask(mask)
    if (!normalized || normalized.topologySignature !== topology.topologySignature) return {}
    const topologyMeshes = new Map(topology.meshes.map((mesh) => [mesh.mesh, mesh]))
    const draft: Record<string, number[]> = {}
    for (const meshMask of normalized.meshes) {
      const topologyMesh = topologyMeshes.get(meshMask.mesh)
      if (!topologyMesh || topologyMesh.topologySignature !== meshMask.topologySignature) continue
      draft[meshMask.mesh] = expandPaintedTriangleRanges(meshMask.triangleRanges, topologyMesh.triangleCount)
    }
    return draft
  }

  function buildPaintedConcealMaskFromDraft() {
    if (!paintedConcealTopology) return undefined
    const meshes = paintedConcealTopology.meshes
      .map((topologyMesh) => {
        const triangleRanges = compressPaintedTriangleRanges(paintedConcealDraftTriangles[topologyMesh.mesh])
        if (triangleRanges.length === 0) return null
        return {
          mesh: topologyMesh.mesh,
          topologySignature: topologyMesh.topologySignature,
          triangleCount: topologyMesh.triangleCount,
          vertexCount: topologyMesh.vertexCount,
          triangleRanges
        }
      })
      .filter((mesh): mesh is GoonPaintedConcealMeshMask => Boolean(mesh))
    if (meshes.length === 0) return undefined
    return {
      version: 1,
      topologySignature: paintedConcealTopology.topologySignature,
      meshes,
      updatedAt: new Date().toISOString()
    } satisfies GoonPaintedConcealMask
  }

  function isEditorClosetItemAssigned(itemId: string) {
    const targetItem = resolveClosetItem(itemId)
    return Object.values(closetAssignments).some(
      (assignment) =>
        assignment.mode === 'item' &&
        (assignment.itemId === itemId ||
          (targetItem ? resolveClosetItem(assignment.itemId)?.id === targetItem.id : false))
    )
  }

  function resolvePaintedConcealTargetItem(target: PaintedConcealEditorTarget | null = paintedConcealTarget) {
    if (!target) return null
    if (target.kind === 'closet-item') return resolveClosetItem(target.itemId)
    if (target.kind === 'slot-original') return resolveSavedOriginalClosetItemForSlot(target.slotName)
    return resolveSavedOriginalClosetItemForGuidedPiece(target.pieceId)
  }

  function resolvePaintedConcealTargetLabel(target: PaintedConcealEditorTarget | null = paintedConcealTarget) {
    if (!target) return 'Wearable'
    if (target.kind === 'closet-item') return resolveClosetItem(target.itemId)?.name ?? 'Wardrobe item'
    if (target.kind === 'slot-original') return `${resolveClosetSlotNickname(target.slotName)} Original`
    return resolveGuidedOutfitPiece(target.pieceId)?.label ?? 'Original piece'
  }

  function isPaintedConcealTargetActive(target: PaintedConcealEditorTarget | null = paintedConcealTarget) {
    if (!target) return false
    if (target.kind === 'closet-item') {
      return isEditorClosetItemAssigned(target.itemId)
    }
    if (target.kind === 'slot-original') {
      return resolveClosetSlotValue(target.slotName) === '__original__'
    }
    const piece = resolveGuidedOutfitPiece(target.pieceId)
    return piece ? getGuidedPieceState(piece) : false
  }

  function appendDraftMaskForPreview(target: PaintedConcealEditorTarget, draftMask?: GoonPaintedConcealMask) {
    if (!draftMask) return false
    if (target.kind === 'closet-item') {
      return false
    }
    if (target.kind === 'slot-original') return isPaintedConcealTargetActive(target)
    return isPaintedConcealTargetActive(target)
  }

  async function applyPaintedConcealDraftPreview() {
    if (!previewEngine || !paintedConcealTopology || !paintedConcealTarget) return
    const draftMask = buildPaintedConcealMaskFromDraft()
    const target = paintedConcealTarget
    const targetItemId = target.kind === 'closet-item' ? target.itemId : null
    const targetItem = targetItemId ? resolveClosetItem(targetItemId) : null
    const bodyConceal = resolveActiveWearableConceal({
      closetAssignments,
      resolveClosetItem: (itemId) => {
        const item = resolveClosetItem(itemId)
        if (!targetItemId || !targetItem || !item || item.id !== targetItem.id) return item
        return {
          ...item,
          paintedConcealMask: draftMask
        }
      },
      resolveOriginalSavedItem: (source) => {
        const existing = resolveOriginalSavedItemForConceal(source)
        if (target.kind === 'closet-item' && originalSourceMatches(targetItem?.originalSource, source)) {
          return {
            ...(targetItem ?? existing ?? {
              id: target.itemId,
              name: resolvePaintedConcealTargetLabel(target),
              category: 'original'
            }),
            paintedConcealMask: draftMask
          }
        }
        if (target.kind === 'slot-original' && originalSourceMatches(source, target)) {
          return {
            ...(existing ?? buildSyntheticOriginalClosetItem(target)),
            paintedConcealMask: draftMask
          }
        }
        if (target.kind === 'guided-piece-original' && originalSourceMatches(source, target)) {
          return {
            ...(existing ?? buildSyntheticOriginalClosetItem(target)),
            paintedConcealMask: draftMask
          }
        }
        return existing
      },
      guidedOutfitPieces: editorGuidedOutfitPiecesDraft,
      guidedPieceStates: buildPersistedGuidedPieceStates(editorGuidedOutfitPiecesDraft)
    })
    previewEngine.applyBodyConceal({
      paintedMasks: appendDraftMaskForPreview(target, draftMask)
        ? [...bodyConceal.paintedMasks, draftMask]
        : bodyConceal.paintedMasks
    })
  }

  function buildSyntheticOriginalClosetItem(target: Extract<PaintedConcealEditorTarget, { kind: 'slot-original' | 'guided-piece-original' }>) {
    return {
      id: `synthetic_${target.kind}`,
      originalSource:
        target.kind === 'slot-original'
          ? { kind: 'slot-original', slotName: target.slotName }
          : { kind: 'guided-piece-original', pieceId: target.pieceId },
      name: resolvePaintedConcealTargetLabel(target),
      category:
        target.kind === 'slot-original'
          ? getClosetSlotTypeLabel(target.slotName)
          : resolveGuidedOutfitPiece(target.pieceId)?.category ?? 'original'
    } satisfies GoonClosetItem
  }

  async function openPaintedConcealEditorForTarget(target: PaintedConcealEditorTarget) {
    try {
      const engine = await ensurePreviewGoonReady()
      if (!engine) throw new Error('Load the preview before painting conceal masks.')
      const topology = engine.getBodyConcealTopology()
      if (!topology) {
        throw new Error('This Goon does not expose a paintable body mesh yet.')
      }
      await ensurePaintedConcealPoseAnimations(engine)
      const item = resolvePaintedConcealTargetItem(target)
      const existingMask = normalizePaintedConcealMask(item?.paintedConcealMask)
      paintedConcealTarget = target
      paintedConcealTopology = topology
      paintedConcealDraftTriangles = buildPaintedConcealDraftFromMask(existingMask, topology)
      paintedConcealHistory = []
      paintedConcealTool = 'paint'
      paintedConcealBrushRadius = 18
      paintedConcealShiftHeld = false
      paintedConcealPointerInPreview = false
      paintedConcealStatus =
        existingMask && existingMask.topologySignature !== topology.topologySignature
          ? 'Saved painted conceal was made for a different Goon file and is ignored.'
          : isPaintedConcealTargetActive(target)
            ? null
            : 'Wear this item before painting to see the clothing and body together.'
      paintedConcealEditorOpen = true
      applyPaintedConcealPoseToPreview()
      await applyPaintedConcealDraftPreview()
    } catch (error: any) {
      toast.error(error?.message || 'Failed to open painted conceal editor')
    }
  }

  async function openClosetItemPaintedConcealEditor(item: GoonClosetItem, slotName?: string) {
    const target: PaintedConcealEditorTarget = { kind: 'closet-item', itemId: item.id, slotName }
    if (!slotName && !isPaintedConcealTargetActive(target)) {
      toast.error('Wear this Wardrobe item first, then use Conceal from Wardrobe so the mask applies to the visible item.')
      return
    }
    await openPaintedConcealEditorForTarget(target)
  }

  async function openClosetSlotPaintedConcealEditor(
    slotName: string,
    assignment: GoonClosetAssignment = buildClosetSlotWorkingAssignment(slotName)
  ) {
    if (assignment.mode === 'none') {
      toast.error('Choose Original or a Wardrobe item before painting this slot.')
      return
    }
    if (assignment.mode === 'item' && assignment.itemId) {
      const item = resolveClosetItem(assignment.itemId)
      if (!item) {
        toast.error('Wardrobe item could not be found.')
        return
      }
      await openClosetItemPaintedConcealEditor(item, slotName)
      return
    }
    await openPaintedConcealEditorForTarget({ kind: 'slot-original', slotName })
  }

  async function openGuidedPiecePaintedConcealEditor(piece: GoonGuidedOutfitPiece) {
    if (!getGuidedPieceState(piece)) {
      toast.error('Choose Original before painting this piece.')
      return
    }
    const selectedItem = resolveStandaloneGuidedPieceSelectedItem(piece)
    if (selectedItem) {
      await openClosetItemPaintedConcealEditor(
        selectedItem,
        buildGuidedPieceOriginalClosetSlot(piece.id)
      )
      return
    }
    await openPaintedConcealEditorForTarget({ kind: 'guided-piece-original', pieceId: piece.id })
  }

  function closePaintedConcealEditor() {
    releasePaintedConcealPointerCapture(paintedConcealPointerId)
    paintedConcealEditorOpen = false
    paintedConcealTarget = null
    paintedConcealTopology = null
    paintedConcealDraftTriangles = {}
    paintedConcealHistory = []
    paintedConcealPainting = false
    paintedConcealPointerId = null
    paintedConcealShiftHeld = false
    paintedConcealPointerInPreview = false
    paintedConcealStatus = null
    previewEngine?.setAuthoringPoseMode(false)
    queueLoggedEditorPreviewUpdate(
      'painted-conceal-close',
      () => refreshEditorClosetPreview()
    )
  }

  function upsertOriginalPaintedConcealTarget(
    target: Extract<PaintedConcealEditorTarget, { kind: 'slot-original' | 'guided-piece-original' }>,
    mask?: GoonPaintedConcealMask
  ) {
    const originalSource: GoonClosetOriginalSource =
      target.kind === 'slot-original'
        ? { kind: 'slot-original', slotName: target.slotName }
        : { kind: 'guided-piece-original', pieceId: target.pieceId }
    const existing = resolveSavedOriginalClosetItem(originalSource)

    if (existing) {
      setEditorClosetItem(existing.id, { paintedConcealMask: mask })
      if (target.kind === 'slot-original') {
        closetAssignments = {
          ...closetAssignments,
          [target.slotName]: {
            mode: 'item',
            itemId: existing.id,
            label: closetAssignments[target.slotName]?.label
          }
        }
      } else {
        closetAssignments = {
          ...closetAssignments,
          [buildGuidedPieceOriginalClosetSlot(target.pieceId)]: {
            mode: 'item',
            itemId: existing.id
          }
        }
        editorGuidedPieceStates = {
          ...editorGuidedPieceStates,
          [target.pieceId]: true
        }
      }
      return
    }

    if (!mask) return

    const nextItem = createCustomClosetItemFromOriginal({
      originalSource,
      name: resolvePaintedConcealTargetLabel(target),
      category:
        target.kind === 'slot-original'
          ? getClosetSlotTypeLabel(target.slotName)
          : resolveGuidedOutfitPiece(target.pieceId)?.category ?? 'original',
      paintedConcealMask: mask
    })
    editorClosetItems = {
      ...editorClosetItems,
      [nextItem.id]: nextItem
    }
    if (target.kind === 'slot-original') {
      closetAssignments = {
        ...closetAssignments,
        [target.slotName]: {
          mode: 'item',
          itemId: nextItem.id,
          label: closetAssignments[target.slotName]?.label
        }
      }
    } else {
      closetAssignments = {
        ...closetAssignments,
        [buildGuidedPieceOriginalClosetSlot(target.pieceId)]: {
          mode: 'item',
          itemId: nextItem.id
        }
      }
      editorGuidedPieceStates = {
        ...editorGuidedPieceStates,
        [target.pieceId]: true
      }
    }
    editorDirty = true
  }

  function savePaintedConcealForClosetItemTarget(
    target: Extract<PaintedConcealEditorTarget, { kind: 'closet-item' }>,
    mask?: GoonPaintedConcealMask
  ) {
    if (editorCustomClosetItemsById.has(target.itemId)) {
      setEditorClosetItem(target.itemId, { paintedConcealMask: mask })
      return
    }

    const sourceItem = closetItemsById.get(target.itemId)
    if (!sourceItem || !target.slotName || !mask) {
      return
    }

    const existing = resolveEditorClosetItemForGlobalSource(sourceItem.id)
    const nextItem = existing ?? createCustomClosetItemFromGlobal(sourceItem)
    if (existing) {
      setEditorClosetItem(existing.id, { paintedConcealMask: mask })
    } else {
      editorClosetItems = {
        ...editorClosetItems,
        [nextItem.id]: {
          ...nextItem,
          paintedConcealMask: mask
        }
      }
    }
    closetAssignments = {
      ...closetAssignments,
      [target.slotName]: {
        mode: 'item',
        itemId: nextItem.id,
        label: closetAssignments[target.slotName]?.label
      }
    }
    editorDirty = true
  }

  async function savePaintedConcealEditor() {
    if (!paintedConcealTarget) return
    const mask = buildPaintedConcealMaskFromDraft()
    if (paintedConcealTarget.kind === 'closet-item') {
      savePaintedConcealForClosetItemTarget(paintedConcealTarget, mask)
    } else {
      upsertOriginalPaintedConcealTarget(paintedConcealTarget, mask)
    }
    releasePaintedConcealPointerCapture(paintedConcealPointerId)
    paintedConcealEditorOpen = false
    paintedConcealTarget = null
    paintedConcealTopology = null
    paintedConcealDraftTriangles = {}
    paintedConcealHistory = []
    paintedConcealPainting = false
    paintedConcealPointerId = null
    paintedConcealShiftHeld = false
    paintedConcealPointerInPreview = false
    paintedConcealStatus = null
    previewEngine?.setAuthoringPoseMode(false)
    await tick()
    await refreshEditorClosetPreview()
  }

  function clearPaintedConcealDraft() {
    paintedConcealHistory = [...paintedConcealHistory, clonePaintedConcealDraft()]
    paintedConcealDraftTriangles = {}
    void applyPaintedConcealDraftPreview()
  }

  function undoPaintedConcealDraft() {
    const previous = paintedConcealHistory[paintedConcealHistory.length - 1]
    if (!previous) return
    paintedConcealHistory = paintedConcealHistory.slice(0, -1)
    paintedConcealDraftTriangles = previous
    void applyPaintedConcealDraftPreview()
  }

  function applyPaintedConcealPointer(event: PointerEvent) {
    if (!previewEngine) return
    const pick = previewEngine.pickBodyConcealTriangles(
      event.clientX,
      event.clientY,
      paintedConcealBrushRadius,
      { mirrorX: paintedConcealMirrorX }
    )
    if (!pick) {
      paintedConcealStatus = 'No body surface under the brush.'
      return
    }
    const next = clonePaintedConcealDraft()
    for (const meshPick of [pick, ...(pick.mirroredPicks ?? [])]) {
      const current = new Set(next[meshPick.mesh] ?? [])
      for (const triangleIndex of meshPick.triangleIndices) {
        if (paintedConcealTool === 'erase') {
          current.delete(triangleIndex)
        } else {
          current.add(triangleIndex)
        }
      }
      const normalized = [...current].sort((a, b) => a - b)
      if (normalized.length > 0) {
        next[meshPick.mesh] = normalized
      } else {
        delete next[meshPick.mesh]
      }
    }
    paintedConcealDraftTriangles = next
    paintedConcealStatus = null
    void applyPaintedConcealDraftPreview()
  }

  function updatePaintedConcealPointerPreviewPosition(event: PointerEvent) {
    if (!previewContainer || !paintedConcealEditorOpen) {
      paintedConcealPointerInPreview = false
      return
    }
    const rect = previewContainer.getBoundingClientRect()
    const x = event.clientX - rect.left
    const y = event.clientY - rect.top
    paintedConcealPointerInPreview = x >= 0 && y >= 0 && x <= rect.width && y <= rect.height
    paintedConcealPointerX = Math.min(Math.max(x, 0), rect.width)
    paintedConcealPointerY = Math.min(Math.max(y, 0), rect.height)
  }

  function releasePaintedConcealPointerCapture(pointerId: number | null) {
    if (pointerId === null || !paintedConcealPointerCaptureElement) return
    try {
      if (paintedConcealPointerCaptureElement.hasPointerCapture?.(pointerId)) {
        paintedConcealPointerCaptureElement.releasePointerCapture(pointerId)
      }
    } catch {
      // Pointer capture can already be gone after browser-level cancellation.
    }
    paintedConcealPointerCaptureElement = null
  }

  function stopPaintedConcealStroke(pointerId: number | null = paintedConcealPointerId) {
    releasePaintedConcealPointerCapture(pointerId)
    paintedConcealPainting = false
    paintedConcealPointerId = null
  }

  function handlePaintedConcealKeyDown(event: KeyboardEvent) {
    if (event.key === 'Shift') {
      paintedConcealShiftHeld = true
    }
  }

  function handlePaintedConcealKeyUp(event: KeyboardEvent) {
    if (event.key !== 'Shift') return
    paintedConcealShiftHeld = false
    if (paintedConcealPainting) {
      stopPaintedConcealStroke()
    }
  }

  function handlePaintedConcealWindowPointerMove(event: PointerEvent) {
    updatePaintedConcealPointerPreviewPosition(event)
    paintedConcealShiftHeld = event.shiftKey
    if (paintedConcealPainting && paintedConcealPointerId === event.pointerId && !event.shiftKey) {
      stopPaintedConcealStroke(event.pointerId)
    }
  }

  function handlePaintedConcealWindowPointerUp(event: PointerEvent) {
    updatePaintedConcealPointerPreviewPosition(event)
    paintedConcealShiftHeld = event.shiftKey
    if (paintedConcealPointerId === event.pointerId) {
      stopPaintedConcealStroke(event.pointerId)
    }
  }

  function handlePaintedConcealPointerDown(event: PointerEvent) {
    updatePaintedConcealPointerPreviewPosition(event)
    if (event.button !== 0) return
    if (!event.shiftKey && !paintedConcealShiftHeld) return
    event.preventDefault()
    event.stopPropagation()
    paintedConcealPainting = true
    paintedConcealPointerId = event.pointerId
    paintedConcealHistory = [...paintedConcealHistory, clonePaintedConcealDraft()]
    paintedConcealPointerCaptureElement = event.currentTarget as HTMLElement
    paintedConcealPointerCaptureElement.setPointerCapture?.(event.pointerId)
    applyPaintedConcealPointer(event)
  }

  function handlePaintedConcealPointerMove(event: PointerEvent) {
    updatePaintedConcealPointerPreviewPosition(event)
    if (!paintedConcealPainting || paintedConcealPointerId !== event.pointerId) return
    if (!event.shiftKey && !paintedConcealShiftHeld) {
      stopPaintedConcealStroke(event.pointerId)
      return
    }
    event.preventDefault()
    event.stopPropagation()
    applyPaintedConcealPointer(event)
  }

  function handlePaintedConcealPointerUp(event: PointerEvent) {
    updatePaintedConcealPointerPreviewPosition(event)
    if (paintedConcealPointerId !== event.pointerId) return
    event.preventDefault()
    event.stopPropagation()
    stopPaintedConcealStroke(event.pointerId)
  }

  function sanitizeGlobalClosetItem(item: GoonClosetItem): GoonClosetItem {
    const next = JSON.parse(JSON.stringify(item)) as GoonClosetItem
    delete next.sourceItemId
    delete next.originalSource
    delete next.materialColors
    delete (next as LegacyConcealRegionItem).concealRegions
    delete next.paintedConcealMask
    return next
  }

  function sanitizeGlobalClosetLibrary(library?: GoonClosetLibrary | null): GoonClosetLibrary {
    const items = Object.fromEntries(
      Object.entries(library?.items ?? {}).map(([itemId, item]) => [itemId, sanitizeGlobalClosetItem(item)])
    )
    return {
      ...(library?.created_at ? { created_at: library.created_at } : {}),
      ...(library?.updated_at ? { updated_at: library.updated_at } : {}),
      items
    }
  }

  function buildEditorClosetItem(
    itemId: string,
    patch: Partial<GoonClosetItem> | null
  ): GoonClosetItem | undefined {
    const current = editorClosetItems[itemId]
    if (!current) return undefined

    const next = {
      ...current,
      ...(patch ?? {}),
      id: current.id,
      sourceItemId: patch?.sourceItemId ?? current.sourceItemId,
      updatedAt: new Date().toISOString()
    }

    const name = next.name?.trim()
    if (!name) return undefined

    const materialColors = normalizeClosetColorOverride(next.materialColors)
    const paintedConcealMask = normalizePaintedConcealMask(next.paintedConcealMask)

    return {
      ...next,
      name,
      ...(materialColors ? { materialColors } : { materialColors: undefined }),
      ...(paintedConcealMask ? { paintedConcealMask } : { paintedConcealMask: undefined })
    }
  }

  function setEditorClosetItem(itemId: string, patch: Partial<GoonClosetItem> | null) {
    const nextItem = buildEditorClosetItem(itemId, patch)
    if (!nextItem) return
    editorClosetItems = {
      ...editorClosetItems,
      [itemId]: nextItem
    }
    editorDirty = true
  }

  function resolveEditorClosetSourceItem(itemId: string) {
    const localItem = editorCustomClosetItemsById.get(itemId)
    if (!localItem) {
      return closetItemsById.get(itemId) ?? null
    }
    const sourceItem = localItem.sourceItemId ? closetItemsById.get(localItem.sourceItemId) : null
    if (sourceItem) return sourceItem
    return {
      ...localItem,
      materialColors: undefined
    }
  }

  function resolveEditorClosetSourceColors(itemId: string) {
    return resolveClosetItemMaterialColors(resolveEditorClosetSourceItem(itemId))
  }

  function resolveEditorClosetEffectiveColors(itemId: string) {
    return resolveClosetItemMaterialColors(resolveClosetItem(itemId))
  }

  function isEditorClosetItemShadeAuto(itemId: string) {
    return (editorCustomClosetItemsById.get(itemId)?.materialColors?.shadeMode ?? 'auto') !== 'manual'
  }

  function resolveClosetItemMaterialColors(item?: GoonClosetItem | null) {
    if (!item) return null
    const materialColors = item.materialColors
    const baseHex =
      normalizeHexColor(materialColors?.baseHex) ?? xwearColorToHex(item.xwear?.colors?._Color)
    const shadeHex =
      normalizeHexColor(materialColors?.shadeHex) ?? xwearColorToHex(item.xwear?.colors?._ShadeColor)
    if (!baseHex && !shadeHex) return null
    return { baseHex, shadeHex }
  }

  function resolveClosetSlotSourceColors(
    slotName: string,
    assignment: GoonClosetAssignment = closetAssignments[slotName] ?? { mode: 'original' }
  ) {
    if (isSkinOverlayClosetSlotKey(slotName)) return null
    const itemColors =
      assignment.mode === 'item' ? resolveClosetItemMaterialColors(resolveClosetItem(assignment.itemId)) : null
    if (itemColors) return itemColors
    const materialColors = previewMaterialColorInfo[slotName]
    if (!materialColors?.baseHex && !materialColors?.shadeHex) return null
    return {
      baseHex: normalizeHexColor(materialColors.baseHex),
      shadeHex: normalizeHexColor(materialColors.shadeHex)
    }
  }

  function resolveClosetSlotEffectiveColors(
    slotName: string,
    assignment: GoonClosetAssignment = closetAssignments[slotName] ?? { mode: 'original' as const }
  ) {
    const source = resolveClosetSlotSourceColors(slotName, assignment)
    return {
      baseHex: source?.baseHex,
      shadeHex: source?.shadeHex,
      sourceBaseHex: source?.baseHex,
      sourceShadeHex: source?.shadeHex
    }
  }

  function resolveClosetSlotValue(slotName: string) {
    const assignment = buildClosetSlotWorkingAssignment(slotName)
    if (assignment.mode === 'original') {
      return getGuidedSlotOriginalState(slotName) ? '__original__' : '__none__'
    }
    if (assignment.mode === 'item' && assignment.itemId) {
      return resolveClosetItem(assignment.itemId)?.id ?? assignment.itemId
    }
    if (assignment.mode === 'none') return '__none__'
    return getGuidedSlotOriginalState(slotName) ? '__original__' : '__none__'
  }

  function resolveEditorClosetItemForGlobalSource(sourceItemId: string) {
    const normalizedSourceId = sourceItemId.trim()
    if (!normalizedSourceId) return null
    const matches = editorCustomClosetItems.filter(
      (item) => item.sourceItemId === normalizedSourceId && !item.originalSource
    )
    if (matches.length === 0) return null
    return [...matches].sort((left, right) =>
      (right.updatedAt ?? right.createdAt ?? '').localeCompare(left.updatedAt ?? left.createdAt ?? '')
    )[0]
  }

  function buildWardrobePickerItems(): ClosetPickerItem[] {
    const items: ClosetPickerItem[] = []
    const globalClosetIds = new Set(closetItems.map((item) => item.id))

    for (const item of editorCustomClosetItems) {
      if (item.sourceItemId && !item.originalSource) {
        continue
      }
      items.push({
        ...item,
        pickerSource: 'custom'
      })
    }

    for (const item of closetItems) {
      const editedItem = resolveEditorClosetItemForGlobalSource(item.id)
      items.push({
        ...(editedItem ?? item),
        pickerSource: editedItem ? 'custom' : 'global'
      })
    }

    for (const item of editorCustomClosetItems) {
      if (!item.sourceItemId || item.originalSource || globalClosetIds.has(item.sourceItemId)) continue
      items.push({
        ...item,
        pickerSource: 'custom'
      })
    }

    return items.sort((left, right) => left.name.localeCompare(right.name))
  }

  function getWardrobeItemSourceLabel(item: Pick<GoonClosetItem, 'sourceItemId' | 'originalSource'> & { pickerSource?: 'custom' | 'global' }) {
    if (item.sourceItemId) return 'Global'
    if (item.pickerSource === 'global') return 'Global'
    return 'Goon'
  }

  function isWardrobeItemEdited(item?: GoonClosetItem | null) {
    if (!item) return false
    return Boolean(
      item.materialColors ||
        countPaintedConcealTriangles(item.paintedConcealMask) > 0
    )
  }

  function getWardrobeItemDisplayName(item: GoonClosetItem) {
    if (item.originalSource && isWardrobeItemEdited(item)) {
      return `${item.name} (edited)`
    }
    return item.name
  }

  function getClosetSlotLabel(slotName: string) {
    const assignment = buildClosetSlotWorkingAssignment(slotName)
    if (assignment.mode === 'original') {
      return getGuidedSlotOriginalState(slotName) ? 'Original' : 'None'
    }
    if (assignment.mode === 'item' && assignment.itemId) {
      const item = resolveClosetItem(assignment.itemId)
      return item ? getWardrobeItemDisplayName(item) : 'Wardrobe Item'
    }
    if (assignment.mode === 'none') return 'None'
    return getGuidedSlotOriginalState(slotName) ? 'Original' : 'None'
  }

  function getClosetItemsForSlot(slotName: string) {
    const availableItems = editorClosetPickerItems.filter((item) => {
      if (item.originalSource?.kind === 'guided-piece-original') return false
      if (item.originalSource?.kind === 'slot-original') {
        return item.originalSource.slotName === slotName
      }
      return true
    })
    const currentItemId = closetAssignments[slotName]?.itemId
    const currentItem = currentItemId ? resolveClosetItem(currentItemId) ?? closetItemsById.get(currentItemId) : null
    if (
      !currentItem ||
      availableItems.some((item) => item.id === currentItemId || item.id === currentItem.id)
    ) {
      return availableItems
    }

    return [
      {
        ...currentItem,
        pickerSource: editorCustomClosetItemsById.has(currentItem.id) ? 'custom' as const : 'global' as const
      },
      ...availableItems
    ].sort((left, right) => left.name.localeCompare(right.name))
  }

  function getClosetPickerSourceLabel(item: Pick<GoonClosetItem, 'sourceItemId' | 'originalSource'> & { pickerSource?: 'custom' | 'global' }) {
    return getWardrobeItemSourceLabel(item)
  }

  function getClosetSlotTypeLabel(slotName: string) {
    if (isSkinOverlayClosetSlotKey(slotName)) return 'Skin Overlay'
    const lower = slotName.toLowerCase()
    if (lower.includes('_tops_')) return 'Tops/Dresses'
    if (lower.includes('_bottoms_')) return 'Bottoms'
    if (lower.includes('_shoes_')) return 'Shoes'
    if (lower.includes('accessory_tie')) return 'Ties'
    if (lower.includes('_onepiece_')) return 'Body Suit'
    return 'Other'
  }

  function resolveClosetSlotNickname(slotName: string) {
    const assignment = closetAssignments[slotName]
    return assignment?.label?.trim() || getDefaultClosetSlotLabel(slotName)
  }

  function normalizeClosetColorOverride(
    override?: GoonMaterialColorOverride
  ): GoonMaterialColorOverride | undefined {
    const nextOverride: GoonMaterialColorOverride = {}
    const baseHex = normalizeHexColor(override?.baseHex)
    const shadeHex = normalizeHexColor(override?.shadeHex)
    if (baseHex) nextOverride.baseHex = baseHex
    if (shadeHex) nextOverride.shadeHex = shadeHex
    if (baseHex || shadeHex) {
      nextOverride.shadeMode = override?.shadeMode === 'manual' ? 'manual' : 'auto'
    }
    return hasMaterialColorOverride(nextOverride) ? nextOverride : undefined
  }

  function getClosetSlotAssignment(slotName: string): GoonClosetAssignment {
    return closetAssignments[slotName] ?? { mode: 'original' as const }
  }

  function sanitizeClosetAssignments(
    assignments: Record<string, GoonClosetAssignment> = {}
  ): Record<string, GoonClosetAssignment> {
    return Object.fromEntries(
      Object.entries(assignments).map(([slotName, assignment]) => [
        slotName,
        {
          mode: assignment.mode,
          ...(assignment.itemId ? { itemId: assignment.itemId } : {}),
          ...(assignment.label?.trim() ? { label: assignment.label.trim() } : {})
        } satisfies GoonClosetAssignment
      ])
    )
  }

  function buildEditorClosetPayload(): GoonRecord['closet'] {
    return buildEditorClosetPayloadFromItems(editorCustomClosetItems, editorWardrobeOutfits)
  }

  function buildEditorClosetPayloadFromItems(
    customItems: GoonClosetItem[],
    wardrobeOutfits: Record<string, GoonWardrobeOutfit>
  ): GoonRecord['closet'] {
    const nextItems: Record<string, GoonClosetItem> = {}
    for (const item of customItems) {
      if (!item.name?.trim()) continue
      const { concealRegions: _retiredConcealRegions, ...itemWithoutRetiredRegions } = item as LegacyConcealRegionItem
      nextItems[item.id] = {
        ...itemWithoutRetiredRegions,
        name: item.name.trim(),
        updatedAt: item.updatedAt ?? new Date().toISOString()
      }
    }
    const nextOutfits = sanitizeWardrobeOutfits(wardrobeOutfits, {
      resolveItem: (itemId) => (itemId ? nextItems[itemId] ?? null : null)
    })

    return {
      ...(Object.keys(nextItems).length > 0 ? { items: nextItems } : {}),
      ...(Object.keys(nextOutfits).length > 0 ? { outfits: nextOutfits } : {})
    }
  }

  function stripPaintedConcealMask(item: GoonClosetItem): GoonClosetItem {
    const next = { ...item }
    delete next.paintedConcealMask
    return next
  }

  function sanitizePackageUpdateClosetAssignments(
    assignments: Record<string, GoonClosetAssignment> = {},
    validGuidedPieceIds: Set<string>,
    validItemIds: Set<string>
  ) {
    const nextAssignments = sanitizeClosetAssignments(assignments)
    for (const [slotName, assignment] of Object.entries(nextAssignments)) {
      const guidedPieceId = parseGuidedPieceOriginalClosetSlot(slotName)
      if (guidedPieceId && !validGuidedPieceIds.has(guidedPieceId)) {
        delete nextAssignments[slotName]
        continue
      }
      if (assignment.mode === 'item' && (!assignment.itemId || !validItemIds.has(assignment.itemId))) {
        nextAssignments[slotName] = {
          mode: 'original',
          ...(assignment.label?.trim() ? { label: assignment.label.trim() } : {})
        }
      }
    }
    return nextAssignments
  }

  function sanitizePackageUpdateWardrobeOutfits(
    outfits: Record<string, GoonWardrobeOutfit>,
    validGuidedPieceIds: Set<string>,
    validItemIds: Set<string>
  ) {
    const nextOutfits: Record<string, GoonWardrobeOutfit> = {}
    for (const outfit of Object.values(outfits)) {
      const guidedPieceStates = Object.fromEntries(
        Object.entries(cloneWardrobeGuidedPieceStates(outfit.guidedPieceStates)).filter(
          ([pieceId]) => validGuidedPieceIds.has(pieceId)
        )
      )
      nextOutfits[outfit.id] = {
        ...outfit,
        assignments: sanitizePackageUpdateClosetAssignments(
          outfit.assignments ?? {},
          validGuidedPieceIds,
          validItemIds
        ),
        guidedPieceStates
      }
    }
    return nextOutfits
  }

  function buildAdvancedPackageUpdateDraft(update: AdvancedGoonPackageUploadResult) {
    const dufPieces = editorGuidedOutfitPiecesDraft.filter((piece) => piece.source === 'duf-overlay')
    const outfitPieces = [...update.outfitPieces, ...dufPieces]
    const validGuidedPieceIds = new Set(outfitPieces.map((piece) => piece.id))
    const currentPieceStates = buildPersistedGuidedPieceStates(editorGuidedOutfitPiecesDraft)
    const customItems = editorCustomClosetItems
      .filter((item) => {
        if (item.originalSource?.kind !== 'guided-piece-original') return true
        return validGuidedPieceIds.has(item.originalSource.pieceId)
      })
      .map(stripPaintedConcealMask)
    const validItemIds = new Set(customItems.map((item) => item.id))
    const closetAssignmentsDraft = sanitizePackageUpdateClosetAssignments(
      closetAssignments,
      validGuidedPieceIds,
      validItemIds
    )
    const wardrobeOutfits = sanitizePackageUpdateWardrobeOutfits(
      editorWardrobeOutfits,
      validGuidedPieceIds,
      validItemIds
    )
    const pieceStates = Object.fromEntries(
      outfitPieces.map((piece) => [
        piece.id,
        currentPieceStates[piece.id] ?? piece.defaultOn ?? true
      ])
    )

    return {
      outfitPieces,
      pieceStates,
      customItems,
      wardrobeOutfits,
      closetAssignments: closetAssignmentsDraft,
      closet: buildEditorClosetPayloadFromItems(customItems, wardrobeOutfits)
    }
  }

  async function refreshEditorClosetPreview() {
    const engine = await ensurePreviewGoonReady()
    if (!engine) return
    engine.resetMaterialOverrides()
    await applyClosetAssignments(engine, closetAssignments, {
      guidedOutfitPieces: editorGuidedOutfitPiecesDraft,
      guidedPieceStates: buildPersistedGuidedPieceStates(editorGuidedOutfitPiecesDraft)
    })
  }

  async function handleEditorClosetBaseColorChange(itemId: string, value: string) {
    const nextBaseHex = normalizeHexColor(value)
    if (!nextBaseHex) return
    const source = resolveEditorClosetSourceColors(itemId)
    const currentOverride = editorCustomClosetItemsById.get(itemId)?.materialColors
    const manualShade = currentOverride?.shadeMode === 'manual'
    setEditorClosetItem(itemId, {
      materialColors: normalizeClosetColorOverride({
        ...currentOverride,
        baseHex: nextBaseHex,
        shadeMode: manualShade ? 'manual' : 'auto',
        shadeHex: manualShade
          ? normalizeHexColor(currentOverride?.shadeHex) ?? source?.shadeHex
          : deriveAutoShadeHex(nextBaseHex, source?.baseHex, source?.shadeHex)
      })
    })
    await refreshEditorClosetPreview()
  }

  async function handleEditorClosetShadeColorChange(itemId: string, value: string) {
    const nextShadeHex = normalizeHexColor(value)
    if (!nextShadeHex) return
    const currentOverride = editorCustomClosetItemsById.get(itemId)?.materialColors
    const effective = resolveEditorClosetEffectiveColors(itemId)
    setEditorClosetItem(itemId, {
      materialColors: normalizeClosetColorOverride({
        ...currentOverride,
        baseHex: normalizeHexColor(currentOverride?.baseHex) ?? effective?.baseHex,
        shadeMode: 'manual',
        shadeHex: nextShadeHex
      })
    })
    await refreshEditorClosetPreview()
  }

  async function resetEditorClosetItemColors(itemId: string) {
    setEditorClosetItem(itemId, { materialColors: undefined })
    await refreshEditorClosetPreview()
  }

  async function useEditorClosetItemAutoShade(itemId: string) {
    const currentOverride = editorCustomClosetItemsById.get(itemId)?.materialColors
    const effective = resolveEditorClosetEffectiveColors(itemId)
    const source = resolveEditorClosetSourceColors(itemId)
    setEditorClosetItem(itemId, {
      materialColors: normalizeClosetColorOverride({
        ...currentOverride,
        baseHex: normalizeHexColor(currentOverride?.baseHex) ?? effective?.baseHex,
        shadeMode: 'auto',
        shadeHex: effective?.baseHex
          ? deriveAutoShadeHex(
              normalizeHexColor(currentOverride?.baseHex) ?? effective.baseHex,
              source?.baseHex,
              source?.shadeHex
            )
          : source?.shadeHex
      })
    })
    await refreshEditorClosetPreview()
  }

  async function ensureEditableWardrobeItemForSlot(slotName: string) {
    const assignment = buildClosetSlotWorkingAssignment(slotName)
    if (assignment.mode !== 'item' || !assignment.itemId) return null

    const localItem = editorCustomClosetItemsById.get(assignment.itemId)
    if (localItem) return localItem

    const sourceItem = closetItemsById.get(assignment.itemId)
    if (!sourceItem) return null

    const existing = resolveEditorClosetItemForGlobalSource(sourceItem.id)
    const nextItem = existing ?? createCustomClosetItemFromGlobal(sourceItem)
    if (!existing) {
      editorClosetItems = {
        ...editorClosetItems,
        [nextItem.id]: nextItem
      }
    }

    closetAssignments = {
      ...closetAssignments,
      [slotName]: {
        mode: 'item',
        itemId: nextItem.id,
        label: closetAssignments[slotName]?.label
      }
    }
    editorDirty = true
    await tick()
    return nextItem
  }

  async function handleWardrobeSlotBaseColorChange(slotName: string, value: string) {
    const item = await ensureEditableWardrobeItemForSlot(slotName)
    if (!item) return
    await handleEditorClosetBaseColorChange(item.id, value)
  }

  async function handleWardrobeSlotShadeColorChange(slotName: string, value: string) {
    const item = await ensureEditableWardrobeItemForSlot(slotName)
    if (!item) return
    await handleEditorClosetShadeColorChange(item.id, value)
  }

  async function useWardrobeSlotItemAutoShade(slotName: string) {
    const item = await ensureEditableWardrobeItemForSlot(slotName)
    if (!item) return
    await useEditorClosetItemAutoShade(item.id)
  }

  async function resetWardrobeSlotItemColors(slotName: string) {
    const assignment = buildClosetSlotWorkingAssignment(slotName)
    if (assignment.mode !== 'item' || !assignment.itemId) return
    const item = resolveClosetItem(assignment.itemId)
    if (!item || !editorCustomClosetItemsById.has(item.id)) return
    await resetEditorClosetItemColors(item.id)
  }

  async function resetWardrobeSlotSelectedItemEdits(slotName: string) {
    const assignment = buildClosetSlotWorkingAssignment(slotName)
    if (assignment.mode !== 'item' || !assignment.itemId) return
    const selectedItem = resolveClosetItem(assignment.itemId)
    if (!selectedItem) return
    const item = editorCustomClosetItemsById.get(selectedItem.id)
    if (!item) return

    if (item.sourceItemId) {
      const nextItems = { ...editorClosetItems }
      delete nextItems[item.id]
      editorClosetItems = nextItems
      closetAssignments = {
        ...closetAssignments,
        [slotName]: {
          mode: 'item',
          itemId: item.sourceItemId,
          label: closetAssignments[slotName]?.label
        }
      }
    } else if (item.originalSource?.kind === 'slot-original') {
      const nextItems = { ...editorClosetItems }
      delete nextItems[item.id]
      editorClosetItems = nextItems
      closetAssignments = {
        ...closetAssignments,
        [slotName]: {
          mode: 'original',
          label: closetAssignments[slotName]?.label
        }
      }
    } else {
      setEditorClosetItem(item.id, {
        materialColors: undefined,
        paintedConcealMask: undefined
      })
    }

    editorDirty = true
    editorActiveWardrobeOutfitId = null
    await tick()
    await refreshEditorClosetPreview()
  }

  async function resetStandaloneGuidedPieceItemEdits(piece: GoonGuidedOutfitPiece) {
    const selectedItem = resolveStandaloneGuidedPieceSelectedItem(piece)
    if (!selectedItem || !editorCustomClosetItemsById.has(selectedItem.id)) return

    const virtualSlotName = buildGuidedPieceOriginalClosetSlot(piece.id)
    const nextItems = { ...editorClosetItems }
    delete nextItems[selectedItem.id]
    editorClosetItems = nextItems
    const nextAssignments = { ...closetAssignments }
    delete nextAssignments[virtualSlotName]
    closetAssignments = nextAssignments
    editorGuidedPieceStates = {
      ...editorGuidedPieceStates,
      [piece.id]: true
    }
    editorDirty = true
    editorActiveWardrobeOutfitId = null
    await tick()
    await runLoggedEditorPreviewUpdate(
      'standalone-guided-piece-reset-edits',
      () => syncEditorGuidedOutfitPreview(),
      { pieceId: piece.id }
    )
  }

  function requestClosetItemDelete(item: GoonClosetItem) {
    closetPendingDelete = item
    closetDeleteConfirmOpen = true
  }

  function observeOverflow(node: HTMLElement, onChange: (overflow: boolean) => void) {
    let callback = onChange
    let frame = 0

    const measure = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        callback(node.scrollWidth > node.clientWidth || node.scrollHeight > node.clientHeight)
      })
    }

    const resizeObserver =
      typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => measure()) : null

    resizeObserver?.observe(node)
    measure()

    return {
      update(nextCallback: (overflow: boolean) => void) {
        callback = nextCallback
        measure()
      },
      destroy() {
        cancelAnimationFrame(frame)
        resizeObserver?.disconnect()
      }
    }
  }

  function setClosetItemSlotOverflow(itemId: string, overflow: boolean) {
    closetItemSlotOverflow = {
      ...closetItemSlotOverflow,
      [itemId]: overflow
    }
  }

  function setClosetItemCategoryOverflow(itemId: string, overflow: boolean) {
    closetItemCategoryOverflow = {
      ...closetItemCategoryOverflow,
      [itemId]: overflow
    }
  }

  function startEditingClosetItem(item: GoonClosetItem) {
    editingClosetItemId = item.id
    editingClosetItemNameDraft = item.name
  }

  function cancelClosetItemEditing() {
    editingClosetItemId = null
    editingClosetItemNameDraft = ''
  }

  function applyClosetItemEdits(itemId: string) {
    const item = closetItemsById.get(itemId)
    if (!item) {
      cancelClosetItemEditing()
      return
    }

    const nextName = editingClosetItemNameDraft.trim()
    if (!nextName) {
      toast.error('Display Name cannot be empty.')
      return
    }

    if (nextName !== item.name) {
      updateClosetItem(itemId, { name: nextName })
    }

    cancelClosetItemEditing()
  }

  function buildClosetSlotWorkingAssignment(slotName: string) {
    const assignment = getClosetSlotAssignment(slotName)
    if (assignment.mode === 'original') {
      const editedOriginal = resolveEditedOriginalWardrobeItemForSlot(slotName)
      if (editedOriginal) {
        return {
          mode: 'item',
          itemId: editedOriginal.id,
          label: assignment.label
        } satisfies GoonClosetAssignment
      }
    }
    return assignment
  }

  function filterEmojiMapForEmotes(map: GoonEmojiMap, cues: GoonCueMap) {
    const allowed = new Set(
      Object.values(cues)
        .filter((cue) => cue.kind === 'emote')
        .map((cue) => cue.name)
    )
    const next: GoonEmojiMap = {}
    for (const [emoji, cueName] of Object.entries(map)) {
      if (allowed.has(cueName)) {
        next[emoji] = cueName
      }
    }
    return next
  }

  function getEmoteEmoji(cueName: string) {
    const drafts = getActiveEmoteEmojiDrafts()
    if (cueName in drafts) {
      return drafts[cueName] ?? ''
    }
    const map = activeTab === 'kitchen' ? kitchenEmojiMap : editorEmojiMap
    return resolveEmoteEmojiFromMap(cueName, map)
  }

  function setEmoteEmoji(cueName: string, emoji: string) {
    const drafts = getActiveEmoteEmojiDrafts()
    setActiveEmoteEmojiDrafts({
      ...drafts,
      [cueName]: normalizeEmoteEmojiInput(emoji)
    })
    if (activeTab === 'kitchen') {
      kitchenDirty = true
    } else {
      editorDirty = true
    }
  }

  function resolveGoonMotionLaneForGoon(goon: GoonRecord | null | undefined): GoonMotionLane {
    return resolveGoonKind(goon) === 'custom' ? 'glb' : 'vrm'
  }

  // Lane-filtered like the dock's collectDockAnimationFilesForLane: VRM goons
  // consume .vrma entries, GLB-lane custom goons consume .glb entries.
  function resolveAnimationFiles(goon: GoonRecord | null): GoonFileRef[] {
    const files: GoonFileRef[] = []
    const seen = new Set<string>()
    const addFile = (file?: GoonFileRef | null) => {
      if (!file) return
      const key = file.url || file.filename
      if (!key || seen.has(key)) return
      seen.add(key)
      files.push(file)
    }
    for (const file of vrmaLibrary) {
      addFile(file)
    }
    const goonFiles = Array.isArray(goon?.files?.animations) ? goon?.files?.animations ?? [] : []
    for (const file of goonFiles) {
      addFile(file)
    }
    return filterGoonAnimationFilesForLane(files, resolveGoonMotionLaneForGoon(goon))
  }

  function resolveMarkerMotionNamesForPosture(posture: GoonPosture, goon: GoonRecord | null) {
    const names = new Set<string>()
    for (const file of resolveAnimationFiles(goon)) {
      if (file.motionMeta?.posture !== posture) continue
      const name = resolveAnimationName(file)
      if (!name) continue
      names.add(name)
    }
    return Array.from(names).sort()
  }

  function scenePreviewUsesMotionOnly() {
    return Boolean(sceneEditorMode) && scenePreviewBodyMode === 'active-goon'
  }

  function setScenePreviewBodyMode(mode: ScenePreviewBodyMode) {
    if (scenePreviewBodyMode === mode) return
    if (activeSceneEdit) {
      toast.error('Apply or cancel the active scene edit first.')
      return
    }
    scenePreviewBodyMode = mode
    kitchenPreviewAnimationName = ''
    kitchenPreviewAnimationActive = false
    kitchenPreviewAnimationRestore = null
    resetKitchenPreview()
    if (sceneEditorMode === 'edit' && sceneEditorId) {
      kitchenPreviewSceneId = sceneEditorId
      void ensureKitchenPreviewReady(sceneEditorId)
    }
  }

  function resolveSceneProxyPoseAnimation() {
    if (sceneProxyPoseId !== 'sit') return null
    return PAINTED_CONCEAL_POSES.find((pose) => pose.id === 'sitting-pose') ?? null
  }

  async function applySceneProxyPose(engine: GoonEngine) {
    const pose = resolveSceneProxyPoseAnimation()
    if (!pose) {
      engine.setAuthoringPoseMode(false)
      engine.clearPreviewAnimation()
      kitchenPreviewAnimationName = ''
      kitchenPreviewAnimationActive = false
      kitchenPreviewAnimationRestore = null
      return
    }
    await engine.loadAdditionalAnimations([pose.file])
    engine.setAuthoringPoseMode(true, pose.animationName)
    kitchenPreviewAnimationName = pose.animationName
    kitchenPreviewAnimationActive = false
    kitchenPreviewAnimationRestore = null
  }

  function setSceneProxyPose(id: SceneProxyPoseId) {
    if (sceneProxyPoseId === id) return
    if (activeSceneEdit) {
      toast.error('Apply or cancel the active scene edit first.')
      return
    }
    sceneProxyPoseId = id
    if (scenePreviewUsingProxy && kitchenPreviewEngine && kitchenPreviewReady) {
      void applySceneProxyPose(kitchenPreviewEngine)
    }
  }

  function resolveScenePreviewMotionName(goon: GoonRecord | null) {
    const available =
      activeSceneEdit?.type === 'marker'
        ? resolveMarkerMotionNamesForPosture(activeSceneEdit.posture, goon)
        : collectKnownAnimationData(goon, kitchenPreviewAnimationCatalog).names
    if (kitchenPreviewAnimationName && available.includes(kitchenPreviewAnimationName)) {
      return kitchenPreviewAnimationName
    }
    for (const candidate of GOON_STAND_POSE_FALLBACK_NAMES) {
      if (available.includes(candidate)) return candidate
    }
    return available[0] ?? ''
  }

  function isMarkerPositioned(marker: GoonSceneMarker | null | undefined) {
    return marker?.positioned !== false
  }

  function hasPendingMarkerDrafts() {
    return Object.values(kitchenScenes ?? {}).some((scene) =>
      Object.values(scene.markers ?? {}).some((list) =>
        (list ?? []).some((marker) => marker.positioned === false)
      )
    )
  }

  const markerApplyWarning =
    'Once you apply this position, you will not be able to adjust it later. You can always delete this marker and create it again.'

  const markerBindingWarning =
    'Once you choose No Prop or a Prop and save the scene, you cannot change this later. You can always delete this marker and create it again.'

  const markerLockDetails =
    'This marker is locked. Delete this marker and create it again if you need a different position or a different Prop / No Prop choice.'

  function normalizeMarkerForSceneEditor(marker: GoonSceneMarker) {
    return {
      ...marker,
      positioned: marker.positioned !== false,
      propLocked: marker.propLocked === true
    } satisfies GoonSceneMarker
  }

  function resolvePreviewAnimationDefinitionForGoon(
    animationName: string,
    goon: GoonRecord | null,
    cueMap?: GoonCueMap | null
  ) {
    return resolvePreviewAnimationDefinition(animationName, cueMap, resolveAnimationFiles(goon))
  }

  function buildPreviewAnimationLoadPlan(goon: GoonRecord | null, cueMap?: GoonCueMap | null) {
    const lane = resolveGoonMotionLaneForGoon(goon)
    const libraryFiles = filterGoonAnimationFilesForLane(vrmaLibrary, lane)
    const goonFiles = filterGoonAnimationFilesForLane(
      Array.isArray(goon?.files?.animations) ? goon?.files?.animations ?? [] : [],
      lane
    )
    const baseLoop = goon?.defaults?.baseLoop ?? 'base_stand'
    const baseLoopAnimation = cueMap?.[baseLoop]?.animationName ?? baseLoop
    const priorityNames = buildGoonAnimationPriorityNames(baseLoopAnimation)
    return buildGoonAnimationLoadPlan(libraryFiles, goonFiles, { priorityNames })
  }

  function buildBaseLoopSignature(baseLoop: string, definition?: GoonCueDefinition) {
    return [
      baseLoop,
      definition?.animationName ?? '',
      definition?.posture ?? '',
      definition?.kind ?? '',
      definition?.playback ?? ''
    ].join('|')
  }

  function stripCueFaceAuthoring(
    definition?: GoonCueDefinition | null
  ): GoonCueDefinition | undefined {
    if (!definition) return undefined
    return {
      ...definition,
      expressionTargets: undefined,
      faceControls: undefined,
      rawMorphTargets: undefined
    }
  }

  function resolveEditorPreviewLoopState() {
    const goon = editorGoon
    if (!goon) return null
    const previewMoodName =
      openMoodName && editorCueMap?.[openMoodName]?.kind === 'mood' ? openMoodName : null
    const name = previewMoodName ?? (editorBaseLoop || goon.defaults?.baseLoop || 'base_stand')
    return {
      name,
      definition: editorCueMap?.[name]
    }
  }

  function resolveKitchenPreviewLoopState() {
    const goon = resolveGoonById(kitchenPreviewGoonId)
    if (!goon) return null
    const previewMoodName =
      openMoodName && kitchenCueMap?.[openMoodName]?.kind === 'mood' ? openMoodName : null
    const resolvedCueMap = resolveGoonCues(goon, goonsSettings).cueMap
    const name = previewMoodName ?? goon.defaults?.baseLoop ?? 'base_stand'
    return {
      name,
      definition: kitchenCueMap?.[name] ?? resolvedCueMap?.[name]
    }
  }

  function applyEditorPreviewLoopState(
    engine: GoonEngine,
    options: {
      neutralFace?: boolean
      trackSignature?: boolean
      preserveCamera?: boolean
      preservePlacement?: boolean
    } = {}
  ) {
    const next = resolveEditorPreviewLoopState()
    if (!next) return
    engine.setMood(
      next.name,
      options.neutralFace ? stripCueFaceAuthoring(next.definition) : next.definition,
      { preserveCamera: options.preserveCamera, preservePlacement: options.preservePlacement }
    )
    if (options.trackSignature !== false) {
      previewBaseLoopSignature = buildBaseLoopSignature(next.name, next.definition)
    }
  }

  function applyKitchenPreviewLoopState(
    engine: GoonEngine,
    options: {
      neutralFace?: boolean
      trackSignature?: boolean
      preserveCamera?: boolean
      preservePlacement?: boolean
    } = {}
  ) {
    const next = resolveKitchenPreviewLoopState()
    if (!next) return
    engine.setMood(
      next.name,
      options.neutralFace ? stripCueFaceAuthoring(next.definition) : next.definition,
      { preserveCamera: options.preserveCamera, preservePlacement: options.preservePlacement }
    )
    if (options.trackSignature !== false) {
      kitchenPreviewBaseLoopSignature = buildBaseLoopSignature(next.name, next.definition)
    }
  }

  function applyScenePreviewMotionState(
    engine: GoonEngine,
    goon: GoonRecord | null,
    options: { preservePlacement?: boolean; preserveCamera?: boolean } = {}
  ) {
    const nextAnimationName = resolveScenePreviewMotionName(goon)
    if (!nextAnimationName) {
      engine.clearPreviewAnimation()
      kitchenPreviewAnimationActive = false
      kitchenPreviewAnimationRestore = null
      kitchenPreviewAnimationName = ''
      return
    }

    kitchenPreviewAnimationName = nextAnimationName
    engine.previewLoopAnimation(
      nextAnimationName,
      resolvePreviewAnimationDefinitionForGoon(nextAnimationName, goon, kitchenCueMap),
      {
        preservePlacement: options.preservePlacement ?? activeSceneEdit?.type === 'marker',
        preserveCamera: options.preserveCamera
      }
    )
    kitchenPreviewAnimationActive = true
    kitchenPreviewAnimationRestore = null
  }

  function clearFacePreviewResumeTimer(scope: FacePreviewScope) {
    const timer =
      scope === 'kitchen' ? kitchenFacePreviewResumeTimer : editorFacePreviewResumeTimer
    if (timer) {
      clearTimeout(timer)
    }
    if (scope === 'kitchen') {
      kitchenFacePreviewResumeTimer = null
      kitchenFacePreviewResumeToken += 1
      return
    }
    editorFacePreviewResumeTimer = null
    editorFacePreviewResumeToken += 1
  }

  function setFacePreviewSuspended(scope: FacePreviewScope, suspended: boolean) {
    if (scope === 'kitchen') {
      kitchenFacePreviewSuspended = suspended
      return
    }
    editorFacePreviewSuspended = suspended
  }

  function resumeFacePreviewAfterCue(scope: FacePreviewScope) {
    if (scope === 'kitchen') {
      if (kitchenPreviewEngine && kitchenPreviewReady && !kitchenPreviewAnimationActive) {
        if (scenePreviewUsesMotionOnly()) {
          applyScenePreviewMotionState(kitchenPreviewEngine, kitchenPreviewGoon, {
            preserveCamera: true
          })
        } else {
          applyKitchenPreviewLoopState(kitchenPreviewEngine, { preserveCamera: true })
        }
      }
    } else if (previewEngine && previewReady && !previewAnimationActive) {
      applyEditorPreviewLoopState(previewEngine, { preserveCamera: true })
    }
    setFacePreviewSuspended(scope, false)
  }

  function suspendFacePreviewForCue(scope: FacePreviewScope, durationMs: number) {
    clearFacePreviewResumeTimer(scope)
    setFacePreviewSuspended(scope, true)
    const token =
      scope === 'kitchen' ? kitchenFacePreviewResumeToken : editorFacePreviewResumeToken
    const resume = () => {
      const currentToken =
        scope === 'kitchen' ? kitchenFacePreviewResumeToken : editorFacePreviewResumeToken
      if (token !== currentToken) return
      if (scope === 'kitchen') {
        kitchenFacePreviewResumeTimer = null
      } else {
        editorFacePreviewResumeTimer = null
      }
      resumeFacePreviewAfterCue(scope)
    }
    const timer = setTimeout(resume, Math.max(240, durationMs))
    if (scope === 'kitchen') {
      kitchenFacePreviewResumeTimer = timer
      return
    }
    editorFacePreviewResumeTimer = timer
  }

  onMount(async () => {
    try {
      await loadGoons()
      await loadGoonAnimationLibrary()
      await loadFbxInstallStatus()
    } catch (error) {
      console.error('[GoonsSettings] Failed to load goons:', error)
    }
  })

  onMount(() => {
    const handleGoonsManage = () => {
      if (editorHairImportOpen) {
        toast.info('Finish or cancel the active Hair import before leaving its review.')
        return
      }
      activeTab = 'goons'
      editorGoonId = null
    }

    const handleGoonsCreate = () => {
      if (editorHairImportOpen) {
        toast.info('Finish or cancel the active Hair import before creating another Goon.')
        return
      }
      activeTab = 'goons'
      editorGoonId = null
      requestAnimationFrame(() => {
        uploadInput?.click()
      })
    }

    const handleGoonsEdit = (event: Event) => {
      if (editorHairImportOpen) {
        toast.info('Finish or cancel the active Hair import before editing another Goon.')
        return
      }
      const detail = (event as CustomEvent).detail as { goonId?: string }
      if (!detail?.goonId) {
        activeTab = 'goons'
        return
      }
      const target = resolveGoonById(detail.goonId)
      if (!target) {
        activeTab = 'goons'
        return
      }
      openCueEditor(target)
    }

    window.addEventListener('batshit:goons-manage', handleGoonsManage as EventListener)
    window.addEventListener('batshit:goons-create', handleGoonsCreate as EventListener)
    window.addEventListener('batshit:goons-edit', handleGoonsEdit as EventListener)

    return () => {
      window.removeEventListener('batshit:goons-manage', handleGoonsManage as EventListener)
      window.removeEventListener('batshit:goons-create', handleGoonsCreate as EventListener)
      window.removeEventListener('batshit:goons-edit', handleGoonsEdit as EventListener)
    }
  })

  $effect(() => {
    const kitchen = goonsSettings?.kitchen
    if (!kitchen || kitchenDirty) return
    const resolvedKitchen = resolveKitchenCues(goonsSettings)
    const eyeContactSettings = normalizeGoonGlobalEyeContactSettingsMap(kitchen.eyeContact)
    kitchenCueMap = cloneCueMap(resolvedKitchen.cueMap)
    kitchenEmojiMap = cloneEmojiMap(resolvedKitchen.emojiMap)
    kitchenEyeContactVroidMode = eyeContactSettings.vroid.mode
    kitchenEyeContactBlenderMode = eyeContactSettings.blender.mode
    kitchenEyeContactVroidTuning = eyeContactSettings.vroid.tuning
    kitchenEyeContactBlenderTuning = eyeContactSettings.blender.tuning
    kitchenCueNameDrafts = {}
  })

  $effect(() => {
    if (!goonsSettings || closetDirty) return
    globalCloset = sanitizeGlobalClosetLibrary(cloneClosetLibrary(goonsSettings.globalCloset))
  })

  $effect(() => {
    const kitchen = goonsSettings?.kitchen
    if (!kitchen || sceneDirty) return
    kitchenRoomTextures = cloneRoomTextureLibrary(kitchen.roomTextures)
    kitchenScenes = cloneSceneMap(kitchen.scenes)
  })

  $effect(() => {
    if (!goonsSettings?.kitchen) return
    const nextSignature = buildMotionsSourceSignature()
    if (!motionsHydrated || (!motionsDirty && nextSignature !== motionsAppliedSourceSignature)) {
      applyMotionsStateFromSources()
    }
  })

  $effect(() => {
    for (const file of vrmaLibrary) {
      ensureAnimationTagInput(file)
    }
    if (animationTagFilterMode === 'tags') {
      const next = animationTagFilters.filter((tag) => animationTagOptions.includes(tag))
      if (next.length !== animationTagFilters.length) {
        animationTagFilters = next
      }
      if (next.length === 0) {
        animationTagFilterMode = 'all'
      }
    }
    if (animationTagFilterMode === 'untagged' && untaggedCount === 0) {
      animationTagFilterMode = 'all'
    }
  })

  $effect(() => {
    if (closetCategoryFilter === 'all') return
    if (!closetCategoryOptions.includes(closetCategoryFilter)) {
      closetCategoryFilter = 'all'
    }
  })

  $effect(() => {
    if (kitchenPreviewGoonId) {
      const exists = goons.some((entry) => entry.id === kitchenPreviewGoonId)
      if (!exists) {
        kitchenPreviewGoonId = goons[0]?.id ?? null
      }
      return
    }
    if (goons.length > 0) {
      kitchenPreviewGoonId = goons[0].id
    }
  })

  $effect(() => {
    const fallbackGoonId =
      goons.find((entry) => hasRenderableGoonAvatar(entry))?.id ??
      goons[0]?.id ??
      null
    if (libraryPreviewGoonId) {
      const exists = goons.some((entry) => entry.id === libraryPreviewGoonId)
      if (!exists) {
        libraryPreviewGoonId = fallbackGoonId
      }
      return
    }
    libraryPreviewGoonId = fallbackGoonId
  })

  $effect(() => {
    if (!editorSceneId) return
    if (!kitchenScenes?.[editorSceneId]) {
      editorSceneId = ''
      if (editorGoonId) {
        editorDirty = true
      }
    }
  })

  $effect(() => {
    if (!kitchenPreviewSceneId) return
    if (kitchenScenes?.[kitchenPreviewSceneId]) return
    kitchenPreviewSceneId = null
  })

  $effect(() => {
    if (sceneEditorMode !== 'edit' || !sceneEditorId) return
    if (kitchenScenes?.[sceneEditorId]) return
    sceneEditorMode = null
    sceneEditorId = null
    if (activeSceneEdit?.type === 'marker') {
      void cancelMarkerPlacement({ quiet: true })
    } else {
      cancelSceneEdit()
    }
  })

  $effect(() => {
    if (!activeSceneEdit) return
    if (!kitchenPreviewSceneId) return
    if (activeSceneEdit.sceneId !== kitchenPreviewSceneId) {
      if (activeSceneEdit.type === 'marker') {
        void cancelMarkerPlacement({ quiet: true })
      } else {
        cancelSceneEdit()
      }
    }
  })

  $effect(() => {
    if (sceneEditorMode !== 'edit' || !sceneEditorId) return
    if (!kitchenPreviewContainer) return
    if (kitchenPreviewSceneId !== sceneEditorId) {
      kitchenPreviewSceneId = sceneEditorId
    }
    void ensureKitchenPreviewReady(sceneEditorId)
  })

  $effect(() => {
    if (!active || activeTab !== 'kitchen' || sceneEditorMode) return
    if (!kitchenPreviewContainer) return
    const goon = resolveGoonById(kitchenPreviewGoonId)
    if (!goon) return
    if (!hasRenderableGoonAvatar(goon)) return
    void ensureKitchenPreviewReady()
  })

  $effect(() => {
    const nextContext = editorGoonId
      ? 'editor'
      : sceneEditorMode
        ? 'scene'
        : active
          ? 'main'
          : null
    if (nextContext !== previewWidthContext) {
      previewWidthContext = nextContext
      previewWidthNeedsInit = Boolean(nextContext)
    }
  })

  $effect(() => {
    if (!previewWidthNeedsInit) return
    const shell = getPreviewShellEl()
    if (!shell) return
    applyDefaultPreviewWidth()
    previewWidthNeedsInit = false
  })

  $effect(() => {
    const shouldPauseDock = Boolean(
          editorGoonId ||
        sceneEditorMode ||
        (active &&
          (activeTab === 'goons' ||
            activeTab === 'closet' ||
            activeTab === 'kitchen' ||
            activeTab === 'scenes' ||
            activeTab === 'motions'))
    )
    if (goonDockPauseActive === shouldPauseDock) return
    goonDockPauseActive = shouldPauseDock
    setGoonDockPause(shouldPauseDock)
  })

  $effect(() => {
    if (active || editorGoonId || sceneEditorMode) return
    resetPreview()
    resetKitchenPreview()
  })

  $effect(() => {
    previewEngine?.setEyeContactEnabled(
      paintedConcealEditorOpen ? false : settingsPreviewEyeContactEnabled
    )
  })

  $effect(() => {
    kitchenPreviewEngine?.setEyeContactEnabled(
      activeTab === 'motions' ? false : settingsPreviewEyeContactEnabled
    )
  })

  $effect(() => {
    if (!previewEngine) return
    previewEngine.setEyeContactMode(editorEyeContactMode)
    previewEngine.setEyeContactTuning(buildEditorEyeContactTuning())
  })

  $effect(() => {
    if (!kitchenPreviewEngine) return
    kitchenPreviewEngine.setEyeContactMode(activeKitchenEyeContactMode)
    kitchenPreviewEngine.setEyeContactTuning(activeKitchenEyeContactTuning)
  })


  $effect(() => {
    if (!editorGoonId) {
      previewAnimationName = ''
      return
    }
    if (availableAnimationNames.length === 0) {
      previewAnimationName = ''
      return
    }
    if (previewAnimationName && !availableAnimationNames.includes(previewAnimationName)) {
      previewAnimationName = ''
    }
  })

  $effect(() => {
    if (!kitchenPreviewGoonId) {
      kitchenPreviewAnimationName = ''
      return
    }
    if (kitchenAvailableAnimationNames.length === 0) {
      kitchenPreviewAnimationName = ''
      return
    }
    if (kitchenPreviewAnimationName && !kitchenAvailableAnimationNames.includes(kitchenPreviewAnimationName)) {
      kitchenPreviewAnimationName = ''
    }
  })

  $effect(() => {
    if (activeSceneEdit?.type !== 'marker') return
    if (!kitchenPreviewGoonId || activeMarkerMotionNames.length === 0) {
      void cancelMarkerPlacement({ quiet: true })
    }
  })

  function resetPreview(reason = 'reset') {
    previewToken += 1
    const previousHost = previewHost
    const disposedGoonId = previewGoonId
    const hadEngine = Boolean(previewEngine)
    previewEngine?.dispose()
    previewEngine = null
    previewHost = null
    previewEngineInitPromise = null
    removeExtraCanvases(previousHost)
    if (previewContainer && previewContainer !== previousHost) {
      removeExtraCanvases(previewContainer)
    }
    previewReady = false
    previewLoading = false
    previewError = null
    previewRuntimeStatus = null
    previewGoonId = null
    previewAnimationCatalog = []
    previewAnimationSignature = ''
    previewBaseLoopSignature = ''
    previewContextSignature = ''
    previewFailedContextSignature = ''
    previewSceneSignature = 'none'
    previewLoadInFlightSignature = ''
    motionLibraryPreviewSignature = ''
    previewAnimationActive = false
    previewAnimationRestore = null
    previewMaterialNames = []
    previewMaterialColorInfo = {}
    closetAssignments = {}
    editorWardrobeOutfits = {}
    editorActiveWardrobeOutfitId = null
    newWardrobeOutfitName = ''
    editorWardrobeOutfitCreateOpen = false
    editorPendingAdvancedPackageUpdate = null
    editorFacialArtworkUploadBusy = false
    editorFacialArtworkCreditDraft = createDefaultFacialArtworkUploadCreditDraft()
    advancedPackageUpdateFile = null
    closetBusy = false
    editorFacePreviewSuspended = false
    clearFacePreviewResumeTimer('editor')
    activeSceneEdit = null
    activeSceneEditTransform = null
    if (hadEngine || disposedGoonId) {
      logClientEvent({
        kind: 'goon-preview-reset',
        scope: 'goons',
        details: {
          reason,
          disposedGoonId,
          activeTab,
          motionLibraryPreviewName
        }
      })
    }
  }

  function resetKitchenPreview() {
    nextKitchenPreviewLoadRequestId()
    const previousHost = kitchenPreviewHost
    kitchenPreviewEngine?.dispose()
    kitchenPreviewEngine = null
    kitchenPreviewLoadedEngine = null
    kitchenPreviewHost = null
    kitchenPreviewEngineInitPromise = null
    removeExtraCanvases(previousHost)
    if (kitchenPreviewContainer && kitchenPreviewContainer !== previousHost) {
      removeExtraCanvases(kitchenPreviewContainer)
    }
    kitchenPreviewReady = false
    kitchenPreviewLoading = false
    kitchenPreviewError = null
    kitchenPreviewRuntimeStatus = null
    kitchenPreviewVrmUrl = ''
    kitchenPreviewSceneId = null
    kitchenPreviewLoadedGoonId = null
    kitchenPreviewAnimationCatalog = []
    kitchenPreviewAnimationSignature = ''
    kitchenPreviewBaseLoopSignature = ''
    kitchenPreviewSceneSignature = 'none'
    kitchenPreviewAnimationName = ''
    kitchenPreviewAnimationActive = false
    kitchenPreviewAnimationRestore = null
    kitchenPreviewClosetSignature = ''
    kitchenFacePreviewSuspended = false
    clearFacePreviewResumeTimer('kitchen')
    activeSceneEdit = null
    activeSceneEditTransform = null
  }

  function releaseInactivePreviewEngines(reason = 'inactive-preview') {
    if (!editorGoonId && activeTab !== 'motions') {
      resetPreview(reason)
    }
    if (!sceneEditorMode && activeTab !== 'kitchen') {
      resetKitchenPreview()
    }
  }

  function cloneEditTransform(transform: GoonEditTransform | null): GoonEditTransform | null {
    if (!transform) return null
    return {
      position: [...transform.position] as [number, number, number],
      rotation: [...transform.rotation] as [number, number, number],
      scale: [...transform.scale] as [number, number, number]
    }
  }

  function syncActiveSceneEditTransform(transform: GoonEditTransform | null) {
    activeSceneEditTransform = cloneEditTransform(transform)
  }

  function setScenePropScaleLock(checked: boolean) {
    scenePropScaleLock = checked
    kitchenPreviewEngine?.setScaleAspectLock(checked)
  }

  function formatScalePercent(value: number) {
    const percent = value * 100
    const rounded = Math.round(percent * 10) / 10
    const display = Math.abs(rounded - Math.round(rounded)) < 0.05 ? Math.round(rounded) : rounded
    return `${display}%`
  }

  function formatRotationDegrees(value: number) {
    const degrees = (value * 180) / Math.PI
    const rounded = Math.round(degrees * 10) / 10
    const display = Math.abs(rounded - Math.round(rounded)) < 0.05 ? Math.round(rounded) : rounded
    return `${display}°`
  }

  async function getGoonEngineCtor() {
    if (GoonEngineCtor) return GoonEngineCtor
    const module = await import('$lib/goons/engine')
    GoonEngineCtor = module.GoonEngine
    return GoonEngineCtor
  }

  async function waitForPreviewLayout(container: HTMLDivElement | null, attempts = 8) {
    if (!container) return
    for (let i = 0; i < attempts; i += 1) {
      if (container.clientWidth > 0 && container.clientHeight > 0) return
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    }
  }

  function removeExtraCanvases(container: HTMLDivElement | null, keepCanvas?: HTMLCanvasElement | null) {
    if (!container) return
    const canvases = Array.from(container.querySelectorAll('canvas'))
    for (const canvas of canvases) {
      if (keepCanvas && canvas === keepCanvas) continue
      canvas.parentElement?.removeChild(canvas)
    }
  }

  async function ensurePreviewEngine(): Promise<GoonEngine | null> {
    const host = previewContainer
    if (!host) return null

    if (previewEngineInitPromise) {
      return previewEngineInitPromise
    }

    if (previewEngine && previewHost === host) {
      removeExtraCanvases(host, previewEngine.getCanvasElement())
      return previewEngine
    }

    const initPromise = (async () => {
      const EngineCtor = await getGoonEngineCtor()
      if (!EngineCtor) return null

      if (previewEngine) {
        previewEngine.dispose()
        previewEngine = null
      }
      if (previewHost && previewHost !== host) {
        removeExtraCanvases(previewHost)
      }

      await waitForPreviewLayout(host)
      if (previewContainer !== host) {
        return null
      }

      removeExtraCanvases(host)
      const engine = new EngineCtor(host, {
        quality: editorQuality,
        lipSyncEnabled: editorLipSync,
        eyeContactMode: editorEyeContactMode,
        eyeContactTuning: buildEditorEyeContactTuning(),
        onRuntimeStatus: (status) => {
          previewRuntimeStatus = status
          logRendererRuntimeStatus('settings-editor-preview', status)
        },
        onCameraChange: handlePreviewCameraChange
      })
      previewEngine = engine
      previewHost = host
      await engine.init()
      engine.setCameraFov(previewViewFov)
      engine.refreshLayout()
      removeExtraCanvases(host, engine.getCanvasElement())
      return engine
    })()

    previewEngineInitPromise = initPromise
    try {
      return await initPromise
    } finally {
      if (previewEngineInitPromise === initPromise) {
        previewEngineInitPromise = null
      }
    }
  }

  async function refreshHairCatalog() {
    if (hairCatalogPromise) return hairCatalogPromise
    hairCatalogLoading = true
    hairCatalogError = null
    const request = loadHairAssetCatalog()
    hairCatalogPromise = request
    try {
      const catalog = await request
      hairAssets = catalog.assets
      hairRefitSources = catalog.refitSources
      hairCatalogLoaded = true
      return catalog
    } catch (error) {
      hairCatalogError = error instanceof Error ? error.message : 'The Hair catalog could not be loaded.'
      throw error
    } finally {
      if (hairCatalogPromise === request) hairCatalogPromise = null
      hairCatalogLoading = false
    }
  }

  async function ensureHairCatalog() {
    if (hairCatalogLoaded) {
      return hairAssets
    }
    return (await refreshHairCatalog()).assets
  }

  function applyStoredHairDraft(goon: GoonRecord) {
    editorHairHydrationGoonId = goon.id
    editorHairStoredSignature = JSON.stringify(goon.hairState ?? null)
    try {
      editorHairState = goon.hairState ? parseHairState(goon.hairState) : createHairState(null)
      editorHairStateError = null
    } catch (error) {
      editorHairState = createHairState(null)
      editorHairStateError =
        error instanceof Error ? error.message : 'The saved Hair state is invalid.'
    }
    hairPreviewError = null
    editorHairMotionTuning = editorHairState.motionSettings ?? {
      enabled: true,
      intensity: HAIR_MOTION_DEFAULT_INTENSITY
    }
  }

  $effect(() => {
    const goon = editorGoon
    const signature = JSON.stringify(goon?.hairState ?? null)
    const dirty = editorDirty
    if (!goon) {
      editorHairHydrationGoonId = ''
      editorHairStoredSignature = ''
      return
    }
    if (
      goon.id === editorHairHydrationGoonId &&
      signature === editorHairStoredSignature
    ) return
    if (dirty) return
    applyStoredHairDraft(goon)
  })

  async function applyHairStatePreview(
    engine: GoonEngine,
    stateValue: HairStateV2 | null | undefined
  ) {
    const state = stateValue ? parseHairState(stateValue) : createHairState(null)
    if (!state.selected) {
      engine.clearHairPreview()
      return null
    }
    const catalog = await ensureHairCatalog()
    const selection = resolveHairSelectionCatalogStatus(state, catalog)
    if (selection.status !== 'ready' || !selection.asset) {
      throw new Error(selection.message ?? 'The selected Hair style is unavailable.')
    }
    const summary = await engine.loadHairAssetPreview(
      selection.asset,
      state,
      resolveHairAssetBrowserUrl(selection.asset.geometry.main.ref, BATSHIT_SERVER_URL),
      (ref) => resolveHairAssetBrowserUrl(ref, BATSHIT_SERVER_URL)
    )
    const tuning = engine.getHairMotionPreviewTuning()
    if (tuning && engine === previewEngine) editorHairMotionTuning = tuning
    return summary
  }

  function updateEditorHairMotionTuning(value: SecondaryMotionTuning) {
    hairPreviewError = null
    try {
      if (!previewEngine) throw new Error('The current Goon preview is unavailable.')
      const nextState = parseHairState({ ...editorHairState, motionSettings: value })
      previewEngine.updateHairMotionPreviewTuning(nextState.motionSettings!)
      editorHairMotionTuning = nextState.motionSettings!
      editorHairState = nextState
      editorHairStateError = null
      editorDirty = true
    } catch (error) {
      hairPreviewError =
        error instanceof Error ? error.message : 'The Hair motion could not be previewed.'
      toast.error(hairPreviewError)
    }
  }

  async function updateEditorHairColors(colors: {
    baseColor: string
    highlightColor: string
  }) {
    if (!editorHairState.selected) return
    const nextState = parseHairState({ ...editorHairState, ...colors })
    if (hairStateEquals(editorHairState, nextState)) return
    hairPreviewError = null
    try {
      const engine = await ensurePreviewGoonReady()
      if (!engine) throw new Error('The current Goon preview is unavailable.')
      engine.updateHairPreviewColors(nextState)
      editorHairState = nextState
      editorHairStateError = null
      editorDirty = true
    } catch (error) {
      hairPreviewError =
        error instanceof Error ? error.message : 'The Hair colors could not be previewed.'
      toast.error(hairPreviewError)
    }
  }

  async function selectEditorHairAsset(asset: HairAssetV1 | null) {
    if (!editorHairSupported) {
      hairPreviewError = 'Hair Assets currently require an Advanced/GLB Goon.'
      return
    }
    if (asset) {
      const availability = classifyHairAssetAvailability(asset, editorHairRecipeSource)
      if (!availability.selectable) {
        hairPreviewError = availability.message
        toast.error(availability.message)
        return
      }
    }
    const previousState = editorHairState
    const nextState = createHairCatalogSelection(asset, previousState)
    if (hairStateEquals(previousState, nextState)) return
    hairPreviewBusy = true
    hairPreviewError = null
    try {
      const engine = await ensurePreviewGoonReady()
      if (!engine) throw new Error('The current Goon preview is unavailable.')
      const summary = await applyHairStatePreview(engine, nextState)
      editorHairState = nextState
      editorHairStateError = null
      editorDirty = true
      if (asset && summary) {
        toast.success(
          `${asset.display.name} previewed: ${summary.meshCount.toLocaleString()} pieces, ${summary.triangleCount.toLocaleString()} triangles.`
        )
      }
    } catch (error) {
      hairPreviewError = error instanceof Error ? error.message : 'The Hair preview could not be updated.'
      toast.error(hairPreviewError)
    } finally {
      hairPreviewBusy = false
    }
  }

  async function openEditorHairImport(files: File[]) {
    if (!editorGoonId || !editorHairSupported) {
      toast.error('Hair import requires an open Advanced/GLB Goon with a verified Recipe.')
      return
    }
    let selection
    try {
      selection = selectHairImportFiles(files)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Choose one OBJ or GLB Hair file.')
      return
    }
    hairImportInitialFile = selection.file
    hairImportInitialCalibrationFile = selection.calibrationFile
    hairImportInitialInspection = null
    hairImportRefitAsset = null
    hairImportRefitSource = null
    hairImportCandidate = null
    hairImportFileName = selection.file.name
    const originalContext = snapshotHairImportEditorContext(
      editorHairState,
      editorAppearanceDialsState
    )
    hairImportOriginalState = originalContext.hairState
    hairImportOriginalDials = originalContext.appearanceDials
    hairImportOriginalCamera = previewEngine?.getCameraState() ?? null
    editorHairImportOpen = true
    await tick()
    revealHairImportEditor(editorScrollElement, hairImportWizardElement)
  }

  function resetEditorHairImportContext() {
    if (hairMotionPaintResolver) finishEditorHairMotionPaint(null)
    hairImportInitialFile = null
    hairImportInitialCalibrationFile = null
    hairImportInitialInspection = null
    hairImportRefitAsset = null
    hairImportRefitSource = null
    hairImportCandidate = null
    hairImportFileName = ''
    hairImportOriginalState = null
    hairImportOriginalDials = null
    hairImportOriginalCamera = null
  }

  function closeEditorHairImport() {
    editorHairImportOpen = false
    resetEditorHairImportContext()
  }

  async function applyHairImportAuthoringPose(engine: GoonEngine) {
    const pose = resolvePaintedConcealPose('t-pose')
    await engine.loadAdditionalAnimations([pose.file])
    engine.setAuthoringPoseMode(true, pose.animationName)
  }

  async function inspectEditorHairImport(file: File, calibrationFile: File | null) {
    if (!editorGoonId) throw new Error('Open one Goon before importing Hair.')
    hairImportFileName = file.name
    const engine = await ensurePreviewGoonReady()
    if (!engine) throw new Error('The current Goon preview is unavailable.')
    await applyHairImportAuthoringPose(engine)
    if (!hairImportOriginalCamera) {
      hairImportOriginalCamera = engine.getCameraState() ?? null
    }
    const inspection = await createHairImport({ file, calibrationFile, goonId: editorGoonId })
    await engine.loadHairImportInspectionPreview(
      resolveHairAssetBrowserUrl(inspection.previewGeometryUrl, BATSHIT_SERVER_URL),
      inspection.objects.map((object) => object.id),
      inspection.objects.filter((object) => object.recommendedHair).map((object) => object.id),
      inspection.proposedTransform
    )
    setTransientHairImportCamera(engine, 0)
    await waitForHairImportPreviewFrame()
    return inspection
  }

  async function openEditorHairRefit(asset: HairAssetV1, refitSource: HairRefitSourceV1) {
    if (
      !editorGoonId ||
      !editorHairSupported ||
      refitSource.assetId !== asset.assetId ||
      refitSource.revisionId !== asset.revisionId
    ) {
      toast.error('Hair refit requires an imported Hair revision and an open Advanced/GLB Goon.')
      return
    }
    const originalContext = snapshotHairImportEditorContext(
      editorHairState,
      editorAppearanceDialsState
    )
    hairImportOriginalState = originalContext.hairState
    hairImportOriginalDials = originalContext.appearanceDials
    hairImportOriginalCamera = previewEngine?.getCameraState() ?? null
    hairImportInitialFile = null
    hairImportInitialCalibrationFile = null
    hairImportInitialInspection = null
    hairImportRefitAsset = asset
    hairImportRefitSource = refitSource
    hairImportCandidate = null
    hairImportFileName = asset.display.name
    hairPreviewBusy = true
    let inspection: HairImportInspection | null = null
    try {
      const engine = await ensurePreviewGoonReady()
      if (!engine) throw new Error('The current Goon preview is unavailable.')
      await applyHairImportAuthoringPose(engine)
      inspection = await createHairRefit({ goonId: editorGoonId, asset })
      await engine.loadHairImportInspectionPreview(
        resolveHairAssetBrowserUrl(inspection.previewGeometryUrl, BATSHIT_SERVER_URL),
        inspection.objects.map((object) => object.id),
        inspection.objects.filter((object) => object.recommendedHair).map((object) => object.id),
        inspection.initialTransform
      )
      setTransientHairImportCamera(engine, 0)
      await waitForHairImportPreviewFrame()
      hairImportInitialInspection = inspection
      editorHairImportOpen = true
      await tick()
      revealHairImportEditor(editorScrollElement, hairImportWizardElement)
    } catch (error) {
      if (inspection?.sessionId) {
        try {
          await cancelHairImport(inspection.sessionId)
        } catch (cleanupError) {
          console.error('[GoonsSettingsPanel] Hair refit cleanup failed:', cleanupError)
        }
      }
      previewEngine?.setAuthoringPoseMode(false)
      try {
        const engine = await ensurePreviewGoonReady()
        if (engine) {
          await applyHairStatePreview(engine, hairImportOriginalState)
          engine.setAppearanceDialValues(hairImportOriginalDials)
          if (hairImportOriginalCamera) engine.applyCamera(hairImportOriginalCamera)
        }
      } catch (restoreError) {
        console.error('[GoonsSettingsPanel] Hair refit preview restoration failed:', restoreError)
      }
      resetEditorHairImportContext()
      toast.error(error instanceof Error ? error.message : 'The Hair refit could not be opened.')
    } finally {
      hairPreviewBusy = false
    }
  }

  function updateEditorHairImportSelection(
    selectedObjectIds: string[],
    soloObjectId: string | null
  ) {
    const engine = previewEngine
    if (!engine) throw new Error('The current Goon preview is unavailable.')
    engine.updateHairImportInspectionSelection(selectedObjectIds, soloObjectId)
  }

  function updateEditorHairImportTransform(transform: HairImportPreviewRequest['transform']) {
    const engine = previewEngine
    if (!engine) throw new Error('The current Goon preview is unavailable.')
    engine.updateHairImportInspectionTransform(transform)
  }

  async function restoreEditorHairImportFit(
    inspection: HairImportInspection,
    request: HairImportPreviewRequest
  ) {
    const engine = await ensurePreviewGoonReady()
    if (!engine) throw new Error('The current Goon preview is unavailable.')
    await engine.loadHairImportInspectionPreview(
      resolveHairAssetBrowserUrl(inspection.previewGeometryUrl, BATSHIT_SERVER_URL),
      inspection.objects.map((object) => object.id),
      request.selectedObjectIds,
      request.transform
    )
    setTransientHairImportCamera(engine, 0)
    await waitForHairImportPreviewFrame()
  }

  function setTransientHairImportCamera(engine: GoonEngine, yaw: number) {
    engine.setCameraChangeHandler()
    try {
      if (!engine.frameAvatar('headshot')) {
        throw new Error('The Goon preview could not frame the imported Hair.')
      }
      const framed = engine.getCameraState()
      if (!framed) throw new Error('The Goon preview camera is unavailable.')
      engine.applyCamera({ ...framed, yaw, pitch: 0, mode: 'free' })
    } finally {
      engine.setCameraChangeHandler(handlePreviewCameraChange)
    }
  }

  async function waitForHairImportPreviewFrame() {
    await tick()
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    })
  }

  async function buildEditorHairImportPreview(request: HairImportPreviewRequest) {
    const prepared = await prepareHairImport({
      ...request,
      reviewedAppearanceState: hairImportOriginalDials
    })
    const engine = await ensurePreviewGoonReady()
    if (!engine) throw new Error('The current Goon preview is unavailable.')
    await engine.loadHairAssetPreview(
      prepared.candidate.asset,
      prepared.candidate.hairState,
      resolveHairAssetBrowserUrl(prepared.candidate.geometryUrl, BATSHIT_SERVER_URL),
      (ref) => resolveHairAssetBrowserUrl(ref, BATSHIT_SERVER_URL)
    )
    hairImportCandidate = prepared.candidate
    setTransientHairImportCamera(engine, 0)
    await waitForHairImportPreviewFrame()
    return prepared.proposals
  }

  async function setEditorHairImportMotionMap(
    enabled: boolean,
    _request: HairImportPreviewRequest
  ) {
    if (!hairImportCandidate) throw new Error('Build the Hair preview before reviewing motion.')
    const engine = await ensurePreviewGoonReady()
    if (!engine) throw new Error('The current Goon preview is unavailable.')
    engine.setAppearanceDialValues(hairImportOriginalDials)
    if (enabled) engine.showHairImportMotionMap()
    else engine.hideHairImportMotionMap()
    setTransientHairImportCamera(engine, 0)
    await waitForHairImportPreviewFrame()
  }

  function finishEditorHairMotionPaint(paint: HairMotionPaintV1 | null) {
    const engine = previewEngine
    if (engine) {
      engine.setHairImportMotionPaintActive(false)
      engine.setHairImportMotionPaintGoonVisible(true)
      for (const mesh of hairMotionPaintTopology?.meshes ?? []) {
        try {
          engine.setHairImportMotionPaintMeshVisible(mesh.meshNode, true)
        } catch {
          // The preview may already have been replaced while the editor was closing.
        }
      }
    }
    const resolve = hairMotionPaintResolver
    hairMotionPaintResolver = null
    hairMotionPaintEditorOpen = false
    hairMotionPaintTopology = null
    hairMotionPaintInitial = null
    resolve?.(paint)
  }

  async function editEditorHairMotionPaint(
    current: HairMotionPaintV1 | null
  ): Promise<HairMotionPaintV1 | null> {
    if (!hairImportCandidate) {
      throw new Error('Build the reviewed Hair candidate before painting motion areas.')
    }
    if (paintedConcealEditorOpen) {
      throw new Error('Finish the active Wardrobe paint editor before painting Hair motion.')
    }
    if (hairMotionPaintResolver) {
      throw new Error('The Hair motion paint editor is already open.')
    }
    const engine = await ensurePreviewGoonReady()
    if (!engine) throw new Error('The current Goon preview is unavailable.')
    engine.setAppearanceDialValues(hairImportOriginalDials)
    hairMotionPaintTopology = engine.getHairImportMotionPaintTopology()
    hairMotionPaintInitial = current
    engine.setHairImportMotionPaintGoonVisible(true)
    for (const mesh of hairMotionPaintTopology.meshes) {
      engine.setHairImportMotionPaintMeshVisible(mesh.meshNode, true)
    }
    engine.setHairImportMotionPaintActive(true)
    hairMotionPaintEditorOpen = true
    return new Promise((resolve) => {
      hairMotionPaintResolver = resolve
    })
  }

  async function previewEditorHairMotionPaint(
    paint: HairMotionPaintV1,
    activeRegionId: string | null
  ) {
    const engine = previewEngine
    if (!engine || !hairMotionPaintEditorOpen) return
    engine.showHairImportMotionPaint(paint, activeRegionId)
    await waitForHairImportPreviewFrame()
  }

  function pickEditorHairMotionPaint(
    clientX: number,
    clientY: number,
    brushRadiusPx: number
  ) {
    return previewEngine?.pickHairImportMotionTriangles(clientX, clientY, brushRadiusPx) ?? null
  }

  function setEditorHairMotionPaintGoonVisible(visible: boolean) {
    previewEngine?.setHairImportMotionPaintGoonVisible(visible)
  }

  function setEditorHairMotionPaintMeshVisible(meshNode: string, visible: boolean) {
    previewEngine?.setHairImportMotionPaintMeshVisible(meshNode, visible)
  }

  function cancelEditorHairMotionPaint() {
    if (hairImportCandidate && previewEngine) {
      try {
        previewEngine.hideHairImportMotionMap()
      } catch (error) {
        console.error('[GoonsSettingsPanel] Hair motion paint cleanup failed:', error)
      }
    }
    finishEditorHairMotionPaint(null)
  }

  function saveEditorHairMotionPaint(paint: HairMotionPaintV1) {
    if (hairImportCandidate && previewEngine) {
      try {
        previewEngine.hideHairImportMotionMap()
      } catch (error) {
        console.error('[GoonsSettingsPanel] Hair motion paint cleanup failed:', error)
      }
    }
    finishEditorHairMotionPaint(paint)
  }

  function hairImportPreviewPng(engine: GoonEngine) {
    const dataUrl = engine.captureSnapshot()
    const prefix = 'data:image/png;base64,'
    if (!dataUrl?.startsWith(prefix)) {
      throw new Error('The exact reviewed Hair preview could not be captured as PNG.')
    }
    const decoded = atob(dataUrl.slice(prefix.length))
    const bytes = new Uint8Array(decoded.length)
    for (let index = 0; index < decoded.length; index += 1) bytes[index] = decoded.charCodeAt(index)
    return bytesToBlob(bytes, { type: 'image/png' })
  }

  function hairImportDisplayName() {
    if (hairImportRefitAsset) return hairImportRefitAsset.display.name
    const value = hairImportFileName
      .replace(/\.(obj|glb)$/i, '')
      .replace(/[_-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    return (value || 'Imported Hair').slice(0, 120)
  }

  async function finalizeEditorHairImport(request: HairImportFinalizeRequest) {
    const candidate = hairImportCandidate
    if (!candidate) throw new Error('The finished Hair candidate is unavailable.')
    const engine = await ensurePreviewGoonReady()
    if (!engine) throw new Error('The current Goon preview is unavailable.')
    engine.setAppearanceDialValues(hairImportOriginalDials)
    engine.hideHairImportMotionMap()
    setTransientHairImportCamera(engine, 0)
    await waitForHairImportPreviewFrame()
    return finalizeHairImport({
      ...request,
      previewPng: hairImportPreviewPng(engine),
      displayName: hairImportDisplayName(),
      author: hairImportRefitAsset
        ? hairImportRefitAsset.provenance.author
        : (userSettings?.displayName?.trim() || 'Local Batshit user').slice(0, 160),
      license: hairImportRefitAsset
        ? hairImportRefitAsset.provenance.license
        : 'User-provided source; rights retained by importer'
    })
  }

  async function completeEditorHairImport(result: unknown) {
    const asset = await verifyHairAsset(result)
    await refreshHairCatalog()
    try {
      await selectEditorHairAsset(asset)
    } finally {
      previewEngine?.setAuthoringPoseMode(false)
    }
    toast.success(
      `${asset.display.name} was saved as immutable imported Hair revision ${asset.revision}.`
    )
  }

  async function deleteEditorHairAsset(asset: HairAssetV1) {
    try {
      await deleteHairAssetRevision(asset.assetId, asset.revisionId)
      await refreshHairCatalog()
      toast.success(`${asset.display.name} revision ${asset.revision} was deleted.`)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'The Hair revision could not be deleted.'
      toast.error(message)
      throw error
    }
  }

  async function cancelEditorHairImport(sessionId: string | null) {
    if (sessionId) await cancelHairImport(sessionId)
    previewEngine?.setAuthoringPoseMode(false)
    try {
      const engine = await ensurePreviewGoonReady()
      if (engine) {
        await applyHairStatePreview(engine, hairImportOriginalState)
        engine.setAppearanceDialValues(hairImportOriginalDials)
        if (hairImportOriginalCamera) engine.applyCamera(hairImportOriginalCamera)
      }
    } catch (error) {
      toast.error(
        error instanceof Error
          ? `The unfinished import was cleaned up, but the prior preview could not be restored: ${error.message}`
          : 'The unfinished import was cleaned up, but the prior preview could not be restored.'
      )
    }
  }

  function resolveGoonById(id?: string | null) {
    if (!id) return null
    return goons.find((entry) => entry.id === id) ?? null
  }

  async function ensureKitchenPreviewEngine(): Promise<GoonEngine | null> {
    const host = kitchenPreviewContainer
    if (!host) return null

    if (kitchenPreviewEngineInitPromise) {
      return kitchenPreviewEngineInitPromise
    }

    if (kitchenPreviewEngine && kitchenPreviewHost === host) {
      removeExtraCanvases(host, kitchenPreviewEngine.getCanvasElement())
      return kitchenPreviewEngine
    }

    const initPromise = (async () => {
      const EngineCtor = await getGoonEngineCtor()
      if (!EngineCtor) return null

      if (kitchenPreviewEngine) {
        kitchenPreviewEngine.dispose()
        kitchenPreviewEngine = null
        kitchenPreviewLoadedEngine = null
      }
      if (kitchenPreviewHost && kitchenPreviewHost !== host) {
        removeExtraCanvases(kitchenPreviewHost)
      }

      await waitForPreviewLayout(host)
      if (kitchenPreviewContainer !== host) {
        return null
      }

      removeExtraCanvases(host)
      const engine = new EngineCtor(host, {
        quality: kitchenPreviewQuality,
        lipSyncEnabled: false,
        eyeContactMode: activeKitchenEyeContactMode,
        eyeContactTuning: activeKitchenEyeContactTuning,
        onRuntimeStatus: (status) => {
          kitchenPreviewRuntimeStatus = status
          logRendererRuntimeStatus('settings-kitchen-preview', status)
        },
        onEditTransformChange: (transform) => {
          syncActiveSceneEditTransform(transform)
        }
      })
      engine.setScaleAspectLock(scenePropScaleLock)
      kitchenPreviewEngine = engine
      kitchenPreviewLoadedEngine = null
      kitchenPreviewHost = host
      await engine.init()
      engine.setCameraFov(previewViewFov)
      engine.refreshLayout()
      removeExtraCanvases(host, engine.getCanvasElement())
      return engine
    })()

    kitchenPreviewEngineInitPromise = initPromise
    try {
      return await initPromise
    } finally {
      if (kitchenPreviewEngineInitPromise === initPromise) {
        kitchenPreviewEngineInitPromise = null
      }
    }
  }

  async function loadKitchenPreviewGoon(
    targetGoon: GoonRecord,
    sceneId?: string | null,
    requestId?: number
  ) {
    const activeRequestId = requestId ?? kitchenPreviewLoadRequestId
    return queueKitchenPreviewLoad(async () => {
      if (!isKitchenPreviewLoadRequestCurrent(activeRequestId)) return false
      const targetUrl = resolveGoonAvatarUrl(targetGoon)
      if (!kitchenPreviewContainer || !targetUrl) return false
      kitchenPreviewLoading = true
      kitchenPreviewError = null

      try {
        const engine = await ensureKitchenPreviewEngine()
        if (!engine || !isKitchenPreviewLoadRequestCurrent(activeRequestId)) return false

        const { kind } = await loadAvatarIntoEngine(engine, targetGoon)
        if (!isKitchenPreviewLoadRequestCurrent(activeRequestId)) return false

        const scene = sceneId ? kitchenScenes?.[sceneId] ?? null : null
        await applyGoonSceneDefinition(engine, scene, stagePostureMap)
        kitchenPreviewSceneSignature = buildGoonSceneSignature(scene)
        if (!isKitchenPreviewLoadRequestCurrent(activeRequestId)) return false
        if (kind === 'vrm') {
          await applyClosetAssignments(engine, targetGoon.closetAssignments ?? {}, {
            guidedOutfitPieces: targetGoon.guidedAvatar?.outfitPieces ?? [],
            guidedPieceStates: targetGoon.guidedAvatar?.pieceStates ?? {}
          })
          if (!isKitchenPreviewLoadRequestCurrent(activeRequestId)) return false
        }
        applyPreviewCamera(engine, targetGoon.camera ?? null, { forceResetIfMissing: true })
        if (!isKitchenPreviewLoadRequestCurrent(activeRequestId)) return false

        const animationFiles = resolveAnimationFiles(targetGoon)
        const { cueMap } = resolveGoonCues(targetGoon, goonsSettings)
        const baseLoop = targetGoon.defaults?.baseLoop ?? 'base_stand'
        const baseLoopDefinition = cueMap?.[baseLoop]
        const animationPlan = buildPreviewAnimationLoadPlan(targetGoon, cueMap)
        kitchenPreviewAnimationCatalog = engine.getAnimationCatalog()
        kitchenPreviewCustomExpressions = kind === 'vrm' ? engine.getCustomExpressionNames() : []
        kitchenPreviewAnimationSignature = animationFiles.map((entry) => entry.url).join('|')
        kitchenPreviewBaseLoopSignature = buildBaseLoopSignature(baseLoop, baseLoopDefinition)
        if (scenePreviewUsesMotionOnly()) {
          kitchenPreviewAnimationActive = false
          kitchenPreviewAnimationRestore = null
          applyScenePreviewMotionState(engine, targetGoon)
        } else {
          engine.setMood(baseLoop, baseLoopDefinition)
          kitchenPreviewAnimationActive = false
          kitchenPreviewAnimationRestore = null
        }
        engine.setGoonVisible(true)
        kitchenPreviewClosetSignature = JSON.stringify(targetGoon.closetAssignments ?? {})
        kitchenPreviewReady = true
        kitchenPreviewVrmUrl = targetUrl
        kitchenPreviewLoadedEngine = engine
        kitchenPreviewLoadedGoonId = targetGoon.id

        void engine
          .syncAnimations(animationPlan.eager, { deferredFiles: animationPlan.deferred })
          .then(() => {
            if (!isKitchenPreviewLoadRequestCurrent(activeRequestId)) return
            kitchenPreviewAnimationCatalog = engine.getAnimationCatalog()
            if (kind === 'vrm') {
              kitchenPreviewCustomExpressions = engine.getCustomExpressionNames()
            }
          })
          .catch((error) => {
            if (!isKitchenPreviewLoadRequestCurrent(activeRequestId)) return
            console.warn('[GoonsSettings] Kitchen animation sync failed:', error)
          })
        return true
      } catch (error: any) {
        if (isKitchenPreviewLoadRequestCurrent(activeRequestId)) {
          kitchenPreviewError = toGoonPreviewError(error, 'Failed to load preview')
          kitchenPreviewReady = false
        }
        return false
      } finally {
        if (isKitchenPreviewLoadRequestCurrent(activeRequestId)) {
          kitchenPreviewLoading = false
        }
      }
    })
  }

  async function ensureSceneProxyPreviewReady(
    sceneId?: string | null,
    options: { syncScene?: boolean } = {}
  ) {
    const requestId = kitchenPreviewLoadRequestId
    return queueKitchenPreviewLoad(async () => {
      if (!isKitchenPreviewLoadRequestCurrent(requestId)) return null
      const engine = await ensureKitchenPreviewEngine()
      if (!engine || !isKitchenPreviewLoadRequestCurrent(requestId)) return null

      kitchenPreviewSceneId = sceneId ?? kitchenPreviewSceneId
      const scene = kitchenPreviewSceneId ? kitchenScenes?.[kitchenPreviewSceneId] ?? null : null
      const shouldReload =
        kitchenPreviewVrmUrl !== STUNT_DUMMY_VRM_URL ||
        kitchenPreviewLoadedGoonId !== SCENE_PROXY_PREVIEW_GOON_ID ||
        kitchenPreviewLoadedEngine !== engine ||
        !kitchenPreviewReady
      const shouldSyncScene = options.syncScene !== false

      if (shouldReload) {
        kitchenPreviewLoading = true
        kitchenPreviewError = null
      }

      try {
        if (shouldReload) {
          await engine.loadGoon(STUNT_DUMMY_VRM_URL)
          if (!isKitchenPreviewLoadRequestCurrent(requestId)) return null
          applyPreviewCamera(engine, null, { forceResetIfMissing: true })
          kitchenPreviewAnimationCatalog = engine.getAnimationCatalog()
          kitchenPreviewCustomExpressions = engine.getCustomExpressionNames()
          kitchenPreviewAnimationSignature = ''
          kitchenPreviewBaseLoopSignature = ''
          kitchenPreviewClosetSignature = ''
          kitchenPreviewVrmUrl = STUNT_DUMMY_VRM_URL
          kitchenPreviewLoadedEngine = engine
          kitchenPreviewLoadedGoonId = SCENE_PROXY_PREVIEW_GOON_ID
          kitchenPreviewReady = true
        }

        if (shouldReload || shouldSyncScene) {
          await applyGoonSceneDefinition(engine, scene, stagePostureMap)
          kitchenPreviewSceneSignature = buildGoonSceneSignature(scene)
          if (!isKitchenPreviewLoadRequestCurrent(requestId)) return null
        }

        await applySceneProxyPose(engine)
        if (!isKitchenPreviewLoadRequestCurrent(requestId)) return null
        engine.setGoonVisible(true)
        return engine
      } catch (error: any) {
        if (isKitchenPreviewLoadRequestCurrent(requestId)) {
          kitchenPreviewError = toGoonPreviewError(error, 'Failed to load preview')
          kitchenPreviewReady = false
        }
        return null
      } finally {
        if (isKitchenPreviewLoadRequestCurrent(requestId)) {
          kitchenPreviewLoading = false
        }
      }
    })
  }

  async function ensureKitchenPreviewReady(
    sceneId?: string | null,
    options: { syncScene?: boolean } = {}
  ) {
    const requestId = kitchenPreviewLoadRequestId
    if (scenePreviewUsingProxy) {
      return ensureSceneProxyPreviewReady(sceneId, options)
    }
    if (!goons.length) {
      toast.error('Create or upload a Goon first.')
      return null
    }
    if (!kitchenPreviewGoonId) {
      kitchenPreviewGoonId = goons[0]?.id ?? null
    }
    const targetGoon = resolveGoonById(kitchenPreviewGoonId)
    if (!targetGoon) {
      toast.error('Select a Goon to preview.')
      return null
    }
    if (!hasRenderableGoonAvatar(targetGoon)) {
      toast.error('Selected Goon has no renderable avatar yet.')
      return null
    }
    const engine = await ensureKitchenPreviewEngine()
    if (!engine || !isKitchenPreviewLoadRequestCurrent(requestId)) return null

    kitchenPreviewSceneId = sceneId ?? kitchenPreviewSceneId
    const scene = kitchenPreviewSceneId ? kitchenScenes?.[kitchenPreviewSceneId] ?? null : null
    const vrmUrl = resolveGoonAvatarUrl(targetGoon)
    const shouldReload =
      kitchenPreviewVrmUrl !== vrmUrl ||
      kitchenPreviewLoadedGoonId !== targetGoon.id ||
      kitchenPreviewLoadedEngine !== engine
    const shouldSyncScene = options.syncScene !== false
    const closetSignature = JSON.stringify(targetGoon.closetAssignments ?? {})
    const { cueMap } = resolveGoonCues(targetGoon, goonsSettings)
    const baseLoop = targetGoon.defaults?.baseLoop ?? 'base_stand'
    const baseLoopDefinition = cueMap?.[baseLoop]
    if (shouldReload || !kitchenPreviewReady) {
      const loaded = await loadKitchenPreviewGoon(targetGoon, kitchenPreviewSceneId, requestId)
      if (!loaded) {
        return null
      }
      if (!isKitchenPreviewLoadRequestCurrent(requestId)) return null
    } else {
      if (shouldSyncScene) {
        await applyGoonSceneDefinition(engine, scene, stagePostureMap)
        kitchenPreviewSceneSignature = buildGoonSceneSignature(scene)
        if (!isKitchenPreviewLoadRequestCurrent(requestId)) return null
      }
      if (closetSignature !== kitchenPreviewClosetSignature) {
        await applyClosetAssignments(engine, targetGoon.closetAssignments ?? {}, {
          guidedOutfitPieces: targetGoon.guidedAvatar?.outfitPieces ?? [],
          guidedPieceStates: targetGoon.guidedAvatar?.pieceStates ?? {}
        })
        if (!isKitchenPreviewLoadRequestCurrent(requestId)) return null
        kitchenPreviewClosetSignature = closetSignature
      }
    }

    if (sceneId && !scenePreviewUsesMotionOnly()) {
      engine.clearPreviewAnimation()
      kitchenPreviewAnimationActive = false
      kitchenPreviewAnimationRestore = null
      if (kitchenPreviewAnimationName) {
        kitchenPreviewAnimationName = ''
      }
    }

    if (!isKitchenPreviewLoadRequestCurrent(requestId)) return null
    kitchenPreviewBaseLoopSignature = buildBaseLoopSignature(baseLoop, baseLoopDefinition)
    if (scenePreviewUsesMotionOnly()) {
      applyScenePreviewMotionState(engine, targetGoon)
    } else {
      engine.setMood(baseLoop, baseLoopDefinition)
    }
    engine.setGoonVisible(true)
    return engine
  }

  function resolveSceneForPreviewGoon(goon: GoonRecord) {
    if (activeTab === 'goons') {
      return null
    }
    if (editorGoonId === goon.id) {
      return editorScene
    }
    const defaultSceneId = goon.defaults?.sceneId
    return defaultSceneId ? kitchenScenes?.[defaultSceneId] ?? null : null
  }

  function resolveCueMapForPreviewGoon(goon: GoonRecord) {
    if (editorGoonId === goon.id) {
      return editorCueMap
    }
    return resolveGoonCues(goon, goonsSettings).cueMap
  }

  function resolveClosetAssignmentsForPreviewGoon(goon: GoonRecord) {
    if (editorGoonId === goon.id) {
      return closetAssignments
    }
    return goon.closetAssignments ?? {}
  }

  function resolveGuidedOutfitPiecesForPreviewGoon(goon: GoonRecord) {
    if (editorGoonId === goon.id) {
      return editorGuidedOutfitPiecesDraft
    }
    return goon.guidedAvatar?.outfitPieces ?? []
  }

  function resolveGuidedPieceStatesForPreviewGoon(goon: GoonRecord) {
    if (editorGoonId === goon.id) {
      return buildPersistedGuidedPieceStates(editorGuidedOutfitPiecesDraft)
    }
    return goon.guidedAvatar?.pieceStates ?? {}
  }

  function resolvePreviewCameraForGoon(goon: GoonRecord) {
    if (editorGoonId === goon.id && editorCamera && Object.keys(editorCamera).length > 0) {
      return editorCamera
    }
    return goon.camera ?? null
  }

  function buildPreviewContextSignature(goon: GoonRecord, mode: GoonPreviewMode) {
    const vrmUrl = resolveGoonAvatarSignature(goon)
    const animationSignature = resolveAnimationFiles(goon)
      .map((entry) => entry.url)
      .join('|')
    const hairSignature = JSON.stringify(goon.hairState ?? null)
    return [mode, goon.id, vrmUrl, animationSignature, hairSignature].join('::')
  }

  async function loadPreviewGoon(
    goon: GoonRecord,
    mode: GoonPreviewMode = 'editor',
    options: {
      strict?: boolean
      awaitAnimations?: boolean
      hairState?: HairStateV2 | null
    } = {}
  ): Promise<boolean> {
    goon = resolveRecipePreviewGoonAssetUrls(goon, BATSHIT_SERVER_URL)
    const targetUrl = resolveGoonAvatarUrl(goon)
    if (!previewContainer || !targetUrl) {
      const error = new Error(
        !previewContainer
          ? 'The Goon preview surface is unavailable.'
          : 'The Goon preview candidate has no renderable model.'
      )
      if (options.strict) throw error
      return false
    }
    const contextSignature = buildPreviewContextSignature(goon, mode)
    if (previewFailedContextSignature === contextSignature) {
      const error = new Error('This Goon preview candidate already failed to load.')
      if (options.strict) throw error
      return false
    }
    if (previewLoading && previewLoadInFlightSignature === contextSignature) {
      const error = new Error('This Goon preview candidate is already loading.')
      if (options.strict) throw error
      return false
    }
    const token = ++previewToken
    previewLoading = true
    previewLoadInFlightSignature = contextSignature
    previewError = null

    try {
      const engine = await ensurePreviewEngine()
      if (!engine) throw new Error('The Goon preview engine is unavailable.')
      if (token !== previewToken) {
        if (options.strict) throw new Error('The Goon preview candidate was superseded before it loaded.')
        return false
      }
      engine.refreshLayout()
      const comparisonState = previewGoonId === goon.id
        ? engine.captureComparisonPreviewState()
        : null

      const { kind } = await loadAvatarIntoEngine(engine, goon, {
        role:
          mode === 'recipe-live-candidate'
            ? 'recipe-live-candidate'
            : mode === 'editor' && goon.recipe?.contract === 'goon-recipe/v2'
            ? 'recipe-source'
            : 'automatic'
      })
      if (token !== previewToken) {
        if (options.strict) throw new Error('The Goon preview candidate was superseded while it loaded.')
        return false
      }
      if (kind === 'custom' && mode !== 'recipe-live-candidate') {
        const previewHairState = Object.prototype.hasOwnProperty.call(options, 'hairState')
          ? options.hairState
          : goon.id === editorGoonId && !recipeEditorPreviewTarget
            ? editorHairState
            : goon.hairState
        try {
          await applyHairStatePreview(engine, previewHairState)
          hairPreviewError = null
        } catch (error) {
          hairPreviewError =
            error instanceof Error ? error.message : 'The selected Hair style could not be restored.'
          toast.error(hairPreviewError)
        }
      } else {
        hairPreviewError = null
      }

      // Both lanes sync their motion set: VRM goons load .vrma entries, GLB
      // custom goons load .glb entries (resolveAnimationFiles/the load plan
      // are lane-filtered), keeping Settings previews consistent with the dock.
      const animationFiles = resolveAnimationFiles(goon)
      const cueMap = resolveCueMapForPreviewGoon(goon)
      const animationPlan = buildPreviewAnimationLoadPlan(goon, cueMap)
      await applyGoonSceneDefinition(engine, resolveSceneForPreviewGoon(goon), stagePostureMap)
      applyPreviewCamera(engine, resolvePreviewCameraForGoon(goon), {
        forceResetIfMissing: true
      })
      applyEditorPreviewLoopState(engine)
      previewSceneSignature = buildGoonSceneSignature(resolveSceneForPreviewGoon(goon))
      previewAnimationCatalog = engine.getAnimationCatalog()
      previewMaterialNames = kind === 'vrm' ? engine.getMaterialNames() : []
      previewMaterialColorInfo = Object.fromEntries(
        previewMaterialNames.map((name) => [name, engine.getMaterialColorInfo(name) ?? {}])
      )
      previewCustomExpressions = kind === 'vrm' ? engine.getCustomExpressionNames() : []
      if (kind === 'vrm') {
        await applyClosetAssignments(engine, resolveClosetAssignmentsForPreviewGoon(goon), {
          guidedOutfitPieces: resolveGuidedOutfitPiecesForPreviewGoon(goon),
          guidedPieceStates: resolveGuidedPieceStatesForPreviewGoon(goon)
        })
      }
      if (token !== previewToken) {
        if (options.strict) throw new Error('The Goon preview candidate was superseded during scene setup.')
        return false
      }
      if (mode === 'editor') {
        applyPendingEditorOpeningFrame(engine, goon.id)
      }
      engine.setGoonVisible(true)
      previewAnimationActive = false
      previewAnimationRestore = null
      previewAnimationSignature = animationFiles.map((entry) => entry.url).join('|')
      previewContextSignature = contextSignature
      previewFailedContextSignature = ''
      previewGoonId = goon.id
      previewVrmUrl = targetUrl
      previewReady = true

      const syncAnimations = engine
        .syncAnimations(animationPlan.eager, { deferredFiles: animationPlan.deferred })
        .then(() => {
          if (token !== previewToken) {
            if (options.strict) {
              throw new Error('The Goon preview candidate was superseded during animation loading.')
            }
            return
          }
          if (comparisonState) engine.restoreComparisonPreviewState(comparisonState)
          previewAnimationCatalog = engine.getAnimationCatalog()
          if (kind === 'vrm') {
            previewCustomExpressions = engine.getCustomExpressionNames()
          }
        })
        .catch((error) => {
          if (token !== previewToken) return
          console.warn('[GoonsSettings] Editor animation sync failed:', error)
          throw error
        })
      if (options.awaitAnimations) await syncAnimations
      else void syncAnimations.catch(() => undefined)
      return true
    } catch (error: any) {
      console.error('[GoonPreview] load failed', { token, error })
      if (token === previewToken) {
        previewFailedContextSignature = contextSignature
        previewError = toGoonPreviewError(error, 'Failed to load preview')
        previewReady = false
      }
      if (options.strict) throw error
      return false
    } finally {
      if (token === previewToken) {
        previewLoading = false
        if (previewLoadInFlightSignature === contextSignature) {
          previewLoadInFlightSignature = ''
        }
      }
    }
  }

  function projectStagedRecipeLiveCandidate(staged: RecipeStageResponse): GoonRecord {
    return applyRecipeRevisionProjection(
      structuredClone(staged.goon),
      staged.envelope,
      (asset, role) => ({
        url: resolveRecipeAssetUrl(asset.ref, BATSHIT_SERVER_URL),
        filename: asset.ref.split('/').pop()?.trim() || `recipe-live-${role}`,
        size: asset.bytes
      })
    )
  }

  async function handleRecipeEditorPreviewTargetChange(
    target: RecipeEditorPreviewTarget | null
  ) {
    const resolvedTarget = target
      ? {
          ...target,
          goon: resolveRecipePreviewGoonAssetUrls(
            target.goon,
            BATSHIT_SERVER_URL
          )
        }
      : null
    recipePreviewTransitioning = true
    try {
      if (resolvedTarget) {
        await loadPreviewGoon(resolvedTarget.goon, 'editor', {
          strict: true,
          awaitAnimations: true,
          hairState: resolvedTarget.goon.hairState ?? null
        })
      }
      recipeEditorPreviewTarget = resolvedTarget
    } finally {
      recipePreviewTransitioning = false
    }
  }

  function applyRecipeFittedPreviewState(
    preview: RecipeFittedPreviewState
  ) {
    if (!previewEngine || !previewReady || previewLoading || recipePreviewTransitioning) {
      return
    }
    if (previewGoonId !== editorGoonId) {
      return
    }
    try {
      previewEngine.setFittedAppearanceDialValues(
        preview.appearanceDials,
        preview.anatomyFitResults
      )
      editorAppearanceDialsError = ''
    } catch (error) {
      editorAppearanceDialsError =
        error instanceof Error ? error.message : String(error)
    }
  }

  function handleRecipeEditorDraftPreviewStateChange(
    preview: RecipeFittedPreviewState | null
  ) {
    recipeEditorDraftPreview = preview
  }

  async function previewStagedRecipeLiveCandidate(staged: RecipeStageResponse) {
    const candidate = projectStagedRecipeLiveCandidate(staged)
    const previousPreview = recipeEditorPreviewTarget?.goon ?? editorRecipeSourceGoon
    try {
      const loaded = await loadPreviewGoon(candidate, 'recipe-live-candidate', {
        strict: true,
        awaitAnimations: true
      })
      if (!loaded) throw new Error('The staged Recipe Live candidate did not become preview-ready.')
    } catch (candidateError) {
      if (!previousPreview) throw candidateError
      try {
        await loadPreviewGoon(previousPreview, 'editor', {
          strict: true,
          awaitAnimations: true
        })
      } catch (restoreError) {
        throw new AggregateError(
          [candidateError, restoreError],
          'The Recipe Live candidate failed to load, and the prior Settings preview could not be restored.'
        )
      }
      throw candidateError
    }
  }

  function applyPreviewCamera(
    engine: GoonEngine,
    camera: GoonCamera | null,
    options: { forceResetIfMissing?: boolean } = {}
  ) {
    if (camera && Object.keys(camera).length > 0) {
      if (typeof camera.fov === 'number') previewViewFov = clampPreviewFov(camera.fov)
      previewCameraMode = camera.mode ?? 'free'
      engine.applyCamera(camera)
      engine.setDefaultCamera(camera)
      return
    }

    if (options.forceResetIfMissing) {
      engine.resetCamera()
      engine.setDefaultCamera(engine.getCameraState())
    }
  }

  function applyPendingEditorOpeningFrame(engine: GoonEngine, goonId: string) {
    if (pendingEditorOpeningFrameGoonId !== goonId) return
    pendingEditorOpeningFrameGoonId = null

    // Opening the editor should always reveal the face, but it must not
    // overwrite the shared per-Goon camera merely because the preview loaded.
    engine.setCameraChangeHandler()
    try {
      if (!engine.frameAvatar(EDITOR_OPENING_FRAME_PRESET)) {
        console.warn('[GoonsSettings] Could not apply the editor opening frame', { goonId })
        return
      }
      engine.setDefaultCamera(engine.getCameraState())
    } finally {
      engine.setCameraChangeHandler(handlePreviewCameraChange)
    }
  }

  async function applyEditorScene(engine: GoonEngine) {
    await applyGoonSceneDefinition(engine, editorScene, stagePostureMap)
  }

  async function ensurePreviewGoonReady(
    goonOverride?: GoonRecord | null,
    mode: 'editor' | 'library' = 'editor'
  ): Promise<GoonEngine | null> {
    const targetGoon = resolveGoonSettingsPreviewTarget({
      explicitTarget: goonOverride,
      mode,
      editorGoon,
      recipeSourceGoon: editorRecipeSourceGoon,
      recipePreviewGoon: recipeEditorPreviewTarget?.goon
    })
    if (!targetGoon) return null
    if (!hasRenderableGoonAvatar(targetGoon)) return null
    const engine = await ensurePreviewEngine()
    if (!engine) return null
    const targetVrmUrl = resolveGoonAvatarUrl(targetGoon)
    const contextSignature = buildPreviewContextSignature(targetGoon, mode)
    if (
      previewGoonId !== targetGoon.id ||
      previewVrmUrl !== targetVrmUrl ||
      previewContextSignature !== contextSignature
    ) {
      await loadPreviewGoon(targetGoon, mode)
    }
    return engine
  }

  async function ensureLibraryPreviewReady(): Promise<GoonEngine | null> {
    const targetGoon = resolveGoonById(libraryPreviewGoonId)
    if (!targetGoon) return null
    return ensurePreviewGoonReady(targetGoon, 'library')
  }

  function resolveAppliedClosetColors(
    materialName: string,
    assignment: GoonClosetAssignment,
    item?: GoonClosetItem | null
  ) {
    const sourceColors = resolveClosetSlotSourceColors(materialName, assignment)
    const itemColorOverride = item?.materialColors
    return {
      baseHex:
        normalizeHexColor(itemColorOverride?.baseHex) ??
        sourceColors?.baseHex,
      shadeHex:
        normalizeHexColor(itemColorOverride?.shadeHex) ??
        sourceColors?.shadeHex
    }
  }

  function applyClosetColorOverride(
    engine: GoonEngine,
    materialName: string,
    assignment: GoonClosetAssignment,
    item?: GoonClosetItem | null
  ) {
    const colors = resolveAppliedClosetColors(materialName, assignment, item)
    if (!colors.baseHex && !colors.shadeHex) return false
    return engine.applyMaterialColorOverride(materialName, colors)
  }

  async function applyClosetAssignment(
    engine: GoonEngine,
    materialName: string,
    assignment: GoonClosetAssignment
  ) {
    const runtimeMaterialName =
      resolveClosetRuntimeMaterialName(materialName, engine.getMaterialNames()) ?? null
    if (!runtimeMaterialName) return

    if (assignment.mode === 'none') {
      if (isSkinOverlayClosetSlotKey(materialName)) {
        engine.resetMaterialOverrides(runtimeMaterialName)
        return
      }
      await engine.applyMaterialTexture(runtimeMaterialName, TRANSPARENT_TEXTURE_URL)
      applyClosetColorOverride(engine, runtimeMaterialName, assignment)
      return
    }
    if (assignment.mode === 'item') {
      const item = resolveClosetItem(assignment.itemId)
      if (!item) return
      if (item.xwear) {
        await engine.applyXWearMaterial(runtimeMaterialName, item.xwear as GoonXWearData)
        applyClosetColorOverride(engine, runtimeMaterialName, assignment, item)
        return
      }
      if (item.texture?.url) {
        await engine.applyMaterialTexture(runtimeMaterialName, item.texture.url)
      } else if (item.originalSource) {
        engine.resetMaterialOverrides(runtimeMaterialName)
      }
      applyClosetColorOverride(engine, runtimeMaterialName, assignment, item)
      return
    }
    engine.resetMaterialOverrides(runtimeMaterialName)
    applyClosetColorOverride(engine, runtimeMaterialName, assignment)
  }

  async function applyClosetAssignments(
    engine: GoonEngine,
    assignments: Record<string, GoonClosetAssignment>,
    options?: {
      guidedOutfitPieces?: GoonGuidedOutfitPiece[]
      guidedPieceStates?: Record<string, boolean>
    }
  ) {
    for (const [materialName, assignment] of Object.entries(assignments)) {
      await applyClosetAssignment(engine, materialName, assignment)
    }
    const bodyConceal = resolveActiveWearableConceal({
      closetAssignments: assignments,
      resolveClosetItem,
      resolveOriginalSavedItem: resolveOriginalSavedItemForConceal,
      guidedOutfitPieces: options?.guidedOutfitPieces,
      guidedPieceStates: options?.guidedPieceStates
    })
    engine.applyBodyConceal({
      paintedMasks: bodyConceal.paintedMasks
    })
  }

  async function handleClosetSlotChange(materialName: string, value: string) {
    closetBusy = true
    try {
      const engine = await ensurePreviewGoonReady()
      if (!engine) throw new Error('Preview not ready')
      const editedOriginal = value === '__original__'
        ? resolveEditedOriginalWardrobeItemForSlot(materialName)
        : null
      const nextAssignments = applyClosetSelectionChange(
        closetAssignments,
        materialName,
        (editedOriginal?.id ?? value) as '__original__' | '__none__' | string,
        resolveClosetItem,
        closetSlotNames
      )
      closetAssignments = nextAssignments
      editorWardrobeColorEditorKey = null
      if (resolveGuidedBasePiecesForSlot(materialName).length > 0) {
        editorGuidedActivePresetId = null
      }
      editorActiveWardrobeOutfitId = null
      editorDirty = true
      await runLoggedEditorPreviewUpdate(
        'closet-slot-change',
        async () => {
          engine.resetMaterialOverrides()
          await applyClosetAssignments(engine, nextAssignments, {
            guidedOutfitPieces: editorGuidedOutfitPiecesDraft,
            guidedPieceStates: buildPersistedGuidedPieceStates(editorGuidedOutfitPiecesDraft)
          })
        },
        { materialName, value }
      )
    } catch (error: any) {
      toast.error(error?.message || 'Closet update failed')
    } finally {
      closetBusy = false
    }
  }

  $effect(() => {
    const motionPreviewActive = active && activeTab === 'motions' && !editorGoonId && !sceneEditorMode

    if (editorGoonId) {
      if (previewGoonId && previewGoonId !== editorGoonId) {
        resetPreview('editor-goon-changed')
      }
      return
    }

    if (motionPreviewActive) {
      const motionLibraryPreviewLoaded = previewGoonId === MOTION_LIBRARY_PREVIEW_GOON_ID
      if (previewEngine && !motionLibraryPreviewLoaded && !motionLibraryPreviewLoading) {
        resetPreview('leaving-editor-for-motions')
      }
      return
    }

    resetPreview('preview-inactive')
  })

  $effect(() => {
    if (!previewContainer) return
    const element = previewContainer
    element.addEventListener('wheel', handlePreviewViewportFovWheel, { capture: true, passive: false })
    return () => {
      element.removeEventListener('wheel', handlePreviewViewportFovWheel, true)
    }
  })

  $effect(() => {
    if (!paintedConcealEditorOpen || typeof window === 'undefined') {
      paintedConcealShiftHeld = false
      paintedConcealPointerInPreview = false
      previewEngine?.setAuthoringPoseMode(false)
      return
    }
    window.addEventListener('keydown', handlePaintedConcealKeyDown)
    window.addEventListener('keyup', handlePaintedConcealKeyUp)
    window.addEventListener('pointermove', handlePaintedConcealWindowPointerMove)
    window.addEventListener('pointerup', handlePaintedConcealWindowPointerUp)
    window.addEventListener('pointercancel', handlePaintedConcealWindowPointerUp)
    return () => {
      window.removeEventListener('keydown', handlePaintedConcealKeyDown)
      window.removeEventListener('keyup', handlePaintedConcealKeyUp)
      window.removeEventListener('pointermove', handlePaintedConcealWindowPointerMove)
      window.removeEventListener('pointerup', handlePaintedConcealWindowPointerUp)
      window.removeEventListener('pointercancel', handlePaintedConcealWindowPointerUp)
      stopPaintedConcealStroke()
      paintedConcealShiftHeld = false
      paintedConcealPointerInPreview = false
    }
  })

  $effect(() => {
    if (!kitchenPreviewContainer) return
    const element = kitchenPreviewContainer
    element.addEventListener('wheel', handlePreviewViewportFovWheel, {
      capture: true,
      passive: false
    })
    return () => {
      element.removeEventListener('wheel', handlePreviewViewportFovWheel, true)
    }
  })

  $effect(() => {
    if (!previewEngine) return
    previewEngine.setQuality(editorQuality)
    previewEngine.setLipSyncEnabled(editorLipSync)
  })

  $effect(() => {
    if (!kitchenPreviewEngine) return
    kitchenPreviewEngine.setQuality(kitchenPreviewQuality)
  })

  $effect(() => {
    if (previewEngine) {
      previewEngine.setSkyboxPitchOffset(previewSkyboxOffset)
    }
    if (kitchenPreviewEngine) {
      kitchenPreviewEngine.setSkyboxPitchOffset(previewSkyboxOffset)
    }
  })

  $effect(() => {
    if (!previewEngine || !editorGoonId) return
    if (previewAnimationActive) return
    const next = resolveEditorPreviewLoopState()
    if (!next) return
    const signature = buildBaseLoopSignature(next.name, next.definition)
    if (signature === previewBaseLoopSignature) return
    applyEditorPreviewLoopState(previewEngine, { preserveCamera: true })
  })

  $effect(() => {
    if (!kitchenPreviewEngine || !kitchenPreviewReady) return
    if (activeTab !== 'kitchen' || sceneEditorMode || kitchenPreviewAnimationActive) return
    const next = resolveKitchenPreviewLoopState()
    if (!next) return
    const signature = buildBaseLoopSignature(next.name, next.definition)
    if (signature === kitchenPreviewBaseLoopSignature) return
    applyKitchenPreviewLoopState(kitchenPreviewEngine, { preserveCamera: true })
  })

  $effect(() => {
    if (!previewEngine || !editorGoonId) return
    const scene = editorGoon ? resolveSceneForPreviewGoon(editorGoon) : null
    const signature = buildGoonSceneSignature(scene)
    if (signature === previewSceneSignature) return
    previewSceneSignature = signature
    void applyGoonSceneDefinition(previewEngine, scene, stagePostureMap)
  })

  $effect(() => {
    if (!kitchenPreviewEngine || !kitchenPreviewSceneId) return
    const scene = kitchenScenes?.[kitchenPreviewSceneId] ?? null
    const signature = buildGoonSceneSignature(scene)
    if (signature === kitchenPreviewSceneSignature) return
    kitchenPreviewSceneSignature = signature
    void applyGoonSceneDefinition(kitchenPreviewEngine, scene, stagePostureMap)
  })

  $effect(() => {
    if (!previewEngine) return
    previewContextSignature
    if (!editorGoonId || !previewReady || editorFacePreviewSuspended) {
      previewEngine.clearAuthoringFacePreview()
      return
    }
    const definition = buildFacePreviewDefinition(editorCueMap, editorFacePreviewSelection)
    if (!definition) {
      previewEngine.clearAuthoringFacePreview()
      return
    }
    previewEngine.setAuthoringFacePreview(definition.name, definition)
  })

  $effect(() => {
    if (!kitchenPreviewEngine) return
    kitchenPreviewLoadedGoonId
    kitchenPreviewVrmUrl
    if (activeTab !== 'kitchen' || sceneEditorMode || !kitchenPreviewReady || kitchenFacePreviewSuspended) {
      kitchenPreviewEngine.clearAuthoringFacePreview()
      return
    }
    const definition = buildFacePreviewDefinition(kitchenCueMap, kitchenFacePreviewSelection)
    if (!definition) {
      kitchenPreviewEngine.clearAuthoringFacePreview()
      return
    }
    kitchenPreviewEngine.setAuthoringFacePreview(definition.name, definition)
  })


  $effect(() => {
    const goon = recipeEditorPreviewTarget?.goon ?? editorRecipeSourceGoon
    if (!goon) return
    const vrmUrl = resolveGoonAvatarUrl(goon)
    if (!vrmUrl || !previewContainer) return
    const contextSignature = buildPreviewContextSignature(goon, 'editor')
    if (previewFailedContextSignature === contextSignature) return
    if (previewContextSignature === contextSignature && previewGoonId === goon.id && previewVrmUrl === vrmUrl) {
      return
    }
    void loadPreviewGoon(goon, 'editor')
  })

  $effect(() => {
    if (activeTab !== 'motions') return
    if (!$goonMotionPreviewGenerationActive) return
    void clearMotionLibraryPreview()
  })

  onDestroy(() => {
    if (goonDockPauseActive) {
      goonDockPauseActive = false
      setGoonDockPause(false)
    }
    clearFacePreviewResumeTimer('editor')
    clearFacePreviewResumeTimer('kitchen')
    resetPreview()
    resetKitchenPreview()
    stopPreviewResize()
  })

  function handleUploadSelection(event: Event) {
    const input = event.currentTarget as HTMLInputElement
    const file = input.files?.[0] || null
    uploadFile = file
    if (file) {
      void handleUpload()
    }
  }

  async function handleUpload() {
    if (!uploadFile) {
      toast.error('Select a VRM file first.')
      return
    }
    uploadBusy = true
    try {
      await createGoon({
        file: uploadFile
      })
      uploadFile = null
      if (uploadInput) uploadInput.value = ''
      toast.success('Goon uploaded!')
    } catch (error: any) {
      toast.error(error?.message || 'Upload failed')
    } finally {
      uploadBusy = false
    }
  }

  function handleGuidedUploadSelection(event: Event) {
    const input = event.currentTarget as HTMLInputElement
    const file = input.files?.[0] || null
    guidedUploadFile = file
    if (file) {
      void handleGuidedUpload()
    }
  }

  async function handleGuidedUpload() {
    if (!guidedUploadFile) {
      toast.error('Select an Advanced/Blender package first.')
      return
    }
    guidedUploadBusy = true
    try {
      await createGoon({
        sourceProfile: 'guided-custom-vrm',
        file: guidedUploadFile
      })
      guidedUploadFile = null
      if (guidedUploadInput) guidedUploadInput.value = ''
      toast.success('Advanced/Blender Goon package uploaded!')
    } catch (error: any) {
      toast.error(error?.message || 'Advanced package upload failed')
    } finally {
      guidedUploadBusy = false
    }
  }

  function handleCustomUploadSelection(event: Event) {
    const input = event.currentTarget as HTMLInputElement
    const file = input.files?.[0] || null
    customUploadFile = file
    if (file) {
      void handleCustomUpload()
    }
  }

  async function handleCustomUpload() {
    if (!customUploadFile) {
      toast.error('Select an Advanced/GLB package first.')
      return
    }
    customUploadBusy = true
    try {
      const created = await createGoon({
        sourceProfile: 'expert-custom-glb',
        file: customUploadFile
      })
      customUploadFile = null
      if (customUploadInput) customUploadInput.value = ''
      openCueEditor(created)
      if (isRecipePreparationRequired(created)) {
        // The verified first-party preparation controller lives in the Goon File
        // section because it needs the editor's shared preview engine. Open that
        // section immediately so preparation starts without another user action.
        editorVrmSectionOpen = true
      }
      toast.success(
        isRecipePreparationRequired(created)
          ? 'Goon uploaded. Preparing it now…'
          : 'Advanced/GLB Goon package uploaded!'
      )
    } catch (error: any) {
      toast.error(error?.message || 'Advanced/GLB package upload failed')
    } finally {
      customUploadBusy = false
    }
  }

  function handleUpdateVrmSelection(event: Event) {
    const input = event.currentTarget as HTMLInputElement
    const file = input.files?.[0] || null
    updateVrmFile = file
    if (file) {
      void handleUpdateVrm()
    }
  }

  async function handleUpdateVrm() {
    if (!editorGoonId || !editorGoon) return
    if (!updateVrmFile) {
      toast.error('Select a VRM file first.')
      return
    }
    updateVrmBusy = true
    try {
      const currentAnalysis = await getCurrentVrmAnalysis()
      const nextAnalysis = await analyzeVrmFile(updateVrmFile)
      const resolvedCues = resolveGoonCues(editorGoon, goonsSettings)
      const report = buildVrmUpdateReport(
        editorGoon,
        currentAnalysis,
        nextAnalysis,
        resolvedCues
      )

      const fileInfo = await uploadGoonVrm(editorGoonId, updateVrmFile)
      editorPendingVrmFile = {
        url: fileInfo.url,
        filename: fileInfo.filename || updateVrmFile.name,
        size: fileInfo.size ?? updateVrmFile.size,
        mimeType: fileInfo.mimeType ?? updateVrmFile.type,
        uploadedAt: fileInfo.uploadedAt ?? new Date().toISOString()
      }
      editorPendingVrmUpdate = report ?? null
      toast.success('Update ready. Save Goon to apply it.')
    } catch (error: any) {
      toast.error(error?.message || 'Update failed')
    } finally {
      updateVrmBusy = false
      updateVrmFile = null
      if (updateVrmInput) updateVrmInput.value = ''
    }
  }

  function handleAdvancedPackageUpdateSelection(event: Event) {
    const input = event.currentTarget as HTMLInputElement
    const file = input.files?.[0] || null
    advancedPackageUpdateFile = file
    if (file) {
      void handleAdvancedPackageUpdate()
    }
  }

  async function handleAdvancedPackageUpdate() {
    if (!editorGoonId || !editorGoon) return
    if (editorSourceProfile !== 'guided-custom-vrm') return
    if (!advancedPackageUpdateFile) {
      toast.error('Select a Goon File Package first.')
      return
    }
    advancedPackageUpdateBusy = true
    try {
      editorPendingAdvancedPackageUpdate = await uploadAdvancedGoonPackage(
        editorGoonId,
        advancedPackageUpdateFile
      )
      toast.success('Package update ready. Save Goon to apply it.')
    } catch (error: any) {
      toast.error(error?.message || 'Package update failed')
    } finally {
      advancedPackageUpdateBusy = false
      advancedPackageUpdateFile = null
      if (advancedPackageUpdateInput) advancedPackageUpdateInput.value = ''
    }
  }

  function cancelPendingAdvancedPackageUpdate() {
    editorPendingAdvancedPackageUpdate = null
    editorFacialArtworkUploadBusy = false
    editorFacialArtworkCreditDraft = createDefaultFacialArtworkUploadCreditDraft()
    advancedPackageUpdateFile = null
    if (advancedPackageUpdateInput) advancedPackageUpdateInput.value = ''
    toast.success('Pending package update canceled')
  }

  function cancelPendingVrmUpdate() {
    editorPendingVrmFile = null
    editorPendingVrmUpdate = null
    updateVrmFile = null
    if (updateVrmInput) updateVrmInput.value = ''
    toast.success('Pending file update canceled')
  }

  async function handleDuplicateGoon(goon: GoonRecord) {
    duplicateGoonBusyId = goon.id
    try {
      const duplicated = await duplicateGoon(goon.id)
      openCueEditor(duplicated)
      toast.success('Goon duplicated')
    } catch (error: any) {
      toast.error(error?.message || 'Duplicate failed')
    } finally {
      duplicateGoonBusyId = null
    }
  }

  async function handleRestoreVrm() {
    if (!editorGoonId || !editorGoon) return
    try {
      if (editorGoon.files?.vrmPending) {
        await updateGoonRecord(editorGoonId, {
          files: {
            ...editorGoon.files,
            vrmPending: undefined
          },
          vrmUpdate: null
        })
        resetPreview()
        toast.success('Update discarded')
        return
      }

      if (!editorGoon.files?.vrmBackup) return

      const current = editorGoon.files?.vrm
      const backup = editorGoon.files?.vrmBackup
      await updateGoonRecord(editorGoonId, {
        files: {
          ...editorGoon.files,
          vrm: backup,
          vrmBackup: current
        },
        compatibility: {
          tier: 'pending',
          issues: ['Awaiting VRM analysis']
        },
        vrmUpdate: null
      })
      resetPreview()
      toast.success('Previous VRM restored')
    } catch (error: any) {
      toast.error(error?.message || 'Restore failed')
    }
  }

  async function clearVrmUpdateWarnings() {
    if (editorPendingVrmFile) {
      editorPendingVrmUpdate = null
      toast.success('Pending update warnings cleared')
      return
    }
    if (!editorGoonId) return
    try {
      await updateGoonRecord(editorGoonId, { vrmUpdate: null })
      toast.success('Update warnings cleared')
    } catch (error: any) {
      toast.error(error?.message || 'Failed to clear warnings')
    }
  }

  async function requestDeleteGoon(goon: GoonRecord) {
    goonPendingDelete = goon
    await tick()
    deleteConfirmOpen = true
  }

  function closeDeleteGoonDialog() {
    deleteConfirmOpen = false
    goonPendingDelete = null
  }

  async function handleDelete(goon: GoonRecord) {
    try {
      await deleteGoon(goon.id)
      toast.success('Goon deleted')
      if (editorGoonId === goon.id) {
        editorGoonId = null
      }
    } catch (error: any) {
      toast.error(error?.message || 'Delete failed')
    }
  }

  async function confirmDeleteGoon() {
    if (!goonPendingDelete) return
    const target = goonPendingDelete
    deleteConfirmOpen = false
    goonPendingDelete = null
    await handleDelete(target)
  }

  async function handleAnimationUpload() {
    if (!editorGoonId) return
    if (!animationUploadFile) {
      toast.error('Select a .glb, .gltf, or .vrma animation file first.')
      return
    }
    animationUploadBusy = true
    try {
      await uploadGoonAnimation(editorGoonId, animationUploadFile)
      animationUploadFile = null
      if (animationUploadInput) {
        animationUploadInput.value = ''
      }
      toast.success('Animation uploaded')
    } catch (error: any) {
      toast.error(error?.message || 'Animation upload failed')
    } finally {
      animationUploadBusy = false
    }
  }

  function handleAnimationSelection(event: Event) {
    const input = event.currentTarget as HTMLInputElement
    const file = input.files?.[0] || null
    animationUploadFile = file
    if (file) {
      void handleAnimationUpload()
    }
  }

  async function handleAnimationDelete(filename: string) {
    if (!editorGoonId) return
    try {
      await deleteGoonAnimation(editorGoonId, filename)
      toast.success('Animation removed')
    } catch (error: any) {
      toast.error(error?.message || 'Failed to remove animation')
    }
  }

  function resetLibrarySelection() {
    libraryUploadFiles = []
    libraryUploadTotal = 0
    libraryUploadDone = 0
    if (libraryUploadInput) {
      libraryUploadInput.value = ''
    }
  }

  async function handleLibraryUpload(files: File[] = libraryUploadFiles) {
    if (libraryUploadBusy) return
    if (!files || files.length === 0) {
      toast.error('Select VRMA, GLB, or FBX files first.')
      return
    }

    libraryUploadBusy = true
    libraryUploadTotal = files.length
    libraryUploadDone = 0

    const failedFiles: File[] = []
    const conflicts: MotionReplaceConflict[] = []
    let uploadedCount = 0
    try {
      for (const file of files) {
        try {
          await uploadGoonAnimationToLibrary(file)
          uploadedCount += 1
        } catch (error) {
          if (error instanceof GoonMotionVersionExistsError) {
            // A motion with this name already has this format. Collected and
            // confirmed once for the whole batch after the loop — never a
            // silent replacement, never one popup per file.
            conflicts.push({
              file,
              motionName: error.conflict.displayName || error.conflict.motionName,
              laneLabel: error.conflict.lane === 'glb' ? 'GLB' : 'VRMA'
            })
          } else {
            failedFiles.push(file)
          }
        } finally {
          libraryUploadDone += 1
        }
      }
    } finally {
      libraryUploadBusy = false
      libraryUploadTotal = 0
      libraryUploadDone = 0
    }

    if (failedFiles.length > 0) {
      libraryUploadFiles = failedFiles
      toast.error(
        `Uploaded ${uploadedCount}/${files.length}. Selection now contains the failed files.`
      )
    } else {
      resetLibrarySelection()
      if (uploadedCount > 0) {
        toast.success(
          `Uploaded ${uploadedCount} animation${uploadedCount === 1 ? '' : 's'} to the vault.`
        )
      }
    }

    if (conflicts.length > 0) {
      motionReplaceConflicts = conflicts
    }
  }

  type MotionReplaceConflict = {
    file: File
    motionName: string
    laneLabel: string
  }

  let motionReplaceConflicts = $state<MotionReplaceConflict[]>([])
  let motionReplaceBusy = $state(false)

  async function confirmMotionReplacements() {
    if (motionReplaceBusy || motionReplaceConflicts.length === 0) return
    const pending = [...motionReplaceConflicts]
    motionReplaceBusy = true
    try {
      let replaced = 0
      const failed: MotionReplaceConflict[] = []
      for (const conflict of pending) {
        try {
          await uploadGoonAnimationToLibrary(conflict.file, { replaceExisting: true })
          replaced += 1
        } catch {
          failed.push(conflict)
        }
      }
      if (replaced > 0) {
        toast.success(`Replaced ${replaced} motion version${replaced === 1 ? '' : 's'}.`)
      }
      if (failed.length > 0) {
        toast.error(`Failed to replace ${failed.length} motion version${failed.length === 1 ? '' : 's'}.`)
      }
      motionReplaceConflicts = []
    } finally {
      motionReplaceBusy = false
    }
  }

  function skipMotionReplacements() {
    if (motionReplaceBusy) return
    const skipped = motionReplaceConflicts.length
    motionReplaceConflicts = []
    toast.info(
      `Skipped ${skipped} duplicate upload${skipped === 1 ? '' : 's'}. Rename the file${skipped === 1 ? '' : 's'} first to keep both versions.`
    )
  }

  function handleLibrarySelection(event: Event) {
    const input = event.currentTarget as HTMLInputElement
    const files = Array.from(input.files ?? [])
    if (files.length === 0) return

    const accepted: File[] = []
    let skipped = 0
    let blockedFbx = 0

    for (const file of files) {
      if (isVrmaFile(file) || isGlbAnimationLibraryFile(file)) {
        accepted.push(file)
        continue
      }
      if (isFbxFile(file)) {
        if (fbxInstallStatus?.installed) {
          accepted.push(file)
        } else {
          blockedFbx += 1
        }
        continue
      }
      skipped += 1
    }

    if (blockedFbx > 0) {
      toast.error('Install the FBX converter in Settings → Admin to upload FBX files.')
    }
    if (skipped > 0) {
      toast.info(`${skipped} unsupported file${skipped === 1 ? '' : 's'} skipped.`)
    }
    if (accepted.length === 0) {
      return
    }

    libraryUploadFiles = accepted
    void handleLibraryUpload(accepted)
  }

  // Whole-motion delete: removes every format version of the motion. The
  // per-version remove inside the card's info menu deletes a single file.
  async function handleMotionEntryDelete(entry: UnifiedGoonMotionEntry) {
    const filenames = entry.files.map((file) => file.filename).filter(Boolean)
    if (filenames.length === 0) return
    try {
      await deleteGoonAnimationFromLibrary(filenames)
      toast.success(
        filenames.length > 1 ? `Motion removed (${filenames.length} files)` : 'Motion removed'
      )
    } catch (error: any) {
      toast.error(error?.message || 'Failed to remove motion')
    }
  }

  async function handleMotionVersionDelete(entry: UnifiedGoonMotionEntry, file: GoonFileRef) {
    if (!file.filename) return
    try {
      await deleteGoonAnimationFromLibrary(file.filename)
      toast.success(
        `${getMotionLaneBadge(resolveGoonMotionLane(file)).label} version removed`
      )
    } catch (error: any) {
      toast.error(error?.message || 'Failed to remove animation file')
    }
  }

  function applyKitchenStateFromSettings(nextSettings: GoonsSettings) {
    const resolvedKitchen = resolveKitchenCues(nextSettings)
    const eyeContactSettings = normalizeGoonGlobalEyeContactSettingsMap(
      nextSettings.kitchen?.eyeContact
    )
    kitchenCueMap = cloneCueMap(resolvedKitchen.cueMap)
    kitchenEmojiMap = cloneEmojiMap(resolvedKitchen.emojiMap)
    kitchenEmoteEmojiDrafts = buildEmoteEmojiDrafts(kitchenCueMap, kitchenEmojiMap)
    kitchenEyeContactVroidMode = eyeContactSettings.vroid.mode
    kitchenEyeContactBlenderMode = eyeContactSettings.blender.mode
    kitchenEyeContactVroidTuning = eyeContactSettings.vroid.tuning
    kitchenEyeContactBlenderTuning = eyeContactSettings.blender.tuning
    kitchenDirty = false
  }

  function applyClosetStateFromSettings(nextSettings: GoonsSettings) {
    globalCloset = sanitizeGlobalClosetLibrary(cloneClosetLibrary(nextSettings.globalCloset))
    closetDirty = false
  }

  function applySceneStateFromSettings(nextSettings: GoonsSettings) {
    kitchenRoomTextures = cloneRoomTextureLibrary(nextSettings.kitchen?.roomTextures)
    kitchenScenes = cloneSceneMap(nextSettings.kitchen?.scenes)
    sceneDirty = false
  }

  async function persistGoonsSettings(nextSettings: GoonsSettings) {
    const persistedSettings = await persistGoonsSettingsRequest(fetch, nextSettings)
    const currentUserSettings = getUserSettings()
    if (currentUserSettings) {
      setUserSettings({ ...currentUserSettings, goons_settings: persistedSettings })
    }
    return persistedSettings
  }

  // The GLB preview body choice is a preference, not staged library data —
  // persist it immediately instead of routing it through Save Motions.
  async function persistGlbPreviewGoonSelection(goonId: string) {
    const trimmed = goonId.trim()
    if ((goonsSettings?.motions?.glbPreviewGoonId ?? '') === trimmed) return
    try {
      await persistGoonsSettings({
        ...(goonsSettings ?? {}),
        motions: trimmed ? { glbPreviewGoonId: trimmed } : {}
      })
    } catch (error: any) {
      toast.error(error?.message || 'Failed to save the GLB preview body choice')
    }
  }

  function togglePackSelection(key: string, selected: boolean) {
    exportPackSelections = {
      ...exportPackSelections,
      [key]: selected
    }
  }

  function openLibraryExportDialog() {
    exportPackSelections = {}
    exportPackDialogOpen = true
  }

  function sanitizePackPathSegment(value: string) {
    return (
      value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-+|-+$/g, '') || 'asset'
    )
  }

  function sanitizePackFilenameStem(value: string) {
    return (
      value
        .trim()
        .replace(/[^a-zA-Z0-9._-]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-+|-+$/g, '') || 'asset'
    )
  }

  function resolveFileStemFromCandidate(value?: string | null) {
    if (!value) return ''
    const cleaned = value.split('?')[0]?.split('#')[0] ?? value
    const basename = cleaned.split(/[\\/]/).filter(Boolean).pop() ?? cleaned
    const dot = basename.lastIndexOf('.')
    return dot > 0 ? basename.slice(0, dot) : basename
  }

  function resolvePackFileExtension(
    fileRef: GoonFileRef,
    assetPath?: string | null,
    fallback = ''
  ) {
    const candidates = [fileRef.filename, fileRef.url, assetPath, fileRef.originalName]
    for (const candidate of candidates) {
      if (!candidate) continue
      const cleaned = candidate.split('?')[0]?.split('#')[0] ?? candidate
      const dot = cleaned.lastIndexOf('.')
      if (dot !== -1) {
        return cleaned.slice(dot).toLowerCase()
      }
    }
    return fallback
  }

  function isPackAssetUrl(url?: string | null) {
    return typeof url === 'string' && url.startsWith('pack://')
  }

  function packAssetPathFromUrl(url?: string | null) {
    return isPackAssetUrl(url) ? url!.slice('pack://'.length) : null
  }

  function isBuiltInPackFileRef(fileRef?: GoonFileRef | null) {
    const url = fileRef?.url ?? ''
    return url.startsWith('/goons/')
  }

  function cloneGoonFileRef(fileRef: GoonFileRef) {
    return JSON.parse(JSON.stringify(fileRef)) as GoonFileRef
  }

  function buildUniquePackAssetPath(
    folder: string,
    label: string,
    extension: string,
    usedPaths: Set<string>
  ) {
    const base = sanitizePackPathSegment(label)
    let candidate = `assets/${folder}/${base}${extension}`
    let index = 2
    while (usedPaths.has(candidate)) {
      candidate = `assets/${folder}/${base}-${index}${extension}`
      index += 1
    }
    usedPaths.add(candidate)
    return candidate
  }

  function buildUniquePackAssetFilenamePath(
    folder: string,
    filenameStem: string,
    extension: string,
    usedPaths: Set<string>
  ) {
    const base = sanitizePackFilenameStem(filenameStem)
    let candidate = `assets/${folder}/${base}${extension}`
    let index = 2
    while (usedPaths.has(candidate)) {
      candidate = `assets/${folder}/${base}-${index}${extension}`
      index += 1
    }
    usedPaths.add(candidate)
    return candidate
  }

  function serializePackFileRef(
    fileRef: GoonFileRef,
    folder: string,
    label: string,
    usedPaths: Set<string>,
    assetsToFetch: Array<{ path: string; fileRef: GoonFileRef }>
  ) {
    const cloned = cloneGoonFileRef(fileRef)
    delete cloned.previewVideo
    if (isBuiltInPackFileRef(cloned)) {
      return cloned
    }
    const extension = resolvePackFileExtension(cloned)
    const assetPath = buildUniquePackAssetPath(folder, label, extension, usedPaths)
    assetsToFetch.push({ path: assetPath, fileRef: cloneGoonFileRef(cloned) })
    cloned.url = `pack://${assetPath}`
    return cloned
  }

  function serializeMotionFileRefForPack(
    fileRef: GoonFileRef,
    fallbackLabel: string,
    usedPaths: Set<string>,
    assetsToFetch: Array<{ path: string; fileRef: GoonFileRef }>,
    motionAssetCache: Map<string, GoonFileRef>
  ) {
    const cloned = cloneGoonFileRef(fileRef)
    if (isBuiltInPackFileRef(cloned)) {
      return cloned
    }
    const cacheKey = cloned.url || cloned.filename
    const cached = cacheKey ? motionAssetCache.get(cacheKey) : null
    if (cached) return cloneGoonFileRef(cached)
    const extension = resolvePackFileExtension(cloned)
    const filenameStem =
      resolveFileStemFromCandidate(cloned.originalName) ||
      resolveFileStemFromCandidate(cloned.filename) ||
      resolveFileStemFromCandidate(cloned.url) ||
      fallbackLabel
    const assetPath = buildUniquePackAssetFilenamePath('motions', filenameStem, extension, usedPaths)
    assetsToFetch.push({ path: assetPath, fileRef: cloneGoonFileRef(cloned) })
    cloned.url = `pack://${assetPath}`
    if (cacheKey) motionAssetCache.set(cacheKey, cloneGoonFileRef(cloned))
    return cloned
  }

  // A cue export carries its own motion file; this adds that motion's OTHER
  // format versions to the pack's standalone motions so the cue resolves by
  // name on both lanes after import. Motions already selected for export are
  // skipped (they are serialized separately).
  function collectCuePairedMotionRefs(
    cueOptions: Array<{ motionFile: GoonFileRef | null }>,
    selectedMotions: PackMotionExportOption[],
    usedPaths: Set<string>,
    assetsToFetch: Array<{ path: string; fileRef: GoonFileRef }>,
    motionAssetCache: Map<string, GoonFileRef>
  ) {
    const covered = new Set<string>()
    for (const option of selectedMotions) {
      for (const file of option.files) {
        const key = file.url || file.filename
        if (key) covered.add(key)
      }
    }

    const refs: GoonFileRef[] = []
    for (const cueOption of cueOptions) {
      const motionFile = cueOption.motionFile
      if (!motionFile) continue
      const entry = motionLibraryEntries.find(
        (candidate) => candidate.name === resolveAnimationName(motionFile)
      )
      if (!entry) continue
      const cueFileKey = motionFile.url || motionFile.filename
      for (const file of entry.files) {
        const key = file.url || file.filename
        if (!key || covered.has(key) || key === cueFileKey) continue
        covered.add(key)
        refs.push(
          serializeMotionFileRefForPack(
            file,
            resolveAnimationName(file),
            usedPaths,
            assetsToFetch,
            motionAssetCache
          )
        )
      }
    }
    return refs
  }

  function serializeSceneForPack(
    scene: GoonSceneDefinition,
    usedPaths: Set<string>,
    assetsToFetch: Array<{ path: string; fileRef: GoonFileRef }>
  ) {
    const next = JSON.parse(JSON.stringify(scene)) as GoonSceneDefinition
    const sceneFolder = `scenes/${sanitizePackPathSegment(scene.name || scene.id || 'scene')}`

    if (next.skybox) {
      next.skybox = serializePackFileRef(
        next.skybox,
        sceneFolder,
        `${scene.name}-skybox`,
        usedPaths,
        assetsToFetch
      )
    }
    if (next.roomShell) {
      next.roomShell = serializePackFileRef(
        next.roomShell,
        sceneFolder,
        `${scene.name}-room-shell`,
        usedPaths,
        assetsToFetch
      )
    }

    const serializeSurfaceSide = (
      side: GoonRoomSurfaceSide | undefined,
      zone: 'floor' | 'ceiling' | 'wall' | 'exterior',
      faceLabel: string
    ) => {
      if (!side) return
      if (side.texture) {
        side.texture = serializePackFileRef(
          side.texture,
          `${sceneFolder}/textures`,
          `${scene.name}-${faceLabel}-${zone}`,
          usedPaths,
          assetsToFetch
        )
      }
      if (side.trimTexture) {
        side.trimTexture = serializePackFileRef(
          side.trimTexture,
          `${sceneFolder}/textures`,
          `${scene.name}-${faceLabel}-${zone}-trim`,
          usedPaths,
          assetsToFetch
        )
      }
    }

    const serializeSurface = (
      surface: GoonRoomSurface | undefined,
      zone: 'floor' | 'ceiling' | 'wall' | 'exterior',
      faceLabel: string
    ) => {
      if (!surface) return
      serializeSurfaceSide(surface.interior, zone, `${faceLabel}-interior`)
      serializeSurfaceSide(surface.exterior, zone, `${faceLabel}-exterior`)
    }

    const surfaces = next.roomShellBuilder?.surfaces
    if (surfaces) {
      serializeSurface(surfaces.floor, 'floor', 'floor')
      serializeSurface(surfaces.ceiling, 'ceiling', 'ceiling')
      serializeSurface(surfaces.walls?.north, 'wall', 'north')
      serializeSurface(surfaces.walls?.south, 'wall', 'south')
      serializeSurface(surfaces.walls?.east, 'wall', 'east')
      serializeSurface(surfaces.walls?.west, 'wall', 'west')
    }

    const exteriorAprons = next.roomShellBuilder?.exteriorAprons
    if (exteriorAprons) {
      serializeSurfaceSide(exteriorAprons.north?.surface, 'exterior', 'north-apron')
      serializeSurfaceSide(exteriorAprons.south?.surface, 'exterior', 'south-apron')
      serializeSurfaceSide(exteriorAprons.east?.surface, 'exterior', 'east-apron')
      serializeSurfaceSide(exteriorAprons.west?.surface, 'exterior', 'west-apron')
    }

    serializeSurfaceSide(next.roomShellBuilder?.terrainSkirt?.surface, 'exterior', 'terrain-skirt')

    next.props = (next.props ?? []).map((prop, index) => ({
      ...prop,
      fileRef: serializePackFileRef(
        prop.fileRef,
        `${sceneFolder}/props`,
        `${index + 1}-${prop.name || 'prop'}`,
        usedPaths,
        assetsToFetch
      )
    }))

    return next
  }

  function serializeCueForPack(
    option: PackCueExportOption,
    usedPaths: Set<string>,
    assetsToFetch: Array<{ path: string; fileRef: GoonFileRef }>,
    motionAssetCache: Map<string, GoonFileRef>
  ): PortablePackCueEntry {
    const motion = option.motionFile
      ? serializeMotionFileRefForPack(
          option.motionFile,
          option.cue.animationName || option.cue.name,
          usedPaths,
          assetsToFetch,
          motionAssetCache
        )
      : null
    const cue = prepareCueForPortablePack(option.cue)
    // Raw physical morph names belong to one package. Cross-Goon packs carry
    // only the portable semantic profile and canonical ARKit-52 channels.
    if (
      cue.posture &&
      !isBuiltInPosture(cue.posture) &&
      !stagePostureMap[cue.posture] &&
      option.motionFile?.motionMeta?.posture
    ) {
      cue.posture = option.motionFile.motionMeta.posture
    }

    return {
      cue,
      emojis: [...option.emojis],
      scope: option.scope,
      sourceGoonId: option.sourceGoonId,
      sourceGoonName: option.sourceGoonName,
      motion
    }
  }

  async function fetchPackAssetBytes(fileRef: GoonFileRef) {
    const response = await fetch(fileRef.url)
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new Error(text || `Failed to fetch asset: ${fileRef.originalName || fileRef.filename}`)
    }
    return new Uint8Array(await response.arrayBuffer())
  }

  async function exportSelectedLibraryBundle() {
    const selectedMoods = globalPackMoodOptions.filter((option) => exportPackSelections[option.key])
    const selectedEmotes = globalPackEmoteOptions.filter((option) => exportPackSelections[option.key])
    const selectedLocalMoods = goonPackCueGroups.flatMap((group) =>
      group.moods.filter((option) => exportPackSelections[option.key])
    )
    const selectedLocalEmotes = goonPackCueGroups.flatMap((group) =>
      group.emotes.filter((option) => exportPackSelections[option.key])
    )
    const selectedScenes = packSceneOptions.filter((option) => exportPackSelections[option.key])
    const selectedMotions = globalPackMotionOptions.filter((option) => exportPackSelections[option.key])

    if (
      selectedMoods.length +
        selectedEmotes.length +
        selectedLocalMoods.length +
        selectedLocalEmotes.length +
        selectedScenes.length +
        selectedMotions.length ===
      0
    ) {
      toast.error('Select at least one mood, emote, scene, or motion to export.')
      return
    }

    exportPackBusy = true
    try {
      const usedPaths = new Set<string>()
      const assetsToFetch: Array<{ path: string; fileRef: GoonFileRef }> = []
      const motionAssetCache = new Map<string, GoonFileRef>()
      const selectedCueOptions = [
        ...selectedMoods,
        ...selectedEmotes,
        ...selectedLocalMoods,
        ...selectedLocalEmotes
      ]
      const referencedPostureIds = new Set<GoonPosture>()
      const addReferencedPosture = (posture?: GoonPosture | null) => {
        if (!posture || isBuiltInPosture(posture) || !stagePostureMap[posture]) return
        referencedPostureIds.add(posture)
      }
      for (const option of selectedCueOptions) {
        addReferencedPosture(option.cue.posture)
        addReferencedPosture(option.motionFile?.motionMeta?.posture)
      }
      for (const option of selectedMotions) {
        for (const file of option.files) {
          addReferencedPosture(file.motionMeta?.posture)
        }
      }
      for (const option of selectedScenes) {
        for (const postureId of Object.keys(option.scene.markers ?? {})) {
          addReferencedPosture(postureId as GoonPosture)
        }
      }
      const manifest: PortablePackManifest = {
        version: 6,
        exportedAt: new Date().toISOString(),
        name: 'Batshit Goon Pack',
        postures: Array.from(referencedPostureIds).map(
          (postureId) => JSON.parse(JSON.stringify(stagePostureMap[postureId])) as GoonPostureDefinition
        ),
        // Dual-format: every version of a selected motion ships in the pack,
        // and cue-referenced motions bring their paired versions along so the
        // cue resolves on both lanes after import.
        motions: [
          ...selectedMotions.flatMap((option) =>
            option.files.map((file) =>
              serializeMotionFileRefForPack(
                file,
                option.label || resolveAnimationName(file),
                usedPaths,
                assetsToFetch,
                motionAssetCache
              )
            )
          ),
          ...collectCuePairedMotionRefs(selectedCueOptions, selectedMotions, usedPaths, assetsToFetch, motionAssetCache)
        ],
        moods: [...selectedMoods, ...selectedLocalMoods].map((option) =>
          serializeCueForPack(option, usedPaths, assetsToFetch, motionAssetCache)
        ),
        emotes: [...selectedEmotes, ...selectedLocalEmotes].map((option) =>
          serializeCueForPack(option, usedPaths, assetsToFetch, motionAssetCache)
        ),
        scenes: selectedScenes.map((option) =>
          serializeSceneForPack(option.scene, usedPaths, assetsToFetch)
        )
      }

      const zipEntries: Record<string, Uint8Array> = {
        'manifest.json': strToU8(JSON.stringify(manifest, null, 2))
      }
      for (const asset of assetsToFetch) {
        zipEntries[asset.path] = await fetchPackAssetBytes(asset.fileRef)
      }

      const filename = `batshit-goon-pack-${new Date().toISOString().slice(0, 10)}.zip`
      const blob = bytesToBlob(zipSync(zipEntries), { type: 'application/zip' })
      const result = await downloadBlob(blob, filename, {
        title: 'Export Batshit Goon Pack',
        mimeType: 'application/zip'
      })
      if (result.canceled) return

      exportPackDialogOpen = false
      toast.success('Selected pack exported')
    } catch (error: any) {
      toast.error(error?.message || 'Failed to export selected pack')
    } finally {
      exportPackBusy = false
    }
  }

  function isPortablePackManifest(value: unknown): value is PortablePackManifest {
    if (!value || typeof value !== 'object') return false
    const record = value as Record<string, unknown>
    return (
      record.version === 6 &&
      (record.postures === undefined || Array.isArray(record.postures)) &&
      (record.motions === undefined || Array.isArray(record.motions)) &&
      Array.isArray(record.moods) &&
      Array.isArray(record.emotes) &&
      Array.isArray(record.scenes)
    )
  }

  async function handleLibraryImportSelection(event: Event) {
    const input = event.currentTarget as HTMLInputElement
    const file = input.files?.[0] ?? null
    if (!file) return
    libraryImportBusy = true

    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      const unzipped = unzipSync(bytes)
      const entries: Record<string, Uint8Array> = {}
      for (const [name, assetBytes] of Object.entries(unzipped)) {
        entries[name.replace(/\\/g, '/')] = assetBytes
      }

      const manifestBytes = entries['manifest.json']
      if (!manifestBytes) {
        throw new Error('That zip is missing manifest.json.')
      }

      const parsed = JSON.parse(strFromU8(manifestBytes))
      if (!isPortablePackManifest(parsed)) {
        const parsedVersion =
          parsed && typeof parsed === 'object'
            ? (parsed as Record<string, unknown>).version
            : undefined
        if (parsedVersion !== undefined && parsedVersion !== 6) {
          throw new Error(
            `That Goon pack uses obsolete format v${String(parsedVersion)}. Export it again from the current Batshit Goon Kitchen.`
          )
        }
        throw new Error('That file is not a valid Batshit Goon pack zip.')
      }

      pendingImportPack = {
        manifest: {
          ...parsed,
          postures: Array.isArray(parsed.postures) ? parsed.postures : [],
          motions: Array.isArray(parsed.motions) ? parsed.motions : []
        },
        entries,
        fileName: file.name
      }
      importPackPreviewOpen = true
    } catch (error: any) {
      toast.error(error?.message || 'Failed to read pack')
    } finally {
      libraryImportBusy = false
      if (libraryImportInput) libraryImportInput.value = ''
    }
  }

  function createPackAssetFile(fileRef: GoonFileRef, bytes: Uint8Array, assetPath: string) {
    const assetName = assetPath.split('/').pop() || 'asset'
    const extension = resolvePackFileExtension(fileRef, assetPath)
    const baseNameSource = assetName || fileRef.originalName || fileRef.filename || 'asset'
    const baseName = stripFileExtension(baseNameSource) || 'asset'
    const name = `${baseName}${extension}`
    const mimeType = fileRef.mimeType || 'application/octet-stream'
    return bytesToFile(bytes, name, { type: mimeType })
  }

  function remapImportedCuePosture(
    cue: GoonCueDefinition,
    postureIdMap: Record<string, GoonPosture>
  ) {
    if (!cue.posture) return cue
    const remapped = postureIdMap[cue.posture]
    if (!remapped) return cue
    return {
      ...cue,
      posture: remapped
    }
  }

  function remapImportedMotionRefPosture(
    fileRef: GoonFileRef,
    postureIdMap: Record<string, GoonPosture>
  ) {
    const posture = fileRef.motionMeta?.posture
    if (!posture || !postureIdMap[posture]) return fileRef
    return {
      ...fileRef,
      motionMeta: {
        ...(fileRef.motionMeta ?? {}),
        posture: postureIdMap[posture]
      }
    }
  }

  function remapImportedScenePostures(
    scene: GoonSceneDefinition,
    postureIdMap: Record<string, GoonPosture>
  ) {
    const nextScene = JSON.parse(JSON.stringify(scene)) as GoonSceneDefinition
    if (!nextScene.markers) return nextScene

    const remappedMarkers: GoonSceneMarkers = {}
    for (const [postureId, markers] of Object.entries(nextScene.markers)) {
      const nextPostureId = postureIdMap[postureId] ?? postureId
      remappedMarkers[nextPostureId] = [
        ...(remappedMarkers[nextPostureId] ?? []),
        ...(markers ?? [])
      ]
    }
    nextScene.markers = remappedMarkers
    return nextScene
  }

  async function restorePackMotionFile(
    fileRef: GoonFileRef,
    entries: Record<string, Uint8Array>,
    cache: Map<string, GoonFileRef>
  ) {
    const assetPath = packAssetPathFromUrl(fileRef.url)
    if (!assetPath) return cloneGoonFileRef(fileRef)
    const cached = cache.get(assetPath)
    if (cached) return cached
    const bytes = entries[assetPath]
    if (!bytes) {
      throw new Error(`Pack is missing motion asset: ${assetPath}`)
    }

    const file = createPackAssetFile(fileRef, bytes, assetPath)
    // Pack imports intentionally replace same-name-same-format versions in
    // place — importing a pack is an explicit action, and this keeps
    // re-importing the same pack idempotent instead of duplicating motions.
    const uploaded = await uploadGoonAnimationToLibraryFile(file, { replaceExisting: true })
    if ((fileRef.tags && fileRef.tags.length > 0) || fileRef.motionMeta || fileRef.displayName) {
      await updateGoonAnimationLibraryMetadata(uploaded.animation.filename, {
        displayName: fileRef.displayName,
        tags: fileRef.tags,
        motionMeta: fileRef.motionMeta
      })
    }
    const restored: GoonFileRef = {
      ...uploaded.animation,
      displayName: fileRef.displayName ?? uploaded.animation.displayName,
      tags: fileRef.tags,
      motionMeta: fileRef.motionMeta ?? uploaded.animation.motionMeta
    }
    cache.set(assetPath, restored)
    return restored
  }

  async function restoreSceneAssetFile(
    fileRef: GoonFileRef,
    restoreKind: 'scene_skybox' | 'room_shell' | 'scene_prop' | 'room_texture',
    entries: Record<string, Uint8Array>,
    cache: Map<string, GoonFileRef>,
    roomTextureKind?: GoonRoomTextureKind
  ) {
    const assetPath = packAssetPathFromUrl(fileRef.url)
    if (!assetPath) return cloneGoonFileRef(fileRef)
    const cached = cache.get(assetPath)
    if (cached) return cached
    const bytes = entries[assetPath]
    if (!bytes) {
      throw new Error(`Pack is missing scene asset: ${assetPath}`)
    }

    const file = createPackAssetFile(fileRef, bytes, assetPath)
    let restored: GoonFileRef
    if (restoreKind === 'scene_skybox') {
      restored = await uploadGoonSceneSkybox(file)
    } else if (restoreKind === 'room_shell') {
      restored = await uploadGoonRoomShell(file)
    } else if (restoreKind === 'scene_prop') {
      restored = await uploadGoonSceneProp(file)
    } else {
      restored = await uploadGoonRoomTexture(file, roomTextureKind ?? 'wall')
    }
    cache.set(assetPath, restored)
    return restored
  }

  async function restoreSceneFromPack(
    scene: GoonSceneDefinition,
    entries: Record<string, Uint8Array>,
    cache: Map<string, GoonFileRef>
  ) {
    const next = JSON.parse(JSON.stringify(scene)) as GoonSceneDefinition
    if (next.skybox) {
      next.skybox = await restoreSceneAssetFile(next.skybox, 'scene_skybox', entries, cache)
    }
    if (next.roomShell) {
      next.roomShell = await restoreSceneAssetFile(next.roomShell, 'room_shell', entries, cache)
    }

    const restoreSurfaceSide = async (
      side: GoonRoomSurfaceSide | undefined,
      zone: 'floor' | 'ceiling' | 'wall' | 'exterior'
    ) => {
      if (!side) return
      if (side.texture) {
        const kind: GoonRoomTextureKind =
          zone === 'floor'
            ? 'floor'
            : zone === 'ceiling'
              ? 'ceiling'
              : zone === 'exterior'
                ? 'exterior'
                : 'wall'
        side.texture = await restoreSceneAssetFile(
          side.texture,
          'room_texture',
          entries,
          cache,
          kind
        )
      }
      if (side.trimTexture) {
        side.trimTexture = await restoreSceneAssetFile(
          side.trimTexture,
          'room_texture',
          entries,
          cache,
          'trim'
        )
      }
    }

    const surfaces = next.roomShellBuilder?.surfaces
    if (surfaces) {
      await restoreSurfaceSide(surfaces.floor?.interior, 'floor')
      await restoreSurfaceSide(surfaces.floor?.exterior, 'floor')
      await restoreSurfaceSide(surfaces.ceiling?.interior, 'ceiling')
      await restoreSurfaceSide(surfaces.ceiling?.exterior, 'ceiling')
      await restoreSurfaceSide(surfaces.walls?.north?.interior, 'wall')
      await restoreSurfaceSide(surfaces.walls?.north?.exterior, 'wall')
      await restoreSurfaceSide(surfaces.walls?.south?.interior, 'wall')
      await restoreSurfaceSide(surfaces.walls?.south?.exterior, 'wall')
      await restoreSurfaceSide(surfaces.walls?.east?.interior, 'wall')
      await restoreSurfaceSide(surfaces.walls?.east?.exterior, 'wall')
      await restoreSurfaceSide(surfaces.walls?.west?.interior, 'wall')
      await restoreSurfaceSide(surfaces.walls?.west?.exterior, 'wall')
    }

    const exteriorAprons = next.roomShellBuilder?.exteriorAprons
    if (exteriorAprons) {
      await restoreSurfaceSide(exteriorAprons.north?.surface, 'exterior')
      await restoreSurfaceSide(exteriorAprons.south?.surface, 'exterior')
      await restoreSurfaceSide(exteriorAprons.east?.surface, 'exterior')
      await restoreSurfaceSide(exteriorAprons.west?.surface, 'exterior')
    }

    await restoreSurfaceSide(next.roomShellBuilder?.terrainSkirt?.surface, 'exterior')

    next.props = await Promise.all(
      (next.props ?? []).map(async (prop) => ({
        ...prop,
        fileRef: await restoreSceneAssetFile(prop.fileRef, 'scene_prop', entries, cache)
      }))
    )

    return next
  }

  async function confirmLibraryImport() {
    if (!pendingImportPack) return
    const currentPack = pendingImportPack
    libraryImportBusy = true

    try {
      const importedPostures = mergeImportedCustomPostures(
        goonsSettings,
        currentPack.manifest.postures ?? []
      )
      const motionCache = new Map<string, GoonFileRef>()
      const sceneAssetCache = new Map<string, GoonFileRef>()
      const emojiMap: GoonEmojiMap = {}
      const moods: GoonCueDefinition[] = []
      const emotes: GoonCueDefinition[] = []

      for (const motion of currentPack.manifest.motions ?? []) {
        await restorePackMotionFile(
          remapImportedMotionRefPosture(motion, importedPostures.idMap),
          currentPack.entries,
          motionCache
        )
      }

      for (const entry of currentPack.manifest.moods) {
        const cue = remapImportedCuePosture(
          JSON.parse(JSON.stringify(entry.cue)) as GoonCueDefinition,
          importedPostures.idMap
        )
        if (entry.motion) {
          const restoredMotion = await restorePackMotionFile(
            remapImportedMotionRefPosture(entry.motion, importedPostures.idMap),
            currentPack.entries,
            motionCache
          )
          cue.animationName = resolveAnimationName(restoredMotion)
        }
        moods.push(cue)
        for (const emoji of entry.emojis ?? []) {
          emojiMap[emoji] = cue.name
        }
      }

      for (const entry of currentPack.manifest.emotes) {
        const cue = remapImportedCuePosture(
          JSON.parse(JSON.stringify(entry.cue)) as GoonCueDefinition,
          importedPostures.idMap
        )
        if (entry.motion) {
          await restorePackMotionFile(
            remapImportedMotionRefPosture(entry.motion, importedPostures.idMap),
            currentPack.entries,
            motionCache
          )
        }
        emotes.push(cue)
        for (const emoji of entry.emojis ?? []) {
          emojiMap[emoji] = cue.name
        }
      }

      const scenes = await Promise.all(
        currentPack.manifest.scenes.map((scene) =>
          restoreSceneFromPack(
            remapImportedScenePostures(scene, importedPostures.idMap),
            currentPack.entries,
            sceneAssetCache
          )
        )
      )

      const imported = importGoonLibraryExportBundle(goonsSettings, {
        version: 1,
        exportedAt: currentPack.manifest.exportedAt,
        moods,
        emotes,
        emojiMap,
        scenes
      })
      imported.settings = {
        ...imported.settings,
        kitchen: {
          ...imported.settings.kitchen,
          postures: importedPostures.postures
        }
      }
      const persistedSettings = await persistGoonsSettings(imported.settings)
      applyKitchenStateFromSettings(persistedSettings)
      applyClosetStateFromSettings(persistedSettings)
      applySceneStateFromSettings(persistedSettings)
      const renamedMotions = Object.keys(imported.renamedCueNames).length
      const renamedScenes = Object.keys(imported.renamedSceneNames).length
      const renamedPostures = (currentPack.manifest.postures ?? []).filter((posture) => {
        const sourceId = posture.id?.trim()
        return Boolean(sourceId && importedPostures.idMap[sourceId] && importedPostures.idMap[sourceId] !== sourceId)
      }).length
      const importedMotionCount = currentPack.manifest.motions?.length ?? 0
      const conflictSuffix =
        imported.emojiConflicts.length > 0
          ? ` Emoji conflicts skipped: ${imported.emojiConflicts.join(', ')}.`
          : ''
      importPackPreviewOpen = false
      pendingImportPack = null
      toast.success(
        `Pack imported.${importedMotionCount > 0 ? ` Imported ${importedMotionCount} standalone motion(s).` : ''}${renamedMotions || renamedScenes || renamedPostures ? ` Renamed ${renamedMotions} cue(s), ${renamedScenes} scene(s), and ${renamedPostures} posture(s).` : ''}${conflictSuffix}`
      )
    } catch (error: any) {
      toast.error(error?.message || 'Failed to import pack')
    } finally {
      libraryImportBusy = false
    }
  }

  async function loadFbxInstallStatus() {
    if (fbxInstallBusy) return
    fbxInstallBusy = true
    try {
      const res = await fetch('/api/goons/animations/converter')
      if (!res.ok) return
      const data = await res.json()
      fbxInstallStatus = data
    } catch (error) {
      console.error('[GoonsSettings] Failed to load FBX converter status:', error)
    } finally {
      fbxInstallBusy = false
    }
  }

  async function handleStarterGoonImport(entry: (typeof STARTER_GOON_ASSETS)[number]) {
    if (starterImportBusy[entry.id]) return
    starterImportBusy = { ...starterImportBusy, [entry.id]: true }
    try {
      await createGoon({
        starterAssetId: entry.id,
        name: entry.name,
        description: entry.description
      })
      toast.success(`${entry.name} added`)
    } catch (error: any) {
      toast.error(error?.message || 'Failed to import starter Goon')
    } finally {
      starterImportBusy = { ...starterImportBusy, [entry.id]: false }
    }
  }

  async function resetEditorRetiredHair() {
    if (
      retiredHairRecoveryBusy ||
      !editorGoon ||
      editorGoon.recipe?.contract !== 'goon-recipe/v2' ||
      !editorRetiredHairSibling
    ) {
      return
    }
    retiredHairRecoveryBusy = true
    try {
      const recovered = await resetRetiredGoonHair(
        editorGoon.id,
        editorGoon.recipe.writeVersion
      )
      closeEditorHairImport()
      openCueEditor(recovered)
      editorHairOpen = true
      toast.success('Retired Hair reset. The rest of the Goon was preserved.')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to reset retired Hair')
    } finally {
      retiredHairRecoveryBusy = false
    }
  }

  function openCueEditor(goon: GoonRecord) {
    activeTab = 'goons'
    if (editorGoonId !== goon.id) {
      pendingEditorOpeningFrameGoonId = goon.id
    }
    editorGoonId = goon.id
    recipeWorkflowBusy = false
    editorName = goon.name ?? ''
    editorDescription = goon.description ?? ''
    const resolved = resolveGoonCues(goon, goonsSettings)
    const nextCueMap = normalizeGoonCueMap({
      ...cloneCueMap(kitchenCueMap),
      ...cloneCueMap(goon.cues?.overrides ?? goon.cues?.cueMap ?? {})
    })
    const nextEmojiMap = filterEmojiMapForEmotes(
      {
        ...cloneEmojiMap(kitchenEmojiMap),
        ...cloneEmojiMap(goon.cues?.emojiOverrides ?? goon.cues?.emojiMap ?? {})
      },
      nextCueMap
    )
    editorCueMap = nextCueMap
    editorEnabledCueNames = resolved.enabled.filter((name) => Boolean(nextCueMap[name]))
    editorEmojiMap = nextEmojiMap
    editorEmoteEmojiDrafts = buildEmoteEmojiDrafts(nextCueMap, nextEmojiMap)
    editorBaseLoop = goon.defaults?.baseLoop ?? 'base_stand'
    editorSceneId = goon.defaults?.sceneId ?? ''
    editorQuality = goon.defaults?.quality ?? 'auto'
    editorLipSync = goon.defaults?.lipSync ?? true
    const eyeContactSettings = buildSettingsWithDraftKitchenEyeContact()
    editorEyeContactMode = resolveGoonEyeContactMode(goon, eyeContactSettings)
    applyEditorEyeContactTuning(resolveGoonEyeContactTuning(goon, eyeContactSettings))
    editorSocketEyeContact = resolveSocketEyeContactSettings(goon.defaults?.socketEyeContact)
    editorHasSocketEyeContact = false
    editorCamera = { ...(goon.camera ?? {}) }
    previewCameraMode = editorCamera.mode ?? 'free'
    previewViewFov = typeof editorCamera.fov === 'number'
      ? clampPreviewFov(editorCamera.fov)
      : DEFAULT_PREVIEW_VIEW_FOV
    editorPendingVrmFile = null
    editorPendingVrmUpdate = null
    editorPendingAdvancedPackageUpdate = null
    recipeEditorPreviewTarget = null
    applyStoredHairDraft(goon)
    editorFacialArtworkUploadBusy = false
    editorFacialArtworkCreditDraft = createDefaultFacialArtworkUploadCreditDraft()
    advancedPackageUpdateFile = null
    editorGuidedOutfitPiecesDraft = [...(goon.guidedAvatar?.outfitPieces ?? [])]
    editorGuidedDufOverlays = [...(goon.guidedAvatar?.dufOverlays ?? [])]
    editorGuidedPieceStates = { ...(goon.guidedAvatar?.pieceStates ?? {}) }
    editorGuidedActivePresetId = goon.guidedAvatar?.activePresetId ?? null
    editorDirty = false
    newEmoteEmoji = ''
    editorAddMoodOpen = false
    editorAddEmoteOpen = false
    editorDescriptionEditorOpen = false
    editorBasicSettingsOpen = false
    editorEyeContactOpen = false
    editorCustomGoonBuilderOpen = false
    editorHairOpen = false
    editorVrmSectionOpen = false
    editorAnimationsSectionOpen = false
    editorClosetOpen = false
    editorCustomClosetOpen = false
    editorWardrobeColorEditorKey = null
    editorDeleteGoonOpen = false
    moodsOpen = false
    emotesOpen = false
    disabledMoodsOpen = false
    disabledEmotesOpen = false
    editorCueNameDrafts = {}
    animationUploadFile = null
    openMoodName = null
    openEmoteName = null
    closetAssignments = sanitizeClosetAssignments(goon.closetAssignments ?? {})
    const customClosetDraft = buildCustomClosetDraft(goon)
    editorClosetItems = { ...customClosetDraft.items }
    const nextWardrobeOutfits = sanitizeWardrobeOutfits(goon.closet?.outfits ?? {}, {
      resolveItem: (itemId) => (itemId ? customClosetDraft.items[itemId] ?? null : null)
    })
    editorWardrobeOutfits = nextWardrobeOutfits
    editorActiveWardrobeOutfitId =
      goon.defaults?.closetOutfitId && nextWardrobeOutfits[goon.defaults.closetOutfitId]
        ? goon.defaults.closetOutfitId
        : null
    newWardrobeOutfitName = ''
    editorWardrobeOutfitCreateOpen = false
  }

  function getFirstEnabledMoodName(
    enabledNames: string[] = editorEnabledCueNames,
    cueMap: GoonCueMap = editorCueMap
  ) {
    for (const name of enabledNames) {
      const cue = cueMap[name]
      if (cue?.kind === 'mood') return cue.name
    }
    return ''
  }

  function isEditorCueShared(name: string) {
    return activeTab !== 'kitchen' && Boolean(kitchenCueMap[name])
  }

  function isEditorCueChanged(name: string) {
    if (!isEditorCueShared(name)) return false
    const cue = editorCueMap[name]
    const base = kitchenCueMap[name]
    return Boolean(cue && base && JSON.stringify(cue) !== JSON.stringify(base))
  }

  function getEditorCueStatus(name: string): 'shared' | 'changed' | 'custom' {
    if (isEditorCueChanged(name)) return 'changed'
    if (isEditorCueShared(name)) return 'shared'
    return 'custom'
  }

  function getEditorCueStatusLabel(name: string) {
    const status = getEditorCueStatus(name)
    if (status === 'changed') return 'Changed'
    if (status === 'shared') return 'via Global'
    return 'Custom'
  }

  function setEditorCueEnabled(name: string, enabled: boolean) {
    if (activeTab === 'kitchen') return
    const exists = Boolean(editorCueMap[name])
    if (!exists) return

    if (enabled) {
      if (editorEnabledCueNames.includes(name)) return
      editorEnabledCueNames = [...editorEnabledCueNames, name]
      editorDirty = true
      return
    }

    if (!editorEnabledCueNames.includes(name)) return
    const nextEnabled = editorEnabledCueNames.filter((entry) => entry !== name)
    editorEnabledCueNames = nextEnabled
    if (editorBaseLoop === name) {
      editorBaseLoop = getFirstEnabledMoodName(nextEnabled)
    }
    if (openMoodName === name) openMoodName = null
    if (openEmoteName === name) openEmoteName = null
    editorDirty = true
  }

  function resetEditorCueToShared(name: string) {
    if (activeTab === 'kitchen') return
    const base = kitchenCueMap[name]
    if (!base) return

    const nextCueMap = {
      ...editorCueMap,
      [name]: cloneCueMap({ [name]: base })[name]
    }
    editorCueMap = nextCueMap

    const nextEmojiMap = { ...editorEmojiMap }
    for (const [emoji, cueName] of Object.entries(nextEmojiMap)) {
      if (cueName === name && kitchenEmojiMap[emoji] !== name) {
        delete nextEmojiMap[emoji]
      }
    }
    for (const [emoji, cueName] of Object.entries(kitchenEmojiMap)) {
      if (cueName === name) {
        nextEmojiMap[emoji] = name
      }
    }
    editorEmojiMap = filterEmojiMapForEmotes(nextEmojiMap, nextCueMap)
    const nextDrafts = { ...editorEmoteEmojiDrafts }
    const sharedEmoji = resolveEmoteEmojiFromMap(name, kitchenEmojiMap)
    if (sharedEmoji) {
      nextDrafts[name] = sharedEmoji
    } else {
      delete nextDrafts[name]
    }
    editorEmoteEmojiDrafts = nextDrafts
    editorDirty = true
  }

  function setActiveCueMap(next: GoonCueMap) {
    if (activeTab === 'kitchen') {
      kitchenCueMap = next
      kitchenDirty = true
      return
    }
    editorCueMap = next
    editorDirty = true
  }

  function setActiveEmojiMap(next: GoonEmojiMap) {
    if (activeTab === 'kitchen') {
      kitchenEmojiMap = next
      kitchenDirty = true
      return
    }
    editorEmojiMap = next
    editorDirty = true
  }

  function getActiveFacePreviewSelection() {
    return activeTab === 'kitchen' ? kitchenFacePreviewSelection : editorFacePreviewSelection
  }

  function setActiveFacePreviewSelection(next: FacePreviewSelection | null) {
    if (activeTab === 'kitchen') {
      kitchenFacePreviewSelection = next
      return
    }
    editorFacePreviewSelection = next
  }

  function renameActiveFacePreviewSelection(name: string, nextName: string) {
    const current = getActiveFacePreviewSelection()
    if (!current || current.cueName !== name) return
    setActiveFacePreviewSelection({
      ...current,
      cueName: nextName
    })
  }

  function clearActiveFacePreviewSelectionForCue(name: string) {
    const current = getActiveFacePreviewSelection()
    if (!current || current.cueName !== name) return
    setActiveFacePreviewSelection(null)
  }

  function cuePatchTouchesFacePreview(patch: Partial<GoonCueMap[string]>) {
    return (
      Object.prototype.hasOwnProperty.call(patch, 'faceProfiles') ||
      Object.prototype.hasOwnProperty.call(patch, 'expressionTargets') ||
      Object.prototype.hasOwnProperty.call(patch, 'faceControls') ||
      Object.prototype.hasOwnProperty.call(patch, 'rawMorphTargets')
    )
  }

  function updateCueField(name: string, patch: Partial<GoonCueMap[string]>) {
    const map = activeTab === 'kitchen' ? kitchenCueMap : editorCueMap
    const existing = map[name] || { name, kind: 'emote' }
    const currentPreviewSelection = getActiveFacePreviewSelection()
    if (
      cuePatchTouchesFacePreview(patch) &&
      (!currentPreviewSelection ||
        currentPreviewSelection.cueName !== name ||
        currentPreviewSelection.stepIndex === null)
    ) {
      setActiveFacePreviewSelection({ cueName: name, stepIndex: null })
    }
    const next = { ...existing, ...patch, name }
    if (next.kind === 'mood') {
      next.playback = 'loop'
    } else {
      next.playback = 'oneshot'
      delete next.posture
      delete next.intensity
    }
    setActiveCueMap({
      ...map,
      [name]: next
    })
  }

  function getActiveCueNameDrafts() {
    return activeTab === 'kitchen' ? kitchenCueNameDrafts : editorCueNameDrafts
  }

  function setActiveCueNameDrafts(next: Record<string, string>) {
    if (activeTab === 'kitchen') {
      kitchenCueNameDrafts = next
      return
    }
    editorCueNameDrafts = next
  }

  function getCueNameDraft(name: string) {
    const drafts = getActiveCueNameDrafts()
    return drafts[name] ?? name
  }

  function setCueNameDraft(name: string, value: string) {
    const drafts = getActiveCueNameDrafts()
    setActiveCueNameDrafts({
      ...drafts,
      [name]: value
    })
  }

  function clearCueNameDraft(name: string) {
    const drafts = getActiveCueNameDrafts()
    if (!(name in drafts)) return
    const next = { ...drafts }
    delete next[name]
    setActiveCueNameDrafts(next)
  }

  function cueKindLabel(kind: GoonCueKind) {
    return kind === 'mood' ? 'mood' : 'emote'
  }

  function showCueNameConflictToast(targetKind: GoonCueKind, conflictKind?: GoonCueKind) {
    const targetLabel = cueKindLabel(targetKind)
    if (conflictKind && conflictKind !== targetKind) {
      toast.error(`That ${targetLabel} name is already used by a ${cueKindLabel(conflictKind)}.`)
      return
    }
    toast.error(`That ${targetLabel} name already exists.`)
  }

  function renameCue(name: string, nextNameRaw: string) {
    const trimmed = nextNameRaw.trim()
    if (!trimmed) {
      toast.error('Cue name cannot be empty.')
      return false
    }
    if (trimmed === name) {
      clearCueNameDraft(name)
      return false
    }
    const map = activeTab === 'kitchen' ? kitchenCueMap : editorCueMap
    const existing = map[name]
    if (!existing) return false
    const conflict = map[trimmed]
    if (conflict) {
      showCueNameConflictToast(existing.kind, conflict.kind)
      return false
    }

    const next = { ...map }
    delete next[name]
    next[trimmed] = { ...existing, name: trimmed }
    setActiveCueMap(next)
    if (activeTab !== 'kitchen') {
      editorEnabledCueNames = editorEnabledCueNames.map((entry) => (entry === name ? trimmed : entry))
      editorDirty = true
    }

    const emojiMap = activeTab === 'kitchen' ? kitchenEmojiMap : editorEmojiMap
    const nextEmoji = { ...emojiMap }
    let emojiChanged = false
    for (const [emoji, cueName] of Object.entries(nextEmoji)) {
      if (cueName === name) {
        nextEmoji[emoji] = trimmed
        emojiChanged = true
      }
    }
    if (emojiChanged) {
      setActiveEmojiMap(nextEmoji)
    }
    const emojiDrafts = getActiveEmoteEmojiDrafts()
    if (name in emojiDrafts) {
      const nextEmojiDrafts = { ...emojiDrafts }
      nextEmojiDrafts[trimmed] = nextEmojiDrafts[name]
      delete nextEmojiDrafts[name]
      setActiveEmoteEmojiDrafts(nextEmojiDrafts)
    }

    if (existing.kind === 'mood' && activeTab !== 'kitchen' && editorBaseLoop === name) {
      editorBaseLoop = trimmed
    }
    if (existing.kind === 'mood' && openMoodName === name) {
      openMoodName = trimmed
    }
    if (existing.kind === 'emote' && openEmoteName === name) {
      openEmoteName = trimmed
    }
    renameActiveFacePreviewSelection(name, trimmed)
    if (previewAnimationRestore?.name === name) {
      previewAnimationRestore = { ...previewAnimationRestore, name: trimmed }
    }
    if (kitchenPreviewAnimationRestore?.name === name) {
      kitchenPreviewAnimationRestore = { ...kitchenPreviewAnimationRestore, name: trimmed }
    }

    const drafts = getActiveCueNameDrafts()
    const nextDrafts = { ...drafts }
    delete nextDrafts[name]
    nextDrafts[trimmed] = trimmed
    setActiveCueNameDrafts(nextDrafts)
    return true
  }

  function commitCueRename(name: string) {
    const draft = getCueNameDraft(name)
    const trimmed = draft.trim()
    if (!trimmed || trimmed === name) {
      clearCueNameDraft(name)
      return
    }
    renameCue(name, trimmed)
  }

  function getExpressionTargetWeight(
    targets: GoonExpressionTarget[] | undefined,
    preset: GoonExpressionPreset
  ): number {
    const target = targets?.find((entry) => entry.preset === preset)
    return typeof target?.weight === 'number' ? Math.max(0, Math.min(1, target.weight)) : 0
  }

  function setExpressionTargetWeight(
    targets: GoonExpressionTarget[] | undefined,
    preset: GoonExpressionPreset,
    value: number
  ): GoonExpressionTarget[] | undefined {
    const clampedValue = Math.max(0, Math.min(1, value))
    const preservedTargets = (targets ?? []).filter((entry) => entry.preset !== preset)
    if (clampedValue <= 0) {
      return preservedTargets.length > 0 ? preservedTargets : undefined
    }

    return [...preservedTargets, { preset, weight: clampedValue }]
  }

  function updateCueExpressionPreset(
    cueName: string,
    preset: GoonExpressionPreset,
    value: number
  ) {
    const map = activeTab === 'kitchen' ? kitchenCueMap : editorCueMap
    const cue = map[cueName] || { name: cueName, kind: 'emote' }
    const faceProfiles = resolveEditorFaceProfiles(cue)
    updateCueField(cueName, {
      faceProfiles: {
        ...faceProfiles,
        portable: {
          ...faceProfiles.portable,
          expressionTargets: setExpressionTargetWeight(
            faceProfiles.portable.expressionTargets,
            preset,
            value
          )
        }
      },
      expressionTargets: undefined
    })
  }

  // ---------------------------------------------------------------------------
  // Face Control helpers
  // ---------------------------------------------------------------------------

  let eyelidsLocked = $state(true)

  const kitchenHasFaceControls = $derived.by(() => {
    return kitchenPreviewEngine?.hasFaceControls() ?? false
  })

  const editorHasFaceControls = $derived.by(() => {
    return previewEngine?.hasFaceControls() ?? false
  })

  function currentHasFaceControls(
    cueLike?: { faceControls?: GoonFaceControl[] | undefined } | null
  ): boolean {
    if (activeTab === 'kitchen' ? kitchenHasFaceControls : editorHasFaceControls) return true
    return NORMAL_FACE_CONTROL_SECTIONS.length > 0
  }

  function currentFaceControlSections(
    cueLike?: { faceControls?: GoonFaceControl[] | undefined } | null
  ): FaceControlSection[] {
    const engine = activeTab === 'kitchen' ? kitchenPreviewEngine : previewEngine
    if (engine && engine.hasFaceControls()) {
      if (engine.getVRMSourceType() === 'unknown') {
        return NORMAL_FACE_CONTROL_SECTIONS
      }
      return getSupportedNormalFaceControlSections(
        engine.getVRMSourceType(),
        engine.getRawMorphTargetNames()
      )
    }
    return NORMAL_FACE_CONTROL_SECTIONS
  }

  function currentSemanticExpressionControls() {
    const engine = activeTab === 'kitchen' ? kitchenPreviewEngine : previewEngine
    const ready = activeTab === 'kitchen' ? kitchenPreviewReady : previewReady
    if (!engine || !ready) return [...GOON_SEMANTIC_EXPRESSION_CONTROLS]
    if (engine.getArkitFaceAuthoringDefinitions().length > 0) return []
    return resolveGoonSemanticExpressionControlStates(
      new Set(engine.getSupportedSemanticExpressionPresets()),
      engine.getSemanticExpressionSourceLabel()
    )
  }

  function isFaceControlGroupLocked(groupId: string): boolean {
    if (groupId === 'eyelids') return eyelidsLocked
    return false
  }

  function setFaceControlGroupLocked(groupId: string, locked: boolean) {
    if (groupId === 'eyelids') eyelidsLocked = locked
  }

  function currentRawMorphTargetNames(): string[] {
    const engine = activeTab === 'kitchen' ? kitchenPreviewEngine : previewEngine
    if (!engine?.hasRawMorphTargets()) return []
    return engine.getAuthorableRawMorphTargetNames()
  }

  function currentCustomMorphDefinitions(): CustomMorphDefinition[] {
    const engine = activeTab === 'kitchen' ? kitchenPreviewEngine : previewEngine
    if (!engine?.hasCustomMorphDefinitions()) return []
    return engine.getCustomMorphDefinitions()
  }

  function currentUniversalFaceControlModel(): UniversalFaceControlModel {
    const engine = activeTab === 'kitchen' ? kitchenPreviewEngine : previewEngine
    return buildUniversalFaceControlModel({
      arkitDefinitions: engine?.getArkitFaceAuthoringDefinitions() ?? [],
      tongueDefinitions: engine?.getTongueFaceAuthoringDefinitions() ?? [],
      customMorphDefinitions: currentCustomMorphDefinitions(),
      mouthPresetSupport: engine?.getMouthPresetSupport() ?? null,
      classicSections: currentFaceControlSections()
    })
  }

  function currentUsesArkit52FaceProfile(): boolean {
    return currentUniversalFaceControlModel().sections.some((section) =>
      section.controls.some((control) => control.storage === 'arkit-channel')
    )
  }

  function resolveEditorFaceProfiles(
    cueLike: Pick<
      GoonCueDefinition | GoonEmoteStep,
      'faceProfiles' | 'expressionTargets' | 'faceControls' | 'rawMorphTargets'
    >,
    initializeNeutralArkit52 = true
  ): GoonCueFaceProfiles {
    return normalizeCueFaceSource(cueLike, { initializeNeutralArkit52 }).faceProfiles
  }

  function setArkitChannelValue(
    channels: GoonArkit52ChannelTarget[] | undefined,
    channel: GoonArkit52ChannelTarget['channel'],
    value: number
  ): GoonArkit52ChannelTarget[] | undefined {
    const next = (channels ?? []).filter((entry) => entry.channel !== channel)
    if (value > 0) next.push({ channel, value })
    next.sort((left, right) => left.channel.localeCompare(right.channel))
    return next.length > 0 ? next : undefined
  }

  function getCueExpressionPresetValue(
    cueName: string,
    preset: GoonExpressionPreset
  ): number {
    const map = activeTab === 'kitchen' ? kitchenCueMap : editorCueMap
    const cue = map[cueName]
    if (!cue) return 0
    return getExpressionTargetWeight(
      resolveEditorFaceProfiles(cue).portable.expressionTargets,
      preset
    )
  }

  function currentUnmanagedRawMorphTargetNames(): string[] {
    const managed = new Set(currentUniversalFaceControlModel().managedRawMorphTargetNames)
    return currentRawMorphTargetNames().filter((targetName) => !managed.has(targetName))
  }

  function currentHasUnmanagedRawMorphTargets(): boolean {
    return currentUnmanagedRawMorphTargetNames().length > 0
  }

  function getUnmanagedRawMorphs(
    rawMorphTargets: GoonRawMorphTarget[] | undefined
  ): GoonRawMorphTarget[] {
    const available = new Set(currentUnmanagedRawMorphTargetNames())
    return (rawMorphTargets ?? []).filter((entry) => available.has(entry.target))
  }

  function getFaceControlValue(cueName: string, controlId: BatshitFaceControlId): number {
    const map = activeTab === 'kitchen' ? kitchenCueMap : editorCueMap
    const cue = map[cueName]
    if (!cue) return 0
    const profiles = resolveEditorFaceProfiles(cue)
    const controls = currentUsesArkit52FaceProfile()
      ? profiles.arkit52?.headControls
      : profiles.portable.faceControls
    const fc = controls?.find((c) => c.control === controlId)
    return fc?.value ?? 0
  }

  function updateFaceControl(cueName: string, controlId: BatshitFaceControlId, value: number) {
    const map = activeTab === 'kitchen' ? kitchenCueMap : editorCueMap
    const cue = map[cueName] || { name: cueName, kind: 'emote' }
    const faceProfiles = resolveEditorFaceProfiles(cue)
    const usesArkit = currentUsesArkit52FaceProfile()
    let next = [
      ...(usesArkit
        ? faceProfiles.arkit52?.headControls ?? []
        : faceProfiles.portable.faceControls ?? [])
    ]

    // Apply the primary control
    next = applyFaceControlToArray(next, controlId, value)

    next = applyLockedFaceControlMirrors(next, controlId, value)

    updateCueField(cueName, {
      faceProfiles: usesArkit
        ? {
            ...faceProfiles,
            arkit52: {
              ...faceProfiles.arkit52,
              headControls: next.length > 0 ? next : undefined
            }
          }
        : {
            ...faceProfiles,
            portable: {
              ...faceProfiles.portable,
              faceControls: next.length > 0 ? next : undefined
            }
          },
      faceControls: undefined
    })
  }

  function applyFaceControlToArray(
    arr: GoonFaceControl[],
    controlId: BatshitFaceControlId,
    value: number
  ): GoonFaceControl[] {
    if (value === 0) {
      return arr.filter((c) => c.control !== controlId)
    }
    const idx = arr.findIndex((c) => c.control === controlId)
    const result = [...arr]
    if (idx >= 0) {
      result[idx] = { control: controlId, value }
    } else {
      result.push({ control: controlId, value })
    }
    return result
  }

  function applyLockedFaceControlMirrors(
    arr: GoonFaceControl[],
    controlId: BatshitFaceControlId,
    value: number
  ): GoonFaceControl[] {
    if (!eyelidsLocked) return arr
    if (controlId === 'eyelids_left') return applyFaceControlToArray(arr, 'eyelids_right', value)
    if (controlId === 'eyelids_right') return applyFaceControlToArray(arr, 'eyelids_left', value)
    return arr
  }

  function getRawMorphTargetValue(cueName: string, targetName: string): number {
    const map = activeTab === 'kitchen' ? kitchenCueMap : editorCueMap
    const cue = map[cueName]
    if (!cue?.rawMorphTargets) return 0
    const rawMorph = cue.rawMorphTargets.find((entry) => entry.target === targetName)
    return rawMorph?.value ?? 0
  }

  function updateRawMorphTarget(cueName: string, targetName: string, value: number) {
    const map = activeTab === 'kitchen' ? kitchenCueMap : editorCueMap
    const cue = map[cueName] || { name: cueName, kind: 'emote' }
    const next = applyRawMorphTargetToArray(cue.rawMorphTargets ?? [], targetName, value)
    updateCueField(cueName, { rawMorphTargets: next.length > 0 ? next : undefined })
  }

  function applyRawMorphTargetToArray(
    arr: GoonRawMorphTarget[],
    targetName: string,
    value: number
  ): GoonRawMorphTarget[] {
    if (!targetName) return arr
    if (value === 0) {
      return arr.filter((entry) => entry.target !== targetName)
    }
    const idx = arr.findIndex((entry) => entry.target === targetName)
    const result = [...arr]
    if (idx >= 0) {
      result[idx] = { target: targetName, value }
    } else {
      result.push({ target: targetName, value })
    }
    return result.sort((a, b) => a.target.localeCompare(b.target))
  }

  function getUniversalFaceControlValue(
    cueName: string,
    control: UniversalFaceControlDefinition
  ): number {
    const map = activeTab === 'kitchen' ? kitchenCueMap : editorCueMap
    const cue = map[cueName]
    if (control.storage === 'face-control' && control.faceControlId) {
      return getFaceControlValue(cueName, control.faceControlId)
    }
    if (control.storage === 'arkit-channel' && control.arkitChannel) {
      const channels = cue
        ? resolveEditorFaceProfiles(cue).arkit52?.channels
        : undefined
      return channels?.find((entry) => entry.channel === control.arkitChannel)?.value ?? 0
    }
    if (control.storage === 'expression-preset' && control.expressionPreset) {
      return getCueExpressionPresetValue(cueName, control.expressionPreset)
    }
    return getCustomMorphValueForTargets(cue?.rawMorphTargets, control.morphTargets ?? [])
  }

  function updateUniversalFaceControl(
    cueName: string,
    control: UniversalFaceControlDefinition,
    value: number
  ) {
    if (control.storage === 'face-control' && control.faceControlId) {
      updateFaceControl(cueName, control.faceControlId, value)
      return
    }
    if (control.storage === 'arkit-channel' && control.arkitChannel) {
      const map = activeTab === 'kitchen' ? kitchenCueMap : editorCueMap
      const cue = map[cueName] || { name: cueName, kind: 'emote' }
      const faceProfiles = resolveEditorFaceProfiles(cue)
      updateCueField(cueName, {
        faceProfiles: {
          ...faceProfiles,
          arkit52: {
            ...faceProfiles.arkit52,
            channels: setArkitChannelValue(
              faceProfiles.arkit52?.channels,
              control.arkitChannel,
              value
            )
          }
        }
      })
      return
    }
    if (control.storage === 'expression-preset' && control.expressionPreset) {
      updateCueExpressionPreset(cueName, control.expressionPreset, value)
      return
    }
    const map = activeTab === 'kitchen' ? kitchenCueMap : editorCueMap
    const cue = map[cueName] || { name: cueName, kind: 'emote' }
    const next = applyCustomMorphValue(cue.rawMorphTargets ?? [], control.morphTargets ?? [], value)
    updateCueField(cueName, { rawMorphTargets: next.length > 0 ? next : undefined })
  }

  function resetUniversalFaceControls(cueName: string) {
    const map = activeTab === 'kitchen' ? kitchenCueMap : editorCueMap
    const cue = map[cueName] || { name: cueName, kind: 'emote' }
    const faceProfiles = resolveEditorFaceProfiles(cue)
    const usesArkit = currentUsesArkit52FaceProfile()
    updateCueField(cueName, {
      faceProfiles: usesArkit
        ? { ...faceProfiles, arkit52: {} }
        : { ...faceProfiles, portable: {} },
      expressionTargets: undefined,
      faceControls: undefined,
      rawMorphTargets: undefined
    })
  }

  function addRawMorphTarget(cueName: string) {
    const available = currentUnmanagedRawMorphTargetNames()
    if (available.length === 0) return
    const map = activeTab === 'kitchen' ? kitchenCueMap : editorCueMap
    const cue = map[cueName] || { name: cueName, kind: 'emote' }
    const existing = cue.rawMorphTargets ?? []
    const nextTarget = available.find((targetName) => !existing.some((entry) => entry.target === targetName))
    if (!nextTarget) return
    updateCueField(cueName, { rawMorphTargets: [...existing, { target: nextTarget, value: 1 }] })
  }

  function removeRawMorphTarget(cueName: string, targetName: string) {
    const map = activeTab === 'kitchen' ? kitchenCueMap : editorCueMap
    const cue = map[cueName]
    if (!cue?.rawMorphTargets) return
    const next = cue.rawMorphTargets.filter((entry) => entry.target !== targetName)
    updateCueField(cueName, { rawMorphTargets: next.length > 0 ? next : undefined })
  }

  function renameRawMorphTarget(cueName: string, fromTarget: string, toTarget: string) {
    if (!toTarget) return
    const map = activeTab === 'kitchen' ? kitchenCueMap : editorCueMap
    const cue = map[cueName]
    if (!cue?.rawMorphTargets) return
    const current = cue.rawMorphTargets.find((entry) => entry.target === fromTarget)
    if (!current) return
    const withoutCurrent = cue.rawMorphTargets.filter((entry) => entry.target !== fromTarget)
    const withoutTarget = withoutCurrent.filter((entry) => entry.target !== toTarget)
    updateCueField(cueName, {
      rawMorphTargets: [...withoutTarget, { target: toTarget, value: current.value }].sort((a, b) =>
        a.target.localeCompare(b.target)
      )
    })
  }

  // ---------------------------------------------------------------------------
  // Multi-step Emote helpers
  // ---------------------------------------------------------------------------

  function getSteps(cueName: string): GoonEmoteStep[] {
    const map = activeTab === 'kitchen' ? kitchenCueMap : editorCueMap
    const cue = map[cueName]
    return cue?.steps ?? []
  }

  function addStep(cueName: string) {
    const map = activeTab === 'kitchen' ? kitchenCueMap : editorCueMap
    const cue = map[cueName] || { name: cueName, kind: 'emote' }
    const steps = [...(cue.steps ?? [])]
    const promotingTopLevelToStep = steps.length === 0

    // If first step and no steps exist yet, promote current top-level to step 1
    if (promotingTopLevelToStep) {
      steps.push({
        faceProfiles: resolveEditorFaceProfiles(cue),
        rawMorphTargets: cue.rawMorphTargets ?? [],
        attackMs: cue.attackMs,
        holdMs: cue.holdMs,
        releaseMs: cue.releaseMs
      })
    }

    // Add new empty step
    steps.push({
      faceProfiles: {
        portable: {},
        arkit52: {}
      },
      rawMorphTargets: [],
      attackMs: 200,
      holdMs: 1000,
      releaseMs: 500
    })

    updateCueField(cueName, {
      steps,
      faceProfiles: promotingTopLevelToStep
        ? {
            portable: {},
            ...(cue.kind === 'emote' ? { arkit52: {} } : {})
          }
        : cue.faceProfiles,
      expressionTargets: promotingTopLevelToStep ? undefined : cue.expressionTargets,
      faceControls: promotingTopLevelToStep ? undefined : cue.faceControls,
      rawMorphTargets: promotingTopLevelToStep ? undefined : cue.rawMorphTargets,
      attackMs: promotingTopLevelToStep ? undefined : cue.attackMs,
      holdMs: promotingTopLevelToStep ? undefined : cue.holdMs,
      releaseMs: promotingTopLevelToStep ? undefined : cue.releaseMs
    })
  }

  function removeStep(cueName: string, stepIndex: number) {
    const map = activeTab === 'kitchen' ? kitchenCueMap : editorCueMap
    const cue = map[cueName]
    if (!cue?.steps) return
    const steps = cue.steps.filter((_s, i) => i !== stepIndex)

    // If only one step left, flatten back to top-level
    if (steps.length <= 1) {
      const single = steps[0]
      updateCueField(cueName, {
        steps: undefined,
        faceProfiles: single?.faceProfiles,
        expressionTargets: single?.expressionTargets,
        faceControls: single?.faceControls,
        rawMorphTargets: single?.rawMorphTargets,
        attackMs: single?.attackMs,
        holdMs: single?.holdMs,
        releaseMs: single?.releaseMs
      })
    } else {
      updateCueField(cueName, { steps })
    }
  }

  function updateStepField(cueName: string, stepIndex: number, patch: Partial<GoonEmoteStep>) {
    const map = activeTab === 'kitchen' ? kitchenCueMap : editorCueMap
    const cue = map[cueName]
    if (!cue?.steps) return
    setActiveFacePreviewSelection({ cueName, stepIndex })
    const steps = [...cue.steps]
    steps[stepIndex] = { ...steps[stepIndex], ...patch }
    updateCueField(cueName, { steps })
  }

  function buildFacePreviewDefinition(
    cueMap: GoonCueMap,
    selection: FacePreviewSelection | null
  ): GoonCueDefinition | null {
    if (!selection) return null
    const cue = cueMap[selection.cueName]
    if (!cue) return null

    const topLevelHasFaceAuthoring = Boolean(
      cue.faceProfiles?.portable.expressionTargets?.length ||
      cue.faceProfiles?.portable.faceControls?.length ||
      cue.faceProfiles?.arkit52?.channels?.length ||
      cue.faceProfiles?.arkit52?.headControls?.length ||
      cue.rawMorphTargets?.length
    )
    const selectedStep =
      typeof selection.stepIndex === 'number' ? cue.steps?.[selection.stepIndex] : undefined
    const fallbackStep =
      !topLevelHasFaceAuthoring && cue.steps && cue.steps.length > 0 ? cue.steps[0] : undefined
    const step = selectedStep ?? fallbackStep

    return {
      name: cue.name,
      kind: cue.kind,
      intensity: cue.intensity,
      faceProfiles: step?.faceProfiles ?? cue.faceProfiles,
      expressionTargets: step?.expressionTargets ?? cue.expressionTargets,
      faceControls: step?.faceControls ?? cue.faceControls,
      rawMorphTargets: step?.rawMorphTargets ?? cue.rawMorphTargets
    }
  }

  function updateStepExpressionPreset(
    cueName: string,
    stepIndex: number,
    preset: GoonExpressionPreset,
    value: number
  ) {
    const map = activeTab === 'kitchen' ? kitchenCueMap : editorCueMap
    const cue = map[cueName]
    if (!cue?.steps) return
    const step = cue.steps[stepIndex]
    if (!step) return
    const faceProfiles = resolveEditorFaceProfiles(step)
    updateStepField(cueName, stepIndex, {
      faceProfiles: {
        ...faceProfiles,
        portable: {
          ...faceProfiles.portable,
          expressionTargets: setExpressionTargetWeight(
            faceProfiles.portable.expressionTargets,
            preset,
            value
          )
        }
      },
      expressionTargets: undefined
    })
  }

  function updateStepFaceControl(
    cueName: string,
    stepIndex: number,
    controlId: BatshitFaceControlId,
    value: number
  ) {
    const map = activeTab === 'kitchen' ? kitchenCueMap : editorCueMap
    const cue = map[cueName]
    if (!cue?.steps) return
    const step = cue.steps[stepIndex]
    if (!step) return
    const faceProfiles = resolveEditorFaceProfiles(step)
    const usesArkit = currentUsesArkit52FaceProfile()
    let next = applyFaceControlToArray(
      usesArkit
        ? faceProfiles.arkit52?.headControls ?? []
        : faceProfiles.portable.faceControls ?? [],
      controlId,
      value
    )
    next = applyLockedFaceControlMirrors(next, controlId, value)
    updateStepField(cueName, stepIndex, {
      faceProfiles: usesArkit
        ? {
            ...faceProfiles,
            arkit52: {
              ...faceProfiles.arkit52,
              headControls: next.length > 0 ? next : undefined
            }
          }
        : {
            ...faceProfiles,
            portable: {
              ...faceProfiles.portable,
              faceControls: next.length > 0 ? next : undefined
            }
          },
      faceControls: undefined
    })
  }

  function getStepFaceControlValue(
    cueName: string,
    stepIndex: number,
    controlId: BatshitFaceControlId
  ): number {
    const map = activeTab === 'kitchen' ? kitchenCueMap : editorCueMap
    const cue = map[cueName]
    const step = cue?.steps?.[stepIndex]
    if (!step) return 0
    const faceProfiles = resolveEditorFaceProfiles(step)
    const controls = currentUsesArkit52FaceProfile()
      ? faceProfiles.arkit52?.headControls
      : faceProfiles.portable.faceControls
    const fc = controls?.find((c) => c.control === controlId)
    return fc?.value ?? 0
  }

  function getStepRawMorphTargetValue(cueName: string, stepIndex: number, targetName: string): number {
    const map = activeTab === 'kitchen' ? kitchenCueMap : editorCueMap
    const cue = map[cueName]
    const step = cue?.steps?.[stepIndex]
    const rawMorph = step?.rawMorphTargets?.find((entry) => entry.target === targetName)
    return rawMorph?.value ?? 0
  }

  function updateStepRawMorphTarget(
    cueName: string,
    stepIndex: number,
    targetName: string,
    value: number
  ) {
    const map = activeTab === 'kitchen' ? kitchenCueMap : editorCueMap
    const cue = map[cueName]
    if (!cue?.steps) return
    const step = cue.steps[stepIndex]
    if (!step) return
    const next = applyRawMorphTargetToArray(step.rawMorphTargets ?? [], targetName, value)
    updateStepField(cueName, stepIndex, { rawMorphTargets: next.length > 0 ? next : undefined })
  }

  function getStepUniversalFaceControlValue(
    cueName: string,
    stepIndex: number,
    control: UniversalFaceControlDefinition
  ): number {
    const map = activeTab === 'kitchen' ? kitchenCueMap : editorCueMap
    const cue = map[cueName]
    const step = cue?.steps?.[stepIndex]
    if (control.storage === 'face-control' && control.faceControlId) {
      return getStepFaceControlValue(cueName, stepIndex, control.faceControlId)
    }
    if (control.storage === 'arkit-channel' && control.arkitChannel) {
      const channels = step
        ? resolveEditorFaceProfiles(step).arkit52?.channels
        : undefined
      return channels?.find((entry) => entry.channel === control.arkitChannel)?.value ?? 0
    }
    if (control.storage === 'expression-preset' && control.expressionPreset) {
      return getExpressionTargetWeight(
        step ? resolveEditorFaceProfiles(step).portable.expressionTargets : undefined,
        control.expressionPreset
      )
    }
    return getCustomMorphValueForTargets(step?.rawMorphTargets, control.morphTargets ?? [])
  }

  function updateStepUniversalFaceControl(
    cueName: string,
    stepIndex: number,
    control: UniversalFaceControlDefinition,
    value: number
  ) {
    if (control.storage === 'face-control' && control.faceControlId) {
      updateStepFaceControl(cueName, stepIndex, control.faceControlId, value)
      return
    }
    if (control.storage === 'arkit-channel' && control.arkitChannel) {
      const map = activeTab === 'kitchen' ? kitchenCueMap : editorCueMap
      const step = map[cueName]?.steps?.[stepIndex]
      if (!step) return
      const faceProfiles = resolveEditorFaceProfiles(step)
      updateStepField(cueName, stepIndex, {
        faceProfiles: {
          ...faceProfiles,
          arkit52: {
            ...faceProfiles.arkit52,
            channels: setArkitChannelValue(
              faceProfiles.arkit52?.channels,
              control.arkitChannel,
              value
            )
          }
        }
      })
      return
    }
    if (control.storage === 'expression-preset' && control.expressionPreset) {
      updateStepExpressionPreset(cueName, stepIndex, control.expressionPreset, value)
      return
    }
    const map = activeTab === 'kitchen' ? kitchenCueMap : editorCueMap
    const cue = map[cueName]
    if (!cue?.steps) return
    const step = cue.steps[stepIndex]
    if (!step) return
    const next = applyCustomMorphValue(step.rawMorphTargets ?? [], control.morphTargets ?? [], value)
    updateStepField(cueName, stepIndex, { rawMorphTargets: next.length > 0 ? next : undefined })
  }

  function resetStepUniversalFaceControls(cueName: string, stepIndex: number) {
    const map = activeTab === 'kitchen' ? kitchenCueMap : editorCueMap
    const step = map[cueName]?.steps?.[stepIndex]
    if (!step) return
    const faceProfiles = resolveEditorFaceProfiles(step)
    const usesArkit = currentUsesArkit52FaceProfile()
    updateStepField(cueName, stepIndex, {
      faceProfiles: usesArkit
        ? { ...faceProfiles, arkit52: {} }
        : { ...faceProfiles, portable: {} },
      expressionTargets: undefined,
      faceControls: undefined,
      rawMorphTargets: undefined
    })
  }

  function addStepRawMorphTarget(cueName: string, stepIndex: number) {
    const available = currentUnmanagedRawMorphTargetNames()
    if (available.length === 0) return
    const map = activeTab === 'kitchen' ? kitchenCueMap : editorCueMap
    const cue = map[cueName]
    if (!cue?.steps) return
    const step = cue.steps[stepIndex]
    if (!step) return
    const existing = step.rawMorphTargets ?? []
    const nextTarget = available.find((targetName) => !existing.some((entry) => entry.target === targetName))
    if (!nextTarget) return
    updateStepField(cueName, stepIndex, {
      rawMorphTargets: [...existing, { target: nextTarget, value: 1 }].sort((a, b) =>
        a.target.localeCompare(b.target)
      )
    })
  }

  function removeStepRawMorphTarget(cueName: string, stepIndex: number, targetName: string) {
    const map = activeTab === 'kitchen' ? kitchenCueMap : editorCueMap
    const cue = map[cueName]
    const step = cue?.steps?.[stepIndex]
    if (!step?.rawMorphTargets) return
    const next = step.rawMorphTargets.filter((entry) => entry.target !== targetName)
    updateStepField(cueName, stepIndex, { rawMorphTargets: next.length > 0 ? next : undefined })
  }

  function renameStepRawMorphTarget(
    cueName: string,
    stepIndex: number,
    fromTarget: string,
    toTarget: string
  ) {
    if (!toTarget) return
    const map = activeTab === 'kitchen' ? kitchenCueMap : editorCueMap
    const cue = map[cueName]
    const step = cue?.steps?.[stepIndex]
    if (!step?.rawMorphTargets) return
    const current = step.rawMorphTargets.find((entry) => entry.target === fromTarget)
    if (!current) return
    const withoutCurrent = step.rawMorphTargets.filter((entry) => entry.target !== fromTarget)
    const withoutTarget = withoutCurrent.filter((entry) => entry.target !== toTarget)
    updateStepField(cueName, stepIndex, {
      rawMorphTargets: [...withoutTarget, { target: toTarget, value: current.value }].sort((a, b) =>
        a.target.localeCompare(b.target)
      )
    })
  }

  const saveCamera = debounce(async (camera: GoonCamera) => {
    if (!editorGoonId) return
    try {
      await persistGoonCamera(editorGoonId, camera)
    } catch (error: any) {
      toast.error(error?.message || 'Failed to save camera view')
    }
  }, 700)

  function handlePreviewCameraChange(camera: GoonCamera | null) {
    if (!editorGoonId || !camera) return
    editorCamera = { ...camera }
    saveCamera(editorCamera)
  }

  function handlePreviewSkyboxOffsetChange(value: number | number[]) {
    if (Array.isArray(value)) {
      previewSkyboxOffset = value[0] ?? previewSkyboxOffset
    } else if (typeof value === 'number') {
      previewSkyboxOffset = value
    }
  }

  function handlePreviewFovChange(value: number | number[]) {
    if (Array.isArray(value)) {
      previewViewFov = value[0] ?? previewViewFov
    } else if (typeof value === 'number') {
      previewViewFov = value
    }
    previewEngine?.setCameraFov(previewViewFov)
    kitchenPreviewEngine?.setCameraFov(previewViewFov)
  }

  function handlePreviewCameraModeChange(
    target: GoonEngine | null,
    mode: GoonCameraMode,
    persist: boolean
  ) {
    if (!target?.setCameraMode(mode)) return
    previewCameraMode = mode
    if (persist) handlePreviewCameraChange(target.getCameraState())
  }

  function handlePreviewFramePreset(preset: GoonFramingPreset) {
    previewEngine?.frameAvatar(preset)
  }

  function handleKitchenPreviewFramePreset(preset: GoonFramingPreset) {
    kitchenPreviewEngine?.frameAvatar(preset)
  }

  function applyEditorEyeContactTuning(tuning: ResolvedGoonEyeContactTuning) {
    editorEyeContactEyeYawSensitivity = tuning.eyeYawSensitivity
    editorEyeContactEyeYawRange = tuning.eyeYawRange
    editorEyeContactEyePitchSensitivity = tuning.eyePitchSensitivity
    editorEyeContactEyePitchRange = tuning.eyePitchRange
    editorEyeContactHeadYawStartOutDeg = tuning.headYawStartOutDeg
    editorEyeContactHeadYawStartInDeg = tuning.headYawStartInDeg
    editorEyeContactHeadYawSensitivity = tuning.headYawSensitivity
    editorEyeContactHeadYawRange = tuning.headYawRange
    editorEyeContactHeadYawSpeed = tuning.headYawSpeed
    editorEyeContactHeadPitchStartOutDeg = tuning.headPitchStartOutDeg
    editorEyeContactHeadPitchStartInDeg = tuning.headPitchStartInDeg
    editorEyeContactHeadPitchSensitivity = tuning.headPitchSensitivity
    editorEyeContactHeadPitchRange = tuning.headPitchRange
    editorEyeContactHeadPitchSpeed = tuning.headPitchSpeed
    editorEyeContactEyeYawHeadCompensation = tuning.eyeYawHeadCompensation
    editorEyeContactEyePitchHeadCompensation = tuning.eyePitchHeadCompensation
  }

  function buildEditorEyeContactTuning(): ResolvedGoonEyeContactTuning {
    return {
      eyeYawSensitivity: editorEyeContactEyeYawSensitivity,
      eyeYawRange: editorEyeContactEyeYawRange,
      eyePitchSensitivity: editorEyeContactEyePitchSensitivity,
      eyePitchRange: editorEyeContactEyePitchRange,
      headYawStartOutDeg: editorEyeContactHeadYawStartOutDeg,
      headYawStartInDeg: editorEyeContactHeadYawStartInDeg,
      headYawSensitivity: editorEyeContactHeadYawSensitivity,
      headYawRange: editorEyeContactHeadYawRange,
      headYawSpeed: editorEyeContactHeadYawSpeed,
      headPitchStartOutDeg: editorEyeContactHeadPitchStartOutDeg,
      headPitchStartInDeg: editorEyeContactHeadPitchStartInDeg,
      headPitchSensitivity: editorEyeContactHeadPitchSensitivity,
      headPitchRange: editorEyeContactHeadPitchRange,
      headPitchSpeed: editorEyeContactHeadPitchSpeed,
      eyeYawHeadCompensation: editorEyeContactEyeYawHeadCompensation,
      eyePitchHeadCompensation: editorEyeContactEyePitchHeadCompensation
    }
  }

  function updateEditorEyeContactTuning(patch: Partial<ResolvedGoonEyeContactTuning>) {
    applyEditorEyeContactTuning(normalizeGoonEyeContactTuning({ ...buildEditorEyeContactTuning(), ...patch }))
    editorDirty = true
  }

  function buildKitchenEyeContactSettings(): GoonGlobalEyeContactSettingsMap {
    return {
      vroid: {
        mode: kitchenEyeContactVroidMode,
        tuning: kitchenEyeContactVroidTuning
      },
      blender: {
        mode: kitchenEyeContactBlenderMode,
        tuning: kitchenEyeContactBlenderTuning
      }
    }
  }

  function setKitchenEyeContactMode(mode: GoonEyeContactMode) {
    if (kitchenEyeContactProfile === 'vroid') {
      kitchenEyeContactVroidMode = mode
    } else {
      kitchenEyeContactBlenderMode = mode
    }
    kitchenDirty = true
  }

  function updateKitchenEyeContactTuning(patch: Partial<ResolvedGoonEyeContactTuning>) {
    if (kitchenEyeContactProfile === 'vroid') {
      kitchenEyeContactVroidTuning = normalizeGoonEyeContactTuning({
        ...kitchenEyeContactVroidTuning,
        ...patch
      })
    } else {
      kitchenEyeContactBlenderTuning = normalizeGoonEyeContactTuning({
        ...kitchenEyeContactBlenderTuning,
        ...patch
      })
    }
    kitchenDirty = true
  }

  function buildSettingsWithDraftKitchenEyeContact(): GoonsSettings {
    return {
      ...goonsSettings,
      kitchen: {
        ...(goonsSettings?.kitchen ?? {}),
        eyeContact: buildKitchenEyeContactSettings()
      }
    }
  }

  function resolveGlobalEyeContactForGoon(goon: GoonRecord) {
    const profile = resolveGoonEyeContactGlobalProfile(goon)
    const globalSettings = normalizeGoonGlobalEyeContactSettingsMap(
      buildKitchenEyeContactSettings()
    )
    return globalSettings[profile]
  }

  function eyeContactTuningMatches(
    left: ResolvedGoonEyeContactTuning,
    right: ResolvedGoonEyeContactTuning
  ) {
    return (
      JSON.stringify(normalizeGoonEyeContactTuning(left)) ===
      JSON.stringify(normalizeGoonEyeContactTuning(right))
    )
  }

  function resetEditorEyeContactToGlobal() {
    const goon = editorRecipeSourceGoon
    if (!goon) return
    const nextSettings = resolveGlobalEyeContactForGoon(goon)
    editorEyeContactMode = nextSettings.mode
    applyEditorEyeContactTuning(nextSettings.tuning)
    editorDirty = true
  }

  function updateEditorSocketEyeContact(value: SocketEyeContactSettingsV2) {
    const parsed = parseSocketEyeContactSettings(value)
    if (JSON.stringify(parsed) === JSON.stringify(editorSocketEyeContact)) return
    editorSocketEyeContact = parsed
    previewEngine?.setSocketEyeContactSettings(parsed)
    editorDirty = true
  }

  function clampPreviewFov(value: number) {
    return Math.max(MIN_PREVIEW_VIEW_FOV, Math.min(MAX_PREVIEW_VIEW_FOV, value))
  }

  function adjustPreviewFovByScrollDelta(rawDelta: number) {
    const direction = Math.sign(rawDelta)
    if (!direction) return
    previewViewFov = clampPreviewFov(previewViewFov + direction * 2)
    previewEngine?.setCameraFov(previewViewFov)
    kitchenPreviewEngine?.setCameraFov(previewViewFov)
  }

  function handlePreviewViewportFovWheel(event: WheelEvent) {
    if (!event.shiftKey || event.metaKey || event.altKey || event.ctrlKey) return
    const rawDelta = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX
    if (!rawDelta) return
    adjustPreviewFovByScrollDelta(rawDelta)
    event.preventDefault()
    event.stopPropagation()
  }

  const previewMinWidth = 480
  const previewMinLeftWidth = 360

  function getPreviewShellEl() {
    if (previewWidthContext === 'editor') return editorShellEl
    if (previewWidthContext === 'scene') return sceneShellEl
    return mainSettingsShellEl
  }

  function applyDefaultPreviewWidth() {
    const shell = getPreviewShellEl()
    if (!shell) return
    const rect = shell.getBoundingClientRect()
    const maxWidth = Math.max(previewMinWidth, rect.width - previewMinLeftWidth)
    const targetWidth = Math.floor(rect.width * 0.5)
    previewWidth = Math.min(Math.max(targetWidth, previewMinWidth), maxWidth)
  }

  function handlePreviewResize(event: PointerEvent) {
    if (!previewResizing) return
    const shell = getPreviewShellEl()
    if (!shell) return
    const rect = shell.getBoundingClientRect()
    const rawWidth = Math.round(rect.right - event.clientX)
    const maxWidth = Math.max(previewMinWidth, rect.width - previewMinLeftWidth)
    previewWidth = Math.min(Math.max(rawWidth, previewMinWidth), maxWidth)
  }

  function stopPreviewResize() {
    if (!previewResizing) return
    previewResizing = false
    if (typeof window !== 'undefined') {
      window.removeEventListener('pointermove', handlePreviewResize)
      window.removeEventListener('pointerup', stopPreviewResize)
    }
  }

  function startPreviewResize(event: PointerEvent) {
    if (event.button !== 0) return
    event.preventDefault()
    previewResizing = true
    if (typeof window !== 'undefined') {
      window.addEventListener('pointermove', handlePreviewResize)
      window.addEventListener('pointerup', stopPreviewResize)
    }
    handlePreviewResize(event)
  }

  async function triggerTestCue(cueName: string) {
    const isKitchen = activeTab === 'kitchen'
    const scope: FacePreviewScope = isKitchen ? 'kitchen' : 'editor'
    const targetGoonId = isKitchen ? kitchenPreviewGoonId : editorGoonId
    if (!targetGoonId) return
    const map = isKitchen ? kitchenCueMap : editorCueMap
    const definition = map[cueName]
    if (typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent('batshit:goon-test-cue', {
          detail: {
            goonId: targetGoonId,
            cueName,
            source: 'goons-settings-preview',
            preserveCamera: true,
            preservePlacement: true
          }
        })
      )
    }
    const engine = isKitchen ? await ensureKitchenPreviewReady() : await ensurePreviewGoonReady()
    if (!engine) return
    if (definition?.kind === 'emote') {
      if (isKitchen) {
        applyKitchenPreviewLoopState(engine, {
          neutralFace: true,
          trackSignature: false,
          preserveCamera: true,
          preservePlacement: true
        })
      } else {
        applyEditorPreviewLoopState(engine, {
          neutralFace: true,
          trackSignature: false,
          preserveCamera: true,
          preservePlacement: true
        })
      }
      engine.clearAuthoringFacePreview()
      suspendFacePreviewForCue(scope, engine.estimateCueDurationMs(cueName, definition) + 120)
    }
    engine.playCue(cueName, definition, { preserveCamera: true, preservePlacement: true })
  }

  async function triggerPreviewAnimation() {
    if (!editorGoonId || !previewAnimationName) return
    if (typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent('batshit:goon-preview-animation', {
          detail: { goonId: editorGoonId, animationName: previewAnimationName }
        })
      )
    }
    const engine = await ensurePreviewGoonReady()
    if (!engine) return
    if (!previewAnimationActive) {
      previewAnimationRestore = engine.getBaseLoopState()
    }
    engine.previewLoopAnimation(
      previewAnimationName,
      resolvePreviewAnimationDefinitionForGoon(previewAnimationName, resolveGoonById(editorGoonId), editorCueMap)
    )
    previewAnimationActive = true
  }

  async function triggerMotionLibraryPreview(animationFile: GoonFileRef, animationName: string, previewId: string) {
    if ($goonMotionPreviewGenerationActive) {
      motionLibraryPreviewError = 'Motion preview videos are still being prepared. Wait for generation to finish.'
      motionLibraryPreviewLoading = false
      return
    }
    const requestId = ++motionLibraryPreviewRequestId
    activePreviewId = previewId
    motionLibraryPreviewName = animationName
    motionLibraryPreviewLoading = true
    motionLibraryPreviewError = null

    try {
      if (previewEngine && previewGoonId !== MOTION_LIBRARY_PREVIEW_GOON_ID) {
        resetPreview('leaving-editor-for-motions')
      }
      const lane = resolveGoonMotionLane(animationFile)
      const previewTarget: MotionPreviewTarget =
        lane === 'glb' ? glbMotionPreviewTarget : { kind: 'vrm', url: STUNT_DUMMY_VRM_URL }
      const targetUrl = resolveMotionPreviewTargetKey(previewTarget)
      if (!targetUrl) {
        throw new Error('Preview Goon is missing its model file.')
      }
      const engine = await ensurePreviewEngine()
      if (!engine || requestId !== motionLibraryPreviewRequestId) return
      if (previewVrmUrl !== targetUrl || previewGoonId !== MOTION_LIBRARY_PREVIEW_GOON_ID) {
        if (previewTarget.kind === 'custom') {
          await loadAvatarIntoEngine(engine, previewTarget.goon)
        } else if (previewTarget.kind === 'custom-url') {
          const manifest = await loadCustomAvatarManifest({
            url: previewTarget.manifestUrl,
            filename: previewTarget.manifestUrl.split('/').pop() || 'avatar.json'
          })
          await engine.loadCustomGoon(previewTarget.modelUrl, manifest)
        } else {
          await engine.loadGoon(STUNT_DUMMY_VRM_URL)
        }
        if (requestId !== motionLibraryPreviewRequestId) return
        previewVrmUrl = targetUrl
        previewGoonId = MOTION_LIBRARY_PREVIEW_GOON_ID
        motionLibraryPreviewSignature = ''
      }

      const signature = `${targetUrl}::${animationFile.url}`
      if (motionLibraryPreviewSignature !== signature) {
        await engine.syncAnimations([animationFile])
        if (requestId !== motionLibraryPreviewRequestId) return
        motionLibraryPreviewSignature = signature
      }

      engine.setGoonVisible(true)
      if (!engine.previewLoopAnimation(animationName)) {
        throw new Error(`Motion "${animationName}" was not available in the live preview.`)
      }
      previewAnimationActive = true
      previewAnimationRestore = null
      previewAnimationName = animationName
    } catch (error: any) {
      if (requestId === motionLibraryPreviewRequestId) {
        motionLibraryPreviewError = error?.message || 'Failed to preview motion'
      }
    } finally {
      if (requestId === motionLibraryPreviewRequestId) {
        motionLibraryPreviewLoading = false
      }
    }
  }

  async function clearMotionLibraryPreview() {
    motionLibraryPreviewRequestId += 1
    motionLibraryPreviewName = ''
    motionLibraryPreviewError = null
    motionLibraryPreviewLoading = false
    activePreviewId = null
    previewAnimationActive = false
    previewAnimationName = ''
    motionLibraryPreviewSignature = ''
    previewEngine?.clearPreviewAnimation()
  }

  async function resetMotionLibraryPreviewAll() {
    await clearMotionLibraryPreview()
    previewViewFov = DEFAULT_PREVIEW_VIEW_FOV
    previewEngine?.resetView()
  }

  async function clearPreviewAnimation() {
    if (!editorGoonId) return
    if (typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent('batshit:goon-preview-clear', {
          detail: { goonId: editorGoonId }
        })
      )
    }
    const engine = await ensurePreviewGoonReady()
    if (!engine) return
    const restore = previewAnimationRestore ?? engine.getBaseLoopState()
    engine.clearPreviewAnimation()
    if (restore?.name) {
      engine.setMood(restore.name, restore.definition ?? undefined)
    }
    previewAnimationActive = false
    previewAnimationRestore = null
    previewAnimationName = ''
  }

  async function triggerKitchenPreviewAnimation(options: { preservePlacement?: boolean } = {}) {
    if (!kitchenPreviewGoonId || !kitchenPreviewAnimationName) return
    if (typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent('batshit:goon-preview-animation', {
          detail: { goonId: kitchenPreviewGoonId, animationName: kitchenPreviewAnimationName }
        })
      )
    }
    const engine = await ensureKitchenPreviewReady()
    if (!engine) return
    if (!kitchenPreviewAnimationActive) {
      kitchenPreviewAnimationRestore = engine.getBaseLoopState()
    }
    engine.previewLoopAnimation(
      kitchenPreviewAnimationName,
      resolvePreviewAnimationDefinitionForGoon(
        kitchenPreviewAnimationName,
        resolveGoonById(kitchenPreviewGoonId),
        kitchenCueMap
      ),
      {
        preservePlacement: options.preservePlacement ?? activeSceneEdit?.type === 'marker'
      }
    )
    kitchenPreviewAnimationActive = true
  }

  async function clearKitchenPreviewAnimation() {
    if (!kitchenPreviewGoonId) return
    if (typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent('batshit:goon-preview-clear', {
          detail: { goonId: kitchenPreviewGoonId }
        })
      )
    }
    const engine = await ensureKitchenPreviewReady()
    if (!engine) return
    engine.clearPreviewAnimation()
    if (scenePreviewUsesMotionOnly()) {
      applyScenePreviewMotionState(engine, kitchenPreviewGoon)
    } else {
      const restore = kitchenPreviewAnimationRestore ?? engine.getBaseLoopState()
      if (restore?.name) {
        engine.setMood(restore.name, restore.definition ?? undefined)
      }
      kitchenPreviewAnimationActive = false
      kitchenPreviewAnimationRestore = null
      kitchenPreviewAnimationName = ''
    }
  }

  async function resetPreviewBaseLoop() {
    if (!editorGoonId) return
    const engine = await ensurePreviewGoonReady()
    if (!engine) return
    applyEditorPreviewLoopState(engine)
  }

  async function resetKitchenPreviewBaseLoop() {
    const engine = await ensureKitchenPreviewReady()
    if (!engine) return
    if (scenePreviewUsingProxy) {
      await applySceneProxyPose(engine)
      return
    }
    if (scenePreviewUsesMotionOnly()) {
      applyScenePreviewMotionState(engine, kitchenPreviewGoon)
    } else {
      applyKitchenPreviewLoopState(engine)
    }
  }

  async function resetPreviewCamera() {
    if (!editorGoonId) return
    const engine = await ensurePreviewGoonReady()
    if (!engine) return
    engine.resetView()
    const camera = engine.getCameraState()
    if (camera) {
      editorCamera = { ...camera }
      saveCamera(editorCamera)
    }
  }

  async function resetKitchenPreviewCamera() {
    const engine = await ensureKitchenPreviewReady()
    if (!engine) return
    engine.resetView()
  }

  function handleEditorGoonSelect(nextGoonId: string | null) {
    if (nextGoonId !== editorGoonId) {
      previewEngine?.clearHairPreview()
      hairPreviewError = null
    }
    if (!nextGoonId) {
      editorGoonId = null
      return
    }
    const target = resolveGoonById(nextGoonId)
    if (target) {
      openCueEditor(target)
    }
  }

  function handleKitchenPreviewGoonSelect(nextGoonId: string | null) {
    kitchenPreviewGoonId = nextGoonId || null
    void ensureKitchenPreviewReady()
  }

  function handleLibraryPreviewGoonSelect(nextGoonId: string | null) {
    libraryPreviewGoonId = nextGoonId || null
    void ensureLibraryPreviewReady()
  }

  function handleScenePreviewGoonSelect(nextGoonId: string | null) {
    kitchenPreviewGoonId = nextGoonId || null
    if (sceneEditorId) {
      void ensureKitchenPreviewReady(sceneEditorId)
      return
    }
    if (activeTab === 'scenes') {
      void ensureKitchenPreviewReady(kitchenPreviewSceneId)
    }
  }

  async function resetEditorPreviewAll() {
    if (previewAnimationActive) {
      await clearPreviewAnimation()
    }
    await resetPreviewBaseLoop()
    previewViewFov = DEFAULT_PREVIEW_VIEW_FOV
    await resetPreviewCamera()
  }

  async function resetKitchenPreviewAll() {
    if (kitchenPreviewAnimationActive) {
      await clearKitchenPreviewAnimation()
    }
    await resetKitchenPreviewBaseLoop()
    previewViewFov = DEFAULT_PREVIEW_VIEW_FOV
    await resetKitchenPreviewCamera()
  }

  async function resetLibraryPreviewAll() {
    previewViewFov = DEFAULT_PREVIEW_VIEW_FOV
    const engine = await ensureLibraryPreviewReady()
    engine?.resetView()
  }

  function toggleMotionSection(section: 'moods' | 'emotes') {
    if (section === 'moods') {
      const next = !moodsOpen
      moodsOpen = next
      emotesOpen = false
      if (next) {
        disabledMoodsOpen = false
      } else {
        openMoodName = null
        disabledMoodsOpen = false
      }
      openEmoteName = null
      disabledEmotesOpen = false
      return
    }
    if (section === 'emotes') {
      const next = !emotesOpen
      emotesOpen = next
      moodsOpen = false
      if (next) {
        disabledEmotesOpen = false
      } else {
        openEmoteName = null
        disabledEmotesOpen = false
      }
      openMoodName = null
      disabledMoodsOpen = false
      return
    }
  }

  // ------------------------------------------ appearance dials v2 (SA-090)
  let editorAppearanceDialsManifest = $state<AppearanceDialsManifest | null>(null)
  let editorAppearanceDialsState = $state<AppearanceDialValueState | null>(null)
  let editorAppearanceDialsError = $state('')
  let editorAppearanceDialsNotice = $state('')
  let editorAppearanceDialsLoadToken = 0
  // Deliberately non-reactive: hydration bookkeeping, never rendered.
  let editorAppearanceDialsHydrationKey = ''
  let editorAppearanceDialsStoredSignature = ''

  function reconcileEditorAppearanceDials(
    manifest: AppearanceDialsManifest,
    stored: unknown
  ): AppearanceDialValueState {
    const result = reconcileAppearanceDialValues(manifest, stored)
    if (result.incompatible) {
      editorAppearanceDialsNotice =
        'Saved Appearance Dials did not match this package definition and were reset to neutral.'
    } else {
      const adjustedCount =
        result.prunedIds.length +
        result.prunedUnlockIds.length +
        result.clampedIds.length +
        result.resetIds.length
      editorAppearanceDialsNotice = adjustedCount
        ? `${adjustedCount} saved Appearance Dial ${adjustedCount === 1 ? 'entry was' : 'entries were'} reconciled with this package.`
        : ''
    }
    return result.state
  }

  // Hydration is keyed by goon id + manifest URL, NOT the goon object
  // reference: background PUTs on the edited goon (for example compatibility
  // reports) can replace the store object while the user works and must not
  // remount the dial editor or clobber an unsaved draft. Camera-only writes
  // intentionally bypass that global-store replacement.
  $effect(() => {
    const goon = editorRecipeSourceGoon
    const isCustom = Boolean(goon && resolveGoonKind(goon) === 'custom')
    const manifestRef = isCustom ? goon?.customAvatar?.manifest : null
    const hydrationKey =
      goon && manifestRef?.url ? `${goon.id}::${manifestRef.url}` : ''
    const storedDials = isCustom ? goon?.appearanceDials ?? null : null
    const storedSignature = JSON.stringify(storedDials ?? null)

    if (!hydrationKey || !manifestRef?.url) {
      editorAppearanceDialsHydrationKey = ''
      editorAppearanceDialsStoredSignature = ''
      editorAppearanceDialsLoadToken += 1
      editorAppearanceDialsManifest = null
      editorAppearanceDialsState = null
      editorAppearanceDialsError = ''
      editorAppearanceDialsNotice = ''
      return
    }

    if (hydrationKey === editorAppearanceDialsHydrationKey) {
      if (storedSignature === editorAppearanceDialsStoredSignature) return
      editorAppearanceDialsStoredSignature = storedSignature
      // Stored dials changed underneath the editor (our save landing, or
      // another surface writing). Reconcile only when there is no unsaved
      // draft; the user's in-progress edits always win until they save.
      if (editorDirty) return
      if (editorAppearanceDialsManifest) {
        editorAppearanceDialsState = reconcileEditorAppearanceDials(
          editorAppearanceDialsManifest,
          storedDials
        )
      }
      return
    }

    editorAppearanceDialsHydrationKey = hydrationKey
    editorAppearanceDialsStoredSignature = storedSignature
    const token = ++editorAppearanceDialsLoadToken
    editorAppearanceDialsManifest = null
    editorAppearanceDialsState = null
    editorAppearanceDialsError = ''
    editorAppearanceDialsNotice = ''
    void (async () => {
      try {
        const manifest = await loadCustomAvatarManifest(manifestRef)
        if (token !== editorAppearanceDialsLoadToken) return
        const parsed = parseAppearanceDialsManifest(manifest)
        if (token !== editorAppearanceDialsLoadToken || !parsed) return
        editorAppearanceDialsManifest = parsed
        editorAppearanceDialsState = reconcileEditorAppearanceDials(parsed, storedDials)
      } catch (error) {
        if (token !== editorAppearanceDialsLoadToken) return
        editorAppearanceDialsError = error instanceof Error ? error.message : String(error)
      }
    })()
  })

  // live-sync the dial draft onto the settings preview engine (fires on
  // fitted draft changes and when the preview finishes loading the editor
  // goon). Recipe Source previews must apply the Appearance state and its
  // matching Anatomy Fit atomically; showing either side alone can put rigid
  // assemblies visibly outside the edited body.
  $effect(() => {
    if (!previewEngine || !previewReady || previewLoading || recipePreviewTransitioning) return
    if (previewGoonId !== editorGoonId) return
    const fitted = recipeEditorPreviewTarget?.preview ?? recipeEditorDraftPreview
    if (fitted) {
      applyRecipeFittedPreviewState(fitted)
      return
    }
    if (!editorAppearanceDialsState) return
    previewEngine.setAppearanceDialValues(editorAppearanceDialsState)
  })

  function updateEditorAppearanceDials(state: AppearanceDialValueState) {
    if (JSON.stringify(editorAppearanceDialsState) === JSON.stringify(state)) return
    editorAppearanceDialsState = state
    editorAppearanceDialsNotice = ''
    editorDirty = true
  }

  // ---------------- package-bound appearance surfaces (SA-090)
  let editorFacialArtworkDefinition = $state<FacialArtworkDefinitionV4 | null>(null)
  let editorFacialArtworkState = $state<FacialArtworkStateV4 | null>(null)
  let editorEyeAppearanceDefinition = $state<EyeAppearanceDefinitionV3 | null>(null)
  let editorEyeAppearanceState = $state<EyeAppearanceStateV3 | null>(null)
  let editorOralAppearanceDefinition = $state<OralAppearanceDefinitionV1 | null>(null)
  let editorOralAppearanceState = $state<OralAppearanceStateV1 | null>(null)
  let editorLipArtworkDefinition = $state<LipArtworkDefinitionV2 | null>(null)
  let editorLipArtworkState = $state<LipArtworkStateV2 | null>(null)
  let editorLipArtworkPresence = $state<LipArtworkPresenceStateV1 | null>(null)
  let editorNailSurfaceDefinition = $state<NailSurfaceDefinitionV1 | null>(null)
  let editorNailSurfaceState = $state<NailSurfaceStateV1 | null>(null)
  let editorNailSurfacePresence = $state<NailSurfacePresenceStateV1 | null>(null)
  let editorSkinAppearanceDefinition = $state<SkinAppearanceDefinitionV1 | null>(null)
  let editorSkinAppearanceState = $state<SkinAppearanceStateV2 | null>(null)
  let editorFacialArtworkHydrated = $state(false)
  let editorFacialArtworkError = $state('')
  let editorFacialArtworkPackageNotice = $state('')
  let editorFacialArtworkNotice = $state('')
  let editorEyeAppearanceNotice = $state('')
  let editorOralAppearanceNotice = $state('')
  let editorLipArtworkNotice = $state('')
  let editorNailSurfaceNotice = $state('')
  let editorNailSurfaceError = $state('')
  let editorSkinAppearanceNotice = $state('')
  let editorSkinAppearanceError = $state('')
  let editorFacialArtworkPreviewError = $state('')
  let editorNailSurfacePreviewError = $state('')
  let editorSkinAppearancePreviewError = $state('')
  let editorFacialArtworkLoadToken = 0
  let editorFacialArtworkPreviewToken = 0
  let editorNailSurfacePreviewToken = 0
  let editorSkinAppearancePreviewToken = 0
  let editorFacialArtworkPreviewTimer: ReturnType<typeof setTimeout> | null = null
  let editorNailSurfacePreviewTimer: ReturnType<typeof setTimeout> | null = null
  let editorSkinAppearancePreviewTimer: ReturnType<typeof setTimeout> | null = null
  // Deliberately non-reactive ownership bookkeeping. Draft bytes become saved
  // only after the Goon PUT succeeds.
  let editorFacialArtworkHydrationKey = ''
  let editorFacialArtworkStoredSignature = ''
  const editorFacialArtworkDraftUploads = new Map<string, FacialArtworkUpload>()
  const editorLipArtworkDraftUploads = new Map<string, LipArtworkUpload>()
  const editorNailArtworkDraftUploads = new Map<string, NailArtworkUploadV1>()
  const editorSkinSurfaceDraftUploads = new Map<string, SkinSurfaceUploadV1>()

  function applyStoredFacialArtworkDraft(
    definition: FacialArtworkDefinitionV4,
    stored: FacialArtworkStateV4 | null | undefined
  ) {
    const restored = restoreFacialArtworkDraft(definition, stored)
    editorFacialArtworkState = restored.state
    editorFacialArtworkPreviewError = ''
    editorFacialArtworkNotice = restored.incompatible
      ? 'Saved Facial Artwork did not match this package definition and was reset to package defaults.'
      : ''
  }

  function applyStoredEyeAppearanceDraft(
    definition: EyeAppearanceDefinitionV3,
    stored: EyeAppearanceStateV3 | null | undefined
  ) {
    const reconciliation = reconcileEyeAppearanceState(definition, stored)
    editorEyeAppearanceState = reconciliation.state
      ? structuredClone(reconciliation.state)
      : createDefaultEyeAppearanceState(definition)
    editorEyeAppearanceNotice = reconciliation.incompatible
      ? 'Saved Eye Appearance controls did not match this package definition and were reset to the package-fitted result.'
      : ''
  }

  function applyStoredOralAppearanceDraft(
    definition: OralAppearanceDefinitionV1,
    stored: OralAppearanceStateV1 | null | undefined
  ) {
    const reconciliation = reconcileOralAppearanceState(definition, stored)
    editorOralAppearanceState = reconciliation.state
      ? structuredClone(reconciliation.state)
      : createDefaultOralAppearanceState(definition)
    editorOralAppearanceNotice = reconciliation.incompatible
      ? 'Saved Oral Appearance controls did not match this package definition and were reset to the authored materials.'
      : ''
  }

  function applyStoredLipArtworkDraft(
    definition: LipArtworkDefinitionV2,
    stored: LipArtworkStateV2 | null | undefined
  ) {
    const reconciliation = reconcileLipArtworkState(definition, stored)
    editorLipArtworkState = reconciliation.state
      ? structuredClone(reconciliation.state)
      : null
    editorLipArtworkNotice = reconciliation.incompatible
      ? 'Saved Lip Artwork did not match this package definition and was reset to the package artwork.'
      : ''
  }

  function applyStoredLipArtworkPresence(
    definition: LipArtworkDefinitionV2,
    stored: LipArtworkPresenceStateV1 | null | undefined
  ) {
    try {
      editorLipArtworkPresence = stored
        ? parseLipArtworkPresenceState(definition, stored)
        : null
    } catch {
      editorLipArtworkPresence = null
      editorLipArtworkNotice = 'Saved Lip Artwork visibility did not match this package and was reset to on.'
    }
  }

  function applyStoredNailSurfaceDraft(
    definition: NailSurfaceDefinitionV1,
    stored: NailSurfaceStateV1 | null | undefined
  ) {
    const reconciliation = reconcileNailSurfaceState(definition, stored)
    editorNailSurfaceState = reconciliation.state
      ? structuredClone(reconciliation.state)
      : createDefaultNailSurfaceState(definition)
    editorNailSurfaceNotice = reconciliation.incompatible
      ? 'Saved Nail Surface controls did not match this package definition and were reset to package defaults.'
      : ''
    editorNailSurfacePreviewError = ''
  }

  function applyStoredNailSurfacePresence(
    definition: NailSurfaceDefinitionV1,
    stored: NailSurfacePresenceStateV1 | null | undefined
  ) {
    try {
      editorNailSurfacePresence = stored
        ? parseNailSurfacePresenceState(definition, stored)
        : null
    } catch {
      editorNailSurfacePresence = null
      editorNailSurfaceNotice = 'Saved Nail Surface visibility did not match this package and was reset to on.'
    }
  }

  function applyStoredSkinAppearanceDraft(
    definition: SkinAppearanceDefinitionV1,
    stored: unknown,
    legacyMaterialArtwork: unknown = null
  ) {
    const reconciliation = reconcileSkinAppearanceState(
      definition,
      stored,
      legacyMaterialArtwork
    )
    editorSkinAppearanceState = reconciliation.state
      ? structuredClone(reconciliation.state)
      : createDefaultSkinAppearanceState(definition)
    editorSkinAppearanceNotice = reconciliation.incompatible
      ? `Saved Skin Appearance could not be migrated and was reset to package defaults. ${reconciliation.reason ?? ''}`.trim()
      : ''
    editorSkinAppearancePreviewError = ''
  }

  function restorePackageOwnedEditorDrafts(goon: GoonRecord) {
    if (editorAppearanceDialsManifest) {
      const storedDials = goon.appearanceDials ?? null
      editorAppearanceDialsStoredSignature = JSON.stringify(storedDials)
      editorAppearanceDialsState = reconcileEditorAppearanceDials(
        editorAppearanceDialsManifest,
        storedDials
      )
      editorAppearanceDialsError = ''
    }
    if (editorFacialArtworkDefinition) {
      editorFacialArtworkStoredSignature = JSON.stringify({
        storedArtwork: goon.facialArtwork ?? null,
        storedEyeAppearance: goon.eyeAppearance ?? null,
        storedOralAppearance: goon.oralAppearance ?? null,
        storedLipArtwork: goon.lipArtwork ?? null,
        storedNailSurface: goon.nailSurface ?? null,
        storedSkinAppearance: goon.skinAppearance ?? null,
        storedSkinMaterialArtwork: goon.skinMaterialArtwork ?? null
      })
      applyStoredFacialArtworkDraft(
        editorFacialArtworkDefinition,
        goon.facialArtwork ?? null
      )
      editorFacialArtworkError = ''
      editorFacialArtworkHydrated = true
    }
    if (editorEyeAppearanceDefinition) {
      applyStoredEyeAppearanceDraft(
        editorEyeAppearanceDefinition,
        goon.eyeAppearance ?? null
      )
    }
    if (editorOralAppearanceDefinition) {
      applyStoredOralAppearanceDraft(
        editorOralAppearanceDefinition,
        goon.oralAppearance ?? null
      )
    }
    if (editorLipArtworkDefinition) {
      applyStoredLipArtworkDraft(editorLipArtworkDefinition, goon.lipArtwork ?? null)
    }
    if (editorNailSurfaceDefinition) {
      applyStoredNailSurfaceDraft(editorNailSurfaceDefinition, goon.nailSurface ?? null)
    }
    if (editorSkinAppearanceDefinition) {
      applyStoredSkinAppearanceDraft(
        editorSkinAppearanceDefinition,
        goon.skinAppearance ?? null,
        goon.skinMaterialArtwork ?? null
      )
    }
  }

  function clearFacialArtworkPreviewTimer() {
    if (editorFacialArtworkPreviewTimer) clearTimeout(editorFacialArtworkPreviewTimer)
    editorFacialArtworkPreviewTimer = null
  }

  function clearNailSurfacePreviewTimer() {
    if (editorNailSurfacePreviewTimer) clearTimeout(editorNailSurfacePreviewTimer)
    editorNailSurfacePreviewTimer = null
  }

  function clearSkinAppearancePreviewTimer() {
    if (editorSkinAppearancePreviewTimer) clearTimeout(editorSkinAppearancePreviewTimer)
    editorSkinAppearancePreviewTimer = null
  }

  function resolveFacialArtworkDraftForSave(): FacialArtworkStateV4 | null {
    if (!editorFacialArtworkHydrated || !editorFacialArtworkDefinition || !editorFacialArtworkState) {
      return null
    }
    const parsed = parseFacialArtworkState(
      editorFacialArtworkDefinition,
      editorFacialArtworkState
    )
    const defaults = createDefaultFacialArtworkState(editorFacialArtworkDefinition)
    return JSON.stringify(parsed) === JSON.stringify(defaults) ? null : parsed
  }

  function resolveEyeAppearanceDraftForSave(): EyeAppearanceStateV3 | null {
    if (!editorEyeAppearanceDefinition || !editorEyeAppearanceState) return null
    const parsed = parseEyeAppearanceState(
      editorEyeAppearanceDefinition,
      editorEyeAppearanceState
    )
    const defaults = createDefaultEyeAppearanceState(editorEyeAppearanceDefinition)
    return JSON.stringify(parsed) === JSON.stringify(defaults) ? null : parsed
  }

  function resolveOralAppearanceDraftForSave(): OralAppearanceStateV1 | null {
    if (!editorOralAppearanceDefinition || !editorOralAppearanceState) return null
    const parsed = parseOralAppearanceState(
      editorOralAppearanceDefinition,
      editorOralAppearanceState
    )
    const defaults = createDefaultOralAppearanceState(editorOralAppearanceDefinition)
    return JSON.stringify(parsed) === JSON.stringify(defaults) ? null : parsed
  }

  function resolveLipArtworkDraftForSave(): LipArtworkStateV2 | null {
    if (!editorLipArtworkDefinition || !editorLipArtworkState) return null
    return parseLipArtworkState(editorLipArtworkDefinition, editorLipArtworkState)
  }

  function resolveLipArtworkPresenceDraftForSave(): LipArtworkPresenceStateV1 | null {
    if (!editorLipArtworkDefinition || !editorLipArtworkPresence) return null
    return parseLipArtworkPresenceState(
      editorLipArtworkDefinition,
      editorLipArtworkPresence
    )
  }

  function resolveNailSurfaceDraftForSave(): NailSurfaceStateV1 | null {
    if (!editorNailSurfaceDefinition || !editorNailSurfaceState) return null
    const parsed = parseNailSurfaceState(editorNailSurfaceDefinition, editorNailSurfaceState)
    const defaults = createDefaultNailSurfaceState(editorNailSurfaceDefinition)
    return JSON.stringify(parsed) === JSON.stringify(defaults) ? null : parsed
  }

  function resolveNailSurfacePresenceDraftForSave(): NailSurfacePresenceStateV1 | null {
    if (!editorNailSurfaceDefinition || !editorNailSurfacePresence) return null
    return parseNailSurfacePresenceState(
      editorNailSurfaceDefinition,
      editorNailSurfacePresence
    )
  }

  function resolveSkinAppearanceDraftForSave(): SkinAppearanceStateV2 | null {
    if (!editorSkinAppearanceDefinition || !editorSkinAppearanceState) return null
    const parsed = parseSkinAppearanceState(
      editorSkinAppearanceDefinition,
      editorSkinAppearanceState
    )
    return countChangedSkinAppearanceControls(editorSkinAppearanceDefinition, parsed) === 0
      ? null
      : parsed
  }

  async function deleteFacialArtworkDraft(upload: FacialArtworkUpload) {
    if (!editorGoonId) return
    await deleteGoonFacialArtwork(editorGoonId, upload.filename)
    editorFacialArtworkDraftUploads.delete(upload.filename)
  }

  async function pruneDetachedFacialArtworkDrafts(state: FacialArtworkStateV4 | null) {
    const referenced = new Set(collectFacialArtworkUploads(state).map((upload) => upload.filename))
    for (const upload of [...editorFacialArtworkDraftUploads.values()]) {
      if (referenced.has(upload.filename)) continue
      try {
        await deleteFacialArtworkDraft(upload)
      } catch (error) {
        console.warn('[GoonsSettings] Failed to delete detached facial-artwork draft:', error)
      }
    }
  }

  async function discardFacialArtworkDraftUploads() {
    const goonId = editorGoonId
    const drafts = [...editorFacialArtworkDraftUploads.values()]
    const lipDrafts = [...editorLipArtworkDraftUploads.values()]
    const nailDrafts = [...editorNailArtworkDraftUploads.values()]
    const skinSurfaceDrafts = [...editorSkinSurfaceDraftUploads.values()]
    editorFacialArtworkDraftUploads.clear()
    editorLipArtworkDraftUploads.clear()
    editorNailArtworkDraftUploads.clear()
    editorSkinSurfaceDraftUploads.clear()
    if (!goonId) return
    for (const upload of drafts) {
      try {
        await deleteGoonFacialArtwork(goonId, upload.filename)
      } catch (error) {
        console.warn('[GoonsSettings] Failed to delete discarded facial-artwork draft:', error)
      }
    }
    for (const upload of lipDrafts) {
      try {
        await deleteGoonLipArtwork(goonId, upload.filename)
      } catch (error) {
        console.warn('[GoonsSettings] Failed to delete discarded Lip Artwork draft:', error)
      }
    }
    for (const upload of nailDrafts) {
      try {
        await deleteGoonNailArtwork(goonId, upload.filename)
      } catch (error) {
        console.warn('[GoonsSettings] Failed to delete discarded Nail Artwork draft:', error)
      }
    }
    for (const upload of skinSurfaceDrafts) {
      try {
        await deleteGoonSkinSurfaceArtwork(goonId, upload.filename)
      } catch (error) {
        console.warn('[GoonsSettings] Failed to delete discarded Skin Surface draft:', error)
      }
    }
  }

  async function reconcileFacialArtworkUploadsAfterSave(
    previous: FacialArtworkStateV4 | null | undefined,
    saved: FacialArtworkStateV4 | null | undefined
  ) {
    const retained = new Set(collectFacialArtworkUploads(saved).map((upload) => upload.filename))
    const candidates = new Map<string, FacialArtworkUpload>()
    for (const upload of collectFacialArtworkUploads(previous)) candidates.set(upload.filename, upload)
    for (const upload of editorFacialArtworkDraftUploads.values()) {
      candidates.set(upload.filename, upload)
    }
    editorFacialArtworkDraftUploads.clear()
    for (const upload of candidates.values()) {
      if (retained.has(upload.filename)) continue
      try {
        await deleteGoonFacialArtwork(editorGoonId!, upload.filename)
      } catch (error) {
        console.warn('[GoonsSettings] Saved facial artwork, but an unused upload remains:', error)
        toast.warning('Facial Artwork saved, but an unused PNG could not be cleaned up.')
      }
    }
  }

  async function reconcileLipArtworkUploadsAfterSave(
    previous: LipArtworkStateV2 | null | undefined,
    saved: LipArtworkStateV2 | null | undefined
  ) {
    const retained = saved?.artwork.filename ?? null
    const candidates = new Map<string, LipArtworkUpload>()
    if (previous?.artwork) candidates.set(previous.artwork.filename, previous.artwork)
    for (const upload of editorLipArtworkDraftUploads.values()) {
      candidates.set(upload.filename, upload)
    }
    editorLipArtworkDraftUploads.clear()
    for (const upload of candidates.values()) {
      if (upload.filename === retained) continue
      try {
        await deleteGoonLipArtwork(editorGoonId!, upload.filename)
      } catch (error) {
        console.warn('[GoonsSettings] Saved Lip Artwork, but an unused upload remains:', error)
        toast.warning('Lip Artwork saved, but an unused PNG could not be cleaned up.')
      }
    }
  }

  async function reconcileNailArtworkUploadsAfterSave(
    previous: NailSurfaceStateV1 | null | undefined,
    saved: NailSurfaceStateV1 | null | undefined
  ) {
    const retained = new Set(
      (['fingers', 'toes'] as const)
        .map((family) => saved?.appearance[family].artwork?.filename)
        .filter((filename): filename is string => Boolean(filename))
    )
    const candidates = new Map<string, NailArtworkUploadV1>()
    for (const family of ['fingers', 'toes'] as const) {
      const upload = previous?.appearance[family].artwork
      if (upload) candidates.set(upload.filename, upload)
    }
    for (const upload of editorNailArtworkDraftUploads.values()) {
      candidates.set(upload.filename, upload)
    }
    editorNailArtworkDraftUploads.clear()
    for (const upload of candidates.values()) {
      if (retained.has(upload.filename)) continue
      try {
        await deleteGoonNailArtwork(editorGoonId!, upload.filename)
      } catch (error) {
        console.warn('[GoonsSettings] Saved Nail Surface, but an unused upload remains:', error)
        toast.warning('Nail Surface saved, but an unused PNG could not be cleaned up.')
      }
    }
  }

  async function reconcileSkinSurfaceUploadsAfterSave(
    previous: SkinAppearanceStateV2 | null | undefined,
    saved: SkinAppearanceStateV2 | null | undefined
  ) {
    const retained = new Set(
      collectSkinSurfaceUploads(saved).map((upload) => upload.filename)
    )
    const candidates = new Map<string, SkinSurfaceUploadV1>()
    for (const upload of collectSkinSurfaceUploads(previous)) {
      candidates.set(upload.filename, upload)
    }
    for (const upload of editorSkinSurfaceDraftUploads.values()) {
      candidates.set(upload.filename, upload)
    }
    editorSkinSurfaceDraftUploads.clear()
    for (const upload of candidates.values()) {
      if (retained.has(upload.filename)) continue
      try {
        await deleteGoonSkinSurfaceArtwork(editorGoonId!, upload.filename)
      } catch (error) {
        console.warn('[GoonsSettings] Saved Skin Surface, but an unused upload remains:', error)
        toast.warning('Skin Surface saved, but an unused PNG could not be cleaned up.')
      }
    }
  }

  async function uploadEditorFacialArtwork(
    roleId: FacialArtworkRoleId,
    file: File,
    provenance: FacialArtworkProvenance,
    orientation: FacialArtworkOrientation
  ) {
    if (!editorGoonId || !editorFacialArtworkDefinition) {
      throw new Error('Facial Artwork is not ready for this Goon.')
    }
    const role = editorFacialArtworkDefinition.roles.find((candidate) => candidate.id === roleId)
    const template = editorFacialArtworkDefinition.templates.find(
      (candidate) => candidate.id === role?.template
    )
    if (!role || !template) throw new Error('The selected facial-artwork template is unavailable.')
    const variant = resolveFacialArtworkTemplateVariant(template, orientation)
    const upload = await uploadGoonFacialArtwork(editorGoonId, file, {
      role: role.id,
      definitionSha256: editorFacialArtworkDefinition.definitionSha256,
      templateId: template.id,
      templateVersion: template.version,
      orientation,
      guideSha256: variant.guide.sha256,
      maskSha256: variant.safePaintMask.sha256,
      provenance
    })
    editorFacialArtworkDraftUploads.set(upload.filename, upload)
    return upload
  }

  async function uploadEditorLipArtwork(file: File, provenance: FacialArtworkProvenance) {
    if (!editorGoonId || !editorLipArtworkDefinition) {
      throw new Error('Lip Artwork is not ready for this Goon.')
    }
    const upload = await uploadGoonLipArtwork(editorGoonId, file, {
      definitionSha256: editorLipArtworkDefinition.definitionSha256,
      provenance
    })
    editorLipArtworkDraftUploads.set(upload.filename, upload)
    return upload
  }

  async function uploadEditorNailArtwork(
    family: NailFamily,
    file: File,
    provenance: FacialArtworkProvenance
  ) {
    if (!editorGoonId || !editorNailSurfaceDefinition) {
      throw new Error('Nail Artwork is not ready for this Goon.')
    }
    const upload = await uploadGoonNailArtwork(editorGoonId, file, {
      family,
      definitionSha256: editorNailSurfaceDefinition.definitionSha256,
      provenance
    })
    editorNailArtworkDraftUploads.set(upload.filename, upload)
    return upload
  }

  async function uploadEditorSkinSurfaceArtwork(
    map: SkinSurfaceMapRole,
    file: File,
    provenance: FacialArtworkProvenance
  ) {
    if (!editorGoonId || !editorSkinAppearanceDefinition) {
      throw new Error('Skin Surface Artwork is not ready for this Goon.')
    }
    const upload = await uploadGoonSkinSurfaceArtwork(editorGoonId, file, {
      map,
      definitionSha256: editorSkinAppearanceDefinition.definitionSha256,
      provenance
    })
    editorSkinSurfaceDraftUploads.set(upload.filename, upload)
    return upload
  }

  function updateEditorFacialArtwork(state: FacialArtworkStateV4) {
    if (!editorFacialArtworkDefinition) return
    const parsed = parseFacialArtworkState(editorFacialArtworkDefinition, state)
    if (JSON.stringify(editorFacialArtworkState) === JSON.stringify(parsed)) return
    editorFacialArtworkState = parsed
    editorFacialArtworkNotice = ''
    editorFacialArtworkPreviewError = ''
    editorDirty = true
    void pruneDetachedFacialArtworkDrafts(parsed)
  }

  function updateEditorEyeAppearance(state: EyeAppearanceStateV3) {
    if (!editorEyeAppearanceDefinition) return
    const parsed = parseEyeAppearanceState(editorEyeAppearanceDefinition, state)
    if (JSON.stringify(editorEyeAppearanceState) === JSON.stringify(parsed)) return
    editorEyeAppearanceState = parsed
    editorEyeAppearanceNotice = ''
    editorFacialArtworkPreviewError = ''
    editorDirty = true
  }

  function updateEditorOralAppearance(state: OralAppearanceStateV1) {
    if (!editorOralAppearanceDefinition) return
    const parsed = parseOralAppearanceState(editorOralAppearanceDefinition, state)
    if (JSON.stringify(editorOralAppearanceState) === JSON.stringify(parsed)) return
    editorOralAppearanceState = parsed
    editorOralAppearanceNotice = ''
    editorFacialArtworkPreviewError = ''
    editorDirty = true
  }

  function updateEditorLipArtwork(state: LipArtworkStateV2 | null) {
    const parsed =
      state && editorLipArtworkDefinition
        ? parseLipArtworkState(editorLipArtworkDefinition, state)
        : null
    if (JSON.stringify(editorLipArtworkState) === JSON.stringify(parsed)) return
    const detached = editorLipArtworkState?.artwork
    editorLipArtworkState = parsed
    editorLipArtworkNotice = ''
    editorFacialArtworkPreviewError = ''
    editorDirty = true
    if (detached && detached.filename !== parsed?.artwork.filename) {
      const draft = editorLipArtworkDraftUploads.get(detached.filename)
      if (draft && editorGoonId) {
        void deleteGoonLipArtwork(editorGoonId, draft.filename)
          .then(() => editorLipArtworkDraftUploads.delete(draft.filename))
          .catch((error) =>
            console.warn('[GoonsSettings] Failed to delete detached Lip Artwork draft:', error)
          )
      }
    }
  }

  function updateEditorLipArtworkPresence(enabled: boolean) {
    if (!editorLipArtworkDefinition) return
    const next = enabled
      ? null
      : createLipArtworkPresenceState(editorLipArtworkDefinition, false)
    if (JSON.stringify(editorLipArtworkPresence) === JSON.stringify(next)) return
    editorLipArtworkPresence = next
    editorLipArtworkNotice = ''
    editorFacialArtworkPreviewError = ''
    editorDirty = true
  }

  function updateEditorNailSurface(state: NailSurfaceStateV1) {
    if (!editorNailSurfaceDefinition) return
    const parsed = parseNailSurfaceState(editorNailSurfaceDefinition, state)
    if (JSON.stringify(editorNailSurfaceState) === JSON.stringify(parsed)) return
    const detached = new Map<string, NailArtworkUploadV1>()
    for (const family of ['fingers', 'toes'] as const) {
      const upload = editorNailSurfaceState?.appearance[family].artwork
      if (upload && upload.filename !== parsed.appearance[family].artwork?.filename) {
        detached.set(upload.filename, upload)
      }
    }
    editorNailSurfaceState = parsed
    editorNailSurfaceNotice = ''
    editorNailSurfacePreviewError = ''
    editorDirty = true
    for (const upload of detached.values()) {
      const draft = editorNailArtworkDraftUploads.get(upload.filename)
      if (draft && editorGoonId) {
        void deleteGoonNailArtwork(editorGoonId, draft.filename)
          .then(() => editorNailArtworkDraftUploads.delete(draft.filename))
          .catch((error) =>
            console.warn('[GoonsSettings] Failed to delete detached Nail Artwork draft:', error)
          )
      }
    }
  }

  function updateEditorNailSurfacePresence(enabled: boolean) {
    if (!editorNailSurfaceDefinition) return
    const next = enabled
      ? null
      : createNailSurfacePresenceState(editorNailSurfaceDefinition, false)
    if (JSON.stringify(editorNailSurfacePresence) === JSON.stringify(next)) return
    editorNailSurfacePresence = next
    editorNailSurfaceNotice = ''
    editorNailSurfacePreviewError = ''
    editorDirty = true
  }

  function updateEditorSkinAppearance(state: SkinAppearanceStateV2) {
    if (!editorSkinAppearanceDefinition) return
    const parsed = parseSkinAppearanceState(editorSkinAppearanceDefinition, state)
    if (JSON.stringify(editorSkinAppearanceState) === JSON.stringify(parsed)) return
    const retained = new Set(
      collectSkinSurfaceUploads(parsed).map((upload) => upload.filename)
    )
    const detached = collectSkinSurfaceUploads(editorSkinAppearanceState).filter(
      (upload) => !retained.has(upload.filename)
    )
    editorSkinAppearanceState = parsed
    editorSkinAppearanceNotice = ''
    editorSkinAppearancePreviewError = ''
    editorDirty = true
    for (const upload of detached) {
      const draft = editorSkinSurfaceDraftUploads.get(upload.filename)
      if (draft && editorGoonId) {
        void deleteGoonSkinSurfaceArtwork(editorGoonId, draft.filename)
          .then(() => editorSkinSurfaceDraftUploads.delete(draft.filename))
          .catch((error) =>
            console.warn(
              '[GoonsSettings] Failed to delete detached Skin Surface draft:',
              error
            )
          )
      }
    }
  }

  function skinAppearanceControlForAppearanceRegion(
    regionId: string
  ): SkinAppearanceRegionId | null {
    if (regionId === 'body.chest') return 'nipplesAreolae'
    if (regionId === 'body.hands-feet') return 'palmsSoles'
    if (regionId === 'face.cheeks') return 'cheekBlush'
    return null
  }

  function resetEditorSkinAppearanceRegion(regionId: string) {
    if (!editorSkinAppearanceDefinition || !editorSkinAppearanceState) return
    if (regionId === 'body.skin') {
      const defaults = createDefaultSkinAppearanceState(editorSkinAppearanceDefinition)
      updateEditorSkinAppearance({
        ...editorSkinAppearanceState,
        surface: structuredClone(defaults.surface)
      })
      return
    }
    const controlId = skinAppearanceControlForAppearanceRegion(regionId)
    if (!controlId) return
    const defaultRegion =
      createDefaultSkinAppearanceState(editorSkinAppearanceDefinition).regions[controlId]
    updateEditorSkinAppearance(
      updateSkinAppearanceRegion(
        editorSkinAppearanceDefinition,
        editorSkinAppearanceState,
        controlId,
        structuredClone(defaultRegion)
      )
    )
  }

  function resetEditorOralAppearance(regionId: string) {
    if (regionId === 'face.cheeks') {
      resetEditorSkinAppearanceRegion(regionId)
      return
    }
    if (regionId === 'face.mouth-lips' && editorOralAppearanceDefinition) {
      updateEditorOralAppearance(createDefaultOralAppearanceState(editorOralAppearanceDefinition))
    }
    if (regionId === 'face.mouth-lips' && editorLipArtworkDefinition) {
      updateEditorLipArtwork(null)
      updateEditorLipArtworkPresence(true)
    }
  }

  function resetEditorNailSurface(regionId: string) {
    if (regionId === 'body.hands-feet' && editorNailSurfaceDefinition) {
      updateEditorNailSurface(createDefaultNailSurfaceState(editorNailSurfaceDefinition))
      updateEditorNailSurfacePresence(true)
    }
    resetEditorSkinAppearanceRegion(regionId)
  }

  const editorOralAppearanceChangedCount = $derived.by(() => {
    if (!editorOralAppearanceDefinition || !editorOralAppearanceState) return 0
    return countChangedOralAppearanceControls(
      editorOralAppearanceDefinition,
      editorOralAppearanceState
    )
  })

  const editorNailSurfaceChangedCount = $derived.by(() => {
    if (!editorNailSurfaceDefinition || !editorNailSurfaceState) return 0
    return countChangedNailSurfaceControls(
      editorNailSurfaceDefinition,
      editorNailSurfaceState
    ) + (editorNailSurfacePresence ? 1 : 0)
  })

  function editorSkinAppearanceChangedCount(regionId: string) {
    if (!editorSkinAppearanceState) return 0
    if (regionId === 'body.skin' && editorSkinAppearanceDefinition) {
      const defaults = createDefaultSkinAppearanceState(editorSkinAppearanceDefinition)
      return Object.keys(editorSkinAppearanceState.surface).filter((role) =>
        JSON.stringify(
          editorSkinAppearanceState!.surface[
            role as keyof SkinAppearanceStateV2['surface']
          ]
        ) !==
        JSON.stringify(
          defaults.surface[role as keyof SkinAppearanceStateV2['surface']]
        )
      ).length
    }
    const controlId = skinAppearanceControlForAppearanceRegion(regionId)
    return controlId && editorSkinAppearanceState.regions[controlId].mode !== 'inherit'
      ? 1
      : 0
  }

  const editorAppearanceRegionContentSearchText = $derived.by(() => {
    const artworkControls = [
      'artwork',
      'upload',
      'credit',
      'source',
      'color',
      'tint',
      'opacity',
      'horizontal position',
      'vertical position',
      'scale',
      'rotation',
      'left',
      'right',
      'shared'
    ].join(' ')
    const eyeControls = editorEyeAppearanceDefinition?.controls
      .flatMap((control) => [control.id, control.label, control.description])
      .join(' ')
    const oralControls = editorOralAppearanceDefinition?.controls
      .flatMap((control) => [control.id, control.label, control.description])
      .join(' ')

    return {
      'face.brows': `Brow Artwork eyebrows ${artworkControls}`,
      'face.eyes': [
        'Lash Outline Iris Pupil Eye Highlight Sclera Eye Artwork',
        artworkControls,
        eyeControls ?? ''
      ].join(' '),
      'face.mouth-lips': `Oral Appearance Lip Artwork upload PNG template lip color opacity teeth gums tongue ${oralControls ?? ''}`,
      'face.cheeks': 'Cheek Blush color package inherit off true off custom skin appearance',
      'body.skin': 'Base Color Artwork tint albedo Normal Map strength Roughness Metallic metal cyborg UV texture upload PNG package custom none skin appearance',
      'body.chest': 'Nipples Areolae color package inherit custom skin appearance',
      'body.hands-feet':
        'Palms Soles skin color package inherit custom Nails Fingernails Toenails length width narrow fantasy claw shape round soft square almond pointed arch left right straight toe free edge color finish natural matte glossy artwork PNG template cuticle growth tip'
    }
  })

  $effect(() => {
    const goon = editorRecipeSourceGoon
    const isCustom = Boolean(goon && resolveGoonKind(goon) === 'custom')
    const manifestRef = isCustom ? goon?.customAvatar?.manifest : null
    const hydrationKey = goon && manifestRef?.url ? `${goon.id}::${manifestRef.url}` : ''
    const storedArtwork = isCustom ? goon?.facialArtwork ?? null : null
    const storedEyeAppearance = isCustom ? goon?.eyeAppearance ?? null : null
    const storedOralAppearance = isCustom ? goon?.oralAppearance ?? null : null
    const storedLipArtwork = isCustom ? goon?.lipArtwork ?? null : null
    const storedLipArtworkPresence = isCustom ? goon?.lipArtworkPresence ?? null : null
    const storedNailSurface = isCustom ? goon?.nailSurface ?? null : null
    const storedNailSurfacePresence = isCustom ? goon?.nailSurfacePresence ?? null : null
    const storedSkinAppearance = isCustom ? goon?.skinAppearance ?? null : null
    const storedSkinMaterialArtwork = isCustom ? goon?.skinMaterialArtwork ?? null : null
    const storedSocketEyeContact = isCustom ? goon?.defaults?.socketEyeContact ?? null : null
    const storedSignature = JSON.stringify({
      storedArtwork,
      storedEyeAppearance,
      storedOralAppearance,
      storedLipArtwork,
      storedLipArtworkPresence,
      storedNailSurface,
      storedNailSurfacePresence,
      storedSkinAppearance,
      storedSkinMaterialArtwork,
      storedSocketEyeContact
    })

    if (!hydrationKey || !manifestRef?.url) {
      editorFacialArtworkHydrationKey = ''
      editorFacialArtworkStoredSignature = ''
      editorFacialArtworkLoadToken += 1
      editorFacialArtworkDefinition = null
      editorFacialArtworkState = null
      editorEyeAppearanceDefinition = null
      editorEyeAppearanceState = null
      editorHasSocketEyeContact = false
      editorOralAppearanceDefinition = null
      editorOralAppearanceState = null
      editorLipArtworkDefinition = null
      editorLipArtworkState = null
      editorLipArtworkPresence = null
      editorNailSurfaceDefinition = null
      editorNailSurfaceState = null
      editorNailSurfacePresence = null
      editorSkinAppearanceDefinition = null
      editorSkinAppearanceState = null
      editorFacialArtworkHydrated = false
      editorFacialArtworkError = ''
      editorFacialArtworkPackageNotice = ''
      editorFacialArtworkNotice = ''
      editorEyeAppearanceNotice = ''
      editorOralAppearanceNotice = ''
      editorLipArtworkNotice = ''
      editorNailSurfaceNotice = ''
      editorNailSurfaceError = ''
      editorSkinAppearanceNotice = ''
      editorSkinAppearanceError = ''
      editorFacialArtworkPreviewError = ''
      editorNailSurfacePreviewError = ''
      editorSkinAppearancePreviewError = ''
      return
    }

    if (hydrationKey === editorFacialArtworkHydrationKey) {
      if (storedSignature === editorFacialArtworkStoredSignature) return
      if (editorDirty || !editorFacialArtworkDefinition || !editorEyeAppearanceDefinition) return
      editorFacialArtworkStoredSignature = storedSignature
      applyStoredFacialArtworkDraft(editorFacialArtworkDefinition, storedArtwork)
      applyStoredEyeAppearanceDraft(editorEyeAppearanceDefinition, storedEyeAppearance)
      editorSocketEyeContact = resolveSocketEyeContactSettings(storedSocketEyeContact)
      previewEngine?.setSocketEyeContactSettings(editorSocketEyeContact)
      if (editorOralAppearanceDefinition) {
        applyStoredOralAppearanceDraft(editorOralAppearanceDefinition, storedOralAppearance)
      }
      if (editorLipArtworkDefinition) {
        applyStoredLipArtworkDraft(editorLipArtworkDefinition, storedLipArtwork)
        applyStoredLipArtworkPresence(editorLipArtworkDefinition, storedLipArtworkPresence)
      }
      if (editorNailSurfaceDefinition) {
        applyStoredNailSurfaceDraft(editorNailSurfaceDefinition, storedNailSurface)
        applyStoredNailSurfacePresence(editorNailSurfaceDefinition, storedNailSurfacePresence)
      }
      if (editorSkinAppearanceDefinition) {
        applyStoredSkinAppearanceDraft(
          editorSkinAppearanceDefinition,
          storedSkinAppearance,
          storedSkinMaterialArtwork
        )
      }
      return
    }

    editorFacialArtworkHydrationKey = hydrationKey
    editorFacialArtworkStoredSignature = storedSignature
    const token = ++editorFacialArtworkLoadToken
    editorFacialArtworkDefinition = null
    editorFacialArtworkState = null
    editorEyeAppearanceDefinition = null
    editorEyeAppearanceState = null
    editorHasSocketEyeContact = false
    editorOralAppearanceDefinition = null
    editorOralAppearanceState = null
    editorLipArtworkDefinition = null
    editorLipArtworkState = null
    editorLipArtworkPresence = null
    editorNailSurfaceDefinition = null
    editorNailSurfaceState = null
    editorNailSurfacePresence = null
    editorSkinAppearanceDefinition = null
    editorSkinAppearanceState = null
    editorFacialArtworkHydrated = false
    editorFacialArtworkError = ''
    editorFacialArtworkPackageNotice = ''
    editorFacialArtworkNotice = ''
    editorEyeAppearanceNotice = ''
    editorOralAppearanceNotice = ''
    editorLipArtworkNotice = ''
    editorNailSurfaceNotice = ''
    editorNailSurfaceError = ''
    editorSkinAppearanceNotice = ''
    editorSkinAppearanceError = ''
    editorFacialArtworkPreviewError = ''
    editorNailSurfacePreviewError = ''
    editorSkinAppearancePreviewError = ''
    void (async () => {
      try {
        const manifest = await loadCustomAvatarManifest(manifestRef)
        if (token !== editorFacialArtworkLoadToken) return
        if (manifest.nailSurface !== undefined) {
          try {
            const nailDefinition = parseNailSurfaceDefinition(manifest.nailSurface)
            editorNailSurfaceDefinition = nailDefinition
            applyStoredNailSurfaceDraft(nailDefinition, storedNailSurface)
            applyStoredNailSurfacePresence(nailDefinition, storedNailSurfacePresence)
          } catch (error) {
            editorNailSurfaceError = error instanceof Error ? error.message : String(error)
          }
        }
        if (manifest.skinAppearance !== undefined) {
          try {
            const skinDefinition = parseSkinAppearanceDefinition(manifest.skinAppearance)
            editorSkinAppearanceDefinition = skinDefinition
            applyStoredSkinAppearanceDraft(
              skinDefinition,
              storedSkinAppearance,
              storedSkinMaterialArtwork
            )
          } catch (error) {
            editorSkinAppearanceError = error instanceof Error ? error.message : String(error)
          }
        }
        const socketEyePackage = parseFirstPartySocketEyePackage(manifest)
        editorHasSocketEyeContact = Boolean(socketEyePackage)
        const capability = classifyFacialArtworkPackageCapability(manifest)
        if (capability.status === 'retired') {
          editorFacialArtworkPackageNotice = capability.notice
          editorFacialArtworkHydrated = true
          return
        }
        if (capability.status === 'malformed') {
          throw new Error(capability.error)
        }
        if (capability.status === 'absent') {
          editorFacialArtworkHydrated = true
          return
        }
        if (!socketEyePackage) {
          throw new Error('The current first-party eye package tuple is incomplete.')
        }
        const definition = socketEyePackage.facialArtwork
        const eyeDefinition = socketEyePackage.eyeAppearance
        const oralDefinition = manifest.oralAppearance === undefined
          ? null
          : parseOralAppearanceDefinition(manifest.oralAppearance)
        const lipDefinition = manifest.lipArtwork === undefined
          ? null
          : parseLipArtworkDefinition(manifest.lipArtwork)
        if (token !== editorFacialArtworkLoadToken) return
        editorFacialArtworkDefinition = definition
        editorEyeAppearanceDefinition = eyeDefinition
        editorOralAppearanceDefinition = oralDefinition
        editorLipArtworkDefinition = lipDefinition
        applyStoredFacialArtworkDraft(definition, storedArtwork)
        applyStoredEyeAppearanceDraft(eyeDefinition, storedEyeAppearance)
        if (oralDefinition) {
          applyStoredOralAppearanceDraft(oralDefinition, storedOralAppearance)
        }
        if (lipDefinition) {
          applyStoredLipArtworkDraft(lipDefinition, storedLipArtwork)
          applyStoredLipArtworkPresence(lipDefinition, storedLipArtworkPresence)
        }
        editorFacialArtworkHydrated = true
      } catch (error) {
        if (token !== editorFacialArtworkLoadToken) return
        editorFacialArtworkHydrated = true
        editorFacialArtworkError = error instanceof Error ? error.message : String(error)
      }
    })()
  })

  $effect(() => {
    const token = ++editorFacialArtworkPreviewToken
    clearFacialArtworkPreviewTimer()
    if (
      !previewEngine ||
      !previewReady ||
      previewLoading ||
      recipePreviewTransitioning ||
      previewGoonId !== editorGoonId
    ) return
    const recipePreview = recipeEditorPreviewTarget
    if (recipePreview) {
      const state = recipePreview.goon.facialArtwork
      const eyeState = recipePreview.goon.eyeAppearance
      const oralState = recipePreview.goon.oralAppearance
      const lipState = recipePreview.goon.lipArtwork
      const lipArtworkEnabled = recipePreview.goon.lipArtworkPresence?.enabled ?? true
      if (!state || !eyeState) return
      editorFacialArtworkPreviewTimer = setTimeout(() => {
        editorFacialArtworkPreviewTimer = null
        void Promise.resolve()
          .then(() => {
            previewEngine!.setEyeAppearanceState(eyeState)
            previewEngine!.setOralAppearanceState(oralState ?? null)
            return previewEngine!.setLipArtworkState(lipState ?? null)
          })
          .then(() => {
            previewEngine!.setLipArtworkEnabled(lipArtworkEnabled)
          })
          .then(() => {
            return previewEngine!.setFacialArtworkState(state)
          })
          .catch((error) => {
            if (token !== editorFacialArtworkPreviewToken) return
            editorFacialArtworkPreviewError = error instanceof Error ? error.message : String(error)
          })
      }, 90)
      return
    }
    if (
      !editorFacialArtworkDefinition ||
      !editorFacialArtworkState ||
      !editorEyeAppearanceState
    ) return
    const state = editorFacialArtworkState
    const eyeState = editorEyeAppearanceState
    const oralState = editorOralAppearanceState
    const lipState = editorLipArtworkState
    const lipArtworkEnabled = editorLipArtworkPresence?.enabled ?? true
    editorFacialArtworkPreviewTimer = setTimeout(() => {
      editorFacialArtworkPreviewTimer = null
      void Promise.resolve()
        .then(() => {
          previewEngine!.setEyeAppearanceState(eyeState)
          if (oralState) previewEngine!.setOralAppearanceState(oralState)
          return previewEngine!.setLipArtworkState(lipState)
        })
        .then(() => {
          previewEngine!.setLipArtworkEnabled(lipArtworkEnabled)
        })
        .then(() => {
          return previewEngine!.setFacialArtworkState(state)
        })
        .then(() => {
          if (token === editorFacialArtworkPreviewToken) editorFacialArtworkPreviewError = ''
        })
        .catch((error) => {
          if (token !== editorFacialArtworkPreviewToken) return
          editorFacialArtworkPreviewError = error instanceof Error ? error.message : String(error)
        })
    }, 90)
  })

  $effect(() => {
    const token = ++editorNailSurfacePreviewToken
    clearNailSurfacePreviewTimer()
    if (
      !previewEngine ||
      !previewReady ||
      previewLoading ||
      recipePreviewTransitioning ||
      previewGoonId !== editorGoonId ||
      !editorNailSurfaceDefinition
    ) return
    const state = recipeEditorPreviewTarget
      ? recipeEditorPreviewTarget.goon.nailSurface ?? null
      : editorNailSurfaceState
    const nailSurfaceEnabled = recipeEditorPreviewTarget
      ? recipeEditorPreviewTarget.goon.nailSurfacePresence?.enabled ?? true
      : editorNailSurfacePresence?.enabled ?? true
    if (!state && !recipeEditorPreviewTarget) return
    editorNailSurfacePreviewTimer = setTimeout(() => {
      editorNailSurfacePreviewTimer = null
      void previewEngine!
        .setNailSurfaceState(state)
        .then(() => previewEngine!.setNailSurfaceEnabled(nailSurfaceEnabled))
        .then(() => {
          if (token === editorNailSurfacePreviewToken) editorNailSurfacePreviewError = ''
        })
        .catch((error) => {
          if (token !== editorNailSurfacePreviewToken) return
          editorNailSurfacePreviewError = error instanceof Error ? error.message : String(error)
        })
    }, 90)
  })

  $effect(() => {
    const token = ++editorSkinAppearancePreviewToken
    clearSkinAppearancePreviewTimer()
    if (
      !previewEngine ||
      !previewReady ||
      previewLoading ||
      recipePreviewTransitioning ||
      previewGoonId !== editorGoonId ||
      !editorSkinAppearanceDefinition
    ) return
    const state = recipeEditorPreviewTarget
      ? recipeEditorPreviewTarget.goon.skinAppearance ?? null
      : resolveSkinAppearanceDraftForSave()
    editorSkinAppearancePreviewTimer = setTimeout(() => {
      editorSkinAppearancePreviewTimer = null
      void previewEngine!
        .setSkinAppearanceState(state)
        .then(() => {
          if (token === editorSkinAppearancePreviewToken) {
            editorSkinAppearancePreviewError = ''
          }
        })
        .catch((error) => {
          if (token !== editorSkinAppearancePreviewToken) return
          editorSkinAppearancePreviewError =
            error instanceof Error ? error.message : String(error)
        })
    }, 90)
  })

  $effect(() => {
    if (
      !editorHasSocketEyeContact ||
      !previewEngine ||
      !previewReady ||
      previewLoading ||
      recipePreviewTransitioning ||
      previewGoonId !== editorGoonId
    ) return
    previewEngine.setSocketEyeContactSettings(editorSocketEyeContact)
  })

  onDestroy(() => {
    clearFacialArtworkPreviewTimer()
    clearNailSurfacePreviewTimer()
    clearSkinAppearancePreviewTimer()
  })

  function toggleEditorPrimarySection(
    section:
      | 'basic'
      | 'eye-contact'
      | 'custom-goon-builder'
      | 'hair'
      | 'vrm'
      | 'animations'
      | 'closet'
      | 'delete'
  ) {
    if (editorHairImportOpen) {
      toast.info('Finish or cancel the active Hair import before leaving its review.')
      return
    }
    if (recipeWorkflowBusy) {
      toast.info('Wait for the current Goon update to finish before leaving this section.')
      return
    }
    editorBasicSettingsOpen = section === 'basic' ? !editorBasicSettingsOpen : false
    editorEyeContactOpen = section === 'eye-contact' ? !editorEyeContactOpen : false
    editorCustomGoonBuilderOpen =
      section === 'custom-goon-builder' ? !editorCustomGoonBuilderOpen : false
    editorHairOpen = section === 'hair' ? !editorHairOpen : false
    if (section === 'hair' && editorHairOpen && !hairCatalogLoaded && !hairCatalogLoading) {
      void refreshHairCatalog().catch(() => {})
    }
    editorVrmSectionOpen = section === 'vrm' ? !editorVrmSectionOpen : false
    editorAnimationsSectionOpen =
      section === 'animations' ? !editorAnimationsSectionOpen : false
    editorClosetOpen = section === 'closet' ? !editorClosetOpen : false
    editorDeleteGoonOpen = section === 'delete' ? !editorDeleteGoonOpen : false

    if (section !== 'closet') {
      editorCustomClosetOpen = false
      editorWardrobeColorEditorKey = null
    }

    moodsOpen = false
    emotesOpen = false
    disabledMoodsOpen = false
    disabledEmotesOpen = false
    openMoodName = null
    openEmoteName = null
  }

  function toggleEditorCueSection(section: 'moods' | 'emotes') {
    if (editorHairImportOpen) {
      toast.info('Finish or cancel the active Hair import before leaving its review.')
      return
    }
    editorBasicSettingsOpen = false
    editorEyeContactOpen = false
    editorCustomGoonBuilderOpen = false
    editorHairOpen = false
    editorVrmSectionOpen = false
    editorAnimationsSectionOpen = false
    editorClosetOpen = false
    editorDeleteGoonOpen = false
    editorCustomClosetOpen = false
    editorWardrobeColorEditorKey = null

    if (section === 'moods') {
      const next = !moodsOpen
      moodsOpen = next
      emotesOpen = false
      disabledEmotesOpen = false
      openEmoteName = null
      if (!next) {
        disabledMoodsOpen = false
        openMoodName = null
      }
      return
    }

    const next = !emotesOpen
    emotesOpen = next
    moodsOpen = false
    disabledMoodsOpen = false
    openMoodName = null
    if (!next) {
      disabledEmotesOpen = false
      openEmoteName = null
    }
  }

  function toggleSceneSection(section: 'world' | 'room' | 'props' | 'markers') {
    if (section === 'world') {
      const next = !sceneWorldOpen
      sceneWorldOpen = next
      roomBuilderOpen = false
      roomBuilderSurfaceOpen = null
      scenePropsOpen = false
      sceneMarkersOpen = false
      return
    }
    if (section === 'room') {
      const next = !roomBuilderOpen
      roomBuilderOpen = next
      sceneWorldOpen = false
      roomBuilderSurfaceOpen = null
      scenePropsOpen = false
      sceneMarkersOpen = false
      return
    }
    if (section === 'props') {
      const next = !scenePropsOpen
      scenePropsOpen = next
      sceneWorldOpen = false
      roomBuilderOpen = false
      roomBuilderSurfaceOpen = null
      sceneMarkersOpen = false
      return
    }
    const next = !sceneMarkersOpen
    sceneMarkersOpen = next
    sceneWorldOpen = false
    roomBuilderOpen = false
    roomBuilderSurfaceOpen = null
    scenePropsOpen = false
  }

  function toggleRoomBuilderSurface(
    surface: 'floor' | 'ceiling' | 'north' | 'south' | 'east' | 'west'
  ) {
    roomBuilderSurfaceOpen = roomBuilderSurfaceOpen === surface ? null : surface
  }

  function toggleMotionItem(kind: 'mood' | 'emote', name: string) {
    if (kind === 'mood') {
      const nextOpen = openMoodName === name ? null : name
      openMoodName = nextOpen
      disabledMoodsOpen = false
      if (nextOpen) {
        setActiveFacePreviewSelection({ cueName: name, stepIndex: null })
      } else {
        clearActiveFacePreviewSelectionForCue(name)
      }
      return
    }
    if (kind === 'emote') {
      const nextOpen = openEmoteName === name ? null : name
      openEmoteName = nextOpen
      disabledEmotesOpen = false
      if (nextOpen) {
        setActiveFacePreviewSelection({ cueName: name, stepIndex: null })
      } else {
        clearActiveFacePreviewSelectionForCue(name)
      }
      return
    }
  }

  function handleMotionItemHeaderKeydown(
    event: KeyboardEvent,
    kind: 'mood' | 'emote',
    name: string
  ) {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    toggleMotionItem(kind, name)
  }

  function handleQuickCuePreview(event: MouseEvent, cueName: string) {
    event.preventDefault()
    event.stopPropagation()
    void triggerTestCue(cueName)
  }

  function addCue(kind: GoonCueDefinition['kind'], name: string) {
    const trimmed = name.trim()
    if (!trimmed) return false
    const map = activeTab === 'kitchen' ? kitchenCueMap : editorCueMap
    const conflict = map[trimmed]
    if (conflict) {
      showCueNameConflictToast(kind, conflict.kind)
      return false
    }
    const next = {
      ...map,
      [trimmed]: {
        name: trimmed,
        kind,
        playback: kind === 'mood' ? ('loop' as GoonMotionPlayback) : ('oneshot' as GoonMotionPlayback)
      }
    }
    setActiveCueMap(next)
    if (activeTab !== 'kitchen' && !editorEnabledCueNames.includes(trimmed)) {
      editorEnabledCueNames = [...editorEnabledCueNames, trimmed]
      editorDirty = true
    }
    if (activeTab !== 'kitchen' && kind === 'mood' && !editorBaseLoop) {
      editorBaseLoop = trimmed
    }
    return true
  }

  function addEmote() {
    const name = newEmoteName.trim()
    if (!name) return false
    const created = addCue('emote', name)
    if (!created) return false
    setEmoteEmoji(name, newEmoteEmoji)
    newEmoteName = ''
    newEmoteEmoji = ''
    return true
  }

  function removeMotion(name: string) {
    if (activeTab !== 'kitchen' && kitchenCueMap[name]) {
      setEditorCueEnabled(name, false)
      return
    }
    const map = activeTab === 'kitchen' ? kitchenCueMap : editorCueMap
    const removedKind = map[name]?.kind
    if (!removedKind) return
    const next = { ...map }
    delete next[name]
    setActiveCueMap(next)
    if (activeTab !== 'kitchen') {
      editorEnabledCueNames = editorEnabledCueNames.filter((entry) => entry !== name)
    }
    clearCueNameDraft(name)
    const emojiDrafts = getActiveEmoteEmojiDrafts()
    if (name in emojiDrafts) {
      const nextEmojiDrafts = { ...emojiDrafts }
      delete nextEmojiDrafts[name]
      setActiveEmoteEmojiDrafts(nextEmojiDrafts)
    }

    const emojiMap = activeTab === 'kitchen' ? kitchenEmojiMap : editorEmojiMap
    const nextEmoji = { ...emojiMap }
    for (const [emoji, cueName] of Object.entries(nextEmoji)) {
      if (cueName === name) {
        delete nextEmoji[emoji]
      }
    }
    setActiveEmojiMap(nextEmoji)

    if (activeTab !== 'kitchen' && editorBaseLoop === name) {
      const fallbackMood = getFirstEnabledMoodName(
        editorEnabledCueNames.filter((entry) => entry !== name),
        next
      )
      editorBaseLoop = fallbackMood
    }
    if (removedKind === 'mood' && openMoodName === name) openMoodName = null
    if (removedKind === 'emote' && openEmoteName === name) openEmoteName = null
    clearActiveFacePreviewSelectionForCue(name)
  }

  function duplicateMotion(name: string) {
    const map = activeTab === 'kitchen' ? kitchenCueMap : editorCueMap
    const existing = map[name]
    if (!existing) return
    let candidate = `${name} Copy`
    let suffix = 2
    while (map[candidate]) {
      candidate = `${name} Copy ${suffix}`
      suffix += 1
    }
    const clone = JSON.parse(JSON.stringify(existing)) as GoonCueDefinition
    clone.name = candidate
    setActiveCueMap({ ...map, [candidate]: clone })
    if (activeTab !== 'kitchen' && !editorEnabledCueNames.includes(candidate)) {
      editorEnabledCueNames = [...editorEnabledCueNames, candidate]
      editorDirty = true
    }
  }

  function buildSceneId(name: string) {
    const trimmed = name.trim().toLowerCase()
    const slug = trimmed
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '')
    const base = slug || `scene_${Date.now()}`
    let candidate = base
    let index = 2
    while (kitchenScenes[candidate]) {
      candidate = `${base}_${index}`
      index += 1
    }
    return candidate
  }

  function resolveSceneAssetFilename(scene: GoonSceneDefinition, kind: SceneAssetKind) {
    return (kind === 'skybox' ? scene.skybox?.filename : scene.roomShell?.filename)?.trim() || null
  }

  function collectSceneAssetFilenames(kind: SceneAssetKind, scenes?: GoonSceneMap | null) {
    const filenames = new Set<string>()
    for (const scene of Object.values(scenes ?? {})) {
      const filename = resolveSceneAssetFilename(scene, kind)
      if (filename) filenames.add(filename)
    }
    return filenames
  }

  function collectPersistedSceneAssetFilenames(
    kind: SceneAssetKind,
    settings: GoonsSettings = goonsSettings
  ) {
    return collectSceneAssetFilenames(kind, settings?.kitchen?.scenes)
  }

  async function deleteSceneAssetFilenamesNotIn(
    kind: SceneAssetKind,
    filenames: Iterable<string>,
    referencedFilenames: Set<string>
  ) {
    for (const filename of new Set(filenames)) {
      if (!filename || referencedFilenames.has(filename)) continue
      if (kind === 'skybox') {
        await deleteUnusedSceneSkyboxUpload(filename)
      } else {
        await deleteUnusedRoomShellUpload(filename)
      }
    }
  }

  async function reconcileSceneAssetUploadsAfterSave(
    previousScenes: GoonSceneMap | undefined,
    persistedScenes: GoonSceneMap | undefined
  ) {
    for (const kind of ['skybox', 'roomShell'] as const) {
      const previousFilenames = collectSceneAssetFilenames(kind, previousScenes)
      const persistedFilenames = collectSceneAssetFilenames(kind, persistedScenes)
      const trackedUploads = draftSceneAssetUploadFilenames[kind]
      const cleanupCandidates = new Set<string>([...previousFilenames, ...trackedUploads])
      trackedUploads.clear()
      await deleteSceneAssetFilenamesNotIn(kind, cleanupCandidates, persistedFilenames)
    }
  }

  function discardDraftSceneAssetUploads() {
    for (const kind of ['skybox', 'roomShell'] as const) {
      const trackedUploads = draftSceneAssetUploadFilenames[kind]
      if (trackedUploads.size === 0) continue
      const cleanupCandidates = [...trackedUploads]
      const persistedFilenames = collectPersistedSceneAssetFilenames(kind)
      trackedUploads.clear()
      void deleteSceneAssetFilenamesNotIn(kind, cleanupCandidates, persistedFilenames)
    }
  }

  function invalidateSceneAssetUploadTargets() {
    sceneEditorSession += 1
    sceneSkyboxUploadTarget = null
    sceneUploadTargetId = null
    sceneRoomShellUploadTarget = null
    sceneRoomShellTargetId = null
  }

  function isSceneAssetUploadTargetActive(
    target: SceneAssetUploadTarget | null
  ): target is SceneAssetUploadTarget {
    if (!target || target.session !== sceneEditorSession) return false
    if (target.mode === 'create') {
      return sceneEditorMode === 'create' && sceneEditorId === null
    }
    return (
      sceneEditorMode === 'edit' &&
      sceneEditorId === target.sceneId &&
      Boolean(kitchenScenes[target.sceneId])
    )
  }

  async function discardDetachedSceneAssetUpload(kind: SceneAssetKind, filename: string) {
    draftSceneAssetUploadFilenames[kind].delete(filename)
    const referencedFilenames = collectPersistedSceneAssetFilenames(kind)
    for (const scene of Object.values(kitchenScenes ?? {})) {
      const draftFilename = resolveSceneAssetFilename(scene, kind)
      if (draftFilename) referencedFilenames.add(draftFilename)
    }
    const createDraftFilename = (
      kind === 'skybox' ? newSceneSkybox?.filename : newSceneRoomShell?.filename
    )?.trim()
    if (createDraftFilename) referencedFilenames.add(createDraftFilename)
    await deleteSceneAssetFilenamesNotIn(kind, [filename], referencedFilenames)
  }

  function openSceneEditor(sceneId?: string) {
    invalidateSceneAssetUploadTargets()
    activeTab = 'scenes'
    editorGoonId = null
    scenePreviewBodyMode = 'proxy'
    sceneProxyPoseId = 'stand'
    activeSceneEdit = null
    sceneUploadTargetId = null
    sceneRoomShellTargetId = null
    sceneWorldOpen = !sceneId
    roomBuilderOpen = false
    roomBuilderSurfaceOpen = null
    scenePropsOpen = false
    sceneMarkersOpen = false
    if (sceneId) {
      sceneEditorMode = 'edit'
      sceneEditorId = sceneId
      kitchenPreviewSceneId = sceneId
      void ensureKitchenPreviewReady(sceneId)
      return
    }
    sceneEditorMode = 'create'
    sceneEditorId = null
    newSceneName = ''
    newSceneDescription = ''
    newSceneSkybox = null
    newSceneRoomShell = null
    newScenePlacement = 'elevated'
    newSceneGroundProjectionLine = DEFAULT_GROUND_PROJECTION_LINE
    newSceneRoomShellTransform = normalizeRoomShellTransform()
    newSceneAmbience = normalizeGoonSceneAmbience()
    resetKitchenPreview()
  }

  function closeSceneEditor() {
    cancelSceneEdit()
    invalidateSceneAssetUploadTargets()
    sceneWorldOpen = false
    roomBuilderOpen = false
    roomBuilderSurfaceOpen = null
    scenePropsOpen = false
    sceneMarkersOpen = false
    sceneEditorMode = null
    sceneEditorId = null
    scenePreviewBodyMode = 'proxy'
    sceneProxyPoseId = 'stand'
    resetKitchenPreview()
  }

  function cancelKitchenChanges() {
    applyKitchenStateFromSettings(goonsSettings)
  }

  function cancelClosetChanges() {
    cancelClosetItemEditing()
    applyClosetStateFromSettings(goonsSettings)
  }

  function resetSceneDraft() {
    newSceneName = ''
    newSceneDescription = ''
    newSceneSkybox = null
    newSceneRoomShell = null
    newScenePlacement = 'elevated'
    newSceneGroundProjectionLine = DEFAULT_GROUND_PROJECTION_LINE
    newSceneRoomShellTransform = normalizeRoomShellTransform()
    newSceneAmbience = normalizeGoonSceneAmbience()
    sceneUploadTargetId = null
    sceneSkyboxUploadTarget = null
    sceneRoomShellTargetId = null
    sceneRoomShellUploadTarget = null
  }

  function discardSceneChanges() {
    invalidateSceneAssetUploadTargets()
    discardDraftSceneAssetUploads()
    applySceneStateFromSettings(goonsSettings)
    cancelSceneEdit()
    sceneWorldOpen = sceneEditorMode === 'create'
    roomBuilderOpen = false
    roomBuilderSurfaceOpen = null
    scenePropsOpen = false
    sceneMarkersOpen = false
    if (sceneEditorMode === 'create') {
      resetSceneDraft()
    }
    if (sceneEditorMode === 'edit' && sceneEditorId) {
      kitchenPreviewSceneId = sceneEditorId
      void ensureKitchenPreviewReady(sceneEditorId)
    }
  }

  function discardCueEditorChanges() {
    if (!editorGoonId) {
      editorDirty = false
      return
    }

    const currentGoon = goons.find((entry) => entry.id === editorGoonId)
    if (currentGoon) {
      void discardFacialArtworkDraftUploads()
      openCueEditor(currentGoon)
      restorePackageOwnedEditorDrafts(currentGoon)
      return
    }

    editorDirty = false
    editorGoonId = null
  }

  function createSceneFromDraft() {
    const createdId = addScene()
    if (!createdId) return false
    sceneEditorMode = 'edit'
    sceneEditorId = createdId
    kitchenPreviewSceneId = createdId
    void ensureKitchenPreviewReady(createdId)
    return true
  }

  function sanitizeSceneMarkers(markers?: GoonSceneMarkers): GoonSceneMarkers | undefined {
    if (!markers) return undefined
    const next: GoonSceneMarkers = {}
    for (const [postureId, list] of Object.entries(markers)) {
      if (postureId === 'stand') continue
      if (Array.isArray(list) && list.length > 0) {
        next[postureId] = list.map((marker) => {
          const normalized = normalizeMarkerForSceneEditor(marker)
          return {
            id: normalized.id,
            propId: normalized.propId,
            position: normalized.position,
            rotation: normalized.rotation,
            positioned: normalized.positioned,
            propLocked: normalized.propLocked
          } satisfies GoonSceneMarker
        })
      }
    }
    return next
  }

  function sanitizeSceneDefinition(scene: GoonSceneDefinition): GoonSceneDefinition {
    return {
      ...scene,
      scenePlacement: resolveGoonScenePlacement(scene),
      groundProjectionLine: normalizeGroundProjectionLine(scene.groundProjectionLine),
      roomShellTransform: scene.roomShell
        ? normalizeRoomShellTransform(scene.roomShellTransform)
        : undefined,
      cameraBoundary: scene.roomShell && !scene.roomShellBuilder
        ? normalizeRoomCameraBoundary(scene.cameraBoundary) ?? undefined
        : undefined,
      markers: sanitizeSceneMarkers(scene.markers)
    }
  }

  function sanitizeSceneMap(map: GoonSceneMap): GoonSceneMap {
    return Object.fromEntries(
      Object.entries(map ?? {}).map(([sceneId, scene]) => [sceneId, sanitizeSceneDefinition(scene)])
    )
  }

  function updateRoomShellBuilder(
    sceneId: string,
    updater: (builder: GoonRoomShellBuilder) => GoonRoomShellBuilder
  ) {
    const scene = kitchenScenes[sceneId]
    if (!scene) return
    const current = normalizeRoomShellBuilder(scene.roomShellBuilder)
    const next = updater(current)
    updateScene(sceneId, { roomShellBuilder: next })
  }

  function updateRoomSurface(
    sceneId: string,
    surfaceKey: 'floor' | 'ceiling',
    patch: Partial<GoonRoomSurface>
  ) {
    updateRoomShellBuilder(sceneId, (builder) => {
      const surfaces = builder.surfaces ?? {}
      const current = createDefaultRoomSurface({ ...(surfaces[surfaceKey] ?? {}) })
      return {
        ...builder,
        surfaces: {
          ...surfaces,
          [surfaceKey]: { ...current, ...patch }
        }
      }
    })
  }

  function updateRoomSurfaceSide(
    sceneId: string,
    surfaceKey: 'floor' | 'ceiling',
    side: 'interior' | 'exterior',
    patch: Partial<GoonRoomSurfaceSide>
  ) {
    updateRoomShellBuilder(sceneId, (builder) => {
      const surfaces = builder.surfaces ?? {}
      const current = createDefaultRoomSurface({ ...(surfaces[surfaceKey] ?? {}) })
      const currentSide = createDefaultRoomSurfaceSide({ ...(current[side] ?? {}) })
      return {
        ...builder,
        surfaces: {
          ...surfaces,
          [surfaceKey]: {
            ...current,
            [side]: { ...currentSide, ...patch }
          }
        }
      }
    })
  }

  function updateRoomWallSurface(
    sceneId: string,
    wallKey: 'north' | 'south' | 'east' | 'west',
    patch: Partial<GoonRoomSurface>
  ) {
    updateRoomShellBuilder(sceneId, (builder) => {
      const surfaces = builder.surfaces ?? {}
      const walls = surfaces.walls ?? {}
      const current = createDefaultRoomSurface({ ...(walls[wallKey] ?? {}) })
      return {
        ...builder,
        surfaces: {
          ...surfaces,
          walls: {
            ...walls,
            [wallKey]: { ...current, ...patch }
          }
        }
      }
    })
  }

  function updateRoomWallSurfaceSide(
    sceneId: string,
    wallKey: 'north' | 'south' | 'east' | 'west',
    side: 'interior' | 'exterior',
    patch: Partial<GoonRoomSurfaceSide>
  ) {
    updateRoomShellBuilder(sceneId, (builder) => {
      const surfaces = builder.surfaces ?? {}
      const walls = surfaces.walls ?? {}
      const current = createDefaultRoomSurface({ ...(walls[wallKey] ?? {}) })
      const currentSide = createDefaultRoomSurfaceSide({ ...(current[side] ?? {}) })
      return {
        ...builder,
        surfaces: {
          ...surfaces,
          walls: {
            ...walls,
            [wallKey]: {
              ...current,
              [side]: { ...currentSide, ...patch }
            }
          }
        }
      }
    })
  }

  function updateScenePlacement(sceneId: string, placement: GoonScenePlacement) {
    const scene = kitchenScenes[sceneId]
    if (!scene) return

    const patch: Partial<GoonSceneDefinition> = { scenePlacement: placement }
    if (scene.roomShellBuilder) {
      const builder = normalizeRoomShellBuilder(scene.roomShellBuilder)
      patch.roomShellBuilder = {
        ...builder,
        exteriorAprons: builder.exteriorAprons
          ? Object.fromEntries(
              Object.entries(builder.exteriorAprons).map(([key, apron]) => [
                key,
                {
                  ...apron,
                  enabled: false
                }
              ])
            ) as GoonRoomShellBuilder['exteriorAprons']
          : undefined
      }
    }

    updateScene(sceneId, patch)
  }

  function updateSceneGroundProjectionLine(sceneId: string, value: number) {
    updateScene(sceneId, { groundProjectionLine: normalizeGroundProjectionLine(value) })
  }

  function updateRoomShellTransform(
    sceneId: string,
    patch: Partial<GoonSceneRoomShellTransform>
  ) {
    const scene = kitchenScenes[sceneId]
    if (!scene?.roomShell) return
    updateScene(sceneId, {
      roomShellTransform: normalizeRoomShellTransform({
        ...scene.roomShellTransform,
        ...patch
      })
    })
  }

  function updateNewRoomShellTransform(patch: Partial<GoonSceneRoomShellTransform>) {
    newSceneRoomShellTransform = normalizeRoomShellTransform({
      ...newSceneRoomShellTransform,
      ...patch
    })
  }

  function updateRoomCameraBoundary(sceneId: string, boundary: GoonSceneCameraBoundary | null) {
    updateScene(sceneId, {
      cameraBoundary: normalizeRoomCameraBoundary(boundary) ?? undefined
    })
  }

  async function suggestRoomCameraBoundary(sceneId: string) {
    const engine = await ensureKitchenPreviewReady(sceneId)
    const boundary = engine?.getSuggestedRoomCameraBoundary() ?? null
    if (!boundary) {
      toast.error('Batshit could not measure this Room Shell. Enter the room boundary manually.')
      return
    }
    updateRoomCameraBoundary(sceneId, boundary)
    toast.success('Indoor Camera boundary fitted to the Room Shell. Adjust it if needed.')
  }

  async function alignRoomShellFloor(sceneId: string) {
    const scene = kitchenScenes[sceneId]
    if (!scene?.roomShell?.url || scene.roomShellBuilder) {
      toast.error('Switch Room Builder to Uploaded GLB before aligning its floor.')
      return
    }

    const engine = await ensureKitchenPreviewReady(sceneId)
    const delta = engine?.getRoomShellFloorAlignmentDelta() ?? null
    if (delta === null || !Number.isFinite(delta)) {
      toast.error('Batshit could not find a walkable floor near the Goon. Adjust Y Offset manually.')
      return
    }

    const transform = normalizeRoomShellTransform(scene.roomShellTransform)
    if (Math.abs(delta) < 0.001) {
      toast.success('The detected Room Shell floor is already aligned.')
      return
    }
    updateRoomShellTransform(sceneId, {
      position: [
        transform.position[0],
        Math.round((transform.position[1] + delta) * 1000) / 1000,
        transform.position[2]
      ]
    })
    toast.success('Aligned the detected Room Shell floor to the Goon stage.')
  }

  function updateSceneAmbience(sceneId: string, patch: Partial<GoonSceneAmbience>) {
    const scene = kitchenScenes[sceneId]
    if (!scene) return
    updateScene(sceneId, {
      ambience: normalizeGoonSceneAmbience({
        ...(scene.ambience ?? {}),
        ...patch
      })
    })
  }

  function updateNewSceneAmbience(patch: Partial<GoonSceneAmbience>) {
    newSceneAmbience = normalizeGoonSceneAmbience({
      ...newSceneAmbience,
      ...patch
    })
  }

  function resolveRoomTexture(kind: GoonRoomTextureKind, filename?: string) {
    if (!filename) return undefined
    return (kitchenRoomTextures[kind] ?? []).find((entry) => entry.filename === filename)
  }

  const formatTriangleCount = (value: number) =>
    new Intl.NumberFormat('en-US').format(Math.round(value))

  async function estimateTriangleCount(file: File) {
    const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
    if (ext !== 'glb' && ext !== 'gltf') return null
    try {
      const buffer = await file.arrayBuffer()
      const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js')
      const loader = new GLTFLoader()
      const triangles = await new Promise<number>((resolve, reject) => {
        loader.parse(
          buffer,
          '',
          (gltf) => {
            let total = 0
            gltf.scene.traverse((child) => {
              const mesh = child as THREE.Mesh
              if (!mesh?.isMesh) return
              const geometry = mesh.geometry as THREE.BufferGeometry
              if (!geometry) return
              const index = geometry.index
              const position = geometry.attributes?.position
              const count = index ? index.count / 3 : position ? position.count / 3 : 0
              total += count
            })
            resolve(total)
          },
          (error) => reject(error)
        )
      })
      return Math.round(triangles)
    } catch {
      return null
    }
  }

  async function enforceModelTriangleLimit(file: File, kind: 'prop' | 'shell') {
    const triangles = await estimateTriangleCount(file)
    if (triangles === null) {
      toast.warning('Unable to estimate poly count for this model. Uploading anyway.')
      return true
    }
    const warnLimit = kind === 'prop' ? PROP_TRIANGLE_WARN : SHELL_TRIANGLE_WARN
    const hardLimit = kind === 'prop' ? PROP_TRIANGLE_LIMIT : SHELL_TRIANGLE_LIMIT
    const prettyCount = formatTriangleCount(triangles)
    const prettyHard = formatTriangleCount(hardLimit)
    if (triangles > hardLimit) {
      toast.error(
        `${kind === 'prop' ? 'Prop' : 'Room shell'} is too heavy (${prettyCount} triangles). Limit is ${prettyHard}.`
      )
      return false
    }
    if (triangles > warnLimit) {
      const ideal =
        kind === 'prop'
          ? 'Ideal range is ~5k–15k.'
          : 'Ideal range is ~25k–80k.'
      toast.warning(
        `High‑poly ${kind === 'prop' ? 'prop' : 'room shell'} (${prettyCount} triangles). ${ideal}`
      )
    }
    return true
  }

  async function handleSceneSelection(event: Event) {
    const input = event.currentTarget as HTMLInputElement
    const file = input.files?.[0] || null
    const uploadTarget = sceneSkyboxUploadTarget
    if (!file) {
      sceneUploadTargetId = null
      sceneSkyboxUploadTarget = null
      return
    }
    sceneUploadBusy = true
    try {
      if (!isSceneAssetUploadTargetActive(uploadTarget)) return
      const fileInfo = await uploadGoonSceneSkybox(file)
      draftSceneAssetUploadFilenames.skybox.add(fileInfo.filename)

      if (!isSceneAssetUploadTargetActive(uploadTarget)) {
        await discardDetachedSceneAssetUpload('skybox', fileInfo.filename)
        return
      }

      if (uploadTarget.mode === 'edit') {
        const targetSceneId = uploadTarget.sceneId
        updateScene(targetSceneId, {
          skybox: {
            ...fileInfo,
            kind: 'skybox',
            projection: 'equirectangular'
          }
        })
        toast.success('Skybox updated')
      } else {
        newSceneSkybox = fileInfo
        toast.success('Skybox uploaded')
      }
    } catch (error: any) {
      toast.error(error?.message || 'Upload failed')
    } finally {
      if (sceneSkyboxUploadTarget === uploadTarget) {
        sceneUploadTargetId = null
        sceneSkyboxUploadTarget = null
      }
      sceneUploadBusy = false
      if (sceneUploadInput) sceneUploadInput.value = ''
    }
  }

  function requestSceneSkyboxUpload(sceneId?: string) {
    sceneUploadTargetId = sceneId ?? null
    sceneSkyboxUploadTarget = sceneId
      ? { session: sceneEditorSession, mode: 'edit', sceneId }
      : { session: sceneEditorSession, mode: 'create' }
    sceneUploadInput?.click()
  }

  async function handleRoomShellSelection(event: Event) {
    const input = event.currentTarget as HTMLInputElement
    const file = input.files?.[0] || null
    const uploadTarget = sceneRoomShellUploadTarget
    if (!file) {
      sceneRoomShellTargetId = null
      sceneRoomShellUploadTarget = null
      return
    }
    sceneRoomShellBusy = true
    try {
      const allowed = await enforceModelTriangleLimit(file, 'shell')
      if (!allowed) return
      if (!isSceneAssetUploadTargetActive(uploadTarget)) return
      const fileInfo = await uploadGoonRoomShell(file)
      draftSceneAssetUploadFilenames.roomShell.add(fileInfo.filename)

      if (!isSceneAssetUploadTargetActive(uploadTarget)) {
        await discardDetachedSceneAssetUpload('roomShell', fileInfo.filename)
        return
      }

      if (uploadTarget.mode === 'edit') {
        const targetSceneId = uploadTarget.sceneId
        updateScene(targetSceneId, {
          roomShell: { ...fileInfo, kind: 'room_shell' }
        })
        toast.success('Room shell updated')
      } else {
        newSceneRoomShell = fileInfo
        toast.success('Room shell uploaded')
      }
    } catch (error: any) {
      toast.error(error?.message || 'Upload failed')
    } finally {
      if (sceneRoomShellUploadTarget === uploadTarget) {
        sceneRoomShellTargetId = null
        sceneRoomShellUploadTarget = null
      }
      sceneRoomShellBusy = false
      if (sceneRoomShellInput) sceneRoomShellInput.value = ''
    }
  }

  function requestRoomShellUpload(sceneId?: string) {
    sceneRoomShellTargetId = sceneId ?? null
    sceneRoomShellUploadTarget = sceneId
      ? { session: sceneEditorSession, mode: 'edit', sceneId }
      : { session: sceneEditorSession, mode: 'create' }
    sceneRoomShellInput?.click()
  }

  async function handleRoomTextureSelection(event: Event) {
    const input = event.currentTarget as HTMLInputElement
    const file = input.files?.[0] || null
    if (!file) return
    roomTextureBusy = true
    try {
      const fileInfo = await uploadGoonRoomTexture(file, roomTextureTargetKind)
      const next = { ...kitchenRoomTextures }
      const list = next[roomTextureTargetKind] ?? []
      next[roomTextureTargetKind] = [
        ...list,
        { ...fileInfo, kind: roomTextureTargetKind }
      ]
      kitchenRoomTextures = next
      sceneDirty = true
      toast.success('Texture uploaded')
    } catch (error: any) {
      toast.error(error?.message || 'Upload failed')
    } finally {
      roomTextureBusy = false
      if (roomTextureInput) roomTextureInput.value = ''
    }
  }

  function requestRoomTextureUpload(kind: GoonRoomTextureKind) {
    roomTextureTargetKind = kind
    roomTextureInput?.click()
  }

  function buildPropId(sceneId: string, name: string) {
    const base = name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '')
    const prefix = base || `prop_${Date.now()}`
    const scene = kitchenScenes[sceneId]
    const existing = new Set((scene?.props ?? []).map((prop) => prop.id))
    let candidate = prefix
    let index = 2
    while (existing.has(candidate)) {
      candidate = `${prefix}_${index}`
      index += 1
    }
    return candidate
  }

  function derivePropName(fileInfo: GoonFileRef) {
    const raw = fileInfo.originalName || fileInfo.filename || 'Prop'
    return raw.replace(/\.[^/.]+$/, '')
  }

  function resolveFileThumbnailUrl(fileRef?: GoonFileRef | null) {
    return fileRef?.thumbnailUrl?.trim() || null
  }

  function resolveSceneThumbnailUrl(scene: GoonSceneDefinition) {
    return resolveFileThumbnailUrl(scene.skybox)
  }

  async function handleScenePropSelection(event: Event) {
    const input = event.currentTarget as HTMLInputElement
    const file = input.files?.[0] || null
    if (!file) {
      scenePropTargetId = null
      return
    }
    if (!scenePropTargetId) {
      toast.error('Select a scene to attach this prop.')
      return
    }
    scenePropBusy = true
    try {
      const allowed = await enforceModelTriangleLimit(file, 'prop')
      if (!allowed) return
      const fileInfo = await uploadGoonSceneProp(file)
      const scene = kitchenScenes[scenePropTargetId]
      if (!scene) {
        scenePropTargetId = null
        return
      }
      const name = derivePropName(fileInfo)
      const id = buildPropId(scene.id, name)
      const nextProp: GoonSceneProp = {
        id,
        name,
        fileRef: fileInfo,
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1]
      }
      updateScene(scene.id, { props: [...(scene.props ?? []), nextProp] })
      toast.success('Prop uploaded')
    } catch (error: any) {
      toast.error(error?.message || 'Upload failed')
    } finally {
      scenePropBusy = false
      scenePropTargetId = null
      if (scenePropInput) scenePropInput.value = ''
    }
  }

  function requestScenePropUpload(sceneId: string) {
    scenePropTargetId = sceneId
    scenePropInput?.click()
  }

  function updateSceneProp(sceneId: string, propId: string, patch: Partial<GoonSceneProp>) {
    const scene = kitchenScenes[sceneId]
    if (!scene) return
    const props = scene.props ?? []
    const next = props.map((prop) => (prop.id === propId ? { ...prop, ...patch } : prop))
    updateScene(sceneId, { props: next })
  }

  function warnSceneAssetDeleteFailure(kind: string, filename: string, error: unknown) {
    console.warn(`[GoonsSettings] Failed to delete ${kind} upload ${filename}:`, error)
    toast.warning(`${kind} removed from Settings, but its uploaded file could not be deleted.`)
  }

  async function deleteUnusedSceneSkyboxUpload(filename: string) {
    try {
      await deleteGoonSceneSkybox(filename)
    } catch (error) {
      warnSceneAssetDeleteFailure('Skybox', filename, error)
    }
  }

  async function deleteUnusedRoomShellUpload(filename: string) {
    try {
      await deleteGoonRoomShell(filename)
    } catch (error) {
      warnSceneAssetDeleteFailure('Room shell', filename, error)
    }
  }

  async function deleteUnusedScenePropUpload(filename: string) {
    try {
      await deleteGoonSceneProp(filename)
    } catch (error) {
      warnSceneAssetDeleteFailure('Scene prop', filename, error)
    }
  }

  async function removeSceneProp(sceneId: string, propId: string) {
    const scene = kitchenScenes[sceneId]
    if (!scene) return
    const props = scene.props ?? []
    const target = props.find((prop) => prop.id === propId)
    const next = props.filter((prop) => prop.id !== propId)
    const markers = scene.markers ?? {}
    const cleanedMarkers = Object.fromEntries(
      Object.entries(markers).map(([postureId, list]) => [
        postureId,
        (list ?? []).map((marker) =>
          marker.propId === propId ? { ...marker, propId: undefined } : marker
        )
      ])
    ) as GoonSceneMarkers
    updateScene(sceneId, { props: next, markers: cleanedMarkers })

    const filename = target?.fileRef?.filename
    if (!filename) return
    const stillUsed = Object.values(kitchenScenes).some((value) =>
      (value.props ?? []).some((prop) => prop.fileRef?.filename === filename)
    )
    if (!stillUsed) {
      await deleteUnusedScenePropUpload(filename)
    }
  }

  async function addSceneMarker(sceneId: string, posture: GoonPosture) {
    if (posture === 'stand') {
      toast.error('Standing uses open floor space and does not use scene markers.')
      return
    }
    if (scenePreviewUsingProxy) {
      toast.error('Preview with active Goon to place markers.')
      return
    }
    const motionNames = resolveMarkerMotionNamesForPosture(posture, kitchenPreviewGoon)
    if (motionNames.length === 0) {
      toast.error(`Add a ${getPostureLabel(posture)} Motion first.`)
      return
    }
    const scene = kitchenScenes[sceneId]
    if (!scene) return
    const engine = await ensureKitchenPreviewReady(sceneId)
    if (!engine) {
      toast.error('Preview with active Goon to place markers.')
      return
    }
    const markers = scene.markers ?? {}
    const list = markers[posture] ?? []
    const id = `${posture}_${Date.now()}`
    const nextMarker: GoonSceneMarker = {
      id,
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      positioned: false,
      propLocked: false
    }
    const nextMarkers: GoonSceneMarkers = {
      ...markers,
      [posture]: [...list, nextMarker]
    }
    updateScene(sceneId, { markers: nextMarkers })
    engine.setSceneMarkers(nextMarkers)
    activeMarkerRestore = structuredClone(nextMarker)
    activeMarkerWasNew = true
    activeMarkerVerticalOffset = 0
    engine.setMarkerAuthoringVerticalOffset(0)
    engine.clearEditTarget()
    activeSceneEdit = { type: 'marker', sceneId, posture, markerId: id }
    activeSceneEditTransform = null
    engine.setStagePosture(posture, id)
    kitchenPreviewAnimationName = motionNames[0]
    await triggerKitchenPreviewAnimation({ preservePlacement: true })
  }

  function updateSceneMarker(
    sceneId: string,
    posture: GoonPosture,
    markerId: string,
    patch: Partial<GoonSceneMarker>
  ): GoonSceneMarkers | null {
    const scene = kitchenScenes[sceneId]
    if (!scene) return null
    const markers = scene.markers ?? {}
    const list = markers[posture] ?? []
    const next = list.map((marker) => (marker.id === markerId ? { ...marker, ...patch } : marker))
    const nextMarkers = { ...markers, [posture]: next }
    updateScene(sceneId, { markers: nextMarkers })
    return nextMarkers
  }

  function removeSceneMarker(sceneId: string, posture: GoonPosture, markerId: string) {
    const scene = kitchenScenes[sceneId]
    if (!scene) return
    const markers = scene.markers ?? {}
    const list = markers[posture] ?? []
    const next = list.filter((marker) => marker.id !== markerId)
    updateScene(sceneId, { markers: { ...markers, [posture]: next } })
    if (
      activeSceneEdit?.type === 'marker' &&
      activeSceneEdit.sceneId === sceneId &&
      activeSceneEdit.posture === posture &&
      activeSceneEdit.markerId === markerId
    ) {
      void cancelMarkerPlacement({ quiet: true })
    }
  }

  async function updateSceneMarkerPropBinding(
    sceneId: string,
    posture: GoonPosture,
    markerId: string,
    nextPropId?: string
  ) {
    const scene = kitchenScenes[sceneId]
    const marker = scene?.markers?.[posture]?.find((entry) => entry.id === markerId)
    if (!scene || !marker) return
    if (marker.propLocked) {
      toast.error('This prop binding is locked. Delete the Marker and start over to change it.')
      return
    }
    if (scenePreviewUsingProxy) {
      toast.error('Preview with active Goon to rebind markers to props.')
      return
    }

    const engine = await ensureKitchenPreviewReady(sceneId)
    if (!engine) {
      toast.error('Preview with active Goon to rebind markers to props.')
      return
    }

    const rebound =
      activeSceneEdit?.type === 'marker' &&
      activeSceneEdit.sceneId === sceneId &&
      activeSceneEdit.posture === posture &&
      activeSceneEdit.markerId === markerId
        ? (() => {
            const snapshot = engine.getGoonMarkerSnapshot(nextPropId)
            return snapshot
              ? {
                  ...marker,
                  propId: nextPropId || undefined,
                  position: snapshot.position,
                  rotation: snapshot.rotation
                }
              : engine.rebindMarkerReference(marker, nextPropId)
          })()
        : engine.rebindMarkerReference(marker, nextPropId)
    const nextMarkers = updateSceneMarker(sceneId, posture, markerId, rebound)
    if (nextMarkers) {
      const currentPlacement = engine.getCurrentVisualPlacement()
      engine.setSceneMarkers(nextMarkers, { reapplyPlacement: false })
      if (currentPlacement) {
        engine.finishMarkerAuthoring(currentPlacement.position, currentPlacement.rotationY)
      }
    }
  }

  async function beginPropEdit(sceneId: string, propId: string) {
    if (activeSceneEdit?.type === 'marker') {
      toast.error('Apply or cancel the active Marker position first.')
      return
    }
    const engine = await ensureKitchenPreviewReady(sceneId)
    if (!engine) {
      toast.error('Scene Preview is not ready.')
      return
    }
    const ok = await engine.setEditTarget({ type: 'prop', id: propId })
    if (!ok) {
      toast.error('Prop is not ready yet.')
      return
    }
    engine.setScaleAspectLock(scenePropScaleLock)
    engine.setEditMode(sceneEditMode)
    activeSceneEdit = { type: 'prop', sceneId, propId }
    syncActiveSceneEditTransform(engine.getEditTransform())
  }

  function setSceneEditMode(mode: 'translate' | 'rotate' | 'scale') {
    sceneEditMode = mode
    kitchenPreviewEngine?.setEditMode(mode)
  }

  async function saveSceneEdit() {
    if (!activeSceneEdit) return
    const engine = kitchenPreviewEngine
    if (!engine) return
    const transform = engine.getEditTransform()
    if (!transform) return

    if (activeSceneEdit.type !== 'prop') return
    updateSceneProp(activeSceneEdit.sceneId, activeSceneEdit.propId, {
      position: transform.position,
      rotation: transform.rotation,
      scale: transform.scale
    })
    engine.clearEditTarget()
    activeSceneEdit = null
    activeSceneEditTransform = null
  }

  function cancelSceneEdit() {
    if (activeSceneEdit?.type !== 'prop') return
    kitchenPreviewEngine?.clearEditTarget()
    activeSceneEdit = null
    activeSceneEditTransform = null
  }

  async function saveMarkerPlacement() {
    if (activeSceneEdit?.type !== 'marker') return
    const { sceneId, posture, markerId } = activeSceneEdit
    const engine = await ensureKitchenPreviewReady(sceneId, { syncScene: false })
    if (!engine) {
      toast.error('Select a Goon in Scene Preview to save the marker.')
      return
    }
    const scene = kitchenScenes[sceneId]
    const marker = scene?.markers?.[posture]?.find((entry) => entry.id === markerId)
    const snapshot = engine.getGoonMarkerSnapshot(marker?.propId)
    if (!snapshot) return
    const currentPlacement = engine.getCurrentVisualPlacement()
    const nextMarkers = updateSceneMarker(sceneId, posture, markerId, {
      position: snapshot.position,
      rotation: snapshot.rotation,
      propId: undefined,
      propLocked: false,
      positioned: true
    })
    if (nextMarkers) {
      engine.setSceneMarkers(nextMarkers, { reapplyPlacement: false })
    }
    if (currentPlacement) {
      engine.finishMarkerAuthoring(currentPlacement.position, currentPlacement.rotationY)
    } else {
      engine.setMarkerAuthoringVerticalOffset(0)
      engine.setStagePosture(posture, markerId)
    }
    activeMarkerVerticalOffset = 0
    activeMarkerRestore = null
    activeMarkerWasNew = false
    activeSceneEdit = null
    activeSceneEditTransform = null
  }

  async function cancelMarkerPlacement(options: { quiet?: boolean } = {}) {
    if (activeSceneEdit?.type !== 'marker') return
    const { sceneId, posture, markerId } = activeSceneEdit
    const engine = await ensureKitchenPreviewReady(sceneId)
    if (!engine && !options.quiet) {
      toast.error('Scene Preview is not ready.')
    }
    if (activeMarkerWasNew) {
      const scene = kitchenScenes[sceneId]
      const markers = scene?.markers ?? {}
      const list = markers[posture] ?? []
      updateScene(sceneId, {
        markers: {
          ...markers,
          [posture]: list.filter((entry) => entry.id !== markerId)
        }
      })
    } else if (activeMarkerRestore) {
      const nextMarkers = updateSceneMarker(sceneId, posture, markerId, activeMarkerRestore)
      if (engine && nextMarkers) {
        engine.setSceneMarkers(nextMarkers)
      }
    }
    if (engine) {
      engine.setMarkerAuthoringVerticalOffset(0)
      if (!activeMarkerWasNew && activeMarkerRestore) {
        engine.setStagePosture(posture, markerId)
      }
    }
    activeMarkerVerticalOffset = 0
    activeMarkerRestore = null
    activeMarkerWasNew = false
    activeSceneEdit = null
    activeSceneEditTransform = null
  }

  function updateMarkerVerticalOffset(value: number) {
    activeMarkerVerticalOffset = value
    kitchenPreviewEngine?.setMarkerAuthoringVerticalOffset(value)
  }

  function addScene() {
    if (!newSceneSkybox && !newSceneRoomShell) {
      toast.error('Upload a skybox or room shell first.')
      return null
    }
    const name = newSceneName.trim() || newSceneSkybox?.originalName || 'Scene'
    const id = buildSceneId(name)
    const now = new Date().toISOString()
    const scene: GoonSceneDefinition = {
      id,
      name,
      description: newSceneDescription.trim() || undefined,
      skybox: newSceneSkybox
        ? {
            ...newSceneSkybox,
            kind: 'skybox',
            projection: 'equirectangular'
          }
        : undefined,
      scenePlacement: newScenePlacement,
      groundProjectionLine: newSceneGroundProjectionLine,
      roomShell: newSceneRoomShell ? { ...newSceneRoomShell, kind: 'room_shell' } : undefined,
      roomShellTransform: newSceneRoomShell
        ? normalizeRoomShellTransform(newSceneRoomShellTransform)
        : undefined,
      ambience: normalizeGoonSceneAmbience(newSceneAmbience)
    }
    kitchenScenes = {
      ...(kitchenScenes ?? {}),
      [id]: scene
    }
    sceneDirty = true
    resetSceneDraft()
    return id
  }

  function updateScene(sceneId: string, patch: Partial<GoonSceneDefinition>) {
    const current = kitchenScenes[sceneId]
    if (!current) return
    const next = sanitizeSceneDefinition({
      ...current,
      ...patch,
      id: current.id
    })
    kitchenScenes = {
      ...(kitchenScenes ?? {}),
      [sceneId]: next
    }
    sceneDirty = true
  }

  async function removeScene(sceneId: string) {
    const current = kitchenScenes[sceneId]
    if (!current) return
    const next = { ...(kitchenScenes ?? {}) }
    delete next[sceneId]
    kitchenScenes = next
    sceneDirty = true
    if (sceneEditorId === sceneId) {
      sceneEditorMode = null
      sceneEditorId = null
      cancelSceneEdit()
    }
    if (kitchenPreviewSceneId === sceneId) {
      kitchenPreviewSceneId = null
    }

    const propFiles = current.props ?? []
    for (const prop of propFiles) {
      const filename = prop.fileRef?.filename
      if (!filename) continue
      const stillUsed = Object.values(next).some((scene) =>
        (scene.props ?? []).some((entry) => entry.fileRef?.filename === filename)
      )
      if (!stillUsed) {
        await deleteUnusedScenePropUpload(filename)
      }
    }
  }

  function requestDeleteScene(scene: GoonSceneDefinition) {
    scenePendingDelete = scene
    sceneDeleteConfirmOpen = true
  }

  async function confirmDeleteScene() {
    if (!scenePendingDelete) return
    const target = scenePendingDelete
    sceneDeleteConfirmOpen = false
    scenePendingDelete = null
    await removeScene(target.id)
  }

  function clearRoomShell(sceneId: string) {
    const current = kitchenScenes[sceneId]
    if (!current?.roomShell) return
    updateScene(sceneId, { roomShell: undefined, roomShellTransform: undefined })
  }

  function buildClosetId(name: string) {
    const trimmed = name.trim().toLowerCase()
    const slug = trimmed
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '')
    return slug || `closet_${Date.now()}`
  }

  function normalizeClosetCategory(value: string) {
    const trimmed = value.trim().toLowerCase()
    if (!trimmed) return 'other'
    return trimmed.replace(/[^a-z0-9]+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '')
  }

  async function handleClosetXWearSelection(event: Event) {
    const input = event.currentTarget as HTMLInputElement
    const file = input.files?.[0] || null
    if (!file) return
    closetXWearBusy = true
    try {
      const parsed = await parseXWearFile(file)
      const uploadedTextureCache = new Map<string, GoonFileRef>()
      const uploadedMaterials = []
      for (const material of parsed.materials) {
        const uploadedTextures: Record<string, GoonFileRef> = {}
        for (const [property, textureFile] of Object.entries(material.textures ?? {})) {
          const cacheKey = textureFile.name
          let fileInfo = uploadedTextureCache.get(cacheKey)
          if (!fileInfo) {
            fileInfo = await uploadGoonClosetImage(textureFile)
            uploadedTextureCache.set(cacheKey, fileInfo)
          }
          uploadedTextures[property] = fileInfo
        }
        uploadedMaterials.push({
          ...material,
          textures: Object.keys(uploadedTextures).length ? uploadedTextures : undefined
        })
      }
      const name = parsed.name || file.name.replace(/\\.xwear$/i, '')
      const id = buildClosetId(name)
      const storedXWear = buildStoredXWear(uploadedMaterials)
      const primaryMaterialName =
        getPrimaryXWearMaterialName(storedXWear) ?? file.name.replace(/\\.xwear$/i, '')
      const category = normalizeClosetCategory(deriveClosetCategoryFromMaterialName(primaryMaterialName))
      const now = new Date().toISOString()
      const item: GoonClosetItem = {
        id,
        name,
        category,
        kind: 'xwear',
        texture: uploadedMaterials[0]?.textures?._MainTex,
        xwear: storedXWear,
        createdAt: now,
        updatedAt: now
      }
      const nextItems = {
        ...(globalCloset.items ?? {}),
        [id]: item
      }
      globalCloset = { ...globalCloset, items: nextItems }
      closetDirty = true
      toast.success('XWear added to Closet')
    } catch (error: any) {
      toast.error(error?.message || 'XWear import failed')
    } finally {
      closetXWearBusy = false
      if (closetXWearInput) closetXWearInput.value = ''
    }
  }

  function updateClosetItem(itemId: string, patch: Partial<GoonClosetItem>) {
    const current = globalCloset.items?.[itemId]
    if (!current) return
    const nextName = patch.name?.trim()
    const next = {
      ...current,
      ...(nextName ? { name: nextName } : {}),
      id: current.id,
      updatedAt: new Date().toISOString()
    }
    globalCloset = {
      ...globalCloset,
      items: {
        ...(globalCloset.items ?? {}),
        [itemId]: next
      }
    }
    closetDirty = true
  }

  async function removeClosetItem(itemId: string) {
    const current = globalCloset.items?.[itemId]
    if (!current) return
    if (editingClosetItemId === itemId) {
      cancelClosetItemEditing()
    }
    closetDeleteBusyId = itemId
    const nextItems = { ...(globalCloset.items ?? {}) }
    delete nextItems[itemId]
    globalCloset = { ...globalCloset, items: nextItems }
    closetDirty = true

    const affectedGoons: Array<{
      goonId: string
      cleanup: Pick<GoonRecord, 'closetAssignments'>
    }> = []

    for (const goon of goons) {
      const cleanup = buildGoonRecordCustomClosetCleanup(goon, itemId)
      if (!cleanup) continue
      affectedGoons.push({ goonId: goon.id, cleanup })
    }

    for (const affected of affectedGoons) {
      await updateGoonRecord(affected.goonId, affected.cleanup)
    }

    const itemUsesFilename = (item: GoonClosetItem, filename: string) => {
      if (item.texture?.filename === filename) return true
      if (item.mask?.filename === filename) return true
      return getXWearMaterials(item.xwear).some((material) =>
        Object.values(material.textures ?? {}).some((ref) => ref?.filename === filename)
      )
    }

    const persistedGoonClosetItems = [
      ...goons.flatMap((goon) => Object.values(goon.closet?.items ?? {})),
      ...Object.values(editorClosetItems)
    ]
    const referencedFilenames = new Set<string>()
    if (current.texture?.filename) referencedFilenames.add(current.texture.filename)
    if (current.mask?.filename) referencedFilenames.add(current.mask.filename)
    for (const material of getXWearMaterials(current.xwear)) {
      for (const ref of Object.values(material.textures ?? {})) {
        if (ref?.filename) referencedFilenames.add(ref.filename)
      }
    }

    for (const filename of referencedFilenames) {
      const stillUsed =
        Object.values(nextItems).some((item) => itemUsesFilename(item, filename)) ||
        persistedGoonClosetItems.some((item) => itemUsesFilename(item, filename))
      if (!stillUsed) {
        await deleteGoonClosetImage(filename).catch(() => {})
      }
    }

    closetDeleteBusyId = null
    closetDeleteConfirmOpen = false
    closetPendingDelete = null
  }

  async function confirmRemoveClosetItem() {
    if (!closetPendingDelete || closetDeleteBusyId) return
    try {
      await removeClosetItem(closetPendingDelete.id)
    } catch (error: any) {
      closetDeleteBusyId = null
      toast.error(error?.message || 'Failed to remove Closet item')
    }
  }

  async function saveCueEditor(options: SaveCueEditorOptions = {}) {
    if (!editorGoonId) return false
    editorSaving = true
    try {
      if (editorHairSupported && editorHairStateError) {
        throw new Error('Resolve the saved Hair state before saving this Goon.')
      }
      if (
        !options.skipRecipeWorkflow &&
        editorSourceProfile === 'expert-custom-glb' &&
        recipeWorkflowController &&
        !(await recipeWorkflowController.saveRecipeDraftIfNeeded())
      ) {
        return false
      }
      const currentGoon = goons.find((entry) => entry.id === editorGoonId)
      const stagedPendingVrm = editorPendingVrmFile ?? currentGoon?.files?.vrmPending ?? null
      const stagedVrmReport = editorPendingVrmUpdate ?? currentGoon?.vrmUpdate ?? null
      const stagedAdvancedPackage = editorPendingAdvancedPackageUpdate
      const advancedPackageDraft = stagedAdvancedPackage
        ? buildAdvancedPackageUpdateDraft(stagedAdvancedPackage)
        : null
      const appearanceDialsForSave =
        editorAppearanceDialsState ?? currentGoon?.appearanceDials ?? null
      const facialArtworkForSave =
        editorFacialArtworkHydrated && editorFacialArtworkDefinition
          ? resolveFacialArtworkDraftForSave()
          : currentGoon?.facialArtwork ?? null
      const eyeAppearanceForSave =
        editorFacialArtworkHydrated && editorEyeAppearanceDefinition
          ? resolveEyeAppearanceDraftForSave()
          : currentGoon?.eyeAppearance ?? null
      const oralAppearanceForSave =
        editorFacialArtworkHydrated && editorOralAppearanceDefinition
          ? resolveOralAppearanceDraftForSave()
          : currentGoon?.oralAppearance ?? null
      const lipArtworkForSave =
        editorFacialArtworkHydrated && editorLipArtworkDefinition
          ? resolveLipArtworkDraftForSave()
          : currentGoon?.lipArtwork ?? null
      const lipArtworkPresenceForSave =
        editorFacialArtworkHydrated && editorLipArtworkDefinition
          ? resolveLipArtworkPresenceDraftForSave()
          : currentGoon?.lipArtworkPresence ?? null
      const nailSurfaceForSave =
        editorNailSurfaceDefinition
          ? resolveNailSurfaceDraftForSave()
          : currentGoon?.nailSurface ?? null
      const nailSurfacePresenceForSave =
        editorNailSurfaceDefinition
          ? resolveNailSurfacePresenceDraftForSave()
          : currentGoon?.nailSurfacePresence ?? null
      const skinAppearanceForSave =
        editorSkinAppearanceDefinition
          ? resolveSkinAppearanceDraftForSave()
          : currentGoon?.skinAppearance ?? null
      const recipeOwnsAppearance = currentGoon?.recipe?.contract === 'goon-recipe/v2'
      const nextName = editorName.trim() || currentGoon?.name || 'Goon'
      const nextDescription = editorDescription?.trim() ?? ''
      const normalizedEditorCueMap = normalizeGoonCueMap(editorCueMap)
      const moodOptions = Object.values(normalizedEditorCueMap)
        .filter((cue) => cue.kind === 'mood')
        .map((cue) => cue.name)
      const resolvedBaseLoop = moodOptions.includes(editorBaseLoop)
        ? editorBaseLoop
        : moodOptions[0] ?? 'base_stand'
      editorBaseLoop = resolvedBaseLoop
      const { emojiMap: filteredEmojiMap, conflicts } = buildEmojiMapFromDrafts(
        normalizedEditorCueMap,
        editorEmojiMap,
        editorEmoteEmojiDrafts
      )
      if (conflicts.length > 0) {
        throw new Error("You've already use this emoji")
      }
      const kitchen = resolveKitchenCues(goonsSettings)
      let enabled = editorEnabledCueNames.filter((name) => Boolean(normalizedEditorCueMap[name]))
      if (stagedPendingVrm) {
        const disabledSet = new Set(stagedVrmReport?.disabledCues ?? [])
        enabled = enabled.filter((name) => !disabledSet.has(name))
      }
      const disabled = Object.keys(normalizedEditorCueMap).filter((name) => !enabled.includes(name))
      const overrides: GoonCueMap = {}
      for (const [name, cue] of Object.entries(normalizedEditorCueMap)) {
        const base = kitchen.cueMap[name]
        const baseSerialized = base ? JSON.stringify(base) : null
        const cueSerialized = JSON.stringify(cue)
        if (!base || baseSerialized !== cueSerialized) {
          overrides[name] = cue
        }
      }
      const emojiOverrides: GoonEmojiMap = {}
      for (const [emoji, cueName] of Object.entries(filteredEmojiMap)) {
        if (kitchen.emojiMap[emoji] !== cueName) {
          emojiOverrides[emoji] = cueName
        }
      }
      const restDefaults = { ...(currentGoon?.defaults ?? {}) }
      delete (restDefaults as Record<string, unknown>).fallbackPoses
      delete (restDefaults as Record<string, unknown>).eyeContactMode
      delete (restDefaults as Record<string, unknown>).eyeContactTuning
      delete (restDefaults as Record<string, unknown>).socketEyeContact
      delete (restDefaults as Record<string, unknown>).closetOutfitId
      const editorEyeContactTuning = buildEditorEyeContactTuning()
      const globalEyeContact = currentGoon
        ? resolveGlobalEyeContactForGoon(currentGoon)
        : {
            mode: editorEyeContactMode,
            tuning: editorEyeContactTuning
          }
      const nextDefaults: NonNullable<GoonRecord['defaults']> = {
        ...restDefaults,
        baseLoop: resolvedBaseLoop,
        sceneId: editorSceneId || undefined,
        quality: editorQuality,
        lipSync: editorLipSync,
        ...(editorActiveWardrobeOutfitId && editorWardrobeOutfits[editorActiveWardrobeOutfitId]
          ? { closetOutfitId: editorActiveWardrobeOutfitId }
          : {})
      }
      if (editorHasSocketEyeContact) {
        nextDefaults.socketEyeContact = parseSocketEyeContactSettings(editorSocketEyeContact)
      } else {
        if (editorEyeContactMode !== globalEyeContact.mode) {
          nextDefaults.eyeContactMode = editorEyeContactMode
        }
        if (!eyeContactTuningMatches(editorEyeContactTuning, globalEyeContact.tuning)) {
          nextDefaults.eyeContactTuning = editorEyeContactTuning
        }
      }
      const updates: Partial<GoonRecord> = {
        name: nextName,
        description: nextDescription,
        cues: {
          enabled,
          disabled,
          overrides,
          emojiOverrides
        },
        defaults: nextDefaults,
        camera: editorCamera,
        closet: advancedPackageDraft?.closet ?? buildEditorClosetPayload(),
        closetAssignments: advancedPackageDraft?.closetAssignments ?? sanitizeClosetAssignments(closetAssignments)
      }
      if (editorHairSupported && !recipeOwnsAppearance) {
        updates.hairState = editorHairState
      }
      if (
        !recipeOwnsAppearance &&
        editorGoonKind === 'custom' &&
        editorAppearanceDialsManifest && editorAppearanceDialsState
      ) {
        updates.appearanceDials = appearanceDialsForSave
      }
      if (
        !recipeOwnsAppearance &&
        editorGoonKind === 'custom' &&
        editorFacialArtworkHydrated && editorFacialArtworkDefinition
      ) {
        updates.facialArtwork = facialArtworkForSave
      }
      if (
        !recipeOwnsAppearance &&
        editorGoonKind === 'custom' &&
        editorFacialArtworkHydrated && editorEyeAppearanceDefinition
      ) {
        updates.eyeAppearance = eyeAppearanceForSave
      }
      if (
        !recipeOwnsAppearance &&
        editorGoonKind === 'custom' &&
        editorFacialArtworkHydrated && editorOralAppearanceDefinition
      ) {
        updates.oralAppearance = oralAppearanceForSave
      }
      if (
        !recipeOwnsAppearance &&
        editorGoonKind === 'custom' &&
        editorFacialArtworkHydrated && editorLipArtworkDefinition
      ) {
        updates.lipArtwork = lipArtworkForSave
        updates.lipArtworkPresence = lipArtworkPresenceForSave
      }
      if (
        !recipeOwnsAppearance &&
        editorGoonKind === 'custom' &&
        editorNailSurfaceDefinition
      ) {
        updates.nailSurface = nailSurfaceForSave
        updates.nailSurfacePresence = nailSurfacePresenceForSave
      }
      if (
        !recipeOwnsAppearance &&
        editorGoonKind === 'custom' &&
        editorSkinAppearanceDefinition
      ) {
        updates.skinAppearance = skinAppearanceForSave
        // Clear the retired sibling when the unified v2 surface state is saved.
        updates.skinMaterialArtwork = null
      }
      if (currentGoon?.guidedAvatar) {
        if (stagedAdvancedPackage && advancedPackageDraft) {
          updates.files = {
            ...(currentGoon.files ?? {}),
            vrm: stagedAdvancedPackage.vrm,
            vrmBackup: currentGoon.files?.vrm,
            vrmPending: undefined
          }
          updates.guidedAvatar = {
            ...currentGoon.guidedAvatar,
            package: stagedAdvancedPackage.package,
            manifest: stagedAdvancedPackage.manifest,
            backup: {
              package: currentGoon.guidedAvatar.package,
              vrm: currentGoon.files?.vrm,
              manifest: currentGoon.guidedAvatar.manifest
            },
            pending: undefined,
            manifestSummary: stagedAdvancedPackage.manifestSummary ?? undefined,
            outfitPieces: advancedPackageDraft.outfitPieces,
            outfitPresets: stagedAdvancedPackage.outfitPresets,
            pieceStates: advancedPackageDraft.pieceStates,
            activePresetId: null,
            dufOverlays: editorGuidedDufOverlays
          }
          updates.compatibility = {
            tier: 'pending',
            issues: ['Awaiting Advanced/Blender Goon analysis']
          }
          updates.vrmUpdate = null
        } else {
          const validPresetIds = new Set(
            (currentGoon.guidedAvatar.outfitPresets ?? []).map((preset) => preset.id)
          )
          updates.guidedAvatar = {
            ...currentGoon.guidedAvatar,
            outfitPieces: editorGuidedOutfitPiecesDraft,
            dufOverlays: editorGuidedDufOverlays,
            pieceStates: buildPersistedGuidedPieceStates(editorGuidedOutfitPiecesDraft),
            activePresetId:
              editorGuidedActivePresetId && validPresetIds.has(editorGuidedActivePresetId)
                ? editorGuidedActivePresetId
                : null
          }
        }
      }
      if (stagedPendingVrm && !stagedAdvancedPackage) {
        updates.files = {
          ...(currentGoon?.files ?? {}),
          vrm: stagedPendingVrm,
          vrmBackup: currentGoon?.files?.vrm,
          vrmPending: undefined
        }
        updates.compatibility = {
          tier: 'pending',
          issues: ['Awaiting VRM analysis']
        }
        updates.vrmUpdate = stagedVrmReport ?? null
      }
      const savedGoon = await updateGoonRecord(editorGoonId, updates)
      await reconcileFacialArtworkUploadsAfterSave(
        currentGoon?.facialArtwork,
        savedGoon.facialArtwork
      )
      await reconcileLipArtworkUploadsAfterSave(
        currentGoon?.lipArtwork,
        savedGoon.lipArtwork
      )
      await reconcileNailArtworkUploadsAfterSave(
        currentGoon?.nailSurface,
        savedGoon.nailSurface
      )
      await reconcileSkinSurfaceUploadsAfterSave(
        currentGoon?.skinAppearance,
        savedGoon.skinAppearance
      )
      editorCueMap = normalizedEditorCueMap
      editorEmojiMap = filteredEmojiMap
      editorEmoteEmojiDrafts = buildEmoteEmojiDrafts(normalizedEditorCueMap, filteredEmojiMap)
      editorPendingVrmFile = null
      editorPendingVrmUpdate = null
      if (advancedPackageDraft) {
        editorGuidedOutfitPiecesDraft = advancedPackageDraft.outfitPieces
        editorGuidedPieceStates = advancedPackageDraft.pieceStates
        editorGuidedActivePresetId = null
        editorClosetItems = Object.fromEntries(
          advancedPackageDraft.customItems.map((item) => [item.id, item])
        )
        editorWardrobeOutfits = advancedPackageDraft.wardrobeOutfits
        closetAssignments = advancedPackageDraft.closetAssignments
      }
      editorPendingAdvancedPackageUpdate = null
      editorDirty = false
      if (options.successMessage !== null) {
        toast.success(options.successMessage ?? 'Goon settings updated')
      }
      return true
    } catch (error: any) {
      toast.error(error?.message || 'Failed to update goon settings')
      return false
    } finally {
      editorSaving = false
    }
  }

  async function saveKitchenSettings() {
    kitchenSaving = true
    try {
      const normalizedKitchenCueMap = normalizeGoonCueMap(kitchenCueMap)
      const { emojiMap: filteredEmojiMap, conflicts } = buildEmojiMapFromDrafts(
        normalizedKitchenCueMap,
        kitchenEmojiMap,
        kitchenEmoteEmojiDrafts
      )
      if (conflicts.length > 0) {
        throw new Error("You've already use this emoji")
      }
      const restKitchen = { ...(goonsSettings?.kitchen ?? {}) }
      delete (restKitchen as Record<string, unknown>).fallbackPoses
      const nextSettings: GoonsSettings = {
        ...goonsSettings,
        kitchen: {
          ...restKitchen,
          cues: normalizedKitchenCueMap,
          emojiMap: filteredEmojiMap,
          eyeContact: buildKitchenEyeContactSettings()
        }
      }
      const persistedSettings = await persistGoonsSettings(nextSettings)
      applyKitchenStateFromSettings(persistedSettings)
      kitchenEmojiMap = filteredEmojiMap
      kitchenEmoteEmojiDrafts = buildEmoteEmojiDrafts(normalizedKitchenCueMap, filteredEmojiMap)
      toast.success('Goon Kitchen updated')
      return true
    } catch (error: any) {
      toast.error(error?.message || 'Failed to update Goon Kitchen')
      return false
    } finally {
      kitchenSaving = false
    }
  }

  async function saveClosetSettings() {
    closetSaving = true
    try {
      const sanitizedGlobalCloset = sanitizeGlobalClosetLibrary(globalCloset)
      const nextSettings: GoonsSettings = {
        ...goonsSettings,
        globalCloset: sanitizedGlobalCloset
      }
      const persistedSettings = await persistGoonsSettings(nextSettings)
      applyClosetStateFromSettings(persistedSettings)
      toast.success('Closet updated')
      return true
    } catch (error: any) {
      toast.error(error?.message || 'Failed to update Closet')
      return false
    } finally {
      closetSaving = false
    }
  }

  async function saveScenesSettings() {
    if (activeSceneEdit?.type === 'marker') {
      toast.error('Apply or cancel the active Marker position first.')
      return false
    }
    if (hasPendingMarkerDrafts()) {
      toast.error('Finish or delete the pending Marker draft first.')
      return false
    }
    sceneSaving = true
    try {
      const previousScenes = cloneSceneMap(goonsSettings?.kitchen?.scenes)
      const restKitchen = { ...(goonsSettings?.kitchen ?? {}) }
      delete (restKitchen as Record<string, unknown>).fallbackPoses
      const finalizedScenes = Object.fromEntries(
        Object.entries(kitchenScenes ?? {}).map(([sceneId, scene]) => [
          sceneId,
          {
            ...scene,
            markers: scene.markers
              ? Object.fromEntries(
                  Object.entries(scene.markers).map(([postureId, list]) => [
                    postureId,
                    (list ?? []).map((marker) => {
                      const normalized = normalizeMarkerForSceneEditor(marker)
                      return {
                        id: normalized.id,
                        propId: normalized.propId,
                        position: normalized.position,
                        rotation: normalized.rotation,
                        positioned: true,
                        propLocked: true
                      } satisfies GoonSceneMarker
                    })
                  ])
                )
              : scene.markers
          } satisfies GoonSceneDefinition
        ])
      ) as GoonSceneMap
      const nextSettings: GoonsSettings = {
        ...goonsSettings,
        kitchen: {
          ...restKitchen,
          scenes: sanitizeSceneMap(finalizedScenes),
          roomTextures: kitchenRoomTextures
        }
      }
      const persistedSettings = await persistGoonsSettings(nextSettings)
      applySceneStateFromSettings(persistedSettings)
      toast.success(sceneEditorMode ? 'Scene updated' : 'Scenes updated')
      try {
        await reconcileSceneAssetUploadsAfterSave(
          previousScenes,
          persistedSettings?.kitchen?.scenes
        )
      } catch (cleanupError) {
        console.warn('[GoonsSettings] Scene saved, but scene asset cleanup failed:', cleanupError)
        toast.warning('Scene saved, but an unused Skybox or Room Shell file could not be cleaned up.')
      }
      return true
    } catch (error: any) {
      toast.error(error?.message || 'Failed to update Scenes')
      return false
    } finally {
      sceneSaving = false
    }
  }

  async function saveActiveGoonsChanges() {
    if (sceneEditorMode === 'create' && sceneCreateDirty) {
      const created = createSceneFromDraft()
      if (!created) return false
      if (!(await saveScenesSettings())) return false
    }

    if (editorHasUnsavedChanges) {
      if (!(await saveCueEditor())) return false
    }
    if (sceneDirty) {
      if (!(await saveScenesSettings())) return false
    }
    if (motionsDirty) {
      if (!(await saveMotionsAndPostures())) return false
    }
    if (closetDirty) {
      if (!(await saveClosetSettings())) return false
    }
    if (kitchenDirty) {
      if (!(await saveKitchenSettings())) return false
    }
    return true
  }

  function discardActiveGoonsChanges() {
    if (editorHasUnsavedChanges) {
      discardCueEditorChanges()
    }
    if (sceneCreateDirty || sceneDirty) {
      discardSceneChanges()
    }
    if (motionsDirty) {
      cancelMotionChanges()
    }
    if (closetDirty) {
      cancelClosetChanges()
    }
    if (kitchenDirty) {
      cancelKitchenChanges()
    }
  }

  function closeUnsavedExitDialog() {
    unsavedExitDialogOpen = false
    pendingExitIntent = null
  }

  function executeExitIntent(intent: GoonsExitIntent | null) {
    if (!intent) return

    if (intent.type === 'tab') {
      if (intent.nextTab !== 'closet') {
        cancelClosetItemEditing()
      }
      const wasEditingGoon = Boolean(editorGoonId)
      if (editorGoonId) {
        editorGoonId = null
      } else if (sceneEditorMode) {
        closeSceneEditor()
      }
      if (wasEditingGoon) {
        resetPreview('top-level-tab-change')
      }
      activeTab = intent.nextTab
      releaseInactivePreviewEngines('top-level-tab-change')
      return
    }

    if (intent.type === 'close-editor') {
      editorGoonId = null
      resetPreview('close-editor')
      return
    }

    closeSceneEditor()
  }

  function requestWorkspaceExit(intent: GoonsExitIntent) {
    if (editorHairImportOpen) {
      toast.info('Finish or cancel the active Hair import before leaving its review.')
      return
    }
    if (activeSceneEdit?.type === 'marker') {
      toast.error('Save or cancel the active marker position first.')
      return
    }
    if (
      editorHasUnsavedChanges ||
      sceneCreateDirty ||
      sceneDirty ||
      motionsDirty ||
      closetDirty ||
      kitchenDirty
    ) {
      pendingExitIntent = intent
      unsavedExitDialogOpen = true
      return
    }

    executeExitIntent(intent)
  }

  function handleTopLevelTabChange(nextValue: string) {
    const nextTab = nextValue as GoonsTopLevelTab
    if (nextTab === activeTab) return

    if (
      editorGoonId ||
      sceneEditorMode ||
      motionsDirty ||
      closetDirty ||
      kitchenDirty ||
      sceneDirty ||
      sceneCreateDirty
    ) {
      requestWorkspaceExit({ type: 'tab', nextTab })
      return
    }

    if (nextTab !== 'closet') {
      cancelClosetItemEditing()
    }
    activeTab = nextTab
    releaseInactivePreviewEngines('top-level-tab-change')
  }

  async function saveAndContinueExit() {
    const exitIntent = pendingExitIntent
    if (!exitIntent) return

    const saved = await saveActiveGoonsChanges()
    if (!saved) return

    closeUnsavedExitDialog()
    executeExitIntent(exitIntent)
  }

  function discardAndContinueExit() {
    const exitIntent = pendingExitIntent
    if (!exitIntent) return

    if (editorHasUnsavedChanges) {
      discardCueEditorChanges()
      editorGoonId = null
      resetPreview('discard-and-continue-exit')
    } else if (sceneCreateDirty || sceneDirty) {
      discardSceneChanges()
    } else if (motionsDirty) {
      cancelMotionChanges()
    }
    if (closetDirty) {
      cancelClosetChanges()
    }
    if (kitchenDirty) {
      cancelKitchenChanges()
    }

    closeUnsavedExitDialog()
    executeExitIntent(exitIntent)
  }

  const tierLabel = (tier?: string) => {
    if (!tier) return 'Pending'
    if (tier === 'A') return 'Tier A'
    if (tier === 'B') return 'Tier B'
    if (tier === 'C') return 'Tier C'
    return 'Pending'
  }

  function getCompatibilityIssues(goon: GoonRecord): string[] {
    return Array.isArray(goon.compatibility?.issues) ? goon.compatibility?.issues ?? [] : []
  }

  function hasRigWarning(goon: GoonRecord): boolean {
    const coverage = goon.compatibility?.boneCoverage
    if (!coverage) return false
    return coverage.present < coverage.total
  }

  function hasTierWarning(goon: GoonRecord): boolean {
    const tier = goon.compatibility?.tier
    if (!tier) return false
    return tier !== 'A'
  }

  function getRigTooltipText(goon: GoonRecord): string[] {
    const coverage = goon.compatibility?.boneCoverage
    const issues = getCompatibilityIssues(goon)
    const lines: string[] = []

    if (coverage) {
      lines.push(`Detected ${coverage.present}/${coverage.total} key bones.`)
    } else {
      lines.push('Bone coverage has not been analyzed yet.')
    }

    if (issues.length > 0) {
      lines.push(...issues)
    }

    return lines
  }

  function getTierTooltipText(goon: GoonRecord): string[] {
    const tier = goon.compatibility?.tier
    const issues = getCompatibilityIssues(goon)

    if (tier === 'A') {
      return ['Tier A = mouth + core expressions + core bones detected.']
    }

    if (tier === 'B') {
      return issues.length > 0
        ? ['Tier B = mouth detected, but some core expression or rig coverage is missing.', ...issues]
        : ['Tier B = mouth detected, but some core expression or rig coverage is missing.']
    }

    if (tier === 'C') {
      return issues.length > 0
        ? ['Tier C = missing mouth support or key rig coverage.', ...issues]
        : ['Tier C = missing mouth support or key rig coverage.']
    }

    return issues.length > 0 ? ['Compatibility analysis is still pending.', ...issues] : ['Compatibility analysis is still pending.']
  }

  const kitchenSaveStatus = $derived.by(() => {
    if (kitchenSaving) {
      return {
        kind: 'saving' as const,
        label: 'Saving…'
      }
    }
    if (kitchenDirty) {
      return {
        kind: 'dirty' as const,
        label: 'Unsaved Changes'
      }
    }
    return null
  })

  const closetSaveStatus = $derived.by(() => {
    if (closetSaving) {
      return {
        kind: 'saving' as const,
        label: 'Saving…'
      }
    }
    if (closetDirty) {
      return {
        kind: 'dirty' as const,
        label: 'Unsaved Changes'
      }
    }
    return null
  })

  const motionsSaveStatus = $derived.by(() => {
    if (motionsSaving) {
      return {
        kind: 'saving' as const,
        label: 'Saving…'
      }
    }
    if (motionsDirty) {
      return {
        kind: 'dirty' as const,
        label: 'Unsaved Changes'
      }
    }
    return null
  })

  const sharedLibraryDirtySection = $derived.by<'closet' | 'kitchen' | null>(() => {
    if (activeTab === 'closet' && closetDirty) return 'closet'
    if (activeTab === 'kitchen' && kitchenDirty) return 'kitchen'
    if (closetDirty) return 'closet'
    if (kitchenDirty) return 'kitchen'
    return null
  })

  const scenePrimaryActionLabel = $derived.by(() => {
    if (sceneEditorMode === 'create') {
      return sceneSaving ? 'Creating…' : 'Create Scene'
    }
    return sceneSaving ? 'Saving…' : 'Save Scene'
  })

  const dockedKitchenFooterActive = $derived.by(
    () => (activeTab === 'kitchen' || activeTab === 'closet') && !editorGoonId && !sceneEditorMode
  )
  const dockedMotionsFooterActive = $derived.by(
    () => activeTab === 'motions' && !editorGoonId && !sceneEditorMode
  )
  const dockedScenesPanelActive = $derived.by(
    () => activeTab === 'scenes' && !editorGoonId && !sceneEditorMode
  )
  const dockedTopLevelFooterActive = $derived.by(
    () => dockedKitchenFooterActive || dockedMotionsFooterActive || dockedScenesPanelActive
  )

  const sceneCreateDirty = $derived.by(() =>
    sceneEditorMode === 'create' &&
    Boolean(
      newSceneName.trim() ||
        newSceneDescription.trim() ||
        newSceneSkybox ||
        newSceneRoomShell
    )
  )

  const unsavedSectionLabels = $derived.by<string[]>(() => {
    const labels: string[] = []
    if (editorHasUnsavedChanges) labels.push('Goon Editor')
    if (sceneCreateDirty) {
      labels.push('Scene Draft')
    } else if (sceneDirty) {
      labels.push(sceneEditorMode ? 'Scene Editor' : 'Scenes')
    }
    if (motionsDirty) labels.push('Motions')
    if (closetDirty) labels.push('Closet')
    if (kitchenDirty) labels.push('Goon Kitchen')
    return labels
  })

  const unsavedSectionsText = $derived.by(() => {
    const labels = unsavedSectionLabels
    if (labels.length === 0) return 'this workspace'
    if (labels.length === 1) return labels[0]
    if (labels.length === 2) return `${labels[0]} and ${labels[1]}`
    return `${labels.slice(0, -1).join(', ')}, and ${labels[labels.length - 1]}`
  })

  const hasMultipleUnsavedSections = $derived.by(() => unsavedSectionLabels.length > 1)

  const unsavedExitSaving = $derived.by(
    () => editorSaving || kitchenSaving || closetSaving || sceneSaving || motionsSaving
  )

  const unsavedExitTitle = $derived.by(() => {
    if (hasMultipleUnsavedSections) return 'Save changes first?'
    if (editorHasUnsavedChanges) return 'Save Goon changes first?'
    if (sceneEditorMode || sceneDirty || sceneCreateDirty) return 'Save Scene changes first?'
    if (motionsDirty) return 'Save Motions changes first?'
    return sharedLibraryDirtySection === 'closet'
      ? 'Save Closet changes first?'
      : 'Save Kitchen changes first?'
  })

  const unsavedExitDescription = $derived.by(() => {
    const actionText = pendingExitIntent?.type === 'tab' ? 'leave this view' : 'close it'

    if (hasMultipleUnsavedSections) {
      return `You have unsaved changes in ${unsavedSectionsText}. Save them before you ${actionText}, or discard them and continue.`
    }

    if (editorHasUnsavedChanges) {
      return `You have unsaved Goon Editor changes. Save them before you ${actionText}, or discard them and continue.`
    }

    if (sceneCreateDirty) {
      return `You have an unfinished Scene draft. Create it before you ${actionText}, or discard it and continue.`
    }

    if (sceneEditorMode && sceneDirty) {
      return `You have unsaved Scene Editor changes. Save them before you ${actionText}, or discard them and continue.`
    }

    if (sceneDirty) {
      return `You have unsaved Scenes changes. Save them before you ${actionText}, or discard them and continue.`
    }

    if (motionsDirty) {
      return `You have unsaved Motions changes. Save them before you ${actionText}, or discard them and continue.`
    }

    return `You have unsaved ${sharedLibraryDirtySection === 'closet' ? 'Closet' : 'Goon Kitchen'} changes. Save them before you ${actionText}, or discard them and continue.`
  })

  const unsavedExitContinueLabel = $derived.by(() => {
    if (hasMultipleUnsavedSections) {
      return pendingExitIntent?.type === 'tab' ? 'Save All and Continue' : 'Save All and Close'
    }
    if (sceneCreateDirty) {
      return pendingExitIntent?.type === 'tab' ? 'Create and Continue' : 'Create and Close'
    }
    if (sceneDirty) {
      return pendingExitIntent?.type === 'tab' ? 'Save and Continue' : 'Save and Close'
    }
    if (motionsDirty) {
      return pendingExitIntent?.type === 'tab' ? 'Save and Continue' : 'Save and Close'
    }
    return pendingExitIntent?.type === 'tab' ? 'Save and Continue' : 'Save and Close'
  })

  const goonsUnsavedState = $derived.by<GoonsUnsavedState | null>(() => {
    if (hasMultipleUnsavedSections) {
      return {
        message: `You have unsaved changes in ${unsavedSectionsText}.`,
        saveLabel: 'Save Changes',
        onSave: saveActiveGoonsChanges,
        onDiscard: discardActiveGoonsChanges
      }
    }

    if (editorHasUnsavedChanges) {
      return {
        message: 'You have unsaved Goon Editor changes.',
        saveLabel: 'Save Goon',
        onSave: saveActiveGoonsChanges,
        onDiscard: discardActiveGoonsChanges
      }
    }

    if (sceneCreateDirty) {
      return {
        message: 'You have an unfinished Scene draft.',
        saveLabel: 'Create Scene',
        onSave: saveActiveGoonsChanges,
        onDiscard: discardActiveGoonsChanges
      }
    }

    if (sceneDirty) {
      return {
        message: sceneEditorMode
          ? 'You have unsaved Scene Editor changes.'
          : 'You have unsaved Scenes changes.',
        saveLabel: 'Save Scene',
        onSave: saveActiveGoonsChanges,
        onDiscard: discardActiveGoonsChanges
      }
    }

    if (motionsDirty) {
      return {
        message: 'You have unsaved Motions changes.',
        saveLabel: 'Save Motions',
        onSave: saveActiveGoonsChanges,
        onDiscard: discardActiveGoonsChanges
      }
    }

    if (closetDirty || kitchenDirty) {
      return {
        message: `You have unsaved ${sharedLibraryDirtySection === 'closet' ? 'Closet' : 'Goon Kitchen'} changes.`,
        saveLabel: sharedLibraryDirtySection === 'closet' ? 'Save Closet' : 'Save Kitchen',
        onSave: saveActiveGoonsChanges,
        onDiscard: discardActiveGoonsChanges
      }
    }

    return null
  })

  $effect(() => {
    onUnsavedStateChange(goonsUnsavedState)
  })

  $effect(() => {
    if (!goonsUnsavedState || typeof window === 'undefined') return

    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }

    window.addEventListener('beforeunload', handleBeforeUnload)

    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload)
    }
  })

  onDestroy(() => {
    invalidateSceneAssetUploadTargets()
    discardDraftSceneAssetUploads()
    onUnsavedStateChange(null)
  })
</script>

<div class="flex h-screen max-h-screen min-h-0 items-stretch overflow-hidden bg-background p-6">
  <div
    bind:this={mainSettingsShellEl}
    class="flex min-h-0 flex-1 overflow-hidden"
  >
    <Tabs.Root
      value={activeTab}
      onValueChange={handleTopLevelTabChange}
      class="flex min-h-0 flex-1 flex-col gap-6"
    >
      <Tabs.List class="mx-auto grid w-full max-w-[1100px] grid-cols-5">
          <Tabs.Trigger value="goons" class="gap-2">
            <BatshitIcon id="goons" class="h-3.5 w-3.5" />
            <span>Goons</span>
          </Tabs.Trigger>
          <Tabs.Trigger value="closet" class="gap-2">
            <BatshitIcon id="closet" class="h-3.5 w-3.5" />
            <span>Closet</span>
          </Tabs.Trigger>
          <Tabs.Trigger value="kitchen" class="gap-2">
            <BatshitIcon id="kitchen" class="h-3.5 w-3.5" />
            <span>Kitchen</span>
          </Tabs.Trigger>
          <Tabs.Trigger value="scenes" class="gap-2">
            <BatshitIcon id="scenes" class="h-3.5 w-3.5" />
            <span>Scenes</span>
          </Tabs.Trigger>
          <Tabs.Trigger value="motions" class="gap-2">
            <BatshitIcon id="motions" class="h-3.5 w-3.5" />
            <span>Motions</span>
          </Tabs.Trigger>
        </Tabs.List>

      <input
        class="hidden"
        type="file"
        accept="image/png,image/jpeg"
        bind:this={sceneUploadInput}
        onchange={handleSceneSelection}
      />
      <input
        class="hidden"
        type="file"
        accept=".glb,.gltf,model/gltf-binary,model/gltf+json"
        bind:this={sceneRoomShellInput}
        onchange={handleRoomShellSelection}
      />
      <input
        class="hidden"
        type="file"
        accept=".glb,.gltf,model/gltf-binary,model/gltf+json"
        bind:this={scenePropInput}
        onchange={handleScenePropSelection}
      />
      <input
        class="hidden"
        type="file"
        accept="image/png,image/jpeg"
        bind:this={roomTextureInput}
        onchange={handleRoomTextureSelection}
      />
      {#if !editorGoonId && !sceneEditorMode}
      <div class="goon-tab-content-shell flex min-h-0 flex-1 items-stretch overflow-hidden">
        <div
          class={`min-w-0 flex-1 min-h-0 ${dockedTopLevelFooterActive ? 'overflow-hidden' : 'overflow-y-auto'}`}
        >
          <div class={dockedTopLevelFooterActive ? 'h-full' : 'space-y-6'}>
      {#if activeTab === 'motions'}
    <Card.Root
      class={`batshit-settings-card batshit-settings-card-default batshit-settings-l1-card ${
        dockedMotionsFooterActive ? 'flex h-full min-h-0 flex-col overflow-hidden pb-0' : ''
      }`}
    >
      <Card.Header>
        <div class="flex items-center gap-1.5">
          <Card.Title class="flex items-center gap-2">
            <BatshitIcon id="motions" class="h-4 w-4" />
            Motions
          </Card.Title>
          <SettingsInfoMenu ariaLabel="About Motions" contentClass="w-80">
            <p>
              Import, tag, preview, and organize reusable Motion clips. Posture sections keep
              motion placement and Scene marker behavior aligned.
            </p>
          </SettingsInfoMenu>
        </div>
      </Card.Header>
      <Card.Content class={dockedMotionsFooterActive ? 'batshit-settings-card-content-flush flex min-h-0 flex-1 flex-col' : 'batshit-settings-card-content-flush space-y-6'}>
        <div class={dockedMotionsFooterActive ? 'min-h-0 flex-1 overflow-y-auto' : ''}>
          <div class="space-y-4 px-5 pt-4">
            <div class="batshit-settings-muted-panel space-y-2">
              <div class="flex flex-wrap items-center justify-between gap-2">
                <div class="flex items-center gap-1.5">
                  <div class="batshit-settings-form-label">Upload Animations</div>
                  <SettingsInfoMenu ariaLabel="About Upload Animations" contentClass="w-80">
                    {#if fbxInstallStatus?.supportLevel === 'docker-worker' || fbxInstallStatus?.supportLevel === 'docker-worker-missing'}
                      <p>
                        Upload VRMA files directly. In Docker, FBX upload becomes available when
                        the FBX-to-VRMA worker sidecar is active.
                      </p>
                    {:else}
                      <p>
                        Upload VRMA files directly. FBX upload becomes available when the local
                        FBX converter is installed, and Batshit converts those files to VRMA during
                        import.
                      </p>
                    {/if}
                  </SettingsInfoMenu>
                </div>
                {#if fbxInstallStatus?.supportLevel === 'docker-worker'}
                  <Badge variant="outline" class="batshit-settings-child-label">
                    FBX Worker Active
                  </Badge>
                {:else if fbxInstallStatus?.supportLevel === 'docker-worker-missing'}
                  <Badge variant="outline" class="batshit-settings-child-label">
                    FBX Worker Not Running
                  </Badge>
                {:else if fbxInstallStatus?.installed}
                  <Badge variant="outline" class="batshit-settings-child-label">
                    FBX Converter Installed
                  </Badge>
                {:else if fbxInstallStatus}
                  <Badge variant="outline" class="batshit-settings-child-label">
                    FBX Converter Not Installed
                  </Badge>
                {/if}
              </div>
              <input
                class="hidden"
                type="file"
                accept={fbxInstallStatus?.installed ? '.vrma,.glb,.gltf,.fbx' : '.vrma,.glb,.gltf'}
                multiple
                bind:this={libraryUploadInput}
                onchange={handleLibrarySelection}
              />
              <div class="flex flex-wrap items-center gap-2">
                <Button onclick={() => libraryUploadInput?.click()} disabled={libraryUploadBusy || fbxInstallBusy}>
                  {libraryUploadBusy
                    ? 'Uploading…'
                    : fbxInstallStatus?.installed
                      ? 'Upload VRMA / GLB / FBX'
                      : 'Upload VRMA / GLB'}
                </Button>
                <Button
                  variant="outline"
                  size="sm"

                  onclick={loadFbxInstallStatus}
                  disabled={fbxInstallBusy}
                >
                  <RefreshCw class={`${fbxInstallBusy ? 'animate-spin' : ''}`} />
                  {fbxInstallBusy
                    ? 'Checking…'
                    : fbxInstallStatus?.supportLevel === 'docker-worker' || fbxInstallStatus?.supportLevel === 'docker-worker-missing'
                      ? 'Refresh Worker'
                      : 'Refresh Converter'}
                </Button>
              </div>
              {#if libraryUploadBusy}
                <p class="batshit-settings-form-label">
                  Uploading {libraryUploadDone}/{libraryUploadTotal}…
                </p>
              {/if}
            </div>

            <div class="space-y-3">
              <div class="flex flex-wrap items-center justify-between gap-2">
                <div class="flex items-center gap-2">
                  <Button variant="outline" size="sm" onclick={addMotionPostureDraft}>
                    <Plus aria-hidden="true" />
                    Add Posture
                  </Button>
                  <SettingsInfoMenu ariaLabel="About Motion Posture Sections" contentClass="w-96">
                    <p>
                      Stage Postures group your Motion library and also help Scenes place a Goon in
                      the correct location when that Motion plays.
                    </p>
                    <p>
                      Built-in sections `Any Posture`, `Standing`, `Sitting`, and `Lying` always
                      exist. Custom posture edits stay staged until you click `Save Motions`.
                    </p>
                    <p>
                      Deleting a custom posture rebases its Motion and Scene placement references to
                      that posture’s Base Posture before save.
                    </p>
                  </SettingsInfoMenu>
                </div>
              </div>

              {#if sortedMotionEntries.length > 0}
                <div class="flex flex-wrap items-center gap-2">
                  {#if animationTagOptions.length > 0 || untaggedCount > 0}
                    <button
                      type="button"
                      class={`batshit-goon-motion-filter-chip ${
                        animationTagFilterMode === 'all' ? 'is-selected' : ''
                      }`}
                      onclick={resetAnimationTagFilters}
                    >
                      All
                    </button>
                    {#if untaggedCount > 0}
                      <button
                        type="button"
                        class={`batshit-goon-motion-filter-chip ${
                          animationTagFilterMode === 'untagged' ? 'is-selected' : ''
                        }`}
                        onclick={showUntaggedAnimationFilter}
                      >
                        Untagged ({untaggedCount})
                      </button>
                    {/if}
                    {#each animationTagOptions as tag}
                      <button
                        type="button"
                        class={`batshit-goon-motion-filter-chip ${
                          isAnimationTagFilterSelected(tag) ? 'is-selected' : ''
                        }`}
                        onclick={() => toggleAnimationTagFilter(tag)}
                      >
                        {tag}
                      </button>
                    {/each}
                  {/if}
                  <div class="ml-auto flex items-center gap-2">
                    {#if motionLibraryEntries.some((entry) => entry.glb)}
                      <div class="flex items-center gap-1.5">
                        <Label.Root class="batshit-settings-form-label">GLB Preview Body</Label.Root>
                        <SettingsInfoMenu ariaLabel="About GLB Preview Body" contentClass="w-80">
                          <p>
                            GLB motions preview on the built-in Batshit dummy, which uses the
                            first-party Goon skeleton.
                          </p>
                          <p>
                            If your GLB motions were made for a different skeleton, pick one of
                            your own Advanced/GLB Goons here so previews bind to the right bones.
                          </p>
                        </SettingsInfoMenu>
                        <Select.Root
                          type="single"
                          value={glbPreviewGoonId}
                          onValueChange={(value: string) => {
                            void persistGlbPreviewGoonSelection(value)
                          }}
                        >
                          <Select.Trigger class="batshit-settings-select-compact w-44">
                            {glbPreviewGoonId
                              ? glbPreviewGoonOptions.find((entry) => entry.id === glbPreviewGoonId)
                                  ?.name ?? 'Batshit Dummy'
                              : 'Batshit Dummy'}
                          </Select.Trigger>
                          <Select.Content>
                            <Select.Item value="">Batshit Dummy</Select.Item>
                            {#each glbPreviewGoonOptions as goonOption (goonOption.id)}
                              <Select.Item value={goonOption.id}>{goonOption.name}</Select.Item>
                            {/each}
                          </Select.Content>
                        </Select.Root>
                      </div>
                    {/if}
                    <DropdownMenu.Root>
                      <DropdownMenu.Trigger
                        class="batshit-settings-icon-trigger"
                        aria-label={`Sort motions. Current sort: ${animationSortLabel}`}
                        title={`Sort motions: ${animationSortLabel}`}
                      >
                        <ArrowDownUp class="h-4 w-4" />
                      </DropdownMenu.Trigger>
                      <DropdownMenu.Content align="end" class="w-44">
                        {#each ANIMATION_SORT_OPTIONS as option}
                          <DropdownMenu.Item
                            onSelect={() => {
                              animationSortMode = option.value
                            }}
                          >
                            <div class="flex w-full items-center justify-between gap-2">
                              <span>{option.label}</span>
                              {#if animationSortMode === option.value}
                                <Check class="h-4 w-4" />
                              {/if}
                            </div>
                          </DropdownMenu.Item>
                        {/each}
                      </DropdownMenu.Content>
                    </DropdownMenu.Root>
                  </div>
                </div>
              {/if}

              {#if filteredMotionEntries.length === 0}
                <p class="batshit-settings-form-label">No motions match this filter.</p>
              {/if}
            </div>

            <div class="space-y-3">
              {#each motionAccordionItems as section (section.id)}
                {@const sectionOpen = openMotionPostureId === section.id}
                {@const sectionEditing = editingMotionPostureId === section.id}
                <Collapsible.Root open={sectionOpen}>
                  <div
                    role="button"
                    tabindex="0"
                    class={goonAccordionHeaderClass}
                    aria-expanded={sectionOpen}
                    onclick={() => {
                      if (sectionEditing) return
                      openMotionPostureId = sectionOpen ? null : section.id
                    }}
                    onkeydown={(event) => {
                      if (sectionEditing) return
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        openMotionPostureId = sectionOpen ? null : section.id
                      }
                    }}
                  >
                    {#if sectionEditing}
                      <div class="min-w-0 flex-1 space-y-2">
                        <div class="grid gap-2 sm:grid-cols-[minmax(0,1fr)_180px_auto] sm:items-end">
                          <div class="space-y-1">
                            <Label.Root class="batshit-settings-form-label">Name</Label.Root>
                            <Input
                              class="batshit-settings-grid-control"
                              value={postureNameInputs[section.id] ?? section.name}
                              onclick={(event) => event.stopPropagation()}
                              oninput={(event) => {
                                postureNameInputs = {
                                  ...postureNameInputs,
                                  [section.id]: (event.currentTarget as HTMLInputElement).value
                                }
                              }}
                              onkeydown={(event) => {
                                if (event.key === 'Enter') {
                                  event.preventDefault()
                                  event.stopPropagation()
                                  applyMotionPostureEdits(section.id)
                                }
                              }}
                            />
                          </div>
                          <div class="space-y-1">
                            <Label.Root class="batshit-settings-form-label">Base</Label.Root>
                            <Select.Root
                              type="single"
                              value={postureBaseInputs[section.id] ?? section.basePosture ?? 'stand'}
                              onValueChange={(value: string) => {
                                if (!isBuiltInPosture(value)) return
                                postureBaseInputs = {
                                  ...postureBaseInputs,
                                  [section.id]: value
                                }
                              }}
                            >
                              <Select.Trigger
                                class="batshit-settings-grid-control"
                                onclick={(event) => event.stopPropagation()}
                                onkeydown={(event) => event.stopPropagation()}
                              >
                                {getPostureLabel(
                                  postureBaseInputs[section.id] ?? section.basePosture ?? 'stand',
                                  motionStagePostureMap
                                )}
                              </Select.Trigger>
                              <Select.Content>
                                <Select.Item value="stand">Standing</Select.Item>
                                <Select.Item value="sit">Sitting</Select.Item>
                                <Select.Item value="lay">Lying</Select.Item>
                              </Select.Content>
                            </Select.Root>
                          </div>
                          <div class="flex items-center gap-1 sm:justify-end">
                            <Button
                              variant="outline"
                              size="icon"

                              aria-label={`Apply edits to ${section.name}`}
                              title="Apply Posture Edits"
                              onclick={(event) => {
                                event.preventDefault()
                                event.stopPropagation()
                                applyMotionPostureEdits(section.id)
                              }}
                            >
                              <Check  />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"

                              aria-label={`Cancel edits to ${section.name}`}
                              title="Cancel Posture Edits"
                              onclick={(event) => {
                                event.preventDefault()
                                event.stopPropagation()
                                cancelMotionPostureEdits(section.id)
                              }}
                            >
                              <X  />
                            </Button>
                          </div>
                        </div>
                        <div class="flex items-center justify-between gap-2">
                          <div class="batshit-settings-caption min-w-0">{section.usageSummary}</div>
                          <Button
                            variant="ghost"
                            size="icon"
                            class="is-danger batshit-button-shrink-0"
                            aria-label={`Delete ${section.name}`}
                            title="Delete Posture"
                            onclick={(event) => {
                              event.preventDefault()
                              event.stopPropagation()
                              deleteMotionPostureDraft(section.id)
                            }}
                          >
                            <Trash2  />
                          </Button>
                        </div>
                      </div>
                    {:else}
                      <div class="flex items-start justify-between gap-3">
                        <div class="min-w-0 flex-1">
                          <div class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                            <span class="batshit-settings-form-label truncate">{section.name}</span>
                            {#if section.basePosture}
                              <Badge variant="outline" class="batshit-settings-child-label">
                                Base: {getPostureLabel(section.basePosture, motionStagePostureMap)}
                              </Badge>
                            {/if}
                          </div>
                          <div class="batshit-settings-caption mt-1">
                            {section.usageSummary}
                          </div>
                        </div>
                        <div class="flex items-center gap-1">
                          {#if section.editable}
                            <Button
                              variant="ghost"
                              size="icon"

                              aria-label={`Edit ${section.name}`}
                              title="Edit Posture"
                              onclick={(event) => {
                                event.preventDefault()
                                event.stopPropagation()
                                startEditingMotionPosture(section.id)
                              }}
                            >
                              <Pencil  />
                            </Button>
                          {/if}
                          <ChevronDown
                            class={`h-4 w-4 shrink-0 transition-transform ${sectionOpen ? 'rotate-180' : ''}`}
                          />
                        </div>
                      </div>
                    {/if}
                  </div>
                  <Collapsible.Content class="pt-3">
                    {#if section.entries.length === 0}
                      <p class="batshit-settings-form-label">
                        No motions currently assigned to this posture.
                      </p>
                    {:else}
                      <div class="space-y-3">
                        {#each section.entries as motionEntry, motionIndex (motionEntry.name)}
                          {@const animationName = motionEntry.name}
                          {@const previewId = motionEntry.name}
                          {@const entryDraft = resolveMotionEntryDraft(motionEntry)}
                          {@const displayName = entryDraft.displayName}
                          {@const postureValue = entryDraft.posture}
                          {@const playbackValue = entryDraft.playback}
                          {@const eyeContactValue = entryDraft.eyeContact}
                          {@const currentTags = normalizeTagInput(entryDraft.tags)}
                          {@const previewLane = resolveMotionEntryPreviewLane(motionEntry)}
                          {@const previewFile = resolveMotionEntryPreviewFile(motionEntry)}
                          {@const motionThumbTarget = resolveMotionThumbTarget(previewFile)}
                          {@const isPairedMotion = Boolean(motionEntry.vrma && motionEntry.glb)}
                          <div class="batshit-goon-motion-card rounded-md border p-3">
                            <div class="batshit-goon-motion-card-body">
                              <div class="flex shrink-0 flex-col items-center gap-1.5">
                                <AnimationPreviewThumb
                                  previewTarget={motionThumbTarget.target}
                                  previewUnavailableReason={motionThumbTarget.unavailableReason}
                                  animationFile={previewFile}
                                  animationName={animationName}
                                  previewId={previewId}
                                  active={activePreviewId === previewId}
                                  containerOpen={sectionOpen}
                                  warmOnOpen={sectionOpen && motionIndex < 5}
                                  onRequestPlay={() => {
                                    void triggerMotionLibraryPreview(previewFile, animationName, previewId)
                                  }}
                                />
                                {#if isPairedMotion}
                                  <div
                                    class="batshit-goon-motion-lane-toggle"
                                    role="group"
                                    aria-label={`Preview format for ${displayName}`}
                                  >
                                    <button
                                      type="button"
                                      class={`batshit-goon-motion-lane-toggle-option ${previewLane === 'vrm' ? 'is-selected' : ''}`}
                                      title="Preview the VRMA version (VRM Goons)"
                                      onclick={() => setMotionEntryPreviewLane(motionEntry, 'vrm')}
                                    >
                                      VRMA
                                    </button>
                                    <button
                                      type="button"
                                      class={`batshit-goon-motion-lane-toggle-option ${previewLane === 'glb' ? 'is-selected' : ''}`}
                                      title="Preview the GLB version (Advanced/GLB Goons)"
                                      onclick={() => setMotionEntryPreviewLane(motionEntry, 'glb')}
                                    >
                                      GLB
                                    </button>
                                  </div>
                                {/if}
                              </div>
                              <div class="min-w-0 flex-1 space-y-3">
                                <div class="flex items-start justify-between gap-2">
                                  <div class="min-w-0 flex-1 space-y-1">
                                    <div class="flex items-center gap-1.5">
                                      <Label.Root class="batshit-settings-form-label">Name</Label.Root>
                                      {#each motionEntry.files as versionFile (versionFile.filename || versionFile.url)}
                                        {@const versionBadge = getMotionLaneBadge(resolveGoonMotionLane(versionFile))}
                                        <Badge
                                          variant="outline"
                                          class="batshit-settings-child-label"
                                          title={versionBadge.title}
                                        >
                                          {versionBadge.label}
                                        </Badge>
                                      {/each}
                                      <SettingsInfoMenu
                                        ariaLabel={`About ${displayName} source files`}
                                        contentClass="w-80"
                                      >
                                        {#if isPairedMotion}
                                          <p>
                                            This Motion has both formats. Each Goon plays the version
                                            its rig understands, and name, tags, and settings stay
                                            shared between them.
                                          </p>
                                        {/if}
                                        {#each motionEntry.files as versionFile (versionFile.filename || versionFile.url)}
                                          {@const versionBadge = getMotionLaneBadge(resolveGoonMotionLane(versionFile))}
                                          <div class="flex items-center justify-between gap-2">
                                            <p class="min-w-0 break-all">
                                              <strong>{versionBadge.label}:</strong>
                                              {resolveMotionSourceFilename(versionFile)}
                                            </p>
                                            {#if motionEntry.files.length > 1}
                                              <Button
                                                variant="ghost"
                                                size="icon"
                                                class="is-danger shrink-0"
                                                aria-label={`Remove the ${versionBadge.label} version of ${displayName}`}
                                                title={`Remove ${versionBadge.label} version`}
                                                onclick={() => handleMotionVersionDelete(motionEntry, versionFile)}
                                                disabled={libraryUploadBusy}
                                              >
                                                <Trash2  />
                                              </Button>
                                            {/if}
                                          </div>
                                        {/each}
                                      </SettingsInfoMenu>
                                    </div>
                                    <Input
                                      class="batshit-settings-grid-control"
                                      value={displayName}
                                      oninput={(event) => {
                                        stageMotionEntryDraft(motionEntry, {
                                          displayName: (event.currentTarget as HTMLInputElement).value
                                        })
                                      }}
                                    />
                                  </div>
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    class="is-danger"
                                    aria-label={`Delete ${displayName}`}
                                    title={isPairedMotion ? 'Delete Motion (both formats)' : 'Delete Motion'}
                                    onclick={() => handleMotionEntryDelete(motionEntry)}
                                    disabled={libraryUploadBusy}
                                  >
                                    <Trash2  />
                                  </Button>
                                </div>

                                <div class="flex flex-wrap items-center gap-1.5">
                                  {#each currentTags as tag}
                                    <span class="batshit-goon-tag">
                                      <span>{tag}</span>
                                      <button
                                        type="button"
                                        class="batshit-goon-tag-remove"
                                        aria-label={`Remove ${tag} tag`}
                                        onclick={() => removeMotionEntryTag(motionEntry, tag)}
                                      >
                                        <X aria-hidden="true" />
                                      </button>
                                    </span>
                                  {/each}
                                  <DropdownMenu.Root
                                    onOpenChange={(open) => {
                                      activeAnimationTagMenu = open ? motionEntry.name : activeAnimationTagMenu === motionEntry.name ? null : activeAnimationTagMenu
                                      if (!open) {
                                        newAnimationTagDraft = ''
                                      }
                                    }}
                                  >
                                    <DropdownMenu.Trigger
                                      class="batshit-goon-tag-add-trigger"
                                      aria-label={`Add tag to ${displayName}`}
                                    >
                                      +tag
                                    </DropdownMenu.Trigger>
                                    <DropdownMenu.Content align="start" class="w-56">
                                      {#each getAvailableAnimationTagChoices(currentTags) as tag}
                                        <DropdownMenu.Item onSelect={() => addMotionEntryTag(motionEntry, tag)}>
                                          {tag}
                                        </DropdownMenu.Item>
                                      {/each}
                                      {#if getAvailableAnimationTagChoices(currentTags).length === 0}
                                        <div class="px-2 py-1.5 text-[11px] text-muted-foreground">
                                          No other active tags yet.
                                        </div>
                                      {/if}
                                      <div class="batshit-goon-tag-menu-create space-y-2">
                                        <Input
                                          class="batshit-settings-grid-control"
                                          placeholder="New tag"
                                          value={activeAnimationTagMenu === motionEntry.name ? newAnimationTagDraft : ''}
                                          oninput={(event) => {
                                            newAnimationTagDraft = (event.currentTarget as HTMLInputElement).value
                                          }}
                                          onkeydown={(event) => {
                                            if (event.key === 'Enter') {
                                              event.preventDefault()
                                              addNewMotionEntryTag(motionEntry)
                                            }
                                          }}
                                        />
                                        <Button
                                          size="sm"
                                          class="batshit-settings-select-compact batshit-button-full"
                                          onclick={() => addNewMotionEntryTag(motionEntry)}
                                        >
                                          <Plus aria-hidden="true" />
                                          Add Tag
                                        </Button>
                                      </div>
                                    </DropdownMenu.Content>
                                  </DropdownMenu.Root>
                                </div>

                                <div class="batshit-goon-motion-meta-grid">
                                  <div class="space-y-1">
                                    <div class="batshit-goon-motion-meta-label">
                                      <Label.Root class="batshit-settings-form-label">Posture</Label.Root>
                                      <SettingsInfoMenu
                                        ariaLabel={`About ${displayName} posture`}
                                        contentClass="w-80"
                                      >
                                        <p>
                                          Stage Posture helps Scenes know where to place the Goon
                                          when this Motion plays.
                                        </p>
                                        <p>
                                          Changing this dropdown stages the Motion for a different
                                          posture section, and the card moves there after you click
                                          `Save Motions`.
                                        </p>
                                      </SettingsInfoMenu>
                                    </div>
                                    <Select.Root
                                      type="single"
                                      value={postureValue}
                                      onValueChange={(value: string) => {
                                        stageMotionEntryDraft(motionEntry, {
                                          posture:
                                            value && motionStagePostureMap[value]
                                              ? (value as GoonPosture)
                                              : ''
                                        })
                                      }}
                                    >
                                      <Select.Trigger class="batshit-settings-select-compact w-full">
                                        {postureValue
                                          ? getPostureLabel(postureValue, motionStagePostureMap)
                                          : 'Any posture'}
                                      </Select.Trigger>
                                      <Select.Content>
                                        <Select.Item value="">Any posture</Select.Item>
                                        {#each motionStagePostureOptions as posture}
                                          <Select.Item value={posture.id}>{posture.name}</Select.Item>
                                        {/each}
                                      </Select.Content>
                                    </Select.Root>
                                  </div>
                                  <div class="space-y-1">
                                    <div class="batshit-goon-motion-meta-label">
                                      <Label.Root class="batshit-settings-form-label">Eye Contact</Label.Root>
                                      <SettingsInfoMenu
                                        ariaLabel={`About ${displayName} eye contact`}
                                        contentClass="w-80"
                                      >
                                        <p>
                                          `Auto` lets the Dock or Preview Eye Contact toggle control
                                          this Motion.
                                        </p>
                                        <p>
                                          `Off` is for big Motions, like dancing, where trying to
                                          lock onto the camera looks unnatural.
                                        </p>
                                      </SettingsInfoMenu>
                                    </div>
                                    <Select.Root
                                      type="single"
                                      value={eyeContactValue}
                                      onValueChange={(value: string) => {
                                        stageMotionEntryDraft(motionEntry, {
                                          eyeContact: value === 'off' ? 'off' : ''
                                        })
                                      }}
                                    >
                                      <Select.Trigger class="batshit-settings-select-compact w-full">
                                        {eyeContactValue === 'off' ? 'Off' : 'Auto'}
                                      </Select.Trigger>
                                      <Select.Content>
                                        <Select.Item value="">Auto</Select.Item>
                                        <Select.Item value="off">Off</Select.Item>
                                      </Select.Content>
                                    </Select.Root>
                                  </div>
                                  <div class="space-y-1">
                                    <div class="batshit-goon-motion-meta-label">
                                      <Label.Root class="batshit-settings-form-label">Playback</Label.Root>
                                      <SettingsInfoMenu
                                        ariaLabel={`About ${displayName} playback`}
                                        contentClass="w-80"
                                      >
                                        <p>
                                          `Loop` is best for motions that should repeat cleanly
                                          without feeling like they restart.
                                        </p>
                                        <p>
                                          `One-shot` is better for gestures or single events that
                                          should play once instead of looping.
                                        </p>
                                      </SettingsInfoMenu>
                                    </div>
                                    <Select.Root
                                      type="single"
                                      value={playbackValue}
                                      onValueChange={(value: string) => {
                                        stageMotionEntryDraft(motionEntry, {
                                          playback:
                                            value === 'loop' || value === 'oneshot'
                                              ? (value as GoonMotionPlayback)
                                              : ''
                                        })
                                      }}
                                    >
                                      <Select.Trigger class="batshit-settings-select-compact w-full">
                                        {playbackValue === 'loop'
                                          ? 'Loop'
                                          : playbackValue === 'oneshot'
                                            ? 'One-shot'
                                            : 'Pick playback'}
                                      </Select.Trigger>
                                      <Select.Content>
                                        <Select.Item value="">Pick playback</Select.Item>
                                        <Select.Item value="loop">Loop</Select.Item>
                                        <Select.Item value="oneshot">One-shot</Select.Item>
                                      </Select.Content>
                                    </Select.Root>
                                  </div>
                                </div>
                              </div>
                            </div>
                          </div>
                        {/each}
                      </div>
                    {/if}
                  </Collapsible.Content>
                </Collapsible.Root>
              {/each}
            </div>
          </div>
        </div>

        {#if dockedMotionsFooterActive}
          <div class="batshit-settings-footer-bar shrink-0 mt-4">
            <div class="flex flex-wrap items-center justify-between gap-3">
              <div class="min-h-6">
                {#if motionsSaveStatus}
                  <div
                    class={`batshit-settings-save-status ${
                      motionsSaveStatus.kind === 'dirty' ? 'is-warning' : 'is-busy'
                    }`}
                  >
                    {#if motionsSaveStatus.kind === 'dirty'}
                      <CircleAlert class="h-3.5 w-3.5" />
                    {:else}
                      <RefreshCw class="h-3.5 w-3.5 animate-spin" />
                    {/if}
                    <span>{motionsSaveStatus.label}</span>
                  </div>
                {/if}
              </div>
              <div class="flex flex-wrap items-center gap-2">
                <Button
                  variant="outline"
                  onclick={cancelMotionChanges}
                  disabled={!motionsDirty || motionsSaving}
                >
                  <X aria-hidden="true" />
                  Cancel
                </Button>
                <Button onclick={saveMotionsAndPostures} disabled={!motionsDirty || motionsSaving}>
                  {motionsSaving ? 'Saving…' : 'Save Motions'}
                </Button>
              </div>
            </div>
          </div>
        {/if}
      </Card.Content>
    </Card.Root>
  {:else}
    {#if activeTab === 'goons'}
      <SettingsAccordionCard name="goon-settings-cards" title="Create Goons" batshitIcon="goons" open>
        {#snippet info()}
          <SettingsInfoMenu ariaLabel="About Create Goons" contentClass="w-80">
            <p>
              Start a new Goon by importing a Standard/VRoid VRM, uploading an Advanced/Blender
              package, or using a temporary starter Goon while you build something more bespoke.
            </p>
          </SettingsInfoMenu>
        {/snippet}
        <div class="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(280px,0.85fr)]">
          <div class="space-y-4">
	        <div class="space-y-3 batshit-settings-muted-panel">
            <div class="flex items-center gap-1.5">
              <span class="batshit-goon-brand-strip" aria-label="VRoid and VRM format icons">
                {#each STANDARD_GOON_FORMAT.icons as icon (icon.label)}
                  <IconRenderer
                    ref={icon.ref}
                    label={icon.label}
                    class={`batshit-goon-brand-icon ${icon.wide ? 'is-wide' : ''}`}
                    iconClass="h-full w-full"
                    imageClass="h-full w-full object-contain"
                  />
                {/each}
              </span>
              <div class="batshit-settings-form-label batshit-goon-format-title">Create New Goon (Standard/VRoid)</div>
              <SettingsInfoMenu ariaLabel="About Create New Goon" contentClass="w-80">
                <p>
                  Import a standard VRM 1.0 or VRoid avatar into your Goon library. Name, description, and
                  the rest of the per-Goon tuning happen after creation inside the Goon Editor.
                </p>
              </SettingsInfoMenu>
            </div>
            <input
              class="hidden"
              type="file"
              accept=".vrm"
              bind:this={uploadInput}
              onchange={handleUploadSelection}
            />
            <Button onclick={() => uploadInput?.click()} disabled={uploadBusy}>
              {uploadBusy ? 'Uploading…' : 'Create New Goon'}
            </Button>
          </div>

	        <div class="space-y-3 batshit-settings-muted-panel">
            <div class="flex items-center gap-1.5">
              <span class="batshit-goon-brand-strip" aria-label="Blender and VRM format icons">
                {#each ADVANCED_BLENDER_GOON_FORMAT.icons as icon (icon.label)}
                  <IconRenderer
                    ref={icon.ref}
                    label={icon.label}
                    class={`batshit-goon-brand-icon ${icon.wide ? 'is-wide' : ''}`}
                    iconClass="h-full w-full"
                    imageClass="h-full w-full object-contain"
                  />
                {/each}
              </span>
              <div class="batshit-settings-form-label batshit-goon-format-title">Create New Goon (Advanced/Blender)</div>
              <SettingsInfoMenu ariaLabel="About Advanced/Blender Goons" contentClass="w-80">
                <p>
                  Upload one `.bgoon` or `.zip` package from the Batshit Blender addon containing `avatar.vrm` and
                  `avatar.json`. Batshit keeps the VRM runtime path, while the package manifest
                  carries the Advanced/Blender metadata Batshit needs.
                </p>
              </SettingsInfoMenu>
            </div>
            <input
              class="hidden"
              type="file"
              accept=".bgoon,.zip"
              bind:this={guidedUploadInput}
              onchange={handleGuidedUploadSelection}
            />
            <Button onclick={() => guidedUploadInput?.click()} disabled={guidedUploadBusy}>
              {guidedUploadBusy ? 'Uploading…' : 'Create Advanced/Blender Goon'}
            </Button>
          </div>

          <div class="space-y-3 batshit-settings-muted-panel">
            <div class="flex items-center gap-1.5">
              <span class="batshit-goon-brand-strip" aria-label="Batshit and GLB format icons">
                {#each ADVANCED_GLB_GOON_FORMAT.icons as icon (icon.label)}
                  <IconRenderer
                    ref={icon.ref}
                    label={icon.label}
                    class={`batshit-goon-brand-icon ${icon.wide ? 'is-wide' : ''}`}
                    iconClass="h-full w-full"
                    imageClass="h-full w-full object-contain"
                  />
                {/each}
              </span>
              <div class="batshit-settings-form-label batshit-goon-format-title">Create New Goon (Advanced/GLB)</div>
              <SettingsInfoMenu ariaLabel="About Advanced/GLB Goons" contentClass="w-80">
                <p>
                  Upload one `.bgoon` or `.zip` package containing `avatar.glb` and `avatar.json`.
                  Batshit keeps the GLB model and drives it from the manifest (stage anchors, face
                  controls, morphs). This is the first-party avatar path for the new Goon system.
                </p>
              </SettingsInfoMenu>
            </div>
            <input
              class="hidden"
              type="file"
              accept=".bgoon,.zip"
              bind:this={customUploadInput}
              onchange={handleCustomUploadSelection}
            />
            <Button onclick={() => customUploadInput?.click()} disabled={customUploadBusy}>
              {customUploadBusy ? 'Uploading…' : 'Create Advanced/GLB Goon'}
            </Button>
          </div>
          </div>

	        <div class="space-y-3 batshit-settings-muted-panel">
          <div class="flex items-center gap-1.5">
            <span class="batshit-goon-brand-strip" aria-label="VRoid and VRM format icons">
              {#each STANDARD_GOON_FORMAT.icons as icon (icon.label)}
                <IconRenderer
                  ref={icon.ref}
                  label={icon.label}
                  class={`batshit-goon-brand-icon ${icon.wide ? 'is-wide' : ''}`}
                  iconClass="h-full w-full"
                  imageClass="h-full w-full object-contain"
                />
              {/each}
            </span>
            <div class="batshit-settings-form-label batshit-goon-format-title">Starter Goons (VRoid)</div>
            <SettingsInfoMenu ariaLabel="About Starter Goons" contentClass="w-80">
              <p>
                Quick-start placeholders built in VRoid Studio. Batshit downloads the starter only
                when you import it, then stores it with your normal Goon uploads.
              </p>
            </SettingsInfoMenu>
          </div>
          {#each STARTER_GOON_ASSETS as starter (starter.id)}
            <div class="flex items-center justify-between gap-3 rounded-md border p-3">
              <div>
                <div class="batshit-settings-form-label">{starter.name}</div>
                <div class="batshit-settings-form-label">{starter.description}</div>
              </div>
              <Button
                variant="outline"
                size="sm"
                onclick={() => handleStarterGoonImport(starter)}
                disabled={starterImportBusy[starter.id]}
              >
                {starterImportBusy[starter.id] ? 'Importing…' : 'Import'}
              </Button>
            </div>
          {/each}
        </div>
      </div>
    </SettingsAccordionCard>
    {/if}
    {#if activeTab === 'closet'}
      <Card.Root
        class={`batshit-settings-card batshit-settings-card-default batshit-settings-l1-card ${
          dockedKitchenFooterActive ? 'flex h-full min-h-0 flex-col overflow-hidden pb-0' : ''
        }`}
      >
        <Card.Header class="flex items-start justify-between gap-4">
          <div class="flex items-center gap-1.5">
            <Card.Title class="flex items-center gap-2">
              <BatshitIcon id="closet" class="h-4 w-4" />
              Global Closet
            </Card.Title>
            <SettingsInfoMenu ariaLabel="About Global Closet" contentClass="w-80">
              <p>
                Import and organize the shared XWear library here. These items are reusable across
                Goons, while each Goon can still keep its own smaller wardrobe inside the editor.
              </p>
            </SettingsInfoMenu>
          </div>
          <div class="flex flex-wrap justify-end gap-2">
            <input
              class="hidden"
              type="file"
              accept=".xwear"
              bind:this={closetXWearInput}
              onchange={handleClosetXWearSelection}
            />
            <Button onclick={() => closetXWearInput?.click()} disabled={closetXWearBusy}>
              {closetXWearBusy ? 'Importing…' : 'Import XWear'}
            </Button>
          </div>
        </Card.Header>
        <Card.Content class={dockedKitchenFooterActive ? 'batshit-settings-card-content-flush flex min-h-0 flex-1 flex-col' : 'batshit-settings-card-content-flush space-y-6'}>
          <div class={dockedKitchenFooterActive ? 'min-h-0 flex-1 overflow-y-auto px-5 pt-4 pb-4' : 'space-y-6 px-5 pt-4'}>
            <div class="grid gap-3 md:grid-cols-3">
              <div class="batshit-settings-muted-panel is-loose">
                <div class="batshit-settings-child-label flex items-center gap-1.5">
                  <span>Library Items</span>
                  <SettingsInfoMenu ariaLabel="About Closet library item count" contentClass="w-64">
                    <p>Shared XWear items ready for reuse across Goons.</p>
                  </SettingsInfoMenu>
                </div>
                <div class="batshit-settings-metric-value mt-2">{closetItems.length}</div>
              </div>
              <div class="batshit-settings-muted-panel is-loose">
                <div class="batshit-settings-child-label flex items-center gap-1.5">
                  <span>Categories</span>
                  <SettingsInfoMenu ariaLabel="About Closet category count" contentClass="w-64">
                    <p>Quick browsing buckets derived from the imported XWear targets.</p>
                  </SettingsInfoMenu>
                </div>
                <div class="batshit-settings-metric-value mt-2">{closetCategoryOptions.length}</div>
              </div>
              <div class="batshit-settings-muted-panel is-loose">
                <div class="batshit-settings-child-label flex items-center gap-1.5">
                  <span>Editable Per Goon</span>
                  <SettingsInfoMenu ariaLabel="About Saved Item edits" contentClass="w-64">
                    <p>These library items can be selected from each Goon’s Wardrobe and customized per Goon when edited.</p>
                  </SettingsInfoMenu>
                </div>
                <div class="batshit-settings-metric-value mt-2">{closetItems.length}</div>
              </div>
            </div>

            <div class="mt-3 batshit-settings-muted-panel is-loose space-y-4">
              <div class="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                <div class="flex items-center gap-1.5">
                  <div class="batshit-settings-form-label">Shared Library</div>
                  <SettingsInfoMenu ariaLabel="About Shared Library" contentClass="w-72">
                    <p>
                      Global Closet items stay reusable everywhere. Per-Goon filtering happens in the
                      Wardrobe controls.
                    </p>
                  </SettingsInfoMenu>
                </div>
                <div class="flex flex-wrap items-center gap-2">
                  <Input
                    class="h-9 w-full min-w-[220px] sm:w-[260px]"
                    placeholder="Search items, categories, or slots"
                    value={closetSearchQuery}
                    oninput={(event) => (closetSearchQuery = (event.currentTarget as HTMLInputElement).value)}
                  />
                  {#if closetSearchQuery || closetCategoryFilter !== 'all'}
                    <Button
                      variant="outline"
                      size="sm"
                      onclick={() => {
                        closetSearchQuery = ''
                        closetCategoryFilter = 'all'
                      }}
                    >
                      <X aria-hidden="true" />

                      Clear Filters
                    </Button>
                  {/if}
                </div>
              </div>

              {#if closetCategoryOptions.length > 0}
                <div class="flex flex-wrap items-center gap-2">
                  <Button
                    variant={closetCategoryFilter === 'all' ? 'secondary' : 'outline'}
                    size="sm"
                    onclick={() => (closetCategoryFilter = 'all')}
                  >
                    <Check aria-hidden="true" />

                    All
                  </Button>
                  {#each closetCategoryOptions as category}
                    <Button
                      variant={closetCategoryFilter === category ? 'secondary' : 'outline'}
                      size="sm"
                      onclick={() => (closetCategoryFilter = category)}
                    >
                      {formatCategoryLabel(category)}
                    </Button>
                  {/each}
                </div>
              {/if}

              {#if closetItems.length === 0}
                <div class="batshit-settings-empty-state">
                  <div class="batshit-settings-form-label">No Global Closet items yet.</div>
                  <div class="mt-2 text-xs text-muted-foreground">
                    Import your first `.xwear` file to start building the shared wardrobe library.
                  </div>
                </div>
              {:else if filteredClosetItems.length === 0}
                <div class="batshit-settings-empty-state">
                  <div class="batshit-settings-form-label">No Closet items match these filters.</div>
                  <div class="mt-2 text-xs text-muted-foreground">
                    Try a different search or clear the category filter.
                  </div>
                </div>
              {:else}
                <GalleryGrid minWidth={240}>
                  {#each filteredClosetItems as item (item.id)}
                    {@const itemEditing = editingClosetItemId === item.id}
                    {@const slotLabelText = getClosetItemSlotLabelText(item)}
                    {@const categoryLabel = formatCategoryLabel(item.category)}
                    <GalleryCard>
                      {#snippet media()}
                        <div class="batshit-goon-closet-media absolute inset-0">
                          {#if getClosetItemPreviewUrl(item)}
                            <img
	                              src={getClosetItemPreviewUrl(item)}
	                              alt={item.name}
	                              class="batshit-goon-closet-preview-image h-full w-full object-cover"
	                              loading="lazy"
	                            />
	                          {/if}
	                          {#if itemEditing}
	                            <div class="absolute inset-0 z-10 bg-black/55 backdrop-blur-sm"></div>
	                            <div class="absolute inset-x-3 top-14 z-20">
                              <Input
                                autofocus
                                value={editingClosetItemNameDraft}
                                class="border-white/15 bg-black/45 text-white placeholder:text-white/45"
                                oninput={(event) =>
                                  (editingClosetItemNameDraft = (event.currentTarget as HTMLInputElement).value)}
                                onkeydown={(event) => {
                                  if (event.key === 'Enter') {
                                    event.preventDefault()
                                    applyClosetItemEdits(item.id)
                                  }
                                  if (event.key === 'Escape') {
                                    event.preventDefault()
                                    cancelClosetItemEditing()
                                  }
                                }}
                              />
                            </div>
                          {/if}
                        </div>
                      {/snippet}
                      {#snippet actions()}
                        <div class="flex gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            class="text-white"
                            aria-label={itemEditing ? `Apply edits to ${item.name}` : `Edit ${item.name}`}
                            title={itemEditing ? 'Apply Display Name' : 'Edit Display Name'}
                            onclick={() => {
                              if (itemEditing) {
                                applyClosetItemEdits(item.id)
                                return
                              }
                              startEditingClosetItem(item)
                            }}
                            disabled={!itemEditing && editingClosetItemId !== null}
                          >
                            {#if itemEditing}
                              <Check  />
                            {:else}
                              <Pencil  />
                            {/if}
                          </Button>
                          {#if itemEditing}
                            <Button
                              variant="ghost"
                              size="sm"
                              class="text-white"
                              aria-label={`Cancel edits to ${item.name}`}
                              title="Cancel Display Name Edit"
                              onclick={cancelClosetItemEditing}
                            >
                              <X  />
                            </Button>
                          {/if}
                          <Button
                            variant="ghost"
                            size="sm"
                            class="text-rose-200"
                            aria-label={`Remove ${item.name} from Global Closet`}
                            title="Remove from Global Closet"
                            onclick={() => requestClosetItemDelete(item)}
                            disabled={closetDeleteBusyId === item.id || itemEditing}
                          >
                            <Trash2  />
                          </Button>
                        </div>
                      {/snippet}
                      {#snippet header()}
                        <div class="space-y-1">
                          <div class="flex items-start gap-2">
                            <div class="batshit-settings-form-label min-w-0 flex-1 truncate">{item.name}</div>
                            <div class="relative shrink-0">
                              <Badge
                                variant="outline"
                                class={`max-w-[112px] text-[10px] font-normal ${
                                  closetItemCategoryOverflow[item.id] ? 'invisible' : ''
                                }`}
                              >
                                <span
                                  class="block max-w-[96px] truncate"
                                  use:observeOverflow={(overflow) => setClosetItemCategoryOverflow(item.id, overflow)}
                                >
                                  {categoryLabel}
                                </span>
                              </Badge>
                              {#if closetItemCategoryOverflow[item.id]}
                                <div class="absolute inset-0 flex items-center justify-end">
                                  <SettingsInfoMenu ariaLabel={`About ${item.name} category`} contentClass="w-64">
                                    <p>{categoryLabel}</p>
                                  </SettingsInfoMenu>
                                </div>
                              {/if}
                            </div>
                          </div>
                          <div class="flex items-center gap-1 min-w-0">
                            <div
                              class="min-w-0 flex-1 truncate text-[11px] text-muted-foreground"
                              use:observeOverflow={(overflow) => setClosetItemSlotOverflow(item.id, overflow)}
                            >
                              {slotLabelText}
                            </div>
                            {#if closetItemSlotOverflow[item.id]}
                              <div class="shrink-0">
                                <SettingsInfoMenu ariaLabel={`About ${item.name} slots`} contentClass="w-72">
                                  <p>{slotLabelText}</p>
                                </SettingsInfoMenu>
                              </div>
                            {/if}
                          </div>
                        </div>
                      {/snippet}
                    </GalleryCard>
                  {/each}
                </GalleryGrid>
              {/if}
            </div>
          </div>

          {#if dockedKitchenFooterActive}
            <div class="batshit-settings-footer-bar shrink-0 mt-4">
              <div class="flex flex-wrap items-center justify-between gap-3">
                <div class="min-h-6">
                  {#if closetSaveStatus}
                    <div
                      class={`batshit-settings-save-status ${
                        closetSaveStatus.kind === 'dirty' ? 'is-warning' : 'is-busy'
                      }`}
                    >
                      {#if closetSaveStatus.kind === 'dirty'}
                        <CircleAlert class="h-3.5 w-3.5" />
                      {:else}
                        <RefreshCw class="h-3.5 w-3.5 animate-spin" />
                      {/if}
                      <span>{closetSaveStatus.label}</span>
                    </div>
                  {/if}
                </div>
                <div class="flex flex-wrap items-center gap-2">
                  <Button
                    variant="outline"
                    onclick={cancelClosetChanges}
                    disabled={!closetDirty || closetSaving}
                  >
                    <X aria-hidden="true" />
                    Cancel
                  </Button>
                  <Button onclick={saveClosetSettings} disabled={!closetDirty || closetSaving}>
                    {closetSaving ? 'Saving…' : 'Save Closet'}
                  </Button>
                </div>
              </div>
            </div>
          {/if}
        </Card.Content>
      </Card.Root>
    {/if}
    {#if activeTab === 'kitchen'}
	      <Card.Root
          class={`batshit-settings-card batshit-settings-card-default batshit-settings-l1-card ${
            dockedKitchenFooterActive ? 'flex h-full min-h-0 flex-col overflow-hidden pb-0' : ''
          }`}
        >
        <Card.Header class="flex items-start justify-between gap-4">
          <div class="flex items-center gap-1.5">
            <Card.Title class="flex items-center gap-2">
              <BatshitIcon id="kitchen" class="h-4 w-4" />
              Goon Kitchen
            </Card.Title>
            <SettingsInfoMenu ariaLabel="About Goon Kitchen" contentClass="w-80">
              <p>
                The shared library for global moods, global emotes, and portable packs. Closet,
                Scenes, and per-Goon wardrobes now have their own dedicated lanes.
              </p>
            </SettingsInfoMenu>
          </div>
          <div class="flex flex-wrap justify-end gap-2">
            <input
              class="hidden"
              type="file"
              accept="application/zip,.zip"
              bind:this={libraryImportInput}
              onchange={handleLibraryImportSelection}
            />
            <Button
              variant="outline"
              size="sm"
              onclick={() => libraryImportInput?.click()}
              disabled={libraryImportBusy}
            >
              {libraryImportBusy ? 'Reading pack…' : 'Import Pack'}
            </Button>
            <Button variant="outline" size="sm" onclick={openLibraryExportDialog}>
              <Download aria-hidden="true" />
              Export Pack
            </Button>
          </div>
        </Card.Header>
        <GoonsPackDialogs
          bind:exportOpen={exportPackDialogOpen}
          bind:importOpen={importPackPreviewOpen}
          {packSceneOptions}
          {globalPackMotionOptions}
          {globalPackMoodOptions}
          {globalPackEmoteOptions}
          {goonPackCueGroups}
          {exportPackSelections}
          {exportPackBusy}
          {pendingImportPack}
          {libraryImportBusy}
          onTogglePackSelection={togglePackSelection}
          onExportSelected={exportSelectedLibraryBundle}
          onCancelImport={() => {
            pendingImportPack = null
          }}
          onConfirmImport={confirmLibraryImport}
          {getPostureLabel}
        />

        <Card.Content class={dockedKitchenFooterActive ? 'batshit-settings-card-content-flush flex min-h-0 flex-1 flex-col' : 'batshit-settings-card-content-flush space-y-6'}>
          <div
            class={`space-y-4 ${
              dockedKitchenFooterActive ? 'min-h-0 flex-1 overflow-y-auto' : ''
            }`}
          >
            <div class="px-5 pt-4 space-y-4">
              <div class="space-y-3">
                <Collapsible.Root bind:open={moodsOpen} class={goonLevel1AccordionClass}>
                  <Collapsible.Trigger
                    class={goonLevel1AccordionHeaderClass}
                    onclick={() => toggleMotionSection('moods')}
                  >
                    <div class="flex items-center gap-2">
                      <BatshitIcon id="moods" class="batshit-goon-l1-icon h-4 w-4" />
                      <span class="batshit-settings-form-label">Moods</span>
                      <Badge variant="secondary">{moodCues.length}</Badge>
                    </div>
                    <ChevronDown
                      class={`h-4 w-4 shrink-0 transition-transform ${moodsOpen ? 'rotate-180' : ''}`}
                    />
                  </Collapsible.Trigger>
                  <Collapsible.Content class={`${goonLevel1AccordionContentClass} space-y-3`}>
                    {#if kitchenAddMoodOpen}
                      <div class="grid gap-2 sm:grid-cols-[1fr_auto] items-start">
                        <div class="grid grid-cols-12 gap-2 items-center">
                          <div class="col-span-9">
                            <Input placeholder="New mood name" bind:value={newMoodName} />
                          </div>
                          <div class="col-span-3 flex justify-end">
                            <Button
                              variant="outline"
                              size="sm"
                              onclick={() => {
                                const created = addCue('mood', newMoodName)
                                if (!created) return
                                newMoodName = ''
                                kitchenAddMoodOpen = false
                              }}
                            >
                              <Plus aria-hidden="true" />

                              Add Mood
                            </Button>
                          </div>
                        </div>
                        <div class="flex justify-end">
                          <Button
                            variant="ghost"
                            size="icon"

                            aria-label="Cancel add mood"
                            onclick={() => {
                              kitchenAddMoodOpen = false
                              newMoodName = ''
                            }}
                          >
                            <X  />
                          </Button>
                        </div>
                      </div>
                    {:else}
                      <div class="flex justify-end">
                        <Button variant="outline" size="sm" onclick={() => (kitchenAddMoodOpen = true)}>
                          <Plus aria-hidden="true" />

                          Add Mood
                        </Button>
                      </div>
                    {/if}
                    {#if moodCues.length === 0}
                      <p class="batshit-settings-form-label">
                        No moods yet. Add one to define base loops.
                      </p>
                    {/if}
                    {#if moodCues.length > 0}
                      <div class={goonLevel2AccordionListClass}>
                    {#each moodCues as cue (cue.name)}
                        <Collapsible.Root
                          open={openMoodName === cue.name}
                          class={goonLevel2AccordionClass}
                        >
                        <div
                          role="button"
                          tabindex="0"
                          class={goonLevel2AccordionHeaderClass}
                          aria-expanded={openMoodName === cue.name}
                          onclick={() => toggleMotionItem('mood', cue.name)}
                          onkeydown={(event) => handleMotionItemHeaderKeydown(event, 'mood', cue.name)}
                        >
                          <span class="batshit-settings-form-label flex items-center gap-2">
                            <BatshitIcon id="moods" class="h-3.5 w-3.5 text-muted-foreground" />
                            <span>{cue.name}</span>
                          </span>
                          <div class="flex items-center gap-1">
                            <Button
                              variant="ghost"
                              size="xs"

                              aria-label="Preview Mood"
                              title="Preview Mood"
                              onclick={(event) => handleQuickCuePreview(event, cue.name)}
                            >
                              <Play  />
                            </Button>
                            <ChevronDown
                              class={`h-4 w-4 transition-transform ${openMoodName === cue.name ? 'rotate-180' : ''}`}
                            />
                          </div>
                        </div>
                        <Collapsible.Content class={goonLevel2CueContentClass}>
                            <div class="flex flex-wrap items-center justify-between gap-2">
                              <div class="min-w-[180px] flex-1 space-y-1">
                                <GoonsFieldLabel label="Name" info={CUE_NAME_INFO} ariaLabel="About Mood Name" />
                                <Input
                                  class="batshit-settings-grid-control"
                                  placeholder="Mood name"
                                  value={getCueNameDraft(cue.name)}
                                  oninput={(event) =>
                                    setCueNameDraft(cue.name, (event.currentTarget as HTMLInputElement).value)}
                                  onkeydown={(event) => {
                                    if (event.key === 'Enter') {
                                      event.preventDefault()
                                      commitCueRename(cue.name)
                                      ;(event.currentTarget as HTMLInputElement).blur()
                                    }
                                    if (event.key === 'Escape') {
                                      event.preventDefault()
                                      clearCueNameDraft(cue.name)
                                      ;(event.currentTarget as HTMLInputElement).blur()
                                    }
                                  }}
                                  onblur={() => commitCueRename(cue.name)}
                                />
                              </div>
                            </div>
                            <div class="space-y-1">
                              <GoonsFieldLabel
                                label="Description"
                                info={CUE_DESCRIPTION_INFO}
                                ariaLabel="About Mood Description"
                              />
                              <Input
                                placeholder="Description (optional)"
                                value={cue.description ?? ''}
                                oninput={(event) => {
                                  const value = (event.currentTarget as HTMLInputElement).value
                                  updateCueField(cue.name, { description: value })
                                }}
                              />
                            </div>
                            <div class="grid grid-cols-12 gap-2 items-center">
                              <GoonsFieldLabel
                                label="Posture"
                                info={CUE_POSTURE_INFO}
                                ariaLabel="About Mood Posture"
                                class="col-span-4"
                              />
                                <div class="col-span-8">
                                  <Select.Root
                                    type="single"
                                    value={cue.posture ?? ''}
                                    onValueChange={(value: string) =>
                                      updateCueField(cue.name, { posture: value || undefined })
                                    }
                                  >
                                    <Select.Trigger class="w-full">
                                      {cue.posture
                                        ? getPostureLabel(cue.posture)
                                        : 'Use linked Motion or Base Posture'}
                                    </Select.Trigger>
                                    <Select.Content>
                                      <Select.Item value="">Use linked Motion or Base Posture</Select.Item>
                                      {#each stagePostureOptions as posture}
                                        <Select.Item value={posture.id}>{posture.name}</Select.Item>
                                      {/each}
                                    </Select.Content>
                                  </Select.Root>
                                </div>
                              </div>
                            <div class="grid grid-cols-12 gap-2 items-center">
                              <GoonsFieldLabel
                                label="Loop Motion"
                                info={CUE_LOOP_MOTION_INFO}
                                ariaLabel="About Mood Loop Motion"
                                class="col-span-4"
                              />
                              <div class="col-span-8">
                                {#if globalAnimationOptions.length > 0}
                                  <GoonMotionPicker
                                    options={globalMotionPickerOptions}
                                    value={
                                      cue.animationName && globalAnimationOptions.includes(cue.animationName)
                                        ? cue.animationName
                                        : ''
                                    }
                                    ariaLabel="Select Mood Loop Motion"
                                    onChange={(value) =>
                                      updateCueField(cue.name, { animationName: value || undefined })}
                                  />
                                {:else}
                                  <div class="batshit-settings-form-label">
                                    Upload a motion to select one.
                                  </div>
                                {/if}
                              </div>
                            </div>
                            <div class="space-y-2">
                              <UniversalFaceControlsEditor
                                presetOptions={currentSemanticExpressionControls()}
                                getPresetValue={(preset) => getCueExpressionPresetValue(cue.name, preset)}
                                onPresetChange={(preset, value) =>
                                  updateCueExpressionPreset(cue.name, preset, value)}
                                model={currentUniversalFaceControlModel()}
                                getControlValue={(control) => getUniversalFaceControlValue(cue.name, control)}
                                onControlChange={(control, value) =>
                                  updateUniversalFaceControl(cue.name, control, value)}
                                onReset={() => resetUniversalFaceControls(cue.name)}
                                isGroupLocked={isFaceControlGroupLocked}
                                onToggleGroupLock={setFaceControlGroupLocked}
                              />
                              {#if currentHasUnmanagedRawMorphTargets()}
                                <GoonsRawMorphEditor
                                  title="Advanced Raw Morphs"
                                  description="Only model targets that are not already represented by the universal face controls appear here."
                                  morphs={getUnmanagedRawMorphs(cue.rawMorphTargets)}
                                  targetNames={currentUnmanagedRawMorphTargetNames()}
                                  getValue={(targetName) => getRawMorphTargetValue(cue.name, targetName)}
                                  onRename={(currentTarget, nextTarget) =>
                                    renameRawMorphTarget(cue.name, currentTarget, nextTarget)}
                                  onChange={(targetName, value) =>
                                    updateRawMorphTarget(cue.name, targetName, value)}
                                  onRemove={(targetName) => removeRawMorphTarget(cue.name, targetName)}
                                  onAdd={() => addRawMorphTarget(cue.name)}
                                />
                              {/if}
                            </div>
                            <div class="flex justify-end">
                              <div class="flex items-center gap-2 batshit-settings-muted-panel">
                                <GoonsFieldLabel
                                  label="Auto-Enable"
                                  info={CUE_AUTO_ENABLE_INFO}
                                  ariaLabel="About Mood Auto-Enable"
                                  class="batshit-settings-form-label"
                                />
                                <Switch.Root
                                  checked={cue.autoEnableForNewGoons !== false}
                                  onCheckedChange={(checked) =>
                                    updateCueField(cue.name, { autoEnableForNewGoons: Boolean(checked) })
                                  }
                                />
                                <Button
                                  variant="ghost"
                                  size="sm"

                                  aria-label="Duplicate Mood"
                                  title="Duplicate Mood"
                                  onclick={() => duplicateMotion(cue.name)}
                                >
                                  <Copy  />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  class="is-danger"
                                  aria-label="Delete Mood"
                                  title="Delete Mood"
                                  onclick={() => removeMotion(cue.name)}
                                >
                                  <Trash2  />
                                </Button>
                              </div>
                            </div>
                        </Collapsible.Content>
                      </Collapsible.Root>
                    {/each}
                      </div>
                    {/if}
                  </Collapsible.Content>
                </Collapsible.Root>

                <Collapsible.Root bind:open={emotesOpen} class={goonLevel1AccordionClass}>
                  <Collapsible.Trigger
                    class={goonLevel1AccordionHeaderClass}
                    onclick={() => toggleMotionSection('emotes')}
                  >
                    <div class="flex items-center gap-2">
                      <BatshitIcon id="emotes" class="batshit-goon-l1-icon h-4 w-4" />
                      <span class="batshit-settings-form-label">Emotes</span>
                      <Badge variant="secondary">{emoteCues.length}</Badge>
                    </div>
                    <ChevronDown
                      class={`h-4 w-4 shrink-0 transition-transform ${emotesOpen ? 'rotate-180' : ''}`}
                    />
                  </Collapsible.Trigger>
                  <Collapsible.Content class={`${goonLevel1AccordionContentClass} space-y-3`}>
                    {#if kitchenAddEmoteOpen}
                      <div class="grid gap-2 sm:grid-cols-[1fr_auto] items-start">
                        <div class="grid grid-cols-12 gap-2 items-center">
                          <div class="col-span-6">
                            <Input placeholder="New emote name" bind:value={newEmoteName} />
                          </div>
                          <div class="col-span-3">
                            <Input placeholder="Emoji(s)" bind:value={newEmoteEmoji} />
                          </div>
                          <div class="col-span-3 flex justify-end">
                            <Button
                              variant="outline"
                              size="sm"
                              onclick={() => {
                                const created = addEmote()
                                if (!created) return
                                kitchenAddEmoteOpen = false
                              }}
                            >
                              <Plus aria-hidden="true" />

                              Add Emote
                            </Button>
                          </div>
                        </div>
                        <div class="flex justify-end">
                          <Button
                            variant="ghost"
                            size="icon"

                            aria-label="Cancel add emote"
                            onclick={() => {
                              kitchenAddEmoteOpen = false
                              newEmoteName = ''
                              newEmoteEmoji = ''
                            }}
                          >
                            <X  />
                          </Button>
                        </div>
                      </div>
                    {:else}
                      <div class="flex justify-end">
                        <Button variant="outline" size="sm" onclick={() => (kitchenAddEmoteOpen = true)}>
                          <Plus aria-hidden="true" />

                          Add Emote
                        </Button>
                      </div>
                    {/if}
                    {#if emoteCues.length === 0}
                      <p class="batshit-settings-form-label">
                        No emotes yet. Add one with an emoji to get started.
                      </p>
                    {/if}
                    {#if emoteCues.length > 0}
                      <div class={goonLevel2AccordionListClass}>
                    {#each emoteCues as cue (cue.name)}
                      {@const emoteEmoji = getEmoteEmoji(cue.name)}
                      {@const emoteEmojiLabel = formatEmoteEmojiLabel(emoteEmoji)}
                      <Collapsible.Root
                        open={openEmoteName === cue.name}
                        class={goonLevel2AccordionClass}
                      >
                        <div
                          role="button"
                          tabindex="0"
                          class={goonLevel2AccordionHeaderClass}
                          aria-expanded={openEmoteName === cue.name}
                          onclick={() => toggleMotionItem('emote', cue.name)}
                          onkeydown={(event) => handleMotionItemHeaderKeydown(event, 'emote', cue.name)}
                        >
                          <span class="batshit-settings-form-label flex items-center gap-2">
                            {#if emoteEmojiLabel}
                              <span class="batshit-settings-action-row-title leading-none">{emoteEmojiLabel}</span>
                            {/if}
                            {cue.name}
                          </span>
                          <div class="flex items-center gap-1">
                            <Button
                              variant="ghost"
                              size="xs"

                              aria-label="Preview Emote"
                              title="Preview Emote"
                              onclick={(event) => handleQuickCuePreview(event, cue.name)}
                            >
                              <Play  />
                            </Button>
                            <ChevronDown
                              class={`h-4 w-4 transition-transform ${openEmoteName === cue.name ? 'rotate-180' : ''}`}
                            />
                          </div>
                        </div>
                        <Collapsible.Content class={goonLevel2CueContentClass}>
                            <div class="flex flex-wrap items-center justify-between gap-2">
                              <div class="min-w-[180px] flex-1 space-y-1">
                                <GoonsFieldLabel label="Name" info={CUE_NAME_INFO} ariaLabel="About Emote Name" />
                                <Input
                                  class="batshit-settings-grid-control"
                                  placeholder="Emote name"
                                  value={getCueNameDraft(cue.name)}
                                  oninput={(event) =>
                                    setCueNameDraft(cue.name, (event.currentTarget as HTMLInputElement).value)}
                                  onkeydown={(event) => {
                                    if (event.key === 'Enter') {
                                      event.preventDefault()
                                      commitCueRename(cue.name)
                                      ;(event.currentTarget as HTMLInputElement).blur()
                                    }
                                    if (event.key === 'Escape') {
                                      event.preventDefault()
                                      clearCueNameDraft(cue.name)
                                      ;(event.currentTarget as HTMLInputElement).blur()
                                    }
                                  }}
                                  onblur={() => commitCueRename(cue.name)}
                                />
                              </div>
                            </div>
                            <div class="space-y-1">
                              <GoonsFieldLabel
                                label="Description"
                                info={CUE_DESCRIPTION_INFO}
                                ariaLabel="About Emote Description"
                              />
                              <Input
                                placeholder="Description (optional)"
                                value={cue.description ?? ''}
                                oninput={(event) => {
                                  const value = (event.currentTarget as HTMLInputElement).value
                                  updateCueField(cue.name, { description: value })
                                }}
                              />
                            </div>
                            <div class="grid grid-cols-12 gap-2 items-center">
                              <GoonsFieldLabel
                                label="Emoji"
                                info={CUE_EMOJI_INFO}
                                ariaLabel="About Emote Emoji"
                                class="col-span-4"
                              />
                              <div class="col-span-8">
                                <Input
                                  placeholder="🙂 or 😏+🙄"
                                  value={getEmoteEmoji(cue.name)}
                                  oninput={(event) => {
                                    const value = (event.currentTarget as HTMLInputElement).value
                                    setEmoteEmoji(cue.name, value)
                                  }}
                                />
                              </div>
                            </div>
                            <div class="batshit-goon-cue-subpanel space-y-2">
                              <div class="grid grid-cols-12 gap-2 items-end">
                                <div class="col-span-6 space-y-1">
                                  <GoonsFieldLabel
                                    label="Pause Speech"
                                    info={CUE_PAUSE_SPEECH_INFO}
                                    ariaLabel="About Emote Pause Speech"
                                  />
                                  <div class="flex h-9 items-center">
                                    <Switch.Root
                                      checked={Boolean(cue.blocking)}
                                      onCheckedChange={(checked) =>
                                        updateCueField(cue.name, { blocking: Boolean(checked) })
                                      }
                                    />
                                  </div>
                                </div>
                                <div class="col-span-6 space-y-1">
                                  <GoonsFieldLabel
                                    label="Duration (ms)"
                                    info={CUE_DURATION_INFO}
                                    ariaLabel="About Emote Duration"
                                  />
                                  <Input
                                    type="number"
                                    min="0"
                                    step="50"
                                    value={cue.durationMs ?? ''}
                                    placeholder="800"
                                    oninput={(event) => {
                                      const value = (event.currentTarget as HTMLInputElement).value
                                      updateCueField(cue.name, {
                                        durationMs: value ? Number(value) : undefined
                                      })
                                    }}
                                  />
                                </div>
                              </div>
                            </div>
                            <div class="space-y-2">
                                {#if !cue.steps || cue.steps.length === 0}
                                  <GoonsFieldLabel
                                    label="Facial Timing (ms)"
                                    info={CUE_FACIAL_TIMING_INFO}
                                    ariaLabel="About Emote Facial Timing"
                                    class="batshit-settings-child-label"
                                  />
                                  <div class="grid grid-cols-12 gap-2 items-end">
                                    <div class="col-span-4 space-y-1">
                                      <div class="batshit-settings-form-label">Fade-In</div>
                                      <Input
                                        type="number"
                                        min="0"
                                        step="10"
                                        value={cue.attackMs ?? ''}
                                        placeholder="120"
                                        oninput={(event) => {
                                          const value = (event.currentTarget as HTMLInputElement).value
                                          updateCueField(cue.name, {
                                            attackMs: value ? Number(value) : undefined
                                          })
                                        }}
                                      />
                                    </div>
                                    <div class="col-span-4 space-y-1">
                                      <div class="batshit-settings-form-label">Hold</div>
                                      <Input
                                        type="number"
                                        min="0"
                                        step="10"
                                        value={cue.holdMs ?? ''}
                                        placeholder="200"
                                        oninput={(event) => {
                                          const value = (event.currentTarget as HTMLInputElement).value
                                          updateCueField(cue.name, {
                                            holdMs: value ? Number(value) : undefined
                                          })
                                        }}
                                      />
                                    </div>
                                    <div class="col-span-4 space-y-1">
                                      <div class="batshit-settings-form-label">Fade-Out</div>
                                      <Input
                                        type="number"
                                        min="0"
                                        step="10"
                                        value={cue.releaseMs ?? ''}
                                        placeholder="180"
                                        oninput={(event) => {
                                          const value = (event.currentTarget as HTMLInputElement).value
                                          updateCueField(cue.name, {
                                            releaseMs: value ? Number(value) : undefined
                                          })
                                        }}
                                      />
                                    </div>
                                  </div>
                                {/if}
                                <UniversalFaceControlsEditor
                                  presetOptions={currentSemanticExpressionControls()}
                                  getPresetValue={(preset) => getCueExpressionPresetValue(cue.name, preset)}
                                  onPresetChange={(preset, value) =>
                                    updateCueExpressionPreset(cue.name, preset, value)}
                                  model={currentUniversalFaceControlModel()}
                                  getControlValue={(control) => getUniversalFaceControlValue(cue.name, control)}
                                  onControlChange={(control, value) =>
                                    updateUniversalFaceControl(cue.name, control, value)}
                                  onReset={() => resetUniversalFaceControls(cue.name)}
                                  isGroupLocked={isFaceControlGroupLocked}
                                  onToggleGroupLock={setFaceControlGroupLocked}
                                />
                                {#if currentHasUnmanagedRawMorphTargets()}
                                  <GoonsRawMorphEditor
                                    title="Advanced Raw Morphs"
                                    description="Only model targets that are not already represented by the universal face controls appear here."
                                    morphs={getUnmanagedRawMorphs(cue.rawMorphTargets)}
                                    targetNames={currentUnmanagedRawMorphTargetNames()}
                                    getValue={(targetName) => getRawMorphTargetValue(cue.name, targetName)}
                                    onRename={(currentTarget, nextTarget) =>
                                      renameRawMorphTarget(cue.name, currentTarget, nextTarget)}
                                    onChange={(targetName, value) =>
                                      updateRawMorphTarget(cue.name, targetName, value)}
                                    onRemove={(targetName) => removeRawMorphTarget(cue.name, targetName)}
                                    onAdd={() => addRawMorphTarget(cue.name)}
                                  />
                                {/if}
                                {#if cue.steps && cue.steps.length > 0}
                                  {#each cue.steps as step, stepIndex (stepIndex)}
                                    <div class="batshit-goon-cue-subpanel is-step space-y-2">
                                    <div class="flex items-center justify-between">
                                      <span class="batshit-settings-child-label">Step {stepIndex + 1}</span>
                                      <Button variant="ghost" size="sm" onclick={() => removeStep(cue.name, stepIndex)}>
                                        <X  />
                                      </Button>
                                    </div>
                                    <GoonsFieldLabel
                                      label="Facial Timing (ms)"
                                      info={CUE_FACIAL_TIMING_INFO}
                                      ariaLabel="About Emote Step Facial Timing"
                                      class="batshit-settings-child-label"
                                    />
                                    <div class="grid grid-cols-12 gap-2 items-end">
                                      <div class="col-span-4 space-y-1">
                                        <div class="batshit-settings-form-label">Fade-In</div>
                                        <Input type="number" min="0" step="10" value={step.attackMs ?? ''} placeholder="200"
                                          oninput={(event) => {
                                            const value = (event.currentTarget as HTMLInputElement).value
                                            updateStepField(cue.name, stepIndex, { attackMs: value ? Number(value) : undefined })
                                          }} />
                                      </div>
                                      <div class="col-span-4 space-y-1">
                                        <div class="batshit-settings-form-label">Hold</div>
                                        <Input type="number" min="0" step="10" value={step.holdMs ?? ''} placeholder="1000"
                                          oninput={(event) => {
                                            const value = (event.currentTarget as HTMLInputElement).value
                                            updateStepField(cue.name, stepIndex, { holdMs: value ? Number(value) : undefined })
                                          }} />
                                      </div>
                                      <div class="col-span-4 space-y-1">
                                        <div class="batshit-settings-form-label">Fade-Out</div>
                                        <Input type="number" min="0" step="10" value={step.releaseMs ?? ''} placeholder="500"
                                          oninput={(event) => {
                                            const value = (event.currentTarget as HTMLInputElement).value
                                            updateStepField(cue.name, stepIndex, { releaseMs: value ? Number(value) : undefined })
                                          }} />
                                      </div>
                                    </div>
                                    <UniversalFaceControlsEditor
                                      presetOptions={currentSemanticExpressionControls()}
                                      getPresetValue={(preset) =>
                                        getExpressionTargetWeight(
                                          resolveEditorFaceProfiles(step).portable.expressionTargets,
                                          preset
                                        )}
                                      onPresetChange={(preset, value) =>
                                        updateStepExpressionPreset(cue.name, stepIndex, preset, value)}
                                      model={currentUniversalFaceControlModel()}
                                      getControlValue={(control) =>
                                        getStepUniversalFaceControlValue(cue.name, stepIndex, control)}
                                      onControlChange={(control, value) =>
                                        updateStepUniversalFaceControl(cue.name, stepIndex, control, value)}
                                      onReset={() => resetStepUniversalFaceControls(cue.name, stepIndex)}
                                      isGroupLocked={isFaceControlGroupLocked}
                                      onToggleGroupLock={setFaceControlGroupLocked}
                                    />
                                    {#if currentHasUnmanagedRawMorphTargets()}
                                      <GoonsRawMorphEditor
                                        title="Advanced Raw Morphs"
                                        description="Only model targets that are not already represented by the universal face controls appear here."
                                        morphs={getUnmanagedRawMorphs(step.rawMorphTargets)}
                                        targetNames={currentUnmanagedRawMorphTargetNames()}
                                        getValue={(targetName) =>
                                          getStepRawMorphTargetValue(cue.name, stepIndex, targetName)}
                                        onRename={(currentTarget, nextTarget) =>
                                          renameStepRawMorphTarget(cue.name, stepIndex, currentTarget, nextTarget)}
                                        onChange={(targetName, value) =>
                                          updateStepRawMorphTarget(cue.name, stepIndex, targetName, value)}
                                        onRemove={(targetName) =>
                                          removeStepRawMorphTarget(cue.name, stepIndex, targetName)}
                                        onAdd={() => addStepRawMorphTarget(cue.name, stepIndex)}
                                      />
                                    {/if}
                                  </div>
                                {/each}
                              {/if}
                              <div class="flex justify-start">
                                <div>
                                  <Button variant="outline" size="sm" onclick={() => addStep(cue.name)}>
                                    <Plus aria-hidden="true" />

                                    Add Step
                                  </Button>
                                </div>
                              </div>
                            </div>
                            <div class="flex justify-end">
                              <div class="flex items-center gap-2 batshit-settings-muted-panel">
                                <GoonsFieldLabel
                                  label="Auto-Enable"
                                  info={CUE_AUTO_ENABLE_INFO}
                                  ariaLabel="About Emote Auto-Enable"
                                  class="batshit-settings-form-label"
                                />
                                <Switch.Root
                                  checked={cue.autoEnableForNewGoons !== false}
                                  onCheckedChange={(checked) =>
                                    updateCueField(cue.name, { autoEnableForNewGoons: Boolean(checked) })
                                  }
                                />
                                <Button
                                  variant="ghost"
                                  size="sm"

                                  aria-label="Duplicate Emote"
                                  title="Duplicate Emote"
                                  onclick={() => duplicateMotion(cue.name)}
                                >
                                  <Copy  />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  class="is-danger"
                                  aria-label="Delete Emote"
                                  title="Delete Emote"
                                  onclick={() => removeMotion(cue.name)}
                                >
                                  <Trash2  />
                                </Button>
                              </div>
                            </div>
                        </Collapsible.Content>
                      </Collapsible.Root>
                    {/each}
                      </div>
                    {/if}
		                  </Collapsible.Content>
		                </Collapsible.Root>

                          <Collapsible.Root bind:open={kitchenEyeContactOpen} class={goonLevel1AccordionClass}>
                            <Collapsible.Trigger
                              class={goonLevel1AccordionHeaderClass}
                            >
                              <div class="flex items-center gap-1.5">
                                <Eye class="batshit-goon-l1-icon h-4 w-4" />
                                <span class="batshit-settings-form-label">Eye Contact</span>
                                <div
                                  onclick={(event) => {
                                    event.preventDefault()
                                    event.stopPropagation()
                                  }}
                                  aria-hidden="true"
                                >
                                  <SettingsInfoMenu ariaLabel="About Global Eye Contact" contentClass="w-80">
                                    <p>{KITCHEN_EYE_CONTACT_INFO}</p>
                                  </SettingsInfoMenu>
                                </div>
                              </div>
                              <ChevronDown
                                class={`h-4 w-4 shrink-0 transition-transform ${kitchenEyeContactOpen ? 'rotate-180' : ''}`}
                              />
                            </Collapsible.Trigger>
                            <Collapsible.Content class={`${goonLevel1AccordionContentClass} space-y-3`}>
                              <Tabs.Root bind:value={kitchenEyeContactProfile} class="w-full px-3">
                                <Tabs.List class="grid w-full grid-cols-2">
                                  {#each kitchenEyeContactProfileOptions as option (option.value)}
                                    <Tabs.Trigger value={option.value} class="min-w-0 text-[11px] font-medium leading-none sm:text-xs">
                                      {option.label}
                                    </Tabs.Trigger>
                                  {/each}
                                </Tabs.List>
                              </Tabs.Root>
                              <EyeContactTuningEditor
                                mode={activeKitchenEyeContactMode}
                                tuning={activeKitchenEyeContactTuning}
                                modeInfo={EDITOR_EYE_CONTACT_MODE_INFO}
                                coordinationInfo={EDITOR_EYE_CONTACT_COORDINATION_INFO}
                                onModeChange={setKitchenEyeContactMode}
                                onTuningChange={updateKitchenEyeContactTuning}
                              />
                            </Collapsible.Content>
                          </Collapsible.Root>

		          </div>
		          </div>
	          </div>

          {#if dockedKitchenFooterActive}
            <div class="batshit-settings-footer-bar shrink-0 mt-4">
              <div class="flex flex-wrap items-center justify-between gap-3">
                <div class="min-h-6">
                  {#if kitchenSaveStatus}
                    <div
                      class={`batshit-settings-save-status ${
                        kitchenSaveStatus.kind === 'dirty' ? 'is-warning' : 'is-busy'
                      }`}
                    >
                      {#if kitchenSaveStatus.kind === 'dirty'}
                        <CircleAlert class="h-3.5 w-3.5" />
                      {:else}
                        <RefreshCw class="h-3.5 w-3.5 animate-spin" />
                      {/if}
                      <span>{kitchenSaveStatus.label}</span>
                    </div>
                  {/if}
                </div>
                <div class="flex flex-wrap items-center gap-2">
                  <Button
                    variant="outline"
                    onclick={cancelKitchenChanges}
                    disabled={!kitchenDirty || kitchenSaving}
                  >
                    <X aria-hidden="true" />
                    Cancel
                  </Button>
                  <Button onclick={saveKitchenSettings} disabled={!kitchenDirty || kitchenSaving}>
                    {kitchenSaving ? 'Saving…' : 'Save Kitchen'}
                  </Button>
                </div>
              </div>
            </div>
          {/if}
        </Card.Content>
      </Card.Root>
	    {/if}
	    {#if activeTab === 'scenes'}
      <Card.Root
        class={`batshit-settings-card batshit-settings-card-default batshit-settings-l1-card ${
          dockedScenesPanelActive ? 'flex h-full min-h-0 flex-col overflow-hidden pb-0' : ''
        }`}
      >
        <Card.Header>
          <div class="flex flex-wrap items-center justify-between gap-3">
            <div class="flex items-center gap-1.5">
              <Card.Title class="flex items-center gap-2">
                <BatshitIcon id="scenes" class="h-4 w-4" />
                Scenes
              </Card.Title>
              <SettingsInfoMenu ariaLabel="About Scenes" contentClass="w-80">
                <p>
                  Scenes are global on purpose. Each scene can include a skybox, room shell or room
                  builder setup, props, markers, and linked textures that every Goon can use.
                </p>
              </SettingsInfoMenu>
            </div>
            <Button variant="outline" size="sm" onclick={() => openSceneEditor()}>
              <Plus aria-hidden="true" />

              Create New Scene
            </Button>
          </div>
        </Card.Header>
        <Card.Content class={dockedScenesPanelActive ? 'batshit-settings-card-content-flush flex min-h-0 flex-1 flex-col' : 'space-y-3'}>
          <div class={dockedScenesPanelActive ? 'min-h-0 flex-1 overflow-y-auto space-y-3 p-4' : 'space-y-3'}>
          {#if sortedScenes.length === 0}
            <p class="batshit-settings-caption">No scenes saved yet.</p>
          {:else}
            {#each sortedScenes as scene}
              <div
                class="batshit-settings-option-card"
              >
                <div class="space-y-3">
                  <div class="flex flex-wrap items-start justify-between gap-2">
                    <div class="min-w-0 flex items-center gap-1.5">
                      <div class="batshit-settings-form-label truncate">{scene.name}</div>
                      {#if scene.description}
                        <SettingsInfoMenu ariaLabel={`About ${scene.name}`} contentClass="w-80">
                          <p>
                            <strong>Description:</strong> {scene.description}
                          </p>
                        </SettingsInfoMenu>
                      {/if}
                    </div>
                    <div class="flex shrink-0 items-center gap-2">
                      <Button
                        variant="outline"
                        size="icon"

                        aria-label={`Edit ${scene.name}`}
                        title="Edit Scene"
                        onclick={() => openSceneEditor(scene.id)}
                      >
                        <Pencil  />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"

                        aria-label={`Delete ${scene.name}`}
                        title="Delete Scene"
                        onclick={() => requestDeleteScene(scene)}
                      >
                        <Trash2  />
                      </Button>
                    </div>
                  </div>
                  <div class="batshit-goon-thumbnail-frame is-scene-card">
                    {#if resolveSceneThumbnailUrl(scene)}
                      <img
                        src={resolveSceneThumbnailUrl(scene) ?? undefined}
                        alt={`${scene.name} thumbnail`}
                        class="h-full w-full object-cover"
                        loading="lazy"
                      />
                    {:else}
                      <div class="batshit-settings-child-label flex h-full w-full items-center justify-center">
                        No Thumb
                      </div>
                    {/if}
                  </div>
                </div>
              </div>
            {/each}
          {/if}
          {#if sceneDirty}
            <div class="batshit-goon-editor-divider flex justify-end gap-2">
              <Button variant="ghost" onclick={discardSceneChanges}>
                <X aria-hidden="true" />
                Cancel
              </Button>
              <Button
                onclick={saveScenesSettings}
                disabled={sceneSaving || activeSceneEdit?.type === 'marker' || hasPendingMarkerDrafts()}
              >
                {sceneSaving ? 'Saving…' : 'Save Scenes'}
              </Button>
            </div>
          {/if}
          </div>
        </Card.Content>
      </Card.Root>
    {/if}
	    {#if activeTab === 'goons'}
      <SettingsAccordionCard name="goon-settings-cards" title="Goon Library" batshitIcon="goons" open>
        {#snippet info()}
          <SettingsInfoMenu ariaLabel="About Goon Library" contentClass="w-80">
            <p>
              Manage the Goons you already imported, review compatibility, and jump into the full
              per-Goon editor for deeper tuning, scenes, outfits, and cue overrides.
            </p>
          </SettingsInfoMenu>
        {/snippet}
        <div class="space-y-3">
          {#if goons.length === 0}
            <p class="batshit-settings-caption">No Goons uploaded yet.</p>
          {:else}
            {#each goons as goon}
              {@const formatVisual = goonFormatVisual(goon)}
              {@const recipeReadiness = resolveRecipeProductReadiness(goon)}
              <div class="batshit-settings-muted-panel batshit-settings-display-card space-y-2">
              <div class="flex items-start justify-between gap-3">
                <div class="min-w-0 flex-1">
                  <div class="flex min-w-0 items-center gap-1.5">
                    <p class="batshit-goon-library-name truncate">{goon.name}</p>
                    <SettingsInfoMenu ariaLabel={`About ${goon.name} ID`} contentClass="w-80">
                      <p>ID: `{goon.id}`</p>
                    </SettingsInfoMenu>
                  </div>
                </div>
                <div class="batshit-settings-badge-row flex shrink-0 items-center gap-2">
                  <Badge variant="secondary" class="batshit-settings-child-label batshit-goon-kind-badge">
                    {#if formatVisual.icons.length}
                      <span class="batshit-goon-brand-strip is-inline" aria-label={`${formatVisual.label} format icons`}>
                        {#each formatVisual.icons as icon (icon.label)}
                          <IconRenderer
                            ref={icon.ref}
                            label={icon.label}
                            class={`batshit-goon-brand-icon is-badge ${icon.wide ? 'is-wide' : ''}`}
                            iconClass="h-full w-full"
                            imageClass="h-full w-full object-contain"
                          />
                        {/each}
                      </span>
                    {/if}
                    <span class="batshit-goon-kind-label">{formatVisual.label}</span>
                  </Badge>
                  {#if goon.compatibility?.boneCoverage}
                    <Tooltip.Root>
                      <Tooltip.Trigger class="inline-flex">
                        <Badge
                          variant="outline"
                          class={`batshit-settings-status-badge uppercase ${hasRigWarning(goon) ? 'is-warning' : ''}`}
                        >
                          Rig {goon.compatibility.boneCoverage.present}/{goon.compatibility.boneCoverage.total}
                        </Badge>
                      </Tooltip.Trigger>
                      <Tooltip.Content side="top" class="max-w-[260px] space-y-1 text-xs">
                        {#each getRigTooltipText(goon) as line}
                          <div>{line}</div>
                        {/each}
                      </Tooltip.Content>
                    </Tooltip.Root>
                  {/if}
                  <Tooltip.Root>
                    <Tooltip.Trigger class="inline-flex">
                      <Badge
                        variant="outline"
                        class={`batshit-settings-status-badge ${hasTierWarning(goon) ? 'is-warning' : ''}`}
                      >
                        {tierLabel(goon.compatibility?.tier)}
                      </Badge>
                    </Tooltip.Trigger>
                    <Tooltip.Content side="top" class="max-w-[260px] space-y-1 text-xs">
                      {#each getTierTooltipText(goon) as line}
                        <div>{line}</div>
                      {/each}
                    </Tooltip.Content>
                  </Tooltip.Root>
                  {#if recipeReadiness !== 'not-required'}
                    <Badge
                      variant="outline"
                      class={`batshit-settings-status-badge ${
                        recipeReadiness === 'ready'
                          ? 'is-success'
                          : recipeReadiness === 'failed'
                            ? 'is-danger'
                            : 'is-info'
                      }`}
                    >
                      {recipeReadiness === 'ready'
                        ? 'Ready'
                        : recipeReadiness === 'failed'
                          ? 'Preparation failed'
                          : 'Preparing'}
                    </Badge>
                  {/if}
                </div>
              </div>
                <div class="flex items-center justify-between">
                  <div></div>
                  <div class="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onclick={() => {
                        if (editorGoonId === goon.id) {
                          requestWorkspaceExit({ type: 'close-editor' })
                        } else if (editorHairImportOpen) {
                          toast.info(
                            'Finish or cancel the active Hair import before editing another Goon.'
                          )
                        } else {
                          openCueEditor(goon)
                        }
                      }}
                    >
                      {editorGoonId === goon.id ? 'Close Editor' : 'Edit Goon'}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onclick={() => void handleDuplicateGoon(goon)}
                      disabled={duplicateGoonBusyId !== null}
                    >
                      <Copy  />
                      {duplicateGoonBusyId === goon.id ? 'Duplicating…' : 'Duplicate'}
                    </Button>
                  </div>
                </div>
            </div>
          {/each}
        {/if}
      </div>
    </SettingsAccordionCard>
  {/if}
  {/if}
          </div>

        </div>

	  {#if !editorGoonId && !sceneEditorMode && activeTab === 'kitchen'}
	    <SettingsLivePreviewPane
	      bind:host={kitchenPreviewContainer}
	      width={previewWidth}
      resizing={previewResizing}
      resizeAriaLabel="Resize live preview"
      onResizeStart={startPreviewResize}
      runtimeBadge={resolveRendererBadge(kitchenPreviewRuntimeStatus)}
      loading={kitchenPreviewLoading}
      error={kitchenPreviewError}
	      emptyMessage={!kitchenPreviewGoonId ? 'Select a Goon to preview.' : null}
	      wrapperClass="h-full min-h-0 batshit-settings-preview-shell"
	    >
      <div class="flex items-center gap-1 min-w-0 flex-1">
        <DropdownMenu.Root>
          <DropdownMenu.Trigger
            class="batshit-settings-icon-trigger"
            disabled={goons.length === 0}
            aria-label="Select preview Goon"
            title={`Preview Goon: ${kitchenPreviewGoon?.name || 'None'}`}
          >
            <BatshitIcon id="goons" class="h-4 w-4" />
          </DropdownMenu.Trigger>
          <DropdownMenu.Content align="start" class="min-w-[220px] max-w-[360px]">
            {#if goons.length > 0}
              {#each goons as goonEntry (goonEntry.id)}
                <DropdownMenu.Item onSelect={() => handleKitchenPreviewGoonSelect(goonEntry.id)}>
                  <span class="truncate">
                    {goonEntry.name || 'Unnamed Goon'}{kitchenPreviewGoonId === goonEntry.id ? ' • Current' : ''}
                  </span>
                </DropdownMenu.Item>
              {/each}
            {:else}
              <DropdownMenu.Item disabled>
                <span class="text-muted-foreground">No goons available</span>
              </DropdownMenu.Item>
            {/if}
          </DropdownMenu.Content>
        </DropdownMenu.Root>

        <DropdownMenu.Root>
          <DropdownMenu.Trigger
            class="batshit-settings-icon-trigger"
            disabled={!kitchenPreviewGoonId || kitchenAvailableAnimationNames.length === 0}
            aria-label="Select preview Motion"
            title={
              kitchenPreviewAnimationName
                ? `Preview Motion: ${kitchenPreviewAnimationName}`
                : 'Select preview Motion'
            }
          >
            <BatshitIcon id="motions" class="h-4 w-4" />
          </DropdownMenu.Trigger>
          <DropdownMenu.Content align="start" class="min-w-[240px] max-h-[320px] overflow-y-auto">
            {#if kitchenAvailableAnimationNames.length > 0}
              {#each kitchenAvailableAnimationNames as animationName}
                <DropdownMenu.Item
                  onSelect={() => {
                    kitchenPreviewAnimationName = animationName
                    void triggerKitchenPreviewAnimation()
                  }}
                >
                  <span class="truncate">
                    {animationName}{kitchenPreviewAnimationName === animationName ? ' • Current' : ''}
                  </span>
                </DropdownMenu.Item>
              {/each}
            {:else}
              <DropdownMenu.Item disabled>
                <span class="text-muted-foreground">No motions available</span>
              </DropdownMenu.Item>
            {/if}
          </DropdownMenu.Content>
        </DropdownMenu.Root>

        <Button
          variant="ghost"
          size="sm"

          onclick={() => void resetKitchenPreviewAll()}
          disabled={!kitchenPreviewGoonId}
          aria-label="Reset preview view controls and clear animation preview"
          title="Reset preview view controls and clear animation preview"
        >
          <RotateCcw  />
        </Button>
      </div>
      <SettingsPreviewViewControls
        disabled={!kitchenPreviewGoonId}
        eyeContactEnabled={settingsPreviewEyeContactEnabled}
        onEyeContactToggle={() => {
          settingsPreviewEyeContactEnabled = !settingsPreviewEyeContactEnabled
        }}
        fov={previewViewFov}
        minFov={MIN_PREVIEW_VIEW_FOV}
        maxFov={MAX_PREVIEW_VIEW_FOV}
        onFovChange={handlePreviewFovChange}
        onFramePreset={handleKitchenPreviewFramePreset}
        cameraMode={previewCameraMode}
        indoorCameraAvailable={kitchenPreviewEngine?.canUseIndoorCamera() ?? false}
        onCameraModeChange={(mode) => handlePreviewCameraModeChange(kitchenPreviewEngine, mode, false)}
        quality={kitchenPreviewQuality}
        qualityOptions={qualityOptions}
        onQualityChange={(value) => {
          kitchenPreviewQuality = value
        }}
      />
	    </SettingsLivePreviewPane>
	  {:else if !editorGoonId && !sceneEditorMode && activeTab === 'motions'}
	    <SettingsLivePreviewPane
      bind:host={previewContainer}
      width={previewWidth}
      resizing={previewResizing}
      resizeAriaLabel="Resize live preview"
      onResizeStart={startPreviewResize}
      runtimeBadge={resolveRendererBadge(previewRuntimeStatus)}
      loading={motionLibraryPreviewLoading || $goonMotionPreviewGenerationActive}
      error={
        $goonMotionPreviewGenerationActive
          ? null
          : motionLibraryPreviewError
      }
      emptyMessage={
        $goonMotionPreviewGenerationActive
          ? 'Motion preview videos are being prepared. The main Live Preview will unlock when generation finishes.'
          : !motionLibraryPreviewName
            ? 'Select a motion to preview it here.'
            : null
	      }
	      wrapperClass="h-full min-h-0 batshit-settings-preview-shell"
	    >
      <div class="flex-1"></div>
      {#if activeMotionPreviewEntry && activeMotionPreviewEntry.vrma && activeMotionPreviewEntry.glb}
        {@const stagePreviewLane = resolveMotionEntryPreviewLane(activeMotionPreviewEntry)}
        <div class="flex items-center justify-center pb-2">
          <div
            class="batshit-goon-motion-lane-toggle"
            role="group"
            aria-label="Stage preview format"
          >
            <button
              type="button"
              class={`batshit-goon-motion-lane-toggle-option ${stagePreviewLane === 'vrm' ? 'is-selected' : ''}`}
              title="Play the VRMA version (VRM Goons)"
              onclick={() => setMotionEntryPreviewLane(activeMotionPreviewEntry, 'vrm')}
            >
              VRMA
            </button>
            <button
              type="button"
              class={`batshit-goon-motion-lane-toggle-option ${stagePreviewLane === 'glb' ? 'is-selected' : ''}`}
              title="Play the GLB version (Advanced/GLB Goons)"
              onclick={() => setMotionEntryPreviewLane(activeMotionPreviewEntry, 'glb')}
            >
              GLB
            </button>
          </div>
        </div>
      {/if}
      <SettingsPreviewViewControls
        disabled={!motionLibraryPreviewName || $goonMotionPreviewGenerationActive}
        showReset={true}
        resetAriaLabel="Clear motion preview and reset view controls"
        resetTitle="Clear motion preview and reset view controls"
        onReset={() => void resetMotionLibraryPreviewAll()}
        fov={previewViewFov}
        minFov={MIN_PREVIEW_VIEW_FOV}
        maxFov={MAX_PREVIEW_VIEW_FOV}
        onFovChange={handlePreviewFovChange}
        onFramePreset={handlePreviewFramePreset}
        cameraMode={previewCameraMode}
        indoorCameraAvailable={previewEngine?.canUseIndoorCamera() ?? false}
        onCameraModeChange={(mode) => handlePreviewCameraModeChange(previewEngine, mode, false)}
      />
    </SettingsLivePreviewPane>
	  {/if}
      </div>
      {/if}

{#if editorGoonId}
      {@const editorFormatVisual = goonFormatVisual(editorGoon)}
      <div
        bind:this={editorShellEl}
        class="flex min-h-0 flex-1 items-stretch overflow-hidden"
      >
        <div class="batshit-settings-preview-shell batshit-goon-static-card flex h-full min-h-0 min-w-0 flex-1 flex-col">
          <div bind:this={editorScrollElement} class="min-h-0 flex-1 overflow-y-auto">
          <div class="space-y-3 px-5 pt-6 pb-24">
          <div class="flex items-center justify-between">
            <div class="batshit-settings-badge-row flex items-center gap-2">
              <div class="batshit-settings-form-label flex items-center gap-2">
                <BatshitIcon id="goons" class="h-4 w-4" />
                <span>Goon Editor</span>
              </div>
              <Badge variant="secondary" class="batshit-settings-child-label batshit-goon-kind-badge">
                {#if editorFormatVisual.icons.length}
                  <span class="batshit-goon-brand-strip is-inline" aria-label={`${editorFormatVisual.label} format icons`}>
                    {#each editorFormatVisual.icons as icon (icon.label)}
                      <IconRenderer
                        ref={icon.ref}
                        label={icon.label}
                        class={`batshit-goon-brand-icon is-badge ${icon.wide ? 'is-wide' : ''}`}
                        iconClass="h-full w-full"
                        imageClass="h-full w-full object-contain"
                      />
                    {/each}
                  </span>
                {/if}
                <span class="batshit-goon-kind-label">{editorFormatVisual.label}</span>
              </Badge>
              {#if editorPendingVrmFile || editorGoon?.files?.vrmPending}
                <Badge variant="secondary" class="batshit-settings-child-label">Pending Update</Badge>
              {/if}
            </div>
          </div>

          <Collapsible.Root bind:open={editorBasicSettingsOpen} class={goonLevel1AccordionClass}>
            <Collapsible.Trigger
              class={goonLevel1AccordionHeaderClass}
              onclick={() => toggleEditorPrimarySection('basic')}
            >
              <div class="flex items-center gap-1.5">
                <BatshitIcon id="core-basic" class="batshit-goon-l1-icon h-4 w-4" />
                <span class="batshit-settings-form-label">Basic Goon Settings</span>
                <div
                  onclick={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                  }}
                  aria-hidden="true"
                >
                  <SettingsInfoMenu ariaLabel="About Basic Goon Settings" contentClass="w-80">
                    <p>{EDITOR_BASIC_SETTINGS_INFO}</p>
                  </SettingsInfoMenu>
                </div>
              </div>
              <ChevronDown
                class={`h-4 w-4 shrink-0 transition-transform ${editorBasicSettingsOpen ? 'rotate-180' : ''}`}
              />
            </Collapsible.Trigger>
            <Collapsible.Content class={goonLevel1AccordionContentClass}>
              <div class="batshit-settings-form-stack">
                <div class="batshit-settings-form-row">
                  <div class="batshit-settings-form-copy">
                    <GoonsFieldLabel
                      label="Goon Name"
                      info={EDITOR_GOON_NAME_INFO}
                      ariaLabel="About Goon Name"
                      class="batshit-settings-form-label-line"
                    />
                  </div>
                  <div class="batshit-settings-form-control">
                  <Input
                    placeholder="Goon name"
                    bind:value={editorName}
                    oninput={() => {
                      editorDirty = true
                    }}
                  />
                  </div>
                </div>
                <div class="batshit-settings-form-row">
                  <div class="batshit-settings-form-copy">
                    <GoonsFieldLabel
                      label="Description"
                      info={EDITOR_DESCRIPTION_INFO}
                      ariaLabel="About Goon Description"
                      class="batshit-settings-form-label-line"
                    />
                  </div>
                  <div class="batshit-settings-form-control is-inline-status">
                    <span class="min-w-0 flex-1 truncate text-sm text-muted-foreground">
                      {editorDescription.trim() || 'No description'}
                    </span>
                    <Button
                      variant="outline"
                      size="sm"

                      onclick={() => (editorDescriptionEditorOpen = true)}
                    >
                      <Pencil  />
                      Edit
                    </Button>
                  </div>
                </div>
                <div class="batshit-settings-form-row">
                  <div class="batshit-settings-form-copy">
                    <GoonsFieldLabel
                      label="Lip Sync"
                      info={EDITOR_LIP_SYNC_INFO}
                      ariaLabel="About Lip Sync"
                      class="batshit-settings-form-label-line"
                    />
                  </div>
                  <div class="batshit-settings-form-control is-inline-status">
                  <Switch.Root
                    checked={editorLipSync}
                    onCheckedChange={(checked) => {
                      editorLipSync = Boolean(checked)
                      editorDirty = true
                    }}
                  />
                  </div>
                </div>
                <div class="batshit-settings-form-row">
                  <div class="batshit-settings-form-copy">
                    <GoonsFieldLabel
                      label="Quality"
                      info={EDITOR_QUALITY_INFO}
                      ariaLabel="About Quality"
                      class="batshit-settings-form-label-line"
                    />
                  </div>
                  <div class="batshit-settings-form-control">
                  <Select.Root
                    type="single"
                    value={editorQuality}
                    onValueChange={(value: string) => {
                      editorQuality = value as GoonEngineQuality
                      editorDirty = true
                    }}
                  >
                    <Select.Trigger>
                      {qualityOptions.find((option) => option.value === editorQuality)?.label || 'Auto'}
                    </Select.Trigger>
                    <Select.Content>
                      {#each qualityOptions as option}
                        <Select.Item value={option.value}>{option.label}</Select.Item>
                      {/each}
                    </Select.Content>
                  </Select.Root>
                  </div>
                </div>
                <div class="batshit-settings-form-row">
                  <div class="batshit-settings-form-copy">
                    <GoonsFieldLabel
                      label="Current Mood"
                      info={EDITOR_CURRENT_MOOD_INFO}
                      ariaLabel="About Current Mood"
                      class="batshit-settings-form-label-line"
                    />
                  </div>
                  <div class="batshit-settings-form-control">
                  <Select.Root
                    type="single"
                    value={editorBaseLoop}
                    onValueChange={(value: string) => {
                      editorBaseLoop = value
                      editorDirty = true
                    }}
                  >
                    <Select.Trigger>
                      {baseCueOptions.includes(editorBaseLoop) ? editorBaseLoop : 'Select mood'}
                    </Select.Trigger>
                    <Select.Content>
                      {#each baseCueOptions as option}
                        <Select.Item value={option}>{option}</Select.Item>
                      {/each}
                    </Select.Content>
                  </Select.Root>
                  </div>
                </div>
                <div class="batshit-settings-form-row">
                  <div class="batshit-settings-form-copy">
                    <GoonsFieldLabel
                      label="Default Scene"
                      info={EDITOR_DEFAULT_SCENE_INFO}
                      ariaLabel="About Default Scene"
                      class="batshit-settings-form-label-line"
                    />
                  </div>
                  <div class="batshit-settings-form-control">
                  <Select.Root
                    type="single"
                    value={editorSceneId}
                    onValueChange={(value: string) => {
                      editorSceneId = value
                      editorDirty = true
                    }}
                  >
                    <Select.Trigger>
                      {editorScene?.name || 'None'}
                    </Select.Trigger>
                    <Select.Content>
                      <Select.Item value="">None</Select.Item>
                      {#each sortedScenes as scene}
                        <Select.Item value={scene.id}>{scene.name}</Select.Item>
                      {/each}
                    </Select.Content>
                  </Select.Root>
                  </div>
                </div>
              </div>
            </Collapsible.Content>
          </Collapsible.Root>

          <Collapsible.Root bind:open={editorEyeContactOpen} class={goonLevel1AccordionClass}>
            <Collapsible.Trigger
              class={goonLevel1AccordionHeaderClass}
              onclick={() => toggleEditorPrimarySection('eye-contact')}
            >
              <div class="flex items-center gap-1.5">
                <Eye class="batshit-goon-l1-icon h-4 w-4" />
                <span class="batshit-settings-form-label">Eye Contact</span>
                <div
                  onclick={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                  }}
                  aria-hidden="true"
                >
                  <SettingsInfoMenu ariaLabel="About Eye Contact" contentClass="w-80">
                    <p>
                      {editorHasSocketEyeContact
                        ? 'The eyes move across each fixed eye surface toward one shared target while the matching ARKit Look shapes naturally accommodate the eyelids and artwork. Gaze Convergence fine-tunes the inward aim, and Head Follow helps only when the target reaches the package-safe edge.'
                        : EDITOR_EYE_CONTACT_TUNING_INFO}
                    </p>
                  </SettingsInfoMenu>
                </div>
              </div>
              <ChevronDown
                class={`h-4 w-4 shrink-0 transition-transform ${editorEyeContactOpen ? 'rotate-180' : ''}`}
              />
            </Collapsible.Trigger>
            <Collapsible.Content class={`${goonLevel1AccordionContentClass} space-y-3`}>
              {#if editorHasSocketEyeContact}
                <SocketEyeContactEditor
                  value={editorSocketEyeContact}
                  disabled={editorSaving}
                  onChange={updateEditorSocketEyeContact}
                />
              {:else}
                <div class="flex justify-end px-3">
                  <Button variant="outline" size="sm" onclick={resetEditorEyeContactToGlobal}>
                    <RotateCcw aria-hidden="true" />
                    Reset to Global
                  </Button>
                </div>
                <EyeContactTuningEditor
                  mode={editorEyeContactMode}
                  tuning={buildEditorEyeContactTuning()}
                  modeInfo={EDITOR_EYE_CONTACT_MODE_INFO}
                  coordinationInfo={EDITOR_EYE_CONTACT_COORDINATION_INFO}
                  onModeChange={(mode) => {
                    editorEyeContactMode = mode
                    editorDirty = true
                  }}
                  onTuningChange={updateEditorEyeContactTuning}
                />
              {/if}
            </Collapsible.Content>
          </Collapsible.Root>

          {#if editorGoonKind === 'custom' && (editorAppearanceDialsManifest || editorAppearanceDialsError || editorFacialArtworkDefinition || editorFacialArtworkError || editorFacialArtworkPackageNotice)}
            <Collapsible.Root bind:open={editorCustomGoonBuilderOpen} class={goonLevel1AccordionClass}>
              <Collapsible.Trigger
                class={goonLevel1AccordionHeaderClass}
                onclick={() => toggleEditorPrimarySection('custom-goon-builder')}
              >
                <div class="flex items-center gap-1.5">
                  <SlidersHorizontal class="batshit-goon-l1-icon h-4 w-4" />
                  <span class="batshit-settings-form-label">Custom Goon Builder</span>
                  <div
                    onclick={(event) => {
                      event.preventDefault()
                      event.stopPropagation()
                    }}
                    aria-hidden="true"
                  >
                    <SettingsInfoMenu ariaLabel="About Custom Goon Builder" contentClass="w-80">
                      <p>
                        Build this Custom Goon's identity in one place. Face shape and fitted facial
                        artwork come first, followed by body, head, and neck proportions. Every
                        change previews live and remains tied to this exact package definition.
                      </p>
                    </SettingsInfoMenu>
                  </div>
                </div>
                <ChevronDown
                  class={`h-4 w-4 shrink-0 transition-transform ${editorCustomGoonBuilderOpen ? 'rotate-180' : ''}`}
                />
              </Collapsible.Trigger>
              <Collapsible.Content class={`${goonLevel1AccordionContentClass} space-y-3`}>
                <div class="batshit-goon-builder-section-heading">
                  <div class="batshit-goon-builder-section-title">Face</div>
                  <p class="batshit-goon-builder-section-copy">
                    Shape the face and apply package-fitted brows, eyes, mouth, and lip artwork.
                  </p>
                </div>
                {#if editorFacialArtworkPackageNotice}
                  <div class="px-3 pb-2">
                    <p class="text-[0.675rem] leading-relaxed text-amber-400" role="status">
                      {editorFacialArtworkPackageNotice}
                    </p>
                  </div>
                {/if}
                {#if editorAppearanceDialsError}
                  <p class="batshit-settings-form-error px-3">
                    Face Builder unavailable: {editorAppearanceDialsError}
                  </p>
                {:else if editorAppearanceDialsManifest && editorAppearanceDialsState}
                  <div class="px-3 pb-2">
                    {#if editorFacialArtworkNotice}
                      <p class="mb-2 text-[0.625rem] leading-relaxed text-muted-foreground" role="status">
                        {editorFacialArtworkNotice}
                      </p>
                    {/if}
                    {#if editorEyeAppearanceNotice}
                      <p class="mb-2 text-[0.625rem] leading-relaxed text-muted-foreground" role="status">
                        {editorEyeAppearanceNotice}
                      </p>
                    {/if}
                    {#if editorOralAppearanceNotice}
                      <p class="mb-2 text-[0.625rem] leading-relaxed text-muted-foreground" role="status">
                        {editorOralAppearanceNotice}
                      </p>
                    {/if}
                    {#if editorLipArtworkNotice}
                      <p class="mb-2 text-[0.625rem] leading-relaxed text-muted-foreground" role="status">
                        {editorLipArtworkNotice}
                      </p>
                    {/if}
                    {#if editorSkinAppearanceNotice}
                      <p class="mb-2 text-[0.625rem] leading-relaxed text-muted-foreground" role="status">
                        {editorSkinAppearanceNotice}
                      </p>
                    {/if}
                    {#if editorSkinAppearanceError}
                      <p class="batshit-settings-form-error mb-2" role="alert">
                        Skin Appearance unavailable: {editorSkinAppearanceError}
                      </p>
                    {/if}
                    {#if editorFacialArtworkPreviewError}
                      <p class="batshit-settings-form-error mb-2" role="alert">
                        Live preview failed: {editorFacialArtworkPreviewError}
                      </p>
                    {/if}
                    {#if editorSkinAppearancePreviewError}
                      <p class="batshit-settings-form-error mb-2" role="alert">
                        Skin preview failed: {editorSkinAppearancePreviewError}
                      </p>
                    {/if}
                    {#snippet facialArtworkRegion(scope: 'brows' | 'eyes')}
                      {#if editorFacialArtworkError}
                        <p class="batshit-settings-form-error">
                          Facial Artwork unavailable: {editorFacialArtworkError}
                        </p>
                      {:else if editorFacialArtworkDefinition && editorFacialArtworkState && editorEyeAppearanceDefinition && editorEyeAppearanceState}
                        <FacialArtworkEditor
                          {scope}
                          definition={editorFacialArtworkDefinition}
                          eyeAppearanceDefinition={editorEyeAppearanceDefinition}
                          valueState={editorFacialArtworkState}
                          eyeAppearanceState={editorEyeAppearanceState}
                          ownerDisplayName={userSettings?.displayName ?? ''}
                          creditDraft={editorFacialArtworkCreditDraft}
                          disabled={editorSaving}
                          onCreditDraftChange={(draft) => (editorFacialArtworkCreditDraft = draft)}
                          onChange={updateEditorFacialArtwork}
                          onEyeAppearanceChange={updateEditorEyeAppearance}
                          onUpload={uploadEditorFacialArtwork}
                          onUploadBusyChange={(busy) => (editorFacialArtworkUploadBusy = busy)}
                        />
                      {:else}
                        <p class="batshit-settings-form-error" role="alert">
                          Facial Artwork or Eye Appearance is unavailable for this Goon package.
                        </p>
                      {/if}
                    {/snippet}

                    <AppearanceDialsEditor
                      manifest={editorAppearanceDialsManifest}
                      valueState={editorAppearanceDialsState}
                      surface="head-face"
                      onChange={updateEditorAppearanceDials}
                      regionContentIds={[
                        'face.brows',
                        'face.eyes',
                        ...((editorOralAppearanceDefinition && editorOralAppearanceState) ||
                        editorLipArtworkDefinition
                          ? ['face.mouth-lips']
                          : []),
                        ...(editorSkinAppearanceDefinition && editorSkinAppearanceState
                          ? ['face.cheeks']
                          : [])
                      ]}
                      regionContentControlCounts={{
                        'face.mouth-lips':
                          (editorOralAppearanceDefinition ? 5 : 0) +
                          (editorLipArtworkDefinition ? 1 : 0),
                        'face.cheeks': editorSkinAppearanceDefinition ? 1 : 0
                      }}
                      regionContentChangedCounts={{
                        'face.mouth-lips':
                          editorOralAppearanceChangedCount +
                          (editorLipArtworkState ? 1 : 0) +
                          (editorLipArtworkPresence ? 1 : 0),
                        'face.cheeks': editorSkinAppearanceChangedCount('face.cheeks')
                      }}
                      regionContentSearchText={editorAppearanceRegionContentSearchText}
                      onResetRegionContent={resetEditorOralAppearance}
                    >
                      {#snippet regionContent(regionId: string)}
                        {#if regionId === 'face.brows'}
                          {@render facialArtworkRegion('brows')}
                        {:else if regionId === 'face.eyes'}
                          {@render facialArtworkRegion('eyes')}
                        {:else if regionId === 'face.mouth-lips'}
                          {#if editorOralAppearanceDefinition && editorOralAppearanceState}
                            <OralAppearanceEditor
                              definition={editorOralAppearanceDefinition}
                              valueState={editorOralAppearanceState}
                              disabled={editorSaving}
                              onChange={updateEditorOralAppearance}
                            />
                          {/if}
                          {#if editorLipArtworkDefinition}
                            <LipArtworkEditor
                              definition={editorLipArtworkDefinition}
                              valueState={editorLipArtworkState}
                              surfaceEnabled={editorLipArtworkPresence?.enabled ?? true}
                              ownerDisplayName={userSettings?.displayName ?? ''}
                              creditDraft={editorFacialArtworkCreditDraft}
                              disabled={editorSaving}
                              onCreditDraftChange={(draft) => (editorFacialArtworkCreditDraft = draft)}
                              onChange={updateEditorLipArtwork}
                              onSurfaceEnabledChange={updateEditorLipArtworkPresence}
                              onUpload={uploadEditorLipArtwork}
                              onUploadBusyChange={(busy) => (editorFacialArtworkUploadBusy = busy)}
                            />
                          {/if}
                        {:else if regionId === 'face.cheeks' && editorSkinAppearanceDefinition && editorSkinAppearanceState}
                          <SkinAppearanceEditor
                            definition={editorSkinAppearanceDefinition}
                            valueState={editorSkinAppearanceState}
                            regionId="cheekBlush"
                            disabled={editorSaving}
                            onChange={updateEditorSkinAppearance}
                          />
                        {/if}
                      {/snippet}
                    </AppearanceDialsEditor>
                  </div>
                {/if}
                <div class="batshit-goon-builder-section-heading is-body">
                  <div class="batshit-goon-builder-section-title">Body</div>
                  <p class="batshit-goon-builder-section-copy">
                    Continue with body, head, and neck proportions after the face is established.
                  </p>
                </div>
                {#if editorAppearanceDialsError}
                  <p class="batshit-settings-form-error px-3">
                    Body Builder unavailable: {editorAppearanceDialsError}
                  </p>
                {:else if editorAppearanceDialsManifest && editorAppearanceDialsState}
                  <div class="px-3 pb-2">
                    {#if editorAppearanceDialsNotice}
                      <p class="mb-2 text-[0.625rem] leading-relaxed text-muted-foreground" role="status">
                        {editorAppearanceDialsNotice}
                      </p>
                    {/if}
                    {#if editorNailSurfaceNotice}
                      <p class="mb-2 text-[0.625rem] leading-relaxed text-muted-foreground" role="status">
                        {editorNailSurfaceNotice}
                      </p>
                    {/if}
                    {#if editorNailSurfaceError}
                      <p class="batshit-settings-form-error mb-2" role="alert">
                        Nails unavailable: {editorNailSurfaceError}
                      </p>
                    {/if}
                    {#if editorNailSurfacePreviewError}
                      <p class="batshit-settings-form-error mb-2" role="alert">
                        Nail preview failed: {editorNailSurfacePreviewError}
                      </p>
                    {/if}
                    {#if editorSkinAppearanceNotice}
                      <p class="mb-2 text-[0.625rem] leading-relaxed text-muted-foreground" role="status">
                        {editorSkinAppearanceNotice}
                      </p>
                    {/if}
                    {#if editorSkinAppearanceError}
                      <p class="batshit-settings-form-error mb-2" role="alert">
                        Skin Appearance unavailable: {editorSkinAppearanceError}
                      </p>
                    {/if}
                    {#if editorSkinAppearancePreviewError}
                      <p class="batshit-settings-form-error mb-2" role="alert">
                        Skin preview failed: {editorSkinAppearancePreviewError}
                      </p>
                    {/if}
                    <AppearanceDialsEditor
                      manifest={editorAppearanceDialsManifest}
                      valueState={editorAppearanceDialsState}
                      surface="body"
                      onChange={updateEditorAppearanceDials}
                      regionContentIds={editorSkinAppearanceDefinition && editorSkinAppearanceState
                        ? ['body.skin', 'body.chest', 'body.hands-feet']
                        : editorNailSurfaceDefinition && editorNailSurfaceState
                          ? ['body.hands-feet']
                          : []}
                      regionContentControlCounts={{
                        'body.skin': editorSkinAppearanceDefinition ? 4 : 0,
                        'body.chest': editorSkinAppearanceDefinition ? 1 : 0,
                        'body.hands-feet':
                          (editorNailSurfaceDefinition ? 17 : 0) +
                          (editorSkinAppearanceDefinition ? 1 : 0)
                      }}
                      regionContentChangedCounts={{
                        'body.skin': editorSkinAppearanceChangedCount('body.skin'),
                        'body.chest': editorSkinAppearanceChangedCount('body.chest'),
                        'body.hands-feet':
                          editorNailSurfaceChangedCount +
                          editorSkinAppearanceChangedCount('body.hands-feet')
                      }}
                      regionContentSearchText={editorAppearanceRegionContentSearchText}
                      onResetRegionContent={resetEditorNailSurface}
                    >
                      {#snippet regionContent(regionId: string)}
                        {#if editorSkinAppearanceDefinition && editorSkinAppearanceState}
                          {@const skinControlId = skinAppearanceControlForAppearanceRegion(regionId)}
                          {#if regionId === 'body.skin'}
                            <SkinSurfaceEditor
                              definition={editorSkinAppearanceDefinition}
                              valueState={editorSkinAppearanceState}
                              ownerDisplayName={userSettings?.displayName ?? ''}
                              creditDraft={editorFacialArtworkCreditDraft}
                              disabled={editorSaving}
                              onCreditDraftChange={(draft) =>
                                (editorFacialArtworkCreditDraft = draft)}
                              onChange={updateEditorSkinAppearance}
                              onUpload={uploadEditorSkinSurfaceArtwork}
                              onUploadBusyChange={(busy) =>
                                (editorFacialArtworkUploadBusy = busy)}
                            />
                          {/if}
                          {#if skinControlId}
                            <SkinAppearanceEditor
                              definition={editorSkinAppearanceDefinition}
                              valueState={editorSkinAppearanceState}
                              regionId={skinControlId}
                              disabled={editorSaving}
                              onChange={updateEditorSkinAppearance}
                            />
                          {/if}
                        {/if}
                        {#if regionId === 'body.hands-feet' && editorNailSurfaceDefinition && editorNailSurfaceState}
                          <NailSurfaceEditor
                            definition={editorNailSurfaceDefinition}
                            valueState={editorNailSurfaceState}
                            surfaceEnabled={editorNailSurfacePresence?.enabled ?? true}
                            ownerDisplayName={userSettings?.displayName ?? ''}
                            creditDraft={editorFacialArtworkCreditDraft}
                            disabled={editorSaving}
                            onCreditDraftChange={(draft) => (editorFacialArtworkCreditDraft = draft)}
                            onChange={updateEditorNailSurface}
                            onSurfaceEnabledChange={updateEditorNailSurfacePresence}
                            onUpload={uploadEditorNailArtwork}
                            onUploadBusyChange={(busy) => (editorFacialArtworkUploadBusy = busy)}
                          />
                        {/if}
                      {/snippet}
                    </AppearanceDialsEditor>
                  </div>
                {/if}
              </Collapsible.Content>
            </Collapsible.Root>
          {/if}

          <Collapsible.Root bind:open={editorHairOpen} class={goonLevel1AccordionClass}>
            <Collapsible.Trigger
              class={goonLevel1AccordionHeaderClass}
              onclick={() => toggleEditorPrimarySection('hair')}
            >
              <div class="flex items-center gap-1.5">
                <Scissors class="batshit-goon-l1-icon h-4 w-4" />
                <span class="batshit-settings-form-label">Hair</span>
                <div
                  onclick={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                  }}
                  aria-hidden="true"
                >
                  <SettingsInfoMenu ariaLabel="About Hair" contentClass="w-80">
                    <p>
                      Choose a compatible built-in or imported Hair style. Changes preview on the
                      current Goon immediately and become part of its self-contained Live Goon when
                      you click Save Goon.
                    </p>
                  </SettingsInfoMenu>
                </div>
              </div>
              <ChevronDown
                class={`h-4 w-4 shrink-0 transition-transform ${editorHairOpen ? 'rotate-180' : ''}`}
              />
            </Collapsible.Trigger>
            <Collapsible.Content class={`${goonLevel1AccordionContentClass} pt-3`}>
              <HairCatalogEditor
                assets={hairAssets}
                refitSources={hairRefitSources}
                valueState={editorHairState}
                recipeSource={editorHairRecipeSource}
                supported={editorHairSupported}
                loading={hairCatalogLoading}
                busy={hairPreviewBusy}
                loadError={hairCatalogError}
                previewError={editorHairStateError ?? hairPreviewError}
                retiredStateRecovery={editorRetiredHairSibling
                  ? {
                      busy: retiredHairRecoveryBusy,
                      onReset: resetEditorRetiredHair
                    }
                  : null}
                disabled={editorSaving || recipeWorkflowBusy || Boolean(editorRetiredHairSibling)}
                onRefresh={() => refreshHairCatalog().then(() => undefined).catch(() => undefined)}
                onSelect={selectEditorHairAsset}
                onImport={openEditorHairImport}
                onRefit={openEditorHairRefit}
                onDelete={deleteEditorHairAsset}
                onColorsChange={updateEditorHairColors}
                motionTuning={editorHairMotionTuning}
                onMotionTuningChange={updateEditorHairMotionTuning}
              />
              {#if editorHairImportOpen && (hairImportInitialFile || hairImportInitialInspection)}
                <div
                  bind:this={hairImportWizardElement}
                  role="region"
                  aria-label="Hair import review"
                  tabindex="-1"
                >
                  <HairImportWizard
                    initialFile={hairImportInitialFile}
                    initialCalibrationFile={hairImportInitialCalibrationFile}
                    initialInspection={hairImportInitialInspection}
                    initialFileSelection={hairImportRefitAsset && hairImportRefitSource
                      ? {
                          name: `${hairImportRefitAsset.display.name}.glb`,
                          size: hairImportRefitSource.source.bytes,
                          type: hairImportRefitSource.source.mimeType
                        }
                      : null}
                    mode={hairImportRefitAsset ? 'refit' : 'import'}
                    disabled={editorSaving || recipeWorkflowBusy}
                    onInspect={inspectEditorHairImport}
                    onPreviewSelectionChange={updateEditorHairImportSelection}
                    onPreviewTransformChange={updateEditorHairImportTransform}
                    onReturnToFit={restoreEditorHairImportFit}
                    onBuildPreview={buildEditorHairImportPreview}
                    onEditMotionPaint={editEditorHairMotionPaint}
                    onSetMotionMap={setEditorHairImportMotionMap}
                    onFinalize={finalizeEditorHairImport}
                    onCancel={cancelEditorHairImport}
                    onComplete={completeEditorHairImport}
                    onClose={closeEditorHairImport}
                  />
                </div>
              {/if}
            </Collapsible.Content>
          </Collapsible.Root>

          <Collapsible.Root bind:open={editorClosetOpen} class={goonLevel1AccordionClass}>
            <Collapsible.Trigger
              class={goonLevel1AccordionHeaderClass}
              onclick={() => toggleEditorPrimarySection('closet')}
            >
              <div class="flex items-center gap-1.5">
                <BatshitIcon id="closet" class="batshit-goon-l1-icon h-4 w-4" />
                <span class="batshit-settings-form-label">Wardrobe</span>
                <div
                  onclick={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                  }}
                  aria-hidden="true"
                >
                  <SettingsInfoMenu ariaLabel="About Wardrobe" contentClass="w-80">
                    <p>{EDITOR_CLOSET_INFO}</p>
                  </SettingsInfoMenu>
                </div>
              </div>
              <ChevronDown
                class={`h-4 w-4 shrink-0 transition-transform ${editorClosetOpen ? 'rotate-180' : ''}`}
              />
            </Collapsible.Trigger>
            <Collapsible.Content class={`${goonLevel1AccordionContentClass} batshit-goon-wardrobe-content`}>
              {#if editorGoonKind !== 'custom'}
                <div class="batshit-goon-wardrobe-outfits">
                  <div class="batshit-goon-wardrobe-section-heading">
                    <div class="min-w-0">
                      <span class="batshit-settings-form-label">Outfits</span>
                      <span class="batshit-goon-wardrobe-current">
                        Current:
                        <span class="batshit-settings-inline-strong">{resolveWardrobeOutfitActiveLabel()}</span>
                      </span>
                    </div>
                  </div>
                  <div class="batshit-goon-outfit-tags">
                    <button
                      type="button"
                      class={`batshit-goon-outfit-tag ${
                        editorActiveWardrobeOutfitId === ALL_ORIGINAL_WARDROBE_OUTFIT_ID ? 'is-active' : ''
                      }`}
                      disabled={!editorCanUseWardrobeOutfits || editorSaving}
                      onclick={() => void applyBuiltInWardrobeOutfit(ALL_ORIGINAL_WARDROBE_OUTFIT_ID)}
                    >
                      All Original
                    </button>
                    <button
                      type="button"
                      class={`batshit-goon-outfit-tag ${
                        editorActiveWardrobeOutfitId === NO_WARDROBE_OUTFIT_ID ? 'is-active' : ''
                      }`}
                      disabled={!editorCanUseWardrobeOutfits || editorSaving}
                      onclick={() => void applyBuiltInWardrobeOutfit(NO_WARDROBE_OUTFIT_ID)}
                    >
                      None
                    </button>
                    {#each editorWardrobeOutfitList as outfit (outfit.id)}
                      <div
                        class={`batshit-goon-outfit-tag-wrap ${
                          editorActiveWardrobeOutfitId === outfit.id ? 'is-active' : ''
                        }`}
                      >
                        <button
                          type="button"
                          class="batshit-goon-outfit-tag is-saved"
                          disabled={!editorCanUseWardrobeOutfits || editorSaving}
                          onclick={() => void applySavedWardrobeOutfit(outfit.id)}
                        >
                          {outfit.name}
                        </button>
                        <div class="batshit-goon-outfit-tag-actions">
                          <Button
                            variant="ghost"
                            size="xs"
                            disabled={!editorCanUseWardrobeOutfits || editorSaving}
                            aria-label={`Update ${outfit.name}`}
                            title="Update Outfit"
                            onclick={(event) => {
                              event.stopPropagation()
                              void updateWardrobeOutfit(outfit.id)
                            }}
                          >
                            <RefreshCw aria-hidden="true" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="xs"
                            class="is-danger"
                            aria-label={`Delete ${outfit.name}`}
                            title="Delete Outfit"
                            disabled={!editorCanUseWardrobeOutfits || editorSaving}
                            onclick={(event) => {
                              event.stopPropagation()
                              void deleteWardrobeOutfit(outfit.id)
                            }}
                          >
                            <Trash2 aria-hidden="true" />
                          </Button>
                        </div>
                      </div>
                    {/each}
                    {#if !editorWardrobeOutfitCreateOpen}
                      <button
                        type="button"
                        class="batshit-goon-outfit-tag is-create"
                        disabled={!editorCanUseWardrobeOutfits || editorSaving}
                        onclick={() => {
                          newWardrobeOutfitName = ''
                          editorWardrobeOutfitCreateOpen = true
                        }}
                      >
                        + Create Outfit
                      </button>
                    {/if}
                  </div>

                  {#if editorWardrobeOutfitCreateOpen}
                    <div class="batshit-goon-outfit-create-row">
                      <Input
                        class="batshit-settings-grid-control"
                        placeholder="New Outfit name"
                        bind:value={newWardrobeOutfitName}
                        disabled={!editorCanUseWardrobeOutfits || editorSaving}
                        onkeydown={(event) => {
                          if (event.key === 'Enter') {
                            event.preventDefault()
                            void saveCurrentWardrobeOutfit()
                          }
                          if (event.key === 'Escape') {
                            event.preventDefault()
                            cancelWardrobeOutfitCreate()
                          }
                        }}
                      />
                      <div class="flex shrink-0 items-center gap-2">
                        <Button
                          size="sm"
                          disabled={
                            !editorCanUseWardrobeOutfits ||
                            editorSaving ||
                            !normalizeWardrobeOutfitName(newWardrobeOutfitName)
                          }
                          onclick={() => void saveCurrentWardrobeOutfit()}
                        >
                          <Save aria-hidden="true" />
                          Save Current Outfit
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={editorSaving}
                          onclick={cancelWardrobeOutfitCreate}
                        >
                          <X aria-hidden="true" />
                          Cancel
                        </Button>
                      </div>
                    </div>
                  {/if}
                </div>
              {/if}

              <div class="batshit-goon-wardrobe-items-section">
                <div class="batshit-goon-wardrobe-section-heading">
                  <div class="flex items-center gap-1.5">
                    <span class="batshit-settings-form-label">Wardrobe Items</span>
                    <SettingsInfoMenu ariaLabel="About Wardrobe Items" contentClass="w-96">
                      {#each EDITOR_CLOSET_SLOTS_INFO as line}
                        <p>{line}</p>
                      {/each}
                    </SettingsInfoMenu>
                  </div>
                </div>
                <div class="space-y-3">
                    {#if editorGoonKind === 'custom'}
                      <p class="batshit-settings-form-label">
                        Advanced/GLB Goons will use named outfit presets first. Wardrobe controls do not apply to this lane yet.
                      </p>
                    {:else}
                      {#if closetItems.length === 0}
                        <p class="batshit-settings-form-label">
                          No XWear items yet. Import them in the Global Closet first.
                        </p>
                      {/if}
                      {#if !editorGoon?.files?.vrm?.url}
                        <p class="batshit-settings-form-label">Upload a VRM to see available slots.</p>
                      {:else if closetSlotNames.length === 0 && editorStandaloneGuidedOutfitPieces.length === 0}
                        <p class="batshit-settings-form-label">
                          No material slots detected yet. Load the preview to refresh.
                        </p>
                      {:else}
                      {#if closetSlotNames.length > 0}
                        <div class="batshit-goon-wardrobe-picker-summary">
                          Picker shows: <span class="batshit-settings-inline-strong">{editorClosetPickerLabel}</span>
                        </div>
                      {/if}
                      <div class="space-y-2">
                        {#if editorIsGuidedCustomVrm}
                          {#each editorStandaloneGuidedOutfitPieces as piece}
                            {@const selectedGuidedItem = resolveStandaloneGuidedPieceSelectedItem(piece)}
                            <div class="batshit-goon-wardrobe-item-row is-guided-piece">
                              <div class="grid gap-2 sm:grid-cols-[minmax(0,1fr)_196px] sm:items-center">
                                <div class="min-w-0 space-y-1">
                                  <div class="batshit-settings-form-label batshit-goon-wardrobe-piece-title truncate">
                                    {resolveStandaloneGuidedPieceLabel(piece)}
                                  </div>
                                  <div class="flex flex-wrap items-center gap-1.5">
                                    <Badge variant="outline" class="batshit-settings-child-label">
                                      Advanced/Blender
                                    </Badge>
                                    {#if piece.category}
                                      <Badge variant="outline" class="batshit-settings-child-label">
                                        {piece.category}
                                      </Badge>
                                    {/if}
                                  </div>
                                </div>
                                <div class="space-y-1">
                                  <Select.Root
                                    type="single"
                                    value={getStandaloneGuidedPieceValue(piece)}
                                    onValueChange={(value: string) =>
                                      setStandaloneGuidedPieceValue(piece, value)}
                                  >
                                    <Select.Trigger class="batshit-settings-select-compact w-full">
                                      {getStandaloneGuidedPieceLabel(piece)}
                                    </Select.Trigger>
                                    <Select.Content>
                                      {#if !resolveEditedOriginalWardrobeItemForGuidedPiece(piece.id)}
                                        <Select.Item value="__original__">Original</Select.Item>
                                      {/if}
                                      {#each getStandaloneGuidedPieceSavedItems(piece) as item}
                                        <Select.Item value={item.id}>
                                          <div class="flex items-center justify-between gap-2">
                                            <span class="truncate">{getWardrobeItemDisplayName(item)}</span>
                                            <div class="flex shrink-0 items-center gap-1">
                                              <Badge variant="secondary" class="batshit-settings-child-label">
                                                {getClosetPickerSourceLabel(item)}
                                              </Badge>
                                              {#if isWardrobeItemEdited(item)}
                                                <Badge variant="outline" class="batshit-settings-child-label">
                                                  Edited
                                                </Badge>
                                              {/if}
                                            </div>
                                          </div>
                                        </Select.Item>
                                      {/each}
                                      <Select.Item value="__none__">None</Select.Item>
                                    </Select.Content>
                                  </Select.Root>
                                </div>
                              </div>
                              <div class="batshit-goon-wardrobe-guided-actions">
	                                <div class="batshit-goon-wardrobe-guided-meta">
	                                  {#if selectedGuidedItem}
	                                    <Badge variant="secondary" class="batshit-settings-child-label">
	                                      {getClosetPickerSourceLabel(selectedGuidedItem)}
	                                    </Badge>
	                                    {#if isWardrobeItemEdited(selectedGuidedItem)}
	                                      <Badge variant="outline" class="batshit-settings-child-label">
	                                        Edited
	                                      </Badge>
	                                    {/if}
	                                  {:else}
	                                    <Badge variant="outline" class="batshit-settings-child-label">
	                                      Original
	                                    </Badge>
	                                  {/if}
	                                  <span class="batshit-settings-form-label">{getGuidedPieceConcealCountLabel(piece)}</span>
	                                </div>
	                                <div class="flex shrink-0 items-center gap-1">
	                                  {#if selectedGuidedItem && isWardrobeItemEdited(selectedGuidedItem)}
	                                    <Button
	                                      variant="ghost"
	                                      size="sm"
	                                      type="button"

	                                      onclick={(event) => {
	                                        event.preventDefault()
	                                        event.stopPropagation()
	                                        void resetStandaloneGuidedPieceItemEdits(piece)
	                                      }}
	                                    >
	                                      <RotateCcw aria-hidden="true" />

	                                      Reset
	                                    </Button>
	                                  {/if}
	                                  <Button
	                                    variant="outline"
	                                    size="sm"
	                                    type="button"

	                                    disabled={getStandaloneGuidedPieceValue(piece) === '__none__'}
	                                    onclick={(event) => {
	                                      event.preventDefault()
	                                      event.stopPropagation()
	                                      void openGuidedPiecePaintedConcealEditor(piece)
	                                    }}
	                                  >
	                                    <Paintbrush  />
	                                    Conceal
	                                  </Button>
	                                </div>
	                              </div>
                            </div>
                          {/each}
                        {/if}
                        {#each closetSlotNames as slotName}
                          {@const slotAssignment = buildClosetSlotWorkingAssignment(slotName)}
                          {@const selectedSlotItem =
                            slotAssignment.mode === 'item' && slotAssignment.itemId
                              ? resolveClosetItem(slotAssignment.itemId)
                              : null}
                          {@const guidedBasePieces = resolveGuidedBasePiecesForSlot(slotName)}
                          {@const slotEffectiveColors = resolveClosetSlotEffectiveColors(slotName, slotAssignment)}
                          {@const slotColorEditorKey = `slot:${slotName}`}
                          <div class="batshit-goon-wardrobe-item-row">
                            <div class="grid gap-2 sm:grid-cols-[minmax(0,1fr)_220px] sm:items-start">
                              <div class="min-w-0">
                                <div class="flex min-w-0 items-center gap-2">
                                  <span class="batshit-settings-form-label truncate">
                                    {resolveClosetSlotNickname(slotName)}
                                  </span>
                                </div>
                              </div>
                              <div class="space-y-1">
                                <Select.Root
                                  type="single"
                                  value={resolveClosetSlotValue(slotName)}
                                  onValueChange={(value: string) => handleClosetSlotChange(slotName, value)}
                                >
                                  <Select.Trigger class="batshit-settings-select-compact w-full">
                                    {getClosetSlotLabel(slotName)}
                                  </Select.Trigger>
                                  <Select.Content>
                                    {#if !resolveEditedOriginalWardrobeItemForSlot(slotName)}
                                      <Select.Item value="__original__">Original</Select.Item>
                                    {/if}
                                    <Select.Item value="__none__">None</Select.Item>
                                    {#each getClosetItemsForSlot(slotName) as item}
                                      <Select.Item value={item.id}>
                                        <div class="flex items-center justify-between gap-2">
                                          <span class="truncate">{getWardrobeItemDisplayName(item)}</span>
                                          <div class="flex shrink-0 items-center gap-1">
                                            <Badge
                                              variant={getWardrobeItemSourceLabel(item) === 'Goon' ? 'secondary' : 'outline'}
                                              class="batshit-settings-child-label"
                                            >
                                              {getClosetPickerSourceLabel(item)}
                                            </Badge>
                                            {#if isWardrobeItemEdited(item)}
                                              <Badge variant="outline" class="batshit-settings-child-label">
                                                Edited
                                              </Badge>
                                            {/if}
                                          </div>
                                        </div>
                                      </Select.Item>
                                    {/each}
                                  </Select.Content>
                                </Select.Root>
                              </div>
                            </div>
                            <div class="mt-2 flex flex-wrap items-center gap-2">
                              <Badge variant="outline" class="batshit-settings-child-label">
                                {getClosetSlotTypeLabel(slotName)}
                              </Badge>
                              {#if guidedBasePieces.length > 0}
                                <Badge variant="outline" class="batshit-settings-child-label">
                                  Advanced/Blender
                                </Badge>
                              {/if}
                              <div class="batshit-goon-wardrobe-color-chip">
                                <span>Base</span>
                                <span
                                  class={`batshit-goon-wardrobe-color-swatch ${
                                    slotEffectiveColors.baseHex ? '' : 'is-empty'
                                  }`}
                                  style={slotEffectiveColors.baseHex
                                    ? `background:${slotEffectiveColors.baseHex}`
                                    : undefined}
                                ></span>
                              </div>
                              <div class="batshit-goon-wardrobe-color-chip">
                                <span>Shade</span>
                                <span
                                  class={`batshit-goon-wardrobe-color-swatch ${
                                    slotEffectiveColors.shadeHex ? '' : 'is-empty'
                                  }`}
                                  style={slotEffectiveColors.shadeHex
                                    ? `background:${slotEffectiveColors.shadeHex}`
                                    : undefined}
                                ></span>
                              </div>
	                              <span class="batshit-settings-form-label">
	                                {getClosetSlotConcealCountLabel(slotName, slotAssignment)}
	                              </span>
	                            </div>
                            {#if slotAssignment.mode === 'item' && selectedSlotItem}
                              {@const selectedSlotItemColors = resolveClosetItemMaterialColors(selectedSlotItem)}
                              {@const selectedSlotItemShadeIsAuto =
                                !editorCustomClosetItemsById.has(selectedSlotItem.id) ||
                                isEditorClosetItemShadeAuto(selectedSlotItem.id)}
                              <div class="batshit-goon-wardrobe-item-actions">
                                <div class="min-w-0 flex flex-wrap items-center gap-1.5">
                                  <Badge
                                    variant={getWardrobeItemSourceLabel(selectedSlotItem) === 'Goon' ? 'secondary' : 'outline'}
                                    class="batshit-settings-child-label"
                                  >
                                    {getClosetPickerSourceLabel(selectedSlotItem)}
                                  </Badge>
                                  {#if isWardrobeItemEdited(selectedSlotItem)}
                                    <Badge variant="outline" class="batshit-settings-child-label">Edited</Badge>
                                  {/if}
                                </div>
                                <div class="flex shrink-0 flex-wrap items-center gap-1">
                                  {#if selectedSlotItem.xwear}
                                    <Button
                                      variant={editorWardrobeColorEditorKey === slotColorEditorKey ? 'secondary' : 'ghost'}
                                      size="sm"
                                      type="button"

                                      onclick={(event) => {
                                        event.preventDefault()
                                        event.stopPropagation()
                                        editorWardrobeColorEditorKey =
                                          editorWardrobeColorEditorKey === slotColorEditorKey
                                            ? null
                                            : slotColorEditorKey
                                      }}
                                    >
                                      <Palette  />
                                      Colors
                                    </Button>
                                  {/if}
                                  {#if isWardrobeItemEdited(selectedSlotItem)}
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      type="button"

                                      onclick={(event) => {
                                        event.preventDefault()
                                        event.stopPropagation()
                                        void resetWardrobeSlotSelectedItemEdits(slotName)
                                    }}
                                  >
                                      <RotateCcw aria-hidden="true" />
                                      Reset
                                    </Button>
                                  {/if}
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    type="button"

                                    onclick={(event) => {
                                      event.preventDefault()
                                      event.stopPropagation()
                                      void openClosetSlotPaintedConcealEditor(slotName, slotAssignment)
                                    }}
                                  >
                                    <Paintbrush  />
                                    Conceal
                                  </Button>
                                </div>
                              </div>
                              {#if selectedSlotItem.xwear && editorWardrobeColorEditorKey === slotColorEditorKey}
                                <div class="batshit-goon-wardrobe-color-editor">
                                  <div class="flex items-center gap-2">
                                    <span class="batshit-settings-form-label">Base</span>
                                    <input
                                      type="color"
                                      class="batshit-settings-color-input"
                                      value={selectedSlotItemColors?.baseHex ?? '#FFFFFF'}
                                      title="Base Color"
                                      oninput={(event) =>
                                        void handleWardrobeSlotBaseColorChange(
                                          slotName,
                                          (event.currentTarget as HTMLInputElement).value
                                        )}
                                    />
                                  </div>
                                  <div class="flex items-center gap-2">
                                    <span class="batshit-settings-form-label">
                                      Shade {selectedSlotItemShadeIsAuto ? '(auto)' : '(manual)'}
                                    </span>
                                    <input
                                      type="color"
                                      class="batshit-settings-color-input"
                                      value={selectedSlotItemColors?.shadeHex ?? '#000000'}
                                      title="Shade Color"
                                      oninput={(event) =>
                                        void handleWardrobeSlotShadeColorChange(
                                          slotName,
                                          (event.currentTarget as HTMLInputElement).value
                                        )}
                                    />
                                  </div>
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    type="button"

                                    onclick={() => void useWardrobeSlotItemAutoShade(slotName)}
                                  >
                                    <Check aria-hidden="true" />

                                    Use Auto Shade
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    type="button"

                                    disabled={!editorCustomClosetItemsById.has(selectedSlotItem.id)}
                                    onclick={() => void resetWardrobeSlotItemColors(slotName)}
                                  >
                                    <RotateCcw aria-hidden="true" />

                                    Reset Colors
                                  </Button>
                                </div>
                              {/if}
                            {:else if slotAssignment.mode !== 'none'}
                              <div class="batshit-goon-wardrobe-item-actions is-simple">
                                <div class="batshit-settings-form-label">
                                  <span class="batshit-settings-inline-strong">Original</span>
                                </div>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  type="button"

                                  onclick={(event) => {
                                    event.preventDefault()
                                    event.stopPropagation()
                                    void openClosetSlotPaintedConcealEditor(slotName, slotAssignment)
                                  }}
                                >
                                  <Paintbrush  />
                                  Conceal
                                </Button>
                              </div>
                            {/if}
                          </div>
                        {/each}
                      </div>
                      {/if}
                    {/if}
                </div>
              </div>

              {#if editorIsGuidedCustomVrm}
                <div class="batshit-goon-duf-import-row space-y-3">
                  <div class="flex flex-wrap items-center justify-between gap-3">
                    <div class="flex items-center gap-1.5">
                      <div class="batshit-settings-form-label">Add DUF Clothes</div>
                      <SettingsInfoMenu ariaLabel="About Add DUF Clothes" contentClass="w-80">
                        <p>
                          Import a DUF-exported VRM as clothes only for this Goon. New pieces appear in the Wardrobe slot dropdowns.
                        </p>
                      </SettingsInfoMenu>
                    </div>
                    <input
                      class="hidden"
                      type="file"
                      accept=".vrm"
                      bind:this={guidedDufClothesInput}
                      onchange={handleGuidedDufClothesSelection}
                    />
                    <Button onclick={() => guidedDufClothesInput?.click()} disabled={guidedDufClothesBusy}>
                      {guidedDufClothesBusy ? 'Importing…' : 'Add DUF Clothes'}
                    </Button>
                  </div>
                  {#if editorGuidedDufOverlays.length > 0}
                    <div class="space-y-2">
                      {#each editorGuidedDufOverlays as overlay}
                        <div class="flex items-center justify-between gap-3 batshit-settings-muted-panel">
                          <div class="min-w-0">
                            <div class="batshit-settings-form-label truncate">{overlay.label}</div>
                            <div class="batshit-settings-form-label">
                              Imported pieces:
                              <span class="text-foreground">{overlay.pieceIds?.length ?? 0}</span>
                            </div>
                          </div>
                          <Button variant="ghost" size="sm" onclick={() => removeGuidedDufOverlay(overlay.id)}>
                            <Trash2 aria-hidden="true" />

                            Remove
                          </Button>
                        </div>
                      {/each}
                    </div>
                  {/if}
                </div>
              {/if}
            </Collapsible.Content>
          </Collapsible.Root>

          <Collapsible.Root bind:open={moodsOpen} class={goonLevel1AccordionClass}>
            <Collapsible.Trigger
              class={goonLevel1AccordionHeaderClass}
              onclick={() => toggleEditorCueSection('moods')}
            >
              <div class="flex items-center gap-2">
                <BatshitIcon id="moods" class="batshit-goon-l1-icon h-4 w-4" />
                <span class="batshit-settings-form-label">Moods</span>
                <Badge variant="secondary">{moodCues.length}</Badge>
                <div
                  onclick={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                  }}
                  aria-hidden="true"
                >
                  <SettingsInfoMenu ariaLabel="About Moods" contentClass="w-80">
                    <p>
                      Global Moods from Goon Kitchen show up here automatically. Disable any this
                      Goon should not use, change any that need a Goon-specific tweak, or add
                      Custom ones just for this Goon.
                    </p>
                  </SettingsInfoMenu>
                </div>
              </div>
              <ChevronDown
                class={`h-4 w-4 shrink-0 transition-transform ${moodsOpen ? 'rotate-180' : ''}`}
              />
            </Collapsible.Trigger>
            <Collapsible.Content class={`${goonLevel1AccordionContentClass} space-y-3`}>
                      {#if editorAddMoodOpen}
                        <div class="grid gap-2 sm:grid-cols-[1fr_auto] items-start">
                          <div class="grid grid-cols-12 gap-2 items-center">
                            <div class="col-span-9">
                              <Input placeholder="New mood name" bind:value={newMoodName} />
                            </div>
                            <div class="col-span-3 flex justify-end">
                              <Button
                                variant="outline"
                                size="sm"
                                onclick={() => {
                                  const created = addCue('mood', newMoodName)
                                  if (!created) return
                                  newMoodName = ''
                                  editorAddMoodOpen = false
                                }}
                              >
                                <Plus aria-hidden="true" />

                                Add Mood
                              </Button>
                            </div>
                          </div>
                          <div class="flex justify-end">
                            <Button
                              variant="ghost"
                              size="icon"

                              aria-label="Cancel add mood"
                              onclick={() => {
                                editorAddMoodOpen = false
                                newMoodName = ''
                              }}
                            >
                              <X  />
                            </Button>
                          </div>
                        </div>
                      {:else}
                        <div class="flex justify-end">
                          <Button variant="outline" size="sm" onclick={() => (editorAddMoodOpen = true)}>
                            <Plus aria-hidden="true" />

                            Add Mood
                          </Button>
                        </div>
                      {/if}
                      {#if moodCues.length === 0}
                        <p class="batshit-settings-form-label">
                          No moods yet. Add one to define base loops.
                        </p>
                      {/if}
                      {#if moodCues.length > 0}
                        <div class={goonLevel2AccordionListClass}>
                      {#each moodCues as cue (cue.name)}
                        {@const cueStatus = getEditorCueStatus(cue.name)}
                        <Collapsible.Root
                          open={openMoodName === cue.name}
                          class={goonLevel2AccordionClass}
                        >
                          <div
                            role="button"
                            tabindex="0"
                            class={goonLevel2AccordionHeaderClass}
                            aria-expanded={openMoodName === cue.name}
                            onclick={() => toggleMotionItem('mood', cue.name)}
                            onkeydown={(event) => handleMotionItemHeaderKeydown(event, 'mood', cue.name)}
                          >
                            <span class="batshit-settings-form-label flex items-center gap-2">
                              <BatshitIcon id="moods" class="h-3.5 w-3.5 text-muted-foreground" />
                              <span>{cue.name}</span>
                              <Badge
                                variant={cueStatus === 'shared' ? 'outline' : cueStatus === 'changed' ? 'secondary' : 'default'}
                                class="batshit-settings-child-label"
                              >
                                {getEditorCueStatusLabel(cue.name)}
                              </Badge>
                            </span>
                            <div class="flex items-center gap-1">
                              <Button
                                variant="ghost"
                                size="xs"

                                aria-label="Preview Mood"
                                title="Preview Mood"
                                onclick={(event) => handleQuickCuePreview(event, cue.name)}
                              >
                                <Play  />
                              </Button>
                              <ChevronDown
                                class={`h-4 w-4 transition-transform ${openMoodName === cue.name ? 'rotate-180' : ''}`}
                              />
                            </div>
                          </div>
                          <Collapsible.Content class={goonLevel2CueContentClass}>
                              <div class="flex flex-wrap items-center gap-2">
                                <div class="min-w-[180px] flex-1 space-y-1">
                                  <GoonsFieldLabel label="Name" info={CUE_NAME_INFO} ariaLabel="About Mood Name" />
                                  <Input
                                    class="batshit-settings-grid-control"
                                    placeholder="Mood name"
                                    value={getCueNameDraft(cue.name)}
                                    oninput={(event) =>
                                      setCueNameDraft(cue.name, (event.currentTarget as HTMLInputElement).value)}
                                    onkeydown={(event) => {
                                      if (event.key === 'Enter') {
                                        event.preventDefault()
                                        commitCueRename(cue.name)
                                        ;(event.currentTarget as HTMLInputElement).blur()
                                      }
                                      if (event.key === 'Escape') {
                                        event.preventDefault()
                                        clearCueNameDraft(cue.name)
                                        ;(event.currentTarget as HTMLInputElement).blur()
                                      }
                                    }}
                                    onblur={() => commitCueRename(cue.name)}
                                  />
                                </div>
                              </div>
                              <div class="space-y-1">
                                <GoonsFieldLabel
                                  label="Description"
                                  info={CUE_DESCRIPTION_INFO}
                                  ariaLabel="About Mood Description"
                                />
                                <Input
                                  placeholder="Description (optional)"
                                  value={cue.description ?? ''}
                                  oninput={(event) => {
                                    const value = (event.currentTarget as HTMLInputElement).value
                                    updateCueField(cue.name, { description: value })
                                  }}
                                />
                              </div>
                              <div class="grid grid-cols-12 gap-2 items-center">
                                <GoonsFieldLabel
                                  label="Posture"
                                  info={CUE_POSTURE_INFO}
                                  ariaLabel="About Mood Posture"
                                  class="col-span-4"
                                />
                                <div class="col-span-8">
                                  <Select.Root
                                    type="single"
                                    value={cue.posture ?? ''}
                                    onValueChange={(value: string) =>
                                      updateCueField(cue.name, { posture: value || undefined })
                                    }
                                  >
                                    <Select.Trigger class="w-full">
                                      {cue.posture
                                        ? getPostureLabel(cue.posture)
                                        : 'Use linked Motion or Base Posture'}
                                    </Select.Trigger>
                                    <Select.Content>
                                      <Select.Item value="">Use linked Motion or Base Posture</Select.Item>
                                      {#each stagePostureOptions as posture}
                                        <Select.Item value={posture.id}>{posture.name}</Select.Item>
                                      {/each}
                                    </Select.Content>
                                  </Select.Root>
                                </div>
                              </div>
                              <div class="grid grid-cols-12 gap-2 items-center">
                                <GoonsFieldLabel
                                  label="Loop Motion"
                                  info={CUE_LOOP_MOTION_INFO}
                                  ariaLabel="About Mood Loop Motion"
                                  class="col-span-4"
                                />
                                <div class="col-span-8">
                                  {#if availableAnimationNames.length > 0}
                                    <GoonMotionPicker
                                      options={editorMotionPickerOptions}
                                      value={
                                        cue.animationName && availableAnimationNames.includes(cue.animationName)
                                          ? cue.animationName
                                          : ''
                                      }
                                      ariaLabel="Select Mood Loop Motion"
                                      onChange={(value) =>
                                        updateCueField(cue.name, { animationName: value || undefined })
                                      }
                                    />
                                  {:else}
                                    <div class="batshit-settings-form-label">
                                      Upload a motion to select one.
                                    </div>
                                  {/if}
                                </div>
                              </div>
                              <div class="space-y-2">
                                <UniversalFaceControlsEditor
                                  presetOptions={currentSemanticExpressionControls()}
                                  getPresetValue={(preset) => getCueExpressionPresetValue(cue.name, preset)}
                                  onPresetChange={(preset, value) =>
                                    updateCueExpressionPreset(cue.name, preset, value)}
                                  model={currentUniversalFaceControlModel()}
                                  getControlValue={(control) => getUniversalFaceControlValue(cue.name, control)}
                                  onControlChange={(control, value) =>
                                    updateUniversalFaceControl(cue.name, control, value)}
                                  onReset={() => resetUniversalFaceControls(cue.name)}
                                  isGroupLocked={isFaceControlGroupLocked}
                                  onToggleGroupLock={setFaceControlGroupLocked}
                                />
                                {#if currentHasUnmanagedRawMorphTargets()}
                                  <GoonsRawMorphEditor
                                    title="Advanced Raw Morphs"
                                    description="Only model targets that are not already represented by the universal face controls appear here."
                                    morphs={getUnmanagedRawMorphs(cue.rawMorphTargets)}
                                    targetNames={currentUnmanagedRawMorphTargetNames()}
                                    getValue={(targetName) => getRawMorphTargetValue(cue.name, targetName)}
                                    onRename={(currentTarget, nextTarget) =>
                                      renameRawMorphTarget(cue.name, currentTarget, nextTarget)}
                                    onChange={(targetName, value) =>
                                      updateRawMorphTarget(cue.name, targetName, value)}
                                    onRemove={(targetName) => removeRawMorphTarget(cue.name, targetName)}
                                    onAdd={() => addRawMorphTarget(cue.name)}
                                  />
                                {/if}
                              </div>
                              <div class="flex justify-end">
                                <div class="batshit-goon-action-cluster">
                                  <Button
                                    variant="ghost"
                                    size="sm"

                                    aria-label="Duplicate Mood"
                                    title="Duplicate Mood"
                                    onclick={() => duplicateMotion(cue.name)}
                                  >
                                    <Copy  />
                                  </Button>
                                  {#if cueStatus === 'changed'}
                                    <Button
                                      variant="ghost"
                                      size="sm"

                                      onclick={() => resetEditorCueToShared(cue.name)}
                                    >
                                      <RotateCcw aria-hidden="true" />
                                      Reset to Global
                                    </Button>
                                  {/if}
                                  {#if cueStatus !== 'custom'}
                                    <Button
                                      variant="ghost"
                                      size="sm"

                                      onclick={() => setEditorCueEnabled(cue.name, false)}
                                    >
                                      <X  />
                                      Disable
                                    </Button>
                                  {/if}
                                  {#if cueStatus === 'custom'}
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      class="is-danger"
                                      aria-label="Delete Mood"
                                      title="Delete Mood"
                                      onclick={() => removeMotion(cue.name)}
                                    >
                                      <Trash2  />
                                    </Button>
                                  {/if}
                                </div>
                              </div>
                          </Collapsible.Content>
                        </Collapsible.Root>
                      {/each}
                        </div>
                      {/if}
                      {#if disabledMoodCues.length > 0}
                        <Collapsible.Root bind:open={disabledMoodsOpen}>
                          <Collapsible.Trigger
                            class={goonDashedAccordionTriggerClass}
                            onclick={() => {
                              const next = !disabledMoodsOpen
                              disabledMoodsOpen = next
                              if (next) {
                                openMoodName = null
                              }
                            }}
                          >
                            <span class="batshit-settings-form-label flex items-center gap-2">
                              <BatshitIcon id="moods" class="h-3.5 w-3.5 text-muted-foreground" />
                              <span>View Disabled Moods</span>
                            </span>
                            <Badge variant="outline">{disabledMoodCues.length}</Badge>
                          </Collapsible.Trigger>
                          <Collapsible.Content class="pt-3 space-y-2">
                            {#each disabledMoodCues as cue (cue.name)}
                              {@const cueStatus = getEditorCueStatus(cue.name)}
                              <div class="flex items-start justify-between gap-3 rounded-md border p-3">
                                <div class="min-w-0">
                                  <div class="batshit-settings-form-label flex items-center gap-2">
                                    <BatshitIcon id="moods" class="h-3.5 w-3.5 text-muted-foreground" />
                                    <span>{cue.name}</span>
                                    <Badge
                                      variant={cueStatus === 'shared' ? 'outline' : cueStatus === 'changed' ? 'secondary' : 'default'}
                                      class="batshit-settings-child-label"
                                    >
                                      {getEditorCueStatusLabel(cue.name)}
                                    </Badge>
                                  </div>
                                  <div class="batshit-settings-form-label">
                                    {cue.description || (cueStatus === 'custom' ? 'Custom mood' : 'Global mood')}
                                  </div>
                                </div>
                                <div class="flex items-center gap-2">
                                  {#if cueStatus === 'changed'}
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      onclick={() => resetEditorCueToShared(cue.name)}
                                    >
                                      <RotateCcw aria-hidden="true" />

                                      Reset to Global
                                    </Button>
                                  {/if}
                                  {#if cueStatus === 'custom'}
                                    <Button variant="ghost" size="sm" onclick={() => removeMotion(cue.name)}>
                                      <Trash2 aria-hidden="true" />

                                      Remove
                                    </Button>
                                  {/if}
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    onclick={() => setEditorCueEnabled(cue.name, true)}
                                  >
                                    <Plus aria-hidden="true" />

                                    Re-enable
                                  </Button>
                                </div>
                              </div>
                            {/each}
                          </Collapsible.Content>
                        </Collapsible.Root>
                      {/if}
                    </Collapsible.Content>
                  </Collapsible.Root>

          <Collapsible.Root bind:open={emotesOpen} class={goonLevel1AccordionClass}>
            <Collapsible.Trigger
              class={goonLevel1AccordionHeaderClass}
              onclick={() => toggleEditorCueSection('emotes')}
            >
              <div class="flex items-center gap-2">
                <BatshitIcon id="emotes" class="batshit-goon-l1-icon h-4 w-4" />
                <span class="batshit-settings-form-label">Emotes</span>
                <Badge variant="secondary">{emoteCues.length}</Badge>
                <div
                  onclick={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                  }}
                  aria-hidden="true"
                >
                  <SettingsInfoMenu ariaLabel="About Emotes" contentClass="w-80">
                    <p>
                      Global Emotes from Goon Kitchen show up here automatically. Disable any this
                      Goon should not use, change any that need a Goon-specific tweak, or add
                      Custom ones just for this Goon.
                    </p>
                  </SettingsInfoMenu>
                </div>
              </div>
              <ChevronDown
                class={`h-4 w-4 shrink-0 transition-transform ${emotesOpen ? 'rotate-180' : ''}`}
              />
            </Collapsible.Trigger>
            <Collapsible.Content class={`${goonLevel1AccordionContentClass} space-y-3`}>
                      {#if editorAddEmoteOpen}
                        <div class="grid gap-2 sm:grid-cols-[1fr_auto] items-start">
                          <div class="grid grid-cols-12 gap-2 items-center">
                            <div class="col-span-6">
                              <Input placeholder="New emote name" bind:value={newEmoteName} />
                            </div>
                            <div class="col-span-3">
                              <Input placeholder="Emoji(s)" bind:value={newEmoteEmoji} />
                            </div>
                            <div class="col-span-3 flex justify-end">
                              <Button
                                variant="outline"
                                size="sm"
                                onclick={() => {
                                  const created = addEmote()
                                  if (!created) return
                                  editorAddEmoteOpen = false
                                }}
                              >
                                <Plus aria-hidden="true" />

                                Add Emote
                              </Button>
                            </div>
                          </div>
                          <div class="flex justify-end">
                            <Button
                              variant="ghost"
                              size="icon"

                              aria-label="Cancel add emote"
                              onclick={() => {
                                editorAddEmoteOpen = false
                                newEmoteName = ''
                                newEmoteEmoji = ''
                              }}
                            >
                              <X  />
                            </Button>
                          </div>
                        </div>
                      {:else}
                        <div class="flex justify-end">
                          <Button variant="outline" size="sm" onclick={() => (editorAddEmoteOpen = true)}>
                            <Plus aria-hidden="true" />

                            Add Emote
                          </Button>
                        </div>
                      {/if}
                      {#if emoteCues.length === 0}
                        <p class="batshit-settings-form-label">
                          No emotes yet. Add one with an emoji to get started.
                        </p>
                      {/if}
                      {#if emoteCues.length > 0}
                        <div class={goonLevel2AccordionListClass}>
                      {#each emoteCues as cue (cue.name)}
                        {@const emoteEmoji = getEmoteEmoji(cue.name)}
                        {@const emoteEmojiLabel = formatEmoteEmojiLabel(emoteEmoji)}
                        {@const cueStatus = getEditorCueStatus(cue.name)}
                        <Collapsible.Root
                          open={openEmoteName === cue.name}
                          class={goonLevel2AccordionClass}
                        >
                          <div
                            role="button"
                            tabindex="0"
                            class={goonLevel2AccordionHeaderClass}
                            aria-expanded={openEmoteName === cue.name}
                            onclick={() => toggleMotionItem('emote', cue.name)}
                            onkeydown={(event) => handleMotionItemHeaderKeydown(event, 'emote', cue.name)}
                          >
                            <span class="batshit-settings-form-label flex items-center gap-2">
                              {#if emoteEmojiLabel}
                                <span class="batshit-settings-action-row-title leading-none">{emoteEmojiLabel}</span>
                              {/if}
                              {cue.name}
                              <Badge
                                variant={cueStatus === 'shared' ? 'outline' : cueStatus === 'changed' ? 'secondary' : 'default'}
                                class="batshit-settings-child-label"
                              >
                                {getEditorCueStatusLabel(cue.name)}
                              </Badge>
                            </span>
                            <div class="flex items-center gap-1">
                              <Button
                                variant="ghost"
                                size="xs"

                                aria-label="Preview Emote"
                                title="Preview Emote"
                                onclick={(event) => handleQuickCuePreview(event, cue.name)}
                              >
                                <Play  />
                              </Button>
                              <ChevronDown
                                class={`h-4 w-4 transition-transform ${openEmoteName === cue.name ? 'rotate-180' : ''}`}
                              />
                            </div>
                          </div>
                          <Collapsible.Content class={goonLevel2CueContentClass}>
                              <div class="flex flex-wrap items-center gap-2">
                                <div class="min-w-[180px] flex-1 space-y-1">
                                  <GoonsFieldLabel label="Name" info={CUE_NAME_INFO} ariaLabel="About Emote Name" />
                                  <Input
                                    class="batshit-settings-grid-control"
                                    placeholder="Emote name"
                                    value={getCueNameDraft(cue.name)}
                                    oninput={(event) =>
                                      setCueNameDraft(cue.name, (event.currentTarget as HTMLInputElement).value)}
                                    onkeydown={(event) => {
                                      if (event.key === 'Enter') {
                                        event.preventDefault()
                                        commitCueRename(cue.name)
                                        ;(event.currentTarget as HTMLInputElement).blur()
                                      }
                                      if (event.key === 'Escape') {
                                        event.preventDefault()
                                        clearCueNameDraft(cue.name)
                                        ;(event.currentTarget as HTMLInputElement).blur()
                                      }
                                    }}
                                    onblur={() => commitCueRename(cue.name)}
                                  />
                                </div>
                              </div>
                              <div class="space-y-1">
                                <GoonsFieldLabel
                                  label="Description"
                                  info={CUE_DESCRIPTION_INFO}
                                  ariaLabel="About Emote Description"
                                />
                                <Input
                                  placeholder="Description (optional)"
                                  value={cue.description ?? ''}
                                  oninput={(event) => {
                                    const value = (event.currentTarget as HTMLInputElement).value
                                    updateCueField(cue.name, { description: value })
                                  }}
                                />
                              </div>
                              <div class="grid grid-cols-12 gap-2 items-center">
                                <GoonsFieldLabel
                                  label="Emoji"
                                  info={CUE_EMOJI_INFO}
                                  ariaLabel="About Emote Emoji"
                                  class="col-span-4"
                                />
                                <div class="col-span-8">
                                  <Input
                                    placeholder="🙂 or 😏+🙄"
                                    value={emoteEmoji}
                                    oninput={(event) => {
                                      const value = (event.currentTarget as HTMLInputElement).value
                                      setEmoteEmoji(cue.name, value)
                                    }}
                                  />
                                </div>
                              </div>
                              <div class="batshit-goon-cue-subpanel space-y-2">
                                <div class="grid grid-cols-12 gap-2 items-end">
                                  <div class="col-span-6 space-y-1">
                                    <GoonsFieldLabel
                                      label="Pause Speech"
                                      info={CUE_PAUSE_SPEECH_INFO}
                                      ariaLabel="About Emote Pause Speech"
                                    />
                                    <div class="flex h-9 items-center">
                                      <Switch.Root
                                        checked={Boolean(cue.blocking)}
                                        onCheckedChange={(checked) =>
                                          updateCueField(cue.name, { blocking: Boolean(checked) })
                                        }
                                      />
                                    </div>
                                  </div>
                                  <div class="col-span-6 space-y-1">
                                    <GoonsFieldLabel
                                      label="Duration (ms)"
                                      info={CUE_DURATION_INFO}
                                      ariaLabel="About Emote Duration"
                                    />
                                    <Input
                                      type="number"
                                      min="0"
                                      step="50"
                                      value={cue.durationMs ?? ''}
                                      placeholder="800"
                                      oninput={(event) => {
                                        const value = (event.currentTarget as HTMLInputElement).value
                                        updateCueField(cue.name, {
                                          durationMs: value ? Number(value) : undefined
                                        })
                                      }}
                                    />
                                  </div>
                                </div>
                              </div>
                              <div class="space-y-2">
                                {#if !cue.steps || cue.steps.length === 0}
                                  <GoonsFieldLabel
                                    label="Facial Timing (ms)"
                                    info={CUE_FACIAL_TIMING_INFO}
                                    ariaLabel="About Emote Facial Timing"
                                    class="batshit-settings-child-label"
                                  />
                                  <div class="grid grid-cols-12 gap-2 items-end">
                                    <div class="col-span-4 space-y-1">
                                      <div class="batshit-settings-form-label">Fade-In</div>
                                      <Input type="number" min="0" step="10" value={cue.attackMs ?? ''} placeholder="120"
                                        oninput={(event) => {
                                          const value = (event.currentTarget as HTMLInputElement).value
                                          updateCueField(cue.name, { attackMs: value ? Number(value) : undefined })
                                        }} />
                                    </div>
                                    <div class="col-span-4 space-y-1">
                                      <div class="batshit-settings-form-label">Hold</div>
                                      <Input type="number" min="0" step="10" value={cue.holdMs ?? ''} placeholder="200"
                                        oninput={(event) => {
                                          const value = (event.currentTarget as HTMLInputElement).value
                                          updateCueField(cue.name, { holdMs: value ? Number(value) : undefined })
                                        }} />
                                    </div>
                                    <div class="col-span-4 space-y-1">
                                      <div class="batshit-settings-form-label">Fade-Out</div>
                                      <Input type="number" min="0" step="10" value={cue.releaseMs ?? ''} placeholder="180"
                                        oninput={(event) => {
                                          const value = (event.currentTarget as HTMLInputElement).value
                                          updateCueField(cue.name, { releaseMs: value ? Number(value) : undefined })
                                        }} />
                                    </div>
                                  </div>
                                {/if}
                                <UniversalFaceControlsEditor
                                  presetOptions={currentSemanticExpressionControls()}
                                  getPresetValue={(preset) => getCueExpressionPresetValue(cue.name, preset)}
                                  onPresetChange={(preset, value) =>
                                    updateCueExpressionPreset(cue.name, preset, value)}
                                  model={currentUniversalFaceControlModel()}
                                  getControlValue={(control) => getUniversalFaceControlValue(cue.name, control)}
                                  onControlChange={(control, value) =>
                                    updateUniversalFaceControl(cue.name, control, value)}
                                  onReset={() => resetUniversalFaceControls(cue.name)}
                                  isGroupLocked={isFaceControlGroupLocked}
                                  onToggleGroupLock={setFaceControlGroupLocked}
                                />
                                {#if currentHasUnmanagedRawMorphTargets()}
                                  <GoonsRawMorphEditor
                                    title="Advanced Raw Morphs"
                                    description="Only model targets that are not already represented by the universal face controls appear here."
                                    morphs={getUnmanagedRawMorphs(cue.rawMorphTargets)}
                                    targetNames={currentUnmanagedRawMorphTargetNames()}
                                    getValue={(targetName) => getRawMorphTargetValue(cue.name, targetName)}
                                    onRename={(currentTarget, nextTarget) =>
                                      renameRawMorphTarget(cue.name, currentTarget, nextTarget)}
                                    onChange={(targetName, value) =>
                                      updateRawMorphTarget(cue.name, targetName, value)}
                                    onRemove={(targetName) => removeRawMorphTarget(cue.name, targetName)}
                                    onAdd={() => addRawMorphTarget(cue.name)}
                                  />
                                {/if}
                                {#if cue.steps && cue.steps.length > 0}
                                  {#each cue.steps as step, stepIndex (stepIndex)}
                                    <div class="batshit-goon-cue-subpanel is-step space-y-2">
                                    <div class="flex items-center justify-between">
                                      <span class="batshit-settings-child-label">Step {stepIndex + 1}</span>
                                      <Button variant="ghost" size="sm" onclick={() => removeStep(cue.name, stepIndex)}>
                                        <X  />
                                      </Button>
                                    </div>
                                    <GoonsFieldLabel
                                      label="Facial Timing (ms)"
                                      info={CUE_FACIAL_TIMING_INFO}
                                      ariaLabel="About Emote Step Facial Timing"
                                      class="batshit-settings-child-label"
                                    />
                                    <div class="grid grid-cols-12 gap-2 items-end">
                                      <div class="col-span-4 space-y-1">
                                        <div class="batshit-settings-form-label">Fade-In</div>
                                        <Input type="number" min="0" step="10" value={step.attackMs ?? ''} placeholder="200"
                                          oninput={(event) => {
                                            const value = (event.currentTarget as HTMLInputElement).value
                                            updateStepField(cue.name, stepIndex, { attackMs: value ? Number(value) : undefined })
                                          }} />
                                      </div>
                                      <div class="col-span-4 space-y-1">
                                        <div class="batshit-settings-form-label">Hold</div>
                                        <Input type="number" min="0" step="10" value={step.holdMs ?? ''} placeholder="1000"
                                          oninput={(event) => {
                                            const value = (event.currentTarget as HTMLInputElement).value
                                            updateStepField(cue.name, stepIndex, { holdMs: value ? Number(value) : undefined })
                                          }} />
                                      </div>
                                      <div class="col-span-4 space-y-1">
                                        <div class="batshit-settings-form-label">Fade-Out</div>
                                        <Input type="number" min="0" step="10" value={step.releaseMs ?? ''} placeholder="500"
                                          oninput={(event) => {
                                            const value = (event.currentTarget as HTMLInputElement).value
                                            updateStepField(cue.name, stepIndex, { releaseMs: value ? Number(value) : undefined })
                                          }} />
                                      </div>
                                    </div>
                                      <UniversalFaceControlsEditor
                                        presetOptions={currentSemanticExpressionControls()}
                                        getPresetValue={(preset) =>
                                          getExpressionTargetWeight(
                                            resolveEditorFaceProfiles(step).portable.expressionTargets,
                                            preset
                                          )}
                                        onPresetChange={(preset, value) =>
                                          updateStepExpressionPreset(cue.name, stepIndex, preset, value)}
                                        model={currentUniversalFaceControlModel()}
                                        getControlValue={(control) =>
                                          getStepUniversalFaceControlValue(cue.name, stepIndex, control)}
                                        onControlChange={(control, value) =>
                                          updateStepUniversalFaceControl(cue.name, stepIndex, control, value)}
                                        onReset={() => resetStepUniversalFaceControls(cue.name, stepIndex)}
                                        isGroupLocked={isFaceControlGroupLocked}
                                        onToggleGroupLock={setFaceControlGroupLocked}
                                      />
                                    {#if currentHasUnmanagedRawMorphTargets()}
                                      <GoonsRawMorphEditor
                                        title="Advanced Raw Morphs"
                                        description="Only model targets that are not already represented by the universal face controls appear here."
                                        morphs={getUnmanagedRawMorphs(step.rawMorphTargets)}
                                        targetNames={currentUnmanagedRawMorphTargetNames()}
                                        getValue={(targetName) =>
                                          getStepRawMorphTargetValue(cue.name, stepIndex, targetName)}
                                        onRename={(currentTarget, nextTarget) =>
                                          renameStepRawMorphTarget(cue.name, stepIndex, currentTarget, nextTarget)}
                                        onChange={(targetName, value) =>
                                          updateStepRawMorphTarget(cue.name, stepIndex, targetName, value)}
                                        onRemove={(targetName) =>
                                          removeStepRawMorphTarget(cue.name, stepIndex, targetName)}
                                        onAdd={() => addStepRawMorphTarget(cue.name, stepIndex)}
                                      />
                                    {/if}
                                  </div>
                                {/each}
                              {/if}
                            </div>
                              <div class="flex items-end justify-between gap-3">
                                <div>
                                  <Button variant="outline" size="sm" onclick={() => addStep(cue.name)}>
                                    <Plus aria-hidden="true" />

                                    Add Step
                                  </Button>
                                </div>
                                <div class="batshit-goon-action-cluster">
                                  <Button
                                    variant="ghost"
                                    size="sm"

                                    aria-label="Duplicate Emote"
                                    title="Duplicate Emote"
                                    onclick={() => duplicateMotion(cue.name)}
                                  >
                                    <Copy  />
                                  </Button>
                                  {#if cueStatus === 'changed'}
                                    <Button
                                      variant="ghost"
                                      size="sm"

                                      onclick={() => resetEditorCueToShared(cue.name)}
                                    >
                                      <RotateCcw aria-hidden="true" />
                                      Reset to Global
                                    </Button>
                                  {/if}
                                  {#if cueStatus !== 'custom'}
                                    <Button
                                      variant="ghost"
                                      size="sm"

                                      onclick={() => setEditorCueEnabled(cue.name, false)}
                                    >
                                      <X  />
                                      Disable
                                    </Button>
                                  {/if}
                                  {#if cueStatus === 'custom'}
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      class="is-danger"
                                      aria-label="Delete Emote"
                                      title="Delete Emote"
                                      onclick={() => removeMotion(cue.name)}
                                    >
                                      <Trash2  />
                                    </Button>
                                  {/if}
                                </div>
                              </div>
                          </Collapsible.Content>
                        </Collapsible.Root>
                      {/each}
                        </div>
                      {/if}
                      {#if disabledEmoteCues.length > 0}
                        <Collapsible.Root bind:open={disabledEmotesOpen}>
                          <Collapsible.Trigger
                            class={goonDashedAccordionTriggerClass}
                            onclick={() => {
                              const next = !disabledEmotesOpen
                              disabledEmotesOpen = next
                              if (next) {
                                openEmoteName = null
                              }
                            }}
                          >
                            <span class="batshit-settings-form-label flex items-center gap-2">
                              <BatshitIcon id="emotes" class="h-3.5 w-3.5 text-muted-foreground" />
                              <span>View Disabled Emotes</span>
                            </span>
                            <Badge variant="outline">{disabledEmoteCues.length}</Badge>
                          </Collapsible.Trigger>
                          <Collapsible.Content class="pt-3 space-y-2">
                            {#each disabledEmoteCues as cue (cue.name)}
                              {@const emoteEmoji = getEmoteEmoji(cue.name)}
                              {@const emoteEmojiLabel = formatEmoteEmojiLabel(emoteEmoji)}
                              {@const cueStatus = getEditorCueStatus(cue.name)}
                              <div class="flex items-start justify-between gap-3 rounded-md border p-3">
                                <div class="min-w-0">
                                  <div class="batshit-settings-form-label flex items-center gap-2">
                                    {#if emoteEmojiLabel}
                                      <span class="batshit-settings-action-row-title leading-none">{emoteEmojiLabel}</span>
                                    {/if}
                                    <span>{cue.name}</span>
                                    <Badge
                                      variant={cueStatus === 'shared' ? 'outline' : cueStatus === 'changed' ? 'secondary' : 'default'}
                                      class="batshit-settings-child-label"
                                    >
                                      {getEditorCueStatusLabel(cue.name)}
                                    </Badge>
                                  </div>
                                  <div class="batshit-settings-form-label">
                                    {cue.description ||
                                      (cueStatus === 'custom' ? 'Custom emote' : 'Global emote')}
                                  </div>
                                </div>
                                <div class="flex items-center gap-2">
                                  {#if cueStatus === 'changed'}
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      onclick={() => resetEditorCueToShared(cue.name)}
                                    >
                                      <RotateCcw aria-hidden="true" />

                                      Reset to Global
                                    </Button>
                                  {/if}
                                  {#if cueStatus === 'custom'}
                                    <Button variant="ghost" size="sm" onclick={() => removeMotion(cue.name)}>
                                      <Trash2 aria-hidden="true" />

                                      Remove
                                    </Button>
                                  {/if}
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    onclick={() => setEditorCueEnabled(cue.name, true)}
                                  >
                                    <Plus aria-hidden="true" />

                                    Re-enable
                                  </Button>
                                </div>
                              </div>
                            {/each}
                          </Collapsible.Content>
                        </Collapsible.Root>
	                      {/if}
	                    </Collapsible.Content>
	                  </Collapsible.Root>

	          <Collapsible.Root bind:open={editorAnimationsSectionOpen} class={goonLevel1AccordionClass}>
	            <Collapsible.Trigger
	              class={goonLevel1AccordionHeaderClass}
	              onclick={() => toggleEditorPrimarySection('animations')}
	            >
	              <div class="flex items-center gap-1.5">
	                <BatshitIcon id="motions" class="batshit-goon-l1-icon h-4 w-4" />
	                <span class="batshit-settings-form-label">Custom Animations</span>
	                <div
	                  onclick={(event) => {
	                    event.preventDefault()
	                    event.stopPropagation()
	                  }}
	                  aria-hidden="true"
	                >
	                  <SettingsInfoMenu ariaLabel="About Custom Animations" contentClass="w-96">
	                    {#each EDITOR_GOON_ANIMATIONS_INFO as line}
	                      <p>{line}</p>
	                    {/each}
	                  </SettingsInfoMenu>
	                </div>
	              </div>
	              <ChevronDown
	                class={`h-4 w-4 shrink-0 transition-transform ${editorAnimationsSectionOpen ? 'rotate-180' : ''}`}
	              />
	            </Collapsible.Trigger>
	            <Collapsible.Content class={goonLevel1AccordionContentClass}>
	              <div class="batshit-goon-editor-subpanel space-y-2">
	                <input
	                  class="hidden"
	                  type="file"
	                  accept=".glb,.gltf,.vrma"
	                  bind:this={animationUploadInput}
	                  onchange={handleAnimationSelection}
	                />
	                <div class="flex items-center gap-2">
	                  <Button onclick={() => animationUploadInput?.click()} disabled={animationUploadBusy}>
	                    {animationUploadBusy ? 'Uploading…' : 'Upload Animation'}
	                  </Button>
	                </div>
	                {#if editorAnimationFiles.length === 0}
	                  <p class="batshit-settings-form-label">No animation files uploaded yet.</p>
	                {:else}
	                  <div class="max-h-32 overflow-y-auto space-y-1 pr-1">
	                    {#each editorAnimationFiles as animationFile}
	                      <div class="flex items-center justify-between text-xs">
	                        <span class="truncate">
	                          {resolveFileLabel(animationFile)}
	                        </span>
	                        <Button
	                          variant="outline"
	                          size="sm"
	                          onclick={() => handleAnimationDelete(animationFile.filename)}
	                        >
	                          <Trash2 aria-hidden="true" />

	                          Remove
	                        </Button>
	                      </div>
	                    {/each}
	                  </div>
	                {/if}
	              </div>
	            </Collapsible.Content>
	          </Collapsible.Root>

	          <Collapsible.Root bind:open={editorVrmSectionOpen} class={goonLevel1AccordionClass}>
	            <Collapsible.Trigger
	              class={goonLevel1AccordionHeaderClass}
	              onclick={() => toggleEditorPrimarySection('vrm')}
	            >
	              <div class="flex items-center gap-1.5">
	                <BatshitIcon id="goons" class="batshit-goon-l1-icon h-4 w-4" />
	                <span class="batshit-settings-form-label">{resolveEditorFileSectionLabel()}</span>
	                <div
	                  onclick={(event) => {
	                    event.preventDefault()
	                    event.stopPropagation()
	                  }}
	                  aria-hidden="true"
	                >
	                  <SettingsInfoMenu
	                    ariaLabel={
                        editorSourceProfile === 'guided-custom-vrm'
                          ? 'About Goon File Package'
                          : editorGoonKind === 'custom'
                            ? 'About Goon File Package'
                            : 'About VRM File'
                      }
	                    contentClass="w-96"
	                  >
	                    {#each resolveEditorFileSectionInfo() as line}
	                      <p>{line}</p>
	                    {/each}
	                  </SettingsInfoMenu>
	                </div>
	              </div>
	              <ChevronDown
	                class={`h-4 w-4 shrink-0 transition-transform ${editorVrmSectionOpen ? 'rotate-180' : ''}`}
	              />
	            </Collapsible.Trigger>
	            <Collapsible.Content forceMount class={goonLevel1AccordionContentClass}>
	              <div class="batshit-goon-editor-subpanel space-y-2">
	                {#if editorSourceProfile === 'guided-custom-vrm'}
	                  <div class="batshit-settings-form-label">
	                    Package: <span class="text-foreground">{currentGuidedPackageLabel}</span>
	                  </div>
	                  <div class="batshit-settings-form-label">
	                    Current VRM: <span class="text-foreground">{currentVrmLabel}</span>
	                  </div>
	                  <div class="batshit-settings-form-label">
	                    Manifest: <span class="text-foreground">{currentGuidedManifestLabel}</span>
	                  </div>
	                  <div class="batshit-settings-form-label">
	                    Contract version:
	                    <span class="text-foreground">
	                      {editorGoon?.guidedAvatar?.manifestSummary?.contractVersion ?? 1}
	                    </span>
	                  </div>
	                  {#if editorGoon?.guidedAvatar?.manifestSummary?.name}
	                    <div class="batshit-settings-form-label">
	                      Manifest name:
	                      <span class="text-foreground">{editorGoon.guidedAvatar.manifestSummary.name}</span>
	                    </div>
	                  {/if}
	                  <div class="batshit-settings-form-label">
	                    Original outfit pieces:
	                    <span class="text-foreground">{editorGuidedOutfitPieces.length}</span>
	                  </div>
	                  <div class="batshit-settings-form-label">
	                    Outfit presets:
	                    <span class="text-foreground">{editorGuidedOutfitPresets.length}</span>
	                  </div>
	                  <div class="batshit-settings-form-label">
	                    DUF clothes overlays:
	                    <span class="text-foreground">{editorGuidedDufOverlayCount}</span>
	                  </div>
	                  <p class="batshit-settings-form-label">
	                    Advanced/Blender Goons keep the extracted VRM for runtime, but Batshit preserves the
	                    package manifest so the Blender metadata stays attached to this Goon.
	                  </p>
	                  {#if editorPendingAdvancedPackageUpdate}
	                    <div class="batshit-settings-form-label">
	                      Pending package update:
	                      <span class="text-foreground">{pendingAdvancedPackageLabel}</span>
	                    </div>
	                  {/if}
	                  {#if editorGoon?.guidedAvatar?.backup?.package}
	                    <div class="batshit-settings-form-label">
	                      Previous package:
	                      <span class="text-foreground">{backupGuidedPackageLabel}</span>
	                    </div>
	                  {/if}
	                  <input
	                    class="hidden"
	                    type="file"
	                    accept=".bgoon,.zip"
	                    bind:this={advancedPackageUpdateInput}
	                    onchange={handleAdvancedPackageUpdateSelection}
	                  />
	                  <div class="flex flex-wrap items-center gap-2">
	                    <Button
	                      onclick={() => advancedPackageUpdateInput?.click()}
	                      disabled={advancedPackageUpdateBusy || Boolean(editorPendingAdvancedPackageUpdate)}
	                    >
	                      {advancedPackageUpdateBusy ? 'Uploading…' : 'Update Goon File Package'}
	                    </Button>
	                    {#if editorPendingAdvancedPackageUpdate}
	                      <Button variant="ghost" size="sm" onclick={cancelPendingAdvancedPackageUpdate}>
	                        <X aria-hidden="true" />
	                        Cancel
	                      </Button>
	                    {/if}
	                  </div>
	                  <p class="batshit-settings-form-label">
	                    Save Goon applies the package update. It keeps saved moods, emotes, Eye Contact, camera,
	                    Wardrobe items, Outfits, and DUF clothes where possible, and clears painted conceal masks.
	                  </p>
	                {:else if editorGoonKind === 'custom'}
	                  {#if editorRecipeSourceError}
	                    <div class="batshit-settings-muted-panel space-y-3" role="alert">
	                      <div class="flex items-start gap-2">
	                        <CircleAlert class="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden="true" />
	                        <div class="min-w-0">
	                          <div class="batshit-settings-form-label is-danger">
	                            {editorRetiredHairSibling ? 'This Goon needs a Hair reset' : 'This Goon needs to be recreated'}
	                          </div>
	                          <p class="batshit-settings-caption mt-1 break-words">
	                            {editorRecipeRecoveryMessage}
	                          </p>
	                        </div>
	                      </div>
	                      {#if editorRetiredHairSibling}
	                        <div class="batshit-settings-action-row">
	                          <Button
	                            variant="outline"
	                            type="button"
	                            onclick={resetEditorRetiredHair}
	                            disabled={retiredHairRecoveryBusy}
	                          >
	                            <RotateCcw aria-hidden="true" />
	                            {retiredHairRecoveryBusy ? 'Resetting Hair…' : 'Reset retired Hair'}
	                          </Button>
	                        </div>
	                      {/if}
	                      <details>
	                        <summary class="batshit-settings-child-label cursor-pointer">
	                          Technical Details
	                        </summary>
	                        <p class="batshit-settings-caption mt-2 break-words">
	                          {editorRecipeSourceError}
	                        </p>
	                      </details>
	                    </div>
	                  {:else if editorGoon && (isRecipePreparationRequired(editorGoon) || editorGoon.recipe?.contract === 'goon-recipe/v2')}
	                    <div class="batshit-settings-form-label">
	                      Appearance changes are applied when you click Save Goon.
	                    </div>
	                    <div class="border-t border-border/50 pt-3">
	                      <RecipeWorkflowController
	                        bind:this={recipeWorkflowController}
	                        goon={editorGoon}
	                        appearanceDials={editorAppearanceDialsState}
	                        facialArtwork={editorFacialArtworkState}
	                        eyeAppearance={editorEyeAppearanceState}
	                        oralAppearance={editorOralAppearanceState}
	                        lipArtwork={editorLipArtworkState}
	                        lipArtworkPresence={editorLipArtworkPresence}
	                        nailSurface={editorNailSurfaceState}
	                        nailSurfacePresence={editorNailSurfacePresence}
	                        skinAppearance={editorSkinAppearanceState}
	                        hairState={editorHairState}
	                        fileTechnicalDetails={{
	                          packageLabel: currentCustomPackageLabel,
	                          modelLabel: currentCustomModelLabel,
	                          manifestLabel: currentCustomManifestLabel,
	                          contractVersion: editorRecipeSourceGoon?.customAvatar?.manifestSummary?.contractVersion ?? 1,
	                          manifestName: editorRecipeSourceGoon?.customAvatar?.manifestSummary?.name ?? null
	                        }}
	                        onSaveEditorDraft={() =>
	                          saveCueEditor({ successMessage: null, skipRecipeWorkflow: true })}
	                        onDiscardEditorDraft={discardCueEditorChanges}
	                        onDraftPreviewStateChange={handleRecipeEditorDraftPreviewStateChange}
	                        onPreviewTargetChange={handleRecipeEditorPreviewTargetChange}
	                        onPreviewLiveCandidate={previewStagedRecipeLiveCandidate}
	                        autoPrepare={isRecipePreparationRequired(editorGoon)}
	                        onWorkflowBusyChange={(busy) => { recipeWorkflowBusy = busy }}
	                      />
	                    </div>
	                  {:else}
	                    <details class="batshit-settings-muted-panel">
	                      <summary class="batshit-settings-child-label cursor-pointer">Technical Details</summary>
	                      <div class="mt-3 space-y-2">
	                        <div class="batshit-settings-form-label">
	                          Package: <span class="text-foreground">{currentCustomPackageLabel}</span>
	                        </div>
	                        <div class="batshit-settings-form-label">
	                          Model: <span class="text-foreground">{currentCustomModelLabel}</span>
	                        </div>
	                        <div class="batshit-settings-form-label">
	                          Manifest: <span class="text-foreground">{currentCustomManifestLabel}</span>
	                        </div>
	                        <div class="batshit-settings-form-label">
	                          Contract version:
	                          <span class="text-foreground">
	                            {editorGoon?.customAvatar?.manifestSummary?.contractVersion ?? 1}
	                          </span>
	                        </div>
	                        {#if editorGoon?.customAvatar?.manifestSummary?.name}
	                          <div class="batshit-settings-form-label">
	                            Manifest name:
	                            <span class="text-foreground">{editorGoon.customAvatar.manifestSummary.name}</span>
	                          </div>
	                        {/if}
	                      </div>
	                    </details>
	                  {/if}
	                {:else}
	                  <div class="batshit-settings-form-label">
	                    Current VRM: <span class="text-foreground">{currentVrmLabel}</span>
	                  </div>
	                  {#if activePendingVrmFile}
	                    <div class="batshit-settings-form-label">
	                      Pending update: <span class="text-foreground">{pendingVrmLabel}</span>
	                    </div>
	                  {/if}
	                  {#if editorGoon?.files?.vrmBackup}
	                    <div class="batshit-settings-form-label">
	                      Previous: <span class="text-foreground">{backupVrmLabel}</span>
	                    </div>
	                  {/if}
	                  <input
	                    class="hidden"
	                    type="file"
	                    accept=".vrm"
	                    bind:this={updateVrmInput}
	                    onchange={handleUpdateVrmSelection}
	                  />
	                  <div class="flex flex-wrap items-center gap-2">
	                    <Button
	                      onclick={() => updateVrmInput?.click()}
	                      disabled={updateVrmBusy || !editorGoon?.files?.vrm?.url || Boolean(activePendingVrmFile)}
	                    >
	                      {updateVrmBusy ? 'Updating…' : 'Update Goon File'}
	                    </Button>
	                    {#if editorPendingVrmFile}
	                      <Button variant="ghost" size="sm" onclick={cancelPendingVrmUpdate}>
	                        <X aria-hidden="true" />
	                        Cancel
	                      </Button>
	                    {:else if editorGoon?.files?.vrmPending || editorGoon?.files?.vrmBackup}
	                      <Button variant="ghost" size="sm" onclick={handleRestoreVrm}>
	                        {editorGoon?.files?.vrmPending ? 'Cancel' : 'Restore Previous File'}
	                      </Button>
	                    {/if}
	                  </div>
	                  {#if activeVrmUpdateReport}
	                    <div class="batshit-settings-inline-alert is-warning space-y-1">
	                      <div class="batshit-settings-form-label is-warning">VRM Update Notes</div>
	                      {#if activeVrmUpdateReport.missingMaterials?.length}
	                        <div>
	                          Missing materials:
	                          <span class="text-foreground">
	                            {formatWarningItems(activeVrmUpdateReport.missingMaterials)}
	                          </span>
	                        </div>
	                      {/if}
	                      {#if activeVrmUpdateReport.missingExpressions?.length}
	                        <div>
	                          Missing expressions:
	                          <span class="text-foreground">
	                            {formatWarningItems(activeVrmUpdateReport.missingExpressions)}
	                          </span>
	                        </div>
	                      {/if}
	                      {#if activeVrmUpdateReport.disabledCues?.length}
	                        <div>
	                          Disabled cues:
	                          <span class="text-foreground">
	                            {formatWarningItems(activeVrmUpdateReport.disabledCues)}
	                          </span>
	                        </div>
	                      {/if}
	                      {#if activeVrmUpdateReport.missingBones?.length}
	                        <div>
	                          Missing bones:
	                          <span class="text-foreground">
	                            {formatWarningItems(activeVrmUpdateReport.missingBones)}
	                          </span>
	                        </div>
	                      {/if}
	                      <div class="flex items-center justify-between pt-1">
	                        {#if activeVrmUpdateReport.updated_at}
	                          <span class="batshit-settings-child-label">
	                            Updated {new Date(activeVrmUpdateReport.updated_at).toLocaleString()}
	                          </span>
	                        {:else}
	                          <span class="batshit-settings-child-label">Update recorded</span>
	                        {/if}
	                        <Button variant="ghost" size="sm" onclick={clearVrmUpdateWarnings}>
	                          <X aria-hidden="true" />

	                          Clear warnings
	                        </Button>
	                      </div>
	                    </div>
	                  {/if}
	                {/if}
	              </div>
	            </Collapsible.Content>
	          </Collapsible.Root>

          <Collapsible.Root bind:open={editorDeleteGoonOpen}>
            <div>
              <Collapsible.Trigger
                class="batshit-settings-delete-trigger"
                onclick={() => toggleEditorPrimarySection('delete')}
              >
                <div class="batshit-settings-delete-trigger-label">
                  <Trash2 class="batshit-settings-delete-trigger-icon" />
                  <span>Delete Goon</span>
                  <div
                    onclick={(event) => {
                      event.preventDefault()
                      event.stopPropagation()
                    }}
                    aria-hidden="true"
                  >
                    <SettingsInfoMenu ariaLabel="About Delete Goon" contentClass="w-80">
                      {#each EDITOR_DELETE_GOON_INFO as line}
                        <p>{line}</p>
                      {/each}
                    </SettingsInfoMenu>
                  </div>
                </div>
                <ChevronDown
                  class={`batshit-settings-delete-chevron ${editorDeleteGoonOpen ? 'is-open' : ''}`}
                />
              </Collapsible.Trigger>
              <Collapsible.Content class="batshit-settings-delete-content">
                <div class="batshit-settings-delete-content-inner">
                  <div class="batshit-settings-delete-copy">
                    <p>Permanently removes this Goon and all of its saved per-Goon tuning.</p>
                    <p>Use this only when you are sure you want to remove it completely.</p>
                  </div>
                  <Button
                    variant="destructive"
                    size="sm"
                    type="button"
                    class="batshit-settings-delete-action"
                    onclick={(event) => {
                      event.stopPropagation()
                      if (editorGoon) {
                        void requestDeleteGoon(editorGoon)
                      }
                    }}
                    disabled={!editorGoon}
                  >
                    <Trash2 class="batshit-settings-delete-action-icon" />
                    Delete Goon
                  </Button>
                </div>
              </Collapsible.Content>
	            </div>
	          </Collapsible.Root>
	          </div>
	          </div>
	          <div class="batshit-settings-footer-bar shrink-0">
            <div class="flex justify-end gap-2">
              <Button
                variant="ghost"
                onclick={discardCueEditorChanges}
                disabled={!editorHasUnsavedChanges || editorSaving || editorFacialArtworkUploadBusy || recipeWorkflowBusy}
              >
                <X aria-hidden="true" />
                Cancel
              </Button>
              <Button
                variant="outline"
                onclick={() => requestWorkspaceExit({ type: 'close-editor' })}
                disabled={editorFacialArtworkUploadBusy || recipeWorkflowBusy}
              >
                <X aria-hidden="true" />
                Close Goon
              </Button>
              <Button
                onclick={() => void saveCueEditor()}
                disabled={Boolean(editorRecipeSourceError) || Boolean(editorHairStateError) || !editorHasUnsavedChanges || editorSaving || editorFacialArtworkUploadBusy || recipeWorkflowBusy}
              >
                {#if recipeWorkflowBusy}
                  <Loader2 class="animate-spin motion-reduce:animate-none" aria-hidden="true" />
                  <span aria-live="polite">Updating Appearance…</span>
                {:else if editorSaving}
                  <Loader2 class="animate-spin motion-reduce:animate-none" aria-hidden="true" />
                  <span aria-live="polite">Saving…</span>
                {:else}
                  Save Goon
                {/if}
              </Button>
            </div>
          </div>
          <SettingsTextEditor
            bind:open={editorDescriptionEditorOpen}
            title="Goon Description"
            description="Short internal note for this Goon."
            value={editorDescription}
            placeholder="Optional description"
            width="medium"
            saveLabel="Save Description"
            onSave={(value) => {
              editorDescription = value
              editorDirty = true
            }}
          />
	          <Dialog.Root
            open={deleteConfirmOpen}
            onOpenChange={(nextOpen) => {
              deleteConfirmOpen = nextOpen
              if (!nextOpen) {
                goonPendingDelete = null
              }
            }}
          >
            <Dialog.Content class="sm:max-w-md">
              <Dialog.Header>
                <Dialog.Title>Delete Goon?</Dialog.Title>
                <Dialog.Description>
                  {#if goonPendingDelete}
                    This will permanently delete `{goonPendingDelete.name || 'Unnamed Goon'}` from your
                    Goon library.
                  {:else}
                    This will permanently delete the selected Goon from your Goon library.
                  {/if}
                </Dialog.Description>
              </Dialog.Header>
              <div class="space-y-2 text-sm text-muted-foreground">
                <p>This action cannot be undone.</p>
              </div>
              <Dialog.Footer class="gap-2">
                <Button
                  variant="ghost"
                  type="button"
                  onclick={(event) => {
                    event.stopPropagation()
                    closeDeleteGoonDialog()
                  }}
                >
                  <X aria-hidden="true" />

                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  type="button"
                  onclick={(event) => {
                    event.stopPropagation()
                    void confirmDeleteGoon()
                  }}
                  disabled={!goonPendingDelete}
                >
                  <Trash2 aria-hidden="true" />

                  Delete Goon
                </Button>
              </Dialog.Footer>
            </Dialog.Content>
          </Dialog.Root>
        </div>
        <SettingsLivePreviewPane
          bind:host={previewContainer}
          width={previewWidth}
          resizing={previewResizing}
          resizeAriaLabel="Resize live preview"
          onResizeStart={startPreviewResize}
          runtimeBadge={resolveRendererBadge(previewRuntimeStatus)}
          loading={previewLoading}
          error={editorRecipeSourceError ? editorRecipeRecoveryMessage : previewError}
          emptyMessage={
            !hasRenderableGoonAvatar(editorGoon)
              ? editorGoonKind === 'custom'
                ? 'Upload a valid Custom package to preview this Goon.'
                : 'Upload a VRM to preview this Goon.'
              : null
          }
          wrapperClass="h-full min-h-0 batshit-settings-preview-shell"
        >
          {#snippet overlay()}
            {#if hairMotionPaintEditorOpen && hairMotionPaintTopology}
              <HairMotionPaintOverlay
                topology={hairMotionPaintTopology}
                initialPaint={hairMotionPaintInitial}
                onPreview={previewEditorHairMotionPaint}
                onPick={pickEditorHairMotionPaint}
                onSetGoonVisible={setEditorHairMotionPaintGoonVisible}
                onSetMeshVisible={setEditorHairMotionPaintMeshVisible}
                onSave={saveEditorHairMotionPaint}
                onCancel={cancelEditorHairMotionPaint}
              />
            {:else if paintedConcealEditorOpen}
              <div
                class="pointer-events-none absolute inset-0 z-20"
                role="application"
                aria-label="Conceal body mask"
              >
                <div class="pointer-events-none absolute inset-0 border-2 border-primary/70"></div>
                {#if paintedConcealPointerInPreview}
                  <div
                    class={`pointer-events-none absolute z-30 rounded-full border-2 shadow-[0_0_0_1px_rgba(0,0,0,0.35)] ${
                      paintedConcealShiftHeld || paintedConcealPainting
                        ? 'border-primary bg-primary/10'
                        : 'border-muted-foreground/70 bg-background/10'
                    }`}
                    style={`left: ${paintedConcealPointerX}px; top: ${paintedConcealPointerY}px; width: ${
                      paintedConcealBrushRadius * 2
                    }px; height: ${paintedConcealBrushRadius * 2}px; transform: translate(-50%, -50%);`}
                    aria-hidden="true"
                  ></div>
                {/if}
                <div
                  class={`absolute inset-0 touch-none ${
                    paintedConcealShiftHeld || paintedConcealPainting
                      ? 'pointer-events-auto cursor-none'
                      : 'pointer-events-none'
                  }`}
                  role="application"
                  aria-label="Conceal body surface"
                  onpointerdown={handlePaintedConcealPointerDown}
                  onpointermove={handlePaintedConcealPointerMove}
                  onpointerup={handlePaintedConcealPointerUp}
                  onpointercancel={handlePaintedConcealPointerUp}
                  onpointerleave={handlePaintedConcealPointerUp}
                ></div>
                <div
                  class="batshit-goon-paint-toolbar"
                  role="group"
                  aria-label="Painted conceal controls"
                  onpointerdown={(event) => event.stopPropagation()}
                  onpointermove={(event) => event.stopPropagation()}
                  onpointerup={(event) => event.stopPropagation()}
                >
                  <div class="flex w-full items-center justify-between gap-2">
                    <div class="flex min-w-0 flex-1 items-center gap-1.5">
                      <Button
                        type="button"
                        variant={paintedConcealTool === 'paint' ? 'default' : 'outline'}
                        size="icon"

                        aria-label="Conceal"
                        title="Conceal"
                        onclick={() => (paintedConcealTool = 'paint')}
                      >
                        <Paintbrush  />
                      </Button>
                      <Button
                        type="button"
                        variant={paintedConcealTool === 'erase' ? 'default' : 'outline'}
                        size="icon"

                        aria-label="Erase"
                        title="Erase"
                        onclick={() => (paintedConcealTool = 'erase')}
                      >
                        <Eraser  />
                      </Button>
                      <Button
                        type="button"
                        variant={paintedConcealMirrorX ? 'default' : 'outline'}
                        size="icon"

                        aria-label="Mirror left/right"
                        aria-pressed={paintedConcealMirrorX}
                        title={paintedConcealMirrorX ? 'Mirror left/right: On' : 'Mirror left/right: Off'}
                        onclick={() => (paintedConcealMirrorX = !paintedConcealMirrorX)}
                      >
                        <FlipHorizontal2  />
                      </Button>
                      <label class="flex min-w-0 max-w-48 flex-1 items-center gap-2">
                        <span class="sr-only">Brush size</span>
                        <input
                          type="range"
                          min="2"
                          max="64"
                          step="1"
                          value={paintedConcealBrushRadius}
                          class="batshit-settings-range-input min-w-16 flex-1"
                          title={`Brush size: ${paintedConcealBrushRadius}px`}
                          oninput={(event) =>
                            (paintedConcealBrushRadius = Number((event.currentTarget as HTMLInputElement).value))}
                        />
                        <span class="w-9 text-right text-[10px] text-muted-foreground">
                          {paintedConcealBrushRadius}px
                        </span>
                      </label>
                    </div>
                    <div class="flex shrink-0 items-center justify-end gap-1.5">
                      <DropdownMenu.Root>
                        <DropdownMenu.Trigger
                          class="batshit-settings-icon-trigger"
                          aria-label={`Paint pose: ${resolvePaintedConcealPose().label}`}
                          title={`Paint pose: ${resolvePaintedConcealPose().label}`}
                        >
                          <PersonStanding class="h-4 w-4" />
                        </DropdownMenu.Trigger>
                        <DropdownMenu.Content align="end" class="min-w-[180px]">
                          {#each PAINTED_CONCEAL_POSES as pose (pose.id)}
                            <DropdownMenu.Item onSelect={() => selectPaintedConcealPose(pose.id)}>
                              <span class="flex min-w-0 flex-1 items-center gap-2">
                                <span class="truncate">{pose.label}</span>
                              </span>
                              {#if paintedConcealPoseId === pose.id}
                                <Check class="ml-2 h-3.5 w-3.5" />
                              {/if}
                            </DropdownMenu.Item>
                          {/each}
                        </DropdownMenu.Content>
                      </DropdownMenu.Root>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"

                        aria-label="Undo"
                        title="Undo"
                        disabled={paintedConcealHistory.length === 0}
                        onclick={undoPaintedConcealDraft}
                      >
                        <RotateCcw  />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"

                        aria-label="Clear"
                        title="Clear"
                        onclick={clearPaintedConcealDraft}
                      >
                        <Trash2  />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"

                        aria-label="Cancel"
                        title="Cancel"
                        onclick={closePaintedConcealEditor}
                      >
                        <X  />
                      </Button>
                      <Button
                        type="button"
                        size="icon"

                        aria-label="Save"
                        title="Save"
                        onclick={() => void savePaintedConcealEditor()}
                      >
                        <Save  />
                      </Button>
                    </div>
                  </div>
                  <div class="flex w-full min-w-0 items-center justify-between gap-2 border-t border-border/50 pt-1 text-[10px]">
                    <div class="batshit-settings-inline-strong truncate" title={getPaintedConcealDraftCountLabel()}>
                      {getPaintedConcealDraftCountLabel()}
                    </div>
                    <div
                      class={`truncate text-right ${
                        paintedConcealStatus ? 'batshit-settings-warning-text' : 'text-muted-foreground'
                      }`}
                      title={getPaintedConcealInstructionLabel()}
                    >
                      {getPaintedConcealInstructionLabel()}
                    </div>
                  </div>
                </div>
              </div>
            {/if}
          {/snippet}
          <div class="flex items-center gap-1 min-w-0 flex-1">
            <DropdownMenu.Root>
              <DropdownMenu.Trigger
                class="batshit-settings-icon-trigger"
                disabled={goons.length === 0}
                aria-label="Select preview Goon"
                title={`Preview Goon: ${editorGoon?.name || 'None'}`}
              >
                <BatshitIcon id="goons" class="h-4 w-4" />
              </DropdownMenu.Trigger>
              <DropdownMenu.Content align="start" class="min-w-[220px] max-w-[360px]">
                {#if goons.length > 0}
                  {#each goons as goonEntry (goonEntry.id)}
                    <DropdownMenu.Item onSelect={() => handleEditorGoonSelect(goonEntry.id)}>
                      <span class="truncate">
                        {goonEntry.name || 'Unnamed Goon'}{editorGoonId === goonEntry.id ? ' • Current' : ''}
                      </span>
                    </DropdownMenu.Item>
                  {/each}
                {:else}
                  <DropdownMenu.Item disabled>
                    <span class="text-muted-foreground">No goons available</span>
                  </DropdownMenu.Item>
                {/if}
              </DropdownMenu.Content>
            </DropdownMenu.Root>

            <DropdownMenu.Root>
              <DropdownMenu.Trigger
                class="batshit-settings-icon-trigger"
                disabled={!editorGoonId || availableAnimationNames.length === 0}
                aria-label="Select preview Motion"
                title={
                  previewAnimationName
                    ? `Preview Motion: ${previewAnimationName}`
                    : 'Select preview Motion'
                }
              >
                <BatshitIcon id="motions" class="h-4 w-4" />
              </DropdownMenu.Trigger>
              <DropdownMenu.Content align="start" class="min-w-[240px] max-h-[320px] overflow-y-auto">
                {#if availableAnimationNames.length > 0}
                  {#each availableAnimationNames as animationName}
                    <DropdownMenu.Item
                      onSelect={() => {
                        previewAnimationName = animationName
                        void triggerPreviewAnimation()
                      }}
                    >
                      <span class="truncate">
                        {animationName}{previewAnimationName === animationName ? ' • Current' : ''}
                      </span>
                    </DropdownMenu.Item>
                  {/each}
                {:else}
                  <DropdownMenu.Item disabled>
                    <span class="text-muted-foreground">No motions available</span>
                  </DropdownMenu.Item>
                {/if}
              </DropdownMenu.Content>
            </DropdownMenu.Root>

            <Button
              variant="ghost"
              size="sm"

              onclick={() => void resetEditorPreviewAll()}
              disabled={!editorGoonId}
              aria-label="Reset preview view controls and clear animation preview"
              title="Reset preview view controls and clear animation preview"
            >
              <RotateCcw  />
            </Button>
          </div>
          <SettingsPreviewViewControls
            disabled={!editorGoonId}
            eyeContactEnabled={settingsPreviewEyeContactEnabled}
            onEyeContactToggle={() => {
              settingsPreviewEyeContactEnabled = !settingsPreviewEyeContactEnabled
            }}
            fov={previewViewFov}
            minFov={MIN_PREVIEW_VIEW_FOV}
            maxFov={MAX_PREVIEW_VIEW_FOV}
            onFovChange={handlePreviewFovChange}
            onFramePreset={handlePreviewFramePreset}
            cameraMode={previewCameraMode}
            indoorCameraAvailable={previewEngine?.canUseIndoorCamera() ?? false}
            onCameraModeChange={(mode) => handlePreviewCameraModeChange(previewEngine, mode, true)}
            quality={editorQuality}
            qualityOptions={qualityOptions}
            onQualityChange={(value) => {
              editorQuality = value
              editorDirty = true
            }}
          />
        </SettingsLivePreviewPane>
      </div>
{/if}

{#if sceneEditorMode}
  <div
    bind:this={sceneShellEl}
    class="flex min-h-0 flex-1 items-stretch overflow-hidden"
  >
{#snippet scenePlacementControls(
  placement: GoonScenePlacement,
  projectionLine: number,
  onPlacementChange: (placement: GoonScenePlacement) => void,
  onProjectionLineChange: (value: number) => void
)}
  <div class="space-y-3">
    <div class="flex items-center gap-1.5">
      <span class="batshit-settings-child-label">Scene Placement</span>
      <SettingsInfoMenu ariaLabel="About Scene Placement" contentClass="w-80">
        <p>
          Ground Level projects the skybox ground so the scene feels placed on the outdoor floor.
        </p>
        <p>
          Elevated / Overlook keeps the skybox unprojected for rooftops, high-rises, balconies,
          space, cliffs, and distant views.
        </p>
        <p>
          Placement works with either a Procedural Builder room or an Uploaded GLB room shell. It
          has no visible effect until the scene has a skybox.
        </p>
      </SettingsInfoMenu>
    </div>
    <Select.Root
      type="single"
      value={placement}
      onValueChange={(value: string) =>
        onPlacementChange(value === 'ground' ? 'ground' : 'elevated')}
    >
      <Select.Trigger class="batshit-settings-select-compact w-full">
        {placement === 'ground' ? 'Ground Level' : 'Elevated / Overlook'}
      </Select.Trigger>
      <Select.Content>
        <Select.Item value="ground">Ground Level</Select.Item>
        <Select.Item value="elevated">Elevated / Overlook</Select.Item>
      </Select.Content>
    </Select.Root>
    {#if placement === 'ground'}
      {@const normalizedLine = normalizeGroundProjectionLine(projectionLine)}
      <div class="space-y-1">
        <div class="flex items-center justify-between gap-2">
          <div class="flex items-center gap-1.5">
            <span class="batshit-settings-child-label">Ground Projection Line</span>
            <SettingsInfoMenu ariaLabel="About Ground Projection Line" contentClass="w-96">
              <p>
                Chooses which horizontal row of the original panorama becomes the boundary between
                the upright skybox and projected ground. The normal equirectangular equator is 50%.
              </p>
              <p>
                Moving this line can correct an imperfect horizon, but it cannot repair a TV,
                couch, wall, tree, rock, or other upright object already painted into the ground
                region below it.
              </p>
            </SettingsInfoMenu>
          </div>
          <div class="flex items-center gap-2">
            <span class="text-[10px] text-muted-foreground">
              {Math.round(normalizedLine * 100)}%
            </span>
            <Button
              variant="ghost"
              size="sm"
              disabled={normalizedLine === DEFAULT_GROUND_PROJECTION_LINE}
              onclick={() => onProjectionLineChange(DEFAULT_GROUND_PROJECTION_LINE)}
            >
              Reset
            </Button>
          </div>
        </div>
        <input
          class="batshit-settings-range-input w-full"
          type="range"
          min={MIN_GROUND_PROJECTION_LINE * 100}
          max={MAX_GROUND_PROJECTION_LINE * 100}
          step="1"
          value={normalizedLine * 100}
          oninput={(event) =>
            onProjectionLineChange(
              Number((event.currentTarget as HTMLInputElement).value) / 100
            )}
        />
        <div class="text-[10px] text-muted-foreground">
          For the cleanest Ground Level result, keep everything below this row to continuous
          floor, terrain, grass, dirt, sand, or water.
        </div>
      </div>
    {/if}
  </div>
{/snippet}

{#snippet roomShellTransformControls(
  transform: ReturnType<typeof normalizeRoomShellTransform>,
  onTransformChange: (patch: Partial<GoonSceneRoomShellTransform>) => void,
  onAlignFloor: (() => void) | null
)}
  <div class="batshit-goon-editor-subpanel space-y-3">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <div class="flex items-center gap-1.5">
        <span class="batshit-settings-child-label">Room Shell Placement</span>
        <SettingsInfoMenu ariaLabel="About Room Shell Placement" contentClass="w-96">
          <p>
            These saved controls move only the Uploaded GLB room. They do not move separate Props,
            Markers, the Goon, or the skybox.
          </p>
          <p>
            Align Floor probes for a walkable surface near the Goon and moves that surface to stage
            height. Generated models are inconsistent, so use Y Offset if Batshit cannot identify
            the right floor.
          </p>
        </SettingsInfoMenu>
      </div>
      <div class="flex items-center gap-2">
        {#if onAlignFloor}
          <Button variant="outline" size="sm" onclick={onAlignFloor}>Align Floor</Button>
        {/if}
        <Button
          variant="ghost"
          size="sm"
          onclick={() => onTransformChange(normalizeRoomShellTransform())}
        >
          Reset Placement
        </Button>
      </div>
    </div>
    <div class="grid gap-2 md:grid-cols-2">
      <div class="space-y-1">
        <div class="batshit-settings-child-label">Uniform Scale</div>
        <Input
          type="number"
          min="0.05"
          max="20"
          step="0.05"
          value={transform.uniformScale}
          oninput={(event) =>
            onTransformChange({
              uniformScale: Number((event.currentTarget as HTMLInputElement).value)
            })}
        />
      </div>
      <div class="space-y-1">
        <div class="batshit-settings-child-label">Y Rotation</div>
        <Input
          type="number"
          min="-180"
          max="180"
          step="1"
          value={Math.round((transform.rotationY * 180) / Math.PI * 100) / 100}
          oninput={(event) =>
            onTransformChange({
              rotationY:
                (Number((event.currentTarget as HTMLInputElement).value) * Math.PI) / 180
            })}
        />
      </div>
    </div>
    <div class="grid gap-2 md:grid-cols-3">
      {#each [
        { label: 'X Offset', index: 0 },
        { label: 'Y Offset', index: 1 },
        { label: 'Z Offset', index: 2 }
      ] as axis}
        <div class="space-y-1">
          <div class="batshit-settings-child-label">{axis.label}</div>
          <Input
            type="number"
            min="-1000"
            max="1000"
            step="0.05"
            value={transform.position[axis.index]}
            oninput={(event) => {
              const position: [number, number, number] = [...transform.position]
              position[axis.index] = Number((event.currentTarget as HTMLInputElement).value)
              onTransformChange({ position })
            }}
          />
        </div>
      {/each}
    </div>
    {#if !onAlignFloor}
      <div class="text-[10px] text-muted-foreground">
        Create the scene to preview the shell and use Align Floor.
      </div>
    {/if}
  </div>
{/snippet}

{#snippet roomCameraBoundaryControls(
  boundary: GoonSceneCameraBoundary | undefined,
  onBoundaryChange: (boundary: GoonSceneCameraBoundary | null) => void,
  onFitRoom: () => void
)}
  {@const normalized = normalizeRoomCameraBoundary(boundary)}
  <div class="batshit-goon-editor-subpanel space-y-3">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <div class="flex items-center gap-1.5">
        <span class="batshit-settings-child-label">Indoor Camera Boundary</span>
        <SettingsInfoMenu ariaLabel="About Indoor Camera Boundary" contentClass="w-96">
          <p>This saved box defines where Indoor Camera may move. Walls, openings, floor, and ceiling all act as boundaries.</p>
          <p>Fit to Room measures the Uploaded GLB as a starting point. Adjust the box when the visible model includes exterior architecture or scenery.</p>
        </SettingsInfoMenu>
      </div>
      <div class="flex items-center gap-2">
        <Button variant="outline" size="sm" onclick={onFitRoom}>Fit to Room</Button>
        {#if normalized}
          <Button variant="ghost" size="sm" onclick={() => onBoundaryChange(null)}>Remove</Button>
        {/if}
      </div>
    </div>
    {#if normalized}
      <div class="grid gap-2 md:grid-cols-3">
        {#each ['X', 'Y', 'Z'] as axis, index}
          <div class="space-y-1">
            <div class="batshit-settings-child-label">{axis} Center</div>
            <Input
              type="number"
              step="0.05"
              value={normalized.center[index]}
              oninput={(event) => {
                const center: [number, number, number] = [...normalized.center]
                center[index] = Number((event.currentTarget as HTMLInputElement).value)
                onBoundaryChange({ ...normalized, center })
              }}
            />
          </div>
        {/each}
      </div>
      <div class="grid gap-2 md:grid-cols-3">
        {#each ['Width', 'Height', 'Depth'] as label, index}
          <div class="space-y-1">
            <div class="batshit-settings-child-label">{label}</div>
            <Input
              type="number"
              min="0.1"
              step="0.05"
              value={normalized.size[index]}
              oninput={(event) => {
                const size: [number, number, number] = [...normalized.size]
                size[index] = Number((event.currentTarget as HTMLInputElement).value)
                onBoundaryChange({ ...normalized, size })
              }}
            />
          </div>
        {/each}
      </div>
      <div class="space-y-1 md:max-w-[220px]">
        <div class="batshit-settings-child-label">Y Rotation</div>
        <Input
          type="number"
          min="-180"
          max="180"
          step="1"
          value={Math.round((normalized.rotationY * 180) / Math.PI * 100) / 100}
          oninput={(event) => onBoundaryChange({
            ...normalized,
            rotationY: Number((event.currentTarget as HTMLInputElement).value) * Math.PI / 180
          })}
        />
      </div>
    {:else}
      <div class="text-[11px] text-muted-foreground">
        Fit and save a boundary to enable Indoor Camera for this Uploaded GLB room.
      </div>
    {/if}
  </div>
{/snippet}

{#snippet sceneAtmosphereControls(
  ambience: ReturnType<typeof normalizeGoonSceneAmbience>,
  onAmbienceChange: (patch: Partial<GoonSceneAmbience>) => void
)}
  <div class="space-y-2">
    <div class="flex items-center gap-1.5">
      <span class="batshit-settings-child-label">Scene Atmosphere</span>
      <SettingsInfoMenu ariaLabel="About Scene Atmosphere" contentClass="w-80">
        <p>Adds one lightweight saved particle layer to the scene.</p>
        <p>
          Use Outside for weather beyond the room, Inside for dust or embers, and Whole Stage for
          subtle all-around motion.
        </p>
        <p>
          Opaque walls hide Outside effects. Use an open or transparent surface to see weather
          beyond a room.
        </p>
      </SettingsInfoMenu>
    </div>
    <div class="space-y-3">
      <div class="flex items-center justify-between gap-3">
        <span class="batshit-settings-child-label">Enable Atmosphere</span>
        <Switch.Root
          checked={ambience.enabled}
          onCheckedChange={(checked) => onAmbienceChange({ enabled: Boolean(checked) })}
        />
      </div>
      {#if ambience.enabled}
        <div class="grid gap-2 md:grid-cols-2">
          <div class="space-y-1">
            <div class="batshit-settings-child-label">Preset</div>
            <Select.Root
              type="single"
              value={ambience.preset}
              onValueChange={(value: string) =>
                onAmbienceChange({ preset: value as GoonSceneAmbiencePreset })}
            >
              <Select.Trigger class="batshit-settings-select-compact w-full">
                {GOON_SCENE_AMBIENCE_PRESET_OPTIONS.find(
                  (option) => option.value === ambience.preset
                )?.label || 'Dust / Pollen'}
              </Select.Trigger>
              <Select.Content>
                {#each GOON_SCENE_AMBIENCE_PRESET_OPTIONS as option}
                  <Select.Item value={option.value}>{option.label}</Select.Item>
                {/each}
              </Select.Content>
            </Select.Root>
          </div>
          <div class="space-y-1">
            <div class="batshit-settings-child-label">Placement</div>
            <Select.Root
              type="single"
              value={ambience.placement}
              onValueChange={(value: string) =>
                onAmbienceChange({ placement: value as GoonSceneAmbiencePlacement })}
            >
              <Select.Trigger class="batshit-settings-select-compact w-full">
                {GOON_SCENE_AMBIENCE_PLACEMENT_OPTIONS.find(
                  (option) => option.value === ambience.placement
                )?.label || 'Whole Stage'}
              </Select.Trigger>
              <Select.Content>
                {#each GOON_SCENE_AMBIENCE_PLACEMENT_OPTIONS as option}
                  <Select.Item value={option.value}>{option.label}</Select.Item>
                {/each}
              </Select.Content>
            </Select.Root>
          </div>
        </div>
        <div class="grid gap-2 md:grid-cols-2">
          <div class="space-y-1">
            <div class="flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
              <span>Intensity</span>
              <span>{Math.round(ambience.intensity * 100)}%</span>
            </div>
            <input
              class="batshit-settings-range-input w-full"
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={ambience.intensity}
              oninput={(event) =>
                onAmbienceChange({
                  intensity: Number((event.currentTarget as HTMLInputElement).value)
                })}
            />
          </div>
          <div class="space-y-1">
            <div class="flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
              <span>Speed</span>
              <span>{ambience.speed.toFixed(2)}x</span>
            </div>
            <input
              class="batshit-settings-range-input w-full"
              type="range"
              min="0.2"
              max="2.5"
              step="0.05"
              value={ambience.speed}
              oninput={(event) =>
                onAmbienceChange({
                  speed: Number((event.currentTarget as HTMLInputElement).value)
                })}
            />
          </div>
        </div>
        <div class="grid gap-2 md:grid-cols-2">
          <div class="space-y-1">
            <div class="batshit-settings-child-label">Wind X</div>
            <Input
              type="number"
              min="-2"
              max="2"
              step="0.05"
              value={ambience.wind[0]}
              oninput={(event) =>
                onAmbienceChange({
                  wind: [
                    Number((event.currentTarget as HTMLInputElement).value),
                    ambience.wind[1]
                  ]
                })}
            />
          </div>
          <div class="space-y-1">
            <div class="batshit-settings-child-label">Wind Z</div>
            <Input
              type="number"
              min="-2"
              max="2"
              step="0.05"
              value={ambience.wind[1]}
              oninput={(event) =>
                onAmbienceChange({
                  wind: [
                    ambience.wind[0],
                    Number((event.currentTarget as HTMLInputElement).value)
                  ]
                })}
            />
          </div>
        </div>
      {/if}
    </div>
  </div>
{/snippet}

        <div class="batshit-settings-preview-shell batshit-goon-static-card flex h-full min-h-0 min-w-0 flex-1 flex-col">
          <div class="min-h-0 flex-1 overflow-y-auto">
          <div class="space-y-6 px-5 pt-6 pb-0">
          <div class="flex items-center justify-between">
            <div class="batshit-settings-form-label flex items-center gap-2">
              <BatshitIcon id="scenes" class="h-4 w-4" />
              <span>{sceneEditorMode === 'create' ? 'Create Scene' : 'Scene Editor'}</span>
            </div>
            <div class="flex items-center gap-2">
              {#if sceneEditorMode === 'edit' && sceneEditorScene}
                <Button
                  variant="ghost"
                  size="icon"

                  aria-label={`Delete ${sceneEditorScene.name || 'Scene'}`}
                  title="Delete Scene"
                  onclick={() => requestDeleteScene(sceneEditorScene)}
                >
                  <Trash2  />
                </Button>
              {/if}
            </div>
          </div>

          {#if sceneEditorMode === 'create'}
            <div class="batshit-settings-child-label">
              Scene Details
            </div>
            <div class="batshit-goon-editor-subpanel is-spacious space-y-3">
              <div class="grid grid-cols-12 gap-2 items-center">
                <div class="col-span-6">
                  <Input placeholder="Scene name" bind:value={newSceneName} />
                </div>
                <div class="col-span-6">
                  <Input placeholder="Description (optional)" bind:value={newSceneDescription} />
                </div>
              </div>
            </div>
            <div class="space-y-2">
              <Collapsible.Root bind:open={sceneWorldOpen} class={goonLevel1AccordionClass}>
                <Collapsible.Trigger
                  class={goonLevel1AccordionHeaderClass}
                  onclick={() => toggleSceneSection('world')}
                >
                  <div class="flex items-center gap-1.5">
                    <span class="batshit-settings-form-label">World</span>
                    <div
                      onclick={(event) => {
                        event.preventDefault()
                        event.stopPropagation()
                      }}
                      aria-hidden="true"
                    >
                      <SettingsInfoMenu ariaLabel="About World" contentClass="w-80">
                        <p>
                          World controls the 360 Skybox, how it meets the stage, and one saved Scene
                          Atmosphere layer.
                        </p>
                      </SettingsInfoMenu>
                    </div>
                  </div>
                </Collapsible.Trigger>
                <Collapsible.Content class={`${goonLevel1AccordionContentClass} space-y-3`}>
                  <div class="batshit-goon-editor-subpanel space-y-3">
                    <div class="flex items-center justify-between gap-2">
                      <span class="batshit-settings-child-label">Skybox</span>
                      <Button
                        variant="outline"
                        size="sm"
                        onclick={() => requestSceneSkyboxUpload()}
                        disabled={sceneUploadBusy}
                      >
                        {sceneUploadBusy
                          ? 'Uploading…'
                          : newSceneSkybox
                            ? 'Replace Skybox'
                            : 'Upload Skybox'}
                      </Button>
                    </div>
                    <div class="flex flex-wrap items-start gap-3 text-[11px] text-muted-foreground">
                      {#if newSceneSkybox}
                        <div class="flex items-start gap-3">
                          <div class="batshit-goon-thumbnail-frame is-small">
                            {#if resolveFileThumbnailUrl(newSceneSkybox)}
                              <img
                                src={resolveFileThumbnailUrl(newSceneSkybox) ?? undefined}
                                alt="Skybox thumbnail"
                                class="h-full w-full object-cover"
                              />
                            {:else}
                              <div class="batshit-settings-child-label flex h-full w-full items-center justify-center">
                                No Thumb
                              </div>
                            {/if}
                          </div>
                          <span class="pt-1">Skybox ready</span>
                        </div>
                      {:else}
                        <span>Upload a 2:1 equirectangular PNG/JPG. Batshit keeps the original file.</span>
                      {/if}
                    </div>
                  </div>
                  {@render scenePlacementControls(
                    newScenePlacement,
                    newSceneGroundProjectionLine,
                    (placement: GoonScenePlacement) => {
                      newScenePlacement = placement
                    },
                    (value: number) => {
                      newSceneGroundProjectionLine = normalizeGroundProjectionLine(value)
                    }
                  )}
                  {@render sceneAtmosphereControls(newSceneAmbience, updateNewSceneAmbience)}
                </Collapsible.Content>
              </Collapsible.Root>

              <Collapsible.Root bind:open={roomBuilderOpen} class={goonLevel1AccordionClass}>
                <Collapsible.Trigger
                  class={goonLevel1AccordionHeaderClass}
                  onclick={() => toggleSceneSection('room')}
                >
                  <div class="flex items-center gap-1.5">
                    <span class="batshit-settings-form-label">Room Builder</span>
                    <div
                      onclick={(event) => {
                        event.preventDefault()
                        event.stopPropagation()
                      }}
                      aria-hidden="true"
                    >
                      <SettingsInfoMenu ariaLabel="About Room Builder" contentClass="w-96">
                        <p>
                          Use an Uploaded GLB room shell or create the scene first and configure
                          Batshit's Procedural Builder surfaces.
                        </p>
                      </SettingsInfoMenu>
                    </div>
                  </div>
                </Collapsible.Trigger>
                <Collapsible.Content class={`${goonLevel1AccordionContentClass} space-y-3`}>
                  <div class="batshit-goon-editor-subpanel space-y-3">
                    <div class="flex items-center justify-between gap-2">
                      <span class="batshit-settings-child-label">Room Shell</span>
                      <Button
                        variant="outline"
                        size="sm"
                        onclick={() => requestRoomShellUpload()}
                        disabled={sceneRoomShellBusy}
                      >
                        {sceneRoomShellBusy
                          ? 'Uploading…'
                          : newSceneRoomShell
                            ? 'Replace Room Shell'
                            : 'Upload Room Shell'}
                      </Button>
                    </div>
                    <div class="text-[11px] text-muted-foreground">
                      {#if newSceneRoomShell}
                        {newSceneRoomShell.originalName || newSceneRoomShell.filename}
                      {:else}
                        Optional. Use a self-contained GLB when possible; single-file GLTF uploads
                        may reference files Batshit cannot receive.
                      {/if}
                    </div>
                    <div class="batshit-settings-child-label">
                      After creation, choose Uploaded GLB or Procedural Builder and configure the
                      room surfaces.
                    </div>
                  </div>
                  {#if newSceneRoomShell}
                    {@render roomShellTransformControls(
                      newSceneRoomShellTransform,
                      updateNewRoomShellTransform,
                      null
                    )}
                  {/if}
                </Collapsible.Content>
              </Collapsible.Root>
              <div class="batshit-settings-child-label px-1">
                Create the scene to configure procedural surfaces, Props, and Markers.
              </div>
            </div>
          {:else}
            {#each sortedScenes as scene (scene.id)}
              {#if scene.id === sceneEditorId}
                <div class="space-y-4">
                  <div class="space-y-2">
                    <Input
                      value={scene.name}
                      oninput={(event) => {
                        const value = (event.currentTarget as HTMLInputElement).value
                        updateScene(scene.id, { name: value })
                      }}
                    />
                    <Input
                      placeholder="Description (optional)"
                      value={scene.description ?? ''}
                      oninput={(event) => {
                        const value = (event.currentTarget as HTMLInputElement).value
                        updateScene(scene.id, { description: value || undefined })
                      }}
                    />
                    <div class="mt-2 space-y-2">
                      <Collapsible.Root bind:open={sceneWorldOpen} class={goonLevel1AccordionClass}>
                        <Collapsible.Trigger
                          class={goonLevel1AccordionHeaderClass}
                          onclick={() => toggleSceneSection('world')}
                        >
                          <div class="flex items-center gap-1.5">
                            <span class="batshit-settings-form-label">World</span>
                            <div
                              onclick={(event) => {
                                event.preventDefault()
                                event.stopPropagation()
                              }}
                              aria-hidden="true"
                            >
                              <SettingsInfoMenu ariaLabel="About World" contentClass="w-80">
                                <p>
                                  World controls the 360 Skybox, how it meets the stage, and one saved
                                  Scene Atmosphere layer.
                                </p>
                              </SettingsInfoMenu>
                            </div>
                          </div>
                        </Collapsible.Trigger>
                        <Collapsible.Content class={`${goonLevel1AccordionContentClass} space-y-3`}>
                          {@const ambience = normalizeGoonSceneAmbience(scene.ambience)}
                          <div class="batshit-goon-editor-subpanel space-y-3">
                            <div class="flex items-center justify-between gap-2">
                              <span class="batshit-settings-child-label">Skybox</span>
                              <Button
                                variant="outline"
                                size="sm"
                                onclick={() => requestSceneSkyboxUpload(scene.id)}
                                disabled={sceneUploadBusy}
                              >
                                {sceneUploadBusy
                                  ? 'Uploading…'
                                  : scene.skybox
                                    ? 'Update Skybox'
                                    : 'Upload Skybox'}
                              </Button>
                            </div>
                            <div class="flex flex-wrap items-start gap-3">
                              <div class="batshit-goon-thumbnail-frame is-small">
                                {#if resolveSceneThumbnailUrl(scene)}
                                  <img
                                    src={resolveSceneThumbnailUrl(scene) ?? undefined}
                                    alt="Skybox thumbnail"
                                    class="h-full w-full object-cover"
                                  />
                                {:else}
                                  <div class="batshit-settings-child-label flex h-full w-full items-center justify-center">
                                    No Thumb
                                  </div>
                                {/if}
                              </div>
                              <div class="min-w-0 flex-1 space-y-1">
                                <div class="batshit-settings-child-label">
                                  {#if scene.skybox}
                                    {#if !resolveSceneThumbnailUrl(scene)}
                                      Update this Skybox to generate a thumbnail copy.
                                    {:else}
                                      Skybox ready
                                    {/if}
                                  {:else}
                                    No skybox uploaded.
                                  {/if}
                                </div>
                                {#if scene.skybox}
                                  <div class="truncate text-[10px] text-muted-foreground">
                                    {scene.skybox.originalName || scene.skybox.filename}
                                  </div>
                                {/if}
                              </div>
                            </div>
                          </div>
                          {@render scenePlacementControls(
                            resolveGoonScenePlacement(scene),
                            normalizeGroundProjectionLine(scene.groundProjectionLine),
                            (placement: GoonScenePlacement) => updateScenePlacement(scene.id, placement),
                            (value: number) => updateSceneGroundProjectionLine(scene.id, value)
                          )}
                          {@render sceneAtmosphereControls(
                            ambience,
                            (patch: Partial<GoonSceneAmbience>) => updateSceneAmbience(scene.id, patch)
                          )}
                        </Collapsible.Content>
                      </Collapsible.Root>

                      <Collapsible.Root bind:open={roomBuilderOpen} class={goonLevel1AccordionClass}>
                        <Collapsible.Trigger
                          class={goonLevel1AccordionHeaderClass}
                          onclick={() => toggleSceneSection('room')}
                        >
                          <div class="flex items-center gap-1.5">
                            <span class="batshit-settings-form-label">Room Builder</span>
                            <div
                              onclick={(event) => {
                                event.preventDefault()
                                event.stopPropagation()
                              }}
                              aria-hidden="true"
                            >
                              <SettingsInfoMenu ariaLabel="About Room Builder" contentClass="w-96">
                                <p>
                                  Room Builder is the fast way to create a simple scene room inside
                                  Batshit with textured Floor, Ceiling, and Walls.
                                </p>
                                <p>
                                  Use `Single Fit` when you want exact texture specs. Use `Repeat`
                                  for seamless textures and manual grid control.
                                </p>
                                <p>
                                  If you switch to `Uploaded GLB`, Batshit uses the uploaded room
                                  shell instead of these builder surfaces.
                                </p>
                              </SettingsInfoMenu>
                            </div>
                          </div>
                        </Collapsible.Trigger>
                        <Collapsible.Content class={`${goonLevel1AccordionContentClass} space-y-3`}>
                          <div class="batshit-goon-editor-subpanel space-y-3">
                            <div class="flex items-center justify-between gap-2">
                              <span class="batshit-settings-child-label">Room Shell</span>
                              <div class="flex items-center gap-2">
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onclick={() => requestRoomShellUpload(scene.id)}
                                  disabled={sceneRoomShellBusy}
                                >
                                  {sceneRoomShellBusy
                                    ? 'Uploading…'
                                    : scene.roomShell
                                      ? 'Replace Room Shell'
                                      : 'Upload Room Shell'}
                                </Button>
                                {#if scene.roomShell}
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    onclick={() => clearRoomShell(scene.id)}
                                  >
                                    <Trash2 aria-hidden="true" />
                                    Remove
                                  </Button>
                                {/if}
                              </div>
                            </div>
                            <div class="text-[11px] text-muted-foreground">
                              {#if scene.roomShell}
                                <span class="block truncate">
                                  {scene.roomShell.originalName || scene.roomShell.filename}
                                </span>
                              {:else}
                                Optional. Use a self-contained GLB when possible; single-file GLTF
                                uploads may reference files Batshit cannot receive.
                              {/if}
                            </div>
                          </div>
                          {#if scene.roomShell?.url}
                            <Select.Root
                              type="single"
                              value={scene.roomShellBuilder ? 'builder' : 'upload'}
                              onValueChange={(value: string) => {
                                if (value === 'builder') {
                                  const builder = normalizeRoomShellBuilder(scene.roomShellBuilder)
                                  updateScene(scene.id, { roomShellBuilder: builder })
                                  return
                                }
                                updateScene(scene.id, { roomShellBuilder: undefined })
                              }}
                            >
                              <Select.Trigger class="batshit-settings-select-compact w-full">
                                {scene.roomShellBuilder ? 'Procedural Builder' : 'Uploaded GLB'}
                              </Select.Trigger>
                              <Select.Content>
                                <Select.Item value="upload">Uploaded GLB</Select.Item>
                                <Select.Item value="builder">Procedural Builder</Select.Item>
                              </Select.Content>
                            </Select.Root>
                          {/if}
                          {#if scene.roomShell?.url && !scene.roomShellBuilder}
                            {@render roomShellTransformControls(
                              normalizeRoomShellTransform(scene.roomShellTransform),
                              (patch: Partial<GoonSceneRoomShellTransform>) =>
                                updateRoomShellTransform(scene.id, patch),
                              () => void alignRoomShellFloor(scene.id)
                            )}
                            {@render roomCameraBoundaryControls(
                              scene.cameraBoundary,
                              (boundary: GoonSceneCameraBoundary | null) =>
                                updateRoomCameraBoundary(scene.id, boundary),
                              () => void suggestRoomCameraBoundary(scene.id)
                            )}
                          {/if}
                          {#if scene.roomShellBuilder || !scene.roomShell?.url}
                            {@const builder = normalizeRoomShellBuilder(scene.roomShellBuilder)}
                            <div class="batshit-goon-editor-subpanel space-y-3">
                              <div class="flex flex-wrap items-center gap-2">
                                <Select.Root
                                  type="single"
                                  value={roomTextureTargetKind}
                                  onValueChange={(value: string) => {
                                    roomTextureTargetKind = value as GoonRoomTextureKind
                                  }}
                                >
                                  <Select.Trigger class="batshit-settings-select-compact w-[170px]">
                                    {ROOM_TEXTURE_KIND_OPTIONS.find((option) => option.value === roomTextureTargetKind)?.label || 'Textures'}
                                  </Select.Trigger>
                                  <Select.Content>
                                    {#each ROOM_TEXTURE_KIND_OPTIONS as option}
                                      <Select.Item value={option.value}>{option.label}</Select.Item>
                                    {/each}
                                  </Select.Content>
                                </Select.Root>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onclick={() => requestRoomTextureUpload(roomTextureTargetKind)}
                                  disabled={roomTextureBusy}
                                >
                                  {roomTextureBusy ? 'Uploading…' : 'Upload Textures'}
                                </Button>
                              </div>
                              <div class="space-y-1">
                                <div class="flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
                                  <div class="flex items-center gap-1.5">
                                    <span>Room Height</span>
                                    <div
                                      onclick={(event) => {
                                        event.preventDefault()
                                        event.stopPropagation()
                                      }}
                                      aria-hidden="true"
                                    >
                                      <SettingsInfoMenu
                                        ariaLabel="About Room Height Texture Specs"
                                        contentClass="w-96"
                                      >
                                        <p>
                                          <strong>Single Fit ideal specs</strong>
                                        </p>
                                        <p>Floor and Ceiling: `2048x2048`</p>
                                        <p>Side walls at `100%`: `{ROOM_HEIGHT_PRESET_SPECS[100]}`</p>
                                        <p>Side walls at `75%`: `{ROOM_HEIGHT_PRESET_SPECS[75]}`</p>
                                        <p>Side walls at `50%`: `{ROOM_HEIGHT_PRESET_SPECS[50]}`</p>
                                        <p>
                                          <strong>Repeat mode</strong> works best with seamless square
                                          textures like `2048x2048` or `1024x1024`.
                                        </p>
                                        <p>
                                          Low ceilings can block orbit view. If that happens, use the
                                          Ceiling settings below to make it transparent or disable it.
                                        </p>
                                      </SettingsInfoMenu>
                                    </div>
                                  </div>
                                  <span>{roomHeightToPercent(builder.height ?? ROOM_DEFAULT_HEIGHT)}%</span>
                                </div>
                                <div class="grid grid-cols-3 gap-2">
                                  {#each ROOM_HEIGHT_PRESET_VALUES as preset}
                                    <Button
                                      variant={
                                        roomHeightToPresetValue(builder.height ?? ROOM_DEFAULT_HEIGHT) === preset
                                          ? 'secondary'
                                          : 'outline'
                                      }
                                      size="sm"

                                      onclick={() =>
                                        updateRoomShellBuilder(scene.id, (current) => ({
                                          ...current,
                                          height: roomPresetValueToHeight(preset)
                                        }))}
                                    >
                                      {preset}%
                                    </Button>
                                  {/each}
                                </div>
                                <div class="batshit-settings-child-label">
                                  Exact room-height presets keep `Single Fit` wall specs predictable.
                                </div>
                              </div>
                              <div class="space-y-1">
                                <div class="batshit-settings-child-label">Floor offset</div>
                                <input
                                  class="batshit-settings-range-input w-full"
                                  type="range"
                                  min="-3"
                                  max="3"
                                  step="0.05"
                                  value={builder.floorOffsetY ?? 0}
                                  oninput={(event) => {
                                    const value = Number((event.currentTarget as HTMLInputElement).value)
                                    updateRoomShellBuilder(scene.id, (current) => ({
                                      ...current,
                                      floorOffsetY: Number.isFinite(value) ? value : 0
                                    }))
                                  }}
                                />
                              </div>
                              {#snippet roomSurfaceSideEditor(args: {
                                title: string
                                side?: GoonRoomSurfaceSide
                                textureOptions: GoonFileRef[]
                                onTextureChange: (value: string) => void
                                onTransparencyChange: (value: string) => void
                                onMappingChange: (value: string) => void
                                onGridXChange: (value: number) => void
                                onGridYChange: (value: number) => void
                                onOpacityChange: (value: number) => void
                                showTrimTexture: boolean
                                trimOptions: GoonFileRef[]
                                onTrimTextureChange: (value: string) => void
                              })}
                                <div class="space-y-3">
                                  <div class="batshit-settings-child-label">
                                    {args.title}
                                  </div>
                                  <div class="grid gap-2 md:grid-cols-2">
                                    <div class="space-y-1">
                                      <div class="batshit-settings-child-label">Texture</div>
                                      <Select.Root
                                        type="single"
                                        value={args.side?.texture?.filename ?? ''}
                                        onValueChange={(value: string) => args.onTextureChange(value)}
                                      >
                                        <Select.Trigger class="batshit-settings-select-compact w-full">
                                          {args.side?.texture?.originalName || 'None'}
                                        </Select.Trigger>
                                        <Select.Content>
                                          <Select.Item value="">None</Select.Item>
                                          {#each args.textureOptions as texture}
                                            <Select.Item value={texture.filename}>
                                              {texture.originalName || texture.filename}
                                            </Select.Item>
                                          {/each}
                                        </Select.Content>
                                      </Select.Root>
                                    </div>
                                    <div class="space-y-1">
                                      <div class="batshit-settings-child-label">Transparency</div>
                                      <Select.Root
                                        type="single"
                                        value={args.side?.transparency ?? 'opaque'}
                                        onValueChange={(value: string) => args.onTransparencyChange(value)}
                                      >
                                        <Select.Trigger class="batshit-settings-select-compact w-full">
                                          {ROOM_TRANSPARENCY_OPTIONS.find(
                                            (option) =>
                                              option.value === (args.side?.transparency ?? 'opaque')
                                          )?.label || 'Opaque'}
                                        </Select.Trigger>
                                        <Select.Content>
                                          {#each ROOM_TRANSPARENCY_OPTIONS as option}
                                            <Select.Item value={option.value}>{option.label}</Select.Item>
                                          {/each}
                                        </Select.Content>
                                      </Select.Root>
                                      {#if args.side?.transparency === 'glass'}
                                        <div class="space-y-1 pt-2">
                                          <div class="batshit-settings-child-label">Opacity</div>
                                          <Input
                                            type="number"
                                            min="0.05"
                                            max="1"
                                            step="0.05"
                                            value={args.side?.opacity ?? 0.4}
                                            oninput={(event) =>
                                              args.onOpacityChange(
                                                Number((event.currentTarget as HTMLInputElement).value)
                                              )}
                                          />
                                        </div>
                                      {/if}
                                    </div>
                                  </div>
                                  <div class="grid gap-2 md:grid-cols-2">
                                    <div class="space-y-1">
                                      <div class="batshit-settings-child-label">Mapping</div>
                                      <Select.Root
                                        type="single"
                                        value={args.side?.fit ?? 'tile'}
                                        onValueChange={(value: string) => args.onMappingChange(value)}
                                      >
                                        <Select.Trigger class="batshit-settings-select-compact w-full">
                                          {ROOM_SURFACE_FIT_OPTIONS.find(
                                            (option) => option.value === (args.side?.fit ?? 'tile')
                                          )?.label || 'Repeat'}
                                        </Select.Trigger>
                                        <Select.Content>
                                          {#each ROOM_SURFACE_FIT_OPTIONS as option}
                                            <Select.Item value={option.value}>{option.label}</Select.Item>
                                          {/each}
                                        </Select.Content>
                                      </Select.Root>
                                    </div>
                                    <div class="space-y-1">
                                      <div class="batshit-settings-child-label">Grid</div>
                                      {#if args.side?.fit === 'tile'}
                                        <div class="grid grid-cols-2 gap-2">
                                          <Input
                                            type="number"
                                            min="0.1"
                                            step="0.1"
                                            aria-label={`${args.title} grid x`}
                                            value={args.side?.tileScale?.[0] ?? 1}
                                            oninput={(event) =>
                                              args.onGridXChange(
                                                Number((event.currentTarget as HTMLInputElement).value)
                                              )}
                                          />
                                          <Input
                                            type="number"
                                            min="0.1"
                                            step="0.1"
                                            aria-label={`${args.title} grid y`}
                                            value={args.side?.tileScale?.[1] ?? 1}
                                            oninput={(event) =>
                                              args.onGridYChange(
                                                Number((event.currentTarget as HTMLInputElement).value)
                                              )}
                                          />
                                        </div>
                                      {:else}
                                        <div class="batshit-goon-conditional-readout">
                                          Only used for Repeat
                                        </div>
                                      {/if}
                                    </div>
                                  </div>
                                  {#if args.showTrimTexture}
                                    <div class="space-y-1">
                                      <div class="batshit-settings-child-label">Trim Texture</div>
                                      <Select.Root
                                        type="single"
                                        value={args.side?.trimTexture?.filename ?? ''}
                                        onValueChange={(value: string) => args.onTrimTextureChange(value)}
                                      >
                                        <Select.Trigger class="batshit-settings-select-compact w-full">
                                          {args.side?.trimTexture?.originalName || 'Default (built-in)'}
                                        </Select.Trigger>
                                        <Select.Content>
                                          <Select.Item value="">Default (built-in)</Select.Item>
                                          {#each args.trimOptions as texture}
                                            <Select.Item value={texture.filename}>
                                              {texture.originalName || texture.filename}
                                            </Select.Item>
                                          {/each}
                                        </Select.Content>
                                      </Select.Root>
                                    </div>
                                  {/if}
                                </div>
                              {/snippet}
                              <div class={goonLevel2AccordionListClass}>
                              {#if builder}
                                {@const floorSurface = builder.surfaces?.floor}
                                {@const floorInterior = floorSurface?.interior}
                                {@const floorExterior = floorSurface?.exterior}
                                <Collapsible.Root open={roomBuilderSurfaceOpen === 'floor'} class={goonLevel2AccordionClass}>
                                  <Collapsible.Trigger
                                    class={goonLevel2AccordionHeaderClass}
                                    onclick={() => toggleRoomBuilderSurface('floor')}
                                  >
                                    <span class="batshit-settings-form-label">Floor</span>
                                    <ChevronDown
                                      class={`h-4 w-4 shrink-0 transition-transform ${roomBuilderSurfaceOpen === 'floor' ? 'rotate-180' : ''}`}
                                    />
                                  </Collapsible.Trigger>
                                  <Collapsible.Content class={goonLevel2AccordionContentClass}>
                                  <div class="batshit-goon-editor-subpanel is-compact space-y-3">
                                  <div class="flex items-center justify-between">
                                    <span class="batshit-settings-child-label">Enable Floor</span>
                                    <Switch.Root
                                      checked={Boolean(floorSurface?.enabled)}
                                      onCheckedChange={(checked) =>
                                        updateRoomSurface(scene.id, 'floor', { enabled: Boolean(checked) })}
                                    />
                                  </div>
                                  {@render roomSurfaceSideEditor({
                                    title: 'Interior',
                                    side: floorInterior,
                                    textureOptions: kitchenRoomTextures.floor ?? [],
                                    onTextureChange: (value: string) =>
                                      updateRoomSurfaceSide(scene.id, 'floor', 'interior', {
                                        texture: resolveRoomTexture('floor', value) ?? undefined
                                      }),
                                    onTransparencyChange: (value: string) =>
                                      updateRoomSurfaceSide(scene.id, 'floor', 'interior', {
                                        transparency: value as GoonRoomSurfaceSide['transparency']
                                      }),
                                    onMappingChange: (value: string) =>
                                      updateRoomSurfaceSide(scene.id, 'floor', 'interior', {
                                        fit: value as GoonRoomSurfaceSide['fit']
                                      }),
                                    onGridXChange: (value: number) =>
                                      updateRoomSurfaceSide(scene.id, 'floor', 'interior', {
                                        tileScale: [
                                          Number.isFinite(value) && value > 0 ? value : 1,
                                          floorInterior?.tileScale?.[1] ?? 1
                                        ]
                                      }),
                                    onGridYChange: (value: number) =>
                                      updateRoomSurfaceSide(scene.id, 'floor', 'interior', {
                                        tileScale: [
                                          floorInterior?.tileScale?.[0] ?? 1,
                                          Number.isFinite(value) && value > 0 ? value : 1
                                        ]
                                      }),
                                    onOpacityChange: (value: number) =>
                                      updateRoomSurfaceSide(scene.id, 'floor', 'interior', {
                                        opacity: Number.isFinite(value) ? value : 0.4
                                      }),
                                    showTrimTexture: false,
                                    trimOptions: [],
                                    onTrimTextureChange: () => {}
                                  })}
                                  <div class="batshit-goon-editor-divider">
                                    {@render roomSurfaceSideEditor({
                                      title: 'Exterior',
                                      side: floorExterior,
                                      textureOptions: kitchenRoomTextures.exterior ?? [],
                                      onTextureChange: (value: string) =>
                                        updateRoomSurfaceSide(scene.id, 'floor', 'exterior', {
                                          texture: resolveRoomTexture('exterior', value) ?? undefined
                                        }),
                                      onTransparencyChange: (value: string) =>
                                        updateRoomSurfaceSide(scene.id, 'floor', 'exterior', {
                                          transparency: value as GoonRoomSurfaceSide['transparency']
                                        }),
                                      onMappingChange: (value: string) =>
                                        updateRoomSurfaceSide(scene.id, 'floor', 'exterior', {
                                          fit: value as GoonRoomSurfaceSide['fit']
                                        }),
                                      onGridXChange: (value: number) =>
                                        updateRoomSurfaceSide(scene.id, 'floor', 'exterior', {
                                          tileScale: [
                                            Number.isFinite(value) && value > 0 ? value : 1,
                                            floorExterior?.tileScale?.[1] ?? 1
                                          ]
                                        }),
                                      onGridYChange: (value: number) =>
                                        updateRoomSurfaceSide(scene.id, 'floor', 'exterior', {
                                          tileScale: [
                                            floorExterior?.tileScale?.[0] ?? 1,
                                            Number.isFinite(value) && value > 0 ? value : 1
                                          ]
                                        }),
                                      onOpacityChange: (value: number) =>
                                        updateRoomSurfaceSide(scene.id, 'floor', 'exterior', {
                                          opacity: Number.isFinite(value) ? value : 0.4
                                        }),
                                      showTrimTexture: false,
                                      trimOptions: [],
                                      onTrimTextureChange: () => {}
                                    })}
                                  </div>
                                  </div>
                                </Collapsible.Content>
                              </Collapsible.Root>
                              {/if}
                              {#if builder}
                                {@const ceilingSurface = builder.surfaces?.ceiling}
                                {@const ceilingInterior = ceilingSurface?.interior}
                                {@const ceilingExterior = ceilingSurface?.exterior}
                                <Collapsible.Root open={roomBuilderSurfaceOpen === 'ceiling'} class={goonLevel2AccordionClass}>
                                  <Collapsible.Trigger
                                    class={goonLevel2AccordionHeaderClass}
                                    onclick={() => toggleRoomBuilderSurface('ceiling')}
                                  >
                                    <span class="batshit-settings-form-label">Ceiling</span>
                                    <ChevronDown
                                      class={`h-4 w-4 shrink-0 transition-transform ${roomBuilderSurfaceOpen === 'ceiling' ? 'rotate-180' : ''}`}
                                    />
                                  </Collapsible.Trigger>
                                  <Collapsible.Content class={goonLevel2AccordionContentClass}>
                                  <div class="batshit-goon-editor-subpanel is-compact space-y-3">
                                  <div class="flex items-center justify-between">
                                    <span class="batshit-settings-child-label">Enable Ceiling</span>
                                    <Switch.Root
                                      checked={Boolean(ceilingSurface?.enabled)}
                                      onCheckedChange={(checked) =>
                                        updateRoomSurface(scene.id, 'ceiling', { enabled: Boolean(checked) })}
                                    />
                                  </div>
                                  {@render roomSurfaceSideEditor({
                                    title: 'Interior',
                                    side: ceilingInterior,
                                    textureOptions: kitchenRoomTextures.ceiling ?? [],
                                    onTextureChange: (value: string) =>
                                      updateRoomSurfaceSide(scene.id, 'ceiling', 'interior', {
                                        texture: resolveRoomTexture('ceiling', value) ?? undefined
                                      }),
                                    onTransparencyChange: (value: string) =>
                                      updateRoomSurfaceSide(scene.id, 'ceiling', 'interior', {
                                        transparency: value as GoonRoomSurfaceSide['transparency']
                                      }),
                                    onMappingChange: (value: string) =>
                                      updateRoomSurfaceSide(scene.id, 'ceiling', 'interior', {
                                        fit: value as GoonRoomSurfaceSide['fit']
                                      }),
                                    onGridXChange: (value: number) =>
                                      updateRoomSurfaceSide(scene.id, 'ceiling', 'interior', {
                                        tileScale: [
                                          Number.isFinite(value) && value > 0 ? value : 1,
                                          ceilingInterior?.tileScale?.[1] ?? 1
                                        ]
                                      }),
                                    onGridYChange: (value: number) =>
                                      updateRoomSurfaceSide(scene.id, 'ceiling', 'interior', {
                                        tileScale: [
                                          ceilingInterior?.tileScale?.[0] ?? 1,
                                          Number.isFinite(value) && value > 0 ? value : 1
                                        ]
                                      }),
                                    onOpacityChange: (value: number) =>
                                      updateRoomSurfaceSide(scene.id, 'ceiling', 'interior', {
                                        opacity: Number.isFinite(value) ? value : 0.4
                                      }),
                                    showTrimTexture: false,
                                    trimOptions: [],
                                    onTrimTextureChange: () => {}
                                  })}
                                  <div class="batshit-goon-editor-divider">
                                    {@render roomSurfaceSideEditor({
                                      title: 'Exterior',
                                      side: ceilingExterior,
                                      textureOptions: kitchenRoomTextures.exterior ?? [],
                                      onTextureChange: (value: string) =>
                                        updateRoomSurfaceSide(scene.id, 'ceiling', 'exterior', {
                                          texture: resolveRoomTexture('exterior', value) ?? undefined
                                        }),
                                      onTransparencyChange: (value: string) =>
                                        updateRoomSurfaceSide(scene.id, 'ceiling', 'exterior', {
                                          transparency: value as GoonRoomSurfaceSide['transparency']
                                        }),
                                      onMappingChange: (value: string) =>
                                        updateRoomSurfaceSide(scene.id, 'ceiling', 'exterior', {
                                          fit: value as GoonRoomSurfaceSide['fit']
                                        }),
                                      onGridXChange: (value: number) =>
                                        updateRoomSurfaceSide(scene.id, 'ceiling', 'exterior', {
                                          tileScale: [
                                            Number.isFinite(value) && value > 0 ? value : 1,
                                            ceilingExterior?.tileScale?.[1] ?? 1
                                          ]
                                        }),
                                      onGridYChange: (value: number) =>
                                        updateRoomSurfaceSide(scene.id, 'ceiling', 'exterior', {
                                          tileScale: [
                                            ceilingExterior?.tileScale?.[0] ?? 1,
                                            Number.isFinite(value) && value > 0 ? value : 1
                                          ]
                                        }),
                                      onOpacityChange: (value: number) =>
                                        updateRoomSurfaceSide(scene.id, 'ceiling', 'exterior', {
                                          opacity: Number.isFinite(value) ? value : 0.4
                                        }),
                                      showTrimTexture: false,
                                      trimOptions: [],
                                      onTrimTextureChange: () => {}
                                    })}
                                  </div>
                                  </div>
                                </Collapsible.Content>
                              </Collapsible.Root>
                              {/if}
                                {#each ROOM_WALL_LABELS as wall}
                                  {@const wallSurface = builder.surfaces?.walls?.[wall.key]}
                                  {@const wallInterior = wallSurface?.interior}
                                  {@const wallExterior = wallSurface?.exterior}
                                  <Collapsible.Root open={roomBuilderSurfaceOpen === wall.key} class={goonLevel2AccordionClass}>
                                    <Collapsible.Trigger
                                      class={goonLevel2AccordionHeaderClass}
                                      onclick={() => toggleRoomBuilderSurface(wall.key)}
                                    >
                                      <span class="batshit-settings-form-label">{wall.label}</span>
                                      <ChevronDown
                                        class={`h-4 w-4 shrink-0 transition-transform ${roomBuilderSurfaceOpen === wall.key ? 'rotate-180' : ''}`}
                                      />
                                    </Collapsible.Trigger>
                                    <Collapsible.Content class={goonLevel2AccordionContentClass}>
                                    <div class="batshit-goon-editor-subpanel is-compact space-y-3">
                                      <div class="flex items-center justify-between">
                                        <span class="batshit-settings-child-label">Enable {wall.label}</span>
                                        <Switch.Root
                                          checked={Boolean(wallSurface?.enabled)}
                                          onCheckedChange={(checked) =>
                                            updateRoomWallSurface(scene.id, wall.key, { enabled: Boolean(checked) })}
                                        />
                                      </div>
                                      {@render roomSurfaceSideEditor({
                                        title: 'Interior',
                                        side: wallInterior,
                                        textureOptions: kitchenRoomTextures.wall ?? [],
                                        onTextureChange: (value: string) =>
                                          updateRoomWallSurfaceSide(scene.id, wall.key, 'interior', {
                                            texture: resolveRoomTexture('wall', value) ?? undefined
                                          }),
                                        onTransparencyChange: (value: string) =>
                                          updateRoomWallSurfaceSide(scene.id, wall.key, 'interior', {
                                            transparency: value as GoonRoomSurfaceSide['transparency']
                                          }),
                                        onMappingChange: (value: string) =>
                                          updateRoomWallSurfaceSide(scene.id, wall.key, 'interior', {
                                            fit: value as GoonRoomSurfaceSide['fit']
                                          }),
                                        onGridXChange: (value: number) =>
                                          updateRoomWallSurfaceSide(scene.id, wall.key, 'interior', {
                                            tileScale: [
                                              Number.isFinite(value) && value > 0 ? value : 1,
                                              wallInterior?.tileScale?.[1] ?? 1
                                            ]
                                          }),
                                        onGridYChange: (value: number) =>
                                          updateRoomWallSurfaceSide(scene.id, wall.key, 'interior', {
                                            tileScale: [
                                              wallInterior?.tileScale?.[0] ?? 1,
                                              Number.isFinite(value) && value > 0 ? value : 1
                                            ]
                                          }),
                                        onOpacityChange: (value: number) =>
                                          updateRoomWallSurfaceSide(scene.id, wall.key, 'interior', {
                                            opacity: Number.isFinite(value) ? value : 0.4
                                          }),
                                        showTrimTexture: wallInterior?.transparency === 'cutout',
                                        trimOptions: kitchenRoomTextures.trim ?? [],
                                        onTrimTextureChange: (value: string) =>
                                          updateRoomWallSurfaceSide(scene.id, wall.key, 'interior', {
                                            trimTexture: resolveRoomTexture('trim', value) ?? undefined
                                          })
                                      })}
                                      <div class="batshit-goon-editor-divider">
                                        {@render roomSurfaceSideEditor({
                                          title: 'Exterior',
                                          side: wallExterior,
                                          textureOptions: kitchenRoomTextures.exterior ?? [],
                                          onTextureChange: (value: string) =>
                                            updateRoomWallSurfaceSide(scene.id, wall.key, 'exterior', {
                                              texture: resolveRoomTexture('exterior', value) ?? undefined
                                            }),
                                          onTransparencyChange: (value: string) =>
                                            updateRoomWallSurfaceSide(scene.id, wall.key, 'exterior', {
                                              transparency: value as GoonRoomSurfaceSide['transparency']
                                            }),
                                          onMappingChange: (value: string) =>
                                            updateRoomWallSurfaceSide(scene.id, wall.key, 'exterior', {
                                              fit: value as GoonRoomSurfaceSide['fit']
                                            }),
                                          onGridXChange: (value: number) =>
                                            updateRoomWallSurfaceSide(scene.id, wall.key, 'exterior', {
                                              tileScale: [
                                                Number.isFinite(value) && value > 0 ? value : 1,
                                                wallExterior?.tileScale?.[1] ?? 1
                                              ]
                                            }),
                                          onGridYChange: (value: number) =>
                                            updateRoomWallSurfaceSide(scene.id, wall.key, 'exterior', {
                                              tileScale: [
                                                wallExterior?.tileScale?.[0] ?? 1,
                                                Number.isFinite(value) && value > 0 ? value : 1
                                              ]
                                            }),
                                          onOpacityChange: (value: number) =>
                                            updateRoomWallSurfaceSide(scene.id, wall.key, 'exterior', {
                                              opacity: Number.isFinite(value) ? value : 0.4
                                            }),
                                          showTrimTexture: false,
                                          trimOptions: [],
                                          onTrimTextureChange: () => {}
                                        })}
                                      </div>
                                    </div>
                                    </Collapsible.Content>
                                  </Collapsible.Root>
                                {/each}
                              </div>
                            </div>
                          {/if}
                        </Collapsible.Content>
                      </Collapsible.Root>
                    </div>
                    <div class="mt-2 space-y-2">
                      <Collapsible.Root bind:open={scenePropsOpen} class={goonLevel1AccordionClass}>
                        <Collapsible.Trigger
                          class={goonLevel1AccordionHeaderClass}
                          onclick={() => toggleSceneSection('props')}
                        >
                          <div class="flex items-center gap-1.5">
                            <span class="batshit-settings-form-label">Props</span>
                            <div
                              onclick={(event) => {
                                event.preventDefault()
                                event.stopPropagation()
                              }}
                              aria-hidden="true"
                            >
                              <SettingsInfoMenu ariaLabel="About Props" contentClass="w-96">
                                <p>
                                  Props are scene objects like furniture, decor, signs, or any other
                                  GLB/GLTF items you want inside the room.
                                </p>
                                <p>Drag gizmo to move, rotate, or scale.</p>
                                <p>Move stays freehand, but scale and rotation still update live.</p>
                                <p>Rotation is shown live in degrees.</p>
                                <p>Scale stays locked to the prop’s proportions while you drag.</p>
                                <p>
                                  `Apply` commits the current transform into the Scene draft. `Save
                                  Scene` is still the real final save.
                                </p>
                              </SettingsInfoMenu>
                            </div>
                          </div>
                        </Collapsible.Trigger>
                        <Collapsible.Content class={`${goonLevel1AccordionContentClass} space-y-2`}>
                          <div class="flex items-center gap-2">
                            <Button
                              variant="outline"
                              size="sm"
                              onclick={() => requestScenePropUpload(scene.id)}
                              disabled={scenePropBusy}
                            >
                              {scenePropBusy ? 'Uploading…' : 'Add Prop'}
                            </Button>
                            <span class="batshit-settings-child-label">GLB/GLTF furniture or decor.</span>
                          </div>
                          {#if (scene.props ?? []).length === 0}
                            <div class="batshit-settings-child-label">No props yet.</div>
                          {:else}
                            <div class="space-y-2">
                              {#each scene.props ?? [] as prop (prop.id)}
                                <div class="batshit-goon-editor-subpanel is-compact space-y-2">
                                  <div class="flex items-center gap-2">
                                    <Input
                                      value={prop.name}
                                      oninput={(event) => {
                                        const value = (event.currentTarget as HTMLInputElement).value
                                        updateSceneProp(scene.id, prop.id, { name: value })
                                      }}
                                    />
                                    <Button
                                      variant="ghost"
                                      size="icon"

                                      aria-label={`Remove ${prop.name}`}
                                      title="Remove Prop"
                                      onclick={() => removeSceneProp(scene.id, prop.id)}
                                    >
                                      <Trash2  />
                                    </Button>
                                  </div>
                                  <div class="flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
                                    <Button
                                      variant={
                                        activeSceneEdit?.type === 'prop' &&
                                        activeSceneEdit.propId === prop.id
                                          ? 'secondary'
                                          : 'outline'
                                      }
                                      size="sm"
                                      onclick={() => beginPropEdit(scene.id, prop.id)}
                                    >
                                      {activeSceneEdit?.type === 'prop' &&
                                      activeSceneEdit.propId === prop.id
                                        ? 'Editing'
                                        : 'Edit'}
                                    </Button>
                                    {#if activeSceneEdit?.type === 'prop' &&
                                    activeSceneEdit.propId === prop.id}
                                      <div class="space-y-2">
                                        <div class="flex flex-wrap items-center gap-1">
                                          <Button
                                            variant={sceneEditMode === 'translate' ? 'secondary' : 'outline'}
                                            size="sm"
                                            onclick={() => setSceneEditMode('translate')}
                                          >
                                            <ArrowDownUp aria-hidden="true" />
                                            Move
                                          </Button>
                                          <Button
                                            variant={sceneEditMode === 'rotate' ? 'secondary' : 'outline'}
                                            size="sm"
                                            onclick={() => setSceneEditMode('rotate')}
                                          >
                                            <RotateCcw aria-hidden="true" />
                                            Rotate
                                          </Button>
                                          <Button
                                            variant={sceneEditMode === 'scale' ? 'secondary' : 'outline'}
                                            size="sm"
                                            onclick={() => setSceneEditMode('scale')}
                                          >
                                            <FlipHorizontal2 aria-hidden="true" />
                                            Scale
                                          </Button>
                                          <Button variant="outline" size="sm" onclick={saveSceneEdit}>
                                            <Check aria-hidden="true" />
                                            Apply
                                          </Button>
                                          <Button variant="outline" size="sm" onclick={cancelSceneEdit}>
                                            <X aria-hidden="true" />
                                            Cancel
                                          </Button>
                                        </div>
                                        <div class="batshit-goon-transform-readout space-y-2">
                                          <div class="flex flex-wrap items-center justify-between gap-2">
                                            <div class="batshit-settings-inline-strong">Transform Readout</div>
                                            <div class="flex items-center gap-2">
                                              <span class="text-muted-foreground">Lock proportions</span>
                                              <Switch.Root
                                                checked={scenePropScaleLock}
                                                onCheckedChange={setScenePropScaleLock}
                                              />
                                            </div>
                                          </div>
                                          {#if activeSceneEditTransform}
                                            <div class="grid grid-cols-2 gap-2 md:grid-cols-3">
                                              <div class="batshit-goon-transform-cell">
                                                <div class="uppercase text-muted-foreground">Scale X</div>
                                                <div class="batshit-settings-inline-strong">
                                                  {formatScalePercent(activeSceneEditTransform.scale[0])}
                                                </div>
                                              </div>
                                              <div class="batshit-goon-transform-cell">
                                                <div class="uppercase text-muted-foreground">Scale Y</div>
                                                <div class="batshit-settings-inline-strong">
                                                  {formatScalePercent(activeSceneEditTransform.scale[1])}
                                                </div>
                                              </div>
                                              <div class="batshit-goon-transform-cell">
                                                <div class="uppercase text-muted-foreground">Scale Z</div>
                                                <div class="batshit-settings-inline-strong">
                                                  {formatScalePercent(activeSceneEditTransform.scale[2])}
                                                </div>
                                              </div>
                                              <div class="batshit-goon-transform-cell">
                                                <div class="uppercase text-muted-foreground">Rotate X</div>
                                                <div class="batshit-settings-inline-strong">
                                                  {formatRotationDegrees(activeSceneEditTransform.rotation[0])}
                                                </div>
                                              </div>
                                              <div class="batshit-goon-transform-cell">
                                                <div class="uppercase text-muted-foreground">Rotate Y</div>
                                                <div class="batshit-settings-inline-strong">
                                                  {formatRotationDegrees(activeSceneEditTransform.rotation[1])}
                                                </div>
                                              </div>
                                              <div class="batshit-goon-transform-cell">
                                                <div class="uppercase text-muted-foreground">Rotate Z</div>
                                                <div class="batshit-settings-inline-strong">
                                                  {formatRotationDegrees(activeSceneEditTransform.rotation[2])}
                                                </div>
                                              </div>
                                            </div>
                                          {/if}
                                        </div>
                                      </div>
                                    {/if}
                                  </div>
                                </div>
                              {/each}
                            </div>
                          {/if}
                        </Collapsible.Content>
                      </Collapsible.Root>
                    </div>
                    <div class="mt-2 space-y-2">
                      <Collapsible.Root bind:open={sceneMarkersOpen} class={goonLevel1AccordionClass}>
                        <Collapsible.Trigger
                          class={goonLevel1AccordionHeaderClass}
                          onclick={() => toggleSceneSection('markers')}
                        >
                          <div class="flex items-center gap-1.5">
                            <span class="batshit-settings-form-label">Markers</span>
                            <div
                              onclick={(event) => {
                                event.preventDefault()
                                event.stopPropagation()
                              }}
                              aria-hidden="true"
                            >
                              <SettingsInfoMenu ariaLabel="About Markers" contentClass="w-96">
                                <p>
                                  Markers tell Batshit where a Goon should be placed for different
                                  Motion postures like `Sitting`, `Lying`, or any custom posture you
                                  create in `Motions`.
                                </p>
                                <p>
                                  Markers are now positioned by moving the real Goon in the Live
                                  Preview: middle mouse moves across the floor, right-click turns the
                                  Goon, and the vertical nudge control fine-tunes height.
                                </p>
                                <p>
                                  Marker authoring only allows Motions already tagged with that same
                                  posture, so placement always happens with a matching Motion.
                                </p>
                                <p>
                                  Prop linking does not place the Marker. It only decides whether the
                                  saved Marker should keep following a prop later if that prop moves.
                                </p>
                              </SettingsInfoMenu>
                            </div>
                          </div>
                        </Collapsible.Trigger>
                      <Collapsible.Content class={`${goonLevel1AccordionContentClass} space-y-2`}>
                          {#each markerPostures as posture}
                            {@const postureMotionNames = resolveMarkerMotionNamesForPosture(posture, kitchenPreviewGoon)}
                            <div class="space-y-2">
                              <div class="flex items-center justify-between">
                                <span class="batshit-settings-child-label">
                                  {getPostureLabel(posture)}
                                </span>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onclick={() => addSceneMarker(scene.id, posture)}
                                  disabled={
                                    scenePreviewBodyMode !== 'active-goon' ||
                                    !kitchenPreviewGoonId ||
                                    postureMotionNames.length === 0 ||
                                    activeSceneEdit?.type === 'marker'
                                  }
                                >
                                  <Plus aria-hidden="true" />

                                  Add
                                </Button>
                              </div>
                              {#if scenePreviewBodyMode !== 'active-goon'}
                                <div class="batshit-settings-child-label">
                                  Preview with active Goon before creating Markers.
                                </div>
                              {:else if !kitchenPreviewGoonId}
                                <div class="batshit-settings-child-label">
                                  Select a preview Goon first so Batshit can position this Marker with
                                  a real Motion.
                                </div>
                              {:else if postureMotionNames.length === 0}
                                <div class="batshit-settings-child-label">
                                  Add a Motion tagged `{getPostureLabel(posture)}` in `Motions`
                                  before creating Markers for this posture.
                                </div>
                              {/if}
                              {#if (scene.markers?.[posture] ?? []).length > 0}
                                <div class="space-y-2">
                                  {#each scene.markers?.[posture] ?? [] as marker (marker.id)}
                                    {@const markerPositioned = isMarkerPositioned(marker)}
                                    {@const markerLocked = marker.propLocked === true}
                                    {@const markerIsActive =
                                      activeSceneEdit?.type === 'marker' &&
                                      activeSceneEdit.markerId === marker.id}
                                    <div class="batshit-goon-editor-subpanel is-compact space-y-2">
                                      {#if markerPositioned && !markerIsActive}
                                        <div class="flex items-center gap-2">
                                          <Select.Root
                                            type="single"
                                            value={marker.propId ?? ''}
                                            onValueChange={(value: string) => {
                                              void updateSceneMarkerPropBinding(
                                                scene.id,
                                                posture,
                                                marker.id,
                                                value || undefined
                                              )
                                            }}
                                            disabled={markerLocked}
                                          >
                                            <Select.Trigger class="batshit-settings-select-compact w-full">
                                              {marker.propId
                                                ? scene.props?.find((prop) => prop.id === marker.propId)
                                                    ?.name || 'Prop'
                                                : 'No Prop'}
                                            </Select.Trigger>
                                            <Select.Content>
                                              <Select.Item value="">No Prop</Select.Item>
                                              {#each scene.props ?? [] as prop}
                                                <Select.Item value={prop.id}>{prop.name}</Select.Item>
                                              {/each}
                                            </Select.Content>
                                          </Select.Root>
                                          <Button
                                            variant="ghost"
                                            size="icon"

                                            aria-label="Remove Marker"
                                            title="Remove Marker"
                                            onclick={() =>
                                              removeSceneMarker(scene.id, posture, marker.id)}
                                          >
                                            <Trash2  />
                                          </Button>
                                        </div>
                                        {#if !markerLocked}
                                          <p class="batshit-settings-warning-text text-[10px]">
                                            {markerBindingWarning}
                                          </p>
                                        {/if}
                                      {:else}
                                        <div class="flex items-center justify-between gap-2 rounded-md border border-dashed bg-background/40 px-3 py-2 text-[10px] text-muted-foreground">
                                          <span>
                                            {markerIsActive
                                              ? 'Apply this position before choosing whether the Marker should use a prop.'
                                              : 'Apply a stage position first. Prop-link comes after placement.'}
                                          </span>
                                          <Button
                                            variant="ghost"
                                            size="icon"

                                            aria-label="Remove Marker"
                                            title="Remove Marker"
                                            onclick={() =>
                                              removeSceneMarker(scene.id, posture, marker.id)}
                                          >
                                            <Trash2  />
                                          </Button>
                                        </div>
                                      {/if}
                                      <div class="flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
                                        {#if markerLocked && !markerIsActive}
                                          <div class="flex flex-wrap items-center gap-2">
                                            <span class="batshit-settings-inline-strong inline-flex items-center gap-1">
                                              <Check class="batshit-settings-success-text h-3.5 w-3.5" />
                                              Marker Position Set
                                            </span>
                                            <span class="inline-flex items-center text-muted-foreground">
                                              <Lock class="h-3.5 w-3.5" />
                                            </span>
                                            <SettingsInfoMenu
                                              ariaLabel="About locked marker choices"
                                              tone="amber"
                                              contentClass="w-80"
                                            >
                                              <p>{markerLockDetails}</p>
                                            </SettingsInfoMenu>
                                          </div>
                                        {/if}
                                        {#if markerIsActive}
                                          <Badge variant="outline">Positioning</Badge>
                                          <div class="flex flex-wrap items-center gap-1">
                                            <Button
                                              variant="outline"
                                              size="sm"
                                              onclick={saveMarkerPlacement}
                                            >
                                              <Check aria-hidden="true" />
                                              Apply Position
                                            </Button>
                                            <Button
                                              variant="outline"
                                              size="sm"
                                              onclick={() => void cancelMarkerPlacement()}
                                            >
                                              <X aria-hidden="true" />

                                              Cancel
                                            </Button>
                                          </div>
                                          <p class="batshit-settings-child-label">
                                            Use the preview controls to place the Goon, then save the
                                            current position.
                                          </p>
                                          <p class="batshit-settings-warning-text text-[10px]">
                                            {markerApplyWarning}
                                          </p>
                                        {:else if !markerPositioned}
                                          <span class="text-muted-foreground">
                                            Positioning did not complete. Delete this Marker and add it again.
                                          </span>
                                        {/if}
                                      </div>
                                    </div>
                                  {/each}
                                </div>
                              {/if}
                            </div>
                          {/each}
                        </Collapsible.Content>
                      </Collapsible.Root>
                    </div>
                  </div>
                </div>
              {/if}
            {/each}
          {/if}
          </div>
          </div>
          <div class="batshit-settings-footer-bar shrink-0">
            <div class="flex justify-end gap-2">
              <Button variant="ghost" onclick={discardSceneChanges}>
                <X aria-hidden="true" />
                Cancel
              </Button>
              <Button
                variant="outline"
                onclick={() => requestWorkspaceExit({ type: 'close-scene' })}
              >
                <X aria-hidden="true" />
                Close Scene
              </Button>
              <Button
                onclick={saveActiveGoonsChanges}
                disabled={
                  (!sceneDirty && !sceneCreateDirty) ||
                  sceneSaving ||
                  activeSceneEdit?.type === 'marker' ||
                  hasPendingMarkerDrafts()
                }
              >
                {scenePrimaryActionLabel}
              </Button>
            </div>
          </div>
        </div>
        <SettingsLivePreviewPane
          bind:host={kitchenPreviewContainer}
          width={previewWidth}
          resizing={previewResizing}
          resizeAriaLabel="Resize scene preview"
          onResizeStart={startPreviewResize}
          runtimeBadge={resolveRendererBadge(kitchenPreviewRuntimeStatus)}
          loading={kitchenPreviewLoading}
          error={kitchenPreviewError}
          emptyMessage={
            sceneEditorMode === 'create'
              ? 'Create the scene to preview it.'
              : !sceneEditorId
                ? 'Select a scene to preview.'
                : scenePreviewBodyMode === 'active-goon' && !kitchenPreviewGoonId
                  ? 'Select a Goon to preview.'
                  : null
          }
          wrapperClass="h-full min-h-0 batshit-settings-preview-shell"
        >
          {#snippet overlay()}
            {#if activeSceneEdit?.type === 'marker'}
              <div class="batshit-goon-floating-popover">
                <div class="space-y-2">
                  <div class="flex items-center justify-between gap-2 text-[10px]">
                    <span class="batshit-settings-inline-strong">Vertical nudge</span>
                    <span class="text-muted-foreground">
                      {activeMarkerVerticalOffset > 0 ? '+' : ''}{activeMarkerVerticalOffset.toFixed(2)}
                    </span>
                  </div>
                  <input
                    type="range"
                    min="-1"
                    max="1"
                    step="0.01"
                    value={-activeMarkerVerticalOffset}
                    class="batshit-settings-range-input h-32 w-full [writing-mode:vertical-lr]"
                    oninput={(event) =>
                      updateMarkerVerticalOffset(
                        -Number((event.currentTarget as HTMLInputElement).value)
                      )}
                  />
                  <p class="batshit-settings-child-label">
                    Middle mouse moves on the floor. Right-click turns the Goon. This only adjusts
                    height.
                  </p>
                </div>
              </div>
            {/if}
          {/snippet}
          <div class="flex items-center gap-1 min-w-0 flex-1">
            <Button
              variant={scenePreviewBodyMode === 'proxy' ? 'secondary' : 'outline'}
              size="sm"
              onclick={() => setScenePreviewBodyMode('proxy')}
              disabled={Boolean(activeSceneEdit)}
              aria-label="Use scale proxy"
              title={
                activeSceneEdit
                  ? 'Apply or cancel the active scene edit before changing preview body.'
                  : 'Use scale proxy'
              }
            >
              <PersonStanding aria-hidden="true" />
              <span class="hidden xl:inline">Proxy</span>
            </Button>
            <Button
              variant={scenePreviewBodyMode === 'active-goon' ? 'secondary' : 'outline'}
              size="sm"
              onclick={() => setScenePreviewBodyMode('active-goon')}
              disabled={goons.length === 0 || Boolean(activeSceneEdit)}
              aria-label="Preview with active Goon"
              title={
                activeSceneEdit
                  ? 'Apply or cancel the active scene edit before changing preview body.'
                  : goons.length === 0
                    ? 'No Goons available'
                    : 'Preview with active Goon'
              }
            >
              <BatshitIcon id="goons" class="h-4 w-4" />
              <span class="hidden xl:inline">Active Goon</span>
            </Button>

            {#if scenePreviewBodyMode === 'proxy'}
              <Button
                variant={sceneProxyPoseId === 'stand' ? 'secondary' : 'outline'}
                size="sm"
                onclick={() => setSceneProxyPose('stand')}
                disabled={Boolean(activeSceneEdit)}
                aria-label="Use standing proxy pose"
                title={
                  activeSceneEdit
                    ? 'Apply or cancel the active scene edit before changing proxy pose.'
                    : 'Standing proxy pose'
                }
              >
                <PersonStanding aria-hidden="true" />
                <span class="hidden xl:inline">Stand</span>
              </Button>
              <Button
                variant={sceneProxyPoseId === 'sit' ? 'secondary' : 'outline'}
                size="sm"
                onclick={() => setSceneProxyPose('sit')}
                disabled={Boolean(activeSceneEdit)}
                aria-label="Use seated proxy pose"
                title={
                  activeSceneEdit
                    ? 'Apply or cancel the active scene edit before changing proxy pose.'
                    : 'Seated proxy pose'
                }
              >
                <Armchair aria-hidden="true" />
                <span class="hidden xl:inline">Sit</span>
              </Button>
            {/if}

            {#if scenePreviewBodyMode === 'active-goon'}
              <DropdownMenu.Root>
                <DropdownMenu.Trigger
                  class="batshit-settings-icon-trigger"
                  disabled={goons.length === 0}
                  aria-label="Select preview Goon"
                  title={`Preview Goon: ${kitchenPreviewGoon?.name || 'None'}`}
                >
                  <BatshitIcon id="goons" class="h-4 w-4" />
                </DropdownMenu.Trigger>
                <DropdownMenu.Content align="start" class="min-w-[220px] max-w-[360px]">
                  {#if goons.length > 0}
                    {#each goons as goonEntry (goonEntry.id)}
                      <DropdownMenu.Item onSelect={() => handleScenePreviewGoonSelect(goonEntry.id)}>
                        <span class="truncate">
                          {goonEntry.name || 'Unnamed Goon'}{kitchenPreviewGoonId === goonEntry.id ? ' • Current' : ''}
                        </span>
                      </DropdownMenu.Item>
                    {/each}
                  {:else}
                    <DropdownMenu.Item disabled>
                      <span class="text-muted-foreground">No goons available</span>
                    </DropdownMenu.Item>
                  {/if}
                </DropdownMenu.Content>
              </DropdownMenu.Root>

              <DropdownMenu.Root>
                <DropdownMenu.Trigger
                  class="batshit-settings-icon-trigger"
                  disabled={!kitchenPreviewGoonId || kitchenAvailableAnimationNames.length === 0}
                  aria-label="Select preview Motion"
                  title={
                    kitchenPreviewAnimationName
                      ? `Preview Motion: ${kitchenPreviewAnimationName}`
                      : 'Select preview Motion'
                  }
                >
                  <BatshitIcon id="motions" class="h-4 w-4" />
                </DropdownMenu.Trigger>
                <DropdownMenu.Content align="start" class="min-w-[240px] max-h-[320px] overflow-y-auto">
                  {#if kitchenAvailableAnimationNames.length > 0}
                    {#each kitchenAvailableAnimationNames as animationName}
                      <DropdownMenu.Item
                        onSelect={() => {
                          kitchenPreviewAnimationName = animationName
                          void triggerKitchenPreviewAnimation()
                        }}
                      >
                        <span class="truncate">
                          {animationName}{kitchenPreviewAnimationName === animationName ? ' • Current' : ''}
                        </span>
                      </DropdownMenu.Item>
                    {/each}
                  {:else}
                    <DropdownMenu.Item disabled>
                      <span class="text-muted-foreground">No motions available</span>
                    </DropdownMenu.Item>
                  {/if}
                </DropdownMenu.Content>
              </DropdownMenu.Root>
            {/if}

            <Button
              variant="ghost"
              size="sm"

              onclick={() => void resetKitchenPreviewAll()}
              disabled={
                (scenePreviewBodyMode === 'active-goon' && !kitchenPreviewGoonId) ||
                activeSceneEdit?.type === 'marker'
              }
              aria-label="Reset preview view controls and clear animation preview"
              title={
                activeSceneEdit?.type === 'marker'
                  ? 'Save or cancel marker positioning before resetting the preview.'
                  : 'Reset preview view controls and clear animation preview'
              }
            >
              <RotateCcw  />
            </Button>
          </div>
          <SettingsPreviewViewControls
            disabled={scenePreviewBodyMode === 'active-goon' && !kitchenPreviewGoonId}
            eyeContactEnabled={settingsPreviewEyeContactEnabled}
            onEyeContactToggle={() => {
              settingsPreviewEyeContactEnabled = !settingsPreviewEyeContactEnabled
            }}
            fov={previewViewFov}
            minFov={MIN_PREVIEW_VIEW_FOV}
            maxFov={MAX_PREVIEW_VIEW_FOV}
            onFovChange={handlePreviewFovChange}
            onFramePreset={handleKitchenPreviewFramePreset}
            cameraMode={previewCameraMode}
            indoorCameraAvailable={kitchenPreviewEngine?.canUseIndoorCamera() ?? false}
            onCameraModeChange={(mode) => handlePreviewCameraModeChange(kitchenPreviewEngine, mode, false)}
            quality={kitchenPreviewQuality}
            qualityOptions={qualityOptions}
            onQualityChange={(value) => {
              kitchenPreviewQuality = value
            }}
          />
	        </SettingsLivePreviewPane>
	      </div>
{/if}
      <GoonsDeleteDialogs
        bind:sceneDeleteConfirmOpen
        bind:closetDeleteConfirmOpen
        {scenePendingDelete}
        {closetPendingDelete}
        {closetDeleteBusyId}
        onClearScenePendingDelete={() => (scenePendingDelete = null)}
        onClearClosetPendingDelete={() => (closetPendingDelete = null)}
        onConfirmDeleteScene={confirmDeleteScene}
        onConfirmRemoveClosetItem={confirmRemoveClosetItem}
      />

      <GoonsUnsavedExitDialog
        bind:open={unsavedExitDialogOpen}
        title={unsavedExitTitle}
        description={unsavedExitDescription}
        saving={unsavedExitSaving}
        continueLabel={unsavedExitContinueLabel}
        onClose={closeUnsavedExitDialog}
        onDiscard={discardAndContinueExit}
        onSave={saveAndContinueExit}
      />

      <Dialog.Root
        open={motionReplaceConflicts.length > 0}
        onOpenChange={(nextOpen) => {
          if (!nextOpen && !motionReplaceBusy) {
            skipMotionReplacements()
          }
        }}
      >
        <Dialog.Content class="sm:max-w-md">
          <Dialog.Header>
            <Dialog.Title>
              {motionReplaceConflicts.length === 1
                ? 'Replace this motion version?'
                : `Replace ${motionReplaceConflicts.length} motion versions?`}
            </Dialog.Title>
            <Dialog.Description>
              {motionReplaceConflicts.length === 1
                ? 'Your library already has this format of this motion.'
                : 'Your library already has these formats of these motions.'}
              Replacing swaps the animation file but keeps the motion's name, tags, and
              settings. To keep both versions instead, skip and rename the
              {motionReplaceConflicts.length === 1 ? 'file' : 'files'} before uploading again.
            </Dialog.Description>
          </Dialog.Header>
          <div class="max-h-48 space-y-1 overflow-y-auto text-sm text-muted-foreground">
            {#each motionReplaceConflicts as conflict (conflict.file.name + conflict.laneLabel)}
              <p class="break-all">
                <span class="text-foreground">{conflict.motionName}</span>
                <Badge variant="outline" class="batshit-settings-child-label ml-1.5">
                  {conflict.laneLabel}
                </Badge>
              </p>
            {/each}
          </div>
          <Dialog.Footer class="gap-2">
            <Button
              variant="ghost"
              type="button"
              onclick={skipMotionReplacements}
              disabled={motionReplaceBusy}
            >
              <X aria-hidden="true" />

              Skip These
            </Button>
            <Button
              type="button"
              onclick={() => void confirmMotionReplacements()}
              disabled={motionReplaceBusy}
            >
              {motionReplaceBusy
                ? 'Replacing…'
                : motionReplaceConflicts.length === 1
                  ? 'Replace Version'
                  : 'Replace All'}
            </Button>
          </Dialog.Footer>
        </Dialog.Content>
      </Dialog.Root>
	    </Tabs.Root>
</div>
</div>
