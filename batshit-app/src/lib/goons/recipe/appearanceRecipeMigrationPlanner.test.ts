import { describe, expect, it } from "vitest";
import {
  planAppearanceRecipeCleanReset,
  planAppearanceRecipeMigration,
  verifyPlannedAppearanceRecipeCleanReset,
  verifyPlannedAppearanceRecipeMigration,
  type AppearanceRecipeMigrationPlannerInput,
  type AppearanceRecipeSiblingVerifier,
} from "./appearanceRecipeMigrationPlanner";
import { createRecipePhysicalMigrationFixture } from "./fixtures/recipePhysicalMigrationPair";
import fixtureOracle from "./fixtures/recipePhysicalMigrationOracle.json";
import { recipeMigrationPlanSha256 } from "./migrationPlanContracts";
import { canonicalRecipeSha256 } from "./recipeCanonical";
import {
  recipeSiblingStateSha256,
  type RecipeSiblingStateRecord,
} from "./recipeContracts";

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

async function siblingState(
  id: string,
  contract: string,
  definitionSha256: string,
  value: number,
): Promise<RecipeSiblingStateRecord> {
  const state = { schemaVersion: contract, definitionSha256, value };
  return {
    id,
    contract,
    definitionSha256,
    stateSha256: await recipeSiblingStateSha256(state),
    state,
  };
}

async function plannerInputWithSiblingCases(blockOral = false) {
  const facialDefinition = "a".repeat(64);
  const eyeSourceDefinition = "b".repeat(64);
  const eyeTargetDefinition = "c".repeat(64);
  const oralSourceDefinition = "d".repeat(64);
  const oralTargetDefinition = "e".repeat(64);
  const facial = await siblingState(
    "facialArtwork",
    "facial-artwork-state/v3",
    facialDefinition,
    1,
  );
  const eye = await siblingState(
    "eyeAppearance",
    "eye-appearance-state/v1",
    eyeSourceDefinition,
    2,
  );
  const oral = await siblingState(
    "oralAppearance",
    "oral-appearance-state/v1",
    oralSourceDefinition,
    3,
  );
  const migratedEye = await siblingState(
    "eyeAppearance-v2",
    "eye-appearance-state/v3",
    eyeTargetDefinition,
    20,
  );
  const resetOral = await siblingState(
    "oralAppearance-v2",
    "oral-appearance-state/v2",
    oralTargetDefinition,
    0,
  );
  const siblingSubplans = [
    {
      surface: "facialArtwork",
      fromContract: facial.contract,
      toContract: facial.contract,
      action: "keep",
      reason: "Facial Artwork definition is unchanged.",
      proofSha256: "1".repeat(64),
    },
    {
      surface: "eyeAppearance",
      fromContract: eye.contract,
      toContract: "eye-appearance-state/v3",
      action: "migrate",
      reason: "Eye Appearance has an exact domain migration.",
      proofSha256: "2".repeat(64),
    },
    {
      surface: "oralAppearance",
      fromContract: oral.contract,
      toContract: "oral-appearance-state/v2",
      action: blockOral ? "blocked" : "reset-required",
      reason: blockOral
        ? "Oral Appearance has no verified migration."
        : "Oral Appearance requires an explicit reset.",
      proofSha256: "3".repeat(64),
    },
  ] as const;
  const siblingInputs = {
    facialArtwork: {
      sourceStateId: facial.id,
      targetStateId: facial.id,
      targetDefinition: {
        contract: facial.contract,
        definitionSha256: facialDefinition,
      },
    },
    eyeAppearance: {
      sourceStateId: eye.id,
      targetStateId: migratedEye.id,
      targetDefinition: {
        contract: migratedEye.contract,
        definitionSha256: eyeTargetDefinition,
      },
    },
    oralAppearance: {
      sourceStateId: oral.id,
      targetStateId: resetOral.id,
      targetDefinition: {
        contract: resetOral.contract,
        definitionSha256: oralTargetDefinition,
      },
    },
  };
  const fixture = await createRecipePhysicalMigrationFixture({
    sourceSiblings: [eye, facial, oral],
    siblingSubplans: structuredClone(siblingSubplans),
    siblingInputs,
  });
  const input: AppearanceRecipeMigrationPlannerInput = {
    planId: blockOral
      ? "migration.r7-fixture.sibling-blocked"
      : "migration.r7-fixture.sibling-decisions",
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
    componentMapBundle: fixture.componentMapBundle,
  };
  const verifier = (
    verifierId: string,
    proposedState: RecipeSiblingStateRecord,
  ): AppearanceRecipeSiblingVerifier => ({
    verifierId,
    verifierVersion: 1,
    verify: async () => ({
      proposedState,
      domainEvidenceSha256: await canonicalRecipeSha256({ verifierId, proposedState }),
      message: `${verifierId} supplied exact domain evidence.`,
    }),
  });
  input.siblingVerifiers = {
    eyeAppearance: verifier("eye-migration-fixture", migratedEye),
    ...(!blockOral
      ? { oralAppearance: verifier("oral-reset-fixture", resetOral) }
      : {}),
  };
  return input;
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

  it("runs keep, migrate, and reset-required sibling decisions through the production planner", async () => {
    const input = await plannerInputWithSiblingCases();
    const plan = await planAppearanceRecipeMigration(input);
    const rows = Object.fromEntries(plan.siblingRows.map((row) => [row.surface, row]));

    expect(rows.facialArtwork).toMatchObject({
      action: "keep",
      resolution: "kept",
      proofStatus: "verified",
      requiresPreview: false,
    });
    expect(rows.eyeAppearance).toMatchObject({
      action: "migrate",
      resolution: "migrated",
      proofStatus: "verified",
      requiresPreview: true,
    });
    expect(rows.oralAppearance).toMatchObject({
      action: "reset-required",
      resolution: "reset",
      proofStatus: "not-preserved",
      requiresPreview: true,
      requiresConfirmation: true,
    });
    expect(plan.proposedState?.siblings.map((sibling) => sibling.id)).toEqual([
      "eyeAppearance-v2",
      "facialArtwork",
      "oralAppearance-v2",
    ]);
    await expect(verifyPlannedAppearanceRecipeMigration(plan, input)).resolves.toEqual(plan);
  });

  it("blocks the full production plan when one sibling surface has no verified proof", async () => {
    const input = await plannerInputWithSiblingCases(true);
    const plan = await planAppearanceRecipeMigration(input);

    expect(plan.outcome).toMatchObject({ readiness: "blocked" });
    expect(plan.outcome.rejectionCodes).toContain("SIBLING_PROOF_FAILED");
    expect(plan.siblingRows.find((row) => row.surface === "oralAppearance")).toMatchObject({
      action: "blocked",
      resolution: "blocked",
      proofStatus: "failed",
    });
    expect(plan.proposedState).toBeNull();
    await expect(verifyPlannedAppearanceRecipeMigration(plan, input)).resolves.toEqual(plan);
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
