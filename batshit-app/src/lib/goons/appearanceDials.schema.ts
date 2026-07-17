import {
  APPEARANCE_DIALS_CONTRACT,
  type AppearanceDialsManifest,
  type AppearanceFollowerDeclaration,
  type AppearanceJointFollow,
  type AppearanceTargetDefinition,
} from "./appearanceDials.contracts";
import {
  collectMappedFaceMorphNames,
  parseFitEvidence,
  parseFollowers,
  parseJointFollow,
  parseNodes,
  parseProductResolution,
  parseTargets,
} from "./appearanceDials.schemaAssets";
import {
  parseDials,
  parseMacroEngine,
  parseRegions,
  validateOwnership,
} from "./appearanceDials.schemaControls";
import {
  ZERO_TOLERANCE,
  hasOwn,
  isIdentityQuat,
  isIdentityScale,
  isRecord,
  isSha256,
  isStableId,
  isZeroVec3,
} from "./appearanceDials.validation";
import { resolveAppearanceDialState } from "./appearanceDials.values";

function validateRequirements(
  targets: Record<string, AppearanceTargetDefinition>,
  dials: AppearanceDialsManifest["dials"],
  jointFollow: AppearanceJointFollow | undefined,
  followers: Record<string, AppearanceFollowerDeclaration>,
) {
  const driverKey = (kind: "dial" | "target", id: string) => kind + ":" + id;
  const requirements = new Map<string, string[]>();
  const targetOwners = new Map<string, Set<string>>();
  const registerDial = (
    id: string,
    followerRefs: string[] | undefined,
    members: Array<{ target: string }>,
  ) => {
    requirements.set(driverKey("dial", id), followerRefs ?? []);
    for (const member of members) {
      const owners = targetOwners.get(member.target) ?? new Set<string>();
      owners.add(id);
      targetOwners.set(member.target, owners);
    }
  };
  for (const dial of dials) {
    registerDial(dial.id, dial.requirements?.followerRefs, dial.members ?? []);
    if (dial.symmetry?.mode === "linked-with-offsets") {
      registerDial(
        dial.symmetry.left.id,
        dial.symmetry.left.requirements?.followerRefs,
        dial.symmetry.left.members,
      );
      registerDial(
        dial.symmetry.right.id,
        dial.symmetry.right.requirements?.followerRefs,
        dial.symmetry.right.members,
      );
    }
  }
  const jointTargetIds = new Set(Object.keys(jointFollow?.deltas ?? {}));
  for (const [targetId, target] of Object.entries(targets)) {
    const requiresJoint = target.requirements?.jointFollow === true;
    const followerRefs = target.requirements?.followerRefs ?? [];
    requirements.set(driverKey("target", targetId), followerRefs);
    if (requiresJoint !== jointTargetIds.has(targetId)) {
      throw new Error(
        "appearance target " +
          targetId +
          " has inconsistent joint-follow ownership",
      );
    }
    for (const followerRef of followerRefs) {
      if (!hasOwn(followers, followerRef)) {
        throw new Error(
          "appearance target " +
            targetId +
            " requires missing follower " +
            followerRef,
        );
      }
      if (
        !followers[followerRef].drivers.some(
          (entry) =>
            entry.driver.kind === "target" && entry.driver.id === targetId,
        )
      ) {
        throw new Error(
          "appearance target " +
            targetId +
            " has no executable driver in follower " +
            followerRef,
        );
      }
    }
    const ownedDialFollower = [...(targetOwners.get(targetId) ?? [])].some(
      (dialId) =>
        (requirements.get(driverKey("dial", dialId)) ?? []).length > 0,
    );
    if (
      target.impact === "structural" &&
      !requiresJoint &&
      followerRefs.length === 0 &&
      !ownedDialFollower
    ) {
      throw new Error(
        "structural appearance target " +
          targetId +
          " declares no joint or node follower",
      );
    }
  }
  for (const [followerId, follower] of Object.entries(followers)) {
    for (const entry of follower.drivers) {
      const key = driverKey(entry.driver.kind, entry.driver.id);
      if (!(requirements.get(key) ?? []).includes(followerId)) {
        throw new Error(
          "appearance follower " +
            followerId +
            " has an unclaimed driver for " +
            key,
        );
      }
    }
  }
  for (const [key, followerRefs] of requirements) {
    const separator = key.indexOf(":");
    const kind = key.slice(0, separator) as "dial" | "target";
    const id = key.slice(separator + 1);
    for (const followerRef of followerRefs) {
      if (!hasOwn(followers, followerRef)) {
        throw new Error(
          "appearance driver " +
            key +
            " requires missing follower " +
            followerRef,
        );
      }
      if (
        !followers[followerRef].drivers.some(
          (entry) => entry.driver.kind === kind && entry.driver.id === id,
        )
      ) {
        throw new Error(
          "appearance driver " +
            key +
            " has no executable declaration in follower " +
            followerRef,
        );
      }
    }
  }
}

function validatePoseCorrectiveUsage(
  manifest: Record<string, unknown>,
  targets: Record<string, AppearanceTargetDefinition>,
) {
  const poseTargets = new Set(
    Object.entries(targets)
      .filter(([, target]) => target.usages.includes("pose-corrective"))
      .map(([id]) => id),
  );
  const rig = isRecord(manifest.rig) ? manifest.rig : null;
  const correctives = rig && isRecord(rig.correctives) ? rig.correctives : null;
  const entries = correctives?.entries;
  if (
    entries === undefined ||
    (Array.isArray(entries) && entries.length === 0)
  ) {
    if (poseTargets.size > 0) {
      throw new Error(
        "pose-corrective appearance targets have no rig.correctives ownership",
      );
    }
    return;
  }
  if (!Array.isArray(entries)) {
    throw new Error("avatar.json#rig.correctives entries is not an array");
  }
  const referenced = new Set<string>();
  for (const entry of entries) {
    if (!isRecord(entry)) {
      throw new Error(
        "avatar.json#rig.correctives contains a malformed target reference",
      );
    }
    const targetId = isStableId(entry.target)
      ? entry.target
      : isStableId(entry.key)
        ? entry.key
        : null;
    if (!targetId || !hasOwn(targets, targetId)) {
      throw new Error(
        "rig.correctives references unknown appearance target " +
          String(targetId),
      );
    }
    if (!targets[targetId].usages.includes("pose-corrective")) {
      throw new Error(
        "rig.correctives target " + targetId + " lacks pose-corrective usage",
      );
    }
    referenced.add(targetId);
  }
  for (const targetId of poseTargets) {
    if (!referenced.has(targetId)) {
      throw new Error(
        "pose-corrective appearance target " +
          targetId +
          " is not driver-owned",
      );
    }
  }
}

/**
 * Parse avatar.json#appearanceDials. Missing means unsupported; a present
 * invalid block fails loudly. v1/v2 coexistence is forbidden at this boundary.
 */
export function parseAppearanceDialsManifest(
  manifest: unknown,
): AppearanceDialsManifest | null {
  if (!isRecord(manifest)) return null;
  const raw = manifest.appearanceDials;
  if (raw === undefined || raw === null) return null;
  if (manifest.dials !== undefined && manifest.dials !== null) {
    throw new Error(
      "avatar.json may not contain body-dials/v1 and appearance-dials/v2 together",
    );
  }
  if (!isRecord(raw)) {
    throw new Error("avatar.json#appearanceDials is not an object");
  }
  if (raw.contract !== APPEARANCE_DIALS_CONTRACT) {
    throw new Error(
      "avatar.json#appearanceDials contract " +
        String(raw.contract) +
        " is not " +
        APPEARANCE_DIALS_CONTRACT,
    );
  }
  if (
    raw.jointDeltas !== undefined ||
    raw.hipsClipRemap !== undefined ||
    raw.meshes !== undefined
  ) {
    throw new Error(
      "appearance-dials/v2 contains retired unversioned joint/remap fields",
    );
  }
  if (!isSha256(raw.definitionSha256)) {
    throw new Error(
      "avatar.json#appearanceDials has a malformed definition hash",
    );
  }
  if (
    !isRecord(raw.neutral) ||
    !isStableId(raw.neutral.id) ||
    !isSha256(raw.neutral.recipeSha256)
  ) {
    throw new Error(
      "avatar.json#appearanceDials has a malformed neutral identity",
    );
  }

  const productResolution = parseProductResolution(raw.productResolution);
  const fitEvidence = parseFitEvidence(raw.fitEvidence, raw.definitionSha256);
  const nodes = parseNodes(raw.nodes);
  const mappedFaceMorphNames = collectMappedFaceMorphNames(manifest);
  const targets = parseTargets(raw.targets, nodes, mappedFaceMorphNames);
  const regions = parseRegions(raw.regions);
  const jointFollow = parseJointFollow(raw.jointFollow, targets);
  const macroEngine = parseMacroEngine(raw.macroEngine, targets);
  const dials = parseDials(raw.dials, regions, targets, macroEngine);
  const followers = parseFollowers(raw.followers, nodes, targets, dials);

  validateOwnership(dials, targets, macroEngine);
  validateRequirements(targets, dials, jointFollow, followers);
  validatePoseCorrectiveUsage(manifest, targets);

  const parsed: AppearanceDialsManifest = {
    contract: APPEARANCE_DIALS_CONTRACT,
    definitionSha256: raw.definitionSha256.toLowerCase(),
    neutral: {
      id: raw.neutral.id,
      recipeSha256: raw.neutral.recipeSha256.toLowerCase(),
    },
    productResolution,
    fitEvidence,
    mappedFaceMorphNames: [...mappedFaceMorphNames].sort(),
    nodes,
    regions,
    dials,
    targets,
    ...(macroEngine ? { macroEngine } : {}),
    ...(jointFollow ? { jointFollow } : {}),
    followers,
  };

  const neutral = resolveAppearanceDialState(parsed, null);
  if (
    [...neutral.influences.values()].some(
      (value) => Math.abs(value) > ZERO_TOLERANCE,
    ) ||
    [...neutral.jointOffsets.values()].some((value) => !isZeroVec3(value)) ||
    [...neutral.followerInputs.values()].some((inputs) =>
      [...inputs.values()].some((value) => Math.abs(value) > ZERO_TOLERANCE),
    ) ||
    neutral.followerState.nodeTransforms.some(
      (entry) =>
        !isZeroVec3(entry.translation) ||
        !isIdentityQuat(entry.rotation) ||
        !isIdentityScale(entry.scale),
    ) ||
    neutral.followerState.morphs.some(
      (entry) => Math.abs(entry.weight) > ZERO_TOLERANCE,
    ) ||
    Math.abs(neutral.rootScale - 1) > ZERO_TOLERANCE ||
    Math.abs(neutral.soleOffsetY) > ZERO_TOLERANCE
  ) {
    throw new Error(
      "appearance-dials/v2 does not resolve to the declared neutral at zero",
    );
  }
  return parsed;
}
