import { describe, expect, it } from "vitest";
import type { AppearanceDialsManifest } from "../appearanceDials.contracts";
import {
  ORAL_CAVITY_ANATOMY_FIT_SOLVER,
  SOCKET_EYE_ANATOMY_FIT_SOLVER,
  anatomyFitRecipeSibling,
  assertAnatomyFitFollowerCompatibility,
  createAnatomyFitInput,
  createAnatomyFitResult,
  createAnatomyFitState,
  normalizeAnatomyFitPhysicalOutput,
  parseAnatomyFitInput,
  parseAnatomyFitResult,
  parseAnatomyFitState,
  requireReusableAnatomyFitResult,
  selectRelevantAnatomyFitInputs,
} from "./anatomyFitContracts";
import { canonicalRecipeString } from "./recipeCanonical";

const sha = (character: string) => character.repeat(64);
const DEFINITION_SHA = sha("b");

async function input(value = 0.9963701302315507, positionsSha256 = sha("d")) {
  return createAnatomyFitInput({
    solverVersion: SOCKET_EYE_ANATOMY_FIT_SOLVER,
    domain: "socket-eye:left",
    source: {
      modelSha256: sha("a"),
      appearanceDefinitionSha256: DEFINITION_SHA,
      topologySha256: sha("c"),
      positionsSha256,
      positionsScalarCount: 61_074,
      physicalEvaluationSha256: sha("e"),
      physicalEvaluationScalarCount: 9_720,
      landmarkSetSha256: sha("f"),
      landmarkSampleCount: 98,
    },
    relevantInputs: selectRelevantAnatomyFitInputs(
      { brow_height: 0.25, face_width: value },
      ["face_width", "brow_height"],
    ),
    parameters: [],
  });
}

async function result(inputSha256: string, countValue = 9_720) {
  return createAnatomyFitResult({
    solverVersion: SOCKET_EYE_ANATOMY_FIT_SOLVER,
    domain: "socket-eye:left",
    inputSha256,
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
    metrics: [{
      id: "generated-position-scalars",
      value: countValue,
      unit: "count",
      minimum: 1,
      maximum: null,
      passed: true,
    }],
    diagnostics: [],
  });
}

const appearance = {
  contract: "appearance-dials/v2",
  definitionSha256: DEFINITION_SHA,
  nodes: {},
  followers: {},
} as unknown as AppearanceDialsManifest;

describe("Anatomy Fit v2 content-addressed contracts", () => {
  it("round-trips deterministic socket-eye verification inputs and results", async () => {
    const first = await input();
    const second = await createAnatomyFitInput({
      solverVersion: first.solverVersion,
      domain: first.domain,
      source: first.source,
      relevantInputs: [...first.relevantInputs].reverse(),
      parameters: [],
    });
    const fitted = await result(first.inputSha256);

    expect(second).toEqual(first);
    await expect(parseAnatomyFitInput(first)).resolves.toEqual(first);
    await expect(parseAnatomyFitResult(fitted)).resolves.toEqual(fitted);
    await expect(requireReusableAnatomyFitResult(first, fitted)).resolves.toEqual(fitted);
    await expect(assertAnatomyFitFollowerCompatibility(first, fitted, appearance)).resolves.toEqual(fitted);
  });

  it("preserves RedisJSON-stable 15-digit numeric canonicalization", async () => {
    const browser = await input(0.9963701302315507);
    const redis = await input(0.9963701302315509);
    expect(redis).toEqual(browser);
    expect(canonicalRecipeString(redis)).toBe(canonicalRecipeString(browser));

    const browserResult = await result(browser.inputSha256, 9720.000000000004);
    const redisResult = await result(browser.inputSha256, 9720.000000000002);
    expect(redisResult).toEqual(browserResult);

    const physicalBrowser = normalizeAnatomyFitPhysicalOutput({
      nodeTransforms: [{
        nodeId: "lower-gums",
        rootDeltaMatrix: [
          1, 0, 0, 0,
          0, 1, 0, 0,
          0, 0, 1, 0,
          0.01234567890123456, 0, 0, 1,
        ],
      }],
      followerMorphCoefficients: [{
        followerId: "anatomy-fit.oral-cavity.lower-gums",
        channelId: "oral-cavity:lower-gums:scale-x",
        nodeId: "lower-gums",
        morph: "bs_anatomy_oral__lower_gums__scale_x",
        weight: 0.1234567890123456,
        lower: -0.3,
        upper: 0.35,
      }],
      metrics: [{
        id: "maximum-translation",
        value: 0.01234567890123456,
        unit: "meters",
        minimum: 0,
        maximum: 0.05,
        passed: true,
      }],
    });
    const physicalNode = normalizeAnatomyFitPhysicalOutput({
      nodeTransforms: [{
        ...physicalBrowser.nodeTransforms[0]!,
        rootDeltaMatrix: [
          1, 0, 0, 0,
          0, 1, 0, 0,
          0, 0, 1, 0,
          0.01234567890123458, 0, 0, 1,
        ],
      }],
      followerMorphCoefficients: [{
        ...physicalBrowser.followerMorphCoefficients[0]!,
        weight: 0.1234567890123458,
      }],
      metrics: [{
        ...physicalBrowser.metrics[0]!,
        value: 0.01234567890123458,
      }],
    });
    expect(physicalNode).toEqual(physicalBrowser);
  });

  it("rejects globe-era solvers and localized output instead of adapting it", async () => {
    const current = await input();
    const { contract: _inputContract, inputSha256: _inputSha256, ...inputPayload } = current;
    const legacyInput = await createAnatomyFitInput({
      ...inputPayload,
      solverVersion: "eye-socket-fit/neutral-relative/v3",
      domain: "eye-socket:left",
      parameters: [{
        id: "sclera-scale",
        lower: 0.8,
        upper: 1.2,
        neutral: 1,
        regularizationWeight: 1,
        initialStep: 0.1,
        minimumStep: 0.01,
      }],
    });

    const legacyResult = await createAnatomyFitResult({
      solverVersion: legacyInput.solverVersion,
      domain: legacyInput.domain,
      inputSha256: legacyInput.inputSha256,
      status: "converged",
      convergence: {
        converged: true,
        iterations: 1,
        objective: 0,
        tolerance: 0,
        reason: "old-fit",
      },
      resolvedParameters: [{
        id: "sclera-scale",
        value: 1,
        lower: 0.8,
        upper: 1.2,
        neutral: 1,
      }],
      nodeTransforms: [{
        nodeId: "old-sclera",
        rootDeltaMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      }],
      followerMorphCoefficients: [],
      metrics: [],
      diagnostics: [],
    });
    await expect(
      assertAnatomyFitFollowerCompatibility(legacyInput, legacyResult, appearance),
    ).rejects.toThrow("retained globe-era localized output");
  });

  it("accepts exact oral closed-form outputs bound to declared Recipe-only followers", async () => {
    const oralAppearance = {
      contract: "appearance-dials/v2",
      definitionSha256: DEFINITION_SHA,
      nodes: {
        "lower-gums": { node: "LowerGums" },
      },
      followers: {
        "anatomy-fit.oral-cavity.lower-gums": {
          nodeIds: ["lower-gums"],
          drivers: [{
            driver: { kind: "dial", id: "dental_arch_width" },
            channels: [{
              id: "oral-cavity:lower-gums:scale-x",
              kind: "morph-weight",
              node: "lower-gums",
              morph: "bs_anatomy_oral__lower_gums__scale_x",
              weightRange: [-0.3, 0.35],
            }],
          }],
        },
      },
    } as unknown as AppearanceDialsManifest;
    const fitInput = await createAnatomyFitInput({
      solverVersion: ORAL_CAVITY_ANATOMY_FIT_SOLVER,
      domain: "oral-cavity",
      source: {
        modelSha256: sha("a"),
        appearanceDefinitionSha256: DEFINITION_SHA,
        topologySha256: sha("c"),
        positionsSha256: sha("d"),
        positionsScalarCount: 24,
        physicalEvaluationSha256: sha("e"),
        physicalEvaluationScalarCount: 24,
        landmarkSetSha256: sha("f"),
        landmarkSampleCount: 8,
      },
      relevantInputs: [{ id: "face_width", value: 0.2 }],
      parameters: [],
    });
    const fitResult = await createAnatomyFitResult({
      solverVersion: ORAL_CAVITY_ANATOMY_FIT_SOLVER,
      domain: "oral-cavity",
      inputSha256: fitInput.inputSha256,
      status: "converged",
      convergence: {
        converged: true,
        iterations: 0,
        objective: 0,
        tolerance: 0,
        reason: "closed-form-fit",
      },
      resolvedParameters: [],
      nodeTransforms: [{
        nodeId: "lower-gums",
        rootDeltaMatrix: [
          1, 0, 0, 0,
          0, 1, 0, 0,
          0, 0, 1, 0,
          0.001, 0, 0, 1,
        ],
      }],
      followerMorphCoefficients: [{
        followerId: "anatomy-fit.oral-cavity.lower-gums",
        channelId: "oral-cavity:lower-gums:scale-x",
        nodeId: "lower-gums",
        morph: "bs_anatomy_oral__lower_gums__scale_x",
        weight: 0.1,
        lower: -0.3,
        upper: 0.35,
      }],
      metrics: [],
      diagnostics: [],
    });

    await expect(
      assertAnatomyFitFollowerCompatibility(
        fitInput,
        fitResult,
        oralAppearance,
      ),
    ).resolves.toEqual(fitResult);
  });

  it("invalidates changed final body or physical-eye/treatment proofs", async () => {
    const current = await input();
    const changedBody = await input(0.9963701302315507, sha("9"));
    expect(changedBody.inputSha256).not.toBe(current.inputSha256);

    const tampered = structuredClone(current);
    tampered.source.physicalEvaluationSha256 = sha("8");
    await expect(parseAnatomyFitInput(tampered)).rejects.toThrow(
      "inputSha256 does not match canonical content",
    );
  });

  it("stores the verified bilateral result in the stable anatomy-fit sibling", async () => {
    const leftInput = await input();
    const leftResult = await result(leftInput.inputSha256);
    const { contract: _leftContract, inputSha256: _leftSha256, ...leftPayload } = leftInput;
    const rightInput = await createAnatomyFitInput({
      ...leftPayload,
      domain: "socket-eye:right",
    });
    const rightCandidate = await result(rightInput.inputSha256);
    const { contract: _rightContract, resultSha256: _rightSha256, ...rightPayload } = rightCandidate;
    const rightResult = await createAnatomyFitResult({
      ...rightPayload,
      domain: "socket-eye:right",
    });
    const state = await createAnatomyFitState(DEFINITION_SHA, [
      { input: leftInput, result: leftResult },
      { input: rightInput, result: rightResult },
    ]);
    const sibling = await anatomyFitRecipeSibling(state);

    expect(sibling.id).toBe("anatomy-fit");
    expect(sibling.contract).toBe("anatomy-fit-state/v2");
    await expect(parseAnatomyFitState(sibling.state)).resolves.toEqual(state);
  });
});
