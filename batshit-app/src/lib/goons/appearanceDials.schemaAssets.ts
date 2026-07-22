import {
  APPEARANCE_CLIP_REMAP_CONTRACT,
  APPEARANCE_FIT_EVIDENCE_CONTRACT,
  APPEARANCE_FOLLOWER_CONTRACT,
  APPEARANCE_JOINT_FOLLOW_CONTRACT,
  APPEARANCE_PRODUCT_RESOLUTION_CONTRACT,
  type AppearanceDialDefinition,
  type AppearanceDialNode,
  type AppearanceFitEvidence,
  type AppearanceFollowerChannel,
  type AppearanceFollowerDeclaration,
  type AppearanceFollowerDriver,
  type AppearanceFollowerDriverRef,
  type AppearanceFollowerMorphChannel,
  type AppearanceFollowerNodeTransformChannel,
  type AppearanceFollowerSample,
  type AppearanceJointFollow,
  type AppearanceProductResolution,
  type AppearanceTargetBinding,
  type AppearanceTargetDefinition,
  type AppearanceTargetLicense,
  type AppearanceTargetRequirements,
  type AppearanceTargetUsage,
  type AppearanceVec3,
} from "./appearanceDials.contracts";
import {
  ALLOWED_LICENSES,
  ALLOWED_USAGES,
  ZERO_TOLERANCE,
  assertNoForbiddenPaths,
  createRecord,
  evaluateAppearanceDialTrack,
  hasOwn,
  isFiniteNumber,
  isIdentityQuat,
  isIdentityScale,
  isNonEmptyString,
  isPositiveVec3,
  isQuat,
  isRange,
  isRecord,
  isSha256,
  isStableId,
  isTrack,
  isVec3,
  isZeroVec3,
  normalizeFaceMorphCollisionName,
} from "./appearanceDials.validation";

const ALLOWED_NODE_ROLES = new Set<AppearanceDialNode["role"]>([
  "body",
  "face",
  "generic-follower",
  "socket-eye-composite-cap",
  "brow-canvas",
  "eye-treatment-canvas",
  "teeth-upper",
  "gums-upper",
  "teeth-lower",
  "gums-lower",
  "tongue",
  "attachment-anchor",
]);

const EYE_NODE_ROLES = new Set<AppearanceDialNode["role"]>([
  "socket-eye-composite-cap",
]);

function parseApprovedProvenance(
  value: unknown,
  context: string,
  firstPartyOnly = false,
) {
  if (!isRecord(value)) {
    throw new Error(context + " is missing provenance");
  }
  assertNoForbiddenPaths(value, context + " provenance");
  if (
    !isStableId(value.catalogId) ||
    !isStableId(value.componentId) ||
    !isNonEmptyString(value.license) ||
    !ALLOWED_LICENSES.has(value.license as AppearanceTargetLicense) ||
    (firstPartyOnly && value.license !== "LicenseRef-Batshit-First-Party") ||
    value.reviewStatus !== "approved" ||
    !isSha256(value.contentSha256) ||
    (value.containerSha256 !== undefined && !isSha256(value.containerSha256)) ||
    (value.archiveSha256 !== undefined && !isSha256(value.archiveSha256))
  ) {
    throw new Error(context + " has ineligible provenance");
  }
  return {
    catalogId: value.catalogId,
    componentId: value.componentId,
    license: value.license as AppearanceTargetLicense,
    reviewStatus: "approved" as const,
    contentSha256: value.contentSha256.toLowerCase(),
    ...(value.containerSha256
      ? { containerSha256: value.containerSha256.toLowerCase() }
      : {}),
    ...(value.archiveSha256
      ? { archiveSha256: value.archiveSha256.toLowerCase() }
      : {}),
  };
}

export function parseProductResolution(
  value: unknown,
): AppearanceProductResolution {
  if (!isRecord(value)) {
    throw new Error("avatar.json#appearanceDials is missing productResolution");
  }
  assertNoForbiddenPaths(value, "appearance productResolution");
  if (value.archiveSha256 !== undefined) {
    throw new Error(
      "appearance productResolution archiveSha256 is ambiguous; archive hashes belong to target provenance",
    );
  }
  if (
    value.contract !== APPEARANCE_PRODUCT_RESOLUTION_CONTRACT ||
    !isSha256(value.catalogSha256) ||
    !isSha256(value.policySha256) ||
    !isSha256(value.resolutionSha256)
  ) {
    throw new Error(
      "avatar.json#appearanceDials productResolution is malformed",
    );
  }
  return {
    contract: APPEARANCE_PRODUCT_RESOLUTION_CONTRACT,
    catalogSha256: value.catalogSha256.toLowerCase(),
    policySha256: value.policySha256.toLowerCase(),
    resolutionSha256: value.resolutionSha256.toLowerCase(),
  };
}

export function parseFitEvidence(
  value: unknown,
  definitionSha256: string,
): AppearanceFitEvidence {
  if (
    !isRecord(value) ||
    value.contract !== APPEARANCE_FIT_EVIDENCE_CONTRACT ||
    !isSha256(value.definitionSha256) ||
    value.definitionSha256.toLowerCase() !== definitionSha256.toLowerCase() ||
    !isSha256(value.modelSha256) ||
    !isSha256(value.scenarioSetSha256) ||
    !isSha256(value.eyeReportSha256) ||
    !isSha256(value.oralReportSha256) ||
    !isSha256(value.facialArtworkDefinitionSha256) ||
    !isSha256(value.facialArtworkContractFileSha256) ||
    !isSha256(value.facialArtworkProofSha256)
  ) {
    throw new Error(
      "avatar.json#appearanceDials fitEvidence is malformed or stale",
    );
  }
  return {
    contract: APPEARANCE_FIT_EVIDENCE_CONTRACT,
    definitionSha256: value.definitionSha256.toLowerCase(),
    modelSha256: value.modelSha256.toLowerCase(),
    scenarioSetSha256: value.scenarioSetSha256.toLowerCase(),
    eyeReportSha256: value.eyeReportSha256.toLowerCase(),
    oralReportSha256: value.oralReportSha256.toLowerCase(),
    facialArtworkDefinitionSha256: value.facialArtworkDefinitionSha256.toLowerCase(),
    facialArtworkContractFileSha256: value.facialArtworkContractFileSha256.toLowerCase(),
    facialArtworkProofSha256: value.facialArtworkProofSha256.toLowerCase(),
  };
}

export function collectMappedFaceMorphNames(
  manifest: Record<string, unknown>,
): Set<string> {
  const names = new Set<string>();
  const face = isRecord(manifest.face) ? manifest.face : null;
  if (!face) return names;
  const visit = (value: unknown) => {
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed) names.add(normalizeFaceMorphCollisionName(trimmed));
      return;
    }
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry);
      return;
    }
    if (isRecord(value)) {
      for (const entry of Object.values(value)) visit(entry);
    }
  };
  const expressions = isRecord(face.expressions) ? face.expressions : null;
  if (expressions) {
    for (const value of Object.values(expressions)) {
      if (
        isRecord(value) &&
        value.schemaVersion === "batshit-expression-recipe/v1" &&
        Array.isArray(value.targets)
      ) {
        for (const target of value.targets) {
          if (isRecord(target)) visit(target.target);
        }
      } else {
        visit(value);
      }
    }
  }
  visit(face.controls);
  visit(face.customMorphs);
  return names;
}

export function parseNodes(value: unknown): Record<string, AppearanceDialNode> {
  if (!isRecord(value) || Object.keys(value).length === 0) {
    throw new Error("avatar.json#appearanceDials has no node declarations");
  }
  const declarations = createRecord<AppearanceDialNode>();
  const runtimeNames = new Set<string>();
  const roleSides = new Set<string>();
  for (const [id, raw] of Object.entries(value)) {
    if (
      !isStableId(id) ||
      !isRecord(raw) ||
      !isNonEmptyString(raw.node) ||
      (raw.kind !== "mesh" && raw.kind !== "anchor") ||
      !ALLOWED_NODE_ROLES.has(raw.role as AppearanceDialNode["role"]) ||
      (raw.side !== "none" &&
        raw.side !== "left" &&
        raw.side !== "right" &&
        raw.side !== "bilateral") ||
      typeof raw.required !== "boolean" ||
      (raw.scalePolicy !== "any" && raw.scalePolicy !== "uniform-only") ||
      raw.exactNodeMatches !== 1
    ) {
      throw new Error(
        "appearance node " + (id || "<unnamed>") + " is malformed",
      );
    }
    if (runtimeNames.has(raw.node)) {
      throw new Error(
        "appearance runtime node " + raw.node + " is declared more than once",
      );
    }
    runtimeNames.add(raw.node);
    if (EYE_NODE_ROLES.has(raw.role as AppearanceDialNode["role"])) {
      if (raw.side !== "left" && raw.side !== "right") {
        throw new Error(
          "appearance eye node " + id + " requires a left/right side",
        );
      }
    } else if (
      (raw.role === "brow-canvas" || raw.role === "eye-treatment-canvas") &&
      raw.side !== "left" &&
      raw.side !== "right"
    ) {
      throw new Error(
        "appearance " +
          raw.role +
          " node " +
          id +
          " requires a left/right side",
      );
    } else if (
      raw.role !== "attachment-anchor" &&
      raw.role !== "generic-follower" &&
      !EYE_NODE_ROLES.has(raw.role as AppearanceDialNode["role"]) &&
      raw.role !== "brow-canvas" &&
      raw.role !== "eye-treatment-canvas" &&
      raw.side !== "none"
    ) {
      throw new Error("appearance node " + id + " has an invalid side");
    }
    const roleSide = String(raw.role) + "\u0000" + String(raw.side);
    const uniqueRole =
      raw.role !== "attachment-anchor" &&
      raw.role !== "generic-follower";
    if (uniqueRole && roleSides.has(roleSide)) {
      throw new Error(
        "appearance node role/side " +
          raw.role +
          "/" +
          raw.side +
          " is duplicated",
      );
    }
    if (uniqueRole) roleSides.add(roleSide);

    let parent: AppearanceDialNode["parent"];
    if (raw.parent !== undefined) {
      if (!isRecord(raw.parent)) {
        throw new Error("appearance node " + id + " has a malformed parent");
      }
      if (raw.parent.kind === "node" && isStableId(raw.parent.id)) {
        parent = { kind: "node", id: raw.parent.id };
      } else if (
        raw.parent.kind === "bone" &&
        isNonEmptyString(raw.parent.name)
      ) {
        parent = { kind: "bone", name: raw.parent.name };
      } else {
        throw new Error("appearance node " + id + " has a malformed parent");
      }
    }
    declarations[id] = {
      node: raw.node,
      kind: raw.kind,
      role: raw.role as AppearanceDialNode["role"],
      side: raw.side,
      required: raw.required,
      scalePolicy: raw.scalePolicy,
      ...(parent ? { parent } : {}),
      exactNodeMatches: 1,
    };
  }

  for (const [id, declaration] of Object.entries(declarations)) {
    if (declaration.parent?.kind !== "node") continue;
    if (!hasOwn(declarations, declaration.parent.id)) {
      throw new Error(
        "appearance node " +
          id +
          " has unknown parent " +
          declaration.parent.id,
      );
    }
    const seen = new Set<string>([id]);
    let cursor: AppearanceDialNode | undefined = declaration;
    while (cursor?.parent?.kind === "node") {
      if (seen.has(cursor.parent.id)) {
        throw new Error("appearance node hierarchy contains a cycle at " + id);
      }
      seen.add(cursor.parent.id);
      cursor = declarations[cursor.parent.id];
    }
  }
  return declarations;
}

export function parseTargets(
  value: unknown,
  nodes: Record<string, AppearanceDialNode>,
  faceMorphNames: Set<string>,
): Record<string, AppearanceTargetDefinition> {
  if (!isRecord(value) || Object.keys(value).length === 0) {
    throw new Error("avatar.json#appearanceDials has no identity targets");
  }
  const targets = createRecord<AppearanceTargetDefinition>();
  const claimedBindings = new Set<string>();
  const faceCollisionNames = new Set(
    [...faceMorphNames].map(normalizeFaceMorphCollisionName),
  );
  for (const [id, raw] of Object.entries(value)) {
    if (!isStableId(id) || !isRecord(raw)) {
      throw new Error(
        "appearance target " + (id || "<unnamed>") + " is malformed",
      );
    }
    if (
      !Array.isArray(raw.usages) ||
      raw.usages.length === 0 ||
      !raw.usages.every((usage) =>
        ALLOWED_USAGES.has(usage as AppearanceTargetUsage),
      ) ||
      new Set(raw.usages).size !== raw.usages.length ||
      !raw.usages.includes("identity") ||
      (raw.runtimeRetention !== "recipe-only" &&
        raw.runtimeRetention !== "retain-in-live-goon") ||
      (raw.side !== "none" &&
        raw.side !== "left" &&
        raw.side !== "right" &&
        raw.side !== "bilateral") ||
      !Array.isArray(raw.bindings) ||
      raw.bindings.length === 0 ||
      !isFiniteNumber(raw.baselineValue) ||
      !isFiniteNumber(raw.influenceMin) ||
      !isFiniteNumber(raw.influenceMax) ||
      raw.influenceMin > 0 ||
      raw.influenceMax < 0 ||
      raw.influenceMin >= raw.influenceMax ||
      (raw.combine !== "exclusive" && raw.combine !== "sum-clamp") ||
      (raw.impact !== "surface" && raw.impact !== "structural") ||
      (raw.soleDeltaY !== undefined && !isFiniteNumber(raw.soleDeltaY))
    ) {
      throw new Error("appearance target " + id + " is malformed");
    }

    const usages = raw.usages as AppearanceTargetUsage[];
    const corrective = usages.includes("pose-corrective");
    if (
      (corrective && raw.runtimeRetention !== "retain-in-live-goon") ||
      (!corrective && raw.runtimeRetention !== "recipe-only")
    ) {
      throw new Error(
        "appearance target " + id + " has inconsistent runtime retention",
      );
    }

    const provenance = parseApprovedProvenance(
      raw.provenance,
      "appearance target " + id,
    );

    const bindings: AppearanceTargetBinding[] = [];
    for (const binding of raw.bindings) {
      if (
        !isRecord(binding) ||
        !isStableId(binding.node) ||
        !isNonEmptyString(binding.morph) ||
        !hasOwn(nodes, binding.node) ||
        nodes[binding.node].kind !== "mesh"
      ) {
        throw new Error(
          "appearance target " + id + " has a malformed mesh binding",
        );
      }
      const bindingKey = binding.node + "\u0000" + binding.morph;
      if (claimedBindings.has(bindingKey)) {
        throw new Error(
          "appearance mesh/morph binding " +
            binding.node +
            "/" +
            binding.morph +
            " has multiple target owners",
        );
      }
      const faceCollisionName = normalizeFaceMorphCollisionName(binding.morph);
      if (faceCollisionNames.has(faceCollisionName)) {
        throw new Error(
          "identity target " +
            id +
            " collides with face animation/custom morph " +
            faceCollisionName,
        );
      }
      claimedBindings.add(bindingKey);
      bindings.push({ node: binding.node, morph: binding.morph });
    }

    let requirements: AppearanceTargetRequirements | undefined;
    if (raw.requirements !== undefined) {
      if (!isRecord(raw.requirements)) {
        throw new Error(
          "appearance target " + id + " requirements are malformed",
        );
      }
      const followerRefs = raw.requirements.followerRefs;
      if (
        (raw.requirements.jointFollow !== undefined &&
          typeof raw.requirements.jointFollow !== "boolean") ||
        (followerRefs !== undefined &&
          (!Array.isArray(followerRefs) ||
            !followerRefs.every(isStableId) ||
            new Set(followerRefs).size !== followerRefs.length))
      ) {
        throw new Error(
          "appearance target " + id + " requirements are malformed",
        );
      }
      requirements = {
        ...(raw.requirements.jointFollow === true ? { jointFollow: true } : {}),
        ...(Array.isArray(followerRefs) && followerRefs.length > 0
          ? { followerRefs: [...followerRefs] }
          : {}),
      };
    }

    targets[id] = {
      usages: [...usages],
      runtimeRetention: raw.runtimeRetention,
      side: raw.side,
      bindings,
      baselineValue: raw.baselineValue,
      influenceMin: raw.influenceMin,
      influenceMax: raw.influenceMax,
      combine: raw.combine,
      impact: raw.impact,
      ...(raw.soleDeltaY !== undefined ? { soleDeltaY: raw.soleDeltaY } : {}),
      ...(requirements ? { requirements } : {}),
      provenance,
    };
  }
  return targets;
}

function parseFollowerSamples(
  value: unknown,
  followerId: string,
  inputRange: [number, number],
  scalePolicy: AppearanceDialNode["scalePolicy"],
): AppearanceFollowerSample[] {
  if (!Array.isArray(value) || value.length < 2) {
    throw new Error(
      "appearance follower " + followerId + " has an empty sample track",
    );
  }
  const samples: AppearanceFollowerSample[] = [];
  let previous = Number.NEGATIVE_INFINITY;
  let neutralSeen = false;
  let nonIdentitySeen = false;
  for (const raw of value) {
    if (
      !isRecord(raw) ||
      !isFiniteNumber(raw.input) ||
      raw.input <= previous ||
      !isVec3(raw.translation) ||
      !isQuat(raw.rotation) ||
      !isPositiveVec3(raw.scale) ||
      !isVec3(raw.pivot)
    ) {
      throw new Error(
        "appearance follower " + followerId + " has malformed samples",
      );
    }
    previous = raw.input;
    const sample: AppearanceFollowerSample = {
      input: raw.input,
      translation: raw.translation,
      rotation: raw.rotation,
      scale: raw.scale,
      pivot: raw.pivot,
    };
    if (
      scalePolicy === "uniform-only" &&
      (Math.abs(sample.scale[0] - sample.scale[1]) > ZERO_TOLERANCE ||
        Math.abs(sample.scale[0] - sample.scale[2]) > ZERO_TOLERANCE)
    ) {
      throw new Error(
        "appearance follower " + followerId + " violates uniform-only scale",
      );
    }
    if (Math.abs(sample.input) <= ZERO_TOLERANCE) {
      neutralSeen = true;
      if (
        !isZeroVec3(sample.translation) ||
        !isIdentityQuat(sample.rotation) ||
        !isIdentityScale(sample.scale)
      ) {
        throw new Error(
          "appearance follower " + followerId + " is not neutral at zero",
        );
      }
    }
    if (
      !isZeroVec3(sample.translation) ||
      !isIdentityQuat(sample.rotation) ||
      !isIdentityScale(sample.scale)
    ) {
      nonIdentitySeen = true;
    }
    samples.push(sample);
  }
  if (!neutralSeen || !nonIdentitySeen) {
    throw new Error(
      "appearance follower " + followerId + " has a no-op or uncentered track",
    );
  }
  if (
    samples[0].input > inputRange[0] + ZERO_TOLERANCE ||
    samples[samples.length - 1].input < inputRange[1] - ZERO_TOLERANCE
  ) {
    throw new Error(
      "appearance follower " +
        followerId +
        " does not cover target influence range",
    );
  }
  return samples;
}

function collectDialDriverRanges(dials: AppearanceDialDefinition[]) {
  const ranges = new Map<string, [number, number]>();
  for (const dial of dials) {
    ranges.set(dial.id, dial.range);
    if (dial.symmetry?.mode === "linked-with-offsets") {
      ranges.set(dial.symmetry.left.id, dial.symmetry.left.range);
      ranges.set(dial.symmetry.right.id, dial.symmetry.right.range);
    }
  }
  return ranges;
}

function followerDriverKey(driver: AppearanceFollowerDriverRef) {
  return driver.kind + ":" + driver.id;
}

export function parseFollowers(
  value: unknown,
  nodes: Record<string, AppearanceDialNode>,
  targets: Record<string, AppearanceTargetDefinition>,
  dials: AppearanceDialDefinition[],
): Record<string, AppearanceFollowerDeclaration> {
  if (value === undefined || value === null) {
    return createRecord<AppearanceFollowerDeclaration>();
  }
  if (!isRecord(value)) {
    throw new Error("avatar.json#appearanceDials followers is not an object");
  }
  const followers = createRecord<AppearanceFollowerDeclaration>();
  const dialRanges = collectDialDriverRanges(dials);
  const claimedFollowerMorphs = new Set<string>();
  for (const [id, raw] of Object.entries(value)) {
    if (
      !isStableId(id) ||
      !isRecord(raw) ||
      raw.contract !== APPEARANCE_FOLLOWER_CONTRACT ||
      raw.space !== "node-parent-rest" ||
      raw.composition !== "rest-relative-follower-channel-id-order/v2" ||
      raw.interpolation !== "linear-trs-slerp-rotation-morph/v2" ||
      raw.extrapolation !== "clamp" ||
      !Array.isArray(raw.nodeIds) ||
      raw.nodeIds.length === 0 ||
      !raw.nodeIds.every(isStableId) ||
      new Set(raw.nodeIds).size !== raw.nodeIds.length ||
      !Array.isArray(raw.drivers) ||
      raw.drivers.length === 0
    ) {
      throw new Error(
        "appearance follower " + (id || "<unnamed>") + " is malformed",
      );
    }

    const provenance = parseApprovedProvenance(
      raw.provenance,
      "appearance follower " + id,
      true,
    );
    const nodeIds = [...raw.nodeIds] as string[];
    const declaredNodeIds = new Set(nodeIds);
    for (const nodeId of declaredNodeIds) {
      if (!hasOwn(nodes, nodeId)) {
        throw new Error(
          "appearance follower " + id + " references unknown node " + nodeId,
        );
      }
    }

    const drivers: AppearanceFollowerDriver[] = [];
    const seenDrivers = new Set<string>();
    const seenChannelIds = new Set<string>();
    for (const rawDriver of raw.drivers) {
      if (
        !isRecord(rawDriver) ||
        !isRecord(rawDriver.driver) ||
        (rawDriver.driver.kind !== "dial" &&
          rawDriver.driver.kind !== "target" &&
          rawDriver.driver.kind !== "anatomy-fit") ||
        !isStableId(rawDriver.driver.id) ||
        !Array.isArray(rawDriver.channels) ||
        rawDriver.channels.length === 0
      ) {
        throw new Error(
          "appearance follower " + id + " has a malformed driver",
        );
      }
      const driver = {
        kind: rawDriver.driver.kind,
        id: rawDriver.driver.id,
      } as AppearanceFollowerDriverRef;
      const driverKey = followerDriverKey(driver);
      if (seenDrivers.has(driverKey)) {
        throw new Error(
          "appearance follower " + id + " repeats driver " + driverKey,
        );
      }
      seenDrivers.add(driverKey);
      const inputRange =
        driver.kind === "dial"
          ? dialRanges.get(driver.id)
          : driver.kind === "target" && hasOwn(targets, driver.id)
            ? ([
                targets[driver.id].influenceMin,
                targets[driver.id].influenceMax,
              ] as [number, number])
            : driver.kind === "anatomy-fit"
              ? ([-1, 1] as [number, number])
              : undefined;
      if (!inputRange) {
        throw new Error(
          "appearance follower " +
            id +
            " references unknown driver " +
            driverKey,
        );
      }

      const channels: AppearanceFollowerChannel[] = [];
      const seenOperations = new Set<string>();
      for (const rawChannel of rawDriver.channels) {
        if (
          !isRecord(rawChannel) ||
          !isStableId(rawChannel.id) ||
          (rawChannel.kind !== "node-trs" &&
            rawChannel.kind !== "morph-weight") ||
          !isStableId(rawChannel.node) ||
          !declaredNodeIds.has(rawChannel.node)
        ) {
          throw new Error(
            "appearance follower " + id + " has a malformed channel",
          );
        }
        if (seenChannelIds.has(rawChannel.id)) {
          throw new Error(
            "appearance follower " + id + " repeats channel " + rawChannel.id,
          );
        }
        seenChannelIds.add(rawChannel.id);
        const declaration = nodes[rawChannel.node];

        if (rawChannel.kind === "node-trs") {
          if (driver.kind === "anatomy-fit") {
            throw new Error(
              "appearance follower " + id +
                " cannot expose Anatomy Fit through an ordinary node channel",
            );
          }
          const operationKey = "node-trs\u0000" + rawChannel.node;
          if (seenOperations.has(operationKey)) {
            throw new Error(
              "appearance follower " +
                id +
                " repeats one driver/node operation",
            );
          }
          seenOperations.add(operationKey);
          const channel: AppearanceFollowerNodeTransformChannel = {
            id: rawChannel.id,
            kind: "node-trs",
            node: rawChannel.node,
            samples: parseFollowerSamples(
              rawChannel.samples,
              id + "/" + rawChannel.id,
              inputRange,
              declaration.scalePolicy,
            ),
          };
          channels.push(channel);
          continue;
        }

        if (
          declaration.kind !== "mesh" ||
          !isNonEmptyString(rawChannel.morph) ||
          !isRange(rawChannel.weightRange) ||
          rawChannel.runtimeRetention !== "recipe-only" ||
          !isTrack(rawChannel.samples)
        ) {
          throw new Error(
            "appearance follower " + id + " has a malformed morph channel",
          );
        }
        const samples = rawChannel.samples as [number, number][];
        const weightRange = rawChannel.weightRange as [number, number];
        const operationKey =
          "morph-weight\u0000" + rawChannel.node + "\u0000" + rawChannel.morph;
        if (seenOperations.has(operationKey)) {
          throw new Error(
            "appearance follower " +
              id +
              " repeats one driver/node/morph operation",
          );
        }
        seenOperations.add(operationKey);
        if (
          samples[0][0] > inputRange[0] + ZERO_TOLERANCE ||
          samples[samples.length - 1][0] < inputRange[1] - ZERO_TOLERANCE ||
          Math.abs(evaluateAppearanceDialTrack(samples, 0)) > ZERO_TOLERANCE ||
          (driver.kind !== "anatomy-fit" &&
            samples.every(([, output]) => Math.abs(output) <= ZERO_TOLERANCE)) ||
          samples.some(
            ([, output]) => output < weightRange[0] || output > weightRange[1],
          )
        ) {
          throw new Error(
            "appearance follower " +
              id +
              " has an uncentered, no-op, or out-of-range morph channel",
          );
        }
        const morphKey = rawChannel.node + "\u0000" + rawChannel.morph;
        if (claimedFollowerMorphs.has(morphKey)) {
          throw new Error(
            "appearance follower morph " + morphKey + " has multiple owners",
          );
        }
        claimedFollowerMorphs.add(morphKey);
        const channel: AppearanceFollowerMorphChannel = {
          id: rawChannel.id,
          kind: "morph-weight",
          node: rawChannel.node,
          morph: rawChannel.morph,
          weightRange,
          runtimeRetention: "recipe-only",
          samples,
        };
        channels.push(channel);
      }
      drivers.push({ driver, channels });
    }
    followers[id] = {
      contract: APPEARANCE_FOLLOWER_CONTRACT,
      space: "node-parent-rest",
      composition: "rest-relative-follower-channel-id-order/v2",
      interpolation: "linear-trs-slerp-rotation-morph/v2",
      extrapolation: "clamp",
      provenance,
      nodeIds,
      drivers,
    };
  }
  return followers;
}

export function parseJointFollow(
  value: unknown,
  targets: Record<string, AppearanceTargetDefinition>,
): AppearanceJointFollow | undefined {
  if (value === undefined || value === null) return undefined;
  if (
    !isRecord(value) ||
    value.contract !== APPEARANCE_JOINT_FOLLOW_CONTRACT ||
    value.space !== "avatar-root" ||
    value.units !== "meters" ||
    !isSha256(value.restSkeletonSha256) ||
    !isRecord(value.deltas) ||
    Object.keys(value.deltas).length === 0
  ) {
    throw new Error("avatar.json#appearanceDials jointFollow is malformed");
  }
  const deltas = createRecord<Record<string, AppearanceVec3>>();
  for (const [targetId, rawPerBone] of Object.entries(value.deltas)) {
    if (
      !hasOwn(targets, targetId) ||
      !isRecord(rawPerBone) ||
      Object.keys(rawPerBone).length === 0
    ) {
      throw new Error(
        "appearance joint deltas for " + targetId + " are malformed",
      );
    }
    const perBone = createRecord<AppearanceVec3>();
    for (const [bone, delta] of Object.entries(rawPerBone)) {
      if (!isNonEmptyString(bone) || !isVec3(delta)) {
        throw new Error(
          "appearance joint delta " + targetId + "/" + bone + " is malformed",
        );
      }
      perBone[bone] = delta;
    }
    deltas[targetId] = perBone;
  }

  let clipRemap: AppearanceJointFollow["clipRemap"];
  if (value.clipRemap !== undefined) {
    if (
      !isRecord(value.clipRemap) ||
      value.clipRemap.contract !== APPEARANCE_CLIP_REMAP_CONTRACT ||
      !isNonEmptyString(value.clipRemap.hipsBone)
    ) {
      throw new Error(
        "avatar.json#appearanceDials jointFollow clipRemap is malformed",
      );
    }
    clipRemap = {
      contract: APPEARANCE_CLIP_REMAP_CONTRACT,
      hipsBone: value.clipRemap.hipsBone,
    };
  }
  return {
    contract: APPEARANCE_JOINT_FOLLOW_CONTRACT,
    space: "avatar-root",
    units: "meters",
    restSkeletonSha256: value.restSkeletonSha256.toLowerCase(),
    deltas,
    ...(clipRemap ? { clipRemap } : {}),
  };
}
