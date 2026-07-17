import { parseRecipeSourceIdentity } from "./packageMetadata";
import {
  canonicalRecipeSha256,
  canonicalRecipeString,
  requireLowercaseSha256,
  sha256Hex,
} from "./recipeCanonical";
import {
  decodeSemanticGlbAccessor,
  parseSemanticGlb,
  resolveSemanticGlbNode,
  resolveSemanticGlbNodeTransform,
  stableSemanticGlbNodeName,
  type SemanticGlbAccessor,
  type SemanticGlbDocument,
} from "./semanticGlb";

export const RECIPE_PHYSICAL_BASIS_PROJECTION_CONTRACT =
  "recipe-physical-basis/v1" as const;
export const RECIPE_BEHAVIOR_PROJECTION_CONTRACT =
  "recipe-behavior/v1" as const;
export const RECIPE_COMPONENT_GRAPH_PROJECTION_CONTRACT =
  "recipe-component-graph/v1" as const;
export const RECIPE_TOPOLOGY_PROJECTION_CONTRACT =
  "recipe-topology/v1" as const;
export const RECIPE_SKELETON_HIERARCHY_PROJECTION_CONTRACT =
  "recipe-skeleton-hierarchy/v1" as const;

export type RecipeSourceProjectionHashes = {
  physicalBasisSha256: string;
  behaviorSha256: string;
  componentGraphSha256: string;
  topologySha256: string;
  skeletonHierarchySha256: string;
};

const RECIPE_SOURCE_PROJECTION_HASH_FIELDS = [
  "physicalBasisSha256",
  "behaviorSha256",
  "componentGraphSha256",
  "topologySha256",
  "skeletonHierarchySha256",
] as const satisfies ReadonlyArray<keyof RecipeSourceProjectionHashes>;

type JsonRecord = Record<string, unknown>;
type ParsedGlb = SemanticGlbDocument;
type DecodedAccessor = Pick<
  SemanticGlbAccessor,
  "count" | "components" | "values"
>;

type AppearanceContext = {
  appearance: JsonRecord;
  dials: JsonRecord[];
  targets: JsonRecord;
  followers: JsonRecord;
  appearanceNodes: JsonRecord;
};

const BINARY_HASH_CHUNK_BYTES = 1024 * 1024;
const SOURCE_PROJECTION_DIAGNOSTIC_PREFIX =
  "recipe-source-projections/v1" as const;

function fail(message: string): never {
  throw new Error(`[recipe-source-projections/v1] ${message}`);
}

function record(value: unknown, context: string): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${context} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail(`${context} must be a plain object`);
  }
  return value as JsonRecord;
}

function array(value: unknown, context: string): unknown[] {
  if (!Array.isArray(value)) fail(`${context} must be an array`);
  return value;
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

function nonEmptyString(value: unknown, context: string): string {
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

function optionalArray(value: unknown, context: string): unknown[] {
  return value === undefined ? [] : array(value, context);
}

function safeIndex<T>(values: T[], value: unknown, context: string): T {
  const index = integer(value, context);
  if (index >= values.length) fail(`${context} is out of range`);
  return values[index];
}

function parseGlb(glbBytes: Uint8Array): ParsedGlb {
  return parseSemanticGlb(glbBytes, {
    diagnosticPrefix: SOURCE_PROJECTION_DIAGNOSTIC_PREFIX,
  });
}

const decodeAccessor = decodeSemanticGlbAccessor;
const resolveNode = resolveSemanticGlbNode;
const stableNodeName = stableSemanticGlbNodeName;

async function hashNumbers(decoded: DecodedAccessor): Promise<string> {
  return canonicalRecipeSha256({
    count: decoded.count,
    components: decoded.components,
    valuesSha256: await hashNumberValueBytes(decoded, 0, decoded.values.length),
  });
}

async function hashNumberRange(
  decoded: DecodedAccessor,
  start: number,
  length: number,
): Promise<string> {
  return canonicalRecipeSha256({
    length,
    valuesSha256: await hashNumberValueBytes(decoded, start, length),
  });
}

async function hashNumberValueBytes(
  decoded: DecodedAccessor,
  start: number,
  length: number,
): Promise<string> {
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(length) ||
    start < 0 ||
    length < 0 ||
    start > decoded.values.length ||
    length > decoded.values.length - start
  ) {
    fail("numeric accessor hash range is invalid");
  }
  const valuesPerChunk = BINARY_HASH_CHUNK_BYTES / 8;
  const chunks: string[] = [];
  for (let offset = 0; offset < length; offset += valuesPerChunk) {
    const chunkLength = Math.min(valuesPerChunk, length - offset);
    const bytes = new Uint8Array(chunkLength * 8);
    const view = new DataView(bytes.buffer);
    for (let index = 0; index < chunkLength; index += 1) {
      const value = decoded.values[start + offset + index];
      view.setFloat64(index * 8, Object.is(value, -0) ? 0 : value, true);
    }
    chunks.push(await sha256Hex(bytes));
  }
  return canonicalRecipeSha256({
    contract: "recipe-float64le-chunks/v1",
    length,
    chunkValues: valuesPerChunk,
    chunks,
  });
}

async function hashIndices(decoded: DecodedAccessor): Promise<string> {
  if (decoded.components !== 1) fail("index accessor must be SCALAR");
  const indicesPerChunk = BINARY_HASH_CHUNK_BYTES / 4;
  const chunks: string[] = [];
  for (let offset = 0; offset < decoded.count; offset += indicesPerChunk) {
    const chunkLength = Math.min(indicesPerChunk, decoded.count - offset);
    const bytes = new Uint8Array(chunkLength * 4);
    const view = new DataView(bytes.buffer);
    for (let index = 0; index < chunkLength; index += 1) {
      const value = decoded.values[offset + index];
      if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
        fail("index accessor contains a non-uint32 value");
      }
      view.setUint32(index * 4, value, true);
    }
    chunks.push(await sha256Hex(bytes));
  }
  return canonicalRecipeSha256({
    contract: "recipe-uint32le-chunks/v1",
    count: decoded.count,
    chunkIndices: indicesPerChunk,
    chunks,
  });
}

function appearanceContext(manifestValue: unknown): AppearanceContext {
  canonicalRecipeString(manifestValue);
  const manifest = record(manifestValue, "avatar.json");
  const appearance = record(
    manifest.appearanceDials,
    "avatar.json#appearanceDials",
  );
  if (appearance.contract !== "appearance-dials/v2") {
    fail("avatar.json#appearanceDials contract is not appearance-dials/v2");
  }
  const dials = array(appearance.dials, "appearanceDials.dials").map(
    (entry, index) => record(entry, `appearanceDials.dials[${index}]`),
  );
  const dialIds = new Set<string>();
  for (const [index, dial] of dials.entries()) {
    const id = nonEmptyString(dial.id, `appearanceDials.dials[${index}].id`);
    if (dialIds.has(id)) fail(`duplicate appearance dial id ${id}`);
    dialIds.add(id);
  }
  return {
    appearance,
    dials,
    targets: record(appearance.targets, "appearanceDials.targets"),
    followers: record(appearance.followers, "appearanceDials.followers"),
    appearanceNodes: record(appearance.nodes, "appearanceDials.nodes"),
  };
}

function primitiveRecords(parsed: ParsedGlb, nodeIndex: number): JsonRecord[] {
  const node = parsed.nodes[nodeIndex];
  if (node.mesh === undefined)
    fail(`GLB node ${stableNodeName(parsed, nodeIndex, "node")} has no mesh`);
  const meshIndex = integer(node.mesh, "node.mesh");
  const mesh = safeIndex(parsed.meshes, meshIndex, "node.mesh");
  const primitives = array(
    mesh.primitives,
    `gltf.meshes[${meshIndex}].primitives`,
  ).map((entry, index) =>
    record(entry, `gltf.meshes[${meshIndex}].primitives[${index}]`),
  );
  if (primitives.length === 0) fail(`GLB mesh ${meshIndex} has no primitives`);
  return primitives;
}

function effectiveMorphWeights(parsed: ParsedGlb, nodeIndex: number): number[] {
  const node = parsed.nodes[nodeIndex];
  const meshIndex = integer(node.mesh, `gltf.nodes[${nodeIndex}].mesh`);
  const mesh = safeIndex(
    parsed.meshes,
    meshIndex,
    `gltf.nodes[${nodeIndex}].mesh`,
  );
  const primitives = primitiveRecords(parsed, nodeIndex);
  const targetCounts = primitives.map(
    (primitive, primitiveIndex) =>
      optionalArray(
        primitive.targets,
        `gltf.meshes[${meshIndex}].primitives[${primitiveIndex}].targets`,
      ).length,
  );
  const targetCount = targetCounts[0] ?? 0;
  if (targetCounts.some((count) => count !== targetCount)) {
    fail(`gltf.meshes[${meshIndex}] primitives disagree on morph target count`);
  }
  const declared = node.weights ?? mesh.weights;
  if (declared === undefined) return new Array(targetCount).fill(0);
  const weights = array(
    declared,
    node.weights === undefined
      ? `gltf.meshes[${meshIndex}].weights`
      : `gltf.nodes[${nodeIndex}].weights`,
  ).map((value, index) =>
    finite(value, `gltf.nodes[${nodeIndex}] effective morph weight ${index}`),
  );
  if (weights.length !== targetCount) {
    fail(
      `gltf.nodes[${nodeIndex}] effective morph weights do not match target count`,
    );
  }
  return weights;
}

function morphAccessor(
  parsed: ParsedGlb,
  nodeIndex: number,
  morphNameValue: unknown,
  context: string,
): unknown {
  const morphName = nonEmptyString(morphNameValue, context);
  const node = parsed.nodes[nodeIndex];
  const meshIndex = integer(node.mesh, `${context} node.mesh`);
  const mesh = safeIndex(parsed.meshes, meshIndex, `${context} node.mesh`);
  const names = array(
    record(mesh.extras, `${context} mesh.extras`).targetNames,
    `${context} targetNames`,
  ).map((entry, index) =>
    nonEmptyString(entry, `${context} targetNames[${index}]`),
  );
  if (new Set(names).size !== names.length)
    fail(`${context} has duplicate morph names`);
  const targetIndex = names.indexOf(morphName);
  if (targetIndex < 0) fail(`${context} morph ${morphName} is missing`);
  const matches: unknown[] = [];
  for (const [primitiveIndex, primitive] of primitiveRecords(
    parsed,
    nodeIndex,
  ).entries()) {
    const targets = optionalArray(
      primitive.targets,
      `${context} primitive ${primitiveIndex} targets`,
    );
    if (targets.length !== names.length) {
      fail(`${context} morph name/target inventory is misaligned`);
    }
    const target = record(
      targets[targetIndex],
      `${context} morph ${morphName}`,
    );
    if (target.POSITION !== undefined) matches.push(target.POSITION);
  }
  if (matches.length !== 1) {
    fail(
      `${context} morph ${morphName} has ${matches.length} POSITION accessors`,
    );
  }
  return matches[0];
}

function appearanceNodeIndex(
  parsed: ParsedGlb,
  context: AppearanceContext,
  nodeIdValue: unknown,
  owner: string,
): number {
  const nodeId = nonEmptyString(nodeIdValue, `${owner}.node`);
  const declaration = record(
    context.appearanceNodes[nodeId],
    `appearanceDials.nodes.${nodeId}`,
  );
  const nodeIndex = resolveNode(
    parsed,
    declaration.node,
    `${owner} runtime node`,
  );
  if (declaration.kind === "mesh") primitiveRecords(parsed, nodeIndex);
  return nodeIndex;
}

function stripPresentationFromDial(dial: JsonRecord): JsonRecord {
  const clone = JSON.parse(canonicalRecipeString(dial)) as JsonRecord;
  for (const key of [
    "label",
    "region",
    "tier",
    "order",
    "description",
    "keywords",
    "step",
  ]) {
    delete clone[key];
  }
  const symmetry = clone.symmetry;
  if (symmetry && typeof symmetry === "object" && !Array.isArray(symmetry)) {
    for (const side of ["left", "right"]) {
      const offset = (symmetry as JsonRecord)[side];
      if (offset && typeof offset === "object" && !Array.isArray(offset)) {
        delete (offset as JsonRecord).label;
        delete (offset as JsonRecord).step;
      }
    }
  }
  return clone;
}

function stripProvenance(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripProvenance);
  if (value && typeof value === "object") {
    const result: JsonRecord = {};
    for (const [key, child] of Object.entries(value as JsonRecord)) {
      if (key === "provenance" || key.endsWith("Sha256")) continue;
      result[key] = stripProvenance(child);
    }
    return result;
  }
  return value;
}

async function topologyProjection(parsed: ParsedGlb): Promise<unknown> {
  const meshes: unknown[] = [];
  for (let nodeIndex = 0; nodeIndex < parsed.nodes.length; nodeIndex += 1) {
    const node = parsed.nodes[nodeIndex];
    if (node.mesh === undefined) continue;
    const runtimeNode = stableNodeName(
      parsed,
      nodeIndex,
      `gltf.nodes[${nodeIndex}]`,
    );
    const primitives: unknown[] = [];
    for (const primitive of primitiveRecords(parsed, nodeIndex)) {
      const attributes = record(
        primitive.attributes,
        `${runtimeNode}.attributes`,
      );
      const positions = decodeAccessor(parsed, attributes.POSITION);
      if (positions.components !== 3)
        fail(`${runtimeNode} POSITION is not VEC3`);
      const indices =
        primitive.indices === undefined
          ? {
              count: positions.count,
              components: 1,
              values: Float64Array.from(
                { length: positions.count },
                (_entry, index) => index,
              ),
            }
          : decodeAccessor(parsed, primitive.indices);
      primitives.push({
        mode: integer(primitive.mode ?? 4, `${runtimeNode}.mode`),
        vertexCount: positions.count,
        indexCount: indices.count,
        indicesSha256: await hashIndices(indices),
      });
    }
    primitives.sort((left, right) =>
      canonicalRecipeString(left).localeCompare(canonicalRecipeString(right)),
    );
    meshes.push({ runtimeNode, primitives });
  }
  meshes.sort((left, right) =>
    canonicalRecipeString(left).localeCompare(canonicalRecipeString(right)),
  );
  return { contract: RECIPE_TOPOLOGY_PROJECTION_CONTRACT, meshes };
}

function skinSemanticRecord(parsed: ParsedGlb, skinIndex: number): JsonRecord {
  const skin = safeIndex(parsed.skins, skinIndex, "skin index");
  const joints = array(skin.joints, `gltf.skins[${skinIndex}].joints`).map(
    (entry, index) =>
      stableNodeName(
        parsed,
        integer(entry, `gltf.skins[${skinIndex}].joints[${index}]`),
        `gltf.skins[${skinIndex}].joints[${index}]`,
      ),
  );
  if (new Set(joints).size !== joints.length)
    fail(`gltf.skins[${skinIndex}] has duplicate joints`);
  return {
    skeletonRoot:
      skin.skeleton === undefined
        ? null
        : stableNodeName(
            parsed,
            integer(skin.skeleton, `gltf.skins[${skinIndex}].skeleton`),
            `gltf.skins[${skinIndex}].skeleton`,
          ),
    jointSlots: joints.map((joint, slot) => ({ slot, joint })),
  };
}

async function physicalSkinRecord(
  parsed: ParsedGlb,
  skinIndex: number,
): Promise<JsonRecord> {
  const skin = safeIndex(parsed.skins, skinIndex, "skin index");
  if (skin.inverseBindMatrices === undefined) {
    fail(`gltf.skins[${skinIndex}] is missing inverseBindMatrices`);
  }
  const decoded = decodeAccessor(parsed, skin.inverseBindMatrices);
  if (decoded.components !== 16) {
    fail(`gltf.skins[${skinIndex}] inverse binds are not MAT4`);
  }
  const skinRecord = skinSemanticRecord(parsed, skinIndex);
  const jointSlots = array(
    skinRecord.jointSlots,
    `gltf.skins[${skinIndex}] semantic joint slots`,
  ).map((value, slot) =>
    record(value, `gltf.skins[${skinIndex}] joint slot ${slot}`),
  );
  if (decoded.count !== jointSlots.length) {
    fail(
      `gltf.skins[${skinIndex}] inverse-bind count does not match joint slots`,
    );
  }
  const slots: unknown[] = [];
  for (let slot = 0; slot < jointSlots.length; slot += 1) {
    slots.push({
      slot,
      joint: jointSlots[slot].joint,
      inverseBindSha256: await hashNumberRange(decoded, slot * 16, 16),
    });
  }
  return {
    skeletonRoot: skinRecord.skeletonRoot,
    jointSlots: slots,
  };
}

async function skeletonHierarchyProjection(
  parsed: ParsedGlb,
): Promise<unknown> {
  const boneIndices = new Set<number>();
  for (const [skinIndex, skin] of parsed.skins.entries()) {
    for (const joint of array(skin.joints, `gltf.skins[${skinIndex}].joints`)) {
      const jointIndex = integer(joint, `gltf.skins[${skinIndex}].joint`);
      if (jointIndex >= parsed.nodes.length)
        fail("skin joint index is out of range");
      boneIndices.add(jointIndex);
    }
    if (skin.skeleton !== undefined)
      boneIndices.add(integer(skin.skeleton, "skin.skeleton"));
  }
  const bones = [...boneIndices]
    .map((nodeIndex) => {
      const name = stableNodeName(parsed, nodeIndex, `bone ${nodeIndex}`);
      const directParent = parsed.parents.get(nodeIndex);
      return {
        name,
        parent:
          directParent === undefined
            ? null
            : stableNodeName(parsed, directParent, `parent of bone ${name}`),
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
  const sourceSkins = parsed.skins.map((_skin, index) =>
    skinSemanticRecord(parsed, index),
  );
  const skinKeys: string[] = [];
  for (const skin of sourceSkins) {
    skinKeys.push(await canonicalRecipeSha256(skin));
  }
  const skins = [...sourceSkins];
  skins.sort((left, right) =>
    canonicalRecipeString(left).localeCompare(canonicalRecipeString(right)),
  );
  const meshSkins: unknown[] = [];
  for (let nodeIndex = 0; nodeIndex < parsed.nodes.length; nodeIndex += 1) {
    const node = parsed.nodes[nodeIndex];
    if (node.mesh === undefined || node.skin === undefined) continue;
    const skinIndex = integer(node.skin, `gltf.nodes[${nodeIndex}].skin`);
    if (skinIndex >= skins.length)
      fail(`gltf.nodes[${nodeIndex}].skin is out of range`);
    meshSkins.push({
      runtimeNode: stableNodeName(
        parsed,
        nodeIndex,
        `gltf.nodes[${nodeIndex}]`,
      ),
      skinSha256: skinKeys[skinIndex],
    });
  }
  meshSkins.sort((left, right) =>
    canonicalRecipeString(left).localeCompare(canonicalRecipeString(right)),
  );
  return {
    contract: RECIPE_SKELETON_HIERARCHY_PROJECTION_CONTRACT,
    bones,
    skins,
    meshSkins,
  };
}

function localMatrix(node: JsonRecord, context: string): number[] {
  const exact = resolveSemanticGlbNodeTransform(node, context, {
    diagnosticPrefix: SOURCE_PROJECTION_DIAGNOSTIC_PREFIX,
  });
  if (exact.rotation === null) return exact.matrix;

  // `recipe-physical-basis/v1` was frozen with near-unit exported node
  // quaternions normalized before matrix projection. The shared semantic GLB
  // reader now correctly preserves valid source components and rejects
  // malformed rotations instead of silently repairing them. Keep the old
  // normalization policy isolated to this immutable v1 identity projection;
  // the R2 physical model consumes the exact semantic transform above.
  const length = Math.hypot(...exact.rotation);
  return resolveSemanticGlbNodeTransform(
    {
      ...node,
      rotation: exact.rotation.map((component) => component / length),
    },
    `${context} frozen recipe-physical-basis/v1 projection`,
    { diagnosticPrefix: SOURCE_PROJECTION_DIAGNOSTIC_PREFIX },
  ).matrix;
}

function collectRelevantNodeIndices(
  parsed: ParsedGlb,
  manifest: JsonRecord,
  context: AppearanceContext,
): Set<number> {
  const relevant = new Set<number>();
  parsed.nodes.forEach((node, index) => {
    if (node.mesh !== undefined || node.skin !== undefined) relevant.add(index);
  });
  parsed.skins.forEach((skin, skinIndex) => {
    array(skin.joints, `gltf.skins[${skinIndex}].joints`).forEach((joint) =>
      relevant.add(integer(joint, `gltf.skins[${skinIndex}].joint`)),
    );
    if (skin.skeleton !== undefined)
      relevant.add(integer(skin.skeleton, "skin.skeleton"));
  });
  for (const [nodeId, value] of Object.entries(context.appearanceNodes)) {
    const declaration = record(value, `appearanceDials.nodes.${nodeId}`);
    relevant.add(
      resolveNode(parsed, declaration.node, `appearance node ${nodeId}`),
    );
  }
  const anchors = (manifest.stage as JsonRecord | undefined)?.anchors;
  if (anchors !== undefined) {
    for (const [anchor, nodeName] of Object.entries(
      record(anchors, "stage.anchors"),
    )) {
      relevant.add(resolveNode(parsed, nodeName, `stage anchor ${anchor}`));
    }
  }
  const jointFollow = context.appearance.jointFollow;
  if (jointFollow !== undefined) {
    const deltas = record(
      record(jointFollow, "appearanceDials.jointFollow").deltas,
      "jointFollow.deltas",
    );
    for (const [targetId, bones] of Object.entries(deltas)) {
      for (const bone of Object.keys(
        record(bones, `jointFollow.deltas.${targetId}`),
      )) {
        relevant.add(resolveNode(parsed, bone, `jointFollow bone ${bone}`));
      }
    }
  }
  const rig =
    manifest.rig === undefined
      ? undefined
      : record(manifest.rig, "avatar.json#rig");
  const correctives = rig?.correctives;
  if (correctives !== undefined) {
    for (const driverValue of optionalArray(
      record(correctives, "rig.correctives").drivers,
      "rig.correctives.drivers",
    )) {
      const driver = record(driverValue, "rig.correctives driver");
      for (const boneValue of optionalArray(
        driver.bones,
        "rig.correctives driver bones",
      )) {
        const bone = record(boneValue, "rig.correctives driver bone");
        relevant.add(resolveNode(parsed, bone.bone, "rig.correctives bone"));
      }
    }
  }
  for (const nodeIndex of [...relevant]) {
    let parent = parsed.parents.get(nodeIndex);
    while (parent !== undefined) {
      relevant.add(parent);
      parent = parsed.parents.get(parent);
    }
  }
  return relevant;
}

async function physicalBasisProjection(
  manifest: JsonRecord,
  parsed: ParsedGlb,
  context: AppearanceContext,
): Promise<unknown> {
  const physicalSkins: JsonRecord[] = [];
  const physicalSkinKeys: string[] = [];
  for (let skinIndex = 0; skinIndex < parsed.skins.length; skinIndex += 1) {
    const physicalSkin = await physicalSkinRecord(parsed, skinIndex);
    physicalSkins.push(physicalSkin);
    physicalSkinKeys.push(await canonicalRecipeSha256(physicalSkin));
  }
  const neutralMeshes: unknown[] = [];
  const skinData: unknown[] = [];
  for (let nodeIndex = 0; nodeIndex < parsed.nodes.length; nodeIndex += 1) {
    const node = parsed.nodes[nodeIndex];
    if (node.mesh === undefined) continue;
    const runtimeNode = stableNodeName(
      parsed,
      nodeIndex,
      `gltf.nodes[${nodeIndex}]`,
    );
    const primitives: unknown[] = [];
    for (const primitive of primitiveRecords(parsed, nodeIndex)) {
      const attributes = record(
        primitive.attributes,
        `${runtimeNode}.attributes`,
      );
      const position = decodeAccessor(parsed, attributes.POSITION);
      if (position.components !== 3)
        fail(`${runtimeNode} POSITION is not VEC3`);
      primitives.push({
        vertexCount: position.count,
        positionSha256: await hashNumbers(position),
      });
      const jointSets = Object.keys(attributes)
        .filter((key) => /^JOINTS_[0-9]+$/.test(key))
        .sort((left, right) => Number(left.slice(7)) - Number(right.slice(7)));
      const weightSets = Object.keys(attributes)
        .filter((key) => /^WEIGHTS_[0-9]+$/.test(key))
        .sort((left, right) => Number(left.slice(8)) - Number(right.slice(8)));
      if (
        jointSets.map((key) => key.slice(7)).join(",") !==
        weightSets.map((key) => key.slice(8)).join(",")
      ) {
        fail(`${runtimeNode} JOINTS/WEIGHTS sets are not paired`);
      }
      if (jointSets.length > 0 && node.skin === undefined) {
        fail(`${runtimeNode} has skin attributes without a skin`);
      }
      const skinIndex =
        node.skin === undefined
          ? null
          : integer(node.skin, `gltf.nodes[${nodeIndex}].skin`);
      const skin =
        skinIndex === null
          ? null
          : safeIndex(physicalSkins, skinIndex, `${runtimeNode} skin`);
      const jointSlotCount =
        skin === null
          ? 0
          : array(
              skin.jointSlots,
              `gltf.skins[${skinIndex}] semantic joint slots`,
            ).length;
      for (let set = 0; set < jointSets.length; set += 1) {
        const joints = decodeAccessor(parsed, attributes[jointSets[set]]);
        const weights = decodeAccessor(parsed, attributes[weightSets[set]]);
        if (
          joints.count !== position.count ||
          weights.count !== position.count ||
          joints.components !== weights.components
        ) {
          fail(`${runtimeNode} skin attributes do not match POSITION`);
        }
        for (const jointSlot of joints.values) {
          if (
            !Number.isSafeInteger(jointSlot) ||
            jointSlot < 0 ||
            jointSlot >= jointSlotCount
          ) {
            fail(
              `${runtimeNode} skin attributes reference an invalid joint slot`,
            );
          }
        }
        skinData.push({
          runtimeNode,
          skinSha256:
            skinIndex === null
              ? null
              : safeIndex(
                  physicalSkinKeys,
                  skinIndex,
                  `${runtimeNode} skin key`,
                ),
          set: integer(
            Number(jointSets[set].slice(7)),
            `${runtimeNode} skin set`,
          ),
          jointsSha256: await hashNumbers(joints),
          weightsSha256: await hashNumbers(weights),
        });
      }
    }
    primitives.sort((left, right) =>
      canonicalRecipeString(left).localeCompare(canonicalRecipeString(right)),
    );
    neutralMeshes.push({
      runtimeNode,
      effectiveMorphWeights: effectiveMorphWeights(parsed, nodeIndex),
      primitives,
    });
  }
  neutralMeshes.sort((left, right) =>
    canonicalRecipeString(left).localeCompare(canonicalRecipeString(right)),
  );
  skinData.sort((left, right) =>
    canonicalRecipeString(left).localeCompare(canonicalRecipeString(right)),
  );

  const inverseBinds: unknown[] = [...physicalSkins];
  inverseBinds.sort((left, right) =>
    canonicalRecipeString(left).localeCompare(canonicalRecipeString(right)),
  );

  const morphRefs = new Map<
    string,
    { nodeId: string; runtimeNode: string; morph: string; accessor: unknown }
  >();
  const addMorph = (
    nodeIdValue: unknown,
    morphValue: unknown,
    owner: string,
  ) => {
    const nodeId = nonEmptyString(nodeIdValue, `${owner}.node`);
    const morph = nonEmptyString(morphValue, `${owner}.morph`);
    const nodeIndex = appearanceNodeIndex(parsed, context, nodeId, owner);
    const runtimeNode = stableNodeName(parsed, nodeIndex, owner);
    const key = `${nodeId}\u0000${morph}`;
    const accessor = morphAccessor(parsed, nodeIndex, morph, owner);
    const previous = morphRefs.get(key);
    if (
      previous &&
      (previous.runtimeNode !== runtimeNode || previous.accessor !== accessor)
    ) {
      fail(`${owner} resolves an ambiguous morph binding`);
    }
    morphRefs.set(key, { nodeId, runtimeNode, morph, accessor });
  };
  for (const [targetId, targetValue] of Object.entries(context.targets)) {
    const target = record(targetValue, `appearance target ${targetId}`);
    for (const [index, bindingValue] of array(
      target.bindings,
      `appearance target ${targetId}.bindings`,
    ).entries()) {
      const binding = record(
        bindingValue,
        `appearance target ${targetId} binding ${index}`,
      );
      addMorph(
        binding.node,
        binding.morph,
        `appearance target ${targetId} binding ${index}`,
      );
    }
  }
  for (const [followerId, followerValue] of Object.entries(context.followers)) {
    const follower = record(followerValue, `appearance follower ${followerId}`);
    for (const driverValue of array(
      follower.drivers,
      `appearance follower ${followerId}.drivers`,
    )) {
      const driver = record(
        driverValue,
        `appearance follower ${followerId} driver`,
      );
      for (const channelValue of array(
        driver.channels,
        `appearance follower ${followerId} channels`,
      )) {
        const channel = record(
          channelValue,
          `appearance follower ${followerId} channel`,
        );
        if (channel.kind === "morph-weight") {
          addMorph(
            channel.node,
            channel.morph,
            `appearance follower ${followerId}`,
          );
        }
      }
    }
  }
  const recipeMorphs: unknown[] = [];
  const orderedMorphRefs = [...morphRefs.values()].sort((left, right) =>
    `${left.nodeId}:${left.morph}`.localeCompare(
      `${right.nodeId}:${right.morph}`,
    ),
  );
  for (const entry of orderedMorphRefs) {
    recipeMorphs.push({
      nodeId: entry.nodeId,
      runtimeNode: entry.runtimeNode,
      morph: entry.morph,
      positionDeltaSha256: await hashNumbers(
        decodeAccessor(parsed, entry.accessor),
      ),
    });
  }

  const relevantNodes = collectRelevantNodeIndices(parsed, manifest, context);
  const rests = [...relevantNodes]
    .map((nodeIndex) => ({
      runtimeNode: stableNodeName(
        parsed,
        nodeIndex,
        `gltf.nodes[${nodeIndex}]`,
      ),
      localMatrix: localMatrix(
        parsed.nodes[nodeIndex],
        `gltf.nodes[${nodeIndex}]`,
      ),
    }))
    .sort((left, right) => left.runtimeNode.localeCompare(right.runtimeNode));

  const targetPhysics = Object.entries(context.targets)
    .map(([id, value]) => {
      const target = record(value, `appearance target ${id}`);
      return {
        id,
        baselineValue: finite(target.baselineValue, `${id}.baselineValue`),
        influenceMin: finite(target.influenceMin, `${id}.influenceMin`),
        influenceMax: finite(target.influenceMax, `${id}.influenceMax`),
        soleDeltaY:
          target.soleDeltaY === undefined
            ? null
            : finite(target.soleDeltaY, `${id}.soleDeltaY`),
      };
    })
    .sort((left, right) => left.id.localeCompare(right.id));
  const rootScale = context.dials
    .filter((dial) => dial.kind === "root-scale")
    .map((dial) => ({
      id: nonEmptyString(dial.id, "root-scale dial id"),
      range: dial.range,
      scalePerUnit: finite(dial.scalePerUnit, "root-scale dial scalePerUnit"),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const followerPhysics = Object.entries(context.followers)
    .map(([id, value]) => {
      const follower = record(
        stripProvenance(record(value, `appearance follower ${id}`)),
        `appearance follower ${id} physical projection`,
      );
      return { id, drivers: follower.drivers };
    })
    .sort((left, right) => left.id.localeCompare(right.id));
  const rig =
    manifest.rig === undefined ? {} : record(manifest.rig, "avatar.json#rig");
  return {
    contract: RECIPE_PHYSICAL_BASIS_PROJECTION_CONTRACT,
    neutral: context.appearance.neutral,
    neutralMeshes,
    rests,
    skinData,
    inverseBinds,
    recipeMorphs,
    targetPhysics,
    jointFollow: stripProvenance(context.appearance.jointFollow ?? null),
    followerPhysics,
    rootScale,
    stageAnchors: stripProvenance(
      (manifest.stage as JsonRecord | undefined)?.anchors ?? {},
    ),
    performance: stripProvenance(rig.performance ?? null),
    correctives: stripProvenance(rig.correctives ?? null),
  };
}

function behaviorProjection(
  manifest: JsonRecord,
  context: AppearanceContext,
): unknown {
  const dials = context.dials
    .map(stripPresentationFromDial)
    .sort((left, right) =>
      nonEmptyString(left.id, "dial.id").localeCompare(
        nonEmptyString(right.id, "dial.id"),
      ),
    );
  const targets = Object.fromEntries(
    Object.entries(context.targets)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([id, value]) => [id, stripProvenance(value)]),
  );
  const followers = Object.fromEntries(
    Object.entries(context.followers)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([id, value]) => [id, stripProvenance(value)]),
  );
  const rig =
    manifest.rig === undefined ? {} : record(manifest.rig, "avatar.json#rig");
  return {
    contract: RECIPE_BEHAVIOR_PROJECTION_CONTRACT,
    appearanceContract: context.appearance.contract,
    dials,
    targets,
    macroEngine: stripProvenance(context.appearance.macroEngine ?? null),
    jointFollow: stripProvenance(context.appearance.jointFollow ?? null),
    followers,
    correctives: stripProvenance(rig.correctives ?? null),
  };
}

function componentGraphProjection(
  manifest: JsonRecord,
  parsed: ParsedGlb,
  context: AppearanceContext,
): unknown {
  const nodes = new Set<string>();
  const edges = new Set<string>();
  const addNode = (kind: string, idValue: unknown, owner: string) => {
    const id = nonEmptyString(idValue, owner);
    const key = `${kind}:${id}`;
    nodes.add(key);
    return key;
  };
  const addEdge = (from: string, to: string, kind: string) => {
    nodes.add(from);
    nodes.add(to);
    edges.add(canonicalRecipeString({ from, to, kind }));
  };

  const targetIds = new Set(Object.keys(context.targets));
  const followerIds = new Set(Object.keys(context.followers));
  const addFollowerRequirementEdges = (
    ownerNode: string,
    requirementsValue: unknown,
    owner: string,
  ) => {
    if (requirementsValue === undefined) return;
    const requirements = record(requirementsValue, `${owner}.requirements`);
    for (const followerValue of optionalArray(
      requirements.followerRefs,
      `${owner}.requirements.followerRefs`,
    )) {
      const followerId = nonEmptyString(
        followerValue,
        `${owner}.requirements follower`,
      );
      if (!followerIds.has(followerId)) {
        fail(`${owner} references missing follower ${followerId}`);
      }
      addEdge(
        ownerNode,
        addNode("follower", followerId, "follower id"),
        "requires-follower",
      );
    }
  };
  const dialIds = new Set<string>();
  for (const dial of context.dials) {
    const dialId = nonEmptyString(dial.id, "appearance dial id");
    if (dialIds.has(dialId)) fail(`duplicate appearance dial id ${dialId}`);
    dialIds.add(dialId);
    const control = addNode("control", dialId, "appearance dial id");
    addFollowerRequirementEdges(control, dial.requirements, `dial ${dialId}`);
    for (const memberValue of optionalArray(
      dial.members,
      `dial ${dialId}.members`,
    )) {
      const member = record(memberValue, `dial ${dialId} member`);
      const targetId = nonEmptyString(member.target, `dial ${dialId} target`);
      if (!targetIds.has(targetId))
        fail(`dial ${dialId} references missing target ${targetId}`);
      addEdge(
        control,
        addNode("target", targetId, "target id"),
        "drives-target",
      );
    }
    const symmetry = dial.symmetry;
    if (symmetry !== undefined) {
      const symmetryRecord = record(symmetry, `dial ${dialId}.symmetry`);
      for (const side of ["left", "right"]) {
        if (symmetryRecord[side] === undefined) continue;
        const offset = record(symmetryRecord[side], `dial ${dialId}.${side}`);
        const offsetId = nonEmptyString(offset.id, `dial ${dialId}.${side}.id`);
        if (dialIds.has(offsetId)) fail(`duplicate control id ${offsetId}`);
        dialIds.add(offsetId);
        const offsetControl = addNode("control", offsetId, "side-offset id");
        addEdge(control, offsetControl, "owns-side-offset");
        addFollowerRequirementEdges(
          offsetControl,
          offset.requirements,
          `dial ${offsetId}`,
        );
        for (const memberValue of array(
          offset.members,
          `dial ${offsetId}.members`,
        )) {
          const member = record(memberValue, `dial ${offsetId} member`);
          const targetId = nonEmptyString(
            member.target,
            `dial ${offsetId} target`,
          );
          if (!targetIds.has(targetId))
            fail(`dial ${offsetId} references missing target ${targetId}`);
          addEdge(
            offsetControl,
            addNode("target", targetId, "target id"),
            "drives-target",
          );
        }
      }
    }
    if (dial.kind === "root-scale") {
      addEdge(control, "output:root-scale", "drives-root-scale");
    }
  }
  const macro = context.appearance.macroEngine;
  if (macro !== undefined) {
    const macroRecord = record(macro, "appearanceDials.macroEngine");
    const byAxis = new Map(
      context.dials
        .filter((dial) => dial.kind === "macro-axis")
        .map((dial) => [dial.axis, nonEmptyString(dial.id, "macro dial id")]),
    );
    for (const cornerValue of array(
      macroRecord.corners,
      "macroEngine.corners",
    )) {
      const corner = record(cornerValue, "macro corner");
      const targetId = nonEmptyString(corner.target, "macro corner target");
      if (!targetIds.has(targetId))
        fail(`macro corner references missing target ${targetId}`);
      for (const axis of Object.keys(
        record(corner.comps, "macro corner comps"),
      )) {
        const dialId = byAxis.get(axis);
        if (!dialId) fail(`macro corner axis ${axis} has no control`);
        addEdge(
          `control:${dialId}`,
          `target:${targetId}`,
          "macro-drives-target",
        );
      }
    }
  }

  for (const [nodeId, nodeValue] of Object.entries(context.appearanceNodes)) {
    const declaration = record(nodeValue, `appearance node ${nodeId}`);
    const appearanceNode = addNode(
      "appearance-node",
      nodeId,
      "appearance node id",
    );
    const runtimeIndex = resolveNode(
      parsed,
      declaration.node,
      `appearance node ${nodeId}`,
    );
    const runtime = addNode(
      "runtime-node",
      stableNodeName(parsed, runtimeIndex, `appearance node ${nodeId}`),
      "runtime node",
    );
    addEdge(appearanceNode, runtime, "resolves-runtime-node");
    if (declaration.parent !== undefined) {
      const parent = record(
        declaration.parent,
        `appearance node ${nodeId}.parent`,
      );
      if (parent.kind === "node") {
        const parentId = nonEmptyString(
          parent.id,
          `appearance node ${nodeId}.parent.id`,
        );
        if (!(parentId in context.appearanceNodes)) {
          fail(
            `appearance node ${nodeId} references missing parent node ${parentId}`,
          );
        }
        addEdge(appearanceNode, `appearance-node:${parentId}`, "parent-node");
      } else if (parent.kind === "bone") {
        const bone = nonEmptyString(
          parent.name,
          `appearance node ${nodeId}.parent.name`,
        );
        resolveNode(parsed, bone, `appearance node ${nodeId} parent bone`);
        addEdge(appearanceNode, addNode("bone", bone, "bone"), "parent-bone");
      } else {
        fail(`appearance node ${nodeId} has invalid parent kind`);
      }
    }
  }

  for (const [targetId, targetValue] of Object.entries(context.targets)) {
    const target = record(targetValue, `appearance target ${targetId}`);
    const targetNode = addNode("target", targetId, "target id");
    for (const bindingValue of array(
      target.bindings,
      `target ${targetId}.bindings`,
    )) {
      const binding = record(bindingValue, `target ${targetId} binding`);
      const nodeId = nonEmptyString(
        binding.node,
        `target ${targetId} binding node`,
      );
      const morph = nonEmptyString(
        binding.morph,
        `target ${targetId} binding morph`,
      );
      const runtimeIndex = appearanceNodeIndex(
        parsed,
        context,
        nodeId,
        `target ${targetId}`,
      );
      morphAccessor(parsed, runtimeIndex, morph, `target ${targetId}`);
      const morphNode = addNode("morph", `${nodeId}:${morph}`, "morph binding");
      addEdge(targetNode, morphNode, "writes-morph");
      addEdge(morphNode, `appearance-node:${nodeId}`, "on-node");
    }
    const requirements = target.requirements;
    if (requirements !== undefined) {
      const requirementRecord = record(
        requirements,
        `target ${targetId}.requirements`,
      );
      for (const followerValue of optionalArray(
        requirementRecord.followerRefs,
        `target ${targetId}.followerRefs`,
      )) {
        const follower = nonEmptyString(
          followerValue,
          `target ${targetId} follower`,
        );
        if (!followerIds.has(follower))
          fail(`target ${targetId} references missing follower ${follower}`);
        addEdge(
          targetNode,
          addNode("follower", follower, "follower id"),
          "requires-follower",
        );
      }
    }
    if (target.soleDeltaY !== undefined) {
      addEdge(targetNode, "output:grounding", "drives-grounding");
    }
  }

  const jointFollow = context.appearance.jointFollow;
  if (jointFollow !== undefined) {
    const deltas = record(
      record(jointFollow, "jointFollow").deltas,
      "jointFollow.deltas",
    );
    for (const [targetId, boneValues] of Object.entries(deltas)) {
      if (!targetIds.has(targetId))
        fail(`jointFollow references missing target ${targetId}`);
      for (const bone of Object.keys(
        record(boneValues, `jointFollow ${targetId}`),
      )) {
        resolveNode(parsed, bone, `jointFollow bone ${bone}`);
        addEdge(
          `target:${targetId}`,
          addNode("bone", bone, "bone"),
          "moves-joint-rest",
        );
      }
    }
  }

  for (const [followerId, followerValue] of Object.entries(context.followers)) {
    const follower = record(followerValue, `follower ${followerId}`);
    const followerNode = addNode("follower", followerId, "follower id");
    const channelIds = new Set<string>();
    for (const driverValue of array(
      follower.drivers,
      `follower ${followerId}.drivers`,
    )) {
      const driver = record(driverValue, `follower ${followerId} driver`);
      const driverRef = record(
        driver.driver,
        `follower ${followerId} driver ref`,
      );
      const driverId = nonEmptyString(
        driverRef.id,
        `follower ${followerId} driver id`,
      );
      const driverNode =
        driverRef.kind === "dial"
          ? `control:${driverId}`
          : driverRef.kind === "target"
            ? `target:${driverId}`
            : fail(`follower ${followerId} has invalid driver kind`);
      if (!nodes.has(driverNode))
        fail(`follower ${followerId} references missing driver ${driverId}`);
      addEdge(driverNode, followerNode, "drives-follower");
      for (const channelValue of array(
        driver.channels,
        `follower ${followerId}.channels`,
      )) {
        const channel = record(channelValue, `follower ${followerId} channel`);
        const channelId = nonEmptyString(
          channel.id,
          `follower ${followerId} channel id`,
        );
        if (channelIds.has(channelId)) {
          fail(`follower ${followerId} has duplicate channel ${channelId}`);
        }
        channelIds.add(channelId);
        const channelNode = addNode(
          "follower-channel",
          `${followerId}:${channelId}`,
          "follower channel id",
        );
        addEdge(followerNode, channelNode, "owns-channel");
        const nodeId = nonEmptyString(
          channel.node,
          `follower ${followerId} channel node`,
        );
        appearanceNodeIndex(parsed, context, nodeId, `follower ${followerId}`);
        if (channel.kind === "morph-weight") {
          const morph = nonEmptyString(
            channel.morph,
            `follower ${followerId} morph`,
          );
          const runtimeIndex = appearanceNodeIndex(
            parsed,
            context,
            nodeId,
            `follower ${followerId}`,
          );
          morphAccessor(parsed, runtimeIndex, morph, `follower ${followerId}`);
          addEdge(
            channelNode,
            addNode("morph", `${nodeId}:${morph}`, "morph"),
            "writes-morph",
          );
        } else if (channel.kind === "node-trs") {
          addEdge(channelNode, `appearance-node:${nodeId}`, "writes-node-rest");
        } else {
          fail(`follower ${followerId} channel ${channelId} has invalid kind`);
        }
      }
    }
  }

  const rig =
    manifest.rig === undefined
      ? undefined
      : record(manifest.rig, "avatar.json#rig");
  if (rig?.correctives !== undefined) {
    const correctives = record(rig.correctives, "rig.correctives");
    const driverIds = new Set<string>();
    for (const driverValue of optionalArray(
      correctives.drivers,
      "rig.correctives.drivers",
    )) {
      const driver = record(driverValue, "rig.correctives driver");
      const driverId = nonEmptyString(driver.id, "rig.correctives driver id");
      if (driverIds.has(driverId))
        fail(`duplicate corrective driver ${driverId}`);
      driverIds.add(driverId);
      const driverNode = addNode(
        "corrective-driver",
        driverId,
        "corrective driver",
      );
      for (const boneValue of array(
        driver.bones,
        `corrective driver ${driverId}.bones`,
      )) {
        const bone = nonEmptyString(
          record(boneValue, "corrective bone").bone,
          "corrective bone",
        );
        resolveNode(parsed, bone, `corrective driver ${driverId} bone`);
        addEdge(addNode("bone", bone, "bone"), driverNode, "drives-corrective");
      }
    }
    for (const entryValue of optionalArray(
      correctives.entries,
      "rig.correctives.entries",
    )) {
      const entry = record(entryValue, "rig.correctives entry");
      const driverId = nonEmptyString(entry.driver, "corrective entry driver");
      if (!driverIds.has(driverId))
        fail(`corrective entry references missing driver ${driverId}`);
      const targetId = nonEmptyString(
        entry.target ?? entry.key,
        "corrective entry target",
      );
      if (!targetIds.has(targetId))
        fail(`corrective entry references missing target ${targetId}`);
      addEdge(
        `corrective-driver:${driverId}`,
        `target:${targetId}`,
        "adds-target-influence",
      );
      const anchorDial = nonEmptyString(
        entry.anchorDial,
        "corrective anchor dial",
      );
      if (!dialIds.has(anchorDial))
        fail(`corrective entry references missing anchor dial ${anchorDial}`);
      addEdge(
        `control:${anchorDial}`,
        `corrective-driver:${driverId}`,
        "sets-corrective-anchor",
      );
    }
  }

  return {
    contract: RECIPE_COMPONENT_GRAPH_PROJECTION_CONTRACT,
    nodes: [...nodes].sort(),
    edges: [...edges].sort().map((value) => JSON.parse(value)),
  };
}

export async function deriveRecipeSourceProjectionHashes(
  manifestValue: unknown,
  glbBytes: Uint8Array,
): Promise<RecipeSourceProjectionHashes> {
  const context = appearanceContext(manifestValue);
  const manifest = record(manifestValue, "avatar.json");
  const parsed = parseGlb(glbBytes);
  const physicalBasisSha256 = await canonicalRecipeSha256(
    await physicalBasisProjection(manifest, parsed, context),
  );
  const behaviorSha256 = await canonicalRecipeSha256(
    behaviorProjection(manifest, context),
  );
  const componentGraphSha256 = await canonicalRecipeSha256(
    componentGraphProjection(manifest, parsed, context),
  );
  const topologySha256 = await canonicalRecipeSha256(
    await topologyProjection(parsed),
  );
  const skeletonHierarchySha256 = await canonicalRecipeSha256(
    await skeletonHierarchyProjection(parsed),
  );
  return {
    physicalBasisSha256,
    behaviorSha256,
    componentGraphSha256,
    topologySha256,
    skeletonHierarchySha256,
  };
}

export function verifyDerivedRecipeSourceProjectionHashes(
  identityValue: unknown,
  actual: RecipeSourceProjectionHashes,
): RecipeSourceProjectionHashes {
  const identity = parseRecipeSourceIdentity(
    identityValue,
    "recipe source projection identity",
  );
  const actualRecord = record(actual, "derived recipe source projections");
  const actualKeys = Object.keys(actualRecord).sort();
  const expectedKeys = [...RECIPE_SOURCE_PROJECTION_HASH_FIELDS].sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    fail("derived recipe source projections contain unexpected fields");
  }
  const verified = {} as RecipeSourceProjectionHashes;
  for (const field of RECIPE_SOURCE_PROJECTION_HASH_FIELDS) {
    const digest = requireLowercaseSha256(
      actualRecord[field],
      `derived recipe source projections.${field}`,
    );
    verified[field] = digest;
    if (identity[field] !== digest) {
      fail(`${field} mismatch: expected ${identity[field]}, got ${digest}`);
    }
  }
  return verified;
}

export async function verifyRecipeSourceProjectionHashes(
  identityValue: unknown,
  manifestValue: unknown,
  glbBytes: Uint8Array,
): Promise<RecipeSourceProjectionHashes> {
  const actual = await deriveRecipeSourceProjectionHashes(
    manifestValue,
    glbBytes,
  );
  return verifyDerivedRecipeSourceProjectionHashes(identityValue, actual);
}
