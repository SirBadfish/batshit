import { describe, expect, it } from "vitest";

import {
  APPEARANCE_CLIP_REMAP_CONTRACT,
  APPEARANCE_FOLLOWER_CONTRACT,
  APPEARANCE_JOINT_FOLLOW_CONTRACT,
  type AppearanceDialDefinition,
  type AppearanceDialMacroAxis,
  type AppearanceDialsManifest,
} from "../appearanceDials.contracts";
import {
  buildAppearanceRecipeDependencyGraph,
  unionAppearanceRecipeDependencyGraphs,
  type AppearanceRecipeDependencyGraph,
} from "./appearanceRecipeDependencyGraph";
import {
  createAppearanceRecipeTestManifest,
  testAppearanceTarget,
  testTrackDial,
} from "./appearanceRecipeTestManifest";

const HASH = "a".repeat(64);

function componentId(
  graph: AppearanceRecipeDependencyGraph,
  nodeId: string,
): string {
  const id = graph.componentIdByNode[nodeId];
  if (!id) throw new Error(`missing component for ${nodeId}`);
  return id;
}

function expectControlsConnected(
  graph: AppearanceRecipeDependencyGraph,
  ...controlIds: string[]
) {
  expect(
    new Set(controlIds.map((id) => componentId(graph, `control:${id}`))).size,
  ).toBe(1);
}

function macroDial(
  id: string,
  axis: AppearanceDialMacroAxis,
): AppearanceDialDefinition {
  return testTrackDial(id, "unused", {
    kind: "macro-axis",
    members: undefined,
    axis,
    axisTrack: [
      [-1, -1],
      [0, 0],
      [1, 1],
    ],
  });
}

function followerSamples() {
  return [
    {
      input: -1,
      translation: [-0.1, 0, 0] as [number, number, number],
      rotation: [0, 0, 0, 1] as [number, number, number, number],
      scale: [1, 1, 1] as [number, number, number],
      pivot: [0, 1, 0] as [number, number, number],
    },
    {
      input: 1,
      translation: [0.1, 0, 0] as [number, number, number],
      rotation: [0, 0, 0, 1] as [number, number, number, number],
      scale: [1, 1, 1] as [number, number, number],
      pivot: [0, 1, 0] as [number, number, number],
    },
  ];
}

describe("Appearance Recipe supplemental dependency graph", () => {
  it("closes controls sharing one target/clamp without coupling other morphs on the same mesh", () => {
    const manifest = createAppearanceRecipeTestManifest();
    manifest.targets = {
      shared: testAppearanceTarget("body", "shared", {
        combine: "sum-clamp",
      }),
      independent: testAppearanceTarget("body", "independent"),
    };
    manifest.dials = [
      testTrackDial("a", "shared"),
      testTrackDial("b", "shared"),
      testTrackDial("c", "independent"),
    ];

    const graph = buildAppearanceRecipeDependencyGraph(manifest);

    expectControlsConnected(graph, "a", "b");
    expect(componentId(graph, "control:a")).not.toBe(
      componentId(graph, "control:c"),
    );
    expect(componentId(graph, "control:a")).toBe(
      componentId(graph, "output:morph:body:shared"),
    );
    expect(componentId(graph, "output:morph:body:shared")).not.toBe(
      componentId(graph, "output:morph:body:independent"),
    );
  });

  it("treats every macro axis and corner target as one complete component", () => {
    const manifest = createAppearanceRecipeTestManifest();
    manifest.targets = {
      macro_a: testAppearanceTarget("body", "macro_a"),
      macro_b: testAppearanceTarget("body", "macro_b"),
    };
    manifest.dials = [
      macroDial("muscle", "muscle"),
      macroDial("weight", "weight"),
      macroDial("cupsize", "cupsize"),
      macroDial("firmness", "firmness"),
    ];
    const dimension = {
      parts: [{ lowest: -2, highest: 2, low: "low", high: "high" }],
    };
    manifest.macroEngine = {
      formula: "mpfb-macro-product/v1",
      cutoff: 1e-7,
      baselineState: { muscle: 0, weight: 0, cupsize: 0, firmness: 0 },
      dims: {
        muscle: dimension,
        weight: dimension,
        cupsize: dimension,
        firmness: dimension,
      },
      corners: [
        {
          target: "macro_a",
          family: "a",
          comps: { muscle: "high", weight: "low" },
          fixedFactor: 1,
          baselineWeight: 0,
        },
        {
          target: "macro_b",
          family: "b",
          comps: { cupsize: "high", firmness: "low" },
          fixedFactor: 1,
          baselineWeight: 0,
        },
      ],
    };

    const graph = buildAppearanceRecipeDependencyGraph(manifest);

    expectControlsConnected(graph, "muscle", "weight", "cupsize", "firmness");
    expect(componentId(graph, "control:muscle")).toBe(
      componentId(graph, "output:morph:body:macro_b"),
    );
  });

  it("keeps bilateral main, offsets, and unlock gate atomic", () => {
    const manifest = createAppearanceRecipeTestManifest();
    manifest.targets = {
      shared: testAppearanceTarget("body", "shared", {
        combine: "sum-clamp",
      }),
    };
    manifest.dials = [
      testTrackDial("width", "shared", {
        symmetry: {
          mode: "linked-with-offsets",
          left: {
            id: "width_left",
            label: "Left",
            range: [-1, 1],
            step: 0.01,
            members: [
              {
                target: "shared",
                track: [
                  [-1, -1],
                  [1, 1],
                ],
              },
            ],
          },
          right: {
            id: "width_right",
            label: "Right",
            range: [-1, 1],
            step: 0.01,
            members: [
              {
                target: "shared",
                track: [
                  [-1, -1],
                  [1, 1],
                ],
              },
            ],
          },
        },
      }),
    ];

    const graph = buildAppearanceRecipeDependencyGraph(manifest);

    expectControlsConnected(graph, "width", "width_left", "width_right");
    expect(componentId(graph, "control:width")).toBe(
      componentId(graph, "unlock:width"),
    );
  });

  it("closes all follower drivers through channel, pivot, node-matrix, and morph outputs", () => {
    const manifest = createAppearanceRecipeTestManifest();
    manifest.targets = {
      driven: testAppearanceTarget("body", "driven"),
    };
    manifest.dials = [
      testTrackDial("follower_dial", "unused", {
        kind: "follower-only",
        members: undefined,
      }),
      testTrackDial("target_dial", "driven"),
    ];
    manifest.followers = {
      combo: {
        contract: APPEARANCE_FOLLOWER_CONTRACT,
        space: "node-parent-rest",
        composition: "rest-relative-follower-channel-id-order/v2",
        interpolation: "linear-trs-slerp-rotation-morph/v2",
        extrapolation: "clamp",
        provenance: manifest.targets.driven!.provenance,
        nodeIds: ["parent", "body"],
        drivers: [
          {
            driver: { kind: "dial", id: "follower_dial" },
            channels: [
              {
                id: "move-parent",
                kind: "node-trs",
                node: "parent",
                samples: followerSamples(),
              },
            ],
          },
          {
            driver: { kind: "target", id: "driven" },
            channels: [
              {
                id: "follow-morph",
                kind: "morph-weight",
                node: "body",
                morph: "follower_morph",
                weightRange: [-1, 1],
                runtimeRetention: "recipe-only",
                samples: [
                  [-1, -1],
                  [1, 1],
                ],
              },
            ],
          },
        ],
      },
    };

    const graph = buildAppearanceRecipeDependencyGraph(manifest);

    expectControlsConnected(graph, "follower_dial", "target_dial");
    for (const output of [
      "output:pivot:parent",
      "output:node-matrix:parent",
      "output:morph:body:follower_morph",
    ]) {
      expect(componentId(graph, "control:follower_dial")).toBe(
        componentId(graph, output),
      );
    }
  });

  it("couples shared joint outputs and the nonlinear root-scale/grounding transform", () => {
    const manifest = createAppearanceRecipeTestManifest();
    manifest.targets = {
      joint_a: testAppearanceTarget("body", "joint_a"),
      joint_b: testAppearanceTarget("body", "joint_b"),
      grounded: testAppearanceTarget("body", "grounded", {
        soleDeltaY: 0.1,
      }),
    };
    manifest.dials = [
      testTrackDial("joint_dial_a", "joint_a"),
      testTrackDial("joint_dial_b", "joint_b"),
      testTrackDial("ground_dial", "grounded"),
      testTrackDial("height", "unused", {
        kind: "root-scale",
        members: undefined,
        scalePerUnit: 0.1,
      }),
    ];
    manifest.jointFollow = {
      contract: APPEARANCE_JOINT_FOLLOW_CONTRACT,
      space: "avatar-root",
      units: "meters",
      restSkeletonSha256: HASH,
      deltas: {
        joint_a: { Head: [0, 0.1, 0] },
        joint_b: { Head: [0, 0, 0.1] },
      },
      clipRemap: {
        contract: APPEARANCE_CLIP_REMAP_CONTRACT,
        hipsBone: "Hips",
      },
    };

    const graph = buildAppearanceRecipeDependencyGraph(manifest);

    expectControlsConnected(graph, "joint_dial_a", "joint_dial_b");
    expectControlsConnected(graph, "ground_dial", "height");
    expect(componentId(graph, "control:height")).toBe(
      componentId(graph, "output:root-transform"),
    );
  });

  it("propagates variable node and bone rests into typed attachment outputs", () => {
    const manifest = createAppearanceRecipeTestManifest();
    manifest.targets = {
      head: testAppearanceTarget("body", "head"),
    };
    manifest.dials = [
      testTrackDial("parent_driver", "unused", {
        kind: "follower-only",
        members: undefined,
      }),
      testTrackDial("head_driver", "head"),
    ];
    manifest.followers = {
      parent: {
        contract: APPEARANCE_FOLLOWER_CONTRACT,
        space: "node-parent-rest",
        composition: "rest-relative-follower-channel-id-order/v2",
        interpolation: "linear-trs-slerp-rotation-morph/v2",
        extrapolation: "clamp",
        provenance: manifest.targets.head!.provenance,
        nodeIds: ["parent"],
        drivers: [
          {
            driver: { kind: "dial", id: "parent_driver" },
            channels: [
              {
                id: "parent-rest",
                kind: "node-trs",
                node: "parent",
                samples: followerSamples(),
              },
            ],
          },
        ],
      },
    };
    manifest.jointFollow = {
      contract: APPEARANCE_JOINT_FOLLOW_CONTRACT,
      space: "avatar-root",
      units: "meters",
      restSkeletonSha256: HASH,
      deltas: { head: { Head: [0, 0.1, 0] } },
    };

    const graph = buildAppearanceRecipeDependencyGraph(manifest);

    expect(componentId(graph, "control:parent_driver")).toBe(
      componentId(graph, "output:attachment:attachment"),
    );
    expect(componentId(graph, "control:head_driver")).toBe(
      componentId(graph, "output:attachment:bone_attachment"),
    );
  });

  it("is byte-deterministic across declaration insertion order", () => {
    const manifest = createAppearanceRecipeTestManifest();
    manifest.targets = {
      a: testAppearanceTarget("body", "a"),
      b: testAppearanceTarget("body", "b"),
    };
    manifest.dials = [testTrackDial("a", "a"), testTrackDial("b", "b")];
    const reordered: AppearanceDialsManifest = {
      ...manifest,
      nodes: Object.fromEntries(Object.entries(manifest.nodes).reverse()),
      targets: Object.fromEntries(Object.entries(manifest.targets).reverse()),
      dials: [...manifest.dials].reverse(),
    };

    expect(JSON.stringify(buildAppearanceRecipeDependencyGraph(manifest))).toBe(
      JSON.stringify(buildAppearanceRecipeDependencyGraph(reordered)),
    );
  });

  it("unions old and new graphs before closure to catch newly introduced cross-version coupling", () => {
    const oldManifest = createAppearanceRecipeTestManifest();
    oldManifest.targets = {
      target_a: testAppearanceTarget("body", "bridge"),
      target_b: testAppearanceTarget("body", "old_b"),
    };
    oldManifest.dials = [
      testTrackDial("a", "target_a"),
      testTrackDial("b", "target_b"),
    ];
    const newManifest = createAppearanceRecipeTestManifest();
    newManifest.targets = {
      target_a: testAppearanceTarget("body", "new_a"),
      target_b: testAppearanceTarget("body", "bridge"),
    };
    newManifest.dials = [
      testTrackDial("a", "target_a"),
      testTrackDial("b", "target_b"),
    ];

    const oldGraph = buildAppearanceRecipeDependencyGraph(oldManifest);
    const newGraph = buildAppearanceRecipeDependencyGraph(newManifest);
    const union = unionAppearanceRecipeDependencyGraphs(oldGraph, newGraph);

    expect(componentId(oldGraph, "control:a")).not.toBe(
      componentId(oldGraph, "control:b"),
    );
    expect(componentId(newGraph, "control:a")).not.toBe(
      componentId(newGraph, "control:b"),
    );
    expectControlsConnected(union, "a", "b");
  });
});
