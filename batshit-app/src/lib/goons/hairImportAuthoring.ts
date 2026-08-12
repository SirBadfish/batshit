import * as THREE from "three";
import {
  APPEARANCE_DIAL_VALUES_CONTRACT,
  type AppearanceDialValueState,
  type AppearanceDialsManifest,
} from "./appearanceDials.contracts";
import { parseAppearanceDialsManifest } from "./appearanceDials.schema";
import { resolveAppearanceDialState } from "./appearanceDials.values";
import {
  HAIR_APPEARANCE_FOLLOWER_CONTRACT,
  HAIR_FOLLOWER_RISK_MATRIX_CONTRACT,
  HAIR_SCALP_CAGE_CONTRACT,
  hairFollowerDefinitionSha256,
  parseHairFollowerDefinition,
  type HairFollowerDefinitionV1,
  type HairFollowerFalloffProfileId,
} from "./hairFollowers";
import {
  HAIR_MOTION_ANCHORED_LENGTH_MAX,
  HAIR_MOTION_ANCHORED_LENGTH_MIN,
  HAIR_MOTION_DEFAULT_ANCHORED_LENGTH,
  HAIR_MOTION_DEFAULT_INTENSITY,
  HAIR_MOTION_WEIGHT_CURVE,
  HAIR_ROOT_WEIGHTED_MOTION_CONTRACT,
  HAIR_ROOT_WEIGHTED_TIP_ATTRIBUTE,
  SECONDARY_MOTION_CONTRACT,
  SECONDARY_MOTION_MAX_REST_LENGTH_METERS,
  SECONDARY_MOTION_MIN_REST_LENGTH_METERS,
  SECONDARY_MOTION_STRESS_MATRIX_CONTRACT,
  parseSecondaryMotionDefinition,
  secondaryMotionDefinitionSha256,
  type SecondaryMotionColliderDriverV1,
  type SecondaryMotionDefinitionV1,
  type SecondaryMotionSegmentDriverV1,
  type SecondaryMotionVec3,
} from "./secondaryMotion";
import {
  expandHairMotionTriangleRanges,
  type HairMotionPaintV1,
} from "./hairMotionPaint";
import { buildAppearanceRecipePhysicalBasisFromGlb } from "./recipe/appearanceRecipePhysicalModel";
import {
  evaluateAppearanceRecipePhysicalOutput,
  type AppearanceRecipePhysicalEvaluation,
} from "./recipe/appearanceRecipePhysicalEvaluator";
import {
  canonicalRecipeSha256,
  canonicalRecipeString,
  sha256Hex,
} from "./recipe/recipeCanonical";
import {
  decodeSemanticGlbAccessor,
  parseSemanticGlb,
  resolveSemanticGlbNode,
  resolveSemanticGlbNodeTransform,
  semanticGlbRuntimeNodeName,
  writeDeterministicSemanticGlb,
  type SemanticGlbDocument,
  type SemanticGltfRecord,
  type SemanticJsonRecord,
} from "./recipe/semanticGlb";

export const HAIR_IMPORT_AUTHORING_CONTRACT =
  "hair-import-authoring/v2" as const;
export const HAIR_IMPORT_CANONICAL_ROOT_NODE = "HairImportRoot" as const;

type Vec3 = [number, number, number];
type Bounds = { minimum: Vec3; maximum: Vec3 };

export type HairImportFollowerDriverInput = {
  dialId: string;
  endpoint: number;
  falloffProfile: HairFollowerFalloffProfileId;
};

export type HairImportClumpReviewInput = {
  id: string;
  meshNode: string;
  collisionGroups: string[];
  maximumConnectedComponents: number;
  tuning?: Partial<{
    stiffness: number;
    damping: number;
    drag: number;
    gravityScale: number;
    maxAngleRadians: number;
    collisionRadius: number;
  }>;
};

export type HairImportMotionRegionSelection = {
  id: string;
  moving: boolean;
};

type HairImportColliderGeometry = {
  id: string;
  group: string;
  shape: "sphere" | "capsule";
  offset: Vec3;
  tailOffset: Vec3;
  radius: number;
  drivers?: SecondaryMotionColliderDriverV1[];
};

export type HairImportColliderInput = HairImportColliderGeometry &
  (
    | {
        /** Appearance mesh/canvas collider attachment. */
        manifestNodeId: string;
        node?: never;
      }
    | {
        /** Exact Recipe GLB rig node for colliders absent from appearanceDials.nodes. */
        node: string;
        manifestNodeId?: never;
      }
  );

export type HairImportAuthoringInput = {
  canonicalHairGlb: Uint8Array;
  recipeSourceGlb: Uint8Array;
  appearanceManifest: unknown;
  owner: {
    assetId: string;
    revisionId: string;
    fitFamily: string;
  };
  recipeNodes: {
    bodyManifestNodeId: string;
    /** Exact GLB node named by avatar.json#rig.performance.nodes.head.node. */
    headRigNode: string;
  };
  fit: {
    authoredRootMatrix: number[];
    minimumScale: number;
    maximumScale: number;
    maximumAxisScaleRatio: number;
  };
  reviewedAppearanceState: AppearanceDialValueState | null;
  scalp: {
    rootBounds: Bounds;
    transferBounds: Bounds;
    rootSeedFraction: number;
    maximumRootDistance: number;
  };
  followerDrivers: HairImportFollowerDriverInput[];
  clumps: HairImportClumpReviewInput[];
  colliders: HairImportColliderInput[];
  motion: {
    anchoredLength: number;
    defaultIntensity: number;
    regionSelections?: HairImportMotionRegionSelection[];
    paint?: HairMotionPaintV1;
    fixedStepSeconds: number;
    maxSubsteps: number;
    interruptionResetSeconds: number;
    gravity: Vec3;
    collisionIterations: number;
  };
};

export type HairImportAuthoringProposal = {
  status: "ready";
  confidence: number;
  confidenceLabel: "high" | "medium" | "review-carefully";
  blockingReasons: [];
  summary: string[];
  clumps: Array<{
    id: string;
    meshNode: string;
    root: Vec3;
    tip: Vec3;
    lengthMeters: number;
    connectedComponents: number;
    anchoredMicroComponentCount: number;
    anchoredMicroVertexCount: number;
    rootSeedCount: number;
    maximumRootDistance: number;
    anchoredVertexCount: number;
    fullyDynamicVertexCount: number;
    confidence: number;
    explanation: string;
  }>;
  weights: {
    anchoredLength: number;
    weightCurve: typeof HAIR_MOTION_WEIGHT_CURVE;
    defaultIntensity: number;
    explanation: string;
  };
  motionRegions: Array<{
    id: string;
    meshNode: string;
    label: string;
    moving: boolean;
    recommendedMoving: boolean;
    supportsMotion: boolean;
    root: Vec3;
    tip: Vec3;
    lengthMeters: number;
    vertexCount: number;
    explanation: string;
  }>;
  chains: Array<{
    id: string;
    motionNode: string;
    collisionGroups: string[];
    explanation: string;
  }>;
  colliders: Array<{
    id: string;
    group: string;
    node: string;
    explanation: string;
  }>;
};

export type HairImportAuthoringEvidence = {
  contract: typeof HAIR_IMPORT_AUTHORING_CONTRACT;
  inputHairSha256: string;
  recipeSourceSha256: string;
  appearanceDefinitionSha256: string;
  outputGeometrySha256: string;
  followerDefinitionSha256: string;
  secondaryMotionDefinitionSha256: string;
  proposalSha256: string;
  meshCount: number;
  vertexCount: number;
  morphTargetCount: number;
  motionChainCount: number;
  colliderCount: number;
  maximumRootDistance: number;
  maximumMorphDelta: number;
  anchoredVertexCount: number;
  fullyDynamicVertexCount: number;
  anchoredMicroComponentCount: number;
  anchoredMicroVertexCount: number;
};

export type HairImportAuthoringResult = {
  geometryGlb: Uint8Array;
  followerDefinition: HairFollowerDefinitionV1;
  secondaryMotionDefinition: SecondaryMotionDefinitionV1;
  proposal: HairImportAuthoringProposal;
  evidence: HairImportAuthoringEvidence;
};

export class HairImportAuthoringError extends Error {
  readonly code: string;
  readonly blockingReasons: string[];

  constructor(code: string, reasons: string[]) {
    super(`[${HAIR_IMPORT_AUTHORING_CONTRACT}] ${reasons.join("; ")}`);
    this.name = "HairImportAuthoringError";
    this.code = code;
    this.blockingReasons = reasons;
  }
}

type Edge = { left: number; right: number };
type NearestBody = {
  indices: [number, number, number, number];
  weights: [number, number, number, number];
};
type ClumpPlan = {
  review: HairImportClumpReviewInput;
  nodeIndex: number;
  meshIndex: number;
  primitive: SemanticJsonRecord;
  positions: Float64Array;
  indices: number[];
  nearestBody: NearestBody[];
  tipRatios: Float32Array;
  topologyDistances: Float64Array;
  rootIndices: number[];
  tipIndex: number;
  pivot: Vec3;
  tip: Vec3;
  length: number;
  componentCount: number;
  anchoredMicroComponentCount: number;
  anchoredMicroVertexCount: number;
  maximumRootDistance: number;
  edges: Edge[];
  coincidentGroups: number[][];
  targetDeltas: Float32Array[];
  motionRegions: MotionRegionPlan[];
};

type MotionRegionPlan = {
  id: string;
  label: string;
  vertices: number[];
  vertexMask: Uint8Array;
  rootIndices: number[];
  tipIndex: number;
  pivot: Vec3;
  tip: Vec3;
  length: number;
  motionRatios: Float32Array;
  moving: boolean;
  recommendedMoving: boolean;
  supportsMotion: boolean;
  explanation: string;
  motionNode: string | null;
  dynamicJointSlot: number | null;
};

const ROOT_WEIGHTED_TAG = "batshitHairRootWeightedMotion";
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

function block(code: string, ...reasons: string[]): never {
  throw new HairImportAuthoringError(code, reasons);
}

function finite(value: unknown, context: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    block("INVALID_INPUT", `${context} must be finite`);
  }
  return Object.is(value, -0) ? 0 : value;
}

function positive(value: unknown, context: string): number {
  const parsed = finite(value, context);
  if (parsed <= 0)
    block("INVALID_INPUT", `${context} must be greater than zero`);
  return parsed;
}

function stableId(value: unknown, context: string): string {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    !ID_PATTERN.test(value)
  ) {
    block("INVALID_INPUT", `${context} must be a stable id`);
  }
  return value;
}

function stableText(value: unknown, context: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim()
  ) {
    block("INVALID_INPUT", `${context} must be a non-empty trimmed string`);
  }
  return value;
}

function vec3(value: unknown, context: string): Vec3 {
  if (!Array.isArray(value) || value.length !== 3) {
    block("INVALID_INPUT", `${context} must contain exactly three numbers`);
  }
  return value.map((entry, index) =>
    finite(entry, `${context}[${index}]`),
  ) as Vec3;
}

function bounds(value: Bounds, context: string): Bounds {
  const minimum = vec3(value?.minimum, `${context}.minimum`);
  const maximum = vec3(value?.maximum, `${context}.maximum`);
  if (minimum.some((entry, index) => entry >= maximum[index]!)) {
    block("INVALID_INPUT", `${context} must have positive dimensions`);
  }
  return { minimum, maximum };
}

function inBounds(values: Float64Array, index: number, value: Bounds): boolean {
  const offset = index * 3;
  return [0, 1, 2].every(
    (component) =>
      values[offset + component]! >= value.minimum[component]! &&
      values[offset + component]! <= value.maximum[component]!,
  );
}

function cloneJson<T>(value: T): T {
  return JSON.parse(canonicalRecipeString(value)) as T;
}

function record(value: unknown, context: string): SemanticJsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    block("UNSAFE_GEOMETRY", `${context} must be an object`);
  }
  return value as SemanticJsonRecord;
}

function recipeHeadAnchor(value: unknown): string {
  const avatar = record(value, "avatar manifest");
  const rig = record(avatar.rig, "avatar manifest.rig");
  const performance = record(
    rig.performance,
    "avatar manifest.rig.performance",
  );
  const nodes = record(
    performance.nodes,
    "avatar manifest.rig.performance.nodes",
  );
  const head = record(nodes.head, "avatar manifest.rig.performance.nodes.head");
  return stableText(
    head.node,
    "avatar manifest.rig.performance.nodes.head.node",
  );
}

function array(value: unknown, context: string): unknown[] {
  if (!Array.isArray(value))
    block("UNSAFE_GEOMETRY", `${context} must be an array`);
  return value;
}

function integer(value: unknown, context: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    block("UNSAFE_GEOMETRY", `${context} must be a non-negative safe integer`);
  }
  return value as number;
}

function round(value: number, digits = 8): number {
  return Number(value.toFixed(digits));
}

function tuple(value: THREE.Vector3): Vec3 {
  return [round(value.x), round(value.y), round(value.z)];
}

function smoothstep(value: number): number {
  const bounded = Math.min(1, Math.max(0, value));
  return bounded * bounded * (3 - 2 * bounded);
}

function align4(value: number): number {
  return Math.ceil(value / 4) * 4;
}

function matrix(value: unknown, context: string): THREE.Matrix4 {
  if (!Array.isArray(value) || value.length !== 16) {
    block("INVALID_FIT", `${context} must contain exactly 16 numbers`);
  }
  const output = new THREE.Matrix4().fromArray(
    value.map((entry, index) => finite(entry, `${context}[${index}]`)),
  );
  if (Math.abs(output.determinant()) < 1e-9)
    block("INVALID_FIT", `${context} is not invertible`);
  return output;
}

function evaluationMatrix(
  evaluation: AppearanceRecipePhysicalEvaluation,
  nodeIndex: number,
  context: string,
): THREE.Matrix4 {
  const id = `node:${nodeIndex}`;
  const node = evaluation.nodes.find((entry) => entry.id === id);
  if (!node)
    block("INVALID_RECIPE_SOURCE", `${context} physical node ${id} is missing`);
  return new THREE.Matrix4().fromArray(node.rootRelativeMatrix);
}

function transformPositions(
  values: Float32Array,
  transform: THREE.Matrix4,
): Float64Array {
  const output = new Float64Array(values.length);
  const point = new THREE.Vector3();
  for (let offset = 0; offset < values.length; offset += 3) {
    point
      .set(values[offset]!, values[offset + 1]!, values[offset + 2]!)
      .applyMatrix4(transform);
    output[offset] = point.x;
    output[offset + 1] = point.y;
    output[offset + 2] = point.z;
  }
  return output;
}

function decodedPositions(
  parsed: SemanticGlbDocument,
  planNodeIndex: number,
): {
  meshIndex: number;
  primitive: SemanticJsonRecord;
  positions: Float64Array;
  indices: number[];
} {
  const node = parsed.nodes[planNodeIndex]!;
  const meshIndex = integer(node.mesh, `gltf.nodes[${planNodeIndex}].mesh`);
  const mesh = parsed.meshes[meshIndex];
  if (!mesh) block("UNSAFE_GEOMETRY", `Hair mesh ${meshIndex} is missing`);
  const primitives = array(
    mesh.primitives,
    `gltf.meshes[${meshIndex}].primitives`,
  );
  if (primitives.length !== 1) {
    block(
      "AMBIGUOUS_CLUMP",
      `Hair mesh ${node.name ?? planNodeIndex} must own one primitive`,
    );
  }
  const primitive = record(
    primitives[0],
    `gltf.meshes[${meshIndex}].primitives[0]`,
  );
  if (primitive.targets !== undefined) {
    block(
      "UNSAFE_GEOMETRY",
      `Hair mesh ${node.name ?? planNodeIndex} already owns morph targets`,
    );
  }
  const attributes = record(
    primitive.attributes,
    `gltf.meshes[${meshIndex}].primitives[0].attributes`,
  );
  if (attributes.JOINTS_0 !== undefined || attributes.WEIGHTS_0 !== undefined) {
    block(
      "UNSAFE_GEOMETRY",
      `Hair mesh ${node.name ?? planNodeIndex} is already skinned`,
    );
  }
  const position = decodeSemanticGlbAccessor(parsed, attributes.POSITION);
  if (
    position.type !== "VEC3" ||
    position.componentType !== 5126 ||
    position.count < 3
  ) {
    block(
      "UNSAFE_GEOMETRY",
      `Hair mesh ${node.name ?? planNodeIndex} POSITION must be FLOAT VEC3`,
    );
  }
  const indices = decodeIndices(parsed, primitive, position.count);
  return { meshIndex, primitive, positions: position.values, indices };
}

function decodeIndices(
  parsed: SemanticGlbDocument,
  primitive: SemanticJsonRecord,
  vertexCount: number,
): number[] {
  if (primitive.indices === undefined) {
    if (vertexCount % 3 !== 0) {
      block(
        "UNSAFE_GEOMETRY",
        "unindexed Hair geometry must be a triangle list",
      );
    }
    return Array.from({ length: vertexCount }, (_, index) => index);
  }
  const accessor = decodeSemanticGlbAccessor(parsed, primitive.indices);
  if (accessor.type !== "SCALAR" || accessor.count % 3 !== 0) {
    block(
      "UNSAFE_GEOMETRY",
      "Hair primitive indices must be a triangulated scalar accessor",
    );
  }
  return Array.from(accessor.values, (entry) => {
    if (!Number.isSafeInteger(entry) || entry < 0 || entry >= vertexCount) {
      block("UNSAFE_GEOMETRY", "Hair primitive index is out of range");
    }
    return entry;
  });
}

type BodyNeighbor = { index: number; distanceSquared: number };
type BodyKdNode = {
  index: number;
  axis: 0 | 1 | 2;
  left: BodyKdNode | null;
  right: BodyKdNode | null;
};

class BodyNeighborIndex {
  private readonly root: BodyKdNode | null;

  constructor(
    private readonly positions: Float64Array,
    candidates: number[],
  ) {
    const build = (values: number[], depth: number): BodyKdNode | null => {
      if (values.length === 0) return null;
      const axis = (depth % 3) as 0 | 1 | 2;
      values.sort(
        (left, right) =>
          positions[left * 3 + axis]! - positions[right * 3 + axis]! ||
          left - right,
      );
      const middle = Math.floor(values.length / 2);
      return {
        index: values[middle]!,
        axis,
        left: build(values.slice(0, middle), depth + 1),
        right: build(values.slice(middle + 1), depth + 1),
      };
    };
    this.root = build([...candidates], 0);
  }

  nearest(point: Vec3): BodyNeighbor[] {
    const result: BodyNeighbor[] = [];
    const insert = (candidate: BodyNeighbor) => {
      const position = result.findIndex(
        (entry) =>
          candidate.distanceSquared < entry.distanceSquared ||
          (candidate.distanceSquared === entry.distanceSquared &&
            candidate.index < entry.index),
      );
      if (position < 0) result.push(candidate);
      else result.splice(position, 0, candidate);
      if (result.length > 4) result.pop();
    };
    const visit = (node: BodyKdNode | null) => {
      if (!node) return;
      const offset = node.index * 3;
      const dx = point[0] - this.positions[offset]!;
      const dy = point[1] - this.positions[offset + 1]!;
      const dz = point[2] - this.positions[offset + 2]!;
      insert({
        index: node.index,
        distanceSquared: dx * dx + dy * dy + dz * dz,
      });
      const axisDelta = point[node.axis] - this.positions[offset + node.axis]!;
      const near = axisDelta <= 0 ? node.left : node.right;
      const far = axisDelta <= 0 ? node.right : node.left;
      visit(near);
      const worst = result.length < 4 ? Infinity : result[3]!.distanceSquared;
      if (axisDelta * axisDelta <= worst) visit(far);
    };
    visit(this.root);
    return result;
  }
}

function nearestBody(
  rootPositions: Float64Array,
  vertex: number,
  index: BodyNeighborIndex,
): { transfer: NearestBody; distance: number } {
  const offset = vertex * 3;
  const nearest = index.nearest([
    rootPositions[offset]!,
    rootPositions[offset + 1]!,
    rootPositions[offset + 2]!,
  ]);
  if (nearest.length !== 4)
    block("SPARSE_SCALP", "scalp transfer cage has fewer than four vertices");
  const unscaled = nearest.map(
    (entry) => 1 / Math.max(1e-12, entry.distanceSquared),
  );
  const total = unscaled.reduce((sum, entry) => sum + entry, 0);
  return {
    transfer: {
      indices: nearest.map((entry) => entry.index) as NearestBody["indices"],
      weights: unscaled.map((entry) => entry / total) as NearestBody["weights"],
    },
    distance: Math.sqrt(nearest[0]!.distanceSquared),
  };
}

function weightedBodyPoint(body: Float64Array, transfer: NearestBody): Vec3 {
  const output: Vec3 = [0, 0, 0];
  transfer.indices.forEach((index, slot) => {
    const offset = index * 3;
    const weight = transfer.weights[slot]!;
    output[0] += body[offset]! * weight;
    output[1] += body[offset + 1]! * weight;
    output[2] += body[offset + 2]! * weight;
  });
  return output;
}

class MinHeap {
  private readonly values: Array<{ vertex: number; distance: number }> = [];

  push(value: { vertex: number; distance: number }) {
    this.values.push(value);
    let index = this.values.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.values[parent]!.distance <= value.distance) break;
      this.values[index] = this.values[parent]!;
      index = parent;
    }
    this.values[index] = value;
  }

  pop() {
    const first = this.values[0];
    const last = this.values.pop();
    if (!first || !last || this.values.length === 0) return first;
    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      if (left >= this.values.length) break;
      const child =
        right < this.values.length &&
        this.values[right]!.distance < this.values[left]!.distance
          ? right
          : left;
      if (this.values[child]!.distance >= last.distance) break;
      this.values[index] = this.values[child]!;
      index = child;
    }
    this.values[index] = last;
    return first;
  }

  get size() {
    return this.values.length;
  }
}

function topology(
  positions: Float64Array,
  indices: number[],
  rootDistances: Float64Array,
  rootSeedFraction: number,
  maximumComponents: number,
): {
  ratios: Float32Array;
  distances: Float64Array;
  rootIndices: number[];
  componentCount: number;
  anchoredMicroComponentCount: number;
  anchoredMicroVertexCount: number;
  edges: Edge[];
  coincidentGroups: number[][];
} {
  const vertexCount = positions.length / 3;
  const adjacency = Array.from(
    { length: vertexCount },
    () => new Map<number, number>(),
  );
  const edges: Edge[] = [];
  const edgeKeys = new Set<string>();
  const connectCoincident = (left: number, right: number) => {
    if (left === right) return;
    adjacency[left]!.set(right, 0);
    adjacency[right]!.set(left, 0);
  };
  const connect = (left: number, right: number) => {
    if (left === right) return;
    const a = left * 3;
    const b = right * 3;
    const length = Math.hypot(
      positions[a]! - positions[b]!,
      positions[a + 1]! - positions[b + 1]!,
      positions[a + 2]! - positions[b + 2]!,
    );
    if (length <= 1e-9) return;
    const prior = adjacency[left]!.get(right);
    if (prior === undefined || length < prior) {
      adjacency[left]!.set(right, length);
      adjacency[right]!.set(left, length);
    }
    const low = Math.min(left, right);
    const high = Math.max(left, right);
    const key = `${low}:${high}`;
    if (!edgeKeys.has(key)) {
      edgeKeys.add(key);
      edges.push({ left: low, right: high });
    }
  };
  for (let offset = 0; offset < indices.length; offset += 3) {
    connect(indices[offset]!, indices[offset + 1]!);
    connect(indices[offset + 1]!, indices[offset + 2]!);
    connect(indices[offset + 2]!, indices[offset]!);
  }
  // Finished meshes commonly split normals/UV seams into duplicate vertices,
  // and the strict OBJ canonicalizer deliberately preserves face corners.
  // Weld exact canonical positions for topology only so those presentation
  // seams cannot turn one physical strand into hundreds of fake components.
  const coincident = new Map<string, number[]>();
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    const offset = vertex * 3;
    const key = `${positions[offset]!.toFixed(7)}:${positions[offset + 1]!.toFixed(7)}:${positions[offset + 2]!.toFixed(7)}`;
    const group = coincident.get(key);
    if (group === undefined) coincident.set(key, [vertex]);
    else group.push(vertex);
  }
  const coincidentGroups = Array.from(coincident.values()).filter(
    (group) => group.length > 1,
  );
  for (const group of coincidentGroups) {
    const representative = group[0]!;
    for (let index = 1; index < group.length; index += 1) {
      connectCoincident(representative, group[index]!);
    }
  }
  const components: number[][] = [];
  const visited = new Uint8Array(vertexCount);
  for (let start = 0; start < vertexCount; start += 1) {
    if (visited[start]) continue;
    const component: number[] = [];
    const pending = [start];
    visited[start] = 1;
    while (pending.length > 0) {
      const vertex = pending.pop()!;
      component.push(vertex);
      for (const neighbor of adjacency[vertex]!.keys()) {
        if (visited[neighbor]) continue;
        visited[neighbor] = 1;
        pending.push(neighbor);
      }
    }
    components.push(component);
  }
  if (components.length > maximumComponents) {
    block(
      "AMBIGUOUS_CLUMP",
      `reviewed clump contains ${components.length} disconnected pieces; limit is ${maximumComponents}`,
    );
  }
  const distances = new Float64Array(vertexCount);
  distances.fill(Infinity);
  const heap = new MinHeap();
  const rootIndices: number[] = [];
  for (const component of components) {
    const seedCount = Math.min(
      component.length,
      Math.max(1, Math.ceil(component.length * rootSeedFraction)),
    );
    const seeds = [...component]
      .sort(
        (left, right) =>
          rootDistances[left]! - rootDistances[right]! || left - right,
      )
      .slice(0, seedCount);
    for (const seed of seeds) {
      distances[seed] = 0;
      rootIndices.push(seed);
      heap.push({ vertex: seed, distance: 0 });
    }
  }
  while (heap.size > 0) {
    const current = heap.pop()!;
    if (current.distance !== distances[current.vertex]) continue;
    for (const [neighbor, edgeLength] of adjacency[current.vertex]!) {
      const next = current.distance + edgeLength;
      if (next >= distances[neighbor]!) continue;
      distances[neighbor] = next;
      heap.push({ vertex: neighbor, distance: next });
    }
  }
  const ratios = new Float32Array(vertexCount);
  let anchoredMicroComponentCount = 0;
  let anchoredMicroVertexCount = 0;
  for (const component of components) {
    const maximum = Math.max(...component.map((vertex) => distances[vertex]!));
    if (!Number.isFinite(maximum)) {
      block("UNSAFE_GEOMETRY", "Hair clump contains unreachable topology");
    }
    // Some finished meshes contain tiny disconnected decorative islands. A
    // sub-5 mm island cannot support a meaningful root-to-tip chain, so keep
    // it explicitly root-anchored and report it for review. The whole clump
    // still fails below when no stable moving component remains.
    if (maximum < SECONDARY_MOTION_MIN_REST_LENGTH_METERS) {
      anchoredMicroComponentCount += 1;
      anchoredMicroVertexCount += component.length;
      continue;
    }
    for (const vertex of component)
      ratios[vertex] = distances[vertex]! / maximum;
  }
  return {
    ratios,
    distances,
    rootIndices,
    componentCount: components.length,
    anchoredMicroComponentCount,
    anchoredMicroVertexCount,
    edges,
    coincidentGroups,
  };
}

function buildMotionRegions(
  plan: Omit<ClumpPlan, "motionRegions">,
  anchoredLength: number,
): MotionRegionPlan[] {
  const vertexCount = plan.positions.length / 3;
  const neighbors = Array.from({ length: vertexCount }, () => new Set<number>());
  for (const edge of plan.edges) {
    neighbors[edge.left]!.add(edge.right);
    neighbors[edge.right]!.add(edge.left);
  }
  for (const group of plan.coincidentGroups) {
    const representative = group[0]!;
    for (const vertex of group.slice(1)) {
      neighbors[representative]!.add(vertex);
      neighbors[vertex]!.add(representative);
    }
  }

  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  for (let offset = 0; offset < plan.positions.length; offset += 3) {
    for (let component = 0; component < 3; component += 1) {
      minimum[component] = Math.min(minimum[component]!, plan.positions[offset + component]!);
      maximum[component] = Math.max(maximum[component]!, plan.positions[offset + component]!);
    }
  }
  const dimensions = minimum
    .map((value, component) => maximum[component]! - value)
    .sort((left, right) => right - left);
  const elongated = dimensions[0]! / Math.max(dimensions[1]!, 1e-6) >= 1.8;
  const hangsBelowRoot = plan.tip[1] < plan.pivot[1] - 0.015;
  const clumpRecommendedMoving = plan.length >= 0.04 && (hangsBelowRoot || elongated);

  const candidateVertices: number[][] = [];
  const candidateTips: number[] = [];
  if (!clumpRecommendedMoving) {
    candidateVertices.push(Array.from({ length: vertexCount }, (_, vertex) => vertex));
    candidateTips.push(plan.tipIndex);
  } else {
    // Build a deterministic superlevel merge tree over the complete topology.
    // A persistent local maximum is a physical strand tip; small surface noise
    // merges back into a stronger tip before it reaches the minimum stable
    // chain length. Every source vertex then follows its merge ancestry to a
    // retained tip, so selection owns the complete strand basin instead of a
    // disconnected fragment left after the protected root was cut away.
    const order = Array.from({ length: vertexCount }, (_, vertex) => vertex).sort(
      (left, right) =>
        plan.topologyDistances[right]! - plan.topologyDistances[left]! || left - right,
    );
    const active = new Uint8Array(vertexCount);
    const parent = Int32Array.from({ length: vertexCount }, (_, vertex) => vertex);
    const peak = Int32Array.from({ length: vertexCount }, (_, vertex) => vertex);
    const peakParent = new Int32Array(vertexCount);
    peakParent.fill(-1);
    const retainedTips = new Set<number>();
    const find = (vertex: number): number => {
      let root = vertex;
      while (parent[root] !== root) root = parent[root]!;
      while (parent[vertex] !== vertex) {
        const next = parent[vertex]!;
        parent[vertex] = root;
        vertex = next;
      }
      return root;
    };
    const unite = (left: number, right: number, saddleDistance: number) => {
      const leftRoot = find(left);
      const rightRoot = find(right);
      if (leftRoot === rightRoot) return;
      const leftPeak = peak[leftRoot]!;
      const rightPeak = peak[rightRoot]!;
      const leftDistance = plan.topologyDistances[leftPeak]!;
      const rightDistance = plan.topologyDistances[rightPeak]!;
      const leftWins =
        leftDistance > rightDistance + 1e-9 ||
        (Math.abs(leftDistance - rightDistance) <= 1e-9 && leftPeak < rightPeak);
      const winnerRoot = leftWins ? leftRoot : rightRoot;
      const loserRoot = leftWins ? rightRoot : leftRoot;
      const winnerPeak = leftWins ? leftPeak : rightPeak;
      const loserPeak = leftWins ? rightPeak : leftPeak;
      parent[loserRoot] = winnerRoot;
      peak[winnerRoot] = winnerPeak;
      peakParent[loserPeak] = winnerPeak;
      if (
        plan.topologyDistances[loserPeak]! - saddleDistance >=
        SECONDARY_MOTION_MIN_REST_LENGTH_METERS - 1e-9
      ) {
        retainedTips.add(loserPeak);
      }
    };
    let cursor = 0;
    while (cursor < order.length) {
      const distance = plan.topologyDistances[order[cursor]!]!;
      let end = cursor + 1;
      while (
        end < order.length &&
        Math.abs(plan.topologyDistances[order[end]!]! - distance) <= 1e-9
      ) {
        end += 1;
      }
      for (let index = cursor; index < end; index += 1) {
        active[order[index]!] = 1;
      }
      for (let index = cursor; index < end; index += 1) {
        const vertex = order[index]!;
        for (const neighbor of neighbors[vertex]!) {
          if (active[neighbor]) unite(vertex, neighbor, distance);
        }
      }
      cursor = end;
    }
    const survivingRoots = new Set<number>();
    for (let vertex = 0; vertex < vertexCount; vertex += 1) {
      survivingRoots.add(find(vertex));
    }
    for (const root of survivingRoots) {
      const rootPeak = peak[root]!;
      if (
        plan.topologyDistances[rootPeak]! >=
        SECONDARY_MOTION_MIN_REST_LENGTH_METERS - 1e-9
      ) {
        retainedTips.add(rootPeak);
      }
    }
    const orderedTips = [...retainedTips].sort((left, right) => left - right);
    if (orderedTips.length === 0) {
      block(
        "AMBIGUOUS_TIP",
        `clump ${plan.review.id} has no stable full-strand tip candidate`,
      );
    }
    const retained = new Set(orderedTips);
    const byTip = new Map<number, number[]>(orderedTips.map((tip) => [tip, []]));
    const resolvedOwner = new Int32Array(vertexCount);
    resolvedOwner.fill(-2);
    for (const tip of orderedTips) resolvedOwner[tip] = tip;
    for (let vertex = 0; vertex < vertexCount; vertex += 1) {
      let owner = vertex;
      const path: number[] = [];
      while (!retained.has(owner) && resolvedOwner[owner] === -2) {
        if (path.length > vertexCount) {
          block("UNSAFE_GEOMETRY", `clump ${plan.review.id} has cyclic tip ancestry`);
        }
        path.push(owner);
        const next = peakParent[owner]!;
        if (next < 0) {
          // A disconnected sub-5 mm decorative island intentionally has no
          // retained motion tip. It remains ordinary root-owned geometry and
          // is already counted in the explicit anchored-micro evidence.
          owner = -1;
          break;
        }
        owner = next;
      }
      const answer = owner < 0 ? -1 : resolvedOwner[owner] >= -1 ? resolvedOwner[owner]! : owner;
      for (const entry of path) resolvedOwner[entry] = answer;
      resolvedOwner[vertex] = answer;
      if (answer >= 0) byTip.get(answer)!.push(vertex);
    }
    for (const tip of orderedTips) {
      const vertices = byTip.get(tip)!;
      if (vertices.length === 0) continue;
      candidateTips.push(tip);
      candidateVertices.push(vertices.sort((left, right) => left - right));
    }
  }

  return candidateVertices
    .map((vertices, candidateIndex) => ({ vertices, tipIndex: candidateTips[candidateIndex]! }))
    .sort((left, right) => left.tipIndex - right.tipIndex)
    .map(({ vertices, tipIndex }, index) => {
      const tipDistance = Math.max(
        plan.topologyDistances[tipIndex]!,
        SECONDARY_MOTION_MIN_REST_LENGTH_METERS,
      );
      const motionRatios = new Float32Array(vertexCount);
      const eligible = new Uint8Array(vertexCount);
      const vertexMask = new Uint8Array(vertexCount);
      for (const vertex of vertices) {
        vertexMask[vertex] = 1;
        const ratio = Math.min(1, Math.max(0, plan.topologyDistances[vertex]! / tipDistance));
        motionRatios[vertex] = ratio;
        if (ratio > anchoredLength + 1e-6) eligible[vertex] = 1;
      }
      const movingVertices = vertices.filter((vertex) => eligible[vertex]);
      const minimumRatio = Math.min(
        ...movingVertices.map((vertex) => motionRatios[vertex]!),
      );
      const boundary = movingVertices.filter((vertex) =>
        [...neighbors[vertex]!].some(
          (neighbor) => vertexMask[neighbor] && !eligible[neighbor],
        ),
      );
      const rootIndices = boundary.length > 0
        ? boundary
        : movingVertices.filter(
            (vertex) => motionRatios[vertex]! <= minimumRatio + 0.02,
          );
      const pivotVector = averageVertices(plan.positions, rootIndices);
      const tipOffset = tipIndex * 3;
      const tipVector = new THREE.Vector3(
        plan.positions[tipOffset],
        plan.positions[tipOffset + 1],
        plan.positions[tipOffset + 2],
      );
      const length = pivotVector.distanceTo(tipVector);
      const supportsMotion =
        length >= SECONDARY_MOTION_MIN_REST_LENGTH_METERS &&
        length <= SECONDARY_MOTION_MAX_REST_LENGTH_METERS;
      const recommendedMoving = supportsMotion && clumpRecommendedMoving;
      const regionHangsBelowRoot = tipVector.y < pivotVector.y - 0.003;
      const id = `${plan.review.id}:region-${String(index + 1).padStart(3, "0")}`;
      return {
        id,
        label: `${stableText(plan.review.meshNode, `clump ${plan.review.id}.meshNode`)} ${clumpRecommendedMoving ? "strand" : "region"} ${index + 1}`,
        vertices,
        vertexMask,
        rootIndices,
        tipIndex,
        pivot: tuple(pivotVector),
        tip: tuple(tipVector),
        length,
        motionRatios,
        moving: recommendedMoving,
        recommendedMoving,
        supportsMotion,
        explanation: !supportsMotion
          ? "Batshit kept this complete detail region anchored because its movable reach is too short to support a stable motion chain."
          : recommendedMoving
            ? regionHangsBelowRoot
              ? "Batshit proposed motion for this complete strand because its tip hangs below the protected root."
              : "Batshit proposed motion for this complete strand because it belongs to a long, narrow Hair form."
            : "Batshit kept this complete compact, scalp-side, or upward region still by default.",
        motionNode: null,
        dynamicJointSlot: null,
      };
    });
}

function buildPaintedMotionRegions(
  plan: Omit<ClumpPlan, "motionRegions">,
  anchoredLength: number,
  paint: HairMotionPaintV1,
): MotionRegionPlan[] {
  const meshNode = stableText(
    plan.review.meshNode,
    `clump ${plan.review.id}.meshNode`,
  );
  const triangleCount = plan.indices.length / 3;
  const vertexCount = plan.positions.length / 3;
  const neighbors = Array.from({ length: vertexCount }, () => new Set<number>());
  const edgeLengths = Array.from(
    { length: vertexCount },
    () => new Map<number, number>(),
  );
  const connect = (left: number, right: number, length: number) => {
    neighbors[left]!.add(right);
    neighbors[right]!.add(left);
    const prior = edgeLengths[left]!.get(right);
    if (prior === undefined || length < prior) {
      edgeLengths[left]!.set(right, length);
      edgeLengths[right]!.set(left, length);
    }
  };
  for (const edge of plan.edges) {
    const leftOffset = edge.left * 3;
    const rightOffset = edge.right * 3;
    connect(
      edge.left,
      edge.right,
      Math.hypot(
        plan.positions[leftOffset]! - plan.positions[rightOffset]!,
        plan.positions[leftOffset + 1]! - plan.positions[rightOffset + 1]!,
        plan.positions[leftOffset + 2]! - plan.positions[rightOffset + 2]!,
      ),
    );
  }
  for (const group of plan.coincidentGroups) {
    const representative = group[0]!;
    for (const vertex of group.slice(1)) {
      connect(representative, vertex, 0);
    }
  }

  const regions: MotionRegionPlan[] = [];
  const claimedTriangles = new Set<number>();
  for (const painted of paint.regions) {
    const paintedMesh = painted.meshes.find((entry) => entry.meshNode === meshNode);
    if (!paintedMesh) continue;
    if (paintedMesh.triangleCount !== triangleCount) {
      block(
        "INVALID_MOTION_PAINT",
        `painted area ${painted.id} no longer matches ${meshNode} topology`,
      );
    }
    const paintedTriangles = expandHairMotionTriangleRanges(
      paintedMesh.triangleRanges,
      triangleCount,
    );
    if (painted.enabled) {
      for (const triangle of paintedTriangles) {
        if (claimedTriangles.has(triangle)) {
          block(
            "INVALID_MOTION_PAINT",
            `enabled painted areas overlap on ${meshNode}; erase the overlap or combine them`,
          );
        }
        claimedTriangles.add(triangle);
      }
    }
    const selectedMask = new Uint8Array(vertexCount);
    for (const triangle of paintedTriangles) {
      const offset = triangle * 3;
      selectedMask[plan.indices[offset]!] = 1;
      selectedMask[plan.indices[offset + 1]!] = 1;
      selectedMask[plan.indices[offset + 2]!] = 1;
    }
    const unseen = new Set(
      Array.from({ length: vertexCount }, (_, vertex) => vertex).filter(
        (vertex) => selectedMask[vertex] === 1,
      ),
    );
    const components: number[][] = [];
    while (unseen.size > 0) {
      const first = unseen.values().next().value!;
      unseen.delete(first);
      const queue = [first];
      const component: number[] = [];
      for (let queueIndex = 0; queueIndex < queue.length; queueIndex += 1) {
        const vertex = queue[queueIndex]!;
        component.push(vertex);
        for (const neighbor of neighbors[vertex]!) {
          if (selectedMask[neighbor] !== 1 || !unseen.delete(neighbor)) continue;
          queue.push(neighbor);
        }
      }
      components.push(component.sort((left, right) => left - right));
    }
    components.sort((left, right) => left[0]! - right[0]!);
    for (const [componentIndex, vertices] of components.entries()) {
      const vertexMask = new Uint8Array(vertexCount);
      for (const vertex of vertices) vertexMask[vertex] = 1;
      const componentTriangleCount = paintedTriangles.filter((triangle) => {
        const offset = triangle * 3;
        return (
          vertexMask[plan.indices[offset]!] === 1 &&
          vertexMask[plan.indices[offset + 1]!] === 1 &&
          vertexMask[plan.indices[offset + 2]!] === 1
        );
      }).length;
      const paintedBoundary = vertices.filter((vertex) =>
        [...neighbors[vertex]!].some(
          (neighbor) => selectedMask[neighbor] === 0,
        ),
      );
      let stableRoots = paintedBoundary;
      if (stableRoots.length === 0) {
        // A fully painted connected piece has no painted/unpainted cut. Use
        // its scalp-side topology band as the protected root instead.
        const minimumDistance = Math.min(
          ...vertices.map((vertex) => plan.topologyDistances[vertex]!),
        );
        const maximumDistance = Math.max(
          ...vertices.map((vertex) => plan.topologyDistances[vertex]!),
        );
        const boundaryLimit =
          minimumDistance +
          Math.max(0.002, (maximumDistance - minimumDistance) * 0.08);
        stableRoots = vertices.filter(
          (vertex) => plan.topologyDistances[vertex]! <= boundaryLimit,
        );
      }
      if (stableRoots.length === 0) stableRoots = [vertices[0]!];

      // Measure inward from every protected boundary vertex, not from the
      // clump's global scalp distance. This guarantees that an unpainted
      // triangle never inherits a moving corner from an adjacent brush mark,
      // while the painted interior still ramps smoothly toward its farthest
      // selected tip.
      const boundaryDistances = new Float64Array(vertexCount);
      boundaryDistances.fill(Infinity);
      const heap = new MinHeap();
      for (const root of stableRoots) {
        boundaryDistances[root] = 0;
        heap.push({ vertex: root, distance: 0 });
      }
      while (heap.size > 0) {
        const current = heap.pop()!;
        if (current.distance !== boundaryDistances[current.vertex]) continue;
        for (const [neighbor, edgeLength] of edgeLengths[current.vertex]!) {
          if (vertexMask[neighbor] !== 1) continue;
          const next = current.distance + edgeLength;
          if (next >= boundaryDistances[neighbor]!) continue;
          boundaryDistances[neighbor] = next;
          heap.push({ vertex: neighbor, distance: next });
        }
      }
      const distanceSpan = Math.max(
        ...vertices.map((vertex) => boundaryDistances[vertex]!),
      );
      if (!Number.isFinite(distanceSpan)) {
        block(
          "UNSAFE_GEOMETRY",
          `painted area ${painted.id} contains unreachable selected topology`,
        );
      }
      const motionRatios = new Float32Array(vertexCount);
      for (const vertex of vertices) {
        const selectedRatio =
          distanceSpan <= 1e-9
            ? 0
            : boundaryDistances[vertex]! / distanceSpan;
        motionRatios[vertex] =
          anchoredLength +
          Math.min(1, Math.max(0, selectedRatio)) * (1 - anchoredLength);
      }
      const pivotVector = averageVertices(plan.positions, stableRoots);
      const tipIndex = [...vertices].sort(
        (left, right) =>
          boundaryDistances[right]! - boundaryDistances[left]! || left - right,
      )[0]!;
      const tipOffset = tipIndex * 3;
      const tipVector = new THREE.Vector3(
        plan.positions[tipOffset],
        plan.positions[tipOffset + 1],
        plan.positions[tipOffset + 2],
      );
      const length = pivotVector.distanceTo(tipVector);
      const supportsMotion =
        componentTriangleCount >= 2 &&
        distanceSpan >= SECONDARY_MOTION_MIN_REST_LENGTH_METERS &&
        length >= SECONDARY_MOTION_MIN_REST_LENGTH_METERS &&
        length <= SECONDARY_MOTION_MAX_REST_LENGTH_METERS;
      const componentSuffix =
        components.length > 1
          ? `:part-${String(componentIndex + 1).padStart(3, "0")}`
          : "";
      const meshSuffix = painted.meshes.length === 1 ? "" : ` · ${meshNode}`;
      const partSuffix =
        components.length > 1 ? ` · part ${componentIndex + 1}` : "";
      regions.push({
        id: `${plan.review.id}:paint:${painted.id}${componentSuffix}`,
        label: `${painted.label}${meshSuffix}${partSuffix}`,
        vertices,
        vertexMask,
        rootIndices: stableRoots,
        tipIndex,
        pivot: tuple(pivotVector),
        tip: tuple(tipVector),
        length,
        motionRatios,
        moving: painted.enabled && supportsMotion,
        recommendedMoving: painted.enabled && supportsMotion,
        supportsMotion,
        explanation: !supportsMotion
          ? "This painted detail remains anchored because it has less than 5 mm of stable interior beyond its protected paint boundary."
          : painted.enabled
            ? "This user-painted area moves. Batshit keeps its unpainted base fixed and ramps motion smoothly from the painted boundary toward the farthest selected tip."
            : "This user-painted area is currently turned off and remains attached.",
        motionNode: null,
        dynamicJointSlot: null,
      });
    }
  }
  return regions.sort((left, right) => left.id.localeCompare(right.id));
}

function applyMotionRegionSelections(
  plans: ClumpPlan[],
  selections: HairImportMotionRegionSelection[] | undefined,
) {
  const regions = plans.flatMap((plan) => plan.motionRegions);
  if (regions.length > 254) {
    block("AMBIGUOUS_CLUMP", "Hair motion proposal exceeds 254 selectable regions");
  }
  if (!selections) return;
  const byId = new Map<string, boolean>();
  for (const selection of selections) {
    stableId(selection.id, "motion region selection id");
    if (typeof selection.moving !== "boolean") {
      block("INVALID_MOTION", `motion region ${selection.id}.moving must be boolean`);
    }
    if (byId.has(selection.id)) {
      block("INVALID_MOTION", `motion region ${selection.id} is selected twice`);
    }
    byId.set(selection.id, selection.moving);
  }
  const expected = regions.map((region) => region.id).sort();
  const received = [...byId.keys()].sort();
  if (
    expected.length !== received.length ||
    expected.some((id, index) => id !== received[index])
  ) {
    block("INVALID_MOTION", "motion region review must match the exact current proposal");
  }
  for (const region of regions) {
    const moving = byId.get(region.id)!;
    if (moving && !region.supportsMotion) {
      block(
        "INVALID_MOTION",
        `motion region ${region.id} is too short to support a stable motion chain`,
      );
    }
    region.moving = moving;
  }
}

function averageVertices(
  positions: Float64Array,
  indices: number[],
): THREE.Vector3 {
  const output = new THREE.Vector3();
  for (const index of indices) {
    const offset = index * 3;
    output.add(
      new THREE.Vector3(
        positions[offset],
        positions[offset + 1],
        positions[offset + 2],
      ),
    );
  }
  return output.multiplyScalar(1 / indices.length);
}

function smoothDelta(plan: ClumpPlan, source: Float32Array): Float32Array {
  const neighbors = Array.from(
    { length: source.length / 3 },
    () => [] as number[],
  );
  for (const edge of plan.edges) {
    neighbors[edge.left]!.push(edge.right);
    neighbors[edge.right]!.push(edge.left);
  }
  const weldCoincidentDeltas = (values: Float32Array) => {
    for (const group of plan.coincidentGroups) {
      for (let component = 0; component < 3; component += 1) {
        const average =
          group.reduce(
            (sum, vertex) => sum + values[vertex * 3 + component]!,
            0,
          ) / group.length;
        for (const vertex of group) values[vertex * 3 + component] = average;
      }
    }
    return values;
  };
  let current = weldCoincidentDeltas(source.slice());
  for (let iteration = 0; iteration < 12; iteration += 1) {
    const next = current.slice();
    for (let vertex = 0; vertex < neighbors.length; vertex += 1) {
      const adjacent = neighbors[vertex]!;
      if (adjacent.length === 0) continue;
      const blend = 0.55 * smoothstep((plan.tipRatios[vertex]! - 0.15) / 0.85);
      for (let component = 0; component < 3; component += 1) {
        const average =
          adjacent.reduce(
            (sum, neighbor) => sum + current[neighbor * 3 + component]!,
            0,
          ) / adjacent.length;
        const offset = vertex * 3 + component;
        next[offset] = current[offset]! * (1 - blend) + average * blend;
      }
    }
    // OBJ face corners and GLB UV/normal seams may be distinct vertices at
    // one exact physical position. Smoothing their different triangle
    // neighborhoods independently opens visible cracks in follower poses, so
    // every iteration must collapse the generated displacement back to one
    // shared seam value.
    current = weldCoincidentDeltas(next);
  }
  return current;
}

function dialState(
  manifest: AppearanceDialsManifest,
  neutralValues: Record<string, number>,
  values: Record<string, number>,
): AppearanceDialValueState {
  return {
    contract: APPEARANCE_DIAL_VALUES_CONTRACT,
    definitionSha256: manifest.definitionSha256,
    neutralId: manifest.neutral.id,
    neutralRecipeSha256: manifest.neutral.recipeSha256,
    values: { ...neutralValues, ...values },
    unlockedDialIds: [],
  };
}

function targetName(driver: HairImportFollowerDriverInput): string {
  const endpoint = String(Math.abs(driver.endpoint)).replace(".", "_");
  return `HairFollower_${driver.dialId.replace(/[^A-Za-z0-9_]/g, "_")}_${
    driver.endpoint < 0 ? "negative" : "positive"
  }_${endpoint}`;
}

function generatedRiskScenarios(drivers: HairImportFollowerDriverInput[]) {
  const candidates: Array<Record<string, number>> = [];
  for (const driver of drivers) {
    for (const factor of [1, 0.75, 0.5, 0.25]) {
      candidates.push({ [driver.dialId]: round(driver.endpoint * factor) });
    }
  }
  for (let left = 0; left < drivers.length; left += 1) {
    for (let right = left + 1; right < drivers.length; right += 1) {
      const first = drivers[left]!;
      const second = drivers[right]!;
      if (first.dialId === second.dialId) continue;
      candidates.push({
        [first.dialId]: first.endpoint,
        [second.dialId]: second.endpoint,
      });
    }
  }
  const unique = new Map(
    candidates.map((values) => [canonicalRecipeString(values), values]),
  );
  const values = [...unique.values()].slice(0, 96);
  if (values.length < 8)
    block(
      "INSUFFICIENT_RISK_COVERAGE",
      "follower drivers produce fewer than eight risk states",
    );
  return values.map((entry, index) => ({
    id: `HairImport_Risk_${String(index + 1).padStart(2, "0")}`,
    values: entry,
  }));
}

function validateFit(input: HairImportAuthoringInput["fit"]): THREE.Matrix4 {
  const authored = matrix(input.authoredRootMatrix, "fit.authoredRootMatrix");
  const minimum = positive(input.minimumScale, "fit.minimumScale");
  const maximum = positive(input.maximumScale, "fit.maximumScale");
  const maximumRatio = positive(
    input.maximumAxisScaleRatio,
    "fit.maximumAxisScaleRatio",
  );
  if (minimum >= maximum || maximumRatio < 1 || maximumRatio > 4) {
    block(
      "INVALID_FIT",
      "fit scale bounds are inconsistent or exceed the supported correction range",
    );
  }
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  authored.decompose(position, quaternion, scale);
  const components = [Math.abs(scale.x), Math.abs(scale.y), Math.abs(scale.z)];
  if (components.some((entry) => entry < minimum || entry > maximum)) {
    block(
      "INVALID_FIT",
      `reviewed fit scale must remain between ${minimum} and ${maximum}`,
    );
  }
  if (Math.max(...components) / Math.min(...components) > maximumRatio) {
    block(
      "INVALID_FIT",
      `reviewed per-axis correction exceeds ratio ${maximumRatio}`,
    );
  }
  return authored;
}

function identityTransform(node: SemanticJsonRecord, context: string): void {
  const resolved = resolveSemanticGlbNodeTransform(node, context, {
    diagnosticPrefix: HAIR_IMPORT_AUTHORING_CONTRACT,
  });
  const identity = new THREE.Matrix4();
  const drift = Math.max(
    ...resolved.matrix.map((entry, index) =>
      Math.abs(entry - identity.elements[index]!),
    ),
  );
  if (drift > 1e-7) {
    block(
      "UNSAFE_GEOMETRY",
      `${context} must be flattened to identity under the canonical Hair root before authoring`,
    );
  }
}

function tuning(length: number, review: HairImportClumpReviewInput) {
  const factor = Math.min(1, Math.max(0, (length - 0.06) / 0.3));
  const proposed = {
    stiffness: 72 - factor * 30,
    damping: 12 - factor * 3,
    drag: 0.008,
    gravityScale: 0.025 + factor * 0.045,
    maxAngleRadians: 0.18 + factor * 0.22,
    collisionRadius: 0.007 + factor * 0.004,
    ...review.tuning,
  };
  Object.entries(proposed).forEach(([key, value]) =>
    finite(value, `clump ${review.id}.${key}`),
  );
  return Object.fromEntries(
    Object.entries(proposed).map(([key, value]) => [key, round(value)]),
  ) as {
    stiffness: number;
    damping: number;
    drag: number;
    gravityScale: number;
    maxAngleRadians: number;
    collisionRadius: number;
  };
}

function appendAuthoredGeometry(
  source: SemanticGlbDocument,
  rootNodeIndex: number,
  plans: ClumpPlan[],
  names: string[],
  motion: HairImportAuthoringInput["motion"],
): {
  bytes: Uint8Array;
  anchoredVertexCount: number;
  fullyDynamicVertexCount: number;
  motionNodes: string[];
} {
  const gltf = cloneJson(source.gltf) as SemanticGltfRecord;
  const nodes = (gltf.nodes ?? []) as SemanticJsonRecord[];
  const meshes = (gltf.meshes ?? []) as SemanticJsonRecord[];
  const accessors = (gltf.accessors ?? []) as SemanticJsonRecord[];
  const bufferViews = (gltf.bufferViews ?? []) as SemanticJsonRecord[];
  const binaryParts: Array<{ offset: number; bytes: Uint8Array }> = [
    { offset: 0, bytes: source.binary },
  ];
  let binaryLength = source.binary.byteLength;
  const append = (
    bytes: Uint8Array,
    componentType: number,
    count: number,
    type: "SCALAR" | "VEC3" | "VEC4" | "MAT4",
    target?: number,
    min?: number[],
    max?: number[],
  ) => {
    const offset = align4(binaryLength);
    binaryParts.push({ offset, bytes });
    binaryLength = offset + bytes.byteLength;
    const bufferView = bufferViews.length;
    bufferViews.push({
      buffer: 0,
      byteOffset: offset,
      byteLength: bytes.byteLength,
      ...(target === undefined ? {} : { target }),
    });
    const accessor = accessors.length;
    accessors.push({
      bufferView,
      componentType,
      count,
      type,
      ...(min ? { min } : {}),
      ...(max ? { max } : {}),
    });
    return accessor;
  };
  const asBytes = (value: ArrayBufferView) =>
    new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
  const root = nodes[rootNodeIndex]!;
  const children = array(
    root.children ?? [],
    `gltf.nodes[${rootNodeIndex}].children`,
  ).map((entry) => integer(entry, `gltf.nodes[${rootNodeIndex}].children`));
  const motionNodes: string[] = [];
  const motionNodeIndices: number[] = [];
  let anchoredVertexCount = 0;
  let fullyDynamicVertexCount = 0;
  const movingRegions = plans.flatMap((plan) =>
    plan.motionRegions.filter((region) => region.moving),
  );
  const inverseBinds = new Float32Array((movingRegions.length + 1) * 16);
  for (let slot = 0; slot <= movingRegions.length; slot += 1) {
    inverseBinds[slot * 16] = 1;
    inverseBinds[slot * 16 + 5] = 1;
    inverseBinds[slot * 16 + 10] = 1;
    inverseBinds[slot * 16 + 15] = 1;
  }
  let nextJointSlot = 1;
  for (const plan of plans) {
    const mesh = meshes[plan.meshIndex]!;
    const primitive = record(
      array(mesh.primitives, `gltf.meshes[${plan.meshIndex}].primitives`)[0],
      `gltf.meshes[${plan.meshIndex}].primitives[0]`,
    );
    const attributes = record(
      primitive.attributes,
      `gltf.meshes[${plan.meshIndex}].attributes`,
    );
    const positionMinimum = [Infinity, Infinity, Infinity];
    const positionMaximum = [-Infinity, -Infinity, -Infinity];
    for (let offset = 0; offset < plan.positions.length; offset += 3) {
      for (let component = 0; component < 3; component += 1) {
        positionMinimum[component] = Math.min(
          positionMinimum[component]!,
          plan.positions[offset + component]!,
        );
        positionMaximum[component] = Math.max(
          positionMaximum[component]!,
          plan.positions[offset + component]!,
        );
      }
    }
    const authoredPositions = Float32Array.from(plan.positions);
    attributes.POSITION = append(
      asBytes(authoredPositions),
      5126,
      plan.positions.length / 3,
      "VEC3",
      34962,
      positionMinimum,
      positionMaximum,
    );
    mesh.extras = {
      ...(mesh.extras && typeof mesh.extras === "object" ? mesh.extras : {}),
      targetNames: names,
    };
    primitive.targets = plan.targetDeltas.map((delta) => {
      const minimum = [Infinity, Infinity, Infinity];
      const maximum = [-Infinity, -Infinity, -Infinity];
      for (let offset = 0; offset < delta.length; offset += 3) {
        for (let component = 0; component < 3; component += 1) {
          minimum[component] = Math.min(
            minimum[component]!,
            delta[offset + component]!,
          );
          maximum[component] = Math.max(
            maximum[component]!,
            delta[offset + component]!,
          );
        }
      }
      return {
        POSITION: append(
          asBytes(delta),
          5126,
          delta.length / 3,
          "VEC3",
          34962,
          minimum,
          maximum,
        ),
      };
    });
    const meshNodeName = stableText(
      nodes[plan.nodeIndex]!.name,
      `Hair mesh ${plan.nodeIndex}.name`,
    );
    const movingRegionsForPlan = plan.motionRegions.filter(
      (region) => region.moving,
    );
    for (const region of movingRegionsForPlan) {
      const motionNodeName = `${semanticGlbRuntimeNodeName(meshNodeName)}__Motion_${String(nextJointSlot).padStart(3, "0")}`;
      if (
        source.rawNodeByName.has(motionNodeName) ||
        source.runtimeNodeByName.has(motionNodeName) ||
        motionNodes.includes(motionNodeName)
      ) {
        block(
          "AMBIGUOUS_CLUMP",
          `generated motion node ${motionNodeName} collides with source Hair`,
        );
      }
      const motionNodeIndex = nodes.length;
      region.motionNode = motionNodeName;
      region.dynamicJointSlot = nextJointSlot;
      nodes.push({
        name: motionNodeName,
        translation: region.pivot,
        extras: {
          [ROOT_WEIGHTED_TAG]: {
            contract: HAIR_ROOT_WEIGHTED_MOTION_CONTRACT,
            meshNode: meshNodeName,
            tipAttribute: HAIR_ROOT_WEIGHTED_TIP_ATTRIBUTE,
            dynamicJointSlot: nextJointSlot,
            anchoredLength: motion.anchoredLength,
            weightCurve: HAIR_MOTION_WEIGHT_CURVE,
            defaultEnabled: true,
            defaultIntensity: motion.defaultIntensity,
          },
        },
      });
      children.push(motionNodeIndex);
      motionNodeIndices.push(motionNodeIndex);
      motionNodes.push(motionNodeName);
      const inverseOffset = nextJointSlot * 16;
      inverseBinds[inverseOffset + 12] = -region.pivot[0];
      inverseBinds[inverseOffset + 13] = -region.pivot[1];
      inverseBinds[inverseOffset + 14] = -region.pivot[2];
      nextJointSlot += 1;
    }

    if (movingRegionsForPlan.length === 0) {
      // A fully static source object must remain an ordinary rigid child of
      // HairImportRoot. Assigning the shared skin without an owned motion
      // segment leaves no runtime rebind owner and can shift the accepted fit.
      delete attributes.JOINTS_0;
      delete attributes.WEIGHTS_0;
      delete attributes._BATSHAIR_TIP;
      delete nodes[plan.nodeIndex]!.skin;
      anchoredVertexCount += plan.tipRatios.length;
      continue;
    }

    const joints = new Uint8Array(plan.tipRatios.length * 4);
    const weights = new Float32Array(plan.tipRatios.length * 4);
    const authoredTipWeights = new Float32Array(plan.tipRatios.length);
    const movingRegionByVertex = new Int16Array(plan.tipRatios.length);
    movingRegionByVertex.fill(-1);
    for (const [regionIndex, region] of plan.motionRegions.entries()) {
      if (!region.moving) continue;
      for (const vertex of region.vertices) movingRegionByVertex[vertex] = regionIndex;
    }
    for (let vertex = 0; vertex < plan.tipRatios.length; vertex += 1) {
      const regionIndex = movingRegionByVertex[vertex]!;
      const region = regionIndex >= 0 ? plan.motionRegions[regionIndex]! : null;
      const ratio = region?.motionRatios[vertex] ?? 0;
      const dynamicWeight = region
        ? smoothstep(
            (ratio - motion.anchoredLength) /
              Math.max(1 - motion.anchoredLength, 1e-6),
          )
        : 0;
      const offset = vertex * 4;
      joints[offset + 1] = region?.dynamicJointSlot ?? 0;
      weights[offset] = 1 - dynamicWeight;
      weights[offset + 1] = dynamicWeight;
      authoredTipWeights[vertex] = dynamicWeight;
      if (dynamicWeight <= 1e-7) anchoredVertexCount += 1;
      if (dynamicWeight >= 1 - 1e-7) fullyDynamicVertexCount += 1;
    }
    attributes.JOINTS_0 = append(
      asBytes(joints),
      5121,
      plan.tipRatios.length,
      "VEC4",
      34962,
    );
    attributes.WEIGHTS_0 = append(
      asBytes(weights),
      5126,
      plan.tipRatios.length,
      "VEC4",
      34962,
    );
    attributes._BATSHAIR_TIP = append(
      asBytes(authoredTipWeights),
      5126,
      plan.tipRatios.length,
      "SCALAR",
      34962,
    );
    nodes[plan.nodeIndex]!.skin = 0;
  }
  if (anchoredVertexCount === 0 || fullyDynamicVertexCount === 0) {
    block(
      "UNSAFE_WEIGHTS",
      "authoring did not produce both anchored roots and fully dynamic tips",
    );
  }
  root.children = children;
  const inverseBindAccessor = append(
    asBytes(inverseBinds),
    5126,
    movingRegions.length + 1,
    "MAT4",
  );
  gltf.skins = [
    {
      name: `${semanticGlbRuntimeNodeName(stableText(root.name, "Hair root name"))}_RootWeightedSkin`,
      skeleton: rootNodeIndex,
      joints: [rootNodeIndex, ...motionNodeIndices],
      inverseBindMatrices: inverseBindAccessor,
    },
  ];
  gltf.asset = {
    version: "2.0",
    generator: "Batshit generic Hair import author v2",
  };
  gltf.nodes = nodes;
  gltf.meshes = meshes;
  gltf.accessors = accessors;
  gltf.bufferViews = bufferViews;
  const binary = new Uint8Array(binaryLength);
  for (const part of binaryParts) binary.set(part.bytes, part.offset);
  gltf.buffers = [{ byteLength: binary.byteLength }];
  return {
    bytes: writeDeterministicSemanticGlb(gltf, binary, {
      diagnosticPrefix: HAIR_IMPORT_AUTHORING_CONTRACT,
    }),
    anchoredVertexCount,
    fullyDynamicVertexCount,
    motionNodes,
  };
}

function segmentDrivers(
  plan: ClumpPlan,
  region: MotionRegionPlan,
  drivers: HairImportFollowerDriverInput[],
) {
  return plan.targetDeltas.map(
    (delta, targetIndex): SecondaryMotionSegmentDriverV1 => {
      const pivotDelta = averageVertices(
        Float64Array.from(delta),
        region.rootIndices,
      );
      const tipOffset = region.tipIndex * 3;
      return {
        kind: "dial-endpoint",
        dialId: drivers[targetIndex]!.dialId,
        endpoint: drivers[targetIndex]!.endpoint,
        pivotDelta: tuple(pivotDelta),
        tipDelta: [
          round(delta[tipOffset]!),
          round(delta[tipOffset + 1]!),
          round(delta[tipOffset + 2]!),
        ],
      };
    },
  );
}

function buildSecondaryMotion(
  input: HairImportAuthoringInput,
  manifest: AppearanceDialsManifest,
  recipe: SemanticGlbDocument,
  geometrySha256: string,
  plans: ClumpPlan[],
): SecondaryMotionDefinitionV1 {
  const colliders = input.colliders.map((source) => {
    stableId(source.id, "collider.id");
    stableId(source.group, `collider ${source.id}.group`);
    const sourceNode =
      source.manifestNodeId !== undefined
        ? (() => {
            const declaration = manifest.nodes[source.manifestNodeId];
            if (!declaration) {
              block(
                "INVALID_COLLIDER",
                `collider ${source.id} references missing appearance manifest node ${source.manifestNodeId}`,
              );
            }
            return declaration.node;
          })()
        : stableText(source.node, `collider ${source.id}.node`);
    resolveSemanticGlbNode(
      recipe,
      sourceNode,
      `collider ${source.id} Recipe node`,
    );
    const offset = vec3(source.offset, `collider ${source.id}.offset`);
    const tailOffset = vec3(
      source.tailOffset,
      `collider ${source.id}.tailOffset`,
    );
    const radius = positive(source.radius, `collider ${source.id}.radius`);
    if (
      radius < 0.003 ||
      radius > 0.5 ||
      [...offset, ...tailOffset].some((entry) => Math.abs(entry) > 5)
    ) {
      block(
        "INVALID_COLLIDER",
        `collider ${source.id} exceeds bounded geometry limits`,
      );
    }
    const drivers = (source.drivers ?? []).map((driver) => {
      const dial = manifest.dials.find((entry) => entry.id === driver.dialId);
      if (
        !dial ||
        driver.endpoint === 0 ||
        driver.endpoint < dial.range[0] ||
        driver.endpoint > dial.range[1]
      ) {
        block(
          "INVALID_COLLIDER",
          `collider ${source.id} driver ${driver.dialId}:${driver.endpoint} is invalid`,
        );
      }
      return cloneJson(driver);
    });
    return {
      id: source.id,
      group: source.group,
      shape: source.shape,
      node: semanticGlbRuntimeNodeName(sourceNode),
      offset,
      tailOffset,
      radius,
      drivers,
    };
  });
  if (colliders.length === 0)
    block("INVALID_COLLIDER", "at least one reviewed collider is required");
  const availableGroups = new Set(colliders.map((entry) => entry.group));
  const chains = plans.flatMap((plan) => {
    const groups = plan.review.collisionGroups.map((entry) =>
      stableId(entry, `clump ${plan.review.id} group`),
    );
    if (
      groups.length === 0 ||
      groups.some((entry) => !availableGroups.has(entry))
    ) {
      block(
        "INVALID_COLLIDER",
        `clump ${plan.review.id} references a missing collider group`,
      );
    }
    return plan.motionRegions
      .filter((region) => region.moving)
      .map((region) => {
        if (!region.motionNode) {
          block("INVALID_MOTION", `moving region ${region.id} has no authored motion node`);
        }
        return {
          id: `Hair_${region.id}`,
          segments: [
            {
              node: region.motionNode,
              pivot: region.pivot,
              tip: region.tip,
              ...tuning(region.length, plan.review),
              collisionGroups: [...new Set(groups)],
              drivers: segmentDrivers(plan, region, input.followerDrivers),
            },
          ],
        };
      });
  });
  return parseSecondaryMotionDefinition({
    contract: SECONDARY_MOTION_CONTRACT,
    owner: {
      kind: "hair",
      assetId: input.owner.assetId,
      revisionId: input.owner.revisionId,
      geometrySha256,
      fitFamily: input.owner.fitFamily,
      appearanceDefinitionSha256: manifest.definitionSha256,
    },
    chainSpace: "asset-root-rest",
    colliderSpace: "node-local-rest",
    simulation: {
      fixedStepSeconds: input.motion.fixedStepSeconds,
      maxSubsteps: input.motion.maxSubsteps,
      interruptionResetSeconds: input.motion.interruptionResetSeconds,
      gravity: input.motion.gravity,
      collisionIterations: input.motion.collisionIterations,
    },
    chains,
    colliders,
    stressMatrix: {
      contract: SECONDARY_MOTION_STRESS_MATRIX_CONTRACT,
      scenarios: [
        { id: "idle", durationSeconds: 2 },
        { id: "head-turn", durationSeconds: 3 },
        { id: "walk-dance", durationSeconds: 5 },
        { id: "bend", durationSeconds: 3 },
        { id: "interruption", durationSeconds: 1 },
      ],
      thresholds: {
        maximumStretchRatio: 1.03,
        maximumColliderPenetration: 0.003,
        maximumSettleSeconds: 2.5,
      },
    },
  });
}

export async function authorHairImportProposal(
  input: HairImportAuthoringInput,
): Promise<HairImportAuthoringResult> {
  stableId(input.owner.assetId, "owner.assetId");
  stableId(input.owner.revisionId, "owner.revisionId");
  stableId(input.owner.fitFamily, "owner.fitFamily");
  const rootBounds = bounds(input.scalp.rootBounds, "scalp.rootBounds");
  const transferBounds = bounds(
    input.scalp.transferBounds,
    "scalp.transferBounds",
  );
  const rootSeedFraction = finite(
    input.scalp.rootSeedFraction,
    "scalp.rootSeedFraction",
  );
  if (rootSeedFraction < 0.01 || rootSeedFraction > 0.25) {
    block(
      "INVALID_SCALP",
      "scalp.rootSeedFraction must remain between 0.01 and 0.25",
    );
  }
  const maximumRootDistance = positive(
    input.scalp.maximumRootDistance,
    "scalp.maximumRootDistance",
  );
  if (maximumRootDistance > 0.25)
    block("INVALID_SCALP", "maximum root distance may not exceed 25 cm");
  const anchoredLength = finite(
    input.motion.anchoredLength ?? HAIR_MOTION_DEFAULT_ANCHORED_LENGTH,
    "motion.anchoredLength",
  );
  const defaultIntensity = finite(
    input.motion.defaultIntensity ?? HAIR_MOTION_DEFAULT_INTENSITY,
    "motion.defaultIntensity",
  );
  if (
    anchoredLength < HAIR_MOTION_ANCHORED_LENGTH_MIN ||
    anchoredLength > HAIR_MOTION_ANCHORED_LENGTH_MAX ||
    defaultIntensity < 0 ||
    defaultIntensity > 1.5
  ) {
    block(
      "INVALID_MOTION",
      "anchored length or default intensity is outside safe bounds",
    );
  }
  const authoredRootMatrix = validateFit(input.fit);
  const manifest = parseAppearanceDialsManifest(input.appearanceManifest);
  if (!manifest)
    block(
      "INVALID_RECIPE_SOURCE",
      "avatar manifest is missing appearance-dials/v2",
    );
  const bodyDeclaration = manifest.nodes[input.recipeNodes.bodyManifestNodeId];
  if (
    !bodyDeclaration ||
    bodyDeclaration.kind !== "mesh" ||
    bodyDeclaration.role !== "body"
  ) {
    block(
      "INVALID_RECIPE_SOURCE",
      "reviewed body node id does not resolve to the manifest body mesh role",
    );
  }
  const declaredHeadRigNode = recipeHeadAnchor(input.appearanceManifest);
  if (input.recipeNodes.headRigNode !== declaredHeadRigNode) {
    block(
      "INVALID_RECIPE_SOURCE",
      `reviewed head rig node must equal avatar.json#rig.performance.nodes.head.node (${declaredHeadRigNode})`,
    );
  }
  const hair = parseSemanticGlb(input.canonicalHairGlb, {
    diagnosticPrefix: HAIR_IMPORT_AUTHORING_CONTRACT,
  });
  const recipe = parseSemanticGlb(input.recipeSourceGlb, {
    diagnosticPrefix: `${HAIR_IMPORT_AUTHORING_CONTRACT}:recipe`,
  });
  if (hair.skins.length !== 0)
    block(
      "UNSAFE_GEOMETRY",
      "canonical Hair input must not already contain skins",
    );
  const rootNodeIndex = resolveSemanticGlbNode(
    hair,
    HAIR_IMPORT_CANONICAL_ROOT_NODE,
    "canonical Hair root",
  );
  const scenes = array(hair.gltf.scenes, "Hair gltf.scenes");
  const sceneIndex = integer(hair.gltf.scene ?? 0, "Hair gltf.scene");
  const scene = record(scenes[sceneIndex], `Hair gltf.scenes[${sceneIndex}]`);
  const sceneRoots = array(
    scene.nodes,
    `Hair gltf.scenes[${sceneIndex}].nodes`,
  ).map((entry) => integer(entry, `Hair gltf.scenes[${sceneIndex}].nodes`));
  if (sceneRoots.length !== 1 || sceneRoots[0] !== rootNodeIndex) {
    block(
      "AMBIGUOUS_ROOT",
      "reviewed Hair root must be the single active-scene root",
    );
  }
  const meshNodes = hair.nodes
    .map((node, index) => ({ node, index }))
    .filter((entry) => entry.node.mesh !== undefined);
  if (meshNodes.length === 0 || meshNodes.length > 254) {
    block(
      "UNSAFE_GEOMETRY",
      "canonical Hair must contain one to 254 mesh clumps",
    );
  }
  if (input.clumps.length !== meshNodes.length) {
    block(
      "UNREVIEWED_CLUMP",
      "every canonical Hair mesh must have exactly one reviewed clump record",
    );
  }
  const clumpByNode = new Map<string, HairImportClumpReviewInput>();
  for (const clump of input.clumps) {
    stableId(clump.id, "clump.id");
    stableText(clump.meshNode, `clump ${clump.id}.meshNode`);
    if (
      !Number.isSafeInteger(clump.maximumConnectedComponents) ||
      clump.maximumConnectedComponents < 1 ||
      clump.maximumConnectedComponents > 8
    ) {
      block(
        "INVALID_INPUT",
        `clump ${clump.id}.maximumConnectedComponents must be one to eight`,
      );
    }
    if (clumpByNode.has(clump.meshNode))
      block("UNREVIEWED_CLUMP", `mesh ${clump.meshNode} is reviewed twice`);
    clumpByNode.set(clump.meshNode, clump);
  }
  const bodyNodeIndex = resolveSemanticGlbNode(
    recipe,
    bodyDeclaration.node,
    "manifest body node",
  );
  const headNodeIndex = resolveSemanticGlbNode(
    recipe,
    input.recipeNodes.headRigNode,
    "manifest stage head rig node",
  );
  const basis = buildAppearanceRecipePhysicalBasisFromGlb(
    input.recipeSourceGlb,
    input.appearanceManifest,
  );
  const neutralResolved = resolveAppearanceDialState(manifest, null);
  const reviewedResolved = resolveAppearanceDialState(
    manifest,
    input.reviewedAppearanceState,
  );
  const neutralEvaluation = evaluateAppearanceRecipePhysicalOutput(
    basis,
    neutralResolved,
  );
  const reviewedEvaluation = evaluateAppearanceRecipePhysicalOutput(
    basis,
    reviewedResolved,
  );
  const bodyBasis = basis.meshes.filter(
    (entry) => entry.nodeId === `node:${bodyNodeIndex}`,
  );
  if (bodyBasis.length !== 1) {
    block(
      "INVALID_RECIPE_SOURCE",
      "manifest body role must resolve to exactly one physical mesh primitive",
    );
  }
  const bodyNeutralMesh = neutralEvaluation.meshes.find(
    (entry) => entry.id === bodyBasis[0]!.id,
  );
  if (!bodyNeutralMesh)
    block(
      "INVALID_RECIPE_SOURCE",
      "neutral Recipe evaluation omitted the body mesh",
    );
  const bodyNeutral = transformPositions(
    bodyNeutralMesh.positions,
    evaluationMatrix(neutralEvaluation, bodyNodeIndex, "body"),
  );
  const bodyReviewedMesh = reviewedEvaluation.meshes.find(
    (entry) => entry.id === bodyBasis[0]!.id,
  );
  if (!bodyReviewedMesh)
    block(
      "INVALID_RECIPE_SOURCE",
      "reviewed Recipe evaluation omitted the body mesh",
    );
  const bodyReviewed = transformPositions(
    bodyReviewedMesh.positions,
    evaluationMatrix(reviewedEvaluation, bodyNodeIndex, "reviewed body"),
  );
  const rootCandidates: number[] = [];
  const transferCandidates: number[] = [];
  for (let vertex = 0; vertex < bodyNeutral.length / 3; vertex += 1) {
    if (inBounds(bodyReviewed, vertex, rootBounds)) rootCandidates.push(vertex);
    if (inBounds(bodyReviewed, vertex, transferBounds))
      transferCandidates.push(vertex);
  }
  if (rootCandidates.length < 4 || transferCandidates.length < 4) {
    block(
      "SPARSE_SCALP",
      "reviewed scalp bounds contain fewer than four Recipe body vertices",
    );
  }
  const rootNeighborIndex = new BodyNeighborIndex(bodyReviewed, rootCandidates);
  const transferNeighborIndex = new BodyNeighborIndex(
    bodyReviewed,
    transferCandidates,
  );
  const neutralAttachment = evaluationMatrix(
    neutralEvaluation,
    headNodeIndex,
    "head",
  ).multiply(authoredRootMatrix);
  const plans: ClumpPlan[] = [];
  for (const { node, index: nodeIndex } of meshNodes) {
    const rawName = stableText(node.name, `Hair node ${nodeIndex}.name`);
    const runtimeName = semanticGlbRuntimeNodeName(rawName);
    const review = clumpByNode.get(rawName) ?? clumpByNode.get(runtimeName);
    if (!review)
      block(
        "UNREVIEWED_CLUMP",
        `Hair mesh ${rawName} has no reviewed clump record`,
      );
    if (hair.parents.get(nodeIndex) !== rootNodeIndex) {
      block(
        "UNSAFE_GEOMETRY",
        `Hair mesh ${rawName} must be a direct child of the reviewed Hair root`,
      );
    }
    identityTransform(node, `Hair mesh ${rawName}`);
    const decoded = decodedPositions(hair, nodeIndex);
    const rootPositions = Float64Array.from(decoded.positions);
    const rootDistances = new Float64Array(decoded.positions.length / 3);
    const nearest: NearestBody[] = [];
    for (let vertex = 0; vertex < rootDistances.length; vertex += 1) {
      const rootMatch = nearestBody(rootPositions, vertex, rootNeighborIndex);
      const transferMatch = nearestBody(
        rootPositions,
        vertex,
        transferNeighborIndex,
      );
      rootDistances[vertex] = rootMatch.distance;
      nearest.push(transferMatch.transfer);
    }
    const topologyResult = topology(
      decoded.positions,
      decoded.indices,
      rootDistances,
      rootSeedFraction,
      review.maximumConnectedComponents,
    );
    const clumpRootDistance = Math.max(
      ...topologyResult.rootIndices.map((vertex) => rootDistances[vertex]!),
    );
    if (clumpRootDistance > maximumRootDistance) {
      block(
        "ROOT_TOO_FAR",
        `clump ${review.id} root is ${round(clumpRootDistance)} m from the reviewed scalp; maximum is ${maximumRootDistance} m`,
      );
    }
    const pivotVector = averageVertices(
      decoded.positions,
      topologyResult.rootIndices,
    );
    const tipCandidates = Array.from(topologyResult.ratios)
      .map((ratio, vertex) => ({ ratio, vertex }))
      .filter((entry) => entry.ratio >= 0.95)
      .sort((left, right) => {
        const leftOffset = left.vertex * 3;
        const rightOffset = right.vertex * 3;
        const leftDistance = pivotVector.distanceTo(
          new THREE.Vector3(
            decoded.positions[leftOffset],
            decoded.positions[leftOffset + 1],
            decoded.positions[leftOffset + 2],
          ),
        );
        const rightDistance = pivotVector.distanceTo(
          new THREE.Vector3(
            decoded.positions[rightOffset],
            decoded.positions[rightOffset + 1],
            decoded.positions[rightOffset + 2],
          ),
        );
        return rightDistance - leftDistance || left.vertex - right.vertex;
      });
    const tipIndex = tipCandidates[0]?.vertex;
    if (tipIndex === undefined)
      block("AMBIGUOUS_TIP", `clump ${review.id} has no stable tip candidate`);
    const tipOffset = tipIndex * 3;
    const tipVector = new THREE.Vector3(
      decoded.positions[tipOffset],
      decoded.positions[tipOffset + 1],
      decoded.positions[tipOffset + 2],
    );
    const length = pivotVector.distanceTo(tipVector);
    if (
      length < SECONDARY_MOTION_MIN_REST_LENGTH_METERS ||
      length > SECONDARY_MOTION_MAX_REST_LENGTH_METERS
    ) {
      block(
        "AMBIGUOUS_TIP",
        `clump ${review.id} proposed length is outside 5 mm to 2 m`,
      );
    }
    const plan: ClumpPlan = {
      review,
      nodeIndex,
      meshIndex: decoded.meshIndex,
      primitive: decoded.primitive,
      positions: decoded.positions,
      indices: decoded.indices,
      nearestBody: nearest,
      tipRatios: topologyResult.ratios,
      topologyDistances: topologyResult.distances,
      rootIndices: topologyResult.rootIndices,
      tipIndex,
      pivot: tuple(pivotVector),
      tip: tuple(tipVector),
      length,
      componentCount: topologyResult.componentCount,
      anchoredMicroComponentCount: topologyResult.anchoredMicroComponentCount,
      anchoredMicroVertexCount: topologyResult.anchoredMicroVertexCount,
      maximumRootDistance: clumpRootDistance,
      edges: topologyResult.edges,
      coincidentGroups: topologyResult.coincidentGroups,
      targetDeltas: [],
      motionRegions: [],
    };
    plans.push(plan);
  }
  if (input.motion.paint && input.motion.regionSelections) {
    block(
      "INVALID_MOTION_PAINT",
      "painted Hair areas and automatic region decisions cannot be submitted together",
    );
  }
  if (input.motion.paint) {
    const availableMeshNodes = new Set(plans.map((plan) => plan.review.meshNode));
    for (const painted of input.motion.paint.regions) {
      for (const mesh of painted.meshes) {
        if (!availableMeshNodes.has(mesh.meshNode)) {
          block(
            "INVALID_MOTION_PAINT",
            `painted area ${painted.id} references missing Hair mesh ${mesh.meshNode}`,
          );
        }
      }
    }
    for (const plan of plans) {
      plan.motionRegions = buildPaintedMotionRegions(
        plan,
        anchoredLength,
        input.motion.paint,
      );
    }
  } else {
    for (const plan of plans) {
      plan.motionRegions = buildMotionRegions(plan, anchoredLength);
    }
  }
  applyMotionRegionSelections(plans, input.motion.regionSelections);
  if (!plans.some((plan) => plan.motionRegions.some((region) => region.moving))) {
    block(
      "NO_MOTION_REGION",
      "review at least one moving Hair region or explicitly save this style as static",
    );
  }
  const headSizeEndpoints = new Set<number>();
  const driverKeys = new Set<string>();
  for (const driver of input.followerDrivers) {
    stableId(driver.dialId, "follower driver dialId");
    const dial = manifest.dials.find((entry) => entry.id === driver.dialId);
    if (
      !dial ||
      driver.endpoint === 0 ||
      driver.endpoint < dial.range[0] ||
      driver.endpoint > dial.range[1]
    ) {
      block(
        "INVALID_FOLLOWER_DRIVER",
        `driver ${driver.dialId}:${driver.endpoint} is outside the Recipe manifest`,
      );
    }
    const key = `${driver.dialId}:${driver.endpoint}`;
    if (driverKeys.has(key))
      block("INVALID_FOLLOWER_DRIVER", `driver ${key} is duplicated`);
    driverKeys.add(key);
    if (driver.dialId === "head_size") headSizeEndpoints.add(driver.endpoint);
  }
  if (!headSizeEndpoints.has(-1) || !headSizeEndpoints.has(1)) {
    block(
      "INVALID_FOLLOWER_DRIVER",
      "reviewed drivers must include both head_size endpoints",
    );
  }
  let maximumMorphDelta = 0;
  for (const driver of input.followerDrivers) {
    const resolved = resolveAppearanceDialState(
      manifest,
      dialState(manifest, neutralResolved.values, {
        [driver.dialId]: driver.endpoint,
      }),
    );
    const evaluation = evaluateAppearanceRecipePhysicalOutput(basis, resolved);
    const bodyMesh = evaluation.meshes.find(
      (entry) => entry.id === bodyBasis[0]!.id,
    );
    if (!bodyMesh)
      block(
        "INVALID_RECIPE_SOURCE",
        `Recipe scenario ${driver.dialId} omitted the body mesh`,
      );
    const bodyScenario = transformPositions(
      bodyMesh.positions,
      evaluationMatrix(evaluation, bodyNodeIndex, "scenario body"),
    );
    const scenarioHairFromRoot = evaluationMatrix(
      evaluation,
      headNodeIndex,
      "scenario head",
    )
      .multiply(authoredRootMatrix)
      .invert();
    const profileTipWeight =
      driver.falloffProfile === "global-head"
        ? 1
        : driver.falloffProfile === "scalp-shape"
          ? 0.72
          : 0.42;
    for (const plan of plans) {
      const delta = new Float32Array(plan.positions.length);
      const neutralPoint = new THREE.Vector3();
      const desiredRoot = new THREE.Vector3();
      for (let vertex = 0; vertex < plan.positions.length / 3; vertex += 1) {
        const offset = vertex * 3;
        neutralPoint
          .set(
            plan.positions[offset]!,
            plan.positions[offset + 1]!,
            plan.positions[offset + 2]!,
          )
          .applyMatrix4(neutralAttachment);
        const neutralBodyPoint = weightedBodyPoint(
          bodyNeutral,
          plan.nearestBody[vertex]!,
        );
        const scenarioBodyPoint = weightedBodyPoint(
          bodyScenario,
          plan.nearestBody[vertex]!,
        );
        const falloff =
          1 -
          (1 - profileTipWeight) *
            smoothstep((plan.tipRatios[vertex]! - 0.15) / 0.85);
        desiredRoot
          .copy(neutralPoint)
          .add(
            new THREE.Vector3(
              scenarioBodyPoint[0] - neutralBodyPoint[0],
              scenarioBodyPoint[1] - neutralBodyPoint[1],
              scenarioBodyPoint[2] - neutralBodyPoint[2],
            ).multiplyScalar(falloff),
          )
          .applyMatrix4(scenarioHairFromRoot);
        delta[offset] = desiredRoot.x - plan.positions[offset]!;
        delta[offset + 1] = desiredRoot.y - plan.positions[offset + 1]!;
        delta[offset + 2] = desiredRoot.z - plan.positions[offset + 2]!;
      }
      const smoothed = smoothDelta(plan, delta);
      for (const value of smoothed)
        maximumMorphDelta = Math.max(maximumMorphDelta, Math.abs(value));
      plan.targetDeltas.push(smoothed);
    }
  }
  if (maximumMorphDelta <= 1e-7) {
    block(
      "NO_FOLLOWER_DEFORMATION",
      "Recipe/scalp transfer produced only zero Hair morph deltas",
    );
  }
  for (const plan of plans) {
    for (
      let targetIndex = 0;
      targetIndex < input.followerDrivers.length;
      targetIndex += 1
    ) {
      const driver = input.followerDrivers[targetIndex]!;
      const weight = Math.min(
        1,
        Math.max(
          0,
          (reviewedResolved.values[driver.dialId] ?? 0) / driver.endpoint,
        ),
      );
      if (weight === 0) continue;
      const delta = plan.targetDeltas[targetIndex]!;
      for (let offset = 0; offset < plan.positions.length; offset += 1) {
        plan.positions[offset] =
          plan.positions[offset]! - delta[offset]! * weight;
      }
    }
    const pivot = averageVertices(plan.positions, plan.rootIndices);
    const tipOffset = plan.tipIndex * 3;
    const tip = new THREE.Vector3(
      plan.positions[tipOffset],
      plan.positions[tipOffset + 1],
      plan.positions[tipOffset + 2],
    );
    plan.pivot = tuple(pivot);
    plan.tip = tuple(tip);
    plan.length = pivot.distanceTo(tip);
  }
  const morphNames = input.followerDrivers.map(targetName);
  if (new Set(morphNames).size !== morphNames.length) {
    block(
      "INVALID_FOLLOWER_DRIVER",
      "reviewed drivers generate colliding morph target names",
    );
  }
  const authored = appendAuthoredGeometry(
    hair,
    rootNodeIndex,
    plans,
    morphNames,
    input.motion,
  );
  const geometrySha256 = await sha256Hex(authored.bytes);
  const riskScenarios = generatedRiskScenarios(input.followerDrivers);
  const followerDefinition = parseHairFollowerDefinition({
    contract: HAIR_APPEARANCE_FOLLOWER_CONTRACT,
    appearanceFollowerContract: "appearance-followers/v2",
    assetId: input.owner.assetId,
    revisionId: input.owner.revisionId,
    geometrySha256,
    fitFamily: input.owner.fitFamily,
    appearanceDefinitionSha256: manifest.definitionSha256,
    headNode: semanticGlbRuntimeNodeName(input.recipeNodes.headRigNode),
    sourceBodyNode: semanticGlbRuntimeNodeName(bodyDeclaration.node),
    scalpCage: {
      contract: HAIR_SCALP_CAGE_CONTRACT,
      space: "avatar-root-rest",
      rootBounds,
      transferBounds,
      nearestNeighbors: 4,
      rootSeedFraction,
      topology: "triangle-geodesic/v1",
    },
    falloffProfiles: [
      { id: "global-head", curve: "smoothstep-root-to-tip/v1", tipWeight: 1 },
      {
        id: "scalp-shape",
        curve: "smoothstep-root-to-tip/v1",
        tipWeight: 0.72,
      },
      {
        id: "local-clearance",
        curve: "smoothstep-root-to-tip/v1",
        tipWeight: 0.42,
      },
    ],
    morphTargets: input.followerDrivers.map((driver, index) => ({
      name: morphNames[index]!,
      driver: {
        kind: "dial-endpoint",
        dialId: driver.dialId,
        endpoint: driver.endpoint,
      },
      falloffProfile: driver.falloffProfile,
    })),
    correctives: [],
    riskMatrix: {
      contract: HAIR_FOLLOWER_RISK_MATRIX_CONTRACT,
      scenarios: riskScenarios,
      thresholds: {
        maximumRootGapChange: 0.012,
        maximumClearanceLoss: 0.018,
        structuralEdgeMinimumLength: 0.00025,
        minimumAbsoluteStretch: 0.00005,
        maximumTipEdgeStretchRatio: 2.75,
        minimumSilhouetteDimensionRatio: 0.55,
        maximumSilhouetteDimensionRatio: 1.75,
      },
    },
  });
  const secondaryMotionDefinition = buildSecondaryMotion(
    input,
    manifest,
    recipe,
    geometrySha256,
    plans,
  );
  const maximumObservedRootDistance = Math.max(
    ...plans.map((plan) => plan.maximumRootDistance),
  );
  const anchoredMicroComponentCount = plans.reduce(
    (sum, plan) => sum + plan.anchoredMicroComponentCount,
    0,
  );
  const anchoredMicroVertexCount = plans.reduce(
    (sum, plan) => sum + plan.anchoredMicroVertexCount,
    0,
  );
  const confidence = round(
    Math.max(
      0.5,
      1 - (maximumObservedRootDistance / maximumRootDistance) * 0.4,
    ),
    4,
  );
  const proposal: HairImportAuthoringProposal = {
    status: "ready",
    confidence,
    confidenceLabel:
      confidence >= 0.85
        ? "high"
        : confidence >= 0.7
          ? "medium"
          : "review-carefully",
    blockingReasons: [],
    summary: [
      `${plans.length} reviewed mesh ${plans.length === 1 ? "clump has" : "clumps have"} real scalp-transferred Appearance morphs.`,
      `Roots remain anchored through ${round(anchoredLength * 100, 2)}% of each topology path before motion ramps toward the tips.`,
      `${input.colliders.length} reviewed body ${input.colliders.length === 1 ? "collider is" : "colliders are"} bound by manifest node role/name.`,
      ...(anchoredMicroComponentCount > 0
        ? [
            `${anchoredMicroComponentCount} sub-5 mm decorative ${anchoredMicroComponentCount === 1 ? "island is" : "islands are"} explicitly root-anchored (${anchoredMicroVertexCount} vertices); no hidden motion chain was guessed.`,
          ]
        : []),
    ],
    clumps: plans.map((plan) => {
      const movingRatios = new Float32Array(plan.tipRatios.length);
      for (const region of plan.motionRegions) {
        if (!region.moving) continue;
        for (const vertex of region.vertices) {
          movingRatios[vertex] = region.motionRatios[vertex]!;
        }
      }
      const anchored = Array.from(movingRatios).filter(
        (entry) => entry <= anchoredLength,
      ).length;
      const dynamic = Array.from(movingRatios).filter(
        (entry) => entry >= 1 - 1e-6,
      ).length;
      const clumpConfidence = round(
        Math.max(
          0.5,
          1 - (plan.maximumRootDistance / maximumRootDistance) * 0.4,
        ),
        4,
      );
      return {
        id: plan.review.id,
        meshNode: semanticGlbRuntimeNodeName(
          stableText(
            hair.nodes[plan.nodeIndex]!.name,
            `Hair node ${plan.nodeIndex}.name`,
          ),
        ),
        root: plan.pivot,
        tip: plan.tip,
        lengthMeters: round(plan.length),
        connectedComponents: plan.componentCount,
        anchoredMicroComponentCount: plan.anchoredMicroComponentCount,
        anchoredMicroVertexCount: plan.anchoredMicroVertexCount,
        rootSeedCount: plan.rootIndices.length,
        maximumRootDistance: round(plan.maximumRootDistance),
        anchoredVertexCount: anchored,
        fullyDynamicVertexCount: dynamic,
        confidence: clumpConfidence,
        explanation: `Root seeds are the closest ${plan.rootIndices.length} topology vertices to the reviewed scalp cage; the tip is the farthest stable geodesic endpoint.${plan.anchoredMicroComponentCount > 0 ? ` ${plan.anchoredMicroComponentCount} sub-5 mm decorative ${plan.anchoredMicroComponentCount === 1 ? "island remains" : "islands remain"} explicitly root-anchored.` : ""}`,
      };
    }),
    weights: {
      anchoredLength,
      weightCurve: HAIR_MOTION_WEIGHT_CURVE,
      defaultIntensity,
      explanation: `Vertices at or below ${round(anchoredLength * 100, 2)}% remain exactly on the root joint; every accepted moving region then ramps smoothly across its complete remaining topology path so only its tip reaches full influence.`,
    },
    motionRegions: plans.flatMap((plan) =>
      plan.motionRegions.map((region) => ({
        id: region.id,
        meshNode: semanticGlbRuntimeNodeName(
          stableText(
            hair.nodes[plan.nodeIndex]!.name,
            `Hair node ${plan.nodeIndex}.name`,
          ),
        ),
        label: region.label,
        moving: region.moving,
        recommendedMoving: region.recommendedMoving,
        supportsMotion: region.supportsMotion,
        root: region.pivot,
        tip: region.tip,
        lengthMeters: round(region.length),
        vertexCount: region.vertices.length,
        explanation: region.explanation,
      })),
    ),
    chains: secondaryMotionDefinition.chains.map((chain) => ({
      id: chain.id,
      motionNode: chain.segments[0]!.node,
      collisionGroups: chain.segments[0]!.collisionGroups,
      explanation:
        "One reviewed moving region owns one deterministic root-to-tip motion chain; users select Hair regions, never bones.",
    })),
    colliders: secondaryMotionDefinition.colliders.map((collider) => ({
      id: collider.id,
      group: collider.group,
      node: collider.node,
      explanation: `${collider.shape} geometry is explicit, bounded, and attached to the reviewed Recipe manifest node.`,
    })),
  };
  const followerDefinitionSha256 =
    await hairFollowerDefinitionSha256(followerDefinition);
  const motionDefinitionSha256 = await secondaryMotionDefinitionSha256(
    secondaryMotionDefinition,
  );
  const evidence: HairImportAuthoringEvidence = {
    contract: HAIR_IMPORT_AUTHORING_CONTRACT,
    inputHairSha256: await sha256Hex(input.canonicalHairGlb),
    recipeSourceSha256: await sha256Hex(input.recipeSourceGlb),
    appearanceDefinitionSha256: manifest.definitionSha256,
    outputGeometrySha256: geometrySha256,
    followerDefinitionSha256,
    secondaryMotionDefinitionSha256: motionDefinitionSha256,
    proposalSha256: await canonicalRecipeSha256(proposal),
    meshCount: plans.length,
    vertexCount: plans.reduce(
      (sum, plan) => sum + plan.positions.length / 3,
      0,
    ),
    morphTargetCount: morphNames.length,
    motionChainCount: secondaryMotionDefinition.chains.length,
    colliderCount: secondaryMotionDefinition.colliders.length,
    maximumRootDistance: round(maximumObservedRootDistance),
    maximumMorphDelta: round(maximumMorphDelta),
    anchoredVertexCount: authored.anchoredVertexCount,
    fullyDynamicVertexCount: authored.fullyDynamicVertexCount,
    anchoredMicroComponentCount,
    anchoredMicroVertexCount,
  };
  return {
    geometryGlb: authored.bytes,
    followerDefinition,
    secondaryMotionDefinition,
    proposal,
    evidence,
  };
}
