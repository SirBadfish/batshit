import type { EyeApertureSeamSideDefinitionV2 } from "../eyeApertureSeam";
import type { SocketEyeSurfaceSideDefinitionV2 } from "../socketEyeSurface";
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
import { canonicalRecipeSha256, sha256Hex } from "./recipeCanonical";

export const SOCKET_EYE_ANATOMY_PROOF_CONTRACT =
  "socket-eye-anatomy-proof/v2" as const;

export type SocketEyePrimitiveProof = {
  role: "physical-eye" | "treatment-upper" | "treatment-lower";
  nodeId: string;
  primitiveId: string;
  materialName: string | null;
  positionsScalarCount: number;
  positionsSha256: string;
  identityFollowerMorphs: string[];
  retainedDynamicMorphs: string[];
  surfaceCorrectiveMorphs: string[];
  followerInventorySha256: string;
};

export type SocketEyeAnatomyProof = {
  contract: typeof SOCKET_EYE_ANATOMY_PROOF_CONTRACT;
  domain: `socket-eye:${"left" | "right"}`;
  socketEyeSurfaceDefinitionSha256: string;
  apertureSeamDefinitionSha256: string;
  physicalEyeRootRelativeMatrix: number[];
  physicalEyeTransformSha256: string;
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

function finiteMatrix(value: readonly number[], context: string): number[] {
  if (!Array.isArray(value) || value.length !== 16) {
    fail(`${context} must contain exactly 16 scalars`);
  }
  return value.map((entry, index) => {
    if (!Number.isFinite(entry)) fail(`${context}[${index}] must be finite`);
    return entry;
  });
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
    const children = node.children === undefined
      ? []
      : array(node.children, `gltf.nodes[${nodeIndex}].children`);
    for (const [index, child] of children.entries()) {
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
  return stringValue(
    record(materials[materialIndex], `gltf.materials[${materialIndex}]`).name,
    `gltf.materials[${materialIndex}].name`,
  );
}

type PrimitiveCandidate = {
  nodeId: string;
  primitiveId: string;
  materialName: string | null;
  targetNames: string[];
  positions: Float32Array;
};

function primitiveCandidates(
  parsed: SemanticGlbDocument,
  evaluation: AppearanceRecipePhysicalEvaluation,
  rootNodeName: string,
): { rootIndex: number; candidates: PrimitiveCandidate[] } {
  const rootIndex = resolveSemanticGlbNode(parsed, rootNodeName, "socket-eye node");
  const evaluatedById = new Map(evaluation.meshes.map((entry) => [entry.id, entry.positions]));
  const candidates: PrimitiveCandidate[] = [];
  for (const nodeIndex of descendantNodeIndexes(parsed, rootIndex)) {
    const node = getSemanticGlbNode(parsed, nodeIndex, `gltf.nodes[${nodeIndex}]`);
    if (node.mesh === undefined) continue;
    const meshIndex = integer(node.mesh, `gltf.nodes[${nodeIndex}].mesh`);
    const mesh = getSemanticGlbMesh(parsed, meshIndex, `gltf.meshes[${meshIndex}]`);
    const extras = mesh.extras === undefined
      ? {}
      : record(mesh.extras, `gltf.meshes[${meshIndex}].extras`);
    const targetNames = sortedUnique(
      (extras.targetNames === undefined
        ? []
        : array(extras.targetNames, `gltf.meshes[${meshIndex}].extras.targetNames`)
      ).map((entry, index) =>
        stringValue(entry, `gltf.meshes[${meshIndex}].extras.targetNames[${index}]`),
      ),
      `gltf.meshes[${meshIndex}].extras.targetNames`,
    );
    for (const [primitiveIndex, primitiveValue] of array(
      mesh.primitives,
      `gltf.meshes[${meshIndex}].primitives`,
    ).entries()) {
      const context = `gltf.meshes[${meshIndex}].primitives[${primitiveIndex}]`;
      const primitive = record(primitiveValue, context);
      const targets = primitive.targets === undefined ? [] : array(primitive.targets, `${context}.targets`);
      if (targets.length !== targetNames.length) {
        fail(`${context} target payloads do not match the named morph inventory`);
      }
      const primitiveId = `mesh:${nodeIndex}:${primitiveIndex}`;
      const positions = evaluatedById.get(primitiveId);
      if (!positions) fail(`${primitiveId} is missing from the final physical evaluation`);
      candidates.push({
        nodeId: stableSemanticGlbNodeName(parsed, nodeIndex, `gltf.nodes[${nodeIndex}]`),
        primitiveId,
        materialName: materialName(parsed, primitive, context),
        targetNames,
        positions,
      });
    }
  }
  if (candidates.length === 0) fail(`${rootNodeName} has no physical mesh primitives`);
  candidates.sort((left, right) => left.primitiveId.localeCompare(right.primitiveId));
  return { rootIndex, candidates };
}

async function primitiveProof(
  candidate: PrimitiveCandidate,
  role: SocketEyePrimitiveProof["role"],
  identityFollowerMorphs: readonly string[],
  retainedDynamicMorphs: readonly string[],
  surfaceCorrectiveMorphs: readonly string[],
): Promise<SocketEyePrimitiveProof> {
  const identity = sortedUnique([...identityFollowerMorphs], `${candidate.primitiveId} identity inventory`);
  const dynamic = sortedUnique([...retainedDynamicMorphs], `${candidate.primitiveId} dynamic inventory`);
  const correctives = sortedUnique(
    [...surfaceCorrectiveMorphs],
    `${candidate.primitiveId} surface-corrective inventory`,
  );
  const expected = [...identity, ...dynamic, ...correctives].sort((left, right) => left.localeCompare(right));
  if (
    candidate.targetNames.length !== expected.length ||
    candidate.targetNames.some((entry, index) => entry !== expected[index])
  ) {
    fail(`${candidate.primitiveId} morph inventory does not exactly match its Recipe/Live contract`);
  }
  const followerInventory = { identityFollowerMorphs: identity };
  const bytes = new Uint8Array(
    candidate.positions.buffer,
    candidate.positions.byteOffset,
    candidate.positions.byteLength,
  );
  return {
    role,
    nodeId: candidate.nodeId,
    primitiveId: candidate.primitiveId,
    materialName: candidate.materialName,
    positionsScalarCount: candidate.positions.length,
    positionsSha256: await sha256Hex(bytes),
    identityFollowerMorphs: identity,
    retainedDynamicMorphs: dynamic,
    surfaceCorrectiveMorphs: correctives,
    followerInventorySha256: await canonicalRecipeSha256(followerInventory),
  };
}

/** Prove the exact static eye transform plus identity-resolved treatment geometry. */
export async function createSocketEyeAnatomyProof(args: {
  modelBytes: Uint8Array;
  evaluation: AppearanceRecipePhysicalEvaluation;
  surfaceDefinitionSha256: string;
  seamDefinitionSha256: string;
  surface: SocketEyeSurfaceSideDefinitionV2;
  seam: EyeApertureSeamSideDefinitionV2;
}): Promise<SocketEyeAnatomyProof> {
  const parsed = parseSemanticGlb(args.modelBytes, {
    diagnosticPrefix: SOCKET_EYE_ANATOMY_PROOF_CONTRACT,
  });
  const physical = primitiveCandidates(
    parsed,
    args.evaluation,
    args.surface.nodes.physicalEye,
  );
  if (physical.candidates.length !== 1) {
    fail(`${args.surface.side} physical eye must contain exactly one static full-sphere primitive`);
  }
  if (physical.candidates[0]!.targetNames.length !== 0) {
    fail(`${args.surface.side} physical eye must contain zero morph targets`);
  }
  const evaluatedPhysicalNode = args.evaluation.nodes.find(
    (entry) => entry.id === `node:${physical.rootIndex}`,
  );
  if (!evaluatedPhysicalNode) {
    fail(`${args.surface.side} physical eye transform is missing from the final physical evaluation`);
  }
  const physicalEyeRootRelativeMatrix = finiteMatrix(
    evaluatedPhysicalNode.rootRelativeMatrix,
    `${args.surface.side} physical eye root-relative transform`,
  );
  const physicalEyeTransformSha256 = await canonicalRecipeSha256({
    node: args.surface.nodes.physicalEye,
    rootRelativeMatrix: physicalEyeRootRelativeMatrix,
  });
  const physicalProof = await primitiveProof(
    physical.candidates[0]!,
    "physical-eye",
    [],
    [],
    [],
  );

  const treatment = primitiveCandidates(
    parsed,
    args.evaluation,
    args.seam.lashesEyeOutlineNode,
  ).candidates;
  if (treatment.length !== 2) {
    fail(`${args.surface.side} treatment must contain exactly one upper and one lower primitive`);
  }
  const upper = treatment.filter(
    (entry) => entry.materialName === args.seam.treatment.upperMaterialName,
  );
  const lower = treatment.filter(
    (entry) => entry.materialName === args.seam.treatment.lowerMaterialName,
  );
  if (upper.length !== 1 || lower.length !== 1) {
    fail(`${args.surface.side} treatment material identities must resolve one upper and one lower primitive`);
  }
  const retained = args.seam.treatment.retainedPerformanceMorphs;
  const followers = args.seam.treatment.followerMorphs;
  const identityFollowers = followers.filter((morph) => !retained.includes(morph));
  if (identityFollowers.length === 0) {
    fail(`${args.surface.side} treatment must contain geometry-derived identity followers`);
  }
  const correction = args.seam.treatment.surfaceCorrection;
  const surfaceCorrectives = [
    correction.projectionMorph,
    correction.blinkLinearMorph,
    correction.blinkResidualMorph,
  ];
  const treatmentFollowerInventorySha256 = await canonicalRecipeSha256({
    identityFollowerMorphs: identityFollowers,
  });
  if (treatmentFollowerInventorySha256 !== args.seam.treatment.followerInventorySha256) {
    fail(`${args.surface.side} treatment identity follower inventory hash is stale`);
  }
  const treatmentProofs = await Promise.all([
    primitiveProof(upper[0]!, "treatment-upper", identityFollowers, retained, surfaceCorrectives),
    primitiveProof(lower[0]!, "treatment-lower", identityFollowers, retained, surfaceCorrectives),
  ]);
  const primitives = [physicalProof, ...treatmentProofs];
  const geometrySha256 = await canonicalRecipeSha256({
    physicalEyeRootRelativeMatrix,
    primitives: primitives.map((entry) => ({
      role: entry.role,
      nodeId: entry.nodeId,
      primitiveId: entry.primitiveId,
      materialName: entry.materialName,
      positionsScalarCount: entry.positionsScalarCount,
      positionsSha256: entry.positionsSha256,
    })),
  });
  const followerInventorySha256 = await canonicalRecipeSha256(
    primitives.map((entry) => ({
      role: entry.role,
      primitiveId: entry.primitiveId,
      identityFollowerMorphs: entry.identityFollowerMorphs,
      retainedDynamicMorphs: entry.retainedDynamicMorphs,
      surfaceCorrectiveMorphs: entry.surfaceCorrectiveMorphs,
      followerInventorySha256: entry.followerInventorySha256,
    })),
  );
  const payload = {
    contract: SOCKET_EYE_ANATOMY_PROOF_CONTRACT,
    domain: `socket-eye:${args.surface.side}` as const,
    socketEyeSurfaceDefinitionSha256: args.surfaceDefinitionSha256,
    apertureSeamDefinitionSha256: args.seamDefinitionSha256,
    physicalEyeRootRelativeMatrix,
    physicalEyeTransformSha256,
    primitives,
    geometrySha256,
    followerInventorySha256,
    scalarCount: primitives.reduce((sum, entry) => sum + entry.positionsScalarCount, 0) + 16,
  };
  return { ...payload, proofSha256: await canonicalRecipeSha256(payload) };
}
