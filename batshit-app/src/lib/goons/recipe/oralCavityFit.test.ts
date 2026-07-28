import { describe, expect, it } from "vitest";
import type { AppearanceDialsManifest } from "../appearanceDials.contracts";
import {
  assertAnatomyFitFollowerCompatibility,
  createAnatomyFitInput,
  requireReusableAnatomyFitResult,
} from "./anatomyFitContracts";

import {
  createOralCavityFitInput,
  createOralCavityFitDefinition,
  createOralCavityFitProof,
  parseOralCavityFitDefinition,
  solveOralCavityFit,
  type OralCavityFitAssembly,
  type OralCavityFitDefinitionV1,
  type OralCavityFitPoint,
  verifyOralCavityFitProof,
} from "./oralCavityFit";
import { canonicalRecipeSha256 } from "./recipeCanonical";

const sha = (character: string) => character.repeat(64);

const LOWER_NEUTRAL: OralCavityFitPoint[] = [
  [-1, -2, -1],
  [1, 0, 1],
  [-1, 0, -1],
  [1, -2, 1],
];
const UPPER_NEUTRAL: OralCavityFitPoint[] = [
  [-2, 0, 2],
  [2, 2, 4],
  [-2, 2, 2],
  [2, 0, 4],
];
const TONGUE_NEUTRAL: OralCavityFitPoint[] = LOWER_NEUTRAL.map((point) => [
  point[0],
  point[1],
  point[2] + 0.5,
]);

function assembly(
  role: OralCavityFitAssembly["role"],
): OralCavityFitAssembly {
  const landmarkSetId = role === "tongue"
    ? "tongue"
    : role.startsWith("upper")
      ? "upper"
      : "lower";
  return {
    role,
    landmarkSetId,
    nodeId: role,
    scaleChannels: (["x", "y", "z"] as const).map((axis) => ({
      axis,
      followerId: `anatomy-fit.oral-cavity.${role}`,
      channelId: `oral-cavity:${role}:scale-${axis}`,
      morph: `bs_anatomy_oral__${role.replaceAll("-", "_")}__scale_${axis}`,
      deltaPerWeight: 1,
      lower: -0.3,
      upper: 0.35,
    })),
  };
}

async function definition(): Promise<OralCavityFitDefinitionV1> {
  return createOralCavityFitDefinition({
    bodyMeshId: "mesh:body:0",
    bodyNodeId: "node:body",
    bodyTopologySha256: sha("a"),
    relevantInputIds: ["mouth_width", "face_width"],
    scaleRange: [0.7, 1.35],
    maximumTranslationMeters: 0.05,
    landmarkSets: [
      {
        id: "upper",
        bindings: UPPER_NEUTRAL.map((_, index) => ({
          id: `upper:${index}`,
          kind: "vertex" as const,
          vertexIndex: index + LOWER_NEUTRAL.length + TONGUE_NEUTRAL.length,
        })),
        neutralCenterRoot: [0, 1, 3],
        neutralHalfExtentsRoot: [2, 1, 1],
      },
      {
        id: "lower",
        bindings: LOWER_NEUTRAL.map((_, index) => ({
          id: `lower:${index}`,
          kind: "vertex" as const,
          vertexIndex: index,
        })),
        neutralCenterRoot: [0, -1, 0],
        neutralHalfExtentsRoot: [1, 1, 1],
      },
      {
        id: "tongue",
        bindings: TONGUE_NEUTRAL.map((_, index) => ({
          id: `tongue:${index}`,
          kind: "vertex" as const,
          vertexIndex: index + LOWER_NEUTRAL.length,
        })),
        neutralCenterRoot: [0, -1, 0.5],
        neutralHalfExtentsRoot: [1, 1, 1],
      },
    ],
    assemblies: [
      assembly("upper-teeth"),
      assembly("lower-teeth"),
      assembly("tongue"),
      assembly("upper-gums"),
      assembly("lower-gums"),
    ],
  });
}

function transformed(
  points: readonly OralCavityFitPoint[],
  center: OralCavityFitPoint,
  scale: OralCavityFitPoint,
  translation: OralCavityFitPoint,
): OralCavityFitPoint[] {
  return points.map((point) => [
    center[0] + (point[0] - center[0]) * scale[0] + translation[0],
    center[1] + (point[1] - center[1]) * scale[1] + translation[1],
    center[2] + (point[2] - center[2]) * scale[2] + translation[2],
  ]);
}

function positions(rows: readonly OralCavityFitPoint[]): Float32Array {
  return new Float32Array(rows.flat());
}

function appearanceManifest(
  fitDefinition: OralCavityFitDefinitionV1,
): AppearanceDialsManifest {
  return {
    contract: "appearance-dials/v2",
    definitionSha256: sha("b"),
    nodes: Object.fromEntries(
      fitDefinition.assemblies.map((entry) => [entry.nodeId, { node: entry.nodeId }]),
    ),
    followers: Object.fromEntries(
      fitDefinition.assemblies.map((entry) => [
        `anatomy-fit.oral-cavity.${entry.role}`,
        {
          nodeIds: [entry.nodeId],
          drivers: [{
            driver: { kind: "dial", id: "oral_fit_internal" },
            channels: entry.scaleChannels.map((channel) => ({
              id: channel.channelId,
              kind: "morph-weight",
              node: entry.nodeId,
              morph: channel.morph,
              weightRange: [channel.lower, channel.upper],
            })),
          }],
        },
      ]),
    ),
  } as unknown as AppearanceDialsManifest;
}

describe("Oral Cavity Fit v1", () => {
  it("self-hashes and canonicalizes the complete five-assembly definition", async () => {
    const created = await definition();
    await expect(parseOralCavityFitDefinition(created)).resolves.toEqual(created);
    expect(created.landmarkSets.map((entry) => entry.id)).toEqual([
      "lower",
      "tongue",
      "upper",
    ]);
    expect(created.relevantInputIds).toEqual(["face_width", "mouth_width"]);
    expect(created.assemblies.map((entry) => entry.role)).toEqual([
      "lower-gums",
      "lower-teeth",
      "tongue",
      "upper-gums",
      "upper-teeth",
    ]);

    const tampered = structuredClone(created);
    tampered.maximumTranslationMeters = 0.04;
    await expect(parseOralCavityFitDefinition(tampered)).rejects.toThrow(
      "definitionSha256 does not match canonical content",
    );
  });

  it("derives deterministic upper/lower translation and rigid-island scale coefficients", async () => {
    const fitDefinition = await definition();
    const lowerTranslation: OralCavityFitPoint = [0.01, -0.005, 0.002];
    const tongueTranslation: OralCavityFitPoint = [0.002, 0.004, -0.003];
    const upperTranslation: OralCavityFitPoint = [-0.004, 0.003, -0.006];
    const lowerScale: OralCavityFitPoint = [0.8, 1.1, 1.2];
    const tongueScale: OralCavityFitPoint = [1.05, 0.95, 1.1];
    const upperScale: OralCavityFitPoint = [1.25, 0.9, 0.75];
    const bodyRootPositions = positions([
      ...transformed(LOWER_NEUTRAL, [0, -1, 0], lowerScale, lowerTranslation),
      ...transformed(
        TONGUE_NEUTRAL,
        [0, -1, 0.5],
        tongueScale,
        tongueTranslation,
      ),
      ...transformed(UPPER_NEUTRAL, [0, 1, 3], upperScale, upperTranslation),
    ]);
    const args = {
      definition: fitDefinition,
      bodyMeshId: "mesh:body:0",
      bodyNodeId: "node:body",
      bodyTopologySha256: sha("a"),
      bodyRootPositions,
      landmarkRootPositions: bodyRootPositions,
    };
    const first = await createOralCavityFitProof(args);
    const second = await createOralCavityFitProof(args);

    expect(second).toEqual(first);
    expect(first.contract).toBe("oral-cavity-fit-proof/v2");
    expect(first.bodyPositionsSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(first.landmarkPositionsSha256).toBe(first.bodyPositionsSha256);
    expect(first.bodyPositionsScalarCount).toBe(36);
    expect(first.landmarkPositionsScalarCount).toBe(36);
    expect(first.nodeTransforms).toHaveLength(5);
    for (const [nodeId, expected] of [
      ["lower-gums", lowerTranslation],
      ["tongue", tongueTranslation],
      ["upper-teeth", upperTranslation],
    ] as const) {
      const translation = first.nodeTransforms
        .find((entry) => entry.nodeId === nodeId)!
        .rootDeltaMatrix.slice(12, 15);
      translation.forEach((value, index) =>
        expect(value).toBeCloseTo(expected[index]!, 6),
      );
    }
    const tongueNodeTranslation = first.nodeTransforms.find(
      (entry) => entry.nodeId === "tongue",
    )!.rootDeltaMatrix.slice(12, 15);
    tongueNodeTranslation.forEach((value, index) =>
      expect(value).toBeCloseTo(tongueTranslation[index]!, 6),
    );
    expect(first.followerMorphCoefficients).toHaveLength(15);
    expect(
      first.followerMorphCoefficients.find(
        (entry) => entry.channelId === "oral-cavity:upper-teeth:scale-x",
      )?.weight,
    ).toBeCloseTo(0.25, 7);
    expect(
      first.followerMorphCoefficients.find(
        (entry) => entry.channelId === "oral-cavity:lower-gums:scale-x",
      )?.weight,
    ).toBeCloseTo(-0.2, 7);
    expect(first.scalarCount).toBe(36);
  });

  it("verifies the serialized proof against exact final geometry", async () => {
    const fitDefinition = await definition();
    const args = {
      definition: fitDefinition,
      bodyMeshId: "mesh:body:0",
      bodyNodeId: "node:body",
      bodyTopologySha256: sha("a"),
      bodyRootPositions: positions([
        ...LOWER_NEUTRAL,
        ...TONGUE_NEUTRAL,
        ...UPPER_NEUTRAL,
      ]),
      landmarkRootPositions: positions([
        ...LOWER_NEUTRAL,
        ...TONGUE_NEUTRAL,
        ...UPPER_NEUTRAL,
      ]),
    };
    const proof = await createOralCavityFitProof(args);
    await expect(verifyOralCavityFitProof(proof, args)).resolves.toEqual(proof);

    const tampered = structuredClone(proof);
    tampered.nodeTransforms[0]!.rootDeltaMatrix[12] += 0.001;
    const { proofSha256: _proofSha256, ...payload } = tampered;
    tampered.proofSha256 = await canonicalRecipeSha256(payload);
    await expect(
      verifyOralCavityFitProof(tampered, args),
    ).rejects.toMatchObject({ code: "stale-proof" });
  });

  it("emits one reusable Anatomy Fit result bound to exact followers", async () => {
    const fitDefinition = await definition();
    const bodyRootPositions = positions([
      ...transformed(LOWER_NEUTRAL, [0, -1, 0], [0.9, 1.05, 1.1], [0.01, 0, 0]),
      ...transformed(TONGUE_NEUTRAL, [0, -1, 0.5], [1.05, 1, 0.95], [0, 0.002, 0]),
      ...transformed(UPPER_NEUTRAL, [0, 1, 3], [1.1, 0.95, 0.9], [-0.005, 0, 0]),
    ]);
    const appearanceValues = {
      dental_arch_width: 0.25,
      face_width: 0.2,
      mouth_width: -0.1,
    };
    const source = {
      modelSha256: sha("c"),
      appearanceDefinitionSha256: sha("b"),
      topologySha256: sha("a"),
    };
    const input = await createOralCavityFitInput({
      source,
      definition: fitDefinition,
      bodyMeshId: "mesh:body:0",
      bodyNodeId: "node:body",
      bodyRootPositions,
      landmarkRootPositions: bodyRootPositions,
      appearanceValues,
    });
    const result = await solveOralCavityFit({
      input,
      source,
      definition: fitDefinition,
      bodyMeshId: "mesh:body:0",
      bodyNodeId: "node:body",
      bodyRootPositions,
      landmarkRootPositions: bodyRootPositions,
      appearanceValues,
    });

    await expect(requireReusableAnatomyFitResult(input, result)).resolves.toEqual(result);
    await expect(
      assertAnatomyFitFollowerCompatibility(
        input,
        result,
        appearanceManifest(fitDefinition),
      ),
    ).resolves.toEqual(result);
    expect(result.nodeTransforms).toHaveLength(5);
    expect(result.followerMorphCoefficients).toHaveLength(15);
    expect(result.convergence).toMatchObject({
      converged: true,
      iterations: 0,
      reason: "closed-form-fit",
    });
  });

  it("rejects changed model, definition, topology, geometry, or relevant Appearance inputs", async () => {
    const fitDefinition = await definition();
    const bodyRootPositions = positions([
      ...LOWER_NEUTRAL,
      ...TONGUE_NEUTRAL,
      ...UPPER_NEUTRAL,
    ]);
    const appearanceValues = {
      dental_arch_width: 0.25,
      face_width: 0.2,
      mouth_width: -0.1,
    };
    const source = {
      modelSha256: sha("c"),
      appearanceDefinitionSha256: sha("b"),
      topologySha256: sha("a"),
    };
    const input = await createOralCavityFitInput({
      source,
      definition: fitDefinition,
      bodyMeshId: "mesh:body:0",
      bodyNodeId: "node:body",
      bodyRootPositions,
      landmarkRootPositions: bodyRootPositions,
      appearanceValues,
    });
    const legacyInput = await createAnatomyFitInput({
      solverVersion: "oral-cavity-anatomy-fit/v1",
      domain: input.domain,
      source: input.source,
      relevantInputs: input.relevantInputs,
      parameters: input.parameters,
    });
    const changedPositions = bodyRootPositions.slice();
    changedPositions[0]! += 0.001;
    const changedLandmarks = bodyRootPositions.slice();
    changedLandmarks[0]! += 0.001;

    await expect(
      solveOralCavityFit({
        input,
        source,
        definition: fitDefinition,
        bodyMeshId: "mesh:body:0",
        bodyNodeId: "node:body",
        bodyRootPositions: changedPositions,
        landmarkRootPositions: bodyRootPositions,
        appearanceValues,
      }),
    ).rejects.toMatchObject({ code: "stale-input" });
    await expect(
      solveOralCavityFit({
        input: legacyInput,
        source,
        definition: fitDefinition,
        bodyMeshId: "mesh:body:0",
        bodyNodeId: "node:body",
        bodyRootPositions,
        landmarkRootPositions: bodyRootPositions,
        appearanceValues,
      }),
    ).rejects.toMatchObject({ code: "invalid-input" });
    await expect(
      solveOralCavityFit({
        input,
        source,
        definition: fitDefinition,
        bodyMeshId: "mesh:body:0",
        bodyNodeId: "node:body",
        bodyRootPositions,
        landmarkRootPositions: changedLandmarks,
        appearanceValues,
      }),
    ).rejects.toMatchObject({ code: "stale-input" });
    await expect(
      solveOralCavityFit({
        input,
        source,
        definition: fitDefinition,
        bodyMeshId: "mesh:body:0",
        bodyNodeId: "node:body",
        bodyRootPositions,
        landmarkRootPositions: bodyRootPositions,
        appearanceValues: { ...appearanceValues, mouth_width: 0.1 },
      }),
    ).rejects.toMatchObject({ code: "stale-input" });
    await expect(
      solveOralCavityFit({
        input,
        source,
        definition: fitDefinition,
        bodyMeshId: "mesh:body:0",
        bodyNodeId: "node:body",
        bodyRootPositions,
        landmarkRootPositions: bodyRootPositions,
        appearanceValues: { ...appearanceValues, dental_arch_width: -0.25 },
      }),
    ).resolves.toMatchObject({ status: "converged" });
    await expect(
      solveOralCavityFit({
        input,
        source: { ...source, modelSha256: sha("d") },
        definition: fitDefinition,
        bodyMeshId: "mesh:body:0",
        bodyNodeId: "node:body",
        bodyRootPositions,
        landmarkRootPositions: bodyRootPositions,
        appearanceValues,
      }),
    ).rejects.toMatchObject({ code: "stale-input" });
    await expect(
      solveOralCavityFit({
        input,
        source: { ...source, appearanceDefinitionSha256: sha("e") },
        definition: fitDefinition,
        bodyMeshId: "mesh:body:0",
        bodyNodeId: "node:body",
        bodyRootPositions,
        landmarkRootPositions: bodyRootPositions,
        appearanceValues,
      }),
    ).rejects.toMatchObject({ code: "stale-input" });
    await expect(
      solveOralCavityFit({
        input,
        source: { ...source, topologySha256: sha("f") },
        definition: fitDefinition,
        bodyMeshId: "mesh:body:0",
        bodyNodeId: "node:body",
        bodyRootPositions,
        landmarkRootPositions: bodyRootPositions,
        appearanceValues,
      }),
    ).rejects.toMatchObject({ code: "stale-input" });
  });

  it("fails loudly instead of clamping out-of-contract geometry", async () => {
    const fitDefinition = await definition();
    await expect(
      createOralCavityFitProof({
        definition: fitDefinition,
        bodyMeshId: "mesh:body:0",
        bodyNodeId: "node:body",
        bodyTopologySha256: sha("a"),
        bodyRootPositions: positions([...LOWER_NEUTRAL, ...UPPER_NEUTRAL]),
        landmarkRootPositions: positions([
          ...transformed(LOWER_NEUTRAL, [0, -1, 0], [1, 1, 1], [0.06, 0, 0]),
          ...TONGUE_NEUTRAL,
          ...UPPER_NEUTRAL,
        ]),
      }),
    ).rejects.toMatchObject({ code: "translation-out-of-range" });

    await expect(
      createOralCavityFitProof({
        definition: fitDefinition,
        bodyMeshId: "mesh:body:0",
        bodyNodeId: "node:body",
        bodyTopologySha256: sha("a"),
        bodyRootPositions: positions([...LOWER_NEUTRAL, ...UPPER_NEUTRAL]),
        landmarkRootPositions: positions([
          ...LOWER_NEUTRAL,
          ...TONGUE_NEUTRAL,
          ...transformed(UPPER_NEUTRAL, [0, 1, 3], [1.5, 1, 1], [0, 0, 0]),
        ]),
      }),
    ).rejects.toMatchObject({ code: "scale-out-of-range" });
  });

  it("rejects incomplete or non-rigid output contracts before authoring", async () => {
    const created = await definition();
    const { contract: _contract, definitionSha256: _definitionSha256, ...payload } = created;
    await expect(
      createOralCavityFitDefinition({
        ...payload,
        assemblies: created.assemblies.filter((entry) => entry.role !== "tongue"),
      }),
    ).rejects.toThrow("complete upper/lower teeth, gums, and tongue inventory");

    const narrowBounds = structuredClone(created);
    narrowBounds.assemblies[0]!.scaleChannels[0]!.lower = -0.1;
    const {
      contract: _narrowContract,
      definitionSha256: _narrowDefinitionSha256,
      ...narrowPayload
    } = narrowBounds;
    await expect(
      createOralCavityFitDefinition(narrowPayload),
    ).rejects.toThrow("channel bounds do not cover scaleRange");
  });
});
