import { describe, expect, it } from "vitest";
import {
  deriveRecipeSourceProjectionHashes,
  verifyDerivedRecipeSourceProjectionHashes,
  verifyRecipeSourceProjectionHashes,
} from "./sourcePackageProjections";

type Json = Record<string, any>;

const encoder = new TextEncoder();

class BinaryBuilder {
  readonly bytes: number[] = [];
  readonly bufferViews: Json[] = [];
  readonly accessors: Json[] = [];

  align(alignment = 4) {
    while (this.bytes.length % alignment !== 0) this.bytes.push(0);
  }

  addView(payload: Uint8Array, byteStride?: number): number {
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

  addAccessor(
    values: number[],
    componentType: 5121 | 5123 | 5125 | 5126,
    type: "SCALAR" | "VEC3" | "VEC4" | "MAT4",
    options: { normalized?: boolean; stridePadding?: number } = {},
  ): number {
    const components = { SCALAR: 1, VEC3: 3, VEC4: 4, MAT4: 16 }[type];
    if (values.length % components !== 0)
      throw new Error("bad fixture accessor");
    const componentBytes = { 5121: 1, 5123: 2, 5125: 4, 5126: 4 }[
      componentType
    ];
    const elementBytes = componentBytes * components;
    const stride = elementBytes + (options.stridePadding ?? 0);
    const count = values.length / components;
    const payload = new Uint8Array(count * stride);
    const view = new DataView(payload.buffer);
    for (let row = 0; row < count; row += 1) {
      for (let component = 0; component < components; component += 1) {
        const value = values[row * components + component];
        const offset = row * stride + component * componentBytes;
        if (componentType === 5121) view.setUint8(offset, value);
        else if (componentType === 5123) view.setUint16(offset, value, true);
        else if (componentType === 5125) view.setUint32(offset, value, true);
        else view.setFloat32(offset, value, true);
      }
    }
    const bufferView = this.addView(
      payload,
      options.stridePadding === undefined ? undefined : stride,
    );
    const index = this.accessors.length;
    this.accessors.push({
      bufferView,
      componentType,
      count,
      type,
      ...(options.normalized ? { normalized: true } : {}),
    });
    return index;
  }

  addSparseVec3(count: number, sparseIndex: number, value: number[]): number {
    const indexView = this.addView(Uint8Array.from([sparseIndex]));
    const payload = new Uint8Array(12);
    const view = new DataView(payload.buffer);
    value.forEach((entry, index) => view.setFloat32(index * 4, entry, true));
    const valuesView = this.addView(payload);
    const accessor = this.accessors.length;
    this.accessors.push({
      componentType: 5126,
      count,
      type: "VEC3",
      sparse: {
        count: 1,
        indices: { bufferView: indexView, componentType: 5121 },
        values: { bufferView: valuesView },
      },
    });
    return accessor;
  }
}

function manifest(): Json {
  const provenance = {
    catalogId: "fixture",
    componentId: "shape",
    license: "CC0-1.0",
    reviewStatus: "approved",
    contentSha256: "a".repeat(64),
  };
  return {
    contractVersion: 2,
    name: "Fixture Goon",
    description: "Presentation copy",
    stage: { anchors: { head: "anchor_head" } },
    rig: {
      baseId: "batshit-base-f-v1",
      fitFamily: "batshit-base-f-v1",
      provenance: { exported: "today" },
      performance: { contract: "performance/v1", jawGain: 1 },
      correctives: {
        driverContract: "joint-angle-corrective/v1",
        drivers: [
          {
            id: "hipFlexion",
            kind: "swing-angle",
            combine: "mean",
            clampDeg: [0, 90],
            bones: [
              {
                bone: "Hip",
                restRotation: [0, 0, 0, 1],
                axisRestLocal: [1, 0, 0],
              },
            ],
          },
        ],
        entries: [
          {
            driver: "hipFlexion",
            anchorDial: "shape",
            anchorAt0: 0,
            anchorAt1: 1,
            angleCurve: [
              [0, 0],
              [90, 1],
            ],
            mode: "additive",
            target: "shape-target",
          },
        ],
      },
    },
    evaluation: { productExportApproved: false },
    appearanceDials: {
      contract: "appearance-dials/v2",
      definitionSha256: "b".repeat(64),
      neutral: { id: "neutral-v1", recipeSha256: "c".repeat(64) },
      regions: [{ id: "body", label: "Body", surface: "body", order: 0 }],
      dials: [
        {
          id: "shape",
          label: "Shape",
          region: "body",
          tier: "core",
          order: 0,
          description: "Pretty words",
          keywords: ["shape"],
          kind: "tracks",
          range: [-1, 1],
          default: 0,
          step: 0.01,
          members: [
            {
              target: "shape-target",
              track: [
                [-1, -1],
                [0, 0],
                [1, 1],
              ],
            },
          ],
        },
      ],
      targets: {
        "shape-target": {
          usages: ["identity"],
          runtimeRetention: "recipe-only",
          side: "none",
          bindings: [{ node: "body", morph: "shape" }],
          baselineValue: 0,
          influenceMin: -1,
          influenceMax: 1,
          combine: "exclusive",
          impact: "structural",
          soleDeltaY: 0.02,
          requirements: { jointFollow: true, followerRefs: ["fit"] },
          provenance,
        },
      },
      nodes: {
        body: {
          node: "Face",
          kind: "mesh",
          role: "body",
          side: "none",
          required: true,
          scalePolicy: "any",
          parent: { kind: "bone", name: "Hip" },
          exactNodeMatches: 1,
        },
      },
      jointFollow: {
        contract: "rest-translation/v1",
        space: "avatar-root",
        units: "meters",
        restSkeletonSha256: "d".repeat(64),
        deltas: { "shape-target": { Hip: [0, 0.01, 0] } },
      },
      followers: {
        fit: {
          contract: "appearance-followers/v2",
          space: "node-parent-rest",
          composition: "rest-relative-follower-channel-id-order/v2",
          interpolation: "linear-trs-slerp-rotation-morph/v2",
          extrapolation: "clamp",
          provenance,
          nodeIds: ["body"],
          drivers: [
            {
              driver: { kind: "target", id: "shape-target" },
              channels: [
                {
                  id: "fit-shape",
                  kind: "morph-weight",
                  node: "body",
                  morph: "shape",
                  weightRange: [-1, 1],
                  runtimeRetention: "recipe-only",
                  samples: [
                    [-1, -1],
                    [0, 0],
                    [1, 1],
                  ],
                },
              ],
            },
          ],
        },
      },
    },
  };
}

function glb(
  options: {
    semanticPacking?: boolean;
    positionX?: number;
    indices?: number[];
    hipParent?: "Root" | "anchor_head";
    material?: number;
    duplicateRuntimeNode?: boolean;
    invalidPositionStride?: boolean;
    sparseIndex?: number;
    jointOrder?: "hip-chest" | "chest-hip";
    meshWeights?: number[];
    nodeWeights?: number[];
    rootRotation?: number[];
    parentCycle?: boolean;
    unsafeAccessorCount?: boolean;
    secondPrimitiveMorph?: boolean;
  } = {},
): Uint8Array {
  const builder = new BinaryBuilder();
  const position = builder.addAccessor(
    [0, 0, 0, options.positionX ?? 1, 0, 0, 0, 1, 0],
    5126,
    "VEC3",
    options.semanticPacking ? { stridePadding: 4 } : {},
  );
  if (options.invalidPositionStride) {
    const positionView = builder.accessors[position].bufferView;
    builder.bufferViews[positionView].byteStride = 2;
  }
  if (options.unsafeAccessorCount) {
    builder.accessors[position].count = Number.MAX_SAFE_INTEGER;
  }
  const jointValues = [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0];
  const joints = builder.addAccessor(
    jointValues,
    options.semanticPacking ? 5121 : 5123,
    "VEC4",
  );
  const weights = builder.addAccessor(
    options.semanticPacking
      ? [255, 0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0]
      : [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
    options.semanticPacking ? 5121 : 5126,
    "VEC4",
    options.semanticPacking ? { normalized: true } : {},
  );
  const indices = builder.addAccessor(
    options.indices ?? [0, 1, 2],
    options.semanticPacking ? 5125 : 5123,
    "SCALAR",
  );
  const morph = options.semanticPacking
    ? builder.addSparseVec3(3, options.sparseIndex ?? 1, [0.1, 0, 0])
    : builder.addAccessor([0, 0, 0, 0.1, 0, 0, 0, 0, 0], 5126, "VEC3");
  const secondMorph = options.secondPrimitiveMorph
    ? builder.addAccessor([0, 0, 0, 0.2, 0, 0, 0, 0, 0], 5126, "VEC3")
    : null;
  const inverseBind = builder.addAccessor(
    [
      1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 0, 0,
      0, 1, 0, 0.25, 0, 0, 1,
    ],
    5126,
    "MAT4",
  );
  const hipUnderAnchor = options.hipParent === "anchor_head";
  const json: Json = {
    asset: { version: "2.0" },
    buffers: [{ byteLength: builder.bytes.length }],
    bufferViews: builder.bufferViews,
    accessors: builder.accessors,
    materials: [{ name: options.material === 1 ? "Changed" : "Original" }],
    meshes: [
      {
        extras: { targetNames: ["shape"] },
        ...(options.meshWeights === undefined
          ? {}
          : { weights: options.meshWeights }),
        primitives: [
          {
            attributes: {
              POSITION: position,
              JOINTS_0: joints,
              WEIGHTS_0: weights,
            },
            indices,
            material: options.material ?? 0,
            targets: [{ POSITION: morph }],
          },
          ...(secondMorph === null
            ? []
            : [
                {
                  attributes: {
                    POSITION: position,
                    JOINTS_0: joints,
                    WEIGHTS_0: weights,
                  },
                  indices,
                  material: options.material ?? 0,
                  targets: [{ POSITION: secondMorph }],
                },
              ]),
        ],
      },
    ],
    nodes: [
      {
        name: "Root",
        children: hipUnderAnchor ? [3, 4] : [1, 3, 4],
        ...(options.rootRotation === undefined
          ? {}
          : { rotation: options.rootRotation }),
      },
      { name: "Hip", children: options.parentCycle ? [2, 0] : [2] },
      { name: "Chest" },
      {
        name: "Face",
        mesh: 0,
        skin: 0,
        ...(options.nodeWeights === undefined
          ? {}
          : { weights: options.nodeWeights }),
      },
      {
        name: options.duplicateRuntimeNode ? "H.ip" : "anchor_head",
        children: hipUnderAnchor ? [1] : [],
      },
    ],
    skins: [
      {
        skeleton: 1,
        joints: options.jointOrder === "chest-hip" ? [2, 1] : [1, 2],
        inverseBindMatrices: inverseBind,
      },
    ],
    scenes: [{ nodes: [0] }],
    scene: 0,
  };
  const jsonBytes = encoder.encode(JSON.stringify(json));
  const jsonPadding = (4 - (jsonBytes.length % 4)) % 4;
  const paddedJson = new Uint8Array(jsonBytes.length + jsonPadding);
  paddedJson.set(jsonBytes);
  paddedJson.fill(0x20, jsonBytes.length);
  const binary = Uint8Array.from(builder.bytes);
  const binPadding = (4 - (binary.length % 4)) % 4;
  const paddedBinary = new Uint8Array(binary.length + binPadding);
  paddedBinary.set(binary);
  const total = 12 + 8 + paddedJson.length + 8 + paddedBinary.length;
  const output = new Uint8Array(total);
  const view = new DataView(output.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, paddedJson.length, true);
  view.setUint32(16, 0x4e4f534a, true);
  output.set(paddedJson, 20);
  const binHeader = 20 + paddedJson.length;
  view.setUint32(binHeader, paddedBinary.length, true);
  view.setUint32(binHeader + 4, 0x004e4942, true);
  output.set(paddedBinary, binHeader + 8);
  return output;
}

function identity(
  hashes: Awaited<ReturnType<typeof deriveRecipeSourceProjectionHashes>>,
) {
  return {
    contract: "recipe-source/v1",
    schemaVersion: 1,
    baseId: "batshit-base-f-v1",
    fitFamily: "batshit-base-f-v1",
    modelSha256: "1".repeat(64),
    manifestSemanticSha256: "2".repeat(64),
    definitionSha256: "b".repeat(64),
    neutralId: "neutral-v1",
    neutralRecipeSha256: "c".repeat(64),
    ...hashes,
  };
}

describe("Recipe source-package projections", () => {
  it("pins frozen v1 near-unit quaternion normalization separately from the exact semantic reader", async () => {
    const exported = [
      -0.0029173805378377438, -0.00010276098328176886, -0.0214017815887928,
      0.9997667670249939,
    ];

    const nearUnit = await deriveRecipeSourceProjectionHashes(
      manifest(),
      glb({ rootRotation: exported }),
    );

    expect(nearUnit.physicalBasisSha256).toBe(
      "39f395645a1f81d563198a6583232f5c227151110e02c6aec28fb02f40375737",
    );
  });

  it("normalizes a real cross-engine quaternion with the frozen compensated v1 arithmetic", async () => {
    // V8 Math.hypot:          1.000000050191092
    // JavaScriptCore hypot:   1.0000000501910917
    // The projection must not depend on either engine approximation.
    const crossEngineRotation = [
      0.39359232783317566,
      -0.5416399240493774,
      0.45666053891181946,
      0.5858092904090881,
    ];

    const projection = await deriveRecipeSourceProjectionHashes(
      manifest(),
      glb({ rootRotation: crossEngineRotation }),
    );

    expect(projection.physicalBasisSha256).toBe(
      "5bce306989d1a81c1d392ef65afa7ad6ab946330d1018a2d3341ad23ed3cce39",
    );
  });

  it("normalizes dense, sparse, interleaved, index-width, and normalized-weight packing", async () => {
    const first = await deriveRecipeSourceProjectionHashes(manifest(), glb());
    const second = await deriveRecipeSourceProjectionHashes(
      manifest(),
      glb({ semanticPacking: true, material: 1 }),
    );
    expect(second).toEqual(first);
  });

  it("retains every per-primitive POSITION accessor for one node morph", async () => {
    const singlePrimitive = await deriveRecipeSourceProjectionHashes(
      manifest(),
      glb(),
    );
    const twoPrimitives = await deriveRecipeSourceProjectionHashes(
      manifest(),
      glb({ secondPrimitiveMorph: true }),
    );

    expect(twoPrimitives.physicalBasisSha256).not.toBe(
      singlePrimitive.physicalBasisSha256,
    );
    expect(twoPrimitives.behaviorSha256).toBe(
      singlePrimitive.behaviorSha256,
    );
  });

  it("keeps presentation and provenance edits out of every projection", async () => {
    const firstManifest = manifest();
    const secondManifest = structuredClone(firstManifest);
    secondManifest.name = "Renamed";
    secondManifest.description = "Different words";
    secondManifest.evaluation = { productExportApproved: true };
    secondManifest.rig.provenance = { exported: "tomorrow" };
    secondManifest.appearanceDials.regions[0].label = "New region label";
    Object.assign(secondManifest.appearanceDials.dials[0], {
      label: "New label",
      region: "another-presentation-region",
      tier: "advanced",
      order: 90,
      description: "New description",
      keywords: ["new"],
      step: 0.5,
    });
    secondManifest.appearanceDials.targets["shape-target"].provenance = {
      catalogId: "renamed evidence",
      contentSha256: "e".repeat(64),
    };
    secondManifest.appearanceDials.followers.fit.provenance = {
      catalogId: "renamed follower evidence",
      contentSha256: "f".repeat(64),
    };
    await expect(
      deriveRecipeSourceProjectionHashes(secondManifest, glb({ material: 1 })),
    ).resolves.toEqual(
      await deriveRecipeSourceProjectionHashes(firstManifest, glb()),
    );
  });

  it("changes each projection for the semantic data it owns", async () => {
    const baseManifest = manifest();
    const baseGlb = glb();
    const base = await deriveRecipeSourceProjectionHashes(
      baseManifest,
      baseGlb,
    );

    const physical = await deriveRecipeSourceProjectionHashes(
      baseManifest,
      glb({ positionX: 1.25 }),
    );
    expect(physical.physicalBasisSha256).not.toBe(base.physicalBasisSha256);
    expect(physical.topologySha256).toBe(base.topologySha256);

    const topology = await deriveRecipeSourceProjectionHashes(
      baseManifest,
      glb({ indices: [0, 2, 1] }),
    );
    expect(topology.topologySha256).not.toBe(base.topologySha256);

    const hierarchy = await deriveRecipeSourceProjectionHashes(
      baseManifest,
      glb({ hipParent: "anchor_head" }),
    );
    expect(hierarchy.skeletonHierarchySha256).not.toBe(
      base.skeletonHierarchySha256,
    );

    const behaviorManifest = structuredClone(baseManifest);
    behaviorManifest.appearanceDials.dials[0].members[0].track[2][1] = 0.75;
    const behavior = await deriveRecipeSourceProjectionHashes(
      behaviorManifest,
      baseGlb,
    );
    expect(behavior.behaviorSha256).not.toBe(base.behaviorSha256);

    const graphManifest = structuredClone(baseManifest);
    delete graphManifest.appearanceDials.targets["shape-target"].requirements
      .followerRefs;
    const graph = await deriveRecipeSourceProjectionHashes(
      graphManifest,
      baseGlb,
    );
    expect(graph.componentGraphSha256).not.toBe(base.componentGraphSha256);
  });

  it("preserves two-joint skin slot order and binds inverse matrices to those slots", async () => {
    const ordered = await deriveRecipeSourceProjectionHashes(
      manifest(),
      glb({ jointOrder: "hip-chest" }),
    );
    const reordered = await deriveRecipeSourceProjectionHashes(
      manifest(),
      glb({ jointOrder: "chest-hip" }),
    );
    expect(reordered.skeletonHierarchySha256).not.toBe(
      ordered.skeletonHierarchySha256,
    );
    expect(reordered.physicalBasisSha256).not.toBe(ordered.physicalBasisSha256);
  });

  it("includes effective mesh and node morph defaults in physical identity", async () => {
    const base = await deriveRecipeSourceProjectionHashes(manifest(), glb());
    const meshDefault = await deriveRecipeSourceProjectionHashes(
      manifest(),
      glb({ meshWeights: [0.25] }),
    );
    const nodeDefault = await deriveRecipeSourceProjectionHashes(
      manifest(),
      glb({ meshWeights: [0.25], nodeWeights: [0.5] }),
    );
    expect(meshDefault.physicalBasisSha256).not.toBe(base.physicalBasisSha256);
    expect(nodeDefault.physicalBasisSha256).not.toBe(
      meshDefault.physicalBasisSha256,
    );
    expect(nodeDefault.topologySha256).toBe(base.topologySha256);
  });

  it("records dial and side-offset follower requirements without global channel-id collisions", async () => {
    const sourceManifest = manifest();
    sourceManifest.appearanceDials.followers.fitTwo = structuredClone(
      sourceManifest.appearanceDials.followers.fit,
    );
    sourceManifest.appearanceDials.dials[0].requirements = {
      followerRefs: ["fit"],
    };
    sourceManifest.appearanceDials.dials[0].symmetry = {
      mode: "linked-with-offsets",
      left: {
        id: "shape-left",
        label: "Left",
        range: [-1, 1],
        step: 0.01,
        members: [{ target: "shape-target", track: [[0, 0]] }],
        requirements: { followerRefs: ["fitTwo"] },
      },
      right: {
        id: "shape-right",
        label: "Right",
        range: [-1, 1],
        step: 0.01,
        members: [{ target: "shape-target", track: [[0, 0]] }],
      },
    };
    const withRequirements = await deriveRecipeSourceProjectionHashes(
      sourceManifest,
      glb(),
    );
    delete sourceManifest.appearanceDials.dials[0].requirements;
    delete sourceManifest.appearanceDials.dials[0].symmetry.left.requirements;
    const withoutRequirements = await deriveRecipeSourceProjectionHashes(
      sourceManifest,
      glb(),
    );
    expect(withRequirements.componentGraphSha256).not.toBe(
      withoutRequirements.componentGraphSha256,
    );
  });

  it("rejects tampering of all five embedded projection hashes", async () => {
    const sourceManifest = manifest();
    const sourceGlb = glb();
    const hashes = await deriveRecipeSourceProjectionHashes(
      sourceManifest,
      sourceGlb,
    );
    await expect(
      verifyRecipeSourceProjectionHashes(
        identity(hashes),
        sourceManifest,
        sourceGlb,
      ),
    ).resolves.toEqual(hashes);
    expect(
      verifyDerivedRecipeSourceProjectionHashes(identity(hashes), hashes),
    ).toEqual(hashes);

    for (const field of Object.keys(hashes) as Array<keyof typeof hashes>) {
      const tampered = identity(hashes);
      tampered[field] = "9".repeat(64);
      await expect(
        verifyRecipeSourceProjectionHashes(tampered, sourceManifest, sourceGlb),
      ).rejects.toThrow(new RegExp(`${field} mismatch`));
      expect(() =>
        verifyDerivedRecipeSourceProjectionHashes(tampered, hashes),
      ).toThrow(new RegExp(`${field} mismatch`));
    }
  });

  it("fails loudly on ambiguous references, invalid accessors, unsafe JSON, and extra GLB chunks", async () => {
    await expect(
      deriveRecipeSourceProjectionHashes(
        manifest(),
        glb({ duplicateRuntimeNode: true }),
      ),
    ).rejects.toThrow(/duplicate Three\.js runtime node name Hip/);

    const ambiguousManifest = manifest();
    ambiguousManifest.appearanceDials.nodes.body.node = "Missing";
    await expect(() =>
      deriveRecipeSourceProjectionHashes(ambiguousManifest, glb()),
    ).rejects.toThrow(/Missing is missing/);

    const missingMorphManifest = manifest();
    missingMorphManifest.appearanceDials.targets[
      "shape-target"
    ].bindings[0].morph = "missing";
    await expect(() =>
      deriveRecipeSourceProjectionHashes(missingMorphManifest, glb()),
    ).rejects.toThrow(/morph missing is missing/);

    await expect(
      deriveRecipeSourceProjectionHashes(
        manifest(),
        glb({ invalidPositionStride: true }),
      ),
    ).rejects.toThrow(/invalid byteStride/);

    await expect(
      deriveRecipeSourceProjectionHashes(
        manifest(),
        glb({ semanticPacking: true, sparseIndex: 3 }),
      ),
    ).rejects.toThrow(
      /sparse indices must be unique, increasing, and in range/,
    );

    await expect(
      deriveRecipeSourceProjectionHashes(
        manifest(),
        glb({ unsafeAccessorCount: true }),
      ),
    ).rejects.toThrow(/value count exceeds the safe integer range/);

    await expect(
      deriveRecipeSourceProjectionHashes(
        manifest(),
        glb({ parentCycle: true }),
      ),
    ).rejects.toThrow(/parent cycle/);

    const unsafe = manifest();
    unsafe.appearanceDials.dials[0].range[1] = Number.POSITIVE_INFINITY;
    await expect(
      deriveRecipeSourceProjectionHashes(unsafe, glb()),
    ).rejects.toThrow(/numbers must be finite/);

    const source = glb();
    const extra = new Uint8Array(source.length + 8);
    extra.set(source);
    const view = new DataView(extra.buffer);
    view.setUint32(8, extra.length, true);
    view.setUint32(source.length, 0, true);
    view.setUint32(source.length + 4, 0x12345678, true);
    await expect(
      deriveRecipeSourceProjectionHashes(manifest(), extra),
    ).rejects.toThrow(/exactly one JSON chunk and one BIN chunk/);
  });
});
