import {
  APPEARANCE_DIAL_VALUES_CONTRACT,
  type AppearanceDialMember,
  type AppearanceDialMacroAxis,
  type AppearanceDialValueState,
  type AppearanceDialsManifest,
  type AppearanceFollowerDriverRef,
  type AppearanceFollowerSample,
  type AppearanceQuat,
  type AppearanceVec3,
  type ReconciledAppearanceDialValues,
  type ResolvedAppearanceDialState,
  type ResolvedAppearanceFollowerState,
} from "./appearanceDials.contracts";
import {
  MACRO_AXES,
  MACRO_BASELINE_TOLERANCE,
  ZERO_TOLERANCE,
  createRecord,
  evaluateAppearanceDialTrack,
  hasOwn,
  isFiniteNumber,
  isRecord,
  isStableId,
} from "./appearanceDials.validation";
import { resolveMpfbMacroCornerWeights } from "./mpfbMacro";

function createDefaultValueState(
  manifest: AppearanceDialsManifest,
): AppearanceDialValueState {
  const values = createRecord<number>();
  for (const dial of manifest.dials) {
    values[dial.id] = 0;
    if (dial.symmetry?.mode === "linked-with-offsets") {
      values[dial.symmetry.left.id] = 0;
      values[dial.symmetry.right.id] = 0;
    }
  }
  return {
    contract: APPEARANCE_DIAL_VALUES_CONTRACT,
    definitionSha256: manifest.definitionSha256,
    neutralId: manifest.neutral.id,
    neutralRecipeSha256: manifest.neutral.recipeSha256,
    values,
    unlockedDialIds: [],
  };
}

function clampValue(range: [number, number], value: number): number {
  return Math.min(range[1], Math.max(range[0], value));
}

function followerDriverKey(driver: AppearanceFollowerDriverRef): string {
  return driver.kind + ":" + driver.id;
}

function lerp(left: number, right: number, amount: number): number {
  return left + (right - left) * amount;
}

function lerpVec3(
  left: AppearanceVec3,
  right: AppearanceVec3,
  amount: number,
): AppearanceVec3 {
  return [
    lerp(left[0], right[0], amount),
    lerp(left[1], right[1], amount),
    lerp(left[2], right[2], amount),
  ];
}

function normalizeQuat(value: AppearanceQuat): AppearanceQuat {
  const length = Math.hypot(value[0], value[1], value[2], value[3]);
  if (!Number.isFinite(length) || length <= ZERO_TOLERANCE) {
    throw new Error("appearance follower resolved an invalid quaternion");
  }
  return [
    value[0] / length,
    value[1] / length,
    value[2] / length,
    value[3] / length,
  ];
}

function slerpQuat(
  leftValue: AppearanceQuat,
  rightValue: AppearanceQuat,
  amount: number,
): AppearanceQuat {
  const left = normalizeQuat(leftValue);
  let right = normalizeQuat(rightValue);
  let dot =
    left[0] * right[0] +
    left[1] * right[1] +
    left[2] * right[2] +
    left[3] * right[3];
  if (dot < 0) {
    right = [-right[0], -right[1], -right[2], -right[3]];
    dot = -dot;
  }
  if (dot > 0.9995) {
    return normalizeQuat([
      lerp(left[0], right[0], amount),
      lerp(left[1], right[1], amount),
      lerp(left[2], right[2], amount),
      lerp(left[3], right[3], amount),
    ]);
  }
  const theta = Math.acos(Math.min(1, Math.max(-1, dot)));
  const sinTheta = Math.sin(theta);
  const leftWeight = Math.sin((1 - amount) * theta) / sinTheta;
  const rightWeight = Math.sin(amount * theta) / sinTheta;
  return normalizeQuat([
    left[0] * leftWeight + right[0] * rightWeight,
    left[1] * leftWeight + right[1] * rightWeight,
    left[2] * leftWeight + right[2] * rightWeight,
    left[3] * leftWeight + right[3] * rightWeight,
  ]);
}

function evaluateFollowerSamples(
  samples: AppearanceFollowerSample[],
  input: number,
): Omit<AppearanceFollowerSample, "input"> {
  const first = samples[0];
  const last = samples[samples.length - 1];
  if (!first || !last) {
    throw new Error("appearance follower has no transform samples");
  }
  if (input <= first.input) {
    const { input: _input, ...result } = first;
    return result;
  }
  if (input >= last.input) {
    const { input: _input, ...result } = last;
    return result;
  }
  for (let index = 0; index < samples.length - 1; index += 1) {
    const left = samples[index];
    const right = samples[index + 1];
    if (input < left.input || input > right.input) continue;
    const amount = (input - left.input) / (right.input - left.input);
    return {
      translation: lerpVec3(left.translation, right.translation, amount),
      rotation: slerpQuat(left.rotation, right.rotation, amount),
      scale: lerpVec3(left.scale, right.scale, amount),
      pivot: lerpVec3(left.pivot, right.pivot, amount),
    };
  }
  throw new Error(
    "appearance follower could not interpolate transform samples",
  );
}

export function resolveAppearanceFollowerState(
  manifest: AppearanceDialsManifest,
  followerInputs: Map<string, Map<string, number>>,
): ResolvedAppearanceFollowerState {
  const nodeTransforms: ResolvedAppearanceFollowerState["nodeTransforms"] = [];
  const morphs: ResolvedAppearanceFollowerState["morphs"] = [];
  for (const [followerId, follower] of Object.entries(manifest.followers).sort(
    ([left], [right]) => left.localeCompare(right),
  )) {
    const inputs = followerInputs.get(followerId);
    if (!inputs) {
      throw new Error(
        "appearance follower " + followerId + " has no resolved inputs",
      );
    }
    const channels = follower.drivers
      .flatMap((entry) =>
        entry.channels.map((channel) => ({ driver: entry.driver, channel })),
      )
      .sort((left, right) => left.channel.id.localeCompare(right.channel.id));
    for (const { driver, channel } of channels) {
      const key = followerDriverKey(driver);
      const input = inputs.get(key);
      if (input === undefined || !Number.isFinite(input)) {
        throw new Error(
          "appearance follower " +
            followerId +
            "/" +
            key +
            " has no finite input",
        );
      }
      if (channel.kind === "node-trs") {
        nodeTransforms.push({
          follower: followerId,
          channel: channel.id,
          driver,
          node: channel.node,
          ...evaluateFollowerSamples(channel.samples, input),
        });
      } else {
        const weight = evaluateAppearanceDialTrack(channel.samples, input);
        if (!Number.isFinite(weight)) {
          throw new Error(
            "appearance follower " +
              followerId +
              "/" +
              channel.id +
              " produced a non-finite weight",
          );
        }
        morphs.push({
          follower: followerId,
          channel: channel.id,
          driver,
          node: channel.node,
          morph: channel.morph,
          weight,
          runtimeRetention: channel.runtimeRetention,
        });
      }
    }
  }
  return { nodeTransforms, morphs };
}

export function reconcileAppearanceDialValues(
  manifest: AppearanceDialsManifest,
  stored: unknown,
): ReconciledAppearanceDialValues {
  const state = createDefaultValueState(manifest);
  const reasons: string[] = [];
  const prunedIds: string[] = [];
  const prunedUnlockIds: string[] = [];
  const clampedIds: string[] = [];
  const resetIds: string[] = [];
  const known = new Map<string, [number, number]>();
  const sideOwner = new Map<string, string>();
  const unlockable = new Set<string>();
  for (const dial of manifest.dials) {
    known.set(dial.id, dial.range);
    if (dial.symmetry?.mode === "linked-with-offsets") {
      unlockable.add(dial.id);
      known.set(dial.symmetry.left.id, dial.symmetry.left.range);
      known.set(dial.symmetry.right.id, dial.symmetry.right.range);
      sideOwner.set(dial.symmetry.left.id, dial.id);
      sideOwner.set(dial.symmetry.right.id, dial.id);
    }
  }

  if (stored === null || stored === undefined) {
    return {
      state,
      values: state.values,
      unlockedDialIds: state.unlockedDialIds,
      incompatible: false,
      incompatibilityReasons: [],
      prunedIds,
      prunedUnlockIds,
      clampedIds,
      resetIds,
    };
  }
  if (!isRecord(stored)) {
    reasons.push("stored appearance dial state is not an object");
  } else {
    if (stored.contract !== APPEARANCE_DIAL_VALUES_CONTRACT) {
      reasons.push("contract mismatch");
    }
    if (stored.definitionSha256 !== manifest.definitionSha256) {
      reasons.push("definition mismatch");
    }
    if (stored.neutralId !== manifest.neutral.id) {
      reasons.push("neutral id mismatch");
    }
    if (stored.neutralRecipeSha256 !== manifest.neutral.recipeSha256) {
      reasons.push("neutral recipe mismatch");
    }
    if (!isRecord(stored.values)) reasons.push("values are malformed");
    if (
      !Array.isArray(stored.unlockedDialIds) ||
      !stored.unlockedDialIds.every(isStableId) ||
      new Set(stored.unlockedDialIds).size !== stored.unlockedDialIds.length
    ) {
      reasons.push("unlocked dial ids are malformed");
    }
  }

  if (reasons.length > 0) {
    resetIds.push(...[...known.keys()].sort());
    return {
      state,
      values: state.values,
      unlockedDialIds: state.unlockedDialIds,
      incompatible: true,
      incompatibilityReasons: reasons,
      prunedIds,
      prunedUnlockIds,
      clampedIds,
      resetIds,
    };
  }

  const raw = stored as Record<string, unknown>;
  const rawValues = raw.values as Record<string, unknown>;
  const rawUnlocks = raw.unlockedDialIds as unknown[];
  const unlocked = new Set<string>();
  for (const id of rawUnlocks) {
    const stringId = id as string;
    if (unlockable.has(stringId)) unlocked.add(stringId);
    else prunedUnlockIds.push(stringId);
  }
  state.unlockedDialIds = [...unlocked].sort();

  for (const id of Object.keys(rawValues)) {
    if (!known.has(id)) prunedIds.push(id);
  }
  for (const [id, range] of known) {
    if (!hasOwn(rawValues, id)) continue;
    const value = rawValues[id];
    if (!isFiniteNumber(value)) {
      resetIds.push(id);
      continue;
    }
    const owner = sideOwner.get(id);
    if (owner && !unlocked.has(owner)) {
      if (Math.abs(value) > ZERO_TOLERANCE) resetIds.push(id);
      continue;
    }
    const clamped = clampValue(range, value);
    if (clamped !== value) clampedIds.push(id);
    state.values[id] = clamped;
  }

  prunedIds.sort();
  prunedUnlockIds.sort();
  clampedIds.sort();
  resetIds.sort();
  return {
    state,
    values: state.values,
    unlockedDialIds: state.unlockedDialIds,
    incompatible: false,
    incompatibilityReasons: [],
    prunedIds,
    prunedUnlockIds,
    clampedIds,
    resetIds,
  };
}

export function normalizeAppearanceDialValues(
  manifest: AppearanceDialsManifest,
  stored: unknown,
): Record<string, number> {
  const reconciled = reconcileAppearanceDialValues(manifest, stored);
  if (reconciled.incompatible) {
    throw new Error(
      "cannot normalize incompatible appearance dial state: " +
        reconciled.incompatibilityReasons.join(", "),
    );
  }
  return reconciled.values;
}

export function relockAppearanceDialSides(
  manifest: AppearanceDialsManifest,
  stored: unknown,
  dialId: string,
): AppearanceDialValueState {
  const reconciled = reconcileAppearanceDialValues(manifest, stored);
  if (reconciled.incompatible) {
    throw new Error(
      "cannot relock incompatible appearance dial state: " +
        reconciled.incompatibilityReasons.join(", "),
    );
  }
  const dial = manifest.dials.find((candidate) => candidate.id === dialId);
  if (!dial || dial.symmetry?.mode !== "linked-with-offsets") {
    throw new Error(
      "appearance dial " + dialId + " does not support side unlocking",
    );
  }
  const state: AppearanceDialValueState = {
    ...reconciled.state,
    values: { ...reconciled.state.values },
    unlockedDialIds: reconciled.state.unlockedDialIds.filter(
      (id) => id !== dialId,
    ),
  };
  state.values[dial.symmetry.left.id] = 0;
  state.values[dial.symmetry.right.id] = 0;
  return state;
}

export function resolveAppearanceDialState(
  manifest: AppearanceDialsManifest,
  stored: unknown,
): ResolvedAppearanceDialState {
  const reconciled = reconcileAppearanceDialValues(manifest, stored);
  if (reconciled.incompatible) {
    throw new Error(
      "cannot resolve incompatible appearance dial state: " +
        reconciled.incompatibilityReasons.join(", "),
    );
  }
  const values = reconciled.values;
  const unlockedDialIds = new Set(reconciled.unlockedDialIds);
  const influences = new Map<string, number>(
    Object.keys(manifest.targets).map((targetId) => [targetId, 0]),
  );
  const macroValues: Record<AppearanceDialMacroAxis, number> =
    manifest.macroEngine
      ? { ...manifest.macroEngine.baselineState }
      : { muscle: 0, weight: 0, cupsize: 0, firmness: 0 };
  let rootScale = 1;

  const contribute = (member: AppearanceDialMember, value: number) => {
    const contribution = evaluateAppearanceDialTrack(member.track, value);
    const nextInfluence = (influences.get(member.target) ?? 0) + contribution;
    if (!Number.isFinite(contribution) || !Number.isFinite(nextInfluence)) {
      throw new Error(
        "appearance target " +
          member.target +
          " resolved a non-finite morph influence",
      );
    }
    influences.set(member.target, nextInfluence);
  };

  for (const dial of manifest.dials) {
    const value = values[dial.id] ?? 0;
    if (dial.kind === "root-scale") {
      rootScale = 1 + (dial.scalePerUnit ?? 0) * value;
      continue;
    }
    if (dial.kind === "macro-axis") {
      if (dial.axis && dial.axisTrack) {
        macroValues[dial.axis] = evaluateAppearanceDialTrack(
          dial.axisTrack,
          value,
        );
      }
      continue;
    }
    for (const member of dial.members ?? []) contribute(member, value);
    if (
      dial.symmetry?.mode === "linked-with-offsets" &&
      unlockedDialIds.has(dial.id)
    ) {
      for (const member of dial.symmetry.left.members) {
        contribute(member, values[dial.symmetry.left.id] ?? 0);
      }
      for (const member of dial.symmetry.right.members) {
        contribute(member, values[dial.symmetry.right.id] ?? 0);
      }
    }
  }

  if (manifest.macroEngine) {
    const cornerWeights = resolveMpfbMacroCornerWeights(
      MACRO_AXES,
      manifest.macroEngine.dims,
      manifest.macroEngine.corners.map((corner) => ({
        id: corner.target,
        comps: corner.comps,
        fixedFactor: corner.fixedFactor,
      })),
      macroValues,
      manifest.macroEngine.cutoff,
    );
    for (const corner of manifest.macroEngine.corners) {
      const absoluteWeight = cornerWeights.get(corner.target) ?? 0;
      const rawContribution = absoluteWeight - corner.baselineWeight;
      if (
        !Number.isFinite(absoluteWeight) ||
        !Number.isFinite(rawContribution)
      ) {
        throw new Error(
          "appearance macro target " +
            corner.target +
            " resolved a non-finite morph influence",
        );
      }
      const contribution =
        Math.abs(rawContribution) <= MACRO_BASELINE_TOLERANCE
          ? 0
          : rawContribution;
      const nextInfluence = (influences.get(corner.target) ?? 0) + contribution;
      if (!Number.isFinite(nextInfluence)) {
        throw new Error(
          "appearance macro target " +
            corner.target +
            " resolved a non-finite morph influence",
        );
      }
      influences.set(corner.target, nextInfluence);
    }
  }

  for (const [targetId, rawInfluence] of influences) {
    if (!Number.isFinite(rawInfluence)) {
      throw new Error(
        "appearance target " +
          targetId +
          " resolved a non-finite morph influence",
      );
    }
    const target = manifest.targets[targetId];
    const influence = Math.min(
      target.influenceMax,
      Math.max(target.influenceMin, rawInfluence),
    );
    if (!Number.isFinite(influence)) {
      throw new Error(
        "appearance target " +
          targetId +
          " resolved a non-finite morph influence",
      );
    }
    influences.set(targetId, influence);
  }

  const jointOffsets = new Map<string, AppearanceVec3>();
  for (const perBone of Object.values(manifest.jointFollow?.deltas ?? {})) {
    for (const bone of Object.keys(perBone)) {
      if (!jointOffsets.has(bone)) jointOffsets.set(bone, [0, 0, 0]);
    }
  }
  const followerInputs = new Map<string, Map<string, number>>();
  for (const [followerId, follower] of Object.entries(manifest.followers)) {
    const inputs = new Map<string, number>();
    for (const entry of follower.drivers) {
      inputs.set(followerDriverKey(entry.driver), 0);
    }
    followerInputs.set(followerId, inputs);
  }

  let soleOffsetY = 0;
  for (const [targetId, influence] of influences) {
    const target = manifest.targets[targetId];
    if (target.soleDeltaY !== undefined) {
      soleOffsetY += influence * target.soleDeltaY;
    }
    for (const [bone, delta] of Object.entries(
      manifest.jointFollow?.deltas[targetId] ?? {},
    )) {
      const current = jointOffsets.get(bone) ?? [0, 0, 0];
      current[0] += influence * delta[0];
      current[1] += influence * delta[1];
      current[2] += influence * delta[2];
      jointOffsets.set(bone, current);
    }
  }

  for (const [followerId, follower] of Object.entries(manifest.followers)) {
    const inputs = followerInputs.get(followerId)!;
    for (const entry of follower.drivers) {
      inputs.set(
        followerDriverKey(entry.driver),
        entry.driver.kind === "target"
          ? (influences.get(entry.driver.id) ?? 0)
          : (values[entry.driver.id] ?? 0),
      );
    }
  }

  if (!Number.isFinite(rootScale)) {
    throw new Error("appearance root scale resolved a non-finite transform");
  }
  if (!Number.isFinite(soleOffsetY)) {
    throw new Error("appearance sole offset resolved a non-finite transform");
  }
  for (const [bone, offset] of jointOffsets) {
    if (!offset.every(Number.isFinite)) {
      throw new Error(
        "appearance joint " + bone + " resolved a non-finite transform",
      );
    }
  }
  for (const [followerId, inputs] of followerInputs) {
    for (const [driverId, input] of inputs) {
      if (!Number.isFinite(input)) {
        throw new Error(
          "appearance follower " +
            followerId +
            "/" +
            driverId +
            " resolved a non-finite transform input",
        );
      }
    }
  }

  const followerState = resolveAppearanceFollowerState(
    manifest,
    followerInputs,
  );

  return {
    values,
    unlockedDialIds,
    influences,
    jointOffsets,
    followerInputs,
    followerState,
    rootScale,
    soleOffsetY,
  };
}

export function appearanceDialValuesEqual(
  a: AppearanceDialValueState | null | undefined,
  b: AppearanceDialValueState | null | undefined,
): boolean {
  if (!a || !b) return !a && !b;
  if (
    a.contract !== b.contract ||
    a.definitionSha256 !== b.definitionSha256 ||
    a.neutralId !== b.neutralId ||
    a.neutralRecipeSha256 !== b.neutralRecipeSha256
  ) {
    return false;
  }
  const aUnlocks = [...a.unlockedDialIds].sort();
  const bUnlocks = [...b.unlockedDialIds].sort();
  if (
    aUnlocks.length !== bUnlocks.length ||
    aUnlocks.some((id, index) => id !== bUnlocks[index])
  ) {
    return false;
  }
  const aKeys = Object.keys(a.values);
  const bKeys = Object.keys(b.values);
  return (
    aKeys.length === bKeys.length &&
    aKeys.every(
      (key) => hasOwn(b.values, key) && a.values[key] === b.values[key],
    )
  );
}
