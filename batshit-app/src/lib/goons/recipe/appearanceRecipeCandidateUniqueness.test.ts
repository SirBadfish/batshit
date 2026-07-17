import { describe, expect, it } from "vitest";
import { parseAppearanceDialsManifest } from "../appearanceDials.schema";
import type { AppearanceRecipeComponentCandidate } from "./appearanceRecipeCandidateGenerator";
import { proveAppearanceRecipeCandidateUniqueness } from "./appearanceRecipeCandidateUniqueness";
import { createRecipePhysicalMigrationFixture } from "./fixtures/recipePhysicalMigrationPair";

const sha = (character: string) => character.repeat(64);
const mutable = <T>(value: T): T => structuredClone(value);

function directCandidate(
  id: "affine_control" | "piecewise_control",
): AppearanceRecipeComponentCandidate {
  const affine = id === "affine_control";
  return {
    componentId: affine ? "component.affine" : "component.piecewise",
    sourceControlIds: [id],
    targetControlIds: [id],
    sourceUnlockDialIds: [],
    targetUnlockDialIds: [],
    status: "candidate",
    solver: affine ? "edge-affine" : "edge-piecewise",
    branchId: null,
    componentMapSha256: null,
    authorizedCandidateCount: 1,
    candidateSha256: sha(affine ? "a" : "b"),
    uniquenessMethod: affine ? "exact-affine" : "exact-piecewise",
    uniquenessProofSha256: sha("c"),
    values: { [id]: 0.6 },
    unlockedDialIds: [],
    controls: [],
    rejectionCodes: [],
  };
}

describe("Appearance Recipe candidate uniqueness", () => {
  it.each(["affine_control", "piecewise_control"] as const)(
    "proves %s from one exclusive strictly monotonic target observable",
    async (id) => {
      const fixture = await createRecipePhysicalMigrationFixture();
      const manifest = parseAppearanceDialsManifest(
        fixture.target.avatarManifest,
      )!;
      const first = await proveAppearanceRecipeCandidateUniqueness(
        fixture.edge,
        manifest,
        directCandidate(id),
      );
      const repeated = await proveAppearanceRecipeCandidateUniqueness(
        fixture.edge,
        manifest,
        directCandidate(id),
      );
      expect(repeated).toEqual(first);
      expect(first).toMatchObject({
        verified: true,
        authorizedCandidateCount: 1,
        method: id === "affine_control" ? "exact-affine" : "exact-piecewise",
        rejectionCodes: [],
      });
      expect(first.proofSha256).toMatch(/^[0-9a-f]{64}$/);
    },
  );

  it("rejects constant and non-monotonic target tracks", async () => {
    const fixture = await createRecipePhysicalMigrationFixture();
    const manifest = parseAppearanceDialsManifest(
      fixture.target.avatarManifest,
    )!;
    const constant = mutable(manifest);
    constant.dials.find(
      (dial) => dial.id === "affine_control",
    )!.members![0]!.track = [
      [-1, 0],
      [1, 0],
    ];
    await expect(
      proveAppearanceRecipeCandidateUniqueness(
        fixture.edge,
        constant,
        directCandidate("affine_control"),
      ),
    ).resolves.toMatchObject({
      verified: false,
      authorizedCandidateCount: 0,
      rejectionCodes: ["CANDIDATE_UNIQUENESS_UNPROVEN"],
    });

    const folded = mutable(manifest);
    folded.dials.find(
      (dial) => dial.id === "piecewise_control",
    )!.members![0]!.track = [
      [-1, -1],
      [0, 1],
      [1, 0],
    ];
    await expect(
      proveAppearanceRecipeCandidateUniqueness(
        fixture.edge,
        folded,
        directCandidate("piecewise_control"),
      ),
    ).resolves.toMatchObject({
      verified: false,
      authorizedCandidateCount: 0,
    });
  });

  it("rejects a target observable shared by another control", async () => {
    const fixture = await createRecipePhysicalMigrationFixture();
    const manifest = parseAppearanceDialsManifest(
      fixture.target.avatarManifest,
    )!;
    const shared = mutable(manifest);
    shared.dials
      .find((dial) => dial.id === "keep_control")!
      .members!.push({
        target: "affine_target",
        track: [
          [-1, -1],
          [0, 0],
          [1, 1],
        ],
      });
    await expect(
      proveAppearanceRecipeCandidateUniqueness(
        fixture.edge,
        shared,
        directCandidate("affine_control"),
      ),
    ).resolves.toMatchObject({
      verified: false,
      rejectionCodes: ["CANDIDATE_UNIQUENESS_UNPROVEN"],
    });
  });

  it("proves a changed root-scale law from its nonzero physical scalar", async () => {
    const fixture = await createRecipePhysicalMigrationFixture();
    const manifest = parseAppearanceDialsManifest(
      fixture.target.avatarManifest,
    )!;
    const rootScale = mutable(manifest);
    const dial = rootScale.dials.find(
      (entry) => entry.id === "affine_control",
    )!;
    dial.kind = "root-scale";
    delete dial.members;
    dial.scalePerUnit = 0.1;

    await expect(
      proveAppearanceRecipeCandidateUniqueness(
        fixture.edge,
        rootScale,
        directCandidate("affine_control"),
      ),
    ).resolves.toMatchObject({
      verified: true,
      authorizedCandidateCount: 1,
      method: "exact-affine",
    });

    dial.scalePerUnit = 0;
    await expect(
      proveAppearanceRecipeCandidateUniqueness(
        fixture.edge,
        rootScale,
        directCandidate("affine_control"),
      ),
    ).resolves.toMatchObject({
      verified: false,
      authorizedCandidateCount: 0,
    });
  });

  it("proves a follower-only remap from one strict follower output", async () => {
    const fixture = await createRecipePhysicalMigrationFixture();
    const manifest = parseAppearanceDialsManifest(
      fixture.target.avatarManifest,
    )!;
    const followerOnly = mutable(manifest);
    const dial = followerOnly.dials.find(
      (entry) => entry.id === "affine_control",
    )!;
    dial.kind = "follower-only";
    delete dial.members;
    dial.requirements = { followerRefs: ["affine_follower"] };
    followerOnly.followers.affine_follower = {
      contract: "appearance-followers/v2",
      space: "node-parent-rest",
      composition: "rest-relative-follower-channel-id-order/v2",
      interpolation: "linear-trs-slerp-rotation-morph/v2",
      extrapolation: "clamp",
      provenance: { ...followerOnly.targets.affine_target.provenance },
      nodeIds: ["body"],
      drivers: [
        {
          driver: { kind: "dial", id: "affine_control" },
          channels: [
            {
              id: "affine_follower_weight",
              kind: "morph-weight",
              node: "body",
              morph: "affine_shape",
              weightRange: [-1, 1],
              runtimeRetention: "recipe-only",
              samples: [
                [-1, -1],
                [0, 0],
                [1, 1],
              ],
            },
          ],
        },
      ],
    };

    await expect(
      proveAppearanceRecipeCandidateUniqueness(
        fixture.edge,
        followerOnly,
        directCandidate("affine_control"),
      ),
    ).resolves.toMatchObject({
      verified: true,
      authorizedCandidateCount: 1,
      method: "exact-affine",
    });

    const morphChannel =
      followerOnly.followers.affine_follower.drivers[0]!.channels[0];
    if (morphChannel.kind !== "morph-weight") {
      throw new Error("fixture follower channel is not morph-weight");
    }
    morphChannel.samples = [
      [-1, 0],
      [1, 0],
    ];
    await expect(
      proveAppearanceRecipeCandidateUniqueness(
        fixture.edge,
        followerOnly,
        directCandidate("affine_control"),
      ),
    ).resolves.toMatchObject({ verified: false });
  });

  it("rejects a target track that is also owned by a macro corner", async () => {
    const fixture = await createRecipePhysicalMigrationFixture();
    const manifest = parseAppearanceDialsManifest(
      fixture.target.avatarManifest,
    )!;
    const macroOwned = mutable(manifest);
    macroOwned.macroEngine = {
      corners: [
        {
          target: "affine_target",
          family: "fixture_macro",
          comps: {},
          fixedFactor: 1,
          baselineWeight: 0,
        },
      ],
    } as NonNullable<typeof macroOwned.macroEngine>;
    await expect(
      proveAppearanceRecipeCandidateUniqueness(
        fixture.edge,
        macroOwned,
        directCandidate("affine_control"),
      ),
    ).resolves.toMatchObject({ verified: false });
  });

  it("uses the separately verified canonical component-map path", async () => {
    const fixture = await createRecipePhysicalMigrationFixture();
    const manifest = parseAppearanceDialsManifest(
      fixture.target.avatarManifest,
    )!;
    const candidate: AppearanceRecipeComponentCandidate = {
      ...directCandidate("affine_control"),
      componentId: "component.complex",
      sourceControlIds: ["complex_a", "complex_b"],
      targetControlIds: ["complex_a", "complex_b"],
      solver: "component-map",
      componentMapSha256: fixture.componentMapBundle.maps[0]!.mapSha256,
      candidateSha256: sha("d"),
      uniquenessMethod: "canonical-component-map",
      uniquenessProofSha256:
        fixture.componentMapBundle.maps[0]!.uniquenessProofSha256,
      values: { complex_a: 0.2, complex_b: -0.1 },
    };
    await expect(
      proveAppearanceRecipeCandidateUniqueness(
        fixture.edge,
        manifest,
        candidate,
      ),
    ).resolves.toMatchObject({
      verified: true,
      authorizedCandidateCount: 1,
      method: "canonical-component-map",
    });
  });
});
