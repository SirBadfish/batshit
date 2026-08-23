import {
  isFiniteNumber,
  isNonEmptyString,
  isRecord,
  isSha256,
  isStableId,
} from "../appearanceDials.validation";
import { RECIPE_MIGRATION_REPORT_CONTRACT } from "./contractIds";
import {
  canonicalRecipeSha256,
  canonicalRecipeString,
} from "./recipeCanonical";
import {
  parseRecipeSourceIdentity,
  verifyRecipeSourceManifest,
  type RecipeSourceIdentity,
} from "./packageMetadata";
import {
  RECIPE_FAILURE_STAGES,
  RECIPE_JOB_STATUSES,
  type RecipeFailureStage,
  type RecipeJobStatus,
} from "./recipeContracts";

export const RECIPE_UPDATES_CONTRACT = "recipe-updates/v1";
export const RECIPE_UPDATE_PROOF_CONTRACT = "recipe-update-proof/v1";
export const RECIPE_UPDATE_JOB_CONTRACT = "recipe-update-job/v1";
export const RECIPE_TOPOLOGY_REBUILD_PROOF_CONTRACT =
  "recipe-topology-rebuild-proof/v1";
export const RECIPE_STRICT_TOLERANCE_PROFILE = "recipe-strict/v1";
export const RECIPE_STRICT_TOLERANCES = {
  scalar: 1e-7,
  positionMeters: 1e-6,
  scale: 1e-6,
  quaternionRadians: 1e-6,
  matrix: 1e-6,
} as const;

const CONTROL_KINDS = ["dial", "side-offset"] as const;
const PLAN_ACTIONS = [
  "keep",
  "presentation-only",
  "affine",
  "piecewise",
  "new",
  "removed",
  "reset-required",
  "blocked",
] as const;
const BEHAVIOR_KINDS = [
  "track",
  "follower-only",
  "macro",
  "bilateral-unlock",
  "shared-clamp",
  "joint",
  "root-scale",
] as const;
const SIBLING_SURFACES = [
  "facialArtwork",
  "eyeAppearance",
  "oralAppearance",
] as const;
const SIBLING_ACTIONS = [
  "keep",
  "migrate",
  "reset-required",
  "blocked",
  "not-present",
] as const;
const WARNING_CODES = [
  "neutral-changed",
  "material-changed",
  "topology-changed",
] as const;
const REPORT_CLASSIFICATIONS = [
  "kept",
  "presentation-updated",
  "remapped",
  "new",
  "removed",
  "reset-required",
  "blocked",
] as const;
const REPORT_PROOF_STATUSES = [
  "verified",
  "not-required",
  "not-preserved",
  "failed",
] as const;
const REPORT_STATUSES = ["preserved", "preview-required", "blocked"] as const;
const JOB_STATES = RECIPE_JOB_STATUSES;
const CANDIDATE_ASSET_ROLES = [
  "source-package",
  "source-model",
  "source-manifest",
  "live-package",
  "live-model",
  "live-manifest",
  "live-build-receipt",
] as const;
const SOURCE_CANDIDATE_ASSET_ROLES = CANDIDATE_ASSET_ROLES.slice(0, 3);
const COMPLETE_CANDIDATE_ASSET_ROLES = [...CANDIDATE_ASSET_ROLES];

export type RecipeStableControlKind = (typeof CONTROL_KINDS)[number];
export type RecipeUpdatePlanAction = (typeof PLAN_ACTIONS)[number];
export type RecipeBehaviorKind = (typeof BEHAVIOR_KINDS)[number];
export type RecipeSiblingSurface = (typeof SIBLING_SURFACES)[number];
export type RecipeSiblingAction = (typeof SIBLING_ACTIONS)[number];
export type RecipeUpdateWarningCode = (typeof WARNING_CODES)[number];
export type RecipeMigrationClassification =
  (typeof REPORT_CLASSIFICATIONS)[number];
export type RecipeMigrationProofStatus = (typeof REPORT_PROOF_STATUSES)[number];
export type RecipeMigrationReportStatus = (typeof REPORT_STATUSES)[number];
export type RecipeUpdateJobState = RecipeJobStatus;
export type RecipeUpdateFailureStage = RecipeFailureStage;
export type RecipeUpdateCandidateAssetRole =
  (typeof CANDIDATE_ASSET_ROLES)[number];

export type { RecipeSourceIdentity } from "./packageMetadata";

export type RecipeStableIdLedgerEntry = {
  id: string;
  fromKind: RecipeStableControlKind | null;
  toKind: RecipeStableControlKind | null;
};

export type RecipeStableIdLedger = {
  fromIds: string[];
  toIds: string[];
  entries: RecipeStableIdLedgerEntry[];
};

export type RecipeControlIdentity = {
  presentationSha256: string;
  mappingSha256: string;
  basisSha256: string;
  behaviorSha256: string;
  componentSha256: string;
};

export type RecipeExactMapping =
  | {
      kind: "affine";
      scale: number;
      offset: number;
      proofSha256: string;
    }
  | {
      kind: "piecewise";
      points: [number, number][];
      proofSha256: string;
    };

export type RecipeControlUpdatePlan = {
  id: string;
  controlKind: RecipeStableControlKind;
  action: RecipeUpdatePlanAction;
  componentId: string;
  behaviorKinds: RecipeBehaviorKind[];
  from: RecipeControlIdentity | null;
  to: RecipeControlIdentity | null;
  mapping: RecipeExactMapping | null;
  reason: string;
  proofSha256: string;
};

export type RecipeAliasProof = {
  fromId: string;
  toId: string;
  reason: string;
  physicalEquivalenceProofSha256: string;
  componentMapSha256: string;
};

export type RecipeSiblingSubplan = {
  surface: RecipeSiblingSurface;
  fromContract: string | null;
  toContract: string | null;
  action: RecipeSiblingAction;
  reason: string;
  proofSha256: string;
};

export type RecipeUpdateWarning = {
  code: RecipeUpdateWarningCode;
  message: string;
  requiresPreview: true;
  proofSha256: string;
};

export type RecipeUpdateProof = {
  contract: typeof RECIPE_UPDATE_PROOF_CONTRACT;
  toleranceProfile: typeof RECIPE_STRICT_TOLERANCE_PROFILE;
  scalarTolerance: number;
  positionToleranceMeters: number;
  scaleTolerance: number;
  quaternionToleranceRadians: number;
  maximumMeasuredError: number;
  fixtureSha256: string;
  componentProofSha256: string;
  wholeRecipeProofSha256: string;
};

export type RecipeTopologyRebuildProof = {
  contract: typeof RECIPE_TOPOLOGY_REBUILD_PROOF_CONTRACT;
  mode: "rebuild-from-target-recipe-source";
  fromTopologySha256: string;
  toTopologySha256: string;
  affectedMeshNodeIds: string[];
  affectedComponentIds: string[];
  authorityBundleSha256: string;
  sourceAuditSha256: string;
  targetAuditSha256: string;
  requiresPreview: true;
  proofSha256: string;
};

export type RecipeUpdateEdge = {
  id: string;
  directEdgeKey: string;
  from: RecipeSourceIdentity;
  to: RecipeSourceIdentity;
  stableIdLedger: RecipeStableIdLedger;
  controls: RecipeControlUpdatePlan[];
  aliases: RecipeAliasProof[];
  siblingSubplans: RecipeSiblingSubplan[];
  warnings: RecipeUpdateWarning[];
  topologyRebuild?: RecipeTopologyRebuildProof;
  proof: RecipeUpdateProof;
  edgeSha256: string;
};

export type RecipeUpdatesContract = {
  contract: typeof RECIPE_UPDATES_CONTRACT;
  schemaVersion: 1;
  edges: RecipeUpdateEdge[];
};

export type RecipeMigrationReportEntry = {
  id: string;
  classification: RecipeMigrationClassification;
  componentId: string;
  oldValue: number | null;
  proposedValue: number | null;
  reason: string;
  proofStatus: RecipeMigrationProofStatus;
  maximumError: number;
  tolerance: number;
  proofSha256: string;
  requiresPreview: boolean;
  requiresConfirmation: boolean;
};

export type RecipeMigrationReportProof = {
  toleranceProfile: typeof RECIPE_STRICT_TOLERANCE_PROFILE;
  wholeRecipeMaximumError: number;
  wholeRecipeRmsError: number;
  wholeRecipeTolerance: number;
  wholeRecipeProofSha256: string;
  reportSha256: string;
};

export type RecipeMigrationReport = {
  contract: typeof RECIPE_MIGRATION_REPORT_CONTRACT;
  reportId: string;
  directEdgeKey: string;
  edgeSha256: string;
  fromRecipeRevision: number;
  toRecipeRevision: number;
  status: RecipeMigrationReportStatus;
  entries: RecipeMigrationReportEntry[];
  warnings: RecipeUpdateWarning[];
  proof: RecipeMigrationReportProof;
};

export type RecipeMigrationReportExpectation = {
  classifications: Readonly<Record<string, RecipeMigrationClassification>>;
  status: RecipeMigrationReportStatus;
};

export type RecipeUpdateJobFailure = {
  stage: RecipeUpdateFailureStage;
  code: string;
  message: string;
  retryable: boolean;
};

export type RecipeUpdateCandidateAsset = {
  role: RecipeUpdateCandidateAssetRole;
  ref: string;
  sha256: string;
  bytes: number;
};

export type RecipeUpdateJob = {
  contract: typeof RECIPE_UPDATE_JOB_CONTRACT;
  jobId: string;
  goonId: string;
  directEdgeKey: string;
  edgeSha256: string;
  expectedRecipeRevision: number;
  concurrencyTokenSha256: string;
  attempt: number;
  state: RecipeUpdateJobState;
  reportSha256: string | null;
  candidateAssets: RecipeUpdateCandidateAsset[];
  committedRevisionId: string | null;
  commitReceiptSha256: string | null;
  failure: RecipeUpdateJobFailure | null;
};

function requireRecord(
  value: unknown,
  context: string,
): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(context + " must be an object");
  return value;
}

function requireExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  context: string,
) {
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key))
      throw new Error(context + " has unknown field " + key);
  }
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      throw new Error(context + " is missing " + key);
    }
  }
}

function requireEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  context: string,
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error(context + " is invalid");
  }
  return value as T;
}

function requireStableId(value: unknown, context: string): string {
  if (!isStableId(value)) throw new Error(context + " is not a stable id");
  return value;
}

function requireString(value: unknown, context: string): string {
  if (
    !isNonEmptyString(value) ||
    value !== value.trim() ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error(
      context +
        " must be a non-empty trimmed string without control characters",
    );
  }
  return value;
}

function requireErrorCode(value: unknown, context: string): string {
  const parsed = requireString(value, context);
  if (!/^[A-Z][A-Z0-9_]*$/.test(parsed)) {
    throw new Error(context + " must be an uppercase error code");
  }
  return parsed;
}

function requireSha(value: unknown, context: string): string {
  if (!isSha256(value) || value !== value.toLowerCase()) {
    throw new Error(context + " must be a lowercase SHA-256 hash");
  }
  return value;
}

function requireNullableSha(value: unknown, context: string): string | null {
  return value === null ? null : requireSha(value, context);
}

function requireNullableString(value: unknown, context: string): string | null {
  return value === null ? null : requireString(value, context);
}

function requireFinite(value: unknown, context: string): number {
  if (!isFiniteNumber(value)) throw new Error(context + " must be finite");
  return value;
}

function requireNonNegativeFinite(value: unknown, context: string): number {
  const parsed = requireFinite(value, context);
  if (parsed < 0) throw new Error(context + " must be non-negative");
  return parsed;
}

function requirePositiveFinite(value: unknown, context: string): number {
  const parsed = requireFinite(value, context);
  if (parsed <= 0) throw new Error(context + " must be positive");
  return parsed;
}

function requireInteger(
  value: unknown,
  minimum: number,
  context: string,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new Error(context + " must be a safe integer >= " + minimum);
  }
  return value as number;
}

function requireBoolean(value: unknown, context: string): boolean {
  if (typeof value !== "boolean") throw new Error(context + " must be boolean");
  return value;
}

function requireArray(value: unknown, context: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(context + " must be an array");
  return value;
}

function assertUnique(values: readonly string[], context: string) {
  if (new Set(values).size !== values.length) {
    throw new Error(context + " contains duplicate ids");
  }
}

function assertSorted(values: readonly string[], context: string) {
  const sorted = [...values].sort();
  if (values.some((value, index) => value !== sorted[index])) {
    throw new Error(context + " must be sorted");
  }
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length && left.every((entry) => right.includes(entry))
  );
}

const SOURCE_IDENTITY_KEY_ORDER: (keyof RecipeSourceIdentity)[] = [
  "contract",
  "schemaVersion",
  "baseId",
  "fitFamily",
  "modelSha256",
  "manifestSemanticSha256",
  "definitionSha256",
  "neutralId",
  "neutralRecipeSha256",
  "physicalBasisSha256",
  "behaviorSha256",
  "componentGraphSha256",
  "topologySha256",
  "skeletonHierarchySha256",
];

export function buildRecipeUpdateDirectEdgeKey(
  from: RecipeSourceIdentity,
  to: RecipeSourceIdentity,
): string {
  const encode = (identity: RecipeSourceIdentity) =>
    SOURCE_IDENTITY_KEY_ORDER.map(
      (key) => `${key}=${encodeURIComponent(String(identity[key]))}`,
    ).join("&");
  return `recipe-direct-edge/v1|from:${encode(from)}|to:${encode(to)}`;
}

function parseStableIdList(value: unknown, context: string): string[] {
  const ids = requireArray(value, context).map((entry, index) =>
    requireStableId(entry, `${context}[${index}]`),
  );
  assertUnique(ids, context);
  assertSorted(ids, context);
  return ids;
}

function parseStableIdLedger(value: unknown): RecipeStableIdLedger {
  const raw = requireRecord(value, "recipe update stable-id ledger");
  requireExactKeys(
    raw,
    ["fromIds", "toIds", "entries"],
    "recipe update stable-id ledger",
  );
  const fromIds = parseStableIdList(raw.fromIds, "stable-id ledger fromIds");
  const toIds = parseStableIdList(raw.toIds, "stable-id ledger toIds");
  const entries = requireArray(raw.entries, "stable-id ledger entries").map(
    (entry, index): RecipeStableIdLedgerEntry => {
      const item = requireRecord(entry, `stable-id ledger entry ${index}`);
      requireExactKeys(
        item,
        ["id", "fromKind", "toKind"],
        `stable-id ledger entry ${index}`,
      );
      const id = requireStableId(item.id, `stable-id ledger entry ${index}.id`);
      const fromKind =
        item.fromKind === null
          ? null
          : requireEnum(
              item.fromKind,
              CONTROL_KINDS,
              `stable-id ledger entry ${id}.fromKind`,
            );
      const toKind =
        item.toKind === null
          ? null
          : requireEnum(
              item.toKind,
              CONTROL_KINDS,
              `stable-id ledger entry ${id}.toKind`,
            );
      if (!fromKind && !toKind) {
        throw new Error(`stable-id ledger entry ${id} is absent on both sides`);
      }
      if ((fromKind !== null) !== fromIds.includes(id)) {
        throw new Error(`stable-id ledger entry ${id} disagrees with fromIds`);
      }
      if ((toKind !== null) !== toIds.includes(id)) {
        throw new Error(`stable-id ledger entry ${id} disagrees with toIds`);
      }
      if (fromKind && toKind && fromKind !== toKind) {
        throw new Error(`stable id ${id} was reused for another control kind`);
      }
      return { id, fromKind, toKind };
    },
  );
  const entryIds = entries.map((entry) => entry.id);
  assertUnique(entryIds, "stable-id ledger entries");
  assertSorted(entryIds, "stable-id ledger entries");
  const union = [...new Set([...fromIds, ...toIds])].sort();
  if (!sameSet(entryIds, union)) {
    throw new Error("stable-id ledger is not exhaustive");
  }
  return { fromIds, toIds, entries };
}

function parseControlIdentity(
  value: unknown,
  context: string,
): RecipeControlIdentity {
  const raw = requireRecord(value, context);
  requireExactKeys(
    raw,
    [
      "presentationSha256",
      "mappingSha256",
      "basisSha256",
      "behaviorSha256",
      "componentSha256",
    ],
    context,
  );
  return {
    presentationSha256: requireSha(
      raw.presentationSha256,
      context + ".presentationSha256",
    ),
    mappingSha256: requireSha(raw.mappingSha256, context + ".mappingSha256"),
    basisSha256: requireSha(raw.basisSha256, context + ".basisSha256"),
    behaviorSha256: requireSha(raw.behaviorSha256, context + ".behaviorSha256"),
    componentSha256: requireSha(
      raw.componentSha256,
      context + ".componentSha256",
    ),
  };
}

function controlIdentitiesEqual(
  left: RecipeControlIdentity,
  right: RecipeControlIdentity,
): boolean {
  return Object.keys(left).every(
    (key) =>
      left[key as keyof RecipeControlIdentity] ===
      right[key as keyof RecipeControlIdentity],
  );
}

function behaviorIdentitiesEqual(
  left: RecipeControlIdentity,
  right: RecipeControlIdentity,
): boolean {
  return (
    left.mappingSha256 === right.mappingSha256 &&
    left.basisSha256 === right.basisSha256 &&
    left.behaviorSha256 === right.behaviorSha256 &&
    left.componentSha256 === right.componentSha256
  );
}

function parseMapping(
  value: unknown,
  context: string,
): RecipeExactMapping | null {
  if (value === null) return null;
  const raw = requireRecord(value, context);
  if (raw.kind === "affine") {
    requireExactKeys(raw, ["kind", "scale", "offset", "proofSha256"], context);
    const scale = requireFinite(raw.scale, context + ".scale");
    if (Math.abs(scale) <= Number.EPSILON) {
      throw new Error(context + ".scale must be effective");
    }
    return {
      kind: "affine",
      scale,
      offset: requireFinite(raw.offset, context + ".offset"),
      proofSha256: requireSha(raw.proofSha256, context + ".proofSha256"),
    };
  }
  if (raw.kind === "piecewise") {
    requireExactKeys(raw, ["kind", "points", "proofSha256"], context);
    const points = requireArray(raw.points, context + ".points").map(
      (point, index): [number, number] => {
        if (!Array.isArray(point) || point.length !== 2) {
          throw new Error(`${context}.points[${index}] is malformed`);
        }
        return [
          requireFinite(point[0], `${context}.points[${index}][0]`),
          requireFinite(point[1], `${context}.points[${index}][1]`),
        ];
      },
    );
    if (points.length < 2) throw new Error(context + ".points is incomplete");
    for (let index = 1; index < points.length; index += 1) {
      if (points[index][0] <= points[index - 1][0]) {
        throw new Error(context + ".points inputs must increase strictly");
      }
    }
    return {
      kind: "piecewise",
      points,
      proofSha256: requireSha(raw.proofSha256, context + ".proofSha256"),
    };
  }
  throw new Error(context + ".kind is invalid");
}

function parseControlPlan(
  value: unknown,
  index: number,
): RecipeControlUpdatePlan {
  const context = `recipe update control ${index}`;
  const raw = requireRecord(value, context);
  requireExactKeys(
    raw,
    [
      "id",
      "controlKind",
      "action",
      "componentId",
      "behaviorKinds",
      "from",
      "to",
      "mapping",
      "reason",
      "proofSha256",
    ],
    context,
  );
  const id = requireStableId(raw.id, context + ".id");
  const action = requireEnum(
    raw.action,
    PLAN_ACTIONS,
    `recipe update control ${id}.action`,
  );
  const behaviorKinds = requireArray(
    raw.behaviorKinds,
    `recipe update control ${id}.behaviorKinds`,
  ).map((entry) =>
    requireEnum(
      entry,
      BEHAVIOR_KINDS,
      `recipe update control ${id}.behaviorKind`,
    ),
  );
  if (behaviorKinds.length === 0) {
    throw new Error(`recipe update control ${id} has no behavior kinds`);
  }
  assertUnique(behaviorKinds, `recipe update control ${id}.behaviorKinds`);
  const from =
    raw.from === null
      ? null
      : parseControlIdentity(raw.from, `recipe update control ${id}.from`);
  const to =
    raw.to === null
      ? null
      : parseControlIdentity(raw.to, `recipe update control ${id}.to`);
  const mapping = parseMapping(
    raw.mapping,
    `recipe update control ${id}.mapping`,
  );

  if (action === "new") {
    if (from || !to || mapping)
      throw new Error(`new control ${id} has invalid identities`);
  } else if (action === "removed") {
    if (!from || to || mapping)
      throw new Error(`removed control ${id} has invalid identities`);
  } else {
    if (!from || !to)
      throw new Error(`control ${id} is missing edge identities`);
    if ((action === "affine" || action === "piecewise") !== Boolean(mapping)) {
      throw new Error(`control ${id} has an invalid exact map`);
    }
    if (mapping && mapping.kind !== action) {
      throw new Error(`control ${id} map does not match its action`);
    }
    if (action === "keep" && !controlIdentitiesEqual(from, to)) {
      throw new Error(`kept control ${id} changed identity`);
    }
    if (
      action === "presentation-only" &&
      (from.presentationSha256 === to.presentationSha256 ||
        !behaviorIdentitiesEqual(from, to))
    ) {
      throw new Error(`presentation-only control ${id} changed behavior`);
    }
  }

  return {
    id,
    controlKind: requireEnum(
      raw.controlKind,
      CONTROL_KINDS,
      `recipe update control ${id}.controlKind`,
    ),
    action,
    componentId: requireStableId(
      raw.componentId,
      `recipe update control ${id}.componentId`,
    ),
    behaviorKinds,
    from,
    to,
    mapping,
    reason: requireString(raw.reason, `recipe update control ${id}.reason`),
    proofSha256: requireSha(
      raw.proofSha256,
      `recipe update control ${id}.proofSha256`,
    ),
  };
}

function parseAlias(value: unknown, index: number): RecipeAliasProof {
  const context = `recipe update alias ${index}`;
  const raw = requireRecord(value, context);
  requireExactKeys(
    raw,
    [
      "fromId",
      "toId",
      "reason",
      "physicalEquivalenceProofSha256",
      "componentMapSha256",
    ],
    context,
  );
  const fromId = requireStableId(raw.fromId, context + ".fromId");
  const toId = requireStableId(raw.toId, context + ".toId");
  if (fromId === toId)
    throw new Error(context + " may not alias an id to itself");
  return {
    fromId,
    toId,
    reason: requireString(raw.reason, context + ".reason"),
    physicalEquivalenceProofSha256: requireSha(
      raw.physicalEquivalenceProofSha256,
      context + ".physicalEquivalenceProofSha256",
    ),
    componentMapSha256: requireSha(
      raw.componentMapSha256,
      context + ".componentMapSha256",
    ),
  };
}

function parseSiblingSubplans(value: unknown): RecipeSiblingSubplan[] {
  const subplans = requireArray(value, "recipe update sibling subplans").map(
    (entry, index): RecipeSiblingSubplan => {
      const context = `recipe update sibling subplan ${index}`;
      const raw = requireRecord(entry, context);
      requireExactKeys(
        raw,
        [
          "surface",
          "fromContract",
          "toContract",
          "action",
          "reason",
          "proofSha256",
        ],
        context,
      );
      const surface = requireEnum(
        raw.surface,
        SIBLING_SURFACES,
        context + ".surface",
      );
      const fromContract = requireNullableString(
        raw.fromContract,
        context + ".fromContract",
      );
      const toContract = requireNullableString(
        raw.toContract,
        context + ".toContract",
      );
      const action = requireEnum(
        raw.action,
        SIBLING_ACTIONS,
        context + ".action",
      );
      if (action === "not-present") {
        if (fromContract !== null || toContract !== null) {
          throw new Error(`sibling subplan ${surface} contradicts not-present`);
        }
      } else if (action === "keep") {
        if (!fromContract || fromContract !== toContract) {
          throw new Error(
            `sibling subplan ${surface} cannot keep different contracts`,
          );
        }
      } else if (!fromContract && !toContract) {
        throw new Error(`sibling subplan ${surface} has no sibling state`);
      }
      return {
        surface,
        fromContract,
        toContract,
        action,
        reason: requireString(raw.reason, context + ".reason"),
        proofSha256: requireSha(raw.proofSha256, context + ".proofSha256"),
      };
    },
  );
  const surfaces = subplans.map((subplan) => subplan.surface);
  assertUnique(surfaces, "recipe update sibling subplans");
  if (!sameSet(surfaces, SIBLING_SURFACES)) {
    throw new Error("recipe update sibling subplans are incomplete");
  }
  return subplans;
}

function parseWarning(value: unknown, index: number): RecipeUpdateWarning {
  const context = `recipe update warning ${index}`;
  const raw = requireRecord(value, context);
  requireExactKeys(
    raw,
    ["code", "message", "requiresPreview", "proofSha256"],
    context,
  );
  if (raw.requiresPreview !== true) {
    throw new Error(context + " must require preview");
  }
  return {
    code: requireEnum(raw.code, WARNING_CODES, context + ".code"),
    message: requireString(raw.message, context + ".message"),
    requiresPreview: true,
    proofSha256: requireSha(raw.proofSha256, context + ".proofSha256"),
  };
}

function parseTopologyRebuildProof(
  value: unknown,
  from: RecipeSourceIdentity,
  to: RecipeSourceIdentity,
  context: string,
): RecipeTopologyRebuildProof {
  const raw = requireRecord(value, context);
  requireExactKeys(
    raw,
    [
      "contract",
      "mode",
      "fromTopologySha256",
      "toTopologySha256",
      "affectedMeshNodeIds",
      "affectedComponentIds",
      "authorityBundleSha256",
      "sourceAuditSha256",
      "targetAuditSha256",
      "requiresPreview",
      "proofSha256",
    ],
    context,
  );
  if (raw.contract !== RECIPE_TOPOLOGY_REBUILD_PROOF_CONTRACT) {
    throw new Error(`${context} contract is invalid`);
  }
  if (raw.mode !== "rebuild-from-target-recipe-source") {
    throw new Error(`${context} mode is invalid`);
  }
  if (raw.requiresPreview !== true) {
    throw new Error(`${context} must require preview`);
  }
  const affectedMeshNodeIds = parseStableIdList(
    raw.affectedMeshNodeIds,
    `${context}.affectedMeshNodeIds`,
  );
  const affectedComponentIds = parseStableIdList(
    raw.affectedComponentIds,
    `${context}.affectedComponentIds`,
  );
  if (affectedMeshNodeIds.length === 0 || affectedComponentIds.length === 0) {
    throw new Error(`${context} must name affected meshes and components`);
  }
  const parsed: RecipeTopologyRebuildProof = {
    contract: RECIPE_TOPOLOGY_REBUILD_PROOF_CONTRACT,
    mode: "rebuild-from-target-recipe-source",
    fromTopologySha256: requireSha(
      raw.fromTopologySha256,
      `${context}.fromTopologySha256`,
    ),
    toTopologySha256: requireSha(
      raw.toTopologySha256,
      `${context}.toTopologySha256`,
    ),
    affectedMeshNodeIds,
    affectedComponentIds,
    authorityBundleSha256: requireSha(
      raw.authorityBundleSha256,
      `${context}.authorityBundleSha256`,
    ),
    sourceAuditSha256: requireSha(
      raw.sourceAuditSha256,
      `${context}.sourceAuditSha256`,
    ),
    targetAuditSha256: requireSha(
      raw.targetAuditSha256,
      `${context}.targetAuditSha256`,
    ),
    requiresPreview: true,
    proofSha256: requireSha(raw.proofSha256, `${context}.proofSha256`),
  };
  if (
    parsed.fromTopologySha256 !== from.topologySha256 ||
    parsed.toTopologySha256 !== to.topologySha256 ||
    parsed.fromTopologySha256 === parsed.toTopologySha256
  ) {
    throw new Error(`${context} does not bind the exact topology transition`);
  }
  return parsed;
}

function parseUpdateProof(value: unknown): RecipeUpdateProof {
  const context = "recipe update proof";
  const raw = requireRecord(value, context);
  requireExactKeys(
    raw,
    [
      "contract",
      "toleranceProfile",
      "scalarTolerance",
      "positionToleranceMeters",
      "scaleTolerance",
      "quaternionToleranceRadians",
      "maximumMeasuredError",
      "fixtureSha256",
      "componentProofSha256",
      "wholeRecipeProofSha256",
    ],
    context,
  );
  if (raw.contract !== RECIPE_UPDATE_PROOF_CONTRACT) {
    throw new Error("recipe update proof contract is invalid");
  }
  if (raw.toleranceProfile !== RECIPE_STRICT_TOLERANCE_PROFILE) {
    throw new Error("recipe update tolerance profile is invalid");
  }
  const parsed: RecipeUpdateProof = {
    contract: RECIPE_UPDATE_PROOF_CONTRACT,
    toleranceProfile: RECIPE_STRICT_TOLERANCE_PROFILE,
    scalarTolerance: requirePositiveFinite(
      raw.scalarTolerance,
      context + ".scalarTolerance",
    ),
    positionToleranceMeters: requirePositiveFinite(
      raw.positionToleranceMeters,
      context + ".positionToleranceMeters",
    ),
    scaleTolerance: requirePositiveFinite(
      raw.scaleTolerance,
      context + ".scaleTolerance",
    ),
    quaternionToleranceRadians: requirePositiveFinite(
      raw.quaternionToleranceRadians,
      context + ".quaternionToleranceRadians",
    ),
    maximumMeasuredError: requireNonNegativeFinite(
      raw.maximumMeasuredError,
      context + ".maximumMeasuredError",
    ),
    fixtureSha256: requireSha(raw.fixtureSha256, context + ".fixtureSha256"),
    componentProofSha256: requireSha(
      raw.componentProofSha256,
      context + ".componentProofSha256",
    ),
    wholeRecipeProofSha256: requireSha(
      raw.wholeRecipeProofSha256,
      context + ".wholeRecipeProofSha256",
    ),
  };
  if (
    parsed.scalarTolerance !== RECIPE_STRICT_TOLERANCES.scalar ||
    parsed.positionToleranceMeters !==
      RECIPE_STRICT_TOLERANCES.positionMeters ||
    parsed.scaleTolerance !== RECIPE_STRICT_TOLERANCES.scale ||
    parsed.quaternionToleranceRadians !==
      RECIPE_STRICT_TOLERANCES.quaternionRadians
  ) {
    throw new Error("recipe update proof changed the locked tolerance profile");
  }
  return parsed;
}

function parseUpdateEdge(value: unknown, index: number): RecipeUpdateEdge {
  const context = `recipe update edge ${index}`;
  const raw = requireRecord(value, context);
  const hasTopologyRebuild = Object.prototype.hasOwnProperty.call(
    raw,
    "topologyRebuild",
  );
  requireExactKeys(
    raw,
    [
      "id",
      "directEdgeKey",
      "from",
      "to",
      "stableIdLedger",
      "controls",
      "aliases",
      "siblingSubplans",
      "warnings",
      ...(hasTopologyRebuild ? ["topologyRebuild"] : []),
      "proof",
      "edgeSha256",
    ],
    context,
  );
  const from = parseRecipeSourceIdentity(raw.from, context + ".from");
  const to = parseRecipeSourceIdentity(raw.to, context + ".to");
  if (from.baseId !== to.baseId) {
    throw new Error(context + " crosses base ids");
  }
  if (from.fitFamily !== to.fitFamily) {
    throw new Error(context + " crosses fit families");
  }
  const topologyChanged = from.topologySha256 !== to.topologySha256;
  if (topologyChanged !== hasTopologyRebuild) {
    throw new Error(
      topologyChanged
        ? context + " crosses topology identities without a rebuild proof"
        : context + " declares a rebuild proof without a topology change",
    );
  }
  const topologyRebuild = hasTopologyRebuild
    ? parseTopologyRebuildProof(
        raw.topologyRebuild,
        from,
        to,
        `${context}.topologyRebuild`,
      )
    : undefined;
  if (from.skeletonHierarchySha256 !== to.skeletonHierarchySha256) {
    throw new Error(context + " crosses skeleton identities");
  }
  if (SOURCE_IDENTITY_KEY_ORDER.every((key) => from[key] === to[key])) {
    throw new Error(context + " does not change the source identity");
  }
  const directEdgeKey = requireString(
    raw.directEdgeKey,
    context + ".directEdgeKey",
  );
  if (directEdgeKey !== buildRecipeUpdateDirectEdgeKey(from, to)) {
    throw new Error(context + " direct-edge identity is malformed or tampered");
  }
  const stableIdLedger = parseStableIdLedger(raw.stableIdLedger);
  const controls = requireArray(raw.controls, context + ".controls").map(
    parseControlPlan,
  );
  const controlIds = controls.map((control) => control.id);
  assertUnique(controlIds, context + ".controls");
  assertSorted(controlIds, context + ".controls");
  const ledgerIds = stableIdLedger.entries.map((entry) => entry.id);
  if (!sameSet(controlIds, ledgerIds)) {
    throw new Error(context + " controls do not exhaust the stable-id ledger");
  }
  if (
    topologyRebuild?.affectedComponentIds.some(
      (componentId) =>
        !controls.some((control) => control.componentId === componentId),
    )
  ) {
    throw new Error(
      context + " topology rebuild references an unknown component",
    );
  }
  const ledgerById = new Map(
    stableIdLedger.entries.map((entry) => [entry.id, entry]),
  );
  for (const control of controls) {
    const ledger = ledgerById.get(control.id);
    if (!ledger)
      throw new Error(
        `control ${control.id} is absent from the stable-id ledger`,
      );
    const expectedKind = ledger.toKind ?? ledger.fromKind;
    if (expectedKind !== control.controlKind) {
      throw new Error(
        `control ${control.id} disagrees with its stable-id kind`,
      );
    }
    if ((control.action === "new") !== (ledger.fromKind === null)) {
      throw new Error(
        `control ${control.id} has an invalid new-control action`,
      );
    }
    if ((control.action === "removed") !== (ledger.toKind === null)) {
      throw new Error(
        `control ${control.id} has an invalid removed-control action`,
      );
    }
  }

  const aliases = requireArray(raw.aliases, context + ".aliases").map(
    parseAlias,
  );
  assertUnique(
    aliases.map((alias) => alias.fromId),
    context + ".alias fromIds",
  );
  assertUnique(
    aliases.map((alias) => alias.toId),
    context + ".alias toIds",
  );
  for (const alias of aliases) {
    if (
      !stableIdLedger.fromIds.includes(alias.fromId) ||
      stableIdLedger.toIds.includes(alias.fromId) ||
      !stableIdLedger.toIds.includes(alias.toId) ||
      stableIdLedger.fromIds.includes(alias.toId)
    ) {
      throw new Error(
        `alias ${alias.fromId} -> ${alias.toId} is not a direct correction edge`,
      );
    }
  }

  const warnings = requireArray(raw.warnings, context + ".warnings").map(
    parseWarning,
  );
  assertUnique(
    warnings.map((warning) => warning.code),
    context + ".warnings",
  );
  const hasTopologyWarning = warnings.some(
    (warning) => warning.code === "topology-changed",
  );
  if (hasTopologyWarning !== topologyChanged) {
    throw new Error(
      topologyChanged
        ? context + " topology rebuild must carry a topology-changed warning"
        : context + " topology-changed warning has no topology rebuild",
    );
  }
  return {
    id: requireStableId(raw.id, context + ".id"),
    directEdgeKey,
    from,
    to,
    stableIdLedger,
    controls,
    aliases,
    siblingSubplans: parseSiblingSubplans(raw.siblingSubplans),
    warnings,
    ...(topologyRebuild ? { topologyRebuild } : {}),
    proof: parseUpdateProof(raw.proof),
    edgeSha256: requireSha(raw.edgeSha256, context + ".edgeSha256"),
  };
}

export function parseRecipeUpdatesContract(
  value: unknown,
): RecipeUpdatesContract {
  canonicalRecipeString(value);
  const raw = requireRecord(value, "recipe updates contract");
  requireExactKeys(
    raw,
    ["contract", "schemaVersion", "edges"],
    "recipe updates contract",
  );
  if (raw.contract !== RECIPE_UPDATES_CONTRACT || raw.schemaVersion !== 1) {
    throw new Error("recipe updates contract identity is invalid");
  }
  const edges = requireArray(raw.edges, "recipe updates edges").map(
    parseUpdateEdge,
  );
  assertUnique(
    edges.map((edge) => edge.id),
    "recipe update edge ids",
  );
  assertUnique(
    edges.map((edge) => edge.directEdgeKey),
    "recipe update direct-edge keys",
  );
  assertUnique(
    edges.map((edge) => edge.edgeSha256),
    "recipe update edge hashes",
  );
  return { contract: RECIPE_UPDATES_CONTRACT, schemaVersion: 1, edges };
}

function parseReportEntry(
  value: unknown,
  index: number,
): RecipeMigrationReportEntry {
  const context = `recipe migration report entry ${index}`;
  const raw = requireRecord(value, context);
  requireExactKeys(
    raw,
    [
      "id",
      "classification",
      "componentId",
      "oldValue",
      "proposedValue",
      "reason",
      "proofStatus",
      "maximumError",
      "tolerance",
      "proofSha256",
      "requiresPreview",
      "requiresConfirmation",
    ],
    context,
  );
  const id = requireStableId(raw.id, context + ".id");
  const classification = requireEnum(
    raw.classification,
    REPORT_CLASSIFICATIONS,
    context + ".classification",
  );
  const oldValue =
    raw.oldValue === null
      ? null
      : requireFinite(raw.oldValue, context + ".oldValue");
  const proposedValue =
    raw.proposedValue === null
      ? null
      : requireFinite(raw.proposedValue, context + ".proposedValue");
  const proofStatus = requireEnum(
    raw.proofStatus,
    REPORT_PROOF_STATUSES,
    context + ".proofStatus",
  );
  const maximumError = requireNonNegativeFinite(
    raw.maximumError,
    context + ".maximumError",
  );
  const tolerance = requirePositiveFinite(
    raw.tolerance,
    context + ".tolerance",
  );
  if (tolerance !== RECIPE_STRICT_TOLERANCES.scalar) {
    throw new Error(
      `migration report entry ${id} changed the locked scalar tolerance`,
    );
  }
  const requiresPreview = requireBoolean(
    raw.requiresPreview,
    context + ".requiresPreview",
  );
  const requiresConfirmation = requireBoolean(
    raw.requiresConfirmation,
    context + ".requiresConfirmation",
  );

  if (["kept", "presentation-updated", "remapped"].includes(classification)) {
    if (
      oldValue === null ||
      proposedValue === null ||
      proofStatus !== "verified" ||
      maximumError > tolerance ||
      requiresPreview ||
      requiresConfirmation
    ) {
      throw new Error(
        `migration report entry ${id} has invalid preservation proof`,
      );
    }
  } else if (classification === "new") {
    if (
      oldValue !== null ||
      proposedValue !== 0 ||
      proofStatus !== "not-required" ||
      requiresPreview !== requiresConfirmation
    ) {
      throw new Error(
        `migration report entry ${id} has invalid new-control state`,
      );
    }
  } else if (classification === "removed") {
    if (
      oldValue === null ||
      proposedValue !== null ||
      proofStatus !== "not-required" ||
      requiresPreview !== requiresConfirmation ||
      (oldValue !== 0 && !requiresPreview)
    ) {
      throw new Error(`migration report entry ${id} has invalid removal state`);
    }
  } else if (classification === "reset-required") {
    if (
      oldValue === null ||
      proposedValue !== 0 ||
      proofStatus !== "not-preserved" ||
      !requiresPreview ||
      !requiresConfirmation
    ) {
      throw new Error(`migration report entry ${id} has invalid reset state`);
    }
  } else if (
    oldValue === null ||
    proposedValue !== null ||
    proofStatus !== "failed" ||
    !requiresPreview ||
    requiresConfirmation
  ) {
    throw new Error(`migration report entry ${id} has invalid blocked state`);
  }

  return {
    id,
    classification,
    componentId: requireStableId(raw.componentId, context + ".componentId"),
    oldValue,
    proposedValue,
    reason: requireString(raw.reason, context + ".reason"),
    proofStatus,
    maximumError,
    tolerance,
    proofSha256: requireSha(raw.proofSha256, context + ".proofSha256"),
    requiresPreview,
    requiresConfirmation,
  };
}

function parseReportProof(value: unknown): RecipeMigrationReportProof {
  const context = "recipe migration report proof";
  const raw = requireRecord(value, context);
  requireExactKeys(
    raw,
    [
      "toleranceProfile",
      "wholeRecipeMaximumError",
      "wholeRecipeRmsError",
      "wholeRecipeTolerance",
      "wholeRecipeProofSha256",
      "reportSha256",
    ],
    context,
  );
  if (raw.toleranceProfile !== RECIPE_STRICT_TOLERANCE_PROFILE) {
    throw new Error("recipe migration report tolerance profile is invalid");
  }
  const wholeRecipeMaximumError = requireNonNegativeFinite(
    raw.wholeRecipeMaximumError,
    context + ".wholeRecipeMaximumError",
  );
  const wholeRecipeRmsError = requireNonNegativeFinite(
    raw.wholeRecipeRmsError,
    context + ".wholeRecipeRmsError",
  );
  const wholeRecipeTolerance = requirePositiveFinite(
    raw.wholeRecipeTolerance,
    context + ".wholeRecipeTolerance",
  );
  if (wholeRecipeTolerance !== RECIPE_STRICT_TOLERANCES.positionMeters) {
    throw new Error(
      "recipe migration report changed the locked whole-Recipe tolerance",
    );
  }
  if (wholeRecipeRmsError > wholeRecipeMaximumError) {
    throw new Error("recipe migration report RMS exceeds its maximum error");
  }
  return {
    toleranceProfile: RECIPE_STRICT_TOLERANCE_PROFILE,
    wholeRecipeMaximumError,
    wholeRecipeRmsError,
    wholeRecipeTolerance,
    wholeRecipeProofSha256: requireSha(
      raw.wholeRecipeProofSha256,
      context + ".wholeRecipeProofSha256",
    ),
    reportSha256: requireSha(raw.reportSha256, context + ".reportSha256"),
  };
}

const EXPECTED_CLASSIFICATION: Record<
  RecipeUpdatePlanAction,
  RecipeMigrationClassification
> = {
  keep: "kept",
  "presentation-only": "presentation-updated",
  affine: "remapped",
  piecewise: "remapped",
  new: "new",
  removed: "removed",
  "reset-required": "reset-required",
  blocked: "blocked",
};

export function parseRecipeMigrationReport(
  value: unknown,
  expectedEdge: RecipeUpdateEdge,
  expectation?: RecipeMigrationReportExpectation,
): RecipeMigrationReport {
  canonicalRecipeString(value);
  canonicalRecipeString(expectedEdge);
  const validatedEdge = parseUpdateEdge(expectedEdge, 0);
  const context = "recipe migration report";
  const raw = requireRecord(value, context);
  requireExactKeys(
    raw,
    [
      "contract",
      "reportId",
      "directEdgeKey",
      "edgeSha256",
      "fromRecipeRevision",
      "toRecipeRevision",
      "status",
      "entries",
      "warnings",
      "proof",
    ],
    context,
  );
  if (raw.contract !== RECIPE_MIGRATION_REPORT_CONTRACT) {
    throw new Error("recipe migration report contract is invalid");
  }
  const fromRecipeRevision = requireInteger(
    raw.fromRecipeRevision,
    1,
    context + ".fromRecipeRevision",
  );
  const toRecipeRevision = requireInteger(
    raw.toRecipeRevision,
    2,
    context + ".toRecipeRevision",
  );
  if (toRecipeRevision <= fromRecipeRevision) {
    throw new Error("recipe migration report revisions are not monotonic");
  }
  const directEdgeKey = requireString(
    raw.directEdgeKey,
    context + ".directEdgeKey",
  );
  const edgeSha256 = requireSha(raw.edgeSha256, context + ".edgeSha256");
  const entries = requireArray(raw.entries, context + ".entries").map(
    parseReportEntry,
  );
  const entryIds = entries.map((entry) => entry.id);
  assertUnique(entryIds, context + ".entries");
  assertSorted(entryIds, context + ".entries");
  const warnings = requireArray(raw.warnings, context + ".warnings").map(
    parseWarning,
  );
  assertUnique(
    warnings.map((warning) => warning.code),
    context + ".warnings",
  );

  if (
    directEdgeKey !== validatedEdge.directEdgeKey ||
    edgeSha256 !== validatedEdge.edgeSha256
  ) {
    throw new Error("recipe migration report targets another direct edge");
  }
  const controlsById = new Map(
    validatedEdge.controls.map((control) => [control.id, control]),
  );
  if (!sameSet(entryIds, [...controlsById.keys()])) {
    throw new Error("recipe migration report is not exhaustive");
  }
  const expectedClassifications = expectation?.classifications ??
    Object.fromEntries(
      validatedEdge.controls.map((control) => [
        control.id,
        EXPECTED_CLASSIFICATION[control.action],
      ]),
    );
  if (!sameSet(Object.keys(expectedClassifications), [...controlsById.keys()])) {
    throw new Error("recipe migration report expectations are not exhaustive");
  }
  for (const entry of entries) {
    const control = controlsById.get(entry.id);
    if (
      !control ||
      entry.classification !== expectedClassifications[entry.id] ||
      entry.componentId !== control.componentId
    ) {
      throw new Error(
        `recipe migration report entry ${entry.id} contradicts its edge`,
      );
    }
  }
  const expectedWarnings = validatedEdge.warnings.map(
    (warning) => `${warning.code}:${warning.proofSha256}`,
  );
  const actualWarnings = warnings.map(
    (warning) => `${warning.code}:${warning.proofSha256}`,
  );
  if (!sameSet(actualWarnings, expectedWarnings)) {
    throw new Error("recipe migration report warnings contradict its edge");
  }

  const status = requireEnum(raw.status, REPORT_STATUSES, context + ".status");
  const expectedStatus: RecipeMigrationReportStatus = expectation?.status ??
    (entries.some((entry) => entry.classification === "blocked")
      ? "blocked"
      : entries.some(
            (entry) => entry.requiresPreview || entry.requiresConfirmation,
          ) || warnings.length > 0
        ? "preview-required"
        : "preserved");
  if (status !== expectedStatus) {
    throw new Error("recipe migration report status contradicts its entries");
  }

  const proof = parseReportProof(raw.proof);
  if (
    status !== "blocked" &&
    proof.wholeRecipeMaximumError > proof.wholeRecipeTolerance
  ) {
    throw new Error("recipe migration report exceeds whole-Recipe tolerance");
  }
  return {
    contract: RECIPE_MIGRATION_REPORT_CONTRACT,
    reportId: requireStableId(raw.reportId, context + ".reportId"),
    directEdgeKey,
    edgeSha256,
    fromRecipeRevision,
    toRecipeRevision,
    status,
    entries,
    warnings,
    proof,
  };
}

function parseJobFailure(value: unknown): RecipeUpdateJobFailure | null {
  if (value === null) return null;
  const context = "recipe update job failure";
  const raw = requireRecord(value, context);
  requireExactKeys(raw, ["stage", "code", "message", "retryable"], context);
  return {
    stage: requireEnum(raw.stage, RECIPE_FAILURE_STAGES, context + ".stage"),
    code: requireErrorCode(raw.code, context + ".code"),
    message: requireString(raw.message, context + ".message"),
    retryable: requireBoolean(raw.retryable, context + ".retryable"),
  };
}

function parseCandidateAssets(value: unknown): RecipeUpdateCandidateAsset[] {
  const assets = requireArray(value, "recipe update candidate assets").map(
    (entry, index): RecipeUpdateCandidateAsset => {
      const context = `recipe update candidate asset ${index}`;
      const raw = requireRecord(entry, context);
      requireExactKeys(raw, ["role", "ref", "sha256", "bytes"], context);
      return {
        role: requireEnum(raw.role, CANDIDATE_ASSET_ROLES, context + ".role"),
        ref: requireString(raw.ref, context + ".ref"),
        sha256: requireSha(raw.sha256, context + ".sha256"),
        bytes: requireInteger(raw.bytes, 1, context + ".bytes"),
      };
    },
  );
  const roles = assets.map((asset) => asset.role);
  assertUnique(roles, "recipe update candidate asset roles");
  const orderedRoles = [...roles].sort(
    (left, right) =>
      CANDIDATE_ASSET_ROLES.indexOf(left) -
      CANDIDATE_ASSET_ROLES.indexOf(right),
  );
  if (roles.some((role, index) => role !== orderedRoles[index])) {
    throw new Error(
      "recipe update candidate assets must use canonical role order",
    );
  }
  assertUnique(
    assets.map((asset) => asset.ref),
    "recipe update candidate asset refs",
  );
  const roleSet = new Set(roles);
  if (
    roleSet.has("live-package") &&
    (!roleSet.has("live-model") || !roleSet.has("live-manifest"))
  ) {
    throw new Error(
      "recipe update live package requires its staged model and manifest",
    );
  }
  if (
    roleSet.has("live-build-receipt") &&
    !["live-package", "live-model", "live-manifest"].every((role) =>
      roleSet.has(role as RecipeUpdateCandidateAssetRole),
    )
  ) {
    throw new Error(
      "recipe update Live-build receipt requires the complete Live asset bundle",
    );
  }
  return assets;
}

function hasExactCandidateAssetRoles(
  assets: readonly RecipeUpdateCandidateAsset[],
  expected: readonly RecipeUpdateCandidateAssetRole[],
): boolean {
  return sameSet(
    assets.map((asset) => asset.role),
    expected,
  );
}

export function parseRecipeUpdateJob(
  value: unknown,
  expectedEdge: RecipeUpdateEdge,
): RecipeUpdateJob {
  canonicalRecipeString(value);
  canonicalRecipeString(expectedEdge);
  const validatedEdge = parseUpdateEdge(expectedEdge, 0);
  const context = "recipe update job";
  const raw = requireRecord(value, context);
  requireExactKeys(
    raw,
    [
      "contract",
      "jobId",
      "goonId",
      "directEdgeKey",
      "edgeSha256",
      "expectedRecipeRevision",
      "concurrencyTokenSha256",
      "attempt",
      "state",
      "reportSha256",
      "candidateAssets",
      "committedRevisionId",
      "commitReceiptSha256",
      "failure",
    ],
    context,
  );
  if (raw.contract !== RECIPE_UPDATE_JOB_CONTRACT) {
    throw new Error("recipe update job contract is invalid");
  }
  const directEdgeKey = requireString(
    raw.directEdgeKey,
    context + ".directEdgeKey",
  );
  const edgeSha256 = requireSha(raw.edgeSha256, context + ".edgeSha256");
  if (
    directEdgeKey !== validatedEdge.directEdgeKey ||
    edgeSha256 !== validatedEdge.edgeSha256
  ) {
    throw new Error("recipe update job targets another direct edge");
  }
  const state = requireEnum(raw.state, JOB_STATES, context + ".state");
  const reportSha256 = requireNullableSha(
    raw.reportSha256,
    context + ".reportSha256",
  );
  const candidateAssets = parseCandidateAssets(raw.candidateAssets);
  const committedRevisionId =
    raw.committedRevisionId === null
      ? null
      : requireStableId(
          raw.committedRevisionId,
          context + ".committedRevisionId",
        );
  const commitReceiptSha256 = requireNullableSha(
    raw.commitReceiptSha256,
    context + ".commitReceiptSha256",
  );
  const failure = parseJobFailure(raw.failure);

  if (["validating", "planning"].includes(state)) {
    if (
      reportSha256 ||
      !hasExactCandidateAssetRoles(
        candidateAssets,
        SOURCE_CANDIDATE_ASSET_ROLES,
      ) ||
      committedRevisionId ||
      commitReceiptSha256 ||
      failure
    ) {
      throw new Error(`recipe update job state ${state} has premature outputs`);
    }
  } else if (state === "baking") {
    if (
      !reportSha256 ||
      !hasExactCandidateAssetRoles(
        candidateAssets,
        SOURCE_CANDIDATE_ASSET_ROLES,
      ) ||
      committedRevisionId ||
      commitReceiptSha256 ||
      failure
    ) {
      throw new Error(`recipe update job state ${state} has invalid outputs`);
    }
  } else if (state === "packaging") {
    if (
      !reportSha256 ||
      !SOURCE_CANDIDATE_ASSET_ROLES.every((role) =>
        candidateAssets.some((asset) => asset.role === role),
      ) ||
      committedRevisionId ||
      commitReceiptSha256 ||
      failure
    ) {
      throw new Error(`recipe update job state ${state} has invalid outputs`);
    }
  } else if (["verifying", "ready", "committing"].includes(state)) {
    if (
      !reportSha256 ||
      !hasExactCandidateAssetRoles(
        candidateAssets,
        COMPLETE_CANDIDATE_ASSET_ROLES,
      ) ||
      committedRevisionId ||
      commitReceiptSha256 ||
      failure
    ) {
      throw new Error(`recipe update job state ${state} has invalid outputs`);
    }
  } else if (state === "committed") {
    if (
      !reportSha256 ||
      !hasExactCandidateAssetRoles(
        candidateAssets,
        COMPLETE_CANDIDATE_ASSET_ROLES,
      ) ||
      !committedRevisionId ||
      !commitReceiptSha256 ||
      failure
    ) {
      throw new Error("committed recipe update job is incomplete");
    }
  } else if (state === "failed" || state === "interrupted") {
    if (!failure || committedRevisionId || commitReceiptSha256) {
      throw new Error(
        `recipe update job state ${state} is missing valid failure state`,
      );
    }
  } else if (
    candidateAssets.length > 0 ||
    failure ||
    committedRevisionId ||
    commitReceiptSha256
  ) {
    throw new Error("discarded recipe update job has active result state");
  }

  return {
    contract: RECIPE_UPDATE_JOB_CONTRACT,
    jobId: requireStableId(raw.jobId, context + ".jobId"),
    goonId: requireStableId(raw.goonId, context + ".goonId"),
    directEdgeKey,
    edgeSha256,
    expectedRecipeRevision: requireInteger(
      raw.expectedRecipeRevision,
      1,
      context + ".expectedRecipeRevision",
    ),
    concurrencyTokenSha256: requireSha(
      raw.concurrencyTokenSha256,
      context + ".concurrencyTokenSha256",
    ),
    attempt: requireInteger(raw.attempt, 0, context + ".attempt"),
    state,
    reportSha256,
    candidateAssets,
    committedRevisionId,
    commitReceiptSha256,
    failure,
  };
}

function recipeUpdateEdgeHashContent(
  edge: RecipeUpdateEdge,
): Omit<RecipeUpdateEdge, "edgeSha256"> {
  const { edgeSha256: _edgeSha256, ...content } = edge;
  return content;
}

export async function recipeTopologyRebuildProofSha256(
  value:
    | RecipeTopologyRebuildProof
    | Omit<RecipeTopologyRebuildProof, "proofSha256">,
): Promise<string> {
  canonicalRecipeString(value);
  const { proofSha256: _proofSha256, ...content } = value as
    RecipeTopologyRebuildProof;
  return canonicalRecipeSha256(content);
}

export async function recipeUpdateEdgeSha256(value: unknown): Promise<string> {
  canonicalRecipeString(value);
  const edge = parseUpdateEdge(value, 0);
  return canonicalRecipeSha256(recipeUpdateEdgeHashContent(edge));
}

export async function verifyRecipeUpdateEdge(
  value: unknown,
): Promise<RecipeUpdateEdge> {
  const edge = parseUpdateEdge(value, 0);
  if (edge.topologyRebuild) {
    const topologyProofSha256 = await recipeTopologyRebuildProofSha256(
      edge.topologyRebuild,
    );
    if (topologyProofSha256 !== edge.topologyRebuild.proofSha256) {
      throw new Error(
        `recipe topology rebuild proof hash mismatch: expected ${edge.topologyRebuild.proofSha256}, got ${topologyProofSha256}`,
      );
    }
  }
  const actual = await recipeUpdateEdgeSha256(edge);
  if (actual !== edge.edgeSha256) {
    throw new Error(
      `recipe update edge hash mismatch: expected ${edge.edgeSha256}, got ${actual}`,
    );
  }
  return edge;
}

export async function verifyRecipeUpdatesContract(
  value: unknown,
): Promise<RecipeUpdatesContract> {
  const contract = parseRecipeUpdatesContract(value);
  await Promise.all(contract.edges.map((edge) => verifyRecipeUpdateEdge(edge)));
  return contract;
}

export async function verifyRecipeUpdatesForSource(
  value: unknown,
  sourceIdentity: unknown,
): Promise<RecipeUpdatesContract> {
  const source = parseRecipeSourceIdentity(
    sourceIdentity,
    "package recipeSource",
  );
  const contract = await verifyRecipeUpdatesContract(value);
  const sourceCanonical = canonicalRecipeString(source);
  for (const edge of contract.edges) {
    if (canonicalRecipeString(edge.to) !== sourceCanonical) {
      throw new Error(
        `recipe update edge ${edge.id} target does not match package recipeSource`,
      );
    }
  }
  return contract;
}

export async function verifyRecipePackageMetadata(
  manifestValue: unknown,
  exactModelSha256: unknown,
): Promise<{
  source: RecipeSourceIdentity;
  updates: RecipeUpdatesContract;
}> {
  const manifest = requireRecord(manifestValue, "avatar.json");
  const source = await verifyRecipeSourceManifest(manifest, exactModelSha256);
  if (!Object.prototype.hasOwnProperty.call(manifest, "recipeUpdates")) {
    throw new Error("authoring avatar.json is missing recipeUpdates");
  }
  const updates = await verifyRecipeUpdatesForSource(
    manifest.recipeUpdates,
    source,
  );
  return { source, updates };
}

function recipeMigrationReportHashContent(report: RecipeMigrationReport): Omit<
  RecipeMigrationReport,
  "proof"
> & {
  proof: Omit<RecipeMigrationReportProof, "reportSha256">;
} {
  const { reportSha256: _reportSha256, ...proof } = report.proof;
  return { ...report, proof };
}

export async function recipeMigrationReportSha256(
  value: unknown,
  expectedEdge: RecipeUpdateEdge,
  expectation?: RecipeMigrationReportExpectation,
): Promise<string> {
  const report = parseRecipeMigrationReport(value, expectedEdge, expectation);
  return canonicalRecipeSha256(recipeMigrationReportHashContent(report));
}

export async function verifyRecipeMigrationReport(
  value: unknown,
  expectedEdge: RecipeUpdateEdge,
  expectation?: RecipeMigrationReportExpectation,
): Promise<RecipeMigrationReport> {
  const verifiedEdge = await verifyRecipeUpdateEdge(expectedEdge);
  const report = parseRecipeMigrationReport(value, verifiedEdge, expectation);
  const actual = await recipeMigrationReportSha256(
    report,
    verifiedEdge,
    expectation,
  );
  if (actual !== report.proof.reportSha256) {
    throw new Error(
      `recipe migration report hash mismatch: expected ${report.proof.reportSha256}, got ${actual}`,
    );
  }
  return report;
}

export async function verifyRecipeUpdateJob(
  value: unknown,
  expectedEdge: RecipeUpdateEdge,
): Promise<RecipeUpdateJob> {
  const verifiedEdge = await verifyRecipeUpdateEdge(expectedEdge);
  return parseRecipeUpdateJob(value, verifiedEdge);
}
