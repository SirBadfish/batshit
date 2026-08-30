import { describe, expect, it } from "vitest";
import {
  RECIPE_UPDATE_PAIR_FIXTURE_SHA256,
  recipeFixtureValues,
  recipeMigrationReportFixture,
  recipeUpdateReadyJobFixture,
  recipeUpdateV1Fixture,
  recipeUpdateV2Fixture,
  recipeUpdatesFixture,
} from "./fixtures/recipeUpdatePair";
import { canonicalRecipeSha256 } from "./recipeCanonical";
import { createRecipePhysicalMigrationFixture } from "./fixtures/recipePhysicalMigrationPair";
import {
  parseRecipeMigrationReport,
  parseRecipeUpdateJob,
  parseRecipeUpdatesContract,
  buildRecipeUpdateDirectEdgeKey,
  recipeTopologyRebuildProofSha256,
  recipeUpdateEdgeSha256,
  recipeMigrationReportSha256,
  verifyRecipeMigrationReport,
  verifyRecipePackageMetadata,
  verifyRecipeUpdateJob,
  verifyRecipeUpdatesContract,
  verifyRecipeUpdatesForSource,
  type RecipeMigrationReportExpectation,
} from "./updateContracts";

const mutable = <T>(value: T): any => structuredClone(value);

describe("recipe update v1/v2 fixture corpus", () => {
  it("is deeply immutable and exhaustively represents the locked migration cases", () => {
    expect(Object.isFrozen(recipeUpdateV1Fixture)).toBe(true);
    expect(Object.isFrozen(recipeUpdateV1Fixture.controls)).toBe(true);
    expect(Object.isFrozen(recipeUpdateV1Fixture.controls[0])).toBe(true);
    expect(Object.isFrozen(recipeUpdateV2Fixture)).toBe(true);
    expect(Object.isFrozen(recipeUpdatesFixture.edges[0].proof)).toBe(true);

    const parsed = parseRecipeUpdatesContract(recipeUpdatesFixture);
    const edge = parsed.edges[0];
    const actions = new Set(edge.controls.map((control) => control.action));
    expect(actions).toEqual(
      new Set([
        "keep",
        "presentation-only",
        "affine",
        "piecewise",
        "new",
        "removed",
        "reset-required",
        "blocked",
      ]),
    );

    const behaviorKinds = new Set(
      edge.controls.flatMap((control) => control.behaviorKinds),
    );
    expect(behaviorKinds).toEqual(
      new Set([
        "track",
        "follower-only",
        "macro",
        "bilateral-unlock",
        "shared-clamp",
        "joint",
        "root-scale",
      ]),
    );
    expect(edge.warnings.map((warning) => warning.code).sort()).toEqual([
      "material-changed",
      "neutral-changed",
    ]);

    const bilateralEntries = edge.stableIdLedger.entries.filter((entry) =>
      entry.id.startsWith("bilateral_shape"),
    );
    expect(bilateralEntries).toHaveLength(3);
    expect(
      bilateralEntries.filter((entry) => entry.fromKind === "side-offset"),
    ).toHaveLength(2);
    expect(recipeUpdateV1Fixture.unlockedDialIds).toEqual(["bilateral_shape"]);
    expect(recipeUpdateV2Fixture.unlockedDialIds).toEqual(["bilateral_shape"]);

    const sharedClamp = edge.controls.filter((control) =>
      control.behaviorKinds.includes("shared-clamp"),
    );
    expect(
      sharedClamp.filter((control) => control.id.startsWith("shared_clamp_")),
    ).toHaveLength(2);
    expect(
      new Set(
        sharedClamp
          .filter((control) => control.id.startsWith("shared_clamp_"))
          .map((control) => control.componentId),
      ).size,
    ).toBe(1);
  });

  it("locks exact affine 0.5 -> 0.75 and a distinct piecewise remap", () => {
    const edge = parseRecipeUpdatesContract(recipeUpdatesFixture).edges[0];
    const affine = edge.controls.find(
      (control) => control.id === "affine_remap",
    );
    expect(affine?.mapping?.kind).toBe("affine");
    if (affine?.mapping?.kind !== "affine")
      throw new Error("affine fixture is missing");
    expect(
      recipeFixtureValues.affineOld * affine.mapping.scale +
        affine.mapping.offset,
    ).toBe(recipeFixtureValues.affineNew);
    expect([
      recipeFixtureValues.affineOld,
      recipeFixtureValues.affineNew,
    ]).toEqual([0.5, 0.75]);

    const piecewise = edge.controls.find(
      (control) => control.id === "piecewise_remap",
    );
    expect(piecewise?.mapping?.kind).toBe("piecewise");
    if (piecewise?.mapping?.kind !== "piecewise") {
      throw new Error("piecewise fixture is missing");
    }
    expect(piecewise.mapping.points).toContainEqual([
      recipeFixtureValues.piecewiseOld,
      recipeFixtureValues.piecewiseNew,
    ]);
  });

  it("pins the canonical fixture-pair, direct-edge, and report hashes", async () => {
    await expect(
      canonicalRecipeSha256({
        v1: recipeUpdateV1Fixture,
        v2: recipeUpdateV2Fixture,
      }),
    ).resolves.toBe(RECIPE_UPDATE_PAIR_FIXTURE_SHA256);
    await expect(
      verifyRecipeUpdatesContract(recipeUpdatesFixture),
    ).resolves.toMatchObject({ contract: "recipe-updates/v1" });
    await expect(
      verifyRecipeMigrationReport(
        recipeMigrationReportFixture,
        recipeUpdatesFixture.edges[0],
      ),
    ).resolves.toMatchObject({ contract: "recipe-migration-report/v1" });
  });

  it("accepts a strictly monotonic report gap after immutable revision rollback", async () => {
    const edge = parseRecipeUpdatesContract(recipeUpdatesFixture).edges[0];
    const report = mutable(recipeMigrationReportFixture);
    report.toRecipeRevision = 3;
    report.proof.reportSha256 = await recipeMigrationReportSha256(report, edge);
    await expect(verifyRecipeMigrationReport(report, edge)).resolves.toMatchObject({
      fromRecipeRevision: 1,
      toRecipeRevision: 3,
    });
  });

  it("normalizes migration-report measurements across RedisJSON decimal drift", async () => {
    const edge = parseRecipeUpdatesContract(recipeUpdatesFixture).edges[0];
    const report = mutable(recipeMigrationReportFixture);
    report.proof.wholeRecipeMaximumError = 4.470348358154297e-8;
    report.proof.wholeRecipeRmsError = 3.3219461576257802e-9;
    report.proof.reportSha256 = await recipeMigrationReportSha256(report, edge);
    const normalized = await verifyRecipeMigrationReport(report, edge);
    expect(normalized.proof.wholeRecipeMaximumError).toBe(
      4.4703483581543e-8,
    );
    expect(normalized.proof.wholeRecipeRmsError).toBe(
      3.32194615762578e-9,
    );

    const stored = mutable(normalized);
    stored.proof.wholeRecipeMaximumError = 4.4703483581542975e-8;
    stored.proof.wholeRecipeRmsError = 3.32194615762578e-9;
    await expect(verifyRecipeMigrationReport(stored, edge)).resolves.toEqual(
      normalized,
    );
  });

  it("distinguishes removed-zero, removed-active, new, reset, and blocked report rows", () => {
    const edge = parseRecipeUpdatesContract(recipeUpdatesFixture).edges[0];
    const report = parseRecipeMigrationReport(
      recipeMigrationReportFixture,
      edge,
    );
    const byId = new Map(report.entries.map((entry) => [entry.id, entry]));

    expect(byId.get("removed_zero")).toMatchObject({
      classification: "removed",
      oldValue: 0,
      proposedValue: null,
      requiresPreview: false,
      requiresConfirmation: false,
    });
    expect(byId.get("removed_active")).toMatchObject({
      classification: "removed",
      oldValue: 0.45,
      proposedValue: null,
      requiresPreview: true,
      requiresConfirmation: true,
    });
    expect(byId.get("new_control")).toMatchObject({
      classification: "new",
      oldValue: null,
      proposedValue: 0,
    });
    expect(byId.get("reset_required")).toMatchObject({
      classification: "reset-required",
      proposedValue: 0,
      proofStatus: "not-preserved",
    });
    expect(byId.get("blocked_control")).toMatchObject({
      classification: "blocked",
      proposedValue: null,
      proofStatus: "failed",
    });
    expect(report.status).toBe("blocked");
  });

  it("binds an unsupported analysis report to its blocked server plan instead of claiming a verified remap", async () => {
    const edge = parseRecipeUpdatesContract(recipeUpdatesFixture).edges[0];
    const report = mutable(recipeMigrationReportFixture);
    const entry = report.entries.find(
      (candidate: { id: string }) => candidate.id === "affine_remap",
    );
    entry.classification = "blocked";
    entry.proposedValue = null;
    entry.proofStatus = "failed";
    entry.requiresPreview = true;
    entry.requiresConfirmation = false;
    report.status = "blocked";
    const expectation: RecipeMigrationReportExpectation = {
      classifications: Object.fromEntries(
        edge.controls.map((control) => [
          control.id,
          control.id === "affine_remap"
            ? "blocked"
            : report.entries.find(
                (candidate: { id: string }) => candidate.id === control.id,
              ).classification,
        ]),
      ),
      status: "blocked",
    };
    report.proof.reportSha256 = await recipeMigrationReportSha256(
      report,
      edge,
      expectation,
    );

    await expect(
      verifyRecipeMigrationReport(report, edge, expectation),
    ).resolves.toMatchObject({
      status: "blocked",
      entries: expect.arrayContaining([
        expect.objectContaining({
          id: "affine_remap",
          classification: "blocked",
          proofStatus: "failed",
        }),
      ]),
    });
    await expect(verifyRecipeMigrationReport(report, edge)).rejects.toThrow(
      /contradicts its edge/,
    );
  });

  it("binds a clean-reset report to reset, new, and removed plan outcomes", async () => {
    const edge = parseRecipeUpdatesContract(recipeUpdatesFixture).edges[0];
    const report = mutable(recipeMigrationReportFixture);
    const classifications = Object.fromEntries(
      edge.controls.map((control) => [
        control.id,
        control.action === "new"
          ? "new"
          : control.action === "removed"
            ? "removed"
            : "reset-required",
      ]),
    ) as RecipeMigrationReportExpectation["classifications"];
    for (const entry of report.entries) {
      entry.classification = classifications[entry.id];
      entry.proposedValue = entry.classification === "removed" ? null : 0;
      entry.proofStatus = ["new", "removed"].includes(entry.classification)
        ? "not-required"
        : "not-preserved";
      entry.requiresPreview = true;
      entry.requiresConfirmation = true;
    }
    report.status = "preview-required";
    const expectation: RecipeMigrationReportExpectation = {
      classifications,
      status: "preview-required",
    };
    report.proof.reportSha256 = await recipeMigrationReportSha256(
      report,
      edge,
      expectation,
    );

    await expect(
      verifyRecipeMigrationReport(report, edge, expectation),
    ).resolves.toMatchObject({
      status: "preview-required",
      entries: expect.arrayContaining([
        expect.objectContaining({
          id: "removed_zero",
          classification: "removed",
          requiresConfirmation: true,
        }),
        expect.objectContaining({
          id: "new_control",
          classification: "new",
          requiresConfirmation: true,
        }),
        expect.objectContaining({
          id: "affine_remap",
          classification: "reset-required",
          proofStatus: "not-preserved",
        }),
      ]),
    });
  });
});

describe("recipe-updates/v1 parser", () => {
  it("accepts an honest source package with no supported predecessor edges", async () => {
    const empty = {
      contract: "recipe-updates/v1",
      schemaVersion: 1,
      edges: [],
    };
    expect(parseRecipeUpdatesContract(empty).edges).toEqual([]);
    await expect(
      verifyRecipeUpdatesForSource(empty, recipeUpdateV2Fixture.identity),
    ).resolves.toEqual(empty);
  });

  it("binds every embedded direct edge to the package intrinsic source identity", async () => {
    await expect(
      verifyRecipeUpdatesForSource(
        recipeUpdatesFixture,
        recipeUpdateV2Fixture.identity,
      ),
    ).resolves.toMatchObject({ contract: "recipe-updates/v1" });
    await expect(
      verifyRecipeUpdatesForSource(
        recipeUpdatesFixture,
        recipeUpdateV1Fixture.identity,
      ),
    ).rejects.toThrow(/target does not match package recipeSource/);
  });

  it("verifies the complete authoring-manifest metadata boundary", async () => {
    const identity = recipeUpdateV2Fixture.identity;
    const baseManifest = {
      contractVersion: 2,
      appearanceDials: {
        contract: "appearance-dials/v2",
        definitionSha256: identity.definitionSha256,
        neutral: {
          id: identity.neutralId,
          recipeSha256: identity.neutralRecipeSha256,
        },
      },
      rig: {
        baseId: identity.baseId,
        fitFamily: identity.fitFamily,
        performance: { contract: "batshit-performance-rig/v1" },
      },
      recipeUpdates: {
        contract: "recipe-updates/v1",
        schemaVersion: 1,
        edges: [],
      },
    };
    const { recipeManifestSemanticSha256 } = await import("./packageMetadata");
    const recipeSource = {
      ...identity,
      modelSha256: "aa".repeat(32),
      manifestSemanticSha256: await recipeManifestSemanticSha256(baseManifest),
    };
    const manifest = { ...baseManifest, recipeSource };
    await expect(
      verifyRecipePackageMetadata(manifest, recipeSource.modelSha256),
    ).resolves.toMatchObject({
      source: recipeSource,
      updates: { edges: [] },
    });

    const missingUpdates = structuredClone(manifest) as any;
    delete missingUpdates.recipeUpdates;
    await expect(
      verifyRecipePackageMetadata(missingUpdates, recipeSource.modelSha256),
    ).rejects.toThrow(/missing recipeUpdates/);
  });

  it("accepts the complete direct edge", () => {
    const parsed = parseRecipeUpdatesContract(recipeUpdatesFixture);
    expect(parsed.edges).toHaveLength(1);
    expect(parsed.edges[0].stableIdLedger.entries).toHaveLength(
      parsed.edges[0].controls.length,
    );
  });

  it("rejects malformed or tampered direct-edge identities", () => {
    const tamperedIdentity = mutable(recipeUpdatesFixture);
    tamperedIdentity.edges[0].to.definitionSha256 = "ab".repeat(32);
    expect(() => parseRecipeUpdatesContract(tamperedIdentity)).toThrow(
      "direct-edge identity is malformed or tampered",
    );

    const tamperedKey = mutable(recipeUpdatesFixture);
    tamperedKey.edges[0].directEdgeKey += ".tampered";
    expect(() => parseRecipeUpdatesContract(tamperedKey)).toThrow(
      "direct-edge identity is malformed or tampered",
    );

    const crossBase = mutable(recipeUpdatesFixture);
    crossBase.edges[0].to.baseId = "another-base";
    expect(() => parseRecipeUpdatesContract(crossBase)).toThrow(
      "crosses base ids",
    );

    const crossFitFamily = mutable(recipeUpdatesFixture);
    crossFitFamily.edges[0].to.fitFamily = "another-fit-family";
    expect(() => parseRecipeUpdatesContract(crossFitFamily)).toThrow(
      "crosses fit families",
    );

    const crossTopology = mutable(recipeUpdatesFixture);
    crossTopology.edges[0].to.topologySha256 = "ac".repeat(32);
    expect(() => parseRecipeUpdatesContract(crossTopology)).toThrow(
      "crosses topology identities without a rebuild proof",
    );
  });

  it("accepts only a hash-bound target-source rebuild for a topology-changing edge", async () => {
    const edge = mutable(recipeUpdatesFixture.edges[0]);
    edge.to.topologySha256 = "ac".repeat(32);
    edge.directEdgeKey = buildRecipeUpdateDirectEdgeKey(edge.from, edge.to);
    const topologyRebuild = {
      contract: "recipe-topology-rebuild-proof/v1" as const,
      mode: "rebuild-from-target-recipe-source" as const,
      fromTopologySha256: edge.from.topologySha256,
      toTopologySha256: edge.to.topologySha256,
      affectedMeshNodeIds: ["Brow_R"],
      affectedComponentIds: [edge.controls[0].componentId],
      authorityBundleSha256: "ad".repeat(32),
      sourceAuditSha256: "ae".repeat(32),
      targetAuditSha256: "af".repeat(32),
      requiresPreview: true as const,
    };
    edge.topologyRebuild = {
      ...topologyRebuild,
      proofSha256:
        await recipeTopologyRebuildProofSha256(topologyRebuild),
    };
    edge.warnings.push({
      code: "topology-changed",
      message:
        "Rebuild the exact target Recipe Source and review Current against Updated.",
      requiresPreview: true,
      proofSha256: "ba".repeat(32),
    });
    edge.edgeSha256 = await recipeUpdateEdgeSha256(edge);
    const contract = {
      contract: "recipe-updates/v1",
      schemaVersion: 1,
      edges: [edge],
    };

    await expect(verifyRecipeUpdatesContract(contract)).resolves.toMatchObject({
      edges: [
        {
          topologyRebuild: {
            mode: "rebuild-from-target-recipe-source",
            affectedMeshNodeIds: ["Brow_R"],
            requiresPreview: true,
          },
        },
      ],
    });

    const tampered = mutable(contract);
    tampered.edges[0].topologyRebuild.targetAuditSha256 = "bb".repeat(32);
    await expect(verifyRecipeUpdatesContract(tampered)).rejects.toThrow(
      "topology rebuild proof hash mismatch",
    );

    const noPreviewWarning = mutable(contract);
    noPreviewWarning.edges[0].warnings = noPreviewWarning.edges[0].warnings.filter(
      (warning: { code: string }) => warning.code !== "topology-changed",
    );
    expect(() => parseRecipeUpdatesContract(noPreviewWarning)).toThrow(
      "topology rebuild must carry a topology-changed warning",
    );
  });

  it("accepts only a hash-bound, explicitly reviewed same-topology geometry change", async () => {
    const fixture = await createRecipePhysicalMigrationFixture({
      sameTopologyGeometryChange: true,
    });
    const contract = {
      contract: "recipe-updates/v1" as const,
      schemaVersion: 1 as const,
      edges: [fixture.edge],
    };

    await expect(verifyRecipeUpdatesContract(contract)).resolves.toMatchObject({
      edges: [
        {
          sameTopologyGeometryChange: {
            mode: "author-intentional-target-geometry",
            affectedMeshNodeIds: ["Body"],
            affectedComponentIds: ["component.keep"],
            requiresPreview: true,
            requiresConfirmation: true,
          },
        },
      ],
    });

    const missingWarning = mutable(contract);
    missingWarning.edges[0].warnings = [];
    expect(() => parseRecipeUpdatesContract(missingWarning)).toThrow(
      "same-topology geometry change must carry a geometry-changed warning",
    );

    const unknownComponent = mutable(contract);
    unknownComponent.edges[0].sameTopologyGeometryChange.affectedComponentIds = [
      "component.unknown",
    ];
    expect(() => parseRecipeUpdatesContract(unknownComponent)).toThrow(
      "same-topology geometry change references an unknown component",
    );

    const wrongAffectedMesh = mutable(contract);
    wrongAffectedMesh.edges[0].sameTopologyGeometryChange.affectedMeshNodeIds = [
      "OtherBody",
    ];
    expect(() => parseRecipeUpdatesContract(wrongAffectedMesh)).toThrow(
      "affected meshes do not exactly match its authorized geometry channels",
    );

    const changedBehavior = mutable(contract);
    changedBehavior.edges[0].sameTopologyGeometryChange.toBehaviorSha256 =
      "bc".repeat(32);
    expect(() => parseRecipeUpdatesContract(changedBehavior)).toThrow(
      "does not bind one exact same-topology geometry transition",
    );

    const tampered = mutable(contract);
    tampered.edges[0].sameTopologyGeometryChange.targetAuditSha256 =
      "ab".repeat(32);
    await expect(verifyRecipeUpdatesContract(tampered)).rejects.toThrow(
      "same-topology geometry change proof hash mismatch",
    );
  });

  it("accepts a hash-bound neutral geometry change with preserved relative controls", async () => {
    const fixture = await createRecipePhysicalMigrationFixture({
      sameTopologyNeutralGeometryChange: true,
    });
    const contract = {
      contract: "recipe-updates/v1" as const,
      schemaVersion: 1 as const,
      edges: [fixture.edge],
    };

    await expect(verifyRecipeUpdatesContract(contract)).resolves.toMatchObject({
      edges: [
        {
          sameTopologyGeometryChange: {
            mode: "author-intentional-neutral-geometry",
            affectedMeshNodeIds: ["Body"],
            affectedComponentIds: ["component.keep"],
            requiresPreview: true,
            requiresConfirmation: true,
          },
        },
      ],
    });
  });

  it("rejects topology inventory drift from the same-topology geometry lane", async () => {
    await expect(
      createRecipePhysicalMigrationFixture({
        topologyRebuild: true,
        sameTopologyGeometryChange: true,
      }),
    ).rejects.toThrow("same-topology geometry transition");
  });

  it("rejects incomplete or duplicate stable-id ledgers and control plans", () => {
    const missingLedgerEntry = mutable(recipeUpdatesFixture);
    missingLedgerEntry.edges[0].stableIdLedger.entries.pop();
    expect(() => parseRecipeUpdatesContract(missingLedgerEntry)).toThrow(
      "stable-id ledger is not exhaustive",
    );

    const duplicateLedgerEntry = mutable(recipeUpdatesFixture);
    duplicateLedgerEntry.edges[0].stableIdLedger.entries.push(
      duplicateLedgerEntry.edges[0].stableIdLedger.entries.at(-1),
    );
    expect(() => parseRecipeUpdatesContract(duplicateLedgerEntry)).toThrow(
      "duplicate ids",
    );

    const missingControl = mutable(recipeUpdatesFixture);
    missingControl.edges[0].controls.pop();
    expect(() => parseRecipeUpdatesContract(missingControl)).toThrow(
      "controls do not exhaust the stable-id ledger",
    );

    const duplicateControl = mutable(recipeUpdatesFixture);
    duplicateControl.edges[0].controls.push(
      duplicateControl.edges[0].controls.at(-1),
    );
    expect(() => parseRecipeUpdatesContract(duplicateControl)).toThrow(
      "duplicate ids",
    );
  });

  it("rejects non-finite maps and missing proof, tolerance, or hash fields", () => {
    const nonFinite = mutable(recipeUpdatesFixture);
    nonFinite.edges[0].controls.find(
      (control: { id: string }) => control.id === "affine_remap",
    ).mapping.scale = Number.POSITIVE_INFINITY;
    expect(() => parseRecipeUpdatesContract(nonFinite)).toThrow(
      "must be finite",
    );

    const missingTolerance = mutable(recipeUpdatesFixture);
    delete missingTolerance.edges[0].proof.scalarTolerance;
    expect(() => parseRecipeUpdatesContract(missingTolerance)).toThrow(
      "is missing scalarTolerance",
    );

    const missingFixtureProof = mutable(recipeUpdatesFixture);
    delete missingFixtureProof.edges[0].proof.fixtureSha256;
    expect(() => parseRecipeUpdatesContract(missingFixtureProof)).toThrow(
      "is missing fixtureSha256",
    );

    const malformedEdgeHash = mutable(recipeUpdatesFixture);
    malformedEdgeHash.edges[0].edgeSha256 = "not-a-hash";
    expect(() => parseRecipeUpdatesContract(malformedEdgeHash)).toThrow(
      "must be a lowercase SHA-256 hash",
    );

    const uppercaseEdgeHash = mutable(recipeUpdatesFixture);
    uppercaseEdgeHash.edges[0].edgeSha256 =
      uppercaseEdgeHash.edges[0].edgeSha256.toUpperCase();
    expect(() => parseRecipeUpdatesContract(uppercaseEdgeHash)).toThrow(
      "must be a lowercase SHA-256 hash",
    );

    const weakenedTolerance = mutable(recipeUpdatesFixture);
    weakenedTolerance.edges[0].proof.scalarTolerance = 1e-5;
    expect(() => parseRecipeUpdatesContract(weakenedTolerance)).toThrow(
      "changed the locked tolerance profile",
    );
  });

  it("recomputes the edge hash instead of trusting a well-formed digest", async () => {
    const tampered = mutable(recipeUpdatesFixture);
    tampered.edges[0].controls[0].reason = "Tampered but structurally valid.";
    expect(parseRecipeUpdatesContract(tampered).edges).toHaveLength(1);
    await expect(verifyRecipeUpdatesContract(tampered)).rejects.toThrow(
      "recipe update edge hash mismatch",
    );
  });

  it("rejects incomplete, duplicate, or contradictory sibling-state subplans", () => {
    const missingSibling = mutable(recipeUpdatesFixture);
    missingSibling.edges[0].siblingSubplans.pop();
    expect(() => parseRecipeUpdatesContract(missingSibling)).toThrow(
      "sibling subplans are incomplete",
    );

    const duplicateSibling = mutable(recipeUpdatesFixture);
    duplicateSibling.edges[0].siblingSubplans.push(
      duplicateSibling.edges[0].siblingSubplans[0],
    );
    expect(() => parseRecipeUpdatesContract(duplicateSibling)).toThrow(
      "duplicate ids",
    );

    const contradictorySibling = mutable(recipeUpdatesFixture);
    const oral = contradictorySibling.edges[0].siblingSubplans.find(
      (subplan: { surface: string }) => subplan.surface === "oralAppearance",
    );
    oral.fromContract = "oral-appearance/v1";
    expect(() => parseRecipeUpdatesContract(contradictorySibling)).toThrow(
      "contradicts not-present",
    );
  });

  it("requires complete physical-equivalence proof for aliases", () => {
    const invalidAlias = mutable(recipeUpdatesFixture);
    invalidAlias.edges[0].aliases.push({
      fromId: "removed_zero",
      toId: "new_control",
      reason: "Correct a historical id.",
      componentMapSha256: "ad".repeat(32),
    });
    expect(() => parseRecipeUpdatesContract(invalidAlias)).toThrow(
      "is missing physicalEquivalenceProofSha256",
    );
  });

  it("rejects duplicate direct edges", () => {
    const duplicate = mutable(recipeUpdatesFixture);
    duplicate.edges.push(mutable(duplicate.edges[0]));
    expect(() => parseRecipeUpdatesContract(duplicate)).toThrow(
      "duplicate ids",
    );
  });
});

describe("recipe-migration-report/v1 parser", () => {
  const edge = parseRecipeUpdatesContract(recipeUpdatesFixture).edges[0];

  it("accepts an exhaustive report bound to the exact direct edge", () => {
    const parsed = parseRecipeMigrationReport(
      recipeMigrationReportFixture,
      edge,
    );
    expect(parsed.entries).toHaveLength(edge.controls.length);
    expect(parsed.warnings).toHaveLength(2);
  });

  it("accepts preview-required neutral geometry with verified relative component rows", async () => {
    const fixture = await createRecipePhysicalMigrationFixture({
      sameTopologyNeutralGeometryChange: true,
    });
    const neutralEdge = fixture.edge;
    const report: any = {
      contract: "recipe-migration-report/v1",
      reportId: "report_neutral_geometry",
      directEdgeKey: neutralEdge.directEdgeKey,
      edgeSha256: neutralEdge.edgeSha256,
      fromRecipeRevision: 1,
      toRecipeRevision: 2,
      status: "preview-required",
      entries: neutralEdge.controls
        .map((control) => ({
          id: control.id,
          classification: "kept",
          componentId: control.componentId,
          oldValue:
            fixture.sourceState.appearanceDials.values[control.id] ?? 0,
          proposedValue:
            fixture.sourceState.appearanceDials.values[control.id] ?? 0,
          reason: "The relative control effect remains exact.",
          proofStatus: "verified",
          maximumError: 0,
          tolerance: 1e-7,
          proofSha256: "aa".repeat(32),
          requiresPreview: false,
          requiresConfirmation: false,
        }))
        .sort((left, right) => left.id.localeCompare(right.id)),
      warnings: neutralEdge.warnings,
      proof: {
        toleranceProfile: "recipe-strict/v1",
        wholeRecipeMaximumError: 0.025,
        wholeRecipeRmsError: 0.01,
        wholeRecipeTolerance: 1e-6,
        wholeRecipeProofSha256: "bb".repeat(32),
        reportSha256: "0".repeat(64),
      },
    };
    report.proof.reportSha256 = await recipeMigrationReportSha256(
      report,
      neutralEdge,
    );

    await expect(
      verifyRecipeMigrationReport(report, neutralEdge),
    ).resolves.toMatchObject({
      status: "preview-required",
      entries: expect.arrayContaining([
        expect.objectContaining({
          componentId: "component.keep",
          proofStatus: "verified",
          requiresPreview: false,
          requiresConfirmation: false,
        }),
      ]),
    });
  });

  it("rejects duplicate, incomplete, or contradictory rows", () => {
    const duplicate = mutable(recipeMigrationReportFixture);
    duplicate.entries.push(duplicate.entries.at(-1));
    expect(() => parseRecipeMigrationReport(duplicate, edge)).toThrow(
      "duplicate ids",
    );

    const incomplete = mutable(recipeMigrationReportFixture);
    incomplete.entries.pop();
    expect(() => parseRecipeMigrationReport(incomplete, edge)).toThrow(
      "report is not exhaustive",
    );

    const contradictory = mutable(recipeMigrationReportFixture);
    contradictory.entries.find(
      (entry: { id: string }) => entry.id === "exact_keep",
    ).classification = "remapped";
    expect(() => parseRecipeMigrationReport(contradictory, edge)).toThrow(
      "contradicts its edge",
    );
  });

  it("rejects non-finite values and missing proof, tolerance, or hash fields", () => {
    const nonFiniteValue = mutable(recipeMigrationReportFixture);
    nonFiniteValue.entries.find(
      (entry: { id: string }) => entry.id === "exact_keep",
    ).oldValue = Number.NaN;
    expect(() => parseRecipeMigrationReport(nonFiniteValue, edge)).toThrow(
      "must be finite",
    );

    const missingEntryProof = mutable(recipeMigrationReportFixture);
    delete missingEntryProof.entries[0].proofSha256;
    expect(() => parseRecipeMigrationReport(missingEntryProof, edge)).toThrow(
      "is missing proofSha256",
    );

    const missingTolerance = mutable(recipeMigrationReportFixture);
    delete missingTolerance.proof.wholeRecipeTolerance;
    expect(() => parseRecipeMigrationReport(missingTolerance, edge)).toThrow(
      "is missing wholeRecipeTolerance",
    );

    const malformedReportHash = mutable(recipeMigrationReportFixture);
    malformedReportHash.proof.reportSha256 = "bad";
    expect(() => parseRecipeMigrationReport(malformedReportHash, edge)).toThrow(
      "must be a lowercase SHA-256 hash",
    );

    const weakenedTolerance = mutable(recipeMigrationReportFixture);
    weakenedTolerance.proof.wholeRecipeTolerance = 1e-4;
    expect(() => parseRecipeMigrationReport(weakenedTolerance, edge)).toThrow(
      "changed the locked whole-Recipe tolerance",
    );
  });

  it("recomputes the report hash instead of trusting a well-formed digest", async () => {
    const tampered = mutable(recipeMigrationReportFixture);
    tampered.entries[0].reason = "Tampered but structurally valid.";
    expect(parseRecipeMigrationReport(tampered, edge).entries).toHaveLength(
      edge.controls.length,
    );
    await expect(verifyRecipeMigrationReport(tampered, edge)).rejects.toThrow(
      "recipe migration report hash mismatch",
    );
  });

  it("binds the report proof to the exact migration-plan whole proof", () => {
    const report = mutable(recipeMigrationReportFixture);
    const expectation: RecipeMigrationReportExpectation = {
      classifications: Object.fromEntries(
        edge.controls.map((control) => [
          control.id,
          report.entries.find(
            (entry: { id: string }) => entry.id === control.id,
          ).classification,
        ]),
      ),
      status: report.status,
      wholeRecipeProof: {
        proofSha256: report.proof.wholeRecipeProofSha256,
        maximumError: report.proof.wholeRecipeMaximumError,
        rmsError: report.proof.wholeRecipeRmsError,
      },
    };
    expect(() => parseRecipeMigrationReport(report, edge, expectation)).not.toThrow();

    expectation.wholeRecipeProof!.proofSha256 = "cd".repeat(32);
    expect(() => parseRecipeMigrationReport(report, edge, expectation)).toThrow(
      "proof contradicts its migration plan",
    );
  });

  it("rejects another edge identity and invalid derived status", () => {
    const wrongEdge = mutable(recipeMigrationReportFixture);
    wrongEdge.edgeSha256 = "ae".repeat(32);
    expect(() => parseRecipeMigrationReport(wrongEdge, edge)).toThrow(
      "targets another direct edge",
    );

    const wrongStatus = mutable(recipeMigrationReportFixture);
    wrongStatus.status = "preserved";
    expect(() => parseRecipeMigrationReport(wrongStatus, edge)).toThrow(
      "status contradicts its entries",
    );
  });
});

describe("recipe-update-job/v1 parser", () => {
  const edge = parseRecipeUpdatesContract(recipeUpdatesFixture).edges[0];

  it("accepts a ready candidate with its report and candidate hashes", async () => {
    expect(
      parseRecipeUpdateJob(recipeUpdateReadyJobFixture, edge),
    ).toMatchObject({
      state: "ready",
      expectedRecipeRevision: 1,
      failure: null,
    });
    await expect(
      verifyRecipeUpdateJob(recipeUpdateReadyJobFixture, edge),
    ).resolves.toMatchObject({ state: "ready" });
  });

  it("rejects unknown states and non-finite counters", () => {
    const unknownState = mutable(recipeUpdateReadyJobFixture);
    unknownState.state = "running";
    expect(() => parseRecipeUpdateJob(unknownState, edge)).toThrow(
      "state is invalid",
    );

    const nonFiniteRevision = mutable(recipeUpdateReadyJobFixture);
    nonFiniteRevision.expectedRecipeRevision = Number.POSITIVE_INFINITY;
    expect(() => parseRecipeUpdateJob(nonFiniteRevision, edge)).toThrow(
      "numbers must be finite",
    );
  });

  it("rejects incomplete committed and failure states", () => {
    const incompleteCommit = mutable(recipeUpdateReadyJobFixture);
    incompleteCommit.state = "committed";
    expect(() => parseRecipeUpdateJob(incompleteCommit, edge)).toThrow(
      "committed recipe update job is incomplete",
    );

    const failedWithoutFailure = mutable(recipeUpdateReadyJobFixture);
    failedWithoutFailure.state = "failed";
    expect(() => parseRecipeUpdateJob(failedWithoutFailure, edge)).toThrow(
      "missing valid failure state",
    );

    const invalidFailureStage = mutable(recipeUpdateReadyJobFixture);
    invalidFailureStage.state = "failed";
    invalidFailureStage.reportSha256 = null;
    invalidFailureStage.candidateAssets = [];
    invalidFailureStage.failure = {
      stage: "somewhere",
      code: "RECIPE_UPDATE_FAILED",
      message: "The update failed.",
      retryable: true,
    };
    expect(() => parseRecipeUpdateJob(invalidFailureStage, edge)).toThrow(
      "failure.stage is invalid",
    );
  });

  it("rejects missing concurrency and commit proof hashes", () => {
    const missingConcurrencyHash = mutable(recipeUpdateReadyJobFixture);
    delete missingConcurrencyHash.concurrencyTokenSha256;
    expect(() => parseRecipeUpdateJob(missingConcurrencyHash, edge)).toThrow(
      "is missing concurrencyTokenSha256",
    );

    const malformedCandidateHash = mutable(recipeUpdateReadyJobFixture);
    malformedCandidateHash.candidateAssets.find(
      (asset: { role: string }) => asset.role === "live-package",
    ).sha256 = "candidate";
    expect(() => parseRecipeUpdateJob(malformedCandidateHash, edge)).toThrow(
      "must be a lowercase SHA-256 hash",
    );
  });

  it("owns every staged source/Live/receipt ref and rejects incomplete bundles", () => {
    const missingLiveManifest = mutable(recipeUpdateReadyJobFixture);
    missingLiveManifest.candidateAssets =
      missingLiveManifest.candidateAssets.filter(
        (asset: { role: string }) => asset.role !== "live-manifest",
      );
    expect(() => parseRecipeUpdateJob(missingLiveManifest, edge)).toThrow(
      "live package requires its staged model and manifest",
    );

    const duplicateRef = mutable(recipeUpdateReadyJobFixture);
    duplicateRef.candidateAssets[1].ref = duplicateRef.candidateAssets[0].ref;
    expect(() => parseRecipeUpdateJob(duplicateRef, edge)).toThrow(
      "candidate asset refs contains duplicate ids",
    );

    const reordered = mutable(recipeUpdateReadyJobFixture);
    reordered.candidateAssets.reverse();
    expect(() => parseRecipeUpdateJob(reordered, edge)).toThrow(
      "must use canonical role order",
    );
  });

  it("rejects a job bound to another direct edge", () => {
    const wrongEdge = mutable(recipeUpdateReadyJobFixture);
    wrongEdge.edgeSha256 = "af".repeat(32);
    expect(() => parseRecipeUpdateJob(wrongEdge, edge)).toThrow(
      "targets another direct edge",
    );
  });
});
