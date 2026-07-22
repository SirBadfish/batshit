import type { AppearanceDialValueState } from "../appearanceDials.contracts";
import { parseAppearanceDialsManifest } from "../appearanceDials.schema";
import type { GoonCustomAvatarManifest } from "../customAvatar";
import {
  parseEyeApertureSeamDefinition,
  validateSocketEyeApertureOwnership,
  type EyeApertureSeamDefinitionV1,
} from "../eyeApertureSeam";
import {
  parseSocketEyeSurfaceDefinition,
  type SocketEyeSurfaceDefinitionV1,
} from "../socketEyeSurface";
import {
  SOCKET_EYE_ANATOMY_FIT_SOLVER,
  anatomyFitRecipeSibling,
  assertAnatomyFitFollowerCompatibility,
  createAnatomyFitInput,
  createAnatomyFitResult,
  createAnatomyFitState,
  getAnatomyFitRecipeSibling,
  parseAnatomyFitState,
  replaceAnatomyFitRecipeSibling,
  requireReusableAnatomyFitResult,
  selectRelevantAnatomyFitInputs,
  withoutAnatomyFitRecipeSibling,
  type AnatomyFitState,
  type AnatomyFitStateEntry,
} from "./anatomyFitContracts";
import {
  parseAnatomyFitManifestDefinition,
  requireAnatomyFitStateDefinition,
  type AnatomyFitManifestDefinition,
  type SocketEyeAnatomyFitDomain,
} from "./anatomyFitManifest";
import { buildAppearanceRecipePhysicalBasisFromGlb } from "./appearanceRecipePhysicalModel";
import {
  evaluateAppearanceRecipePhysicalOutput,
  type AppearanceRecipePhysicalBasis,
  type AppearanceRecipePhysicalEvaluation,
} from "./appearanceRecipePhysicalEvaluator";
import type { RecipeSourceIdentity } from "./packageMetadata";
import { canonicalRecipeSha256, sha256Hex } from "./recipeCanonical";
import {
  recipeSiblingStateSha256,
  type RecipeSiblingStateRecord,
  type RecipeStateSnapshot,
} from "./recipeContracts";
import { resolveStrictAppearanceRecipeSnapshot } from "./strictAppearanceRecipeResolver";
import { createSocketEyeAnatomyProof } from "./socketEyeSurfaceFit";

export type AnatomyFitAuthoringEvaluationInput = {
  definition: AnatomyFitManifestDefinition;
  socketEyeSurface: SocketEyeSurfaceDefinitionV1;
  eyeApertureSeam: EyeApertureSeamDefinitionV1;
  modelBytes: Uint8Array;
  source: RecipeSourceIdentity;
  appearanceManifest: NonNullable<ReturnType<typeof parseAppearanceDialsManifest>>;
  appearanceDials: AppearanceDialValueState;
  basis: AppearanceRecipePhysicalBasis;
  evaluation: AppearanceRecipePhysicalEvaluation;
  previousState?: AnatomyFitState | null;
};

export type AnatomyFitAuthoringInput = {
  manifest: GoonCustomAvatarManifest;
  modelBytes: Uint8Array;
  source: RecipeSourceIdentity;
  appearanceDials: AppearanceDialValueState;
  previousSibling?: RecipeSiblingStateRecord | null;
};

function fail(message: string): never {
  throw new Error(`[anatomy-fit-authoring/v2] ${message}`);
}

function uint8View(value: Float32Array): Uint8Array {
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

function validateDomainBindings(
  domain: SocketEyeAnatomyFitDomain,
  socketEye: SocketEyeSurfaceDefinitionV1,
  seam: EyeApertureSeamDefinitionV1,
) {
  const surfaceSide = socketEye.runtimeBindings[domain.side];
  const seamSide = seam.runtimeBindings[domain.side];
  if (domain.socketEyeSurfaceDefinitionSha256 !== socketEye.definitionSha256) {
    fail(`domain socket-eye:${domain.side} references another socket-eye definition`);
  }
  if (domain.apertureSeamDefinitionSha256 !== seam.definitionSha256) {
    fail(`domain socket-eye:${domain.side} references another aperture-seam definition`);
  }
  if (domain.compositeCapNodeId !== surfaceSide.nodes.compositeCap) {
    fail(`domain socket-eye:${domain.side} references another composite-cap node`);
  }
  if (domain.lashesEyeOutlineNodeId !== seamSide.lashesEyeOutlineNode) {
    fail(`domain socket-eye:${domain.side} references another lashes/outline node`);
  }
  return { surfaceSide, seamSide };
}

/** Verify every package-authored cap/liner surface against final identity geometry. */
export async function computeAnatomyFitSiblingFromEvaluation(
  input: AnatomyFitAuthoringEvaluationInput,
): Promise<RecipeSiblingStateRecord> {
  validateSocketEyeApertureOwnership(input.socketEyeSurface, input.eyeApertureSeam);
  if (input.source.topologySha256 !== input.definition.domains[0]?.bodyTopologySha256) {
    fail("the Anatomy Fit definition does not match the verified Recipe Source topology");
  }
  const meshById = new Map(input.evaluation.meshes.map((entry) => [entry.id, entry]));
  const previousByDomain = new Map(
    (input.previousState?.fits ?? []).map((entry) => [entry.result.domain, entry]),
  );
  const relevantInputIds = Object.keys(input.appearanceDials.values).sort((left, right) =>
    left.localeCompare(right),
  );
  if (relevantInputIds.length === 0) {
    fail("socket-eye verification requires the complete resolved Appearance input inventory");
  }
  const fits: AnatomyFitStateEntry[] = [];

  for (const domain of input.definition.domains) {
    if (domain.bodyTopologySha256 !== input.source.topologySha256) {
      fail(`domain socket-eye:${domain.side} targets another Recipe Source topology`);
    }
    const body = meshById.get(domain.bodyMeshId);
    if (!body) fail(`domain socket-eye:${domain.side} body mesh ${domain.bodyMeshId} is missing`);
    const { surfaceSide, seamSide } = validateDomainBindings(
      domain,
      input.socketEyeSurface,
      input.eyeApertureSeam,
    );
    const proof = await createSocketEyeAnatomyProof({
      modelBytes: input.modelBytes,
      evaluation: input.evaluation,
      surfaceDefinitionSha256: input.socketEyeSurface.definitionSha256,
      seamDefinitionSha256: input.eyeApertureSeam.definitionSha256,
      surface: surfaceSide,
      seam: seamSide,
    });
    const landmarkSet = {
      domain,
      surface: input.socketEyeSurface.definitionSha256,
      seam: input.eyeApertureSeam.definitionSha256,
    };
    const landmarkSampleCount =
      seamSide.upperBoundary.sampleCount + seamSide.lowerBoundary.sampleCount + 2;
    const fitInput = await createAnatomyFitInput({
      solverVersion: SOCKET_EYE_ANATOMY_FIT_SOLVER,
      domain: `socket-eye:${domain.side}`,
      source: {
        modelSha256: input.source.modelSha256,
        appearanceDefinitionSha256: input.appearanceManifest.definitionSha256,
        topologySha256: input.source.topologySha256,
        positionsSha256: await sha256Hex(uint8View(body.positions)),
        positionsScalarCount: body.positions.length,
        physicalEvaluationSha256: proof.proofSha256,
        physicalEvaluationScalarCount: proof.scalarCount,
        landmarkSetSha256: await canonicalRecipeSha256(landmarkSet),
        landmarkSampleCount,
      },
      relevantInputs: selectRelevantAnatomyFitInputs(
        input.appearanceDials.values,
        relevantInputIds,
      ),
      parameters: [],
    });
    const previous = previousByDomain.get(fitInput.domain);
    const fitResult = previous?.input.inputSha256 === fitInput.inputSha256
      ? await requireReusableAnatomyFitResult(previous.input, previous.result)
      : await createAnatomyFitResult({
          solverVersion: SOCKET_EYE_ANATOMY_FIT_SOLVER,
          domain: fitInput.domain,
          inputSha256: fitInput.inputSha256,
          status: "converged",
          convergence: {
            converged: true,
            iterations: 0,
            objective: 0,
            tolerance: 0,
            reason: "geometry-and-followers-verified",
          },
          resolvedParameters: [],
          nodeTransforms: [],
          followerMorphCoefficients: [],
          metrics: [
            {
              id: "generated-position-scalars",
              value: proof.scalarCount,
              unit: "count",
              minimum: 1,
              maximum: null,
              passed: true,
            },
            {
              id: "verified-primitives",
              value: proof.primitives.length,
              unit: "count",
              minimum: 3,
              maximum: null,
              passed: true,
            },
          ],
          diagnostics: [],
        });
    fits.push({
      input: fitInput,
      result: await assertAnatomyFitFollowerCompatibility(
        fitInput,
        fitResult,
        input.appearanceManifest,
      ),
    });
  }

  return anatomyFitRecipeSibling(
    await createAnatomyFitState(input.definition.definitionSha256, fits),
  );
}

/** Build the final pre-fit identity geometry once, then verify both socket-eye sides. */
export async function computeAnatomyFitRecipeSibling(
  input: AnatomyFitAuthoringInput,
): Promise<RecipeSiblingStateRecord | null> {
  if (input.manifest.anatomyFit === undefined || input.manifest.anatomyFit === null) return null;
  if (input.manifest.socketEyeSurface === undefined || input.manifest.eyeApertureSeam === undefined) {
    fail("Anatomy Fit v2 requires socketEyeSurface and eyeApertureSeam definitions");
  }
  if ((await sha256Hex(input.modelBytes)) !== input.source.modelSha256) {
    fail("model bytes do not match the verified Recipe Source identity");
  }
  const [definition, socketEyeSurface, eyeApertureSeam] = await Promise.all([
    parseAnatomyFitManifestDefinition(input.manifest.anatomyFit),
    Promise.resolve(parseSocketEyeSurfaceDefinition(input.manifest.socketEyeSurface)),
    Promise.resolve(parseEyeApertureSeamDefinition(input.manifest.eyeApertureSeam)),
  ]);
  validateSocketEyeApertureOwnership(socketEyeSurface, eyeApertureSeam);
  let previousState: AnatomyFitState | null = null;
  if (input.previousSibling) {
    if (
      input.previousSibling.id !== "anatomy-fit" ||
      input.previousSibling.contract !== "anatomy-fit-state/v2"
    ) {
      fail("the previous Anatomy Fit sibling has an ambiguous identity");
    }
    if (
      input.previousSibling.stateSha256 !==
      (await recipeSiblingStateSha256(input.previousSibling.state))
    ) {
      fail("the previous Anatomy Fit sibling state hash is stale");
    }
    const parsedPrevious = await parseAnatomyFitState(input.previousSibling.state);
    if (input.previousSibling.definitionSha256 !== parsedPrevious.definitionSha256) {
      fail("the previous Anatomy Fit sibling definition hash is stale");
    }
    if (parsedPrevious.definitionSha256 === definition.definitionSha256) {
      previousState = requireAnatomyFitStateDefinition(definition, parsedPrevious);
    }
  }
  const appearanceManifest = parseAppearanceDialsManifest(input.manifest);
  if (!appearanceManifest) fail("the Recipe Source has no appearance-dials/v2 definition");
  const resolved = resolveStrictAppearanceRecipeSnapshot(
    appearanceManifest,
    input.appearanceDials,
  );
  const basis = buildAppearanceRecipePhysicalBasisFromGlb(input.modelBytes, input.manifest);
  const evaluation = evaluateAppearanceRecipePhysicalOutput(basis, resolved.resolved);
  return computeAnatomyFitSiblingFromEvaluation({
    definition,
    socketEyeSurface,
    eyeApertureSeam,
    modelBytes: input.modelBytes,
    source: input.source,
    appearanceManifest,
    appearanceDials: input.appearanceDials,
    basis,
    evaluation,
    previousState,
  });
}

export type ComputeAnatomyFitRecipeStateInput = Omit<
  AnatomyFitAuthoringInput,
  "appearanceDials" | "previousSibling"
> & {
  state: RecipeStateSnapshot;
  previousState?: RecipeStateSnapshot | null;
};

export async function computeAnatomyFitRecipeState(
  input: ComputeAnatomyFitRecipeStateInput,
): Promise<RecipeStateSnapshot> {
  const state = await withoutAnatomyFitRecipeSibling(input.state);
  const previousSibling = input.previousState
    ? await getAnatomyFitRecipeSibling(input.previousState)
    : null;
  const sibling = await computeAnatomyFitRecipeSibling({
    manifest: input.manifest,
    modelBytes: input.modelBytes,
    source: input.source,
    appearanceDials: structuredClone(state.appearanceDials),
    previousSibling,
  });
  return replaceAnatomyFitRecipeSibling(state, sibling?.state ?? null);
}
