import type { AppearanceRecipePhysicalEvaluation } from "./appearanceRecipePhysicalEvaluator";
import {
  getSemanticGlbMesh,
  getSemanticGlbNode,
  parseSemanticGlb,
  resolveSemanticGlbNode,
  stableSemanticGlbNodeName,
  type SemanticGlbDocument,
  type SemanticJsonRecord,
} from "./semanticGlb";
import {
  canonicalRecipeSha256,
  sha256Hex,
} from "./recipeCanonical";
import {
  socketEyeCapRetainedDynamicMorphs,
  type SocketEyeSurfaceSideDefinition,
} from "../socketEyeSurface";
import type { EyeApertureSeamSideDefinition } from "../eyeApertureSeam";

export const SOCKET_EYE_ANATOMY_PROOF_CONTRACT =
  "socket-eye-anatomy-proof/v1" as const;

export type SocketEyePrimitiveProof = {
  role: "composite-cap-visible" | "composite-cap-hidden" | "lashes-eye-outline";
  nodeId: string;
  primitiveId: string;
  positionsScalarCount: number;
  positionsSha256: string;
  identityFollowerMorphs: string[];
  retainedDynamicMorphs: string[];
  followerInventorySha256: string;
};

export type SocketEyeAnatomyProof = {
  contract: typeof SOCKET_EYE_ANATOMY_PROOF_CONTRACT;
  domain: `socket-eye:${"left" | "right"}`;
  socketEyeSurfaceDefinitionSha256: string;
  apertureSeamDefinitionSha256: string;
  primitives: SocketEyePrimitiveProof[];
  geometrySha256: string;
  followerInventorySha256: string;
  scalarCount: number;
  proofSha256: string;
};

function fail(message: string): never {
  throw new Error(`[${SOCKET_EYE_ANATOMY_PROOF_CONTRACT}] ${message}`);
}

function record(value: unknown, context: string): SemanticJsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${context} must be an object`);
  }
  return value as SemanticJsonRecord;
}

function array(value: unknown, context: string): unknown[] {
  if (!Array.isArray(value)) fail(`${context} must be an array`);
  return value;
}

function integer(value: unknown, context: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    fail(`${context} must be a non-negative safe integer`);
  }
  return value as number;
}

function stringValue(value: unknown, context: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    fail(`${context} must be a non-empty trimmed string`);
  }
  return value;
}

function sortedUnique(values: string[], context: string): string[] {
  const sorted = [...values].sort((left, right) => left.localeCompare(right));
  if (new Set(sorted).size !== sorted.length) fail(`${context} contains duplicate morph names`);
  return sorted;
}

function descendantNodeIndexes(parsed: SemanticGlbDocument, rootIndex: number): number[] {
  const result: number[] = [];
  const visiting = new Set<number>();
  const visit = (nodeIndex: number) => {
    if (visiting.has(nodeIndex)) fail(`node ${nodeIndex} creates a descendant cycle`);
    visiting.add(nodeIndex);
    result.push(nodeIndex);
    const node = getSemanticGlbNode(parsed, nodeIndex, `gltf.nodes[${nodeIndex}]`);
    for (const [index, child] of (node.children === undefined ? [] : array(node.children, `gltf.nodes[${nodeIndex}].children`)).entries()) {
      visit(integer(child, `gltf.nodes[${nodeIndex}].children[${index}]`));
    }
    visiting.delete(nodeIndex);
  };
  visit(rootIndex);
  return result;
}

function materialName(
  parsed: SemanticGlbDocument,
  primitive: SemanticJsonRecord,
  context: string,
): string | null {
  if (primitive.material === undefined) return null;
  const materials = array(parsed.gltf.materials, "gltf.materials");
  const materialIndex = integer(primitive.material, `${context}.material`);
  if (materialIndex >= materials.length) fail(`${context}.material is out of range`);
  return stringValue(record(materials[materialIndex], `gltf.materials[${materialIndex}]`).name, `gltf.materials[${materialIndex}].name`);
}

type PrimitiveCandidate = {
  nodeIndex: number;
  nodeId: string;
  primitiveIndex: number;
  primitiveId: string;
  materialName: string | null;
  targetNames: string[];
  positions: Float32Array;
};

function primitiveCandidates(
  parsed: SemanticGlbDocument,
  evaluation: AppearanceRecipePhysicalEvaluation,
  rootNodeName: string,
): PrimitiveCandidate[] {
  const rootIndex = resolveSemanticGlbNode(parsed, rootNodeName, "socket-eye node");
  const evaluatedById = new Map(evaluation.meshes.map((entry) => [entry.id, entry.positions]));
  const result: PrimitiveCandidate[] = [];
  for (const nodeIndex of descendantNodeIndexes(parsed, rootIndex)) {
    const node = getSemanticGlbNode(parsed, nodeIndex, `gltf.nodes[${nodeIndex}]`);
    if (node.mesh === undefined) continue;
    const meshIndex = integer(node.mesh, `gltf.nodes[${nodeIndex}].mesh`);
    const mesh = getSemanticGlbMesh(parsed, meshIndex, `gltf.meshes[${meshIndex}]`);
    const extras = mesh.extras === undefined ? {} : record(mesh.extras, `gltf.meshes[${meshIndex}].extras`);
    const targetNames = sortedUnique(
      (extras.targetNames === undefined ? [] : array(extras.targetNames, `gltf.meshes[${meshIndex}].extras.targetNames`))
        .map((entry, index) => stringValue(entry, `gltf.meshes[${meshIndex}].extras.targetNames[${index}]`)),
      `gltf.meshes[${meshIndex}].extras.targetNames`,
    );
    for (const [primitiveIndex, primitiveValue] of array(mesh.primitives, `gltf.meshes[${meshIndex}].primitives`).entries()) {
      const context = `gltf.meshes[${meshIndex}].primitives[${primitiveIndex}]`;
      const primitive = record(primitiveValue, context);
      const targets = primitive.targets === undefined ? [] : array(primitive.targets, `${context}.targets`);
      if (targets.length !== targetNames.length) {
        fail(`${context} target payloads do not match the named morph inventory`);
      }
      const primitiveId = `mesh:${nodeIndex}:${primitiveIndex}`;
      const positions = evaluatedById.get(primitiveId);
      if (!positions) fail(`${primitiveId} is missing from the final physical evaluation`);
      result.push({
        nodeIndex,
        nodeId: stableSemanticGlbNodeName(parsed, nodeIndex, `gltf.nodes[${nodeIndex}]`),
        primitiveIndex,
        primitiveId,
        materialName: materialName(parsed, primitive, context),
        targetNames,
        positions,
      });
    }
  }
  if (result.length === 0) fail(`${rootNodeName} has no physical mesh primitives`);
  return result.sort((left, right) => left.primitiveId.localeCompare(right.primitiveId));
}

async function primitiveProof(
  candidate: PrimitiveCandidate,
  role: SocketEyePrimitiveProof["role"],
  retainedDynamicMorphs: readonly string[],
  expectedIdentityFollowerMorphs?: readonly string[],
): Promise<SocketEyePrimitiveProof> {
  const dynamic = sortedUnique([...retainedDynamicMorphs], `${candidate.primitiveId} dynamic inventory`);
  for (const morph of dynamic) {
    if (!candidate.targetNames.includes(morph)) {
      fail(`${candidate.primitiveId} is missing retained dynamic morph ${morph}`);
    }
  }
  const identity =
    expectedIdentityFollowerMorphs === undefined
      ? candidate.targetNames.filter((morph) => !dynamic.includes(morph))
      : sortedUnique(
          [...expectedIdentityFollowerMorphs],
          `${candidate.primitiveId} expected identity inventory`,
        );
  for (const morph of identity) {
    if (!candidate.targetNames.includes(morph)) {
      fail(`${candidate.primitiveId} is missing identity follower morph ${morph}`);
    }
  }
  if (identity.length === 0) {
    fail(`${candidate.primitiveId} has no identity follower morphs`);
  }
  const followerInventory = { identityFollowerMorphs: identity, retainedDynamicMorphs: dynamic };
  const bytes = new Uint8Array(
    candidate.positions.buffer,
    candidate.positions.byteOffset,
    candidate.positions.byteLength,
  );
  return {
    role,
    nodeId: candidate.nodeId,
    primitiveId: candidate.primitiveId,
    positionsScalarCount: candidate.positions.length,
    positionsSha256: await sha256Hex(bytes),
    ...followerInventory,
    followerInventorySha256: await canonicalRecipeSha256(followerInventory),
  };
}

/**
 * Prove the exact identity-resolved cap/liner geometry and the split between
 * authoring-only identity followers and each node's exact Live performance inventory.
 */
export async function createSocketEyeAnatomyProof(args: {
  modelBytes: Uint8Array;
  evaluation: AppearanceRecipePhysicalEvaluation;
  surfaceDefinitionSha256: string;
  seamDefinitionSha256: string;
  surface: SocketEyeSurfaceSideDefinition;
  seam: EyeApertureSeamSideDefinition;
}): Promise<SocketEyeAnatomyProof> {
  const parsed = parseSemanticGlb(args.modelBytes, {
    diagnosticPrefix: SOCKET_EYE_ANATOMY_PROOF_CONTRACT,
  });
  const capDynamic = socketEyeCapRetainedDynamicMorphs(args.surface.side);
  const linerDynamic = args.seam.liner.retainedPerformanceMorphs;
  const cap = primitiveCandidates(parsed, args.evaluation, args.surface.nodes.compositeCap);
  const visible = cap.filter((entry) => entry.materialName === args.surface.cap.visibleFrontFaceGroup);
  const hidden = cap.filter((entry) => entry.materialName === args.surface.cap.hiddenClosureFaceGroup);
  if (visible.length !== 1 || hidden.length !== 1 || cap.length !== 2) {
    fail(`${args.surface.side} composite cap must contain exactly one visible and one hidden primitive`);
  }
  const liner = primitiveCandidates(parsed, args.evaluation, args.seam.lashesEyeOutlineNode);
  const capPrimitives = await Promise.all([
    primitiveProof(visible[0]!, "composite-cap-visible", capDynamic),
    primitiveProof(hidden[0]!, "composite-cap-hidden", capDynamic),
  ]);
  const capIdentityInventories = capPrimitives.map((entry) =>
    entry.identityFollowerMorphs.join("\u0000"),
  );
  if (new Set(capIdentityInventories).size !== 1) {
    fail(`${args.surface.side} cap primitives must share one exact identity follower inventory`);
  }
  const identityFollowerMorphs = capPrimitives[0]!.identityFollowerMorphs;
  const linerPrimitives = await Promise.all(
    liner.map((entry) =>
      primitiveProof(
        entry,
        "lashes-eye-outline",
        linerDynamic,
        identityFollowerMorphs,
      ),
    ),
  );
  const primitives = [...capPrimitives, ...linerPrimitives];
  const geometry = primitives.map((entry) => ({
    role: entry.role,
    primitiveId: entry.primitiveId,
    positionsScalarCount: entry.positionsScalarCount,
    positionsSha256: entry.positionsSha256,
  }));
  const inventories = primitives.map((entry) => ({
    role: entry.role,
    primitiveId: entry.primitiveId,
    identityFollowerMorphs: entry.identityFollowerMorphs,
    retainedDynamicMorphs: entry.retainedDynamicMorphs,
    followerInventorySha256: entry.followerInventorySha256,
  }));
  const payload = {
    contract: SOCKET_EYE_ANATOMY_PROOF_CONTRACT,
    domain: `socket-eye:${args.surface.side}` as const,
    socketEyeSurfaceDefinitionSha256: args.surfaceDefinitionSha256,
    apertureSeamDefinitionSha256: args.seamDefinitionSha256,
    primitives,
    geometrySha256: await canonicalRecipeSha256(geometry),
    followerInventorySha256: await canonicalRecipeSha256(inventories),
    scalarCount: primitives.reduce((sum, entry) => sum + entry.positionsScalarCount, 0),
  };
  return { ...payload, proofSha256: await canonicalRecipeSha256(payload) };
}
