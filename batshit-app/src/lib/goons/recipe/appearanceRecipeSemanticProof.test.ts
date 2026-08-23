import { describe, expect, it } from "vitest";

import {
  buildAppearanceRecipeSemanticProof,
  type AppearanceRecipeSemanticProof,
} from "./appearanceRecipeSemanticProof";

type JsonRecord = Record<string, unknown>;
type LogicalNode = "root" | "body" | "bone" | "inactive";

const encoder = new TextEncoder();

function makeGlb(gltf: JsonRecord, binary: Uint8Array): Uint8Array {
  const jsonSource = encoder.encode(JSON.stringify(gltf));
  const jsonLength = Math.ceil(jsonSource.byteLength / 4) * 4;
  const binaryLength = Math.ceil(binary.byteLength / 4) * 4;
  const result = new Uint8Array(12 + 8 + jsonLength + 8 + binaryLength);
  const view = new DataView(result.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, result.byteLength, true);
  view.setUint32(12, jsonLength, true);
  view.setUint32(16, 0x4e4f534a, true);
  result.fill(0x20, 20, 20 + jsonLength);
  result.set(jsonSource, 20);
  const binaryHeader = 20 + jsonLength;
  view.setUint32(binaryHeader, binaryLength, true);
  view.setUint32(binaryHeader + 4, 0x004e4942, true);
  result.set(binary, binaryHeader + 8);
  return result;
}

class BinaryFixture {
  readonly bytes: number[] = [];
  readonly bufferViews: JsonRecord[] = [];
  readonly accessors: JsonRecord[] = [];

  private align(alignment = 4): void {
    while (this.bytes.length % alignment !== 0) this.bytes.push(0);
  }

  addBytes(bytes: Uint8Array): number {
    this.align();
    const byteOffset = this.bytes.length;
    this.bytes.push(...bytes);
    const bufferView = this.bufferViews.length;
    this.bufferViews.push({
      buffer: 0,
      byteOffset,
      byteLength: bytes.byteLength,
    });
    return bufferView;
  }

  addFloatAccessor(type: string, values: number[], components: number): number {
    const bytes = new Uint8Array(values.length * 4);
    const view = new DataView(bytes.buffer);
    values.forEach((value, index) => view.setFloat32(index * 4, value, true));
    const bufferView = this.addBytes(bytes);
    const accessor = this.accessors.length;
    this.accessors.push({
      bufferView,
      componentType: 5126,
      count: values.length / components,
      type,
    });
    return accessor;
  }

  addU16Accessor(values: number[]): number {
    const bytes = new Uint8Array(values.length * 2);
    const view = new DataView(bytes.buffer);
    values.forEach((value, index) => view.setUint16(index * 2, value, true));
    const bufferView = this.addBytes(bytes);
    const accessor = this.accessors.length;
    this.accessors.push({
      bufferView,
      componentType: 5123,
      count: values.length,
      type: "SCALAR",
    });
    return accessor;
  }

  finish(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }
}

type FixtureOptions = {
  nodeOrder?: LogicalNode[];
  materialColor?: number[];
  materialName?: string;
  materialExtras?: JsonRecord;
  imageBytes?: number[];
  positionX?: number;
  normalX?: number;
  morphNormalX?: number;
  clearcoatFactor?: number;
  samplerWrapS?: number;
  duplicatePrimitive?: boolean;
  duplicatePrimitiveWithDistinctMaterialRole?: boolean;
  unnamedBody?: boolean;
  invalidJointIndex?: boolean;
  invalidMaterialIndex?: boolean;
  invalidTextureIndex?: boolean;
  invalidImageBufferView?: boolean;
  inactiveMaterialColor?: number[];
  imageStorage?: "buffer-view" | "data-uri";
  reorderTextureAndImageArrays?: boolean;
};

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fixture(options: FixtureOptions = {}): Uint8Array {
  const binary = new BinaryFixture();
  const position = binary.addFloatAccessor(
    "VEC3",
    [options.positionX ?? 0, 0, 0, 1, 0, 0, 0, 1, 0],
    3,
  );
  const normal = binary.addFloatAccessor(
    "VEC3",
    [options.normalX ?? 0, 0, 1, 0, 0, 1, 0, 0, 1],
    3,
  );
  const tangent = binary.addFloatAccessor(
    "VEC4",
    [1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1],
    4,
  );
  const texcoord = binary.addFloatAccessor("VEC2", [0, 0, 1, 0, 0, 1], 2);
  const color = binary.addFloatAccessor(
    "VEC4",
    [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
    4,
  );
  const morphNormal = binary.addFloatAccessor(
    "VEC3",
    [options.morphNormalX ?? 0.1, 0, 0, 0.1, 0, 0, 0.1, 0, 0],
    3,
  );
  const indices = binary.addU16Accessor([0, 1, 2]);
  const inverseBind = binary.addFloatAccessor(
    "MAT4",
    [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    16,
  );
  const activeImageBytes = Uint8Array.from(
    options.imageBytes ?? [0x89, 0x50, 0x4e, 0x47],
  );
  const imageBufferView = binary.addBytes(activeImageBytes);
  const inactiveImageBufferView = binary.addBytes(
    Uint8Array.from([0x89, 0x50, 0x4e, 0x48]),
  );

  const order = options.nodeOrder ?? ["root", "body", "bone", "inactive"];
  const nodeIndex = Object.fromEntries(
    order.map((logical, index) => [logical, index]),
  ) as Record<LogicalNode, number>;
  const nodes = order.map((logical): JsonRecord => {
    if (logical === "root") {
      return {
        name: "Avatar Root",
        children: [nodeIndex.body, nodeIndex.bone],
      };
    }
    if (logical === "body") {
      return {
        ...(options.unnamedBody ? {} : { name: "Body.Mesh" }),
        mesh: 0,
        skin: 0,
      };
    }
    if (logical === "bone") return { name: "Hips:Bone" };
    return { name: "Inactive Mesh", mesh: 1 };
  });

  const activePrimitive = {
    attributes: {
      POSITION: position,
      NORMAL: normal,
      TANGENT: tangent,
      TEXCOORD_0: texcoord,
      COLOR_0: color,
    },
    indices,
    material: options.invalidMaterialIndex ? 99 : 0,
    targets: [{ NORMAL: morphNormal }],
  };
  const inactivePrimitive = {
    attributes: { POSITION: position, NORMAL: normal },
    material: 1,
  };
  const material = {
    name: options.materialName ?? "Visible Material",
    extras: options.materialExtras ?? { editorOnly: true },
    pbrMetallicRoughness: {
      baseColorFactor: options.materialColor ?? [1, 0.5, 0.25, 1],
      baseColorTexture: {
        index: options.invalidTextureIndex
          ? 99
          : options.reorderTextureAndImageArrays
            ? 1
            : 0,
      },
    },
    normalTexture: {
      index: options.reorderTextureAndImageArrays ? 1 : 0,
      scale: 0.75,
    },
    extensions: {
      KHR_materials_clearcoat: {
        clearcoatFactor: options.clearcoatFactor ?? 0.4,
        clearcoatTexture: {
          index: options.reorderTextureAndImageArrays ? 1 : 0,
        },
      },
    },
  };
  const inactiveMaterial = {
    pbrMetallicRoughness: {
      baseColorFactor: options.inactiveMaterialColor ?? [0, 0, 0, 1],
    },
  };
  const bytes = binary.finish();
  return makeGlb(
    {
      asset: { version: "2.0" },
      buffers: [{ byteLength: bytes.byteLength }],
      bufferViews: binary.bufferViews,
      accessors: binary.accessors,
      scene: 0,
      scenes: [{ nodes: [nodeIndex.root] }, { nodes: [nodeIndex.inactive] }],
      nodes,
      meshes: [
        {
          extras: { targetNames: ["wrinkle_normal"] },
          primitives: options.duplicatePrimitive
            ? [activePrimitive, structuredClone(activePrimitive)]
            : options.duplicatePrimitiveWithDistinctMaterialRole
              ? [activePrimitive, { ...structuredClone(activePrimitive), material: 2 }]
            : [activePrimitive],
        },
        { primitives: [inactivePrimitive] },
      ],
      skins: [
        {
          skeleton: nodeIndex.bone,
          joints: [options.invalidJointIndex ? 99 : nodeIndex.bone],
          inverseBindMatrices: inverseBind,
        },
      ],
      materials: [
        material,
        inactiveMaterial,
        { ...structuredClone(material), name: "Second Visible Material" },
      ],
      textures: options.reorderTextureAndImageArrays
        ? [
            { sampler: 1, source: 0 },
            { sampler: 0, source: 1 },
          ]
        : [
            { sampler: 0, source: 0 },
            { sampler: 1, source: 1 },
          ],
      samplers: [
        {
          magFilter: 9729,
          minFilter: 9987,
          wrapS: options.samplerWrapS ?? 10497,
          wrapT: 10497,
        },
        {
          magFilter: 9728,
          minFilter: 9728,
          wrapS: 33071,
          wrapT: 33071,
        },
      ],
      images: options.reorderTextureAndImageArrays
        ? [
            {
              mimeType: "image/png",
              bufferView: inactiveImageBufferView,
            },
            options.imageStorage === "data-uri"
              ? {
                  uri: `data:image/png;base64,${base64(activeImageBytes)}`,
                }
              : {
                  mimeType: "image/png",
                  bufferView: options.invalidImageBufferView
                    ? 99
                    : imageBufferView,
                },
          ]
        : [
            options.imageStorage === "data-uri"
              ? {
                  uri: `data:image/png;base64,${base64(activeImageBytes)}`,
                }
              : {
                  mimeType: "image/png",
                  bufferView: options.invalidImageBufferView
                    ? 99
                    : imageBufferView,
                },
            {
              mimeType: "image/png",
              bufferView: inactiveImageBufferView,
            },
          ],
    },
    bytes,
  );
}

function semanticValues(proof: AppearanceRecipeSemanticProof) {
  return {
    nodes: Object.values(proof.correspondence.nodes).sort(),
    meshes: Object.values(proof.correspondence.meshes).sort(),
    bones: Object.values(proof.correspondence.bones).sort(),
    skins: Object.values(proof.correspondence.skins).sort(),
  };
}

describe("Appearance Recipe semantic proof", () => {
  it("maps index-based physical basis ids to stable node, primitive, bone, and skin semantics", async () => {
    const original = await buildAppearanceRecipeSemanticProof(fixture());
    const reordered = await buildAppearanceRecipeSemanticProof(
      fixture({ nodeOrder: ["body", "bone", "root", "inactive"] }),
    );

    expect(original.correspondence.nodes).toMatchObject({
      "node:0": "node/v1/Avatar_Root",
      "node:1": "node/v1/Avatar_Root/BodyMesh",
      "node:2": "node/v1/Avatar_Root/HipsBone",
    });
    expect(original.correspondence.meshes["mesh:1:0"]).toContain(
      "node/v1/Avatar_Root/BodyMesh/primitive/v1/",
    );
    expect(original.correspondence.bones["bone:2"]).toBe(
      "bone/v1/node/v1/Avatar_Root/HipsBone",
    );
    expect(original.correspondence.skins["skin:1:0"]).toContain("skin/v1/");
    expect(semanticValues(reordered)).toEqual(semanticValues(original));
    expect(reordered.materials.projectionSha256).toBe(
      original.materials.projectionSha256,
    );
  });

  it("hashes active rendering material graphs, image bytes, and shading accessors while excluding only presentation fields", async () => {
    const baseline = await buildAppearanceRecipeSemanticProof(fixture());
    const renamed = await buildAppearanceRecipeSemanticProof(
      fixture({
        materialName: "Renamed for the editor",
        materialExtras: { anything: [1, 2, 3] },
      }),
    );
    expect(renamed.materials.projectionSha256).toBe(
      baseline.materials.projectionSha256,
    );

    const changedMaterial = await buildAppearanceRecipeSemanticProof(
      fixture({ materialColor: [0.5, 0.5, 0.5, 1] }),
    );
    const changedImage = await buildAppearanceRecipeSemanticProof(
      fixture({ imageBytes: [0x89, 0x50, 0x4e, 0x48] }),
    );
    const changedNormal = await buildAppearanceRecipeSemanticProof(
      fixture({ normalX: 0.25 }),
    );
    const changedMorphNormal = await buildAppearanceRecipeSemanticProof(
      fixture({ morphNormalX: 0.2 }),
    );
    const changedExtension = await buildAppearanceRecipeSemanticProof(
      fixture({ clearcoatFactor: 0.8 }),
    );
    const changedSampler = await buildAppearanceRecipeSemanticProof(
      fixture({ samplerWrapS: 33071 }),
    );
    for (const changed of [
      changedMaterial,
      changedImage,
      changedNormal,
      changedMorphNormal,
      changedExtension,
      changedSampler,
    ]) {
      expect(changed.materials.projectionSha256).not.toBe(
        baseline.materials.projectionSha256,
      );
    }

    const positionOnly = await buildAppearanceRecipeSemanticProof(
      fixture({ positionX: 0.125 }),
    );
    const inactiveOnly = await buildAppearanceRecipeSemanticProof(
      fixture({ inactiveMaterialColor: [1, 1, 1, 1] }),
    );
    expect(positionOnly.materials.projectionSha256).toBe(
      baseline.materials.projectionSha256,
    );
    expect(inactiveOnly.materials.projectionSha256).toBe(
      baseline.materials.projectionSha256,
    );
  });

  it("canonicalizes equivalent embedded image bytes across bufferView and data URI storage", async () => {
    const bufferView = await buildAppearanceRecipeSemanticProof(
      fixture({ imageStorage: "buffer-view" }),
    );
    const dataUri = await buildAppearanceRecipeSemanticProof(
      fixture({ imageStorage: "data-uri" }),
    );

    expect(dataUri.materials.projectionSha256).toBe(
      bufferView.materials.projectionSha256,
    );
    expect(dataUri.materials).toEqual(bufferView.materials);
  });

  it("canonicalizes texture and image array reordering when every reference is rewritten", async () => {
    const original = await buildAppearanceRecipeSemanticProof(fixture());
    const reordered = await buildAppearanceRecipeSemanticProof(
      fixture({ reorderTextureAndImageArrays: true }),
    );

    expect(reordered.materials.projectionSha256).toBe(
      original.materials.projectionSha256,
    );
    expect(reordered.materials).toEqual(original.materials);
  });

  it("rejects ambiguous semantic correspondence and unnamed active hierarchy nodes", async () => {
    await expect(
      buildAppearanceRecipeSemanticProof(
        fixture({ duplicatePrimitiveWithDistinctMaterialRole: true }),
      ),
    ).resolves.toBeDefined();
    await expect(
      buildAppearanceRecipeSemanticProof(fixture({ duplicatePrimitive: true })),
    ).rejects.toThrow(/ambiguous primitive signatures/);
    await expect(
      buildAppearanceRecipeSemanticProof(fixture({ unnamedBody: true })),
    ).rejects.toThrow(/name must be a non-empty trimmed string/);
    await expect(
      buildAppearanceRecipeSemanticProof(fixture({ invalidJointIndex: true })),
    ).rejects.toThrow(/joints\[0\].*out of range/);
  });

  it("fails closed on malformed material, texture, and embedded-image references", async () => {
    await expect(
      buildAppearanceRecipeSemanticProof(
        fixture({ invalidMaterialIndex: true }),
      ),
    ).rejects.toThrow(/materials\[99\].*out of range|out of range/);
    await expect(
      buildAppearanceRecipeSemanticProof(
        fixture({ invalidTextureIndex: true }),
      ),
    ).rejects.toThrow(/textures\[99\].*out of range|out of range/);
    await expect(
      buildAppearanceRecipeSemanticProof(
        fixture({ invalidImageBufferView: true }),
      ),
    ).rejects.toThrow(/bufferView.*out of range|out of range/);
  });

  it("returns deterministic canonical self hashes", async () => {
    const first = await buildAppearanceRecipeSemanticProof(fixture());
    const second = await buildAppearanceRecipeSemanticProof(fixture());
    expect(second).toEqual(first);
    expect(first.correspondence.correspondenceSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(first.materials.projectionSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(first.proofSha256).toMatch(/^[0-9a-f]{64}$/);
  });
});
