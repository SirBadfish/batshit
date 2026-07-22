import { describe, expect, it } from "vitest";

import { createAnatomyFitInput } from "./anatomyFitContracts";
import {
  AnatomyFitSolverError,
  measureSignedAnatomyFitClearance,
  sampleAnatomyFitLandmarks,
  solveBoundedAnatomyFit,
} from "./anatomyFitSolver";

const sha = (character: string) => character.repeat(64);

async function input() {
  return createAnatomyFitInput({
    solverVersion: "anatomy-fit-test/bounded/v1",
    domain: "test-domain",
    source: {
      modelSha256: sha("a"),
      appearanceDefinitionSha256: sha("b"),
      topologySha256: sha("c"),
      positionsSha256: sha("d"),
      positionsScalarCount: 12,
      physicalEvaluationSha256: sha("e"),
      physicalEvaluationScalarCount: 32,
      landmarkSetSha256: sha("e"),
      landmarkSampleCount: 2,
    },
    relevantInputs: [{ id: "identity", value: 0.25 }],
    parameters: [
      {
        id: "necessary",
        lower: -1,
        upper: 1,
        neutral: 0,
        regularizationWeight: 0.01,
        initialStep: 0.5,
        minimumStep: 0.125,
      },
      {
        id: "unnecessary",
        lower: -1,
        upper: 1,
        neutral: 0,
        regularizationWeight: 1,
        initialStep: 0.5,
        minimumStep: 0.125,
      },
    ],
  });
}

describe("shared Anatomy Fit solver", () => {
  it("samples exact and barycentric landmarks deterministically from final composed geometry", () => {
    const positions = new Float32Array([
      0, 0, 0,
      2, 0, 0,
      0, 2, 0,
      0, 0, 3,
    ]);
    const sampled = sampleAnatomyFitLandmarks(positions, [
      { id: "tip", kind: "vertex", vertexIndex: 3 },
      {
        id: "center",
        kind: "triangle-barycentric",
        vertexIndices: [0, 1, 2],
        weights: [0.25, 0.25, 0.5],
      },
    ]);

    expect(sampled).toEqual([
      { id: "center", position: [0.5, 1, 0] },
      { id: "tip", position: [0, 0, 3] },
    ]);
    expect(() =>
      sampleAnatomyFitLandmarks(positions, [
        { id: "missing", kind: "vertex", vertexIndex: 9 },
      ]),
    ).toThrow("outside the composed mesh");
    expect(() =>
      sampleAnatomyFitLandmarks(positions, [
        {
          id: "bad-weights",
          kind: "triangle-barycentric",
          vertexIndices: [0, 1, 2],
          weights: [0.5, 0.5, 0.5],
        },
      ]),
    ).toThrow("must be non-negative and sum to one");
  });

  it("measures signed clearance with positive underlap and negative penetration", () => {
    expect(
      measureSignedAnatomyFitClearance([
        {
          id: "backed",
          surface: [0, 0, 0],
          internal: [0, 0, -0.002],
          inwardNormal: [0, 0, -2],
        },
        {
          id: "penetrating",
          surface: [0, 0, 0],
          internal: [0, 0, 0.001],
          inwardNormal: [0, 0, -1],
        },
      ]),
    ).toEqual([
      { id: "backed", meters: 0.002 },
      { id: "penetrating", meters: -0.001 },
    ]);
  });

  it("solves bounded parameters deterministically while regularizing unnecessary movement to neutral", async () => {
    const fitInput = await input();
    const evaluator = (parameters: Readonly<Record<string, number>>) => {
      const necessary = parameters.necessary!;
      return {
        objective: (necessary - 0.5) ** 2,
        nodeTransforms: [
          {
            nodeId: "fitted-node",
            rootDeltaMatrix: [
              1, 0, 0, 0,
              0, 1, 0, 0,
              0, 0, 1, 0,
              necessary, 0, 0, 1,
            ],
          },
        ],
        followerMorphCoefficients: [],
        metrics: [
          {
            id: "fit-error",
            value: Math.abs(necessary - 0.5),
            unit: "meters" as const,
            minimum: null,
            maximum: 0.125,
          },
        ],
      };
    };

    const first = await solveBoundedAnatomyFit(fitInput, evaluator);
    const second = await solveBoundedAnatomyFit(fitInput, evaluator);

    expect(first).toEqual(second);
    expect(first.status).toBe("converged");
    expect(first.resolvedParameters).toEqual([
      { id: "necessary", value: 0.5, lower: -1, upper: 1, neutral: 0 },
      { id: "unnecessary", value: 0, lower: -1, upper: 1, neutral: 0 },
    ]);
    expect(first.nodeTransforms[0]?.rootDeltaMatrix.slice(12, 15)).toEqual([
      0.5,
      0,
      0,
    ]);
    expect(first.metrics[0]?.passed).toBe(true);
  });

  it("accepts explicit bounded starts and rejects stale or out-of-range starts", async () => {
    const fitInput = await input();
    let firstNecessary: number | null = null;
    await solveBoundedAnatomyFit(
      fitInput,
      (parameters) => {
        firstNecessary ??= parameters.necessary!;
        return {
          objective: (parameters.necessary! - 0.75) ** 2,
          nodeTransforms: [],
          followerMorphCoefficients: [],
          metrics: [],
        };
      },
      { initialValues: { necessary: 0.75 } },
    );
    expect(firstNecessary).toBe(0.75);

    await expect(
      solveBoundedAnatomyFit(fitInput, async () => {
        throw new Error("must not evaluate");
      }, { initialValues: { stale: 0 } }),
    ).rejects.toThrow("unknown parameters: stale");
    await expect(
      solveBoundedAnatomyFit(fitInput, async () => {
        throw new Error("must not evaluate");
      }, { initialValues: { necessary: 2 } }),
    ).rejects.toThrow("must be finite and within [-1, 1]");
  });

  it("returns an explicit non-reusable diagnostic when bounded constraints cannot pass", async () => {
    const fitInput = await input();
    const failed = await solveBoundedAnatomyFit(fitInput, () => ({
      objective: 0,
      nodeTransforms: [],
      followerMorphCoefficients: [],
      metrics: [
        {
          id: "clearance",
          value: -0.001,
          unit: "meters",
          minimum: 0.00025,
          maximum: null,
        },
      ],
    }));

    expect(failed).toMatchObject({
      status: "failed",
      convergence: { converged: false, reason: "constraints-unsatisfied" },
      resolvedParameters: [],
      nodeTransforms: [],
      followerMorphCoefficients: [],
      diagnostics: [
        {
          code: "constraint-unsatisfied:clearance",
        },
      ],
    });
  });

  it("converts missing-landmark and iteration-limit failures into deterministic result records", async () => {
    const fitInput = await input();
    const missing = await solveBoundedAnatomyFit(fitInput, () => {
      throw new AnatomyFitSolverError(
        "missing-landmark",
        "The required lower-lid landmark is missing.",
      );
    });
    expect(missing).toMatchObject({
      status: "failed",
      convergence: { reason: "evaluation-error", iterations: 0 },
      diagnostics: [{ code: "missing-landmark" }],
    });

    const limited = await solveBoundedAnatomyFit(
      fitInput,
      (parameters) => ({
        objective: (parameters.necessary! - 1) ** 2,
        nodeTransforms: [],
        followerMorphCoefficients: [],
        metrics: [],
      }),
      { maxIterations: 1 },
    );
    expect(limited).toMatchObject({
      status: "failed",
      convergence: { reason: "iteration-limit", iterations: 1 },
      diagnostics: [{ code: "iteration-limit" }],
    });

    const invalidOutput = await solveBoundedAnatomyFit(fitInput, () => ({
      objective: 0,
      nodeTransforms: [
        {
          nodeId: "broken-node",
          rootDeltaMatrix: [
            0, 0, 0, 0,
            0, 1, 0, 0,
            0, 0, 1, 0,
            0, 0, 0, 1,
          ],
        },
      ],
      followerMorphCoefficients: [],
      metrics: [],
    }));
    expect(invalidOutput).toMatchObject({
      status: "failed",
      convergence: { reason: "invalid-output" },
      diagnostics: [{ code: "invalid-fit-output" }],
    });
  });
});
