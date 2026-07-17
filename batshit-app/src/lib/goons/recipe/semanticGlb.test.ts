import { describe, expect, it } from "vitest";
import {
  decodeSemanticGlbAccessor,
  getSemanticGlbMesh,
  getSemanticGlbNode,
  parseSemanticGlb,
  RECIPE_SEMANTIC_GLB_UNIT_QUATERNION_TOLERANCE,
  resolveSemanticGlbNode,
  resolveSemanticGlbNodeTransform,
  stableSemanticGlbNodeName,
  visitSemanticGlbAccessorRows,
  visitSemanticGlbAccessorScalars,
} from "./semanticGlb";

type JsonRecord = Record<string, unknown>;

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

function fixture(accessorCount = 1): Uint8Array {
  const binary = new Uint8Array(12);
  const view = new DataView(binary.buffer);
  view.setFloat32(0, 1, true);
  view.setFloat32(4, 2, true);
  view.setFloat32(8, 3, true);
  return makeGlb(
    {
      asset: { version: "2.0" },
      buffers: [{ byteLength: binary.byteLength }],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 12 }],
      accessors: [
        {
          bufferView: 0,
          componentType: 5126,
          count: accessorCount,
          type: "VEC3",
        },
      ],
      nodes: [
        { name: "Root", children: [1, 2] },
        {
          name: "Face.001",
          mesh: 0,
          translation: [1, 2, 3],
          rotation: [0, 0, 0, 1],
          scale: [2, 3, 4],
        },
        {
          name: "Anchor",
          matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 4, 5, 6, 1],
        },
      ],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
      skins: [],
    },
    binary,
  );
}

class AccessorFixtureBuilder {
  readonly bytes: number[] = [];
  readonly bufferViews: JsonRecord[] = [];
  readonly accessors: JsonRecord[] = [];

  private align(): void {
    while (this.bytes.length % 4 !== 0) this.bytes.push(0);
  }

  private addView(payload: Uint8Array, byteStride?: number): number {
    this.align();
    const byteOffset = this.bytes.length;
    this.bytes.push(...payload);
    const index = this.bufferViews.length;
    this.bufferViews.push({
      buffer: 0,
      byteOffset,
      byteLength: payload.byteLength,
      ...(byteStride === undefined ? {} : { byteStride }),
    });
    return index;
  }

  addFloatVec3(values: number[], stride = 12): number {
    const count = values.length / 3;
    const payload = new Uint8Array(count * stride);
    const view = new DataView(payload.buffer);
    values.forEach((value, index) => {
      const row = Math.floor(index / 3);
      const component = index % 3;
      view.setFloat32(row * stride + component * 4, value, true);
    });
    const bufferView = this.addView(
      payload,
      stride === 12 ? undefined : stride,
    );
    const accessor = this.accessors.length;
    this.accessors.push({
      bufferView,
      componentType: 5126,
      count,
      type: "VEC3",
    });
    return accessor;
  }

  addSparseFloatVec3(count: number, rows: number[], values: number[]): number {
    const indices = this.addView(Uint8Array.from(rows));
    const payload = new Uint8Array(values.length * 4);
    const view = new DataView(payload.buffer);
    values.forEach((value, index) => view.setFloat32(index * 4, value, true));
    const sparseValues = this.addView(payload);
    const accessor = this.accessors.length;
    this.accessors.push({
      componentType: 5126,
      count,
      type: "VEC3",
      sparse: {
        count: rows.length,
        indices: { bufferView: indices, componentType: 5121 },
        values: { bufferView: sparseValues },
      },
    });
    return accessor;
  }

  addNormalizedU8Vec3(values: number[]): number {
    const bufferView = this.addView(Uint8Array.from(values));
    const accessor = this.accessors.length;
    this.accessors.push({
      bufferView,
      componentType: 5121,
      count: values.length / 3,
      type: "VEC3",
      normalized: true,
    });
    return accessor;
  }

  glb(): Uint8Array {
    const binary = Uint8Array.from(this.bytes);
    return makeGlb(
      {
        asset: { version: "2.0" },
        buffers: [{ byteLength: binary.byteLength }],
        bufferViews: this.bufferViews,
        accessors: this.accessors,
        nodes: [],
        meshes: [],
        skins: [],
      },
      binary,
    );
  }
}

function visitorFixture(): {
  glb: Uint8Array;
  dense: number;
  interleaved: number;
  sparse: number;
  normalized: number;
} {
  const builder = new AccessorFixtureBuilder();
  const values = [0, 0, 0, 1, 2, 3, 4, 5, 6];
  return {
    dense: builder.addFloatVec3(values),
    interleaved: builder.addFloatVec3(values, 16),
    sparse: builder.addSparseFloatVec3(3, [1, 2], values.slice(3)),
    normalized: builder.addNormalizedU8Vec3([0, 127, 255]),
    glb: builder.glb(),
  };
}

describe("semantic GLB", () => {
  it("exposes bounded semantic access, stable names, and raw transform representation", () => {
    const parsed = parseSemanticGlb(fixture());

    expect(resolveSemanticGlbNode(parsed, "Face.001", "face")).toBe(1);
    expect(resolveSemanticGlbNode(parsed, "Face001", "face")).toBe(1);
    expect(stableSemanticGlbNodeName(parsed, 1, "face")).toBe("Face001");
    expect(getSemanticGlbMesh(parsed, 0).primitives).toBeDefined();
    expect(parsed.parents.get(1)).toBe(0);

    const decoded = decodeSemanticGlbAccessor(parsed, 0);
    expect(decoded).toMatchObject({
      count: 1,
      components: 3,
      componentType: 5126,
      type: "VEC3",
      normalized: false,
    });
    expect([...decoded.values]).toEqual([1, 2, 3]);

    const trs = resolveSemanticGlbNodeTransform(
      getSemanticGlbNode(parsed, 1),
      "face",
    );
    expect(trs.representation).toBe("trs");
    expect(trs.translation).toEqual([1, 2, 3]);
    expect(trs.rotation).toEqual([0, 0, 0, 1]);
    expect(trs.scale).toEqual([2, 3, 4]);
    expect(trs.matrix.slice(12, 16)).toEqual([1, 2, 3, 1]);

    const matrix = resolveSemanticGlbNodeTransform(
      getSemanticGlbNode(parsed, 2),
      "anchor",
    );
    expect(matrix.representation).toBe("matrix");
    expect(matrix.rawMatrix).toEqual(matrix.matrix);
    expect(matrix.matrix.slice(12, 16)).toEqual([4, 5, 6, 1]);
  });

  it("keeps accessor allocation bounded by the declared package bytes", () => {
    const parsed = parseSemanticGlb(fixture(2));
    expect(() => decodeSemanticGlbAccessor(parsed, 0)).toThrow(
      /declares more values than the GLB can safely represent/,
    );
  });

  it("visits dense, sparse, and interleaved rows equivalently and repeatably", () => {
    const packed = visitorFixture();
    const parsed = parseSemanticGlb(packed.glb);
    const collect = (accessor: number) => {
      const rows: number[] = [];
      const values: number[][] = [];
      const info = visitSemanticGlbAccessorRows(
        parsed,
        accessor,
        (row, rowValues) => {
          rows.push(row);
          values.push([...rowValues]);
        },
      );
      return { info, rows, values };
    };

    const dense = collect(packed.dense);
    expect(dense.rows).toEqual([0, 1, 2]);
    expect(dense.info).toMatchObject({ count: 3, components: 3 });
    expect(collect(packed.interleaved).values).toEqual(dense.values);
    expect(collect(packed.sparse).values).toEqual(dense.values);
    expect(collect(packed.sparse).values).toEqual(dense.values);
  });

  it("visits normalized scalars in deterministic row-major order", () => {
    const packed = visitorFixture();
    const parsed = parseSemanticGlb(packed.glb);
    const visited: Array<[number, number, number]> = [];
    const info = visitSemanticGlbAccessorScalars(
      parsed,
      packed.normalized,
      (row, component, value) => visited.push([row, component, value]),
    );

    expect(info).toMatchObject({
      count: 1,
      components: 3,
      componentType: 5121,
      normalized: true,
    });
    expect(visited).toEqual([
      [0, 0, 0],
      [0, 1, 127 / 255],
      [0, 2, 1],
    ]);
  });

  it("applies the same buffer-view bounds before a visitor can run", () => {
    const packed = visitorFixture();
    const parsed = parseSemanticGlb(packed.glb);
    const accessor = parsed.gltf.accessors?.[packed.dense] as JsonRecord;
    accessor.count = 4;

    expect(() =>
      visitSemanticGlbAccessorRows(parsed, packed.dense, () => undefined),
    ).toThrow(/exceeds its bufferView/);
  });

  it("rejects ambiguous matrix-plus-TRS nodes before callers interpret them", () => {
    expect(() =>
      resolveSemanticGlbNodeTransform(
        { matrix: new Array(16).fill(0), translation: [0, 0, 0] },
        "node",
      ),
    ).toThrow(/mixes matrix and TRS/);
  });

  it("preserves valid unit quaternions exactly without normalizing them", () => {
    const rotation = [
      -0.0029173805378377438, -0.00010276098328176886, -0.0214017815887928,
      0.9997667670249939,
    ];
    expect(Math.abs(Math.hypot(...rotation) - 1)).toBeLessThan(
      RECIPE_SEMANTIC_GLB_UNIT_QUATERNION_TOLERANCE,
    );

    const transform = resolveSemanticGlbNodeTransform(
      { rotation },
      "valid exported node",
    );
    expect(transform.rotation).toEqual(rotation);
  });

  it("rejects malformed, zero-length, and non-unit quaternions instead of repairing them", () => {
    const invalid: Array<[unknown, RegExp]> = [
      [[0, 0, 1], /has malformed TRS/],
      [[0, 0, 0, 0], /must have unit length/],
      [[0, 0, 0, 2], /must have unit length/],
      [[0, 0, Number.NaN, 1], /must be finite/],
    ];

    for (const [rotation, expected] of invalid) {
      expect(() =>
        resolveSemanticGlbNodeTransform({ rotation }, "invalid node"),
      ).toThrow(expected);
    }
  });
});
