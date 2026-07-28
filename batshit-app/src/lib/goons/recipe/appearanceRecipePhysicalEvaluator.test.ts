import * as THREE from "three";
import { describe, expect, it } from "vitest";
import type {
  AppearanceQuat,
  AppearanceVec3,
  ResolvedAppearanceDialState,
  ResolvedAppearanceFollowerNodeTransform,
} from "../appearanceDials.contracts";
import {
  APPEARANCE_RECIPE_PHYSICAL_BASIS_CONTRACT,
  evaluateAppearanceRecipePhysicalOutput,
  validateAppearanceRecipePhysicalBasis,
  type AppearanceRecipePhysicalBasis,
  type AppearanceRecipePositionDelta,
} from "./appearanceRecipePhysicalEvaluator";
import type { AnatomyFitResult } from "./anatomyFitContracts";

const IDENTITY_QUAT: AppearanceQuat = [0, 0, 0, 1];
const ONE: AppearanceVec3 = [1, 1, 1];
const ZERO: AppearanceVec3 = [0, 0, 0];

function trs(
  position: AppearanceVec3 = ZERO,
  rotation: AppearanceQuat = IDENTITY_QUAT,
  scale: AppearanceVec3 = ONE,
): number[] {
  return new THREE.Matrix4()
    .compose(
      new THREE.Vector3(...position),
      new THREE.Quaternion(...rotation),
      new THREE.Vector3(...scale),
    )
    .toArray();
}

function lazyDelta(values: readonly number[]): AppearanceRecipePositionDelta {
  return {
    length: values.length,
    visit(visitor) {
      values.forEach((value, index) => visitor(index, value));
    },
  };
}

function basis(): AppearanceRecipePhysicalBasis {
  const quarterTurn: AppearanceQuat = [0, 0, Math.SQRT1_2, Math.SQRT1_2];
  return {
    contract: APPEARANCE_RECIPE_PHYSICAL_BASIS_CONTRACT,
    rootBaseMatrix: trs([10, 5, -2], IDENTITY_QUAT, [2, 3, 4]),
    meshes: [
      {
        id: "body",
        nodeId: "body",
        basePositions: new Float32Array([0.1, -0.2, 1_000_000]),
      },
    ],
    targets: [
      { id: "shape_a", runtimeRetention: "recipe-only" },
      { id: "shape_b", runtimeRetention: "recipe-only" },
      { id: "live_corrective", runtimeRetention: "retain-in-live-goon" },
    ],
    targetPositionBindings: [
      {
        id: "shape_a/body",
        targetId: "shape_a",
        meshId: "body",
        positionDelta: new Float32Array([0.2, 0.3, 0.4]),
      },
      {
        id: "shape_b/body",
        targetId: "shape_b",
        meshId: "body",
        // Visitor-backed deltas let the GLB adapter stay lazy for the real
        // 418-target source without changing contribution order.
        positionDelta: lazyDelta([-0.1, 0.4, 10]),
      },
    ],
    retainedTargetPositionBindings: [
      {
        id: "live_corrective/body",
        targetId: "live_corrective",
        node: "body_node",
        morph: "live_corrective",
        meshId: "body",
        positionDelta: new Float32Array([0.11, 0.12, 0.13]),
      },
    ],
    followerMorphPositionBindings: [
      {
        id: "fit/surface/body",
        follower: "fit",
        channel: "surface",
        node: "body_node",
        morph: "fit_surface",
        meshId: "body",
        positionDelta: new Float32Array([0.05, -0.2, 1]),
      },
    ],
    followerMorphBindings: [
      {
        follower: "fit",
        channel: "surface",
        driver: { kind: "dial", id: "fit_control" },
        node: "body_node",
        morph: "fit_surface",
        positionBindingIds: ["fit/surface/body"],
      },
      {
        follower: "optional",
        channel: "missing_surface",
        driver: { kind: "target", id: "shape_a" },
        node: "optional_node",
        morph: "missing_surface",
      },
    ],
    nodes: [
      { id: "body", baseLocalMatrix: trs() },
      {
        id: "pelvis_node",
        baseLocalMatrix: trs([0, 1, 0], quarterTurn),
      },
      {
        id: "head_node",
        parentId: "pelvis_node",
        baseLocalMatrix: trs([1, 0, 0]),
      },
      {
        id: "attachment_node",
        parentId: "head_node",
        baseLocalMatrix: trs([0, 0, 1]),
      },
      { id: "fit_node", baseLocalMatrix: trs([1, 0, 0]) },
      {
        id: "stage_node",
        parentId: "fit_node",
        baseLocalMatrix: trs([0, 1, 0]),
      },
      {
        id: "eye_node",
        parentId: "head_node",
        baseLocalMatrix: trs([0, 0.5, 0]),
      },
    ],
    followerNodeBindings: [
      { id: "body_node", nodeId: "body" },
      { id: "fit_anchor", nodeId: "fit_node" },
    ],
    followerNodeTransformBindings: [
      {
        follower: "fit",
        channel: "a_scale",
        driver: { kind: "dial", id: "fit_control" },
        node: "fit_anchor",
        nodeId: "fit_node",
      },
      {
        follower: "fit",
        channel: "b_rotate",
        driver: { kind: "dial", id: "fit_control" },
        node: "fit_anchor",
        nodeId: "fit_node",
      },
      {
        follower: "fit",
        channel: "c_translate",
        driver: { kind: "dial", id: "fit_control" },
        node: "fit_anchor",
        nodeId: "fit_node",
      },
      {
        follower: "optional",
        channel: "missing_transform",
        driver: { kind: "target", id: "shape_a" },
        node: "optional_node",
      },
    ],
    bones: [
      { id: "pelvis", name: "mixamorig:Hips", nodeId: "pelvis_node" },
      { id: "head", name: "Head", nodeId: "head_node" },
    ],
    skins: [
      {
        id: "body_skin",
        // Deliberately child-first: output must preserve GLB joint slots.
        joints: [
          { boneId: "head", baseInverseBindMatrix: trs() },
          { boneId: "pelvis", baseInverseBindMatrix: trs() },
        ],
      },
    ],
    jointOffsetBindings: [
      { bone: "mixamorigHips", boneId: "pelvis" },
      { bone: "Head", boneId: "head" },
    ],
    roles: [
      {
        kind: "attachment",
        id: "hat",
        nodeId: "attachment_node",
        declaredParent: { kind: "bone", name: "Head" },
      },
      { kind: "stage", id: "head", nodeId: "stage_node" },
      { kind: "performance", id: "hips", nodeId: "pelvis_node" },
      { kind: "eye", id: "left", nodeId: "eye_node" },
    ],
    hipsBone: "mixamorigHips",
  };
}

function transform(
  channel: string,
  translation: AppearanceVec3,
  rotation: AppearanceQuat,
  scale: AppearanceVec3,
  pivot: AppearanceVec3,
): ResolvedAppearanceFollowerNodeTransform {
  return {
    follower: "fit",
    channel,
    driver: { kind: "dial", id: "fit_control" },
    node: "fit_anchor",
    translation,
    rotation,
    scale,
    pivot,
  };
}

function state(active: boolean): ResolvedAppearanceDialState {
  const quarterTurn: AppearanceQuat = [0, 0, Math.SQRT1_2, Math.SQRT1_2];
  return {
    values: {},
    unlockedDialIds: new Set(),
    influences: new Map([
      ["shape_a", active ? 0.3 : 0],
      ["shape_b", active ? 0.7 : 0],
      ["live_corrective", active ? 0.4 : 0],
    ]),
    jointOffsets: new Map([
      ["mixamorigHips", active ? [1, 0.5, 0] : [0, 0, 0]],
      ["Head", active ? [1, 1.5, 0] : [0, 0, 0]],
    ] as Array<[string, AppearanceVec3]>),
    followerInputs: new Map(),
    followerState: {
      nodeTransforms: active
        ? [
            transform("a_scale", ZERO, IDENTITY_QUAT, [2, 1, 1], [0.5, 0, 0]),
            transform("b_rotate", ZERO, quarterTurn, ONE, ZERO),
            transform("c_translate", [0.25, 0, 0], IDENTITY_QUAT, ONE, ZERO),
            {
              follower: "optional",
              channel: "missing_transform",
              driver: { kind: "target", id: "shape_a" },
              node: "optional_node",
              translation: [0.1, 0, 0],
              rotation: IDENTITY_QUAT,
              scale: ONE,
              pivot: ZERO,
            },
          ]
        : [
            transform("a_scale", ZERO, IDENTITY_QUAT, ONE, ZERO),
            transform("b_rotate", ZERO, IDENTITY_QUAT, ONE, ZERO),
            transform("c_translate", ZERO, IDENTITY_QUAT, ONE, ZERO),
            {
              follower: "optional",
              channel: "missing_transform",
              driver: { kind: "target", id: "shape_a" },
              node: "optional_node",
              translation: ZERO,
              rotation: IDENTITY_QUAT,
              scale: ONE,
              pivot: ZERO,
            },
          ],
      morphs: [
        {
          follower: "fit",
          channel: "surface",
          driver: { kind: "dial", id: "fit_control" },
          node: "body_node",
          morph: "fit_surface",
          weight: active ? 0.6 : 0,
          runtimeRetention: "recipe-only",
        },
        {
          follower: "optional",
          channel: "missing_surface",
          driver: { kind: "target", id: "shape_a" },
          node: "optional_node",
          morph: "missing_surface",
          weight: active ? 0.2 : 0,
          runtimeRetention: "recipe-only",
        },
      ],
    },
    rootScale: active ? 1.25 : 1,
    soleOffsetY: active ? 0.2 : 0,
  };
}

function expectVecClose(
  actual: readonly number[],
  expected: readonly number[],
) {
  expect(actual).toHaveLength(expected.length);
  expected.forEach((value, index) =>
    expect(actual[index]).toBeCloseTo(value, 10),
  );
}

function anatomyFitResult(
  overrides: Partial<AnatomyFitResult> = {},
): AnatomyFitResult {
  return {
    contract: "anatomy-fit-result/v1",
    solverVersion: "eye-socket-fit/geometry-clearance/v1",
    domain: "eye-socket:left",
    inputSha256: "a".repeat(64),
    status: "converged",
    convergence: {
      converged: true,
      iterations: 1,
      objective: 0,
      tolerance: 1e-12,
      reason: "minimum-step",
    },
    resolvedParameters: [],
    nodeTransforms: [
      {
        nodeId: "fit_anchor",
        rootDeltaMatrix: [
          1, 0, 0, 0,
          0, 1, 0, 0,
          0, 0, 1, 0,
          0.5, 0, 0, 1,
        ],
      },
    ],
    followerMorphCoefficients: [
      {
        followerId: "fit",
        channelId: "surface",
        nodeId: "body_node",
        morph: "fit_surface",
        weight: 0.5,
        lower: 0,
        upper: 1,
      },
    ],
    metrics: [],
    diagnostics: [],
    resultSha256: "b".repeat(64),
    ...overrides,
  };
}

describe("appearance Recipe physical evaluator", () => {
  it("composes verified Anatomy Fit morphs and node transforms after ordinary dial followers", () => {
    const output = evaluateAppearanceRecipePhysicalOutput(basis(), state(false), {
      anatomyFitResults: [anatomyFitResult()],
    });
    expect(Array.from(output.meshes[0].positions)).toEqual([
      0.125, -0.30000001192092896, 1_000_000.5,
    ]);
    const fit = output.nodes.find((node) => node.id === "fit_node")!;
    expectVecClose(fit.localMatrix.slice(12, 15), [1.5, 0, 0]);

    expect(() =>
      evaluateAppearanceRecipePhysicalOutput(basis(), state(false), {
        anatomyFitResults: [
          anatomyFitResult(),
          anatomyFitResult({
            domain: "eye-socket:right",
            resultSha256: "c".repeat(64),
          }),
        ],
      }),
    ).toThrow("writes node fit_anchor more than once");

    expect(() =>
      evaluateAppearanceRecipePhysicalOutput(basis(), state(false), {
        anatomyFitResults: [
          anatomyFitResult({
            followerMorphCoefficients: [
              {
                followerId: "fit",
                channelId: "missing",
                nodeId: "body_node",
                morph: "missing",
                weight: 0.5,
                lower: 0,
                upper: 1,
              },
            ],
          }),
        ],
      }),
    ).toThrow("does not bind a physical recipe-only POSITION channel");
  });

  it("conjugates Anatomy Fit root deltas into bone rests and matching inverse binds", () => {
    const physicalBasis = basis();
    physicalBasis.followerNodeBindings.push({
      id: "pelvis_fit_anchor",
      nodeId: "pelvis_node",
    });
    const result = anatomyFitResult({
      nodeTransforms: [
        {
          nodeId: "pelvis_fit_anchor",
          rootDeltaMatrix: [
            1, 0, 0, 0,
            0, 1, 0, 0,
            0, 0, 1, 0,
            0.25, 0, 0, 1,
          ],
        },
      ],
      followerMorphCoefficients: [],
    });
    const output = evaluateAppearanceRecipePhysicalOutput(
      physicalBasis,
      state(false),
      { anatomyFitResults: [result] },
    );

    const pelvis = output.jointRests.find((entry) => entry.boneId === "pelvis")!;
    const head = output.jointRests.find((entry) => entry.boneId === "head")!;
    expectVecClose(pelvis.localPosition, [0.25, 1, 0]);
    expectVecClose(pelvis.avatarRootOffset, [0.25, 0, 0]);
    expectVecClose(head.avatarRootOffset, [0.25, 0, 0]);
    for (const joint of output.skins[0].joints) {
      expectVecClose(joint.inverseBindMatrix.slice(12, 15), [-0.25, 0, 0]);
    }
  });

  it("pins Float32 bake order, retained weights, joint rests, inverse slots, and hips remap", () => {
    const physicalBasis = basis();
    const resolvedState = state(true);
    const sourceRetainedDelta =
      physicalBasis.retainedTargetPositionBindings[0].positionDelta;
    const output = evaluateAppearanceRecipePhysicalOutput(
      physicalBasis,
      resolvedState,
    );

    expect(Array.from(output.meshes[0].positions)).toEqual([
      0.11999999731779099, 0.05000000074505806, 1_000_007.75,
    ]);
    expect(
      output.retainedTargetPositionBindings.map(
        ({ positionDelta: _delta, ...binding }) => binding,
      ),
    ).toEqual([
      {
        id: "live_corrective/body",
        targetId: "live_corrective",
        node: "body_node",
        morph: "live_corrective",
        meshId: "body",
        weight: 0.4,
      },
    ]);
    expect(output.retainedTargetPositionBindings[0].positionDelta).not.toBe(
      sourceRetainedDelta,
    );
    expect(
      Array.from(
        output.retainedTargetPositionBindings[0].positionDelta as Float32Array,
      ),
    ).toEqual([0.10999999940395355, 0.11999999731779099, 0.12999999523162842]);
    expect(output.followerMorphWeights).toEqual([
      {
        follower: "fit",
        channel: "surface",
        driver: { kind: "dial", id: "fit_control" },
        node: "body_node",
        morph: "fit_surface",
        weight: 0.6,
      },
      {
        follower: "optional",
        channel: "missing_surface",
        driver: { kind: "target", id: "shape_a" },
        node: "optional_node",
        morph: "missing_surface",
        weight: 0.2,
      },
    ]);
    output.followerMorphWeights[0].driver.id = "mutated";
    expect(resolvedState.followerState.morphs[0].driver.id).toBe("fit_control");

    const pelvis = output.jointRests.find((bone) => bone.boneId === "pelvis")!;
    const head = output.jointRests.find((bone) => bone.boneId === "head")!;
    expectVecClose(pelvis.localPosition, [1, 1.5, 0]);
    // Avatar-root delta [0, 1, 0] becomes local +X through the inverse of the
    // parent's captured 90-degree root-relative rest rotation.
    expectVecClose(head.localPosition, [2, 0, 0]);
    expect(head.parentBoneId).toBe("pelvis");
    expect(output.skins[0].joints.map((joint) => joint.boneId)).toEqual([
      "head",
      "pelvis",
    ]);
    expectVecClose(
      output.skins[0].joints[0].inverseBindMatrix.slice(12, 15),
      [-1, -1.5, 0],
    );
    expectVecClose(
      output.skins[0].joints[1].inverseBindMatrix.slice(12, 15),
      [-1, -0.5, 0],
    );
    expect(output.hipsClipRemap).toEqual({
      boneId: "pelvis",
      bone: "mixamorig:Hips",
      baseRest: [0, 1, 0],
      newRest: [1, 1.5, 0],
      ratio: 1.5,
    });
  });

  it("pins pivoted channel order and propagates node/bone-parent roles through the grounded root", () => {
    const physicalBasis = basis();
    const output = evaluateAppearanceRecipePhysicalOutput(
      physicalBasis,
      state(true),
    );
    expectVecClose(output.root.position, [10, 4.75, -2]);
    expectVecClose(output.root.scale, [2.5, 3.75, 5]);

    const fit = output.nodes.find((node) => node.id === "fit_node")!;
    expectVecClose(fit.localMatrix.slice(12, 15), [0.25, 1.5, 0]);
    // Scale around X=.5, then rotate, then translate. Changing channel order
    // moves this origin and is therefore a hard parity failure.
    expect(fit.localMatrix[0]).toBeCloseTo(0, 10);
    expect(fit.localMatrix[1]).toBeCloseTo(2, 10);
    expect(fit.localMatrix[4]).toBeCloseTo(-1, 10);
    expect(fit.localMatrix[5]).toBeCloseTo(0, 10);

    const attachment = output.roles.find(
      (role) => role.kind === "attachment" && role.id === "hat",
    )!;
    const stage = output.roles.find(
      (role) => role.kind === "stage" && role.id === "head",
    )!;
    expectVecClose(attachment.worldPosition, [12.5, 17.875, 3]);
    expect(attachment.declaredParent).toEqual({ kind: "bone", name: "Head" });
    if (attachment.declaredParent?.kind === "bone") {
      attachment.declaredParent.name = "mutated";
    }
    expect(physicalBasis.roles[0].declaredParent).toEqual({
      kind: "bone",
      name: "Head",
    });
    expectVecClose(stage.worldPosition, [8.125, 10.375, -2]);
    expect(output.roles.map((role) => role.kind)).toEqual([
      "attachment",
      "stage",
      "performance",
      "eye",
    ]);
  });

  it("is a deterministic reset/repeat function and never mutates its basis", () => {
    const physicalBasis = basis();
    const originalPositions = physicalBasis.meshes[0].basePositions.slice();
    const first = evaluateAppearanceRecipePhysicalOutput(
      physicalBasis,
      state(true),
    );
    const reset = evaluateAppearanceRecipePhysicalOutput(
      physicalBasis,
      state(false),
    );
    const repeated = evaluateAppearanceRecipePhysicalOutput(
      physicalBasis,
      state(true),
    );

    expect(Array.from(reset.meshes[0].positions)).toEqual(
      Array.from(originalPositions),
    );
    expectVecClose(reset.root.position, [10, 5, -2]);
    expectVecClose(reset.root.scale, [2, 3, 4]);
    expect(
      reset.jointRests.find((bone) => bone.boneId === "head")?.localPosition,
    ).toEqual([1, 0, 0]);
    expect(Array.from(repeated.meshes[0].positions)).toEqual(
      Array.from(first.meshes[0].positions),
    );
    expect(repeated.nodes).toEqual(first.nodes);
    expect(repeated.roles).toEqual(first.roles);
    expect(Array.from(physicalBasis.meshes[0].basePositions)).toEqual(
      Array.from(originalPositions),
    );
  });

  it("skips threshold-zero contributions without opening lazy GLB visitors", () => {
    const physicalBasis = basis();
    let visits = 0;
    physicalBasis.targetPositionBindings[1].positionDelta = {
      length: 3,
      visit(visitor) {
        visits += 1;
        visitor(0, 999);
      },
    };
    const nearZero = state(false);
    nearZero.influences.set("shape_b", 1e-8);
    nearZero.followerState.morphs[0].weight = -1e-8;

    const output = evaluateAppearanceRecipePhysicalOutput(
      physicalBasis,
      nearZero,
    );
    expect(visits).toBe(0);
    expect(Array.from(output.meshes[0].positions)).toEqual([
      0.10000000149011612, -0.20000000298023224, 1_000_000,
    ]);
  });

  it("fails closed on duplicate/missing ids, malformed arrays, cycles, aliases, non-finite values, and shear", () => {
    const cases: Array<
      [string, (value: AppearanceRecipePhysicalBasis) => void, RegExp]
    > = [
      [
        "duplicate id",
        (value) => value.meshes.push({ ...value.meshes[0] }),
        /duplicates id body/,
      ],
      [
        "missing id",
        (value) => {
          value.targets[0].id = "";
        },
        /non-empty trimmed id/,
      ],
      [
        "missing reference",
        (value) => {
          value.targetPositionBindings[0].meshId = "missing";
        },
        /references missing mesh/,
      ],
      [
        "array length",
        (value) => {
          value.targetPositionBindings[0].positionDelta = new Float32Array(2);
        },
        /delta length does not match/,
      ],
      [
        "hierarchy cycle",
        (value) => {
          value.nodes.find((node) => node.id === "pelvis_node")!.parentId =
            "head_node";
        },
        /hierarchy contains a cycle/,
      ],
      [
        "bone alias",
        (value) => {
          value.nodes.push({ id: "alias_node", baseLocalMatrix: trs() });
          value.bones.push({
            id: "alias_bone",
            name: "mixamorigHips",
            nodeId: "alias_node",
          });
        },
        /bone alias mixamorigHips is ambiguous/,
      ],
      [
        "non-finite",
        (value) => {
          value.rootBaseMatrix = value.rootBaseMatrix.map((entry, index) =>
            index === 12 ? Number.NaN : entry,
          );
        },
        /must be finite/,
      ],
      [
        "shear",
        (value) => {
          const sheared = trs();
          sheared[4] = 0.25;
          value.nodes[0].baseLocalMatrix = sheared;
        },
        /contains shear or another non-TRS/,
      ],
      [
        "attachment parent",
        (value) => {
          value.roles[0].declaredParent = {
            kind: "bone",
            name: "mixamorig:Hips",
          };
        },
        /bone parent does not match its hierarchy/,
      ],
      [
        "follower transform identity",
        (value) => {
          value.followerNodeTransformBindings[0].node = "missing";
        },
        /references missing appearance node missing/,
      ],
    ];

    for (const [, mutate, expected] of cases) {
      const value = basis();
      mutate(value);
      expect(() => validateAppearanceRecipePhysicalBasis(value)).toThrow(
        expected,
      );
    }
  });

  it("rejects nondeterministic or malformed lazy delta visitation", () => {
    const physicalBasis = basis();
    physicalBasis.targetPositionBindings[0].positionDelta = {
      length: 3,
      visit(visitor) {
        visitor(1, 1);
        visitor(0, 1);
      },
    };
    expect(() =>
      evaluateAppearanceRecipePhysicalOutput(physicalBasis, state(true)),
    ).toThrow(/indices must be unique and strictly ascending/);
  });

  it("requires the resolved follower transform inventory exactly", () => {
    const missing = state(true);
    missing.followerState.nodeTransforms.pop();
    expect(() =>
      evaluateAppearanceRecipePhysicalOutput(basis(), missing),
    ).toThrow(/resolved follower transform count does not match/);

    const changed = state(true);
    changed.followerState.nodeTransforms[0].channel = "unknown";
    expect(() =>
      evaluateAppearanceRecipePhysicalOutput(basis(), changed),
    ).toThrow(/resolved follower transform order or identity changed/);
  });

  it("rejects every reordered resolver inventory instead of treating it as a set", () => {
    const targetOrder = state(true);
    targetOrder.influences = new Map([
      ["shape_b", 0.7],
      ["shape_a", 0.3],
      ["live_corrective", 0.4],
    ]);
    expect(() =>
      evaluateAppearanceRecipePhysicalOutput(basis(), targetOrder),
    ).toThrow(/resolved target influence order changed at index 0/);

    const jointOrder = state(true);
    jointOrder.jointOffsets = new Map([
      ["Head", [1, 1.5, 0]],
      ["mixamorigHips", [1, 0.5, 0]],
    ] as Array<[string, AppearanceVec3]>);
    expect(() =>
      evaluateAppearanceRecipePhysicalOutput(basis(), jointOrder),
    ).toThrow(/resolved joint offset order changed at index 0/);

    const morphOrder = state(true);
    morphOrder.followerState.morphs.reverse();
    expect(() =>
      evaluateAppearanceRecipePhysicalOutput(basis(), morphOrder),
    ).toThrow(/resolved follower morph order or identity changed at index 0/);

    const transformOrder = state(true);
    [
      transformOrder.followerState.nodeTransforms[0],
      transformOrder.followerState.nodeTransforms[1],
    ] = [
      transformOrder.followerState.nodeTransforms[1],
      transformOrder.followerState.nodeTransforms[0],
    ];
    expect(() =>
      evaluateAppearanceRecipePhysicalOutput(basis(), transformOrder),
    ).toThrow(
      /resolved follower transform order or identity changed at index 0/,
    );
  });

  it("exhausts physical follower bindings once and rejects joint-slot or alias duplication", () => {
    const retainedIdentity = basis();
    retainedIdentity.nodes.push({ id: "other_node", baseLocalMatrix: trs() });
    retainedIdentity.meshes.push({
      id: "other_mesh",
      nodeId: "other_node",
      basePositions: new Float32Array(3),
    });
    retainedIdentity.retainedTargetPositionBindings[0].meshId = "other_mesh";
    expect(() =>
      validateAppearanceRecipePhysicalBasis(retainedIdentity),
    ).toThrow(/retained target binding .* changed its physical mesh identity/);

    const omittedFollower = basis();
    delete omittedFollower.followerMorphBindings[0].positionBindingIds;
    expect(() =>
      validateAppearanceRecipePhysicalBasis(omittedFollower),
    ).toThrow(/omits its present physical binding/);

    const unclaimedFollower = basis();
    unclaimedFollower.followerMorphPositionBindings.push({
      ...unclaimedFollower.followerMorphPositionBindings[0],
      id: "orphan/follower/position",
      follower: "orphan",
      channel: "surface",
    });
    expect(() =>
      validateAppearanceRecipePhysicalBasis(unclaimedFollower),
    ).toThrow(/follower morph position bindings are unclaimed/);

    const duplicateJointAlias = basis();
    duplicateJointAlias.jointOffsetBindings[1] = {
      bone: "mixamorig:Hips",
      boneId: "pelvis",
    };
    expect(() =>
      validateAppearanceRecipePhysicalBasis(duplicateJointAlias),
    ).toThrow(/joint offset bindings duplicate physical bone pelvis/);

    const duplicateSkinSlot = basis();
    duplicateSkinSlot.skins[0].joints[1].boneId = "head";
    expect(() =>
      validateAppearanceRecipePhysicalBasis(duplicateSkinSlot),
    ).toThrow(/duplicates joint slot bone head/);
  });

  it("requires exact tuple shapes and contract-valid follower quaternions without normalization", () => {
    const longTuple = state(true);
    longTuple.followerState.nodeTransforms[0].translation = [
      0, 0, 0, 0,
    ] as unknown as AppearanceVec3;
    expect(() =>
      evaluateAppearanceRecipePhysicalOutput(basis(), longTuple),
    ).toThrow(/translation must contain exactly 3 numbers/);

    const nonUnit = state(true);
    nonUnit.followerState.nodeTransforms[0].rotation = [0, 0, 0, 2];
    expect(() =>
      evaluateAppearanceRecipePhysicalOutput(basis(), nonUnit),
    ).toThrow(/rotation must be unit length/);

    const float32QuarterTurn = state(true);
    float32QuarterTurn.followerState.nodeTransforms[0].rotation = [
      0, 0, 0.7071067690849304, 0.7071067690849304,
    ];
    expect(() =>
      evaluateAppearanceRecipePhysicalOutput(basis(), float32QuarterTurn),
    ).not.toThrow();
  });

  it("fails closed when finite inputs overflow Float32, follower, root, or world operations", () => {
    const floatOverflowBasis = basis();
    floatOverflowBasis.targetPositionBindings[0].positionDelta = lazyDelta([
      Number.MAX_VALUE,
      0,
      0,
    ]);
    expect(() =>
      evaluateAppearanceRecipePhysicalOutput(floatOverflowBasis, state(true)),
    ).toThrow(
      /target position binding shape_a\/body delta output\[0\] must be finite/,
    );

    const followerOverflow = state(true);
    followerOverflow.followerState.nodeTransforms[0].translation = [
      Number.MAX_VALUE,
      0,
      0,
    ];
    followerOverflow.followerState.nodeTransforms[0].scale = [
      Number.MAX_VALUE,
      Number.MAX_VALUE,
      Number.MAX_VALUE,
    ];
    expect(() =>
      evaluateAppearanceRecipePhysicalOutput(basis(), followerOverflow),
    ).toThrow(/follower node fit_anchor composed matrix.*must be finite/);

    const rootOverflow = state(true);
    rootOverflow.rootScale = Number.MAX_VALUE;
    expect(() =>
      evaluateAppearanceRecipePhysicalOutput(basis(), rootOverflow),
    ).toThrow(/root evaluated scale.*must be finite/);

    const worldOverflowBasis = basis();
    worldOverflowBasis.nodes.find(
      (node) => node.id === "eye_node",
    )!.baseLocalMatrix = trs([Number.MAX_VALUE, 0, 0]);
    expect(() =>
      evaluateAppearanceRecipePhysicalOutput(worldOverflowBasis, state(true)),
    ).toThrow(/(root-relative|world) matrix.*must be finite/);

    const inverseOverflowBasis = basis();
    inverseOverflowBasis.skins[0].joints[0].baseInverseBindMatrix = trs(
      ZERO,
      IDENTITY_QUAT,
      [Number.MAX_VALUE, 1, 1],
    );
    const inverseOverflow = state(true);
    inverseOverflow.jointOffsets = new Map([
      ["mixamorigHips", [Number.MAX_VALUE, 0, 0]],
      ["Head", [Number.MAX_VALUE, 0, 0]],
    ] as Array<[string, AppearanceVec3]>);
    expect(() =>
      evaluateAppearanceRecipePhysicalOutput(
        inverseOverflowBasis,
        inverseOverflow,
      ),
    ).toThrow(/output inverse bind.*must be finite/);
  });

  it("wraps retained lazy deltas with fresh validated visitors", () => {
    const physicalBasis = basis();
    const source = lazyDelta([0.2, 0.3, 0.4]);
    physicalBasis.retainedTargetPositionBindings[0].positionDelta = source;
    const output = evaluateAppearanceRecipePhysicalOutput(
      physicalBasis,
      state(true),
    );
    const retained = output.retainedTargetPositionBindings[0].positionDelta;
    expect(retained).not.toBe(source);
    expect(retained).not.toBeInstanceOf(Float32Array);
    const visited: Array<[number, number]> = [];
    if (!(retained instanceof Float32Array)) {
      retained.visit((index, value) => visited.push([index, value]));
    }
    expect(visited).toEqual([
      [0, 0.2],
      [1, 0.3],
      [2, 0.4],
    ]);
  });
});
