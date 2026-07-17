import * as THREE from "three";
import type {
  AppearanceFollowerDriverRef,
  AppearanceNodeParent,
  AppearanceQuat,
  AppearanceVec3,
  ResolvedAppearanceDialState,
  ResolvedAppearanceFollowerNodeTransform,
} from "../appearanceDials.contracts";
import { APPEARANCE_QUATERNION_LENGTH_TOLERANCE } from "../appearanceDials.validation";
import { sanitizeCustomRuntimeNodeName } from "../customAvatar";

export const APPEARANCE_RECIPE_PHYSICAL_BASIS_CONTRACT =
  "appearance-recipe-physical-basis/v1" as const;
export const APPEARANCE_RECIPE_PHYSICAL_EVALUATION_CONTRACT =
  "appearance-recipe-physical-evaluation/v1" as const;

export type AppearanceRecipeMatrix4 = readonly number[];
export type AppearanceRecipePositionDelta =
  | Float32Array
  | {
      /** Full output POSITION scalar length, including implicit zero entries. */
      length: number;
      /** Visit explicit scalar deltas once in strictly ascending index order. */
      visit: (visitor: (index: number, value: number) => void) => void;
    };
export type AppearanceRecipePhysicalRoleKind =
  "stage" | "attachment" | "performance" | "eye";

export type AppearanceRecipePhysicalBasis = {
  contract: typeof APPEARANCE_RECIPE_PHYSICAL_BASIS_CONTRACT;
  rootBaseMatrix: AppearanceRecipeMatrix4;
  meshes: Array<{
    id: string;
    /** Physical node that owns this mesh/primitive. */
    nodeId: string;
    basePositions: Float32Array;
  }>;
  targets: Array<{
    id: string;
    runtimeRetention: "recipe-only" | "retain-in-live-goon";
  }>;
  targetPositionBindings: Array<{
    id: string;
    targetId: string;
    meshId: string;
    positionDelta: AppearanceRecipePositionDelta;
  }>;
  retainedTargetPositionBindings: Array<{
    id: string;
    targetId: string;
    node: string;
    morph: string;
    meshId: string;
    positionDelta: AppearanceRecipePositionDelta;
  }>;
  followerMorphPositionBindings: Array<{
    id: string;
    follower: string;
    channel: string;
    node: string;
    morph: string;
    meshId: string;
    positionDelta: AppearanceRecipePositionDelta;
  }>;
  /** Complete resolver-ordered morph channel inventory, including omissions. */
  followerMorphBindings: Array<{
    follower: string;
    channel: string;
    driver: AppearanceFollowerDriverRef;
    node: string;
    morph: string;
    /** Present only when the optional runtime node/morph exists. */
    positionBindingId?: string;
  }>;
  nodes: Array<{
    id: string;
    parentId?: string;
    baseLocalMatrix: AppearanceRecipeMatrix4;
  }>;
  followerNodeBindings: Array<{
    /** Appearance Dials manifest node id. */
    id: string;
    /** Physical node id. */
    nodeId: string;
  }>;
  followerNodeTransformBindings: Array<{
    follower: string;
    channel: string;
    driver: AppearanceFollowerDriverRef;
    /** Appearance Dials manifest node id. */
    node: string;
    /** Physical node id; absent for a declared optional runtime omission. */
    nodeId?: string;
  }>;
  bones: Array<{
    id: string;
    /** Exact runtime/GLB bone name. */
    name: string;
    nodeId: string;
  }>;
  /** Exact resolver insertion order for jointOffsets. */
  jointOffsetBindings: Array<{
    bone: string;
    boneId: string;
  }>;
  skins: Array<{
    id: string;
    /** Original skin joint-slot order. */
    joints: Array<{
      boneId: string;
      baseInverseBindMatrix: AppearanceRecipeMatrix4;
    }>;
  }>;
  roles: Array<{
    kind: AppearanceRecipePhysicalRoleKind;
    id: string;
    nodeId: string;
    /** Exact appearance manifest declaration retained for migration proofs. */
    declaredParent?: AppearanceNodeParent;
  }>;
  /** Runtime bone name or its sanitized alias. */
  hipsBone?: string;
};

export type AppearanceRecipePhysicalEvaluation = {
  contract: typeof APPEARANCE_RECIPE_PHYSICAL_EVALUATION_CONTRACT;
  meshes: Array<{ id: string; nodeId: string; positions: Float32Array }>;
  retainedTargetPositionBindings: Array<{
    id: string;
    targetId: string;
    node: string;
    morph: string;
    meshId: string;
    positionDelta: AppearanceRecipePositionDelta;
    weight: number;
  }>;
  followerMorphWeights: Array<{
    follower: string;
    channel: string;
    driver: AppearanceFollowerDriverRef;
    node: string;
    morph: string;
    weight: number;
  }>;
  jointRests: Array<{
    boneId: string;
    bone: string;
    nodeId: string;
    parentBoneId?: string;
    avatarRootOffset: AppearanceVec3;
    baseLocalPosition: AppearanceVec3;
    localPosition: AppearanceVec3;
    localMatrix: number[];
  }>;
  skins: Array<{
    id: string;
    joints: Array<{
      boneId: string;
      inverseBindMatrix: number[];
    }>;
  }>;
  root: {
    matrix: number[];
    position: AppearanceVec3;
    rotation: AppearanceQuat;
    scale: AppearanceVec3;
    rootScale: number;
    soleOffsetY: number;
  };
  nodes: Array<{
    id: string;
    parentId?: string;
    localMatrix: number[];
    rootRelativeMatrix: number[];
    worldMatrix: number[];
  }>;
  roles: Array<{
    kind: AppearanceRecipePhysicalRoleKind;
    id: string;
    nodeId: string;
    declaredParent?: AppearanceNodeParent;
    rootRelativeMatrix: number[];
    worldMatrix: number[];
    worldPosition: AppearanceVec3;
  }>;
  hipsClipRemap: {
    boneId: string;
    bone: string;
    baseRest: AppearanceVec3;
    newRest: AppearanceVec3;
    ratio: number;
  } | null;
};

type BasisNode = AppearanceRecipePhysicalBasis["nodes"][number];
type BasisBone = AppearanceRecipePhysicalBasis["bones"][number];

type ValidatedBasis = {
  meshById: Map<string, AppearanceRecipePhysicalBasis["meshes"][number]>;
  targetById: Map<string, AppearanceRecipePhysicalBasis["targets"][number]>;
  nodeById: Map<string, BasisNode>;
  boneById: Map<string, BasisBone>;
  boneByNodeId: Map<string, BasisBone>;
  boneByAlias: Map<string, BasisBone>;
  followerNodeById: Map<string, string>;
  followerTransformByKey: Map<
    string,
    AppearanceRecipePhysicalBasis["followerNodeTransformBindings"][number]
  >;
  followerMorphPositionById: Map<
    string,
    AppearanceRecipePhysicalBasis["followerMorphPositionBindings"][number]
  >;
  baseLocalByNodeId: Map<string, THREE.Matrix4>;
  baseRootRelativeByNodeId: Map<string, THREE.Matrix4>;
};

// glTF-authored float32 TRS can round-trip through THREE decomposition with
// ~1e-7 scalar drift. This remains far below meaningful shear.
const TRS_TOLERANCE = 1e-6;
function fail(reason: string): never {
  throw new Error(`appearance Recipe physical basis rejected: ${reason}`);
}

function assertId(value: string, context: string): string {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    value.length === 0
  ) {
    fail(`${context} must be a non-empty trimmed id`);
  }
  return value;
}

function addUnique<T extends { id: string }>(
  map: Map<string, T>,
  value: T,
  context: string,
) {
  assertId(value.id, `${context}.id`);
  if (map.has(value.id)) fail(`${context} duplicates id ${value.id}`);
  map.set(value.id, value);
}

function finite(value: number, context: string): number {
  if (!Number.isFinite(value)) fail(`${context} must be finite`);
  return value;
}

function finiteVec3(value: AppearanceVec3, context: string): AppearanceVec3 {
  if (!Array.isArray(value) || value.length !== 3) {
    fail(`${context} must contain exactly 3 numbers`);
  }
  return [
    finite(value[0], `${context}[0]`),
    finite(value[1], `${context}[1]`),
    finite(value[2], `${context}[2]`),
  ];
}

function finiteQuat(value: AppearanceQuat, context: string): AppearanceQuat {
  if (!Array.isArray(value) || value.length !== 4) {
    fail(`${context} must contain exactly 4 numbers`);
  }
  return [
    finite(value[0], `${context}[0]`),
    finite(value[1], `${context}[1]`),
    finite(value[2], `${context}[2]`),
    finite(value[3], `${context}[3]`),
  ];
}

function assertFiniteVector3(value: THREE.Vector3, context: string) {
  finite(value.x, `${context}.x`);
  finite(value.y, `${context}.y`);
  finite(value.z, `${context}.z`);
}

function assertFiniteQuaternion(value: THREE.Quaternion, context: string) {
  finite(value.x, `${context}.x`);
  finite(value.y, `${context}.y`);
  finite(value.z, `${context}.z`);
  finite(value.w, `${context}.w`);
}

function assertFiniteMatrix(
  matrix: THREE.Matrix4,
  context: string,
): THREE.Matrix4 {
  matrix.elements.forEach((value, index) =>
    finite(value, `${context}[${index}]`),
  );
  return matrix;
}

function assertUnitQuaternion(value: AppearanceQuat, context: string) {
  const length = Math.hypot(value[0], value[1], value[2], value[3]);
  finite(length, `${context} length`);
  if (Math.abs(length - 1) >= APPEARANCE_QUATERNION_LENGTH_TOLERANCE) {
    fail(
      `${context} must be unit length within the appearance contract tolerance`,
    );
  }
}

function matrixFrom(
  values: AppearanceRecipeMatrix4,
  context: string,
  requireTrs: boolean,
): THREE.Matrix4 {
  if (!Array.isArray(values) || values.length !== 16) {
    fail(`${context} must contain exactly 16 numbers`);
  }
  const matrix = new THREE.Matrix4().fromArray(
    values.map((value, index) => finite(value, `${context}[${index}]`)),
  );
  assertFiniteMatrix(matrix, context);
  if (requireTrs) assertTrsRepresentable(matrix, context);
  return matrix;
}

function assertTrsRepresentable(matrix: THREE.Matrix4, context: string) {
  const position = new THREE.Vector3();
  const rotation = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  matrix.decompose(position, rotation, scale);
  assertFiniteVector3(position, `${context} decomposed position`);
  assertFiniteQuaternion(rotation, `${context} decomposed rotation`);
  assertFiniteVector3(scale, `${context} decomposed scale`);
  if (
    Math.abs(scale.x) <= Number.EPSILON ||
    Math.abs(scale.y) <= Number.EPSILON ||
    Math.abs(scale.z) <= Number.EPSILON
  ) {
    fail(`${context} has a singular scale and cannot be represented as TRS`);
  }
  const recomposed = new THREE.Matrix4().compose(position, rotation, scale);
  assertFiniteMatrix(recomposed, `${context} recomposed`);
  const source = matrix.elements;
  const roundTrip = recomposed.elements;
  for (let index = 0; index < 16; index += 1) {
    const tolerance = TRS_TOLERANCE * Math.max(1, Math.abs(source[index] ?? 0));
    if (Math.abs((source[index] ?? 0) - (roundTrip[index] ?? 0)) > tolerance) {
      fail(`${context} contains shear or another non-TRS transform`);
    }
  }
}

function arrayFromMatrix(matrix: THREE.Matrix4): number[] {
  return matrix.toArray();
}

function tupleFromVector(value: THREE.Vector3): AppearanceVec3 {
  return [value.x, value.y, value.z];
}

function tupleFromQuaternion(value: THREE.Quaternion): AppearanceQuat {
  return [value.x, value.y, value.z, value.w];
}

function followerKey(follower: string, channel: string): string {
  return `${follower}\u0000${channel}`;
}

function validateFollowerDriver(
  driver: AppearanceFollowerDriverRef,
  context: string,
) {
  if (!driver || typeof driver !== "object" || Array.isArray(driver)) {
    fail(`${context} driver must be an object`);
  }
  if (driver.kind !== "dial" && driver.kind !== "target") {
    fail(`${context} has an unsupported driver kind`);
  }
  assertId(driver.id, `${context} driver id`);
}

function followerDriverEqual(
  left: AppearanceFollowerDriverRef,
  right: AppearanceFollowerDriverRef,
): boolean {
  return left.kind === right.kind && left.id === right.id;
}

function followerDeltaMatrix(
  entry: ResolvedAppearanceFollowerNodeTransform,
): THREE.Matrix4 {
  const translation = new THREE.Matrix4().makeTranslation(
    ...finiteVec3(
      entry.translation,
      `${entry.follower}/${entry.channel} translation`,
    ),
  );
  const pivotValue = finiteVec3(
    entry.pivot,
    `${entry.follower}/${entry.channel} pivot`,
  );
  const pivot = new THREE.Matrix4().makeTranslation(...pivotValue);
  const inversePivot = new THREE.Matrix4().makeTranslation(
    -pivotValue[0],
    -pivotValue[1],
    -pivotValue[2],
  );
  const rotationValue = finiteQuat(
    entry.rotation,
    `${entry.follower}/${entry.channel} rotation`,
  );
  assertUnitQuaternion(
    rotationValue,
    `${entry.follower}/${entry.channel} rotation`,
  );
  const rotation = new THREE.Matrix4().makeRotationFromQuaternion(
    new THREE.Quaternion(...rotationValue),
  );
  const scale = new THREE.Matrix4().makeScale(
    ...finiteVec3(entry.scale, `${entry.follower}/${entry.channel} scale`),
  );
  return assertFiniteMatrix(
    translation
      .multiply(pivot)
      .multiply(rotation)
      .multiply(scale)
      .multiply(inversePivot),
    `${entry.follower}/${entry.channel} follower delta matrix`,
  );
}

function deltaLength(delta: AppearanceRecipePositionDelta): number {
  if (delta instanceof Float32Array) return delta.length;
  if (!delta || typeof delta !== "object") {
    fail(`POSITION delta must be a Float32Array or lazy visitor`);
  }
  return delta.length;
}

function validatePositionDeltaShape(
  delta: AppearanceRecipePositionDelta,
  context: string,
) {
  if (delta instanceof Float32Array) {
    delta.forEach((value, index) => finite(value, `${context}[${index}]`));
    return;
  }
  if (
    !delta ||
    typeof delta !== "object" ||
    !Number.isSafeInteger(delta.length) ||
    delta.length < 0 ||
    typeof delta.visit !== "function"
  ) {
    fail(`${context} visitor must declare a non-negative safe length`);
  }
}

function visitPositionDelta(
  delta: AppearanceRecipePositionDelta,
  context: string,
  visitor: (index: number, value: number) => void,
) {
  if (delta instanceof Float32Array) {
    delta.forEach((value, index) =>
      visitor(index, finite(value, `${context}[${index}]`)),
    );
    return;
  }
  if (
    !delta ||
    typeof delta !== "object" ||
    !Number.isSafeInteger(delta.length) ||
    delta.length < 0 ||
    typeof delta.visit !== "function"
  ) {
    fail(`${context} visitor must declare a non-negative safe length`);
  }
  let previousIndex = -1;
  delta.visit((index, value) => {
    if (!Number.isSafeInteger(index) || index < 0 || index >= delta.length) {
      fail(`${context} visitor emitted out-of-range index ${index}`);
    }
    if (index <= previousIndex) {
      fail(`${context} visitor indices must be unique and strictly ascending`);
    }
    previousIndex = index;
    visitor(index, finite(value, `${context}[${index}]`));
  });
}

function clonePositionDelta(
  delta: AppearanceRecipePositionDelta,
  context: string,
): AppearanceRecipePositionDelta {
  if (delta instanceof Float32Array) return delta.slice();
  return {
    length: delta.length,
    visit(visitor) {
      visitPositionDelta(delta, context, visitor);
    },
  };
}

function validatePhysicalBasis(
  basis: AppearanceRecipePhysicalBasis,
): ValidatedBasis {
  if (basis.contract !== APPEARANCE_RECIPE_PHYSICAL_BASIS_CONTRACT) {
    fail(`contract must be ${APPEARANCE_RECIPE_PHYSICAL_BASIS_CONTRACT}`);
  }
  matrixFrom(basis.rootBaseMatrix, "rootBaseMatrix", true);

  const meshById = new Map<
    string,
    AppearanceRecipePhysicalBasis["meshes"][number]
  >();
  for (const mesh of basis.meshes) {
    addUnique(meshById, mesh, "mesh");
    assertId(mesh.nodeId, `mesh ${mesh.id}.nodeId`);
    if (!(mesh.basePositions instanceof Float32Array)) {
      fail(`mesh ${mesh.id} basePositions must be Float32Array`);
    }
    if (
      mesh.basePositions.length === 0 ||
      mesh.basePositions.length % 3 !== 0
    ) {
      fail(`mesh ${mesh.id} basePositions must contain complete vec3 vertices`);
    }
    mesh.basePositions.forEach((value, index) =>
      finite(value, `mesh ${mesh.id} basePositions[${index}]`),
    );
  }

  const targetById = new Map<
    string,
    AppearanceRecipePhysicalBasis["targets"][number]
  >();
  for (const target of basis.targets) {
    addUnique(targetById, target, "target");
    if (
      target.runtimeRetention !== "recipe-only" &&
      target.runtimeRetention !== "retain-in-live-goon"
    ) {
      fail(`target ${target.id} has an unsupported runtime retention`);
    }
  }

  const bindingIds = new Set<string>();
  const recipeTargetBindingCount = new Map<string, number>();
  for (const binding of basis.targetPositionBindings) {
    assertId(binding.id, "target position binding id");
    if (bindingIds.has(binding.id)) {
      fail(`target position binding duplicates id ${binding.id}`);
    }
    bindingIds.add(binding.id);
    const target = targetById.get(binding.targetId);
    if (!target)
      fail(`target position binding ${binding.id} references missing target`);
    if (target.runtimeRetention !== "recipe-only") {
      fail(`retained target ${target.id} cannot own a baked POSITION binding`);
    }
    const mesh = meshById.get(binding.meshId);
    if (!mesh)
      fail(`target position binding ${binding.id} references missing mesh`);
    if (deltaLength(binding.positionDelta) !== mesh.basePositions.length) {
      fail(
        `target position binding ${binding.id} delta length does not match its mesh`,
      );
    }
    validatePositionDeltaShape(
      binding.positionDelta,
      `target position binding ${binding.id} delta`,
    );
    recipeTargetBindingCount.set(
      target.id,
      (recipeTargetBindingCount.get(target.id) ?? 0) + 1,
    );
  }
  for (const target of basis.targets) {
    if (
      target.runtimeRetention === "recipe-only" &&
      !recipeTargetBindingCount.has(target.id)
    ) {
      fail(`recipe-only target ${target.id} has no POSITION binding`);
    }
  }

  const retainedTargetBindingCount = new Map<string, number>();
  for (const binding of basis.retainedTargetPositionBindings) {
    assertId(binding.id, "retained target position binding id");
    if (bindingIds.has(binding.id)) {
      fail(`physical binding duplicates id ${binding.id}`);
    }
    bindingIds.add(binding.id);
    assertId(binding.node, `${binding.id}.node`);
    assertId(binding.morph, `${binding.id}.morph`);
    const target = targetById.get(binding.targetId);
    if (!target) {
      fail(`retained target binding ${binding.id} references missing target`);
    }
    if (target.runtimeRetention !== "retain-in-live-goon") {
      fail(
        `recipe-only target ${target.id} cannot own a retained POSITION binding`,
      );
    }
    const mesh = meshById.get(binding.meshId);
    if (!mesh) {
      fail(`retained target binding ${binding.id} references missing mesh`);
    }
    if (deltaLength(binding.positionDelta) !== mesh.basePositions.length) {
      fail(
        `retained target binding ${binding.id} delta length does not match its mesh`,
      );
    }
    validatePositionDeltaShape(
      binding.positionDelta,
      `retained target binding ${binding.id} delta`,
    );
    retainedTargetBindingCount.set(
      target.id,
      (retainedTargetBindingCount.get(target.id) ?? 0) + 1,
    );
  }
  for (const target of basis.targets) {
    if (
      target.runtimeRetention === "retain-in-live-goon" &&
      !retainedTargetBindingCount.has(target.id)
    ) {
      fail(`retained target ${target.id} has no physical POSITION binding`);
    }
  }

  const followerMorphKeys = new Set<string>();
  const followerMorphPositionById = new Map<
    string,
    AppearanceRecipePhysicalBasis["followerMorphPositionBindings"][number]
  >();
  for (const binding of basis.followerMorphPositionBindings) {
    assertId(binding.id, "follower morph position binding id");
    if (bindingIds.has(binding.id)) {
      fail(`physical binding duplicates id ${binding.id}`);
    }
    bindingIds.add(binding.id);
    followerMorphPositionById.set(binding.id, binding);
    assertId(binding.follower, `${binding.id}.follower`);
    assertId(binding.channel, `${binding.id}.channel`);
    assertId(binding.node, `${binding.id}.node`);
    assertId(binding.morph, `${binding.id}.morph`);
    const key = followerKey(binding.follower, binding.channel);
    if (followerMorphKeys.has(key)) {
      fail(
        `follower morph ${binding.follower}/${binding.channel} is ambiguous`,
      );
    }
    followerMorphKeys.add(key);
    const mesh = meshById.get(binding.meshId);
    if (!mesh)
      fail(`follower morph binding ${binding.id} references missing mesh`);
    if (deltaLength(binding.positionDelta) !== mesh.basePositions.length) {
      fail(
        `follower morph binding ${binding.id} delta length does not match its mesh`,
      );
    }
    validatePositionDeltaShape(
      binding.positionDelta,
      `follower morph binding ${binding.id} delta`,
    );
  }

  const followerMorphInventoryKeys = new Set<string>();
  const referencedFollowerPositionIds = new Set<string>();
  for (const binding of basis.followerMorphBindings) {
    assertId(binding.follower, "follower morph inventory follower");
    assertId(binding.channel, "follower morph inventory channel");
    validateFollowerDriver(
      binding.driver,
      `${binding.follower}/${binding.channel}`,
    );
    assertId(binding.node, "follower morph inventory node");
    assertId(binding.morph, "follower morph inventory morph");
    const key = followerKey(binding.follower, binding.channel);
    if (followerMorphInventoryKeys.has(key)) {
      fail(
        `follower morph inventory duplicates ${binding.follower}/${binding.channel}`,
      );
    }
    followerMorphInventoryKeys.add(key);
    if (binding.positionBindingId === undefined) {
      if (followerMorphKeys.has(key)) {
        fail(
          `follower morph ${binding.follower}/${binding.channel} omits its present physical binding`,
        );
      }
      continue;
    }
    assertId(
      binding.positionBindingId,
      `${binding.follower}/${binding.channel} positionBindingId`,
    );
    const physical = followerMorphPositionById.get(binding.positionBindingId);
    if (!physical) {
      fail(
        `follower morph ${binding.follower}/${binding.channel} references missing position binding`,
      );
    }
    if (
      physical.follower !== binding.follower ||
      physical.channel !== binding.channel ||
      physical.node !== binding.node ||
      physical.morph !== binding.morph
    ) {
      fail(
        `follower morph ${binding.follower}/${binding.channel} changed physical identity`,
      );
    }
    if (referencedFollowerPositionIds.has(binding.positionBindingId)) {
      fail(
        `follower morph position binding ${binding.positionBindingId} is referenced twice`,
      );
    }
    referencedFollowerPositionIds.add(binding.positionBindingId);
  }
  if (referencedFollowerPositionIds.size !== followerMorphPositionById.size) {
    const missing = [...followerMorphPositionById.keys()].filter(
      (id) => !referencedFollowerPositionIds.has(id),
    );
    fail(
      `follower morph position bindings are unclaimed: ${missing.join(", ")}`,
    );
  }

  const nodeById = new Map<string, BasisNode>();
  const baseLocalByNodeId = new Map<string, THREE.Matrix4>();
  for (const node of basis.nodes) {
    addUnique(nodeById, node, "node");
    baseLocalByNodeId.set(
      node.id,
      matrixFrom(node.baseLocalMatrix, `node ${node.id} baseLocalMatrix`, true),
    );
  }
  for (const mesh of basis.meshes) {
    if (!nodeById.has(mesh.nodeId)) {
      fail(`mesh ${mesh.id} references missing physical node ${mesh.nodeId}`);
    }
  }
  for (const node of basis.nodes) {
    if (node.parentId !== undefined && !nodeById.has(node.parentId)) {
      fail(`node ${node.id} references missing parent ${node.parentId}`);
    }
  }

  const visitState = new Map<string, "visiting" | "visited">();
  const baseRootRelativeByNodeId = new Map<string, THREE.Matrix4>();
  const resolveBaseRootRelative = (nodeId: string): THREE.Matrix4 => {
    const cached = baseRootRelativeByNodeId.get(nodeId);
    if (cached) return cached;
    if (visitState.get(nodeId) === "visiting") {
      fail(`node hierarchy contains a cycle at ${nodeId}`);
    }
    visitState.set(nodeId, "visiting");
    const node = nodeById.get(nodeId)!;
    const local = baseLocalByNodeId.get(nodeId)!;
    const result = node.parentId
      ? resolveBaseRootRelative(node.parentId).clone().multiply(local)
      : local.clone();
    assertFiniteMatrix(result, `node ${nodeId} base root-relative matrix`);
    visitState.set(nodeId, "visited");
    baseRootRelativeByNodeId.set(nodeId, result);
    return result;
  };
  for (const node of basis.nodes) resolveBaseRootRelative(node.id);

  const followerNodeById = new Map<string, string>();
  for (const binding of basis.followerNodeBindings) {
    assertId(binding.id, "follower node binding id");
    if (followerNodeById.has(binding.id)) {
      fail(`follower node binding duplicates id ${binding.id}`);
    }
    if (!nodeById.has(binding.nodeId)) {
      fail(`follower node binding ${binding.id} references missing node`);
    }
    followerNodeById.set(binding.id, binding.nodeId);
  }
  for (const binding of basis.retainedTargetPositionBindings) {
    const physicalNodeId = followerNodeById.get(binding.node);
    if (!physicalNodeId) {
      fail(
        `retained target binding ${binding.id} references missing appearance node`,
      );
    }
    if (physicalNodeId !== meshById.get(binding.meshId)!.nodeId) {
      fail(
        `retained target binding ${binding.id} changed its physical mesh identity`,
      );
    }
  }
  for (const binding of basis.followerMorphPositionBindings) {
    const physicalNodeId = followerNodeById.get(binding.node);
    if (!physicalNodeId) {
      fail(
        `follower morph binding ${binding.id} references missing appearance node`,
      );
    }
    if (physicalNodeId !== meshById.get(binding.meshId)!.nodeId) {
      fail(
        `follower morph binding ${binding.id} changed its physical mesh identity`,
      );
    }
  }

  const followerTransformByKey = new Map<
    string,
    AppearanceRecipePhysicalBasis["followerNodeTransformBindings"][number]
  >();
  for (const binding of basis.followerNodeTransformBindings) {
    assertId(binding.follower, "follower transform binding follower");
    assertId(binding.channel, "follower transform binding channel");
    validateFollowerDriver(
      binding.driver,
      `${binding.follower}/${binding.channel}`,
    );
    assertId(binding.node, "follower transform binding node");
    const physicalNodeId = followerNodeById.get(binding.node);
    if (binding.nodeId === undefined) {
      if (physicalNodeId !== undefined) {
        fail(
          `follower transform ${binding.follower}/${binding.channel} omits its present physical node`,
        );
      }
    } else if (!physicalNodeId) {
      fail(
        `follower transform ${binding.follower}/${binding.channel} references missing appearance node ${binding.node}`,
      );
    } else if (physicalNodeId !== binding.nodeId) {
      fail(
        `follower transform ${binding.follower}/${binding.channel} changed its physical node binding`,
      );
    }
    const key = followerKey(binding.follower, binding.channel);
    if (followerTransformByKey.has(key)) {
      fail(
        `follower transform binding duplicates ${binding.follower}/${binding.channel}`,
      );
    }
    followerTransformByKey.set(key, binding);
  }

  const boneById = new Map<string, BasisBone>();
  const boneByNodeId = new Map<string, BasisBone>();
  const boneByAlias = new Map<string, BasisBone>();
  const addBoneAlias = (alias: string, bone: BasisBone) => {
    const existing = boneByAlias.get(alias);
    if (existing && existing.id !== bone.id) {
      fail(
        `bone alias ${alias} is ambiguous between ${existing.id} and ${bone.id}`,
      );
    }
    boneByAlias.set(alias, bone);
  };
  for (const bone of basis.bones) {
    addUnique(boneById, bone, "bone");
    assertId(bone.name, `bone ${bone.id}.name`);
    if (!nodeById.has(bone.nodeId)) {
      fail(`bone ${bone.id} references missing node ${bone.nodeId}`);
    }
    if (boneByNodeId.has(bone.nodeId)) {
      fail(`node ${bone.nodeId} is assigned to more than one bone`);
    }
    boneByNodeId.set(bone.nodeId, bone);
    addBoneAlias(bone.name, bone);
    const sanitizedName = sanitizeCustomRuntimeNodeName(bone.name);
    if (!sanitizedName) {
      fail(`bone ${bone.id} has an empty sanitized runtime alias`);
    }
    addBoneAlias(sanitizedName, bone);
  }

  const jointOffsetNames = new Set<string>();
  const jointOffsetBoneIds = new Set<string>();
  for (const binding of basis.jointOffsetBindings) {
    assertId(binding.bone, "joint offset binding bone");
    if (jointOffsetNames.has(binding.bone)) {
      fail(`joint offset binding duplicates bone ${binding.bone}`);
    }
    jointOffsetNames.add(binding.bone);
    const physical =
      boneByAlias.get(binding.bone) ??
      boneByAlias.get(sanitizeCustomRuntimeNodeName(binding.bone));
    if (!physical) {
      fail(`joint offset binding ${binding.bone} references missing bone`);
    }
    if (physical.id !== binding.boneId) {
      fail(
        `joint offset binding ${binding.bone} changed physical bone identity`,
      );
    }
    if (jointOffsetBoneIds.has(binding.boneId)) {
      fail(`joint offset bindings duplicate physical bone ${binding.boneId}`);
    }
    jointOffsetBoneIds.add(binding.boneId);
  }

  const skinIds = new Set<string>();
  for (const skin of basis.skins) {
    assertId(skin.id, "skin id");
    if (skinIds.has(skin.id)) fail(`skin duplicates id ${skin.id}`);
    skinIds.add(skin.id);
    if (skin.joints.length === 0) fail(`skin ${skin.id} has no joint slots`);
    const jointSlots = new Set<string>();
    skin.joints.forEach((joint, index) => {
      if (jointSlots.has(joint.boneId)) {
        fail(`skin ${skin.id} duplicates joint slot bone ${joint.boneId}`);
      }
      jointSlots.add(joint.boneId);
      if (!boneById.has(joint.boneId)) {
        fail(`skin ${skin.id} joint slot ${index} references missing bone`);
      }
      matrixFrom(
        joint.baseInverseBindMatrix,
        `skin ${skin.id} joint slot ${index} inverse bind`,
        false,
      );
    });
  }

  const roleKeys = new Set<string>();
  for (const role of basis.roles) {
    assertId(role.id, `${role.kind} role id`);
    if (!["stage", "attachment", "performance", "eye"].includes(role.kind)) {
      fail(`role ${role.id} has an unsupported kind`);
    }
    const key = `${role.kind}\u0000${role.id}`;
    if (roleKeys.has(key)) fail(`${role.kind} role duplicates id ${role.id}`);
    roleKeys.add(key);
    if (!nodeById.has(role.nodeId)) {
      fail(`${role.kind} role ${role.id} references missing node`);
    }
    if (role.declaredParent) {
      if (role.kind !== "attachment") {
        fail(`only attachment roles may declare an appearance parent`);
      }
      const actualParentId = nodeById.get(role.nodeId)!.parentId;
      if (!actualParentId) {
        fail(
          `attachment role ${role.id} declares a parent but has no physical parent`,
        );
      }
      if (role.declaredParent.kind === "node") {
        const declaredPhysicalParent = followerNodeById.get(
          role.declaredParent.id,
        );
        if (!declaredPhysicalParent) {
          fail(
            `attachment role ${role.id} declares missing appearance node parent ${role.declaredParent.id}`,
          );
        }
        if (actualParentId !== declaredPhysicalParent) {
          fail(
            `attachment role ${role.id} node parent does not match its hierarchy`,
          );
        }
      } else {
        const declaredBone =
          boneByAlias.get(role.declaredParent.name) ??
          boneByAlias.get(
            sanitizeCustomRuntimeNodeName(role.declaredParent.name),
          );
        if (!declaredBone) {
          fail(
            `attachment role ${role.id} declares missing bone parent ${role.declaredParent.name}`,
          );
        }
        if (actualParentId !== declaredBone.nodeId) {
          fail(
            `attachment role ${role.id} bone parent does not match its hierarchy`,
          );
        }
      }
    }
  }
  if (basis.hipsBone !== undefined) {
    assertId(basis.hipsBone, "hipsBone");
    const hips =
      boneByAlias.get(basis.hipsBone) ??
      boneByAlias.get(sanitizeCustomRuntimeNodeName(basis.hipsBone));
    if (!hips) fail(`hipsBone ${basis.hipsBone} does not resolve exactly`);
  }

  return {
    meshById,
    targetById,
    nodeById,
    boneById,
    boneByNodeId,
    boneByAlias,
    followerNodeById,
    followerTransformByKey,
    followerMorphPositionById,
    baseLocalByNodeId,
    baseRootRelativeByNodeId,
  };
}

/** Validate a package-independent physical basis without evaluating a Recipe. */
export function validateAppearanceRecipePhysicalBasis(
  basis: AppearanceRecipePhysicalBasis,
): void {
  validatePhysicalBasis(basis);
}

function resolveBoneByName(validated: ValidatedBasis, name: string): BasisBone {
  const bone =
    validated.boneByAlias.get(name) ??
    validated.boneByAlias.get(sanitizeCustomRuntimeNodeName(name));
  if (!bone) fail(`joint offset bone ${name} does not resolve exactly`);
  return bone;
}

function validateResolvedState(
  basis: AppearanceRecipePhysicalBasis,
  validated: ValidatedBasis,
  state: ResolvedAppearanceDialState,
) {
  finite(state.rootScale, "resolved rootScale");
  finite(state.soleOffsetY, "resolved soleOffsetY");

  const influences = [...state.influences];
  if (influences.length !== basis.targets.length) {
    fail(`resolved target influence count does not match the physical basis`);
  }
  influences.forEach(([target, weight], index) => {
    if (basis.targets[index]?.id !== target) {
      fail(`resolved target influence order changed at index ${index}`);
    }
    finite(weight, `target ${target} weight`);
  });

  const jointOffsets = [...state.jointOffsets];
  if (jointOffsets.length !== basis.jointOffsetBindings.length) {
    fail(`resolved joint offset count does not match the physical basis`);
  }
  jointOffsets.forEach(([bone, offset], index) => {
    const binding = basis.jointOffsetBindings[index];
    if (binding?.bone !== bone) {
      fail(`resolved joint offset order changed at index ${index}`);
    }
    if (resolveBoneByName(validated, bone).id !== binding.boneId) {
      fail(`resolved joint offset ${bone} changed physical identity`);
    }
    finiteVec3(offset, `joint offset ${bone}`);
  });

  if (
    state.followerState.morphs.length !== basis.followerMorphBindings.length
  ) {
    fail(`resolved follower morph count does not match the physical basis`);
  }
  state.followerState.morphs.forEach((morph, index) => {
    const binding = basis.followerMorphBindings[index];
    if (
      !binding ||
      binding.follower !== morph.follower ||
      binding.channel !== morph.channel ||
      !followerDriverEqual(binding.driver, morph.driver) ||
      binding.node !== morph.node ||
      binding.morph !== morph.morph
    ) {
      fail(
        `resolved follower morph order or identity changed at index ${index}`,
      );
    }
    finite(
      morph.weight,
      `follower morph ${morph.follower}/${morph.channel} weight`,
    );
  });

  if (
    state.followerState.nodeTransforms.length !==
    basis.followerNodeTransformBindings.length
  ) {
    fail(`resolved follower transform count does not match the physical basis`);
  }
  state.followerState.nodeTransforms.forEach((transform, index) => {
    const binding = basis.followerNodeTransformBindings[index];
    if (
      !binding ||
      binding.follower !== transform.follower ||
      binding.channel !== transform.channel ||
      !followerDriverEqual(binding.driver, transform.driver) ||
      binding.node !== transform.node
    ) {
      fail(
        `resolved follower transform order or identity changed at index ${index}`,
      );
    }
    followerDeltaMatrix(transform);
  });
}

/**
 * Evaluate the final absolute physical Recipe output without a loaded package,
 * GLB, Object3D hierarchy, or renderer. Operation order intentionally mirrors
 * AppearanceDialsEngineRuntime: retained weights, Float32 baking, joint rests,
 * followers, then runtime-root scale/grounding and world propagation.
 */
export function evaluateAppearanceRecipePhysicalOutput(
  basis: AppearanceRecipePhysicalBasis,
  state: ResolvedAppearanceDialState,
): AppearanceRecipePhysicalEvaluation {
  const validated = validatePhysicalBasis(basis);
  validateResolvedState(basis, validated, state);

  const positionsByMesh = new Map(
    basis.meshes.map((mesh) => [mesh.id, mesh.basePositions.slice()]),
  );
  const applyPositionDelta = (
    meshId: string,
    delta: AppearanceRecipePositionDelta,
    weight: number,
    context: string,
  ) => {
    if (Math.abs(weight) <= 1e-8) return;
    const output = positionsByMesh.get(meshId)!;
    visitPositionDelta(delta, context, (index, value) => {
      // The Float32Array write is deliberate: the live engine rounds after
      // every contribution, rather than once after the final sum.
      output[index] += value * weight;
      finite(output[index]!, `${context} output[${index}]`);
    });
  };
  for (const [targetId, weight] of state.influences) {
    for (const binding of basis.targetPositionBindings) {
      if (binding.targetId === targetId) {
        applyPositionDelta(
          binding.meshId,
          binding.positionDelta,
          weight,
          `target position binding ${binding.id} delta`,
        );
      }
    }
  }
  for (let index = 0; index < state.followerState.morphs.length; index += 1) {
    const morph = state.followerState.morphs[index]!;
    const inventory = basis.followerMorphBindings[index]!;
    if (inventory.positionBindingId === undefined) continue;
    const binding = validated.followerMorphPositionById.get(
      inventory.positionBindingId,
    )!;
    applyPositionDelta(
      binding.meshId,
      binding.positionDelta,
      morph.weight,
      `follower morph binding ${binding.id} delta`,
    );
  }

  const retainedTargetPositionBindings =
    basis.retainedTargetPositionBindings.map((binding) => ({
      id: binding.id,
      targetId: binding.targetId,
      node: binding.node,
      morph: binding.morph,
      meshId: binding.meshId,
      positionDelta: clonePositionDelta(
        binding.positionDelta,
        `retained target binding ${binding.id} output delta`,
      ),
      weight: state.influences.get(binding.targetId)!,
    }));
  const followerMorphWeights = state.followerState.morphs.map((morph) => ({
    follower: morph.follower,
    channel: morph.channel,
    driver: { ...morph.driver },
    node: morph.node,
    morph: morph.morph,
    weight: morph.weight,
  }));

  const localByNodeId = new Map(
    [...validated.baseLocalByNodeId].map(([id, matrix]) => [
      id,
      matrix.clone(),
    ]),
  );
  const offsetsByBoneId = new Map<string, THREE.Vector3>();
  const resolvedJointOffsets = [...state.jointOffsets];
  for (let index = 0; index < resolvedJointOffsets.length; index += 1) {
    const [, offset] = resolvedJointOffsets[index]!;
    const vector = new THREE.Vector3(...offset);
    assertFiniteVector3(
      vector,
      `joint offset ${basis.jointOffsetBindings[index]!.bone}`,
    );
    offsetsByBoneId.set(basis.jointOffsetBindings[index]!.boneId, vector);
  }
  const zero = new THREE.Vector3();
  const jointRests: AppearanceRecipePhysicalEvaluation["jointRests"] = [];
  for (const bone of basis.bones) {
    const node = validated.nodeById.get(bone.nodeId)!;
    const baseLocal = validated.baseLocalByNodeId.get(bone.nodeId)!;
    const position = new THREE.Vector3();
    const rotation = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    baseLocal.decompose(position, rotation, scale);
    assertFiniteVector3(position, `bone ${bone.name} base position`);
    assertFiniteQuaternion(rotation, `bone ${bone.name} base rotation`);
    assertFiniteVector3(scale, `bone ${bone.name} base scale`);
    const baseLocalPosition = position.clone();
    const ownOffset = offsetsByBoneId.get(bone.id) ?? zero;
    const parentBone = node.parentId
      ? validated.boneByNodeId.get(node.parentId)
      : undefined;
    const parentOffset = parentBone
      ? (offsetsByBoneId.get(parentBone.id) ?? zero)
      : zero;
    const localDelta = ownOffset.clone().sub(parentOffset);
    if (localDelta.lengthSq() > 0) {
      const parentRootRotation = new THREE.Quaternion();
      if (node.parentId) {
        validated.baseRootRelativeByNodeId
          .get(node.parentId)!
          .decompose(
            new THREE.Vector3(),
            parentRootRotation,
            new THREE.Vector3(),
          );
        assertFiniteQuaternion(
          parentRootRotation,
          `bone ${bone.name} parent root rotation`,
        );
      }
      localDelta.applyQuaternion(parentRootRotation.invert());
      assertFiniteVector3(localDelta, `bone ${bone.name} local joint delta`);
      position.add(localDelta);
      assertFiniteVector3(position, `bone ${bone.name} local position`);
    }
    const local = assertFiniteMatrix(
      new THREE.Matrix4().compose(position, rotation, scale),
      `bone ${bone.name} local matrix`,
    );
    localByNodeId.set(bone.nodeId, local);
    jointRests.push({
      boneId: bone.id,
      bone: bone.name,
      nodeId: bone.nodeId,
      ...(parentBone ? { parentBoneId: parentBone.id } : {}),
      avatarRootOffset: tupleFromVector(ownOffset),
      baseLocalPosition: tupleFromVector(baseLocalPosition),
      localPosition: tupleFromVector(position),
      localMatrix: arrayFromMatrix(local),
    });
  }

  const skins = basis.skins.map((skin) => ({
    id: skin.id,
    joints: skin.joints.map((joint) => {
      const offset = offsetsByBoneId.get(joint.boneId) ?? zero;
      const inverse = matrixFrom(
        joint.baseInverseBindMatrix,
        `skin ${skin.id}/${joint.boneId} inverse bind`,
        false,
      );
      if (offset.lengthSq() > 0) {
        inverse.multiply(
          new THREE.Matrix4().makeTranslation(-offset.x, -offset.y, -offset.z),
        );
      }
      assertFiniteMatrix(
        inverse,
        `skin ${skin.id}/${joint.boneId} output inverse bind`,
      );
      return {
        boneId: joint.boneId,
        inverseBindMatrix: arrayFromMatrix(inverse),
      };
    }),
  }));

  let hipsClipRemap: AppearanceRecipePhysicalEvaluation["hipsClipRemap"] = null;
  if (basis.hipsBone) {
    const hips = resolveBoneByName(validated, basis.hipsBone);
    const rest = jointRests.find((candidate) => candidate.boneId === hips.id)!;
    const ratio =
      Math.abs(rest.baseLocalPosition[1]) > 1e-6
        ? rest.localPosition[1] / rest.baseLocalPosition[1]
        : 1;
    finite(ratio, `hips ${hips.name} remap ratio`);
    hipsClipRemap = {
      boneId: hips.id,
      bone: hips.name,
      baseRest: [...rest.baseLocalPosition],
      newRest: [...rest.localPosition],
      ratio,
    };
  }

  const transformsByNode = new Map<
    string,
    ResolvedAppearanceFollowerNodeTransform[]
  >();
  for (const transform of state.followerState.nodeTransforms) {
    const entries = transformsByNode.get(transform.node) ?? [];
    entries.push(transform);
    transformsByNode.set(transform.node, entries);
  }
  // Iteration order is part of the basis because the live runtime stores one
  // captured rest per manifest node binding and applies those bindings in its
  // validated inventory order.
  for (const binding of basis.followerNodeBindings) {
    const composed = validated.baseLocalByNodeId.get(binding.nodeId)!.clone();
    for (const transform of transformsByNode.get(binding.id) ?? []) {
      composed.premultiply(followerDeltaMatrix(transform));
      assertFiniteMatrix(
        composed,
        `follower node ${binding.id} composed matrix`,
      );
    }
    const position = new THREE.Vector3();
    const rotation = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    composed.decompose(position, rotation, scale);
    assertFiniteVector3(position, `follower node ${binding.id} position`);
    assertFiniteQuaternion(rotation, `follower node ${binding.id} rotation`);
    assertFiniteVector3(scale, `follower node ${binding.id} scale`);
    localByNodeId.set(
      binding.nodeId,
      assertFiniteMatrix(
        new THREE.Matrix4().compose(position, rotation, scale),
        `follower node ${binding.id} local matrix`,
      ),
    );
  }

  const rootMatrix = matrixFrom(basis.rootBaseMatrix, "rootBaseMatrix", true);
  const rootPosition = new THREE.Vector3();
  const rootRotation = new THREE.Quaternion();
  const rootScale = new THREE.Vector3();
  rootMatrix.decompose(rootPosition, rootRotation, rootScale);
  assertFiniteVector3(rootPosition, "root position");
  assertFiniteQuaternion(rootRotation, "root rotation");
  assertFiniteVector3(rootScale, "root base scale");
  rootScale.multiplyScalar(state.rootScale);
  assertFiniteVector3(rootScale, "root evaluated scale");
  rootPosition.y =
    new THREE.Vector3().setFromMatrixPosition(
      matrixFrom(basis.rootBaseMatrix, "rootBaseMatrix", true),
    ).y -
    state.soleOffsetY * state.rootScale;
  assertFiniteVector3(rootPosition, "root grounded position");
  rootMatrix.compose(rootPosition, rootRotation, rootScale);
  assertFiniteMatrix(rootMatrix, "root evaluated matrix");

  const rootRelativeByNodeId = new Map<string, THREE.Matrix4>();
  const resolveRootRelative = (nodeId: string): THREE.Matrix4 => {
    const cached = rootRelativeByNodeId.get(nodeId);
    if (cached) return cached;
    const node = validated.nodeById.get(nodeId)!;
    const local = localByNodeId.get(nodeId)!;
    const result = node.parentId
      ? resolveRootRelative(node.parentId).clone().multiply(local)
      : local.clone();
    assertFiniteMatrix(result, `node ${nodeId} root-relative matrix`);
    rootRelativeByNodeId.set(nodeId, result);
    return result;
  };
  for (const node of basis.nodes) resolveRootRelative(node.id);

  const nodes = basis.nodes.map((node) => {
    const rootRelative = rootRelativeByNodeId.get(node.id)!;
    const world = assertFiniteMatrix(
      rootMatrix.clone().multiply(rootRelative),
      `node ${node.id} world matrix`,
    );
    return {
      id: node.id,
      ...(node.parentId ? { parentId: node.parentId } : {}),
      localMatrix: arrayFromMatrix(localByNodeId.get(node.id)!),
      rootRelativeMatrix: arrayFromMatrix(rootRelative),
      worldMatrix: arrayFromMatrix(world),
    };
  });
  const roles = basis.roles.map((role) => {
    const rootRelative = rootRelativeByNodeId.get(role.nodeId)!;
    const world = assertFiniteMatrix(
      rootMatrix.clone().multiply(rootRelative),
      `${role.kind} role ${role.id} world matrix`,
    );
    const worldPosition = new THREE.Vector3().setFromMatrixPosition(world);
    assertFiniteVector3(
      worldPosition,
      `${role.kind} role ${role.id} world position`,
    );
    return {
      kind: role.kind,
      id: role.id,
      nodeId: role.nodeId,
      ...(role.declaredParent
        ? { declaredParent: { ...role.declaredParent } }
        : {}),
      rootRelativeMatrix: arrayFromMatrix(rootRelative),
      worldMatrix: arrayFromMatrix(world),
      worldPosition: tupleFromVector(worldPosition),
    };
  });

  return {
    contract: APPEARANCE_RECIPE_PHYSICAL_EVALUATION_CONTRACT,
    meshes: basis.meshes.map((mesh) => ({
      id: mesh.id,
      nodeId: mesh.nodeId,
      positions: positionsByMesh.get(mesh.id)!,
    })),
    retainedTargetPositionBindings,
    followerMorphWeights,
    jointRests,
    skins,
    root: {
      matrix: arrayFromMatrix(rootMatrix),
      position: tupleFromVector(rootPosition),
      rotation: tupleFromQuaternion(rootRotation),
      scale: tupleFromVector(rootScale),
      rootScale: state.rootScale,
      soleOffsetY: state.soleOffsetY,
    },
    nodes,
    roles,
    hipsClipRemap,
  };
}
