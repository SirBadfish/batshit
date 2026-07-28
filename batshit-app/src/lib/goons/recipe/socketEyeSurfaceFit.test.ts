import { describe, expect, it } from "vitest";
import type { EyeApertureSeamSideDefinition } from "../eyeApertureSeam";
import type { SocketEyeSurfaceSideDefinition } from "../socketEyeSurface";
import type { AppearanceRecipePhysicalEvaluation } from "./appearanceRecipePhysicalEvaluator";
import { createSocketEyeAnatomyProof } from "./socketEyeSurfaceFit";

const sha = (character: string) => character.repeat(64);
const encoder = new TextEncoder();
const followerMorphs = ["faceWidth", "eyeBlinkLeft", "eyeSquintLeft", "eyeWideLeft"];
const linerPerformanceMorphs = [
  "eyeBlinkLeft",
  "eyeSquintLeft",
  "eyeWideLeft",
  "browInnerUp",
  "cheekSquintLeft",
  ...Array.from({ length: 39 }, (_, index) => `performanceLeft${index}`),
].sort();

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
  const mesh = (material: number, offset: number, morphs = followerMorphs) => {
    const base = addAccessor([offset, 0, 0, offset + 0.1, 0, 0, offset, 0.1, 0]);
    const targets = morphs.map((_, index) => ({
      POSITION: addAccessor([0, 0, index * 0.001, 0, 0, 0, 0, 0, 0]),
    }));
    return {
      extras: { targetNames: morphs },
      primitives: [{ attributes: { POSITION: base }, material, targets }],
      weights: morphs.map(() => 0),
    };
  };
  const meshes = [
    mesh(0, 0),
    mesh(1, 1),
    mesh(2, 2, ["faceWidth", ...linerPerformanceMorphs]),
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
      { name: "Root", children: [1, 4] },
      { name: "Cap_L", children: [2, 3] },
      { name: "Cap_L_Visible", mesh: 0 },
      { name: "Cap_L_Hidden", mesh: 1 },
      { name: "Liner_L", mesh: 2 },
    ],
    materials: [
      { name: "VisibleFront" },
      { name: "HiddenClosure" },
      { name: "Liner" },
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
  nodes: { compositeCap: "Cap_L" },
  cap: {
    visibleFrontFaceGroup: "VisibleFront",
    hiddenClosureFaceGroup: "HiddenClosure",
    primitiveFollowerMorphs: {
      visibleFront: [...followerMorphs].sort(),
      hiddenClosure: [...followerMorphs].sort(),
    },
  },
} as unknown as SocketEyeSurfaceSideDefinition;

const seam = {
  side: "left",
  lashesEyeOutlineNode: "Liner_L",
  liner: { retainedPerformanceMorphs: linerPerformanceMorphs },
} as unknown as EyeApertureSeamSideDefinition;

function evaluation(offset = 0): AppearanceRecipePhysicalEvaluation {
  const positions = (base: number) => new Float32Array([
    base + offset, 0, 0,
    base + 0.1, 0, 0,
    base, 0.1, 0,
  ]);
  return {
    contract: "appearance-recipe-physical-evaluation/v1",
    meshes: [
      { id: "mesh:2:0", nodeId: "node:2", positions: positions(0) },
      { id: "mesh:3:0", nodeId: "node:3", positions: positions(1) },
      { id: "mesh:4:0", nodeId: "node:4", positions: positions(2) },
    ],
  } as AppearanceRecipePhysicalEvaluation;
}

describe("socket-eye Anatomy Fit geometry proof", () => {
  it("hash-binds evaluated cap/liner geometry and exact identity/dynamic inventories", async () => {
    const proof = await createSocketEyeAnatomyProof({
      modelBytes: glb(),
      evaluation: evaluation(),
      surfaceDefinitionSha256: sha("d"),
      seamDefinitionSha256: sha("e"),
      surface,
      seam,
    });
    expect(proof.domain).toBe("socket-eye:left");
    expect(proof.primitives.map((entry) => entry.role)).toEqual([
      "composite-cap-visible",
      "composite-cap-hidden",
      "lashes-eye-outline",
    ]);
    for (const primitive of proof.primitives.slice(0, 2)) {
      expect(primitive.identityFollowerMorphs).toEqual(["faceWidth"]);
      expect(primitive.retainedDynamicMorphs).toEqual([
        "eyeBlinkLeft",
        "eyeSquintLeft",
        "eyeWideLeft",
      ]);
    }
    expect(proof.primitives.at(-1)?.identityFollowerMorphs).toEqual(["faceWidth"]);
    expect(proof.primitives.at(-1)?.retainedDynamicMorphs).toEqual(
      linerPerformanceMorphs,
    );

    const changed = await createSocketEyeAnatomyProof({
      modelBytes: glb(),
      evaluation: evaluation(0.01),
      surfaceDefinitionSha256: sha("d"),
      seamDefinitionSha256: sha("e"),
      surface,
      seam,
    });
    expect(changed.geometrySha256).not.toBe(proof.geometrySha256);
    expect(changed.proofSha256).not.toBe(proof.proofSha256);
  });

  it("fails closed when any generated primitive is absent", async () => {
    const missing = evaluation();
    missing.meshes = missing.meshes.filter((entry) => entry.id !== "mesh:3:0");
    await expect(createSocketEyeAnatomyProof({
      modelBytes: glb(),
      evaluation: missing,
      surfaceDefinitionSha256: sha("d"),
      seamDefinitionSha256: sha("e"),
      surface,
      seam,
    })).rejects.toThrow("missing from the final physical evaluation");
  });

  it("does not misclassify liner-only facial performance channels as identity followers", async () => {
    const proof = await createSocketEyeAnatomyProof({
      modelBytes: glb(),
      evaluation: evaluation(),
      surfaceDefinitionSha256: sha("d"),
      seamDefinitionSha256: sha("e"),
      surface,
      seam,
    });
    expect(proof.primitives.at(-1)?.identityFollowerMorphs).toEqual([
      "faceWidth",
    ]);
    expect(proof.primitives.at(-1)?.retainedDynamicMorphs).toEqual(
      linerPerformanceMorphs,
    );
    expect(proof.primitives.at(-1)?.retainedDynamicMorphs).toContain("browInnerUp");
    expect(proof.primitives.at(-1)?.retainedDynamicMorphs).toContain("cheekSquintLeft");
  });
});
