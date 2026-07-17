import * as THREE from "three";
import type {
  AppearanceDialsManifest,
  AppearanceFollowerChannel,
  AppearanceFollowerDriverRef,
} from "../appearanceDials.contracts";
import { parseAppearanceDialsManifest } from "../appearanceDials.schema";
import { resolveCustomPerformanceRigManifest } from "../customPerformanceRig";
import { parseEyeAppearanceDefinition } from "../eyeAppearance";
import {
  APPEARANCE_RECIPE_PHYSICAL_BASIS_CONTRACT,
  validateAppearanceRecipePhysicalBasis,
  type AppearanceRecipePhysicalBasis,
  type AppearanceRecipePositionDelta,
} from "./appearanceRecipePhysicalEvaluator";
import {
  decodeSemanticGlbAccessor,
  getSemanticGlbMesh,
  getSemanticGlbNode,
  getSemanticGlbSkin,
  inspectSemanticGlbAccessor,
  parseSemanticGlb,
  resolveSemanticGlbNode,
  resolveSemanticGlbNodeTransform,
  stableSemanticGlbNodeName,
  visitSemanticGlbAccessorScalars,
  type SemanticGlbDocument,
  type SemanticJsonRecord,
} from "./semanticGlb";

export const APPEARANCE_RECIPE_PHYSICAL_MODEL_CONTRACT =
  "appearance-recipe-physical-model/v1" as const;

export type AppearanceRecipePhysicalModelOptions = {
  /** Synthetic runtime-root rest transform. Raw GLB scenes default to identity. */
  rootBaseMatrix?: readonly number[];
};

type ActiveScene = {
  order: number[];
  reachable: Set<number>;
};

type PhysicalMesh = {
  id: string;
  nodeIndex: number;
  nodeId: string;
  primitiveIndex: number;
  primitive: SemanticJsonRecord;
  mesh: SemanticJsonRecord;
  baseAccessor: number;
  basePositions: Float32Array;
};

type RecipeMesh = PhysicalMesh & {
  targetNames: string[];
  targetWeights: number[];
};

const DIAGNOSTIC_PREFIX = APPEARANCE_RECIPE_PHYSICAL_MODEL_CONTRACT;
const IDENTITY_MATRIX = Object.freeze([
  1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
]);
const STAGE_ANCHOR_IDS = new Set([
  "head",
  "hips",
  "feet",
  "leftFoot",
  "rightFoot",
]);

function fail(message: string): never {
  throw new Error(`[${DIAGNOSTIC_PREFIX}] ${message}`);
}

function record(value: unknown, context: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${context} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail(`${context} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, context: string): unknown[] {
  if (!Array.isArray(value)) fail(`${context} must be an array`);
  return value;
}

function optionalArray(value: unknown, context: string): unknown[] {
  return value === undefined ? [] : array(value, context);
}

function integer(value: unknown, context: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    fail(`${context} must be a safe integer >= ${minimum}`);
  }
  return value as number;
}

function finite(value: unknown, context: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(`${context} must be finite`);
  }
  return Object.is(value, -0) ? 0 : value;
}

function string(value: unknown, context: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    fail(`${context} must be a non-empty trimmed string`);
  }
  return value;
}

function indexRecord<T>(values: T[], value: unknown, context: string): T {
  const index = integer(value, context);
  if (index >= values.length) fail(`${context} is out of range`);
  return values[index]!;
}

function nodeId(nodeIndex: number): string {
  return `node:${nodeIndex}`;
}

function boneId(nodeIndex: number): string {
  return `bone:${nodeIndex}`;
}

function parseActiveScene(parsed: SemanticGlbDocument): ActiveScene {
  const scenes = array(parsed.gltf.scenes, "gltf.scenes");
  if (scenes.length === 0) fail("avatar.glb has no scenes");
  const activeSceneIndex = integer(parsed.gltf.scene ?? 0, "gltf.scene");
  const activeScene = record(
    indexRecord(scenes, activeSceneIndex, "gltf.scene"),
    `gltf.scenes[${activeSceneIndex}]`,
  );
  const roots = array(
    activeScene.nodes,
    `gltf.scenes[${activeSceneIndex}].nodes`,
  ).map((value, index) =>
    integer(value, `gltf.scenes[${activeSceneIndex}].nodes[${index}]`),
  );
  if (roots.length === 0) fail("active GLB scene has no root nodes");
  if (new Set(roots).size !== roots.length) {
    fail("active GLB scene repeats a root node");
  }

  const reachable = new Set<number>();
  const order: number[] = [];
  const visit = (current: number, context: string) => {
    if (current >= parsed.nodes.length) fail(`${context} is out of range`);
    if (reachable.has(current)) {
      fail(`active GLB scene reaches node ${current} more than once`);
    }
    reachable.add(current);
    order.push(current);
    const node = getSemanticGlbNode(parsed, current, context);
    for (const [childIndex, childValue] of optionalArray(
      node.children,
      `${context}.children`,
    ).entries()) {
      visit(
        integer(childValue, `${context}.children[${childIndex}]`),
        `${context}.children[${childIndex}]`,
      );
    }
  };
  roots.forEach((root, index) => {
    if (parsed.parents.has(root)) {
      fail(`active GLB scene root ${root} has a parent outside the scene root`);
    }
    visit(root, `gltf.scenes[${activeSceneIndex}].nodes[${index}]`);
  });
  return { order, reachable };
}

function resolveReachableNode(
  parsed: SemanticGlbDocument,
  active: ActiveScene,
  value: unknown,
  context: string,
): number {
  const resolved = resolveSemanticGlbNode(parsed, value, context);
  if (!active.reachable.has(resolved)) {
    fail(`${context} resolves outside the active GLB scene`);
  }
  return resolved;
}

function resolveAppearanceNode(
  parsed: SemanticGlbDocument,
  active: ActiveScene,
  declaration: AppearanceDialsManifest["nodes"][string],
  context: string,
): number | null {
  const raw = parsed.rawNodeByName.get(declaration.node);
  const runtime = parsed.runtimeNodeByName.get(declaration.node);
  if (raw === undefined && runtime === undefined) {
    if (!declaration.required) return null;
    return resolveReachableNode(parsed, active, declaration.node, context);
  }
  const resolved = resolveSemanticGlbNode(parsed, declaration.node, context);
  if (!active.reachable.has(resolved)) {
    if (!declaration.required) return null;
    fail(`${context} resolves outside the active GLB scene`);
  }
  return resolved;
}

function assertAppearanceNodeShape(
  parsed: SemanticGlbDocument,
  nodeIndex: number,
  declaration: AppearanceDialsManifest["nodes"][string],
  context: string,
) {
  const node = getSemanticGlbNode(parsed, nodeIndex, context);
  const isMesh = node.mesh !== undefined;
  if ((declaration.kind === "mesh") !== isMesh) {
    fail(
      `${context} declares kind ${declaration.kind} but the GLB node is ${isMesh ? "mesh" : "anchor"}`,
    );
  }
  const transform = resolveSemanticGlbNodeTransform(node, context, {
    diagnosticPrefix: DIAGNOSTIC_PREFIX,
  });
  const matrix = new THREE.Matrix4().fromArray(transform.matrix);
  const scale = new THREE.Vector3();
  matrix.decompose(new THREE.Vector3(), new THREE.Quaternion(), scale);
  if (
    declaration.scalePolicy === "uniform-only" &&
    (Math.abs(scale.x - scale.y) > 1e-7 || Math.abs(scale.x - scale.z) > 1e-7)
  ) {
    fail(`${context} violates its uniform-only scale policy`);
  }
}

function assertDeclaredParent(
  parsed: SemanticGlbDocument,
  active: ActiveScene,
  manifest: AppearanceDialsManifest,
  appearanceNodeIndices: Map<string, number | null>,
  appearanceNodeId: string,
) {
  const declaration = manifest.nodes[appearanceNodeId]!;
  if (!declaration.parent) return;
  const child = appearanceNodeIndices.get(appearanceNodeId);
  if (child === null || child === undefined) return;
  let expected: number;
  if (declaration.parent.kind === "node") {
    const resolved = appearanceNodeIndices.get(declaration.parent.id);
    if (resolved === undefined || resolved === null) {
      fail(
        `appearance node ${appearanceNodeId} references missing appearance parent ${declaration.parent.id}`,
      );
    }
    expected = resolved;
  } else {
    expected = resolveReachableNode(
      parsed,
      active,
      declaration.parent.name,
      `appearance node ${appearanceNodeId} bone parent`,
    );
  }
  if (parsed.parents.get(child) !== expected) {
    fail(
      `appearance node ${appearanceNodeId} does not have its declared direct parent`,
    );
  }
}

function activePhysicalMeshes(
  parsed: SemanticGlbDocument,
  active: ActiveScene,
): { meshes: PhysicalMesh[]; byNode: Map<number, PhysicalMesh[]> } {
  const meshes: PhysicalMesh[] = [];
  const byNode = new Map<number, PhysicalMesh[]>();
  for (const nodeIndex of active.order) {
    const node = getSemanticGlbNode(
      parsed,
      nodeIndex,
      `gltf.nodes[${nodeIndex}]`,
    );
    if (node.mesh === undefined) continue;
    const meshIndex = integer(node.mesh, `gltf.nodes[${nodeIndex}].mesh`);
    const mesh = getSemanticGlbMesh(
      parsed,
      meshIndex,
      `gltf.nodes[${nodeIndex}].mesh`,
    );
    const primitives = array(
      mesh.primitives,
      `gltf.meshes[${meshIndex}].primitives`,
    );
    if (primitives.length === 0) {
      fail(`active GLB mesh node ${nodeIndex} has no primitives`);
    }
    for (const [primitiveIndex, primitiveValue] of primitives.entries()) {
      const context = `gltf.nodes[${nodeIndex}] primitive ${primitiveIndex}`;
      const primitive = record(primitiveValue, context);
      const attributes = record(primitive.attributes, `${context}.attributes`);
      if (attributes.POSITION === undefined) {
        fail(`${context} is missing POSITION`);
      }
      const baseAccessor = integer(attributes.POSITION, `${context}.POSITION`);
      const baseInfo = inspectSemanticGlbAccessor(parsed, baseAccessor);
      if (
        baseInfo.type !== "VEC3" ||
        baseInfo.components !== 3 ||
        baseInfo.componentType !== 5126 ||
        baseInfo.normalized
      ) {
        fail(`${context} POSITION must be an unnormalized FLOAT VEC3`);
      }
      const decoded = decodeSemanticGlbAccessor(parsed, baseAccessor);
      const basePositions = new Float32Array(decoded.values.length);
      decoded.values.forEach((value, index) => {
        basePositions[index] = value;
      });
      const entry: PhysicalMesh = {
        id: `mesh:${nodeIndex}:${primitiveIndex}`,
        nodeIndex,
        nodeId: nodeId(nodeIndex),
        primitiveIndex,
        primitive,
        mesh,
        baseAccessor,
        basePositions,
      };
      meshes.push(entry);
      const nodeMeshes = byNode.get(nodeIndex) ?? [];
      nodeMeshes.push(entry);
      byNode.set(nodeIndex, nodeMeshes);
    }
  }
  return { meshes, byNode };
}

function effectiveTargetWeights(
  parsed: SemanticGlbDocument,
  nodeIndex: number,
  mesh: SemanticJsonRecord,
  targetCount: number,
  context: string,
): number[] {
  const node = getSemanticGlbNode(parsed, nodeIndex, context);
  const declared = node.weights ?? mesh.weights;
  if (declared === undefined) return new Array(targetCount).fill(0);
  const weights = array(declared, `${context}.weights`).map((value, index) =>
    finite(value, `${context}.weights[${index}]`),
  );
  if (weights.length !== targetCount) {
    fail(`${context} morph weights do not match its target inventory`);
  }
  return weights;
}

function createRecipeMesh(
  parsed: SemanticGlbDocument,
  appearanceNodeId: string,
  physicalMeshesByNode: Map<number, PhysicalMesh[]>,
  nodeIndex: number,
): RecipeMesh {
  const context = `appearance mesh ${appearanceNodeId}`;
  const physicalMeshes = physicalMeshesByNode.get(nodeIndex) ?? [];
  if (physicalMeshes.length !== 1) {
    fail(
      `${context} must have exactly one primitive for first-party Recipe morph binding`,
    );
  }
  const physical = physicalMeshes[0]!;

  const extras = record(physical.mesh.extras, `${context}.mesh.extras`);
  const targetNames = array(
    extras.targetNames,
    `${context}.mesh.extras.targetNames`,
  ).map((value, index) =>
    string(value, `${context}.mesh.extras.targetNames[${index}]`),
  );
  if (new Set(targetNames).size !== targetNames.length) {
    fail(`${context} has duplicate morph target names`);
  }
  const targets = optionalArray(
    physical.primitive.targets,
    `${context}.targets`,
  );
  if (targets.length !== targetNames.length) {
    fail(`${context} morph target names and payloads are misaligned`);
  }
  const targetWeights = effectiveTargetWeights(
    parsed,
    nodeIndex,
    physical.mesh,
    targetNames.length,
    context,
  );
  return {
    ...physical,
    targetNames,
    targetWeights,
  };
}

function morphIndex(mesh: RecipeMesh, morph: string, context: string): number {
  const index = mesh.targetNames.indexOf(morph);
  if (index < 0) fail(`${context} references missing morph ${morph}`);
  if (mesh.targetWeights[index] !== 0) {
    fail(`${context} Recipe-owned morph ${morph} has a nonzero initial weight`);
  }
  return index;
}

function lazyPositionDelta(
  parsed: SemanticGlbDocument,
  mesh: RecipeMesh,
  morph: string,
  context: string,
): AppearanceRecipePositionDelta {
  const index = morphIndex(mesh, morph, context);
  const target = record(
    array(mesh.primitive.targets, `${context}.targets`)[index],
    `${context}.target`,
  );
  const accessorIndex = integer(target.POSITION, `${context}.POSITION`);
  const info = inspectSemanticGlbAccessor(parsed, accessorIndex);
  const base = inspectSemanticGlbAccessor(parsed, mesh.baseAccessor);
  if (
    info.type !== "VEC3" ||
    info.components !== 3 ||
    info.componentType !== 5126 ||
    info.normalized ||
    info.count !== base.count
  ) {
    fail(
      `${context} POSITION delta must be an unnormalized FLOAT VEC3 matching the neutral mesh`,
    );
  }
  return {
    length: info.count * info.components,
    visit(visitor) {
      visitSemanticGlbAccessorScalars(
        parsed,
        accessorIndex,
        (row, component, value) => {
          if (value !== 0) visitor(row * info.components + component, value);
        },
      );
    },
  };
}

function orderedFollowerChannels(manifest: AppearanceDialsManifest): Array<{
  follower: string;
  driver: AppearanceFollowerDriverRef;
  channel: AppearanceFollowerChannel;
}> {
  const result: Array<{
    follower: string;
    driver: AppearanceFollowerDriverRef;
    channel: AppearanceFollowerChannel;
  }> = [];
  for (const [follower, declaration] of Object.entries(manifest.followers).sort(
    ([left], [right]) => left.localeCompare(right),
  )) {
    const channels = declaration.drivers
      .flatMap((entry) =>
        entry.channels.map((channel) => ({
          driver: entry.driver,
          channel,
        })),
      )
      .sort((left, right) => left.channel.id.localeCompare(right.channel.id));
    channels.forEach(({ driver, channel }) =>
      result.push({ follower, driver, channel }),
    );
  }
  return result;
}

function parseStageAnchors(
  rawManifest: Record<string, unknown>,
): Record<string, string> {
  const stage = record(rawManifest.stage, "avatar.json#stage");
  const anchors = record(stage.anchors, "avatar.json#stage.anchors");
  for (const key of Object.keys(anchors)) {
    if (!STAGE_ANCHOR_IDS.has(key)) {
      fail(`avatar.json#stage.anchors.${key} is not supported`);
    }
  }
  const parsed = Object.fromEntries(
    Object.entries(anchors).map(([id, value]) => [
      id,
      string(value, `avatar.json#stage.anchors.${id}`),
    ]),
  );
  if (!parsed.head || !parsed.hips) {
    fail("stage anchors must declare head and hips");
  }
  if (!parsed.feet && !(parsed.leftFoot && parsed.rightFoot)) {
    fail("stage anchors must declare feet or both leftFoot and rightFoot");
  }
  return parsed;
}

/**
 * Build the renderer-independent physical basis directly from exact package
 * bytes. Neutral mesh arrays are dense Float32 values; Recipe deltas stay
 * repeatable, visitor-backed GLB accessors so the full target catalog is never
 * materialized at once.
 */
export function buildAppearanceRecipePhysicalBasisFromGlb(
  glbBytes: Uint8Array,
  avatarManifest: unknown,
  options: AppearanceRecipePhysicalModelOptions = {},
): AppearanceRecipePhysicalBasis {
  const rawManifest = record(avatarManifest, "avatar.json");
  const manifest = parseAppearanceDialsManifest(rawManifest);
  if (!manifest) {
    fail("avatar.json does not contain appearance-dials/v2");
  }
  const parsed = parseSemanticGlb(glbBytes, {
    diagnosticPrefix: DIAGNOSTIC_PREFIX,
  });
  const active = parseActiveScene(parsed);
  const physicalMeshes = activePhysicalMeshes(parsed, active);

  const appearanceNodeIndices = new Map<string, number | null>();
  for (const [id, declaration] of Object.entries(manifest.nodes)) {
    const resolved = resolveAppearanceNode(
      parsed,
      active,
      declaration,
      `appearance node ${id}`,
    );
    if (resolved !== null) {
      assertAppearanceNodeShape(
        parsed,
        resolved,
        declaration,
        `appearance node ${id}`,
      );
    }
    appearanceNodeIndices.set(id, resolved);
  }
  for (const id of appearanceNodeIndices.keys()) {
    assertDeclaredParent(parsed, active, manifest, appearanceNodeIndices, id);
  }

  const recipeMeshes = new Map<string, RecipeMesh>();
  const ensureRecipeMesh = (appearanceNodeId: string): RecipeMesh => {
    const cached = recipeMeshes.get(appearanceNodeId);
    if (cached) return cached;
    const resolved = appearanceNodeIndices.get(appearanceNodeId);
    if (resolved === undefined || resolved === null) {
      fail(
        `Recipe binding references missing appearance node ${appearanceNodeId}`,
      );
    }
    const created = createRecipeMesh(
      parsed,
      appearanceNodeId,
      physicalMeshes.byNode,
      resolved,
    );
    recipeMeshes.set(appearanceNodeId, created);
    return created;
  };

  const targets: AppearanceRecipePhysicalBasis["targets"] = [];
  const targetPositionBindings: AppearanceRecipePhysicalBasis["targetPositionBindings"] =
    [];
  const retainedTargetPositionBindings: AppearanceRecipePhysicalBasis["retainedTargetPositionBindings"] =
    [];
  for (const [targetId, target] of Object.entries(manifest.targets)) {
    targets.push({ id: targetId, runtimeRetention: target.runtimeRetention });
    target.bindings.forEach((binding, bindingIndex) => {
      const mesh = ensureRecipeMesh(binding.node);
      const context = `appearance target ${targetId} binding ${bindingIndex}`;
      morphIndex(mesh, binding.morph, context);
      if (target.runtimeRetention === "recipe-only") {
        targetPositionBindings.push({
          id: `target:${targetId}:${bindingIndex}`,
          targetId,
          meshId: mesh.id,
          positionDelta: lazyPositionDelta(
            parsed,
            mesh,
            binding.morph,
            context,
          ),
        });
      } else {
        retainedTargetPositionBindings.push({
          id: `retained:${targetId}:${bindingIndex}`,
          targetId,
          node: binding.node,
          morph: binding.morph,
          meshId: mesh.id,
          positionDelta: lazyPositionDelta(
            parsed,
            mesh,
            binding.morph,
            context,
          ),
        });
      }
    });
  }

  const followerMorphPositionBindings: AppearanceRecipePhysicalBasis["followerMorphPositionBindings"] =
    [];
  const followerMorphBindings: AppearanceRecipePhysicalBasis["followerMorphBindings"] =
    [];
  const followerNodeTransformBindings: AppearanceRecipePhysicalBasis["followerNodeTransformBindings"] =
    [];
  for (const { follower, driver, channel } of orderedFollowerChannels(
    manifest,
  )) {
    const physicalNode = appearanceNodeIndices.get(channel.node);
    if (physicalNode === undefined) {
      fail(
        `appearance follower ${follower}/${channel.id} references missing node`,
      );
    }
    if (channel.kind === "node-trs") {
      followerNodeTransformBindings.push({
        follower,
        channel: channel.id,
        driver,
        node: channel.node,
        ...(physicalNode === null ? {} : { nodeId: nodeId(physicalNode) }),
      });
      continue;
    }
    if (physicalNode === null) {
      followerMorphBindings.push({
        follower,
        channel: channel.id,
        driver,
        node: channel.node,
        morph: channel.morph,
      });
      continue;
    }
    const mesh = ensureRecipeMesh(channel.node);
    const context = `appearance follower ${follower}/${channel.id}`;
    const positionBindingId = `follower:${follower}:${channel.id}`;
    followerMorphPositionBindings.push({
      id: positionBindingId,
      follower,
      channel: channel.id,
      node: channel.node,
      morph: channel.morph,
      meshId: mesh.id,
      positionDelta: lazyPositionDelta(parsed, mesh, channel.morph, context),
    });
    followerMorphBindings.push({
      follower,
      channel: channel.id,
      driver,
      node: channel.node,
      morph: channel.morph,
      positionBindingId,
    });
  }

  const jointNodeIndices = new Set<number>();
  const activeSkinIndices = new Set<number>();
  for (const activeNodeIndex of active.order) {
    const activeNode = getSemanticGlbNode(
      parsed,
      activeNodeIndex,
      `gltf.nodes[${activeNodeIndex}]`,
    );
    if (activeNode.skin !== undefined) {
      activeSkinIndices.add(
        integer(activeNode.skin, `gltf.nodes[${activeNodeIndex}].skin`),
      );
    }
  }
  for (const skinIndex of activeSkinIndices) {
    const skin = getSemanticGlbSkin(
      parsed,
      skinIndex,
      `gltf.skins[${skinIndex}]`,
    );
    if (skin.skeleton !== undefined) {
      const skeleton = integer(
        skin.skeleton,
        `gltf.skins[${skinIndex}].skeleton`,
      );
      if (skeleton >= parsed.nodes.length) {
        fail(`gltf.skins[${skinIndex}].skeleton is out of range`);
      }
      if (!active.reachable.has(skeleton)) {
        fail(`gltf.skins[${skinIndex}].skeleton is outside the active scene`);
      }
    }
    const seenJointSlots = new Set<number>();
    for (const [slot, jointValue] of array(
      skin.joints,
      `gltf.skins[${skinIndex}].joints`,
    ).entries()) {
      const joint = integer(
        jointValue,
        `gltf.skins[${skinIndex}].joints[${slot}]`,
      );
      if (joint >= parsed.nodes.length) {
        fail(`gltf.skins[${skinIndex}].joints[${slot}] is out of range`);
      }
      if (!active.reachable.has(joint)) {
        fail(
          `gltf.skins[${skinIndex}].joints[${slot}] is outside the active scene`,
        );
      }
      if (seenJointSlots.has(joint)) {
        fail(`gltf.skins[${skinIndex}] repeats joint node ${joint}`);
      }
      seenJointSlots.add(joint);
      jointNodeIndices.add(joint);
    }
  }
  const bones: AppearanceRecipePhysicalBasis["bones"] = active.order
    .filter((index) => jointNodeIndices.has(index))
    .map((index) => ({
      id: boneId(index),
      name: stableSemanticGlbNodeName(parsed, index, `bone ${index}`),
      nodeId: nodeId(index),
    }));
  const jointOffsetBindings: AppearanceRecipePhysicalBasis["jointOffsetBindings"] =
    [];
  const jointOffsetNames = new Set<string>();
  for (const perBone of Object.values(manifest.jointFollow?.deltas ?? {})) {
    for (const bone of Object.keys(perBone)) {
      if (jointOffsetNames.has(bone)) continue;
      jointOffsetNames.add(bone);
      const physical = resolveReachableNode(
        parsed,
        active,
        bone,
        `appearance joint offset ${bone}`,
      );
      if (!jointNodeIndices.has(physical)) {
        fail(
          `appearance joint offset ${bone} does not resolve to a skin joint`,
        );
      }
      jointOffsetBindings.push({ bone, boneId: boneId(physical) });
    }
  }

  const skins: AppearanceRecipePhysicalBasis["skins"] = [];
  for (const skinnedNodeIndex of active.order) {
    const skinnedNode = getSemanticGlbNode(
      parsed,
      skinnedNodeIndex,
      `gltf.nodes[${skinnedNodeIndex}]`,
    );
    if (skinnedNode.skin === undefined) continue;
    if (skinnedNode.mesh === undefined) {
      fail(`gltf.nodes[${skinnedNodeIndex}] declares a skin without a mesh`);
    }
    const skinIndex = integer(
      skinnedNode.skin,
      `gltf.nodes[${skinnedNodeIndex}].skin`,
    );
    const skin = getSemanticGlbSkin(
      parsed,
      skinIndex,
      `gltf.nodes[${skinnedNodeIndex}].skin`,
    );
    const joints = array(skin.joints, `gltf.skins[${skinIndex}].joints`).map(
      (value, slot) =>
        integer(value, `gltf.skins[${skinIndex}].joints[${slot}]`),
    );
    if (joints.length === 0) fail(`gltf.skins[${skinIndex}] has no joints`);
    if (new Set(joints).size !== joints.length) {
      fail(`gltf.skins[${skinIndex}] repeats a joint slot`);
    }
    if (skin.inverseBindMatrices === undefined) {
      fail(`gltf.skins[${skinIndex}] is missing inverseBindMatrices`);
    }
    const inverseAccessor = inspectSemanticGlbAccessor(
      parsed,
      skin.inverseBindMatrices,
    );
    if (
      inverseAccessor.type !== "MAT4" ||
      inverseAccessor.components !== 16 ||
      inverseAccessor.componentType !== 5126 ||
      inverseAccessor.normalized ||
      inverseAccessor.count !== joints.length
    ) {
      fail(`gltf.skins[${skinIndex}] has malformed inverse-bind matrices`);
    }
    const inverseValues = decodeSemanticGlbAccessor(
      parsed,
      skin.inverseBindMatrices,
    ).values;
    skins.push({
      id: `skin:${skinnedNodeIndex}:${skinIndex}`,
      joints: joints.map((joint, slot) => ({
        boneId: boneId(joint),
        baseInverseBindMatrix: Array.from(
          inverseValues.subarray(slot * 16, slot * 16 + 16),
        ),
      })),
    });
  }

  const roles: AppearanceRecipePhysicalBasis["roles"] = [];
  for (const [id, declaration] of Object.entries(manifest.nodes)) {
    if (declaration.role !== "attachment-anchor") continue;
    if (!declaration.parent) {
      fail(`appearance attachment ${id} must declare its direct parent`);
    }
    const physicalNode = appearanceNodeIndices.get(id);
    if (physicalNode === undefined || physicalNode === null) {
      if (declaration.required) {
        fail(`required appearance attachment ${id} is missing from avatar.glb`);
      }
      continue;
    }
    roles.push({
      kind: "attachment",
      id,
      nodeId: nodeId(physicalNode),
      declaredParent: declaration.parent,
    });
  }
  for (const [id, nodeName] of Object.entries(parseStageAnchors(rawManifest))) {
    roles.push({
      kind: "stage",
      id,
      nodeId: nodeId(
        resolveReachableNode(parsed, active, nodeName, `stage anchor ${id}`),
      ),
    });
  }

  const rawRig = rawManifest.rig;
  const rawPerformance =
    rawRig === undefined
      ? undefined
      : record(rawRig, "avatar.json#rig").performance;
  const performance = resolveCustomPerformanceRigManifest(rawPerformance);
  if (performance.issues.length > 0) {
    fail(`malformed rig.performance: ${performance.issues.join(" ")}`);
  }
  if (performance.manifest) {
    const claimed = new Map<number, string>();
    for (const role of ["head", "neck", "leftEye", "rightEye"] as const) {
      const physical = resolveReachableNode(
        parsed,
        active,
        performance.manifest.nodes[role].node,
        `rig.performance.nodes.${role}.node`,
      );
      const prior = claimed.get(physical);
      if (prior) fail(`rig.performance.nodes.${role}.node duplicates ${prior}`);
      claimed.set(physical, `nodes.${role}`);
      roles.push({
        kind: "performance",
        id: `look.${role}`,
        nodeId: nodeId(physical),
      });
    }
    for (const [role, target] of Object.entries(
      performance.manifest.targetTransforms,
    )) {
      const physical = resolveReachableNode(
        parsed,
        active,
        target.node,
        `rig.performance.targetTransforms.${role}.node`,
      );
      const prior = claimed.get(physical);
      if (prior) {
        fail(
          `rig.performance.targetTransforms.${role}.node duplicates ${prior}`,
        );
      }
      claimed.set(physical, `targetTransforms.${role}`);
      roles.push({
        kind: "performance",
        id: `target.${role}`,
        nodeId: nodeId(physical),
      });
    }
  }

  if (
    rawManifest.eyeAppearance !== undefined &&
    rawManifest.eyeAppearance !== null
  ) {
    const eye = parseEyeAppearanceDefinition(rawManifest.eyeAppearance);
    const claimedAssemblies = new Set<number>();
    for (const side of ["left", "right"] as const) {
      const binding = eye.runtimeBindings[side];
      const eyeBone = resolveReachableNode(
        parsed,
        active,
        binding.eyeBone,
        `eyeAppearance.runtimeBindings.${side}.eyeBone`,
      );
      if (!jointNodeIndices.has(eyeBone)) {
        fail(`eyeAppearance ${side} eye bone is not a skin joint`);
      }
      roles.push({ kind: "eye", id: `${side}.bone`, nodeId: nodeId(eyeBone) });
      for (const [assemblyRole, assemblyName] of Object.entries(
        binding.assemblyNodes,
      )) {
        const assembly = resolveReachableNode(
          parsed,
          active,
          assemblyName,
          `eyeAppearance.runtimeBindings.${side}.assemblyNodes.${assemblyRole}`,
        );
        if (parsed.parents.get(assembly) !== eyeBone) {
          fail(
            `eyeAppearance ${side} ${assemblyRole} is not a direct child of its eye bone`,
          );
        }
        if (
          getSemanticGlbNode(
            parsed,
            assembly,
            `eyeAppearance ${side} ${assemblyRole}`,
          ).mesh === undefined
        ) {
          fail(`eyeAppearance ${side} ${assemblyRole} is not a mesh node`);
        }
        if (claimedAssemblies.has(assembly)) {
          fail(
            `eyeAppearance assembly node ${assemblyName} is declared more than once`,
          );
        }
        claimedAssemblies.add(assembly);
        roles.push({
          kind: "eye",
          id: `${side}.assembly.${assemblyRole}`,
          nodeId: nodeId(assembly),
        });
      }
    }
  }

  const basis: AppearanceRecipePhysicalBasis = {
    contract: APPEARANCE_RECIPE_PHYSICAL_BASIS_CONTRACT,
    rootBaseMatrix: [...(options.rootBaseMatrix ?? IDENTITY_MATRIX)],
    meshes: physicalMeshes.meshes.map((mesh) => ({
      id: mesh.id,
      nodeId: mesh.nodeId,
      basePositions: mesh.basePositions,
    })),
    targets,
    targetPositionBindings,
    retainedTargetPositionBindings,
    followerMorphPositionBindings,
    followerMorphBindings,
    nodes: active.order.map((index) => {
      const parent = parsed.parents.get(index);
      return {
        id: nodeId(index),
        ...(parent === undefined ? {} : { parentId: nodeId(parent) }),
        baseLocalMatrix: resolveSemanticGlbNodeTransform(
          getSemanticGlbNode(parsed, index, `gltf.nodes[${index}]`),
          `gltf.nodes[${index}]`,
          { diagnosticPrefix: DIAGNOSTIC_PREFIX },
        ).matrix,
      };
    }),
    followerNodeBindings: Object.keys(manifest.nodes).flatMap((id) => {
      const physicalNode = appearanceNodeIndices.get(id);
      return physicalNode === null || physicalNode === undefined
        ? []
        : [{ id, nodeId: nodeId(physicalNode) }];
    }),
    followerNodeTransformBindings,
    bones,
    jointOffsetBindings,
    skins,
    roles,
    ...(manifest.jointFollow?.clipRemap?.hipsBone
      ? { hipsBone: manifest.jointFollow.clipRemap.hipsBone }
      : {}),
  };
  validateAppearanceRecipePhysicalBasis(basis);
  return basis;
}
