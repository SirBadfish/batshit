import type {
  AppearanceFollowerDriverRef,
  AppearanceQuat,
  AppearanceVec3,
  ResolvedAppearanceDialState,
} from "../appearanceDials.contracts";

export const APPEARANCE_RECIPE_PHYSICAL_SNAPSHOT_CONTRACT =
  "appearance-recipe-physical-snapshot/v1" as const;

export type AppearanceRecipePhysicalSnapshot = {
  contract: typeof APPEARANCE_RECIPE_PHYSICAL_SNAPSHOT_CONTRACT;
  influences: Array<{ target: string; weight: number }>;
  jointOffsets: Array<{ bone: string; translation: AppearanceVec3 }>;
  followerInputs: Array<{
    follower: string;
    driver: string;
    input: number;
  }>;
  followerNodeTransforms: Array<{
    follower: string;
    channel: string;
    driver: AppearanceFollowerDriverRef;
    node: string;
    translation: AppearanceVec3;
    rotation: AppearanceQuat;
    scale: AppearanceVec3;
    pivot: AppearanceVec3;
  }>;
  followerMorphs: Array<{
    follower: string;
    channel: string;
    driver: AppearanceFollowerDriverRef;
    node: string;
    morph: string;
    weight: number;
    runtimeRetention: "recipe-only";
  }>;
  rootScale: number;
  soleOffsetY: number;
};

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizedFinite(value: number, context: string): number {
  if (!Number.isFinite(value)) {
    throw new Error(`${context} must be finite`);
  }
  return Object.is(value, -0) ? 0 : value;
}

function vec3(value: AppearanceVec3, context: string): AppearanceVec3 {
  return [
    normalizedFinite(value[0], `${context}[0]`),
    normalizedFinite(value[1], `${context}[1]`),
    normalizedFinite(value[2], `${context}[2]`),
  ];
}

function quat(value: AppearanceQuat, context: string): AppearanceQuat {
  return [
    normalizedFinite(value[0], `${context}[0]`),
    normalizedFinite(value[1], `${context}[1]`),
    normalizedFinite(value[2], `${context}[2]`),
    normalizedFinite(value[3], `${context}[3]`),
  ];
}

function nodeTransformKey(
  value: ResolvedAppearanceDialState["followerState"]["nodeTransforms"][number],
): string {
  return [
    value.follower,
    value.channel,
    value.node,
    value.driver.kind,
    value.driver.id,
  ].join("\u0000");
}

function morphKey(
  value: ResolvedAppearanceDialState["followerState"]["morphs"][number],
): string {
  return [
    value.follower,
    value.channel,
    value.node,
    value.morph,
    value.driver.kind,
    value.driver.id,
  ].join("\u0000");
}

/**
 * Captures the complete package-independent physical output already resolved
 * by Appearance Dials v2. The ordered snapshot is the R0 parity oracle shared
 * by future migration and bake work; it deliberately excludes presentation
 * metadata and saved input values.
 */
export function snapshotAppearanceRecipePhysicalOutput(
  resolved: ResolvedAppearanceDialState,
): AppearanceRecipePhysicalSnapshot {
  const influences = [...resolved.influences]
    .sort(([left], [right]) => compareText(left, right))
    .map(([target, weight]) => ({
      target,
      weight: normalizedFinite(weight, `influence ${target}`),
    }));

  const jointOffsets = [...resolved.jointOffsets]
    .sort(([left], [right]) => compareText(left, right))
    .map(([bone, translation]) => ({
      bone,
      translation: vec3(translation, `joint ${bone}`),
    }));

  const followerInputs = [...resolved.followerInputs]
    .sort(([left], [right]) => compareText(left, right))
    .flatMap(([follower, inputs]) =>
      [...inputs]
        .sort(([left], [right]) => compareText(left, right))
        .map(([driver, input]) => ({
          follower,
          driver,
          input: normalizedFinite(
            input,
            `follower input ${follower}/${driver}`,
          ),
        })),
    );

  const followerNodeTransforms = [...resolved.followerState.nodeTransforms]
    .sort((left, right) =>
      compareText(nodeTransformKey(left), nodeTransformKey(right)),
    )
    .map((value) => ({
      follower: value.follower,
      channel: value.channel,
      driver: { ...value.driver },
      node: value.node,
      translation: vec3(
        value.translation,
        `follower node ${value.follower}/${value.channel} translation`,
      ),
      rotation: quat(
        value.rotation,
        `follower node ${value.follower}/${value.channel} rotation`,
      ),
      scale: vec3(
        value.scale,
        `follower node ${value.follower}/${value.channel} scale`,
      ),
      pivot: vec3(
        value.pivot,
        `follower node ${value.follower}/${value.channel} pivot`,
      ),
    }));

  const followerMorphs = [...resolved.followerState.morphs]
    .sort((left, right) => compareText(morphKey(left), morphKey(right)))
    .map((value) => ({
      follower: value.follower,
      channel: value.channel,
      driver: { ...value.driver },
      node: value.node,
      morph: value.morph,
      weight: normalizedFinite(
        value.weight,
        `follower morph ${value.follower}/${value.channel}`,
      ),
      runtimeRetention: value.runtimeRetention,
    }));

  return {
    contract: APPEARANCE_RECIPE_PHYSICAL_SNAPSHOT_CONTRACT,
    influences,
    jointOffsets,
    followerInputs,
    followerNodeTransforms,
    followerMorphs,
    rootScale: normalizedFinite(resolved.rootScale, "root scale"),
    soleOffsetY: normalizedFinite(resolved.soleOffsetY, "sole offset"),
  };
}
