import * as THREE from "three";
import type {
  AnatomyFitFollowerMorphCoefficient,
  AnatomyFitInput,
  AnatomyFitNodeTransform,
  AnatomyFitParameter,
  AnatomyFitResult,
} from "./anatomyFitContracts";
import {
  createAnatomyFitInput,
  parseAnatomyFitInput,
  selectRelevantAnatomyFitInputs,
} from "./anatomyFitContracts";
import type {
  AnatomyFitEvaluator,
  AnatomyFitLandmark,
  AnatomyFitLandmarkBinding,
  AnatomyFitPoint,
} from "./anatomyFitSolver";
import {
  AnatomyFitSolverError,
  measureSignedAnatomyFitClearance,
  sampleAnatomyFitLandmarks,
  solveBoundedAnatomyFit,
} from "./anatomyFitSolver";
import {
  canonicalRecipeSha256,
  requireLowercaseSha256,
  sha256Hex,
} from "./recipeCanonical";

export const EYE_SOCKET_FIT_SOLVER_VERSION =
  "eye-socket-fit/geometry-clearance/v2" as const;
export const EYE_SOCKET_FIT_DOMAIN_PREFIX = "eye-socket" as const;

const EPSILON = 1e-9;
const COEFFICIENT_BOUND_TOLERANCE = 1e-6;
const HARD_CONSTRAINT_PENALTY = 100_000_000;
const DEFAULT_MAX_ITERATIONS = 512;

export const EYE_SOCKET_FIT_PARAMETER_IDS = Object.freeze({
  rotationPitch: "rotation.pitch",
  rotationRoll: "rotation.roll",
  rotationYaw: "rotation.yaw",
  scaleBack: "scale.back",
  scaleHorizontal: "scale.horizontal",
  scaleVertical: "scale.vertical",
  translationBack: "translation.back",
  translationHorizontal: "translation.horizontal",
  translationVertical: "translation.vertical",
});

export type EyeSocketFitSide = "left" | "right";

export type EyeSocketFitLandmarkBindings = {
  innerCorner: AnatomyFitLandmarkBinding;
  outerCorner: AnatomyFitLandmarkBinding;
  upperMargin: AnatomyFitLandmarkBinding[];
  lowerMargin: AnatomyFitLandmarkBinding[];
  depthSamples: AnatomyFitLandmarkBinding[];
};

export type EyeSocketFitNeutralReference = {
  apertureCenter: AnatomyFitPoint;
  frameRotation: [number, number, number, number];
  apertureHalfWidth: number;
  apertureHalfHeight: number;
  depthHalfExtent: number;
  eyeCenter: AnatomyFitPoint;
  eyeRotation: [number, number, number, number];
  pivotRotation: [number, number, number, number];
  eyeRadii: AnatomyFitPoint;
  regionalCenter: AnatomyFitPoint;
  regionalReachMeters: Record<EyeSocketFitRegion, number>;
};

export type EyeSocketFitRegion = "inner" | "lower" | "outer" | "upper";
export type EyeSocketFitMorphKind =
  | "scale-back"
  | "scale-horizontal"
  | "scale-vertical"
  | `localized-${EyeSocketFitRegion}`;

export type EyeSocketFitMorphOutput = {
  kind: EyeSocketFitMorphKind;
  followerId: string;
  channelId: string;
  nodeId: string;
  morph: string;
  lower: number;
  upper: number;
};

export type EyeSocketFitLayerOutput = {
  role: "cornea" | "iris" | "pupil" | "sclera";
  nodeId: string;
  meshId: string;
  morphOutputs: EyeSocketFitMorphOutput[];
};

export type EyeSocketFitOutputs = {
  pivotNodeId: string;
  layers: EyeSocketFitLayerOutput[];
};

export type EyeSocketFitLimits = {
  inwardAxisHint: AnatomyFitPoint;
  minimumClearanceMeters: number;
  maximumClearanceMeters: number;
  targetClearanceMeters: number;
  maximumLayerConformanceErrorMeters: number;
};

export type EyeSocketFitDefinition = {
  contract: "eye-socket-fit-definition/v1";
  side: EyeSocketFitSide;
  bodyMeshId: string;
  bodyTopologySha256: string;
  relevantInputIds: string[];
  landmarks: EyeSocketFitLandmarkBindings;
  neutral: EyeSocketFitNeutralReference;
  outputs: EyeSocketFitOutputs;
  limits: EyeSocketFitLimits;
};

export type EyeSocketFitPhysicalState = {
  pivot: {
    nodeId: string;
    parentRootRelativeMatrix: number[];
    rootRelativeMatrix: number[];
  };
  layers: Array<{
    nodeId: string;
    meshId: string;
    rootRelativeMatrix: number[];
    positions: Float32Array;
  }>;
};

export type EyeSocketFitInputSource = {
  modelSha256: string;
  appearanceDefinitionSha256: string;
  topologySha256: string;
};

export type EyeSocketFitAperture = {
  side: EyeSocketFitSide;
  center: AnatomyFitPoint;
  horizontalAxis: AnatomyFitPoint;
  inwardAxis: AnatomyFitPoint;
  verticalAxis: AnatomyFitPoint;
  frameRotation: [number, number, number, number];
  halfWidth: number;
  halfHeight: number;
  depthHalfExtent: number;
  marginLandmarks: AnatomyFitLandmark[];
};

type EyeSocketCandidate = {
  center: THREE.Vector3;
  rotation: THREE.Quaternion;
  radii: THREE.Vector3;
  surfaceSamples: Array<{
    landmarkId: string;
    position: AnatomyFitPoint;
    covered: boolean;
    radial: number;
  }>;
  nodeTransforms: AnatomyFitNodeTransform[];
  followerMorphCoefficients: AnatomyFitFollowerMorphCoefficient[];
  maximumLayerConformanceErrorMeters: number;
};

function fail(code: string, message: string): never {
  throw new AnatomyFitSolverError(code, message);
}

function record(value: unknown, context: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid-eye-fit-definition", `${context} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  context: string,
) {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (
    actual.length !== sortedExpected.length ||
    actual.some((entry, index) => entry !== sortedExpected[index])
  ) {
    fail(
      "invalid-eye-fit-definition",
      `${context} must contain exactly: ${sortedExpected.join(", ")}.`,
    );
  }
}

function stableId(value: unknown, context: string): string {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)
  ) {
    fail("invalid-eye-fit-definition", `${context} must be a stable id.`);
  }
  return value;
}

function finite(value: unknown, context: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail("invalid-eye-fit-definition", `${context} must be finite.`);
  }
  return value;
}

function positive(value: unknown, context: string): number {
  const parsed = finite(value, context);
  if (parsed <= 0) {
    fail("invalid-eye-fit-definition", `${context} must be positive.`);
  }
  return parsed;
}

function point(value: AnatomyFitPoint, context: string): THREE.Vector3 {
  if (!Array.isArray(value) || value.length !== 3) {
    fail("invalid-eye-fit-definition", `${context} must contain three coordinates.`);
  }
  return new THREE.Vector3(
    finite(value[0], `${context}[0]`),
    finite(value[1], `${context}[1]`),
    finite(value[2], `${context}[2]`),
  );
}

function tuple(value: THREE.Vector3): AnatomyFitPoint {
  return [value.x, value.y, value.z];
}

function quaternion(
  value: [number, number, number, number],
  context: string,
): THREE.Quaternion {
  const parsed = parsedQuaternionTuple(value, context);
  return new THREE.Quaternion(...parsed).normalize();
}

function parsedQuaternionTuple(
  value: unknown,
  context: string,
): [number, number, number, number] {
  if (!Array.isArray(value) || value.length !== 4) {
    fail("invalid-eye-fit-definition", `${context} must contain four coordinates.`);
  }
  const parsed = [
    finite(value[0], `${context}[0]`),
    finite(value[1], `${context}[1]`),
    finite(value[2], `${context}[2]`),
    finite(value[3], `${context}[3]`),
  ] as [number, number, number, number];
  if (Math.abs(Math.hypot(...parsed) - 1) > 1e-5) {
    fail("invalid-eye-fit-definition", `${context} must be normalized.`);
  }
  return parsed;
}

function parsedNormalizedPointTuple(
  value: unknown,
  context: string,
): AnatomyFitPoint {
  const parsed = point(value as AnatomyFitPoint, context);
  if (Math.abs(parsed.length() - 1) > 1e-5) {
    fail("invalid-eye-fit-definition", `${context} must be normalized.`);
  }
  return tuple(parsed);
}

function quaternionTuple(
  value: THREE.Quaternion,
): [number, number, number, number] {
  return [value.x, value.y, value.z, value.w];
}

function matrix16(value: unknown, context: string): number[] {
  if (!Array.isArray(value) || value.length !== 16) {
    fail("invalid-eye-fit-geometry", `${context} must contain 16 values.`);
  }
  return value.map((entry, index) => finite(entry, `${context}[${index}]`));
}

function parseBinding(
  value: unknown,
  context: string,
): AnatomyFitLandmarkBinding {
  const raw = record(value, context);
  if (raw.kind === "vertex") {
    exactKeys(raw, ["id", "kind", "vertexIndex"], context);
    if (!Number.isSafeInteger(raw.vertexIndex) || (raw.vertexIndex as number) < 0) {
      fail(
        "invalid-eye-fit-definition",
        `${context}.vertexIndex must be a non-negative safe integer.`,
      );
    }
    return {
      id: stableId(raw.id, `${context}.id`),
      kind: "vertex",
      vertexIndex: raw.vertexIndex as number,
    };
  }
  if (raw.kind === "triangle-barycentric") {
    exactKeys(raw, ["id", "kind", "vertexIndices", "weights"], context);
    if (!Array.isArray(raw.vertexIndices) || raw.vertexIndices.length !== 3) {
      fail(
        "invalid-eye-fit-definition",
        `${context}.vertexIndices must contain three indices.`,
      );
    }
    const vertexIndices = raw.vertexIndices.map((entry, index) => {
      if (!Number.isSafeInteger(entry) || (entry as number) < 0) {
        fail(
          "invalid-eye-fit-definition",
          `${context}.vertexIndices[${index}] must be a non-negative safe integer.`,
        );
      }
      return entry as number;
    }) as [number, number, number];
    if (!Array.isArray(raw.weights) || raw.weights.length !== 3) {
      fail(
        "invalid-eye-fit-definition",
        `${context}.weights must contain three values.`,
      );
    }
    const weights = raw.weights.map((entry, index) =>
      finite(entry, `${context}.weights[${index}]`),
    ) as [number, number, number];
    if (
      weights.some((entry) => entry < 0) ||
      Math.abs(weights.reduce((sum, entry) => sum + entry, 0) - 1) > 1e-6
    ) {
      fail(
        "invalid-eye-fit-definition",
        `${context}.weights must be non-negative and sum to one.`,
      );
    }
    return {
      id: stableId(raw.id, `${context}.id`),
      kind: "triangle-barycentric",
      vertexIndices,
      weights,
    };
  }
  fail("invalid-eye-fit-definition", `${context}.kind is unsupported.`);
}

function mean(points: readonly THREE.Vector3[], context: string): THREE.Vector3 {
  if (points.length === 0) fail("missing-landmark", `${context} is empty.`);
  return points
    .reduce((sum, entry) => sum.add(entry), new THREE.Vector3())
    .multiplyScalar(1 / points.length);
}

function normalized(value: THREE.Vector3, context: string): THREE.Vector3 {
  if (value.lengthSq() <= EPSILON * EPSILON) {
    fail("degenerate-eye-frame", `${context} is degenerate.`);
  }
  return value.normalize();
}

function bindingInventory(definition: EyeSocketFitDefinition) {
  return [
    definition.landmarks.innerCorner,
    definition.landmarks.outerCorner,
    ...definition.landmarks.upperMargin,
    ...definition.landmarks.lowerMargin,
    ...definition.landmarks.depthSamples,
  ];
}

export function parseEyeSocketFitDefinition(
  value: unknown,
): EyeSocketFitDefinition {
  const raw = record(value, "Eye Socket Fit definition");
  exactKeys(
    raw,
    [
      "contract",
      "side",
      "bodyMeshId",
      "bodyTopologySha256",
      "relevantInputIds",
      "landmarks",
      "neutral",
      "outputs",
      "limits",
    ],
    "Eye Socket Fit definition",
  );
  if (raw.contract !== "eye-socket-fit-definition/v1") {
    fail(
      "invalid-eye-fit-definition",
      "Eye Socket Fit definition contract is unsupported.",
    );
  }
  if (raw.side !== "left" && raw.side !== "right") {
    fail("invalid-eye-fit-definition", "Eye Socket Fit side is unsupported.");
  }
  const bodyMeshId = stableId(raw.bodyMeshId, "Eye Socket Fit bodyMeshId");
  const bodyTopologySha256 = requireLowercaseSha256(
    raw.bodyTopologySha256,
    "Eye Socket Fit bodyTopologySha256",
  );
  if (!Array.isArray(raw.relevantInputIds) || raw.relevantInputIds.length === 0) {
    fail(
      "invalid-eye-fit-definition",
      "Eye Socket Fit relevantInputIds must be a non-empty array.",
    );
  }
  const relevantInputIds = raw.relevantInputIds.map((entry) =>
    stableId(entry, "Eye Socket Fit relevant input id"),
  );
  const sortedRelevantInputIds = [...relevantInputIds].sort((left, right) =>
    left.localeCompare(right),
  );
  if (
    relevantInputIds.some(
      (entry, index) =>
        entry !== sortedRelevantInputIds[index] ||
        (index > 0 && entry === relevantInputIds[index - 1]),
    )
  ) {
    fail(
      "invalid-eye-fit-definition",
      "Eye Socket Fit relevantInputIds must be sorted and unique.",
    );
  }
  const landmarksRaw = record(raw.landmarks, "Eye Socket Fit landmarks");
  exactKeys(
    landmarksRaw,
    ["innerCorner", "outerCorner", "upperMargin", "lowerMargin", "depthSamples"],
    "Eye Socket Fit landmarks",
  );
  if (
    !Array.isArray(landmarksRaw.upperMargin) ||
    !Array.isArray(landmarksRaw.lowerMargin) ||
    !Array.isArray(landmarksRaw.depthSamples)
  ) {
    fail(
      "missing-landmark",
      "Eye Socket Fit margin and depth bindings must be arrays.",
    );
  }
  const landmarks: EyeSocketFitLandmarkBindings = {
    innerCorner: parseBinding(landmarksRaw.innerCorner, "inner corner"),
    outerCorner: parseBinding(landmarksRaw.outerCorner, "outer corner"),
    upperMargin: landmarksRaw.upperMargin.map((entry, index) =>
      parseBinding(entry, `upper margin ${index}`),
    ),
    lowerMargin: landmarksRaw.lowerMargin.map((entry, index) =>
      parseBinding(entry, `lower margin ${index}`),
    ),
    depthSamples: landmarksRaw.depthSamples.map((entry, index) =>
      parseBinding(entry, `depth sample ${index}`),
    ),
  };
  if (
    landmarks.upperMargin.length < 3 ||
    landmarks.lowerMargin.length < 3 ||
    landmarks.depthSamples.length < 3
  ) {
    fail(
      "missing-landmark",
      "Eye Socket Fit requires at least three upper, lower, and depth samples.",
    );
  }
  const neutralRaw = record(raw.neutral, "Eye Socket Fit neutral reference");
  exactKeys(
    neutralRaw,
    [
      "apertureCenter",
      "frameRotation",
      "apertureHalfWidth",
      "apertureHalfHeight",
      "depthHalfExtent",
      "eyeCenter",
      "eyeRotation",
      "pivotRotation",
      "eyeRadii",
      "regionalCenter",
      "regionalReachMeters",
    ],
    "Eye Socket Fit neutral reference",
  );
  const neutral: EyeSocketFitNeutralReference = {
    apertureCenter: tuple(
      point(neutralRaw.apertureCenter as AnatomyFitPoint, "neutral aperture center"),
    ),
    frameRotation: parsedQuaternionTuple(
      neutralRaw.frameRotation,
      "neutral aperture rotation",
    ),
    apertureHalfWidth: positive(
      neutralRaw.apertureHalfWidth,
      "neutral aperture half width",
    ),
    apertureHalfHeight: positive(
      neutralRaw.apertureHalfHeight,
      "neutral aperture half height",
    ),
    depthHalfExtent: positive(
      neutralRaw.depthHalfExtent,
      "neutral depth half extent",
    ),
    eyeCenter: tuple(point(neutralRaw.eyeCenter as AnatomyFitPoint, "neutral eye center")),
    eyeRotation: parsedQuaternionTuple(
      neutralRaw.eyeRotation,
      "neutral eye rotation",
    ),
    pivotRotation: parsedQuaternionTuple(
      neutralRaw.pivotRotation,
      "neutral pivot rotation",
    ),
    eyeRadii: tuple(point(neutralRaw.eyeRadii as AnatomyFitPoint, "neutral eye radii")),
    regionalCenter: tuple(
      point(neutralRaw.regionalCenter as AnatomyFitPoint, "neutral regional center"),
    ),
    regionalReachMeters: (() => {
      const regions = record(
        neutralRaw.regionalReachMeters,
        "neutral regional reach",
      );
      exactKeys(
        regions,
        ["inner", "lower", "outer", "upper"],
        "neutral regional reach",
      );
      return {
        inner: positive(regions.inner, "neutral inner reach"),
        lower: positive(regions.lower, "neutral lower reach"),
        outer: positive(regions.outer, "neutral outer reach"),
        upper: positive(regions.upper, "neutral upper reach"),
      };
    })(),
  };
  if (Math.min(...neutral.eyeRadii) <= 0) {
    fail("invalid-eye-fit-definition", "Neutral eye radii must be positive.");
  }
  const outputsRaw = record(raw.outputs, "Eye Socket Fit outputs");
  exactKeys(outputsRaw, ["layers", "pivotNodeId"], "Eye Socket Fit outputs");
  const pivotNodeId = stableId(
    outputsRaw.pivotNodeId,
    "Eye Socket Fit pivot node id",
  );
  if (!Array.isArray(outputsRaw.layers) || outputsRaw.layers.length !== 4) {
    fail(
      "invalid-eye-fit-definition",
      "Eye Socket Fit outputs must declare exactly four eye layers.",
    );
  }
  const morphKinds: EyeSocketFitMorphKind[] = [
    "localized-inner",
    "localized-lower",
    "localized-outer",
    "localized-upper",
    "scale-back",
    "scale-horizontal",
    "scale-vertical",
  ];
  const layers = outputsRaw.layers.map((entry, layerIndex) => {
    const context = `Eye Socket Fit layer ${layerIndex}`;
    const layer = record(entry, context);
    exactKeys(layer, ["meshId", "morphOutputs", "nodeId", "role"], context);
    if (
      layer.role !== "cornea" &&
      layer.role !== "iris" &&
      layer.role !== "pupil" &&
      layer.role !== "sclera"
    ) {
      fail("invalid-eye-fit-definition", `${context}.role is unsupported.`);
    }
    if (!Array.isArray(layer.morphOutputs) || layer.morphOutputs.length !== 7) {
      fail(
        "invalid-eye-fit-definition",
        `${context} must declare all seven Anatomy Fit morph outputs.`,
      );
    }
    const morphOutputs = layer.morphOutputs
      .map((morphEntry, morphIndex) => {
        const morphContext = `${context}.morphOutputs[${morphIndex}]`;
        const morph = record(morphEntry, morphContext);
        exactKeys(
          morph,
          ["channelId", "followerId", "kind", "lower", "morph", "nodeId", "upper"],
          morphContext,
        );
        if (!morphKinds.includes(morph.kind as EyeSocketFitMorphKind)) {
          fail("invalid-eye-fit-definition", `${morphContext}.kind is unsupported.`);
        }
        const lower = finite(morph.lower, `${morphContext}.lower`);
        const upper = finite(morph.upper, `${morphContext}.upper`);
        if (lower >= upper) {
          fail("invalid-eye-fit-definition", `${morphContext} bounds are invalid.`);
        }
        return {
          kind: morph.kind as EyeSocketFitMorphKind,
          followerId: stableId(morph.followerId, `${morphContext}.followerId`),
          channelId: stableId(morph.channelId, `${morphContext}.channelId`),
          nodeId: stableId(morph.nodeId, `${morphContext}.nodeId`),
          morph: stableId(morph.morph, `${morphContext}.morph`),
          lower,
          upper,
        };
      })
      .sort((left, right) => left.kind.localeCompare(right.kind));
    if (
      morphOutputs.some((morph, index) => morph.kind !== morphKinds[index]) ||
      morphOutputs.some((morph) => morph.nodeId !== layer.nodeId)
    ) {
      fail(
        "invalid-eye-fit-definition",
        `${context} morph outputs must cover the exact sorted kind inventory on the layer node.`,
      );
    }
    return {
      role: layer.role,
      nodeId: stableId(layer.nodeId, `${context}.nodeId`),
      meshId: stableId(layer.meshId, `${context}.meshId`),
      morphOutputs,
    } as EyeSocketFitLayerOutput;
  });
  layers.sort((left, right) => left.role.localeCompare(right.role));
  const expectedRoles = ["cornea", "iris", "pupil", "sclera"];
  if (layers.some((layer, index) => layer.role !== expectedRoles[index])) {
    fail(
      "invalid-eye-fit-definition",
      "Eye Socket Fit layer roles must be complete and unique.",
    );
  }
  const outputs: EyeSocketFitOutputs = { pivotNodeId, layers };
  const limitsRaw = record(raw.limits, "Eye Socket Fit limits");
  exactKeys(
    limitsRaw,
    [
      "inwardAxisHint",
      "minimumClearanceMeters",
      "maximumClearanceMeters",
      "targetClearanceMeters",
      "maximumLayerConformanceErrorMeters",
    ],
    "Eye Socket Fit limits",
  );
  const limits: EyeSocketFitLimits = {
    inwardAxisHint: parsedNormalizedPointTuple(
      limitsRaw.inwardAxisHint,
      "inward axis hint",
    ),
    minimumClearanceMeters: positive(
      limitsRaw.minimumClearanceMeters,
      "minimum eye clearance",
    ),
    maximumClearanceMeters: positive(
      limitsRaw.maximumClearanceMeters,
      "maximum eye clearance",
    ),
    targetClearanceMeters: positive(
      limitsRaw.targetClearanceMeters,
      "target eye clearance",
    ),
    maximumLayerConformanceErrorMeters: finite(
      limitsRaw.maximumLayerConformanceErrorMeters,
      "maximum layer conformance error",
    ),
  };
  const normalizedDefinition: EyeSocketFitDefinition = {
    contract: "eye-socket-fit-definition/v1",
    side: raw.side,
    bodyMeshId,
    bodyTopologySha256,
    relevantInputIds,
    landmarks,
    neutral,
    outputs,
    limits,
  };
  const bindingIds = bindingInventory(normalizedDefinition).map((entry) =>
    stableId(entry.id, "Eye Socket Fit landmark id"),
  );
  if (new Set(bindingIds).size !== bindingIds.length) {
    fail("duplicate-id", "Eye Socket Fit landmark ids must be unique.");
  }
  const morphKeys = layers.flatMap((layer) =>
    layer.morphOutputs.map((morph) => `${morph.followerId}:${morph.channelId}`),
  );
  if (new Set(morphKeys).size !== morphKeys.length) {
    fail("duplicate-id", "Eye Socket Fit morph outputs must be unique.");
  }
  const minimum = limits.minimumClearanceMeters;
  const maximum = limits.maximumClearanceMeters;
  const target = limits.targetClearanceMeters;
  if (minimum > target || target > maximum) {
    fail(
      "invalid-eye-fit-definition",
      "Eye clearance must satisfy minimum <= target <= maximum.",
    );
  }
  const conformance = limits.maximumLayerConformanceErrorMeters;
  if (conformance < 0) {
    fail(
      "invalid-eye-fit-definition",
      "Maximum layer conformance error must be non-negative.",
    );
  }
  return normalizedDefinition;
}

function parseEyeSocketFitPhysicalState(
  value: EyeSocketFitPhysicalState,
  definition: EyeSocketFitDefinition,
): EyeSocketFitPhysicalState {
  const raw = record(value, "Eye Socket Fit physical state");
  exactKeys(raw, ["layers", "pivot"], "Eye Socket Fit physical state");
  const pivotRaw = record(raw.pivot, "Eye Socket Fit physical pivot");
  exactKeys(
    pivotRaw,
    ["nodeId", "parentRootRelativeMatrix", "rootRelativeMatrix"],
    "Eye Socket Fit physical pivot",
  );
  const pivot = {
    nodeId: stableId(pivotRaw.nodeId, "Eye Socket Fit physical pivot node"),
    parentRootRelativeMatrix: matrix16(
      pivotRaw.parentRootRelativeMatrix,
      "Eye Socket Fit physical pivot parent matrix",
    ),
    rootRelativeMatrix: matrix16(
      pivotRaw.rootRelativeMatrix,
      "Eye Socket Fit physical pivot matrix",
    ),
  };
  if (pivot.nodeId !== definition.outputs.pivotNodeId) {
    fail(
      "invalid-eye-fit-geometry",
      "Eye Socket Fit physical pivot does not match its definition.",
    );
  }
  if (!Array.isArray(raw.layers) || raw.layers.length !== 4) {
    fail(
      "invalid-eye-fit-geometry",
      "Eye Socket Fit physical state must contain four layers.",
    );
  }
  const layers = raw.layers
    .map((entry, index) => {
      const context = `Eye Socket Fit physical layer ${index}`;
      const layer = record(entry, context);
      exactKeys(
        layer,
        ["meshId", "nodeId", "positions", "rootRelativeMatrix"],
        context,
      );
      if (!(layer.positions instanceof Float32Array) || layer.positions.length % 3 !== 0) {
        fail("invalid-eye-fit-geometry", `${context}.positions are malformed.`);
      }
      return {
        nodeId: stableId(layer.nodeId, `${context}.nodeId`),
        meshId: stableId(layer.meshId, `${context}.meshId`),
        rootRelativeMatrix: matrix16(
          layer.rootRelativeMatrix,
          `${context}.rootRelativeMatrix`,
        ),
        positions: layer.positions,
      };
    })
    .sort((left, right) => left.nodeId.localeCompare(right.nodeId));
  const expectedLayers = [...definition.outputs.layers].sort((left, right) =>
    left.nodeId.localeCompare(right.nodeId),
  );
  layers.forEach((layer, index) => {
    const expected = expectedLayers[index];
    if (layer.nodeId !== expected?.nodeId || layer.meshId !== expected.meshId) {
      fail(
        "invalid-eye-fit-geometry",
        "Eye Socket Fit physical layer inventory does not match its definition.",
      );
    }
  });
  return { pivot, layers };
}

export async function eyeSocketFitPhysicalProjection(
  state: EyeSocketFitPhysicalState,
): Promise<{ sha256: string; scalarCount: number }> {
  const layers = await Promise.all(
    state.layers.map(async (layer) => ({
      nodeId: layer.nodeId,
      meshId: layer.meshId,
      rootRelativeMatrix: layer.rootRelativeMatrix,
      positionsSha256: await sha256Hex(
        new Uint8Array(
          layer.positions.buffer,
          layer.positions.byteOffset,
          layer.positions.byteLength,
        ),
      ),
      positionsScalarCount: layer.positions.length,
    })),
  );
  const projection = {
    pivot: state.pivot,
    layers: layers.sort((left, right) => left.nodeId.localeCompare(right.nodeId)),
  };
  return {
    sha256: await canonicalRecipeSha256(projection),
    scalarCount:
      state.pivot.parentRootRelativeMatrix.length +
      state.pivot.rootRelativeMatrix.length +
      state.layers.reduce(
        (sum, layer) =>
          sum + layer.rootRelativeMatrix.length + layer.positions.length,
        0,
      ),
  };
}

function sampleMap(landmarks: readonly AnatomyFitLandmark[]) {
  return new Map(landmarks.map((entry) => [entry.id, point(entry.position, entry.id)]));
}

function pointsFor(
  bindings: readonly AnatomyFitLandmarkBinding[],
  samples: ReadonlyMap<string, THREE.Vector3>,
  context: string,
) {
  return bindings.map((binding) => {
    const sample = samples.get(binding.id);
    if (!sample) fail("missing-landmark", `${context} ${binding.id} is missing.`);
    return sample.clone();
  });
}

/**
 * Derive one stable eye-aperture frame from exact final-identity landmarks.
 * No dial names or state labels participate in this measurement.
 */
export function deriveEyeSocketFitAperture(
  positions: Float32Array,
  definitionValue: EyeSocketFitDefinition,
): EyeSocketFitAperture {
  const definition = parseEyeSocketFitDefinition(definitionValue);
  const sampled = sampleAnatomyFitLandmarks(
    positions,
    bindingInventory(definition),
  );
  const samples = sampleMap(sampled);
  const inner = samples.get(definition.landmarks.innerCorner.id)!;
  const outer = samples.get(definition.landmarks.outerCorner.id)!;
  const upper = pointsFor(
    definition.landmarks.upperMargin,
    samples,
    "upper margin",
  );
  const lower = pointsFor(
    definition.landmarks.lowerMargin,
    samples,
    "lower margin",
  );
  const depth = pointsFor(
    definition.landmarks.depthSamples,
    samples,
    "depth sample",
  );

  const horizontal = normalized(
    outer.clone().sub(inner),
    "inner-to-outer eye axis",
  );
  const verticalSeed = mean(upper, "upper margin").sub(mean(lower, "lower margin"));
  const vertical = normalized(
    verticalSeed.addScaledVector(horizontal, -verticalSeed.dot(horizontal)),
    "lower-to-upper eye axis",
  );
  let inward = normalized(
    vertical.clone().cross(horizontal),
    "eye inward axis",
  );
  const inwardHint = normalized(
    point(definition.limits.inwardAxisHint, "inward axis hint"),
    "inward axis hint",
  );
  if (inward.dot(inwardHint) < 0) inward = inward.negate();
  const correctedVertical = normalized(
    horizontal.clone().cross(inward),
    "orthogonal eye vertical axis",
  );
  // Mirrored eyelid bindings naturally reverse the inner-to-outer axis on
  // one side. Keep the physical inward direction and the measured lower-to-
  // upper direction stable by flipping the other two frame axes together.
  // That preserves a right-handed frame and gives both eyes one root-space
  // horizontal convention instead of silently turning one vertical axis down.
  if (correctedVertical.dot(verticalSeed) < 0) {
    horizontal.negate();
    correctedVertical.negate();
  }

  const marginPoints = [...upper, ...lower];
  const roughCenter = mean(marginPoints, "eye margins");
  const localRows = marginPoints.map((entry) => {
    const delta = entry.clone().sub(roughCenter);
    return {
      x: delta.dot(horizontal),
      z: delta.dot(correctedVertical),
    };
  });
  const minimumX = Math.min(...localRows.map((entry) => entry.x));
  const maximumX = Math.max(...localRows.map((entry) => entry.x));
  const minimumZ = Math.min(...localRows.map((entry) => entry.z));
  const maximumZ = Math.max(...localRows.map((entry) => entry.z));
  const halfWidth = (maximumX - minimumX) * 0.5;
  const halfHeight = (maximumZ - minimumZ) * 0.5;
  if (Math.min(halfWidth, halfHeight) <= EPSILON) {
    fail("degenerate-eye-frame", "Eye aperture extents are degenerate.");
  }
  const center = roughCenter
    .clone()
    .addScaledVector(horizontal, (minimumX + maximumX) * 0.5)
    .addScaledVector(correctedVertical, (minimumZ + maximumZ) * 0.5);
  const depthCoordinates = depth.map((entry) =>
    entry.clone().sub(center).dot(inward),
  );
  const depthHalfExtent =
    (Math.max(...depthCoordinates) - Math.min(...depthCoordinates)) * 0.5;
  if (depthHalfExtent <= EPSILON) {
    fail("degenerate-eye-frame", "Eye depth samples are degenerate.");
  }

  const frame = new THREE.Matrix4().makeBasis(
    horizontal,
    inward,
    correctedVertical,
  );
  const frameRotation = new THREE.Quaternion().setFromRotationMatrix(frame).normalize();
  const marginIds = new Set([
    ...definition.landmarks.upperMargin.map((entry) => entry.id),
    ...definition.landmarks.lowerMargin.map((entry) => entry.id),
  ]);

  return {
    side: definition.side,
    center: tuple(center),
    horizontalAxis: tuple(horizontal),
    inwardAxis: tuple(inward),
    verticalAxis: tuple(correctedVertical),
    frameRotation: quaternionTuple(frameRotation),
    halfWidth,
    halfHeight,
    depthHalfExtent,
    marginLandmarks: sampled.filter((entry) => marginIds.has(entry.id)),
  };
}

export function eyeSocketFitParameters(): AnatomyFitParameter[] {
  const degrees = (value: number) => THREE.MathUtils.degToRad(value);
  return [
    {
      id: EYE_SOCKET_FIT_PARAMETER_IDS.rotationPitch,
      lower: degrees(-4),
      upper: degrees(4),
      neutral: 0,
      regularizationWeight: 0.03,
      initialStep: degrees(1),
      minimumStep: degrees(0.0078125),
    },
    {
      id: EYE_SOCKET_FIT_PARAMETER_IDS.rotationRoll,
      lower: degrees(-4),
      upper: degrees(4),
      neutral: 0,
      regularizationWeight: 0.03,
      initialStep: degrees(1),
      minimumStep: degrees(0.0078125),
    },
    {
      id: EYE_SOCKET_FIT_PARAMETER_IDS.rotationYaw,
      lower: degrees(-4),
      upper: degrees(4),
      neutral: 0,
      regularizationWeight: 0.03,
      initialStep: degrees(1),
      minimumStep: degrees(0.0078125),
    },
    {
      id: EYE_SOCKET_FIT_PARAMETER_IDS.scaleBack,
      lower: 0.5,
      upper: 1.5,
      neutral: 1,
      regularizationWeight: 0.04,
      initialStep: 0.05,
      minimumStep: 0.000390625,
    },
    {
      id: EYE_SOCKET_FIT_PARAMETER_IDS.scaleHorizontal,
      lower: 0.5,
      upper: 1.5,
      neutral: 1,
      regularizationWeight: 0.04,
      initialStep: 0.05,
      minimumStep: 0.000390625,
    },
    {
      id: EYE_SOCKET_FIT_PARAMETER_IDS.scaleVertical,
      lower: 0.5,
      upper: 1.5,
      neutral: 1,
      regularizationWeight: 0.04,
      initialStep: 0.05,
      minimumStep: 0.000390625,
    },
    {
      id: EYE_SOCKET_FIT_PARAMETER_IDS.translationBack,
      lower: -0.008,
      upper: 0.008,
      neutral: 0,
      regularizationWeight: 0.02,
      initialStep: 0.001,
      minimumStep: 0.00000390625,
    },
    {
      id: EYE_SOCKET_FIT_PARAMETER_IDS.translationHorizontal,
      lower: -0.004,
      upper: 0.004,
      neutral: 0,
      regularizationWeight: 0.02,
      initialStep: 0.0005,
      minimumStep: 0.00000390625,
    },
    {
      id: EYE_SOCKET_FIT_PARAMETER_IDS.translationVertical,
      lower: -0.004,
      upper: 0.004,
      neutral: 0,
      regularizationWeight: 0.02,
      initialStep: 0.0005,
      minimumStep: 0.00000390625,
    },
  ];
}

export async function createEyeSocketFitInput(args: {
  source: EyeSocketFitInputSource;
  positions: Float32Array;
  physicalState: EyeSocketFitPhysicalState;
  definition: EyeSocketFitDefinition;
  appearanceValues: Readonly<Record<string, number>>;
}): Promise<AnatomyFitInput> {
  const definition = parseEyeSocketFitDefinition(args.definition);
  if (!(args.positions instanceof Float32Array) || args.positions.length % 3 !== 0) {
    fail(
      "invalid-geometry",
      "Eye Socket Fit positions must be a Float32Array of complete vec3 values.",
    );
  }
  const landmarkSetSha256 = await canonicalRecipeSha256(definition);
  const topologySha256 = requireLowercaseSha256(
    args.source.topologySha256,
    "Eye Socket Fit topologySha256",
  );
  if (topologySha256 !== definition.bodyTopologySha256) {
    fail(
      "invalid-eye-fit-definition",
      "Eye Socket Fit source topology does not match its landmark definition.",
    );
  }
  const positionBytes = new Uint8Array(
    args.positions.buffer,
    args.positions.byteOffset,
    args.positions.byteLength,
  );
  const physicalState = parseEyeSocketFitPhysicalState(
    args.physicalState,
    definition,
  );
  const physicalProjection = await eyeSocketFitPhysicalProjection(physicalState);
  return createAnatomyFitInput({
    solverVersion: EYE_SOCKET_FIT_SOLVER_VERSION,
    domain: `${EYE_SOCKET_FIT_DOMAIN_PREFIX}:${definition.side}`,
    source: {
      modelSha256: requireLowercaseSha256(
        args.source.modelSha256,
        "Eye Socket Fit modelSha256",
      ),
      appearanceDefinitionSha256: requireLowercaseSha256(
        args.source.appearanceDefinitionSha256,
        "Eye Socket Fit appearanceDefinitionSha256",
      ),
      topologySha256,
      positionsSha256: await sha256Hex(positionBytes),
      positionsScalarCount: args.positions.length,
      physicalEvaluationSha256: physicalProjection.sha256,
      physicalEvaluationScalarCount: physicalProjection.scalarCount,
      landmarkSetSha256,
      landmarkSampleCount: bindingInventory(definition).length,
    },
    relevantInputs: selectRelevantAnatomyFitInputs(
      args.appearanceValues,
      definition.relevantInputIds,
    ),
    parameters: eyeSocketFitParameters(),
  });
}

function clamp(value: number, lower: number, upper: number) {
  return Math.min(upper, Math.max(lower, value));
}

function regionalReach(
  aperture: EyeSocketFitAperture,
  definition: EyeSocketFitDefinition,
): Record<EyeSocketFitRegion, number> {
  const horizontal = point(aperture.horizontalAxis, "aperture horizontal axis");
  const vertical = point(aperture.verticalAxis, "aperture vertical axis");
  const translatedNeutralCenter = point(
    definition.neutral.regionalCenter,
    "neutral regional center",
  ).add(
    point(aperture.center, "aperture center").sub(
      point(definition.neutral.apertureCenter, "neutral aperture center"),
    ),
  );
  const rows = aperture.marginLandmarks.map((landmark) => {
    const delta = point(landmark.position, landmark.id).sub(translatedNeutralCenter);
    return { horizontal: delta.dot(horizontal), vertical: delta.dot(vertical) };
  });
  const left = Math.max(EPSILON, -Math.min(...rows.map((entry) => entry.horizontal)));
  const right = Math.max(EPSILON, Math.max(...rows.map((entry) => entry.horizontal)));
  return {
    upper: Math.max(EPSILON, Math.max(...rows.map((entry) => entry.vertical))),
    lower: Math.max(EPSILON, -Math.min(...rows.map((entry) => entry.vertical))),
    inner: definition.side === "left" ? left : right,
    outer: definition.side === "left" ? right : left,
  };
}

function resolvedPhysicalEye(
  definition: EyeSocketFitDefinition,
  physicalState: EyeSocketFitPhysicalState,
) {
  const pivotMatrix = new THREE.Matrix4().fromArray(
    physicalState.pivot.rootRelativeMatrix,
  );
  const pivotCenter = new THREE.Vector3().setFromMatrixPosition(pivotMatrix);
  const pivotRotation = new THREE.Quaternion();
  const pivotScale = new THREE.Vector3();
  pivotMatrix.decompose(
    new THREE.Vector3(),
    pivotRotation,
    pivotScale,
  );
  const pivotToEye = quaternion(
    definition.neutral.pivotRotation,
    "neutral pivot rotation",
  )
    .invert()
    .multiply(quaternion(definition.neutral.eyeRotation, "neutral eye rotation"));
  const eyeRotation = pivotRotation.clone().multiply(pivotToEye).normalize();
  const inverseEyeRotation = eyeRotation.clone().invert();
  const scleraDefinition = definition.outputs.layers.find(
    (layer) => layer.role === "sclera",
  )!;
  const scleraState = physicalState.layers.find(
    (layer) => layer.nodeId === scleraDefinition.nodeId,
  )!;
  const layerMatrix = new THREE.Matrix4().fromArray(
    scleraState.rootRelativeMatrix,
  );
  const minimum = new THREE.Vector3(
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY,
  );
  const maximum = new THREE.Vector3(
    Number.NEGATIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  );
  const vertex = new THREE.Vector3();
  for (let index = 0; index < scleraState.positions.length; index += 3) {
    vertex
      .set(
        scleraState.positions[index]!,
        scleraState.positions[index + 1]!,
        scleraState.positions[index + 2]!,
      )
      .applyMatrix4(layerMatrix)
      .sub(pivotCenter)
      .applyQuaternion(inverseEyeRotation);
    minimum.min(vertex);
    maximum.max(vertex);
  }
  const radii = maximum.clone().sub(minimum).multiplyScalar(0.5);
  if (Math.min(radii.x, radii.y, radii.z) <= EPSILON) {
    fail("invalid-eye-fit-geometry", "Resolved sclera extents are degenerate.");
  }
  return { pivotCenter, pivotRotation, pivotScale, eyeRotation, radii };
}

function coefficient(
  output: EyeSocketFitMorphOutput,
  weight: number,
): AnatomyFitFollowerMorphCoefficient {
  if (
    weight < output.lower - COEFFICIENT_BOUND_TOLERANCE ||
    weight > output.upper + COEFFICIENT_BOUND_TOLERANCE
  ) {
    fail(
      "eye-fit-output-out-of-bounds",
      `${output.kind} requires ${weight}, outside [${output.lower}, ${output.upper}].`,
    );
  }
  return {
    followerId: output.followerId,
    channelId: output.channelId,
    nodeId: output.nodeId,
    morph: output.morph,
    weight: clamp(weight, output.lower, output.upper),
    lower: output.lower,
    upper: output.upper,
  };
}

function candidateFor(
  definition: EyeSocketFitDefinition,
  aperture: EyeSocketFitAperture,
  physicalState: EyeSocketFitPhysicalState,
  parameters: Readonly<Record<string, number>>,
): EyeSocketCandidate {
  const neutral = definition.neutral;
  const currentFrame = quaternion(aperture.frameRotation, "current aperture frame");
  const neutralFrame = quaternion(neutral.frameRotation, "neutral aperture frame");
  const authoredRotation = quaternion(neutral.eyeRotation, "neutral eye rotation");
  const frameDelta = currentFrame.clone().multiply(neutralFrame.clone().invert());
  const baselineRotation = frameDelta.multiply(authoredRotation);
  const fineRotation = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(
      parameters[EYE_SOCKET_FIT_PARAMETER_IDS.rotationPitch]!,
      parameters[EYE_SOCKET_FIT_PARAMETER_IDS.rotationYaw]!,
      parameters[EYE_SOCKET_FIT_PARAMETER_IDS.rotationRoll]!,
      "YXZ",
    ),
  );
  const requestedEyeRotation = baselineRotation
    .multiply(fineRotation)
    .normalize();

  const authoredCenter = point(neutral.eyeCenter, "neutral eye center");
  const apertureTranslation = point(aperture.center, "aperture center").sub(
    point(neutral.apertureCenter, "neutral aperture center"),
  );
  const horizontal = point(aperture.horizontalAxis, "aperture horizontal axis");
  const inward = point(aperture.inwardAxis, "aperture inward axis");
  const vertical = point(aperture.verticalAxis, "aperture vertical axis");
  const requestedCenter = authoredCenter
    .clone()
    .add(apertureTranslation)
    .addScaledVector(
      horizontal,
      parameters[EYE_SOCKET_FIT_PARAMETER_IDS.translationHorizontal]!,
    )
    .addScaledVector(
      inward,
      parameters[EYE_SOCKET_FIT_PARAMETER_IDS.translationBack]!,
    )
    .addScaledVector(
      vertical,
      parameters[EYE_SOCKET_FIT_PARAMETER_IDS.translationVertical]!,
    );

  const rawHorizontal = aperture.halfWidth / neutral.apertureHalfWidth;
  const rawVertical = aperture.halfHeight / neutral.apertureHalfHeight;
  const rawBack = aperture.depthHalfExtent / neutral.depthHalfExtent;
  const baselineScale = new THREE.Vector3(
    clamp(1 + (rawHorizontal - 1) * 0.35, 0.65, 1.5),
    clamp(
      rawBack * (1 + (Math.sqrt(Math.max(rawHorizontal * rawVertical, EPSILON)) - 1) * 0.25),
      0.65,
      1.5,
    ),
    clamp(1 + (rawVertical - 1) * 0.35, 0.65, 1.5),
  );
  const authoredRadii = point(neutral.eyeRadii, "neutral eye radii");
  const radii = authoredRadii
    .clone()
    .multiply(baselineScale)
    .multiply(
      new THREE.Vector3(
        parameters[EYE_SOCKET_FIT_PARAMETER_IDS.scaleHorizontal]!,
        parameters[EYE_SOCKET_FIT_PARAMETER_IDS.scaleBack]!,
        parameters[EYE_SOCKET_FIT_PARAMETER_IDS.scaleVertical]!,
      ),
    );

  const current = resolvedPhysicalEye(definition, physicalState);
  const scale = new THREE.Vector3(
    radii.x / current.radii.x,
    radii.y / current.radii.y,
    radii.z / current.radii.z,
  );
  const reaches = regionalReach(aperture, definition);
  const globalHorizontal = radii.x / authoredRadii.x;
  const globalVertical = radii.z / authoredRadii.z;
  const localizedWeights: Record<EyeSocketFitRegion, number> = {
    inner: 0,
    lower: 0,
    outer: 0,
    upper: 0,
  };
  for (const region of ["inner", "lower", "outer", "upper"] as const) {
    const global = region === "lower" || region === "upper"
      ? globalVertical
      : globalHorizontal;
    const residual =
      (reaches[region] / definition.neutral.regionalReachMeters[region]) /
      global;
    const factor = clamp(1 + (residual - 1) * 0.35, 0.88, 1);
    localizedWeights[region] = (1 - factor) / 0.12;
  }
  const followerMorphCoefficients = definition.outputs.layers
    .flatMap((layer) => {
      const presentationScale = Math.min(scale.x, scale.z);
      return layer.morphOutputs.map((output) => {
        let weight: number;
        if (output.kind === "scale-back") weight = scale.y - 1;
        else if (output.kind === "scale-horizontal") {
          weight =
            layer.role === "iris" || layer.role === "pupil"
              ? presentationScale - 1
              : scale.x - 1;
        } else if (output.kind === "scale-vertical") {
          weight =
            layer.role === "iris" || layer.role === "pupil"
              ? presentationScale - 1
              : scale.z - 1;
        } else {
          weight = localizedWeights[
            output.kind.slice("localized-".length) as EyeSocketFitRegion
          ];
        }
        return coefficient(output, weight);
      });
    })
    .sort((left, right) =>
      `${left.followerId}:${left.channelId}`.localeCompare(
        `${right.followerId}:${right.channelId}`,
      ),
    );

  const pivotToEye = current.pivotRotation
    .clone()
    .invert()
    .multiply(current.eyeRotation);
  const desiredPivotRotation = requestedEyeRotation
    .clone()
    .multiply(pivotToEye.clone().invert())
    .normalize();
  const desiredPivotRoot = new THREE.Matrix4().compose(
    requestedCenter,
    desiredPivotRotation,
    current.pivotScale,
  );
  const parentRoot = new THREE.Matrix4().fromArray(
    physicalState.pivot.parentRootRelativeMatrix,
  );
  const targetLocalRaw = parentRoot.clone().invert().multiply(desiredPivotRoot);
  const targetLocalPosition = new THREE.Vector3();
  const targetLocalRotation = new THREE.Quaternion();
  const targetLocalScale = new THREE.Vector3();
  targetLocalRaw.decompose(
    targetLocalPosition,
    targetLocalRotation,
    targetLocalScale,
  );
  const targetLocal = new THREE.Matrix4().compose(
    targetLocalPosition,
    targetLocalRotation.normalize(),
    targetLocalScale,
  );
  const targetPivotRoot = parentRoot.clone().multiply(targetLocal);
  const center = new THREE.Vector3().setFromMatrixPosition(targetPivotRoot);
  const actualPivotRotation = new THREE.Quaternion();
  targetPivotRoot.decompose(
    new THREE.Vector3(),
    actualPivotRotation,
    new THREE.Vector3(),
  );
  const rotation = actualPivotRotation.multiply(pivotToEye).normalize();
  const currentPivotMatrix = new THREE.Matrix4().fromArray(
    physicalState.pivot.rootRelativeMatrix,
  );
  const rootDeltaMatrix = targetPivotRoot.multiply(
    currentPivotMatrix.invert(),
  );

  const inverseRotation = rotation.clone().invert();
  const surfaceSamples = aperture.marginLandmarks.map((landmark) => {
    const local = point(landmark.position, `margin ${landmark.id}`)
      .sub(center)
      .applyQuaternion(inverseRotation);
    const radial =
      (local.x / radii.x) ** 2 + (local.z / radii.z) ** 2;
    const covered = radial <= 1;
    const localSurface = new THREE.Vector3(
      local.x,
      -radii.y * Math.sqrt(Math.max(0, 1 - radial)),
      local.z,
    );
    const position = localSurface.applyQuaternion(rotation).add(center);
    return {
      landmarkId: landmark.id,
      position: tuple(position),
      covered,
      radial,
    };
  });

  const transform: Omit<AnatomyFitNodeTransform, "nodeId"> = {
    rootDeltaMatrix: [...rootDeltaMatrix.elements],
  };
  return {
    center,
    rotation,
    radii,
    surfaceSamples,
    nodeTransforms: [{ nodeId: definition.outputs.pivotNodeId, ...transform }],
    followerMorphCoefficients,
    maximumLayerConformanceErrorMeters: 0,
  };
}

function assertExactParameterInventory(input: AnatomyFitInput) {
  const expected = eyeSocketFitParameters().map((entry) => entry.id);
  const actual = input.parameters.map((entry) => entry.id);
  if (
    actual.length !== expected.length ||
    actual.some((entry, index) => entry !== expected[index])
  ) {
    fail(
      "invalid-eye-fit-input",
      "Eye Socket Fit parameter inventory does not match the specialization.",
    );
  }
}

/**
 * Solve one eye against final composed identity geometry. The specialization
 * owns aperture/clearance/conformance measurements; the shared solver owns
 * bounded deterministic refinement and reusable result records.
 */
export async function solveEyeSocketFit(args: {
  input: unknown;
  positions: Float32Array;
  physicalState: EyeSocketFitPhysicalState;
  definition: EyeSocketFitDefinition;
  maxIterations?: number;
}): Promise<AnatomyFitResult> {
  const definition = parseEyeSocketFitDefinition(args.definition);
  const input = await parseAnatomyFitInput(args.input);
  if (
    input.solverVersion !== EYE_SOCKET_FIT_SOLVER_VERSION ||
    input.domain !== `${EYE_SOCKET_FIT_DOMAIN_PREFIX}:${definition.side}`
  ) {
    fail(
      "invalid-eye-fit-input",
      "Eye Socket Fit input targets another specialization or side.",
    );
  }
  if (input.source.topologySha256 !== definition.bodyTopologySha256) {
    fail(
      "stale-eye-fit-input",
      "Eye Socket Fit body topology does not match the landmark definition.",
    );
  }
  assertExactParameterInventory(input);
  if (input.source.positionsScalarCount !== args.positions.length) {
    fail(
      "stale-eye-fit-input",
      "Eye Socket Fit POSITION scalar count changed after input creation.",
    );
  }
  const positionBytes = new Uint8Array(
    args.positions.buffer,
    args.positions.byteOffset,
    args.positions.byteLength,
  );
  if (input.source.positionsSha256 !== (await sha256Hex(positionBytes))) {
    fail(
      "stale-eye-fit-input",
      "Eye Socket Fit final composed POSITION data changed after input creation.",
    );
  }
  const physicalState = parseEyeSocketFitPhysicalState(
    args.physicalState,
    definition,
  );
  const physicalProjection = await eyeSocketFitPhysicalProjection(physicalState);
  if (
    input.source.physicalEvaluationSha256 !== physicalProjection.sha256 ||
    input.source.physicalEvaluationScalarCount !== physicalProjection.scalarCount
  ) {
    fail(
      "stale-eye-fit-input",
      "Eye Socket Fit physical eye evaluation changed after input creation.",
    );
  }
  if (
    input.source.landmarkSetSha256 !==
    (await canonicalRecipeSha256(definition))
  ) {
    fail(
      "stale-eye-fit-input",
      "Eye Socket Fit landmark definition changed after input creation.",
    );
  }
  const aperture = deriveEyeSocketFitAperture(args.positions, definition);
  const marginById = new Map(
    aperture.marginLandmarks.map((entry) => [entry.id, entry]),
  );

  const evaluator: AnatomyFitEvaluator = (
    parameters: Readonly<Record<string, number>>,
  ) => {
      const candidate = candidateFor(
        definition,
        aperture,
        physicalState,
        parameters,
      );
      const clearances = measureSignedAnatomyFitClearance(
        candidate.surfaceSamples.map((surface) => ({
          id: surface.landmarkId,
          surface: marginById.get(surface.landmarkId)!.position,
          internal: surface.position,
          inwardNormal: aperture.inwardAxis,
        })),
      );
      const covered = candidate.surfaceSamples.filter((entry) => entry.covered).length;
      const coverageRatio = covered / candidate.surfaceSamples.length;
      const radialOverflow = candidate.surfaceSamples.reduce(
        (sum, entry) => sum + Math.max(0, entry.radial - 1) ** 2,
        0,
      );
      const minimumClearance = Math.min(...clearances.map((entry) => entry.meters));
      const maximumClearance = Math.max(...clearances.map((entry) => entry.meters));
      const meanClearance =
        clearances.reduce((sum, entry) => sum + entry.meters, 0) /
        clearances.length;
      const band = Math.max(
        definition.limits.maximumClearanceMeters -
          definition.limits.minimumClearanceMeters,
        1e-6,
      );
      const clearanceObjective = clearances.reduce((sum, entry) => {
        const normalized =
          (entry.meters - definition.limits.targetClearanceMeters) / band;
        return sum + normalized * normalized;
      }, 0);
      const constraintPenalty =
        ((1 - coverageRatio) + radialOverflow) * HARD_CONSTRAINT_PENALTY +
        Math.max(
          0,
          (definition.limits.minimumClearanceMeters - minimumClearance) / band,
        ) ** 2 *
          HARD_CONSTRAINT_PENALTY +
        Math.max(
          0,
          (maximumClearance - definition.limits.maximumClearanceMeters) / band,
        ) ** 2 *
          HARD_CONSTRAINT_PENALTY;
      return {
        objective:
          clearanceObjective +
          constraintPenalty +
          (candidate.maximumLayerConformanceErrorMeters /
            Math.max(
              definition.limits.maximumLayerConformanceErrorMeters,
              1e-6,
            )) **
            2,
        nodeTransforms: candidate.nodeTransforms,
        followerMorphCoefficients: candidate.followerMorphCoefficients,
        metrics: [
          {
            id: "aperture-coverage-ratio",
            value: coverageRatio,
            unit: "ratio",
            minimum: 1,
            maximum: 1,
          },
          {
            id: "layer-conformance-maximum",
            value: candidate.maximumLayerConformanceErrorMeters,
            unit: "meters",
            minimum: 0,
            maximum: definition.limits.maximumLayerConformanceErrorMeters,
          },
          {
            id: "lid-clearance-maximum",
            value: maximumClearance,
            unit: "meters",
            minimum: null,
            maximum: definition.limits.maximumClearanceMeters,
          },
          {
            id: "lid-clearance-mean",
            value: meanClearance,
            unit: "meters",
            minimum: null,
            maximum: null,
          },
          {
            id: "lid-clearance-minimum",
            value: minimumClearance,
            unit: "meters",
            minimum: definition.limits.minimumClearanceMeters,
            maximum: null,
          },
          {
            id: "lid-depth-half-extent",
            value: aperture.depthHalfExtent,
            unit: "meters",
            minimum: 0,
            maximum: null,
          },
        ],
      };
    };
  const scaleSearchStarts: ReadonlyArray<Readonly<Record<string, number>>> = [
    {},
    { [EYE_SOCKET_FIT_PARAMETER_IDS.scaleVertical]: 1.5 },
    {
      [EYE_SOCKET_FIT_PARAMETER_IDS.scaleHorizontal]: 1.25,
      [EYE_SOCKET_FIT_PARAMETER_IDS.scaleVertical]: 1.5,
    },
    {
      [EYE_SOCKET_FIT_PARAMETER_IDS.scaleBack]: 0.75,
      [EYE_SOCKET_FIT_PARAMETER_IDS.scaleHorizontal]: 1.25,
      [EYE_SOCKET_FIT_PARAMETER_IDS.scaleVertical]: 1.5,
    },
    {
      [EYE_SOCKET_FIT_PARAMETER_IDS.scaleBack]: 1.25,
      [EYE_SOCKET_FIT_PARAMETER_IDS.scaleHorizontal]: 1.25,
      [EYE_SOCKET_FIT_PARAMETER_IDS.scaleVertical]: 1.5,
    },
  ];
  const attempts: AnatomyFitResult[] = [];
  for (const initialValues of scaleSearchStarts) {
    const result = await solveBoundedAnatomyFit(input, evaluator, {
      maxIterations: args.maxIterations ?? DEFAULT_MAX_ITERATIONS,
      objectiveTolerance: 1e-12,
      initialValues,
    });
    attempts.push(result);
    if (result.status === "converged") return result;
  }
  return [...attempts].sort((left, right) => {
    const leftEvaluationFailure = left.convergence.reason === "evaluation-error";
    const rightEvaluationFailure = right.convergence.reason === "evaluation-error";
    if (leftEvaluationFailure !== rightEvaluationFailure) {
      return leftEvaluationFailure ? 1 : -1;
    }
    return (
      left.convergence.objective - right.convergence.objective ||
      left.convergence.reason.localeCompare(right.convergence.reason)
    );
  })[0]!;
}
