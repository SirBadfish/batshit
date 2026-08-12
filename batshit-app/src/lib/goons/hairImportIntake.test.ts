import { describe, expect, it } from "vitest";
import {
  HAIR_IMPORT_BUDGETS,
  canonicalizeHairImportSelection,
  inspectHairImportSource,
  normalizeHairImportTransform,
} from "./hairImportIntake";
import {
  parseSemanticGlb,
  writeDeterministicSemanticGlb,
  type SemanticGltfRecord,
} from "./recipe/semanticGlb";

const ENCODER = new TextEncoder();

const AHS_LIKE_OBJ_FIXTURE =
  ENCODER.encode(`# Anime Hair Studio mesh and center-curve export
o Front_Bang
v -1 0 0
v 1 0 0
v 0 2 0
vt 0 0
vt 1 0
vt 0.5 1
usemtl Purple
f 1/1 2/2 3/3
o Front_Bang_curve
v 0 0 0
v 0 1 0
l 4 5
`);

const GENERIC_OBJ_FIXTURE = ENCODER.encode(`# ordinary polygon source
o Hair_Cap
v -1 0 0
v 1 0 0
v 1 2 0
v -1 2 0
usemtl SourceHair
f 1 2 3 4
o Non_Hair_Pin
v 2 0 0
v 3 0 0
v 2.5 1 0
usemtl SourceMetal
f 5 6 7
`);

function bytes(...arrays: ArrayBufferView[]) {
  let byteLength = 0;
  const offsets: number[] = [];
  for (const array of arrays) {
    byteLength = Math.ceil(byteLength / 4) * 4;
    offsets.push(byteLength);
    byteLength += array.byteLength;
  }
  const result = new Uint8Array(byteLength);
  arrays.forEach((array, index) => {
    result.set(
      new Uint8Array(array.buffer, array.byteOffset, array.byteLength),
      offsets[index],
    );
  });
  return { result, offsets };
}

function genericGlbFixture(
  patch: Partial<SemanticGltfRecord> = {},
  options: {
    bufferUri?: string;
    positionValues?: Float32Array;
    indexValues?: Uint16Array;
  } = {},
) {
  const positions =
    options.positionValues ?? new Float32Array([-1, 0, 0, 1, 0, 0, 0, 2, 0]);
  const normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]);
  const uvs = new Float32Array([0, 0, 1, 0, 0.5, 1]);
  const indices = options.indexValues ?? new Uint16Array([0, 1, 2]);
  const packed = bytes(positions, normals, uvs, indices);
  const gltf: SemanticGltfRecord = {
    asset: { version: "2.0", generator: "Non-AHS test fixture" },
    buffers: [
      {
        byteLength: packed.result.byteLength,
        ...(options.bufferUri ? { uri: options.bufferUri } : {}),
      },
    ],
    bufferViews: [
      {
        buffer: 0,
        byteOffset: packed.offsets[0],
        byteLength: positions.byteLength,
      },
      {
        buffer: 0,
        byteOffset: packed.offsets[1],
        byteLength: normals.byteLength,
      },
      { buffer: 0, byteOffset: packed.offsets[2], byteLength: uvs.byteLength },
      {
        buffer: 0,
        byteOffset: packed.offsets[3],
        byteLength: indices.byteLength,
      },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: "VEC3" },
      { bufferView: 1, componentType: 5126, count: 3, type: "VEC3" },
      { bufferView: 2, componentType: 5126, count: 3, type: "VEC2" },
      { bufferView: 3, componentType: 5123, count: 3, type: "SCALAR" },
    ],
    materials: [{ name: "Outside Material" }],
    meshes: [
      {
        name: "Outside Mesh",
        primitives: [
          {
            attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 },
            indices: 3,
            material: 0,
            mode: 4,
          },
        ],
      },
    ],
    nodes: [
      { name: "Outside Root", children: [1] },
      { name: "Outside Hair", mesh: 0 },
    ],
    scenes: [{ nodes: [0] }],
    scene: 0,
    ...patch,
  };
  return writeDeterministicSemanticGlb(gltf, packed.result, {
    diagnosticPrefix: "hair-import-test-fixture/v1",
  });
}

describe("hairImportIntake", () => {
  it("detects AHS-like OBJ from content and removes its line-only helpers by default", () => {
    const inspection = inspectHairImportSource({
      bytes: AHS_LIKE_OBJ_FIXTURE,
      filename: "renamed-source.obj",
    });

    expect(inspection.sourceMode).toBe("ahs-like-obj");
    expect(inspection.inventory).toMatchObject([
      {
        objectId: "object-0001",
        name: "Front_Bang",
        kind: "mesh",
        defaultDecision: "keep",
        triangleCount: 1,
      },
      {
        objectId: "object-0002",
        name: "Front_Bang_curve",
        kind: "line-helper",
        defaultDecision: "remove",
        lineCount: 1,
      },
    ]);
    expect(inspection.receipts).toContainEqual(
      expect.objectContaining({ action: "removed", subject: "object-0002" }),
    );
  });

  it("routes generic OBJ and generic GLB through the same deterministic canonical contract", () => {
    const obj = canonicalizeHairImportSelection({
      bytes: GENERIC_OBJ_FIXTURE,
      removeObjectIds: ["object-0002"],
    });
    const glb = canonicalizeHairImportSelection({ bytes: genericGlbFixture() });

    expect(obj.sourceMode).toBe("generic-obj");
    expect(glb.sourceMode).toBe("generic-glb");
    expect(obj.keptObjectIds).toEqual(["object-0001"]);
    expect(obj.removedObjectIds).toEqual(["object-0002"]);
    expect(obj.geometry).toMatchObject({
      meshCount: 1,
      vertexCount: 6,
      triangleCount: 2,
      materialCount: 1,
      textureCount: 0,
    });
    expect(glb.geometry).toMatchObject({
      meshCount: 1,
      vertexCount: 3,
      triangleCount: 1,
      materialCount: 1,
      textureCount: 0,
    });
    for (const result of [obj, glb]) {
      const parsed = parseSemanticGlb(result.glbBytes);
      expect(parsed.meshes).toHaveLength(1);
      expect(parsed.skins).toHaveLength(0);
      expect(parsed.gltf.scenes).toEqual([
        expect.objectContaining({ nodes: [0] }),
      ]);
      expect(parsed.nodes[0]).toMatchObject({
        name: "HairImportRoot",
        children: [1],
      });
      expect(parsed.gltf.materials).toEqual([
        expect.objectContaining({ name: "BatshitHairNeutralPlaceholder" }),
      ]);
      expect(parsed.gltf.images).toBeUndefined();
      expect(parsed.gltf.textures).toBeUndefined();
    }
  });

  it("maps registered stock roots while preserving paired-curve tips", () => {
    const sourceScalpPoints = Array.from({ length: 112 }, () => [0, 0, 0] as [
      number,
      number,
      number,
    ]);
    const targetScalpPoints = Array.from({ length: 112 }, () => [1, 0, 0] as [
      number,
      number,
      number,
    ]);
    const result = canonicalizeHairImportSelection({
      bytes: AHS_LIKE_OBJ_FIXTURE,
      calibration: {
        contract: "hair-import-source-calibration/v1",
        mode: "stock-scalp-deformation/v1",
        sourceScalpPoints,
        targetScalpPoints,
      },
    });

    expect(result.geometry.bounds).toEqual({
      min: [0, 0, 0],
      max: [2, 2, 0],
    });
    expect(result.receipts).toContainEqual(
      expect.objectContaining({
        subject: "ahs-stock-scalp-deformation",
        count: 112,
      }),
    );
  });

  it("rejects AHS calibration on non-AHS geometry instead of guessing", () => {
    expect(() =>
      canonicalizeHairImportSelection({
        bytes: GENERIC_OBJ_FIXTURE,
        calibration: {
          contract: "hair-import-source-calibration/v1",
          mode: "registered-template/v1",
          sourceScalpPoints: null,
          targetScalpPoints: null,
        },
      }),
    ).toThrow(/requires a matching AHS OBJ export/);
  });

  it("inventories bounded embedded GLB textures and removes them with source materials", () => {
    const result = canonicalizeHairImportSelection({
      bytes: genericGlbFixture({
        images: [{ bufferView: 2, mimeType: "image/png" }],
        samplers: [{}],
        textures: [{ sampler: 0, source: 0 }],
        materials: [
          {
            name: "Textured Source Hair",
            pbrMetallicRoughness: { baseColorTexture: { index: 0 } },
          },
        ],
      }),
    });

    expect(result.geometry.textureCount).toBe(0);
    expect(result.receipts).toContainEqual(
      expect.objectContaining({
        action: "removed",
        subject: "source-textures",
        count: 1,
      }),
    );
    const parsed = parseSemanticGlb(result.glbBytes);
    expect(parsed.gltf.images).toBeUndefined();
    expect(parsed.gltf.textures).toBeUndefined();
    expect(parsed.gltf.samplers).toBeUndefined();
  });

  it("produces byte-identical GLB output and receipts for the same reviewed selection", () => {
    const input = {
      bytes: GENERIC_OBJ_FIXTURE,
      keepObjectIds: ["object-0001"],
      transform: {
        translation: [0.25, -0.5, 0.75],
        rotation: [0.1, -0.2, 0.3],
        uniformScale: 1.5,
        axisScale: [1.1, 0.9, 1],
      },
    } as const;
    const first = canonicalizeHairImportSelection(input);
    const second = canonicalizeHairImportSelection(input);

    expect([...first.glbBytes]).toEqual([...second.glbBytes]);
    expect(first.receipts).toEqual(second.receipts);
    expect(first.geometry).toEqual(second.geometry);
  });

  it("normalizes full rotations but rejects transforms outside production bounds", () => {
    expect(
      normalizeHairImportTransform({ rotation: [Math.PI * 3, 0, 0] })
        .rotation[0],
    ).toBe(-Math.PI);
    expect(() =>
      normalizeHairImportTransform({
        translation: [HAIR_IMPORT_BUDGETS.maxTranslation + 1, 0, 0],
      }),
    ).toThrow(/translation must stay within/);
    expect(() =>
      normalizeHairImportTransform({ axisScale: [0.49, 1, 1] }),
    ).toThrow(/axisScale entries/);
  });

  it("rejects extension/content mismatches without using filenames for source mode", () => {
    expect(() =>
      inspectHairImportSource({
        bytes: AHS_LIKE_OBJ_FIXTURE,
        filename: "hair.glb",
      }),
    ).toThrow(/does not match obj source content/);
    expect(
      inspectHairImportSource({
        bytes: AHS_LIKE_OBJ_FIXTURE,
        filename: "anything.obj",
      }).sourceMode,
    ).toBe("ahs-like-obj");
  });

  it("enforces source byte, line byte, and count budgets before canonicalization", () => {
    expect(() =>
      inspectHairImportSource({
        bytes: GENERIC_OBJ_FIXTURE,
        budgets: { maxSourceBytes: 8 },
      }),
    ).toThrow(/source file exceeds/);
    expect(() =>
      inspectHairImportSource({
        bytes: ENCODER.encode(`v ${"1".repeat(30)} 0 0\n`),
        budgets: { maxObjLineBytes: 16 },
      }),
    ).toThrow(/OBJ line exceeds/);
    expect(() =>
      inspectHairImportSource({
        bytes: GENERIC_OBJ_FIXTURE,
        budgets: { maxVertices: 3 },
      }),
    ).toThrow(/vertex limit/);
    expect(() =>
      inspectHairImportSource({
        bytes: GENERIC_OBJ_FIXTURE,
        budgets: { maxObjects: 1 },
      }),
    ).toThrow(/object limit/);
  });

  it("rejects malformed indices, non-finite values, external refs, and unknown OBJ directives", () => {
    expect(() =>
      inspectHairImportSource({
        bytes: ENCODER.encode("v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 4\n"),
      }),
    ).toThrow(/out-of-range OBJ index/);
    expect(() =>
      inspectHairImportSource({ bytes: ENCODER.encode("v NaN 0 0\n") }),
    ).toThrow(/finite decimal number/);
    expect(() =>
      inspectHairImportSource({
        bytes: ENCODER.encode("mtllib https:\/\/evil.test\/hair.mtl\n"),
      }),
    ).toThrow(/external material library/);
    expect(() =>
      inspectHairImportSource({ bytes: ENCODER.encode("call shell-script\n") }),
    ).toThrow(/unsupported OBJ directive/);
  });

  it("rejects GLB URI references and unsupported animation, skeleton, camera, and extension content", () => {
    expect(() =>
      inspectHairImportSource({
        bytes: genericGlbFixture({}, { bufferUri: "x.bin" }),
      }),
    ).toThrow(/URI reference/);
    expect(() =>
      inspectHairImportSource({
        bytes: genericGlbFixture({
          images: [{ uri: "data:image/png;base64,AAAA" }],
        }),
      }),
    ).toThrow(/URI reference/);
    expect(() =>
      inspectHairImportSource({
        bytes: genericGlbFixture({
          animations: [{ channels: [], samplers: [] }],
        }),
      }),
    ).toThrow(/animations content is unsupported/);
    expect(() =>
      inspectHairImportSource({
        bytes: genericGlbFixture({ skins: [{ joints: [0] }] }),
      }),
    ).toThrow(/skins content is unsupported/);
    expect(() =>
      inspectHairImportSource({
        bytes: genericGlbFixture({
          cameras: [{ type: "perspective", perspective: {} }],
        }),
      }),
    ).toThrow(/cameras content is unsupported/);
    expect(() =>
      inspectHairImportSource({
        bytes: genericGlbFixture({ extensionsUsed: ["KHR_lights_punctual"] }),
      }),
    ).toThrow(/extensionsUsed content is unsupported/);
  });

  it("rejects malformed GLB indices, non-finite positions, and nodes outside the active scene", () => {
    const outOfRange = genericGlbFixture(
      {},
      { indexValues: new Uint16Array([0, 1, 9]) },
    );
    expect(() => inspectHairImportSource({ bytes: outOfRange })).toThrow(
      /out-of-range index/,
    );
    expect(() =>
      inspectHairImportSource({
        bytes: genericGlbFixture(
          {},
          { positionValues: new Float32Array([NaN, 0, 0, 1, 0, 0, 0, 1, 0]) },
        ),
      }),
    ).toThrow(/must be finite/);
    expect(() =>
      inspectHairImportSource({
        bytes: genericGlbFixture({
          nodes: [
            { name: "Outside Root", children: [1] },
            { name: "Outside Hair", mesh: 0 },
            { name: "Hidden Node" },
          ],
        }),
      }),
    ).toThrow(/nodes outside its active scene/);
  });

  it("enforces GLB JSON depth and elapsed-work budgets", () => {
    expect(() =>
      inspectHairImportSource({
        bytes: genericGlbFixture({ custom: { a: { b: { c: { d: true } } } } }),
        budgets: { maxJsonDepth: 4 },
      }),
    ).toThrow(/JSON exceeds the 4-level depth limit/);

    let clock = 0;
    expect(() =>
      inspectHairImportSource({
        bytes: GENERIC_OBJ_FIXTURE,
        budgets: { maxConversionMilliseconds: 1 },
        now: () => {
          clock += 2;
          return clock;
        },
      }),
    ).toThrow(/conversion budget/);
  });

  it("culls a bounded amount of degenerate junk and records the cleanup", () => {
    const source = ENCODER.encode(`o Hair
v 0 0 0
v 1 0 0
v 0 1 0
v 2 0 0
f 1 2 3
f 1 2 3
f 1 2 3
f 1 2 4
`);
    const inspection = inspectHairImportSource({ bytes: source });

    expect(inspection.geometry).toMatchObject({
      triangleCount: 3,
      discardedDegenerateTriangles: 1,
    });
    expect(inspection.receipts).toContainEqual(
      expect.objectContaining({ subject: "degenerate-triangles", count: 1 }),
    );
  });

  it("fails closed when the reviewed selection keeps no polygon geometry", () => {
    expect(() =>
      canonicalizeHairImportSelection({
        bytes: AHS_LIKE_OBJ_FIXTURE,
        keepObjectIds: [],
      }),
    ).toThrow(/must keep at least one polygon object/);
    expect(() =>
      canonicalizeHairImportSelection({
        bytes: AHS_LIKE_OBJ_FIXTURE,
        keepObjectIds: ["object-0002"],
      }),
    ).toThrow(/cannot keep non-polygon object/);
  });
});
