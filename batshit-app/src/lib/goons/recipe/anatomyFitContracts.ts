import type { AppearanceDialsManifest } from "../appearanceDials.contracts";
import {
  canonicalRecipeSha256,
  requireLowercaseSha256,
} from "./recipeCanonical";
import {
  recipeStateSnapshotSha256,
  verifyRecipeStateSnapshot,
  type RecipeSiblingStateRecord,
  type RecipeStateSnapshot,
} from "./recipeContracts";

export const ANATOMY_FIT_INPUT_CONTRACT = "anatomy-fit-input/v2" as const;
export const ANATOMY_FIT_RESULT_CONTRACT = "anatomy-fit-result/v2" as const;
export const ANATOMY_FIT_STATE_CONTRACT = "anatomy-fit-state/v2" as const;
export const ANATOMY_FIT_RECIPE_SIBLING_ID = "anatomy-fit" as const;
export const SOCKET_EYE_ANATOMY_FIT_SOLVER = "socket-eye-anatomy-fit/v2" as const;
export const ORAL_CAVITY_ANATOMY_FIT_SOLVER =
  "oral-cavity-anatomy-fit/v2" as const;

const STABLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const VERSIONED_CONTRACT_PATTERN =
  /^[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)*\/v[1-9][0-9]*$/;
const BOUND_TOLERANCE = 1e-9;
const STORAGE_STABLE_SIGNIFICANT_DIGITS = 15;

export type AnatomyFitRelevantInput = {
  id: string;
  value: number;
};

export type AnatomyFitParameter = {
  id: string;
  lower: number;
  upper: number;
  neutral: number;
  regularizationWeight: number;
  initialStep: number;
  minimumStep: number;
};

export type AnatomyFitSourceIdentity = {
  modelSha256: string;
  appearanceDefinitionSha256: string;
  topologySha256: string;
  positionsSha256: string;
  positionsScalarCount: number;
  physicalEvaluationSha256: string;
  physicalEvaluationScalarCount: number;
  landmarkSetSha256: string;
  landmarkSampleCount: number;
};

export type AnatomyFitInput = {
  contract: typeof ANATOMY_FIT_INPUT_CONTRACT;
  solverVersion: string;
  domain: string;
  source: AnatomyFitSourceIdentity;
  relevantInputs: AnatomyFitRelevantInput[];
  parameters: AnatomyFitParameter[];
  inputSha256: string;
};

export type AnatomyFitNodeTransform = {
  nodeId: string;
  /**
   * Affine delta in the physical Recipe root coordinate system. The evaluator
   * conjugates this matrix through the node's resolved parent transform before
   * writing the baked local rest. A full matrix is required because an
   * anisotropic anatomy correction around a rotated anatomical frame cannot be
   * represented exactly by one parent-space TRS tuple.
   */
  rootDeltaMatrix: number[];
};

export type AnatomyFitFollowerMorphCoefficient = {
  followerId: string;
  channelId: string;
  nodeId: string;
  morph: string;
  weight: number;
  lower: number;
  upper: number;
};

export type AnatomyFitPhysicalOutput = {
  nodeTransforms: AnatomyFitNodeTransform[];
  followerMorphCoefficients: AnatomyFitFollowerMorphCoefficient[];
  metrics: AnatomyFitMetric[];
};

export type AnatomyFitResolvedParameter = {
  id: string;
  value: number;
  lower: number;
  upper: number;
  neutral: number;
};

export type AnatomyFitMetricUnit =
  | "meters"
  | "radians"
  | "ratio"
  | "score"
  | "count";

export type AnatomyFitMetric = {
  id: string;
  value: number;
  unit: AnatomyFitMetricUnit;
  minimum: number | null;
  maximum: number | null;
  passed: boolean;
};

export type AnatomyFitDiagnostic = {
  code: string;
  message: string;
};

export type AnatomyFitConvergence = {
  converged: boolean;
  iterations: number;
  objective: number;
  tolerance: number;
  reason: string;
};

export type AnatomyFitResult = {
  contract: typeof ANATOMY_FIT_RESULT_CONTRACT;
  solverVersion: string;
  domain: string;
  inputSha256: string;
  status: "converged" | "failed";
  convergence: AnatomyFitConvergence;
  resolvedParameters: AnatomyFitResolvedParameter[];
  nodeTransforms: AnatomyFitNodeTransform[];
  followerMorphCoefficients: AnatomyFitFollowerMorphCoefficient[];
  metrics: AnatomyFitMetric[];
  diagnostics: AnatomyFitDiagnostic[];
  resultSha256: string;
};

export type AnatomyFitState = {
  contract: typeof ANATOMY_FIT_STATE_CONTRACT;
  definitionSha256: string;
  fits: AnatomyFitStateEntry[];
  stateSha256: string;
};

export type AnatomyFitStateEntry = {
  input: AnatomyFitInput;
  result: AnatomyFitResult;
};

type AnatomyFitInputPayload = Omit<AnatomyFitInput, "inputSha256">;
type AnatomyFitResultPayload = Omit<AnatomyFitResult, "resultSha256">;
type AnatomyFitStatePayload = Omit<AnatomyFitState, "stateSha256">;

function fail(context: string, reason: string): never {
  throw new Error(`[${context}] ${reason}`);
}

function record(value: unknown, context: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(context, "must be an object");
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  context: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    fail(context, `must contain exactly: ${expected.join(", ")}`);
  }
}

function stableId(value: unknown, context: string): string {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    !STABLE_ID_PATTERN.test(value)
  ) {
    fail(context, "must be a stable id");
  }
  return value;
}

function versionedContract(value: unknown, context: string): string {
  if (typeof value !== "string" || !VERSIONED_CONTRACT_PATTERN.test(value)) {
    fail(context, "must be a versioned contract id");
  }
  return value;
}

function finite(value: unknown, context: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(context, "must be finite");
  }
  // RedisJSON stores numbers as IEEE-754 doubles but may emit an adjacent
  // shortest decimal for inputs that use all 16-17 significant digits. Anatomy
  // Fit hashes every persisted solver number, so normalize beyond the solver's
  // required precision before hashing. Fifteen significant digits are stable
  // across the browser/Node/RedisJSON round trip while remaining substantially
  // finer than any declared Anatomy Fit tolerance.
  const normalized = Number(
    value.toPrecision(STORAGE_STABLE_SIGNIFICANT_DIGITS),
  );
  return Object.is(normalized, -0) ? 0 : normalized;
}

function nonNegativeInteger(value: unknown, context: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    fail(context, "must be a non-negative safe integer");
  }
  return value as number;
}

function positiveInteger(value: unknown, context: string): number {
  const parsed = nonNegativeInteger(value, context);
  if (parsed === 0) fail(context, "must be positive");
  return parsed;
}

function sortedUnique<T>(
  rows: T[],
  key: (row: T) => string,
  context: string,
): T[] {
  const ids = rows.map(key);
  const expected = [...ids].sort((left, right) => left.localeCompare(right));
  if (ids.some((id, index) => id !== expected[index])) {
    fail(context, "must be sorted by stable id");
  }
  const duplicate = ids.find((id, index) => index > 0 && id === ids[index - 1]);
  if (duplicate) fail(context, `duplicates ${duplicate}`);
  return rows;
}

function sortById<T>(rows: readonly T[], key: (row: T) => string): T[] {
  return [...rows].sort((left, right) => key(left).localeCompare(key(right)));
}

function parseSource(value: unknown): AnatomyFitSourceIdentity {
  const raw = record(value, "anatomy-fit-input.source");
  exactKeys(
    raw,
    [
      "modelSha256",
      "appearanceDefinitionSha256",
      "topologySha256",
      "positionsSha256",
      "positionsScalarCount",
      "physicalEvaluationSha256",
      "physicalEvaluationScalarCount",
      "landmarkSetSha256",
      "landmarkSampleCount",
    ],
    "anatomy-fit-input.source",
  );
  return {
    modelSha256: requireLowercaseSha256(
      raw.modelSha256,
      "anatomy-fit-input.source.modelSha256",
    ),
    appearanceDefinitionSha256: requireLowercaseSha256(
      raw.appearanceDefinitionSha256,
      "anatomy-fit-input.source.appearanceDefinitionSha256",
    ),
    topologySha256: requireLowercaseSha256(
      raw.topologySha256,
      "anatomy-fit-input.source.topologySha256",
    ),
    positionsSha256: requireLowercaseSha256(
      raw.positionsSha256,
      "anatomy-fit-input.source.positionsSha256",
    ),
    positionsScalarCount: positiveInteger(
      raw.positionsScalarCount,
      "anatomy-fit-input.source.positionsScalarCount",
    ),
    physicalEvaluationSha256: requireLowercaseSha256(
      raw.physicalEvaluationSha256,
      "anatomy-fit-input.source.physicalEvaluationSha256",
    ),
    physicalEvaluationScalarCount: positiveInteger(
      raw.physicalEvaluationScalarCount,
      "anatomy-fit-input.source.physicalEvaluationScalarCount",
    ),
    landmarkSetSha256: requireLowercaseSha256(
      raw.landmarkSetSha256,
      "anatomy-fit-input.source.landmarkSetSha256",
    ),
    landmarkSampleCount: positiveInteger(
      raw.landmarkSampleCount,
      "anatomy-fit-input.source.landmarkSampleCount",
    ),
  };
}

function parseRelevantInputs(value: unknown): AnatomyFitRelevantInput[] {
  if (!Array.isArray(value) || value.length === 0) {
    fail("anatomy-fit-input.relevantInputs", "must be a non-empty array");
  }
  return sortedUnique(
    value.map((entry, index) => {
      const raw = record(entry, `anatomy-fit-input.relevantInputs[${index}]`);
      exactKeys(raw, ["id", "value"], `anatomy-fit-input.relevantInputs[${index}]`);
      return {
        id: stableId(raw.id, `anatomy-fit-input.relevantInputs[${index}].id`),
        value: finite(raw.value, `anatomy-fit-input.relevantInputs[${index}].value`),
      };
    }),
    (entry) => entry.id,
    "anatomy-fit-input.relevantInputs",
  );
}

function parseParameters(value: unknown): AnatomyFitParameter[] {
  if (!Array.isArray(value)) {
    fail("anatomy-fit-input.parameters", "must be an array");
  }
  return sortedUnique(
    value.map((entry, index) => {
      const context = `anatomy-fit-input.parameters[${index}]`;
      const raw = record(entry, context);
      exactKeys(
        raw,
        [
          "id",
          "lower",
          "upper",
          "neutral",
          "regularizationWeight",
          "initialStep",
          "minimumStep",
        ],
        context,
      );
      const lower = finite(raw.lower, `${context}.lower`);
      const upper = finite(raw.upper, `${context}.upper`);
      const neutral = finite(raw.neutral, `${context}.neutral`);
      const regularizationWeight = finite(
        raw.regularizationWeight,
        `${context}.regularizationWeight`,
      );
      const initialStep = finite(raw.initialStep, `${context}.initialStep`);
      const minimumStep = finite(raw.minimumStep, `${context}.minimumStep`);
      if (lower >= upper) fail(context, "lower must be less than upper");
      if (neutral < lower || neutral > upper) {
        fail(context, "neutral must be inside the declared bounds");
      }
      if (regularizationWeight < 0) {
        fail(context, "regularizationWeight must be non-negative");
      }
      if (initialStep <= 0 || initialStep > upper - lower) {
        fail(context, "initialStep must be positive and no larger than the parameter span");
      }
      if (minimumStep <= 0 || minimumStep > initialStep) {
        fail(context, "minimumStep must be positive and no larger than initialStep");
      }
      return {
        id: stableId(raw.id, `${context}.id`),
        lower,
        upper,
        neutral,
        regularizationWeight,
        initialStep,
        minimumStep,
      };
    }),
    (entry) => entry.id,
    "anatomy-fit-input.parameters",
  );
}

function parseInputPayload(value: unknown): AnatomyFitInputPayload {
  const raw = record(value, ANATOMY_FIT_INPUT_CONTRACT);
  exactKeys(
    raw,
    ["contract", "solverVersion", "domain", "source", "relevantInputs", "parameters"],
    ANATOMY_FIT_INPUT_CONTRACT,
  );
  if (raw.contract !== ANATOMY_FIT_INPUT_CONTRACT) {
    fail(ANATOMY_FIT_INPUT_CONTRACT, "contract is unsupported");
  }
  const solverVersion = versionedContract(
    raw.solverVersion,
    "anatomy-fit-input.solverVersion",
  );
  const domain = stableId(raw.domain, "anatomy-fit-input.domain");
  const parameters = parseParameters(raw.parameters);
  if (solverVersion === SOCKET_EYE_ANATOMY_FIT_SOLVER) {
    if (domain !== "socket-eye:left" && domain !== "socket-eye:right") {
      fail(ANATOMY_FIT_INPUT_CONTRACT, "domain must be socket-eye:left or socket-eye:right");
    }
    if (parameters.length !== 0) {
      fail(ANATOMY_FIT_INPUT_CONTRACT, "socket-eye verification cannot declare local fit parameters");
    }
  }
  if (solverVersion === ORAL_CAVITY_ANATOMY_FIT_SOLVER) {
    if (domain !== "oral-cavity") {
      fail(ANATOMY_FIT_INPUT_CONTRACT, "domain must be oral-cavity");
    }
    if (parameters.length !== 0) {
      fail(
        ANATOMY_FIT_INPUT_CONTRACT,
        "oral-cavity closed-form fitting cannot declare iterative parameters",
      );
    }
  }
  return {
    contract: ANATOMY_FIT_INPUT_CONTRACT,
    solverVersion,
    domain,
    source: parseSource(raw.source),
    relevantInputs: parseRelevantInputs(raw.relevantInputs),
    parameters,
  };
}

export async function createAnatomyFitInput(
  value: Omit<AnatomyFitInputPayload, "contract">,
): Promise<AnatomyFitInput> {
  const payload = parseInputPayload({
    contract: ANATOMY_FIT_INPUT_CONTRACT,
    ...value,
    relevantInputs: sortById(value.relevantInputs, (entry) => entry.id),
    parameters: sortById(value.parameters, (entry) => entry.id),
  });
  return {
    ...payload,
    inputSha256: await canonicalRecipeSha256(payload),
  };
}

export async function parseAnatomyFitInput(value: unknown): Promise<AnatomyFitInput> {
  const raw = record(value, ANATOMY_FIT_INPUT_CONTRACT);
  exactKeys(
    raw,
    [
      "contract",
      "solverVersion",
      "domain",
      "source",
      "relevantInputs",
      "parameters",
      "inputSha256",
    ],
    ANATOMY_FIT_INPUT_CONTRACT,
  );
  const { inputSha256: claimed, ...payloadValue } = raw;
  const payload = parseInputPayload(payloadValue);
  const inputSha256 = requireLowercaseSha256(
    claimed,
    "anatomy-fit-input.inputSha256",
  );
  const expected = await canonicalRecipeSha256(payload);
  if (inputSha256 !== expected) {
    fail(ANATOMY_FIT_INPUT_CONTRACT, "inputSha256 does not match canonical content");
  }
  return { ...payload, inputSha256 };
}

function parseNodeTransforms(value: unknown): AnatomyFitNodeTransform[] {
  if (!Array.isArray(value)) fail("anatomy-fit-result.nodeTransforms", "must be an array");
  return sortedUnique(
    value.map((entry, index) => {
      const context = `anatomy-fit-result.nodeTransforms[${index}]`;
      const raw = record(entry, context);
      exactKeys(raw, ["nodeId", "rootDeltaMatrix"], context);
      if (!Array.isArray(raw.rootDeltaMatrix) || raw.rootDeltaMatrix.length !== 16) {
        fail(`${context}.rootDeltaMatrix`, "must contain exactly 16 numbers");
      }
      const rootDeltaMatrix = raw.rootDeltaMatrix.map((entry, matrixIndex) =>
        finite(entry, `${context}.rootDeltaMatrix[${matrixIndex}]`),
      );
      const determinant =
        rootDeltaMatrix[0]! *
          (rootDeltaMatrix[5]! * rootDeltaMatrix[10]! -
            rootDeltaMatrix[6]! * rootDeltaMatrix[9]!) -
        rootDeltaMatrix[4]! *
          (rootDeltaMatrix[1]! * rootDeltaMatrix[10]! -
            rootDeltaMatrix[2]! * rootDeltaMatrix[9]!) +
        rootDeltaMatrix[8]! *
          (rootDeltaMatrix[1]! * rootDeltaMatrix[6]! -
            rootDeltaMatrix[2]! * rootDeltaMatrix[5]!);
      if (Math.abs(determinant) <= 1e-12) {
        fail(`${context}.rootDeltaMatrix`, "must have an invertible affine basis");
      }
      if (
        Math.abs(rootDeltaMatrix[3]!) > 1e-9 ||
        Math.abs(rootDeltaMatrix[7]!) > 1e-9 ||
        Math.abs(rootDeltaMatrix[11]!) > 1e-9 ||
        Math.abs(rootDeltaMatrix[15]! - 1) > 1e-9
      ) {
        fail(`${context}.rootDeltaMatrix`, "must be an affine column-major matrix");
      }
      return {
        nodeId: stableId(raw.nodeId, `${context}.nodeId`),
        rootDeltaMatrix,
      };
    }),
    (entry) => entry.nodeId,
    "anatomy-fit-result.nodeTransforms",
  );
}

function parseResolvedParameters(value: unknown): AnatomyFitResolvedParameter[] {
  if (!Array.isArray(value)) {
    fail("anatomy-fit-result.resolvedParameters", "must be an array");
  }
  return sortedUnique(
    value.map((entry, index) => {
      const context = `anatomy-fit-result.resolvedParameters[${index}]`;
      const raw = record(entry, context);
      exactKeys(raw, ["id", "value", "lower", "upper", "neutral"], context);
      const lower = finite(raw.lower, `${context}.lower`);
      const upper = finite(raw.upper, `${context}.upper`);
      const neutral = finite(raw.neutral, `${context}.neutral`);
      const resolvedValue = finite(raw.value, `${context}.value`);
      if (lower >= upper) fail(context, "lower must be less than upper");
      if (neutral < lower || neutral > upper) {
        fail(context, "neutral must be inside the declared bounds");
      }
      if (resolvedValue < lower || resolvedValue > upper) {
        fail(context, "value must be inside the declared bounds");
      }
      return {
        id: stableId(raw.id, `${context}.id`),
        value: resolvedValue,
        lower,
        upper,
        neutral,
      };
    }),
    (entry) => entry.id,
    "anatomy-fit-result.resolvedParameters",
  );
}

function morphKey(value: AnatomyFitFollowerMorphCoefficient): string {
  return `${value.followerId}:${value.channelId}`;
}

function parseMorphCoefficients(value: unknown): AnatomyFitFollowerMorphCoefficient[] {
  if (!Array.isArray(value)) {
    fail("anatomy-fit-result.followerMorphCoefficients", "must be an array");
  }
  return sortedUnique(
    value.map((entry, index) => {
      const context = `anatomy-fit-result.followerMorphCoefficients[${index}]`;
      const raw = record(entry, context);
      exactKeys(
        raw,
        ["followerId", "channelId", "nodeId", "morph", "weight", "lower", "upper"],
        context,
      );
      const lower = finite(raw.lower, `${context}.lower`);
      const upper = finite(raw.upper, `${context}.upper`);
      const weight = finite(raw.weight, `${context}.weight`);
      if (lower >= upper) fail(context, "lower must be less than upper");
      if (weight < lower || weight > upper) {
        fail(context, "weight must be inside the declared bounds");
      }
      return {
        followerId: stableId(raw.followerId, `${context}.followerId`),
        channelId: stableId(raw.channelId, `${context}.channelId`),
        nodeId: stableId(raw.nodeId, `${context}.nodeId`),
        morph: stableId(raw.morph, `${context}.morph`),
        weight,
        lower,
        upper,
      };
    }),
    morphKey,
    "anatomy-fit-result.followerMorphCoefficients",
  );
}

const METRIC_UNITS = new Set<AnatomyFitMetricUnit>([
  "meters",
  "radians",
  "ratio",
  "score",
  "count",
]);

function nullableFinite(value: unknown, context: string): number | null {
  return value === null ? null : finite(value, context);
}

function parseMetrics(value: unknown): AnatomyFitMetric[] {
  if (!Array.isArray(value)) fail("anatomy-fit-result.metrics", "must be an array");
  return sortedUnique(
    value.map((entry, index) => {
      const context = `anatomy-fit-result.metrics[${index}]`;
      const raw = record(entry, context);
      exactKeys(raw, ["id", "value", "unit", "minimum", "maximum", "passed"], context);
      if (typeof raw.unit !== "string" || !METRIC_UNITS.has(raw.unit as AnatomyFitMetricUnit)) {
        fail(`${context}.unit`, "is unsupported");
      }
      const minimum = nullableFinite(raw.minimum, `${context}.minimum`);
      const maximum = nullableFinite(raw.maximum, `${context}.maximum`);
      if (minimum !== null && maximum !== null && minimum > maximum) {
        fail(context, "minimum must not exceed maximum");
      }
      if (typeof raw.passed !== "boolean") fail(`${context}.passed`, "must be boolean");
      return {
        id: stableId(raw.id, `${context}.id`),
        value: finite(raw.value, `${context}.value`),
        unit: raw.unit as AnatomyFitMetricUnit,
        minimum,
        maximum,
        passed: raw.passed,
      };
    }),
    (entry) => entry.id,
    "anatomy-fit-result.metrics",
  );
}

/**
 * Canonicalize the reusable physical result at the same precision boundary as
 * persisted Anatomy Fit results. Browser, Node, and Redis may retain adjacent
 * double representations beyond the solver's declared precision; those bits
 * are not physical identity.
 */
export function normalizeAnatomyFitPhysicalOutput(
  value: AnatomyFitPhysicalOutput,
): AnatomyFitPhysicalOutput {
  return {
    nodeTransforms: parseNodeTransforms(value.nodeTransforms),
    followerMorphCoefficients: parseMorphCoefficients(
      value.followerMorphCoefficients,
    ),
    metrics: parseMetrics(value.metrics),
  };
}

function parseDiagnostics(value: unknown): AnatomyFitDiagnostic[] {
  if (!Array.isArray(value)) fail("anatomy-fit-result.diagnostics", "must be an array");
  return sortedUnique(
    value.map((entry, index) => {
      const context = `anatomy-fit-result.diagnostics[${index}]`;
      const raw = record(entry, context);
      exactKeys(raw, ["code", "message"], context);
      if (typeof raw.message !== "string" || raw.message.trim() !== raw.message || !raw.message) {
        fail(`${context}.message`, "must be a non-empty trimmed string");
      }
      return {
        code: stableId(raw.code, `${context}.code`),
        message: raw.message,
      };
    }),
    (entry) => entry.code,
    "anatomy-fit-result.diagnostics",
  );
}

function parseConvergence(value: unknown): AnatomyFitConvergence {
  const raw = record(value, "anatomy-fit-result.convergence");
  exactKeys(
    raw,
    ["converged", "iterations", "objective", "tolerance", "reason"],
    "anatomy-fit-result.convergence",
  );
  if (typeof raw.converged !== "boolean") {
    fail("anatomy-fit-result.convergence.converged", "must be boolean");
  }
  const tolerance = finite(raw.tolerance, "anatomy-fit-result.convergence.tolerance");
  if (tolerance < 0) fail("anatomy-fit-result.convergence.tolerance", "must be non-negative");
  return {
    converged: raw.converged,
    iterations: nonNegativeInteger(
      raw.iterations,
      "anatomy-fit-result.convergence.iterations",
    ),
    objective: finite(raw.objective, "anatomy-fit-result.convergence.objective"),
    tolerance,
    reason: stableId(raw.reason, "anatomy-fit-result.convergence.reason"),
  };
}

function parseResultPayload(value: unknown): AnatomyFitResultPayload {
  const raw = record(value, ANATOMY_FIT_RESULT_CONTRACT);
  exactKeys(
    raw,
    [
      "contract",
      "solverVersion",
      "domain",
      "inputSha256",
      "status",
      "convergence",
      "resolvedParameters",
      "nodeTransforms",
      "followerMorphCoefficients",
      "metrics",
      "diagnostics",
    ],
    ANATOMY_FIT_RESULT_CONTRACT,
  );
  if (raw.contract !== ANATOMY_FIT_RESULT_CONTRACT) {
    fail(ANATOMY_FIT_RESULT_CONTRACT, "contract is unsupported");
  }
  if (raw.status !== "converged" && raw.status !== "failed") {
    fail("anatomy-fit-result.status", "must be converged or failed");
  }
  const convergence = parseConvergence(raw.convergence);
  const resolvedParameters = parseResolvedParameters(raw.resolvedParameters);
  const {
    nodeTransforms,
    followerMorphCoefficients,
    metrics,
  } = normalizeAnatomyFitPhysicalOutput({
    nodeTransforms: raw.nodeTransforms as AnatomyFitNodeTransform[],
    followerMorphCoefficients:
      raw.followerMorphCoefficients as AnatomyFitFollowerMorphCoefficient[],
    metrics: raw.metrics as AnatomyFitMetric[],
  });
  const diagnostics = parseDiagnostics(raw.diagnostics);
  if (raw.solverVersion === SOCKET_EYE_ANATOMY_FIT_SOLVER) {
    if (raw.domain !== "socket-eye:left" && raw.domain !== "socket-eye:right") {
      fail(ANATOMY_FIT_RESULT_CONTRACT, "domain must be socket-eye:left or socket-eye:right");
    }
    if (
      resolvedParameters.length > 0 ||
      nodeTransforms.length > 0 ||
      followerMorphCoefficients.length > 0
    ) {
      fail(
        ANATOMY_FIT_RESULT_CONTRACT,
        "socket-eye verification cannot emit local parameters, node transforms, or morph coefficients",
      );
    }
  }
  if (raw.solverVersion === ORAL_CAVITY_ANATOMY_FIT_SOLVER) {
    if (raw.domain !== "oral-cavity") {
      fail(ANATOMY_FIT_RESULT_CONTRACT, "domain must be oral-cavity");
    }
    if (resolvedParameters.length > 0) {
      fail(
        ANATOMY_FIT_RESULT_CONTRACT,
        "oral-cavity closed-form fitting cannot emit iterative parameters",
      );
    }
  }
  if (raw.status === "converged") {
    if (!convergence.converged) fail(ANATOMY_FIT_RESULT_CONTRACT, "converged status requires convergence");
    if (metrics.some((metric) => !metric.passed)) {
      fail(ANATOMY_FIT_RESULT_CONTRACT, "converged results cannot retain failed metrics");
    }
    if (diagnostics.length > 0) {
      fail(ANATOMY_FIT_RESULT_CONTRACT, "converged results cannot retain failure diagnostics");
    }
  } else {
    if (convergence.converged) fail(ANATOMY_FIT_RESULT_CONTRACT, "failed status cannot claim convergence");
    if (
      resolvedParameters.length > 0 ||
      nodeTransforms.length > 0 ||
      followerMorphCoefficients.length > 0
    ) {
      fail(ANATOMY_FIT_RESULT_CONTRACT, "failed results cannot expose reusable fit outputs");
    }
    if (diagnostics.length === 0) {
      fail(ANATOMY_FIT_RESULT_CONTRACT, "failed results require explicit diagnostics");
    }
  }
  return {
    contract: ANATOMY_FIT_RESULT_CONTRACT,
    solverVersion: versionedContract(
      raw.solverVersion,
      "anatomy-fit-result.solverVersion",
    ),
    domain: stableId(raw.domain, "anatomy-fit-result.domain"),
    inputSha256: requireLowercaseSha256(
      raw.inputSha256,
      "anatomy-fit-result.inputSha256",
    ),
    status: raw.status,
    convergence,
    resolvedParameters,
    nodeTransforms,
    followerMorphCoefficients,
    metrics,
    diagnostics,
  };
}

export async function createAnatomyFitResult(
  value: Omit<AnatomyFitResultPayload, "contract">,
): Promise<AnatomyFitResult> {
  const payload = parseResultPayload({
    contract: ANATOMY_FIT_RESULT_CONTRACT,
    ...value,
    resolvedParameters: sortById(value.resolvedParameters, (entry) => entry.id),
    nodeTransforms: sortById(value.nodeTransforms, (entry) => entry.nodeId),
    followerMorphCoefficients: sortById(value.followerMorphCoefficients, morphKey),
    metrics: sortById(value.metrics, (entry) => entry.id),
    diagnostics: sortById(value.diagnostics, (entry) => entry.code),
  });
  return {
    ...payload,
    resultSha256: await canonicalRecipeSha256(payload),
  };
}

export async function parseAnatomyFitResult(value: unknown): Promise<AnatomyFitResult> {
  const raw = record(value, ANATOMY_FIT_RESULT_CONTRACT);
  exactKeys(
    raw,
    [
      "contract",
      "solverVersion",
      "domain",
      "inputSha256",
      "status",
      "convergence",
      "resolvedParameters",
      "nodeTransforms",
      "followerMorphCoefficients",
      "metrics",
      "diagnostics",
      "resultSha256",
    ],
    ANATOMY_FIT_RESULT_CONTRACT,
  );
  const { resultSha256: claimed, ...payloadValue } = raw;
  const payload = parseResultPayload(payloadValue);
  const resultSha256 = requireLowercaseSha256(
    claimed,
    "anatomy-fit-result.resultSha256",
  );
  const expected = await canonicalRecipeSha256(payload);
  if (resultSha256 !== expected) {
    fail(ANATOMY_FIT_RESULT_CONTRACT, "resultSha256 does not match canonical content");
  }
  return { ...payload, resultSha256 };
}

export async function requireReusableAnatomyFitResult(
  inputValue: unknown,
  resultValue: unknown,
): Promise<AnatomyFitResult> {
  const input = await parseAnatomyFitInput(inputValue);
  const result = await parseAnatomyFitResult(resultValue);
  if (
    result.inputSha256 !== input.inputSha256 ||
    result.solverVersion !== input.solverVersion ||
    result.domain !== input.domain
  ) {
    fail(ANATOMY_FIT_RESULT_CONTRACT, "result is stale for the current fit input");
  }
  if (result.status !== "converged") {
    const diagnostic = result.diagnostics.map((entry) => `${entry.code}: ${entry.message}`).join("; ");
    fail(ANATOMY_FIT_RESULT_CONTRACT, `fit failed and cannot be reused (${diagnostic})`);
  }
  if (result.resolvedParameters.length !== input.parameters.length) {
    fail(ANATOMY_FIT_RESULT_CONTRACT, "resolved parameter inventory does not match the fit input");
  }
  result.resolvedParameters.forEach((resolved, index) => {
    const declared = input.parameters[index]!;
    if (
      resolved.id !== declared.id ||
      resolved.lower !== declared.lower ||
      resolved.upper !== declared.upper ||
      resolved.neutral !== declared.neutral
    ) {
      fail(
        ANATOMY_FIT_RESULT_CONTRACT,
        `resolved parameter ${resolved.id} changed its input identity or bounds`,
      );
    }
  });
  return result;
}

export function selectRelevantAnatomyFitInputs(
  values: Readonly<Record<string, number>>,
  relevantIds: readonly string[],
): AnatomyFitRelevantInput[] {
  const ids = [...relevantIds].sort((left, right) => left.localeCompare(right));
  const duplicate = ids.find((id, index) => index > 0 && id === ids[index - 1]);
  if (duplicate) fail(ANATOMY_FIT_INPUT_CONTRACT, `relevant input ids duplicate ${duplicate}`);
  return ids.map((id) => {
    stableId(id, "anatomy-fit relevant input id");
    if (!Object.hasOwn(values, id)) {
      fail(ANATOMY_FIT_INPUT_CONTRACT, `relevant input ${id} is missing`);
    }
    return { id, value: finite(values[id], `anatomy-fit relevant input ${id}`) };
  });
}

export async function assertAnatomyFitFollowerCompatibility(
  inputValue: unknown,
  resultValue: unknown,
  appearance: AppearanceDialsManifest,
): Promise<AnatomyFitResult> {
  const input = await parseAnatomyFitInput(inputValue);
  const result = await requireReusableAnatomyFitResult(input, resultValue);
  if (input.source.appearanceDefinitionSha256 !== appearance.definitionSha256) {
    fail(ANATOMY_FIT_RESULT_CONTRACT, "fit input targets a different Appearance Dials definition");
  }
  if (input.solverVersion === SOCKET_EYE_ANATOMY_FIT_SOLVER) {
    if (
      result.nodeTransforms.length !== 0 ||
      result.followerMorphCoefficients.length !== 0 ||
      result.resolvedParameters.length !== 0
    ) {
      fail(
        ANATOMY_FIT_RESULT_CONTRACT,
        "socket-eye verification retained globe-era localized output",
      );
    }
  } else if (
    input.solverVersion !== ORAL_CAVITY_ANATOMY_FIT_SOLVER &&
    (result.nodeTransforms.length !== 0 ||
      result.followerMorphCoefficients.length !== 0 ||
      result.resolvedParameters.length !== 0)
  ) {
    fail(
      ANATOMY_FIT_RESULT_CONTRACT,
      "unsupported Anatomy Fit solver retained globe-era localized output",
    );
  }
  const followerNodes = new Set<string>();
  for (const follower of Object.values(appearance.followers)) {
    for (const nodeId of follower.nodeIds) followerNodes.add(nodeId);
  }
  for (const transform of result.nodeTransforms) {
    if (!appearance.nodes[transform.nodeId] || !followerNodes.has(transform.nodeId)) {
      fail(
        ANATOMY_FIT_RESULT_CONTRACT,
        `node transform ${transform.nodeId} is not a declared appearance follower node`,
      );
    }
  }
  for (const coefficient of result.followerMorphCoefficients) {
    const follower = appearance.followers[coefficient.followerId];
    const matches = follower?.drivers.flatMap((driver) => driver.channels).filter(
      (channel) =>
        channel.id === coefficient.channelId &&
        channel.kind === "morph-weight" &&
        channel.node === coefficient.nodeId &&
        channel.morph === coefficient.morph,
    ) ?? [];
    if (matches.length !== 1 || matches[0]?.kind !== "morph-weight") {
      fail(
        ANATOMY_FIT_RESULT_CONTRACT,
        `morph coefficient ${morphKey(coefficient)} does not bind one exact appearance-followers/v2 channel`,
      );
    }
    if (
      Math.abs(matches[0].weightRange[0] - coefficient.lower) > BOUND_TOLERANCE ||
      Math.abs(matches[0].weightRange[1] - coefficient.upper) > BOUND_TOLERANCE
    ) {
      fail(
        ANATOMY_FIT_RESULT_CONTRACT,
        `morph coefficient ${morphKey(coefficient)} changed its declared bounds`,
      );
    }
  }
  return result;
}

function parseStatePayload(value: unknown): AnatomyFitStatePayload {
  const raw = record(value, ANATOMY_FIT_STATE_CONTRACT);
  exactKeys(raw, ["contract", "definitionSha256", "fits"], ANATOMY_FIT_STATE_CONTRACT);
  if (raw.contract !== ANATOMY_FIT_STATE_CONTRACT) {
    fail(ANATOMY_FIT_STATE_CONTRACT, "contract is unsupported");
  }
  if (!Array.isArray(raw.fits)) fail("anatomy-fit-state.fits", "must be an array");
  return {
    contract: ANATOMY_FIT_STATE_CONTRACT,
    definitionSha256: requireLowercaseSha256(
      raw.definitionSha256,
      "anatomy-fit-state.definitionSha256",
    ),
    fits: raw.fits as AnatomyFitStateEntry[],
  };
}

export async function createAnatomyFitState(
  definitionSha256: string,
  fitValues: ReadonlyArray<{ input: unknown; result: unknown }>,
): Promise<AnatomyFitState> {
  const fits = await Promise.all(
    fitValues.map(async (entry, index) => {
      const raw = record(entry, `anatomy-fit-state.fits[${index}]`);
      exactKeys(raw, ["input", "result"], `anatomy-fit-state.fits[${index}]`);
      const input = await parseAnatomyFitInput(raw.input);
      const result = await requireReusableAnatomyFitResult(input, raw.result);
      return { input, result };
    }),
  );
  const sorted = sortById(fits, (entry) => entry.result.domain);
  sortedUnique(
    sorted,
    (entry) => entry.result.domain,
    "anatomy-fit-state.fits",
  );
  const payload: AnatomyFitStatePayload = {
    contract: ANATOMY_FIT_STATE_CONTRACT,
    definitionSha256: requireLowercaseSha256(
      definitionSha256,
      "anatomy-fit-state.definitionSha256",
    ),
    fits: sorted,
  };
  return { ...payload, stateSha256: await canonicalRecipeSha256(payload) };
}

export async function parseAnatomyFitState(value: unknown): Promise<AnatomyFitState> {
  const raw = record(value, ANATOMY_FIT_STATE_CONTRACT);
  exactKeys(
    raw,
    ["contract", "definitionSha256", "fits", "stateSha256"],
    ANATOMY_FIT_STATE_CONTRACT,
  );
  const { stateSha256: claimed, ...payloadValue } = raw;
  const payload = parseStatePayload(payloadValue);
  const fits = await Promise.all(
    payload.fits.map(async (entry, index) => {
      const raw = record(entry, `anatomy-fit-state.fits[${index}]`);
      exactKeys(raw, ["input", "result"], `anatomy-fit-state.fits[${index}]`);
      const input = await parseAnatomyFitInput(raw.input);
      const result = await requireReusableAnatomyFitResult(input, raw.result);
      return { input, result };
    }),
  );
  sortedUnique(
    fits,
    (entry) => entry.result.domain,
    "anatomy-fit-state.fits",
  );
  const normalizedPayload: AnatomyFitStatePayload = { ...payload, fits };
  const stateSha256 = requireLowercaseSha256(
    claimed,
    "anatomy-fit-state.stateSha256",
  );
  const expected = await canonicalRecipeSha256(normalizedPayload);
  if (stateSha256 !== expected) {
    fail(ANATOMY_FIT_STATE_CONTRACT, "stateSha256 does not match canonical content");
  }
  return { ...normalizedPayload, stateSha256 };
}

export async function anatomyFitRecipeSibling(stateValue: unknown) {
  const state = await parseAnatomyFitState(stateValue);
  return {
    id: ANATOMY_FIT_RECIPE_SIBLING_ID,
    contract: ANATOMY_FIT_STATE_CONTRACT,
    definitionSha256: state.definitionSha256,
    // Recipe sibling hashes bind the complete state object. The inner
    // stateSha256 separately proves the content excluding its self-hash.
    stateSha256: await canonicalRecipeSha256(state),
    state,
  };
}

function managedAnatomyFitSibling(
  state: RecipeStateSnapshot,
): RecipeSiblingStateRecord | null {
  const candidates = state.siblings.filter(
    (entry) =>
      entry.id === ANATOMY_FIT_RECIPE_SIBLING_ID ||
      entry.contract === ANATOMY_FIT_STATE_CONTRACT,
  );
  if (candidates.length > 1) {
    fail(ANATOMY_FIT_STATE_CONTRACT, "Recipe State contains ambiguous Anatomy Fit siblings");
  }
  const candidate = candidates[0] ?? null;
  if (
    candidate &&
    (candidate.id !== ANATOMY_FIT_RECIPE_SIBLING_ID ||
      candidate.contract !== ANATOMY_FIT_STATE_CONTRACT)
  ) {
    fail(ANATOMY_FIT_STATE_CONTRACT, "Recipe sibling identity is ambiguous");
  }
  return candidate;
}

/** Return the one exact managed Anatomy Fit sibling from a verified Recipe State. */
export async function getAnatomyFitRecipeSibling(
  stateValue: unknown,
): Promise<RecipeSiblingStateRecord | null> {
  const state = await verifyRecipeStateSnapshot(stateValue);
  const sibling = managedAnatomyFitSibling(state);
  if (!sibling) return null;
  const parsed = await parseAnatomyFitState(sibling.state);
  const normalized = await anatomyFitRecipeSibling(parsed);
  if (
    sibling.definitionSha256 !== normalized.definitionSha256 ||
    sibling.stateSha256 !== normalized.stateSha256
  ) {
    fail(ANATOMY_FIT_STATE_CONTRACT, "Recipe sibling hashes do not match its exact Anatomy Fit state");
  }
  return structuredClone(sibling);
}

/**
 * Remove deterministic Anatomy Fit output from migration-review state.
 *
 * Package migration owns user-authored sibling surfaces. Anatomy Fit is
 * derived from the verified target package and reviewed appearance values,
 * so carrying an old fit through that migration would authorize stale output.
 */
export async function withoutAnatomyFitRecipeSibling(
  stateValue: unknown,
): Promise<RecipeStateSnapshot> {
  const state = await verifyRecipeStateSnapshot(stateValue);
  const sibling = managedAnatomyFitSibling(state);
  if (!sibling) return state;
  await getAnatomyFitRecipeSibling(state);
  const next: RecipeStateSnapshot = {
    ...structuredClone(state),
    stateSha256: "0".repeat(64),
    siblings: state.siblings.filter((entry) => entry.id !== sibling.id),
  };
  next.stateSha256 = await recipeStateSnapshotSha256(next);
  return verifyRecipeStateSnapshot(next);
}

/** Replace the managed sibling from one verified Anatomy Fit state payload. */
export async function replaceAnatomyFitRecipeSibling(
  stateValue: unknown,
  anatomyFitStateValue: unknown | null,
): Promise<RecipeStateSnapshot> {
  const state = await withoutAnatomyFitRecipeSibling(stateValue);
  const sibling = anatomyFitStateValue === null
    ? null
    : await anatomyFitRecipeSibling(anatomyFitStateValue);
  const next: RecipeStateSnapshot = {
    ...structuredClone(state),
    stateSha256: "0".repeat(64),
    siblings: [
      ...state.siblings,
      ...(sibling ? [sibling] : []),
    ].sort((left, right) => left.id.localeCompare(right.id)),
  };
  next.stateSha256 = await recipeStateSnapshotSha256(next);
  return verifyRecipeStateSnapshot(next);
}
