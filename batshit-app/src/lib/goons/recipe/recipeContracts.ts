import {
  APPEARANCE_DIAL_VALUES_CONTRACT,
  type AppearanceDialValueState,
} from "../appearanceDials.contracts";
import { RECIPE_MIGRATION_REPORT_CONTRACT } from "./contractIds";
import { GOON_LIVE_BUILD_CONTRACT } from "./liveBuildContracts";
import {
  parseRecipeSourceIdentity,
  type RecipeSourceIdentity,
} from "./packageMetadata";
import {
  canonicalRecipeSha256,
  canonicalRecipeString,
} from "./recipeCanonical";

export const GOON_RECIPE_CONTRACT = "goon-recipe/v1" as const;
export const GOON_RECIPE_AUTHORING_REVISION_CONTRACT =
  "goon-recipe-authoring-revision/v1" as const;
export const GOON_RECIPE_REVISION_CONTRACT = "goon-recipe-revision/v1" as const;
export const GOON_RECIPE_STATE_CONTRACT = "goon-recipe-state/v1" as const;

export const RECIPE_LIVE_STATUSES = [
  "up_to_date",
  "needs_bake",
  "building",
  "failed",
  "interrupted",
] as const;

export const RECIPE_JOB_STATUSES = [
  "validating",
  "planning",
  "baking",
  "packaging",
  "verifying",
  "ready",
  "committing",
  "committed",
  "failed",
  "interrupted",
  "discarded",
] as const;

export const RECIPE_FAILURE_STAGES = [
  "upload",
  "validating",
  "planning",
  "baking",
  "packaging",
  "verifying",
  "preview-load",
  "committing",
  "cleanup",
  "restart",
] as const;

const ACTIVE_RECIPE_JOB_STATUSES = new Set<RecipeJobStatus>([
  "validating",
  "planning",
  "baking",
  "packaging",
  "verifying",
  "ready",
  "committing",
]);
const FAILURE_STAGES = new Set<RecipeFailureStage>(RECIPE_FAILURE_STAGES);
const LIVE_STATUS_SET = new Set<string>(RECIPE_LIVE_STATUSES);
const JOB_STATUS_SET = new Set<string>(RECIPE_JOB_STATUSES);
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const STABLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const VERSIONED_CONTRACT_PATTERN =
  /^[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)*\/v[1-9][0-9]*$/;
const FORBIDDEN_RECORD_KEYS = new Set([
  "__proto__",
  "prototype",
  "constructor",
]);

export type RecipeLiveStatus = (typeof RECIPE_LIVE_STATUSES)[number];
export type RecipeJobStatus = (typeof RECIPE_JOB_STATUSES)[number];
export type RecipeFailureStage = (typeof RECIPE_FAILURE_STAGES)[number];

export type RecipeJsonPrimitive = string | number | boolean | null;
export type RecipeJsonValue =
  RecipeJsonPrimitive | RecipeJsonValue[] | { [key: string]: RecipeJsonValue };

export type RecipeAssetRef = {
  ref: string;
  sha256: string;
};

export type RecipeSource = {
  package: RecipeAssetRef;
  model: RecipeAssetRef;
  manifest: RecipeAssetRef;
  identities: RecipeSourceIdentity;
};

export type RecipeSiblingStateRecord = {
  id: string;
  contract: string;
  definitionSha256: string;
  stateSha256: string;
  state: { [key: string]: RecipeJsonValue };
};

export type RecipeStateSnapshot = {
  contract: typeof GOON_RECIPE_STATE_CONTRACT;
  stateSha256: string;
  appearanceDials: AppearanceDialValueState;
  siblings: RecipeSiblingStateRecord[];
};

export type RecipeDocumentRef = {
  contract: string;
  ref: string;
  sha256: string;
};

export type RecipeRevisionBundle = {
  contract: typeof GOON_RECIPE_REVISION_CONTRACT;
  recipeRevision: number;
  revisionId: string;
  revisionSha256: string;
  source: RecipeSource;
  state: RecipeStateSnapshot;
  liveBuildReceipt: RecipeDocumentRef;
  updateReport: RecipeDocumentRef | null;
};

export type RecipeAuthoringRevision = {
  contract: typeof GOON_RECIPE_AUTHORING_REVISION_CONTRACT;
  recipeRevision: number;
  revisionId: string;
  revisionSha256: string;
  source: RecipeSource;
  state: RecipeStateSnapshot;
  updateReport: RecipeDocumentRef | null;
};

export type RecipePendingJob = {
  jobId: string;
  status: RecipeJobStatus;
  recipeRevision: number;
  revisionId: string;
  reportRefs: RecipeDocumentRef[];
};

export type RecipeFailure = {
  jobId: string;
  stage: RecipeFailureStage;
  reason: string;
  reportRef: RecipeDocumentRef | null;
};

export type GoonRecipeV1 = {
  contract: typeof GOON_RECIPE_CONTRACT;
  recipeRevision: number;
  revisionId: string;
  concurrencyToken: string;
  liveStatus: RecipeLiveStatus;
  authoringRevision: RecipeAuthoringRevision;
  activeRevision: RecipeRevisionBundle | null;
  previousRevision: RecipeRevisionBundle | null;
  activeLiveBuildReceipt: RecipeDocumentRef | null;
  pendingJob: RecipePendingJob | null;
  latestUpdateReport: RecipeDocumentRef | null;
  lastFailure: RecipeFailure | null;
};

function fail(message: string): never {
  throw new Error(`[${GOON_RECIPE_CONTRACT}] ${message}`);
}

function record(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`${context} must be an object`);
  }
  return value as Record<string, unknown>;
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  context: string,
): void {
  const allowedSet = new Set(allowed);
  const unsupported = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unsupported.length > 0) {
    fail(`${context} contains unsupported fields: ${unsupported.join(", ")}`);
  }
}

function stringValue(value: unknown, context: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    fail(
      `${context} must be a non-empty trimmed string without control characters`,
    );
  }
  return value;
}

function stableId(value: unknown, context: string): string {
  const parsed = stringValue(value, context);
  if (!STABLE_ID_PATTERN.test(parsed) || FORBIDDEN_RECORD_KEYS.has(parsed)) {
    fail(`${context} must be a stable id`);
  }
  return parsed;
}

function sha256(value: unknown, context: string): string {
  const parsed = stringValue(value, context);
  if (!SHA256_PATTERN.test(parsed)) {
    fail(`${context} must be a lowercase SHA-256`);
  }
  return parsed;
}

function positiveInteger(value: unknown, context: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    fail(`${context} must be a positive safe integer`);
  }
  return value;
}

function versionedContract(value: unknown, context: string): string {
  const parsed = stringValue(value, context);
  if (!VERSIONED_CONTRACT_PATTERN.test(parsed)) {
    fail(`${context} must be a versioned contract id`);
  }
  return parsed;
}

function parseJsonValue(value: unknown, context: string): RecipeJsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      fail(`${context} must not contain non-finite numbers`);
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) =>
      parseJsonValue(entry, `${context}[${index}]`),
    );
  }
  const source = record(value, context);
  const result: { [key: string]: RecipeJsonValue } = Object.create(null);
  for (const [key, entry] of Object.entries(source)) {
    if (FORBIDDEN_RECORD_KEYS.has(key))
      fail(`${context} contains forbidden field ${key}`);
    result[key] = parseJsonValue(entry, `${context}.${key}`);
  }
  return result;
}

function parseAssetRef(value: unknown, context: string): RecipeAssetRef {
  const source = record(value, context);
  rejectUnknownKeys(source, ["ref", "sha256"], context);
  return {
    ref: stringValue(source.ref, `${context}.ref`),
    sha256: sha256(source.sha256, `${context}.sha256`),
  };
}

export function parseRecipeSource(
  value: unknown,
  context = "Recipe source",
): RecipeSource {
  const source = record(value, context);
  rejectUnknownKeys(
    source,
    ["package", "model", "manifest", "identities"],
    context,
  );
  const result: RecipeSource = {
    package: parseAssetRef(source.package, `${context}.package`),
    model: parseAssetRef(source.model, `${context}.model`),
    manifest: parseAssetRef(source.manifest, `${context}.manifest`),
    identities: parseRecipeSourceIdentity(
      source.identities,
      `${context}.identities`,
    ),
  };
  if (result.identities.modelSha256 !== result.model.sha256) {
    fail(`${context}.identities.modelSha256 must match model.sha256`);
  }
  if (
    new Set([result.package.ref, result.model.ref, result.manifest.ref])
      .size !== 3
  ) {
    fail(`${context} package, model, and manifest refs must be distinct`);
  }
  return result;
}

function parseAppearanceDialState(
  value: unknown,
  context: string,
): AppearanceDialValueState {
  const source = record(value, context);
  rejectUnknownKeys(
    source,
    [
      "contract",
      "definitionSha256",
      "neutralId",
      "neutralRecipeSha256",
      "values",
      "unlockedDialIds",
    ],
    context,
  );
  if (source.contract !== APPEARANCE_DIAL_VALUES_CONTRACT) {
    fail(`${context}.contract must equal ${APPEARANCE_DIAL_VALUES_CONTRACT}`);
  }
  const valueSource = record(source.values, `${context}.values`);
  if (Object.keys(valueSource).length === 0)
    fail(`${context}.values must not be empty`);
  const values: Record<string, number> = Object.create(null);
  for (const [id, rawValue] of Object.entries(valueSource)) {
    stableId(id, `${context}.values key`);
    if (typeof rawValue !== "number" || !Number.isFinite(rawValue)) {
      fail(`${context}.values.${id} must be finite`);
    }
    values[id] = rawValue;
  }
  if (!Array.isArray(source.unlockedDialIds)) {
    fail(`${context}.unlockedDialIds must be an array`);
  }
  const unlockedDialIds = source.unlockedDialIds.map((id, index) =>
    stableId(id, `${context}.unlockedDialIds[${index}]`),
  );
  if (new Set(unlockedDialIds).size !== unlockedDialIds.length) {
    fail(`${context}.unlockedDialIds must not contain duplicates`);
  }
  if (
    unlockedDialIds.some(
      (id, index) => index > 0 && unlockedDialIds[index - 1] >= id,
    )
  ) {
    fail(`${context}.unlockedDialIds must be sorted`);
  }
  for (const id of unlockedDialIds) {
    if (!Object.hasOwn(values, id)) {
      fail(`${context}.unlockedDialIds contains unknown dial ${id}`);
    }
  }
  return {
    contract: APPEARANCE_DIAL_VALUES_CONTRACT,
    definitionSha256: sha256(
      source.definitionSha256,
      `${context}.definitionSha256`,
    ),
    neutralId: stableId(source.neutralId, `${context}.neutralId`),
    neutralRecipeSha256: sha256(
      source.neutralRecipeSha256,
      `${context}.neutralRecipeSha256`,
    ),
    values,
    unlockedDialIds,
  };
}

function parseSiblingState(
  value: unknown,
  context: string,
): RecipeSiblingStateRecord {
  const source = record(value, context);
  rejectUnknownKeys(
    source,
    ["id", "contract", "definitionSha256", "stateSha256", "state"],
    context,
  );
  const contract = versionedContract(source.contract, `${context}.contract`);
  if (contract === APPEARANCE_DIAL_VALUES_CONTRACT) {
    fail(`${context}.contract cannot duplicate the owned Appearance state`);
  }
  const state = parseJsonValue(source.state, `${context}.state`);
  if (state === null || Array.isArray(state) || typeof state !== "object") {
    fail(`${context}.state must be an object`);
  }
  const declaredStateContract = state.schemaVersion ?? state.contract;
  if (declaredStateContract !== contract) {
    fail(`${context}.state must declare the same versioned contract`);
  }
  return {
    id: stableId(source.id, `${context}.id`),
    contract,
    definitionSha256: sha256(
      source.definitionSha256,
      `${context}.definitionSha256`,
    ),
    stateSha256: sha256(source.stateSha256, `${context}.stateSha256`),
    state,
  };
}

function parseRecipeState(
  value: unknown,
  context: string,
): RecipeStateSnapshot {
  const source = record(value, context);
  rejectUnknownKeys(
    source,
    ["contract", "stateSha256", "appearanceDials", "siblings"],
    context,
  );
  if (source.contract !== GOON_RECIPE_STATE_CONTRACT) {
    fail(`${context}.contract must equal ${GOON_RECIPE_STATE_CONTRACT}`);
  }
  if (!Array.isArray(source.siblings))
    fail(`${context}.siblings must be an array`);
  const siblings = source.siblings.map((entry, index) =>
    parseSiblingState(entry, `${context}.siblings[${index}]`),
  );
  const siblingIds = siblings.map((entry) => entry.id);
  if (new Set(siblingIds).size !== siblingIds.length) {
    fail(`${context}.siblings must not contain duplicate ids`);
  }
  if (
    siblingIds.some((id, index) => index > 0 && siblingIds[index - 1] >= id)
  ) {
    fail(`${context}.siblings must be sorted by id`);
  }
  return {
    contract: GOON_RECIPE_STATE_CONTRACT,
    stateSha256: sha256(source.stateSha256, `${context}.stateSha256`),
    appearanceDials: parseAppearanceDialState(
      source.appearanceDials,
      `${context}.appearanceDials`,
    ),
    siblings,
  };
}

function parseDocumentRef(
  value: unknown,
  context: string,
  requiredContract?: string,
): RecipeDocumentRef {
  const source = record(value, context);
  rejectUnknownKeys(source, ["contract", "ref", "sha256"], context);
  const contract = versionedContract(source.contract, `${context}.contract`);
  if (requiredContract && contract !== requiredContract) {
    fail(`${context}.contract must equal ${requiredContract}`);
  }
  return {
    contract,
    ref: stringValue(source.ref, `${context}.ref`),
    sha256: sha256(source.sha256, `${context}.sha256`),
  };
}

function parseNullableDocumentRef(
  value: unknown,
  context: string,
  requiredContract?: string,
): RecipeDocumentRef | null {
  return value === null
    ? null
    : parseDocumentRef(value, context, requiredContract);
}

function documentRefsEqual(
  left: RecipeDocumentRef,
  right: RecipeDocumentRef,
): boolean {
  return (
    left.contract === right.contract &&
    left.ref === right.ref &&
    left.sha256 === right.sha256
  );
}

function parseBoundSourceAndState(
  rawSource: unknown,
  rawState: unknown,
  context: string,
): { source: RecipeSource; state: RecipeStateSnapshot } {
  const source = parseRecipeSource(rawSource, `${context}.source`);
  const state = parseRecipeState(rawState, `${context}.state`);
  if (
    state.appearanceDials.definitionSha256 !==
    source.identities.definitionSha256
  ) {
    fail(
      `${context} Appearance definition identity does not match Recipe Source`,
    );
  }
  if (state.appearanceDials.neutralId !== source.identities.neutralId) {
    fail(`${context} Appearance neutral id does not match Recipe Source`);
  }
  if (
    state.appearanceDials.neutralRecipeSha256 !==
    source.identities.neutralRecipeSha256
  ) {
    fail(
      `${context} Appearance neutral Recipe identity does not match Recipe Source`,
    );
  }
  return { source, state };
}

export function parseRecipeAuthoringRevision(
  value: unknown,
  context = "authoring revision",
): RecipeAuthoringRevision {
  canonicalRecipeString(value);
  const raw = record(value, context);
  rejectUnknownKeys(
    raw,
    [
      "contract",
      "recipeRevision",
      "revisionId",
      "revisionSha256",
      "source",
      "state",
      "updateReport",
    ],
    context,
  );
  if (raw.contract !== GOON_RECIPE_AUTHORING_REVISION_CONTRACT) {
    fail(
      `${context}.contract must equal ${GOON_RECIPE_AUTHORING_REVISION_CONTRACT}`,
    );
  }
  const bound = parseBoundSourceAndState(raw.source, raw.state, context);
  return {
    contract: GOON_RECIPE_AUTHORING_REVISION_CONTRACT,
    recipeRevision: positiveInteger(
      raw.recipeRevision,
      `${context}.recipeRevision`,
    ),
    revisionId: stableId(raw.revisionId, `${context}.revisionId`),
    revisionSha256: sha256(raw.revisionSha256, `${context}.revisionSha256`),
    ...bound,
    updateReport: parseNullableDocumentRef(
      raw.updateReport,
      `${context}.updateReport`,
      RECIPE_MIGRATION_REPORT_CONTRACT,
    ),
  };
}

export function parseRecipeRevisionBundle(
  value: unknown,
  context = "revision",
): RecipeRevisionBundle {
  canonicalRecipeString(value);
  const source = record(value, context);
  rejectUnknownKeys(
    source,
    [
      "contract",
      "recipeRevision",
      "revisionId",
      "revisionSha256",
      "source",
      "state",
      "liveBuildReceipt",
      "updateReport",
    ],
    context,
  );
  if (source.contract !== GOON_RECIPE_REVISION_CONTRACT) {
    fail(`${context}.contract must equal ${GOON_RECIPE_REVISION_CONTRACT}`);
  }
  const bound = parseBoundSourceAndState(source.source, source.state, context);
  return {
    contract: GOON_RECIPE_REVISION_CONTRACT,
    recipeRevision: positiveInteger(
      source.recipeRevision,
      `${context}.recipeRevision`,
    ),
    revisionId: stableId(source.revisionId, `${context}.revisionId`),
    revisionSha256: sha256(source.revisionSha256, `${context}.revisionSha256`),
    ...bound,
    liveBuildReceipt: parseDocumentRef(
      source.liveBuildReceipt,
      `${context}.liveBuildReceipt`,
      GOON_LIVE_BUILD_CONTRACT,
    ),
    updateReport: parseNullableDocumentRef(
      source.updateReport,
      `${context}.updateReport`,
      RECIPE_MIGRATION_REPORT_CONTRACT,
    ),
  };
}

function parsePendingJob(value: unknown, context: string): RecipePendingJob {
  const source = record(value, context);
  rejectUnknownKeys(
    source,
    ["jobId", "status", "recipeRevision", "revisionId", "reportRefs"],
    context,
  );
  if (!JOB_STATUS_SET.has(String(source.status)))
    fail(`${context}.status is unsupported`);
  if (source.status === "committed" || source.status === "discarded") {
    fail(`${context} cannot retain a committed or discarded job as pending`);
  }
  if (!Array.isArray(source.reportRefs))
    fail(`${context}.reportRefs must be an array`);
  const reportRefs = source.reportRefs.map((entry, index) =>
    parseDocumentRef(entry, `${context}.reportRefs[${index}]`),
  );
  const reportKeys = reportRefs.map(
    (entry) => `${entry.contract}\u0000${entry.ref}\u0000${entry.sha256}`,
  );
  if (new Set(reportKeys).size !== reportKeys.length) {
    fail(`${context}.reportRefs must not contain duplicates`);
  }
  if (
    reportKeys.some((key, index) => index > 0 && reportKeys[index - 1] >= key)
  ) {
    fail(`${context}.reportRefs must be sorted`);
  }
  return {
    jobId: stableId(source.jobId, `${context}.jobId`),
    status: source.status as RecipeJobStatus,
    recipeRevision: positiveInteger(
      source.recipeRevision,
      `${context}.recipeRevision`,
    ),
    revisionId: stableId(source.revisionId, `${context}.revisionId`),
    reportRefs,
  };
}

function parseFailure(value: unknown, context: string): RecipeFailure {
  const source = record(value, context);
  rejectUnknownKeys(source, ["jobId", "stage", "reason", "reportRef"], context);
  if (!FAILURE_STAGES.has(source.stage as RecipeFailureStage)) {
    fail(`${context}.stage is unsupported`);
  }
  return {
    jobId: stableId(source.jobId, `${context}.jobId`),
    stage: source.stage as RecipeFailureStage,
    reason: stringValue(source.reason, `${context}.reason`),
    reportRef: parseNullableDocumentRef(
      source.reportRef,
      `${context}.reportRef`,
    ),
  };
}

function parseNullablePendingJob(
  value: unknown,
  context: string,
): RecipePendingJob | null {
  return value === null ? null : parsePendingJob(value, context);
}

function parseNullableFailure(
  value: unknown,
  context: string,
): RecipeFailure | null {
  return value === null ? null : parseFailure(value, context);
}

function assertLiveStatusConsistency(recipe: GoonRecipeV1): void {
  const { liveStatus, pendingJob, lastFailure } = recipe;
  if (pendingJob) {
    if (
      pendingJob.recipeRevision !== recipe.recipeRevision ||
      pendingJob.revisionId !== recipe.revisionId
    ) {
      fail("pendingJob must target the exact current Recipe revision");
    }
    if (lastFailure && lastFailure.jobId !== pendingJob.jobId) {
      fail("lastFailure.jobId must match pendingJob.jobId");
    }
  }
  if (liveStatus === "up_to_date") {
    if (pendingJob !== null || lastFailure !== null) {
      fail("up_to_date cannot retain a pending job or visible failure");
    }
    return;
  }
  if (liveStatus === "needs_bake") {
    if (pendingJob !== null) fail("needs_bake cannot retain a pending job");
    return;
  }
  if (liveStatus === "building") {
    if (!pendingJob || !ACTIVE_RECIPE_JOB_STATUSES.has(pendingJob.status)) {
      fail("building requires one active pending job");
    }
    if (lastFailure !== null) fail("building cannot retain a visible failure");
    return;
  }
  if (liveStatus === "failed") {
    if (!pendingJob || pendingJob.status !== "failed" || !lastFailure) {
      fail("failed requires a failed pending job and visible failure");
    }
    return;
  }
  if (!pendingJob || pendingJob.status !== "interrupted" || !lastFailure) {
    fail("interrupted requires an interrupted pending job and visible failure");
  }
}

export function parseGoonRecipe(value: unknown): GoonRecipeV1 {
  canonicalRecipeString(value);
  const source = record(value, "recipe");
  rejectUnknownKeys(
    source,
    [
      "contract",
      "recipeRevision",
      "revisionId",
      "concurrencyToken",
      "liveStatus",
      "authoringRevision",
      "activeRevision",
      "previousRevision",
      "activeLiveBuildReceipt",
      "pendingJob",
      "latestUpdateReport",
      "lastFailure",
    ],
    "recipe",
  );
  if (source.contract !== GOON_RECIPE_CONTRACT) {
    fail(`recipe.contract must equal ${GOON_RECIPE_CONTRACT}`);
  }
  if (!LIVE_STATUS_SET.has(String(source.liveStatus)))
    fail("recipe.liveStatus is unsupported");
  const recipeRevision = positiveInteger(
    source.recipeRevision,
    "recipe.recipeRevision",
  );
  const revisionId = stableId(source.revisionId, "recipe.revisionId");
  const authoringRevision = parseRecipeAuthoringRevision(
    source.authoringRevision,
    "recipe.authoringRevision",
  );
  if (
    authoringRevision.recipeRevision !== recipeRevision ||
    authoringRevision.revisionId !== revisionId
  ) {
    fail("recipe authoring revision identity must match the owner");
  }
  const activeRevision =
    source.activeRevision === null
      ? null
      : parseRecipeRevisionBundle(
          source.activeRevision,
          "recipe.activeRevision",
        );
  let previousRevision: RecipeRevisionBundle | null = null;
  if (source.previousRevision !== null) {
    previousRevision = parseRecipeRevisionBundle(
      source.previousRevision,
      "recipe.previousRevision",
    );
  }
  if (activeRevision === null) {
    if (recipeRevision !== 1) {
      fail("a Recipe without an active revision must be authoring revision 1");
    }
    if (previousRevision !== null) {
      fail(
        "a Recipe without an active revision cannot have a previous revision",
      );
    }
  } else if (activeRevision.recipeRevision === 1) {
    if (previousRevision !== null) {
      fail("active Recipe revision 1 cannot have a previous revision");
    }
  } else {
    if (!previousRevision)
      fail("recipe must retain the immediately previous successful revision");
    if (previousRevision.recipeRevision !== activeRevision.recipeRevision - 1) {
      fail(
        "recipe previous revision must be exactly active revision minus one",
      );
    }
    if (
      previousRevision.revisionId === activeRevision.revisionId ||
      previousRevision.revisionSha256 === activeRevision.revisionSha256
    ) {
      fail(
        "recipe active and previous revisions must have distinct immutable identities",
      );
    }
  }
  const activeLiveBuildReceipt = parseNullableDocumentRef(
    source.activeLiveBuildReceipt,
    "recipe.activeLiveBuildReceipt",
    GOON_LIVE_BUILD_CONTRACT,
  );
  if (activeRevision === null) {
    if (activeLiveBuildReceipt !== null) {
      fail(
        "a Recipe without an active revision cannot have a Live-build receipt",
      );
    }
  } else {
    if (activeRevision.recipeRevision > recipeRevision) {
      fail(
        "recipe active revision cannot be newer than the authoring revision",
      );
    }
    if (
      activeLiveBuildReceipt === null ||
      !documentRefsEqual(
        activeLiveBuildReceipt,
        activeRevision.liveBuildReceipt,
      )
    ) {
      fail("recipe active Live-build receipt must match the active revision");
    }
  }
  const recipe: GoonRecipeV1 = {
    contract: GOON_RECIPE_CONTRACT,
    recipeRevision,
    revisionId,
    concurrencyToken: sha256(
      source.concurrencyToken,
      "recipe.concurrencyToken",
    ),
    liveStatus: source.liveStatus as RecipeLiveStatus,
    authoringRevision,
    activeRevision,
    previousRevision,
    activeLiveBuildReceipt,
    pendingJob: parseNullablePendingJob(source.pendingJob, "recipe.pendingJob"),
    latestUpdateReport: parseNullableDocumentRef(
      source.latestUpdateReport,
      "recipe.latestUpdateReport",
      RECIPE_MIGRATION_REPORT_CONTRACT,
    ),
    lastFailure: parseNullableFailure(source.lastFailure, "recipe.lastFailure"),
  };
  const authoringMatchesActive =
    activeRevision !== null &&
    authoringRevision.recipeRevision === activeRevision.recipeRevision &&
    authoringRevision.revisionId === activeRevision.revisionId &&
    canonicalRecipeString(authoringRevision.source) ===
      canonicalRecipeString(activeRevision.source) &&
    authoringRevision.state.stateSha256 === activeRevision.state.stateSha256;
  if (recipe.liveStatus === "up_to_date") {
    if (!authoringMatchesActive) {
      fail(
        "up_to_date requires the authoring revision to match the active successful revision",
      );
    }
  } else if (activeRevision === null) {
    if (authoringRevision.recipeRevision !== 1) {
      fail("the first pending bake must use authoring revision 1");
    }
  } else {
    if (authoringMatchesActive) {
      fail("a Recipe that matches the active revision cannot require a bake");
    }
    if (
      authoringRevision.recipeRevision !==
      activeRevision.recipeRevision + 1
    ) {
      fail(
        "a pending authoring revision must be exactly active revision plus one",
      );
    }
    if (authoringRevision.revisionId === activeRevision.revisionId) {
      fail(
        "a pending authoring revision must have a new immutable revision id",
      );
    }
    if (
      previousRevision &&
      authoringRevision.revisionId === previousRevision.revisionId
    ) {
      fail("a pending authoring revision cannot reuse a retained revision id");
    }
  }
  assertLiveStatusConsistency(recipe);
  return recipe;
}

export function parseRecipeStateSnapshot(value: unknown): RecipeStateSnapshot {
  canonicalRecipeString(value);
  return parseRecipeState(value, "recipe state");
}

export async function recipeSiblingStateSha256(
  state: unknown,
): Promise<string> {
  canonicalRecipeString(state);
  return canonicalRecipeSha256(state);
}

export async function recipeStateSnapshotSha256(
  value: unknown,
): Promise<string> {
  const state = parseRecipeStateSnapshot(value);
  const { stateSha256: _stateSha256, ...content } = state;
  return canonicalRecipeSha256(content);
}

export async function verifyRecipeStateSnapshot(
  value: unknown,
): Promise<RecipeStateSnapshot> {
  const state = parseRecipeStateSnapshot(value);
  for (const sibling of state.siblings) {
    const actual = await recipeSiblingStateSha256(sibling.state);
    if (actual !== sibling.stateSha256) {
      throw new Error(
        `recipe sibling ${sibling.id} state hash mismatch: expected ${sibling.stateSha256}, got ${actual}`,
      );
    }
  }
  const actual = await recipeStateSnapshotSha256(state);
  if (actual !== state.stateSha256) {
    throw new Error(
      `recipe state hash mismatch: expected ${state.stateSha256}, got ${actual}`,
    );
  }
  return state;
}

export async function recipeRevisionBundleSha256(
  value: unknown,
): Promise<string> {
  const revision = parseRecipeRevisionBundle(value);
  const { revisionSha256: _revisionSha256, ...content } = revision;
  return canonicalRecipeSha256(content);
}

export async function recipeAuthoringRevisionSha256(
  value: unknown,
): Promise<string> {
  const revision = parseRecipeAuthoringRevision(value);
  const { revisionSha256: _revisionSha256, ...content } = revision;
  return canonicalRecipeSha256(content);
}

export async function verifyRecipeAuthoringRevision(
  value: unknown,
): Promise<RecipeAuthoringRevision> {
  const revision = parseRecipeAuthoringRevision(value);
  await verifyRecipeStateSnapshot(revision.state);
  const actual = await recipeAuthoringRevisionSha256(revision);
  if (actual !== revision.revisionSha256) {
    throw new Error(
      `recipe authoring revision hash mismatch: expected ${revision.revisionSha256}, got ${actual}`,
    );
  }
  return revision;
}

export async function verifyRecipeRevisionBundle(
  value: unknown,
): Promise<RecipeRevisionBundle> {
  const revision = parseRecipeRevisionBundle(value);
  await verifyRecipeStateSnapshot(revision.state);
  const actual = await recipeRevisionBundleSha256(revision);
  if (actual !== revision.revisionSha256) {
    throw new Error(
      `recipe revision hash mismatch: expected ${revision.revisionSha256}, got ${actual}`,
    );
  }
  return revision;
}

export async function verifyGoonRecipe(value: unknown): Promise<GoonRecipeV1> {
  const recipe = parseGoonRecipe(value);
  await verifyRecipeAuthoringRevision(recipe.authoringRevision);
  if (recipe.activeRevision) {
    await verifyRecipeRevisionBundle(recipe.activeRevision);
  }
  if (recipe.previousRevision) {
    await verifyRecipeRevisionBundle(recipe.previousRevision);
  }
  return recipe;
}
