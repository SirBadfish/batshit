import type {
  AppearanceDialValueState,
  AppearanceDialsManifest,
} from "../appearanceDials.contracts";
import { parseAppearanceDialsManifest } from "../appearanceDials.schema";
import {
  buildAppearanceRecipeDependencyGraph,
  unionAppearanceRecipeDependencyGraphs,
  type AppearanceRecipeDependencyGraph,
} from "./appearanceRecipeDependencyGraph";
import {
  generateAppearanceRecipeComponentCandidates,
  type AppearanceRecipeCandidateGeneration,
  type AppearanceRecipeComponentCandidate,
} from "./appearanceRecipeCandidateGenerator";
import { proveAppearanceRecipeCandidateUniqueness } from "./appearanceRecipeCandidateUniqueness";
import { buildAppearanceRecipePhysicalBasisFromGlb } from "./appearanceRecipePhysicalModel";
import {
  AppearanceRecipePhysicalInventoryMismatchError,
  appearanceRecipePhysicalProofKeyInventory,
  compareAppearanceRecipePhysicalProof,
  compareAppearanceRecipeRelativeComponentEffects,
  projectAppearanceRecipeAbsoluteProof,
  projectAppearanceRecipeLogicalProof,
  projectAppearanceRecipeRelativeComponentEffect,
  type AppearanceRecipePhysicalProofErrorSummary,
  type AppearanceRecipePhysicalProofInput,
} from "./appearanceRecipePhysicalProof";
import { evaluateAppearanceRecipePhysicalOutput } from "./appearanceRecipePhysicalEvaluator";
import { buildAppearanceRecipeSemanticProof } from "./appearanceRecipeSemanticProof";
import {
  createRecipeMigrationPlan,
  verifyRecipeMigrationPlan,
  type RecipeMigrationComponentMembership,
  type RecipeMigrationComponentProof,
  type RecipeMigrationControlRow,
  type RecipeMigrationPlan,
  type RecipeMigrationRejectionCode,
  type RecipeMigrationExternalSiblingBinding,
  type RecipeMigrationSiblingBinding,
  type RecipeMigrationSiblingDefinitionRef,
  type RecipeMigrationSiblingRow,
  type RecipeMigrationWholeProof,
  type RecipePhysicalErrorSummary,
} from "./migrationPlanContracts";
import type { RecipeSourceIdentity } from "./packageMetadata";
import {
  canonicalRecipeSha256,
  canonicalRecipeString,
  requireLowercaseSha256,
} from "./recipeCanonical";
import {
  GOON_RECIPE_STATE_CONTRACT,
  recipeSiblingStateSha256,
  recipeStateSnapshotSha256,
  verifyRecipeStateSnapshot,
  type RecipeSource,
  type RecipeSiblingStateRecord,
  type RecipeStateSnapshot,
} from "./recipeContracts";
import { verifyRecipeSourceRawAssets } from "./recipeSourceAssets";
import {
  appearanceRecipeControlInventory,
  createNeutralAppearanceRecipeState,
  resolveStrictAppearanceRecipeSnapshot,
} from "./strictAppearanceRecipeResolver";
import type {
  RecipeComponentMapBundle,
  RecipeComponentMapMembership,
} from "./componentMapContracts";
import {
  RECIPE_STRICT_TOLERANCE_PROFILE,
  verifyRecipeUpdateEdge,
  type RecipeSiblingSurface,
  type RecipeUpdateEdge,
} from "./updateContracts";

export const APPEARANCE_RECIPE_MIGRATION_PLANNER_CONTRACT =
  "appearance-recipe-migration-planner/v1" as const;

export type AppearanceRecipeMigrationPackageInput = {
  recipeSource: RecipeSource;
  packageBytes: Uint8Array;
  glbBytes: Uint8Array;
  manifestBytes: Uint8Array;
};

export type AppearanceRecipeMigrationSiblingInput = {
  sourceStateId: string | null;
  targetStateId: string | null;
  targetDefinition: RecipeMigrationSiblingDefinitionRef | null;
  message?: string;
};

export type AppearanceRecipeMigrationExternalSiblingInput = {
  sourceStateId: string;
  targetStateId: string;
  validationSha256: string;
  message: string;
  targetState: RecipeSiblingStateRecord;
};

export type AppearanceRecipeSiblingVerificationRequest = {
  surface: RecipeSiblingSurface;
  operation: "migrate" | "reset";
  directEdgeKey: string;
  edgeSha256: string;
  sourceState: RecipeSiblingStateRecord | null;
  targetStateId: string;
  targetDefinition: RecipeMigrationSiblingDefinitionRef;
};

export type AppearanceRecipeSiblingVerificationResult = {
  proposedState: RecipeSiblingStateRecord;
  domainEvidenceSha256: string;
  message: string;
};

export type AppearanceRecipeSiblingVerifier = {
  verifierId: string;
  verifierVersion: number;
  verify(
    request: AppearanceRecipeSiblingVerificationRequest,
  ):
    | Promise<AppearanceRecipeSiblingVerificationResult>
    | AppearanceRecipeSiblingVerificationResult;
};

export type AppearanceRecipeMigrationPlannerInput = {
  planId: string;
  fromRecipeRevision: number;
  toRecipeRevision?: number;
  edge: RecipeUpdateEdge;
  sourceState: RecipeStateSnapshot;
  sourcePackage: AppearanceRecipeMigrationPackageInput;
  targetPackage: AppearanceRecipeMigrationPackageInput;
  siblingInputs: Record<
    RecipeSiblingSurface,
    AppearanceRecipeMigrationSiblingInput
  >;
  externalSiblingInputs?: AppearanceRecipeMigrationExternalSiblingInput[];
  componentMapBundle?: RecipeComponentMapBundle;
  siblingVerifiers?: Partial<
    Record<RecipeSiblingSurface, AppearanceRecipeSiblingVerifier>
  >;
};

export type AppearanceRecipeCleanResetPlannerInput = {
  planId: string;
  migrationInput: AppearanceRecipeMigrationPlannerInput;
  eligibleUnsupportedPlan: RecipeMigrationPlan;
};

type PreparedPackage = {
  source: RecipeSource;
  identity: RecipeSourceIdentity;
  manifest: AppearanceDialsManifest;
  basis: ReturnType<typeof buildAppearanceRecipePhysicalBasisFromGlb>;
  semantic: Awaited<ReturnType<typeof buildAppearanceRecipeSemanticProof>>;
};

type EvaluatedAppearance = {
  state: AppearanceDialValueState;
  proof: AppearanceRecipePhysicalProofInput;
};

type ComponentModel = {
  candidateMembership: Record<string, RecipeComponentMapMembership>;
  verifierMembership: Record<string, RecipeMigrationComponentMembership>;
};

type SiblingPlanningResult = {
  rows: RecipeMigrationSiblingRow[];
  proposedStates: RecipeSiblingStateRecord[];
  bindings: Record<RecipeSiblingSurface, RecipeMigrationSiblingBinding>;
  externalBindings: RecipeMigrationExternalSiblingBinding[];
  externalStateChanged: boolean;
  rejectionCodes: RecipeMigrationRejectionCode[];
};

type BuiltMigrationContext = {
  plan: RecipeMigrationPlan;
  verifier: Parameters<typeof verifyRecipeMigrationPlan>[1];
  edge: RecipeUpdateEdge;
  sourceState: RecipeStateSnapshot;
  sourcePrepared: PreparedPackage;
  targetPrepared: PreparedPackage;
  sourceAppearance: AppearanceDialValueState;
  sourceFull: EvaluatedAppearance;
  components: ComponentModel;
  targetInventory: ReturnType<typeof appearanceRecipeControlInventory>;
  siblingBindings: Record<RecipeSiblingSurface, RecipeMigrationSiblingBinding>;
  externalSiblingBindings: RecipeMigrationExternalSiblingBinding[];
};

const ZERO_SHA256 = "0".repeat(64);

function fail(message: string): never {
  throw new Error(
    `[${APPEARANCE_RECIPE_MIGRATION_PLANNER_CONTRACT}] ${message}`,
  );
}

function plannedTargetRecipeRevision(
  input: AppearanceRecipeMigrationPlannerInput,
): number {
  const target = input.toRecipeRevision ?? input.fromRecipeRevision + 1;
  if (!Number.isSafeInteger(target) || target <= input.fromRecipeRevision) {
    fail(
      "toRecipeRevision must be a safe integer greater than fromRecipeRevision",
    );
  }
  return target;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function record(value: unknown, context: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${context} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail(`${context} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalRecipeString(left) === canonicalRecipeString(right);
}

function sortedUniqueRejections(
  values: Iterable<RecipeMigrationRejectionCode>,
): RecipeMigrationRejectionCode[] {
  return [...new Set(values)].sort(compareText);
}

function zeroErrors(): RecipePhysicalErrorSummary {
  return {
    scalarMaximum: 0,
    positionMaximumMeters: 0,
    positionRmsMeters: 0,
    scaleMaximum: 0,
    quaternionMaximumRadians: 0,
    matrixMaximum: 0,
    bakedPositionMaximumMeters: 0,
    bakedPositionRmsMeters: 0,
  };
}

function physicalErrors(
  value: AppearanceRecipePhysicalProofErrorSummary,
): RecipePhysicalErrorSummary {
  return { ...value };
}

async function preparePackage(
  input: AppearanceRecipeMigrationPackageInput,
  expected: RecipeSourceIdentity,
  side: "source" | "target",
  requiredTargetEdge?: RecipeUpdateEdge,
): Promise<PreparedPackage> {
  let verified: Awaited<ReturnType<typeof verifyRecipeSourceRawAssets>>;
  try {
    verified = await verifyRecipeSourceRawAssets(
      input.recipeSource,
      {
        packageBytes: input.packageBytes,
        modelBytes: input.glbBytes,
        manifestBytes: input.manifestBytes,
      },
      expected,
      requiredTargetEdge,
    );
  } catch (error) {
    fail(
      `${side} package raw source verification failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const avatarManifest = verified.manifest;
  const identity = verified.source.identities;
  const manifest = parseAppearanceDialsManifest(avatarManifest);
  if (!manifest) fail(`${side} package has no Appearance Dials v2 contract`);
  const basis = buildAppearanceRecipePhysicalBasisFromGlb(
    input.glbBytes,
    avatarManifest,
  );
  const semantic = await buildAppearanceRecipeSemanticProof(input.glbBytes);
  return {
    source: verified.source,
    identity,
    manifest,
    basis,
    semantic,
  };
}

function rawControlId(nodeId: string): string {
  if (!nodeId.startsWith("control:") || nodeId.length === "control:".length) {
    fail(`dependency graph contains malformed control node ${nodeId}`);
  }
  return nodeId.slice("control:".length);
}

function componentModel(
  edge: RecipeUpdateEdge,
  graph: AppearanceRecipeDependencyGraph,
  sourceManifest: AppearanceDialsManifest,
  targetManifest: AppearanceDialsManifest,
): ComponentModel {
  const sourceInventory = appearanceRecipeControlInventory(sourceManifest);
  const targetInventory = appearanceRecipeControlInventory(targetManifest);
  const edgeControls = new Map(
    edge.controls.map((control) => [control.id, control]),
  );
  const graphControlIds = graph.components
    .flatMap((component) => component.controlIds.map(rawControlId))
    .sort(compareText);
  const ledgerControlIds = [
    ...new Set([...edge.stableIdLedger.fromIds, ...edge.stableIdLedger.toIds]),
  ].sort(compareText);
  if (!sameJson(graphControlIds, ledgerControlIds)) {
    fail("union dependency graph does not exhaust the direct-edge ledger");
  }

  const candidateMembership: Record<string, RecipeComponentMapMembership> = {};
  const graphComponentByEdgeComponent = new Map<string, string>();
  for (const graphComponent of graph.components) {
    const controlIds = graphComponent.controlIds
      .map(rawControlId)
      .sort(compareText);
    if (controlIds.length === 0) continue;
    const edgeComponentIds = new Set(
      controlIds.map((id) => {
        const control = edgeControls.get(id);
        if (!control)
          fail(`dependency graph control ${id} is absent from the edge`);
        return control.componentId;
      }),
    );
    if (edgeComponentIds.size !== 1) {
      fail(
        `union dependency component ${graphComponent.id} was split by the edge`,
      );
    }
    const edgeComponentId = [...edgeComponentIds][0]!;
    const previous = graphComponentByEdgeComponent.get(edgeComponentId);
    if (previous && previous !== graphComponent.id) {
      fail(
        `edge component ${edgeComponentId} merges disconnected graph components`,
      );
    }
    graphComponentByEdgeComponent.set(edgeComponentId, graphComponent.id);
    candidateMembership[edgeComponentId] = {
      sourceControlIds: controlIds.filter((id) =>
        edge.stableIdLedger.fromIds.includes(id),
      ),
      targetControlIds: controlIds.filter((id) =>
        edge.stableIdLedger.toIds.includes(id),
      ),
      sourceUnlockDialIds: controlIds.filter((id) =>
        sourceInventory.unlockDialIds.includes(id),
      ),
      targetUnlockDialIds: controlIds.filter((id) =>
        targetInventory.unlockDialIds.includes(id),
      ),
    };
  }
  const sortedCandidateMembership = Object.fromEntries(
    Object.entries(candidateMembership).sort(([left], [right]) =>
      compareText(left, right),
    ),
  );
  return {
    candidateMembership: sortedCandidateMembership,
    verifierMembership: Object.fromEntries(
      Object.entries(sortedCandidateMembership).map(([id, membership]) => [
        id,
        {
          sourceControlIds: membership.sourceControlIds,
          targetControlIds: membership.targetControlIds,
          sourceUnlockDialIds: membership.sourceUnlockDialIds,
          targetUnlockDialIds: membership.targetUnlockDialIds,
        },
      ]),
    ),
  };
}

function appearanceState(
  manifest: AppearanceDialsManifest,
  values: Record<string, number>,
  unlockedDialIds: string[],
): AppearanceDialValueState {
  return resolveStrictAppearanceRecipeSnapshot(manifest, {
    contract: "appearance-dial-values/v2",
    definitionSha256: manifest.definitionSha256,
    neutralId: manifest.neutral.id,
    neutralRecipeSha256: manifest.neutral.recipeSha256,
    values,
    unlockedDialIds: [...unlockedDialIds].sort(compareText),
  }).state;
}

function componentAppearanceState(
  manifest: AppearanceDialsManifest,
  source: AppearanceDialValueState,
  controlIds: string[],
  unlockDialIds: string[],
): AppearanceDialValueState {
  const neutral = createNeutralAppearanceRecipeState(manifest);
  for (const id of controlIds) neutral.values[id] = source.values[id]!;
  neutral.unlockedDialIds = source.unlockedDialIds.filter((id) =>
    unlockDialIds.includes(id),
  );
  return appearanceState(manifest, neutral.values, neutral.unlockedDialIds);
}

function candidateAppearanceState(
  manifest: AppearanceDialsManifest,
  candidate: AppearanceRecipeComponentCandidate,
): AppearanceDialValueState {
  const neutral = createNeutralAppearanceRecipeState(manifest);
  for (const [id, value] of Object.entries(candidate.values ?? {})) {
    neutral.values[id] = value;
  }
  neutral.unlockedDialIds = [...(candidate.unlockedDialIds ?? [])];
  return appearanceState(manifest, neutral.values, neutral.unlockedDialIds);
}

function evaluateAppearance(
  prepared: PreparedPackage,
  stored: AppearanceDialValueState,
): EvaluatedAppearance {
  const resolved = resolveStrictAppearanceRecipeSnapshot(
    prepared.manifest,
    stored,
  );
  return {
    state: resolved.state,
    proof: {
      logical: resolved.physicalSnapshot,
      absolute: evaluateAppearanceRecipePhysicalOutput(
        prepared.basis,
        resolved.resolved,
      ),
      correspondence: prepared.semantic.correspondence,
    },
  };
}

async function combinedOutputSha256(
  logicalSha256: string,
  absoluteSha256: string,
): Promise<string> {
  return canonicalRecipeSha256({ logicalSha256, absoluteSha256 });
}

async function comparedKeysSha256(
  logicalKeysSha256: string,
  absoluteKeysSha256: string,
): Promise<string> {
  return canonicalRecipeSha256({ logicalKeysSha256, absoluteKeysSha256 });
}

async function sourceComponentProjection(
  neutral: EvaluatedAppearance,
  evaluated: EvaluatedAppearance,
): Promise<{
  outputSha256: string;
  comparedKeysSha256: string;
}> {
  const projection = await projectAppearanceRecipeRelativeComponentEffect(
    neutral.proof,
    evaluated.proof,
  );
  return {
    outputSha256: await combinedOutputSha256(
      projection.logical.projectionSha256,
      projection.absolute.projectionSha256,
    ),
    comparedKeysSha256: await comparedKeysSha256(
      await canonicalRecipeSha256(projection.logical.inventory),
      await canonicalRecipeSha256(projection.absolute.inventory),
    ),
  };
}

async function buildComponentProofs(
  candidates: AppearanceRecipeCandidateGeneration,
  edge: RecipeUpdateEdge,
  sourcePrepared: PreparedPackage,
  targetPrepared: PreparedPackage,
  sourceAppearance: AppearanceDialValueState,
): Promise<RecipeMigrationComponentProof[]> {
  const sourceNeutral = evaluateAppearance(
    sourcePrepared,
    createNeutralAppearanceRecipeState(sourcePrepared.manifest),
  );
  const targetNeutral = evaluateAppearance(
    targetPrepared,
    createNeutralAppearanceRecipeState(targetPrepared.manifest),
  );
  const proofs: RecipeMigrationComponentProof[] = [];
  for (const candidate of candidates.components) {
    const uniqueness = await proveAppearanceRecipeCandidateUniqueness(
      edge,
      targetPrepared.manifest,
      candidate,
    );
    const sourceComponent = evaluateAppearance(
      sourcePrepared,
      componentAppearanceState(
        sourcePrepared.manifest,
        sourceAppearance,
        candidate.sourceControlIds,
        candidate.sourceUnlockDialIds,
      ),
    );
    const sourceProjection = await sourceComponentProjection(
      sourceNeutral,
      sourceComponent,
    );
    let targetOutputSha256: string | null = null;
    let comparedOutputKeysSha256 = sourceProjection.comparedKeysSha256;
    let errors = zeroErrors();
    let mismatchDomains: RecipeMigrationComponentProof["mismatchDomains"] = [];
    let status: RecipeMigrationComponentProof["status"] = "failed";
    const rejectionCodes = new Set(candidate.rejectionCodes);
    if (candidate.status !== "rejected" && !uniqueness.verified) {
      for (const code of uniqueness.rejectionCodes) rejectionCodes.add(code);
    }

    if (candidate.status !== "rejected" && uniqueness.verified) {
      try {
        const targetComponent = evaluateAppearance(
          targetPrepared,
          candidateAppearanceState(targetPrepared.manifest, candidate),
        );
        const comparison =
          await compareAppearanceRecipeRelativeComponentEffects(
            sourceNeutral.proof,
            sourceComponent.proof,
            targetNeutral.proof,
            targetComponent.proof,
          );
        targetOutputSha256 = await combinedOutputSha256(
          comparison.targetLogicalEffectSha256,
          comparison.targetAbsoluteEffectSha256,
        );
        comparedOutputKeysSha256 = await comparedKeysSha256(
          comparison.comparedLogicalKeysSha256,
          comparison.comparedAbsoluteKeysSha256,
        );
        errors = physicalErrors(comparison.errors);
        mismatchDomains = [...comparison.mismatchDomains].sort(compareText);
        if (candidate.status === "non-preserved") {
          status = "not-preserved";
        } else if (comparison.matches) {
          status = "verified";
          rejectionCodes.clear();
        } else {
          status = "failed";
          rejectionCodes.add("COMPONENT_PROOF_FAILED");
        }
      } catch (error) {
        const inventoryMismatch =
          error instanceof AppearanceRecipePhysicalInventoryMismatchError;
        const topologyRebuildExplainsMismatch =
          inventoryMismatch &&
          edge.topologyRebuild?.affectedComponentIds.includes(
            candidate.componentId,
          ) === true;
        mismatchDomains = inventoryMismatch
          ? [...error.mismatchDomains].sort(compareText)
          : [];
        if (topologyRebuildExplainsMismatch) {
          const targetComponent = evaluateAppearance(
            targetPrepared,
            candidateAppearanceState(targetPrepared.manifest, candidate),
          );
          const targetProjection = await sourceComponentProjection(
            targetNeutral,
            targetComponent,
          );
          targetOutputSha256 = targetProjection.outputSha256;
          comparedOutputKeysSha256 = await comparedKeysSha256(
            sourceProjection.comparedKeysSha256,
            targetProjection.comparedKeysSha256,
          );
          status = "not-preserved";
          rejectionCodes.clear();
        } else {
          status = "failed";
          rejectionCodes.add(
            inventoryMismatch
              ? "COMPONENT_MEMBERSHIP_MISMATCH"
              : "COMPONENT_PROOF_FAILED",
          );
        }
      }
    }

    proofs.push({
      componentId: candidate.componentId,
      sourceControlIds: candidate.sourceControlIds,
      targetControlIds: candidate.targetControlIds,
      solver: candidate.solver,
      authorizedCandidateCount: uniqueness.authorizedCandidateCount,
      selectedCandidateSha256: uniqueness.selectedCandidateSha256,
      uniquenessMethod: uniqueness.method,
      uniquenessProofSha256: uniqueness.proofSha256,
      componentMapSha256: candidate.componentMapSha256,
      sourcePhysicalOutputSha256: sourceProjection.outputSha256,
      targetPhysicalOutputSha256: targetOutputSha256,
      comparedOutputKeysSha256,
      mismatchDomains,
      status,
      errors,
      rejectionCodes: sortedUniqueRejections(rejectionCodes),
      proofSha256: ZERO_SHA256,
    });
  }
  return proofs;
}

async function buildExplicitResetComponentProofs(
  components: ComponentModel,
  sourcePrepared: PreparedPackage,
  targetPrepared: PreparedPackage,
  sourceAppearance: AppearanceDialValueState,
): Promise<{
  proofs: RecipeMigrationComponentProof[];
  candidateShaByComponent: Map<string, string>;
}> {
  const sourceNeutral = evaluateAppearance(
    sourcePrepared,
    createNeutralAppearanceRecipeState(sourcePrepared.manifest),
  );
  const targetNeutral = evaluateAppearance(
    targetPrepared,
    createNeutralAppearanceRecipeState(targetPrepared.manifest),
  );
  const targetNeutralProjection = await sourceComponentProjection(
    targetNeutral,
    targetNeutral,
  );
  const proofs: RecipeMigrationComponentProof[] = [];
  const candidateShaByComponent = new Map<string, string>();

  for (const [componentId, membership] of Object.entries(
    components.candidateMembership,
  ).sort(([left], [right]) => compareText(left, right))) {
    const sourceComponent = evaluateAppearance(
      sourcePrepared,
      componentAppearanceState(
        sourcePrepared.manifest,
        sourceAppearance,
        membership.sourceControlIds,
        membership.sourceUnlockDialIds,
      ),
    );
    const sourceProjection = await sourceComponentProjection(
      sourceNeutral,
      sourceComponent,
    );
    let comparison;
    try {
      comparison = await compareAppearanceRecipeRelativeComponentEffects(
        sourceNeutral.proof,
        sourceComponent.proof,
        targetNeutral.proof,
        targetNeutral.proof,
      );
    } catch (error) {
      fail(
        `clean reset component ${componentId} cannot be compared: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    const candidateSha256 = await canonicalRecipeSha256({
      contract: "appearance-recipe-component-candidate/v1",
      componentId,
      values: Object.fromEntries(
        membership.targetControlIds.map((id) => [id, 0]),
      ),
      unlockedDialIds: [],
    });
    candidateShaByComponent.set(componentId, candidateSha256);
    const uniquenessProofSha256 = await canonicalRecipeSha256({
      contract: "appearance-recipe-candidate-uniqueness/v1",
      componentId,
      method: "explicit-reset",
      targetControlIds: membership.targetControlIds,
      candidateSha256,
    });
    proofs.push({
      componentId,
      sourceControlIds: membership.sourceControlIds,
      targetControlIds: membership.targetControlIds,
      solver: "explicit-reset",
      authorizedCandidateCount: 1,
      selectedCandidateSha256: candidateSha256,
      uniquenessMethod: "explicit-reset",
      uniquenessProofSha256,
      componentMapSha256: null,
      sourcePhysicalOutputSha256: sourceProjection.outputSha256,
      targetPhysicalOutputSha256: targetNeutralProjection.outputSha256,
      comparedOutputKeysSha256: await comparedKeysSha256(
        comparison.comparedLogicalKeysSha256,
        comparison.comparedAbsoluteKeysSha256,
      ),
      mismatchDomains: [...comparison.mismatchDomains].sort(compareText),
      status: "not-preserved",
      errors: physicalErrors(comparison.errors),
      rejectionCodes: [],
      proofSha256: ZERO_SHA256,
    });
  }
  return { proofs, candidateShaByComponent };
}

function siblingStateRef(state: RecipeSiblingStateRecord | null) {
  return state
    ? {
        id: state.id,
        contract: state.contract,
        definitionSha256: state.definitionSha256,
        stateSha256: state.stateSha256,
      }
    : null;
}

async function verifiedSiblingState(
  value: RecipeSiblingStateRecord,
  context: string,
): Promise<RecipeSiblingStateRecord> {
  const actual = await recipeSiblingStateSha256(value.state);
  if (actual !== value.stateSha256) fail(`${context} state hash mismatch`);
  return structuredClone(value);
}

async function runSiblingVerifier(
  verifier: AppearanceRecipeSiblingVerifier | undefined,
  request: AppearanceRecipeSiblingVerificationRequest,
): Promise<{
  proposedState: RecipeSiblingStateRecord;
  proofSha256: string;
  message: string;
}> {
  if (!verifier) {
    fail(`sibling ${request.surface} has no registered domain verifier`);
  }
  if (
    !/^[a-z0-9][a-z0-9._-]*$/.test(verifier.verifierId) ||
    !Number.isSafeInteger(verifier.verifierVersion) ||
    verifier.verifierVersion < 1
  ) {
    fail(`sibling ${request.surface} domain verifier identity is invalid`);
  }
  const result = await verifier.verify(structuredClone(request));
  const proposedState = await verifiedSiblingState(
    result.proposedState,
    `sibling ${request.surface} verifier result`,
  );
  if (
    proposedState.id !== request.targetStateId ||
    proposedState.contract !== request.targetDefinition.contract ||
    proposedState.definitionSha256 !== request.targetDefinition.definitionSha256
  ) {
    fail(`sibling ${request.surface} verifier returned another target state`);
  }
  const domainEvidenceSha256 = requireLowercaseSha256(
    result.domainEvidenceSha256,
    `sibling ${request.surface} domain evidence`,
  );
  if (typeof result.message !== "string" || result.message.length === 0) {
    fail(`sibling ${request.surface} verifier returned no explanation`);
  }
  const proofSha256 = await canonicalRecipeSha256({
    contract: "recipe-sibling-migration-proof/v1",
    verifierId: verifier.verifierId,
    verifierVersion: verifier.verifierVersion,
    surface: request.surface,
    operation: request.operation,
    directEdgeKey: request.directEdgeKey,
    edgeSha256: request.edgeSha256,
    sourceStateSha256: request.sourceState?.stateSha256 ?? null,
    targetStateId: request.targetStateId,
    targetDefinition: request.targetDefinition,
    proposedStateSha256: proposedState.stateSha256,
    domainEvidenceSha256,
  });
  return { proposedState, proofSha256, message: result.message };
}

function assertSiblingBindingsExhaustState(
  sourceState: RecipeStateSnapshot,
  inputs: AppearanceRecipeMigrationPlannerInput["siblingInputs"],
  externalInputs: AppearanceRecipeMigrationExternalSiblingInput[] = [],
): void {
  const surfaces: RecipeSiblingSurface[] = [
    "eyeAppearance",
    "facialArtwork",
    "oralAppearance",
  ];
  const inputSurfaces = Object.keys(inputs).sort(compareText);
  if (!sameJson(inputSurfaces, [...surfaces].sort(compareText))) {
    fail("sibling inputs must contain exactly the three named surfaces");
  }
  const sortedExternalInputs = [...externalInputs].sort((left, right) =>
    compareText(left.sourceStateId, right.sourceStateId),
  );
  if (!sameJson(sortedExternalInputs, externalInputs)) {
    fail("external sibling inputs must be sorted by source state id");
  }
  if (
    new Set(externalInputs.map((input) => input.sourceStateId)).size !==
      externalInputs.length ||
    new Set(externalInputs.map((input) => input.targetStateId)).size !==
      externalInputs.length
  ) {
    fail("external sibling inputs must be unique");
  }
  const boundSourceIds = [
    ...surfaces
      .map((surface) => inputs[surface].sourceStateId)
      .filter((id): id is string => id !== null),
    ...externalInputs.map((input) => input.sourceStateId),
  ].sort(compareText);
  const sourceIds = sourceState.siblings
    .map((state) => state.id)
    .sort(compareText);
  if (!sameJson(boundSourceIds, sourceIds)) {
    fail("sibling source bindings do not exhaust Recipe state siblings");
  }
  const targetIds = [
    ...surfaces
      .map((surface) => inputs[surface].targetStateId)
      .filter((id): id is string => id !== null),
    ...externalInputs.map((input) => input.targetStateId),
  ];
  if (new Set(targetIds).size !== targetIds.length) {
    fail("sibling target state ids must be unique");
  }
}

async function buildSiblingPlan(
  edge: RecipeUpdateEdge,
  sourceState: RecipeStateSnapshot,
  inputs: AppearanceRecipeMigrationPlannerInput["siblingInputs"],
  verifiers: AppearanceRecipeMigrationPlannerInput["siblingVerifiers"],
  externalInputs: AppearanceRecipeMigrationExternalSiblingInput[] = [],
): Promise<SiblingPlanningResult> {
  assertSiblingBindingsExhaustState(sourceState, inputs, externalInputs);
  const sourceById = new Map(
    sourceState.siblings.map((state) => [state.id, state]),
  );
  const rows: RecipeMigrationSiblingRow[] = [];
  const proposedStates: RecipeSiblingStateRecord[] = [];
  const rejectionCodes = new Set<RecipeMigrationRejectionCode>();
  const bindings = {} as Record<
    RecipeSiblingSurface,
    RecipeMigrationSiblingBinding
  >;

  for (const subplan of [...edge.siblingSubplans].sort((left, right) =>
    compareText(left.surface, right.surface),
  )) {
    const input = inputs[subplan.surface];
    if (!input) fail(`sibling input ${subplan.surface} is missing`);
    bindings[subplan.surface] = {
      sourceStateId: input.sourceStateId,
      targetStateId: input.targetStateId,
    };
    const source = input.sourceStateId
      ? (sourceById.get(input.sourceStateId) ?? null)
      : null;
    if ((source === null) !== (subplan.fromContract === null)) {
      fail(`sibling ${subplan.surface} source presence contradicts its edge`);
    }
    if (source && source.contract !== subplan.fromContract) {
      fail(`sibling ${subplan.surface} source contract contradicts its edge`);
    }
    if ((input.targetDefinition === null) !== (subplan.toContract === null)) {
      fail(`sibling ${subplan.surface} target presence contradicts its edge`);
    }
    if (
      input.targetDefinition &&
      input.targetDefinition.contract !== subplan.toContract
    ) {
      fail(`sibling ${subplan.surface} target contract contradicts its edge`);
    }

    let resolution: RecipeMigrationSiblingRow["resolution"] = "blocked";
    let proposedState: RecipeSiblingStateRecord | null = null;
    let proofStatus: RecipeMigrationSiblingRow["proofStatus"] = "failed";
    let proofSha256 = subplan.proofSha256;
    let reasonCode: RecipeMigrationSiblingRow["reasonCode"] = "SIBLING_BLOCKED";
    let requiresPreview = true;
    let requiresConfirmation = false;
    let message = input.message ?? subplan.reason;

    if (subplan.action === "not-present") {
      if (
        input.sourceStateId !== null ||
        input.targetStateId !== null ||
        input.targetDefinition !== null
      ) {
        fail(`not-present sibling ${subplan.surface} invented state bindings`);
      }
      resolution = "not-present";
      proofStatus = "not-required";
      reasonCode = "SIBLING_NOT_PRESENT";
      requiresPreview = false;
    } else if (subplan.action === "keep") {
      if (
        !source ||
        input.targetStateId !== source.id ||
        !input.targetDefinition
      ) {
        fail(`kept sibling ${subplan.surface} must retain the exact state id`);
      }
      if (
        input.targetDefinition.contract !== source.contract ||
        input.targetDefinition.definitionSha256 !== source.definitionSha256
      ) {
        fail(`kept sibling ${subplan.surface} changed its definition`);
      }
      proposedState = structuredClone(source);
      resolution = "kept";
      proofStatus = "verified";
      reasonCode = "SIBLING_KEEP";
      requiresPreview = false;
    } else if (
      subplan.action === "migrate" ||
      subplan.action === "reset-required"
    ) {
      if (input.targetStateId && input.targetDefinition) {
        try {
          const verified = await runSiblingVerifier(
            verifiers?.[subplan.surface],
            {
              surface: subplan.surface,
              operation: subplan.action === "migrate" ? "migrate" : "reset",
              directEdgeKey: edge.directEdgeKey,
              edgeSha256: edge.edgeSha256,
              sourceState: source,
              targetStateId: input.targetStateId,
              targetDefinition: input.targetDefinition,
            },
          );
          proposedState = verified.proposedState;
          proofSha256 = verified.proofSha256;
          message = verified.message;
        } catch (error) {
          rejectionCodes.add("SIBLING_PROOF_FAILED");
          message =
            error instanceof Error
              ? error.message
              : `The ${subplan.surface} verifier failed.`;
        }
      }
      if (proposedState) {
        if (subplan.action === "migrate") {
          resolution = "migrated";
          proofStatus = "verified";
          reasonCode = "SIBLING_MIGRATE";
          requiresPreview = true;
        } else {
          resolution = "reset";
          proofStatus = "not-preserved";
          reasonCode = "SIBLING_RESET";
          requiresPreview = true;
          requiresConfirmation = true;
        }
      } else {
        rejectionCodes.add("SIBLING_HANDLER_MISSING");
        message ||= `No verified ${subplan.surface} handler result was supplied.`;
      }
    } else {
      rejectionCodes.add("SIBLING_PROOF_FAILED");
    }

    if (proposedState) proposedStates.push(proposedState);
    rows.push({
      surface: subplan.surface,
      sourceState: siblingStateRef(source),
      targetDefinition: input.targetDefinition,
      action: subplan.action,
      resolution,
      proposedState,
      proofStatus,
      proofSha256,
      reasonCode,
      message,
      requiresPreview,
      requiresConfirmation,
    });
  }
  for (const input of externalInputs) {
    requireLowercaseSha256(
      input.validationSha256,
      `external sibling ${input.sourceStateId} validationSha256`,
    );
    if (input.sourceStateId !== input.targetStateId) {
      fail(
        `external sibling ${input.sourceStateId} must retain its exact state id`,
      );
    }
    if (
      typeof input.message !== "string" ||
      input.message.trim() !== input.message ||
      input.message.length === 0
    ) {
      fail(
        `external sibling ${input.sourceStateId} must include a validation message`,
      );
    }
    const source = sourceById.get(input.sourceStateId);
    if (!source)
      fail(`external sibling ${input.sourceStateId} has no source state`);
    if (input.targetState.id !== input.targetStateId) {
      fail(
        `external sibling ${input.sourceStateId} target state id contradicts its binding`,
      );
    }
    proposedStates.push(structuredClone(input.targetState));
  }
  proposedStates.sort((left, right) => compareText(left.id, right.id));
  return {
    rows,
    proposedStates,
    bindings,
    externalBindings: externalInputs.map(
      ({ sourceStateId, targetStateId, validationSha256, targetState }) => ({
        sourceStateId,
        targetStateId,
        targetStateSha256: targetState.stateSha256,
        validationSha256,
      }),
    ),
    externalStateChanged: externalInputs.some((input) => {
      const source = sourceById.get(input.sourceStateId)!;
      return (
        source.contract !== input.targetState.contract ||
        source.definitionSha256 !== input.targetState.definitionSha256 ||
        source.stateSha256 !== input.targetState.stateSha256
      );
    }),
    rejectionCodes: sortedUniqueRejections(rejectionCodes),
  };
}

async function buildCleanResetSiblingPlan(
  edge: RecipeUpdateEdge,
  sourceState: RecipeStateSnapshot,
  inputs: AppearanceRecipeMigrationPlannerInput["siblingInputs"],
  verifiers: AppearanceRecipeMigrationPlannerInput["siblingVerifiers"],
  externalInputs: AppearanceRecipeMigrationExternalSiblingInput[] = [],
): Promise<SiblingPlanningResult> {
  assertSiblingBindingsExhaustState(sourceState, inputs, externalInputs);
  const sourceById = new Map(
    sourceState.siblings.map((state) => [state.id, state]),
  );
  const rows: RecipeMigrationSiblingRow[] = [];
  const proposedStates: RecipeSiblingStateRecord[] = [];
  const bindings = {} as Record<
    RecipeSiblingSurface,
    RecipeMigrationSiblingBinding
  >;

  for (const subplan of [...edge.siblingSubplans].sort((left, right) =>
    compareText(left.surface, right.surface),
  )) {
    const input = inputs[subplan.surface];
    if (!input) fail(`clean reset sibling input ${subplan.surface} is missing`);
    bindings[subplan.surface] = {
      sourceStateId: input.sourceStateId,
      targetStateId: input.targetStateId,
    };
    const source = input.sourceStateId
      ? (sourceById.get(input.sourceStateId) ?? null)
      : null;
    if ((source === null) !== (subplan.fromContract === null)) {
      fail(
        `clean reset sibling ${subplan.surface} source presence contradicts its edge`,
      );
    }
    if (source && source.contract !== subplan.fromContract) {
      fail(
        `clean reset sibling ${subplan.surface} source contract contradicts its edge`,
      );
    }
    if ((input.targetDefinition === null) !== (subplan.toContract === null)) {
      fail(
        `clean reset sibling ${subplan.surface} target presence contradicts its edge`,
      );
    }

    if (input.targetDefinition === null) {
      if (input.targetStateId !== null) {
        fail(
          `clean reset sibling ${subplan.surface} invented target state or proof`,
        );
      }
      rows.push({
        surface: subplan.surface,
        sourceState: siblingStateRef(source),
        targetDefinition: null,
        action: subplan.action,
        resolution: "not-present",
        proposedState: null,
        proofStatus: "not-required",
        proofSha256: subplan.proofSha256,
        reasonCode: "CLEAN_RESET",
        message: `The ${subplan.surface} surface is not present in the target source.`,
        requiresPreview: true,
        requiresConfirmation: true,
      });
      continue;
    }

    if (!input.targetStateId) {
      fail(
        `clean reset sibling ${subplan.surface} has no verified target reset state`,
      );
    }
    const verified = await runSiblingVerifier(verifiers?.[subplan.surface], {
      surface: subplan.surface,
      operation: "reset",
      directEdgeKey: edge.directEdgeKey,
      edgeSha256: edge.edgeSha256,
      sourceState: source,
      targetStateId: input.targetStateId,
      targetDefinition: input.targetDefinition,
    });
    const proposedState = verified.proposedState;
    proposedStates.push(proposedState);
    rows.push({
      surface: subplan.surface,
      sourceState: siblingStateRef(source),
      targetDefinition: input.targetDefinition,
      action: subplan.action,
      resolution: "reset",
      proposedState,
      proofStatus: "not-preserved",
      proofSha256: verified.proofSha256,
      reasonCode: "CLEAN_RESET",
      message: verified.message,
      requiresPreview: true,
      requiresConfirmation: true,
    });
  }

  for (const input of externalInputs) {
    requireLowercaseSha256(
      input.validationSha256,
      `external sibling ${input.sourceStateId} validationSha256`,
    );
    if (input.sourceStateId !== input.targetStateId) {
      fail(
        `external sibling ${input.sourceStateId} must retain its exact state id`,
      );
    }
    const source = sourceById.get(input.sourceStateId);
    if (!source)
      fail(`external sibling ${input.sourceStateId} has no source state`);
    if (input.targetState.id !== input.targetStateId) {
      fail(
        `external sibling ${input.sourceStateId} target state id contradicts its binding`,
      );
    }
    proposedStates.push(structuredClone(input.targetState));
  }

  proposedStates.sort((left, right) => compareText(left.id, right.id));
  return {
    rows,
    proposedStates,
    bindings,
    externalBindings: externalInputs.map(
      ({ sourceStateId, targetStateId, validationSha256, targetState }) => ({
        sourceStateId,
        targetStateId,
        targetStateSha256: targetState.stateSha256,
        validationSha256,
      }),
    ),
    externalStateChanged: externalInputs.some((input) => {
      const source = sourceById.get(input.sourceStateId)!;
      return (
        source.contract !== input.targetState.contract ||
        source.definitionSha256 !== input.targetState.definitionSha256 ||
        source.stateSha256 !== input.targetState.stateSha256
      );
    }),
    rejectionCodes: [],
  };
}

function targetAppearanceFromCandidates(
  manifest: AppearanceDialsManifest,
  candidates: AppearanceRecipeCandidateGeneration,
): AppearanceDialValueState {
  const neutral = createNeutralAppearanceRecipeState(manifest);
  const unlocked = new Set<string>();
  for (const component of candidates.components) {
    if (!component.values || !component.unlockedDialIds) {
      fail(
        `component ${component.componentId} has no complete target candidate`,
      );
    }
    for (const [id, value] of Object.entries(component.values)) {
      neutral.values[id] = value;
    }
    for (const id of component.unlockedDialIds) unlocked.add(id);
  }
  return appearanceState(
    manifest,
    neutral.values,
    [...unlocked].sort(compareText),
  );
}

async function createStateSnapshot(
  appearanceDials: AppearanceDialValueState,
  siblings: RecipeSiblingStateRecord[],
): Promise<RecipeStateSnapshot> {
  const provisional: RecipeStateSnapshot = {
    contract: GOON_RECIPE_STATE_CONTRACT,
    stateSha256: ZERO_SHA256,
    appearanceDials,
    siblings: [...siblings].sort((left, right) =>
      compareText(left.id, right.id),
    ),
  };
  provisional.stateSha256 = await recipeStateSnapshotSha256(provisional);
  return verifyRecipeStateSnapshot(provisional);
}

async function wholeProof(
  edge: RecipeUpdateEdge,
  source: EvaluatedAppearance,
  target: EvaluatedAppearance,
  sourcePrepared: PreparedPackage,
  targetPrepared: PreparedPackage,
  componentProofs: RecipeMigrationComponentProof[],
  siblingRows: RecipeMigrationSiblingRow[],
  externalStateChanged = false,
): Promise<RecipeMigrationWholeProof> {
  const sourceLogical = await projectAppearanceRecipeLogicalProof(
    source.proof.logical,
  );
  const sourceAbsolute = await projectAppearanceRecipeAbsoluteProof(
    source.proof.absolute,
    source.proof.correspondence,
  );
  const sourcePhysicalOutputSha256 = sourceLogical.projectionSha256;
  const sourceAbsoluteOutputSha256 = sourceAbsolute.projectionSha256;
  const sourceMaterialSha256 =
    sourcePrepared.semantic.materials.projectionSha256;
  const targetMaterialSha256 =
    targetPrepared.semantic.materials.projectionSha256;
  const materialMatches = sourceMaterialSha256 === targetMaterialSha256;
  try {
    const comparison = await compareAppearanceRecipePhysicalProof(
      source.proof,
      target.proof,
    );
    const hasNeutralWarning = edge.warnings.some(
      (warning) => warning.code === "neutral-changed",
    );
    const hasMaterialWarning = edge.warnings.some(
      (warning) => warning.code === "material-changed",
    );
    const explainedPhysicalDomains = new Set(
      componentProofs
        .filter((proof) => proof.status === "not-preserved")
        .flatMap((proof) => proof.mismatchDomains),
    );
    const mismatchDomains = new Set<
      RecipeMigrationWholeProof["mismatchDomains"][number]
    >();
    if (!comparison.matches) {
      for (const domain of comparison.mismatchDomains) {
        mismatchDomains.add(domain);
      }
      if (hasNeutralWarning) mismatchDomains.add("neutral");
    }
    if (!materialMatches) mismatchDomains.add("material");
    const unexplainedPhysicalDomains = comparison.mismatchDomains.filter(
      (domain) => !hasNeutralWarning && !explainedPhysicalDomains.has(domain),
    );
    const physicalExplained =
      comparison.matches || unexplainedPhysicalDomains.length === 0;
    const materialExplained = materialMatches || hasMaterialWarning;
    const status: RecipeMigrationWholeProof["status"] =
      comparison.matches && materialMatches
        ? "verified"
        : physicalExplained && materialExplained
          ? "expected-mismatch"
          : "failed";
    const permitsAppearancePreservedClaim =
      status === "verified" &&
      edge.warnings.length === 0 &&
      !externalStateChanged &&
      componentProofs.every((proof) => proof.status === "verified") &&
      siblingRows.every(
        (row) =>
          ["kept", "not-present"].includes(row.resolution) &&
          ["verified", "not-required"].includes(row.proofStatus) &&
          !row.requiresPreview &&
          !row.requiresConfirmation,
      );
    return {
      status,
      sourcePhysicalOutputSha256,
      targetPhysicalOutputSha256: comparison.targetLogicalOutputSha256,
      sourceAbsoluteOutputSha256,
      targetAbsoluteOutputSha256: comparison.targetAbsoluteOutputSha256,
      sourceMaterialSha256,
      targetMaterialSha256,
      materialMatches,
      errors: physicalErrors(comparison.errors),
      mismatchDomains: [...mismatchDomains].sort(compareText),
      permitsAppearancePreservedClaim,
      proofSha256: ZERO_SHA256,
    };
  } catch (error) {
    const targetLogical = await projectAppearanceRecipeLogicalProof(
      target.proof.logical,
    );
    const targetAbsolute = await projectAppearanceRecipeAbsoluteProof(
      target.proof.absolute,
      target.proof.correspondence,
    );
    const inventoryMismatch =
      error instanceof AppearanceRecipePhysicalInventoryMismatchError;
    const physicalMismatchDomains =
      error instanceof AppearanceRecipePhysicalInventoryMismatchError
        ? error.mismatchDomains
        : (["geometry"] as const);
    const mismatchDomains = new Set<
      RecipeMigrationWholeProof["mismatchDomains"][number]
    >(physicalMismatchDomains);
    if (!materialMatches) mismatchDomains.add("material");
    const topologyRebuildExplainsMismatch =
      inventoryMismatch &&
      edge.topologyRebuild !== undefined &&
      edge.warnings.some((warning) => warning.code === "topology-changed") &&
      physicalMismatchDomains.every((domain) => domain === "geometry");
    const materialExplained =
      materialMatches ||
      edge.warnings.some((warning) => warning.code === "material-changed");
    const status: RecipeMigrationWholeProof["status"] =
      topologyRebuildExplainsMismatch && materialExplained
        ? "expected-mismatch"
        : "unavailable";
    return {
      status,
      sourcePhysicalOutputSha256,
      targetPhysicalOutputSha256: targetLogical.projectionSha256,
      sourceAbsoluteOutputSha256,
      targetAbsoluteOutputSha256: targetAbsolute.projectionSha256,
      sourceMaterialSha256,
      targetMaterialSha256,
      materialMatches,
      errors: zeroErrors(),
      mismatchDomains: [...mismatchDomains].sort(compareText),
      permitsAppearancePreservedClaim: false,
      proofSha256: ZERO_SHA256,
    };
  }
}

function failedWholeProof(
  source: EvaluatedAppearance,
  sourcePrepared: PreparedPackage,
): Promise<RecipeMigrationWholeProof> {
  return Promise.all([
    projectAppearanceRecipeLogicalProof(source.proof.logical),
    projectAppearanceRecipeAbsoluteProof(
      source.proof.absolute,
      source.proof.correspondence,
    ),
  ]).then(([logical, absolute]) => ({
    status: "unavailable",
    sourcePhysicalOutputSha256: logical.projectionSha256,
    targetPhysicalOutputSha256: null,
    sourceAbsoluteOutputSha256: absolute.projectionSha256,
    targetAbsoluteOutputSha256: null,
    sourceMaterialSha256: sourcePrepared.semantic.materials.projectionSha256,
    targetMaterialSha256: null,
    materialMatches: null,
    errors: zeroErrors(),
    mismatchDomains: [],
    permitsAppearancePreservedClaim: false,
    proofSha256: ZERO_SHA256,
  }));
}

async function buildCleanResetEvidence(input: {
  edge: RecipeUpdateEdge;
  sourceState: RecipeStateSnapshot;
  sourcePrepared: PreparedPackage;
  targetPrepared: PreparedPackage;
  sourceAppearance: AppearanceDialValueState;
  sourceFull: EvaluatedAppearance;
  components: ComponentModel;
  siblingInputs: AppearanceRecipeMigrationPlannerInput["siblingInputs"];
  siblingVerifiers: AppearanceRecipeMigrationPlannerInput["siblingVerifiers"];
  externalSiblingInputs: AppearanceRecipeMigrationPlannerInput["externalSiblingInputs"];
}): Promise<{
  proposedState: RecipeStateSnapshot;
  controlRows: RecipeMigrationControlRow[];
  siblingRows: RecipeMigrationSiblingRow[];
  componentProofs: RecipeMigrationComponentProof[];
  wholeRecipeProof: RecipeMigrationWholeProof;
  siblingBindings: Record<RecipeSiblingSurface, RecipeMigrationSiblingBinding>;
}> {
  const siblings = await buildCleanResetSiblingPlan(
    input.edge,
    input.sourceState,
    input.siblingInputs,
    input.siblingVerifiers,
    input.externalSiblingInputs,
  );
  const explicitReset = await buildExplicitResetComponentProofs(
    input.components,
    input.sourcePrepared,
    input.targetPrepared,
    input.sourceAppearance,
  );
  const targetAppearance = appearanceState(
    input.targetPrepared.manifest,
    createNeutralAppearanceRecipeState(input.targetPrepared.manifest).values,
    [],
  );
  const proposedState = await createStateSnapshot(
    targetAppearance,
    siblings.proposedStates,
  );
  const wholeRecipeProof = await wholeProof(
    input.edge,
    input.sourceFull,
    evaluateAppearance(input.targetPrepared, targetAppearance),
    input.sourcePrepared,
    input.targetPrepared,
    explicitReset.proofs,
    siblings.rows,
    siblings.externalStateChanged,
  );
  if (["failed", "unavailable"].includes(wholeRecipeProof.status)) {
    fail(
      `clean reset target cannot produce a complete explained whole-Recipe proof (${wholeRecipeProof.status})`,
    );
  }
  return {
    proposedState,
    controlRows: cleanResetControlRows(
      input.edge,
      input.sourceState,
      explicitReset.proofs,
      explicitReset.candidateShaByComponent,
    ),
    siblingRows: siblings.rows,
    componentProofs: explicitReset.proofs,
    wholeRecipeProof: {
      ...wholeRecipeProof,
      permitsAppearancePreservedClaim: false,
    },
    siblingBindings: siblings.bindings,
  };
}

function controlRows(
  edge: RecipeUpdateEdge,
  candidates: AppearanceRecipeCandidateGeneration,
  proofs: RecipeMigrationComponentProof[],
  unsupported: boolean,
): RecipeMigrationControlRow[] {
  const candidateByControl = new Map(
    candidates.components.flatMap((component) =>
      component.controls.map(
        (control) => [control.ledgerId, { component, control }] as const,
      ),
    ),
  );
  const proofByComponent = new Map(
    proofs.map((proof) => [proof.componentId, proof]),
  );
  const ledgerById = new Map(
    edge.stableIdLedger.entries.map((entry) => [entry.id, entry]),
  );
  return edge.controls
    .map((edgeControl) => {
      const found = candidateByControl.get(edgeControl.id);
      const ledger = ledgerById.get(edgeControl.id);
      if (!found || !ledger) fail(`candidate row ${edgeControl.id} is missing`);
      const { component, control } = found;
      const proof = proofByComponent.get(component.componentId)!;
      const proofStatus: RecipeMigrationControlRow["proofStatus"] =
        proof.status === "failed"
          ? "failed"
          : ["new-neutral", "removed-neutral"].includes(control.resolution)
            ? "not-required"
            : proof.status === "not-preserved" || !control.preserved
              ? "not-preserved"
              : "verified";
      return {
        ledgerId: edgeControl.id,
        sourceControl: ledger.fromKind
          ? {
              id: edgeControl.id,
              kind: ledger.fromKind,
              value: control.sourceValue,
            }
          : null,
        targetControl: ledger.toKind
          ? {
              id: edgeControl.id,
              kind: ledger.toKind,
              value: unsupported ? null : control.targetValue,
            }
          : null,
        edgeAction: edgeControl.action,
        componentId: edgeControl.componentId,
        resolution: control.resolution,
        aliasId: control.aliasId,
        candidateOrigin: control.candidateOrigin,
        candidateProofSha256: component.candidateSha256,
        componentProofSha256: proof.proofSha256,
        maximumScalarError: proof.errors.scalarMaximum,
        proofStatus,
        reasonCode: control.reasonCode,
        message: control.message,
        requiresPreview: control.requiresPreview,
        requiresConfirmation: control.requiresConfirmation,
      };
    })
    .sort((left, right) => compareText(left.ledgerId, right.ledgerId));
}

function cleanResetControlRows(
  edge: RecipeUpdateEdge,
  sourceState: RecipeStateSnapshot,
  proofs: RecipeMigrationComponentProof[],
  candidateShaByComponent: Map<string, string>,
): RecipeMigrationControlRow[] {
  const ledgerById = new Map(
    edge.stableIdLedger.entries.map((entry) => [entry.id, entry]),
  );
  const proofByComponent = new Map(
    proofs.map((proof) => [proof.componentId, proof]),
  );
  const aliasById = new Map<string, string>();
  for (const alias of edge.aliases) {
    const aliasId = `${alias.fromId}:${alias.toId}`;
    aliasById.set(alias.fromId, aliasId);
    aliasById.set(alias.toId, aliasId);
  }
  return edge.controls
    .map((control): RecipeMigrationControlRow => {
      const ledger = ledgerById.get(control.id);
      const proof = proofByComponent.get(control.componentId);
      const candidateProofSha256 = candidateShaByComponent.get(
        control.componentId,
      );
      if (!ledger || !proof || !candidateProofSha256) {
        fail(`clean reset control ${control.id} has no component proof`);
      }
      const sourceValue = ledger.fromKind
        ? sourceState.appearanceDials.values[control.id]
        : null;
      const hasTarget = ledger.toKind !== null;
      const resolution: RecipeMigrationControlRow["resolution"] = hasTarget
        ? "reset-to-neutral"
        : sourceValue === 0
          ? "removed-neutral"
          : "removed-active-preview";
      return {
        ledgerId: control.id,
        sourceControl: ledger.fromKind
          ? { id: control.id, kind: ledger.fromKind, value: sourceValue }
          : null,
        targetControl: ledger.toKind
          ? { id: control.id, kind: ledger.toKind, value: 0 }
          : null,
        edgeAction: control.action,
        componentId: control.componentId,
        resolution,
        aliasId: aliasById.get(control.id) ?? null,
        candidateOrigin: hasTarget ? "neutral" : "none",
        candidateProofSha256,
        componentProofSha256: proof.proofSha256,
        maximumScalarError: proof.errors.scalarMaximum,
        proofStatus: "not-preserved",
        reasonCode: "CLEAN_RESET",
        message: hasTarget
          ? "Reset this control to the target source's exact neutral value."
          : "Remove this source-only control as part of the confirmed clean reset.",
        requiresPreview: true,
        requiresConfirmation: true,
      };
    })
    .sort((left, right) => compareText(left.ledgerId, right.ledgerId));
}

function outcomeRejections(
  candidates: AppearanceRecipeCandidateGeneration,
  componentProofs: RecipeMigrationComponentProof[],
  siblings: SiblingPlanningResult,
  whole: RecipeMigrationWholeProof,
): RecipeMigrationRejectionCode[] {
  const result = new Set<RecipeMigrationRejectionCode>(siblings.rejectionCodes);
  for (const candidate of candidates.components) {
    if (candidate.status === "rejected") {
      for (const code of candidate.rejectionCodes) result.add(code);
    }
  }
  for (const proof of componentProofs) {
    if (proof.status === "failed") {
      result.add("COMPONENT_PROOF_FAILED");
      for (const code of proof.rejectionCodes) result.add(code);
    }
  }
  if (whole.status === "failed")
    result.add("WHOLE_RECIPE_MISMATCH_UNEXPLAINED");
  if (whole.status === "unavailable")
    result.add("WHOLE_RECIPE_PROOF_UNAVAILABLE");
  return sortedUniqueRejections(result);
}

async function buildMigrationPlan(
  input: AppearanceRecipeMigrationPlannerInput,
): Promise<BuiltMigrationContext> {
  if (
    !Number.isSafeInteger(input.fromRecipeRevision) ||
    input.fromRecipeRevision < 1
  ) {
    fail("fromRecipeRevision must be a positive safe integer");
  }
  const toRecipeRevision = plannedTargetRecipeRevision(input);
  const edge = await verifyRecipeUpdateEdge(input.edge);
  const sourceState = await verifyRecipeStateSnapshot(input.sourceState);
  const [sourcePrepared, targetPrepared] = await Promise.all([
    preparePackage(input.sourcePackage, edge.from, "source"),
    preparePackage(input.targetPackage, edge.to, "target", edge),
  ]);
  const sourceResolved = resolveStrictAppearanceRecipeSnapshot(
    sourcePrepared.manifest,
    sourceState.appearanceDials,
  );
  const sourceFull = evaluateAppearance(sourcePrepared, sourceResolved.state);
  const unionGraph = unionAppearanceRecipeDependencyGraphs(
    buildAppearanceRecipeDependencyGraph(sourcePrepared.manifest),
    buildAppearanceRecipeDependencyGraph(targetPrepared.manifest),
  );
  const components = componentModel(
    edge,
    unionGraph,
    sourcePrepared.manifest,
    targetPrepared.manifest,
  );
  const targetInventory = appearanceRecipeControlInventory(
    targetPrepared.manifest,
  );
  const candidates = await generateAppearanceRecipeComponentCandidates({
    edge,
    sourceState: sourceResolved.state,
    sourceControlRanges: appearanceRecipeControlInventory(
      sourcePrepared.manifest,
    ).ranges,
    targetControlRanges: targetInventory.ranges,
    componentMembership: components.candidateMembership,
    ...(input.componentMapBundle
      ? { componentMapBundle: input.componentMapBundle }
      : {}),
  });
  const componentProofs = await buildComponentProofs(
    candidates,
    edge,
    sourcePrepared,
    targetPrepared,
    sourceResolved.state,
  );
  const siblings = await buildSiblingPlan(
    edge,
    sourceState,
    input.siblingInputs,
    input.siblingVerifiers,
    input.externalSiblingInputs,
  );

  const canBuildTarget =
    candidates.components.every(
      (component) => component.status !== "rejected",
    ) &&
    siblings.rejectionCodes.length === 0 &&
    siblings.rows.every((row) => row.resolution !== "blocked");
  let proposedState: RecipeStateSnapshot | null = null;
  let wholeRecipeProof: RecipeMigrationWholeProof;
  if (canBuildTarget) {
    const targetAppearance = targetAppearanceFromCandidates(
      targetPrepared.manifest,
      candidates,
    );
    proposedState = await createStateSnapshot(
      targetAppearance,
      siblings.proposedStates,
    );
    wholeRecipeProof = await wholeProof(
      edge,
      sourceFull,
      evaluateAppearance(targetPrepared, targetAppearance),
      sourcePrepared,
      targetPrepared,
      componentProofs,
      siblings.rows,
      siblings.externalStateChanged,
    );
  } else {
    wholeRecipeProof = await failedWholeProof(sourceFull, sourcePrepared);
  }

  const rejectionCodes = outcomeRejections(
    candidates,
    componentProofs,
    siblings,
    wholeRecipeProof,
  );
  const unsupported = rejectionCodes.length > 0;
  if (unsupported) proposedState = null;
  let cleanResetEligibility: "eligible" | "ineligible" = "ineligible";
  if (unsupported) {
    try {
      await buildCleanResetEvidence({
        edge,
        sourceState,
        sourcePrepared,
        targetPrepared,
        sourceAppearance: sourceResolved.state,
        sourceFull,
        components,
        siblingInputs: input.siblingInputs,
        siblingVerifiers: input.siblingVerifiers,
        externalSiblingInputs: input.externalSiblingInputs,
      });
      cleanResetEligibility = "eligible";
    } catch {
      cleanResetEligibility = "ineligible";
    }
  }
  const planRows = controlRows(edge, candidates, componentProofs, unsupported);
  const siblingRows = siblings.rows.map((row) => ({
    ...row,
    proposedState: unsupported ? null : row.proposedState,
  }));
  const hasPreview =
    edge.warnings.length > 0 ||
    planRows.some((row) => row.requiresPreview || row.requiresConfirmation) ||
    siblingRows.some(
      (row) => row.requiresPreview || row.requiresConfirmation,
    ) ||
    componentProofs.some((proof) => proof.status !== "verified") ||
    wholeRecipeProof.status === "expected-mismatch";
  const externalPreviewRequired = siblings.externalStateChanged;
  const hasPreviewWithExternal = hasPreview || externalPreviewRequired;
  const appearancePreserved =
    !unsupported && wholeRecipeProof.permitsAppearancePreservedClaim;

  const plan = await createRecipeMigrationPlan({
    contract: "recipe-migration-plan/v1",
    schemaVersion: 1,
    planId: input.planId,
    directEdgeKey: edge.directEdgeKey,
    edgeSha256: edge.edgeSha256,
    fromSource: sourcePrepared.source,
    toSource: targetPrepared.source,
    fromRecipeRevision: input.fromRecipeRevision,
    toRecipeRevision,
    fromStateSha256: sourceState.stateSha256,
    toleranceProfile: RECIPE_STRICT_TOLERANCE_PROFILE,
    componentMapBundleSha256: candidates.componentMapBundleSha256,
    outcome: unsupported
      ? {
          kind: "unsupported",
          readiness: "blocked",
          preservationClaim: "none",
          rejectionCodes,
          cleanResetEligibility,
          basedOnUnsupportedPlanSha256: null,
        }
      : {
          kind: "automatic",
          readiness: hasPreviewWithExternal ? "preview-required" : "ready",
          preservationClaim: appearancePreserved
            ? "appearance-preserved"
            : "values-migrated-only",
          rejectionCodes: [],
          cleanResetEligibility: "not-applicable",
          basedOnUnsupportedPlanSha256: null,
        },
    controlRows: planRows,
    siblingRows,
    componentProofs,
    wholeRecipeProof,
    warnings: [...edge.warnings].sort((left, right) =>
      compareText(left.code, right.code),
    ),
    proposedState,
  });
  const verifier = {
    edge,
    fromSource: sourcePrepared.source,
    toSource: targetPrepared.source,
    sourceState,
    sourceControlRanges: appearanceRecipeControlInventory(
      sourcePrepared.manifest,
    ).ranges,
    targetControlRanges: targetInventory.ranges,
    componentMembership: components.verifierMembership,
    siblingBindings: siblings.bindings,
    externalSiblingBindings: siblings.externalBindings,
    ...(input.componentMapBundle
      ? { componentMapBundle: input.componentMapBundle }
      : {}),
  };
  return {
    plan: await verifyRecipeMigrationPlan(plan, verifier),
    verifier,
    edge,
    sourceState,
    sourcePrepared,
    targetPrepared,
    sourceAppearance: sourceResolved.state,
    sourceFull,
    components,
    targetInventory,
    siblingBindings: siblings.bindings,
    externalSiblingBindings: siblings.externalBindings,
  };
}

/** Produce the authoritative automatic-or-unsupported R2 plan for one exact state. */
export async function planAppearanceRecipeMigration(
  input: AppearanceRecipeMigrationPlannerInput,
): Promise<RecipeMigrationPlan> {
  return (await buildMigrationPlan(input)).plan;
}

/**
 * Build the separately requested destructive reset. It is never selected by
 * planAppearanceRecipeMigration and it can only cite the exact recomputed
 * eligible unsupported plan for the same source state and direct edge.
 */
export async function planAppearanceRecipeCleanReset(
  input: AppearanceRecipeCleanResetPlannerInput,
): Promise<RecipeMigrationPlan> {
  const migration = await buildMigrationPlan(input.migrationInput);
  if (!sameJson(input.eligibleUnsupportedPlan, migration.plan)) {
    fail(
      "clean reset cites an unsupported plan that is not the deterministic planner result",
    );
  }
  const eligibleUnsupportedPlan = await verifyRecipeMigrationPlan(
    input.eligibleUnsupportedPlan,
    migration.verifier,
  );
  if (
    eligibleUnsupportedPlan.outcome.kind !== "unsupported" ||
    eligibleUnsupportedPlan.outcome.cleanResetEligibility !== "eligible"
  ) {
    fail("clean reset requires an eligible unsupported plan");
  }
  const evidence = await buildCleanResetEvidence({
    edge: migration.edge,
    sourceState: migration.sourceState,
    sourcePrepared: migration.sourcePrepared,
    targetPrepared: migration.targetPrepared,
    sourceAppearance: migration.sourceAppearance,
    sourceFull: migration.sourceFull,
    components: migration.components,
    siblingInputs: input.migrationInput.siblingInputs,
    siblingVerifiers: input.migrationInput.siblingVerifiers,
    externalSiblingInputs: input.migrationInput.externalSiblingInputs,
  });
  const plan = await createRecipeMigrationPlan({
    contract: "recipe-migration-plan/v1",
    schemaVersion: 1,
    planId: input.planId,
    directEdgeKey: migration.edge.directEdgeKey,
    edgeSha256: migration.edge.edgeSha256,
    fromSource: migration.sourcePrepared.source,
    toSource: migration.targetPrepared.source,
    fromRecipeRevision: input.migrationInput.fromRecipeRevision,
    toRecipeRevision: plannedTargetRecipeRevision(input.migrationInput),
    fromStateSha256: migration.sourceState.stateSha256,
    toleranceProfile: RECIPE_STRICT_TOLERANCE_PROFILE,
    componentMapBundleSha256: eligibleUnsupportedPlan.componentMapBundleSha256,
    outcome: {
      kind: "clean-reset",
      readiness: "preview-required",
      preservationClaim: "none",
      rejectionCodes: [],
      cleanResetEligibility: "not-applicable",
      basedOnUnsupportedPlanSha256: eligibleUnsupportedPlan.planSha256,
    },
    controlRows: evidence.controlRows,
    siblingRows: evidence.siblingRows,
    componentProofs: evidence.componentProofs,
    wholeRecipeProof: evidence.wholeRecipeProof,
    warnings: [...migration.edge.warnings].sort((left, right) =>
      compareText(left.code, right.code),
    ),
    proposedState: evidence.proposedState,
  });
  return verifyRecipeMigrationPlan(plan, {
    ...migration.verifier,
    eligibleUnsupportedPlan,
  });
}

/**
 * Recompute every package, candidate, component, sibling, material, and whole
 * proof. An outer plan rehash cannot make forged nested evidence pass.
 */
export async function verifyPlannedAppearanceRecipeMigration(
  value: unknown,
  input: AppearanceRecipeMigrationPlannerInput,
): Promise<RecipeMigrationPlan> {
  const expected = await buildMigrationPlan(input);
  if (!sameJson(value, expected.plan)) {
    fail("supplied migration plan does not match deterministic recomputation");
  }
  return verifyRecipeMigrationPlan(value, expected.verifier);
}

/** Recompute the complete explicit clean-reset plan and all nested evidence. */
export async function verifyPlannedAppearanceRecipeCleanReset(
  value: unknown,
  input: AppearanceRecipeCleanResetPlannerInput,
): Promise<RecipeMigrationPlan> {
  const expected = await planAppearanceRecipeCleanReset(input);
  if (!sameJson(value, expected)) {
    fail(
      "supplied clean-reset plan does not match deterministic recomputation",
    );
  }
  const migration = await buildMigrationPlan(input.migrationInput);
  return verifyRecipeMigrationPlan(value, {
    ...migration.verifier,
    eligibleUnsupportedPlan: input.eligibleUnsupportedPlan,
  });
}
