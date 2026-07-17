import {
  canonicalRecipeSha256,
  canonicalRecipeString,
  sha256Hex,
} from "./recipeCanonical";
import {
  decodeSemanticGlbAccessor,
  getSemanticGlbMesh,
  getSemanticGlbNode,
  getSemanticGlbSkin,
  inspectSemanticGlbAccessor,
  parseSemanticGlb,
  stableSemanticGlbNodeName,
  type SemanticGlbAccessorInfo,
  type SemanticGlbDocument,
  type SemanticJsonRecord,
} from "./semanticGlb";

export const APPEARANCE_RECIPE_SEMANTIC_CORRESPONDENCE_CONTRACT =
  "appearance-recipe-semantic-correspondence/v1" as const;
export const APPEARANCE_RECIPE_SEMANTIC_MATERIAL_PROOF_CONTRACT =
  "appearance-recipe-semantic-material-proof/v1" as const;
export const APPEARANCE_RECIPE_SEMANTIC_PROOF_CONTRACT =
  "appearance-recipe-semantic-proof/v1" as const;

export type AppearanceRecipeSemanticCorrespondence = {
  contract: typeof APPEARANCE_RECIPE_SEMANTIC_CORRESPONDENCE_CONTRACT;
  activeScene: number;
  nodes: Record<string, string>;
  meshes: Record<string, string>;
  bones: Record<string, string>;
  skins: Record<string, string>;
  correspondenceSha256: string;
};

export type AppearanceRecipeSemanticAccessorProof = {
  semantic: string;
  target: string | null;
  accessorSha256: string;
};

export type AppearanceRecipeSemanticImageProof = {
  mimeType: string;
  byteLength: number;
  bytesSha256: string;
  json: Record<string, unknown>;
};

export type AppearanceRecipeSemanticTextureProof = {
  textureSha256: string;
  json: Record<string, unknown>;
  sampler: Record<string, unknown> | null;
  imageReferences: Array<{
    path: string;
    image: AppearanceRecipeSemanticImageProof;
  }>;
};

export type AppearanceRecipeSemanticMaterialProofEntry = {
  materialSha256: string;
  json: Record<string, unknown>;
  textureReferences: Array<{ path: string; textureSha256: string }>;
  textures: AppearanceRecipeSemanticTextureProof[];
};

export type AppearanceRecipeSemanticMaterialProjection = {
  contract: typeof APPEARANCE_RECIPE_SEMANTIC_MATERIAL_PROOF_CONTRACT;
  primitives: Array<{
    meshSemanticKey: string;
    materialSha256: string | null;
    shadingAccessors: AppearanceRecipeSemanticAccessorProof[];
  }>;
  materials: AppearanceRecipeSemanticMaterialProofEntry[];
  projectionSha256: string;
};

export type AppearanceRecipeSemanticProof = {
  contract: typeof APPEARANCE_RECIPE_SEMANTIC_PROOF_CONTRACT;
  correspondence: AppearanceRecipeSemanticCorrespondence;
  materials: AppearanceRecipeSemanticMaterialProjection;
  proofSha256: string;
};

type ActiveScene = {
  index: number;
  order: number[];
  reachable: Set<number>;
};

type PrimitiveDescriptor = {
  nodeIndex: number;
  primitiveIndex: number;
  primitive: SemanticJsonRecord;
  mesh: SemanticJsonRecord;
  meshSemanticKey: string;
};

const DIAGNOSTIC_PREFIX = APPEARANCE_RECIPE_SEMANTIC_PROOF_CONTRACT;
const SHADING_ATTRIBUTE = /^(?:NORMAL|TANGENT|TEXCOORD_[0-9]+|COLOR_[0-9]+)$/;

function fail(message: string): never {
  throw new Error(`[${DIAGNOSTIC_PREFIX}] ${message}`);
}

function record(value: unknown, context: string): SemanticJsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${context} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail(`${context} must be a plain object`);
  }
  return value as SemanticJsonRecord;
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

function index<T>(values: T[], value: unknown, context: string): T {
  const parsed = integer(value, context);
  if (parsed >= values.length) fail(`${context} is out of range`);
  return values[parsed]!;
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

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function omitPresentationFields(
  value: SemanticJsonRecord,
  additionallyOmitted: readonly string[] = [],
): Record<string, unknown> {
  const omitted = new Set(["name", "extras", ...additionallyOmitted]);
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => !omitted.has(key)),
  );
}

function parseActiveScene(parsed: SemanticGlbDocument): ActiveScene {
  const scenes = array(parsed.gltf.scenes, "gltf.scenes");
  if (scenes.length === 0) fail("avatar.glb has no scenes");
  const sceneIndex = integer(parsed.gltf.scene ?? 0, "gltf.scene");
  const scene = record(
    index(scenes, sceneIndex, "gltf.scene"),
    `gltf.scenes[${sceneIndex}]`,
  );
  const roots = array(scene.nodes, `gltf.scenes[${sceneIndex}].nodes`).map(
    (value, rootIndex) =>
      integer(value, `gltf.scenes[${sceneIndex}].nodes[${rootIndex}]`),
  );
  if (roots.length === 0) fail("active GLB scene has no root nodes");
  if (new Set(roots).size !== roots.length) {
    fail("active GLB scene repeats a root node");
  }

  const reachable = new Set<number>();
  const order: number[] = [];
  const visit = (nodeIndex: number, context: string) => {
    if (nodeIndex >= parsed.nodes.length) fail(`${context} is out of range`);
    if (reachable.has(nodeIndex)) {
      fail(`active GLB scene reaches node ${nodeIndex} more than once`);
    }
    reachable.add(nodeIndex);
    order.push(nodeIndex);
    const node = getSemanticGlbNode(parsed, nodeIndex, context);
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
  roots.forEach((root, rootIndex) => {
    if (parsed.parents.has(root)) {
      fail(`active GLB scene root ${root} has a parent`);
    }
    visit(root, `gltf.scenes[${sceneIndex}].nodes[${rootIndex}]`);
  });
  return { index: sceneIndex, order, reachable };
}

function semanticNodeKeys(
  parsed: SemanticGlbDocument,
  active: ActiveScene,
): Record<string, string> {
  const byIndex = new Map<number, string>();
  const resolve = (nodeIndex: number): string => {
    const cached = byIndex.get(nodeIndex);
    if (cached) return cached;
    if (!active.reachable.has(nodeIndex)) {
      fail(`node ${nodeIndex} is outside the active scene`);
    }
    const name = stableSemanticGlbNodeName(
      parsed,
      nodeIndex,
      `gltf.nodes[${nodeIndex}]`,
    );
    const segment = encodeURIComponent(name);
    const parent = parsed.parents.get(nodeIndex);
    const key =
      parent === undefined
        ? `node/v1/${segment}`
        : `${resolve(parent)}/${segment}`;
    byIndex.set(nodeIndex, key);
    return key;
  };
  const result: Record<string, string> = {};
  for (const nodeIndex of active.order)
    result[`node:${nodeIndex}`] = resolve(nodeIndex);
  if (new Set(Object.values(result)).size !== Object.keys(result).length) {
    fail("active GLB node hierarchy has ambiguous semantic keys");
  }
  return result;
}

function accessorShape(
  parsed: SemanticGlbDocument,
  accessorIndex: unknown,
): SemanticGlbAccessorInfo {
  return inspectSemanticGlbAccessor(
    parsed,
    integer(accessorIndex, "accessor index"),
  );
}

function primitiveSignature(
  parsed: SemanticGlbDocument,
  mesh: SemanticJsonRecord,
  primitive: SemanticJsonRecord,
  primitiveIndex: number,
): Record<string, unknown> {
  const context = `primitive ${primitiveIndex}`;
  const attributes = record(primitive.attributes, `${context}.attributes`);
  if (attributes.POSITION === undefined) fail(`${context} is missing POSITION`);
  const attributeShapes = Object.fromEntries(
    Object.entries(attributes)
      .sort(([left], [right]) => compareText(left, right))
      .map(([semantic, accessorIndex]) => [
        semantic,
        accessorShape(parsed, accessorIndex),
      ]),
  );
  const targets = optionalArray(primitive.targets, `${context}.targets`).map(
    (targetValue, targetIndex) => {
      const target = record(targetValue, `${context}.targets[${targetIndex}]`);
      return Object.fromEntries(
        Object.entries(target)
          .sort(([left], [right]) => compareText(left, right))
          .map(([semantic, accessorIndex]) => [
            semantic,
            accessorShape(parsed, accessorIndex),
          ]),
      );
    },
  );
  let targetNames: string[] = [];
  if (targets.length > 0 && mesh.extras !== undefined) {
    const extras = record(mesh.extras, `${context}.mesh.extras`);
    if (extras.targetNames !== undefined) {
      targetNames = array(extras.targetNames, `${context}.targetNames`).map(
        (value, targetIndex) =>
          string(value, `${context}.targetNames[${targetIndex}]`),
      );
      if (
        targetNames.length !== targets.length ||
        new Set(targetNames).size !== targetNames.length
      ) {
        fail(`${context}.targetNames must be unique and exhaustive`);
      }
    }
  }
  const mode = integer(primitive.mode ?? 4, `${context}.mode`);
  if (mode > 6) fail(`${context}.mode is invalid`);
  return {
    mode,
    indices:
      primitive.indices === undefined
        ? null
        : accessorShape(parsed, primitive.indices),
    attributes: attributeShapes,
    targets,
    targetNames,
  };
}

async function activePrimitives(
  parsed: SemanticGlbDocument,
  active: ActiveScene,
  nodeKeys: Record<string, string>,
): Promise<PrimitiveDescriptor[]> {
  const result: PrimitiveDescriptor[] = [];
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
    if (primitives.length === 0)
      fail(`active mesh node ${nodeIndex} has no primitives`);
    const signatureHashes = new Set<string>();
    for (const [primitiveIndex, primitiveValue] of primitives.entries()) {
      const primitive = record(
        primitiveValue,
        `gltf.meshes[${meshIndex}].primitives[${primitiveIndex}]`,
      );
      const signatureSha256 = await canonicalRecipeSha256(
        primitiveSignature(parsed, mesh, primitive, primitiveIndex),
      );
      if (signatureHashes.has(signatureSha256)) {
        fail(
          `active mesh node ${nodeIndex} has ambiguous primitive signatures`,
        );
      }
      signatureHashes.add(signatureSha256);
      result.push({
        nodeIndex,
        primitiveIndex,
        primitive,
        mesh,
        meshSemanticKey: `${nodeKeys[`node:${nodeIndex}`]}/primitive/v1/${signatureSha256}`,
      });
    }
  }
  return result;
}

function validateSkinAndBoneCorrespondence(
  parsed: SemanticGlbDocument,
  active: ActiveScene,
  nodeKeys: Record<string, string>,
): { bones: Record<string, string>; skins: Record<string, string> } {
  const bones: Record<string, string> = {};
  const skins: Record<string, string> = {};
  for (const skinnedNodeIndex of active.order) {
    const node = getSemanticGlbNode(
      parsed,
      skinnedNodeIndex,
      `gltf.nodes[${skinnedNodeIndex}]`,
    );
    if (node.skin === undefined) continue;
    if (node.mesh === undefined)
      fail(`gltf.nodes[${skinnedNodeIndex}] has a skin without a mesh`);
    const skinIndex = integer(
      node.skin,
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
    if (joints.length === 0 || new Set(joints).size !== joints.length) {
      fail(`gltf.skins[${skinIndex}].joints must be non-empty and unique`);
    }
    const jointKeys = joints.map((joint, slot) => {
      if (joint >= parsed.nodes.length)
        fail(`gltf.skins[${skinIndex}].joints[${slot}] is out of range`);
      if (!active.reachable.has(joint))
        fail(
          `gltf.skins[${skinIndex}].joints[${slot}] is outside the active scene`,
        );
      const nodeKey = nodeKeys[`node:${joint}`];
      bones[`bone:${joint}`] = `bone/v1/${nodeKey}`;
      return bones[`bone:${joint}`];
    });
    if (skin.inverseBindMatrices === undefined) {
      fail(`gltf.skins[${skinIndex}] is missing inverseBindMatrices`);
    }
    const inverse = accessorShape(parsed, skin.inverseBindMatrices);
    if (
      inverse.type !== "MAT4" ||
      inverse.componentType !== 5126 ||
      inverse.normalized ||
      inverse.count !== joints.length
    ) {
      fail(`gltf.skins[${skinIndex}] has malformed inverseBindMatrices`);
    }
    let skeleton: string | null = null;
    if (skin.skeleton !== undefined) {
      const skeletonIndex = integer(
        skin.skeleton,
        `gltf.skins[${skinIndex}].skeleton`,
      );
      if (
        skeletonIndex >= parsed.nodes.length ||
        !active.reachable.has(skeletonIndex)
      ) {
        fail(`gltf.skins[${skinIndex}].skeleton is outside the active scene`);
      }
      skeleton = nodeKeys[`node:${skeletonIndex}`]!;
    }
    const semantic = canonicalRecipeString({
      skinnedNode: nodeKeys[`node:${skinnedNodeIndex}`],
      skeleton,
      joints: jointKeys,
    });
    skins[`skin:${skinnedNodeIndex}:${skinIndex}`] =
      `skin/v1/${encodeURIComponent(semantic)}`;
  }
  return { bones, skins };
}

export async function buildAppearanceRecipeSemanticCorrespondence(
  parsed: SemanticGlbDocument,
): Promise<AppearanceRecipeSemanticCorrespondence> {
  const active = parseActiveScene(parsed);
  const nodes = semanticNodeKeys(parsed, active);
  const primitives = await activePrimitives(parsed, active, nodes);
  const meshes = Object.fromEntries(
    primitives
      .map((entry) => [
        `mesh:${entry.nodeIndex}:${entry.primitiveIndex}`,
        entry.meshSemanticKey,
      ])
      .sort(([left], [right]) => compareText(left, right)),
  );
  if (new Set(Object.values(meshes)).size !== Object.keys(meshes).length) {
    fail("active GLB primitives have ambiguous semantic keys");
  }
  const { bones, skins } = validateSkinAndBoneCorrespondence(
    parsed,
    active,
    nodes,
  );
  const content = {
    contract: APPEARANCE_RECIPE_SEMANTIC_CORRESPONDENCE_CONTRACT,
    activeScene: active.index,
    nodes,
    meshes,
    bones,
    skins,
  };
  return {
    ...content,
    correspondenceSha256: await canonicalRecipeSha256(content),
  };
}

async function semanticAccessorSha256(
  parsed: SemanticGlbDocument,
  accessorIndex: unknown,
): Promise<string> {
  const accessor = decodeSemanticGlbAccessor(
    parsed,
    integer(accessorIndex, "shading accessor index"),
  );
  return canonicalRecipeSha256({
    count: accessor.count,
    components: accessor.components,
    componentType: accessor.componentType,
    type: accessor.type,
    normalized: accessor.normalized,
    values: Array.from(accessor.values, (value) =>
      Object.is(value, -0) ? 0 : value,
    ),
  });
}

async function shadingAccessorProofs(
  parsed: SemanticGlbDocument,
  descriptor: PrimitiveDescriptor,
): Promise<AppearanceRecipeSemanticAccessorProof[]> {
  const result: AppearanceRecipeSemanticAccessorProof[] = [];
  const attributes = record(
    descriptor.primitive.attributes,
    `${descriptor.meshSemanticKey}.attributes`,
  );
  for (const [semantic, accessorIndex] of Object.entries(attributes).sort(
    ([left], [right]) => compareText(left, right),
  )) {
    if (!SHADING_ATTRIBUTE.test(semantic)) continue;
    result.push({
      semantic,
      target: null,
      accessorSha256: await semanticAccessorSha256(parsed, accessorIndex),
    });
  }
  const targets = optionalArray(
    descriptor.primitive.targets,
    `${descriptor.meshSemanticKey}.targets`,
  );
  const extras =
    descriptor.mesh.extras === undefined
      ? null
      : record(
          descriptor.mesh.extras,
          `${descriptor.meshSemanticKey}.mesh.extras`,
        );
  const targetNames =
    extras?.targetNames === undefined
      ? []
      : array(
          extras.targetNames,
          `${descriptor.meshSemanticKey}.targetNames`,
        ).map((value, targetIndex) =>
          string(
            value,
            `${descriptor.meshSemanticKey}.targetNames[${targetIndex}]`,
          ),
        );
  if (targetNames.length > 0 && targetNames.length !== targets.length) {
    fail(`${descriptor.meshSemanticKey}.targetNames is not exhaustive`);
  }
  for (const [targetIndex, targetValue] of targets.entries()) {
    const target = record(
      targetValue,
      `${descriptor.meshSemanticKey}.targets[${targetIndex}]`,
    );
    for (const [semantic, accessorIndex] of Object.entries(target).sort(
      ([left], [right]) => compareText(left, right),
    )) {
      if (!SHADING_ATTRIBUTE.test(semantic)) continue;
      result.push({
        semantic,
        target: targetNames[targetIndex] ?? `target:${targetIndex}`,
        accessorSha256: await semanticAccessorSha256(parsed, accessorIndex),
      });
    }
  }
  return result.sort((left, right) =>
    compareText(
      `${left.target ?? ""}\u0000${left.semantic}`,
      `${right.target ?? ""}\u0000${right.semantic}`,
    ),
  );
}

function textureReferenceIndices(
  material: Record<string, unknown>,
): Array<{ path: string; index: number }> {
  const result: Array<{ path: string; index: number }> = [];
  const visit = (value: unknown, path: string, property: string | null) => {
    if (Array.isArray(value)) {
      value.forEach((entry, index) => visit(entry, `${path}/${index}`, null));
      return;
    }
    if (value === null || typeof value !== "object") return;
    const current = record(value, path || "material");
    if (property?.endsWith("Texture") && current.index !== undefined) {
      result.push({ index: integer(current.index, `${path}/index`), path });
    }
    for (const [key, child] of Object.entries(current)) {
      visit(child, `${path}/${key}`, key);
    }
  };
  visit(material, "", null);
  return result.sort((left, right) => compareText(left.path, right.path));
}

function normalizeMaterialJson(
  value: unknown,
  context: string,
  property: string | null = null,
): unknown {
  if (Array.isArray(value)) {
    return value.map((entry, index) =>
      normalizeMaterialJson(entry, `${context}[${index}]`),
    );
  }
  if (value === null || typeof value !== "object") return value;
  const current = record(value, context);
  const textureInfo = property?.endsWith("Texture") ?? false;
  return Object.fromEntries(
    Object.entries(current)
      .filter(
        ([key]) =>
          key !== "name" &&
          key !== "extras" &&
          !(textureInfo && key === "index"),
      )
      .map(([key, child]) => [
        key,
        normalizeMaterialJson(child, `${context}.${key}`, key),
      ]),
  );
}

function normalizeTextureJson(
  value: unknown,
  context: string,
  insideExtension = false,
): unknown {
  if (Array.isArray(value)) {
    return value.map((entry, index) =>
      normalizeTextureJson(entry, `${context}[${index}]`, insideExtension),
    );
  }
  if (value === null || typeof value !== "object") return value;
  const current = record(value, context);
  return Object.fromEntries(
    Object.entries(current)
      .filter(
        ([key]) =>
          key !== "name" &&
          key !== "extras" &&
          key !== "sampler" &&
          !(key === "source" && (insideExtension || context === "texture")),
      )
      .map(([key, child]) => [
        key,
        normalizeTextureJson(
          child,
          `${context}.${key}`,
          insideExtension || key === "extensions",
        ),
      ]),
  );
}

function embeddedBufferViewBytes(
  parsed: SemanticGlbDocument,
  bufferViewIndex: unknown,
  context: string,
): Uint8Array {
  const bufferViews = optionalArray(
    parsed.gltf.bufferViews,
    "gltf.bufferViews",
  );
  const viewIndex = integer(bufferViewIndex, `${context}.bufferView`);
  const view = record(
    index(bufferViews, viewIndex, `${context}.bufferView`),
    `gltf.bufferViews[${viewIndex}]`,
  );
  if (view.buffer !== undefined && view.buffer !== 0) {
    fail(`${context} references a non-GLB buffer`);
  }
  const byteOffset = integer(
    view.byteOffset ?? 0,
    `gltf.bufferViews[${viewIndex}].byteOffset`,
  );
  const byteLength = integer(
    view.byteLength,
    `gltf.bufferViews[${viewIndex}].byteLength`,
  );
  if (
    byteOffset > parsed.binary.byteLength ||
    byteLength > parsed.binary.byteLength - byteOffset
  ) {
    fail(`gltf.bufferViews[${viewIndex}] exceeds the GLB BIN chunk`);
  }
  return parsed.binary.subarray(byteOffset, byteOffset + byteLength);
}

function decodeDataUri(
  uri: string,
  context: string,
): { mimeType: string; bytes: Uint8Array } {
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/.exec(uri);
  if (!match) fail(`${context} must be an embedded base64 data URI`);
  let decoded: string;
  try {
    decoded = atob(match[2]!);
  } catch (error) {
    fail(`${context} has invalid base64: ${String(error)}`);
  }
  return {
    mimeType: string(match[1], `${context}.mimeType`),
    bytes: Uint8Array.from(decoded!, (character) => character.charCodeAt(0)),
  };
}

async function imageProof(
  parsed: SemanticGlbDocument,
  imageIndex: number,
): Promise<AppearanceRecipeSemanticImageProof> {
  const images = optionalArray(parsed.gltf.images, "gltf.images");
  const image = record(
    index(images, imageIndex, `gltf.images[${imageIndex}]`),
    `gltf.images[${imageIndex}]`,
  );
  if ((image.bufferView === undefined) === (image.uri === undefined)) {
    fail(`gltf.images[${imageIndex}] must declare exactly one embedded source`);
  }
  let mimeType: string;
  let bytes: Uint8Array;
  if (image.bufferView !== undefined) {
    mimeType = string(image.mimeType, `gltf.images[${imageIndex}].mimeType`);
    bytes = embeddedBufferViewBytes(
      parsed,
      image.bufferView,
      `gltf.images[${imageIndex}]`,
    );
  } else {
    const decoded = decodeDataUri(
      string(image.uri, `gltf.images[${imageIndex}].uri`),
      `gltf.images[${imageIndex}].uri`,
    );
    mimeType = decoded.mimeType;
    bytes = decoded.bytes;
    if (image.mimeType !== undefined && image.mimeType !== mimeType) {
      fail(`gltf.images[${imageIndex}].mimeType contradicts its data URI`);
    }
  }
  return {
    mimeType,
    byteLength: bytes.byteLength,
    bytesSha256: await sha256Hex(bytes),
    json: omitPresentationFields(image, ["bufferView", "uri", "mimeType"]),
  };
}

function textureImageReferences(
  texture: SemanticJsonRecord,
  context: string,
): Array<{ path: string; index: number }> {
  const result: Array<{ path: string; index: number }> = [];
  if (texture.source !== undefined) {
    result.push({
      path: "source",
      index: integer(texture.source, `${context}.source`),
    });
  }
  if (texture.extensions !== undefined) {
    const extensions = record(texture.extensions, `${context}.extensions`);
    for (const [extensionName, extensionValue] of Object.entries(extensions)) {
      const extension = record(
        extensionValue,
        `${context}.extensions.${extensionName}`,
      );
      if (extension.source !== undefined) {
        result.push({
          path: `extensions/${extensionName}/source`,
          index: integer(
            extension.source,
            `${context}.extensions.${extensionName}.source`,
          ),
        });
      }
    }
  }
  if (result.length === 0) fail(`${context} has no embedded image source`);
  return result.sort((left, right) => compareText(left.path, right.path));
}

async function textureProof(
  parsed: SemanticGlbDocument,
  textureIndex: number,
): Promise<AppearanceRecipeSemanticTextureProof> {
  const textures = optionalArray(parsed.gltf.textures, "gltf.textures");
  const texture = record(
    index(textures, textureIndex, `gltf.textures[${textureIndex}]`),
    `gltf.textures[${textureIndex}]`,
  );
  let sampler: Record<string, unknown> | null = null;
  if (texture.sampler !== undefined) {
    const samplers = optionalArray(parsed.gltf.samplers, "gltf.samplers");
    const samplerIndex = integer(
      texture.sampler,
      `gltf.textures[${textureIndex}].sampler`,
    );
    sampler = omitPresentationFields(
      record(
        index(samplers, samplerIndex, `gltf.samplers[${samplerIndex}]`),
        `gltf.samplers[${samplerIndex}]`,
      ),
    );
  }
  const imageReferences = await Promise.all(
    textureImageReferences(texture, `gltf.textures[${textureIndex}]`).map(
      async (reference) => ({
        path: reference.path,
        image: await imageProof(parsed, reference.index),
      }),
    ),
  );
  const content = {
    json: normalizeTextureJson(texture, "texture") as Record<string, unknown>,
    sampler,
    imageReferences,
  };
  return {
    textureSha256: await canonicalRecipeSha256(content),
    ...content,
  };
}

async function materialProofEntry(
  parsed: SemanticGlbDocument,
  materialIndex: number,
): Promise<AppearanceRecipeSemanticMaterialProofEntry> {
  const materials = optionalArray(parsed.gltf.materials, "gltf.materials");
  const material = record(
    index(materials, materialIndex, `gltf.materials[${materialIndex}]`),
    `gltf.materials[${materialIndex}]`,
  );
  const references = textureReferenceIndices(material);
  const textureByIndex = new Map<
    number,
    AppearanceRecipeSemanticTextureProof
  >();
  for (const reference of references) {
    if (!textureByIndex.has(reference.index)) {
      textureByIndex.set(
        reference.index,
        await textureProof(parsed, reference.index),
      );
    }
  }
  const textureReferences = references.map((reference) => ({
    path: reference.path,
    textureSha256: textureByIndex.get(reference.index)!.textureSha256,
  }));
  const textures = [...textureByIndex.values()].sort((left, right) =>
    compareText(left.textureSha256, right.textureSha256),
  );
  const content = {
    json: normalizeMaterialJson(material, "material") as Record<
      string,
      unknown
    >,
    textureReferences,
    textures,
  };
  return {
    materialSha256: await canonicalRecipeSha256(content),
    ...content,
  };
}

export async function buildAppearanceRecipeSemanticMaterialProof(
  parsed: SemanticGlbDocument,
): Promise<AppearanceRecipeSemanticMaterialProjection> {
  const active = parseActiveScene(parsed);
  const nodeKeys = semanticNodeKeys(parsed, active);
  const descriptors = await activePrimitives(parsed, active, nodeKeys);
  const materialByIndex = new Map<
    number,
    AppearanceRecipeSemanticMaterialProofEntry
  >();
  const primitives: AppearanceRecipeSemanticMaterialProjection["primitives"] =
    [];
  for (const descriptor of descriptors) {
    let materialSha256: string | null = null;
    if (descriptor.primitive.material !== undefined) {
      const materialIndex = integer(
        descriptor.primitive.material,
        `${descriptor.meshSemanticKey}.material`,
      );
      if (!materialByIndex.has(materialIndex)) {
        materialByIndex.set(
          materialIndex,
          await materialProofEntry(parsed, materialIndex),
        );
      }
      materialSha256 = materialByIndex.get(materialIndex)!.materialSha256;
    }
    primitives.push({
      meshSemanticKey: descriptor.meshSemanticKey,
      materialSha256,
      shadingAccessors: await shadingAccessorProofs(parsed, descriptor),
    });
  }
  primitives.sort((left, right) =>
    compareText(left.meshSemanticKey, right.meshSemanticKey),
  );
  const materials = [...materialByIndex.values()]
    .filter(
      (entry, index, all) =>
        all.findIndex(
          (candidate) => candidate.materialSha256 === entry.materialSha256,
        ) === index,
    )
    .sort((left, right) =>
      compareText(left.materialSha256, right.materialSha256),
    );
  const content = {
    contract: APPEARANCE_RECIPE_SEMANTIC_MATERIAL_PROOF_CONTRACT,
    primitives,
    materials,
  };
  return {
    ...content,
    projectionSha256: await canonicalRecipeSha256(content),
  };
}

export async function buildAppearanceRecipeSemanticProof(
  glbBytes: Uint8Array,
): Promise<AppearanceRecipeSemanticProof> {
  const parsed = parseSemanticGlb(glbBytes, {
    diagnosticPrefix: DIAGNOSTIC_PREFIX,
  });
  const correspondence =
    await buildAppearanceRecipeSemanticCorrespondence(parsed);
  const materials = await buildAppearanceRecipeSemanticMaterialProof(parsed);
  const content = {
    contract: APPEARANCE_RECIPE_SEMANTIC_PROOF_CONTRACT,
    correspondence,
    materials,
  };
  return {
    ...content,
    proofSha256: await canonicalRecipeSha256(content),
  };
}
