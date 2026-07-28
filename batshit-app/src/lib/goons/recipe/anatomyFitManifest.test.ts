import { describe, expect, it } from "vitest";
import {
  ORAL_CAVITY_ANATOMY_FIT_SOLVER,
  SOCKET_EYE_ANATOMY_FIT_SOLVER,
  createAnatomyFitInput,
  createAnatomyFitResult,
  createAnatomyFitState,
} from "./anatomyFitContracts";
import {
  ORAL_CAVITY_ANATOMY_DOMAIN_CONTRACT,
  SOCKET_EYE_ANATOMY_DOMAIN_CONTRACT,
  createAnatomyFitManifestDefinition,
  parseAnatomyFitManifestDefinition,
  requireAnatomyFitStateDefinition,
  type OralCavityAnatomyFitDomain,
  type SocketEyeAnatomyFitDomain,
} from "./anatomyFitManifest";

const sha = (character: string) => character.repeat(64);

function domain(side: "left" | "right"): SocketEyeAnatomyFitDomain {
  const suffix = side === "left" ? "L" : "R";
  return {
    contract: SOCKET_EYE_ANATOMY_DOMAIN_CONTRACT,
    side,
    bodyMeshId: "mesh:1:0",
    bodyTopologySha256: sha("c"),
    socketEyeSurfaceDefinitionSha256: sha("d"),
    apertureSeamDefinitionSha256: sha("e"),
    compositeCapNodeId: `BS_Eye_${suffix}_CompositeCap`,
    lashesEyeOutlineNodeId: `BS_Face_${suffix}_LashesEyeOutline`,
  };
}

function oralDomain(): OralCavityAnatomyFitDomain {
  return {
    contract: ORAL_CAVITY_ANATOMY_DOMAIN_CONTRACT,
    bodyMeshId: "mesh:1:0",
    bodyTopologySha256: sha("c"),
    oralCavityFitDefinitionSha256: sha("7"),
  };
}

async function fit(domain: "oral-cavity" | "socket-eye:left" | "socket-eye:right") {
  const solverVersion = domain === "oral-cavity"
    ? ORAL_CAVITY_ANATOMY_FIT_SOLVER
    : SOCKET_EYE_ANATOMY_FIT_SOLVER;
  const input = await createAnatomyFitInput({
    solverVersion,
    domain,
    source: {
      modelSha256: sha("a"),
      appearanceDefinitionSha256: sha("b"),
      topologySha256: sha("c"),
      positionsSha256: sha("f"),
      positionsScalarCount: 12,
      physicalEvaluationSha256: sha("1"),
      physicalEvaluationScalarCount: 24,
      landmarkSetSha256: sha("2"),
      landmarkSampleCount: 10,
    },
    relevantInputs: [{ id: "face_width", value: 0 }],
    parameters: [],
  });
  const result = await createAnatomyFitResult({
    solverVersion,
    domain: input.domain,
    inputSha256: input.inputSha256,
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
    metrics: [],
    diagnostics: [],
  });
  return { input, result };
}

describe("Anatomy Fit v2 manifest definition", () => {
  it("self-hashes the oral plus bilateral socket/seam bindings and round-trips exactly", async () => {
    const manifest = await createAnatomyFitManifestDefinition([
      domain("right"),
      oralDomain(),
      domain("left"),
    ]);
    await expect(parseAnatomyFitManifestDefinition(manifest)).resolves.toEqual(manifest);
    expect(manifest.contract).toBe("anatomy-fit-manifest/v2");
    expect(manifest.domains.map((entry) =>
      entry.contract === ORAL_CAVITY_ANATOMY_DOMAIN_CONTRACT
        ? "oral-cavity"
        : `socket-eye:${entry.side}`,
    )).toEqual(["oral-cavity", "socket-eye:left", "socket-eye:right"]);

    const tampered = structuredClone(manifest);
    const left = tampered.domains.find(
      (entry) => entry.contract === SOCKET_EYE_ANATOMY_DOMAIN_CONTRACT && entry.side === "left",
    );
    if (!left || left.contract !== SOCKET_EYE_ANATOMY_DOMAIN_CONTRACT) {
      throw new Error("left test domain is missing");
    }
    left.compositeCapNodeId = "BS_Eye_L_Other";
    await expect(parseAnatomyFitManifestDefinition(tampered)).rejects.toThrow(
      "definitionSha256 does not match canonical content",
    );
  });

  it("binds reusable state to the exact definition and complete bilateral domain set", async () => {
    const manifest = await createAnatomyFitManifestDefinition([
      oralDomain(),
      domain("left"),
      domain("right"),
    ]);
    const state = await createAnatomyFitState(manifest.definitionSha256, [
      await fit("oral-cavity"),
      await fit("socket-eye:left"),
      await fit("socket-eye:right"),
    ]);
    expect(requireAnatomyFitStateDefinition(manifest, state)).toBe(state);

    const wrongDefinition = structuredClone(state);
    wrongDefinition.definitionSha256 = sha("9");
    expect(() => requireAnatomyFitStateDefinition(manifest, wrongDefinition)).toThrow(
      "targets a different Anatomy Fit definition",
    );
    const missing = structuredClone(state);
    missing.fits.pop();
    expect(() => requireAnatomyFitStateDefinition(manifest, missing)).toThrow(
      "exactly one fit for every declared domain",
    );
  });

  it("rejects incomplete, duplicate, and globe-era domain definitions", async () => {
    await expect(createAnatomyFitManifestDefinition([
      oralDomain(),
      domain("left"),
    ])).rejects.toThrow(
      "oral cavity plus left and right",
    );
    await expect(
      createAnatomyFitManifestDefinition([
        oralDomain(),
        domain("left"),
        domain("left"),
      ]),
    ).rejects.toThrow("duplicate specialization ids");
    await expect(createAnatomyFitManifestDefinition([
      oralDomain(),
      domain("right"),
      {
        contract: "eye-socket-fit-definition/v1",
        side: "left",
      } as never,
    ])).rejects.toThrow("must contain exactly");
  });
});
