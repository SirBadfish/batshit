import { describe, expect, it } from "vitest";
import type { AppearanceDialValueState } from "../appearanceDials.contracts";
import {
  createRecipeComponentMapBundle,
  createRecipeExecutableComponentMap,
  type RecipeComponentMapBundle,
  type RecipeComponentMapMembership,
  type RecipeExecutableComponentMap,
} from "./componentMapContracts";
import {
  generateAppearanceRecipeComponentCandidates,
  type AppearanceRecipeCandidateGeneratorInput,
} from "./appearanceRecipeCandidateGenerator";
import {
  recipeUpdateV1Fixture,
  recipeUpdateV2Fixture,
  recipeUpdatesFixture,
} from "./fixtures/recipeUpdatePair";
import {
  recipeUpdateEdgeSha256,
  type RecipeUpdateEdge,
} from "./updateContracts";

const sha = (character: string) => character.repeat(64);
const mutable = <T>(value: T): any => structuredClone(value);

function sourceState(): AppearanceDialValueState {
  return {
    contract: "appearance-dial-values/v2",
    definitionSha256: recipeUpdateV1Fixture.identity.definitionSha256,
    neutralId: recipeUpdateV1Fixture.identity.neutralId,
    neutralRecipeSha256: recipeUpdateV1Fixture.identity.neutralRecipeSha256,
    values: Object.fromEntries(
      recipeUpdateV1Fixture.controls.map((control) => [
        control.id,
        control.value,
      ]),
    ),
    unlockedDialIds: [...recipeUpdateV1Fixture.unlockedDialIds],
  };
}

function targetRanges(): Record<string, [number, number]> {
  return Object.fromEntries(
    recipeUpdateV2Fixture.controls.map((control) => [
      control.id,
      [...control.range] as [number, number],
    ]),
  );
}

function sourceRanges(): Record<string, [number, number]> {
  return Object.fromEntries(
    recipeUpdateV1Fixture.controls.map((control) => [
      control.id,
      [...control.range] as [number, number],
    ]),
  );
}

function memberships(
  edge: RecipeUpdateEdge = recipeUpdatesFixture.edges[0],
): Record<string, RecipeComponentMapMembership> {
  const result: Record<string, RecipeComponentMapMembership> = {};
  for (const control of edge.controls) {
    const membership = (result[control.componentId] ??= {
      sourceControlIds: [],
      targetControlIds: [],
      sourceUnlockDialIds: [],
      targetUnlockDialIds: [],
    });
    if (edge.stableIdLedger.fromIds.includes(control.id)) {
      membership.sourceControlIds.push(control.id);
    }
    if (edge.stableIdLedger.toIds.includes(control.id)) {
      membership.targetControlIds.push(control.id);
    }
  }
  const bilateral = result["component.bilateral"];
  if (bilateral) {
    bilateral.sourceUnlockDialIds.push("bilateral_shape");
    bilateral.targetUnlockDialIds.push("bilateral_shape");
  }
  return Object.fromEntries(
    Object.entries(result)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([componentId, membership]) => [
        componentId,
        {
          sourceControlIds: membership.sourceControlIds.sort(),
          targetControlIds: membership.targetControlIds.sort(),
          sourceUnlockDialIds: membership.sourceUnlockDialIds.sort(),
          targetUnlockDialIds: membership.targetUnlockDialIds.sort(),
        },
      ]),
  );
}

function input(
  overrides: Partial<AppearanceRecipeCandidateGeneratorInput> = {},
): AppearanceRecipeCandidateGeneratorInput {
  const edge = overrides.edge ?? recipeUpdatesFixture.edges[0];
  return {
    edge,
    sourceState: overrides.sourceState ?? sourceState(),
    sourceControlRanges: overrides.sourceControlRanges ?? sourceRanges(),
    targetControlRanges: overrides.targetControlRanges ?? targetRanges(),
    componentMembership: overrides.componentMembership ?? memberships(edge),
    ...(overrides.componentMapBundle
      ? { componentMapBundle: overrides.componentMapBundle }
      : {}),
  };
}

function component(
  result: Awaited<
    ReturnType<typeof generateAppearanceRecipeComponentCandidates>
  >,
  id: string,
) {
  const found = result.components.find((entry) => entry.componentId === id);
  if (!found) throw new Error(`missing component ${id}`);
  return found;
}

async function rehashEdge(edge: RecipeUpdateEdge): Promise<RecipeUpdateEdge> {
  const next = mutable(edge) as RecipeUpdateEdge;
  next.edgeSha256 = await recipeUpdateEdgeSha256(next);
  return next;
}

async function affineMap(
  branches?: RecipeExecutableComponentMap["branches"],
): Promise<RecipeExecutableComponentMap> {
  return createRecipeExecutableComponentMap({
    mapId: "map.component.affine",
    componentId: "component.affine",
    sourceControlIds: ["affine_remap"],
    targetControlIds: ["affine_remap"],
    sourceUnlockDialIds: [],
    targetUnlockDialIds: [],
    branches: branches ?? [
      {
        branchId: "all",
        sourceDomain: [
          {
            controlId: "affine_remap",
            minimum: -1,
            maximum: 1,
            minimumInclusive: true,
            maximumInclusive: true,
          },
        ],
        sourceUnlockState: [],
        outputs: [
          {
            controlId: "affine_remap",
            constant: 0,
            terms: [{ sourceControlId: "affine_remap", coefficient: 0.5 }],
          },
        ],
        targetUnlockState: [],
      },
    ],
    auditedFixtureSha256: recipeUpdatesFixture.edges[0].proof.fixtureSha256,
    authoredPhysicalEvidenceSha256: sha("c"),
  });
}

async function mapBundle(
  map: RecipeExecutableComponentMap,
): Promise<RecipeComponentMapBundle> {
  const edge = recipeUpdatesFixture.edges[0];
  return createRecipeComponentMapBundle({
    contract: "recipe-component-maps/v1",
    schemaVersion: 1,
    directEdgeKey: edge.directEdgeKey,
    edgeSha256: edge.edgeSha256,
    fromSource: edge.from,
    toSource: edge.to,
    maps: [map],
  });
}

describe("Appearance Recipe candidate generator", () => {
  it("generates exact identity, affine, piecewise, neutral, removal, and rejection outcomes", async () => {
    const first = await generateAppearanceRecipeComponentCandidates(input());
    const repeated = await generateAppearanceRecipeComponentCandidates(input());
    expect(repeated).toEqual(first);
    expect(first.components.map((entry) => entry.componentId)).toEqual(
      [...first.components.map((entry) => entry.componentId)].sort(),
    );

    expect(component(first, "component.affine")).toMatchObject({
      status: "candidate",
      solver: "edge-affine",
      authorizedCandidateCount: 1,
      values: { affine_remap: 0.75 },
      rejectionCodes: [],
    });
    expect(component(first, "component.piecewise")).toMatchObject({
      status: "candidate",
      solver: "edge-piecewise",
      values: { piecewise_remap: 0.6 },
    });
    expect(component(first, "component.keep").controls[0]).toMatchObject({
      sourceValue: 0.35,
      targetValue: 0.35,
      resolution: "kept",
      candidateOrigin: "identity",
      preserved: true,
    });
    expect(component(first, "component.new")).toMatchObject({
      status: "candidate",
      values: { new_control: 0 },
    });
    expect(
      component(first, "component.removed.zero").controls[0],
    ).toMatchObject({
      resolution: "removed-neutral",
      sourceValue: 0,
      targetValue: null,
      requiresPreview: false,
      preserved: true,
    });
    expect(component(first, "component.removed.active")).toMatchObject({
      status: "non-preserved",
      rejectionCodes: ["COMPONENT_MAP_MISSING"],
    });
    expect(
      component(first, "component.removed.active").controls[0],
    ).toMatchObject({
      resolution: "removed-active-preview",
      requiresPreview: true,
      requiresConfirmation: true,
      preserved: false,
    });
    expect(component(first, "component.reset")).toMatchObject({
      status: "non-preserved",
      values: { reset_required: 0 },
      rejectionCodes: ["CANDIDATE_UNREACHABLE"],
    });
    expect(component(first, "component.blocked")).toMatchObject({
      status: "rejected",
      authorizedCandidateCount: 0,
      candidateSha256: null,
      values: null,
      rejectionCodes: ["COMPONENT_PROOF_FAILED"],
    });
    expect(component(first, "component.bilateral")).toMatchObject({
      status: "candidate",
      unlockedDialIds: ["bilateral_shape"],
      values: {
        bilateral_shape: 0.25,
        "bilateral_shape.left_offset": 0.1,
        "bilateral_shape.right_offset": -0.1,
      },
    });
    expect(component(first, "component.macro").status).toBe("candidate");
    expect(component(first, "component.shared-clamp").status).toBe("candidate");
  });

  it("rejects out-of-range affine output and piecewise gaps/non-monotonic ambiguity without clamping", async () => {
    const outOfRangeState = sourceState();
    outOfRangeState.values.affine_remap = 1;
    const outOfRange = await generateAppearanceRecipeComponentCandidates(
      input({ sourceState: outOfRangeState }),
    );
    expect(component(outOfRange, "component.affine")).toMatchObject({
      status: "rejected",
      values: null,
      rejectionCodes: ["CANDIDATE_OUT_OF_RANGE", "IMPLICIT_CLAMP_REQUIRED"],
    });

    const gapEdge = mutable(recipeUpdatesFixture.edges[0]) as RecipeUpdateEdge;
    const gapControl = gapEdge.controls.find(
      (entry) => entry.id === "piecewise_remap",
    )!;
    if (gapControl.mapping?.kind !== "piecewise") throw new Error("fixture");
    gapControl.mapping.points = [
      [-0.25, -0.5],
      [0.25, 0.5],
    ];
    const verifiedGapEdge = await rehashEdge(gapEdge);
    const gap = await generateAppearanceRecipeComponentCandidates(
      input({
        edge: verifiedGapEdge,
        componentMembership: memberships(verifiedGapEdge),
      }),
    );
    expect(component(gap, "component.piecewise")).toMatchObject({
      status: "rejected",
      rejectionCodes: ["CANDIDATE_UNREACHABLE"],
    });

    const ambiguousEdge = mutable(
      recipeUpdatesFixture.edges[0],
    ) as RecipeUpdateEdge;
    const ambiguousControl = ambiguousEdge.controls.find(
      (entry) => entry.id === "piecewise_remap",
    )!;
    if (ambiguousControl.mapping?.kind !== "piecewise") {
      throw new Error("fixture");
    }
    ambiguousControl.mapping.points = [
      [-1, -1],
      [0, 0.75],
      [1, 0.5],
    ];
    const verifiedAmbiguousEdge = await rehashEdge(ambiguousEdge);
    const ambiguous = await generateAppearanceRecipeComponentCandidates(
      input({
        edge: verifiedAmbiguousEdge,
        componentMembership: memberships(verifiedAmbiguousEdge),
      }),
    );
    expect(component(ambiguous, "component.piecewise")).toMatchObject({
      status: "rejected",
      rejectionCodes: ["CANDIDATE_AMBIGUOUS"],
    });
  });

  it("lets one exact component map atomically override its complete component", async () => {
    const map = await affineMap();
    const bundle = await mapBundle(map);
    const result = await generateAppearanceRecipeComponentCandidates(
      input({ componentMapBundle: bundle }),
    );
    expect(component(result, "component.affine")).toMatchObject({
      status: "candidate",
      solver: "component-map",
      branchId: "all",
      componentMapSha256: map.mapSha256,
      values: { affine_remap: 0.25 },
      rejectionCodes: [],
    });

    const gapMap = await affineMap([
      {
        branchId: "negative-only",
        sourceDomain: [
          {
            controlId: "affine_remap",
            minimum: -1,
            maximum: 0,
            minimumInclusive: true,
            maximumInclusive: true,
          },
        ],
        sourceUnlockState: [],
        outputs: [
          {
            controlId: "affine_remap",
            constant: 0,
            terms: [{ sourceControlId: "affine_remap", coefficient: 1 }],
          },
        ],
        targetUnlockState: [],
      },
    ]);
    const gapResult = await generateAppearanceRecipeComponentCandidates(
      input({ componentMapBundle: await mapBundle(gapMap) }),
    );
    expect(component(gapResult, "component.affine")).toMatchObject({
      status: "rejected",
      solver: "component-map",
      rejectionCodes: ["COMPONENT_MAP_DOMAIN_GAP"],
    });

    const overlapBase = (await affineMap()).branches[0];
    const overlapMap = await affineMap([
      { ...mutable(overlapBase), branchId: "a" },
      { ...mutable(overlapBase), branchId: "b" },
    ]);
    const overlapResult = await generateAppearanceRecipeComponentCandidates(
      input({ componentMapBundle: await mapBundle(overlapMap) }),
    );
    expect(component(overlapResult, "component.affine")).toMatchObject({
      status: "rejected",
      rejectionCodes: ["COMPONENT_MAP_DOMAIN_AMBIGUOUS"],
    });
  });

  it("requires component maps for changed coupled, macro, and bilateral behavior", async () => {
    for (const controlId of [
      "bilateral_shape",
      "macro_weight",
      "shared_clamp_a",
    ]) {
      const changed = mutable(
        recipeUpdatesFixture.edges[0],
      ) as RecipeUpdateEdge;
      const control = changed.controls.find((entry) => entry.id === controlId)!;
      control.action = "affine";
      control.mapping = {
        kind: "affine",
        scale: 1,
        offset: 0.1,
        proofSha256: sha("d"),
      };
      const edge = await rehashEdge(changed);
      const result = await generateAppearanceRecipeComponentCandidates(
        input({ edge, componentMembership: memberships(edge) }),
      );
      expect(component(result, control.componentId)).toMatchObject({
        status: "rejected",
        rejectionCodes: ["COMPONENT_MAP_MISSING"],
      });

      const membership = memberships(edge)[control.componentId]!;
      const map = await createRecipeExecutableComponentMap({
        mapId: `map.${control.componentId}`,
        componentId: control.componentId,
        sourceControlIds: membership.sourceControlIds,
        targetControlIds: membership.targetControlIds,
        sourceUnlockDialIds: membership.sourceUnlockDialIds,
        targetUnlockDialIds: membership.targetUnlockDialIds,
        branches: [
          {
            branchId: "all",
            sourceDomain: membership.sourceControlIds.map((id) => ({
              controlId: id,
              minimum: sourceRanges()[id]![0],
              maximum: sourceRanges()[id]![1],
              minimumInclusive: true,
              maximumInclusive: true,
            })),
            sourceUnlockState: membership.sourceUnlockDialIds.map((id) => ({
              dialId: id,
              unlocked: sourceState().unlockedDialIds.includes(id),
            })),
            outputs: membership.targetControlIds.map((id) => ({
              controlId: id,
              constant: 0,
              terms: [{ sourceControlId: id, coefficient: 1 }],
            })),
            targetUnlockState: membership.targetUnlockDialIds.map((id) => ({
              dialId: id,
              unlocked: sourceState().unlockedDialIds.includes(id),
            })),
          },
        ],
        auditedFixtureSha256: edge.proof.fixtureSha256,
        authoredPhysicalEvidenceSha256: sha("c"),
      });
      const bundle = await createRecipeComponentMapBundle({
        contract: "recipe-component-maps/v1",
        schemaVersion: 1,
        directEdgeKey: edge.directEdgeKey,
        edgeSha256: edge.edgeSha256,
        fromSource: edge.from,
        toSource: edge.to,
        maps: [map],
      });
      const mapped = await generateAppearanceRecipeComponentCandidates(
        input({
          edge,
          componentMembership: memberships(edge),
          componentMapBundle: bundle,
        }),
      );
      expect(component(mapped, control.componentId)).toMatchObject({
        status: "candidate",
        solver: "component-map",
        authorizedCandidateCount: 1,
        uniquenessMethod: "canonical-component-map",
        rejectionCodes: [],
      });
    }

    const resetMacro = mutable(
      recipeUpdatesFixture.edges[0],
    ) as RecipeUpdateEdge;
    const resetControl = resetMacro.controls.find(
      (entry) => entry.id === "macro_weight",
    )!;
    resetControl.action = "reset-required";
    resetControl.mapping = null;
    const resetEdge = await rehashEdge(resetMacro);
    const resetResult = await generateAppearanceRecipeComponentCandidates(
      input({ edge: resetEdge, componentMembership: memberships(resetEdge) }),
    );
    expect(component(resetResult, "component.macro")).toMatchObject({
      status: "non-preserved",
      values: { macro_weight: 0 },
      rejectionCodes: ["CANDIDATE_UNREACHABLE"],
    });
  });

  it("requires one atomic map for aliases and active-removal preservation", async () => {
    const aliasEdge = mutable(
      recipeUpdatesFixture.edges[0],
    ) as RecipeUpdateEdge;
    const removed = aliasEdge.controls.find(
      (entry) => entry.id === "removed_active",
    )!;
    const added = aliasEdge.controls.find(
      (entry) => entry.id === "new_control",
    )!;
    removed.componentId = "component.alias";
    added.componentId = "component.alias";
    const map = await createRecipeExecutableComponentMap({
      mapId: "map.component.alias",
      componentId: "component.alias",
      sourceControlIds: ["removed_active"],
      targetControlIds: ["new_control"],
      sourceUnlockDialIds: [],
      targetUnlockDialIds: [],
      branches: [
        {
          branchId: "all",
          sourceDomain: [
            {
              controlId: "removed_active",
              minimum: -1,
              maximum: 1,
              minimumInclusive: true,
              maximumInclusive: true,
            },
          ],
          sourceUnlockState: [],
          outputs: [
            {
              controlId: "new_control",
              constant: 0,
              terms: [{ sourceControlId: "removed_active", coefficient: 1 }],
            },
          ],
          targetUnlockState: [],
        },
      ],
      auditedFixtureSha256: aliasEdge.proof.fixtureSha256,
      authoredPhysicalEvidenceSha256: sha("c"),
    });
    aliasEdge.aliases = [
      {
        fromId: "removed_active",
        toId: "new_control",
        reason: "The renamed control is physically identical.",
        physicalEquivalenceProofSha256: sha("e"),
        componentMapSha256: map.mapSha256,
      },
    ];
    const edge = await rehashEdge(aliasEdge);
    const bundle = await createRecipeComponentMapBundle({
      contract: "recipe-component-maps/v1",
      schemaVersion: 1,
      directEdgeKey: edge.directEdgeKey,
      edgeSha256: edge.edgeSha256,
      fromSource: edge.from,
      toSource: edge.to,
      maps: [map],
    });
    const result = await generateAppearanceRecipeComponentCandidates(
      input({
        edge,
        componentMembership: memberships(edge),
        componentMapBundle: bundle,
      }),
    );
    const alias = component(result, "component.alias");
    expect(alias).toMatchObject({
      status: "candidate",
      solver: "component-map",
      values: { new_control: 0.45 },
      rejectionCodes: [],
    });
    expect(alias.controls).toEqual([
      expect.objectContaining({
        ledgerId: "new_control",
        resolution: "alias-target",
        aliasId: "removed_active:new_control",
      }),
      expect.objectContaining({
        ledgerId: "removed_active",
        resolution: "alias-source",
        aliasId: "removed_active:new_control",
      }),
    ]);
  });

  it("fails closed on membership drift and tampered component-map hashes", async () => {
    const drifted = memberships();
    drifted["component.affine"].targetControlIds = [];
    await expect(
      generateAppearanceRecipeComponentCandidates(
        input({ componentMembership: drifted }),
      ),
    ).rejects.toThrow(/component membership does not exhaust/);

    const bundle = mutable(await mapBundle(await affineMap()));
    bundle.maps[0].branches[0].outputs[0].constant = 0.1;
    await expect(
      generateAppearanceRecipeComponentCandidates(
        input({ componentMapBundle: bundle }),
      ),
    ).rejects.toThrow(
      /component map bundle hash mismatch|component map .* hash mismatch|map .* hash mismatch/,
    );
  });
});
