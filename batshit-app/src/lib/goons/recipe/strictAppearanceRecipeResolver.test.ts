import { describe, expect, it } from "vitest";

import type { AppearanceDialValueState } from "../appearanceDials.contracts";
import {
  createAppearanceRecipeTestManifest,
  testAppearanceTarget,
  testTrackDial,
} from "./appearanceRecipeTestManifest";
import {
  createNeutralAppearanceRecipeState,
  resolveStrictAppearanceRecipeSnapshot,
} from "./strictAppearanceRecipeResolver";

function manifestWithBilateralDial() {
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
          label: "Width Left",
          range: [-0.5, 0.5],
          step: 0.01,
          members: [
            {
              target: "shared",
              track: [
                [-0.5, -0.5],
                [0, 0],
                [0.5, 0.5],
              ],
            },
          ],
        },
        right: {
          id: "width_right",
          label: "Width Right",
          range: [-0.5, 0.5],
          step: 0.01,
          members: [
            {
              target: "shared",
              track: [
                [-0.5, -0.5],
                [0, 0],
                [0.5, 0.5],
              ],
            },
          ],
        },
      },
    }),
  ];
  return manifest;
}

function copyState(state: AppearanceDialValueState): AppearanceDialValueState {
  return {
    ...state,
    values: { ...state.values },
    unlockedDialIds: [...state.unlockedDialIds],
  };
}

describe("strict Appearance Recipe snapshot resolver", () => {
  it("builds and resolves the exact neutral state", () => {
    const manifest = manifestWithBilateralDial();
    const neutral = createNeutralAppearanceRecipeState(manifest);

    expect(neutral.values).toEqual({
      width: 0,
      width_left: 0,
      width_right: 0,
    });
    expect(neutral.unlockedDialIds).toEqual([]);

    const result = resolveStrictAppearanceRecipeSnapshot(manifest, neutral);
    expect(result.state).toEqual(neutral);
    expect(result.resolved.values).toEqual(neutral.values);
    expect(result.physicalSnapshot.influences).toEqual([
      { target: "shared", weight: 0 },
    ]);
  });

  it("accepts an exact unlocked bilateral state without reconciling it", () => {
    const manifest = manifestWithBilateralDial();
    const state = createNeutralAppearanceRecipeState(manifest);
    state.values.width = 0.25;
    state.values.width_left = -0.1;
    state.values.width_right = 0.2;
    state.unlockedDialIds = ["width"];

    const result = resolveStrictAppearanceRecipeSnapshot(manifest, state);

    expect(result.state).toEqual(state);
    expect(result.physicalSnapshot.influences[0]?.target).toBe("shared");
    expect(result.physicalSnapshot.influences[0]?.weight).toBeCloseTo(0.35);
  });

  it("rejects non-canonical unlock ordering instead of normalizing it", () => {
    const manifest = manifestWithBilateralDial();
    const width = manifest.dials[0]!;
    if (width.symmetry?.mode !== "linked-with-offsets") {
      throw new Error("fixture lost bilateral symmetry");
    }
    manifest.dials.push({
      ...width,
      id: "depth",
      label: "Depth",
      symmetry: {
        mode: "linked-with-offsets",
        left: { ...width.symmetry.left, id: "depth_left" },
        right: { ...width.symmetry.right, id: "depth_right" },
      },
    });
    const state = createNeutralAppearanceRecipeState(manifest);
    state.unlockedDialIds = ["width", "depth"];

    expect(() =>
      resolveStrictAppearanceRecipeSnapshot(manifest, state),
    ).toThrow(/canonical ascending id order/);
  });

  it("rejects every state the editor would repair, prune, reset, or clamp", () => {
    const manifest = manifestWithBilateralDial();
    const neutral = createNeutralAppearanceRecipeState(manifest);
    const cases: Array<{
      name: string;
      mutate: (state: AppearanceDialValueState) => unknown;
      message: RegExp;
    }> = [
      {
        name: "definition identity mismatch",
        mutate: (state) => ({ ...state, definitionSha256: "0".repeat(64) }),
        message: /definition identity/,
      },
      {
        name: "neutral identity mismatch",
        mutate: (state) => ({ ...state, neutralId: "different-neutral" }),
        message: /neutral id/,
      },
      {
        name: "neutral Recipe mismatch",
        mutate: (state) => ({
          ...state,
          neutralRecipeSha256: "0".repeat(64),
        }),
        message: /neutral Recipe identity/,
      },
      {
        name: "missing control",
        mutate: (state) => {
          delete state.values.width;
          return state;
        },
        message: /missing fields: width/,
      },
      {
        name: "unknown control",
        mutate: (state) => {
          state.values.unknown = 0;
          return state;
        },
        message: /unknown fields: unknown/,
      },
      {
        name: "non-finite control",
        mutate: (state) => {
          state.values.width = Number.NaN;
          return state;
        },
        message: /control width must be finite/,
      },
      {
        name: "out-of-range control",
        mutate: (state) => {
          state.values.width = 2;
          return state;
        },
        message: /outside \[-1, 1\]/,
      },
      {
        name: "invalid unlock",
        mutate: (state) => {
          state.unlockedDialIds = ["not_unlockable"];
          return state;
        },
        message: /non-unlockable control not_unlockable/,
      },
      {
        name: "duplicate unlock",
        mutate: (state) => {
          state.unlockedDialIds = ["width", "width"];
          return state;
        },
        message: /duplicate width/,
      },
      {
        name: "locked side offset",
        mutate: (state) => {
          state.values.width_left = 0.1;
          return state;
        },
        message: /locked side offset width_left must be exactly zero/,
      },
      {
        name: "tiny locked offset reconciliation would silently zero",
        mutate: (state) => {
          state.values.width_right = 1e-12;
          return state;
        },
        message: /locked side offset width_right must be exactly zero/,
      },
    ];

    for (const entry of cases) {
      const candidate = entry.mutate(copyState(neutral));
      expect(
        () => resolveStrictAppearanceRecipeSnapshot(manifest, candidate),
        entry.name,
      ).toThrow(entry.message);
    }
  });

  it("rejects malformed state envelopes instead of manufacturing defaults", () => {
    const manifest = manifestWithBilateralDial();
    const neutral = createNeutralAppearanceRecipeState(manifest);

    expect(() => resolveStrictAppearanceRecipeSnapshot(manifest, null)).toThrow(
      /state must be an object/,
    );
    expect(() =>
      resolveStrictAppearanceRecipeSnapshot(manifest, {
        ...neutral,
        values: [],
      }),
    ).toThrow(/values must be an object/);
    expect(() =>
      resolveStrictAppearanceRecipeSnapshot(manifest, {
        ...neutral,
        futureField: true,
      }),
    ).toThrow(/unknown fields: futureField/);
  });
});
