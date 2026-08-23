import { describe, expect, it, vi } from "vitest";
import type { AppearanceDialsManifest } from "../appearanceDials.contracts";
import type { EyeApertureSeamDefinitionV2 } from "../eyeApertureSeam";
import type { SocketEyeSurfaceDefinitionV2 } from "../socketEyeSurface";
import { parseAnatomyFitState } from "./anatomyFitContracts";
import { computeAnatomyFitSiblingFromEvaluation } from "./anatomyFitAuthoring";
import {
  ORAL_CAVITY_ANATOMY_DOMAIN_CONTRACT,
  SOCKET_EYE_ANATOMY_DOMAIN_CONTRACT,
  createAnatomyFitManifestDefinition,
} from "./anatomyFitManifest";
import type {
  AppearanceRecipePhysicalBasis,
  AppearanceRecipePhysicalEvaluation,
} from "./appearanceRecipePhysicalEvaluator";
import type { RecipeSourceIdentity } from "./packageMetadata";
import {
  createOralCavityFitDefinition,
  type OralCavityFitAssembly,
  type OralCavityFitPoint,
} from "./oralCavityFit";
import {
  createOralCavityFitPackage,
  createOralCavityLandmarkBasis,
} from "./oralCavityFitPackage";

vi.mock("./socketEyeSurfaceFit", () => ({
  createSocketEyeAnatomyProof: vi.fn(async ({ surface }: { surface: { side: string } }) => ({
    contract: "socket-eye-anatomy-proof/v2",
    domain: `socket-eye:${surface.side}`,
    socketEyeSurfaceDefinitionSha256: "d".repeat(64),
    apertureSeamDefinitionSha256: "e".repeat(64),
    primitives: [{}, {}, {}],
    geometrySha256: "4".repeat(64),
    followerInventorySha256: "5".repeat(64),
    scalarCount: 96,
    proofSha256: surface.side === "left" ? "6".repeat(64) : "7".repeat(64),
  })),
}));

const sha = (character: string) => character.repeat(64);
const matrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function source(): RecipeSourceIdentity {
  return {
    contract: "recipe-source/v1",
    schemaVersion: 1,
    baseId: "socket-eye-authoring-test",
    fitFamily: "socket-eye-authoring-test.v1",
    modelSha256: sha("a"),
    manifestSemanticSha256: sha("8"),
    definitionSha256: sha("b"),
    neutralId: "neutral",
    neutralRecipeSha256: sha("9"),
    physicalBasisSha256: sha("1"),
    behaviorSha256: sha("2"),
    componentGraphSha256: sha("3"),
    topologySha256: sha("c"),
    skeletonHierarchySha256: sha("4"),
  };
}

function surface(): SocketEyeSurfaceDefinitionV2 {
  const side = (name: "left" | "right") => ({
    side: name,
    nodes: { physicalEye: name === "left" ? "Eye_L" : "Eye_R" },
    apertureSeamDefinitionSha256: sha("e"),
    cap: {
      minimumHiddenUnderlapMeters: 0.001,
    },
  });
  return {
    definitionSha256: sha("d"),
    runtimeBindings: { left: side("left"), right: side("right") },
  } as unknown as SocketEyeSurfaceDefinitionV2;
}

function seam(): EyeApertureSeamDefinitionV2 {
  const side = (name: "left" | "right") => ({
    side: name,
    physicalEyeNode: name === "left" ? "Eye_L" : "Eye_R",
    lashesEyeOutlineNode: name === "left" ? "Liner_L" : "Liner_R",
    capUnderlapMeters: 0.001,
    upperBoundary: { sampleCount: 24, bindingSha256: sha("5") },
    lowerBoundary: { sampleCount: 24, bindingSha256: sha("6") },
  });
  return {
    definitionSha256: sha("e"),
    runtimeBindings: { left: side("left"), right: side("right") },
  } as unknown as EyeApertureSeamDefinitionV2;
}

async function definition() {
  const oralCavityFit = await oralPackage();
  return createAnatomyFitManifestDefinition([
    {
      contract: ORAL_CAVITY_ANATOMY_DOMAIN_CONTRACT,
      bodyMeshId: "body",
      bodyTopologySha256: sha("c"),
      oralCavityFitDefinitionSha256: oralCavityFit.definitionSha256,
    },
    ...(["left", "right"] as const).map((side) => ({
    contract: SOCKET_EYE_ANATOMY_DOMAIN_CONTRACT,
    side,
    bodyMeshId: "body",
    bodyTopologySha256: sha("c"),
    socketEyeSurfaceDefinitionSha256: sha("d"),
    apertureSeamDefinitionSha256: sha("e"),
    physicalEyeNodeId: side === "left" ? "Eye_L" : "Eye_R",
    lashesEyeOutlineNodeId: side === "left" ? "Liner_L" : "Liner_R",
    })),
  ]);
}

const ORAL_POINTS: OralCavityFitPoint[] = [
  [-1, -1, -1],
  [-1, 1, 1],
  [1, -1, 1],
  [1, 1, -1],
];
const ORAL_ROLES: OralCavityFitAssembly["role"][] = [
  "lower-gums",
  "lower-teeth",
  "tongue",
  "upper-gums",
  "upper-teeth",
];

function oralAssembly(role: OralCavityFitAssembly["role"]): OralCavityFitAssembly {
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
      followerId: "anatomy-fit.oral-cavity",
      channelId: `oral-cavity:${role}:scale-${axis}`,
      morph: `bs_anatomy_oral__${role.replaceAll("-", "_")}__scale_${axis}`,
      deltaPerWeight: 1,
      lower: -0.3,
      upper: 0.35,
    })),
  };
}

async function oralPackage() {
  const landmarkBasis = await createOralCavityLandmarkBasis({
    frames: (["lower", "tongue", "upper"] as const).map((id) => ({
      id,
      neutralPositionsRoot: ORAL_POINTS.map((point) => [
        point[0],
        point[1] + (id === "upper" ? 3 : 0),
        point[2] + (id === "tongue" ? 0.5 : 0),
      ]),
      targetDeltas: [{
        targetId: "identity.mouth_width",
        deltasRoot: ORAL_POINTS.map((point) => [point[0] * 0.1, 0, 0]),
      }],
    })),
  });
  const definition = await createOralCavityFitDefinition({
    bodyMeshId: "body",
    bodyNodeId: "body-node",
    bodyTopologySha256: sha("c"),
    relevantInputIds: ["mouth_width"],
    scaleRange: [0.7, 1.35],
    maximumTranslationMeters: 0.05,
    landmarkSets: (["lower", "tongue", "upper"] as const).map((id, frameIndex) => ({
      id,
      bindings: ORAL_POINTS.map((_, pointIndex) => ({
        id: `${id}:${pointIndex}`,
        kind: "vertex" as const,
        vertexIndex: frameIndex * ORAL_POINTS.length + pointIndex,
      })),
      neutralCenterRoot: [
        0,
        id === "upper" ? 3 : 0,
        id === "tongue" ? 0.5 : 0,
      ] as OralCavityFitPoint,
      neutralHalfExtentsRoot: [1, 1, 1] as OralCavityFitPoint,
    })),
    assemblies: ORAL_ROLES.map(oralAssembly),
  });
  return createOralCavityFitPackage({ definition, landmarkBasis });
}

const ORAL_ASSEMBLIES = ORAL_ROLES.map(oralAssembly);
const appearanceManifest = {
  contract: "appearance-dials/v2",
  definitionSha256: sha("b"),
  nodes: Object.fromEntries(ORAL_ROLES.map((role) => [role, { node: role }])),
  followers: {
    "anatomy-fit.oral-cavity": {
      nodeIds: [...ORAL_ROLES],
      drivers: [{
        driver: { kind: "anatomy-fit", id: "oral-cavity" },
        channels: ORAL_ASSEMBLIES.flatMap((assembly) =>
          assembly.scaleChannels.map((channel) => ({
            id: channel.channelId,
            kind: "morph-weight",
            node: assembly.nodeId,
            morph: channel.morph,
            weightRange: [channel.lower, channel.upper],
          })),
        ),
      }],
    },
  },
} as unknown as AppearanceDialsManifest;

const evaluation = {
  contract: "appearance-recipe-physical-evaluation/v1",
  meshes: [{ id: "body", nodeId: "body-node", positions: new Float32Array([0, 0, 0, 1, 1, 1]) }],
  nodes: [{ id: "body-node", localMatrix: matrix, rootRelativeMatrix: matrix, worldMatrix: matrix }],
} as unknown as AppearanceRecipePhysicalEvaluation;

describe("Anatomy Fit v2 authoring orchestration", () => {
  it("authors all domains when whole-package topology differs from the shared body topology", async () => {
    const oralCavityFit = await oralPackage();
    const input = {
      definition: await definition(),
      socketEyeSurface: surface(),
      eyeApertureSeam: seam(),
      oralCavityFit,
      modelBytes: new Uint8Array([1, 2, 3]),
      source: { ...source(), topologySha256: sha("d") },
      appearanceManifest,
      appearanceDials: {
        contract: "appearance-dial-values/v1" as const,
        definitionSha256: sha("b"),
        neutralId: "neutral",
        neutralRecipeSha256: sha("9"),
        values: { face_width: 0.3, eye_height: -0.1, mouth_width: 0 },
        unlockedDialIds: [],
      },
      basis: {} as AppearanceRecipePhysicalBasis,
      evaluation,
      resolved: {
        influences: new Map([["identity.mouth_width", 0]]),
      } as never,
    };
    const first = await computeAnatomyFitSiblingFromEvaluation(input);
    const state = await parseAnatomyFitState(first.state);
    const reused = await computeAnatomyFitSiblingFromEvaluation({
      ...input,
      previousState: state,
    });

    expect(reused).toEqual(first);
    expect(first.id).toBe("anatomy-fit");
    expect(state.fits.map((entry) => entry.result.domain)).toEqual([
      "oral-cavity",
      "socket-eye:left",
      "socket-eye:right",
    ]);
    for (const fit of state.fits) {
      expect(fit.input.source.topologySha256).toBe(sha("c"));
      expect(fit.input.parameters).toEqual([]);
      expect(fit.result.resolvedParameters).toEqual([]);
      if (fit.result.domain === "oral-cavity") {
        expect(fit.result.nodeTransforms).toHaveLength(5);
        expect(fit.result.followerMorphCoefficients).toHaveLength(15);
      } else {
        expect(fit.result.nodeTransforms).toEqual([]);
        expect(fit.result.followerMorphCoefficients).toEqual([]);
      }
    }
  });

  it("fails closed when the manifest binds another physical eye or body topology", async () => {
    const oralCavityFit = await oralPackage();
    const staleCap = await definition();
    const left = staleCap.domains.find(
      (entry) => entry.contract === SOCKET_EYE_ANATOMY_DOMAIN_CONTRACT && entry.side === "left",
    );
    if (!left || left.contract !== SOCKET_EYE_ANATOMY_DOMAIN_CONTRACT) {
      throw new Error("left test domain is missing");
    }
    left.physicalEyeNodeId = "OtherEye";
    await expect(computeAnatomyFitSiblingFromEvaluation({
      definition: staleCap,
      socketEyeSurface: surface(),
      eyeApertureSeam: seam(),
      oralCavityFit,
      modelBytes: new Uint8Array([1]),
      source: source(),
      appearanceManifest,
      appearanceDials: {
        contract: "appearance-dial-values/v1",
        definitionSha256: sha("b"),
        neutralId: "neutral",
        neutralRecipeSha256: sha("9"),
        values: { face_width: 0, mouth_width: 0 },
        unlockedDialIds: [],
      },
      basis: {} as AppearanceRecipePhysicalBasis,
      evaluation,
      resolved: { influences: new Map([["identity.mouth_width", 0]]) } as never,
    })).rejects.toThrow("another physical-eye node");

    const staleTopology = await definition();
    staleTopology.domains[0]!.bodyTopologySha256 = sha("0");
    await expect(computeAnatomyFitSiblingFromEvaluation({
      definition: staleTopology,
      socketEyeSurface: surface(),
      eyeApertureSeam: seam(),
      oralCavityFit,
      modelBytes: new Uint8Array([1]),
      source: source(),
      appearanceManifest,
      appearanceDials: {
        contract: "appearance-dial-values/v1",
        definitionSha256: sha("b"),
        neutralId: "neutral",
        neutralRecipeSha256: sha("9"),
        values: { face_width: 0, mouth_width: 0 },
        unlockedDialIds: [],
      },
      basis: {} as AppearanceRecipePhysicalBasis,
      evaluation,
      resolved: { influences: new Map([["identity.mouth_width", 0]]) } as never,
    })).rejects.toThrow("oral-cavity domain references another body topology");
  });
});
