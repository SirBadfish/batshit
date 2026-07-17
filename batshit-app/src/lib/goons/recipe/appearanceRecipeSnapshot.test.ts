import { describe, expect, it } from "vitest";

import type { ResolvedAppearanceDialState } from "../appearanceDials.contracts";
import {
  APPEARANCE_RECIPE_PHYSICAL_SNAPSHOT_CONTRACT,
  snapshotAppearanceRecipePhysicalOutput,
} from "./appearanceRecipeSnapshot";

function resolved(reverse = false): ResolvedAppearanceDialState {
  const influences = reverse
    ? new Map([
        ["target_b", -0],
        ["target_a", 0.25],
      ])
    : new Map([
        ["target_a", 0.25],
        ["target_b", 0],
      ]);
  const jointOffsets = reverse
    ? new Map<string, [number, number, number]>([
        ["joint_b", [0, -0, 0.2]],
        ["joint_a", [0.1, 0, 0]],
      ])
    : new Map<string, [number, number, number]>([
        ["joint_a", [0.1, 0, 0]],
        ["joint_b", [0, 0, 0.2]],
      ]);
  const followerInputs = reverse
    ? new Map([
        ["follower_b", new Map([["dial:b", -0]])],
        [
          "follower_a",
          new Map([
            ["target:b", 0.5],
            ["target:a", 0.25],
          ]),
        ],
      ])
    : new Map([
        [
          "follower_a",
          new Map([
            ["target:a", 0.25],
            ["target:b", 0.5],
          ]),
        ],
        ["follower_b", new Map([["dial:b", 0]])],
      ]);
  const nodeTransforms: ResolvedAppearanceDialState["followerState"]["nodeTransforms"] =
    [
      {
        follower: "follower_b",
        channel: "channel_b",
        driver: { kind: "dial", id: "dial_b" },
        node: "node_b",
        translation: [0, -0, 0.2],
        rotation: [0, 0, 0, 1],
        scale: [1, 1, 1],
        pivot: [0, 0, 0],
      },
      {
        follower: "follower_a",
        channel: "channel_a",
        driver: { kind: "target", id: "target_a" },
        node: "node_a",
        translation: [0.1, 0, 0],
        rotation: [0, 0.1, 0, 0.99498743710662],
        scale: [1.1, 1, 1],
        pivot: [0.01, 0, 0],
      },
    ];
  const morphs: ResolvedAppearanceDialState["followerState"]["morphs"] = [
    {
      follower: "follower_b",
      channel: "morph_b",
      driver: { kind: "dial", id: "dial_b" },
      node: "mesh_b",
      morph: "morph_b",
      weight: -0,
      runtimeRetention: "recipe-only",
    },
    {
      follower: "follower_a",
      channel: "morph_a",
      driver: { kind: "target", id: "target_a" },
      node: "mesh_a",
      morph: "morph_a",
      weight: 0.25,
      runtimeRetention: "recipe-only",
    },
  ];
  return {
    values: { dial_b: 0, dial_a: 0.25 },
    unlockedDialIds: new Set(
      reverse ? ["dial_b", "dial_a"] : ["dial_a", "dial_b"],
    ),
    influences,
    jointOffsets,
    followerInputs,
    followerState: {
      nodeTransforms: reverse ? nodeTransforms : [...nodeTransforms].reverse(),
      morphs: reverse ? morphs : [...morphs].reverse(),
    },
    rootScale: 1.02,
    soleOffsetY: -0,
  };
}

describe("appearance Recipe physical snapshot", () => {
  it("is deterministic across map and array insertion order", () => {
    const first = snapshotAppearanceRecipePhysicalOutput(resolved(false));
    const second = snapshotAppearanceRecipePhysicalOutput(resolved(true));

    expect(first).toEqual(second);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.contract).toBe(APPEARANCE_RECIPE_PHYSICAL_SNAPSHOT_CONTRACT);
    expect(first.influences.map((entry) => entry.target)).toEqual([
      "target_a",
      "target_b",
    ]);
    expect(
      first.followerInputs.map((entry) => `${entry.follower}/${entry.driver}`),
    ).toEqual([
      "follower_a/target:a",
      "follower_a/target:b",
      "follower_b/dial:b",
    ]);
    expect(first.soleOffsetY).toBe(0);
    expect(first.followerMorphs[1]?.weight).toBe(0);
  });

  it("copies vector and driver data away from the mutable resolver state", () => {
    const source = resolved();
    const snapshot = snapshotAppearanceRecipePhysicalOutput(source);
    source.jointOffsets.get("joint_a")![0] = 99;
    source.followerState.nodeTransforms[0]!.driver.id = "mutated";

    expect(snapshot.jointOffsets[0]).toEqual({
      bone: "joint_a",
      translation: [0.1, 0, 0],
    });
    expect(snapshot.followerNodeTransforms[0]?.driver.id).toBe("target_a");
  });

  it("fails closed on non-finite physical output", () => {
    const source = resolved();
    source.followerState.nodeTransforms[0]!.rotation[3] = Number.NaN;

    expect(() => snapshotAppearanceRecipePhysicalOutput(source)).toThrow(
      "rotation[3] must be finite",
    );
  });
});
