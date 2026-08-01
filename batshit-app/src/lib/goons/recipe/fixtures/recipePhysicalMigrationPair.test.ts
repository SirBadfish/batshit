import { unzipSync } from "fflate";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { describe, expect, it } from "vitest";
import { parseAppearanceDialsManifest } from "../../appearanceDials.schema";
import {
  bindCustomPerformanceRig,
  resolveCustomPerformanceRigManifest,
} from "../../customPerformanceRig";
import { buildAppearanceRecipeDependencyGraph } from "../appearanceRecipeDependencyGraph";
import { buildAppearanceRecipePhysicalBasisFromGlb } from "../appearanceRecipePhysicalModel";
import { verifyRecipeComponentMapBundle } from "../componentMapContracts";
import { verifyRecipeSourceManifest } from "../packageMetadata";
import { sha256Hex } from "../recipeCanonical";
import { verifyRecipeStateSnapshot } from "../recipeContracts";
import { verifyRecipeSourceProjectionHashes } from "../sourcePackageProjections";
import { appearanceRecipeControlInventory } from "../strictAppearanceRecipeResolver";
import { verifyRecipeUpdateEdge } from "../updateContracts";
import {
  RECIPE_PHYSICAL_MIGRATION_FIXTURE_CONTRACT,
  createRecipePhysicalMigrationFixture,
} from "./recipePhysicalMigrationPair";
import recipePhysicalMigrationOracle from "./recipePhysicalMigrationOracle.json";

function membershipFor(
  graph: ReturnType<typeof buildAppearanceRecipeDependencyGraph>,
  sourceIds: string[],
  targetIds: string[],
) {
  const result: Record<
    string,
    {
      sourceControlIds: string[];
      targetControlIds: string[];
      sourceUnlockDialIds: string[];
      targetUnlockDialIds: string[];
    }
  > = {};
  for (const component of graph.components) {
    const controls = component.controlIds.map((id) =>
      id.slice("control:".length),
    );
    if (controls.length === 0) continue;
    const edgeComponentId = controls.includes("complex_a")
      ? "component.complex"
      : null;
    if (!edgeComponentId) continue;
    result[edgeComponentId] = {
      sourceControlIds: controls.filter((id) => sourceIds.includes(id)).sort(),
      targetControlIds: controls.filter((id) => targetIds.includes(id)).sort(),
      sourceUnlockDialIds: [],
      targetUnlockDialIds: [],
    };
  }
  return result;
}

describe("SA-090 R2 physical migration fixture", () => {
  it("builds byte-for-byte deterministic source and target packages", async () => {
    const first = await createRecipePhysicalMigrationFixture();
    const repeated = await createRecipePhysicalMigrationFixture();

    expect(first.contract).toBe(RECIPE_PHYSICAL_MIGRATION_FIXTURE_CONTRACT);
    expect(repeated).toEqual(first);
    expect(first.fixtureSha256).toMatch(/^[0-9a-f]{64}$/);
    const sourceEntries = unzipSync(first.source.packageBytes);
    expect(await sha256Hex(sourceEntries["avatar.glb"]!)).toBe(
      await sha256Hex(first.source.glbBytes),
    );
    expect(await sha256Hex(sourceEntries["avatar.json"]!)).toBe(
      await sha256Hex(first.source.manifestBytes),
    );
    expect(await sha256Hex(first.source.glbBytes)).toBe(
      first.source.identity.modelSha256,
    );
    expect(await sha256Hex(first.target.glbBytes)).toBe(
      first.target.identity.modelSha256,
    );
    expect(first.source.identity.topologySha256).toBe(
      first.target.identity.topologySha256,
    );
    expect(first.source.identity.skeletonHierarchySha256).toBe(
      first.target.identity.skeletonHierarchySha256,
    );
    expect(first.source.identity.physicalBasisSha256).not.toBe(
      first.target.identity.physicalBasisSha256,
    );
  });

  it("can add a runtime-valid performance rig without changing the frozen default fixture", async () => {
    const frozen = await createRecipePhysicalMigrationFixture({
      runtimeMorphName: "blink_runtime",
    });
    const acceptance = await createRecipePhysicalMigrationFixture({
      runtimeMorphName: "blink_runtime",
      runtimePreviewCompatible: true,
    });

    expect(acceptance.fixtureSha256).not.toBe(frozen.fixtureSha256);
    for (const side of [acceptance.source, acceptance.target]) {
      const rig = side.avatarManifest.rig as Record<string, unknown>;
      const resolved = resolveCustomPerformanceRigManifest(rig.performance, {
        required: true,
      });
      expect(resolved.issues).toEqual([]);
      expect(resolved.manifest).not.toBeNull();
      if (!resolved.manifest) throw new Error("Expected a performance rig.");

      const glb = side.glbBytes.slice();
      const gltf = await new GLTFLoader().parseAsync(
        glb.buffer as ArrayBuffer,
        "",
      );
      const binding = bindCustomPerformanceRig(gltf.scene, resolved.manifest);
      expect(binding.issues).toEqual([]);
      expect(binding.runtime).not.toBeNull();
      binding.runtime?.dispose();
    }
  });

  it("matches the separate frozen R2 physical oracle", async () => {
    const fixture = await createRecipePhysicalMigrationFixture();
    expect(recipePhysicalMigrationOracle).toMatchObject({
      contract: "sa090-recipe-r2-physical-fixture-oracle/v1",
      fixtureSha256: fixture.fixtureSha256,
      sourcePackageSha256: fixture.source.recipeSource.package.sha256,
      sourceModelSha256: fixture.source.identity.modelSha256,
      sourceManifestSha256: fixture.source.recipeSource.manifest.sha256,
      targetPackageSha256: fixture.target.recipeSource.package.sha256,
      targetModelSha256: fixture.target.identity.modelSha256,
      targetManifestSha256: fixture.target.recipeSource.manifest.sha256,
      sourceManifestSemanticSha256:
        fixture.source.identity.manifestSemanticSha256,
      targetManifestSemanticSha256:
        fixture.target.identity.manifestSemanticSha256,
      edgeSha256: fixture.edge.edgeSha256,
      componentMapBundleSha256: fixture.componentMapBundle.bundleSha256,
      sourceStateSha256: fixture.sourceState.stateSha256,
    });
  });

  it("verifies both embedded source identities and every derived projection", async () => {
    const fixture = await createRecipePhysicalMigrationFixture();
    for (const side of [fixture.source, fixture.target]) {
      await expect(
        verifyRecipeSourceManifest(
          side.avatarManifest,
          await sha256Hex(side.glbBytes),
        ),
      ).resolves.toEqual(side.identity);
      await expect(
        verifyRecipeSourceProjectionHashes(
          side.identity,
          side.avatarManifest,
          side.glbBytes,
        ),
      ).resolves.toBeDefined();
      expect(
        buildAppearanceRecipePhysicalBasisFromGlb(
          side.glbBytes,
          side.avatarManifest,
        ).meshes,
      ).toHaveLength(1);
    }
  });

  it("carries the exact migration case ledger and three absent sibling inputs", async () => {
    const fixture = await createRecipePhysicalMigrationFixture();
    await expect(verifyRecipeUpdateEdge(fixture.edge)).resolves.toEqual(
      fixture.edge,
    );
    expect(
      Object.fromEntries(
        fixture.edge.controls.map((control) => [control.id, control.action]),
      ),
    ).toEqual({
      affine_control: "affine",
      complex_a: "affine",
      complex_b: "keep",
      keep_control: "keep",
      new_control: "new",
      piecewise_control: "piecewise",
      removed_control: "removed",
    });
    expect(fixture.sourceState.appearanceDials.values.removed_control).toBe(0);
    expect(Object.keys(fixture.siblingInputs).sort()).toEqual([
      "eyeAppearance",
      "facialArtwork",
      "oralAppearance",
    ]);
    expect(
      Object.values(fixture.siblingInputs).every(
        (input) =>
          input.sourceStateId === null &&
          input.targetStateId === null &&
          input.targetDefinition === null,
      ),
    ).toBe(true);
    await expect(
      verifyRecipeStateSnapshot(fixture.sourceState),
    ).resolves.toEqual(fixture.sourceState);
  });

  it("proves the coupled component requires and carries one exhaustive component map", async () => {
    const fixture = await createRecipePhysicalMigrationFixture();
    const sourceManifest = parseAppearanceDialsManifest(
      fixture.source.avatarManifest,
    )!;
    const targetManifest = parseAppearanceDialsManifest(
      fixture.target.avatarManifest,
    )!;
    const sourceGraph = buildAppearanceRecipeDependencyGraph(sourceManifest);
    const targetGraph = buildAppearanceRecipeDependencyGraph(targetManifest);
    const sourceComplex = sourceGraph.components.find((component) =>
      component.controlIds.includes("control:complex_a"),
    );
    const targetComplex = targetGraph.components.find((component) =>
      component.controlIds.includes("control:complex_a"),
    );
    expect(sourceComplex?.controlIds).toEqual([
      "control:complex_a",
      "control:complex_b",
    ]);
    expect(targetComplex?.controlIds).toEqual(sourceComplex?.controlIds);

    const sourceInventory = appearanceRecipeControlInventory(sourceManifest);
    const targetInventory = appearanceRecipeControlInventory(targetManifest);
    const componentMembership = membershipFor(
      sourceGraph,
      fixture.edge.stableIdLedger.fromIds,
      fixture.edge.stableIdLedger.toIds,
    );
    await expect(
      verifyRecipeComponentMapBundle(fixture.componentMapBundle, {
        edge: fixture.edge,
        sourceControlRanges: sourceInventory.ranges,
        targetControlRanges: targetInventory.ranges,
        componentMembership,
      }),
    ).resolves.toEqual(fixture.componentMapBundle);
  });
});
