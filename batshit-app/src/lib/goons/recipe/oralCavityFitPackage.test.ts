import { describe, expect, it } from "vitest";

import {
  createOralCavityFitDefinition,
  type OralCavityFitAssembly,
  type OralCavityFitPoint,
} from "./oralCavityFit";
import {
  composeOralCavityLandmarkPositions,
  createOralCavityFitPackage,
  createOralCavityLandmarkBasis,
  parseOralCavityFitPackage,
} from "./oralCavityFitPackage";

const sha = (character: string) => character.repeat(64);
const LOWER: OralCavityFitPoint[] = [
  [-1, -1, -1],
  [-1, 1, 1],
  [1, -1, 1],
  [1, 1, -1],
];
const UPPER: OralCavityFitPoint[] = LOWER.map((entry) => [
  entry[0],
  entry[1] + 3,
  entry[2],
]);
const TONGUE: OralCavityFitPoint[] = LOWER.map((entry) => [
  entry[0],
  entry[1],
  entry[2] + 0.5,
]);

function assembly(role: OralCavityFitAssembly["role"]): OralCavityFitAssembly {
  return {
    role,
    landmarkSetId: role === "tongue"
      ? "tongue"
      : role.startsWith("upper")
        ? "upper"
        : "lower",
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

async function fixture() {
  const landmarkBasis = await createOralCavityLandmarkBasis({
    frames: [
      {
        id: "upper",
        neutralPositionsRoot: UPPER,
        targetDeltas: [{
          targetId: "identity.mouth_width",
          deltasRoot: UPPER.map((entry) => [entry[0] * 0.2, 0, 0]),
        }],
      },
      {
        id: "lower",
        neutralPositionsRoot: LOWER,
        targetDeltas: [
          {
            targetId: "identity.jaw_depth",
            deltasRoot: LOWER.map(() => [0, -0.1, 0]),
          },
          {
            targetId: "identity.mouth_width",
            deltasRoot: LOWER.map((entry) => [entry[0] * 0.2, 0, 0]),
          },
        ],
      },
      {
        id: "tongue",
        neutralPositionsRoot: TONGUE,
        targetDeltas: [{
          targetId: "identity.jaw_depth",
          deltasRoot: TONGUE.map(() => [0, -0.1, 0]),
        }],
      },
    ],
  });
  const definition = await createOralCavityFitDefinition({
    bodyMeshId: "mesh:body:0",
    bodyNodeId: "node:body",
    bodyTopologySha256: sha("a"),
    relevantInputIds: ["jaw_depth", "mouth_width"],
    scaleRange: [0.7, 1.35],
    maximumTranslationMeters: 0.05,
    landmarkSets: [
      {
        id: "lower",
        bindings: LOWER.map((_, index) => ({
          id: `lower:${index}`,
          kind: "vertex" as const,
          vertexIndex: index,
        })),
        neutralCenterRoot: [0, 0, 0],
        neutralHalfExtentsRoot: [1, 1, 1],
      },
      {
        id: "tongue",
        bindings: TONGUE.map((_, index) => ({
          id: `tongue:${index}`,
          kind: "vertex" as const,
          vertexIndex: LOWER.length + index,
        })),
        neutralCenterRoot: [0, 0, 0.5],
        neutralHalfExtentsRoot: [1, 1, 1],
      },
      {
        id: "upper",
        bindings: UPPER.map((_, index) => ({
          id: `upper:${index}`,
          kind: "vertex" as const,
          vertexIndex: LOWER.length + TONGUE.length + index,
        })),
        neutralCenterRoot: [0, 3, 0],
        neutralHalfExtentsRoot: [1, 1, 1],
      },
    ],
    assemblies: [
      assembly("upper-teeth"),
      assembly("upper-gums"),
      assembly("lower-teeth"),
      assembly("lower-gums"),
      assembly("tongue"),
    ],
  });
  return createOralCavityFitPackage({ definition, landmarkBasis });
}

describe("Oral Cavity Fit package", () => {
  it("self-hashes the definition and exact hidden-landmark basis", async () => {
    const created = await fixture();
    await expect(parseOralCavityFitPackage(created)).resolves.toEqual(created);
    expect(created.landmarkBasis.frames.map((entry) => entry.id)).toEqual([
      "lower",
      "tongue",
      "upper",
    ]);
    expect(created.landmarkBasis.targetIds).toEqual([
      "identity.jaw_depth",
      "identity.mouth_width",
    ]);

    const tampered = structuredClone(created);
    tampered.landmarkBasis.frames[0]!.neutralPositionsRoot[0]![0] += 0.01;
    await expect(parseOralCavityFitPackage(tampered)).rejects.toMatchObject({
      code: "stale-package",
    });
  });

  it("composes the packed landmark stream from exact target influences", async () => {
    const created = await fixture();
    const positions = composeOralCavityLandmarkPositions(
      created.landmarkBasis,
      {
        influences: new Map([
          ["identity.jaw_depth", 0.5],
          ["identity.mouth_width", 0.25],
        ]),
      },
    );
    const lower = [...positions.slice(0, 3)];
    const upperOffset = (LOWER.length + TONGUE.length) * 3;
    const upper = [...positions.slice(upperOffset, upperOffset + 3)];
    [-1.05, -1.05, -1].forEach((value, index) =>
      expect(lower[index]).toBeCloseTo(value, 6),
    );
    [-1.05, 2, -1].forEach((value, index) =>
      expect(upper[index]).toBeCloseTo(value, 6),
    );
  });

  it("fails closed when resolved Appearance omits a basis target", async () => {
    const created = await fixture();
    expect(() =>
      composeOralCavityLandmarkPositions(created.landmarkBasis, {
        influences: new Map([["identity.mouth_width", 0]]),
      }),
    ).toThrow("lacks landmark target identity.jaw_depth");
  });
});
