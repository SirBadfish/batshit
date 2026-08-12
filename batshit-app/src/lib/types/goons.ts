import type { AppearanceDialValueState } from "$lib/goons/appearanceDials";
import type { FacialArtworkStateV4 } from "$lib/goons/facialArtwork";
import type { EyeAppearanceStateV3 } from "$lib/goons/eyeAppearance";
import type { HairStateV2 } from "$lib/goons/hairAssets";
import type {
  LipArtworkPresenceStateV1,
  LipArtworkStateV2,
} from "$lib/goons/lipArtwork";
import type {
  NailSurfacePresenceStateV1,
  NailSurfaceStateV1,
} from "$lib/goons/nailSurface";
import type { OralAppearanceStateV1 } from "$lib/goons/oralAppearance";
import type { SkinAppearanceStateV2 } from "$lib/goons/skinAppearance";
import type { SocketEyeContactSettingsV2 } from "$lib/goons/socketEyeContact";
import type {
  GoonRecipeFitReceipt,
  GoonRecipeV1,
  GoonRecipeV2,
} from "$lib/goons/recipe";

export type GoonCompatibilityTier = "A" | "B" | "C" | "pending";
export type GoonKind = "vrm" | "custom";
export type GoonSourceProfile =
  "standard-vrm" | "guided-custom-vrm" | "expert-custom-glb";
export type GoonEyeContactMode = "bone" | "expression";
export type GoonEyeContactGlobalProfile = "vroid" | "blender";
export type GoonEyeContactTuning = {
  eyeYawSensitivity?: number;
  eyeYawRange?: number;
  eyePitchSensitivity?: number;
  eyePitchRange?: number;
  headYawStartOutDeg?: number;
  headYawStartInDeg?: number;
  headYawStartDeg?: number;
  headYawSensitivity?: number;
  headYawRange?: number;
  headYawSpeed?: number;
  headPitchStartOutDeg?: number;
  headPitchStartInDeg?: number;
  headPitchStartDeg?: number;
  headPitchSensitivity?: number;
  headPitchRange?: number;
  headPitchSpeed?: number;
  eyeYawHeadCompensation?: number;
  eyePitchHeadCompensation?: number;
};
export type ResolvedGoonEyeContactTuning = Required<
  Omit<GoonEyeContactTuning, "headYawStartDeg" | "headPitchStartDeg">
>;
export type GoonGlobalEyeContactSettings = {
  mode?: GoonEyeContactMode;
  tuning?: GoonEyeContactTuning;
};
export type GoonGlobalEyeContactSettingsMap = Partial<
  Record<GoonEyeContactGlobalProfile, GoonGlobalEyeContactSettings>
>;

export type GoonCueKind = "mood" | "emote";

export type GoonMask = "full" | "upper" | "head";

export type GoonBasePosture = "stand" | "sit" | "lay";

export type GoonPosture = GoonBasePosture | (string & {});

export type GoonMotionPlayback = "loop" | "oneshot";

export type GoonEnvelopeEasing = "linear" | "easeIn" | "easeOut" | "easeInOut";

export type GoonExpressionPreset =
  | "aa"
  | "ih"
  | "ou"
  | "ee"
  | "oh"
  | "blink"
  | "blinkLeft"
  | "blinkRight"
  | "happy"
  | "angry"
  | "sad"
  | "relaxed"
  | "surprised"
  | "neutral"
  | "lookUp"
  | "lookDown"
  | "lookLeft"
  | "lookRight"
  | "lookUpHead"
  | "lookDownHead"
  | "lookLeftHead"
  | "lookRightHead"
  | (string & {});

export type GoonExpressionTarget = {
  preset: GoonExpressionPreset;
  weight?: number;
};

export type GoonRawMorphTarget = {
  target: string;
  value: number;
};

export type GoonCuePortableFaceProfile = {
  expressionTargets?: GoonExpressionTarget[];
  faceControls?: GoonFaceControl[];
};

export type GoonArkit52ChannelTarget = {
  channel: import("$lib/goons/speechFaceProfiles").Arkit52Channel;
  value: number;
};

export type GoonCueArkit52FaceProfile = {
  channels?: GoonArkit52ChannelTarget[];
  headControls?: GoonFaceControl[];
};

export type GoonCueFaceProfiles = {
  portable: GoonCuePortableFaceProfile;
  /**
   * Presence is meaningful. An explicit empty object means an ARKit-capable
   * Goon should stay neutral instead of falling back to the portable profile.
   */
  arkit52?: GoonCueArkit52FaceProfile;
};

export type GoonEmoteStep = {
  faceProfiles?: GoonCueFaceProfiles;
  /** Package-bound expert morphs. Portable packs intentionally omit these. */
  rawMorphTargets?: GoonRawMorphTarget[];
  /** @deprecated Read-only migration input. Normalize into faceProfiles. */
  expressionTargets?: GoonExpressionTarget[];
  /** @deprecated Read-only migration input. Normalize into faceProfiles. */
  faceControls?: GoonFaceControl[];
  attackMs?: number;
  holdMs?: number;
  releaseMs?: number;
};

export type GoonFaceControl = {
  control: import("$lib/goons/faceControls").BatshitFaceControlId;
  value: number;
};

export type GoonCueDefinition = {
  name: string;
  kind: GoonCueKind;
  description?: string;
  autoEnableForNewGoons?: boolean;
  blocking?: boolean;
  mask?: GoonMask;
  posture?: GoonPosture;
  playback?: GoonMotionPlayback;
  intensity?: number;
  durationMs?: number;
  attackMs?: number;
  holdMs?: number;
  releaseMs?: number;
  easing?: GoonEnvelopeEasing;
  animationName?: string;
  faceProfiles?: GoonCueFaceProfiles;
  /** Package-bound expert morphs. Portable packs intentionally omit these. */
  rawMorphTargets?: GoonRawMorphTarget[];
  /** @deprecated Read-only migration input. Normalize into faceProfiles. */
  expressionTargets?: GoonExpressionTarget[];
  /** @deprecated Read-only migration input. Normalize into faceProfiles. */
  faceControls?: GoonFaceControl[];
  steps?: GoonEmoteStep[];
};

export type GoonCueMap = Record<string, GoonCueDefinition>;

export type GoonEmojiMap = Record<string, string>;

export type GoonPostureDefinition = {
  id: GoonPosture;
  name: string;
  description?: string;
  basePosture: GoonBasePosture;
  builtIn?: boolean;
};

export type GoonPostureMap = Record<string, GoonPostureDefinition>;

export type GoonCompatibilityReport = {
  tier: GoonCompatibilityTier;
  issues?: string[];
  hasMouth?: boolean;
  hasExpressions?: boolean;
  hasBodyAnimations?: boolean;
  runtimeBackend?: "webgpu" | "fallback-webgl2" | "unsupported";
  boneCoverage?: { present: number; total: number };
  animationNames?: string[];
  updated_at?: string;
};

export type GoonVrmUpdateReport = {
  updated_at?: string;
  missingMaterials?: string[];
  missingExpressions?: GoonExpressionPreset[];
  missingBones?: string[];
  disabledCues?: string[];
  disabledClosetItems?: string[];
};

export type GoonCameraMode = "indoor" | "free";

export type GoonCamera = {
  orbitTarget?: { x?: number; y?: number; z?: number };
  distance?: number;
  yaw?: number;
  pitch?: number;
  zoom?: number;
  fov?: number;
  mode?: GoonCameraMode;
};

export type GoonSceneSkybox = GoonFileRef & {
  kind?: "skybox";
  projection?: "equirectangular";
};

export type GoonSceneRoomShell = GoonFileRef & {
  kind?: "room_shell";
};

export type GoonSceneRoomShellTransform = {
  position?: [number, number, number];
  /** Y-axis rotation in radians. Scene Editor presents this value in degrees. */
  rotationY?: number;
  uniformScale?: number;
};

export type GoonSceneCameraBoundary = {
  /** Boundary-box center in the uploaded Room Shell wrapper's local coordinates. */
  center?: [number, number, number];
  /** Full boundary-box dimensions before the uploaded Room Shell wrapper transform. */
  size?: [number, number, number];
  /** Optional local Y rotation in radians, applied inside the Room Shell wrapper. */
  rotationY?: number;
};

export type GoonRoomTextureKind =
  "floor" | "wall" | "ceiling" | "exterior" | "trim";

export type GoonRoomTexture = GoonFileRef & {
  kind: GoonRoomTextureKind;
};

export type GoonRoomTextureLibrary = Partial<
  Record<GoonRoomTextureKind, GoonRoomTexture[]>
>;

export type GoonRoomSurfaceFit = "tile" | "stretch";

export type GoonRoomSurfaceTransparency = "opaque" | "cutout" | "glass";

export type GoonRoomWallKey = "north" | "south" | "east" | "west";

export type GoonRoomSurfaceSide = {
  texture?: GoonFileRef;
  trimTexture?: GoonFileRef;
  fit?: GoonRoomSurfaceFit;
  tileScale?: [number, number];
  transparency?: GoonRoomSurfaceTransparency;
  opacity?: number;
};

export type GoonRoomSurface = {
  enabled?: boolean;
  interior?: GoonRoomSurfaceSide;
  exterior?: GoonRoomSurfaceSide;
};

export type GoonRoomWallSurfaces = {
  north?: GoonRoomSurface;
  south?: GoonRoomSurface;
  east?: GoonRoomSurface;
  west?: GoonRoomSurface;
};

export type GoonRoomSurfaces = {
  floor?: GoonRoomSurface;
  ceiling?: GoonRoomSurface;
  walls?: GoonRoomWallSurfaces;
};

export type GoonRoomExteriorApron = {
  enabled?: boolean;
  depth?: number;
  surface?: GoonRoomSurfaceSide;
};

export type GoonRoomExteriorAprons = Partial<
  Record<GoonRoomWallKey, GoonRoomExteriorApron>
>;

export type GoonRoomTerrainSkirt = {
  enabled?: boolean;
  radius?: number;
  edgeFade?: number;
  slopeAngleDeg?: number;
  projection?: "surface" | "skybox-ground";
  segments?: number;
  opacity?: number;
  surface?: GoonRoomSurfaceSide;
};

export type GoonRoomShellBuilder = {
  width?: number;
  depth?: number;
  height?: number;
  floorOffsetY?: number;
  surfaces?: GoonRoomSurfaces;
  exteriorAprons?: GoonRoomExteriorAprons;
  terrainSkirt?: GoonRoomTerrainSkirt;
};

export type GoonSceneProp = {
  id: string;
  name: string;
  fileRef: GoonFileRef;
  position?: [number, number, number];
  rotation?: [number, number, number];
  scale?: [number, number, number];
};

export type GoonSceneMarker = {
  id: string;
  propId?: string;
  position: [number, number, number];
  rotation?: [number, number, number];
  positioned?: boolean;
  propLocked?: boolean;
};

export type GoonSceneMarkers = Record<string, GoonSceneMarker[]>;

export type GoonSceneAmbiencePreset =
  | "rain"
  | "snow"
  | "embers"
  | "fireflies"
  | "dust"
  | "petals"
  | "magic_sparks"
  | "mist";

export type GoonSceneAmbiencePlacement = "inside" | "outside" | "whole_stage";

export type GoonScenePlacement = "ground" | "elevated";

export type GoonSceneAmbience = {
  enabled?: boolean;
  preset?: GoonSceneAmbiencePreset;
  placement?: GoonSceneAmbiencePlacement;
  intensity?: number;
  speed?: number;
  wind?: [number, number];
  seed?: number;
};

export type GoonSceneDefinition = {
  id: string;
  name: string;
  description?: string;
  skybox?: GoonSceneSkybox;
  scenePlacement?: GoonScenePlacement;
  /** Image-space row from the top used as Ground Level's projection boundary. */
  groundProjectionLine?: number;
  roomShell?: GoonSceneRoomShell;
  roomShellTransform?: GoonSceneRoomShellTransform;
  cameraBoundary?: GoonSceneCameraBoundary;
  roomShellBuilder?: GoonRoomShellBuilder;
  props?: GoonSceneProp[];
  markers?: GoonSceneMarkers;
  ambience?: GoonSceneAmbience;
};

export type GoonSceneMap = Record<string, GoonSceneDefinition>;

export type GoonXWearPropertyColor = {
  r: number;
  g: number;
  b: number;
  a: number;
};

export type GoonXWearMaterial = {
  materialName: string;
  shader?: string;
  colors?: Record<string, GoonXWearPropertyColor>;
  floats?: Record<string, number>;
  textures?: Record<string, GoonFileRef>;
};

export type GoonXWearData = {
  materialName: string;
  shader?: string;
  colors?: Record<string, GoonXWearPropertyColor>;
  floats?: Record<string, number>;
  textures?: Record<string, GoonFileRef>;
  materials?: GoonXWearMaterial[];
};

export type GoonMaterialColorOverride = {
  baseHex?: string;
  shadeHex?: string;
  shadeMode?: "auto" | "manual";
};

export type GoonPaintedConcealMeshMask = {
  mesh: string;
  topologySignature: string;
  triangleCount: number;
  vertexCount: number;
  triangleRanges: Array<[number, number]>;
};

export type GoonPaintedConcealMask = {
  version: 1;
  topologySignature: string;
  meshes: GoonPaintedConcealMeshMask[];
  updatedAt?: string;
};

export type GoonClosetOriginalSource =
  | {
      kind: "slot-original";
      slotName: string;
    }
  | {
      kind: "guided-piece-original";
      pieceId: string;
    };

export type GoonClosetAssignment = {
  mode: "original" | "none" | "item";
  itemId?: string;
  label?: string;
  colorOverride?: GoonMaterialColorOverride;
};

export type GoonClosetItem = {
  id: string;
  sourceItemId?: string;
  originalSource?: GoonClosetOriginalSource;
  name: string;
  description?: string;
  category: string;
  templateKey?: string;
  kind?: "texture" | "xwear";
  texture?: GoonFileRef;
  mask?: GoonFileRef;
  xwear?: GoonXWearData;
  materialColors?: GoonMaterialColorOverride;
  paintedConcealMask?: GoonPaintedConcealMask;
  usesSkinTemplate?: boolean;
  tags?: string[];
  revision?: number;
  createdAt?: string;
  updatedAt?: string;
};

export type GoonWardrobeOutfit = {
  id: string;
  name: string;
  assignments?: Record<string, GoonClosetAssignment>;
  guidedPieceStates?: Record<string, boolean>;
  createdAt?: string;
  updatedAt?: string;
};

export type GoonClosetLibrary = {
  items?: Record<string, GoonClosetItem>;
  created_at?: string;
  updated_at?: string;
};

export type GoonBodyVariant = {
  id: string;
  name: string;
  set: "feminine" | "masculine";
  style: "slim" | "average" | "athletic";
  fileRef: GoonFileRef;
  previewImage?: GoonFileRef;
  revision?: number;
  createdAt?: string;
  updatedAt?: string;
};

export type GoonBodyVariantLibrary = {
  items?: Record<string, GoonBodyVariant>;
  created_at?: string;
  updated_at?: string;
};

export type GoonMotionEyeContact = "off";

export type GoonMotionMetadata = {
  posture?: GoonPosture;
  playback?: GoonMotionPlayback;
  eyeContact?: GoonMotionEyeContact;
};

export type GoonFileRef = {
  url: string;
  filename: string;
  thumbnailUrl?: string;
  displayName?: string;
  originalName?: string;
  size?: number;
  mimeType?: string;
  uploadedAt?: string;
  // Stamped by the animation-library PATCH route whenever motion metadata is
  // edited; unified motion cards use it to pick the metadata winner when a
  // pre-pairing VRMA/GLB pair diverged.
  metaUpdatedAt?: string;
  tags?: string[];
  motionMeta?: GoonMotionMetadata;
  previewVideo?: Omit<GoonFileRef, "previewVideo" | "tags" | "motionMeta">;
};

export type GoonDefaults = {
  baseLoop?: string;
  quality?: "auto" | "low" | "high" | "ultra";
  lipSync?: boolean;
  eyeContactMode?: GoonEyeContactMode;
  eyeContactTuning?: GoonEyeContactTuning;
  socketEyeContact?: SocketEyeContactSettingsV2;
  sceneId?: string;
  bodyVariantId?: string;
  closetOutfitId?: string;
};

export type GoonDefaultPackDefaults = Pick<
  GoonDefaults,
  | "baseLoop"
  | "quality"
  | "lipSync"
  | "eyeContactMode"
  | "eyeContactTuning"
  | "socketEyeContact"
  | "sceneId"
>;

export type GoonDefaultPack = {
  name: string;
  exportedAt: string;
  sourceGoonId?: string;
  sourceGoonName?: string;
  enabledCueNames: string[];
  cueMap: GoonCueMap;
  emojiMap: GoonEmojiMap;
  defaults?: GoonDefaultPackDefaults;
};

export type GoonAnimationLibrary = {
  vrma: GoonFileRef[];
  created_at?: string;
  updated_at?: string;
};

export type GoonCustomManifestSummary = {
  contractVersion?: number;
  name?: string;
  description?: string;
  /** Exact Recipe base identity when the package declares one. */
  baseId?: string;
  /** Capability hint only; exact Recipe verification still gates activation. */
  recipeReady?: boolean;
  /** Capability hint for automatic authoring-time Anatomy Fit recompute. */
  anatomyFitReady?: boolean;
};

export type GoonGuidedOutfitPiece = {
  id: string;
  label: string;
  runtimeNodeNames: string[];
  category?: string;
  defaultOn?: boolean;
  source?: "base" | "duf-overlay";
  overlayId?: string | null;
  materialNames?: string[];
};

export type GoonGuidedOutfitPreset = {
  id: string;
  name: string;
  piecesOn?: string[];
  piecesOff?: string[];
};

export type GoonGuidedManifestSummary = {
  contractVersion?: number;
  name?: string;
  description?: string;
  outfitPieceCount?: number;
  outfitPresetCount?: number;
};

export type GoonCustomAvatarFiles = {
  package?: GoonFileRef;
  model?: GoonFileRef;
  manifest?: GoonFileRef;
  pending?: {
    package?: GoonFileRef;
    model?: GoonFileRef;
    manifest?: GoonFileRef;
  };
  backup?: {
    package?: GoonFileRef;
    model?: GoonFileRef;
    manifest?: GoonFileRef;
  };
  manifestSummary?: GoonCustomManifestSummary;
};

export type GoonGuidedAvatarFiles = {
  package?: GoonFileRef;
  manifest?: GoonFileRef;
  pending?: {
    package?: GoonFileRef;
    vrm?: GoonFileRef;
    manifest?: GoonFileRef;
  };
  backup?: {
    package?: GoonFileRef;
    vrm?: GoonFileRef;
    manifest?: GoonFileRef;
  };
  manifestSummary?: GoonGuidedManifestSummary;
  outfitPieces?: GoonGuidedOutfitPiece[];
  outfitPresets?: GoonGuidedOutfitPreset[];
  pieceStates?: Record<string, boolean>;
  activePresetId?: string | null;
  dufOverlays?: Array<{
    id: string;
    label: string;
    file: GoonFileRef;
    importedAt?: string;
    pieceIds?: string[];
  }>;
};

export interface GoonRecord {
  id: string;
  user_id: string;
  name: string;
  description?: string;
  kind?: GoonKind;
  sourceProfile?: GoonSourceProfile;
  files: {
    vrm?: GoonFileRef;
    vrmBackup?: GoonFileRef;
    vrmPending?: GoonFileRef;
    animations?: GoonFileRef[];
  };
  customAvatar?: GoonCustomAvatarFiles;
  /** Durable Recipe source/state, immutable revision lineage, and active Live-build owner. */
  recipe?: GoonRecipeV1 | GoonRecipeV2 | null;
  /** Versioned first-party appearance state (avatar.json#appearanceDials contract). */
  appearanceDials?: AppearanceDialValueState | null;
  /** Recipe-owned facial artwork state, bound to avatar.json#facialArtwork. */
  facialArtwork?: FacialArtworkStateV4 | null;
  /** Package-owned linked physical eye state, bound to avatar.json#eyeAppearance. */
  eyeAppearance?: EyeAppearanceStateV3 | null;
  /** Package-owned oral material state, bound to avatar.json#oralAppearance. */
  oralAppearance?: OralAppearanceStateV1 | null;
  /** Recipe-owned lip artwork state, bound to avatar.json#lipArtwork. Null inherits package art. */
  lipArtwork?: LipArtworkStateV2 | null;
  /** Recipe-owned Lip Artwork presence. Null/absent keeps the package overlay enabled. */
  lipArtworkPresence?: LipArtworkPresenceStateV1 | null;
  /** Recipe-owned nail geometry/material/artwork state, bound to avatar.json#nailSurface. */
  nailSurface?: NailSurfaceStateV1 | null;
  /** Recipe-owned Nail Surface presence. Null/absent keeps both nail meshes enabled. */
  nailSurfacePresence?: NailSurfacePresenceStateV1 | null;
  /** Recipe-owned body surface maps, tint, and regional pigment state. */
  skinAppearance?: SkinAppearanceStateV2 | null;
  /** Recipe-owned immutable Hair Asset selection and user color choices. */
  hairState?: HairStateV2 | null;
  /** @deprecated Read-only migration input; new writes fold this into skinAppearance.surface. */
  skinMaterialArtwork?: unknown;
  /** Revision-bound hair/clothing/conceal/attachment fit evidence. */
  recipeFitReceipts?: GoonRecipeFitReceipt[];
  guidedAvatar?: GoonGuidedAvatarFiles;
  compatibility?: GoonCompatibilityReport;
  vrmUpdate?: GoonVrmUpdateReport | null;
  cues?: {
    enabled?: string[];
    disabled?: string[];
    overrides?: GoonCueMap;
    emojiOverrides?: GoonEmojiMap;
    // Legacy fallback (pre Goon Kitchen)
    emojiMap?: GoonEmojiMap;
    cueMap?: GoonCueMap;
  };
  camera?: GoonCamera;
  defaults?: GoonDefaults;
  closet?: {
    items?: Record<string, GoonClosetItem>;
    outfits?: Record<string, GoonWardrobeOutfit>;
  };
  closetAssignments?: Record<string, GoonClosetAssignment>;
  bodyVariants?: {
    enabled?: string[];
    overrides?: Record<string, Partial<GoonBodyVariant>>;
  };
  created_at: string;
  updated_at: string;
}

export type GoonsSettings = {
  dockOpen?: boolean;
  showCues?: boolean;
  immersiveMode?: boolean;
  globalCloset?: GoonClosetLibrary;
  kitchen?: {
    cues?: GoonCueMap;
    emojiMap?: GoonEmojiMap;
    postures?: GoonPostureMap;
    scenes?: GoonSceneMap;
    roomTextures?: GoonRoomTextureLibrary;
    bodyVariants?: GoonBodyVariantLibrary;
    eyeContact?: GoonGlobalEyeContactSettingsMap;
    defaultPack?: GoonDefaultPack | null;
  };
  motions?: {
    // Preview body override for GLB-lane motion previews. Unset means the
    // bundled BSRigV2 stunt dummy; a goon id targets that custom goon (for
    // GLB clips authored against a non-first-party rig).
    glbPreviewGoonId?: string;
  };
};
