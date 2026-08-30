import * as THREE from "three";
import { describe, expect, it } from "vitest";
import type { AppearanceRecipePhysicalSnapshot } from "./appearanceRecipeSnapshot";
import type { AppearanceRecipePhysicalEvaluation } from "./appearanceRecipePhysicalEvaluator";
import {
  APPEARANCE_RECIPE_PHYSICAL_PROOF_TOLERANCES,
  AppearanceRecipePhysicalInventoryMismatchError,
  appearanceRecipePhysicalProofKeyInventory,
  compareAppearanceRecipePhysicalProof,
  compareAppearanceRecipeRelativeComponentEffects,
  projectAppearanceRecipeAbsoluteProof,
  projectAppearanceRecipeLogicalProof,
  projectAppearanceRecipeRelativeComponentEffect,
  type AppearanceRecipePhysicalProofInput,
  type AppearanceRecipePhysicalCorrespondence,
} from "./appearanceRecipePhysicalProof";

const matrix = (
  position: [number, number, number] = [0, 0, 0],
  rotation: [number, number, number, number] = [0, 0, 0, 1],
  scale: [number, number, number] = [1, 1, 1],
): number[] =>
  new THREE.Matrix4()
    .compose(
      new THREE.Vector3(...position),
      new THREE.Quaternion(...rotation),
      new THREE.Vector3(...scale),
    )
    .toArray();

function logical(): AppearanceRecipePhysicalSnapshot {
  return {
    contract: "appearance-recipe-physical-snapshot/v1",
    influences: [
      { target: "shape_a", weight: 0.25 },
      { target: "shape_b", weight: 0 },
    ],
    jointOffsets: [{ bone: "Hips", translation: [0, 0.1, 0] }],
    followerInputs: [
      { follower: "fit", driver: "target:shape_a", input: 0.25 },
    ],
    followerNodeTransforms: [
      {
        follower: "fit",
        channel: "anchor",
        driver: { kind: "target", id: "shape_a" },
        node: "attachment",
        translation: [0.1, 0, 0],
        rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2],
        scale: [1, 1.1, 1],
        pivot: [0.01, 0, 0],
      },
    ],
    followerMorphs: [
      {
        follower: "fit",
        channel: "surface",
        driver: { kind: "target", id: "shape_a" },
        node: "body",
        morph: "fit_surface",
        weight: 0.25,
        runtimeRetention: "recipe-only",
      },
    ],
    rootScale: 1.05,
    soleOffsetY: 0.02,
  };
}

function absolute(ids = "a"): AppearanceRecipePhysicalEvaluation {
  const rootId = `node-root-${ids}`;
  const hipsId = `node-hips-${ids}`;
  const bodyId = `node-body-${ids}`;
  const attachmentId = `node-attachment-${ids}`;
  const boneId = `bone-hips-${ids}`;
  const root = matrix([0, -0.021, 0], [0, 0, 0, 1], [1.05, 1.05, 1.05]);
  const hipsLocal = matrix([0, 1.1, 0]);
  const hipsRootRelative = hipsLocal;
  const hipsWorld = new THREE.Matrix4()
    .fromArray(root)
    .multiply(new THREE.Matrix4().fromArray(hipsRootRelative))
    .toArray();
  const bodyLocal = matrix();
  const bodyWorld = new THREE.Matrix4()
    .fromArray(root)
    .multiply(new THREE.Matrix4().fromArray(bodyLocal))
    .toArray();
  const attachmentLocal = matrix([0.1, 0, 0]);
  const attachmentWorld = new THREE.Matrix4()
    .fromArray(root)
    .multiply(new THREE.Matrix4().fromArray(attachmentLocal))
    .toArray();
  return {
    contract: "appearance-recipe-physical-evaluation/v1",
    meshes: [
      {
        id: `mesh-body-${ids}`,
        nodeId: bodyId,
        positions: new Float32Array([0, 0, 0, 1, 0, 0]),
      },
      {
        id: `mesh-eye-${ids}`,
        nodeId: attachmentId,
        positions: new Float32Array([0, 1, 0]),
      },
    ],
    retainedTargetPositionBindings: [
      {
        id: `retained-${ids}`,
        targetId: "blink",
        node: "body",
        morph: "blink",
        meshId: `mesh-body-${ids}`,
        positionDelta: new Float32Array([0, 0.1, 0, 0, 0.1, 0]),
        weight: 0.2,
      },
    ],
    followerMorphWeights: [
      {
        follower: "fit",
        channel: "surface",
        driver: { kind: "target", id: "shape_a" },
        node: "body",
        morph: "fit_surface",
        weight: 0.25,
      },
    ],
    jointRests: [
      {
        boneId,
        bone: "Hips",
        nodeId: hipsId,
        avatarRootOffset: [0, 0.1, 0],
        baseLocalPosition: [0, 1, 0],
        localPosition: [0, 1.1, 0],
        localMatrix: hipsLocal,
      },
    ],
    skins: [
      {
        id: `skin-body-${ids}`,
        joints: [{ boneId, inverseBindMatrix: matrix([0, -1.1, 0]) }],
      },
    ],
    root: {
      matrix: root,
      position: [0, -0.021, 0],
      rotation: [0, 0, 0, 1],
      scale: [1.05, 1.05, 1.05],
      rootScale: 1.05,
      soleOffsetY: 0.02,
    },
    nodes: [
      {
        id: rootId,
        localMatrix: matrix(),
        rootRelativeMatrix: matrix(),
        worldMatrix: root,
      },
      {
        id: hipsId,
        parentId: rootId,
        localMatrix: hipsLocal,
        rootRelativeMatrix: hipsRootRelative,
        worldMatrix: hipsWorld,
      },
      {
        id: bodyId,
        parentId: rootId,
        localMatrix: bodyLocal,
        rootRelativeMatrix: bodyLocal,
        worldMatrix: bodyWorld,
      },
      {
        id: attachmentId,
        parentId: rootId,
        localMatrix: attachmentLocal,
        rootRelativeMatrix: attachmentLocal,
        worldMatrix: attachmentWorld,
      },
    ],
    roles: [
      {
        kind: "attachment",
        id: "hat",
        nodeId: attachmentId,
        declaredParent: { kind: "node", id: "root" },
        rootRelativeMatrix: attachmentLocal,
        worldMatrix: attachmentWorld,
        worldPosition: new THREE.Vector3()
          .setFromMatrixPosition(new THREE.Matrix4().fromArray(attachmentWorld))
          .toArray(),
      },
    ],
    hipsClipRemap: {
      boneId,
      bone: "Hips",
      baseRest: [0, 1, 0],
      newRest: [0, 1.1, 0],
      ratio: 1.1,
    },
  };
}

function correspondence(ids = "a"): AppearanceRecipePhysicalCorrespondence {
  return {
    meshes: {
      [`mesh-body-${ids}`]: "Body/primitive:body",
      [`mesh-eye-${ids}`]: "Eye/primitive:eye",
    },
    nodes: {
      [`node-root-${ids}`]: "Root",
      [`node-hips-${ids}`]: "Hips",
      [`node-body-${ids}`]: "Body",
      [`node-attachment-${ids}`]: "HatAnchor",
    },
    bones: { [`bone-hips-${ids}`]: "Hips" },
    skins: { [`skin-body-${ids}`]: "Body/skin:Hips" },
  };
}

function input(ids = "a"): AppearanceRecipePhysicalProofInput {
  return {
    logical: logical(),
    absolute: absolute(ids),
    correspondence: correspondence(ids),
  };
}

const clone = <T>(value: T): T => structuredClone(value);

describe("appearance Recipe physical proof", () => {
  it("canonicalizes array order and package-local GLB ids through semantic correspondence", async () => {
    const first = input("a");
    const reordered = input("z");
    reordered.logical.influences.reverse();
    reordered.logical.followerMorphs.reverse();
    reordered.absolute.meshes.reverse();
    reordered.absolute.nodes.reverse();

    const comparison = await compareAppearanceRecipePhysicalProof(
      first,
      reordered,
    );
    expect(comparison.matches).toBe(true);
    expect(comparison.errors).toEqual({
      scalarMaximum: 0,
      positionMaximumMeters: 0,
      positionRmsMeters: 0,
      scaleMaximum: 0,
      quaternionMaximumRadians: 0,
      matrixMaximum: 0,
      bakedPositionMaximumMeters: 0,
      bakedPositionRmsMeters: 0,
    });
    expect(comparison.sourceLogicalOutputSha256).toBe(
      comparison.targetLogicalOutputSha256,
    );
    expect(comparison.sourceAbsoluteOutputSha256).toBe(
      comparison.targetAbsoluteOutputSha256,
    );
  });

  it("canonicalizes quaternion sign and measures a robust sign-aligned angle", async () => {
    const source = input();
    const target = clone(source);
    target.logical.followerNodeTransforms[0]!.rotation = [
      0,
      0,
      -Math.SQRT1_2,
      -Math.SQRT1_2,
    ];
    target.absolute.root.rotation = [0, 0, 0, -1];

    const comparison = await compareAppearanceRecipePhysicalProof(
      source,
      target,
    );
    expect(comparison.matches).toBe(true);
    expect(comparison.errors.quaternionMaximumRadians).toBe(0);
    await expect(
      projectAppearanceRecipeLogicalProof(source.logical),
    ).resolves.toEqual(
      await projectAppearanceRecipeLogicalProof(target.logical),
    );

    target.logical.followerNodeTransforms[0]!.rotation = [
      0,
      0,
      Math.sin(0.000002 / 2),
      Math.cos(0.000002 / 2),
    ];
    const changed = await compareAppearanceRecipePhysicalProof(source, target);
    expect(changed.matches).toBe(false);
    expect(changed.errors.quaternionMaximumRadians).toBeGreaterThan(1e-6);
    expect(changed.mismatchDomains).toContain("rest");
  });

  it("excludes resolver intermediates when final physical outputs are unchanged", async () => {
    const source = input();
    const remapped = clone(source);
    remapped.logical.jointOffsets[0]!.translation = [9, 8, 7];
    remapped.logical.followerInputs[0]!.input = 0.75;

    const comparison = await compareAppearanceRecipePhysicalProof(
      source,
      remapped,
    );
    expect(comparison.matches).toBe(true);
    expect(comparison.sourceLogicalOutputSha256).toBe(
      comparison.targetLogicalOutputSha256,
    );
  });

  it("uses Euclidean vertex max/RMS over exact Float32 POSITION order", async () => {
    const source = input();
    const target = clone(source);
    const positions = target.absolute.meshes[0]!.positions;
    positions[0] = 3e-6;
    positions[4] = 4e-6;

    const comparison = await compareAppearanceRecipePhysicalProof(
      source,
      target,
    );
    expect(comparison.matches).toBe(false);
    expect(comparison.errors.bakedPositionMaximumMeters).toBeCloseTo(4e-6, 10);
    expect(comparison.errors.bakedPositionRmsMeters).toBeCloseTo(
      Math.sqrt((Math.fround(3e-6) ** 2 + Math.fround(4e-6) ** 2) / 3),
      10,
    );
    expect(comparison.mismatchDomains).toEqual(["geometry"]);

    const swapped = clone(source.absolute);
    [swapped.meshes[0]!.positions[0], swapped.meshes[0]!.positions[3]] = [
      swapped.meshes[0]!.positions[3]!,
      swapped.meshes[0]!.positions[0]!,
    ];
    expect(
      (
        await projectAppearanceRecipeAbsoluteProof(
          source.absolute,
          source.correspondence,
        )
      ).projectionSha256,
    ).not.toBe(
      (
        await projectAppearanceRecipeAbsoluteProof(
          swapped,
          source.correspondence,
        )
      ).projectionSha256,
    );
  });

  it("reports pivot distance and upper-3x3 matrix residual independently", async () => {
    const source = input();
    const target = clone(source);
    target.logical.followerNodeTransforms[0]!.pivot[0] += 3e-6;
    target.absolute.nodes.find(
      (entry) => entry.id === "node-body-a",
    )!.localMatrix[4] = 2e-6;

    const comparison = await compareAppearanceRecipePhysicalProof(
      source,
      target,
    );
    expect(comparison.matches).toBe(false);
    expect(comparison.errors.positionMaximumMeters).toBeCloseTo(3e-6, 10);
    expect(comparison.errors.matrixMaximum).toBeCloseTo(2e-6, 10);
    expect(comparison.mismatchDomains).toEqual(["pivot", "rest"]);
  });

  it("rejects missing, renamed, or differently sized physical inventory", async () => {
    const source = input();
    const renamed = input();
    renamed.correspondence.meshes["mesh-eye-a"] = "DifferentEye";
    await expect(
      compareAppearanceRecipePhysicalProof(source, renamed),
    ).rejects.toBeInstanceOf(AppearanceRecipePhysicalInventoryMismatchError);

    const resized = input();
    resized.absolute.meshes[0]!.positions = new Float32Array([0, 0, 0]);
    await expect(
      compareAppearanceRecipePhysicalProof(source, resized),
    ).rejects.toThrow(/inventory mismatch/);

    const incomplete = input();
    delete incomplete.correspondence.nodes["node-body-a"];
    await expect(
      compareAppearanceRecipePhysicalProof(source, incomplete),
    ).rejects.toThrow(/must exhaust the physical inventory/);
  });

  it("projects selectable neutral-relative component effects deterministically", async () => {
    const baseline = input();
    const evaluated = clone(baseline);
    evaluated.logical.rootScale = 1.15;
    evaluated.absolute.root.rootScale = 1.15;
    evaluated.absolute.meshes[0]!.positions[1] = 0.25;
    const inventory = appearanceRecipePhysicalProofKeyInventory(baseline);
    const logicalRoot = inventory.logicalKeys.find((entry) =>
      entry.includes('"root","scale"'),
    )!;
    const absoluteMesh = inventory.absoluteKeys.find((entry) =>
      entry.includes('"Body/primitive:body"'),
    )!;

    const first = await projectAppearanceRecipeRelativeComponentEffect(
      baseline,
      evaluated,
      { logicalKeys: [logicalRoot], absoluteKeys: [absoluteMesh] },
    );
    const second = await projectAppearanceRecipeRelativeComponentEffect(
      baseline,
      evaluated,
      { absoluteKeys: [absoluteMesh], logicalKeys: [logicalRoot] },
    );
    expect(first).toEqual(second);
    expect(first.logical.inventory).toEqual([logicalRoot]);
    expect(first.absolute.inventory).toEqual([absoluteMesh]);

    await expect(
      projectAppearanceRecipeRelativeComponentEffect(baseline, evaluated, {
        logicalKeys: ["missing"],
      }),
    ).rejects.toThrow(/unknown key/);
  });

  it("compares source and target neutral-relative component effects numerically", async () => {
    const sourceBaseline = input("a");
    const sourceEvaluated = clone(sourceBaseline);
    sourceEvaluated.logical.rootScale += 0.1;
    sourceEvaluated.absolute.root.rootScale += 0.1;
    sourceEvaluated.absolute.meshes[0]!.positions[1] = 0.2;

    const targetBaseline = input("z");
    targetBaseline.logical.rootScale = 1.2;
    targetBaseline.absolute.root.rootScale = 1.2;
    targetBaseline.absolute.meshes[0]!.positions[1] = 1;
    const targetEvaluated = clone(targetBaseline);
    targetEvaluated.logical.rootScale += 0.1;
    targetEvaluated.absolute.root.rootScale += 0.1;
    targetEvaluated.absolute.meshes[0]!.positions[1] = 1.2;

    const inventory = appearanceRecipePhysicalProofKeyInventory(sourceBaseline);
    const logicalRoot = inventory.logicalKeys.find((entry) =>
      entry.includes('"root","scale"'),
    )!;
    const absoluteMesh = inventory.absoluteKeys.find((entry) =>
      entry.includes('"Body/primitive:body"'),
    )!;
    const sameEffect = await compareAppearanceRecipeRelativeComponentEffects(
      sourceBaseline,
      sourceEvaluated,
      targetBaseline,
      targetEvaluated,
      { logicalKeys: [logicalRoot], absoluteKeys: [absoluteMesh] },
    );
    expect(sameEffect.matches).toBe(true);
    expect(sameEffect.sourceLogicalEffectSha256).toBe(
      sameEffect.targetLogicalEffectSha256,
    );
    expect(sameEffect.sourceAbsoluteEffectSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(sameEffect.targetAbsoluteEffectSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(sameEffect.comparedAbsoluteKeysSha256).toMatch(/^[a-f0-9]{64}$/);

    targetEvaluated.absolute.meshes[0]!.positions[1] = 1.20001;
    const different = await compareAppearanceRecipeRelativeComponentEffects(
      sourceBaseline,
      sourceEvaluated,
      targetBaseline,
      targetEvaluated,
      { logicalKeys: [logicalRoot], absoluteKeys: [absoluteMesh] },
    );
    expect(different.matches).toBe(false);
    expect(different.mismatchDomains).toEqual(["geometry"]);
    expect(different.mismatchChannelKeys).toEqual([absoluteMesh]);
    expect(different.errors.bakedPositionMaximumMeters).toBeGreaterThan(1e-6);
  });

  it("compares relative rotations rather than package-specific absolute rests", async () => {
    const sourceBaseline = input("a");
    const sourceEvaluated = clone(sourceBaseline);
    sourceBaseline.logical.followerNodeTransforms[0]!.rotation = [0, 0, 0, 1];
    sourceEvaluated.logical.followerNodeTransforms[0]!.rotation = [
      0,
      0,
      Math.SQRT1_2,
      Math.SQRT1_2,
    ];
    const targetBaseline = input("z");
    const targetEvaluated = clone(targetBaseline);
    targetBaseline.logical.followerNodeTransforms[0]!.rotation = [
      0,
      0,
      Math.SQRT1_2,
      Math.SQRT1_2,
    ];
    targetEvaluated.logical.followerNodeTransforms[0]!.rotation = [0, 0, 1, 0];
    const rotationKey = appearanceRecipePhysicalProofKeyInventory(
      sourceBaseline,
    ).logicalKeys.find((entry) => entry.includes('"rotation"'))!;

    const comparison = await compareAppearanceRecipeRelativeComponentEffects(
      sourceBaseline,
      sourceEvaluated,
      targetBaseline,
      targetEvaluated,
      { logicalKeys: [rotationKey], absoluteKeys: [] },
    );
    expect(comparison.matches).toBe(true);
    expect(comparison.errors.quaternionMaximumRadians).toBeLessThan(1e-15);
    expect(comparison.sourceLogicalEffectSha256).toBe(
      comparison.targetLogicalEffectSha256,
    );
  });

  it("uses locked inclusive thresholds and rejects invalid tolerances", async () => {
    const source = input();
    const within = clone(source);
    within.logical.influences[1]!.weight =
      APPEARANCE_RECIPE_PHYSICAL_PROOF_TOLERANCES.scalar;
    expect(
      (await compareAppearanceRecipePhysicalProof(source, within)).matches,
    ).toBe(true);

    const over = clone(source);
    over.logical.influences[1]!.weight =
      APPEARANCE_RECIPE_PHYSICAL_PROOF_TOLERANCES.scalar * 1.01;
    expect(
      (await compareAppearanceRecipePhysicalProof(source, over)).matches,
    ).toBe(false);

    await expect(
      compareAppearanceRecipePhysicalProof(source, source, {
        ...APPEARANCE_RECIPE_PHYSICAL_PROOF_TOLERANCES,
        matrix: 0,
      }),
    ).rejects.toThrow(/matrix tolerance must be positive/);
  });
});
