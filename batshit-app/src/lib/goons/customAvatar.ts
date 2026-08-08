import type { Mesh, Object3D } from "three";
import type { GoonEngine } from "$lib/goons/engine";
// Keep this core manifest/runtime module independent from the recipe barrel.
// Worker entrypoints import Custom Avatar types, while the barrel also exports
// both worker clients; importing the barrel here makes Vite discover each
// worker from inside the other worker's graph and reject the circular bundle.
import { isMountedRecipeLiveGoon } from "$lib/goons/recipe/recipeRuntimeProjection";
import type { BatshitFaceControlId } from "$lib/goons/faceControls";
import { sanitizeCustomRuntimeNodeName } from "$lib/goons/customRuntimeNames";
import {
  parseLipArtworkDefinition,
  parseLipArtworkPresenceState,
} from "$lib/goons/lipArtwork";
import {
  parseNailSurfaceDefinition,
  parseNailSurfacePresenceState,
} from "$lib/goons/nailSurface";
import {
  ARKIT_52_CHANNEL_ORDER,
  AUDIO2FACE_16_TONGUE_CHANNEL_ORDER,
  resolveGoonSpeechFaceProfileDeclaration,
  type Arkit52Channel,
  type Audio2FaceTongueChannel,
} from "$lib/goons/speechFaceProfiles";
import type {
  GoonEyeContactGlobalProfile,
  GoonEyeContactMode,
  GoonEyeContactTuning,
  GoonFileRef,
  GoonGlobalEyeContactSettings,
  GoonGlobalEyeContactSettingsMap,
  GoonKind,
  GoonRecord,
  GoonSourceProfile,
  GoonsSettings,
  ResolvedGoonEyeContactTuning,
} from "$lib/types/goons";

type ResolvedGoonGlobalEyeContactSettings = {
  mode: GoonEyeContactMode;
  tuning: ResolvedGoonEyeContactTuning;
};

export type GoonCustomStageAnchors = {
  head?: string;
  hips?: string;
  feet?: string;
  leftFoot?: string;
  rightFoot?: string;
};

export type GoonCustomMorphBindingValue = string | string[];
export type GoonCustomExpressionRecipeV1 = {
  schemaVersion: "batshit-expression-recipe/v1";
  targets: Array<{
    target: string;
    weight?: number;
  }>;
};
export type GoonCustomExpressionBindingValue =
  | GoonCustomMorphBindingValue
  | GoonCustomExpressionRecipeV1;
export type GoonCustomFaceControlBindingValue =
  | GoonCustomMorphBindingValue
  | {
      negative?: GoonCustomMorphBindingValue;
      positive?: GoonCustomMorphBindingValue;
    };

export type GoonCustomFaceManifest = {
  mesh?: string;
  meshes?: string[];
  speechProfile?: unknown;
  arkit52?: unknown;
  tongue16?: unknown;
  expressions?: Record<string, GoonCustomExpressionBindingValue>;
  controls?: Partial<
    Record<
      BatshitFaceControlId | (string & {}),
      GoonCustomFaceControlBindingValue
    >
  >;
  customMorphs?: Record<string, GoonCustomMorphBindingValue>;
};

export type GoonCustomBodyConcealManifest = {
  topologyId?: string;
  meshes?: Array<{
    mesh: string;
    regions?: Record<string, number[]>;
  }>;
};

export type GoonCustomAvatarManifest = {
  contractVersion?: number;
  baseId?: string;
  name?: string;
  description?: string;
  stage?: {
    anchors?: GoonCustomStageAnchors;
  };
  body?: {
    conceal?: GoonCustomBodyConcealManifest;
  };
  face?: GoonCustomFaceManifest;
  /** Strict first-party identity/follower contract; parsed before runtime use. */
  appearanceDials?: unknown;
  /** Intrinsic authoring-package identity; raw package/manifest hashes stay external. */
  recipeSource?: unknown;
  /** Direct intrinsic update edges supported by this authoring source. */
  recipeUpdates?: unknown;
  /** Deterministic Live provenance. Mutually exclusive with appearanceDials. */
  liveBuild?: unknown;
  /** Immutable first-party facial artwork definition; parsed before runtime use. */
  facialArtwork?: unknown;
  /** Immutable first-party physical eye definition; parsed before runtime use. */
  eyeAppearance?: unknown;
  /** Fixed first-party composite eye surface; valid only with eyeApertureSeam. */
  socketEyeSurface?: unknown;
  /** Shared cap/liner aperture ownership contract; valid only with socketEyeSurface. */
  eyeApertureSeam?: unknown;
  /** Immutable first-party oral material definition; parsed before runtime use. */
  oralAppearance?: unknown;
  /** Immutable first-party lip artwork definition; parsed before runtime use. */
  lipArtwork?: unknown;
  /** Immutable first-party finger/toe Nail Surface definition. */
  nailSurface?: unknown;
  /** Immutable first-party regional skin pigment definition. */
  skinAppearance?: unknown;
  /** Exact hidden-landmark and rigid-assembly Oral Cavity Fit authoring package. */
  oralCavityFit?: unknown;
  /** Authoring-time final-geometry fit definitions; stripped from Live output. */
  anatomyFit?: unknown;
  /** First-party skeleton/retarget/corrective contract; parsed by its owning runtimes. */
  rig?: unknown;
};

export type ResolvedCustomFaceMeshes = {
  meshes: Mesh[];
  issues: string[];
};

export type ResolvedCustomFaceControlBinding = {
  negative?: string[];
  positive: string[];
};

export type ResolvedCustomExpressionBinding = {
  target: string;
  weight: number;
};

export type ResolvedCustomExpressionBindingContract = {
  bindings: Record<string, ResolvedCustomExpressionBinding[]>;
  issues: string[];
};

export type ResolvedCustomFaceControlBindings = Partial<
  Record<BatshitFaceControlId, ResolvedCustomFaceControlBinding>
>;

export type ResolvedCustomMorphDefinition = {
  id: string;
  morphTargets: string[];
};

export type ResolvedCustomArkitFaceBindings = {
  face: Map<Arkit52Channel, string[]> | null;
  tongue: Map<Audio2FaceTongueChannel, string[]> | null;
  issues: string[];
};

const customManifestCache = new Map<
  string,
  Promise<GoonCustomAvatarManifest>
>();
const EMBEDDED_BATSHIT_GLTF_EXTENSION = "BATSHIT_avatar";
const EMBEDDED_BATSHIT_GLTF_ASSET_EXTRA_KEY = "batshitAvatar";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeNameList(
  value: unknown,
) {
  const names: string[] = Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : typeof value === "string"
      ? [value]
      : [];
  return [...new Set(names.map((name) => name.trim()).filter(Boolean))];
}

export { sanitizeCustomRuntimeNodeName } from "$lib/goons/customRuntimeNames";

export function resolveCustomPerformanceRigBlock(
  manifest: GoonCustomAvatarManifest,
) {
  return isRecord(manifest.rig) ? manifest.rig.performance : undefined;
}

export function getCustomRuntimeNodeNameCandidates(
  name: string | null | undefined,
) {
  const trimmed = String(name ?? "").trim();
  if (!trimmed) return [];
  const sanitized = sanitizeCustomRuntimeNodeName(trimmed);
  return [...new Set([trimmed, sanitized].filter(Boolean))];
}

export function resolveCustomNamedNode(
  root: Object3D,
  name: string | null | undefined,
) {
  for (const candidate of getCustomRuntimeNodeNameCandidates(name)) {
    const node = root.getObjectByName(candidate);
    if (node) {
      return node;
    }
  }
  return null;
}

function isFaceControlSides(
  value: GoonCustomFaceControlBindingValue | null | undefined,
): value is {
  negative?: GoonCustomMorphBindingValue;
  positive?: GoonCustomMorphBindingValue;
} {
  return isRecord(value) && ("negative" in value || "positive" in value);
}

export function resolveGoonKind(
  goon: Pick<GoonRecord, "kind"> | null | undefined,
): GoonKind {
  return goon?.kind === "custom" ? "custom" : "vrm";
}

export function resolveGoonSourceProfile(
  goon: Pick<GoonRecord, "kind" | "sourceProfile"> | null | undefined,
): GoonSourceProfile {
  if (goon?.sourceProfile === "guided-custom-vrm") return "guided-custom-vrm";
  if (goon?.sourceProfile === "expert-custom-glb") return "expert-custom-glb";
  if (goon?.sourceProfile === "standard-vrm") return "standard-vrm";
  return resolveGoonKind(goon) === "custom"
    ? "expert-custom-glb"
    : "standard-vrm";
}

export function isGuidedCustomVrmGoon(
  goon: Pick<GoonRecord, "kind" | "sourceProfile"> | null | undefined,
) {
  return resolveGoonSourceProfile(goon) === "guided-custom-vrm";
}

export function resolveGoonEyeContactMode(
  goon:
    Pick<GoonRecord, "kind" | "sourceProfile" | "defaults"> | null | undefined,
  goonsSettings?: Pick<GoonsSettings, "kitchen"> | null,
): GoonEyeContactMode {
  if (goon?.defaults?.eyeContactMode === "bone") return "bone";
  if (goon?.defaults?.eyeContactMode === "expression") return "expression";
  const profile = resolveGoonEyeContactGlobalProfile(goon);
  const globalMode = normalizeGoonGlobalEyeContactSettingsMap(
    goonsSettings?.kitchen?.eyeContact,
  )[profile]?.mode;
  if (globalMode === "bone" || globalMode === "expression") return globalMode;
  return resolveGoonSourceProfile(goon) === "guided-custom-vrm"
    ? "expression"
    : "bone";
}

export function normalizeGoonEyeContactMultiplier(
  value: unknown,
  fallback = 1,
): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(0, Math.min(8, Math.round(numeric * 100) / 100));
}

export const normalizeGoonEyeContactStrength =
  normalizeGoonEyeContactMultiplier;

export function normalizeGoonEyeContactSpeed(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return 1;
  return Math.max(0.05, Math.min(3, Math.round(numeric * 100) / 100));
}

export function normalizeGoonEyeContactCompensation(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return 1;
  return Math.max(0, Math.min(5, Math.round(numeric * 100) / 100));
}

export function normalizeGoonEyeContactHeadStart(
  value: unknown,
  fallback = 14,
): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(0, Math.min(90, Math.round(numeric)));
}

export function resolveGoonEyeContactGlobalProfile(
  goon: Pick<GoonRecord, "kind" | "sourceProfile"> | null | undefined,
): GoonEyeContactGlobalProfile {
  return resolveGoonSourceProfile(goon) === "standard-vrm"
    ? "vroid"
    : "blender";
}

export function normalizeGoonGlobalEyeContactSettings(
  value: GoonGlobalEyeContactSettings | null | undefined,
  fallbackMode: GoonEyeContactMode,
): ResolvedGoonGlobalEyeContactSettings {
  return {
    mode:
      value?.mode === "bone" || value?.mode === "expression"
        ? value.mode
        : fallbackMode,
    tuning: normalizeGoonEyeContactTuning(value?.tuning),
  };
}

export function normalizeGoonGlobalEyeContactSettingsMap(
  value: GoonGlobalEyeContactSettingsMap | null | undefined,
): Record<GoonEyeContactGlobalProfile, ResolvedGoonGlobalEyeContactSettings> {
  return {
    vroid: normalizeGoonGlobalEyeContactSettings(value?.vroid, "bone"),
    blender: normalizeGoonGlobalEyeContactSettings(
      value?.blender,
      "expression",
    ),
  };
}

export function normalizeGoonEyeContactTuning(
  tuning: GoonEyeContactTuning | null | undefined,
): ResolvedGoonEyeContactTuning {
  const legacy = tuning as
    | (GoonEyeContactTuning & {
        yawStrength?: number;
        pitchStrength?: number;
        headStartDeg?: number;
        headStrength?: number;
      })
    | undefined;

  return {
    eyeYawSensitivity: normalizeGoonEyeContactMultiplier(
      tuning?.eyeYawSensitivity ?? legacy?.yawStrength,
    ),
    eyeYawRange: normalizeGoonEyeContactMultiplier(
      tuning?.eyeYawRange ?? legacy?.yawStrength,
    ),
    eyePitchSensitivity: normalizeGoonEyeContactMultiplier(
      tuning?.eyePitchSensitivity ?? legacy?.pitchStrength,
    ),
    eyePitchRange: normalizeGoonEyeContactMultiplier(
      tuning?.eyePitchRange ?? legacy?.pitchStrength,
    ),
    headYawStartOutDeg: normalizeGoonEyeContactHeadStart(
      tuning?.headYawStartOutDeg ??
        tuning?.headYawStartDeg ??
        legacy?.headStartDeg,
      14,
    ),
    headYawStartInDeg: normalizeGoonEyeContactHeadStart(
      tuning?.headYawStartInDeg,
      52,
    ),
    headYawSensitivity: normalizeGoonEyeContactMultiplier(
      tuning?.headYawSensitivity ?? legacy?.headStrength,
    ),
    headYawRange: normalizeGoonEyeContactMultiplier(
      tuning?.headYawRange ?? legacy?.headStrength,
    ),
    headYawSpeed: normalizeGoonEyeContactSpeed(tuning?.headYawSpeed),
    headPitchStartOutDeg: normalizeGoonEyeContactHeadStart(
      tuning?.headPitchStartOutDeg ?? tuning?.headPitchStartDeg,
      8,
    ),
    headPitchStartInDeg: normalizeGoonEyeContactHeadStart(
      tuning?.headPitchStartInDeg,
      22,
    ),
    headPitchSensitivity: normalizeGoonEyeContactMultiplier(
      tuning?.headPitchSensitivity ?? legacy?.headStrength,
    ),
    headPitchRange: normalizeGoonEyeContactMultiplier(
      tuning?.headPitchRange ?? legacy?.headStrength,
    ),
    headPitchSpeed: normalizeGoonEyeContactSpeed(tuning?.headPitchSpeed),
    eyeYawHeadCompensation: normalizeGoonEyeContactCompensation(
      tuning?.eyeYawHeadCompensation,
    ),
    eyePitchHeadCompensation: normalizeGoonEyeContactCompensation(
      tuning?.eyePitchHeadCompensation,
    ),
  };
}

export function resolveGoonEyeContactTuning(
  goon:
    Pick<GoonRecord, "kind" | "sourceProfile" | "defaults"> | null | undefined,
  goonsSettings?: Pick<GoonsSettings, "kitchen"> | null,
): ResolvedGoonEyeContactTuning {
  const tuning = goon?.defaults?.eyeContactTuning;
  if (tuning) return normalizeGoonEyeContactTuning(tuning);
  const profile = resolveGoonEyeContactGlobalProfile(goon);
  const globalSettings = normalizeGoonGlobalEyeContactSettingsMap(
    goonsSettings?.kitchen?.eyeContact,
  );
  return globalSettings[profile].tuning;
}

export function resolveCustomManifestFile(
  goon: GoonRecord | null | undefined,
): GoonFileRef | null {
  if (resolveGoonKind(goon) !== "custom") return null;
  return goon?.customAvatar?.manifest ?? null;
}

export function resolveGuidedManifestFile(
  goon: GoonRecord | null | undefined,
): GoonFileRef | null {
  if (!isGuidedCustomVrmGoon(goon)) return null;
  return goon?.guidedAvatar?.manifest ?? null;
}

export function resolveGoonManifestFile(
  goon: GoonRecord | null | undefined,
): GoonFileRef | null {
  return resolveGuidedManifestFile(goon) ?? resolveCustomManifestFile(goon);
}

export function resolveGoonAvatarUrl(goon: GoonRecord | null | undefined) {
  if (!goon) return "";
  if (resolveGoonKind(goon) === "custom") {
    return goon.customAvatar?.model?.url ?? "";
  }
  return goon.files?.vrmPending?.url ?? goon.files?.vrm?.url ?? "";
}

export function resolveGoonAvatarSignature(
  goon: GoonRecord | null | undefined,
) {
  if (!goon) return "";
  const kind = resolveGoonKind(goon);
  const sourceProfile = resolveGoonSourceProfile(goon);
  const avatarUrl = resolveGoonAvatarUrl(goon);
  if (!avatarUrl) return "";
  if (kind === "custom") {
    return [kind, avatarUrl, goon.customAvatar?.manifest?.url ?? ""].join("::");
  }
  if (sourceProfile === "guided-custom-vrm") {
    const overlayUrls = (goon.guidedAvatar?.dufOverlays ?? []).map(
      (overlay) => overlay.file?.url ?? "",
    );
    const pieceStates = goon.guidedAvatar?.pieceStates ?? {};
    const hasGuidedOutfitState =
      overlayUrls.length > 0 || Object.keys(pieceStates).length > 0;
    return [
      kind,
      sourceProfile,
      avatarUrl,
      goon.guidedAvatar?.manifest?.url ?? "",
      ...(hasGuidedOutfitState
        ? [...overlayUrls, JSON.stringify(pieceStates)]
        : []),
    ].join("::");
  }
  return [kind, avatarUrl].join("::");
}

export function hasRenderableGoonAvatar(goon: GoonRecord | null | undefined) {
  return resolveGoonAvatarUrl(goon).length > 0;
}

export function resolveCustomFaceMeshNames(manifest: GoonCustomAvatarManifest) {
  return [
    ...new Set([
      ...normalizeNameList(manifest.face?.mesh),
      ...normalizeNameList(manifest.face?.meshes ?? []),
    ]),
  ];
}

export function resolveCustomExpressionBindings(
  manifest: GoonCustomAvatarManifest,
) {
  return resolveCustomExpressionBindingContract(manifest).bindings;
}

export function resolveCustomExpressionBindingContract(
  manifest: GoonCustomAvatarManifest,
): ResolvedCustomExpressionBindingContract {
  const entries = Object.entries(manifest.face?.expressions ?? {});
  const bindings: Record<string, ResolvedCustomExpressionBinding[]> = {};
  const issues: string[] = [];
  for (const [preset, rawValue] of entries) {
    if (isRecord(rawValue)) {
      const path = `face.expressions.${preset}`;
      if (rawValue.schemaVersion !== "batshit-expression-recipe/v1") {
        issues.push(`${path}.schemaVersion must be "batshit-expression-recipe/v1".`);
        continue;
      }
      if (!Array.isArray(rawValue.targets) || rawValue.targets.length === 0) {
        issues.push(`${path}.targets must be a non-empty array.`);
        continue;
      }

      const recipeBindings: ResolvedCustomExpressionBinding[] = [];
      const targetNames = new Set<string>();
      let valid = true;
      for (const [index, rawTarget] of rawValue.targets.entries()) {
        if (!isRecord(rawTarget)) {
          issues.push(`${path}.targets[${index}] must be an object.`);
          valid = false;
          continue;
        }
        const target = typeof rawTarget.target === "string" ? rawTarget.target.trim() : "";
        const weight = rawTarget.weight === undefined ? 1 : rawTarget.weight;
        if (!target) {
          issues.push(`${path}.targets[${index}].target must be a non-empty string.`);
          valid = false;
          continue;
        }
        if (typeof weight !== "number" || !Number.isFinite(weight) || weight <= 0 || weight > 1) {
          issues.push(`${path}.targets[${index}].weight must be greater than 0 and at most 1.`);
          valid = false;
          continue;
        }
        if (targetNames.has(target)) {
          issues.push(`${path} assigns target "${target}" more than once.`);
          valid = false;
          continue;
        }
        targetNames.add(target);
        recipeBindings.push({ target, weight });
      }
      if (valid && recipeBindings.length > 0) bindings[preset] = recipeBindings;
      continue;
    }

    const morphTargets = normalizeNameList(rawValue);
    if (morphTargets.length === 0) continue;
    bindings[preset] = morphTargets.map((target) => ({ target, weight: 1 }));
  }
  return { bindings, issues };
}

export function resolveCustomSpeechFaceProfile(
  manifest: GoonCustomAvatarManifest,
) {
  return resolveGoonSpeechFaceProfileDeclaration(manifest.face?.speechProfile);
}

function resolveExactCustomFaceChannelBindings<TChannel extends string>(
  value: unknown,
  channels: readonly TChannel[],
  path: string,
): { bindings: Map<TChannel, string[]> | null; issues: string[] } {
  if (value === undefined || value === null) {
    return { bindings: null, issues: [] };
  }
  if (!isRecord(value)) {
    return { bindings: null, issues: [`${path} must be an object.`] };
  }

  const expected = new Set<string>(channels);
  const unknown = Object.keys(value).filter((channel) => !expected.has(channel));
  const missing = channels.filter((channel) => !(channel in value));
  const issues: string[] = [];
  if (unknown.length > 0) {
    issues.push(`${path} contains unknown channels: ${unknown.join(", ")}.`);
  }
  if (missing.length > 0) {
    issues.push(`${path} is missing required channels: ${missing.join(", ")}.`);
  }

  const bindings = new Map<TChannel, string[]>();
  const targetOwners = new Map<string, TChannel>();
  for (const channel of channels) {
    if (!(channel in value)) continue;
    const rawBinding = value[channel];
    if (
      typeof rawBinding !== "string" &&
      !(Array.isArray(rawBinding) && rawBinding.every((entry) => typeof entry === "string"))
    ) {
      issues.push(`${path}.${channel} must be a morph-target name or string array.`);
      continue;
    }
    const targets = normalizeNameList(rawBinding);
    if (targets.length === 0) {
      issues.push(`${path}.${channel} must map to at least one morph target.`);
      continue;
    }
    for (const target of targets) {
      const owner = targetOwners.get(target);
      if (owner && owner !== channel) {
        issues.push(
          `${path} maps morph target "${target}" to both ${owner} and ${channel}.`,
        );
      } else {
        targetOwners.set(target, channel);
      }
    }
    bindings.set(channel, targets);
  }

  return {
    bindings: issues.length === 0 ? bindings : null,
    issues,
  };
}

/**
 * Full-fidelity Audio2Face support is declaration-driven. Faceit can retarget
 * one ARKit source expression to arbitrary target shapes, so runtime filename
 * guessing is not authoritative; the exported manifest must bind every source
 * channel explicitly.
 */
export function resolveCustomArkitFaceBindings(
  manifest: GoonCustomAvatarManifest,
): ResolvedCustomArkitFaceBindings {
  const face = resolveExactCustomFaceChannelBindings(
    manifest.face?.arkit52,
    ARKIT_52_CHANNEL_ORDER,
    "face.arkit52",
  );
  const tongue = resolveExactCustomFaceChannelBindings(
    manifest.face?.tongue16,
    AUDIO2FACE_16_TONGUE_CHANNEL_ORDER,
    "face.tongue16",
  );
  return {
    face: face.bindings,
    tongue: tongue.bindings,
    issues: [...face.issues, ...tongue.issues],
  };
}

export function resolveCustomFaceControlBindings(
  manifest: GoonCustomAvatarManifest,
): ResolvedCustomFaceControlBindings {
  const entries = Object.entries(manifest.face?.controls ?? {});
  const bindings: ResolvedCustomFaceControlBindings = {};

  for (const [controlId, rawValue] of entries) {
    if (isFaceControlSides(rawValue)) {
      const negative = normalizeNameList(rawValue.negative);
      const positive = normalizeNameList(rawValue.positive);
      if (negative.length === 0 && positive.length === 0) continue;
      bindings[controlId as BatshitFaceControlId] = {
        positive,
        ...(negative.length > 0 ? { negative } : {}),
      };
      continue;
    }

    const positive = normalizeNameList(rawValue);
    if (positive.length === 0) continue;
    bindings[controlId as BatshitFaceControlId] = { positive };
  }

  const expressionBindings = resolveCustomExpressionBindings(manifest);

  const ensureNegativeTargets = (
    controlId: BatshitFaceControlId,
    targets: string[],
  ) => {
    if (targets.length === 0) return;
    const existing = bindings[controlId];
    if (existing?.negative && existing.negative.length > 0) return;
    bindings[controlId] = {
      positive: existing?.positive ?? [],
      negative: targets,
    };
  };

  // Guided lanes often author eyelid closure as semantic blink expressions
  // while eyelid opening lives under the face-control contract. Treat those
  // as the two sides of the same Batshit eyelid slider.
  ensureNegativeTargets(
    "eyelids_left",
    (expressionBindings.blinkLeft ?? expressionBindings.blink ?? []).map(
      (binding) => binding.target,
    ),
  );
  ensureNegativeTargets(
    "eyelids_right",
    (expressionBindings.blinkRight ?? expressionBindings.blink ?? []).map(
      (binding) => binding.target,
    ),
  );

  return bindings;
}

export function resolveCustomMorphDefinitions(
  manifest: GoonCustomAvatarManifest,
) {
  const definitions: ResolvedCustomMorphDefinition[] = [];

  for (const [id, rawValue] of Object.entries(
    manifest.face?.customMorphs ?? {},
  )) {
    const trimmedId = id.trim();
    if (!trimmedId) continue;
    const morphTargets = normalizeNameList(rawValue);
    if (morphTargets.length === 0) continue;
    definitions.push({
      id: trimmedId,
      morphTargets,
    });
  }

  return definitions;
}

function looksLikeCustomAvatarManifest(
  value: unknown,
): value is GoonCustomAvatarManifest {
  return (
    isRecord(value) &&
    ("stage" in value ||
      "body" in value ||
      "face" in value ||
      "recipeSource" in value ||
      "recipeUpdates" in value ||
      "liveBuild" in value ||
      "contractVersion" in value ||
      "name" in value ||
      "description" in value)
  );
}

function normalizeEmbeddedManifestPayload(
  value: unknown,
): GoonCustomAvatarManifest | null {
  if (!isRecord(value)) return null;
  const candidate = looksLikeCustomAvatarManifest(value)
    ? value
    : looksLikeCustomAvatarManifest(value.manifest)
      ? value.manifest
      : null;
  return candidate ?? null;
}

export function extractEmbeddedCustomAvatarManifest(
  document: unknown,
): GoonCustomAvatarManifest | null {
  if (!isRecord(document)) return null;

  const extensions = isRecord(document.extensions) ? document.extensions : null;
  const extensionPayload = extensions?.[EMBEDDED_BATSHIT_GLTF_EXTENSION];
  const fromExtension = normalizeEmbeddedManifestPayload(extensionPayload);
  if (fromExtension) return fromExtension;

  const asset = isRecord(document.asset) ? document.asset : null;
  const assetExtras = isRecord(asset?.extras) ? asset.extras : null;
  const extrasPayload = assetExtras?.[EMBEDDED_BATSHIT_GLTF_ASSET_EXTRA_KEY];
  return normalizeEmbeddedManifestPayload(extrasPayload);
}

function isMeshNode(node: Object3D): node is Mesh {
  return (node as Mesh & { isMesh?: boolean }).isMesh === true;
}

function getMorphTargetCount(node: Object3D) {
  if (!isMeshNode(node)) return 0;
  return Object.keys(node.morphTargetDictionary ?? {}).length;
}

function collectMorphEnabledDescendants(node: Object3D) {
  const meshes: Mesh[] = [];
  const seen = new Set<Mesh>();

  if (isMeshNode(node) && getMorphTargetCount(node) > 0) {
    meshes.push(node);
    seen.add(node);
  }

  node.traverse((child) => {
    if (!isMeshNode(child)) return;
    if (seen.has(child)) return;
    if (getMorphTargetCount(child) <= 0) return;
    meshes.push(child);
    seen.add(child);
  });

  return meshes;
}

export function resolveCustomFaceMeshes(
  root: Object3D,
  requestedMeshNames: string[],
): ResolvedCustomFaceMeshes {
  const meshes: Mesh[] = [];
  const issues: string[] = [];
  const seen = new Set<Mesh>();

  if (requestedMeshNames.length > 0) {
    for (const meshName of requestedMeshNames) {
      const node = resolveCustomNamedNode(root, meshName);
      if (!node) {
        issues.push(
          `Custom face mesh "${meshName}" was not found in the model.`,
        );
        continue;
      }

      const resolved = collectMorphEnabledDescendants(node);
      if (resolved.length === 0) {
        issues.push(
          `Custom face mesh "${meshName}" did not resolve to any morph-enabled meshes.`,
        );
        continue;
      }

      for (const mesh of resolved) {
        if (seen.has(mesh)) continue;
        meshes.push(mesh);
        seen.add(mesh);
      }
    }
    return { meshes, issues };
  }

  root.traverse((node) => {
    if (!isMeshNode(node)) return;
    if (seen.has(node)) return;
    if (getMorphTargetCount(node) <= 0) return;
    meshes.push(node);
    seen.add(node);
  });

  return { meshes, issues };
}

export async function loadCustomAvatarManifest(
  file: GoonFileRef | null | undefined,
): Promise<GoonCustomAvatarManifest> {
  if (!file?.url) {
    throw new Error("Custom Goon is missing its avatar manifest.");
  }

  const cached = customManifestCache.get(file.url);
  if (cached) {
    return cached;
  }

  const request = (async () => {
    const response = await fetch(file.url);
    if (!response.ok) {
      throw new Error(
        `Failed to load Custom avatar manifest (${response.status}).`,
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error("Custom avatar manifest is not valid JSON.");
    }

    if (!isRecord(payload)) {
      throw new Error("Custom avatar manifest must be a JSON object.");
    }

    return payload as GoonCustomAvatarManifest;
  })();

  customManifestCache.set(file.url, request);
  request.catch(() => {
    if (customManifestCache.get(file.url) === request) {
      customManifestCache.delete(file.url);
    }
  });
  return request;
}

export async function loadAvatarIntoEngine(
  engine: GoonEngine,
  goon: GoonRecord,
  options: {
    role?: "automatic" | "recipe-source" | "recipe-live-candidate" | "mounted-live";
  } = {},
) {
  const kind = resolveGoonKind(goon);
  const sourceProfile = resolveGoonSourceProfile(goon);
  const avatarUrl = resolveGoonAvatarUrl(goon);
  if (!avatarUrl) {
    throw new Error(
      kind === "custom"
        ? "Custom Goon is missing its model file."
        : "Goon is missing its VRM file.",
    );
  }

  if (kind === "custom") {
    const manifest = await loadCustomAvatarManifest(
      resolveCustomManifestFile(goon),
    );
    const isLeanLive = manifest.liveBuild !== undefined && manifest.liveBuild !== null;
    if (options.role === "recipe-source" && isLeanLive) {
      throw new Error("Recipe editor resolved a Live package instead of Recipe Source.");
    }
    if (options.role === "recipe-live-candidate" && !isLeanLive) {
      throw new Error("Recipe candidate preview resolved an authoring package instead of lean Live.");
    }
    if (
      options.role === "mounted-live" &&
      isMountedRecipeLiveGoon(goon) &&
      !isLeanLive
    ) {
      throw new Error("Mounted Recipe Goon resolved an authoring package instead of active Live.");
    }
    engine.setSocketEyeContactSettings(goon.defaults?.socketEyeContact ?? null);
    const lipArtworkEnabled = goon.lipArtworkPresence
      ? parseLipArtworkPresenceState(
          parseLipArtworkDefinition(manifest.lipArtwork),
          goon.lipArtworkPresence,
        ).enabled
      : true;
    const nailSurfaceEnabled = goon.nailSurfacePresence
      ? parseNailSurfacePresenceState(
          parseNailSurfaceDefinition(manifest.nailSurface),
          goon.nailSurfacePresence,
        ).enabled
      : true;
    await engine.loadCustomGoon(avatarUrl, manifest, {
      ...(!isLeanLive
        ? { appearanceDialValues: goon.appearanceDials ?? null }
        : {}),
      facialArtworkState: goon.facialArtwork ?? null,
      eyeAppearanceState: goon.eyeAppearance ?? null,
      oralAppearanceState: goon.oralAppearance ?? null,
      lipArtworkState: goon.lipArtwork ?? null,
      lipArtworkEnabled,
      nailSurfaceState: goon.nailSurface ?? null,
      nailSurfaceEnabled,
      skinAppearanceState: goon.skinAppearance ?? null,
      skinMaterialArtworkState: goon.skinMaterialArtwork ?? null,
    });
    return { kind, manifest, role: isLeanLive ? "live" as const : "source" as const };
  }

  if (sourceProfile === "guided-custom-vrm") {
    const manifest = await loadCustomAvatarManifest(
      resolveGuidedManifestFile(goon),
    );
    await engine.loadGoon(avatarUrl, manifest);
    await engine.configureGuidedOutfitPieces(
      goon.guidedAvatar?.outfitPieces ?? [],
      goon.guidedAvatar?.pieceStates ?? {},
      (goon.guidedAvatar?.dufOverlays ?? []).map((overlay) => ({
        id: overlay.id,
        file: overlay.file,
      })),
    );
    return { kind, manifest, role: "vrm" as const };
  }

  await engine.loadGoon(avatarUrl, null);
  return { kind, manifest: null, role: "vrm" as const };
}
