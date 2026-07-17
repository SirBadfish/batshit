import {
  isFiniteNumber,
  isRecord,
  isStableId,
} from "../appearanceDials.validation";
import type { AppearanceDialValueState } from "../appearanceDials.contracts";
import {
  canonicalRecipeSha256,
  canonicalRecipeString,
  requireLowercaseSha256,
} from "./recipeCanonical";
import {
  parseRecipeSource,
  parseRecipeStateSnapshot,
  verifyRecipeStateSnapshot,
  type RecipeJsonValue,
  type RecipeSource,
  type RecipeSiblingStateRecord,
  type RecipeStateSnapshot,
} from "./recipeContracts";
import {
  verifyRecipeComponentMapBundle,
  type RecipeComponentMapBundle,
} from "./componentMapContracts";
import {
  RECIPE_STRICT_TOLERANCE_PROFILE,
  RECIPE_STRICT_TOLERANCES,
  buildRecipeUpdateDirectEdgeKey,
  verifyRecipeUpdateEdge,
  type RecipeSiblingAction,
  type RecipeSiblingSurface,
  type RecipeStableControlKind,
  type RecipeUpdateEdge,
  type RecipeUpdatePlanAction,
  type RecipeUpdateWarning,
} from "./updateContracts";

export const RECIPE_MIGRATION_PLAN_CONTRACT =
  "recipe-migration-plan/v1" as const;

const OUTCOME_KINDS = ["automatic", "unsupported", "clean-reset"] as const;
const READINESS = ["ready", "preview-required", "blocked"] as const;
const PRESERVATION_CLAIMS = [
  "appearance-preserved",
  "values-migrated-only",
  "none",
] as const;
const CLEAN_RESET_ELIGIBILITY = [
  "eligible",
  "ineligible",
  "not-applicable",
] as const;
const CONTROL_KINDS = ["dial", "side-offset"] as const;
const EDGE_ACTIONS = [
  "keep",
  "presentation-only",
  "affine",
  "piecewise",
  "new",
  "removed",
  "reset-required",
  "blocked",
] as const;
const CONTROL_RESOLUTIONS = [
  "kept",
  "presentation-updated",
  "affine-remapped",
  "piecewise-remapped",
  "component-remapped",
  "alias-source",
  "alias-target",
  "new-neutral",
  "removed-neutral",
  "removed-component-remapped",
  "removed-active-preview",
  "reset-to-neutral",
  "blocked",
] as const;
const CANDIDATE_ORIGINS = [
  "identity",
  "edge-affine",
  "edge-piecewise",
  "component-map",
  "neutral",
  "none",
] as const;
const PROOF_STATUSES = [
  "verified",
  "not-required",
  "not-preserved",
  "failed",
] as const;
const SIBLING_SURFACES = [
  "eyeAppearance",
  "facialArtwork",
  "oralAppearance",
] as const;
const SIBLING_ACTIONS = [
  "keep",
  "migrate",
  "reset-required",
  "blocked",
  "not-present",
] as const;
const SIBLING_RESOLUTIONS = [
  "kept",
  "migrated",
  "reset",
  "not-present",
  "blocked",
] as const;
const COMPONENT_SOLVERS = [
  "identity",
  "edge-affine",
  "edge-piecewise",
  "component-map",
  "explicit-reset",
  "none",
] as const;
const COMPONENT_UNIQUENESS_METHODS = [
  "identity",
  "exact-affine",
  "exact-piecewise",
  "canonical-component-map",
  "neutral",
  "explicit-reset",
  "none",
] as const;
const COMPONENT_STATUSES = ["verified", "not-preserved", "failed"] as const;
const WHOLE_PROOF_STATUSES = [
  "verified",
  "expected-mismatch",
  "failed",
  "unavailable",
] as const;
const MISMATCH_DOMAINS = [
  "neutral",
  "material",
  "geometry",
  "rest",
  "pivot",
  "attachment",
  "grounding",
] as const;
const WARNING_CODES = ["neutral-changed", "material-changed"] as const;

export const RECIPE_MIGRATION_REJECTION_CODES = [
  "EDGE_SOURCE_MISMATCH",
  "EDGE_TARGET_MISMATCH",
  "EDGE_HASH_INVALID",
  "STABLE_LEDGER_INCOMPLETE",
  "CONTROL_IDENTITY_MISMATCH",
  "TOLERANCE_PROFILE_MISMATCH",
  "COMPONENT_GRAPH_MISMATCH",
  "COMPONENT_MEMBERSHIP_MISMATCH",
  "DEPENDENCY_MISSING",
  "COMPONENT_MAP_MISSING",
  "COMPONENT_MAP_HASH_MISMATCH",
  "COMPONENT_MAP_DOMAIN_GAP",
  "COMPONENT_MAP_DOMAIN_AMBIGUOUS",
  "ALIAS_PROOF_INVALID",
  "ALIAS_CYCLE",
  "ALIAS_TARGET_COLLISION",
  "CANDIDATE_NON_FINITE",
  "CANDIDATE_OUT_OF_RANGE",
  "CANDIDATE_UNREACHABLE",
  "CANDIDATE_AMBIGUOUS",
  "CANDIDATE_UNIQUENESS_UNPROVEN",
  "IMPLICIT_CLAMP_REQUIRED",
  "COMPONENT_PROOF_FAILED",
  "WHOLE_RECIPE_PROOF_UNAVAILABLE",
  "WHOLE_RECIPE_MISMATCH_UNEXPLAINED",
  "ABSOLUTE_GEOMETRY_PROOF_REQUIRED",
  "MATERIAL_PROOF_MISSING",
  "SIBLING_STATE_MISSING",
  "SIBLING_CONTRACT_MISMATCH",
  "SIBLING_HANDLER_MISSING",
  "SIBLING_PROOF_FAILED",
  "CLEAN_RESET_TARGET_INVALID",
  "CLEAN_RESET_SIBLING_UNSUPPORTED",
  "TAMPERED_PROOF",
] as const;

export const RECIPE_MIGRATION_REASON_CODES = [
  "UNCHANGED_IDENTITY",
  "PRESENTATION_ONLY",
  "EDGE_AFFINE_CANDIDATE",
  "EDGE_PIECEWISE_CANDIDATE",
  "COMPONENT_MAP_CANDIDATE",
  "ALIAS_COMPONENT_MAP",
  "NEW_NEUTRAL",
  "REMOVED_ZERO",
  "REMOVED_ACTIVE",
  "RESET_REQUIRED",
  "BLOCKED_BY_EDGE",
  "SIBLING_KEEP",
  "SIBLING_MIGRATE",
  "SIBLING_RESET",
  "SIBLING_NOT_PRESENT",
  "SIBLING_BLOCKED",
  "CLEAN_RESET",
] as const;

export type RecipeMigrationRejectionCode =
  (typeof RECIPE_MIGRATION_REJECTION_CODES)[number];
export type RecipeMigrationReasonCode =
  (typeof RECIPE_MIGRATION_REASON_CODES)[number];
export type RecipeMigrationOutcomeKind = (typeof OUTCOME_KINDS)[number];
export type RecipeMigrationReadiness = (typeof READINESS)[number];
export type RecipeMigrationPreservationClaim =
  (typeof PRESERVATION_CLAIMS)[number];
export type RecipeMigrationControlResolution =
  (typeof CONTROL_RESOLUTIONS)[number];
export type RecipeMigrationCandidateOrigin = (typeof CANDIDATE_ORIGINS)[number];

export type RecipeMigrationOutcome = {
  kind: RecipeMigrationOutcomeKind;
  readiness: RecipeMigrationReadiness;
  preservationClaim: RecipeMigrationPreservationClaim;
  rejectionCodes: RecipeMigrationRejectionCode[];
  cleanResetEligibility: (typeof CLEAN_RESET_ELIGIBILITY)[number];
  basedOnUnsupportedPlanSha256: string | null;
};

export type RecipeMigrationControlEndpoint = {
  id: string;
  kind: RecipeStableControlKind;
  value: number | null;
};

export type RecipeMigrationControlRow = {
  ledgerId: string;
  sourceControl: RecipeMigrationControlEndpoint | null;
  targetControl: RecipeMigrationControlEndpoint | null;
  edgeAction: RecipeUpdatePlanAction;
  componentId: string;
  resolution: RecipeMigrationControlResolution;
  aliasId: string | null;
  candidateOrigin: RecipeMigrationCandidateOrigin;
  candidateProofSha256: string | null;
  componentProofSha256: string;
  maximumScalarError: number;
  proofStatus: (typeof PROOF_STATUSES)[number];
  reasonCode: RecipeMigrationReasonCode;
  message: string;
  requiresPreview: boolean;
  requiresConfirmation: boolean;
};

export type RecipeMigrationSiblingStateRef = {
  id: string;
  contract: string;
  definitionSha256: string;
  stateSha256: string;
};

export type RecipeMigrationSiblingDefinitionRef = {
  contract: string;
  definitionSha256: string;
};

export type RecipeMigrationSiblingRow = {
  surface: RecipeSiblingSurface;
  sourceState: RecipeMigrationSiblingStateRef | null;
  targetDefinition: RecipeMigrationSiblingDefinitionRef | null;
  action: RecipeSiblingAction;
  resolution: (typeof SIBLING_RESOLUTIONS)[number];
  proposedState: RecipeSiblingStateRecord | null;
  proofStatus: (typeof PROOF_STATUSES)[number];
  proofSha256: string;
  reasonCode: RecipeMigrationReasonCode;
  message: string;
  requiresPreview: boolean;
  requiresConfirmation: boolean;
};

export type RecipePhysicalErrorSummary = {
  scalarMaximum: number;
  positionMaximumMeters: number;
  positionRmsMeters: number;
  scaleMaximum: number;
  quaternionMaximumRadians: number;
  matrixMaximum: number;
  bakedPositionMaximumMeters: number;
  bakedPositionRmsMeters: number;
};

export type RecipeMigrationComponentProof = {
  componentId: string;
  sourceControlIds: string[];
  targetControlIds: string[];
  solver: (typeof COMPONENT_SOLVERS)[number];
  authorizedCandidateCount: number;
  selectedCandidateSha256: string | null;
  uniquenessMethod: (typeof COMPONENT_UNIQUENESS_METHODS)[number];
  uniquenessProofSha256: string | null;
  componentMapSha256: string | null;
  sourcePhysicalOutputSha256: string;
  targetPhysicalOutputSha256: string | null;
  comparedOutputKeysSha256: string;
  mismatchDomains: RecipeMigrationMismatchDomain[];
  status: (typeof COMPONENT_STATUSES)[number];
  errors: RecipePhysicalErrorSummary;
  rejectionCodes: RecipeMigrationRejectionCode[];
  proofSha256: string;
};

export type RecipeMigrationMismatchDomain = (typeof MISMATCH_DOMAINS)[number];

export type RecipeMigrationWholeProof = {
  status: (typeof WHOLE_PROOF_STATUSES)[number];
  sourcePhysicalOutputSha256: string;
  targetPhysicalOutputSha256: string | null;
  sourceAbsoluteOutputSha256: string | null;
  targetAbsoluteOutputSha256: string | null;
  sourceMaterialSha256: string | null;
  targetMaterialSha256: string | null;
  materialMatches: boolean | null;
  errors: RecipePhysicalErrorSummary;
  mismatchDomains: RecipeMigrationMismatchDomain[];
  permitsAppearancePreservedClaim: boolean;
  proofSha256: string;
};

export type RecipeMigrationPlan = {
  contract: typeof RECIPE_MIGRATION_PLAN_CONTRACT;
  schemaVersion: 1;
  planId: string;
  planSha256: string;
  directEdgeKey: string;
  edgeSha256: string;
  fromSource: RecipeSource;
  toSource: RecipeSource;
  fromRecipeRevision: number;
  toRecipeRevision: number;
  fromStateSha256: string;
  toleranceProfile: typeof RECIPE_STRICT_TOLERANCE_PROFILE;
  componentMapBundleSha256: string | null;
  outcome: RecipeMigrationOutcome;
  controlRows: RecipeMigrationControlRow[];
  siblingRows: RecipeMigrationSiblingRow[];
  componentProofs: RecipeMigrationComponentProof[];
  wholeRecipeProof: RecipeMigrationWholeProof;
  warnings: RecipeUpdateWarning[];
  proposedState: RecipeStateSnapshot | null;
};

export type RecipeMigrationComponentMembership = {
  sourceControlIds: string[];
  targetControlIds: string[];
  sourceUnlockDialIds: string[];
  targetUnlockDialIds: string[];
};

export type RecipeMigrationSiblingBinding = {
  sourceStateId: string | null;
  targetStateId: string | null;
};

export type RecipeMigrationPlanVerifierContext = {
  edge: RecipeUpdateEdge;
  fromSource: RecipeSource;
  toSource: RecipeSource;
  sourceState: RecipeStateSnapshot;
  sourceControlRanges: Record<string, [number, number]>;
  targetControlRanges: Record<string, [number, number]>;
  componentMembership: Record<string, RecipeMigrationComponentMembership>;
  siblingBindings: Record<RecipeSiblingSurface, RecipeMigrationSiblingBinding>;
  componentMapBundle?: RecipeComponentMapBundle;
  eligibleUnsupportedPlan?: RecipeMigrationPlan;
};

type RecipeMigrationPlanInput = Omit<RecipeMigrationPlan, "planSha256">;
type RecipeMigrationComponentProofInput = Omit<
  RecipeMigrationComponentProof,
  "proofSha256"
>;
type RecipeMigrationWholeProofInput = Omit<
  RecipeMigrationWholeProof,
  "proofSha256"
>;

function fail(message: string): never {
  throw new Error(`[${RECIPE_MIGRATION_PLAN_CONTRACT}] ${message}`);
}

function record(value: unknown, context: string): Record<string, unknown> {
  if (!isRecord(value)) fail(`${context} must be an object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail(`${context} must be a plain object`);
  }
  return value;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  context: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    fail(`${context} must contain exactly: ${wanted.join(", ")}`);
  }
}

function array(value: unknown, context: string): unknown[] {
  if (!Array.isArray(value)) fail(`${context} must be an array`);
  return value;
}

function stableId(value: unknown, context: string): string {
  if (!isStableId(value)) fail(`${context} must be a stable id`);
  return value;
}

function text(value: unknown, context: string): string {
  if (typeof value !== "string" || value.length === 0) {
    fail(`${context} must be a non-empty string`);
  }
  return value;
}

function finite(value: unknown, context: string): number {
  if (!isFiniteNumber(value)) fail(`${context} must be finite`);
  return Object.is(value, -0) ? 0 : value;
}

function nonNegative(value: unknown, context: string): number {
  const parsed = finite(value, context);
  if (parsed < 0) fail(`${context} must be non-negative`);
  return parsed;
}

function integer(value: unknown, minimum: number, context: string): number {
  if (!Number.isInteger(value) || (value as number) < minimum) {
    fail(`${context} must be an integer >= ${minimum}`);
  }
  return value as number;
}

function boolean(value: unknown, context: string): boolean {
  if (typeof value !== "boolean") fail(`${context} must be boolean`);
  return value;
}

function nullableSha(value: unknown, context: string): string | null {
  return value === null ? null : requireLowercaseSha256(value, context);
}

function enumValue<T extends string>(
  value: unknown,
  allowed: readonly T[],
  context: string,
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    fail(`${context} is invalid`);
  }
  return value as T;
}

function assertSortedUnique(values: string[], context: string): void {
  for (let index = 1; index < values.length; index += 1) {
    if (values[index - 1] >= values[index]) {
      fail(`${context} must be sorted and unique`);
    }
  }
}

function enumList<T extends string>(
  value: unknown,
  allowed: readonly T[],
  context: string,
): T[] {
  const values = array(value, context).map((entry, index) =>
    enumValue(entry, allowed, `${context}[${index}]`),
  );
  assertSortedUnique(values, context);
  return values;
}

function stableIdList(value: unknown, context: string): string[] {
  const values = array(value, context).map((entry, index) =>
    stableId(entry, `${context}[${index}]`),
  );
  assertSortedUnique(values, context);
  return values;
}

function sameStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalRecipeString(left) === canonicalRecipeString(right);
}

function parseOutcome(value: unknown): RecipeMigrationOutcome {
  const context = "migration outcome";
  const raw = record(value, context);
  exactKeys(
    raw,
    [
      "kind",
      "readiness",
      "preservationClaim",
      "rejectionCodes",
      "cleanResetEligibility",
      "basedOnUnsupportedPlanSha256",
    ],
    context,
  );
  const outcome: RecipeMigrationOutcome = {
    kind: enumValue(raw.kind, OUTCOME_KINDS, `${context}.kind`),
    readiness: enumValue(raw.readiness, READINESS, `${context}.readiness`),
    preservationClaim: enumValue(
      raw.preservationClaim,
      PRESERVATION_CLAIMS,
      `${context}.preservationClaim`,
    ),
    rejectionCodes: enumList(
      raw.rejectionCodes,
      RECIPE_MIGRATION_REJECTION_CODES,
      `${context}.rejectionCodes`,
    ),
    cleanResetEligibility: enumValue(
      raw.cleanResetEligibility,
      CLEAN_RESET_ELIGIBILITY,
      `${context}.cleanResetEligibility`,
    ),
    basedOnUnsupportedPlanSha256: nullableSha(
      raw.basedOnUnsupportedPlanSha256,
      `${context}.basedOnUnsupportedPlanSha256`,
    ),
  };
  if (outcome.kind === "automatic") {
    if (
      outcome.readiness === "blocked" ||
      outcome.rejectionCodes.length !== 0 ||
      outcome.cleanResetEligibility !== "not-applicable" ||
      outcome.basedOnUnsupportedPlanSha256 !== null
    ) {
      fail("automatic outcome is contradictory");
    }
  } else if (outcome.kind === "unsupported") {
    if (
      outcome.readiness !== "blocked" ||
      outcome.preservationClaim !== "none" ||
      outcome.rejectionCodes.length === 0 ||
      outcome.cleanResetEligibility === "not-applicable" ||
      outcome.basedOnUnsupportedPlanSha256 !== null
    ) {
      fail("unsupported outcome is contradictory");
    }
  } else if (
    outcome.readiness !== "preview-required" ||
    outcome.preservationClaim !== "none" ||
    outcome.rejectionCodes.length !== 0 ||
    outcome.cleanResetEligibility !== "not-applicable" ||
    outcome.basedOnUnsupportedPlanSha256 === null
  ) {
    fail("clean-reset outcome is contradictory");
  }
  return outcome;
}

function parseControlEndpoint(
  value: unknown,
  context: string,
): RecipeMigrationControlEndpoint | null {
  if (value === null) return null;
  const raw = record(value, context);
  exactKeys(raw, ["id", "kind", "value"], context);
  return {
    id: stableId(raw.id, `${context}.id`),
    kind: enumValue(raw.kind, CONTROL_KINDS, `${context}.kind`),
    value: raw.value === null ? null : finite(raw.value, `${context}.value`),
  };
}

function parseControlRow(
  value: unknown,
  index: number,
): RecipeMigrationControlRow {
  const context = `migration control row ${index}`;
  const raw = record(value, context);
  exactKeys(
    raw,
    [
      "ledgerId",
      "sourceControl",
      "targetControl",
      "edgeAction",
      "componentId",
      "resolution",
      "aliasId",
      "candidateOrigin",
      "candidateProofSha256",
      "componentProofSha256",
      "maximumScalarError",
      "proofStatus",
      "reasonCode",
      "message",
      "requiresPreview",
      "requiresConfirmation",
    ],
    context,
  );
  return {
    ledgerId: stableId(raw.ledgerId, `${context}.ledgerId`),
    sourceControl: parseControlEndpoint(
      raw.sourceControl,
      `${context}.sourceControl`,
    ),
    targetControl: parseControlEndpoint(
      raw.targetControl,
      `${context}.targetControl`,
    ),
    edgeAction: enumValue(
      raw.edgeAction,
      EDGE_ACTIONS,
      `${context}.edgeAction`,
    ),
    componentId: stableId(raw.componentId, `${context}.componentId`),
    resolution: enumValue(
      raw.resolution,
      CONTROL_RESOLUTIONS,
      `${context}.resolution`,
    ),
    aliasId:
      raw.aliasId === null ? null : stableId(raw.aliasId, `${context}.aliasId`),
    candidateOrigin: enumValue(
      raw.candidateOrigin,
      CANDIDATE_ORIGINS,
      `${context}.candidateOrigin`,
    ),
    candidateProofSha256: nullableSha(
      raw.candidateProofSha256,
      `${context}.candidateProofSha256`,
    ),
    componentProofSha256: requireLowercaseSha256(
      raw.componentProofSha256,
      `${context}.componentProofSha256`,
    ),
    maximumScalarError: nonNegative(
      raw.maximumScalarError,
      `${context}.maximumScalarError`,
    ),
    proofStatus: enumValue(
      raw.proofStatus,
      PROOF_STATUSES,
      `${context}.proofStatus`,
    ),
    reasonCode: enumValue(
      raw.reasonCode,
      RECIPE_MIGRATION_REASON_CODES,
      `${context}.reasonCode`,
    ),
    message: text(raw.message, `${context}.message`),
    requiresPreview: boolean(raw.requiresPreview, `${context}.requiresPreview`),
    requiresConfirmation: boolean(
      raw.requiresConfirmation,
      `${context}.requiresConfirmation`,
    ),
  };
}

function parseSiblingStateRef(
  value: unknown,
  context: string,
): RecipeMigrationSiblingStateRef | null {
  if (value === null) return null;
  const raw = record(value, context);
  exactKeys(
    raw,
    ["id", "contract", "definitionSha256", "stateSha256"],
    context,
  );
  return {
    id: stableId(raw.id, `${context}.id`),
    contract: text(raw.contract, `${context}.contract`),
    definitionSha256: requireLowercaseSha256(
      raw.definitionSha256,
      `${context}.definitionSha256`,
    ),
    stateSha256: requireLowercaseSha256(
      raw.stateSha256,
      `${context}.stateSha256`,
    ),
  };
}

function parseSiblingDefinitionRef(
  value: unknown,
  context: string,
): RecipeMigrationSiblingDefinitionRef | null {
  if (value === null) return null;
  const raw = record(value, context);
  exactKeys(raw, ["contract", "definitionSha256"], context);
  return {
    contract: text(raw.contract, `${context}.contract`),
    definitionSha256: requireLowercaseSha256(
      raw.definitionSha256,
      `${context}.definitionSha256`,
    ),
  };
}

function parseSiblingState(
  value: unknown,
  context: string,
): RecipeSiblingStateRecord | null {
  if (value === null) return null;
  const raw = record(value, context);
  exactKeys(
    raw,
    ["id", "contract", "definitionSha256", "stateSha256", "state"],
    context,
  );
  const state = record(raw.state, `${context}.state`);
  canonicalRecipeString(state);
  return {
    id: stableId(raw.id, `${context}.id`),
    contract: text(raw.contract, `${context}.contract`),
    definitionSha256: requireLowercaseSha256(
      raw.definitionSha256,
      `${context}.definitionSha256`,
    ),
    stateSha256: requireLowercaseSha256(
      raw.stateSha256,
      `${context}.stateSha256`,
    ),
    state: state as { [key: string]: RecipeJsonValue },
  };
}

function parseSiblingRow(
  value: unknown,
  index: number,
): RecipeMigrationSiblingRow {
  const context = `migration sibling row ${index}`;
  const raw = record(value, context);
  exactKeys(
    raw,
    [
      "surface",
      "sourceState",
      "targetDefinition",
      "action",
      "resolution",
      "proposedState",
      "proofStatus",
      "proofSha256",
      "reasonCode",
      "message",
      "requiresPreview",
      "requiresConfirmation",
    ],
    context,
  );
  return {
    surface: enumValue(raw.surface, SIBLING_SURFACES, `${context}.surface`),
    sourceState: parseSiblingStateRef(
      raw.sourceState,
      `${context}.sourceState`,
    ),
    targetDefinition: parseSiblingDefinitionRef(
      raw.targetDefinition,
      `${context}.targetDefinition`,
    ),
    action: enumValue(raw.action, SIBLING_ACTIONS, `${context}.action`),
    resolution: enumValue(
      raw.resolution,
      SIBLING_RESOLUTIONS,
      `${context}.resolution`,
    ),
    proposedState: parseSiblingState(
      raw.proposedState,
      `${context}.proposedState`,
    ),
    proofStatus: enumValue(
      raw.proofStatus,
      PROOF_STATUSES,
      `${context}.proofStatus`,
    ),
    proofSha256: requireLowercaseSha256(
      raw.proofSha256,
      `${context}.proofSha256`,
    ),
    reasonCode: enumValue(
      raw.reasonCode,
      RECIPE_MIGRATION_REASON_CODES,
      `${context}.reasonCode`,
    ),
    message: text(raw.message, `${context}.message`),
    requiresPreview: boolean(raw.requiresPreview, `${context}.requiresPreview`),
    requiresConfirmation: boolean(
      raw.requiresConfirmation,
      `${context}.requiresConfirmation`,
    ),
  };
}

function parseErrors(
  value: unknown,
  context: string,
): RecipePhysicalErrorSummary {
  const raw = record(value, context);
  exactKeys(
    raw,
    [
      "scalarMaximum",
      "positionMaximumMeters",
      "positionRmsMeters",
      "scaleMaximum",
      "quaternionMaximumRadians",
      "matrixMaximum",
      "bakedPositionMaximumMeters",
      "bakedPositionRmsMeters",
    ],
    context,
  );
  return {
    scalarMaximum: nonNegative(raw.scalarMaximum, `${context}.scalarMaximum`),
    positionMaximumMeters: nonNegative(
      raw.positionMaximumMeters,
      `${context}.positionMaximumMeters`,
    ),
    positionRmsMeters: nonNegative(
      raw.positionRmsMeters,
      `${context}.positionRmsMeters`,
    ),
    scaleMaximum: nonNegative(raw.scaleMaximum, `${context}.scaleMaximum`),
    quaternionMaximumRadians: nonNegative(
      raw.quaternionMaximumRadians,
      `${context}.quaternionMaximumRadians`,
    ),
    matrixMaximum: nonNegative(raw.matrixMaximum, `${context}.matrixMaximum`),
    bakedPositionMaximumMeters: nonNegative(
      raw.bakedPositionMaximumMeters,
      `${context}.bakedPositionMaximumMeters`,
    ),
    bakedPositionRmsMeters: nonNegative(
      raw.bakedPositionRmsMeters,
      `${context}.bakedPositionRmsMeters`,
    ),
  };
}

function parseComponentProof(
  value: unknown,
  index: number,
): RecipeMigrationComponentProof {
  const context = `migration component proof ${index}`;
  const raw = record(value, context);
  exactKeys(
    raw,
    [
      "componentId",
      "sourceControlIds",
      "targetControlIds",
      "solver",
      "authorizedCandidateCount",
      "selectedCandidateSha256",
      "uniquenessMethod",
      "uniquenessProofSha256",
      "componentMapSha256",
      "sourcePhysicalOutputSha256",
      "targetPhysicalOutputSha256",
      "comparedOutputKeysSha256",
      "mismatchDomains",
      "status",
      "errors",
      "rejectionCodes",
      "proofSha256",
    ],
    context,
  );
  const authorizedCandidateCount = integer(
    raw.authorizedCandidateCount,
    0,
    `${context}.authorizedCandidateCount`,
  );
  if (authorizedCandidateCount > 1) {
    fail(`${context}.authorizedCandidateCount must be zero or one`);
  }
  const selectedCandidateSha256 = nullableSha(
    raw.selectedCandidateSha256,
    `${context}.selectedCandidateSha256`,
  );
  if ((authorizedCandidateCount === 1) !== (selectedCandidateSha256 !== null)) {
    fail(`${context} candidate selection is contradictory`);
  }
  const uniquenessMethod = enumValue(
    raw.uniquenessMethod,
    COMPONENT_UNIQUENESS_METHODS,
    `${context}.uniquenessMethod`,
  );
  const uniquenessProofSha256 = nullableSha(
    raw.uniquenessProofSha256,
    `${context}.uniquenessProofSha256`,
  );
  if (
    (authorizedCandidateCount === 1) !==
      (uniquenessMethod !== "none" && uniquenessProofSha256 !== null) ||
    (authorizedCandidateCount === 0 &&
      (uniquenessMethod !== "none" || uniquenessProofSha256 !== null))
  ) {
    fail(`${context} uniqueness proof is contradictory`);
  }
  return {
    componentId: stableId(raw.componentId, `${context}.componentId`),
    sourceControlIds: stableIdList(
      raw.sourceControlIds,
      `${context}.sourceControlIds`,
    ),
    targetControlIds: stableIdList(
      raw.targetControlIds,
      `${context}.targetControlIds`,
    ),
    solver: enumValue(raw.solver, COMPONENT_SOLVERS, `${context}.solver`),
    authorizedCandidateCount,
    selectedCandidateSha256,
    uniquenessMethod,
    uniquenessProofSha256,
    componentMapSha256: nullableSha(
      raw.componentMapSha256,
      `${context}.componentMapSha256`,
    ),
    sourcePhysicalOutputSha256: requireLowercaseSha256(
      raw.sourcePhysicalOutputSha256,
      `${context}.sourcePhysicalOutputSha256`,
    ),
    targetPhysicalOutputSha256: nullableSha(
      raw.targetPhysicalOutputSha256,
      `${context}.targetPhysicalOutputSha256`,
    ),
    comparedOutputKeysSha256: requireLowercaseSha256(
      raw.comparedOutputKeysSha256,
      `${context}.comparedOutputKeysSha256`,
    ),
    mismatchDomains: enumList(
      raw.mismatchDomains,
      MISMATCH_DOMAINS,
      `${context}.mismatchDomains`,
    ),
    status: enumValue(raw.status, COMPONENT_STATUSES, `${context}.status`),
    errors: parseErrors(raw.errors, `${context}.errors`),
    rejectionCodes: enumList(
      raw.rejectionCodes,
      RECIPE_MIGRATION_REJECTION_CODES,
      `${context}.rejectionCodes`,
    ),
    proofSha256: requireLowercaseSha256(
      raw.proofSha256,
      `${context}.proofSha256`,
    ),
  };
}

function parseWholeProof(value: unknown): RecipeMigrationWholeProof {
  const context = "migration whole-Recipe proof";
  const raw = record(value, context);
  exactKeys(
    raw,
    [
      "status",
      "sourcePhysicalOutputSha256",
      "targetPhysicalOutputSha256",
      "sourceAbsoluteOutputSha256",
      "targetAbsoluteOutputSha256",
      "sourceMaterialSha256",
      "targetMaterialSha256",
      "materialMatches",
      "errors",
      "mismatchDomains",
      "permitsAppearancePreservedClaim",
      "proofSha256",
    ],
    context,
  );
  const materialMatches =
    raw.materialMatches === null
      ? null
      : boolean(raw.materialMatches, `${context}.materialMatches`);
  return {
    status: enumValue(raw.status, WHOLE_PROOF_STATUSES, `${context}.status`),
    sourcePhysicalOutputSha256: requireLowercaseSha256(
      raw.sourcePhysicalOutputSha256,
      `${context}.sourcePhysicalOutputSha256`,
    ),
    targetPhysicalOutputSha256: nullableSha(
      raw.targetPhysicalOutputSha256,
      `${context}.targetPhysicalOutputSha256`,
    ),
    sourceAbsoluteOutputSha256: nullableSha(
      raw.sourceAbsoluteOutputSha256,
      `${context}.sourceAbsoluteOutputSha256`,
    ),
    targetAbsoluteOutputSha256: nullableSha(
      raw.targetAbsoluteOutputSha256,
      `${context}.targetAbsoluteOutputSha256`,
    ),
    sourceMaterialSha256: nullableSha(
      raw.sourceMaterialSha256,
      `${context}.sourceMaterialSha256`,
    ),
    targetMaterialSha256: nullableSha(
      raw.targetMaterialSha256,
      `${context}.targetMaterialSha256`,
    ),
    materialMatches,
    errors: parseErrors(raw.errors, `${context}.errors`),
    mismatchDomains: enumList(
      raw.mismatchDomains,
      MISMATCH_DOMAINS,
      `${context}.mismatchDomains`,
    ),
    permitsAppearancePreservedClaim: boolean(
      raw.permitsAppearancePreservedClaim,
      `${context}.permitsAppearancePreservedClaim`,
    ),
    proofSha256: requireLowercaseSha256(
      raw.proofSha256,
      `${context}.proofSha256`,
    ),
  };
}

function parseWarning(value: unknown, index: number): RecipeUpdateWarning {
  const context = `migration warning ${index}`;
  const raw = record(value, context);
  exactKeys(
    raw,
    ["code", "message", "requiresPreview", "proofSha256"],
    context,
  );
  if (raw.requiresPreview !== true) fail(`${context} must require preview`);
  return {
    code: enumValue(raw.code, WARNING_CODES, `${context}.code`),
    message: text(raw.message, `${context}.message`),
    requiresPreview: true,
    proofSha256: requireLowercaseSha256(
      raw.proofSha256,
      `${context}.proofSha256`,
    ),
  };
}

export function parseRecipeMigrationPlan(value: unknown): RecipeMigrationPlan {
  canonicalRecipeString(value);
  const context = "recipe migration plan";
  const raw = record(value, context);
  exactKeys(
    raw,
    [
      "contract",
      "schemaVersion",
      "planId",
      "planSha256",
      "directEdgeKey",
      "edgeSha256",
      "fromSource",
      "toSource",
      "fromRecipeRevision",
      "toRecipeRevision",
      "fromStateSha256",
      "toleranceProfile",
      "componentMapBundleSha256",
      "outcome",
      "controlRows",
      "siblingRows",
      "componentProofs",
      "wholeRecipeProof",
      "warnings",
      "proposedState",
    ],
    context,
  );
  if (
    raw.contract !== RECIPE_MIGRATION_PLAN_CONTRACT ||
    raw.schemaVersion !== 1
  ) {
    fail("contract identity is invalid");
  }
  const fromRecipeRevision = integer(
    raw.fromRecipeRevision,
    1,
    `${context}.fromRecipeRevision`,
  );
  const toRecipeRevision = integer(
    raw.toRecipeRevision,
    2,
    `${context}.toRecipeRevision`,
  );
  if (toRecipeRevision <= fromRecipeRevision) {
    fail("recipe revisions are not monotonic");
  }
  if (raw.toleranceProfile !== RECIPE_STRICT_TOLERANCE_PROFILE) {
    fail("tolerance profile is invalid");
  }
  const outcome = parseOutcome(raw.outcome);
  const controlRows = array(raw.controlRows, `${context}.controlRows`).map(
    parseControlRow,
  );
  assertSortedUnique(
    controlRows.map((row) => row.ledgerId),
    `${context}.controlRows`,
  );
  const siblingRows = array(raw.siblingRows, `${context}.siblingRows`).map(
    parseSiblingRow,
  );
  if (
    siblingRows.length !== SIBLING_SURFACES.length ||
    !sameStrings(
      siblingRows.map((row) => row.surface),
      SIBLING_SURFACES,
    )
  ) {
    fail("sibling rows must contain exactly the three named surfaces");
  }
  const componentProofs = array(
    raw.componentProofs,
    `${context}.componentProofs`,
  ).map(parseComponentProof);
  assertSortedUnique(
    componentProofs.map((proof) => proof.componentId),
    `${context}.componentProofs`,
  );
  const warnings = array(raw.warnings, `${context}.warnings`).map(parseWarning);
  assertSortedUnique(
    warnings.map((warning) => warning.code),
    `${context}.warnings`,
  );
  const proposedState =
    raw.proposedState === null
      ? null
      : parseRecipeStateSnapshot(raw.proposedState);
  if ((outcome.kind === "unsupported") !== (proposedState === null)) {
    fail("outcome contradicts proposed state availability");
  }
  return {
    contract: RECIPE_MIGRATION_PLAN_CONTRACT,
    schemaVersion: 1,
    planId: stableId(raw.planId, `${context}.planId`),
    planSha256: requireLowercaseSha256(raw.planSha256, `${context}.planSha256`),
    directEdgeKey: text(raw.directEdgeKey, `${context}.directEdgeKey`),
    edgeSha256: requireLowercaseSha256(raw.edgeSha256, `${context}.edgeSha256`),
    fromSource: parseRecipeSource(raw.fromSource, `${context}.fromSource`),
    toSource: parseRecipeSource(raw.toSource, `${context}.toSource`),
    fromRecipeRevision,
    toRecipeRevision,
    fromStateSha256: requireLowercaseSha256(
      raw.fromStateSha256,
      `${context}.fromStateSha256`,
    ),
    toleranceProfile: RECIPE_STRICT_TOLERANCE_PROFILE,
    componentMapBundleSha256: nullableSha(
      raw.componentMapBundleSha256,
      `${context}.componentMapBundleSha256`,
    ),
    outcome,
    controlRows,
    siblingRows,
    componentProofs,
    wholeRecipeProof: parseWholeProof(raw.wholeRecipeProof),
    warnings,
    proposedState,
  };
}

function planHashContent(
  plan: RecipeMigrationPlan,
): Omit<RecipeMigrationPlan, "planSha256"> {
  const { planSha256: _planSha256, ...content } = plan;
  return content;
}

function componentProofHashContent(
  proof: RecipeMigrationComponentProof,
): RecipeMigrationComponentProofInput {
  const { proofSha256: _proofSha256, ...content } = proof;
  return content;
}

function wholeProofHashContent(
  proof: RecipeMigrationWholeProof,
): RecipeMigrationWholeProofInput {
  const { proofSha256: _proofSha256, ...content } = proof;
  return content;
}

export async function recipeMigrationComponentProofSha256(
  value: unknown,
): Promise<string> {
  const proof = parseComponentProof(value, 0);
  return canonicalRecipeSha256(componentProofHashContent(proof));
}

export async function recipeMigrationWholeProofSha256(
  value: unknown,
): Promise<string> {
  const proof = parseWholeProof(value);
  return canonicalRecipeSha256(wholeProofHashContent(proof));
}

export async function recipeMigrationPlanSha256(
  value: unknown,
): Promise<string> {
  const plan = parseRecipeMigrationPlan(value);
  return canonicalRecipeSha256(planHashContent(plan));
}

export async function createRecipeMigrationPlan(
  value: RecipeMigrationPlanInput,
): Promise<RecipeMigrationPlan> {
  canonicalRecipeString(value);
  const componentProofs = await Promise.all(
    value.componentProofs.map(async (proof) => {
      const content = componentProofHashContent(proof);
      const proofSha256 = await canonicalRecipeSha256(content);
      if (
        proof.proofSha256 !== "0".repeat(64) &&
        proof.proofSha256 !== proofSha256
      ) {
        fail(`component proof ${proof.componentId} supplied a stale hash`);
      }
      return {
        ...content,
        proofSha256,
      };
    }),
  );
  const proofShaByComponent = new Map(
    componentProofs.map((proof) => [proof.componentId, proof.proofSha256]),
  );
  const controlRows = value.controlRows.map((row) => {
    const componentProofSha256 = proofShaByComponent.get(row.componentId);
    if (!componentProofSha256) {
      fail(`control row ${row.ledgerId} references a missing component proof`);
    }
    if (
      row.componentProofSha256 !== "0".repeat(64) &&
      row.componentProofSha256 !== componentProofSha256
    ) {
      fail(`control row ${row.ledgerId} supplied a contradictory proof link`);
    }
    return { ...row, componentProofSha256 };
  });
  const wholeContent = wholeProofHashContent(value.wholeRecipeProof);
  const wholeProofSha256 = await canonicalRecipeSha256(wholeContent);
  if (
    value.wholeRecipeProof.proofSha256 !== "0".repeat(64) &&
    value.wholeRecipeProof.proofSha256 !== wholeProofSha256
  ) {
    fail("whole-Recipe proof supplied a stale hash");
  }
  const wholeRecipeProof = {
    ...wholeContent,
    proofSha256: wholeProofSha256,
  };
  const normalized = {
    ...value,
    controlRows,
    componentProofs,
    wholeRecipeProof,
  };
  const planSha256 = await canonicalRecipeSha256(normalized);
  return parseRecipeMigrationPlan({ ...normalized, planSha256 });
}

function assertTargetAppearanceState(
  state: AppearanceDialValueState,
  edge: RecipeUpdateEdge,
  ranges: Record<string, [number, number]>,
  requireCleanReset: boolean,
): void {
  if (
    state.definitionSha256 !== edge.to.definitionSha256 ||
    state.neutralId !== edge.to.neutralId ||
    state.neutralRecipeSha256 !== edge.to.neutralRecipeSha256
  ) {
    fail("proposed Appearance state does not bind the target source");
  }
  const targetIds = Object.keys(ranges).sort();
  const actualIds = Object.keys(state.values).sort();
  if (!sameStrings(actualIds, targetIds)) {
    fail("proposed Appearance state is not exhaustive");
  }
  for (const id of targetIds) {
    const range = ranges[id];
    const value = finite(state.values[id], `proposed Appearance value ${id}`);
    if (
      !range ||
      !range.every(Number.isFinite) ||
      value < range[0] ||
      value > range[1]
    ) {
      fail(`proposed Appearance value ${id} is out of range`);
    }
    if (requireCleanReset && value !== 0) {
      fail(`clean reset Appearance value ${id} is not zero`);
    }
  }
  assertSortedUnique(state.unlockedDialIds, "proposed Appearance unlock ids");
  if (requireCleanReset && state.unlockedDialIds.length !== 0) {
    fail("clean reset must relock every Appearance dial");
  }
}

function expectedWarnings(edge: RecipeUpdateEdge): string[] {
  return edge.warnings.map((warning) => canonicalRecipeString(warning)).sort();
}

function assertControlCoverage(
  plan: RecipeMigrationPlan,
  edge: RecipeUpdateEdge,
  sourceState: RecipeStateSnapshot,
): void {
  const ledgerEntries = new Map(
    edge.stableIdLedger.entries.map((entry) => [entry.id, entry]),
  );
  if (
    !sameStrings(
      Object.keys(sourceState.appearanceDials.values).sort(),
      edge.stableIdLedger.fromIds,
    )
  ) {
    fail("source Appearance state does not exhaust the stable-id ledger");
  }
  if (
    !sameStrings(
      plan.controlRows.map((row) => row.ledgerId),
      [...ledgerEntries.keys()].sort(),
    )
  ) {
    fail("control rows do not exhaust the stable-id ledger");
  }
  const controls = new Map(
    edge.controls.map((control) => [control.id, control]),
  );
  const aliases = new Map<string, { fromId: string; toId: string }>();
  for (const alias of edge.aliases) {
    const aliasId = `${alias.fromId}:${alias.toId}`;
    aliases.set(alias.fromId, { fromId: alias.fromId, toId: alias.toId });
    aliases.set(alias.toId, { fromId: alias.fromId, toId: alias.toId });
    const rows = plan.controlRows.filter((row) => row.aliasId === aliasId);
    if (rows.length !== 2)
      fail(`alias ${aliasId} does not own exactly two rows`);
  }
  for (const row of plan.controlRows) {
    const ledger = ledgerEntries.get(row.ledgerId);
    const control = controls.get(row.ledgerId);
    if (
      !ledger ||
      !control ||
      row.edgeAction !== control.action ||
      row.componentId !== control.componentId
    ) {
      fail(`control row ${row.ledgerId} contradicts its edge`);
    }
    const alias = aliases.get(row.ledgerId);
    const expectedAliasId = alias ? `${alias.fromId}:${alias.toId}` : null;
    if (row.aliasId !== expectedAliasId) {
      fail(`control row ${row.ledgerId} contradicts its alias proof`);
    }
    if (Boolean(row.sourceControl) !== Boolean(ledger.fromKind)) {
      fail(`control row ${row.ledgerId} contradicts source presence`);
    }
    if (Boolean(row.targetControl) !== Boolean(ledger.toKind)) {
      fail(`control row ${row.ledgerId} contradicts target presence`);
    }
    if (row.sourceControl) {
      if (
        row.sourceControl.id !== row.ledgerId ||
        row.sourceControl.kind !== ledger.fromKind ||
        row.sourceControl.value === null ||
        row.sourceControl.value !==
          sourceState.appearanceDials.values[row.ledgerId]
      ) {
        fail(`control row ${row.ledgerId} source value is not exact`);
      }
    }
    if (
      row.targetControl &&
      (row.targetControl.id !== row.ledgerId ||
        row.targetControl.kind !== ledger.toKind)
    ) {
      fail(`control row ${row.ledgerId} target identity is invalid`);
    }
    if (
      plan.outcome.kind !== "unsupported" &&
      row.targetControl?.value === null
    ) {
      fail(`control row ${row.ledgerId} is missing its proposed target value`);
    }
    if (
      plan.outcome.kind === "unsupported" &&
      row.targetControl !== null &&
      row.targetControl.value !== null
    ) {
      fail(`unsupported control row ${row.ledgerId} invented a target value`);
    }
    if (
      plan.outcome.kind !== "unsupported" &&
      (row.resolution === "new-neutral" ||
        row.resolution === "reset-to-neutral") &&
      row.targetControl?.value !== 0
    ) {
      fail(`control row ${row.ledgerId} does not resolve to exact neutral`);
    }
    if (row.resolution === "removed-neutral") {
      if (
        row.sourceControl?.value !== 0 ||
        row.targetControl !== null ||
        (plan.outcome.kind !== "clean-reset" && row.requiresConfirmation)
      ) {
        fail(`control row ${row.ledgerId} has an invalid neutral removal`);
      }
    }
    if (row.resolution === "removed-active-preview") {
      if (
        row.sourceControl?.value === null ||
        row.sourceControl?.value === 0 ||
        row.targetControl !== null ||
        !row.requiresPreview ||
        !row.requiresConfirmation
      ) {
        fail(`control row ${row.ledgerId} has an invalid active removal`);
      }
    }
    if (row.resolution === "removed-component-remapped") {
      if (
        row.sourceControl?.value === null ||
        row.sourceControl?.value === 0 ||
        row.targetControl !== null ||
        row.candidateOrigin !== "component-map" ||
        row.proofStatus !== "verified"
      ) {
        fail(`control row ${row.ledgerId} has an invalid mapped removal`);
      }
    }
    if (
      plan.outcome.kind !== "unsupported" &&
      row.resolution === "reset-to-neutral" &&
      (!row.requiresPreview ||
        !row.requiresConfirmation ||
        row.proofStatus !== "not-preserved")
    ) {
      fail(`control row ${row.ledgerId} has an invalid explicit reset`);
    }
  }
}

function assertComponentCoverage(
  plan: RecipeMigrationPlan,
  memberships: Record<string, RecipeMigrationComponentMembership>,
): void {
  const componentIds = Object.keys(memberships).sort();
  if (
    !sameStrings(
      plan.componentProofs.map((proof) => proof.componentId),
      componentIds,
    )
  ) {
    fail("component proofs do not exhaust graph membership");
  }
  const proofs = new Map(
    plan.componentProofs.map((proof) => [proof.componentId, proof]),
  );
  for (const componentId of componentIds) {
    const proof = proofs.get(componentId)!;
    const membership = memberships[componentId];
    if (
      !sameStrings(proof.sourceControlIds, membership.sourceControlIds) ||
      !sameStrings(proof.targetControlIds, membership.targetControlIds)
    ) {
      fail(`component proof ${componentId} contradicts graph membership`);
    }
  }
  for (const row of plan.controlRows) {
    const proof = proofs.get(row.componentId);
    if (!proof || row.componentProofSha256 !== proof.proofSha256) {
      fail(`control row ${row.ledgerId} has no matching component proof`);
    }
  }
}

function assertSiblingCoverage(
  plan: RecipeMigrationPlan,
  edge: RecipeUpdateEdge,
  sourceState: RecipeStateSnapshot,
  bindings: Record<RecipeSiblingSurface, RecipeMigrationSiblingBinding>,
): void {
  const boundSourceIds = plan.siblingRows
    .map((row) => bindings[row.surface]?.sourceStateId ?? null)
    .filter((id): id is string => id !== null)
    .sort();
  const sourceIds = sourceState.siblings.map((state) => state.id).sort();
  if (!sameStrings(boundSourceIds, sourceIds)) {
    fail("sibling bindings do not exhaust source Recipe state");
  }
  const targetIds = plan.siblingRows
    .map((row) => bindings[row.surface]?.targetStateId ?? null)
    .filter((id): id is string => id !== null);
  if (new Set(targetIds).size !== targetIds.length) {
    fail("sibling bindings reuse a target state id");
  }
  const sourceById = new Map(
    sourceState.siblings.map((state) => [state.id, state]),
  );
  const proposedById = new Map(
    (plan.proposedState?.siblings ?? []).map((state) => [state.id, state]),
  );
  const subplans = new Map(
    edge.siblingSubplans.map((subplan) => [subplan.surface, subplan]),
  );
  for (const row of plan.siblingRows) {
    const binding = bindings[row.surface];
    const subplan = subplans.get(row.surface);
    if (!binding || !subplan || row.action !== subplan.action) {
      fail(`sibling row ${row.surface} contradicts its edge`);
    }
    if (
      (subplan.fromContract === null) !== (binding.sourceStateId === null) ||
      (subplan.toContract === null) !== (row.targetDefinition === null)
    ) {
      fail(`sibling row ${row.surface} contradicts edge presence`);
    }
    if (row.sourceState && row.sourceState.contract !== subplan.fromContract) {
      fail(`sibling row ${row.surface} source contract is not bound`);
    }
    if (
      row.targetDefinition &&
      row.targetDefinition.contract !== subplan.toContract
    ) {
      fail(`sibling row ${row.surface} target contract is not bound`);
    }
    if (binding.sourceStateId === null) {
      if (row.sourceState !== null)
        fail(`sibling row ${row.surface} invented source state`);
    } else {
      const source = sourceById.get(binding.sourceStateId);
      if (
        !source ||
        !row.sourceState ||
        !sameJson(row.sourceState, {
          id: source.id,
          contract: source.contract,
          definitionSha256: source.definitionSha256,
          stateSha256: source.stateSha256,
        })
      ) {
        fail(`sibling row ${row.surface} source state is not bound`);
      }
    }
    if (binding.targetStateId === null) {
      if (row.proposedState !== null)
        fail(`sibling row ${row.surface} invented target state`);
    } else if (plan.proposedState) {
      const target = proposedById.get(binding.targetStateId);
      if (
        !target ||
        !row.proposedState ||
        !sameJson(target, row.proposedState)
      ) {
        fail(`sibling row ${row.surface} target state is not bound`);
      }
      if (
        !row.targetDefinition ||
        row.targetDefinition.contract !== target.contract ||
        row.targetDefinition.definitionSha256 !== target.definitionSha256
      ) {
        fail(`sibling row ${row.surface} target definition is not bound`);
      }
    }
    if (plan.outcome.kind === "clean-reset" && row.resolution === "reset") {
      if (!row.requiresPreview || !row.requiresConfirmation) {
        fail(`clean reset sibling ${row.surface} lacks confirmation`);
      }
    }
  }
}

function assertOutcomeProofConsistency(plan: RecipeMigrationPlan): void {
  const assertVerifiedErrors = (
    errors: RecipePhysicalErrorSummary,
    context: string,
  ) => {
    if (
      errors.scalarMaximum > RECIPE_STRICT_TOLERANCES.scalar ||
      errors.positionMaximumMeters > RECIPE_STRICT_TOLERANCES.positionMeters ||
      errors.positionRmsMeters > RECIPE_STRICT_TOLERANCES.positionMeters ||
      errors.scaleMaximum > RECIPE_STRICT_TOLERANCES.scale ||
      errors.quaternionMaximumRadians >
        RECIPE_STRICT_TOLERANCES.quaternionRadians ||
      errors.matrixMaximum > RECIPE_STRICT_TOLERANCES.matrix ||
      errors.bakedPositionMaximumMeters >
        RECIPE_STRICT_TOLERANCES.positionMeters ||
      errors.bakedPositionRmsMeters > RECIPE_STRICT_TOLERANCES.positionMeters
    ) {
      fail(`${context} exceeds the locked tolerance profile`);
    }
  };
  for (const proof of plan.componentProofs) {
    if (
      (proof.solver === "component-map") !==
      (proof.componentMapSha256 !== null)
    ) {
      fail(
        `component proof ${proof.componentId} has contradictory map ownership`,
      );
    }
    if (
      (proof.solver === "component-map") !==
      (proof.uniquenessMethod === "canonical-component-map")
    ) {
      fail(
        `component proof ${proof.componentId} has contradictory uniqueness ownership`,
      );
    }
    if (
      (proof.solver === "edge-affine") !==
        (proof.uniquenessMethod === "exact-affine") ||
      (proof.solver === "edge-piecewise") !==
        (proof.uniquenessMethod === "exact-piecewise") ||
      (proof.solver === "explicit-reset") !==
        (proof.uniquenessMethod === "explicit-reset")
    ) {
      fail(
        `component proof ${proof.componentId} has contradictory solver uniqueness`,
      );
    }
    if (
      ["identity", "neutral"].includes(proof.uniquenessMethod) &&
      proof.solver !== "identity"
    ) {
      fail(
        `component proof ${proof.componentId} has contradictory policy uniqueness`,
      );
    }
    if (proof.status === "verified") {
      if (
        proof.authorizedCandidateCount !== 1 ||
        proof.selectedCandidateSha256 === null ||
        proof.targetPhysicalOutputSha256 === null ||
        proof.rejectionCodes.length !== 0
      ) {
        fail(`component proof ${proof.componentId} is not completely verified`);
      }
      assertVerifiedErrors(
        proof.errors,
        `component proof ${proof.componentId}`,
      );
    } else if (proof.status === "failed" && proof.rejectionCodes.length === 0) {
      fail(`failed component proof ${proof.componentId} has no rejection code`);
    }
  }
  for (const row of plan.controlRows) {
    if (
      row.proofStatus === "verified" &&
      row.maximumScalarError > RECIPE_STRICT_TOLERANCES.scalar
    ) {
      fail(`control row ${row.ledgerId} exceeds the locked scalar tolerance`);
    }
  }
  const whole = plan.wholeRecipeProof;
  const hasSourceMaterial = whole.sourceMaterialSha256 !== null;
  const hasTargetMaterial = whole.targetMaterialSha256 !== null;
  if (hasSourceMaterial !== hasTargetMaterial) {
    if (
      !["failed", "unavailable"].includes(whole.status) ||
      whole.materialMatches !== null
    ) {
      fail("whole-Recipe material proof is one-sided");
    }
  }
  if (!hasSourceMaterial || !hasTargetMaterial) {
    if (whole.materialMatches !== null) {
      fail("whole-Recipe material result lacks material hashes");
    }
  } else if (
    whole.materialMatches !==
    (whole.sourceMaterialSha256 === whole.targetMaterialSha256)
  ) {
    fail("whole-Recipe material result contradicts its hashes");
  }
  if (plan.wholeRecipeProof.status === "verified") {
    if (
      plan.wholeRecipeProof.targetPhysicalOutputSha256 === null ||
      plan.wholeRecipeProof.sourceAbsoluteOutputSha256 === null ||
      plan.wholeRecipeProof.targetAbsoluteOutputSha256 === null ||
      plan.wholeRecipeProof.materialMatches !== true ||
      plan.wholeRecipeProof.mismatchDomains.length !== 0
    ) {
      fail("verified whole-Recipe proof is incomplete");
    }
    assertVerifiedErrors(plan.wholeRecipeProof.errors, "whole-Recipe proof");
  }
  const failedComponent = plan.componentProofs.some(
    (proof) => proof.status === "failed",
  );
  const hasPreviewRequirement =
    plan.warnings.length > 0 ||
    plan.controlRows.some(
      (row) => row.requiresPreview || row.requiresConfirmation,
    ) ||
    plan.siblingRows.some(
      (row) => row.requiresPreview || row.requiresConfirmation,
    ) ||
    plan.componentProofs.some((proof) => proof.status !== "verified") ||
    plan.wholeRecipeProof.status === "expected-mismatch";
  if (
    plan.wholeRecipeProof.permitsAppearancePreservedClaim &&
    (hasPreviewRequirement ||
      plan.wholeRecipeProof.status !== "verified" ||
      plan.wholeRecipeProof.materialMatches !== true ||
      plan.componentProofs.some((proof) => proof.status !== "verified") ||
      plan.controlRows.some(
        (row) => !["verified", "not-required"].includes(row.proofStatus),
      ) ||
      plan.siblingRows.some(
        (row) =>
          !["kept", "not-present"].includes(row.resolution) ||
          !["verified", "not-required"].includes(row.proofStatus),
      ))
  ) {
    fail("whole-Recipe proof cannot permit an appearance-preserved claim");
  }
  if (
    plan.outcome.kind !== "unsupported" &&
    plan.warnings.length > 0 &&
    plan.outcome.readiness !== "preview-required"
  ) {
    fail("migration warnings require preview");
  }
  if (plan.outcome.kind === "automatic") {
    if (
      failedComponent ||
      plan.controlRows.some((row) => row.resolution === "blocked") ||
      plan.siblingRows.some((row) => row.resolution === "blocked")
    ) {
      fail("automatic outcome contains blocked or failed work");
    }
    const expectedReadiness = hasPreviewRequirement
      ? "preview-required"
      : "ready";
    if (plan.outcome.readiness !== expectedReadiness) {
      fail("automatic readiness contradicts its proof and review rows");
    }
    if (plan.outcome.preservationClaim === "appearance-preserved") {
      if (
        plan.outcome.readiness !== "ready" ||
        plan.warnings.length !== 0 ||
        plan.wholeRecipeProof.status !== "verified" ||
        !plan.wholeRecipeProof.permitsAppearancePreservedClaim ||
        plan.wholeRecipeProof.materialMatches !== true ||
        plan.wholeRecipeProof.sourceAbsoluteOutputSha256 === null ||
        plan.wholeRecipeProof.targetAbsoluteOutputSha256 === null ||
        plan.wholeRecipeProof.sourceMaterialSha256 === null ||
        plan.wholeRecipeProof.targetMaterialSha256 === null ||
        plan.componentProofs.some((proof) => proof.status !== "verified") ||
        plan.controlRows.some(
          (row) =>
            row.requiresPreview ||
            row.requiresConfirmation ||
            !["verified", "not-required"].includes(row.proofStatus),
        ) ||
        plan.siblingRows.some(
          (row) =>
            row.requiresPreview ||
            row.requiresConfirmation ||
            !["kept", "not-present"].includes(row.resolution) ||
            !["verified", "not-required"].includes(row.proofStatus),
        )
      ) {
        fail("appearance-preserved claim lacks complete proof");
      }
    }
    if (plan.wholeRecipeProof.status === "expected-mismatch") {
      if (
        plan.outcome.readiness !== "preview-required" ||
        plan.outcome.preservationClaim === "appearance-preserved"
      ) {
        fail("expected whole-Recipe mismatch lacks explicit preview review");
      }
      if (plan.wholeRecipeProof.mismatchDomains.length === 0) {
        fail("expected whole-Recipe mismatch has no mismatch domain");
      }
      const allowedDomains = new Set<RecipeMigrationMismatchDomain>();
      for (const warning of plan.warnings) {
        if (warning.code === "material-changed") {
          allowedDomains.add("material");
          continue;
        }
        allowedDomains.add("neutral");
        for (const domain of [
          "geometry",
          "rest",
          "pivot",
          "attachment",
          "grounding",
        ] as const) {
          allowedDomains.add(domain);
        }
      }
      const explicitlyReviewedComponentIds = new Set(
        plan.controlRows
          .filter(
            (row) =>
              row.proofStatus === "not-preserved" &&
              row.requiresPreview &&
              row.requiresConfirmation,
          )
          .map((row) => row.componentId),
      );
      for (const proof of plan.componentProofs) {
        if (
          proof.status === "not-preserved" &&
          explicitlyReviewedComponentIds.has(proof.componentId)
        ) {
          for (const domain of proof.mismatchDomains) {
            allowedDomains.add(domain);
          }
        }
      }
      if (
        plan.wholeRecipeProof.mismatchDomains.some(
          (domain) => !allowedDomains.has(domain),
        )
      ) {
        fail(
          "whole-Recipe mismatch is not explained by warnings or confirmed resets",
        );
      }
    } else if (
      ["failed", "unavailable"].includes(plan.wholeRecipeProof.status)
    ) {
      fail("automatic outcome lacks whole-Recipe proof");
    }
  } else if (plan.outcome.kind === "unsupported") {
    if (
      !failedComponent &&
      plan.controlRows.every((row) => row.resolution !== "blocked") &&
      plan.siblingRows.every((row) => row.resolution !== "blocked") &&
      !["failed", "unavailable"].includes(plan.wholeRecipeProof.status)
    ) {
      fail("unsupported outcome has no failed or blocked evidence");
    }
  } else {
    if (
      plan.componentProofs.some(
        (proof) =>
          proof.solver !== "explicit-reset" ||
          proof.uniquenessMethod !== "explicit-reset" ||
          proof.status !== "not-preserved" ||
          proof.authorizedCandidateCount !== 1 ||
          proof.selectedCandidateSha256 === null ||
          proof.targetPhysicalOutputSha256 === null ||
          proof.componentMapSha256 !== null ||
          proof.rejectionCodes.length !== 0,
      )
    ) {
      fail("clean reset has incomplete explicit-reset component proof");
    }
    if (
      plan.controlRows.some(
        (row) =>
          row.reasonCode !== "CLEAN_RESET" ||
          row.proofStatus !== "not-preserved" ||
          !row.requiresPreview ||
          !row.requiresConfirmation ||
          row.resolution === "blocked",
      )
    ) {
      fail("clean reset control rows are not explicitly destructive");
    }
    if (
      plan.siblingRows.some((row) => {
        if (
          row.reasonCode !== "CLEAN_RESET" ||
          !row.requiresPreview ||
          !row.requiresConfirmation
        ) {
          return true;
        }
        return row.targetDefinition
          ? row.resolution !== "reset" || row.proofStatus !== "not-preserved"
          : row.resolution !== "not-present" ||
              row.proofStatus !== "not-required";
      })
    ) {
      fail("clean reset sibling rows are incomplete");
    }
    if (
      ["failed", "unavailable"].includes(plan.wholeRecipeProof.status) ||
      plan.wholeRecipeProof.permitsAppearancePreservedClaim
    ) {
      fail("clean reset lacks a complete non-preservation whole proof");
    }
  }
}

/**
 * Verify the self-hashed plan structure against already verified source,
 * edge, state, graph, and sibling context. This function does not inspect raw
 * package bytes or recompute physical evidence. Production callers holding
 * untrusted plan data must use verifyPlannedAppearanceRecipeMigration or
 * verifyPlannedAppearanceRecipeCleanReset, which deterministically rebuild
 * every raw-source, candidate, component, material, and whole-Recipe proof.
 */
export async function verifyRecipeMigrationPlan(
  value: unknown,
  verifier: RecipeMigrationPlanVerifierContext,
): Promise<RecipeMigrationPlan> {
  const plan = parseRecipeMigrationPlan(value);
  const edge = await verifyRecipeUpdateEdge(verifier.edge);
  const fromSource = parseRecipeSource(
    verifier.fromSource,
    "migration verifier fromSource",
  );
  const toSource = parseRecipeSource(
    verifier.toSource,
    "migration verifier toSource",
  );
  const sourceState = await verifyRecipeStateSnapshot(verifier.sourceState);
  if (
    plan.directEdgeKey !== edge.directEdgeKey ||
    plan.directEdgeKey !== buildRecipeUpdateDirectEdgeKey(edge.from, edge.to) ||
    plan.edgeSha256 !== edge.edgeSha256 ||
    !sameJson(fromSource.identities, edge.from) ||
    !sameJson(toSource.identities, edge.to) ||
    !sameJson(plan.fromSource, fromSource) ||
    !sameJson(plan.toSource, toSource)
  ) {
    fail("plan targets another edge or exact Recipe source");
  }
  if (plan.fromStateSha256 !== sourceState.stateSha256) {
    fail("plan targets another source Recipe state");
  }
  if (
    !sameStrings(
      expectedWarnings(edge),
      expectedWarnings({ ...edge, warnings: plan.warnings }),
    )
  ) {
    fail("plan warnings contradict the edge");
  }
  assertControlCoverage(plan, edge, sourceState);
  assertComponentCoverage(plan, verifier.componentMembership);

  if (
    !sameStrings(
      Object.keys(verifier.sourceControlRanges).sort(),
      edge.stableIdLedger.fromIds,
    )
  ) {
    fail("source verifier ranges do not exhaust the stable-id ledger");
  }
  if (
    !sameStrings(
      Object.keys(verifier.targetControlRanges).sort(),
      edge.stableIdLedger.toIds,
    )
  ) {
    fail("target verifier ranges do not exhaust the stable-id ledger");
  }

  if (plan.componentMapBundleSha256 === null) {
    if (verifier.componentMapBundle)
      fail("unreferenced component map bundle supplied");
    if (
      plan.componentProofs.some((proof) => proof.componentMapSha256 !== null)
    ) {
      fail("component proof references a map without a map bundle");
    }
  } else {
    if (!verifier.componentMapBundle)
      fail("referenced component map bundle is missing");
    const bundle = await verifyRecipeComponentMapBundle(
      verifier.componentMapBundle,
      {
        edge,
        sourceControlRanges: verifier.sourceControlRanges,
        targetControlRanges: verifier.targetControlRanges,
        componentMembership: verifier.componentMembership,
      },
    );
    if (bundle.bundleSha256 !== plan.componentMapBundleSha256) {
      fail("component map bundle hash mismatch");
    }
    const mapsByHash = new Map(bundle.maps.map((map) => [map.mapSha256, map]));
    for (const proof of plan.componentProofs) {
      if (proof.componentMapSha256 === null) continue;
      const map = mapsByHash.get(proof.componentMapSha256);
      if (
        !map ||
        map.componentId !== proof.componentId ||
        proof.uniquenessMethod !== "canonical-component-map" ||
        proof.uniquenessProofSha256 !== map.uniquenessProofSha256
      ) {
        fail(`component proof ${proof.componentId} references another map`);
      }
    }
  }

  if (plan.proposedState) {
    const proposed = await verifyRecipeStateSnapshot(plan.proposedState);
    assertTargetAppearanceState(
      proposed.appearanceDials,
      edge,
      verifier.targetControlRanges,
      plan.outcome.kind === "clean-reset",
    );
    for (const row of plan.controlRows) {
      if (row.targetControl) {
        const proposedValue =
          proposed.appearanceDials.values[row.targetControl.id];
        if (proposedValue !== row.targetControl.value) {
          fail(
            `control row ${row.ledgerId} target value is not in proposed state`,
          );
        }
      }
      if (
        plan.outcome.kind === "clean-reset" &&
        (!row.requiresPreview || !row.requiresConfirmation)
      ) {
        fail(`clean reset control ${row.ledgerId} lacks confirmation`);
      }
    }
  }
  assertSiblingCoverage(plan, edge, sourceState, verifier.siblingBindings);
  assertOutcomeProofConsistency(plan);

  if (plan.outcome.kind === "clean-reset") {
    const unsupportedValue = verifier.eligibleUnsupportedPlan;
    if (!unsupportedValue) fail("clean reset has no eligible unsupported plan");
    const unsupported = await verifyRecipeMigrationPlan(unsupportedValue, {
      ...verifier,
      eligibleUnsupportedPlan: undefined,
    });
    if (
      unsupported.outcome.kind !== "unsupported" ||
      unsupported.outcome.cleanResetEligibility !== "eligible" ||
      plan.outcome.basedOnUnsupportedPlanSha256 !== unsupported.planSha256 ||
      unsupported.directEdgeKey !== plan.directEdgeKey ||
      unsupported.fromStateSha256 !== plan.fromStateSha256 ||
      unsupported.fromRecipeRevision !== plan.fromRecipeRevision ||
      unsupported.toRecipeRevision !== plan.toRecipeRevision
    ) {
      fail("clean reset does not cite the eligible unsupported plan");
    }
  }
  for (const proof of plan.componentProofs) {
    const actual = await recipeMigrationComponentProofSha256(proof);
    if (actual !== proof.proofSha256) {
      fail(`component proof ${proof.componentId} hash mismatch`);
    }
  }
  const actualWholeProofSha256 = await recipeMigrationWholeProofSha256(
    plan.wholeRecipeProof,
  );
  if (actualWholeProofSha256 !== plan.wholeRecipeProof.proofSha256) {
    fail("whole-Recipe proof hash mismatch");
  }
  const actualPlanSha256 = await recipeMigrationPlanSha256(plan);
  if (actualPlanSha256 !== plan.planSha256) fail("plan hash mismatch");
  return plan;
}
