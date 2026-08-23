import { describe, expect, it } from "vitest";
import type { EyeApertureSeamSideDefinitionV2 } from "../eyeApertureSeam";
import type { SocketEyeSurfaceSideDefinitionV2 } from "../socketEyeSurface";
import type { AppearanceRecipePhysicalEvaluation } from "./appearanceRecipePhysicalEvaluator";
import { canonicalRecipeSha256 } from "./recipeCanonical";
import { createSocketEyeAnatomyProof } from "./socketEyeSurfaceFit";

const sha = (character: string) => character.repeat(64);
const encoder = new TextEncoder();
const identityFollowerMorphs = Array.from(
  { length: 46 },
  (_, index) => `identityLeft${index}`,
).sort();
const treatmentPerformanceMorphs = [
  "eyeBlinkLeft",
  "eyeLookDownLeft",
  "eyeLookInLeft",
  "eyeLookOutLeft",
  "eyeLookUpLeft",
  "eyeSquintLeft",
  "eyeWideLeft",
  ...Array.from({ length: 31 }, (_, index) => `performanceLeft${index}`),
].sort();
const surfaceCorrectiveMorphs = [
  "surfaceBlinkLinearLeft",
  "surfaceBlinkResidualLeft",
  "surfaceProjectionLeft",
].sort();
const treatmentFollowerMorphs = [...identityFollowerMorphs, ...treatmentPerformanceMorphs].sort();
const treatmentMorphs = [...treatmentFollowerMorphs, ...surfaceCorrectiveMorphs].sort();

function pad4(bytes: Uint8Array, fill: number): Uint8Array {
  const output = new Uint8Array((bytes.length + 3) & ~3);
  output.fill(fill);
  output.set(bytes);
  return output;
}

function glb() {
  const chunks: Uint8Array[] = [];
  const accessors: Array<Record<string, unknown>> = [];
  const views: Array<Record<string, unknown>> = [];
  const addAccessor = (values: number[]) => {
    const floats = new Float32Array(values);
    const bytes = new Uint8Array(floats.buffer);
    const offset = chunks.reduce((sum, entry) => sum + entry.byteLength, 0);
    chunks.push(bytes);
    views.push({ buffer: 0, byteOffset: offset, byteLength: bytes.byteLength });
    accessors.push({
      bufferView: views.length - 1,
      componentType: 5126,
      count: values.length / 3,
      type: "VEC3",
    });
    return accessors.length - 1;
  };
  const primitive = (material: number, offset: number, morphs: string[]) => {
    const base = addAccessor([offset, 0, 0, offset + 0.1, 0, 0, offset, 0.1, 0]);
    const targets = morphs.map((_, index) => ({
      POSITION: addAccessor([0, 0, index * 0.00001, 0, 0, 0, 0, 0, 0]),
    }));
    return {
      attributes: { POSITION: base },
      material,
      ...(targets.length === 0 ? {} : { targets }),
    };
  };
  const meshes = [
    {
      extras: { targetNames: [] },
      primitives: [primitive(0, 0, [])],
      weights: [],
    },
    {
      extras: { targetNames: treatmentMorphs },
      primitives: [
        primitive(1, 1, treatmentMorphs),
        primitive(2, 2, treatmentMorphs),
      ],
      weights: treatmentMorphs.map(() => 0),
    },
  ];
  const binary = new Uint8Array(chunks.reduce((sum, entry) => sum + entry.byteLength, 0));
  let binaryOffset = 0;
  for (const bytes of chunks) {
    binary.set(bytes, binaryOffset);
    binaryOffset += bytes.byteLength;
  }
  const json = {
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [
      { name: "Root", children: [1, 2] },
      { name: "PhysicalEye_L", mesh: 0 },
      { name: "Treatment_L", mesh: 1 },
    ],
    materials: [
      { name: "PhysicalEye" },
      { name: "TreatmentUpper" },
      { name: "TreatmentLower" },
    ],
    meshes,
    accessors,
    bufferViews: views,
    buffers: [{ byteLength: binary.byteLength }],
  };
  const jsonBytes = pad4(encoder.encode(JSON.stringify(json)), 0x20);
  const binBytes = pad4(binary, 0);
  const output = new Uint8Array(12 + 8 + jsonBytes.length + 8 + binBytes.length);
  const view = new DataView(output.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, output.length, true);
  view.setUint32(12, jsonBytes.length, true);
  view.setUint32(16, 0x4e4f534a, true);
  output.set(jsonBytes, 20);
  const binHeader = 20 + jsonBytes.length;
  view.setUint32(binHeader, binBytes.length, true);
  view.setUint32(binHeader + 4, 0x004e4942, true);
  output.set(binBytes, binHeader + 8);
  return output;
}

const surface = {
  side: "left",
  nodes: { physicalEye: "PhysicalEye_L" },
} as SocketEyeSurfaceSideDefinitionV2;

async function seam(): Promise<EyeApertureSeamSideDefinitionV2> {
  return {
    side: "left",
    lashesEyeOutlineNode: "Treatment_L",
    treatment: {
      upperMaterialName: "TreatmentUpper",
      lowerMaterialName: "TreatmentLower",
      followerMorphs: treatmentFollowerMorphs,
      retainedPerformanceMorphs: treatmentPerformanceMorphs,
      surfaceCorrection: {
        contract: "head-projection-blink-surface-correction/v1",
        projectionMorph: "surfaceProjectionLeft",
        blinkLinearMorph: "surfaceBlinkLinearLeft",
        blinkResidualMorph: "surfaceBlinkResidualLeft",
        blinkMorph: "eyeBlinkLeft",
        projectionWeightLaw: "appearance-follower-weight",
        blinkLinearWeightLaw: "blink-times-projection",
        blinkResidualWeightLaw: "four-blink-one-minus-blink-times-projection",
      },
      followerInventorySha256: await canonicalRecipeSha256({
        identityFollowerMorphs,
      }),
    },
  } as EyeApertureSeamSideDefinitionV2;
}

function evaluation(positionOffset = 0, transformOffset = 0): AppearanceRecipePhysicalEvaluation {
  const positions = (base: number) => new Float32Array([
    base + positionOffset, 0, 0,
    base + 0.1, 0, 0,
    base, 0.1, 0,
  ]);
  return {
    contract: "appearance-recipe-physical-evaluation/v1",
    meshes: [
      { id: "mesh:1:0", nodeId: "node:1", positions: positions(0) },
      { id: "mesh:2:0", nodeId: "node:2", positions: positions(1) },
      { id: "mesh:2:1", nodeId: "node:2", positions: positions(2) },
    ],
    nodes: [{
      id: "node:1",
      rootRelativeMatrix: [
        1, 0, 0, 0,
        0, 1, 0, 0,
        0, 0, 1, 0,
        transformOffset, 0, 0, 1,
      ],
    }],
  } as AppearanceRecipePhysicalEvaluation;
}

describe("socket-eye Anatomy Fit geometry proof", () => {
  it("hash-binds the static eye transform and exact treatment geometry/inventories", async () => {
    const treatment = await seam();
    const proof = await createSocketEyeAnatomyProof({
      modelBytes: glb(),
      evaluation: evaluation(),
      surfaceDefinitionSha256: sha("d"),
      seamDefinitionSha256: sha("e"),
      surface,
      seam: treatment,
    });
    expect(proof.contract).toBe("socket-eye-anatomy-proof/v2");
    expect(proof.primitives.map((entry) => entry.role)).toEqual([
      "physical-eye",
      "treatment-upper",
      "treatment-lower",
    ]);
    expect(proof.primitives[0]).toMatchObject({
      identityFollowerMorphs: [],
      retainedDynamicMorphs: [],
    });
    for (const primitive of proof.primitives.slice(1)) {
      expect(primitive.identityFollowerMorphs).toEqual(identityFollowerMorphs);
      expect(primitive.retainedDynamicMorphs).toEqual(treatmentPerformanceMorphs);
      expect(primitive.surfaceCorrectiveMorphs).toEqual(surfaceCorrectiveMorphs);
    }

    const changedGeometry = await createSocketEyeAnatomyProof({
      modelBytes: glb(),
      evaluation: evaluation(0.01),
      surfaceDefinitionSha256: sha("d"),
      seamDefinitionSha256: sha("e"),
      surface,
      seam: treatment,
    });
    expect(changedGeometry.geometrySha256).not.toBe(proof.geometrySha256);

    const changedTransform = await createSocketEyeAnatomyProof({
      modelBytes: glb(),
      evaluation: evaluation(0, 0.01),
      surfaceDefinitionSha256: sha("d"),
      seamDefinitionSha256: sha("e"),
      surface,
      seam: treatment,
    });
    expect(changedTransform.physicalEyeTransformSha256).not.toBe(
      proof.physicalEyeTransformSha256,
    );
    expect(changedTransform.proofSha256).not.toBe(proof.proofSha256);
  });

  it("fails closed when a generated treatment primitive is absent", async () => {
    const missing = evaluation();
    missing.meshes = missing.meshes.filter((entry) => entry.id !== "mesh:2:1");
    await expect(createSocketEyeAnatomyProof({
      modelBytes: glb(),
      evaluation: missing,
      surfaceDefinitionSha256: sha("d"),
      seamDefinitionSha256: sha("e"),
      surface,
      seam: await seam(),
    })).rejects.toThrow("missing from the final physical evaluation");
  });

  it("rejects a stale treatment follower inventory hash", async () => {
    const stale = await seam();
    stale.treatment.followerInventorySha256 = sha("0");
    await expect(createSocketEyeAnatomyProof({
      modelBytes: glb(),
      evaluation: evaluation(),
      surfaceDefinitionSha256: sha("d"),
      seamDefinitionSha256: sha("e"),
      surface,
      seam: stale,
    })).rejects.toThrow("identity follower inventory hash is stale");
  });
});
