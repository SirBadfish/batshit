import type { MpfbMacroDimension, MpfbMacroPart } from "./mpfbMacro";

export const APPEARANCE_DIALS_CONTRACT = "appearance-dials/v2";
export const APPEARANCE_DIAL_VALUES_CONTRACT = "appearance-dial-values/v2";
export const APPEARANCE_PRODUCT_RESOLUTION_CONTRACT =
  "batshit-product-resolution/v1";
export const APPEARANCE_FOLLOWER_CONTRACT = "appearance-followers/v2";
export const APPEARANCE_FIT_EVIDENCE_CONTRACT = "appearance-fit-evidence/v1";
export const APPEARANCE_JOINT_FOLLOW_CONTRACT = "rest-translation/v1";
export const APPEARANCE_CLIP_REMAP_CONTRACT = "hips-rest-relative/v1";

export type AppearanceDialSurface = "body" | "head-face";
export type AppearanceDialTier = "core" | "detail" | "advanced";
export type AppearanceDialTrackPoint = [number, number];
export type AppearanceDialMacroAxis =
  "muscle" | "weight" | "cupsize" | "firmness";
export type AppearanceDialKind =
  "tracks" | "macro-axis" | "root-scale" | "follower-only";
export type AppearanceTargetLicense =
  "CC0-1.0" | "LicenseRef-Batshit-First-Party";
export type AppearanceTargetUsage = "identity" | "pose-corrective";
export type AppearanceRuntimeRetention = "recipe-only" | "retain-in-live-goon";
export type AppearanceTargetSide = "none" | "left" | "right" | "bilateral";
export type AppearanceVec3 = [number, number, number];
export type AppearanceQuat = [number, number, number, number];
export type AppearanceNodeKind = "mesh" | "anchor";
export type AppearanceNodeSide = "none" | "left" | "right" | "bilateral";
export type AppearanceNodeScalePolicy = "any" | "uniform-only";
export type AppearanceNodeRole =
  | "body"
  | "face"
  | "generic-follower"
  | "socket-eye-physical-eye"
  | "brow-canvas"
  | "eye-treatment-canvas"
  | "teeth-upper"
  | "gums-upper"
  | "teeth-lower"
  | "gums-lower"
  | "tongue"
  | "attachment-anchor";

export type AppearanceProductResolution = {
  contract: typeof APPEARANCE_PRODUCT_RESOLUTION_CONTRACT;
  catalogSha256: string;
  policySha256: string;
  resolutionSha256: string;
};

export type AppearanceNodeParent =
  { kind: "node"; id: string } | { kind: "bone"; name: string };

export type AppearanceDialNode = {
  node: string;
  kind: AppearanceNodeKind;
  role: AppearanceNodeRole;
  side: AppearanceNodeSide;
  required: boolean;
  scalePolicy: AppearanceNodeScalePolicy;
  parent?: AppearanceNodeParent;
  exactNodeMatches: 1;
};

export type AppearanceDialRegion = {
  id: string;
  label: string;
  surface: AppearanceDialSurface;
  order: number;
  parentId?: string;
};

export type AppearanceDialMember = {
  target: string;
  track: AppearanceDialTrackPoint[];
};

export type AppearanceDialSideOffset = {
  id: string;
  label: string;
  range: [number, number];
  step: number;
  members: AppearanceDialMember[];
  requirements?: AppearanceDriverRequirements;
};

export type AppearanceDialSymmetry =
  | { mode: "none" | "linked" }
  | {
      mode: "linked-with-offsets";
      left: AppearanceDialSideOffset;
      right: AppearanceDialSideOffset;
    };

export type AppearanceDialDefinition = {
  id: string;
  label: string;
  region: string;
  tier: AppearanceDialTier;
  order: number;
  description: string;
  keywords: string[];
  kind: AppearanceDialKind;
  range: [number, number];
  default: 0;
  step: number;
  members?: AppearanceDialMember[];
  axis?: AppearanceDialMacroAxis;
  axisTrack?: AppearanceDialTrackPoint[];
  scalePerUnit?: number;
  symmetry?: AppearanceDialSymmetry;
  requirements?: AppearanceDriverRequirements;
};

export type AppearanceTargetBinding = {
  node: string;
  morph: string;
};

export type AppearanceTargetProvenance = {
  catalogId: string;
  componentId: string;
  license: AppearanceTargetLicense;
  reviewStatus: "approved";
  contentSha256: string;
  containerSha256?: string;
  archiveSha256?: string;
};

export type AppearanceTargetRequirements = {
  jointFollow?: boolean;
  followerRefs?: string[];
};

export type AppearanceDriverRequirements = {
  followerRefs: string[];
};

export type AppearanceTargetDefinition = {
  usages: AppearanceTargetUsage[];
  runtimeRetention: AppearanceRuntimeRetention;
  side: AppearanceTargetSide;
  bindings: AppearanceTargetBinding[];
  /** Authoring evidence only. Runtime deltas are rebased around zero. */
  baselineValue: number;
  influenceMin: number;
  influenceMax: number;
  combine: "exclusive" | "sum-clamp";
  impact: "surface" | "structural";
  soleDeltaY?: number;
  requirements?: AppearanceTargetRequirements;
  provenance: AppearanceTargetProvenance;
};

export type AppearanceFollowerSample = {
  input: number;
  translation: AppearanceVec3;
  rotation: AppearanceQuat;
  scale: AppearanceVec3;
  pivot: AppearanceVec3;
};

export type AppearanceFollowerDriverRef =
  | { kind: "dial"; id: string }
  | { kind: "target"; id: string }
  /** Derived authoring output. Ordinary Appearance resolution always supplies zero. */
  | { kind: "anatomy-fit"; id: string };

export type AppearanceFollowerNodeTransformChannel = {
  id: string;
  kind: "node-trs";
  node: string;
  samples: AppearanceFollowerSample[];
};

export type AppearanceFollowerMorphSample = [number, number];

export type AppearanceFollowerMorphChannel = {
  id: string;
  kind: "morph-weight";
  node: string;
  morph: string;
  weightRange: [number, number];
  runtimeRetention: "recipe-only";
  samples: AppearanceFollowerMorphSample[];
};

export type AppearanceFollowerChannel =
  AppearanceFollowerNodeTransformChannel | AppearanceFollowerMorphChannel;

export type AppearanceFollowerDriver = {
  driver: AppearanceFollowerDriverRef;
  channels: AppearanceFollowerChannel[];
};

export type AppearanceFollowerDeclaration = {
  contract: typeof APPEARANCE_FOLLOWER_CONTRACT;
  space: "node-parent-rest";
  composition: "rest-relative-follower-channel-id-order/v2";
  interpolation: "linear-trs-slerp-rotation-morph/v2";
  extrapolation: "clamp";
  provenance: AppearanceTargetProvenance;
  nodeIds: string[];
  drivers: AppearanceFollowerDriver[];
};

export type AppearanceFitEvidence = {
  contract: typeof APPEARANCE_FIT_EVIDENCE_CONTRACT;
  definitionSha256: string;
  modelSha256: string;
  scenarioSetSha256: string;
  eyeReportSha256: string;
  oralReportSha256: string;
  facialArtworkDefinitionSha256: string;
  facialArtworkContractFileSha256: string;
  facialArtworkProofSha256: string;
};

export type AppearanceMacroPart = MpfbMacroPart;

export type AppearanceMacroCorner = {
  target: string;
  family: string;
  comps: Partial<Record<AppearanceDialMacroAxis, string>>;
  fixedFactor: number;
  baselineWeight: number;
};

export type AppearanceMacroEngine = {
  formula: "mpfb-macro-product/v1";
  cutoff: number;
  baselineState: Record<AppearanceDialMacroAxis, number>;
  dims: Record<AppearanceDialMacroAxis, MpfbMacroDimension>;
  corners: AppearanceMacroCorner[];
};

export type AppearanceJointFollow = {
  contract: typeof APPEARANCE_JOINT_FOLLOW_CONTRACT;
  space: "avatar-root";
  units: "meters";
  restSkeletonSha256: string;
  deltas: Record<string, Record<string, AppearanceVec3>>;
  clipRemap?: {
    contract: typeof APPEARANCE_CLIP_REMAP_CONTRACT;
    hipsBone: string;
  };
};

export type AppearanceDialsManifest = {
  contract: typeof APPEARANCE_DIALS_CONTRACT;
  definitionSha256: string;
  neutral: {
    id: string;
    recipeSha256: string;
  };
  productResolution: AppearanceProductResolution;
  fitEvidence: AppearanceFitEvidence;
  /** Parser-derived face expression/control/custom morph names. */
  mappedFaceMorphNames: string[];
  nodes: Record<string, AppearanceDialNode>;
  regions: AppearanceDialRegion[];
  dials: AppearanceDialDefinition[];
  targets: Record<string, AppearanceTargetDefinition>;
  macroEngine?: AppearanceMacroEngine;
  jointFollow?: AppearanceJointFollow;
  followers: Record<string, AppearanceFollowerDeclaration>;
};

export type AppearanceDialValueState = {
  contract: typeof APPEARANCE_DIAL_VALUES_CONTRACT;
  definitionSha256: string;
  neutralId: string;
  neutralRecipeSha256: string;
  values: Record<string, number>;
  unlockedDialIds: string[];
};

export type ReconciledAppearanceDialValues = {
  state: AppearanceDialValueState;
  values: Record<string, number>;
  unlockedDialIds: string[];
  incompatible: boolean;
  incompatibilityReasons: string[];
  prunedIds: string[];
  prunedUnlockIds: string[];
  clampedIds: string[];
  resetIds: string[];
};

export type ResolvedAppearanceDialState = {
  values: Record<string, number>;
  unlockedDialIds: Set<string>;
  influences: Map<string, number>;
  jointOffsets: Map<string, AppearanceVec3>;
  followerInputs: Map<string, Map<string, number>>;
  followerState: ResolvedAppearanceFollowerState;
  rootScale: number;
  soleOffsetY: number;
};

export type AppearanceRecipeBakeInventory = {
  bakeAndRemoveTargetIds: string[];
  retainInLiveGoonTargetIds: string[];
  bakeAndRemoveFollowerMorphs: Array<{
    follower: string;
    channel: string;
    node: string;
    morph: string;
  }>;
  bakeFollowerNodeTransforms: Array<{
    follower: string;
    channel: string;
    node: string;
  }>;
  bakeJointRestTargetIds: string[];
  preserveDynamicFaceMorphNames: string[];
};

export type AppearanceRuntimeMorph = {
  name: string;
  index: number;
  initialWeight: number;
};

export type AppearanceRuntimeNode = {
  runtimeId: string;
  node: string;
  kind: AppearanceNodeKind;
  parentRuntimeId?: string;
  parentBone?: string;
  localScale: AppearanceVec3;
  morphs: AppearanceRuntimeMorph[];
};

export type AppearanceRuntimeFaceBinding = {
  runtimeNodeId: string;
  morph: string;
};

export type AppearanceRuntimeInventory = {
  nodes: AppearanceRuntimeNode[];
  /** Complete concrete runtime evidence for mappedFaceMorphNames. */
  faceBindings: AppearanceRuntimeFaceBinding[];
};

export type ValidatedAppearanceRuntimeBinding = {
  target: string;
  node: string;
  runtimeNodeId: string;
  morph: string;
  index: number;
};

export type ValidatedAppearanceRuntimeInventory = {
  bindings: ValidatedAppearanceRuntimeBinding[];
  followerMorphBindings: Array<{
    follower: string;
    channel: string;
    node: string;
    runtimeNodeId: string;
    morph: string;
    index: number;
  }>;
  ownedRuntimeKeys: Set<string>;
  runtimeNodeIdsByManifestNode: Map<string, string>;
};

export type ResolvedAppearanceFollowerNodeTransform = {
  follower: string;
  channel: string;
  driver: AppearanceFollowerDriverRef;
  node: string;
  translation: AppearanceVec3;
  rotation: AppearanceQuat;
  scale: AppearanceVec3;
  pivot: AppearanceVec3;
};

export type ResolvedAppearanceFollowerMorph = {
  follower: string;
  channel: string;
  driver: AppearanceFollowerDriverRef;
  node: string;
  morph: string;
  weight: number;
  runtimeRetention: "recipe-only";
};

export type ResolvedAppearanceFollowerState = {
  /** Stable follower-id, then channel-id order; engine composition must preserve it. */
  nodeTransforms: ResolvedAppearanceFollowerNodeTransform[];
  morphs: ResolvedAppearanceFollowerMorph[];
};
