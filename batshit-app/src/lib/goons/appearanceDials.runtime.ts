import type {
  AppearanceDialsManifest,
  AppearanceRecipeBakeInventory,
  AppearanceRuntimeInventory,
  AppearanceRuntimeNode,
  ValidatedAppearanceRuntimeBinding,
  ValidatedAppearanceRuntimeInventory,
} from "./appearanceDials.contracts";
import {
  ZERO_TOLERANCE,
  isFiniteNumber,
  isNonEmptyString,
  isPositiveVec3,
  normalizeFaceMorphCollisionName,
} from "./appearanceDials.validation";
import { sanitizeCustomRuntimeNodeName } from "./customRuntimeNames";

export function getAppearanceRecipeBakeInventory(
  manifest: AppearanceDialsManifest,
): AppearanceRecipeBakeInventory {
  const bakeAndRemoveTargetIds: string[] = [];
  const retainInLiveGoonTargetIds: string[] = [];
  for (const [targetId, target] of Object.entries(manifest.targets)) {
    if (target.runtimeRetention === "retain-in-live-goon") {
      retainInLiveGoonTargetIds.push(targetId);
    } else {
      bakeAndRemoveTargetIds.push(targetId);
    }
  }
  const bakeAndRemoveFollowerMorphs: AppearanceRecipeBakeInventory["bakeAndRemoveFollowerMorphs"] =
    [];
  const bakeFollowerNodeTransforms: AppearanceRecipeBakeInventory["bakeFollowerNodeTransforms"] =
    [];
  for (const [followerId, follower] of Object.entries(manifest.followers)) {
    for (const entry of follower.drivers) {
      for (const channel of entry.channels) {
        if (channel.kind === "morph-weight") {
          bakeAndRemoveFollowerMorphs.push({
            follower: followerId,
            channel: channel.id,
            node: channel.node,
            morph: channel.morph,
          });
        } else {
          bakeFollowerNodeTransforms.push({
            follower: followerId,
            channel: channel.id,
            node: channel.node,
          });
        }
      }
    }
  }
  bakeAndRemoveTargetIds.sort();
  retainInLiveGoonTargetIds.sort();
  bakeAndRemoveFollowerMorphs.sort((left, right) =>
    (left.follower + "\u0000" + left.channel).localeCompare(
      right.follower + "\u0000" + right.channel,
    ),
  );
  bakeFollowerNodeTransforms.sort((left, right) =>
    (left.follower + "\u0000" + left.channel).localeCompare(
      right.follower + "\u0000" + right.channel,
    ),
  );
  return {
    bakeAndRemoveTargetIds,
    retainInLiveGoonTargetIds,
    bakeAndRemoveFollowerMorphs,
    bakeFollowerNodeTransforms,
    bakeJointRestTargetIds: Object.keys(
      manifest.jointFollow?.deltas ?? {},
    ).sort(),
    preserveDynamicFaceMorphNames: [...manifest.mappedFaceMorphNames].sort(),
  };
}

function runtimeBindingKey(runtimeNodeId: string, index: number): string {
  return runtimeNodeId + "\u0000" + index;
}

function isUniformScale(scale: [number, number, number]): boolean {
  return (
    Math.abs(scale[0] - scale[1]) <= ZERO_TOLERANCE &&
    Math.abs(scale[0] - scale[2]) <= ZERO_TOLERANCE
  );
}

function requireRuntimeMorph(
  runtimeNode: AppearanceRuntimeNode,
  morphName: string,
  context: string,
) {
  const matches = runtimeNode.morphs.filter(
    (morph) => morph.name === morphName,
  );
  if (matches.length !== 1) {
    throw new Error(context + " expected one exact runtime morph " + morphName);
  }
  const morph = matches[0];
  if (Math.abs(morph.initialWeight) > ZERO_TOLERANCE) {
    throw new Error(context + " runtime morph is not rebased to zero");
  }
  return morph;
}

export function validateAppearanceRuntimeInventory(
  manifest: AppearanceDialsManifest,
  inventory: AppearanceRuntimeInventory,
): ValidatedAppearanceRuntimeInventory {
  if (!Array.isArray(inventory.nodes)) {
    throw new Error("appearance runtime inventory nodes are malformed");
  }
  if (
    !Array.isArray(manifest.mappedFaceMorphNames) ||
    !manifest.mappedFaceMorphNames.every(isNonEmptyString) ||
    new Set(manifest.mappedFaceMorphNames).size !==
      manifest.mappedFaceMorphNames.length
  ) {
    throw new Error("appearance mapped face morph evidence is malformed");
  }
  if (!Array.isArray(inventory.faceBindings)) {
    throw new Error("appearance runtime face binding evidence is required");
  }

  const byRuntimeId = new Map<string, AppearanceRuntimeNode>();
  const byNode = new Map<string, AppearanceRuntimeNode[]>();
  for (const node of inventory.nodes) {
    if (
      !isNonEmptyString(node.runtimeId) ||
      !isNonEmptyString(node.node) ||
      (node.kind !== "mesh" && node.kind !== "anchor") ||
      !isPositiveVec3(node.localScale) ||
      !Array.isArray(node.morphs)
    ) {
      throw new Error("appearance runtime inventory contains a malformed node");
    }
    if (byRuntimeId.has(node.runtimeId)) {
      throw new Error(
        "appearance runtime node id " + node.runtimeId + " is duplicated",
      );
    }
    if (node.kind === "anchor" && node.morphs.length > 0) {
      throw new Error(
        "appearance runtime anchor " + node.runtimeId + " carries morphs",
      );
    }
    const names = new Set<string>();
    const indices = new Set<number>();
    for (const morph of node.morphs) {
      if (
        !isNonEmptyString(morph.name) ||
        !Number.isInteger(morph.index) ||
        morph.index < 0 ||
        !isFiniteNumber(morph.initialWeight) ||
        names.has(morph.name) ||
        indices.has(morph.index)
      ) {
        throw new Error(
          "appearance runtime node " + node.runtimeId + " has malformed morphs",
        );
      }
      names.add(morph.name);
      indices.add(morph.index);
    }
    byRuntimeId.set(node.runtimeId, node);
    const matches = byNode.get(node.node) ?? [];
    matches.push(node);
    byNode.set(node.node, matches);
  }

  const runtimeByManifestNode = new Map<string, AppearanceRuntimeNode>();
  for (const [nodeId, declaration] of Object.entries(manifest.nodes)) {
    const matches = byNode.get(declaration.node) ?? [];
    if (matches.length === 0 && !declaration.required) continue;
    if (matches.length !== declaration.exactNodeMatches) {
      throw new Error(
        "appearance node " +
          nodeId +
          " expected exactly " +
          declaration.exactNodeMatches +
          " runtime node match, got " +
          matches.length,
      );
    }
    const runtimeNode = matches[0];
    if (runtimeNode.kind !== declaration.kind) {
      throw new Error(
        "appearance node " + nodeId + " has the wrong runtime kind",
      );
    }
    if (
      declaration.scalePolicy === "uniform-only" &&
      !isUniformScale(runtimeNode.localScale)
    ) {
      throw new Error(
        "appearance node " + nodeId + " violates uniform-only scale",
      );
    }
    runtimeByManifestNode.set(nodeId, runtimeNode);
  }

  for (const [nodeId, declaration] of Object.entries(manifest.nodes)) {
    const runtimeNode = runtimeByManifestNode.get(nodeId);
    if (!runtimeNode || !declaration.parent) continue;
    if (declaration.parent.kind === "bone") {
      const sourceBoneName = declaration.parent.name;
      const runtimeBoneNames = new Set([
        sourceBoneName,
        sanitizeCustomRuntimeNodeName(sourceBoneName),
      ]);
      if (
        !runtimeNode.parentBone ||
        !runtimeBoneNames.has(runtimeNode.parentBone)
      ) {
        throw new Error(
          "appearance node " + nodeId + " has the wrong runtime bone parent",
        );
      }
    } else {
      const parent = runtimeByManifestNode.get(declaration.parent.id);
      if (!parent || runtimeNode.parentRuntimeId !== parent.runtimeId) {
        throw new Error(
          "appearance node " + nodeId + " has the wrong runtime node parent",
        );
      }
    }
  }

  const bindings: ValidatedAppearanceRuntimeBinding[] = [];
  const followerMorphBindings: ValidatedAppearanceRuntimeInventory["followerMorphBindings"] =
    [];
  const ownedRuntimeKeys = new Set<string>();
  const claim = (
    runtimeNode: AppearanceRuntimeNode,
    index: number,
    context: string,
  ) => {
    const key = runtimeBindingKey(runtimeNode.runtimeId, index);
    if (ownedRuntimeKeys.has(key)) {
      throw new Error(
        "appearance runtime morph index has multiple owners: " + context,
      );
    }
    ownedRuntimeKeys.add(key);
  };

  for (const [targetId, target] of Object.entries(manifest.targets)) {
    for (const binding of target.bindings) {
      const runtimeNode = runtimeByManifestNode.get(binding.node);
      if (!runtimeNode) {
        throw new Error(
          "appearance target " +
            targetId +
            " has no runtime node " +
            binding.node,
        );
      }
      const morph = requireRuntimeMorph(
        runtimeNode,
        binding.morph,
        "appearance target " + targetId,
      );
      claim(runtimeNode, morph.index, "target " + targetId);
      bindings.push({
        target: targetId,
        node: binding.node,
        runtimeNodeId: runtimeNode.runtimeId,
        morph: morph.name,
        index: morph.index,
      });
    }
  }

  for (const [followerId, follower] of Object.entries(manifest.followers)) {
    for (const entry of follower.drivers) {
      for (const channel of entry.channels) {
        if (channel.kind !== "morph-weight") continue;
        const runtimeNode = runtimeByManifestNode.get(channel.node);
        if (!runtimeNode) {
          if (!manifest.nodes[channel.node].required) continue;
          throw new Error(
            "appearance follower " +
              followerId +
              " has no runtime node " +
              channel.node,
          );
        }
        const morph = requireRuntimeMorph(
          runtimeNode,
          channel.morph,
          "appearance follower " + followerId + "/" + channel.id,
        );
        claim(
          runtimeNode,
          morph.index,
          "follower " + followerId + "/" + channel.id,
        );
        followerMorphBindings.push({
          follower: followerId,
          channel: channel.id,
          node: channel.node,
          runtimeNodeId: runtimeNode.runtimeId,
          morph: morph.name,
          index: morph.index,
        });
      }
    }
  }

  const expectedFaceMorphs = new Set(manifest.mappedFaceMorphNames);
  const evidencedFaceMorphs = new Set<string>();
  const seenFaceBindingKeys = new Set<string>();
  for (const faceBinding of inventory.faceBindings) {
    const runtimeNode = byRuntimeId.get(faceBinding.runtimeNodeId);
    if (!runtimeNode || !isNonEmptyString(faceBinding.morph)) {
      throw new Error("appearance runtime face binding is malformed");
    }
    const canonicalMorph = normalizeFaceMorphCollisionName(faceBinding.morph);
    const evidenceKey = faceBinding.runtimeNodeId + "\u0000" + canonicalMorph;
    if (seenFaceBindingKeys.has(evidenceKey)) {
      throw new Error(
        "appearance runtime face binding evidence repeats " +
          canonicalMorph +
          " on " +
          faceBinding.runtimeNodeId,
      );
    }
    seenFaceBindingKeys.add(evidenceKey);
    evidencedFaceMorphs.add(canonicalMorph);
    const matches = runtimeNode.morphs.filter(
      (morph) =>
        morph.name === faceBinding.morph ||
        normalizeFaceMorphCollisionName(morph.name) === canonicalMorph,
    );
    if (matches.length !== 1) {
      throw new Error(
        "appearance runtime face binding " +
          canonicalMorph +
          " is missing or ambiguous",
      );
    }
    const key = runtimeBindingKey(runtimeNode.runtimeId, matches[0].index);
    if (ownedRuntimeKeys.has(key)) {
      throw new Error(
        "appearance identity/follower target collides with normalized face morph " +
          canonicalMorph,
      );
    }
  }
  for (const expectedMorph of expectedFaceMorphs) {
    if (!evidencedFaceMorphs.has(expectedMorph)) {
      throw new Error(
        "appearance runtime face binding evidence is incomplete; missing " +
          expectedMorph,
      );
    }
  }

  return {
    bindings,
    followerMorphBindings,
    ownedRuntimeKeys,
    runtimeNodeIdsByManifestNode: new Map(
      [...runtimeByManifestNode].map(([nodeId, node]) => [
        nodeId,
        node.runtimeId,
      ]),
    ),
  };
}

export function getAppearanceTargetBindings(
  manifest: AppearanceDialsManifest,
): Array<{ target: string; node: string; morph: string }> {
  return Object.entries(manifest.targets).flatMap(([target, definition]) =>
    definition.bindings.map((binding) => ({
      target,
      node: binding.node,
      morph: binding.morph,
    })),
  );
}
