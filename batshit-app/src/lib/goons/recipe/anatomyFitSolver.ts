import type {
  AnatomyFitFollowerMorphCoefficient,
  AnatomyFitInput,
  AnatomyFitMetric,
  AnatomyFitMetricUnit,
  AnatomyFitNodeTransform,
  AnatomyFitParameter,
} from "./anatomyFitContracts";
import {
  createAnatomyFitResult,
  parseAnatomyFitInput,
} from "./anatomyFitContracts";

const STABLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

export type AnatomyFitPoint = [number, number, number];

export type AnatomyFitLandmarkBinding =
  | {
      id: string;
      kind: "vertex";
      vertexIndex: number;
    }
  | {
      id: string;
      kind: "triangle-barycentric";
      vertexIndices: [number, number, number];
      weights: [number, number, number];
    };

export type AnatomyFitLandmark = {
  id: string;
  position: AnatomyFitPoint;
};

export type AnatomyFitClearancePair = {
  id: string;
  surface: AnatomyFitPoint;
  internal: AnatomyFitPoint;
  inwardNormal: AnatomyFitPoint;
};

export type AnatomyFitMetricCandidate = Omit<AnatomyFitMetric, "passed">;

export type AnatomyFitEvaluation = {
  objective: number;
  nodeTransforms: AnatomyFitNodeTransform[];
  followerMorphCoefficients: AnatomyFitFollowerMorphCoefficient[];
  metrics: AnatomyFitMetricCandidate[];
};

export type AnatomyFitEvaluator = (
  parameters: Readonly<Record<string, number>>,
) => AnatomyFitEvaluation | Promise<AnatomyFitEvaluation>;

export type AnatomyFitSolverOptions = {
  maxIterations?: number;
  objectiveTolerance?: number;
  initialValues?: Readonly<Record<string, number>>;
};

export class AnatomyFitSolverError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "AnatomyFitSolverError";
    this.code = stableId(code, "Anatomy Fit diagnostic code");
  }
}

function fail(code: string, message: string): never {
  throw new AnatomyFitSolverError(code, message);
}

function stableId(value: unknown, context: string): string {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    !STABLE_ID_PATTERN.test(value)
  ) {
    throw new Error(`${context} must be a stable id.`);
  }
  return value;
}

function finite(value: unknown, context: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail("non-finite-value", `${context} must be finite.`);
  }
  return value;
}

function point(value: AnatomyFitPoint, context: string): AnatomyFitPoint {
  if (!Array.isArray(value) || value.length !== 3) {
    fail("invalid-point", `${context} must contain exactly three coordinates.`);
  }
  return [
    finite(value[0], `${context}[0]`),
    finite(value[1], `${context}[1]`),
    finite(value[2], `${context}[2]`),
  ];
}

function sortedUnique<T>(
  rows: readonly T[],
  key: (row: T) => string,
  context: string,
): T[] {
  const sorted = [...rows].sort((left, right) => key(left).localeCompare(key(right)));
  const duplicate = sorted.find(
    (row, index) => index > 0 && key(row) === key(sorted[index - 1]!),
  );
  if (duplicate) fail("duplicate-id", `${context} duplicates ${key(duplicate)}.`);
  return sorted;
}

function vertexPoint(
  positions: Float32Array,
  vertexIndex: number,
  context: string,
): AnatomyFitPoint {
  if (!Number.isSafeInteger(vertexIndex) || vertexIndex < 0) {
    fail("invalid-landmark", `${context} vertex index must be a non-negative safe integer.`);
  }
  const offset = vertexIndex * 3;
  if (offset + 2 >= positions.length) {
    fail("missing-landmark", `${context} references vertex ${vertexIndex} outside the composed mesh.`);
  }
  return [
    finite(positions[offset], `${context}.x`),
    finite(positions[offset + 1], `${context}.y`),
    finite(positions[offset + 2], `${context}.z`),
  ];
}

/**
 * Sample exact vertex or topology-stable barycentric landmarks from the final
 * composed POSITION payload. Domain specializations own which bindings matter.
 */
export function sampleAnatomyFitLandmarks(
  positions: Float32Array,
  bindings: readonly AnatomyFitLandmarkBinding[],
): AnatomyFitLandmark[] {
  if (!(positions instanceof Float32Array) || positions.length === 0 || positions.length % 3 !== 0) {
    fail("invalid-geometry", "Composed POSITION data must be a non-empty Float32Array of vec3 values.");
  }
  if (bindings.length === 0) fail("missing-landmark", "At least one landmark binding is required.");
  return sortedUnique(bindings, (binding) => binding.id, "Landmark bindings").map(
    (binding) => {
      stableId(binding.id, "Landmark id");
      if (binding.kind === "vertex") {
        return {
          id: binding.id,
          position: vertexPoint(positions, binding.vertexIndex, `Landmark ${binding.id}`),
        };
      }
      if (binding.kind !== "triangle-barycentric") {
        const unsupported = binding as unknown as { id?: unknown };
        fail(
          "invalid-landmark",
          `Landmark ${String(unsupported.id ?? "unknown")} has an unsupported binding kind.`,
        );
      }
      const weights = binding.weights.map((weight, index) =>
        finite(weight, `Landmark ${binding.id} weight ${index}`),
      ) as [number, number, number];
      if (weights.some((weight) => weight < 0) || Math.abs(weights.reduce((sum, weight) => sum + weight, 0) - 1) > 1e-6) {
        fail(
          "invalid-landmark",
          `Landmark ${binding.id} barycentric weights must be non-negative and sum to one.`,
        );
      }
      const vertices = binding.vertexIndices.map((vertexIndex) =>
        vertexPoint(positions, vertexIndex, `Landmark ${binding.id}`),
      ) as [AnatomyFitPoint, AnatomyFitPoint, AnatomyFitPoint];
      return {
        id: binding.id,
        position: [0, 1, 2].map((axis) =>
          vertices.reduce(
            (sum, vertex, index) => sum + vertex[axis]! * weights[index]!,
            0,
          ),
        ) as AnatomyFitPoint,
      };
    },
  );
}

/**
 * Positive clearance means the internal surface lies in the declared inward
 * direction from the visible skin/margin sample; penetration is negative.
 */
export function measureSignedAnatomyFitClearance(
  pairs: readonly AnatomyFitClearancePair[],
): Array<{ id: string; meters: number }> {
  if (pairs.length === 0) fail("missing-clearance-samples", "At least one clearance pair is required.");
  return sortedUnique(pairs, (pair) => pair.id, "Clearance pairs").map((pair) => {
    stableId(pair.id, "Clearance id");
    const surface = point(pair.surface, `Clearance ${pair.id} surface`);
    const internal = point(pair.internal, `Clearance ${pair.id} internal`);
    const normal = point(pair.inwardNormal, `Clearance ${pair.id} inward normal`);
    const length = Math.hypot(...normal);
    if (length <= 1e-12) {
      fail("invalid-clearance-normal", `Clearance ${pair.id} inward normal is degenerate.`);
    }
    const normalized = normal.map((value) => value / length) as AnatomyFitPoint;
    return {
      id: pair.id,
      meters:
        (internal[0] - surface[0]) * normalized[0] +
        (internal[1] - surface[1]) * normalized[1] +
        (internal[2] - surface[2]) * normalized[2],
    };
  });
}

function metricPasses(metric: AnatomyFitMetricCandidate): boolean {
  return (
    (metric.minimum === null || metric.value >= metric.minimum) &&
    (metric.maximum === null || metric.value <= metric.maximum)
  );
}

function validatedMetric(
  metric: AnatomyFitMetricCandidate,
  index: number,
): AnatomyFitMetric {
  stableId(metric.id, `Anatomy Fit metric ${index} id`);
  const value = finite(metric.value, `Anatomy Fit metric ${metric.id} value`);
  const minimum =
    metric.minimum === null
      ? null
      : finite(metric.minimum, `Anatomy Fit metric ${metric.id} minimum`);
  const maximum =
    metric.maximum === null
      ? null
      : finite(metric.maximum, `Anatomy Fit metric ${metric.id} maximum`);
  if (minimum !== null && maximum !== null && minimum > maximum) {
    fail("invalid-metric", `Anatomy Fit metric ${metric.id} has reversed bounds.`);
  }
  const units = new Set<AnatomyFitMetricUnit>([
    "meters",
    "radians",
    "ratio",
    "score",
    "count",
  ]);
  if (!units.has(metric.unit)) {
    fail("invalid-metric", `Anatomy Fit metric ${metric.id} has unsupported units.`);
  }
  return {
    id: metric.id,
    value,
    unit: metric.unit,
    minimum,
    maximum,
    passed: metricPasses({ ...metric, value, minimum, maximum }),
  };
}

function validateEvaluation(value: AnatomyFitEvaluation): Omit<AnatomyFitEvaluation, "metrics"> & {
  metrics: AnatomyFitMetric[];
} {
  if (value === null || typeof value !== "object") {
    fail("invalid-evaluation", "Anatomy Fit evaluator must return an object.");
  }
  const objective = finite(value.objective, "Anatomy Fit objective");
  if (objective < 0) fail("invalid-evaluation", "Anatomy Fit objective must be non-negative.");
  if (!Array.isArray(value.nodeTransforms) || !Array.isArray(value.followerMorphCoefficients) || !Array.isArray(value.metrics)) {
    fail("invalid-evaluation", "Anatomy Fit evaluator output arrays are missing.");
  }
  return {
    ...value,
    objective,
    metrics: sortedUnique(
      value.metrics.map(validatedMetric),
      (metric) => metric.id,
      "Anatomy Fit metrics",
    ),
  };
}

function parameterRecord(
  parameters: readonly AnatomyFitParameter[],
  values: ReadonlyMap<string, number>,
): Record<string, number> {
  return Object.fromEntries(parameters.map((parameter) => [parameter.id, values.get(parameter.id)!]));
}

function regularizationPenalty(
  parameters: readonly AnatomyFitParameter[],
  values: ReadonlyMap<string, number>,
): number {
  return parameters.reduce((sum, parameter) => {
    const normalized =
      (values.get(parameter.id)! - parameter.neutral) / (parameter.upper - parameter.lower);
    return sum + parameter.regularizationWeight * normalized * normalized;
  }, 0);
}

async function evaluateCandidate(
  parameters: readonly AnatomyFitParameter[],
  values: ReadonlyMap<string, number>,
  evaluator: AnatomyFitEvaluator,
) {
  const evaluation = validateEvaluation(await evaluator(parameterRecord(parameters, values)));
  return {
    evaluation,
    score: evaluation.objective + regularizationPenalty(parameters, values),
  };
}

function resolvedParameters(
  parameters: readonly AnatomyFitParameter[],
  values: ReadonlyMap<string, number>,
) {
  return parameters.map((parameter) => ({
    id: parameter.id,
    value: values.get(parameter.id)!,
    lower: parameter.lower,
    upper: parameter.upper,
    neutral: parameter.neutral,
  }));
}

function parameterDiagnostic(
  parameters: readonly AnatomyFitParameter[],
  values: ReadonlyMap<string, number>,
) {
  return parameters
    .map((parameter) => `${parameter.id}=${values.get(parameter.id)}`)
    .join(", ");
}

async function failedResult(
  input: AnatomyFitInput,
  reason: string,
  code: string,
  message: string,
  iterations: number,
  objective: number,
  tolerance: number,
  metrics: AnatomyFitMetric[] = [],
) {
  return createAnatomyFitResult({
    solverVersion: input.solverVersion,
    domain: input.domain,
    inputSha256: input.inputSha256,
    status: "failed",
    convergence: {
      converged: false,
      iterations,
      objective,
      tolerance,
      reason,
    },
    resolvedParameters: [],
    nodeTransforms: [],
    followerMorphCoefficients: [],
    metrics,
    diagnostics: [{ code, message }],
  });
}

/**
 * Deterministic bounded coordinate solver shared by Anatomy Fit domains.
 * Specializations supply only measurements/objective terms and final follower
 * outputs; this layer owns bounds, neutral regularization, convergence, and
 * explicit failure records.
 */
export async function solveBoundedAnatomyFit(
  inputValue: unknown,
  evaluator: AnatomyFitEvaluator,
  options: AnatomyFitSolverOptions = {},
) {
  const input = await parseAnatomyFitInput(inputValue);
  const maxIterations = options.maxIterations ?? 256;
  const objectiveTolerance = options.objectiveTolerance ?? 1e-12;
  if (!Number.isSafeInteger(maxIterations) || maxIterations < 1) {
    throw new Error("Anatomy Fit maxIterations must be a positive safe integer.");
  }
  if (!Number.isFinite(objectiveTolerance) || objectiveTolerance < 0) {
    throw new Error("Anatomy Fit objectiveTolerance must be a non-negative finite number.");
  }

  const parameters = input.parameters;
  const initialValues = options.initialValues ?? {};
  const parameterIds = new Set(parameters.map((parameter) => parameter.id));
  const unknownInitialIds = Object.keys(initialValues).filter(
    (id) => !parameterIds.has(id),
  );
  if (unknownInitialIds.length > 0) {
    throw new Error(
      `Anatomy Fit initial values reference unknown parameters: ${unknownInitialIds
        .sort()
        .join(", ")}.`,
    );
  }
  let values = new Map(
    parameters.map((parameter) => {
      const value = Object.prototype.hasOwnProperty.call(initialValues, parameter.id)
        ? initialValues[parameter.id]!
        : parameter.neutral;
      if (
        !Number.isFinite(value) ||
        value < parameter.lower ||
        value > parameter.upper
      ) {
        throw new Error(
          `Anatomy Fit initial value ${parameter.id} must be finite and within ` +
            `[${parameter.lower}, ${parameter.upper}].`,
        );
      }
      return [parameter.id, value] as const;
    }),
  );
  const steps = new Map(parameters.map((parameter) => [parameter.id, parameter.initialStep]));
  let current: Awaited<ReturnType<typeof evaluateCandidate>>;
  try {
    current = await evaluateCandidate(parameters, values, evaluator);
  } catch (error) {
    const diagnostic =
      error instanceof AnatomyFitSolverError
        ? error
        : new AnatomyFitSolverError(
            "evaluation-failed",
            error instanceof Error ? error.message : String(error),
          );
    return failedResult(
      input,
      "evaluation-error",
      diagnostic.code,
      diagnostic.message,
      0,
      0,
      objectiveTolerance,
    );
  }

  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    let improved = false;
    try {
      for (const parameter of parameters) {
        let best = current;
        let bestValues = values;
        for (const direction of [-1, 1] as const) {
          const candidateValue = Math.min(
            parameter.upper,
            Math.max(
              parameter.lower,
              values.get(parameter.id)! + direction * steps.get(parameter.id)!,
            ),
          );
          if (candidateValue === values.get(parameter.id)) continue;
          const candidateValues = new Map(values);
          candidateValues.set(parameter.id, candidateValue);
          const candidate = await evaluateCandidate(parameters, candidateValues, evaluator);
          if (candidate.score < best.score - objectiveTolerance) {
            best = candidate;
            bestValues = candidateValues;
          }
        }
        if (bestValues !== values) {
          values = bestValues;
          current = best;
          improved = true;
        }
      }
    } catch (error) {
      const diagnostic =
        error instanceof AnatomyFitSolverError
          ? error
          : new AnatomyFitSolverError(
              "evaluation-failed",
              error instanceof Error ? error.message : String(error),
            );
      return failedResult(
        input,
        "evaluation-error",
        diagnostic.code,
        diagnostic.message,
        iteration,
        current.score,
        objectiveTolerance,
        current.evaluation.metrics,
      );
    }

    if (improved) continue;

    let alreadyAtMinimumStep = true;
    for (const parameter of parameters) {
      const currentStep = steps.get(parameter.id)!;
      if (currentStep > parameter.minimumStep) alreadyAtMinimumStep = false;
      const next = Math.max(parameter.minimumStep, currentStep * 0.5);
      steps.set(parameter.id, next);
    }
    if (!alreadyAtMinimumStep) continue;

    const failedMetrics = current.evaluation.metrics.filter((metric) => !metric.passed);
    if (failedMetrics.length > 0) {
      const metric = failedMetrics[0]!;
      return failedResult(
        input,
        "constraints-unsatisfied",
        `constraint-unsatisfied:${metric.id}`,
        `Metric ${metric.id} remained outside its declared bounds at the best bounded solution. Best parameters: ${parameterDiagnostic(parameters, values)}.`,
        iteration,
        current.score,
        objectiveTolerance,
        current.evaluation.metrics,
      );
    }

    try {
      return await createAnatomyFitResult({
        solverVersion: input.solverVersion,
        domain: input.domain,
        inputSha256: input.inputSha256,
        status: "converged",
        convergence: {
          converged: true,
          iterations: iteration,
          objective: current.score,
          tolerance: objectiveTolerance,
          reason: "minimum-step",
        },
        resolvedParameters: resolvedParameters(parameters, values),
        nodeTransforms: current.evaluation.nodeTransforms,
        followerMorphCoefficients: current.evaluation.followerMorphCoefficients,
        metrics: current.evaluation.metrics,
        diagnostics: [],
      });
    } catch (error) {
      return failedResult(
        input,
        "invalid-output",
        "invalid-fit-output",
        error instanceof Error ? error.message : String(error),
        iteration,
        current.score,
        objectiveTolerance,
        current.evaluation.metrics,
      );
    }
  }

  return failedResult(
    input,
    "iteration-limit",
    "iteration-limit",
    `The deterministic bounded solver reached its iteration limit before convergence. Best parameters: ${parameterDiagnostic(parameters, values)}.`,
    maxIterations,
    current.score,
    objectiveTolerance,
    current.evaluation.metrics,
  );
}
