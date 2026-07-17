import { describe, expect, it } from "vitest";
import {
  planAppearanceRecipeCleanReset,
  planAppearanceRecipeMigration,
  verifyPlannedAppearanceRecipeCleanReset,
  verifyPlannedAppearanceRecipeMigration,
  type AppearanceRecipeMigrationPlannerInput,
} from "./appearanceRecipeMigrationPlanner";
import { createRecipePhysicalMigrationFixture } from "./fixtures/recipePhysicalMigrationPair";
import fixtureOracle from "./fixtures/recipePhysicalMigrationOracle.json";
import { recipeMigrationPlanSha256 } from "./migrationPlanContracts";
import { canonicalRecipeSha256 } from "./recipeCanonical";

const mutable = <T>(value: T): any => structuredClone(value);

async function plannerInput(
  includeComponentMap = true,
): Promise<AppearanceRecipeMigrationPlannerInput> {
  const fixture = await createRecipePhysicalMigrationFixture();
  return {
    planId: includeComponentMap
      ? "migration.r2-fixture.automatic"
      : "migration.r2-fixture.unsupported",
    fromRecipeRevision: 1,
    edge: fixture.edge,
    sourceState: fixture.sourceState,
    sourcePackage: {
      recipeSource: fixture.source.recipeSource,
      packageBytes: fixture.source.packageBytes,
      glbBytes: fixture.source.glbBytes,
      manifestBytes: fixture.source.manifestBytes,
    },
    targetPackage: {
      recipeSource: fixture.target.recipeSource,
      packageBytes: fixture.target.packageBytes,
      glbBytes: fixture.target.glbBytes,
      manifestBytes: fixture.target.manifestBytes,
    },
    siblingInputs: fixture.siblingInputs,
    ...(includeComponentMap
      ? { componentMapBundle: fixture.componentMapBundle }
      : {}),
  };
}

describe("Appearance Recipe migration planner", () => {
  it("produces one deterministic exhaustive automatic plan with complete physical proof", async () => {
    const input = await plannerInput();
    const first = await planAppearanceRecipeMigration(input);
    const repeated = await planAppearanceRecipeMigration(input);

    expect(repeated).toEqual(first);
    expect(first.outcome).toMatchObject({
      kind: "automatic",
      readiness: "ready",
      preservationClaim: "appearance-preserved",
      rejectionCodes: [],
    });
    expect(first.controlRows).toHaveLength(input.edge.controls.length);
    expect(first.siblingRows.map((row) => row.surface)).toEqual([
      "eyeAppearance",
      "facialArtwork",
      "oralAppearance",
    ]);
    expect(
      first.componentProofs.every(
        (proof) =>
          proof.status === "verified" &&
          proof.authorizedCandidateCount === 1 &&
          proof.uniquenessProofSha256 !== null,
      ),
    ).toBe(true);
    expect(first.wholeRecipeProof).toMatchObject({
      status: "verified",
      materialMatches: true,
      mismatchDomains: [],
      permitsAppearancePreservedClaim: true,
    });
    expect(first.planSha256).toBe(fixtureOracle.automaticPlanSha256);
    expect(await canonicalRecipeSha256(first.componentProofs)).toBe(
      fixtureOracle.automaticComponentProofsSha256,
    );
    expect(first.wholeRecipeProof.proofSha256).toBe(
      fixtureOracle.automaticWholeRecipeProofSha256,
    );
    await expect(
      verifyPlannedAppearanceRecipeMigration(first, input),
    ).resolves.toEqual(first);
  });

  it("supports an explicit monotonic target revision after whole-revision rollback", async () => {
    const input = await plannerInput();
    input.toRecipeRevision = 3;
    const plan = await planAppearanceRecipeMigration(input);
    expect(plan).toMatchObject({ fromRecipeRevision: 1, toRecipeRevision: 3 });
    await expect(
      verifyPlannedAppearanceRecipeMigration(plan, input),
    ).resolves.toEqual(plan);
  });

  it("returns unsupported without the required coupled map, then permits only a separately cited clean reset", async () => {
    const input = await plannerInput(false);
    const unsupported = await planAppearanceRecipeMigration(input);
    expect(unsupported.planSha256).toBe(fixtureOracle.unsupportedPlanSha256);
    expect(unsupported.outcome).toMatchObject({
      kind: "unsupported",
      readiness: "blocked",
      cleanResetEligibility: "eligible",
    });
    expect(unsupported.proposedState).toBeNull();
    expect(unsupported.outcome.rejectionCodes).toContain(
      "COMPONENT_MAP_MISSING",
    );

    const resetInput = {
      planId: "migration.r2-fixture.clean-reset",
      migrationInput: input,
      eligibleUnsupportedPlan: unsupported,
    };
    const reset = await planAppearanceRecipeCleanReset(resetInput);
    expect(reset.planSha256).toBe(fixtureOracle.cleanResetPlanSha256);
    expect(reset.outcome).toMatchObject({
      kind: "clean-reset",
      readiness: "preview-required",
      preservationClaim: "none",
      basedOnUnsupportedPlanSha256: unsupported.planSha256,
    });
    expect(Object.values(reset.proposedState!.appearanceDials.values)).toEqual(
      Object.values(reset.proposedState!.appearanceDials.values).map(() => 0),
    );
    expect(reset.proposedState!.appearanceDials.unlockedDialIds).toEqual([]);
    expect(
      reset.controlRows.every(
        (row) => row.requiresPreview && row.requiresConfirmation,
      ),
    ).toBe(true);
    await expect(
      verifyPlannedAppearanceRecipeCleanReset(reset, resetInput),
    ).resolves.toEqual(reset);
  });

  it("rejects a rehashed outer plan when nested deterministic evidence changed", async () => {
    const input = await plannerInput();
    const plan = await planAppearanceRecipeMigration(input);
    const tampered = mutable(plan);
    tampered.componentProofs[0].sourcePhysicalOutputSha256 = "f".repeat(64);
    await expect(
      verifyPlannedAppearanceRecipeMigration(tampered, input),
    ).rejects.toThrow(/deterministic recomputation/);
  });

  it("rejects a rehashed plan that points at another external source ref", async () => {
    const input = await plannerInput();
    const plan = await planAppearanceRecipeMigration(input);
    const tampered = mutable(plan);
    tampered.fromSource.package.ref = "fixture://forged/avatar.bgoon";
    tampered.planSha256 = await recipeMigrationPlanSha256(tampered);

    await expect(
      verifyPlannedAppearanceRecipeMigration(tampered, input),
    ).rejects.toThrow(/deterministic recomputation/);
  });
});
