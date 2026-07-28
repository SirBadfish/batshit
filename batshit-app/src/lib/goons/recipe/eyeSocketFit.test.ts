import { describe, expect, it } from "vitest";
import type { EyeSocketFitDefinition } from "./eyeSocketFit";
import {
  createEyeSocketFitInput,
  deriveEyeSocketFitAperture,
  parseEyeSocketFitDefinition,
  solveEyeSocketFit,
} from "./eyeSocketFit";

const sha = (character: string) => character.repeat(64);
const MORPH_KINDS = [
  "localized-inner",
  "localized-lower",
  "localized-outer",
  "localized-upper",
  "scale-back",
  "scale-horizontal",
  "scale-vertical",
] as const;

function morphOutputs(nodeId: string) {
  return MORPH_KINDS.map((kind) => ({
    kind,
    followerId: "anatomy-fit.eye.left",
    channelId: `${nodeId}.${kind}`,
    nodeId,
    morph: `bs_eye_fit__${kind.replaceAll("-", "_")}`,
    lower: kind.startsWith("localized-") ? 0 : -0.5,
    upper: kind.startsWith("localized-") ? 1 : 0.5,
  }));
}

function positions(shift: [number, number, number] = [0, 0, 0]) {
  const rows: Array<[number, number, number]> = [
    [-0.01, 0, 0],
    [0.01, 0, 0],
    [-0.008, 0, 0.005],
    [0, 0, 0.006],
    [0.008, 0, 0.005],
    [-0.008, 0, -0.005],
    [0, 0, -0.006],
    [0.008, 0, -0.005],
    [-0.005, -0.001, 0],
    [0, 0.001, 0],
    [0.005, 0, 0],
  ];
  return new Float32Array(
    rows.flatMap((row) => row.map((value, axis) => value + shift[axis]!)),
  );
}

function definition(
  overrides: Partial<EyeSocketFitDefinition> = {},
): EyeSocketFitDefinition {
  return {
    contract: "eye-socket-fit-definition/v1",
    side: "left",
    bodyMeshId: "body",
    bodyTopologySha256: sha("c"),
    relevantInputIds: ["eye_size", "head_projection"],
    landmarks: {
      innerCorner: { id: "left.inner", kind: "vertex", vertexIndex: 0 },
      outerCorner: { id: "left.outer", kind: "vertex", vertexIndex: 1 },
      upperMargin: [
        { id: "left.upper.0", kind: "vertex", vertexIndex: 2 },
        { id: "left.upper.1", kind: "vertex", vertexIndex: 3 },
        { id: "left.upper.2", kind: "vertex", vertexIndex: 4 },
      ],
      lowerMargin: [
        { id: "left.lower.0", kind: "vertex", vertexIndex: 5 },
        { id: "left.lower.1", kind: "vertex", vertexIndex: 6 },
        { id: "left.lower.2", kind: "vertex", vertexIndex: 7 },
      ],
      depthSamples: [
        { id: "left.depth.0", kind: "vertex", vertexIndex: 8 },
        { id: "left.depth.1", kind: "vertex", vertexIndex: 9 },
        { id: "left.depth.2", kind: "vertex", vertexIndex: 10 },
      ],
    },
    neutral: {
      apertureCenter: [0, 0, 0],
      frameRotation: [0, 0, 0, 1],
      apertureHalfWidth: 0.008,
      apertureHalfHeight: 0.006,
      depthHalfExtent: 0.001,
      eyeCenter: [0, 0.01025, 0],
      eyeRotation: [0, 0, 0, 1],
      pivotRotation: [0, 0, 0, 1],
      eyeRadii: [0.012, 0.01, 0.008],
      regionalCenter: [0, 0, 0],
      regionalReachMeters: {
        inner: 0.008,
        lower: 0.006,
        outer: 0.008,
        upper: 0.006,
      },
    },
    outputs: {
      pivotNodeId: "eye-left-pivot",
      layers: (["cornea", "iris", "pupil", "sclera"] as const).map((role) => {
        const nodeId = `eye-left-${role}`;
        return {
          role,
          nodeId,
          meshId: `${nodeId}-mesh`,
          morphOutputs: morphOutputs(nodeId),
        };
      }),
    },
    limits: {
      inwardAxisHint: [0, 1, 0],
      minimumClearanceMeters: 0.0002,
      maximumClearanceMeters: 0.006,
      targetClearanceMeters: 0.001,
      maximumLayerConformanceErrorMeters: 0.00005,
    },
    ...overrides,
  };
}

function physicalState() {
  const radii = [0.012, 0.01, 0.008] as const;
  const layerPositions = new Float32Array([
    -radii[0], 0, 0,
    radii[0], 0, 0,
    0, -radii[1], 0,
    0, radii[1], 0,
    0, 0, -radii[2],
    0, 0, radii[2],
  ]);
  const rootRelativeMatrix = [
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0.01025, 0, 1,
  ];
  return {
    pivot: {
      nodeId: "eye-left-pivot",
      parentRootRelativeMatrix: [
        1, 0, 0, 0,
        0, 1, 0, 0,
        0, 0, 1, 0,
        0, 0, 0, 1,
      ],
      rootRelativeMatrix,
    },
    layers: (["cornea", "iris", "pupil", "sclera"] as const).map((role) => ({
      nodeId: `eye-left-${role}`,
      meshId: `eye-left-${role}-mesh`,
      rootRelativeMatrix,
      positions: layerPositions.slice(),
    })),
  };
}

async function input(
  geometry: Float32Array,
  fitDefinition = definition(),
  values: Record<string, number> = { eye_size: 0, head_projection: 0, hair_tint: 0 },
) {
  return createEyeSocketFitInput({
    source: {
      modelSha256: sha("a"),
      appearanceDefinitionSha256: sha("b"),
      topologySha256: sha("c"),
    },
    positions: geometry,
    physicalState: physicalState(),
    definition: fitDefinition,
    appearanceValues: values,
  });
}

describe("Eye Socket Fit specialization", () => {
  it("preserves authored quaternion bytes across repeated definition parsing", () => {
    const authored = definition();
    authored.neutral.frameRotation = [
      -0.604305702465636,
      0.0578054843158836,
      0.12146421395314518,
      0.7853149614513052,
    ];
    authored.neutral.eyeRotation = [...authored.neutral.frameRotation];
    authored.limits.inwardAxisHint = [
      -0.25930552833724024,
      0.21826584683661068,
      -0.9408085156281494,
    ];
    const once = parseEyeSocketFitDefinition(authored);
    const twice = parseEyeSocketFitDefinition(once);

    expect(twice).toEqual(once);
    expect(twice.neutral.frameRotation).toEqual(
      authored.neutral.frameRotation,
    );
    expect(twice.limits.inwardAxisHint).toEqual(
      authored.limits.inwardAxisHint,
    );
  });

  it("derives a stable aperture frame and depth evidence from final composed landmarks", () => {
    const aperture = deriveEyeSocketFitAperture(positions(), definition());
    expect(aperture.side).toBe("left");
    expect(aperture.center).toEqual([0, 0, 0]);
    expect(aperture.horizontalAxis).toEqual([1, 0, 0]);
    expect(aperture.inwardAxis).toEqual([0, 1, 0]);
    expect(aperture.verticalAxis).toEqual([0, 0, 1]);
    expect(aperture.halfWidth).toBeCloseTo(0.008, 7);
    expect(aperture.halfHeight).toBeCloseTo(0.006, 7);
    expect(aperture.depthHalfExtent).toBeCloseTo(0.001, 7);
    expect(aperture.marginLandmarks.map((entry) => entry.id)).toEqual([
      "left.lower.0",
      "left.lower.1",
      "left.lower.2",
      "left.upper.0",
      "left.upper.1",
      "left.upper.2",
    ]);
  });

  it("content-addresses exact geometry, landmark definitions, and only relevant dials", async () => {
    const geometry = positions();
    const first = await input(geometry);
    const unrelated = await input(geometry, definition(), {
      eye_size: 0,
      head_projection: 0,
      hair_tint: 1,
    });
    const relevant = await input(geometry, definition(), {
      eye_size: 0.25,
      head_projection: 0,
      hair_tint: 0,
    });
    const shifted = await input(positions([0.001, 0, 0]));

    expect(unrelated.inputSha256).toBe(first.inputSha256);
    expect(relevant.inputSha256).not.toBe(first.inputSha256);
    expect(shifted.inputSha256).not.toBe(first.inputSha256);
    expect(first.source.landmarkSampleCount).toBe(11);
    expect(first.relevantInputs.map((entry) => entry.id)).toEqual([
      "eye_size",
      "head_projection",
    ]);
  });

  it("solves the final combined aperture into deterministic complete-eye follower transforms", async () => {
    const geometry = positions([0.002, 0, 0.001]);
    const fitInput = await input(geometry);
    const first = await solveEyeSocketFit({
      input: fitInput,
      positions: geometry,
      physicalState: physicalState(),
      definition: definition(),
    });
    const second = await solveEyeSocketFit({
      input: fitInput,
      positions: geometry,
      physicalState: physicalState(),
      definition: definition(),
    });

    expect(first).toEqual(second);
    expect(first.status).toBe("converged");
    expect(first.domain).toBe("eye-socket:left");
    expect(first.nodeTransforms.map((entry) => entry.nodeId)).toEqual([
      "eye-left-pivot",
    ]);
    for (const transform of first.nodeTransforms) {
      expect(transform.rootDeltaMatrix[12]).toBeCloseTo(0.002, 6);
      expect(transform.rootDeltaMatrix[14]).toBeCloseTo(0.001, 6);
    }
    expect(first.followerMorphCoefficients).toHaveLength(28);
    expect(
      first.followerMorphCoefficients.every(
        (entry) =>
          Number.isFinite(entry.weight) &&
          entry.weight >= entry.lower &&
          entry.weight <= entry.upper,
      ),
    ).toBe(true);
    const irisScales = first.followerMorphCoefficients.filter(
      (entry) =>
        entry.nodeId === "eye-left-iris" &&
        (entry.channelId.endsWith("scale-horizontal") ||
          entry.channelId.endsWith("scale-vertical")),
    );
    expect(irisScales[0]?.weight).toBeCloseTo(irisScales[1]?.weight ?? NaN, 9);
    expect(first.metrics.every((entry) => entry.passed)).toBe(true);
  });

  it("rejects stale geometry before solving and emits no reusable output for impossible clearance", async () => {
    const geometry = positions();
    const fitInput = await input(geometry);
    await expect(
      solveEyeSocketFit({
        input: fitInput,
        positions: positions([0.001, 0, 0]),
        physicalState: physicalState(),
        definition: definition(),
      }),
    ).rejects.toThrow("final composed POSITION data changed");

    const impossibleDefinition = definition({
      limits: {
        inwardAxisHint: [0, 1, 0],
        minimumClearanceMeters: 0.02,
        maximumClearanceMeters: 0.021,
        targetClearanceMeters: 0.0205,
        maximumLayerConformanceErrorMeters: 0.00005,
      },
    });
    const impossibleInput = await input(geometry, impossibleDefinition);
    const failed = await solveEyeSocketFit({
      input: impossibleInput,
      positions: geometry,
      physicalState: physicalState(),
      definition: impossibleDefinition,
    });
    expect(failed.status).toBe("failed");
    expect(failed.nodeTransforms).toEqual([]);
    expect(failed.followerMorphCoefficients).toEqual([]);
    expect(failed.diagnostics[0]?.code).toMatch(/^constraint-unsatisfied:/);
  });

  it("fails loudly on duplicate or degenerate landmark definitions", () => {
    const duplicate = definition();
    duplicate.landmarks.outerCorner = {
      ...duplicate.landmarks.outerCorner,
      id: duplicate.landmarks.innerCorner.id,
    };
    expect(() => deriveEyeSocketFitAperture(positions(), duplicate)).toThrow(
      "landmark ids must be unique",
    );

    const degenerate = positions();
    degenerate.set(degenerate.slice(0, 3), 3);
    expect(() => deriveEyeSocketFitAperture(degenerate, definition())).toThrow(
      "inner-to-outer eye axis is degenerate",
    );
  });
});
