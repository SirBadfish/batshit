import { RECIPE_MIGRATION_PLAN_CONTRACT } from "./migrationPlanContracts";
import {
  RECIPE_ARCHIVE_CONTAINMENT_RECEIPT_CONTRACT,
  parseRecipeStoredAssetRef,
  type RecipeStoredAssetRef,
} from "./archiveContainmentContracts";
import {
  GOON_RECIPE_AUTHORING_REVISION_CONTRACT,
  RECIPE_FAILURE_STAGES,
  RECIPE_JOB_STATUSES,
  RECIPE_LIVE_STATUSES,
  parseRecipeAuthoringRevision,
  parseRecipeRevisionBundle,
  verifyRecipeAuthoringRevision,
  verifyRecipeRevisionBundle,
  type RecipeAuthoringRevision,
  type RecipeDocumentRef,
  type RecipeFailureStage,
  type RecipeJobStatus,
  type RecipeLiveStatus,
  type RecipeRevisionBundle,
  type RecipeSource,
} from "./recipeContracts";
import { parseRecipeSource } from "./recipeContracts";
import {
  canonicalRecipeSha256,
  canonicalRecipeString,
  requireLowercaseSha256,
} from "./recipeCanonical";
import {
  GOON_LIVE_BUILD_CONTRACT,
  parseGoonLiveBuildReceipt,
} from "./liveBuildContracts";

export const GOON_RECIPE_OWNER_V2_CONTRACT = "goon-recipe/v2" as const;
export const GOON_RECIPE_REVISION_ENVELOPE_CONTRACT =
  "goon-recipe-revision-envelope/v1" as const;
export const GOON_RECIPE_DOCUMENT_CONTRACT =
  "goon-recipe-document/v1" as const;
export const GOON_RECIPE_JOB_CONTRACT = "goon-recipe-job/v1" as const;

export const RECIPE_JOB_OPERATIONS = [
  "first-bake",
  "rebake",
  "package-update",
] as const;

export type RecipeJobOperation = (typeof RECIPE_JOB_OPERATIONS)[number];

export type RecipeAssetSet = {
  package: RecipeStoredAssetRef;
  model: RecipeStoredAssetRef;
  manifest: RecipeStoredAssetRef;
};

export type RecipeRevisionEnvelope = {
  contract: typeof GOON_RECIPE_REVISION_ENVELOPE_CONTRACT;
  envelopeSha256: string;
  revision: RecipeRevisionBundle;
  sourceContainmentReceipt: RecipeDocumentRef;
  live: RecipeAssetSet;
};

export type GoonRecipeDocument = {
  contract: typeof GOON_RECIPE_DOCUMENT_CONTRACT;
  userId: string;
  goonId: string;
  documentContract: string;
  sha256: string;
  content: Record<string, unknown>;
};

export type RecipeLifecycleFailure = {
  stage: RecipeFailureStage;
  reason: string;
  reportRef: RecipeDocumentRef | null;
};

export type RecipeJobLease = {
  ownerId: string;
  expiresAt: string;
};

export type RecipeStagedSource = {
  source: RecipeSource;
  containmentReceipt: RecipeDocumentRef;
};

export type GoonRecipeJob = {
  contract: typeof GOON_RECIPE_JOB_CONTRACT;
  userId: string;
  goonId: string;
  jobId: string;
  idempotencyKey: string;
  operation: RecipeJobOperation;
  status: RecipeJobStatus;
  stateVersion: number;
  attempt: number;
  targetWriteVersion: number;
  targetRecipeRevision: number;
  targetRevisionId: string;
  sourceRevision: RecipeDocumentRef | null;
  stagedSource: RecipeStagedSource;
  plan: RecipeDocumentRef | null;
  migrationReport: RecipeDocumentRef | null;
  reviewedState: RecipeDocumentRef;
  stagedLive: RecipeAssetSet | null;
  candidateRevision: RecipeDocumentRef | null;
  lease: RecipeJobLease | null;
  failure: RecipeLifecycleFailure | null;
  cleanupAssets: RecipeStoredAssetRef[];
  createdAt: string;
  updatedAt: string;
};

export type RecipePendingJobV2 = {
  jobId: string;
  jobRef: string;
  status: RecipeJobStatus;
  operation: RecipeJobOperation;
  targetWriteVersion: number;
  targetRecipeRevision: number;
  targetRevisionId: string;
};

export type RecipePendingAnalysisV2 = {
  analysisId: string;
  analysisRef: RecipeDocumentRef;
  basePlan: RecipeDocumentRef;
  selectedPlan: RecipeDocumentRef;
  migrationReport: RecipeDocumentRef;
  containmentReceipt: RecipeDocumentRef;
  reviewedState: RecipeDocumentRef | null;
  targetWriteVersion: number;
};

export type GoonRecipeV2 = {
  contract: typeof GOON_RECIPE_OWNER_V2_CONTRACT;
  writeVersion: number;
  nextRecipeRevision: number;
  liveStatus: RecipeLiveStatus;
  authoringRevision: RecipeAuthoringRevision;
  authoringSourceContainmentReceipt: RecipeDocumentRef;
  activeRevision: RecipeDocumentRef | null;
  previousRevision: RecipeDocumentRef | null;
  pendingAnalysis: RecipePendingAnalysisV2 | null;
  pendingJob: RecipePendingJobV2 | null;
  latestUpdateReport: RecipeDocumentRef | null;
  lastFailure: RecipeLifecycleFailure | null;
  maintenanceFailure: RecipeLifecycleFailure | null;
};

type UnknownRecord = Record<string, unknown>;

const VERSIONED_CONTRACT_PATTERN =
  /^[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)*\/v[1-9][0-9]*$/;
const STABLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const ACTIVE_JOB_STATUSES = new Set<RecipeJobStatus>([
  "validating",
  "planning",
  "baking",
  "packaging",
  "verifying",
  "committing",
]);
const BUILDING_JOB_STATUSES = new Set<RecipeJobStatus>([
  ...ACTIVE_JOB_STATUSES,
  "ready",
]);
const TERMINAL_JOB_STATUSES = new Set<RecipeJobStatus>([
  "committed",
  "discarded",
]);
const JOB_STATUS_SET = new Set<string>(RECIPE_JOB_STATUSES);
const LIVE_STATUS_SET = new Set<string>(RECIPE_LIVE_STATUSES);
const FAILURE_STAGE_SET = new Set<string>(RECIPE_FAILURE_STAGES);
const JOB_OPERATION_SET = new Set<string>(RECIPE_JOB_OPERATIONS);

function fail(path: string, message: string): never {
  throw new Error(`[${GOON_RECIPE_OWNER_V2_CONTRACT}] ${path} ${message}`);
}

function record(value: unknown, path: string): UnknownRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(path, "must be an object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail(path, "must be a plain object");
  }
  return value as UnknownRecord;
}

function exactKeys(
  value: UnknownRecord,
  expected: readonly string[],
  path: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    fail(path, `must contain exactly: ${wanted.join(", ")}`);
  }
}

function stringValue(value: unknown, path: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    fail(path, "must be a non-empty trimmed string without control characters");
  }
  return value;
}

function stableId(value: unknown, path: string): string {
  const parsed = stringValue(value, path);
  if (!STABLE_ID_PATTERN.test(parsed)) fail(path, "must be a stable id");
  return parsed;
}

function positiveInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    fail(path, "must be a positive safe integer");
  }
  return value as number;
}

function nonNegativeInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    fail(path, "must be a non-negative safe integer");
  }
  return value as number;
}

function isoDate(value: unknown, path: string): string {
  const parsed = stringValue(value, path);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(parsed)) {
    fail(path, "must be a canonical UTC ISO timestamp");
  }
  if (!Number.isFinite(Date.parse(parsed))) fail(path, "must be a valid timestamp");
  return parsed;
}

function versionedContract(value: unknown, path: string): string {
  const parsed = stringValue(value, path);
  if (!VERSIONED_CONTRACT_PATTERN.test(parsed)) {
    fail(path, "must be a versioned contract id");
  }
  return parsed;
}

function parseDocumentRef(
  value: unknown,
  path: string,
  requiredContract?: string,
): RecipeDocumentRef {
  const raw = record(value, path);
  exactKeys(raw, ["contract", "ref", "sha256"], path);
  const contract = versionedContract(raw.contract, `${path}.contract`);
  if (requiredContract && contract !== requiredContract) {
    fail(`${path}.contract`, `must equal ${requiredContract}`);
  }
  return {
    contract,
    ref: stringValue(raw.ref, `${path}.ref`),
    sha256: requireLowercaseSha256(raw.sha256, `${path}.sha256`),
  };
}

function nullableDocumentRef(
  value: unknown,
  path: string,
  requiredContract?: string,
): RecipeDocumentRef | null {
  return value === null ? null : parseDocumentRef(value, path, requiredContract);
}

function parseAssetSet(value: unknown, path: string): RecipeAssetSet {
  const raw = record(value, path);
  exactKeys(raw, ["package", "model", "manifest"], path);
  const result = {
    package: parseRecipeStoredAssetRef(raw.package, `${path}.package`),
    model: parseRecipeStoredAssetRef(raw.model, `${path}.model`),
    manifest: parseRecipeStoredAssetRef(raw.manifest, `${path}.manifest`),
  };
  if (new Set(Object.values(result).map((asset) => asset.ref)).size !== 3) {
    fail(path, "asset refs must be distinct");
  }
  return result;
}

function parseFailure(
  value: unknown,
  path: string,
): RecipeLifecycleFailure {
  const raw = record(value, path);
  exactKeys(raw, ["stage", "reason", "reportRef"], path);
  if (!FAILURE_STAGE_SET.has(String(raw.stage))) {
    fail(`${path}.stage`, "is unsupported");
  }
  return {
    stage: raw.stage as RecipeFailureStage,
    reason: stringValue(raw.reason, `${path}.reason`),
    reportRef: nullableDocumentRef(raw.reportRef, `${path}.reportRef`),
  };
}

function nullableFailure(
  value: unknown,
  path: string,
): RecipeLifecycleFailure | null {
  return value === null ? null : parseFailure(value, path);
}

export function parseRecipeRevisionEnvelope(
  value: unknown,
): RecipeRevisionEnvelope {
  canonicalRecipeString(value);
  const raw = record(value, "revision envelope");
  exactKeys(
    raw,
    [
      "contract",
      "envelopeSha256",
      "revision",
      "sourceContainmentReceipt",
      "live",
    ],
    "revision envelope",
  );
  if (raw.contract !== GOON_RECIPE_REVISION_ENVELOPE_CONTRACT) {
    fail(
      "revision envelope.contract",
      `must equal ${GOON_RECIPE_REVISION_ENVELOPE_CONTRACT}`,
    );
  }
  return {
    contract: GOON_RECIPE_REVISION_ENVELOPE_CONTRACT,
    envelopeSha256: requireLowercaseSha256(
      raw.envelopeSha256,
      "revision envelope.envelopeSha256",
    ),
    revision: parseRecipeRevisionBundle(raw.revision, "revision envelope.revision"),
    sourceContainmentReceipt: parseDocumentRef(
      raw.sourceContainmentReceipt,
      "revision envelope.sourceContainmentReceipt",
      RECIPE_ARCHIVE_CONTAINMENT_RECEIPT_CONTRACT,
    ),
    live: parseAssetSet(raw.live, "revision envelope.live"),
  };
}

export async function recipeRevisionEnvelopeSha256(
  value: unknown,
): Promise<string> {
  const envelope = parseRecipeRevisionEnvelope(value);
  const { envelopeSha256: _envelopeSha256, ...content } = envelope;
  return canonicalRecipeSha256(content);
}

export async function verifyRecipeRevisionEnvelope(
  value: unknown,
): Promise<RecipeRevisionEnvelope> {
  const envelope = parseRecipeRevisionEnvelope(value);
  await verifyRecipeRevisionBundle(envelope.revision);
  const actual = await recipeRevisionEnvelopeSha256(envelope);
  if (actual !== envelope.envelopeSha256) {
    fail(
      "revision envelope.envelopeSha256",
      `mismatch: expected ${envelope.envelopeSha256}, got ${actual}`,
    );
  }
  return envelope;
}

export async function createRecipeRevisionEnvelope(
  value: Omit<RecipeRevisionEnvelope, "envelopeSha256">,
): Promise<RecipeRevisionEnvelope> {
  const candidate: RecipeRevisionEnvelope = {
    ...value,
    envelopeSha256: "0".repeat(64),
  };
  const parsed = parseRecipeRevisionEnvelope(candidate);
  parsed.envelopeSha256 = await recipeRevisionEnvelopeSha256(parsed);
  return parsed;
}

export function parseGoonRecipeDocument(value: unknown): GoonRecipeDocument {
  canonicalRecipeString(value);
  const raw = record(value, "Recipe document");
  exactKeys(
    raw,
    ["contract", "userId", "goonId", "documentContract", "sha256", "content"],
    "Recipe document",
  );
  if (raw.contract !== GOON_RECIPE_DOCUMENT_CONTRACT) {
    fail("Recipe document.contract", `must equal ${GOON_RECIPE_DOCUMENT_CONTRACT}`);
  }
  const content = record(raw.content, "Recipe document.content");
  const documentContract = versionedContract(
    raw.documentContract,
    "Recipe document.documentContract",
  );
  if (content.contract !== documentContract) {
    fail("Recipe document.content.contract", "must match documentContract");
  }
  return {
    contract: GOON_RECIPE_DOCUMENT_CONTRACT,
    userId: stableId(raw.userId, "Recipe document.userId"),
    goonId: stableId(raw.goonId, "Recipe document.goonId"),
    documentContract,
    sha256: requireLowercaseSha256(raw.sha256, "Recipe document.sha256"),
    content,
  };
}

function normalizedRecipeDocumentContent(
  documentContract: string,
  content: Record<string, unknown>,
): Record<string, unknown> {
  if (documentContract === GOON_LIVE_BUILD_CONTRACT) {
    return parseGoonLiveBuildReceipt(content) as unknown as Record<
      string,
      unknown
    >;
  }
  return content;
}

export async function verifyGoonRecipeDocument(
  value: unknown,
): Promise<GoonRecipeDocument> {
  const document = parseGoonRecipeDocument(value);
  const content = normalizedRecipeDocumentContent(
    document.documentContract,
    document.content,
  );
  const actual = await canonicalRecipeSha256(content);
  if (actual !== document.sha256) {
    fail(
      "Recipe document.sha256",
      `mismatch: expected ${document.sha256}, got ${actual}`,
    );
  }
  return { ...document, content };
}

export async function createGoonRecipeDocument(input: {
  userId: string;
  goonId: string;
  content: Record<string, unknown>;
}): Promise<GoonRecipeDocument> {
  const documentContract = versionedContract(
    input.content.contract,
    "Recipe document.content.contract",
  );
  const content = normalizedRecipeDocumentContent(
    documentContract,
    input.content,
  );
  return parseGoonRecipeDocument({
    contract: GOON_RECIPE_DOCUMENT_CONTRACT,
    userId: input.userId,
    goonId: input.goonId,
    documentContract,
    sha256: await canonicalRecipeSha256(content),
    content,
  });
}

function parseLease(value: unknown, path: string): RecipeJobLease {
  const raw = record(value, path);
  exactKeys(raw, ["ownerId", "expiresAt"], path);
  return {
    ownerId: stableId(raw.ownerId, `${path}.ownerId`),
    expiresAt: isoDate(raw.expiresAt, `${path}.expiresAt`),
  };
}

function parseStagedSource(value: unknown): RecipeStagedSource {
  const raw = record(value, "Recipe job.stagedSource");
  exactKeys(raw, ["source", "containmentReceipt"], "Recipe job.stagedSource");
  return {
    source: parseRecipeSource(raw.source, "Recipe job.stagedSource.source"),
    containmentReceipt: parseDocumentRef(
      raw.containmentReceipt,
      "Recipe job.stagedSource.containmentReceipt",
      RECIPE_ARCHIVE_CONTAINMENT_RECEIPT_CONTRACT,
    ),
  };
}

export function parseGoonRecipeJob(value: unknown): GoonRecipeJob {
  canonicalRecipeString(value);
  const raw = record(value, "Recipe job");
  exactKeys(
    raw,
    [
      "contract",
      "userId",
      "goonId",
      "jobId",
      "idempotencyKey",
      "operation",
      "status",
      "stateVersion",
      "attempt",
      "targetWriteVersion",
      "targetRecipeRevision",
      "targetRevisionId",
      "sourceRevision",
      "stagedSource",
      "plan",
      "migrationReport",
      "reviewedState",
      "stagedLive",
      "candidateRevision",
      "lease",
      "failure",
      "cleanupAssets",
      "createdAt",
      "updatedAt",
    ],
    "Recipe job",
  );
  if (raw.contract !== GOON_RECIPE_JOB_CONTRACT) {
    fail("Recipe job.contract", `must equal ${GOON_RECIPE_JOB_CONTRACT}`);
  }
  if (!JOB_OPERATION_SET.has(String(raw.operation))) {
    fail("Recipe job.operation", "is unsupported");
  }
  if (!JOB_STATUS_SET.has(String(raw.status))) {
    fail("Recipe job.status", "is unsupported");
  }
  if (!Array.isArray(raw.cleanupAssets)) {
    fail("Recipe job.cleanupAssets", "must be an array");
  }
  const cleanupAssets = raw.cleanupAssets.map((asset, index) =>
    parseRecipeStoredAssetRef(asset, `Recipe job.cleanupAssets[${index}]`),
  );
  const cleanupRefs = cleanupAssets.map((asset) => asset.ref);
  if (
    new Set(cleanupRefs).size !== cleanupRefs.length ||
    cleanupRefs.some((ref, index) => index > 0 && cleanupRefs[index - 1] >= ref)
  ) {
    fail("Recipe job.cleanupAssets", "must be sorted with no duplicate refs");
  }
  const status = raw.status as RecipeJobStatus;
  const lease = raw.lease === null ? null : parseLease(raw.lease, "Recipe job.lease");
  const failure = nullableFailure(raw.failure, "Recipe job.failure");
  if (ACTIVE_JOB_STATUSES.has(status) !== Boolean(lease)) {
    fail("Recipe job.lease", "must exist exactly while a runner owns an active stage");
  }
  if ((status === "failed" || status === "interrupted") !== Boolean(failure)) {
    fail("Recipe job.failure", "must exist exactly for failed or interrupted work");
  }
  if (TERMINAL_JOB_STATUSES.has(status) && cleanupAssets.length > 0) {
    fail("Recipe job.cleanupAssets", "must be empty after a terminal transition");
  }
  const candidateRevision = nullableDocumentRef(
    raw.candidateRevision,
    "Recipe job.candidateRevision",
    GOON_RECIPE_REVISION_ENVELOPE_CONTRACT,
  );
  const stagedLive = raw.stagedLive === null ? null : parseAssetSet(raw.stagedLive, "Recipe job.stagedLive");
  if (candidateRevision && !stagedLive) {
    fail("Recipe job.stagedLive", "is required once a candidate revision exists");
  }
  if (
    (status === "ready" || status === "committing" || status === "committed") &&
    !candidateRevision
  ) {
    fail("Recipe job.candidateRevision", "is required once a candidate is ready");
  }
  if (
    ["validating", "planning", "baking", "packaging", "verifying"].includes(status) &&
    candidateRevision
  ) {
    fail("Recipe job.candidateRevision", "cannot exist before verification completes");
  }
  const plan = nullableDocumentRef(
    raw.plan,
    "Recipe job.plan",
    RECIPE_MIGRATION_PLAN_CONTRACT,
  );
  const reviewedState = parseDocumentRef(
    raw.reviewedState,
    "Recipe job.reviewedState",
    "recipe-reviewed-state/v1",
  );
  const migrationReport = nullableDocumentRef(
    raw.migrationReport,
    "Recipe job.migrationReport",
    "recipe-migration-report/v1",
  );
  if (
    raw.operation === "package-update" &&
    ["baking", "packaging", "verifying", "ready", "committing", "committed"].includes(status) &&
    !plan
  ) {
    fail("Recipe job.plan", "is required after package-update planning");
  }
  if (raw.operation === "package-update" && !migrationReport) {
    fail("Recipe job.migrationReport", "is required for package updates");
  }
  if (raw.operation !== "package-update" && migrationReport) {
    fail("Recipe job.migrationReport", "is only valid for package updates");
  }
  const createdAt = isoDate(raw.createdAt, "Recipe job.createdAt");
  const updatedAt = isoDate(raw.updatedAt, "Recipe job.updatedAt");
  if (Date.parse(updatedAt) < Date.parse(createdAt)) {
    fail("Recipe job.updatedAt", "cannot predate createdAt");
  }
  return {
    contract: GOON_RECIPE_JOB_CONTRACT,
    userId: stableId(raw.userId, "Recipe job.userId"),
    goonId: stableId(raw.goonId, "Recipe job.goonId"),
    jobId: stableId(raw.jobId, "Recipe job.jobId"),
    idempotencyKey: stableId(raw.idempotencyKey, "Recipe job.idempotencyKey"),
    operation: raw.operation as RecipeJobOperation,
    status,
    stateVersion: positiveInteger(raw.stateVersion, "Recipe job.stateVersion"),
    attempt: positiveInteger(raw.attempt, "Recipe job.attempt"),
    targetWriteVersion: positiveInteger(
      raw.targetWriteVersion,
      "Recipe job.targetWriteVersion",
    ),
    targetRecipeRevision: positiveInteger(
      raw.targetRecipeRevision,
      "Recipe job.targetRecipeRevision",
    ),
    targetRevisionId: stableId(raw.targetRevisionId, "Recipe job.targetRevisionId"),
    sourceRevision: nullableDocumentRef(
      raw.sourceRevision,
      "Recipe job.sourceRevision",
      GOON_RECIPE_REVISION_ENVELOPE_CONTRACT,
    ),
    stagedSource: parseStagedSource(raw.stagedSource),
    plan,
    migrationReport,
    reviewedState,
    stagedLive,
    candidateRevision,
    lease,
    failure,
    cleanupAssets,
    createdAt,
    updatedAt,
  };
}

function parsePendingAnalysis(value: unknown): RecipePendingAnalysisV2 {
  const raw = record(value, "Recipe owner.pendingAnalysis");
  exactKeys(
    raw,
    [
      "analysisId",
      "analysisRef",
      "basePlan",
      "selectedPlan",
      "migrationReport",
      "containmentReceipt",
      "reviewedState",
      "targetWriteVersion",
    ],
    "Recipe owner.pendingAnalysis",
  );
  return {
    analysisId: stableId(raw.analysisId, "Recipe owner.pendingAnalysis.analysisId"),
    analysisRef: parseDocumentRef(
      raw.analysisRef,
      "Recipe owner.pendingAnalysis.analysisRef",
      "recipe-update-analysis-context/v3",
    ),
    basePlan: parseDocumentRef(
      raw.basePlan,
      "Recipe owner.pendingAnalysis.basePlan",
      RECIPE_MIGRATION_PLAN_CONTRACT,
    ),
    selectedPlan: parseDocumentRef(
      raw.selectedPlan,
      "Recipe owner.pendingAnalysis.selectedPlan",
      RECIPE_MIGRATION_PLAN_CONTRACT,
    ),
    migrationReport: parseDocumentRef(
      raw.migrationReport,
      "Recipe owner.pendingAnalysis.migrationReport",
      "recipe-migration-report/v1",
    ),
    containmentReceipt: parseDocumentRef(
      raw.containmentReceipt,
      "Recipe owner.pendingAnalysis.containmentReceipt",
      RECIPE_ARCHIVE_CONTAINMENT_RECEIPT_CONTRACT,
    ),
    reviewedState: nullableDocumentRef(
      raw.reviewedState,
      "Recipe owner.pendingAnalysis.reviewedState",
      "recipe-reviewed-state/v1",
    ),
    targetWriteVersion: positiveInteger(
      raw.targetWriteVersion,
      "Recipe owner.pendingAnalysis.targetWriteVersion",
    ),
  };
}

function parsePendingJob(value: unknown): RecipePendingJobV2 {
  const raw = record(value, "Recipe owner.pendingJob");
  exactKeys(
    raw,
    [
      "jobId",
      "jobRef",
      "status",
      "operation",
      "targetWriteVersion",
      "targetRecipeRevision",
      "targetRevisionId",
    ],
    "Recipe owner.pendingJob",
  );
  if (!JOB_STATUS_SET.has(String(raw.status)) || TERMINAL_JOB_STATUSES.has(raw.status as RecipeJobStatus)) {
    fail("Recipe owner.pendingJob.status", "must be a non-terminal job status");
  }
  if (!JOB_OPERATION_SET.has(String(raw.operation))) {
    fail("Recipe owner.pendingJob.operation", "is unsupported");
  }
  return {
    jobId: stableId(raw.jobId, "Recipe owner.pendingJob.jobId"),
    jobRef: stringValue(raw.jobRef, "Recipe owner.pendingJob.jobRef"),
    status: raw.status as RecipeJobStatus,
    operation: raw.operation as RecipeJobOperation,
    targetWriteVersion: positiveInteger(
      raw.targetWriteVersion,
      "Recipe owner.pendingJob.targetWriteVersion",
    ),
    targetRecipeRevision: positiveInteger(
      raw.targetRecipeRevision,
      "Recipe owner.pendingJob.targetRecipeRevision",
    ),
    targetRevisionId: stableId(
      raw.targetRevisionId,
      "Recipe owner.pendingJob.targetRevisionId",
    ),
  };
}

export function parseGoonRecipeV2(value: unknown): GoonRecipeV2 {
  canonicalRecipeString(value);
  const raw = record(value, "Recipe owner");
  exactKeys(
    raw,
    [
      "contract",
      "writeVersion",
      "nextRecipeRevision",
      "liveStatus",
      "authoringRevision",
      "authoringSourceContainmentReceipt",
      "activeRevision",
      "previousRevision",
      "pendingAnalysis",
      "pendingJob",
      "latestUpdateReport",
      "lastFailure",
      "maintenanceFailure",
    ],
    "Recipe owner",
  );
  if (raw.contract !== GOON_RECIPE_OWNER_V2_CONTRACT) {
    fail("Recipe owner.contract", `must equal ${GOON_RECIPE_OWNER_V2_CONTRACT}`);
  }
  if (!LIVE_STATUS_SET.has(String(raw.liveStatus))) {
    fail("Recipe owner.liveStatus", "is unsupported");
  }
  const authoringRevision = parseRecipeAuthoringRevision(
    raw.authoringRevision,
    "Recipe owner.authoringRevision",
  );
  if (authoringRevision.contract !== GOON_RECIPE_AUTHORING_REVISION_CONTRACT) {
    fail("Recipe owner.authoringRevision.contract", "is unsupported");
  }
  const writeVersion = positiveInteger(raw.writeVersion, "Recipe owner.writeVersion");
  const nextRecipeRevision = positiveInteger(
    raw.nextRecipeRevision,
    "Recipe owner.nextRecipeRevision",
  );
  if (nextRecipeRevision <= authoringRevision.recipeRevision) {
    fail("Recipe owner.nextRecipeRevision", "must exceed the authoring revision");
  }
  const activeRevision = nullableDocumentRef(
    raw.activeRevision,
    "Recipe owner.activeRevision",
    GOON_RECIPE_REVISION_ENVELOPE_CONTRACT,
  );
  const authoringSourceContainmentReceipt = parseDocumentRef(
    raw.authoringSourceContainmentReceipt,
    "Recipe owner.authoringSourceContainmentReceipt",
    RECIPE_ARCHIVE_CONTAINMENT_RECEIPT_CONTRACT,
  );
  const previousRevision = nullableDocumentRef(
    raw.previousRevision,
    "Recipe owner.previousRevision",
    GOON_RECIPE_REVISION_ENVELOPE_CONTRACT,
  );
  if (
    activeRevision &&
    previousRevision &&
    (activeRevision.ref === previousRevision.ref ||
      activeRevision.sha256 === previousRevision.sha256)
  ) {
    fail("Recipe owner", "active and previous revisions must be distinct");
  }
  const pendingJob = raw.pendingJob === null ? null : parsePendingJob(raw.pendingJob);
  const pendingAnalysis =
    raw.pendingAnalysis === null ? null : parsePendingAnalysis(raw.pendingAnalysis);
  if (pendingAnalysis && pendingJob) {
    fail("Recipe owner", "cannot retain analysis review and a build job simultaneously");
  }
  if (pendingAnalysis && pendingAnalysis.targetWriteVersion !== writeVersion) {
    fail("Recipe owner.pendingAnalysis", "must target the current write version");
  }
  if (pendingJob && pendingJob.targetWriteVersion !== writeVersion) {
    fail("Recipe owner.pendingJob", "must target the current write version");
  }
  const lastFailure = nullableFailure(raw.lastFailure, "Recipe owner.lastFailure");
  const liveStatus = raw.liveStatus as RecipeLiveStatus;
  if (liveStatus === "up_to_date") {
    if (!activeRevision || pendingJob || lastFailure) {
      fail("Recipe owner", "up_to_date requires active output and no pending failure");
    }
  } else if (liveStatus === "needs_bake") {
    if (pendingJob || pendingAnalysis) {
      fail("Recipe owner", "needs_bake cannot retain pending analysis or build work");
    }
  } else if (liveStatus === "building") {
    if (pendingAnalysis || !pendingJob || !BUILDING_JOB_STATUSES.has(pendingJob.status) || lastFailure) {
      fail("Recipe owner", "building requires one active or ready job and no failure");
    }
  } else if (liveStatus === "failed") {
    if (!pendingJob || pendingJob.status !== "failed" || !lastFailure) {
      fail("Recipe owner", "failed requires a failed job and visible failure");
    }
  } else if (!pendingJob || pendingJob.status !== "interrupted" || !lastFailure) {
    fail("Recipe owner", "interrupted requires an interrupted job and visible failure");
  }
  return {
    contract: GOON_RECIPE_OWNER_V2_CONTRACT,
    writeVersion,
    nextRecipeRevision,
    liveStatus,
    authoringRevision,
    authoringSourceContainmentReceipt,
    activeRevision,
    previousRevision,
    pendingAnalysis,
    pendingJob,
    latestUpdateReport: nullableDocumentRef(
      raw.latestUpdateReport,
      "Recipe owner.latestUpdateReport",
    ),
    lastFailure,
    maintenanceFailure: nullableFailure(
      raw.maintenanceFailure,
      "Recipe owner.maintenanceFailure",
    ),
  };
}

export async function verifyGoonRecipeV2(value: unknown): Promise<GoonRecipeV2> {
  const owner = parseGoonRecipeV2(value);
  await verifyRecipeAuthoringRevision(owner.authoringRevision);
  return owner;
}

export function recipeJobRedisKey(
  userId: string,
  goonId: string,
  jobId: string,
): string {
  return `goon_recipe_job:${stableId(userId, "userId")}:${stableId(goonId, "goonId")}:${stableId(jobId, "jobId")}`;
}

export function recipeDocumentRedisKey(
  userId: string,
  goonId: string,
  sha256: string,
): string {
  return `goon_recipe_document:${stableId(userId, "userId")}:${stableId(goonId, "goonId")}:${requireLowercaseSha256(sha256, "sha256")}`;
}

export function recipeRevisionRedisKey(
  userId: string,
  goonId: string,
  revisionId: string,
): string {
  return `goon_recipe_revision:${stableId(userId, "userId")}:${stableId(goonId, "goonId")}:${stableId(revisionId, "revisionId")}`;
}
