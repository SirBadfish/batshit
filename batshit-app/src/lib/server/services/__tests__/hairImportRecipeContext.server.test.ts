import { describe, expect, it } from "vitest";

import { canonicalizeHairImportSelection } from "$lib/goons/hairImportIntake";
import { createRecipePhysicalMigrationFixture } from "$lib/goons/recipe/fixtures/recipePhysicalMigrationPair";

import { proposeHairImportAuthoringInput } from "../hairImportRecipeContext.server";

describe("Hair import Recipe proposal context", () => {
  it("proposes reviewed clumps plus validator-safe head, neck, and body colliders", async () => {
    const fixture = await createRecipePhysicalMigrationFixture({
      runtimePreviewCompatible: true,
      hairImportCompatible: true,
    });
    const appearanceManifest = structuredClone(
      fixture.source.avatarManifest,
    ) as Record<string, unknown>;
    const appearance = appearanceManifest.appearanceDials as Record<
      string,
      unknown
    >;
    const dials = appearance.dials as Array<Record<string, unknown>>;
    for (const [sourceId, id] of [
      ["piecewise_control", "neck_thickness"],
      ["complex_a", "shoulder_distance"],
      ["complex_b", "trap_slope"],
    ]) {
      const dial = dials.find((entry) => entry.id === sourceId)!;
      dial.id = id;
      dial.label = id;
      dial.description = `Fixture ${id}.`;
      dial.keywords = [id];
    }
    dials.sort((left, right) =>
      String(left.id).localeCompare(String(right.id)),
    );
    const canonical = canonicalizeHairImportSelection({
      bytes: new TextEncoder().encode(`o Hair
v -0.1 1.45 0
v 0.1 1.45 0
v 0 1.8 0
f 1 2 3
`),
    });

    const proposal = proposeHairImportAuthoringInput({
      canonical,
      context: {
        recipeSourceGlb: fixture.source.glbBytes,
        appearanceManifest,
        recipeSource: fixture.source.identity,
        bodyManifestNodeId: "body",
        headRigNode: "HeadAnchor",
        neckRigNode: "HeadAnchor",
        authoredRootMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1],
      },
      assetId: "hair-context-fixture",
      revisionId: "hair-context-fixture-r1",
    });

    expect(proposal.clumps).toHaveLength(1);
    expect(proposal.followerDrivers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ dialId: "head_size", endpoint: -1 }),
        expect.objectContaining({ dialId: "head_size", endpoint: 1 }),
      ]),
    );
    expect(proposal.colliders).toHaveLength(3);
    expect(proposal.colliders[0]).toMatchObject({
      id: "head-shell",
      shape: "sphere",
      offset: [0, 0.08, 0.03],
      tailOffset: [0, 0.08, 0.03],
    });
    expect(proposal.colliders[2]).toMatchObject({
      id: "shoulder-chest-clearance",
      manifestNodeId: "body",
    });
    expect(proposal.colliders[1]?.drivers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ dialId: "neck_thickness", endpoint: -1 }),
        expect.objectContaining({ dialId: "neck_thickness", endpoint: 1 }),
      ]),
    );
    expect(proposal.colliders[2]?.drivers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ dialId: "shoulder_distance", endpoint: -1 }),
        expect.objectContaining({ dialId: "shoulder_distance", endpoint: 1 }),
        expect.objectContaining({ dialId: "trap_slope", endpoint: -1 }),
        expect.objectContaining({ dialId: "trap_slope", endpoint: 1 }),
      ]),
    );
  });
});
