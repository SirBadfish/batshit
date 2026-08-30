import * as THREE from "three";
import type { AppearanceRecipePhysicalSnapshot } from "./appearanceRecipeSnapshot";
import type {
  AppearanceRecipePhysicalEvaluation,
  AppearanceRecipePositionDelta,
} from "./appearanceRecipePhysicalEvaluator";
import {
  canonicalRecipeSha256,
  canonicalRecipeString,
  sha256Hex,
} from "./recipeCanonical";

export const APPEARANCE_RECIPE_LOGICAL_PROOF_PROJECTION_CONTRACT =
  "appearance-recipe-logical-proof-projection/v1" as const;
export const APPEARANCE_RECIPE_ABSOLUTE_PROOF_PROJECTION_CONTRACT =
  "appearance-recipe-absolute-proof-projection/v1" as const;
export const APPEARANCE_RECIPE_RELATIVE_EFFECT_PROJECTION_CONTRACT =
  "appearance-recipe-relative-effect-projection/v1" as const;

export const APPEARANCE_RECIPE_PHYSICAL_PROOF_TOLERANCES = {
  scalar: 1e-7,
  positionMeters: 1e-6,
  scale: 1e-6,
  quaternionRadians: 1e-6,
  matrix: 1e-6,
  bakedPositionMeters: 1e-6,
} as const;

export type AppearanceRecipePhysicalProofTolerances = {
  scalar: number;
  positionMeters: number;
  scale: number;
  quaternionRadians: number;
  matrix: number;
  bakedPositionMeters: number;
};

export type AppearanceRecipePhysicalMismatchDomain =
  "geometry" | "rest" | "pivot" | "attachment" | "grounding";

/**
 * R2-C deliberately uses package-local GLB indices as physical ids. R2-D
 * callers must supply a strict one-to-one semantic correspondence before two
 * packages can be compared. Typical values are stable runtime node names and
 * node-name/primitive-signature keys derived by the semantic GLB adapter.
 */
export type AppearanceRecipePhysicalCorrespondence = {
  meshes: Readonly<Record<string, string>>;
  nodes: Readonly<Record<string, string>>;
  bones: Readonly<Record<string, string>>;
  skins: Readonly<Record<string, string>>;
};

export type AppearanceRecipePhysicalProofInput = {
  logical: AppearanceRecipePhysicalSnapshot;
  absolute: AppearanceRecipePhysicalEvaluation;
  correspondence: AppearanceRecipePhysicalCorrespondence;
};

type ProofChannelKind =
  "scalar" | "position" | "scale" | "quaternion" | "matrix" | "baked-position";

type ProofNumericStorage = "float32le" | "float64le";

type ProofChannel = {
  key: string;
  kind: ProofChannelKind;
  domain: AppearanceRecipePhysicalMismatchDomain;
  itemSize: number;
  storage: ProofNumericStorage;
  values: Float32Array | Float64Array;
};

export type AppearanceRecipeCanonicalProofChannel = Omit<
  ProofChannel,
  "values"
> & {
  valueCount: number;
  valuesSha256: string;
};

export type AppearanceRecipeLogicalProofProjection = {
  contract: typeof APPEARANCE_RECIPE_LOGICAL_PROOF_PROJECTION_CONTRACT;
  inventory: string[];
  channels: AppearanceRecipeCanonicalProofChannel[];
  projectionSha256: string;
};

export type AppearanceRecipeAbsoluteProofProjection = {
  contract: typeof APPEARANCE_RECIPE_ABSOLUTE_PROOF_PROJECTION_CONTRACT;
  inventory: string[];
  channels: AppearanceRecipeCanonicalProofChannel[];
  projectionSha256: string;
};

export type AppearanceRecipeRelativeEffectSelection = {
  logicalKeys?: readonly string[];
  absoluteKeys?: readonly string[];
};

export type AppearanceRecipeRelativeEffectProjection = {
  contract: typeof APPEARANCE_RECIPE_RELATIVE_EFFECT_PROJECTION_CONTRACT;
  logical: AppearanceRecipeLogicalProofProjection;
  absolute: AppearanceRecipeAbsoluteProofProjection;
  projectionSha256: string;
};

export type AppearanceRecipePhysicalProofKeyInventory = {
  logicalKeys: string[];
  absoluteKeys: string[];
};

export type AppearanceRecipePhysicalProofErrorSummary = {
  scalarMaximum: number;
  positionMaximumMeters: number;
  positionRmsMeters: number;
  scaleMaximum: number;
  quaternionMaximumRadians: number;
  matrixMaximum: number;
  bakedPositionMaximumMeters: number;
  bakedPositionRmsMeters: number;
};

export type AppearanceRecipePhysicalProofComparison = {
  matches: boolean;
  errors: AppearanceRecipePhysicalProofErrorSummary;
  mismatchDomains: AppearanceRecipePhysicalMismatchDomain[];
  mismatchChannelKeys: string[];
  sourceLogicalOutputSha256: string;
  targetLogicalOutputSha256: string;
  sourceAbsoluteOutputSha256: string;
  targetAbsoluteOutputSha256: string;
  comparedLogicalKeysSha256: string;
  comparedAbsoluteKeysSha256: string;
};

export type AppearanceRecipeRelativeComponentEffectComparison = {
  matches: boolean;
  errors: AppearanceRecipePhysicalProofErrorSummary;
  mismatchDomains: AppearanceRecipePhysicalMismatchDomain[];
  mismatchChannelKeys: string[];
  sourceLogicalEffectSha256: string;
  targetLogicalEffectSha256: string;
  sourceAbsoluteEffectSha256: string;
  targetAbsoluteEffectSha256: string;
  comparedLogicalKeysSha256: string;
  comparedAbsoluteKeysSha256: string;
};

export class AppearanceRecipePhysicalInventoryMismatchError extends Error {
  readonly mismatchDomains: AppearanceRecipePhysicalMismatchDomain[];

  constructor(
    message: string,
    mismatchDomains: Iterable<AppearanceRecipePhysicalMismatchDomain>,
  ) {
    super(`appearance Recipe physical proof inventory mismatch: ${message}`);
    this.name = "AppearanceRecipePhysicalInventoryMismatchError";
    this.mismatchDomains = [...new Set(mismatchDomains)].sort();
  }
}

function fail(message: string): never {
  throw new Error(`appearance Recipe physical proof rejected: ${message}`);
}

function finite(value: number, context: string): number {
  if (!Number.isFinite(value)) fail(`${context} must be finite`);
  return Object.is(value, -0) ? 0 : value;
}

function stableText(value: string, context: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim() ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    fail(`${context} must be non-empty stable text`);
  }
  return value;
}

function key(...parts: string[]): string {
  return canonicalRecipeString(parts);
}

function values(
  source: ArrayLike<number>,
  context: string,
  storage: ProofNumericStorage = "float64le",
): Float32Array | Float64Array {
  const output =
    storage === "float32le"
      ? new Float32Array(source.length)
      : new Float64Array(source.length);
  for (let index = 0; index < source.length; index += 1) {
    output[index] = finite(source[index]!, `${context}[${index}]`);
  }
  return output;
}

function channel(
  channelKey: string,
  kind: ProofChannelKind,
  domain: AppearanceRecipePhysicalMismatchDomain,
  itemSize: number,
  source: ArrayLike<number>,
  context: string,
  storage: ProofNumericStorage = "float64le",
): ProofChannel {
  stableText(channelKey, `${context} key`);
  if (!Number.isSafeInteger(itemSize) || itemSize <= 0) {
    fail(`${context} itemSize must be a positive safe integer`);
  }
  if (source.length === 0 || source.length % itemSize !== 0) {
    fail(`${context} values must contain complete non-empty items`);
  }
  return {
    key: channelKey,
    kind,
    domain,
    itemSize,
    storage,
    values: values(source, context, storage),
  };
}

function sortedChannels(
  channels: ProofChannel[],
  context: string,
): ProofChannel[] {
  channels.sort((left, right) => left.key.localeCompare(right.key));
  for (let index = 1; index < channels.length; index += 1) {
    if (channels[index - 1]!.key === channels[index]!.key) {
      fail(`${context} duplicates channel ${channels[index]!.key}`);
    }
  }
  return channels;
}

function exactSemanticMap(
  value: Readonly<Record<string, string>>,
  physicalIds: readonly string[],
  context: string,
): Map<string, string> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${context} correspondence must be an object`);
  }
  const expected = [...physicalIds].sort();
  const actual = Object.keys(value).sort();
  if (
    expected.length !== actual.length ||
    expected.some((id, index) => id !== actual[index])
  ) {
    fail(`${context} correspondence must exhaust the physical inventory`);
  }
  const semantic = actual.map((id) =>
    stableText(value[id]!, `${context}.${id}`),
  );
  if (new Set(semantic).size !== semantic.length) {
    fail(`${context} correspondence must be one-to-one`);
  }
  return new Map(actual.map((id, index) => [id, semantic[index]!]));
}

function mapRequired(
  mapping: Map<string, string>,
  physicalId: string,
  context: string,
): string {
  const semantic = mapping.get(physicalId);
  if (!semantic)
    fail(`${context} references unmapped physical id ${physicalId}`);
  return semantic;
}

function buildLogicalChannels(
  snapshot: AppearanceRecipePhysicalSnapshot,
): ProofChannel[] {
  if (snapshot.contract !== "appearance-recipe-physical-snapshot/v1") {
    fail("logical snapshot contract is invalid");
  }
  const result: ProofChannel[] = [];
  for (const entry of snapshot.influences) {
    result.push(
      channel(
        key("logical", "target", entry.target, "weight"),
        "scalar",
        "geometry",
        1,
        [entry.weight],
        `target ${entry.target}`,
      ),
    );
  }
  // jointOffsets and followerInputs are resolver intermediates, not final
  // physical outputs. A valid remap may change either while reproducing the
  // same final joint rests, inverse binds, and follower channels below.
  for (const entry of snapshot.followerNodeTransforms) {
    const identity = [
      "logical",
      "follower-node",
      entry.follower,
      entry.channel,
      entry.driver.kind,
      entry.driver.id,
      entry.node,
    ];
    result.push(
      channel(
        key(...identity, "translation"),
        "position",
        "rest",
        3,
        entry.translation,
        `follower ${entry.follower}/${entry.channel} translation`,
      ),
      channel(
        key(...identity, "rotation"),
        "quaternion",
        "rest",
        4,
        entry.rotation,
        `follower ${entry.follower}/${entry.channel} rotation`,
      ),
      channel(
        key(...identity, "scale"),
        "scale",
        "rest",
        3,
        entry.scale,
        `follower ${entry.follower}/${entry.channel} scale`,
      ),
      channel(
        key(...identity, "pivot"),
        "position",
        "pivot",
        3,
        entry.pivot,
        `follower ${entry.follower}/${entry.channel} pivot`,
      ),
    );
  }
  for (const entry of snapshot.followerMorphs) {
    result.push(
      channel(
        key(
          "logical",
          "follower-morph",
          entry.follower,
          entry.channel,
          entry.driver.kind,
          entry.driver.id,
          entry.node,
          entry.morph,
          entry.runtimeRetention,
        ),
        "scalar",
        "geometry",
        1,
        [entry.weight],
        `follower morph ${entry.follower}/${entry.channel}`,
      ),
    );
  }
  result.push(
    channel(
      key("logical", "root", "scale"),
      "scale",
      "grounding",
      1,
      [snapshot.rootScale],
      "logical root scale",
    ),
    channel(
      key("logical", "root", "sole-offset"),
      "position",
      "grounding",
      1,
      [snapshot.soleOffsetY],
      "logical sole offset",
    ),
  );
  return sortedChannels(result, "logical proof");
}

function materializePositionDelta(
  delta: AppearanceRecipePositionDelta,
  context: string,
): Float32Array {
  // `structuredClone` and browser/worker boundaries can produce a valid
  // Float32Array from another realm, where `instanceof Float32Array` is false.
  if (Object.prototype.toString.call(delta) === "[object Float32Array]") {
    const typed = delta as Float32Array;
    if (typed.length === 0 || typed.length % 3 !== 0) {
      fail(`${context} must contain complete non-empty VEC3 values`);
    }
    return values(typed, context, "float32le") as Float32Array;
  }
  const visitorDelta = delta as {
    length: number;
    visit: (visitor: (index: number, value: number) => void) => void;
  };
  if (
    !visitorDelta ||
    typeof visitorDelta !== "object" ||
    !Number.isSafeInteger(visitorDelta.length) ||
    visitorDelta.length <= 0 ||
    visitorDelta.length % 3 !== 0 ||
    typeof visitorDelta.visit !== "function"
  ) {
    fail(`${context} visitor is malformed`);
  }
  const output = new Float32Array(visitorDelta.length);
  let previous = -1;
  visitorDelta.visit((index, value) => {
    if (
      !Number.isSafeInteger(index) ||
      index < 0 ||
      index >= visitorDelta.length ||
      index <= previous
    ) {
      fail(
        `${context} visitor indices must be unique, ascending, and in range`,
      );
    }
    previous = index;
    output[index] = finite(value, `${context}[${index}]`);
  });
  return output;
}

function roleDomain(
  kind: AppearanceRecipePhysicalEvaluation["roles"][number]["kind"],
): AppearanceRecipePhysicalMismatchDomain {
  return kind === "attachment" ? "attachment" : "rest";
}

function buildAbsoluteChannels(
  evaluation: AppearanceRecipePhysicalEvaluation,
  correspondence: AppearanceRecipePhysicalCorrespondence,
): ProofChannel[] {
  if (evaluation.contract !== "appearance-recipe-physical-evaluation/v1") {
    fail("absolute physical evaluation contract is invalid");
  }
  const meshMap = exactSemanticMap(
    correspondence.meshes,
    evaluation.meshes.map((entry) => entry.id),
    "mesh",
  );
  const nodeMap = exactSemanticMap(
    correspondence.nodes,
    evaluation.nodes.map((entry) => entry.id),
    "node",
  );
  const boneMap = exactSemanticMap(
    correspondence.bones,
    evaluation.jointRests.map((entry) => entry.boneId),
    "bone",
  );
  const skinMap = exactSemanticMap(
    correspondence.skins,
    evaluation.skins.map((entry) => entry.id),
    "skin",
  );
  const result: ProofChannel[] = [];

  for (const mesh of evaluation.meshes) {
    const semanticMesh = mapRequired(meshMap, mesh.id, `mesh ${mesh.id}`);
    const semanticNode = mapRequired(nodeMap, mesh.nodeId, `mesh ${mesh.id}`);
    result.push(
      channel(
        key("absolute", "mesh", semanticMesh, semanticNode, "POSITION"),
        "baked-position",
        "geometry",
        3,
        mesh.positions,
        `mesh ${semanticMesh} POSITION`,
        "float32le",
      ),
    );
  }

  for (const binding of evaluation.retainedTargetPositionBindings) {
    const semanticMesh = mapRequired(
      meshMap,
      binding.meshId,
      `retained target ${binding.targetId}`,
    );
    const identity = [
      "absolute",
      "retained-target",
      binding.targetId,
      binding.node,
      binding.morph,
      semanticMesh,
    ];
    result.push(
      channel(
        key(...identity, "delta"),
        "position",
        "geometry",
        3,
        materializePositionDelta(
          binding.positionDelta,
          `retained target ${binding.targetId} delta`,
        ),
        `retained target ${binding.targetId} delta`,
        "float32le",
      ),
      channel(
        key(...identity, "weight"),
        "scalar",
        "geometry",
        1,
        [binding.weight],
        `retained target ${binding.targetId} weight`,
      ),
    );
  }

  for (const morph of evaluation.followerMorphWeights) {
    result.push(
      channel(
        key(
          "absolute",
          "follower-morph",
          morph.follower,
          morph.channel,
          morph.driver.kind,
          morph.driver.id,
          morph.node,
          morph.morph,
        ),
        "scalar",
        "geometry",
        1,
        [morph.weight],
        `absolute follower morph ${morph.follower}/${morph.channel}`,
      ),
    );
  }

  for (const joint of evaluation.jointRests) {
    const semanticBone = mapRequired(
      boneMap,
      joint.boneId,
      `joint ${joint.bone}`,
    );
    const semanticNode = mapRequired(
      nodeMap,
      joint.nodeId,
      `joint ${joint.bone}`,
    );
    const parent = joint.parentBoneId
      ? mapRequired(boneMap, joint.parentBoneId, `joint ${joint.bone} parent`)
      : "<root>";
    const identity = [
      "absolute",
      "joint",
      semanticBone,
      joint.bone,
      semanticNode,
      parent,
    ];
    result.push(
      channel(
        key(...identity, "avatar-root-offset"),
        "position",
        "rest",
        3,
        joint.avatarRootOffset,
        `joint ${joint.bone} avatar-root offset`,
      ),
      channel(
        key(...identity, "local-position"),
        "position",
        "rest",
        3,
        joint.localPosition,
        `joint ${joint.bone} local position`,
      ),
      channel(
        key(...identity, "local-matrix"),
        "matrix",
        "rest",
        16,
        joint.localMatrix,
        `joint ${joint.bone} local matrix`,
      ),
    );
  }

  for (const skin of evaluation.skins) {
    const semanticSkin = mapRequired(skinMap, skin.id, `skin ${skin.id}`);
    skin.joints.forEach((joint, slot) => {
      const semanticBone = mapRequired(
        boneMap,
        joint.boneId,
        `skin ${skin.id} slot ${slot}`,
      );
      result.push(
        channel(
          key(
            "absolute",
            "skin",
            semanticSkin,
            "slot",
            String(slot),
            semanticBone,
            "inverse-bind",
          ),
          "matrix",
          "rest",
          16,
          joint.inverseBindMatrix,
          `skin ${semanticSkin} slot ${slot} inverse bind`,
        ),
      );
    });
  }

  result.push(
    channel(
      key("absolute", "root", "matrix"),
      "matrix",
      "grounding",
      16,
      evaluation.root.matrix,
      "root matrix",
    ),
    channel(
      key("absolute", "root", "position"),
      "position",
      "grounding",
      3,
      evaluation.root.position,
      "root position",
    ),
    channel(
      key("absolute", "root", "rotation"),
      "quaternion",
      "grounding",
      4,
      evaluation.root.rotation,
      "root rotation",
    ),
    channel(
      key("absolute", "root", "scale"),
      "scale",
      "grounding",
      3,
      evaluation.root.scale,
      "root scale vector",
    ),
    channel(
      key("absolute", "root", "root-scale"),
      "scale",
      "grounding",
      1,
      [evaluation.root.rootScale],
      "root scale law",
    ),
    channel(
      key("absolute", "root", "sole-offset"),
      "position",
      "grounding",
      1,
      [evaluation.root.soleOffsetY],
      "root sole offset",
    ),
  );

  for (const node of evaluation.nodes) {
    const semanticNode = mapRequired(nodeMap, node.id, `node ${node.id}`);
    const parent = node.parentId
      ? mapRequired(nodeMap, node.parentId, `node ${node.id} parent`)
      : "<root>";
    const identity = ["absolute", "node", semanticNode, "parent", parent];
    result.push(
      channel(
        key(...identity, "local"),
        "matrix",
        "rest",
        16,
        node.localMatrix,
        `node ${semanticNode} local matrix`,
      ),
      channel(
        key(...identity, "root-relative"),
        "matrix",
        "rest",
        16,
        node.rootRelativeMatrix,
        `node ${semanticNode} root-relative matrix`,
      ),
      channel(
        key(...identity, "world"),
        "matrix",
        "rest",
        16,
        node.worldMatrix,
        `node ${semanticNode} world matrix`,
      ),
    );
  }

  for (const role of evaluation.roles) {
    const semanticNode = mapRequired(
      nodeMap,
      role.nodeId,
      `${role.kind} ${role.id}`,
    );
    const declaredParent = role.declaredParent
      ? canonicalRecipeString(role.declaredParent)
      : "null";
    const identity = [
      "absolute",
      "role",
      role.kind,
      role.id,
      semanticNode,
      declaredParent,
    ];
    const domain = roleDomain(role.kind);
    result.push(
      channel(
        key(...identity, "root-relative"),
        "matrix",
        domain,
        16,
        role.rootRelativeMatrix,
        `${role.kind} ${role.id} root-relative matrix`,
      ),
      channel(
        key(...identity, "world"),
        "matrix",
        domain,
        16,
        role.worldMatrix,
        `${role.kind} ${role.id} world matrix`,
      ),
      channel(
        key(...identity, "world-position"),
        "position",
        domain,
        3,
        role.worldPosition,
        `${role.kind} ${role.id} world position`,
      ),
    );
  }

  if (evaluation.hipsClipRemap) {
    const hips = evaluation.hipsClipRemap;
    const semanticBone = mapRequired(boneMap, hips.boneId, "hips clip remap");
    const identity = ["absolute", "hips-clip-remap", semanticBone, hips.bone];
    result.push(
      channel(
        key(...identity, "base-rest"),
        "position",
        "rest",
        3,
        hips.baseRest,
        "hips clip base rest",
      ),
      channel(
        key(...identity, "new-rest"),
        "position",
        "rest",
        3,
        hips.newRest,
        "hips clip new rest",
      ),
      channel(
        key(...identity, "ratio"),
        "scalar",
        "rest",
        1,
        [hips.ratio],
        "hips clip ratio",
      ),
    );
  }

  return sortedChannels(result, "absolute proof");
}

function canonicalQuaternion(
  source: ArrayLike<number>,
  context: string,
): number[] {
  if (source.length !== 4) fail(`${context} must contain four components`);
  const components = Array.from(source, (value, index) =>
    finite(value, `${context}[${index}]`),
  );
  const length = Math.hypot(...components);
  if (!Number.isFinite(length) || length <= Number.EPSILON) {
    fail(`${context} must have non-zero finite length`);
  }
  const normalized = components.map((value) => value / length);
  const firstNonzero = normalized.find((value) => value !== 0);
  if (firstNonzero !== undefined && firstNonzero < 0) {
    return normalized.map((value) => (value === 0 ? 0 : -value));
  }
  return normalized.map((value) => (Object.is(value, -0) ? 0 : value));
}

async function hashNumericValues(channelValue: ProofChannel): Promise<string> {
  const projected =
    channelValue.kind === "quaternion"
      ? canonicalQuaternion(channelValue.values, channelValue.key)
      : Array.from(channelValue.values);
  const bytesPerValue = channelValue.storage === "float32le" ? 4 : 8;
  const bytes = new Uint8Array(projected.length * bytesPerValue);
  const view = new DataView(bytes.buffer);
  projected.forEach((value, index) => {
    const normalized = finite(value, `${channelValue.key}[${index}]`);
    if (channelValue.storage === "float32le") {
      view.setFloat32(index * bytesPerValue, normalized, true);
    } else {
      view.setFloat64(index * bytesPerValue, normalized, true);
    }
  });
  return sha256Hex(bytes);
}

async function canonicalProjection<
  Contract extends
    | typeof APPEARANCE_RECIPE_LOGICAL_PROOF_PROJECTION_CONTRACT
    | typeof APPEARANCE_RECIPE_ABSOLUTE_PROOF_PROJECTION_CONTRACT,
>(
  contract: Contract,
  source: ProofChannel[],
): Promise<
  Contract extends typeof APPEARANCE_RECIPE_LOGICAL_PROOF_PROJECTION_CONTRACT
    ? AppearanceRecipeLogicalProofProjection
    : AppearanceRecipeAbsoluteProofProjection
> {
  const channels: AppearanceRecipeCanonicalProofChannel[] = [];
  for (const entry of sortedChannels([...source], `${contract} projection`)) {
    channels.push({
      key: entry.key,
      kind: entry.kind,
      domain: entry.domain,
      itemSize: entry.itemSize,
      storage: entry.storage,
      valueCount: entry.values.length,
      valuesSha256: await hashNumericValues(entry),
    });
  }
  const inventory = channels.map((entry) => entry.key);
  const content = { contract, inventory, channels };
  const projectionSha256 = await canonicalRecipeSha256(content);
  return {
    ...content,
    projectionSha256,
  } as unknown as Contract extends typeof APPEARANCE_RECIPE_LOGICAL_PROOF_PROJECTION_CONTRACT
    ? AppearanceRecipeLogicalProofProjection
    : AppearanceRecipeAbsoluteProofProjection;
}

export async function projectAppearanceRecipeLogicalProof(
  snapshot: AppearanceRecipePhysicalSnapshot,
): Promise<AppearanceRecipeLogicalProofProjection> {
  return canonicalProjection(
    APPEARANCE_RECIPE_LOGICAL_PROOF_PROJECTION_CONTRACT,
    buildLogicalChannels(snapshot),
  );
}

export async function projectAppearanceRecipeAbsoluteProof(
  evaluation: AppearanceRecipePhysicalEvaluation,
  correspondence: AppearanceRecipePhysicalCorrespondence,
): Promise<AppearanceRecipeAbsoluteProofProjection> {
  return canonicalProjection(
    APPEARANCE_RECIPE_ABSOLUTE_PROOF_PROJECTION_CONTRACT,
    buildAbsoluteChannels(evaluation, correspondence),
  );
}

export function appearanceRecipePhysicalProofKeyInventory(
  input: AppearanceRecipePhysicalProofInput,
): AppearanceRecipePhysicalProofKeyInventory {
  return {
    logicalKeys: buildLogicalChannels(input.logical).map((entry) => entry.key),
    absoluteKeys: buildAbsoluteChannels(
      input.absolute,
      input.correspondence,
    ).map((entry) => entry.key),
  };
}

function assertSameInventory(
  left: ProofChannel[],
  right: ProofChannel[],
  context: string,
): void {
  const leftByKey = new Map(left.map((entry) => [entry.key, entry]));
  const rightByKey = new Map(right.map((entry) => [entry.key, entry]));
  const keys = [...new Set([...leftByKey.keys(), ...rightByKey.keys()])].sort();
  const mismatches: string[] = [];
  const domains = new Set<AppearanceRecipePhysicalMismatchDomain>();
  for (const channelKey of keys) {
    const leftEntry = leftByKey.get(channelKey);
    const rightEntry = rightByKey.get(channelKey);
    const exemplar = leftEntry ?? rightEntry!;
    if (
      !leftEntry ||
      !rightEntry ||
      leftEntry.kind !== rightEntry.kind ||
      leftEntry.domain !== rightEntry.domain ||
      leftEntry.itemSize !== rightEntry.itemSize ||
      leftEntry.storage !== rightEntry.storage ||
      leftEntry.values.length !== rightEntry.values.length
    ) {
      mismatches.push(channelKey);
      domains.add(exemplar.domain);
    }
  }
  if (mismatches.length > 0) {
    throw new AppearanceRecipePhysicalInventoryMismatchError(
      `${context} differs at ${mismatches.slice(0, 3).join(", ")}${
        mismatches.length > 3 ? ` and ${mismatches.length - 3} more` : ""
      }`,
      domains,
    );
  }
}

function neutralChannelValues(
  exemplar: ProofChannel,
  relative: boolean,
): Float32Array | Float64Array {
  const output =
    exemplar.storage === "float32le"
      ? new Float32Array(exemplar.values.length)
      : new Float64Array(exemplar.values.length);
  if (exemplar.kind === "quaternion") {
    for (let offset = 0; offset < output.length; offset += 4) {
      output[offset + 3] = 1;
    }
  } else if (exemplar.kind === "matrix") {
    for (let offset = 0; offset < output.length; offset += 16) {
      output[offset] = 1;
      output[offset + 5] = 1;
      output[offset + 10] = 1;
      output[offset + 15] = 1;
    }
  } else if (exemplar.kind === "scale" && !relative) {
    output.fill(1);
  }
  return output;
}

function exactValuesEqual(
  left: ArrayLike<number>,
  right: ArrayLike<number>,
): boolean {
  return (
    left.length === right.length &&
    Array.from(left).every((value, index) => value === right[index])
  );
}

/**
 * A direct edge may add/remove a logical target or optional follower channel.
 * Its absent side is comparable only when the present side is the exact
 * neutral element. Absolute output inventories never use this policy.
 */
function alignMissingNeutralLogicalChannels(
  left: ProofChannel[],
  right: ProofChannel[],
  context: string,
  relative: boolean,
): { left: ProofChannel[]; right: ProofChannel[] } {
  const leftByKey = new Map(left.map((entry) => [entry.key, entry]));
  const rightByKey = new Map(right.map((entry) => [entry.key, entry]));
  const keys = [...new Set([...leftByKey.keys(), ...rightByKey.keys()])].sort();
  const alignedLeft: ProofChannel[] = [];
  const alignedRight: ProofChannel[] = [];
  const rejected: string[] = [];
  const domains = new Set<AppearanceRecipePhysicalMismatchDomain>();
  for (const channelKey of keys) {
    const leftEntry = leftByKey.get(channelKey);
    const rightEntry = rightByKey.get(channelKey);
    if (leftEntry && rightEntry) {
      alignedLeft.push(leftEntry);
      alignedRight.push(rightEntry);
      continue;
    }
    const exemplar = leftEntry ?? rightEntry!;
    const neutral = neutralChannelValues(exemplar, relative);
    if (!exactValuesEqual(exemplar.values, neutral)) {
      rejected.push(channelKey);
      domains.add(exemplar.domain);
      continue;
    }
    const synthetic: ProofChannel = { ...exemplar, values: neutral };
    alignedLeft.push(leftEntry ?? synthetic);
    alignedRight.push(rightEntry ?? synthetic);
  }
  if (rejected.length > 0) {
    throw new AppearanceRecipePhysicalInventoryMismatchError(
      `${context} has non-neutral one-sided channels: ${rejected.join(", ")}`,
      domains,
    );
  }
  assertSameInventory(alignedLeft, alignedRight, context);
  return {
    left: sortedChannels(alignedLeft, `${context} left`),
    right: sortedChannels(alignedRight, `${context} right`),
  };
}

function selectedChannels(
  channels: ProofChannel[],
  requested: readonly string[] | undefined,
  context: string,
): ProofChannel[] {
  if (requested === undefined) return channels;
  const unique = new Set(requested);
  if (unique.size !== requested.length) fail(`${context} keys must be unique`);
  const byKey = new Map(channels.map((entry) => [entry.key, entry]));
  const selected = [...unique].map((channelKey) => {
    const found = byKey.get(channelKey);
    if (!found) fail(`${context} references unknown key ${channelKey}`);
    return found;
  });
  return sortedChannels(selected, context);
}

function relativeQuaternion(
  baseline: ArrayLike<number>,
  evaluated: ArrayLike<number>,
  context: string,
): Float64Array {
  const base = canonicalQuaternion(baseline, `${context} baseline`);
  const next = canonicalQuaternion(evaluated, `${context} evaluated`);
  const inverse = new THREE.Quaternion(
    -base[0]!,
    -base[1]!,
    -base[2]!,
    base[3]!,
  );
  const relative = inverse.multiply(
    new THREE.Quaternion(...(next as [number, number, number, number])),
  );
  return values(
    canonicalQuaternion(
      [relative.x, relative.y, relative.z, relative.w],
      `${context} relative`,
    ),
    `${context} relative`,
  ) as Float64Array;
}

function relativeMatrix(
  baseline: ArrayLike<number>,
  evaluated: ArrayLike<number>,
  context: string,
): Float64Array {
  if (baseline.length !== 16 || evaluated.length !== 16) {
    fail(`${context} matrices must contain 16 values`);
  }
  const base = new THREE.Matrix4().fromArray(Array.from(baseline));
  const determinant = finite(base.determinant(), `${context} determinant`);
  if (Math.abs(determinant) <= Number.EPSILON) {
    fail(`${context} baseline matrix is singular`);
  }
  const relative = base
    .clone()
    .invert()
    .multiply(new THREE.Matrix4().fromArray(Array.from(evaluated)));
  return values(
    relative.elements,
    `${context} relative matrix`,
  ) as Float64Array;
}

function relativeChannels(
  baseline: ProofChannel[],
  evaluated: ProofChannel[],
  context: string,
): ProofChannel[] {
  assertSameInventory(baseline, evaluated, context);
  const evaluatedByKey = new Map(evaluated.map((entry) => [entry.key, entry]));
  return baseline.map((entry) => {
    const next = evaluatedByKey.get(entry.key)!;
    let output: Float64Array;
    if (entry.kind === "quaternion") {
      output = relativeQuaternion(entry.values, next.values, entry.key);
    } else if (entry.kind === "matrix") {
      output = relativeMatrix(entry.values, next.values, entry.key);
    } else {
      output = new Float64Array(entry.values.length);
      for (let index = 0; index < output.length; index += 1) {
        output[index] = finite(
          next.values[index]! - entry.values[index]!,
          `${entry.key} relative[${index}]`,
        );
      }
    }
    return { ...entry, storage: "float64le", values: output };
  });
}

function buildRelativeProofChannels(
  baseline: AppearanceRecipePhysicalProofInput,
  evaluated: AppearanceRecipePhysicalProofInput,
  selection: AppearanceRecipeRelativeEffectSelection,
): { logical: ProofChannel[]; absolute: ProofChannel[] } {
  const baselineLogical = buildLogicalChannels(baseline.logical);
  const evaluatedLogical = buildLogicalChannels(evaluated.logical);
  const baselineAbsolute = buildAbsoluteChannels(
    baseline.absolute,
    baseline.correspondence,
  );
  const evaluatedAbsolute = buildAbsoluteChannels(
    evaluated.absolute,
    evaluated.correspondence,
  );
  return {
    logical: selectedChannels(
      relativeChannels(baselineLogical, evaluatedLogical, "logical effect"),
      selection.logicalKeys,
      "logical effect selection",
    ),
    absolute: selectedChannels(
      relativeChannels(baselineAbsolute, evaluatedAbsolute, "absolute effect"),
      selection.absoluteKeys,
      "absolute effect selection",
    ),
  };
}

export async function projectAppearanceRecipeRelativeComponentEffect(
  baseline: AppearanceRecipePhysicalProofInput,
  evaluated: AppearanceRecipePhysicalProofInput,
  selection: AppearanceRecipeRelativeEffectSelection = {},
): Promise<AppearanceRecipeRelativeEffectProjection> {
  const relative = buildRelativeProofChannels(baseline, evaluated, selection);
  const logical = await canonicalProjection(
    APPEARANCE_RECIPE_LOGICAL_PROOF_PROJECTION_CONTRACT,
    relative.logical,
  );
  const absolute = await canonicalProjection(
    APPEARANCE_RECIPE_ABSOLUTE_PROOF_PROJECTION_CONTRACT,
    relative.absolute,
  );
  const content = {
    contract: APPEARANCE_RECIPE_RELATIVE_EFFECT_PROJECTION_CONTRACT,
    logical,
    absolute,
  };
  return {
    ...content,
    projectionSha256: await canonicalRecipeSha256(content),
  };
}

type ErrorAccumulator = AppearanceRecipePhysicalProofErrorSummary & {
  positionSquared: number;
  positionCount: number;
  bakedPositionSquared: number;
  bakedPositionCount: number;
};

function emptyErrors(): ErrorAccumulator {
  return {
    scalarMaximum: 0,
    positionMaximumMeters: 0,
    positionRmsMeters: 0,
    scaleMaximum: 0,
    quaternionMaximumRadians: 0,
    matrixMaximum: 0,
    bakedPositionMaximumMeters: 0,
    bakedPositionRmsMeters: 0,
    positionSquared: 0,
    positionCount: 0,
    bakedPositionSquared: 0,
    bakedPositionCount: 0,
  };
}

function quaternionAngularError(
  left: ArrayLike<number>,
  right: ArrayLike<number>,
  context: string,
): number {
  const first = canonicalQuaternion(left, `${context} left`);
  const second = canonicalQuaternion(right, `${context} right`);
  const dot = first.reduce(
    (sum, value, index) => sum + value * second[index]!,
    0,
  );
  const sign = dot < 0 ? -1 : 1;
  let differenceSquared = 0;
  let sumSquared = 0;
  for (let index = 0; index < 4; index += 1) {
    const aligned = sign * second[index]!;
    differenceSquared += (first[index]! - aligned) ** 2;
    sumSquared += (first[index]! + aligned) ** 2;
  }
  return finite(
    2 * Math.atan2(Math.sqrt(differenceSquared), Math.sqrt(sumSquared)),
    `${context} angular error`,
  );
}

function addVectorErrors(
  errors: ErrorAccumulator,
  left: ArrayLike<number>,
  right: ArrayLike<number>,
  itemSize: number,
  baked: boolean,
): number {
  let localMaximum = 0;
  for (let offset = 0; offset < left.length; offset += itemSize) {
    let squared = 0;
    for (let component = 0; component < itemSize; component += 1) {
      squared += (left[offset + component]! - right[offset + component]!) ** 2;
    }
    const distance = finite(Math.sqrt(squared), "physical vector error");
    localMaximum = Math.max(localMaximum, distance);
    if (baked) {
      errors.bakedPositionSquared += squared;
      errors.bakedPositionCount += 1;
    } else {
      errors.positionSquared += squared;
      errors.positionCount += 1;
    }
  }
  if (baked) {
    errors.bakedPositionMaximumMeters = Math.max(
      errors.bakedPositionMaximumMeters,
      localMaximum,
    );
  } else {
    errors.positionMaximumMeters = Math.max(
      errors.positionMaximumMeters,
      localMaximum,
    );
  }
  return localMaximum;
}

function matrixErrors(
  errors: ErrorAccumulator,
  left: ArrayLike<number>,
  right: ArrayLike<number>,
  context: string,
): {
  position: number;
  scale: number;
  quaternion: number;
  matrix: number;
  scalar: number;
} {
  const leftMatrix = new THREE.Matrix4().fromArray(Array.from(left));
  const rightMatrix = new THREE.Matrix4().fromArray(Array.from(right));
  const leftPosition = new THREE.Vector3();
  const rightPosition = new THREE.Vector3();
  const leftRotation = new THREE.Quaternion();
  const rightRotation = new THREE.Quaternion();
  const leftScale = new THREE.Vector3();
  const rightScale = new THREE.Vector3();
  leftMatrix.decompose(leftPosition, leftRotation, leftScale);
  rightMatrix.decompose(rightPosition, rightRotation, rightScale);
  const position = addVectorErrors(
    errors,
    leftPosition.toArray(),
    rightPosition.toArray(),
    3,
    false,
  );
  const scale = Math.max(
    Math.abs(leftScale.x - rightScale.x),
    Math.abs(leftScale.y - rightScale.y),
    Math.abs(leftScale.z - rightScale.z),
  );
  finite(scale, `${context} scale error`);
  errors.scaleMaximum = Math.max(errors.scaleMaximum, scale);
  const quaternion = quaternionAngularError(
    [leftRotation.x, leftRotation.y, leftRotation.z, leftRotation.w],
    [rightRotation.x, rightRotation.y, rightRotation.z, rightRotation.w],
    `${context} rotation`,
  );
  errors.quaternionMaximumRadians = Math.max(
    errors.quaternionMaximumRadians,
    quaternion,
  );
  const linearIndices = [0, 1, 2, 4, 5, 6, 8, 9, 10];
  const matrix = Math.max(
    ...linearIndices.map((index) =>
      Math.abs(leftMatrix.elements[index]! - rightMatrix.elements[index]!),
    ),
  );
  finite(matrix, `${context} matrix error`);
  errors.matrixMaximum = Math.max(errors.matrixMaximum, matrix);
  const affineIndices = [3, 7, 11, 15];
  const scalar = Math.max(
    ...affineIndices.map((index) =>
      Math.abs(leftMatrix.elements[index]! - rightMatrix.elements[index]!),
    ),
  );
  finite(scalar, `${context} affine-row error`);
  errors.scalarMaximum = Math.max(errors.scalarMaximum, scalar);
  return { position, scale, quaternion, matrix, scalar };
}

function compareChannels(
  left: ProofChannel[],
  right: ProofChannel[],
  tolerances: AppearanceRecipePhysicalProofTolerances,
  errors: ErrorAccumulator,
  domains: Set<AppearanceRecipePhysicalMismatchDomain>,
  mismatchChannelKeys: Set<string>,
  context: string,
): void {
  assertSameInventory(left, right, context);
  const rightByKey = new Map(right.map((entry) => [entry.key, entry]));
  for (const entry of left) {
    const target = rightByKey.get(entry.key)!;
    let mismatch = false;
    if (entry.kind === "scalar") {
      let maximum = 0;
      for (let index = 0; index < entry.values.length; index += 1) {
        maximum = Math.max(
          maximum,
          Math.abs(entry.values[index]! - target.values[index]!),
        );
      }
      errors.scalarMaximum = Math.max(errors.scalarMaximum, maximum);
      mismatch = maximum > tolerances.scalar;
    } else if (entry.kind === "position") {
      mismatch =
        addVectorErrors(
          errors,
          entry.values,
          target.values,
          entry.itemSize,
          false,
        ) > tolerances.positionMeters;
    } else if (entry.kind === "baked-position") {
      mismatch =
        addVectorErrors(
          errors,
          entry.values,
          target.values,
          entry.itemSize,
          true,
        ) > tolerances.bakedPositionMeters;
    } else if (entry.kind === "scale") {
      let maximum = 0;
      for (let index = 0; index < entry.values.length; index += 1) {
        maximum = Math.max(
          maximum,
          Math.abs(entry.values[index]! - target.values[index]!),
        );
      }
      errors.scaleMaximum = Math.max(errors.scaleMaximum, maximum);
      mismatch = maximum > tolerances.scale;
    } else if (entry.kind === "quaternion") {
      const angle = quaternionAngularError(
        entry.values,
        target.values,
        entry.key,
      );
      errors.quaternionMaximumRadians = Math.max(
        errors.quaternionMaximumRadians,
        angle,
      );
      mismatch = angle > tolerances.quaternionRadians;
    } else {
      const measured = matrixErrors(
        errors,
        entry.values,
        target.values,
        entry.key,
      );
      mismatch =
        measured.position > tolerances.positionMeters ||
        measured.scale > tolerances.scale ||
        measured.quaternion > tolerances.quaternionRadians ||
        measured.matrix > tolerances.matrix ||
        measured.scalar > tolerances.scalar;
    }
    if (mismatch) {
      domains.add(entry.domain);
      mismatchChannelKeys.add(entry.key);
    }
  }
}

function finishErrors(
  errors: ErrorAccumulator,
): AppearanceRecipePhysicalProofErrorSummary {
  errors.positionRmsMeters =
    errors.positionCount === 0
      ? 0
      : Math.sqrt(errors.positionSquared / errors.positionCount);
  errors.bakedPositionRmsMeters =
    errors.bakedPositionCount === 0
      ? 0
      : Math.sqrt(errors.bakedPositionSquared / errors.bakedPositionCount);
  const {
    positionSquared: _positionSquared,
    positionCount: _positionCount,
    bakedPositionSquared: _bakedPositionSquared,
    bakedPositionCount: _bakedPositionCount,
    ...summary
  } = errors;
  return summary;
}

function comparisonInventory(
  projection:
    | AppearanceRecipeLogicalProofProjection
    | AppearanceRecipeAbsoluteProofProjection,
): Array<{
  key: string;
  kind: ProofChannelKind;
  domain: AppearanceRecipePhysicalMismatchDomain;
  itemSize: number;
  storage: ProofNumericStorage;
  valueCount: number;
}> {
  return projection.channels.map(
    ({ key, kind, domain, itemSize, storage, valueCount }) => ({
      key,
      kind,
      domain,
      itemSize,
      storage,
      valueCount,
    }),
  );
}

function validateTolerances(
  value: AppearanceRecipePhysicalProofTolerances,
): AppearanceRecipePhysicalProofTolerances {
  for (const [name, tolerance] of Object.entries(value)) {
    if (!Number.isFinite(tolerance) || tolerance <= 0) {
      fail(`${name} tolerance must be positive and finite`);
    }
  }
  return value;
}

export async function compareAppearanceRecipePhysicalProof(
  source: AppearanceRecipePhysicalProofInput,
  target: AppearanceRecipePhysicalProofInput,
  toleranceValue: AppearanceRecipePhysicalProofTolerances = APPEARANCE_RECIPE_PHYSICAL_PROOF_TOLERANCES,
): Promise<AppearanceRecipePhysicalProofComparison> {
  const tolerances = validateTolerances(toleranceValue);
  const alignedLogical = alignMissingNeutralLogicalChannels(
    buildLogicalChannels(source.logical),
    buildLogicalChannels(target.logical),
    "logical proof",
    false,
  );
  const sourceLogical = alignedLogical.left;
  const targetLogical = alignedLogical.right;
  const sourceAbsolute = buildAbsoluteChannels(
    source.absolute,
    source.correspondence,
  );
  const targetAbsolute = buildAbsoluteChannels(
    target.absolute,
    target.correspondence,
  );
  const errors = emptyErrors();
  const mismatchDomains = new Set<AppearanceRecipePhysicalMismatchDomain>();
  const mismatchChannelKeys = new Set<string>();
  compareChannels(
    sourceLogical,
    targetLogical,
    tolerances,
    errors,
    mismatchDomains,
    mismatchChannelKeys,
    "logical proof",
  );
  compareChannels(
    sourceAbsolute,
    targetAbsolute,
    tolerances,
    errors,
    mismatchDomains,
    mismatchChannelKeys,
    "absolute proof",
  );
  const sourceLogicalProjection = await canonicalProjection(
    APPEARANCE_RECIPE_LOGICAL_PROOF_PROJECTION_CONTRACT,
    sourceLogical,
  );
  const targetLogicalProjection = await canonicalProjection(
    APPEARANCE_RECIPE_LOGICAL_PROOF_PROJECTION_CONTRACT,
    targetLogical,
  );
  const sourceAbsoluteProjection = await canonicalProjection(
    APPEARANCE_RECIPE_ABSOLUTE_PROOF_PROJECTION_CONTRACT,
    sourceAbsolute,
  );
  const targetAbsoluteProjection = await canonicalProjection(
    APPEARANCE_RECIPE_ABSOLUTE_PROOF_PROJECTION_CONTRACT,
    targetAbsolute,
  );
  return {
    matches: mismatchDomains.size === 0,
    errors: finishErrors(errors),
    mismatchDomains: [...mismatchDomains].sort(),
    mismatchChannelKeys: [...mismatchChannelKeys].sort(),
    sourceLogicalOutputSha256: sourceLogicalProjection.projectionSha256,
    targetLogicalOutputSha256: targetLogicalProjection.projectionSha256,
    sourceAbsoluteOutputSha256: sourceAbsoluteProjection.projectionSha256,
    targetAbsoluteOutputSha256: targetAbsoluteProjection.projectionSha256,
    comparedLogicalKeysSha256: await canonicalRecipeSha256(
      comparisonInventory(sourceLogicalProjection),
    ),
    comparedAbsoluteKeysSha256: await canonicalRecipeSha256(
      comparisonInventory(sourceAbsoluteProjection),
    ),
  };
}

/**
 * Compare the neutral-relative effect of one component across two packages.
 * Each package first subtracts/relativizes its own neutral, then the resulting
 * effect vectors are compared with the same strict physical metrics as the
 * whole-Recipe proof. One-sided logical channels are admitted only when their
 * present relative effect is the exact neutral element; absolute inventories
 * remain exact and exhaustive.
 */
export async function compareAppearanceRecipeRelativeComponentEffects(
  sourceBaseline: AppearanceRecipePhysicalProofInput,
  sourceEvaluated: AppearanceRecipePhysicalProofInput,
  targetBaseline: AppearanceRecipePhysicalProofInput,
  targetEvaluated: AppearanceRecipePhysicalProofInput,
  selection: AppearanceRecipeRelativeEffectSelection = {},
  toleranceValue: AppearanceRecipePhysicalProofTolerances = APPEARANCE_RECIPE_PHYSICAL_PROOF_TOLERANCES,
): Promise<AppearanceRecipeRelativeComponentEffectComparison> {
  const tolerances = validateTolerances(toleranceValue);
  const source = buildRelativeProofChannels(
    sourceBaseline,
    sourceEvaluated,
    selection,
  );
  const target = buildRelativeProofChannels(
    targetBaseline,
    targetEvaluated,
    selection,
  );
  const alignedLogical = alignMissingNeutralLogicalChannels(
    source.logical,
    target.logical,
    "relative logical effect proof",
    true,
  );
  source.logical = alignedLogical.left;
  target.logical = alignedLogical.right;
  const errors = emptyErrors();
  const mismatchDomains = new Set<AppearanceRecipePhysicalMismatchDomain>();
  const mismatchChannelKeys = new Set<string>();
  compareChannels(
    source.logical,
    target.logical,
    tolerances,
    errors,
    mismatchDomains,
    mismatchChannelKeys,
    "relative logical effect proof",
  );
  compareChannels(
    source.absolute,
    target.absolute,
    tolerances,
    errors,
    mismatchDomains,
    mismatchChannelKeys,
    "relative absolute effect proof",
  );
  const sourceLogical = await canonicalProjection(
    APPEARANCE_RECIPE_LOGICAL_PROOF_PROJECTION_CONTRACT,
    source.logical,
  );
  const targetLogical = await canonicalProjection(
    APPEARANCE_RECIPE_LOGICAL_PROOF_PROJECTION_CONTRACT,
    target.logical,
  );
  const sourceAbsolute = await canonicalProjection(
    APPEARANCE_RECIPE_ABSOLUTE_PROOF_PROJECTION_CONTRACT,
    source.absolute,
  );
  const targetAbsolute = await canonicalProjection(
    APPEARANCE_RECIPE_ABSOLUTE_PROOF_PROJECTION_CONTRACT,
    target.absolute,
  );
  return {
    matches: mismatchDomains.size === 0,
    errors: finishErrors(errors),
    mismatchDomains: [...mismatchDomains].sort(),
    mismatchChannelKeys: [...mismatchChannelKeys].sort(),
    sourceLogicalEffectSha256: sourceLogical.projectionSha256,
    targetLogicalEffectSha256: targetLogical.projectionSha256,
    sourceAbsoluteEffectSha256: sourceAbsolute.projectionSha256,
    targetAbsoluteEffectSha256: targetAbsolute.projectionSha256,
    comparedLogicalKeysSha256: await canonicalRecipeSha256(
      comparisonInventory(sourceLogical),
    ),
    comparedAbsoluteKeysSha256: await canonicalRecipeSha256(
      comparisonInventory(sourceAbsolute),
    ),
  };
}
