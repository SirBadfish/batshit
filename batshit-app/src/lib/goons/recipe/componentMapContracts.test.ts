import { describe, expect, it } from "vitest";
import {
  createRecipeComponentMapBundle,
  createRecipeExecutableComponentMap,
  evaluateRecipeComponentMap,
  parseRecipeComponentMapBundle,
  recipeComponentMapBundleSha256,
  selectRecipeComponentMapBranch,
  verifyRecipeComponentMapBundle,
  type RecipeComponentMapBundle,
  type RecipeExecutableComponentMap,
} from "./componentMapContracts";
import type { RecipeUpdateEdge } from "./updateContracts";
import {
  recipeUpdateV1Fixture,
  recipeUpdateV2Fixture,
  recipeUpdatesFixture,
} from "./fixtures/recipeUpdatePair";

const sha = (character: string): string => character.repeat(64);
const mutable = <T>(value: T): any => structuredClone(value);

async function fixtureMap(): Promise<RecipeExecutableComponentMap> {
  return createRecipeExecutableComponentMap({
    mapId: "map.component.affine",
    componentId: "component.affine",
    sourceControlIds: ["affine_remap"],
    targetControlIds: ["affine_remap"],
    sourceUnlockDialIds: [],
    targetUnlockDialIds: [],
    branches: [
      {
        branchId: "negative",
        sourceDomain: [
          {
            controlId: "affine_remap",
            minimum: -1,
            maximum: 0,
            minimumInclusive: true,
            maximumInclusive: false,
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
      {
        branchId: "nonnegative",
        sourceDomain: [
          {
            controlId: "affine_remap",
            minimum: 0,
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
            terms: [{ sourceControlId: "affine_remap", coefficient: 1.5 }],
          },
        ],
        targetUnlockState: [],
      },
    ],
    auditedFixtureSha256: recipeUpdatesFixture.edges[0].proof.fixtureSha256,
    authoredPhysicalEvidenceSha256: sha("c"),
  });
}

async function boundFixture(): Promise<{
  map: RecipeExecutableComponentMap;
  bundle: RecipeComponentMapBundle;
  edge: RecipeUpdateEdge;
}> {
  const map = await fixtureMap();
  const bundle = await createRecipeComponentMapBundle({
    contract: "recipe-component-maps/v1",
    schemaVersion: 1,
    directEdgeKey: recipeUpdatesFixture.edges[0].directEdgeKey,
    edgeSha256: recipeUpdatesFixture.edges[0].edgeSha256,
    fromSource: recipeUpdateV1Fixture.identity,
    toSource: recipeUpdateV2Fixture.identity,
    maps: [map],
  });
  const edge = recipeUpdatesFixture.edges[0];
  return { map, bundle, edge };
}

describe("Recipe executable component maps", () => {
  it("selects exactly one half-open branch and evaluates a finite in-range target", async () => {
    const map = await fixtureMap();
    expect(
      selectRecipeComponentMapBranch(map, { affine_remap: 0 }, []).branchId,
    ).toBe("nonnegative");
    expect(
      evaluateRecipeComponentMap(map, { affine_remap: 0.5 }, [], {
        targetControlRanges: { affine_remap: [-1, 1] },
      }),
    ).toEqual({
      branchId: "nonnegative",
      values: { affine_remap: 0.75 },
      unlockedDialIds: [],
    });
  });

  it("rejects branch gaps, overlaps, incomplete inputs, and out-of-range output", async () => {
    const map = await fixtureMap();
    expect(() =>
      selectRecipeComponentMapBranch(map, { affine_remap: 2 }, []),
    ).toThrow(/unreachable/);

    const overlap = mutable(map);
    overlap.branches[0].sourceDomain[0].maximumInclusive = true;
    overlap.branches[0].sourceDomain[0].maximum = 0.5;
    overlap.mapSha256 = await (async () => {
      const { mapSha256: _hash, ...content } = overlap;
      content.uniquenessProofSha256 = sha("0");
      const created = await createRecipeExecutableComponentMap(content);
      return created.mapSha256;
    })();
    expect(() =>
      selectRecipeComponentMapBranch(overlap, { affine_remap: 0.25 }, []),
    ).toThrow(/ambiguous/);

    expect(() => selectRecipeComponentMapBranch(map, {}, [])).toThrow(
      /not exhaustive/,
    );
    expect(() =>
      evaluateRecipeComponentMap(map, { affine_remap: 1 }, [], {
        targetControlRanges: { affine_remap: [-1, 1] },
      }),
    ).toThrow(/out of range/);
  });

  it("rejects zero/duplicate terms, branch coverage drift, and unknown fields", async () => {
    const map = mutable(await fixtureMap());
    map.branches[0].outputs[0].terms[0].coefficient = 0;
    expect(() => parseRecipeComponentMapBundle({})).toThrow();
    expect(() =>
      selectRecipeComponentMapBranch(map, { affine_remap: -0.5 }, []),
    ).toThrow(/may not be zero/);

    const duplicate = mutable(await fixtureMap());
    duplicate.branches[0].outputs[0].terms.push(
      duplicate.branches[0].outputs[0].terms[0],
    );
    expect(() =>
      selectRecipeComponentMapBranch(duplicate, { affine_remap: -0.5 }, []),
    ).toThrow(/sorted and unique/);

    const missingOutput = mutable(await fixtureMap());
    missingOutput.branches[0].outputs = [];
    expect(() =>
      selectRecipeComponentMapBranch(missingOutput, { affine_remap: -0.5 }, []),
    ).toThrow(/not exhaustive/);

    const unknown = mutable(await fixtureMap());
    unknown.surprise = true;
    expect(() =>
      selectRecipeComponentMapBranch(unknown, { affine_remap: -0.5 }, []),
    ).toThrow(/must contain exactly/);
  });

  it("verifies edge/source/component/range binding and both self hashes", async () => {
    const { bundle, edge } = await boundFixture();
    const verified = await verifyRecipeComponentMapBundle(bundle, {
      edge,
      sourceControlRanges: { affine_remap: [-1, 1] },
      targetControlRanges: { affine_remap: [-1, 1] },
      componentMembership: {
        "component.affine": {
          sourceControlIds: ["affine_remap"],
          targetControlIds: ["affine_remap"],
          sourceUnlockDialIds: [],
          targetUnlockDialIds: [],
        },
      },
    });
    expect(verified.bundleSha256).toBe(
      await recipeComponentMapBundleSha256(bundle),
    );

    const tamperedMap = mutable(bundle);
    tamperedMap.maps[0].branches[1].outputs[0].constant = 0.1;
    await expect(
      verifyRecipeComponentMapBundle(tamperedMap, {
        edge,
        sourceControlRanges: { affine_remap: [-1, 1] },
        targetControlRanges: { affine_remap: [-1, 1] },
        componentMembership: {
          "component.affine": {
            sourceControlIds: ["affine_remap"],
            targetControlIds: ["affine_remap"],
            sourceUnlockDialIds: [],
            targetUnlockDialIds: [],
          },
        },
      }),
    ).rejects.toThrow(/map .* hash mismatch/);

    const badMembership = {
      "component.affine": {
        sourceControlIds: ["another"],
        targetControlIds: ["affine_remap"],
        sourceUnlockDialIds: [],
        targetUnlockDialIds: [],
      },
    };
    await expect(
      verifyRecipeComponentMapBundle(bundle, {
        edge,
        sourceControlRanges: { affine_remap: [-1, 1] },
        targetControlRanges: { affine_remap: [-1, 1] },
        componentMembership: badMembership,
      }),
    ).rejects.toThrow(/component membership/);

    const {
      mapSha256: _mapSha256,
      uniquenessProofSha256: _uniquenessProofSha256,
      ...mapContent
    } = bundle.maps[0];
    const wrongMap = await createRecipeExecutableComponentMap({
      ...mapContent,
      auditedFixtureSha256: sha("f"),
    });
    const wrongFixture = await createRecipeComponentMapBundle({
      contract: "recipe-component-maps/v1",
      schemaVersion: 1,
      directEdgeKey: bundle.directEdgeKey,
      edgeSha256: bundle.edgeSha256,
      fromSource: bundle.fromSource,
      toSource: bundle.toSource,
      maps: [wrongMap],
    });
    await expect(
      verifyRecipeComponentMapBundle(wrongFixture, {
        edge,
        sourceControlRanges: { affine_remap: [-1, 1] },
        targetControlRanges: { affine_remap: [-1, 1] },
        componentMembership: {
          "component.affine": {
            sourceControlIds: ["affine_remap"],
            targetControlIds: ["affine_remap"],
            sourceUnlockDialIds: [],
            targetUnlockDialIds: [],
          },
        },
      }),
    ).rejects.toThrow(/another audited fixture/);
  });
});
