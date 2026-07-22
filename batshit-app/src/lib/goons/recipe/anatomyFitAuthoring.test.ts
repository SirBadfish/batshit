import { describe, expect, it, vi } from "vitest";
import type { AppearanceDialsManifest } from "../appearanceDials.contracts";
import type { EyeApertureSeamDefinitionV1 } from "../eyeApertureSeam";
import type { SocketEyeSurfaceDefinitionV1 } from "../socketEyeSurface";
import { parseAnatomyFitState } from "./anatomyFitContracts";
import { computeAnatomyFitSiblingFromEvaluation } from "./anatomyFitAuthoring";
import {
  SOCKET_EYE_ANATOMY_DOMAIN_CONTRACT,
  createAnatomyFitManifestDefinition,
} from "./anatomyFitManifest";
import type {
  AppearanceRecipePhysicalBasis,
  AppearanceRecipePhysicalEvaluation,
} from "./appearanceRecipePhysicalEvaluator";
import type { RecipeSourceIdentity } from "./packageMetadata";

vi.mock("./socketEyeSurfaceFit", () => ({
  createSocketEyeAnatomyProof: vi.fn(async ({ surface }: { surface: { side: string } }) => ({
    contract: "socket-eye-anatomy-proof/v1",
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

function surface(): SocketEyeSurfaceDefinitionV1 {
  const side = (name: "left" | "right") => ({
    side: name,
    nodes: { compositeCap: name === "left" ? "Cap_L" : "Cap_R" },
    apertureSeamDefinitionSha256: sha("e"),
    cap: {
      minimumHiddenUnderlapMeters: 0.001,
    },
  });
  return {
    definitionSha256: sha("d"),
    runtimeBindings: { left: side("left"), right: side("right") },
  } as unknown as SocketEyeSurfaceDefinitionV1;
}

function seam(): EyeApertureSeamDefinitionV1 {
  const side = (name: "left" | "right") => ({
    side: name,
    compositeCapNode: name === "left" ? "Cap_L" : "Cap_R",
    lashesEyeOutlineNode: name === "left" ? "Liner_L" : "Liner_R",
    capUnderlapMeters: 0.001,
    upperBoundary: { sampleCount: 24, bindingSha256: sha("5") },
    lowerBoundary: { sampleCount: 24, bindingSha256: sha("6") },
  });
  return {
    definitionSha256: sha("e"),
    runtimeBindings: { left: side("left"), right: side("right") },
  } as unknown as EyeApertureSeamDefinitionV1;
}

async function definition() {
  return createAnatomyFitManifestDefinition((["left", "right"] as const).map((side) => ({
    contract: SOCKET_EYE_ANATOMY_DOMAIN_CONTRACT,
    side,
    bodyMeshId: "body",
    bodyTopologySha256: sha("c"),
    socketEyeSurfaceDefinitionSha256: sha("d"),
    apertureSeamDefinitionSha256: sha("e"),
    compositeCapNodeId: side === "left" ? "Cap_L" : "Cap_R",
    lashesEyeOutlineNodeId: side === "left" ? "Liner_L" : "Liner_R",
  })));
}

const appearanceManifest = {
  contract: "appearance-dials/v2",
  definitionSha256: sha("b"),
  nodes: {},
  followers: {},
} as unknown as AppearanceDialsManifest;

const evaluation = {
  contract: "appearance-recipe-physical-evaluation/v1",
  meshes: [{ id: "body", nodeId: "body-node", positions: new Float32Array([0, 0, 0, 1, 1, 1]) }],
  nodes: [{ id: "body-node", localMatrix: matrix, rootRelativeMatrix: matrix, worldMatrix: matrix }],
} as unknown as AppearanceRecipePhysicalEvaluation;

describe("Anatomy Fit v2 authoring orchestration", () => {
  it("verifies both cap/liner domains into one deterministic no-coefficient sibling", async () => {
    const input = {
      definition: await definition(),
      socketEyeSurface: surface(),
      eyeApertureSeam: seam(),
      modelBytes: new Uint8Array([1, 2, 3]),
      source: source(),
      appearanceManifest,
      appearanceDials: {
        contract: "appearance-dial-values/v1" as const,
        definitionSha256: sha("b"),
        neutralId: "neutral",
        neutralRecipeSha256: sha("9"),
        values: { face_width: 0.3, eye_height: -0.1 },
        unlockedDialIds: [],
      },
      basis: {} as AppearanceRecipePhysicalBasis,
      evaluation,
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
      "socket-eye:left",
      "socket-eye:right",
    ]);
    for (const fit of state.fits) {
      expect(fit.input.parameters).toEqual([]);
      expect(fit.result.nodeTransforms).toEqual([]);
      expect(fit.result.followerMorphCoefficients).toEqual([]);
      expect(fit.result.resolvedParameters).toEqual([]);
    }
  });

  it("fails closed when the manifest binds another cap or topology", async () => {
    const staleCap = await definition();
    staleCap.domains[0]!.compositeCapNodeId = "OtherCap";
    await expect(computeAnatomyFitSiblingFromEvaluation({
      definition: staleCap,
      socketEyeSurface: surface(),
      eyeApertureSeam: seam(),
      modelBytes: new Uint8Array([1]),
      source: source(),
      appearanceManifest,
      appearanceDials: {
        contract: "appearance-dial-values/v1",
        definitionSha256: sha("b"),
        neutralId: "neutral",
        neutralRecipeSha256: sha("9"),
        values: { face_width: 0 },
        unlockedDialIds: [],
      },
      basis: {} as AppearanceRecipePhysicalBasis,
      evaluation,
    })).rejects.toThrow("another composite-cap node");

    const staleTopology = await definition();
    staleTopology.domains[0]!.bodyTopologySha256 = sha("0");
    await expect(computeAnatomyFitSiblingFromEvaluation({
      definition: staleTopology,
      socketEyeSurface: surface(),
      eyeApertureSeam: seam(),
      modelBytes: new Uint8Array([1]),
      source: source(),
      appearanceManifest,
      appearanceDials: {
        contract: "appearance-dial-values/v1",
        definitionSha256: sha("b"),
        neutralId: "neutral",
        neutralRecipeSha256: sha("9"),
        values: { face_width: 0 },
        unlockedDialIds: [],
      },
      basis: {} as AppearanceRecipePhysicalBasis,
      evaluation,
    })).rejects.toThrow("does not match the verified Recipe Source topology");
  });
});
