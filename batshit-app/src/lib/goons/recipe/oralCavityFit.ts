import {
  ORAL_CAVITY_ANATOMY_FIT_SOLVER,
  createAnatomyFitInput,
  createAnatomyFitResult,
  normalizeAnatomyFitPhysicalOutput,
  parseAnatomyFitInput,
  selectRelevantAnatomyFitInputs,
  type AnatomyFitFollowerMorphCoefficient,
  type AnatomyFitInput,
  type AnatomyFitMetric,
  type AnatomyFitNodeTransform,
  type AnatomyFitResult,
} from "./anatomyFitContracts";
import {
  type AnatomyFitLandmarkBinding,
  sampleAnatomyFitLandmarks,
} from "./anatomyFitSolver";
import {
  canonicalRecipeSha256,
  requireLowercaseSha256,
  sha256Hex,
} from "./recipeCanonical";

export const ORAL_CAVITY_FIT_DEFINITION_CONTRACT =
  "oral-cavity-fit-definition/v1" as const;
export const ORAL_CAVITY_FIT_PROOF_CONTRACT =
  "oral-cavity-fit-proof/v2" as const;

export type OralCavityFitLandmarkSetId = "lower" | "tongue" | "upper";
export type OralCavityFitAxis = "x" | "y" | "z";
export type OralCavityFitAssemblyRole =
  | "lower-gums"
  | "lower-teeth"
  | "tongue"
  | "upper-gums"
  | "upper-teeth";
export type OralCavityFitPoint = [number, number, number];

export type OralCavityFitLandmarkSet = {
  id: OralCavityFitLandmarkSetId;
  bindings: AnatomyFitLandmarkBinding[];
  neutralCenterRoot: OralCavityFitPoint;
  neutralHalfExtentsRoot: OralCavityFitPoint;
};

export type OralCavityFitScaleChannel = {
  axis: OralCavityFitAxis;
  followerId: string;
  channelId: string;
  morph: string;
  deltaPerWeight: number;
  lower: number;
  upper: number;
};

export type OralCavityFitAssembly = {
  role: OralCavityFitAssemblyRole;
  landmarkSetId: OralCavityFitLandmarkSetId;
  nodeId: string;
  scaleChannels: OralCavityFitScaleChannel[];
};

export type OralCavityFitDefinitionV1 = {
  contract: typeof ORAL_CAVITY_FIT_DEFINITION_CONTRACT;
  bodyMeshId: string;
  bodyNodeId: string;
  bodyTopologySha256: string;
  relevantInputIds: string[];
  scaleRange: [number, number];
  maximumTranslationMeters: number;
  landmarkSets: OralCavityFitLandmarkSet[];
  assemblies: OralCavityFitAssembly[];
  definitionSha256: string;
};

export type OralCavityFitInputSource = {
  modelSha256: string;
  appearanceDefinitionSha256: string;
  topologySha256: string;
};

export type OralCavityFitLandmarkFrame = {
  id: OralCavityFitLandmarkSetId;
  centerRoot: OralCavityFitPoint;
  halfExtentsRoot: OralCavityFitPoint;
  translationRoot: OralCavityFitPoint;
  scale: OralCavityFitPoint;
  sampleCount: number;
};

export type OralCavityFitProofV2 = {
  contract: typeof ORAL_CAVITY_FIT_PROOF_CONTRACT;
  definitionSha256: string;
  bodyPositionsSha256: string;
  bodyPositionsScalarCount: number;
  landmarkPositionsSha256: string;
  landmarkPositionsScalarCount: number;
  nodeTransforms: AnatomyFitNodeTransform[];
  followerMorphCoefficients: AnatomyFitFollowerMorphCoefficient[];
  metrics: AnatomyFitMetric[];
  scalarCount: number;
  proofSha256: string;
};

type OralCavityFitDefinitionPayload = Omit<
  OralCavityFitDefinitionV1,
  "definitionSha256"
>;
type OralCavityFitProofPayload = Omit<OralCavityFitProofV2, "proofSha256">;

const STABLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const AXES: OralCavityFitAxis[] = ["x", "y", "z"];
const LANDMARK_SET_IDS: OralCavityFitLandmarkSetId[] = [
  "lower",
  "tongue",
  "upper",
];
const ASSEMBLY_LANDMARKS: Record<
  OralCavityFitAssemblyRole,
  OralCavityFitLandmarkSetId
> = {
  "lower-gums": "lower",
  "lower-teeth": "lower",
  tongue: "tongue",
  "upper-gums": "upper",
  "upper-teeth": "upper",
};
const ASSEMBLY_ROLES = Object.keys(
  ASSEMBLY_LANDMARKS,
) as OralCavityFitAssemblyRole[];
const BOUND_TOLERANCE = 1e-9;

export class OralCavityFitError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "OralCavityFitError";
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new OralCavityFitError(code, `[${ORAL_CAVITY_FIT_DEFINITION_CONTRACT}] ${message}`);
}

function proofFail(code: string, message: string): never {
  throw new OralCavityFitError(code, `[${ORAL_CAVITY_FIT_PROOF_CONTRACT}] ${message}`);
}

function record(value: unknown, context: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid-definition", `${context} must be an object`);
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
      "invalid-definition",
      `${context} must contain exactly: ${sortedExpected.join(", ")}`,
    );
  }
}

function finite(value: unknown, context: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail("invalid-definition", `${context} must be finite`);
  }
  return Object.is(value, -0) ? 0 : value;
}

function stableId(value: unknown, context: string): string {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    !STABLE_ID_PATTERN.test(value)
  ) {
    fail("invalid-definition", `${context} must be a stable id`);
  }
  return value;
}

function point(value: unknown, context: string): OralCavityFitPoint {
  if (!Array.isArray(value) || value.length !== 3) {
    fail("invalid-definition", `${context} must contain exactly three coordinates`);
  }
  return value.map((entry, index) => finite(entry, `${context}[${index}]`)) as OralCavityFitPoint;
}

function positivePoint(value: unknown, context: string): OralCavityFitPoint {
  const parsed = point(value, context);
  if (parsed.some((entry) => entry <= 1e-9)) {
    fail("invalid-definition", `${context} must contain positive, non-degenerate extents`);
  }
  return parsed;
}

function sortedUnique<T>(
  rows: T[],
  key: (row: T) => string,
  context: string,
): T[] {
  const ids = rows.map(key);
  const expected = [...ids].sort((left, right) => left.localeCompare(right));
  if (ids.some((entry, index) => entry !== expected[index])) {
    fail("invalid-definition", `${context} must be sorted by stable id`);
  }
  const duplicate = ids.find((entry, index) => index > 0 && entry === ids[index - 1]);
  if (duplicate) fail("invalid-definition", `${context} duplicates ${duplicate}`);
  return rows;
}

function parseBinding(value: unknown, context: string): AnatomyFitLandmarkBinding {
  const raw = record(value, context);
  if (raw.kind === "vertex") {
    exactKeys(raw, ["id", "kind", "vertexIndex"], context);
    if (!Number.isSafeInteger(raw.vertexIndex) || (raw.vertexIndex as number) < 0) {
      fail("invalid-definition", `${context}.vertexIndex must be a non-negative safe integer`);
    }
    return {
      id: stableId(raw.id, `${context}.id`),
      kind: "vertex",
      vertexIndex: raw.vertexIndex as number,
    };
  }
  if (raw.kind !== "triangle-barycentric") {
    fail("invalid-definition", `${context}.kind is unsupported`);
  }
  exactKeys(raw, ["id", "kind", "vertexIndices", "weights"], context);
  if (
    !Array.isArray(raw.vertexIndices) ||
    raw.vertexIndices.length !== 3 ||
    !raw.vertexIndices.every(
      (entry) => Number.isSafeInteger(entry) && (entry as number) >= 0,
    ) ||
    new Set(raw.vertexIndices).size !== 3
  ) {
    fail(
      "invalid-definition",
      `${context}.vertexIndices must contain three distinct non-negative safe integers`,
    );
  }
  if (!Array.isArray(raw.weights) || raw.weights.length !== 3) {
    fail("invalid-definition", `${context}.weights must contain exactly three numbers`);
  }
  const weights = raw.weights.map((entry, index) =>
    finite(entry, `${context}.weights[${index}]`),
  ) as [number, number, number];
  if (
    weights.some((entry) => entry < 0) ||
    Math.abs(weights.reduce((sum, entry) => sum + entry, 0) - 1) > 1e-6
  ) {
    fail("invalid-definition", `${context}.weights must be non-negative and sum to one`);
  }
  return {
    id: stableId(raw.id, `${context}.id`),
    kind: "triangle-barycentric",
    vertexIndices: raw.vertexIndices as [number, number, number],
    weights,
  };
}

function parseLandmarkSet(value: unknown, index: number): OralCavityFitLandmarkSet {
  const context = `oral-cavity landmarkSets[${index}]`;
  const raw = record(value, context);
  exactKeys(
    raw,
    ["id", "bindings", "neutralCenterRoot", "neutralHalfExtentsRoot"],
    context,
  );
  if (raw.id !== "lower" && raw.id !== "tongue" && raw.id !== "upper") {
    fail("invalid-definition", `${context}.id must be lower, tongue, or upper`);
  }
  if (!Array.isArray(raw.bindings) || raw.bindings.length < 4) {
    fail("invalid-definition", `${context}.bindings must contain at least four samples`);
  }
  const bindings = sortedUnique(
    raw.bindings.map((entry, bindingIndex) =>
      parseBinding(entry, `${context}.bindings[${bindingIndex}]`),
    ),
    (entry) => entry.id,
    `${context}.bindings`,
  );
  return {
    id: raw.id,
    bindings,
    neutralCenterRoot: point(raw.neutralCenterRoot, `${context}.neutralCenterRoot`),
    neutralHalfExtentsRoot: positivePoint(
      raw.neutralHalfExtentsRoot,
      `${context}.neutralHalfExtentsRoot`,
    ),
  };
}

function parseScaleChannel(
  value: unknown,
  context: string,
): OralCavityFitScaleChannel {
  const raw = record(value, context);
  exactKeys(
    raw,
    ["axis", "followerId", "channelId", "morph", "deltaPerWeight", "lower", "upper"],
    context,
  );
  if (raw.axis !== "x" && raw.axis !== "y" && raw.axis !== "z") {
    fail("invalid-definition", `${context}.axis must be x, y, or z`);
  }
  const deltaPerWeight = finite(raw.deltaPerWeight, `${context}.deltaPerWeight`);
  const lower = finite(raw.lower, `${context}.lower`);
  const upper = finite(raw.upper, `${context}.upper`);
  if (deltaPerWeight <= 0) {
    fail("invalid-definition", `${context}.deltaPerWeight must be positive`);
  }
  if (lower >= 0 || upper <= 0) {
    fail("invalid-definition", `${context} bounds must contain zero`);
  }
  return {
    axis: raw.axis,
    followerId: stableId(raw.followerId, `${context}.followerId`),
    channelId: stableId(raw.channelId, `${context}.channelId`),
    morph: stableId(raw.morph, `${context}.morph`),
    deltaPerWeight,
    lower,
    upper,
  };
}

function parseAssembly(value: unknown, index: number): OralCavityFitAssembly {
  const context = `oral-cavity assemblies[${index}]`;
  const raw = record(value, context);
  exactKeys(raw, ["role", "landmarkSetId", "nodeId", "scaleChannels"], context);
  if (!ASSEMBLY_ROLES.includes(raw.role as OralCavityFitAssemblyRole)) {
    fail("invalid-definition", `${context}.role is unsupported`);
  }
  const role = raw.role as OralCavityFitAssemblyRole;
  const landmarkSetId = ASSEMBLY_LANDMARKS[role];
  if (raw.landmarkSetId !== landmarkSetId) {
    fail(
      "invalid-definition",
      `${context}.landmarkSetId must be ${landmarkSetId} for ${role}`,
    );
  }
  if (!Array.isArray(raw.scaleChannels) || raw.scaleChannels.length !== 3) {
    fail("invalid-definition", `${context}.scaleChannels must contain x, y, and z`);
  }
  const scaleChannels = sortedUnique(
    raw.scaleChannels.map((entry, channelIndex) =>
      parseScaleChannel(entry, `${context}.scaleChannels[${channelIndex}]`),
    ),
    (entry) => entry.axis,
    `${context}.scaleChannels`,
  );
  if (scaleChannels.some((entry, axisIndex) => entry.axis !== AXES[axisIndex])) {
    fail("invalid-definition", `${context}.scaleChannels must contain exactly x, y, and z`);
  }
  return {
    role,
    landmarkSetId,
    nodeId: stableId(raw.nodeId, `${context}.nodeId`),
    scaleChannels,
  };
}

function parsePayload(value: unknown): OralCavityFitDefinitionPayload {
  const raw = record(value, "Oral Cavity Fit definition");
  exactKeys(
    raw,
    [
      "contract",
      "bodyMeshId",
      "bodyNodeId",
      "bodyTopologySha256",
      "relevantInputIds",
      "scaleRange",
      "maximumTranslationMeters",
      "landmarkSets",
      "assemblies",
    ],
    "Oral Cavity Fit definition",
  );
  if (raw.contract !== ORAL_CAVITY_FIT_DEFINITION_CONTRACT) {
    fail("invalid-definition", "contract is unsupported");
  }
  if (!Array.isArray(raw.relevantInputIds) || raw.relevantInputIds.length === 0) {
    fail("invalid-definition", "relevantInputIds must be a non-empty array");
  }
  const relevantInputIds = sortedUnique(
    raw.relevantInputIds.map((entry, index) =>
      stableId(entry, `relevantInputIds[${index}]`),
    ),
    (entry) => entry,
    "relevantInputIds",
  );
  if (!Array.isArray(raw.scaleRange) || raw.scaleRange.length !== 2) {
    fail("invalid-definition", "scaleRange must contain lower and upper bounds");
  }
  const scaleRange = [
    finite(raw.scaleRange[0], "scaleRange[0]"),
    finite(raw.scaleRange[1], "scaleRange[1]"),
  ] as [number, number];
  if (scaleRange[0] <= 0 || scaleRange[0] >= 1 || scaleRange[1] <= 1) {
    fail("invalid-definition", "scaleRange must be positive and straddle one");
  }
  const maximumTranslationMeters = finite(
    raw.maximumTranslationMeters,
    "maximumTranslationMeters",
  );
  if (maximumTranslationMeters <= 0 || maximumTranslationMeters > 0.25) {
    fail(
      "invalid-definition",
      "maximumTranslationMeters must be inside the supported (0, 0.25] meter band",
    );
  }
  if (!Array.isArray(raw.landmarkSets) || raw.landmarkSets.length !== 3) {
    fail("invalid-definition", "landmarkSets must contain exactly lower, tongue, and upper");
  }
  const landmarkSets = sortedUnique(
    raw.landmarkSets.map(parseLandmarkSet),
    (entry) => entry.id,
    "oral-cavity landmarkSets",
  );
  if (landmarkSets.some((entry, index) => entry.id !== LANDMARK_SET_IDS[index])) {
    fail("invalid-definition", "landmarkSets must contain exactly lower, tongue, and upper");
  }
  if (!Array.isArray(raw.assemblies) || raw.assemblies.length !== ASSEMBLY_ROLES.length) {
    fail(
      "invalid-definition",
      "assemblies must contain the complete upper/lower teeth, gums, and tongue inventory",
    );
  }
  const assemblies = sortedUnique(
    raw.assemblies.map(parseAssembly),
    (entry) => entry.role,
    "oral-cavity assemblies",
  );
  if (assemblies.some((entry, index) => entry.role !== ASSEMBLY_ROLES[index])) {
    fail(
      "invalid-definition",
      "assemblies must contain the complete upper/lower teeth, gums, and tongue inventory",
    );
  }
  const nodes = assemblies.map((entry) => entry.nodeId);
  if (new Set(nodes).size !== nodes.length) {
    fail("invalid-definition", "assemblies must bind distinct appearance nodes");
  }
  const outputChannels = assemblies.flatMap((assembly) =>
    assembly.scaleChannels.map((channel) => `${channel.followerId}:${channel.channelId}`),
  );
  if (new Set(outputChannels).size !== outputChannels.length) {
    fail("invalid-definition", "scale output channels must be globally unique");
  }
  for (const assembly of assemblies) {
    for (const channel of assembly.scaleChannels) {
      const requiredLower = (scaleRange[0] - 1) / channel.deltaPerWeight;
      const requiredUpper = (scaleRange[1] - 1) / channel.deltaPerWeight;
      if (
        requiredLower < channel.lower - BOUND_TOLERANCE ||
        requiredUpper > channel.upper + BOUND_TOLERANCE
      ) {
        fail(
          "invalid-definition",
          `${assembly.role}/${channel.axis} channel bounds do not cover scaleRange`,
        );
      }
    }
  }
  return {
    contract: ORAL_CAVITY_FIT_DEFINITION_CONTRACT,
    bodyMeshId: stableId(raw.bodyMeshId, "bodyMeshId"),
    bodyNodeId: stableId(raw.bodyNodeId, "bodyNodeId"),
    bodyTopologySha256: requireLowercaseSha256(
      raw.bodyTopologySha256,
      "Oral Cavity Fit bodyTopologySha256",
    ),
    relevantInputIds,
    scaleRange,
    maximumTranslationMeters,
    landmarkSets,
    assemblies,
  };
}

export async function createOralCavityFitDefinition(
  value: Omit<OralCavityFitDefinitionPayload, "contract">,
): Promise<OralCavityFitDefinitionV1> {
  const payload = parsePayload({
    contract: ORAL_CAVITY_FIT_DEFINITION_CONTRACT,
    ...value,
    relevantInputIds: [...value.relevantInputIds].sort((left, right) =>
      left.localeCompare(right),
    ),
    landmarkSets: [...value.landmarkSets]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((entry) => ({
        ...entry,
        bindings: [...entry.bindings].sort((left, right) => left.id.localeCompare(right.id)),
      })),
    assemblies: [...value.assemblies]
      .sort((left, right) => left.role.localeCompare(right.role))
      .map((entry) => ({
        ...entry,
        scaleChannels: [...entry.scaleChannels].sort((left, right) =>
          left.axis.localeCompare(right.axis),
        ),
      })),
  });
  return { ...payload, definitionSha256: await canonicalRecipeSha256(payload) };
}

export async function parseOralCavityFitDefinition(
  value: unknown,
): Promise<OralCavityFitDefinitionV1> {
  const raw = record(value, "Oral Cavity Fit definition");
  exactKeys(
    raw,
    [
      "contract",
      "bodyMeshId",
      "bodyNodeId",
      "bodyTopologySha256",
      "relevantInputIds",
      "scaleRange",
      "maximumTranslationMeters",
      "landmarkSets",
      "assemblies",
      "definitionSha256",
    ],
    "Oral Cavity Fit definition",
  );
  const { definitionSha256: claimed, ...payloadValue } = raw;
  const payload = parsePayload(payloadValue);
  const definitionSha256 = requireLowercaseSha256(
    claimed,
    "Oral Cavity Fit definitionSha256",
  );
  if (definitionSha256 !== (await canonicalRecipeSha256(payload))) {
    fail("stale-definition", "definitionSha256 does not match canonical content");
  }
  return { ...payload, definitionSha256 };
}

function landmarkFrame(
  positions: Float32Array,
  definition: OralCavityFitLandmarkSet,
  scaleRange: [number, number],
  maximumTranslationMeters: number,
): OralCavityFitLandmarkFrame {
  const sampled = sampleAnatomyFitLandmarks(positions, definition.bindings);
  const coordinates = sampled.map((entry) => entry.position);
  const minimum = AXES.map((_, axis) =>
    Math.min(...coordinates.map((entry) => entry[axis]!)),
  ) as OralCavityFitPoint;
  const maximum = AXES.map((_, axis) =>
    Math.max(...coordinates.map((entry) => entry[axis]!)),
  ) as OralCavityFitPoint;
  const centerRoot = AXES.map(
    (_, axis) => (minimum[axis]! + maximum[axis]!) * 0.5,
  ) as OralCavityFitPoint;
  const halfExtentsRoot = AXES.map(
    (_, axis) => (maximum[axis]! - minimum[axis]!) * 0.5,
  ) as OralCavityFitPoint;
  if (halfExtentsRoot.some((entry) => entry <= 1e-9)) {
    fail("degenerate-landmarks", `${definition.id} landmark frame is degenerate`);
  }
  const translationRoot = AXES.map(
    (_, axis) => centerRoot[axis]! - definition.neutralCenterRoot[axis]!,
  ) as OralCavityFitPoint;
  const translationMagnitude = Math.hypot(...translationRoot);
  if (translationMagnitude > maximumTranslationMeters + BOUND_TOLERANCE) {
    fail(
      "translation-out-of-range",
      `${definition.id} requires ${translationMagnitude}m translation, above ${maximumTranslationMeters}m`,
    );
  }
  const scale = AXES.map(
    (_, axis) => halfExtentsRoot[axis]! / definition.neutralHalfExtentsRoot[axis]!,
  ) as OralCavityFitPoint;
  scale.forEach((entry, axis) => {
    if (entry < scaleRange[0] - BOUND_TOLERANCE || entry > scaleRange[1] + BOUND_TOLERANCE) {
      fail(
        "scale-out-of-range",
        `${definition.id}/${AXES[axis]} requires scale ${entry}, outside [${scaleRange.join(", ")}]`,
      );
    }
  });
  return {
    id: definition.id,
    centerRoot,
    halfExtentsRoot,
    translationRoot,
    scale,
    sampleCount: sampled.length,
  };
}

function translationMatrix(value: OralCavityFitPoint): number[] {
  return [
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    value[0], value[1], value[2], 1,
  ];
}

/**
 * Resolve the five oral assemblies from final composed body landmarks.
 *
 * The result is intentionally closed-form and fail-closed. Translation follows
 * the final upper/lower landmark centers. Axis scale is emitted only through
 * package-authored Recipe-only basis morphs, so tooth islands can remain rigid
 * while gums and tongue deform around them. Manual oral controls remain a
 * separate zero-based follower layer.
 */
export async function createOralCavityFitProof(args: {
  definition: OralCavityFitDefinitionV1;
  bodyMeshId: string;
  bodyNodeId: string;
  bodyTopologySha256: string;
  bodyRootPositions: Float32Array;
  landmarkRootPositions: Float32Array;
}): Promise<OralCavityFitProofV2> {
  const definition = await parseOralCavityFitDefinition(args.definition);
  if (args.bodyMeshId !== definition.bodyMeshId) {
    fail("stale-geometry", "body mesh identity does not match the definition");
  }
  if (args.bodyNodeId !== definition.bodyNodeId) {
    fail("stale-geometry", "body node identity does not match the definition");
  }
  if (args.bodyTopologySha256 !== definition.bodyTopologySha256) {
    fail("stale-geometry", "body topology does not match the definition");
  }
  if (
    !(args.bodyRootPositions instanceof Float32Array) ||
    args.bodyRootPositions.length === 0 ||
    args.bodyRootPositions.length % 3 !== 0
  ) {
    fail("invalid-geometry", "bodyRootPositions must be a non-empty Float32Array of vec3 values");
  }
  if (
    !(args.landmarkRootPositions instanceof Float32Array) ||
    args.landmarkRootPositions.length === 0 ||
    args.landmarkRootPositions.length % 3 !== 0
  ) {
    fail(
      "invalid-geometry",
      "landmarkRootPositions must be a non-empty Float32Array of vec3 values",
    );
  }
  const frames = definition.landmarkSets.map((entry) =>
    landmarkFrame(
      args.landmarkRootPositions,
      entry,
      definition.scaleRange,
      definition.maximumTranslationMeters,
    ),
  );
  const frameById = new Map(frames.map((entry) => [entry.id, entry]));
  const nodeTransforms = definition.assemblies
    .map((assembly) => ({
      nodeId: assembly.nodeId,
      rootDeltaMatrix: translationMatrix(
        frameById.get(assembly.landmarkSetId)!.translationRoot,
      ),
    }))
    .sort((left, right) => left.nodeId.localeCompare(right.nodeId));
  const followerMorphCoefficients = definition.assemblies
    .flatMap((assembly) => {
      const frame = frameById.get(assembly.landmarkSetId)!;
      return assembly.scaleChannels.map((channel) => {
        const axis = AXES.indexOf(channel.axis);
        const weight = (frame.scale[axis]! - 1) / channel.deltaPerWeight;
        if (weight < channel.lower - BOUND_TOLERANCE || weight > channel.upper + BOUND_TOLERANCE) {
          fail(
            "coefficient-out-of-range",
            `${assembly.role}/${channel.axis} requires weight ${weight}, outside [${channel.lower}, ${channel.upper}]`,
          );
        }
        return {
          followerId: channel.followerId,
          channelId: channel.channelId,
          nodeId: assembly.nodeId,
          morph: channel.morph,
          weight,
          lower: channel.lower,
          upper: channel.upper,
        };
      });
    })
    .sort((left, right) =>
      `${left.followerId}:${left.channelId}`.localeCompare(
        `${right.followerId}:${right.channelId}`,
      ),
    );
  const translations = frames.map((entry) => Math.hypot(...entry.translationRoot));
  const scales = frames.flatMap((entry) => entry.scale);
  const metrics: AnatomyFitMetric[] = [
    {
      id: "landmark-samples",
      value: frames.reduce((sum, entry) => sum + entry.sampleCount, 0),
      unit: "count",
      minimum: 8,
      maximum: null,
      passed: true,
    },
    {
      id: "maximum-translation",
      value: Math.max(...translations),
      unit: "meters",
      minimum: 0,
      maximum: definition.maximumTranslationMeters,
      passed: true,
    },
    {
      id: "maximum-scale",
      value: Math.max(...scales),
      unit: "ratio",
      minimum: null,
      maximum: definition.scaleRange[1],
      passed: true,
    },
    {
      id: "minimum-scale",
      value: Math.min(...scales),
      unit: "ratio",
      minimum: definition.scaleRange[0],
      maximum: null,
      passed: true,
    },
  ];
  metrics.sort((left, right) => left.id.localeCompare(right.id));
  const {
    nodeTransforms: normalizedNodeTransforms,
    followerMorphCoefficients: normalizedFollowerMorphCoefficients,
    metrics: normalizedMetrics,
  } = normalizeAnatomyFitPhysicalOutput({
    nodeTransforms,
    followerMorphCoefficients,
    metrics,
  });
  const scalarCount = args.landmarkRootPositions.length;
  const payload: OralCavityFitProofPayload = {
    contract: ORAL_CAVITY_FIT_PROOF_CONTRACT,
    definitionSha256: definition.definitionSha256,
    bodyPositionsSha256: await sha256Hex(uint8View(args.bodyRootPositions)),
    bodyPositionsScalarCount: args.bodyRootPositions.length,
    landmarkPositionsSha256: await sha256Hex(
      uint8View(args.landmarkRootPositions),
    ),
    landmarkPositionsScalarCount: args.landmarkRootPositions.length,
    nodeTransforms: normalizedNodeTransforms,
    followerMorphCoefficients: normalizedFollowerMorphCoefficients,
    metrics: normalizedMetrics,
    scalarCount,
  };
  return { ...payload, proofSha256: await canonicalRecipeSha256(payload) };
}

type OralCavityFitGeometryArgs = {
  definition: OralCavityFitDefinitionV1;
  bodyMeshId: string;
  bodyNodeId: string;
  bodyTopologySha256: string;
  bodyRootPositions: Float32Array;
  landmarkRootPositions: Float32Array;
};

/**
 * Verify a serialized oral proof against the exact definition and final body
 * geometry that must have produced it. Re-hashing edited proof JSON is not
 * enough: the complete deterministic proof must match a fresh computation.
 */
export async function verifyOralCavityFitProof(
  value: unknown,
  geometry: OralCavityFitGeometryArgs,
): Promise<OralCavityFitProofV2> {
  const raw = record(value, "Oral Cavity Fit proof");
  exactKeys(
    raw,
    [
      "contract",
      "definitionSha256",
      "bodyPositionsSha256",
      "bodyPositionsScalarCount",
      "landmarkPositionsSha256",
      "landmarkPositionsScalarCount",
      "nodeTransforms",
      "followerMorphCoefficients",
      "metrics",
      "scalarCount",
      "proofSha256",
    ],
    "Oral Cavity Fit proof",
  );
  if (raw.contract !== ORAL_CAVITY_FIT_PROOF_CONTRACT) {
    proofFail("invalid-proof", "contract is unsupported");
  }
  const proofSha256 = requireLowercaseSha256(
    raw.proofSha256,
    "Oral Cavity Fit proofSha256",
  );
  const { proofSha256: _claimed, ...payload } = raw;
  if (proofSha256 !== (await canonicalRecipeSha256(payload))) {
    proofFail("stale-proof", "proofSha256 does not match canonical content");
  }
  const expected = await createOralCavityFitProof(geometry);
  if (proofSha256 !== expected.proofSha256) {
    proofFail(
      "stale-proof",
      "proof does not match the exact definition and final body geometry",
    );
  }
  return expected;
}

function uint8View(value: Float32Array): Uint8Array {
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

/**
 * Bind one closed-form oral fit to the exact model, final body positions,
 * landmark definition, and declared relevant Appearance input inventory.
 */
export async function createOralCavityFitInput(args: {
  source: OralCavityFitInputSource;
  definition: OralCavityFitDefinitionV1;
  bodyMeshId: string;
  bodyNodeId: string;
  bodyRootPositions: Float32Array;
  landmarkRootPositions: Float32Array;
  appearanceValues: Readonly<Record<string, number>>;
}): Promise<AnatomyFitInput> {
  const definition = await parseOralCavityFitDefinition(args.definition);
  const topologySha256 = requireLowercaseSha256(
    args.source.topologySha256,
    "Oral Cavity Fit topologySha256",
  );
  const proof = await createOralCavityFitProof({
    definition,
    bodyMeshId: args.bodyMeshId,
    bodyNodeId: args.bodyNodeId,
    bodyTopologySha256: topologySha256,
    bodyRootPositions: args.bodyRootPositions,
    landmarkRootPositions: args.landmarkRootPositions,
  });
  return createAnatomyFitInput({
    solverVersion: ORAL_CAVITY_ANATOMY_FIT_SOLVER,
    domain: "oral-cavity",
    source: {
      modelSha256: requireLowercaseSha256(
        args.source.modelSha256,
        "Oral Cavity Fit modelSha256",
      ),
      appearanceDefinitionSha256: requireLowercaseSha256(
        args.source.appearanceDefinitionSha256,
        "Oral Cavity Fit appearanceDefinitionSha256",
      ),
      topologySha256,
      positionsSha256: await sha256Hex(uint8View(args.bodyRootPositions)),
      positionsScalarCount: args.bodyRootPositions.length,
      physicalEvaluationSha256: proof.proofSha256,
      physicalEvaluationScalarCount: proof.scalarCount,
      landmarkSetSha256: definition.definitionSha256,
      landmarkSampleCount: definition.landmarkSets.reduce(
        (sum, entry) => sum + entry.bindings.length,
        0,
      ),
    },
    relevantInputs: selectRelevantAnatomyFitInputs(
      args.appearanceValues,
      definition.relevantInputIds,
    ),
    parameters: [],
  });
}

function assertRelevantInputs(
  input: AnatomyFitInput,
  definition: OralCavityFitDefinitionV1,
  appearanceValues: Readonly<Record<string, number>>,
) {
  const expected = selectRelevantAnatomyFitInputs(
    appearanceValues,
    definition.relevantInputIds,
  );
  if (
    input.relevantInputs.length !== expected.length ||
    input.relevantInputs.some(
      (entry, index) =>
        entry.id !== expected[index]!.id || entry.value !== expected[index]!.value,
    )
  ) {
    fail(
      "stale-input",
      "relevant Appearance inputs changed after Oral Cavity Fit input creation",
    );
  }
}

/**
 * Recompute and emit the reusable Anatomy Fit v2 result for one exact oral
 * input. No clamping or stale-proof reuse is permitted.
 */
export async function solveOralCavityFit(args: {
  input: unknown;
  source: OralCavityFitInputSource;
  definition: OralCavityFitDefinitionV1;
  bodyMeshId: string;
  bodyNodeId: string;
  bodyRootPositions: Float32Array;
  landmarkRootPositions: Float32Array;
  appearanceValues: Readonly<Record<string, number>>;
}): Promise<AnatomyFitResult> {
  const definition = await parseOralCavityFitDefinition(args.definition);
  const input = await parseAnatomyFitInput(args.input);
  if (
    input.solverVersion !== ORAL_CAVITY_ANATOMY_FIT_SOLVER ||
    input.domain !== "oral-cavity"
  ) {
    fail("invalid-input", "Anatomy Fit input targets another specialization");
  }
  const modelSha256 = requireLowercaseSha256(
    args.source.modelSha256,
    "Oral Cavity Fit modelSha256",
  );
  const appearanceDefinitionSha256 = requireLowercaseSha256(
    args.source.appearanceDefinitionSha256,
    "Oral Cavity Fit appearanceDefinitionSha256",
  );
  const topologySha256 = requireLowercaseSha256(
    args.source.topologySha256,
    "Oral Cavity Fit topologySha256",
  );
  if (input.source.modelSha256 !== modelSha256) {
    fail("stale-input", "model changed after Oral Cavity Fit input creation");
  }
  if (input.source.appearanceDefinitionSha256 !== appearanceDefinitionSha256) {
    fail(
      "stale-input",
      "Appearance definition changed after Oral Cavity Fit input creation",
    );
  }
  if (
    input.source.topologySha256 !== topologySha256 ||
    topologySha256 !== definition.bodyTopologySha256
  ) {
    fail("stale-input", "body topology changed after Oral Cavity Fit input creation");
  }
  if (input.source.positionsScalarCount !== args.bodyRootPositions.length) {
    fail(
      "stale-input",
      "final body POSITION scalar count changed after Oral Cavity Fit input creation",
    );
  }
  if (
    input.source.positionsSha256 !==
    (await sha256Hex(uint8View(args.bodyRootPositions)))
  ) {
    fail(
      "stale-input",
      "final body POSITION data changed after Oral Cavity Fit input creation",
    );
  }
  if (input.source.landmarkSetSha256 !== definition.definitionSha256) {
    fail(
      "stale-input",
      "landmark definition changed after Oral Cavity Fit input creation",
    );
  }
  const landmarkSampleCount = definition.landmarkSets.reduce(
    (sum, entry) => sum + entry.bindings.length,
    0,
  );
  if (input.source.landmarkSampleCount !== landmarkSampleCount) {
    fail(
      "stale-input",
      "landmark inventory changed after Oral Cavity Fit input creation",
    );
  }
  assertRelevantInputs(input, definition, args.appearanceValues);
  const proof = await createOralCavityFitProof({
    definition,
    bodyMeshId: args.bodyMeshId,
    bodyNodeId: args.bodyNodeId,
    bodyTopologySha256: input.source.topologySha256,
    bodyRootPositions: args.bodyRootPositions,
    landmarkRootPositions: args.landmarkRootPositions,
  });
  if (
    input.source.physicalEvaluationSha256 !== proof.proofSha256 ||
    input.source.physicalEvaluationScalarCount !== proof.scalarCount
  ) {
    fail(
      "stale-input",
      "closed-form oral proof changed after Oral Cavity Fit input creation",
    );
  }
  return createAnatomyFitResult({
    solverVersion: ORAL_CAVITY_ANATOMY_FIT_SOLVER,
    domain: "oral-cavity",
    inputSha256: input.inputSha256,
    status: "converged",
    convergence: {
      converged: true,
      iterations: 0,
      objective: 0,
      tolerance: 0,
      reason: "closed-form-fit",
    },
    resolvedParameters: [],
    nodeTransforms: proof.nodeTransforms,
    followerMorphCoefficients: proof.followerMorphCoefficients,
    metrics: proof.metrics,
    diagnostics: [],
  });
}
