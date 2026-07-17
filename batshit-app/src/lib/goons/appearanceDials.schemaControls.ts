import {
  type AppearanceDialDefinition,
  type AppearanceDriverRequirements,
  type AppearanceDialMacroAxis,
  type AppearanceDialMember,
  type AppearanceDialRegion,
  type AppearanceDialSideOffset,
  type AppearanceMacroCorner,
  type AppearanceMacroEngine,
  type AppearanceMacroPart,
  type AppearanceTargetDefinition,
} from "./appearanceDials.contracts";
import {
  MACRO_AXES,
  MACRO_BASELINE_TOLERANCE,
  ZERO_TOLERANCE,
  evaluateAppearanceDialTrack,
  hasOwn,
  isFiniteNumber,
  isNonEmptyString,
  isRange,
  isRecord,
  isStableId,
  isTrack,
} from "./appearanceDials.validation";
import { resolveMpfbMacroCornerWeights } from "./mpfbMacro";

export function parseRegions(value: unknown): AppearanceDialRegion[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("avatar.json#appearanceDials has no regions");
  }
  const regions: AppearanceDialRegion[] = [];
  const ids = new Set<string>();
  for (const raw of value) {
    if (
      !isRecord(raw) ||
      !isStableId(raw.id) ||
      !isNonEmptyString(raw.label) ||
      (raw.surface !== "body" && raw.surface !== "head-face") ||
      !isFiniteNumber(raw.order) ||
      !Number.isInteger(raw.order) ||
      (raw.parentId !== undefined && !isStableId(raw.parentId))
    ) {
      throw new Error(
        "avatar.json#appearanceDials contains a malformed region",
      );
    }
    if (ids.has(raw.id)) {
      throw new Error(
        "appearance region " + raw.id + " is declared more than once",
      );
    }
    ids.add(raw.id);
    regions.push({
      id: raw.id,
      label: raw.label,
      surface: raw.surface,
      order: raw.order,
      ...(raw.parentId ? { parentId: raw.parentId } : {}),
    });
  }

  const surfaces = new Set(regions.map((region) => region.surface));
  for (const surface of ["body", "head-face"] as const) {
    if (!surfaces.has(surface)) {
      throw new Error(
        "appearance-dials/v2 requires at least one " + surface + " region",
      );
    }
  }

  const byId = new Map(regions.map((region) => [region.id, region]));
  for (const region of regions) {
    if (!region.parentId) continue;
    const parent = byId.get(region.parentId);
    if (!parent) {
      throw new Error(
        "appearance region " +
          region.id +
          " has unknown parent " +
          region.parentId,
      );
    }
    if (parent.id === region.id || parent.surface !== region.surface) {
      throw new Error(
        "appearance region " + region.id + " has an invalid parent",
      );
    }
    const seen = new Set<string>([region.id]);
    let cursor: AppearanceDialRegion | undefined = parent;
    while (cursor) {
      if (seen.has(cursor.id)) {
        throw new Error(
          "appearance region hierarchy contains a cycle at " + cursor.id,
        );
      }
      seen.add(cursor.id);
      cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
    }
  }
  return regions;
}

export function parseMacroEngine(
  value: unknown,
  targets: Record<string, AppearanceTargetDefinition>,
): AppearanceMacroEngine | undefined {
  if (value === undefined || value === null) return undefined;
  if (
    !isRecord(value) ||
    value.formula !== "mpfb-macro-product/v1" ||
    !isFiniteNumber(value.cutoff) ||
    value.cutoff < 0 ||
    value.cutoff >= 1 ||
    !isRecord(value.baselineState) ||
    !isRecord(value.dims) ||
    !Array.isArray(value.corners) ||
    value.corners.length === 0
  ) {
    throw new Error("avatar.json#appearanceDials macroEngine is malformed");
  }

  const baselineState = {} as Record<AppearanceDialMacroAxis, number>;
  const dims = {} as AppearanceMacroEngine["dims"];
  const componentNames = {} as Record<AppearanceDialMacroAxis, Set<string>>;
  for (const axis of MACRO_AXES) {
    const baseline = value.baselineState[axis];
    const rawDim = value.dims[axis];
    if (
      !isFiniteNumber(baseline) ||
      !isRecord(rawDim) ||
      !Array.isArray(rawDim.parts) ||
      rawDim.parts.length === 0 ||
      (rawDim.extrapolateHigh !== undefined &&
        typeof rawDim.extrapolateHigh !== "boolean")
    ) {
      throw new Error(
        "appearance macro engine is missing the " + axis + " dimension",
      );
    }
    const parts: AppearanceMacroPart[] = [];
    const names = new Set<string>();
    let previousLowest = Number.NEGATIVE_INFINITY;
    let previousHighest = Number.NEGATIVE_INFINITY;
    for (const rawPart of rawDim.parts) {
      if (
        !isRecord(rawPart) ||
        !isFiniteNumber(rawPart.lowest) ||
        !isFiniteNumber(rawPart.highest) ||
        rawPart.lowest >= rawPart.highest ||
        !Number.isFinite(rawPart.highest - rawPart.lowest) ||
        rawPart.lowest < previousLowest ||
        rawPart.highest < previousHighest ||
        typeof rawPart.low !== "string" ||
        typeof rawPart.high !== "string"
      ) {
        throw new Error(
          "appearance macro " + axis + " has a malformed parts table",
        );
      }
      previousLowest = rawPart.lowest;
      previousHighest = rawPart.highest;
      if (rawPart.low) names.add(rawPart.low);
      if (rawPart.high) names.add(rawPart.high);
      parts.push({
        lowest: rawPart.lowest,
        highest: rawPart.highest,
        low: rawPart.low,
        high: rawPart.high,
      });
    }
    baselineState[axis] = baseline;
    dims[axis] = {
      parts,
      ...(rawDim.extrapolateHigh === true ? { extrapolateHigh: true } : {}),
    };
    componentNames[axis] = names;
  }

  const corners: AppearanceMacroCorner[] = [];
  const targetIds = new Set<string>();
  for (const raw of value.corners) {
    if (
      !isRecord(raw) ||
      !isStableId(raw.target) ||
      !hasOwn(targets, raw.target) ||
      !isStableId(raw.family) ||
      !isRecord(raw.comps) ||
      !isFiniteNumber(raw.fixedFactor) ||
      !isFiniteNumber(raw.baselineWeight)
    ) {
      throw new Error("appearance macro engine contains a malformed corner");
    }
    if (targetIds.has(raw.target)) {
      throw new Error(
        "appearance macro target " + raw.target + " is declared more than once",
      );
    }
    targetIds.add(raw.target);
    const comps: Partial<Record<AppearanceDialMacroAxis, string>> = {};
    for (const axis of MACRO_AXES) {
      const component = raw.comps[axis];
      if (
        component !== undefined &&
        (!isNonEmptyString(component) || !componentNames[axis].has(component))
      ) {
        throw new Error(
          "appearance macro corner " +
            raw.target +
            " has unknown " +
            axis +
            " component",
        );
      }
      if (component) comps[axis] = component;
    }
    corners.push({
      target: raw.target,
      family: raw.family,
      comps,
      fixedFactor: raw.fixedFactor,
      baselineWeight: raw.baselineWeight,
    });
  }

  const engine: AppearanceMacroEngine = {
    formula: "mpfb-macro-product/v1",
    cutoff: value.cutoff,
    baselineState,
    dims,
    corners,
  };
  const baselineWeights = resolveMpfbMacroCornerWeights(
    MACRO_AXES,
    dims,
    corners.map((corner) => ({
      id: corner.target,
      comps: corner.comps,
      fixedFactor: corner.fixedFactor,
    })),
    baselineState,
    engine.cutoff,
  );
  for (const corner of corners) {
    const resolvedBaselineWeight = baselineWeights.get(corner.target) ?? 0;
    if (
      !Number.isFinite(resolvedBaselineWeight) ||
      Math.abs(resolvedBaselineWeight - corner.baselineWeight) >
        MACRO_BASELINE_TOLERANCE
    ) {
      throw new Error(
        "appearance macro corner " + corner.target + " baselineWeight drifted",
      );
    }
  }
  return engine;
}

function validateTrackCoverageAndEffect(
  track: [number, number][],
  inputRange: [number, number],
  neutralOutput: number,
  context: string,
) {
  const first = track[0];
  const last = track[track.length - 1];
  if (first[0] > inputRange[0] || last[0] < inputRange[1]) {
    throw new Error(context + " does not cover its declared input range");
  }
  const inputs = [
    inputRange[0],
    0,
    inputRange[1],
    ...track
      .map(([input]) => input)
      .filter((input) => input >= inputRange[0] && input <= inputRange[1]),
  ];
  const outputs = inputs.map((input) =>
    evaluateAppearanceDialTrack(track, input),
  );
  if (outputs.some((output) => !Number.isFinite(output))) {
    throw new Error(context + " produces a non-finite endpoint");
  }
  if (
    outputs.every(
      (output) => Math.abs(output - neutralOutput) <= ZERO_TOLERANCE,
    )
  ) {
    throw new Error(context + " does not produce an effective change");
  }
}

function validateMacroDialEffect(
  track: [number, number][],
  inputRange: [number, number],
  axis: AppearanceDialMacroAxis,
  engine: AppearanceMacroEngine,
  dialId: string,
) {
  const inputs = [
    inputRange[0],
    inputRange[1],
    ...track
      .map(([input]) => input)
      .filter((input) => input >= inputRange[0] && input <= inputRange[1]),
  ];
  const corners = engine.corners.map((corner) => ({
    id: corner.target,
    comps: corner.comps,
    fixedFactor: corner.fixedFactor,
  }));
  for (const input of inputs) {
    const state = {
      ...engine.baselineState,
      [axis]: evaluateAppearanceDialTrack(track, input),
    };
    const weights = resolveMpfbMacroCornerWeights(
      MACRO_AXES,
      engine.dims,
      corners,
      state,
      engine.cutoff,
    );
    for (const corner of engine.corners) {
      const weight = weights.get(corner.target) ?? 0;
      if (!Number.isFinite(weight)) {
        throw new Error(
          "appearance macro dial " + dialId + " produces a non-finite endpoint",
        );
      }
      if (Math.abs(weight - corner.baselineWeight) > ZERO_TOLERANCE) {
        return;
      }
    }
  }
  throw new Error(
    "appearance macro dial " +
      dialId +
      " does not produce an effective macro change",
  );
}

function parseMembers(
  value: unknown,
  dialId: string,
  targets: Record<string, AppearanceTargetDefinition>,
  inputRange: [number, number],
): AppearanceDialMember[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("appearance dial " + dialId + " has no target members");
  }
  const members: AppearanceDialMember[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (
      !isRecord(raw) ||
      !isStableId(raw.target) ||
      !hasOwn(targets, raw.target) ||
      !isTrack(raw.track)
    ) {
      throw new Error(
        "appearance dial " + dialId + " has a malformed target member",
      );
    }
    if (seen.has(raw.target)) {
      throw new Error(
        "appearance dial " + dialId + " repeats target " + raw.target,
      );
    }
    seen.add(raw.target);
    validateTrackCoverageAndEffect(
      raw.track,
      inputRange,
      0,
      "appearance dial " + dialId + " target " + raw.target,
    );
    if (Math.abs(evaluateAppearanceDialTrack(raw.track, 0)) > ZERO_TOLERANCE) {
      throw new Error(
        "appearance dial " +
          dialId +
          " target " +
          raw.target +
          " is not neutral at zero",
      );
    }
    const target = targets[raw.target];
    if (
      target.combine === "exclusive" &&
      raw.track.some(
        ([, output]) =>
          output < target.influenceMin || output > target.influenceMax,
      )
    ) {
      throw new Error(
        "appearance dial " +
          dialId +
          " target " +
          raw.target +
          " exceeds its influence bounds",
      );
    }
    members.push({ target: raw.target, track: raw.track });
  }
  return members;
}

function parseDriverRequirements(
  value: unknown,
  context: string,
): AppearanceDriverRequirements | undefined {
  if (value === undefined) return undefined;
  if (
    !isRecord(value) ||
    !Array.isArray(value.followerRefs) ||
    value.followerRefs.length === 0 ||
    !value.followerRefs.every(isStableId) ||
    new Set(value.followerRefs).size !== value.followerRefs.length
  ) {
    throw new Error(context + " requirements are malformed");
  }
  return { followerRefs: [...value.followerRefs] as string[] };
}

function parseSideOffset(
  value: unknown,
  dialId: string,
  side: "left" | "right",
  targets: Record<string, AppearanceTargetDefinition>,
): AppearanceDialSideOffset {
  if (
    !isRecord(value) ||
    !isStableId(value.id) ||
    !isNonEmptyString(value.label) ||
    !isRange(value.range) ||
    !isFiniteNumber(value.step) ||
    value.step <= 0 ||
    value.step > value.range[1] - value.range[0]
  ) {
    throw new Error(
      "appearance dial " + dialId + " has a malformed " + side + " offset",
    );
  }
  const requirements = parseDriverRequirements(
    value.requirements,
    "appearance dial " + dialId + ":" + side,
  );
  return {
    id: value.id,
    label: value.label,
    range: value.range,
    step: value.step,
    members: parseMembers(
      value.members,
      dialId + ":" + side,
      targets,
      value.range,
    ),
    ...(requirements ? { requirements } : {}),
  };
}

function validateSymmetry(
  dial: AppearanceDialDefinition,
  targets: Record<string, AppearanceTargetDefinition>,
) {
  const symmetry = dial.symmetry;
  if (!symmetry || symmetry.mode === "none") return;
  const members = dial.members ?? [];
  const mainIds = new Set(members.map((member) => member.target));
  const mainSides = new Set(
    members.map((member) => targets[member.target].side),
  );
  const isLinkedPair =
    mainSides.has("bilateral") ||
    (mainSides.has("left") && mainSides.has("right"));
  if (!isLinkedPair) {
    throw new Error(
      "appearance dial " +
        dial.id +
        " declares linked symmetry without both sides",
    );
  }
  if (symmetry.mode !== "linked-with-offsets") return;

  const leftIds = new Set<string>();
  const rightIds = new Set<string>();
  for (const member of symmetry.left.members) {
    if (targets[member.target].side !== "left" || !mainIds.has(member.target)) {
      throw new Error(
        "appearance dial " + dial.id + " has invalid left offset ownership",
      );
    }
    leftIds.add(member.target);
  }
  for (const member of symmetry.right.members) {
    if (
      targets[member.target].side !== "right" ||
      !mainIds.has(member.target)
    ) {
      throw new Error(
        "appearance dial " + dial.id + " has invalid right offset ownership",
      );
    }
    if (leftIds.has(member.target)) {
      throw new Error(
        "appearance dial " +
          dial.id +
          " reuses one target for both side offsets",
      );
    }
    rightIds.add(member.target);
  }
  if (leftIds.size === 0 || rightIds.size === 0) {
    throw new Error(
      "appearance dial " + dial.id + " has empty side offset ownership",
    );
  }
}

export function parseDials(
  value: unknown,
  regions: AppearanceDialRegion[],
  targets: Record<string, AppearanceTargetDefinition>,
  macroEngine: AppearanceMacroEngine | undefined,
): AppearanceDialDefinition[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("avatar.json#appearanceDials has no dial definitions");
  }
  const dials: AppearanceDialDefinition[] = [];
  const valueIds = new Set<string>();
  const macroAxisOwners = new Set<AppearanceDialMacroAxis>();
  const regionsById = new Map(regions.map((region) => [region.id, region]));
  const dialSurfaces = new Set<AppearanceDialRegion["surface"]>();
  let rootScaleCount = 0;

  for (const raw of value) {
    if (
      !isRecord(raw) ||
      !isStableId(raw.id) ||
      !isNonEmptyString(raw.label) ||
      !isStableId(raw.region) ||
      !regionsById.has(raw.region) ||
      (raw.tier !== "core" &&
        raw.tier !== "detail" &&
        raw.tier !== "advanced") ||
      !isFiniteNumber(raw.order) ||
      !Number.isInteger(raw.order) ||
      typeof raw.description !== "string" ||
      !Array.isArray(raw.keywords) ||
      raw.keywords.length === 0 ||
      !raw.keywords.every(isNonEmptyString) ||
      (raw.kind !== "tracks" &&
        raw.kind !== "macro-axis" &&
        raw.kind !== "root-scale" &&
        raw.kind !== "follower-only") ||
      !isRange(raw.range) ||
      raw.default !== 0 ||
      !isFiniteNumber(raw.step) ||
      raw.step <= 0 ||
      raw.step > raw.range[1] - raw.range[0]
    ) {
      throw new Error(
        "appearance dial " +
          (isRecord(raw) ? String(raw.id ?? "") : "") +
          " is malformed",
      );
    }
    if (valueIds.has(raw.id)) {
      throw new Error(
        "appearance dial value id " + raw.id + " is declared more than once",
      );
    }
    valueIds.add(raw.id);

    const requirements = parseDriverRequirements(
      raw.requirements,
      "appearance dial " + raw.id,
    );

    const definition: AppearanceDialDefinition = {
      id: raw.id,
      label: raw.label,
      region: raw.region,
      tier: raw.tier,
      order: raw.order,
      description: raw.description,
      keywords: [...new Set(raw.keywords)],
      kind: raw.kind,
      range: raw.range,
      default: 0,
      step: raw.step,
      ...(requirements ? { requirements } : {}),
    };

    if (raw.kind === "tracks") {
      if (
        raw.axis !== undefined ||
        raw.axisTrack !== undefined ||
        raw.scalePerUnit !== undefined
      ) {
        throw new Error(
          "appearance track dial " + raw.id + " has incompatible fields",
        );
      }
      definition.members = parseMembers(
        raw.members,
        raw.id,
        targets,
        raw.range,
      );
    } else if (raw.kind === "macro-axis") {
      if (raw.members !== undefined || raw.scalePerUnit !== undefined) {
        throw new Error(
          "appearance macro dial " + raw.id + " has incompatible fields",
        );
      }
      if (
        !macroEngine ||
        !MACRO_AXES.includes(raw.axis as AppearanceDialMacroAxis) ||
        !isTrack(raw.axisTrack)
      ) {
        throw new Error("appearance macro dial " + raw.id + " is malformed");
      }
      const axis = raw.axis as AppearanceDialMacroAxis;
      if (macroAxisOwners.has(axis)) {
        throw new Error(
          "appearance macro axis " + axis + " has multiple dials",
        );
      }
      macroAxisOwners.add(axis);
      validateTrackCoverageAndEffect(
        raw.axisTrack,
        raw.range,
        macroEngine.baselineState[axis],
        "appearance macro dial " + raw.id,
      );
      validateMacroDialEffect(
        raw.axisTrack,
        raw.range,
        axis,
        macroEngine,
        raw.id,
      );
      if (
        Math.abs(
          evaluateAppearanceDialTrack(raw.axisTrack, 0) -
            macroEngine.baselineState[axis],
        ) > ZERO_TOLERANCE
      ) {
        throw new Error(
          "appearance macro dial " +
            raw.id +
            " is not centered on baselineState",
        );
      }
      definition.axis = axis;
      definition.axisTrack = raw.axisTrack;
    } else if (raw.kind === "follower-only") {
      if (
        raw.members !== undefined ||
        raw.axis !== undefined ||
        raw.axisTrack !== undefined ||
        raw.scalePerUnit !== undefined
      ) {
        throw new Error(
          "appearance follower-only dial " +
            raw.id +
            " has incompatible fields",
        );
      }
      if (!requirements) {
        throw new Error(
          "appearance follower-only dial " +
            raw.id +
            " requires one or more followerRefs",
        );
      }
    } else {
      if (
        raw.members !== undefined ||
        raw.axis !== undefined ||
        raw.axisTrack !== undefined
      ) {
        throw new Error(
          "appearance root-scale dial " + raw.id + " has incompatible fields",
        );
      }
      rootScaleCount += 1;
      if (
        !isFiniteNumber(raw.scalePerUnit) ||
        Math.abs(raw.scalePerUnit) <= ZERO_TOLERANCE
      ) {
        throw new Error(
          "appearance root-scale dial " +
            raw.id +
            " requires an effective scalePerUnit",
        );
      }
      const lowScale = 1 + raw.scalePerUnit * raw.range[0];
      const highScale = 1 + raw.scalePerUnit * raw.range[1];
      if (!Number.isFinite(lowScale) || !Number.isFinite(highScale)) {
        throw new Error(
          "appearance root-scale dial " +
            raw.id +
            " produces a non-finite endpoint scale",
        );
      }
      if (lowScale <= 0 || highScale <= 0) {
        throw new Error(
          "appearance root-scale dial " +
            raw.id +
            " may collapse or invert the avatar",
        );
      }
      definition.scalePerUnit = raw.scalePerUnit;
    }

    if (raw.symmetry !== undefined) {
      if (raw.kind !== "tracks") {
        throw new Error(
          "appearance dial " +
            raw.id +
            " may declare symmetry only for target tracks",
        );
      }
      if (
        !isRecord(raw.symmetry) ||
        (raw.symmetry.mode !== "none" &&
          raw.symmetry.mode !== "linked" &&
          raw.symmetry.mode !== "linked-with-offsets")
      ) {
        throw new Error(
          "appearance dial " + raw.id + " has malformed symmetry metadata",
        );
      }
      if (raw.symmetry.mode === "linked-with-offsets") {
        const left = parseSideOffset(
          raw.symmetry.left,
          raw.id,
          "left",
          targets,
        );
        const right = parseSideOffset(
          raw.symmetry.right,
          raw.id,
          "right",
          targets,
        );
        for (const side of [left, right]) {
          if (valueIds.has(side.id)) {
            throw new Error(
              "appearance side value id " +
                side.id +
                " is declared more than once",
            );
          }
          valueIds.add(side.id);
        }
        definition.symmetry = { mode: "linked-with-offsets", left, right };
      } else {
        definition.symmetry = { mode: raw.symmetry.mode };
      }
    }
    validateSymmetry(definition, targets);
    dials.push(definition);
    dialSurfaces.add(regionsById.get(definition.region)!.surface);
  }
  if (rootScaleCount > 1) {
    throw new Error("appearance-dials/v2 allows only one root-scale dial");
  }
  if (macroEngine) {
    const missing = MACRO_AXES.filter((axis) => !macroAxisOwners.has(axis));
    if (missing.length > 0) {
      throw new Error(
        "appearance macro engine requires exactly one dial for every axis; missing: " +
          missing.join(", "),
      );
    }
  }
  for (const surface of ["body", "head-face"] as const) {
    if (!dialSurfaces.has(surface)) {
      throw new Error(
        "appearance-dials/v2 requires at least one dial on the " +
          surface +
          " surface",
      );
    }
  }
  return dials;
}

export function validateOwnership(
  dials: AppearanceDialDefinition[],
  targets: Record<string, AppearanceTargetDefinition>,
  macroEngine: AppearanceMacroEngine | undefined,
) {
  const owners = new Map<string, Set<string>>();
  const addOwner = (target: string, owner: string) => {
    const current = owners.get(target) ?? new Set<string>();
    current.add(owner);
    owners.set(target, current);
  };
  for (const dial of dials) {
    for (const member of dial.members ?? []) addOwner(member.target, dial.id);
    if (dial.symmetry?.mode === "linked-with-offsets") {
      for (const member of dial.symmetry.left.members) {
        addOwner(member.target, dial.symmetry.left.id);
      }
      for (const member of dial.symmetry.right.members) {
        addOwner(member.target, dial.symmetry.right.id);
      }
    }
  }
  for (const corner of macroEngine?.corners ?? []) {
    addOwner(corner.target, "macro:" + corner.family);
  }
  for (const [targetId, target] of Object.entries(targets)) {
    const targetOwners = owners.get(targetId) ?? new Set<string>();
    if (targetOwners.size === 0) {
      throw new Error("appearance target " + targetId + " is unowned");
    }
    if (target.combine === "exclusive" && targetOwners.size !== 1) {
      throw new Error(
        "exclusive appearance target " +
          targetId +
          " has multiple owners: " +
          [...targetOwners].join(", "),
      );
    }
  }
}
