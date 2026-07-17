import { describe, expect, it } from "vitest";
import { canonicalRecipeSha256 } from "./recipeCanonical";
import {
  GOON_RECIPE_STATE_CONTRACT,
  recipeStateSnapshotSha256,
  type RecipeSource,
  type RecipeSiblingStateRecord,
  type RecipeStateSnapshot,
} from "./recipeContracts";
import {
  createRecipeMigrationPlan,
  parseRecipeMigrationPlan,
  verifyRecipeMigrationPlan,
  type RecipeMigrationComponentMembership,
  type RecipeMigrationComponentProof,
  type RecipeMigrationControlRow,
  type RecipeMigrationPlan,
  type RecipeMigrationPlanVerifierContext,
  type RecipeMigrationSiblingRow,
  type RecipePhysicalErrorSummary,
} from "./migrationPlanContracts";
import {
  recipeMigrationReportSha256,
  recipeUpdateEdgeSha256,
  type RecipeUpdateEdge,
} from "./updateContracts";
import {
  RECIPE_UPDATE_PAIR_FIXTURE_SHA256,
  recipeMigrationReportFixture,
  recipeUpdateV1Fixture,
  recipeUpdateV2Fixture,
  recipeUpdatesFixture,
} from "./fixtures/recipeUpdatePair";
import type { RecipeSourceIdentity } from "./packageMetadata";

const sha = (character: string): string => character.repeat(64);
const mutable = <T>(value: T): any => structuredClone(value);

function recipeSource(
  identity: RecipeSourceIdentity,
  suffix: "v1" | "v2",
): RecipeSource {
  return {
    package: {
      ref: `goons/${suffix}/source.bgoon`,
      sha256: sha(suffix === "v1" ? "1" : "2"),
    },
    model: {
      ref: `goons/${suffix}/avatar.glb`,
      sha256: identity.modelSha256,
    },
    manifest: {
      ref: `goons/${suffix}/avatar.json`,
      sha256: sha(suffix === "v1" ? "3" : "4"),
    },
    identities: identity,
  };
}
const zeroErrors = (): RecipePhysicalErrorSummary => ({
  scalarMaximum: 0,
  positionMaximumMeters: 0,
  positionRmsMeters: 0,
  scaleMaximum: 0,
  quaternionMaximumRadians: 0,
  matrixMaximum: 0,
  bakedPositionMaximumMeters: 0,
  bakedPositionRmsMeters: 0,
});

async function sibling(
  id: string,
  contract: string,
  definitionCharacter: string,
): Promise<RecipeSiblingStateRecord> {
  const state = { contract, enabled: true };
  return {
    id,
    contract,
    definitionSha256: sha(definitionCharacter),
    stateSha256: await canonicalRecipeSha256(state),
    state,
  };
}

async function recipeState(
  version: "v1" | "v2",
  valuesOverride: Record<string, number> = {},
  reset = false,
): Promise<RecipeStateSnapshot> {
  const fixture =
    version === "v1" ? recipeUpdateV1Fixture : recipeUpdateV2Fixture;
  const facial = await sibling("facial-artwork", "facial-artwork/v3", "a");
  const eye = await sibling(
    "eye-appearance",
    version === "v1" ? "eye-appearance/v1" : "eye-appearance/v2",
    version === "v1" ? "b" : "c",
  );
  const values = Object.fromEntries(
    fixture.controls.map((control) => [
      control.id,
      reset ? 0 : (valuesOverride[control.id] ?? control.value),
    ]),
  );
  const state: RecipeStateSnapshot = {
    contract: GOON_RECIPE_STATE_CONTRACT,
    stateSha256: sha("0"),
    appearanceDials: {
      contract: "appearance-dial-values/v2",
      definitionSha256: fixture.identity.definitionSha256,
      neutralId: fixture.identity.neutralId,
      neutralRecipeSha256: fixture.identity.neutralRecipeSha256,
      values,
      unlockedDialIds: reset ? [] : [...fixture.unlockedDialIds],
    },
    siblings: [eye, facial].sort((left, right) =>
      left.id.localeCompare(right.id),
    ),
  };
  state.stateSha256 = await recipeStateSnapshotSha256(state);
  return state;
}

function componentMembership(
  edge: RecipeUpdateEdge,
): Record<string, RecipeMigrationComponentMembership> {
  const result: Record<string, RecipeMigrationComponentMembership> = {};
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
  return Object.fromEntries(
    Object.entries(result)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([id, membership]) => [
        id,
        {
          sourceControlIds: membership.sourceControlIds.sort(),
          targetControlIds: membership.targetControlIds.sort(),
          sourceUnlockDialIds: membership.sourceControlIds
            .filter((id) => recipeUpdateV1Fixture.unlockedDialIds.includes(id))
            .sort(),
          targetUnlockDialIds: membership.targetControlIds
            .filter((id) => recipeUpdateV2Fixture.unlockedDialIds.includes(id))
            .sort(),
        },
      ]),
  );
}

function componentProofs(
  memberships: Record<string, RecipeMigrationComponentMembership>,
  failedComponentId: string | null,
  resetAll = false,
): RecipeMigrationComponentProof[] {
  return Object.entries(memberships).map(([componentId, membership], index) => {
    const failed = componentId === failedComponentId;
    return {
      componentId,
      sourceControlIds: membership.sourceControlIds,
      targetControlIds: membership.targetControlIds,
      solver: failed ? "none" : resetAll ? "explicit-reset" : "identity",
      authorizedCandidateCount: failed ? 0 : 1,
      selectedCandidateSha256: failed
        ? null
        : sha(((index + 1) % 10).toString()),
      uniquenessMethod: failed
        ? "none"
        : resetAll
          ? "explicit-reset"
          : "identity",
      uniquenessProofSha256: failed ? null : sha("e"),
      componentMapSha256: null,
      sourcePhysicalOutputSha256: sha("a"),
      targetPhysicalOutputSha256: failed ? null : sha(resetAll ? "c" : "a"),
      comparedOutputKeysSha256: sha("b"),
      mismatchDomains: [],
      status: failed ? "failed" : resetAll ? "not-preserved" : "verified",
      errors: zeroErrors(),
      rejectionCodes: failed ? ["COMPONENT_PROOF_FAILED"] : [],
      proofSha256: sha("0"),
    };
  });
}

function controlRows(
  edge: RecipeUpdateEdge,
  source: RecipeStateSnapshot,
  target: RecipeStateSnapshot | null,
  proofs: RecipeMigrationComponentProof[],
  cleanReset = false,
): RecipeMigrationControlRow[] {
  const proofByComponent = new Map(
    proofs.map((proof) => [proof.componentId, proof]),
  );
  return edge.controls.map((control) => {
    const sourceValue = source.appearanceDials.values[control.id];
    const targetValue = target?.appearanceDials.values[control.id];
    const blocked = control.action === "blocked" && !cleanReset;
    const resolution = cleanReset
      ? control.action === "removed"
        ? sourceValue === 0
          ? "removed-neutral"
          : "removed-active-preview"
        : control.action === "new"
          ? "new-neutral"
          : "reset-to-neutral"
      : control.action === "keep"
        ? "kept"
        : control.action === "presentation-only"
          ? "presentation-updated"
          : control.action === "affine"
            ? "affine-remapped"
            : control.action === "piecewise"
              ? "piecewise-remapped"
              : control.action === "new"
                ? "new-neutral"
                : control.action === "removed"
                  ? sourceValue === 0
                    ? "removed-neutral"
                    : "removed-active-preview"
                  : control.action === "reset-required"
                    ? "reset-to-neutral"
                    : "blocked";
    const reasonCode = cleanReset
      ? "CLEAN_RESET"
      : control.action === "keep"
        ? "UNCHANGED_IDENTITY"
        : control.action === "presentation-only"
          ? "PRESENTATION_ONLY"
          : control.action === "affine"
            ? "EDGE_AFFINE_CANDIDATE"
            : control.action === "piecewise"
              ? "EDGE_PIECEWISE_CANDIDATE"
              : control.action === "new"
                ? "NEW_NEUTRAL"
                : control.action === "removed"
                  ? sourceValue === 0
                    ? "REMOVED_ZERO"
                    : "REMOVED_ACTIVE"
                  : control.action === "reset-required"
                    ? "RESET_REQUIRED"
                    : "BLOCKED_BY_EDGE";
    return {
      ledgerId: control.id,
      sourceControl:
        sourceValue === undefined
          ? null
          : { id: control.id, kind: control.controlKind, value: sourceValue },
      targetControl: edge.stableIdLedger.toIds.includes(control.id)
        ? {
            id: control.id,
            kind: control.controlKind,
            value: target ? (targetValue ?? null) : null,
          }
        : null,
      edgeAction: control.action,
      componentId: control.componentId,
      resolution,
      aliasId: null,
      candidateOrigin: blocked
        ? "none"
        : cleanReset ||
            control.action === "new" ||
            control.action === "reset-required"
          ? "neutral"
          : control.action === "affine"
            ? "edge-affine"
            : control.action === "piecewise"
              ? "edge-piecewise"
              : "identity",
      candidateProofSha256: blocked ? null : control.proofSha256,
      componentProofSha256: proofByComponent.get(control.componentId)!
        .proofSha256,
      maximumScalarError: 0,
      proofStatus: blocked
        ? "failed"
        : cleanReset || control.action === "reset-required"
          ? "not-preserved"
          : control.action === "new" || control.action === "removed"
            ? "not-required"
            : "verified",
      reasonCode,
      message: control.reason,
      requiresPreview:
        cleanReset ||
        blocked ||
        control.action === "reset-required" ||
        (control.action === "removed" && sourceValue !== 0),
      requiresConfirmation:
        cleanReset ||
        control.action === "reset-required" ||
        (control.action === "removed" && sourceValue !== 0),
    };
  });
}

function siblingRows(
  edge: RecipeUpdateEdge,
  source: RecipeStateSnapshot,
  target: RecipeStateSnapshot | null,
  cleanReset = false,
): RecipeMigrationSiblingRow[] {
  const sourceById = new Map(source.siblings.map((entry) => [entry.id, entry]));
  const targetById = new Map(
    (target?.siblings ?? []).map((entry) => [entry.id, entry]),
  );
  const stateIds = {
    facialArtwork: "facial-artwork",
    eyeAppearance: "eye-appearance",
    oralAppearance: null,
  } as const;
  return [...edge.siblingSubplans]
    .sort((left, right) => left.surface.localeCompare(right.surface))
    .map((subplan) => {
      const stateId = stateIds[subplan.surface];
      const sourceState = stateId ? (sourceById.get(stateId) ?? null) : null;
      const proposedState = stateId ? (targetById.get(stateId) ?? null) : null;
      const reset = cleanReset && stateId !== null;
      return {
        surface: subplan.surface,
        sourceState: sourceState
          ? {
              id: sourceState.id,
              contract: sourceState.contract,
              definitionSha256: sourceState.definitionSha256,
              stateSha256: sourceState.stateSha256,
            }
          : null,
        targetDefinition: proposedState
          ? {
              contract: proposedState.contract,
              definitionSha256: proposedState.definitionSha256,
            }
          : subplan.toContract
            ? { contract: subplan.toContract, definitionSha256: sha("d") }
            : null,
        action: subplan.action,
        resolution: reset
          ? "reset"
          : subplan.action === "keep"
            ? "kept"
            : subplan.action === "migrate"
              ? "migrated"
              : subplan.action === "not-present"
                ? "not-present"
                : subplan.action === "reset-required"
                  ? "reset"
                  : "blocked",
        proposedState,
        proofStatus: reset
          ? "not-preserved"
          : subplan.action === "not-present"
            ? "not-required"
            : "verified",
        proofSha256: subplan.proofSha256,
        reasonCode: cleanReset
          ? "CLEAN_RESET"
          : subplan.action === "keep"
            ? "SIBLING_KEEP"
            : subplan.action === "migrate"
              ? "SIBLING_MIGRATE"
              : subplan.action === "not-present"
                ? "SIBLING_NOT_PRESENT"
                : subplan.action === "reset-required"
                  ? "SIBLING_RESET"
                  : "SIBLING_BLOCKED",
        message: subplan.reason,
        requiresPreview:
          cleanReset ||
          subplan.action === "reset-required" ||
          subplan.action === "blocked",
        requiresConfirmation: cleanReset || subplan.action === "reset-required",
      };
    });
}

function targetRanges(): Record<string, [number, number]> {
  return Object.fromEntries(
    recipeUpdateV2Fixture.controls.map((control) => [
      control.id,
      control.range,
    ]),
  );
}

function sourceRanges(): Record<string, [number, number]> {
  return Object.fromEntries(
    recipeUpdateV1Fixture.controls.map((control) => [
      control.id,
      control.range,
    ]),
  );
}

function verifierContext(
  edge: RecipeUpdateEdge,
  sourceState: RecipeStateSnapshot,
  eligibleUnsupportedPlan?: RecipeMigrationPlan,
): RecipeMigrationPlanVerifierContext {
  return {
    edge,
    fromSource: recipeSource(edge.from, "v1"),
    toSource: recipeSource(edge.to, "v2"),
    sourceState,
    sourceControlRanges: sourceRanges(),
    targetControlRanges: targetRanges(),
    componentMembership: componentMembership(edge),
    siblingBindings: {
      facialArtwork: {
        sourceStateId: "facial-artwork",
        targetStateId: "facial-artwork",
      },
      eyeAppearance: {
        sourceStateId: "eye-appearance",
        targetStateId: "eye-appearance",
      },
      oralAppearance: { sourceStateId: null, targetStateId: null },
    },
    eligibleUnsupportedPlan,
  };
}

async function unsupportedPlan(): Promise<{
  plan: RecipeMigrationPlan;
  sourceState: RecipeStateSnapshot;
}> {
  const edge = recipeUpdatesFixture.edges[0];
  const sourceState = await recipeState("v1");
  const memberships = componentMembership(edge);
  const proofs = componentProofs(memberships, "component.blocked");
  const plan = await createRecipeMigrationPlan({
    contract: "recipe-migration-plan/v1",
    schemaVersion: 1,
    planId: "migration.fixture.unsupported",
    directEdgeKey: edge.directEdgeKey,
    edgeSha256: edge.edgeSha256,
    fromSource: recipeSource(edge.from, "v1"),
    toSource: recipeSource(edge.to, "v2"),
    fromRecipeRevision: 1,
    toRecipeRevision: 2,
    fromStateSha256: sourceState.stateSha256,
    toleranceProfile: "recipe-strict/v1",
    componentMapBundleSha256: null,
    outcome: {
      kind: "unsupported",
      readiness: "blocked",
      preservationClaim: "none",
      rejectionCodes: ["COMPONENT_PROOF_FAILED"],
      cleanResetEligibility: "eligible",
      basedOnUnsupportedPlanSha256: null,
    },
    controlRows: controlRows(edge, sourceState, null, proofs),
    siblingRows: siblingRows(edge, sourceState, null),
    componentProofs: proofs,
    wholeRecipeProof: {
      status: "failed",
      sourcePhysicalOutputSha256: sha("1"),
      targetPhysicalOutputSha256: null,
      sourceAbsoluteOutputSha256: null,
      targetAbsoluteOutputSha256: null,
      sourceMaterialSha256: sha("2"),
      targetMaterialSha256: sha("3"),
      materialMatches: false,
      errors: zeroErrors(),
      mismatchDomains: [],
      permitsAppearancePreservedClaim: false,
      proofSha256: sha("0"),
    },
    warnings: [...edge.warnings].sort((left, right) =>
      left.code.localeCompare(right.code),
    ),
    proposedState: null,
  });
  return { plan, sourceState };
}

describe("Recipe migration plan v1", () => {
  it("preserves the exact pinned R1 fixture, edge, and report hashes", async () => {
    expect(RECIPE_UPDATE_PAIR_FIXTURE_SHA256).toBe(
      "e86bedddc13eb9103c885d36229b7667148400f0487e084e5e47d2fb87733310",
    );
    expect(recipeUpdatesFixture.edges[0].edgeSha256).toBe(
      "040fc2f9ba119f4aad662a33363d4e91977ee9fa93b4c5a1e51bfa1a032be14e",
    );
    expect(
      await recipeMigrationReportSha256(
        recipeMigrationReportFixture,
        recipeUpdatesFixture.edges[0],
      ),
    ).toBe("886b9080a8c78f0413a1d0a3fdac3fe8963ad20825118f33eaffdafb8741e091");
  });

  it("verifies an exhaustive unsupported outcome without fabricating proposed state", async () => {
    const { plan, sourceState } = await unsupportedPlan();
    await expect(
      verifyRecipeMigrationPlan(
        plan,
        verifierContext(recipeUpdatesFixture.edges[0], sourceState),
      ),
    ).resolves.toEqual(plan);
  });

  it("verifies an automatic preview plan while withholding appearance preservation", async () => {
    const edge = mutable(recipeUpdatesFixture.edges[0]) as RecipeUpdateEdge;
    const blocked = edge.controls.find(
      (control) => control.id === "blocked_control",
    )!;
    blocked.action = "reset-required";
    blocked.reason = "The changed target is explicitly reset for preview.";
    edge.edgeSha256 = await recipeUpdateEdgeSha256(edge);
    const sourceState = await recipeState("v1");
    const targetState = await recipeState("v2", { blocked_control: 0 });
    const memberships = componentMembership(edge);
    const proofs = componentProofs(memberships, null);
    const rows = controlRows(edge, sourceState, targetState, proofs);
    const blockedRow = rows.find((row) => row.ledgerId === "blocked_control")!;
    blockedRow.resolution = "reset-to-neutral";
    blockedRow.candidateOrigin = "neutral";
    blockedRow.proofStatus = "not-preserved";
    blockedRow.reasonCode = "RESET_REQUIRED";
    blockedRow.requiresPreview = true;
    blockedRow.requiresConfirmation = true;
    const plan = await createRecipeMigrationPlan({
      contract: "recipe-migration-plan/v1",
      schemaVersion: 1,
      planId: "migration.fixture.automatic",
      directEdgeKey: edge.directEdgeKey,
      edgeSha256: edge.edgeSha256,
      fromSource: recipeSource(edge.from, "v1"),
      toSource: recipeSource(edge.to, "v2"),
      fromRecipeRevision: 1,
      toRecipeRevision: 2,
      fromStateSha256: sourceState.stateSha256,
      toleranceProfile: "recipe-strict/v1",
      componentMapBundleSha256: null,
      outcome: {
        kind: "automatic",
        readiness: "preview-required",
        preservationClaim: "none",
        rejectionCodes: [],
        cleanResetEligibility: "not-applicable",
        basedOnUnsupportedPlanSha256: null,
      },
      controlRows: rows,
      siblingRows: siblingRows(edge, sourceState, targetState),
      componentProofs: proofs,
      wholeRecipeProof: {
        status: "expected-mismatch",
        sourcePhysicalOutputSha256: sha("1"),
        targetPhysicalOutputSha256: sha("2"),
        sourceAbsoluteOutputSha256: sha("3"),
        targetAbsoluteOutputSha256: sha("4"),
        sourceMaterialSha256: sha("5"),
        targetMaterialSha256: sha("6"),
        materialMatches: false,
        errors: zeroErrors(),
        mismatchDomains: ["material", "neutral"],
        permitsAppearancePreservedClaim: false,
        proofSha256: sha("0"),
      },
      warnings: [...edge.warnings].sort((left, right) =>
        left.code.localeCompare(right.code),
      ),
      proposedState: targetState,
    });
    await expect(
      verifyRecipeMigrationPlan(plan, verifierContext(edge, sourceState)),
    ).resolves.toEqual(plan);

    const unexplained = mutable(plan);
    unexplained.wholeRecipeProof.mismatchDomains.push("geometry");
    unexplained.wholeRecipeProof.mismatchDomains.sort();
    unexplained.wholeRecipeProof.proofSha256 = sha("0");
    const { planSha256: _hash, ...content } = unexplained;
    const confirmedResetGeometry = await createRecipeMigrationPlan(content);
    await expect(
      verifyRecipeMigrationPlan(
        confirmedResetGeometry,
        verifierContext(edge, sourceState),
      ),
    ).resolves.toEqual(confirmedResetGeometry);
  });

  it("allows a clean reset only from the cited eligible unsupported plan", async () => {
    const { plan: unsupported, sourceState } = await unsupportedPlan();
    const edge = recipeUpdatesFixture.edges[0];
    const targetState = await recipeState("v2", {}, true);
    const memberships = componentMembership(edge);
    const proofs = componentProofs(memberships, null, true);
    const reset = await createRecipeMigrationPlan({
      contract: "recipe-migration-plan/v1",
      schemaVersion: 1,
      planId: "migration.fixture.clean-reset",
      directEdgeKey: edge.directEdgeKey,
      edgeSha256: edge.edgeSha256,
      fromSource: recipeSource(edge.from, "v1"),
      toSource: recipeSource(edge.to, "v2"),
      fromRecipeRevision: 1,
      toRecipeRevision: 2,
      fromStateSha256: sourceState.stateSha256,
      toleranceProfile: "recipe-strict/v1",
      componentMapBundleSha256: null,
      outcome: {
        kind: "clean-reset",
        readiness: "preview-required",
        preservationClaim: "none",
        rejectionCodes: [],
        cleanResetEligibility: "not-applicable",
        basedOnUnsupportedPlanSha256: unsupported.planSha256,
      },
      controlRows: controlRows(edge, sourceState, targetState, proofs, true),
      siblingRows: siblingRows(edge, sourceState, targetState, true),
      componentProofs: proofs,
      wholeRecipeProof: {
        status: "expected-mismatch",
        sourcePhysicalOutputSha256: sha("1"),
        targetPhysicalOutputSha256: sha("2"),
        sourceAbsoluteOutputSha256: sha("3"),
        targetAbsoluteOutputSha256: sha("4"),
        sourceMaterialSha256: sha("5"),
        targetMaterialSha256: sha("6"),
        materialMatches: false,
        errors: zeroErrors(),
        mismatchDomains: ["geometry"],
        permitsAppearancePreservedClaim: false,
        proofSha256: sha("0"),
      },
      warnings: [...edge.warnings].sort((left, right) =>
        left.code.localeCompare(right.code),
      ),
      proposedState: targetState,
    });
    await expect(
      verifyRecipeMigrationPlan(
        reset,
        verifierContext(edge, sourceState, unsupported),
      ),
    ).resolves.toEqual(reset);

    const nonzero = mutable(reset);
    nonzero.proposedState.appearanceDials.values.affine_remap = 0.1;
    nonzero.proposedState.stateSha256 = await recipeStateSnapshotSha256(
      nonzero.proposedState,
    );
    nonzero.controlRows.find(
      (row: RecipeMigrationControlRow) => row.ledgerId === "affine_remap",
    ).targetControl.value = 0.1;
    nonzero.planSha256 = await (async () => {
      const { planSha256: _hash, ...content } = nonzero;
      return (await createRecipeMigrationPlan(content)).planSha256;
    })();
    await expect(
      verifyRecipeMigrationPlan(
        nonzero,
        verifierContext(edge, sourceState, unsupported),
      ),
    ).rejects.toThrow(/exact neutral|not zero/);

    await expect(
      verifyRecipeMigrationPlan(reset, verifierContext(edge, sourceState)),
    ).rejects.toThrow(/no eligible unsupported plan/);
  });

  it("rejects contract contradictions, ledger drift, warning drift, state tamper, and hash tamper", async () => {
    const { plan, sourceState } = await unsupportedPlan();
    const context = verifierContext(recipeUpdatesFixture.edges[0], sourceState);

    const contradictory = mutable(plan);
    contradictory.outcome.kind = "automatic";
    expect(() => parseRecipeMigrationPlan(contradictory)).toThrow(
      /automatic outcome is contradictory|proposed state availability/,
    );

    const ledger = mutable(plan);
    ledger.controlRows.pop();
    ledger.planSha256 = await (async () => {
      const { planSha256: _hash, ...content } = ledger;
      return (await createRecipeMigrationPlan(content)).planSha256;
    })();
    await expect(verifyRecipeMigrationPlan(ledger, context)).rejects.toThrow(
      /stable-id ledger/,
    );

    const targetIdentity = mutable(plan);
    const targetRow = targetIdentity.controlRows.find(
      (row: RecipeMigrationControlRow) => row.targetControl !== null,
    );
    targetRow.targetControl.id =
      recipeUpdatesFixture.edges[0].stableIdLedger.toIds.find(
        (id) => id !== targetRow.ledgerId,
      );
    targetIdentity.planSha256 = await (async () => {
      const { planSha256: _hash, ...content } = targetIdentity;
      return (await createRecipeMigrationPlan(content)).planSha256;
    })();
    await expect(
      verifyRecipeMigrationPlan(targetIdentity, context),
    ).rejects.toThrow(/target identity/);

    const tolerance = mutable(plan);
    tolerance.componentProofs.find(
      (proof: RecipeMigrationComponentProof) => proof.status === "verified",
    ).errors.scalarMaximum = 1e-6;
    const changedToleranceProof = tolerance.componentProofs.find(
      (proof: RecipeMigrationComponentProof) =>
        proof.errors.scalarMaximum === 1e-6,
    );
    changedToleranceProof.proofSha256 = sha("0");
    for (const row of tolerance.controlRows) {
      if (row.componentId === changedToleranceProof.componentId) {
        row.componentProofSha256 = sha("0");
      }
    }
    tolerance.planSha256 = await (async () => {
      const { planSha256: _hash, ...content } = tolerance;
      return (await createRecipeMigrationPlan(content)).planSha256;
    })();
    await expect(verifyRecipeMigrationPlan(tolerance, context)).rejects.toThrow(
      /locked tolerance/,
    );

    const solverMismatch = mutable(plan);
    const mismatchedProof = solverMismatch.componentProofs.find(
      (proof: RecipeMigrationComponentProof) => proof.status === "verified",
    );
    mismatchedProof.solver = "edge-affine";
    mismatchedProof.proofSha256 = sha("0");
    for (const row of solverMismatch.controlRows) {
      if (row.componentId === mismatchedProof.componentId) {
        row.componentProofSha256 = sha("0");
      }
    }
    const { planSha256: _solverPlanSha256, ...solverMismatchContent } =
      solverMismatch;
    const rehashedSolverMismatch = await createRecipeMigrationPlan(
      solverMismatchContent,
    );
    await expect(
      verifyRecipeMigrationPlan(rehashedSolverMismatch, context),
    ).rejects.toThrow(/contradictory solver uniqueness/);

    const warning = mutable(plan);
    warning.warnings[0].proofSha256 = sha("f");
    warning.planSha256 = await (async () => {
      const { planSha256: _hash, ...content } = warning;
      return (await createRecipeMigrationPlan(content)).planSha256;
    })();
    await expect(verifyRecipeMigrationPlan(warning, context)).rejects.toThrow(
      /warnings contradict/,
    );

    const sourceTamper = mutable(sourceState);
    sourceTamper.appearanceDials.values.affine_remap = 0.51;
    await expect(
      verifyRecipeMigrationPlan(plan, {
        ...context,
        sourceState: sourceTamper,
      }),
    ).rejects.toThrow(/state hash mismatch/);

    const hash = mutable(plan);
    hash.planSha256 = sha("f");
    await expect(verifyRecipeMigrationPlan(hash, context)).rejects.toThrow(
      /plan hash mismatch/,
    );

    const nestedProof = mutable(plan);
    nestedProof.componentProofs.find(
      (proof: RecipeMigrationComponentProof) => proof.status === "verified",
    ).sourcePhysicalOutputSha256 = sha("f");
    const { planSha256: _nestedPlanSha256, ...nestedProofContent } =
      nestedProof;
    nestedProof.planSha256 = await canonicalRecipeSha256(nestedProofContent);
    await expect(
      verifyRecipeMigrationPlan(nestedProof, context),
    ).rejects.toThrow(/component proof .* hash mismatch/);

    const extra = mutable(plan);
    extra.extra = true;
    expect(() => parseRecipeMigrationPlan(extra)).toThrow(
      /must contain exactly/,
    );
  });
});
