import { describe, expect, it } from "vitest";
import { APPEARANCE_DIAL_VALUES_CONTRACT } from "./appearanceDials.contracts";
import {
  HAIR_IMPORT_AUTHORING_CONTRACT,
  HairImportAuthoringError,
  authorHairImportProposal,
  type HairImportAuthoringInput,
} from "./hairImportAuthoring";
import { canonicalizeHairImportSelection } from "./hairImportIntake";
import { parseHairFollowerDefinition } from "./hairFollowers";
import {
  SECONDARY_MOTION_MIN_REST_LENGTH_METERS,
  createEmbeddedSecondaryMotion,
  parseSecondaryMotionDefinition,
} from "./secondaryMotion";
import { composeHairIntoAvatarGlb } from "./recipe/hairAvatarGlbComposer";
import { bakeHairFollowerGlb } from "./recipe/hairFollowerGlbBaker";
import { createRecipePhysicalMigrationFixture } from "./recipe/fixtures/recipePhysicalMigrationPair";
import {
  decodeSemanticGlbAccessor,
  parseSemanticGlb,
  writeDeterministicSemanticGlb,
  type SemanticGltfRecord,
  type SemanticJsonRecord,
} from "./recipe/semanticGlb";

type JsonRecord = Record<string, unknown>;

class BinaryFixture {
  private readonly chunks: Array<{ offset: number; bytes: Uint8Array }> = [];
  readonly bufferViews: JsonRecord[] = [];
  readonly accessors: JsonRecord[] = [];
  private length = 0;

  private append(bytes: Uint8Array, target?: number): number {
    const offset = Math.ceil(this.length / 4) * 4;
    this.chunks.push({ offset, bytes });
    this.length = offset + bytes.byteLength;
    const index = this.bufferViews.length;
    this.bufferViews.push({
      buffer: 0,
      byteOffset: offset,
      byteLength: bytes.byteLength,
      ...(target === undefined ? {} : { target }),
    });
    return index;
  }

  float(values: number[], type: "SCALAR" | "VEC3", target?: number): number {
    const array = Float32Array.from(values);
    const components = type === "SCALAR" ? 1 : 3;
    const bufferView = this.append(new Uint8Array(array.buffer), target);
    const count = values.length / components;
    const accessor = this.accessors.length;
    const minimum = Array.from({ length: components }, (_, component) =>
      Math.min(
        ...Array.from(
          { length: count },
          (_, row) => values[row * components + component]!,
        ),
      ),
    );
    const maximum = Array.from({ length: components }, (_, component) =>
      Math.max(
        ...Array.from(
          { length: count },
          (_, row) => values[row * components + component]!,
        ),
      ),
    );
    this.accessors.push({
      bufferView,
      componentType: 5126,
      count,
      type,
      min: minimum,
      max: maximum,
    });
    return accessor;
  }

  indices(values: number[]): number {
    const array = Uint16Array.from(values);
    const bufferView = this.append(new Uint8Array(array.buffer), 34963);
    const accessor = this.accessors.length;
    this.accessors.push({
      bufferView,
      componentType: 5123,
      count: values.length,
      type: "SCALAR",
      min: [Math.min(...values)],
      max: [Math.max(...values)],
    });
    return accessor;
  }

  bytes(): Uint8Array {
    const output = new Uint8Array(this.length);
    for (const chunk of this.chunks) output.set(chunk.bytes, chunk.offset);
    return output;
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function makeHairGlb(includeMicroIsland = false): Uint8Array {
  const binary = new BinaryFixture();
  const position = binary.float(
    [
      -0.025,
      1.66,
      0,
      0.025,
      1.66,
      0,
      -0.035,
      1.84,
      0.005,
      0.035,
      1.84,
      0.005,
      -0.045,
      2.02,
      0.015,
      0.045,
      2.02,
      0.015,
      ...(includeMicroIsland
        ? [-0.001, 1.65, 0, 0.001, 1.65, 0, 0, 1.651, 0]
        : []),
    ],
    "VEC3",
    34962,
  );
  const indices = binary.indices([
    0,
    1,
    2,
    1,
    3,
    2,
    2,
    3,
    4,
    3,
    5,
    4,
    ...(includeMicroIsland ? [6, 7, 8] : []),
  ]);
  const bytes = binary.bytes();
  return writeDeterministicSemanticGlb(
    {
      asset: { version: "2.0", generator: "generic Hair author fixture" },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [
        { name: "HairImportRoot", children: [1] },
        { name: "ImportedFrontClump", mesh: 0 },
      ],
      meshes: [
        {
          name: "ImportedFrontClumpMesh",
          primitives: [{ attributes: { POSITION: position }, indices }],
        },
      ],
      buffers: [{ byteLength: bytes.byteLength }],
      bufferViews: binary.bufferViews,
      accessors: binary.accessors,
    },
    bytes,
    { diagnosticPrefix: "hair-import-authoring-test" },
  );
}

function makeMixedMotionSupportHairGlb(): Uint8Array {
  const binary = new BinaryFixture();
  const addPositions = (xOffset: number, tipHalfWidth: number) =>
    binary.float(
      [
        xOffset - 0.025,
        1.66,
        0,
        xOffset + 0.025,
        1.66,
        0,
        xOffset - 0.035,
        1.84,
        0.005,
        xOffset + 0.035,
        1.84,
        0.005,
        xOffset - tipHalfWidth,
        2.02,
        0.015,
        xOffset + tipHalfWidth,
        2.02,
        0.015,
      ],
      "VEC3",
      34962,
    );
  const addIndices = () =>
    binary.indices([0, 1, 2, 1, 3, 2, 2, 3, 4, 3, 5, 4]);
  const movingPosition = addPositions(0, 0.045);
  const movingIndices = addIndices();
  const anchoredPosition = addPositions(0.1, 0.001);
  const anchoredIndices = addIndices();
  const bytes = binary.bytes();
  return writeDeterministicSemanticGlb(
    {
      asset: { version: "2.0", generator: "mixed motion support fixture" },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [
        { name: "HairImportRoot", children: [1, 2] },
        { name: "ImportedMovingClump", mesh: 0 },
        { name: "ImportedAnchoredDetail", mesh: 1 },
      ],
      meshes: [
        {
          name: "ImportedMovingClumpMesh",
          primitives: [
            {
              attributes: { POSITION: movingPosition },
              indices: movingIndices,
            },
          ],
        },
        {
          name: "ImportedAnchoredDetailMesh",
          primitives: [
            {
              attributes: { POSITION: anchoredPosition },
              indices: anchoredIndices,
            },
          ],
        },
      ],
      buffers: [{ byteLength: bytes.byteLength }],
      bufferViews: binary.bufferViews,
      accessors: binary.accessors,
    },
    bytes,
    { diagnosticPrefix: "hair-import-authoring-mixed-motion-test" },
  );
}

function makeBranchedHairGlb(): Uint8Array {
  const binary = new BinaryFixture();
  const position = binary.float(
    [
      -0.02, 1.66, 0,
      0.02, 1.66, 0,
      -0.02, 1.74, 0,
      0.02, 1.74, 0,
      -0.05, 1.78, 0,
      -0.02, 1.78, 0,
      -0.09, 1.83, 0,
      -0.06, 1.83, 0,
      0.02, 1.86, 0,
      0.05, 1.86, 0,
      0.06, 2.1, 0,
      0.09, 2.1, 0,
    ],
    "VEC3",
    34962,
  );
  const indices = binary.indices([
    0, 1, 2,
    1, 3, 2,
    2, 3, 4,
    3, 5, 4,
    4, 5, 6,
    5, 7, 6,
    2, 3, 8,
    3, 9, 8,
    8, 9, 10,
    9, 11, 10,
  ]);
  const bytes = binary.bytes();
  return writeDeterministicSemanticGlb(
    {
      asset: { version: "2.0", generator: "branched Hair author fixture" },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [
        { name: "HairImportRoot", children: [1] },
        { name: "ImportedFrontClump", mesh: 0 },
      ],
      meshes: [
        {
          name: "ImportedFrontClumpMesh",
          primitives: [{ attributes: { POSITION: position }, indices }],
        },
      ],
      buffers: [{ byteLength: bytes.byteLength }],
      bufferViews: binary.bufferViews,
      accessors: binary.accessors,
    },
    bytes,
    { diagnosticPrefix: "hair-import-authoring-branched-test" },
  );
}

async function makeRecipeFixture(zeroHeadSize = false) {
  const fixture = await createRecipePhysicalMigrationFixture({
    runtimePreviewCompatible: true,
  });
  const parsed = parseSemanticGlb(fixture.source.glbBytes);
  const gltf = clone(parsed.gltf) as SemanticGltfRecord;
  const binary = new BinaryFixture();
  const positions = [
    -0.12, 1.46, -0.1, 0.12, 1.46, -0.1, -0.12, 1.66, -0.1, 0.12, 1.66, -0.1,
    -0.12, 1.46, 0.1, 0.12, 1.46, 0.1, -0.12, 1.66, 0.1, 0.12, 1.66, 0.1,
  ];
  const positionAccessor = binary.float(positions, "VEC3", 34962);
  const morphNames = [
    "affine_shape",
    "complex_shape",
    "keep_shape",
    "new_shape",
    "piecewise_shape",
    "removed_shape",
  ];
  const targets = morphNames.map((name) => {
    const values = new Array(positions.length).fill(0) as number[];
    if (name === "keep_shape" && !zeroHeadSize) {
      for (let offset = 0; offset < positions.length; offset += 3) {
        values[offset] = positions[offset]! * 0.2;
        values[offset + 1] = (positions[offset + 1]! - 1.56) * 0.15;
        values[offset + 2] = positions[offset + 2]! * 0.2;
      }
    }
    return { POSITION: binary.float(values, "VEC3", 34962) };
  });
  const mesh = (gltf.meshes as SemanticJsonRecord[])[0]!;
  mesh.extras = { targetNames: morphNames };
  mesh.weights = morphNames.map(() => 0);
  const primitive = (mesh.primitives as SemanticJsonRecord[])[0]!;
  primitive.attributes = { POSITION: positionAccessor };
  primitive.targets = targets;
  const recipeBytes = binary.bytes();
  gltf.buffers = [{ byteLength: recipeBytes.byteLength }];
  gltf.bufferViews = binary.bufferViews;
  gltf.accessors = binary.accessors;
  const recipeSourceGlb = writeDeterministicSemanticGlb(gltf, recipeBytes, {
    diagnosticPrefix: "hair-import-authoring-recipe-test",
  });
  const appearanceManifest = clone(fixture.source.avatarManifest);
  const appearance = appearanceManifest.appearanceDials as JsonRecord;
  const dials = appearance.dials as JsonRecord[];
  const headSize = dials.find((entry) => entry.id === "keep_control")!;
  headSize.id = "head_size";
  headSize.label = "Head Size";
  headSize.description = "Fixture head-size deformation.";
  headSize.keywords = ["head", "size"];
  dials.sort((left, right) => String(left.id).localeCompare(String(right.id)));
  return { recipeSourceGlb, appearanceManifest };
}

async function inputFixture(
  zeroHeadSize = false,
): Promise<HairImportAuthoringInput> {
  const recipe = await makeRecipeFixture(zeroHeadSize);
  return {
    canonicalHairGlb: makeHairGlb(),
    recipeSourceGlb: recipe.recipeSourceGlb,
    appearanceManifest: recipe.appearanceManifest,
    owner: {
      assetId: "hair-import-fixture",
      revisionId: "hair-import-fixture-r1",
      fitFamily: "sa090-r2-physical-fixture.v1",
    },
    recipeNodes: {
      bodyManifestNodeId: "body",
      headRigNode: "HeadAnchor",
    },
    fit: {
      authoredRootMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      minimumScale: 0.25,
      maximumScale: 4,
      maximumAxisScaleRatio: 1.5,
    },
    reviewedAppearanceState: null,
    scalp: {
      rootBounds: { minimum: [-0.2, 1.4, -0.2], maximum: [0.2, 1.7, 0.2] },
      transferBounds: {
        minimum: [-0.3, 1.35, -0.3],
        maximum: [0.3, 1.75, 0.3],
      },
      rootSeedFraction: 0.2,
      maximumRootDistance: 0.2,
    },
    followerDrivers: [
      { dialId: "head_size", endpoint: -1, falloffProfile: "global-head" },
      { dialId: "head_size", endpoint: 1, falloffProfile: "global-head" },
    ],
    clumps: [
      {
        id: "ImportedFront",
        meshNode: "ImportedFrontClump",
        collisionGroups: ["head"],
        maximumConnectedComponents: 1,
      },
    ],
    colliders: [
      {
        id: "scalp-shell",
        group: "head",
        shape: "sphere",
        node: "HeadAnchor",
        offset: [0, 1.56, 0],
        tailOffset: [0, 1.56, 0],
        radius: 0.11,
        drivers: [
          {
            dialId: "head_size",
            endpoint: -1,
            offsetDelta: [0, 0, 0],
            tailOffsetDelta: [0, 0, 0],
            radiusDelta: -0.01,
          },
          {
            dialId: "head_size",
            endpoint: 1,
            offsetDelta: [0, 0, 0],
            tailOffsetDelta: [0, 0, 0],
            radiusDelta: 0.01,
          },
        ],
      },
    ],
    motion: {
      anchoredLength: 0.6,
      defaultIntensity: 0.65,
      fixedStepSeconds: 1 / 120,
      maxSubsteps: 8,
      interruptionResetSeconds: 0.25,
      gravity: [0, -9.81, 0],
      collisionIterations: 4,
    },
  };
}

describe("generic Hair import authoring", () => {
  it("turns user-painted triangles into a protected-boundary-to-tip motion ramp", async () => {
    const input = await inputFixture();
    input.motion.paint = {
      contract: "hair-motion-paint/v1",
      regions: [
        {
          id: "front-strand",
          label: "Front strand",
          enabled: true,
          meshes: [
            {
              meshNode: "ImportedFrontClump",
              triangleCount: 4,
              triangleRanges: [[2, 3]],
            },
          ],
        },
      ],
    };

    const result = await authorHairImportProposal(input);
    expect(result.proposal.motionRegions).toHaveLength(1);
    expect(result.proposal.motionRegions[0]).toMatchObject({
      label: "Front strand",
      moving: true,
      recommendedMoving: true,
    });
    expect(result.proposal.chains).toHaveLength(1);

    const parsed = parseSemanticGlb(result.geometryGlb);
    const primitive = parsed.meshes[0]!.primitives[0]!;
    const attributes = primitive.attributes as SemanticJsonRecord;
    const tips = decodeSemanticGlbAccessor(parsed, attributes._BATSHAIR_TIP);
    const values = Array.from(tips.values);
    // Triangles 0 and 1 were not painted. Their shared cut vertices (2 and 3)
    // must remain fully anchored so an adjacent brush mark cannot stretch an
    // unpainted triangle into a visible sliver during motion.
    expect(values.slice(0, 4).every((value) => value < 1e-6)).toBe(true);
    expect(values.slice(4)).toEqual([1, 1]);
  });

  it("anchors an accidental painted triangle with no stable interior", async () => {
    const input = await inputFixture();
    input.motion.paint = {
      contract: "hair-motion-paint/v1",
      regions: [
        {
          id: "front-strand",
          label: "Front strand",
          enabled: true,
          meshes: [
            {
              meshNode: "ImportedFrontClump",
              triangleCount: 4,
              triangleRanges: [[2, 3]],
            },
          ],
        },
        {
          id: "brush-speck",
          label: "Brush speck",
          enabled: true,
          meshes: [
            {
              meshNode: "ImportedFrontClump",
              triangleCount: 4,
              triangleRanges: [[0, 0]],
            },
          ],
        },
      ],
    };

    const result = await authorHairImportProposal(input);
    expect(result.proposal.chains).toHaveLength(1);
    expect(result.proposal.motionRegions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "Front strand",
          moving: true,
          supportsMotion: true,
        }),
        expect.objectContaining({
          label: "Brush speck",
          moving: false,
          recommendedMoving: false,
          supportsMotion: false,
          explanation: expect.stringMatching(/stable interior/i),
        }),
      ]),
    );
  });

  it("authors deterministic real follower morphs and root-weighted motion through existing validators", async () => {
    const input = await inputFixture();
    const first = await authorHairImportProposal(input);
    const second = await authorHairImportProposal(input);

    expect(first.geometryGlb).toEqual(second.geometryGlb);
    expect(first.evidence).toEqual(second.evidence);
    expect(first.evidence.contract).toBe(HAIR_IMPORT_AUTHORING_CONTRACT);
    expect(first.evidence.maximumMorphDelta).toBeGreaterThan(0);
    expect(first.evidence.anchoredVertexCount).toBeGreaterThan(0);
    expect(first.evidence.fullyDynamicVertexCount).toBeGreaterThan(0);
    expect(first.proposal.weights).toMatchObject({
      anchoredLength: 0.6,
      weightCurve: 'root-to-tip-smoothstep/v1',
      defaultIntensity: 0.65,
    });
    expect(first.proposal.chains).toHaveLength(1);
    expect(first.proposal.colliders).toHaveLength(1);
    expect(parseHairFollowerDefinition(first.followerDefinition)).toEqual(
      first.followerDefinition,
    );
    expect(
      parseSecondaryMotionDefinition(first.secondaryMotionDefinition),
    ).toEqual(first.secondaryMotionDefinition);

    const parsed = parseSemanticGlb(first.geometryGlb);
    const mesh = parsed.meshes[0]!;
    const primitive = (mesh.primitives as SemanticJsonRecord[])[0]!;
    const targets = primitive.targets as SemanticJsonRecord[];
    const firstDelta = decodeSemanticGlbAccessor(parsed, targets[0]!.POSITION);
    expect(
      Math.max(...Array.from(firstDelta.values, Math.abs)),
    ).toBeGreaterThan(0);
    const attributes = primitive.attributes as SemanticJsonRecord;
    const tips = decodeSemanticGlbAccessor(parsed, attributes._BATSHAIR_TIP);
    const weights = decodeSemanticGlbAccessor(parsed, attributes.WEIGHTS_0);
    expect(Math.min(...Array.from(tips.values))).toBe(0);
    expect(Math.max(...Array.from(tips.values))).toBe(1);
    expect(weights.values[1]).toBe(0);
    expect(Math.max(...Array.from(weights.values))).toBe(1);

    const baked = bakeHairFollowerGlb({
      hairGlb: first.geometryGlb,
      definition: first.followerDefinition,
      state: { values: { head_size: 1 } },
    });
    const bakedPrimitive = (
      parseSemanticGlb(baked).meshes[0]!.primitives as SemanticJsonRecord[]
    )[0]!;
    expect(bakedPrimitive.targets).toBeUndefined();
    const embeddedMotion = await createEmbeddedSecondaryMotion(
      first.secondaryMotionDefinition,
      { values: { head_size: 0 } },
    );
    expect(() =>
      composeHairIntoAvatarGlb({
        sourceAvatarGlb: input.recipeSourceGlb,
        hairGlb: baked,
        attachment: {
          headNode: "HeadAnchor",
          authoredRootMatrix: input.fit.authoredRootMatrix,
        },
        sourceSecondaryMotion: first.secondaryMotionDefinition,
        secondaryMotion: embeddedMotion,
      }),
    ).not.toThrow();
  });

  it("fails closed with reviewable reasons when a clump root is outside the reviewed scalp cage", async () => {
    const input = await inputFixture();
    input.scalp.maximumRootDistance = 0.005;
    await expect(authorHairImportProposal(input)).rejects.toMatchObject<
      Partial<HairImportAuthoringError>
    >({
      name: "HairImportAuthoringError",
      code: "ROOT_TOO_FAR",
    });
  });

  it("normalizes a reviewed non-neutral head fit so reapplying that Appearance state preserves the fitted geometry", async () => {
    const input = await inputFixture();
    const manifest = (input.appearanceManifest as JsonRecord)
      .appearanceDials as JsonRecord;
    const neutral = manifest.neutral as JsonRecord;
    input.reviewedAppearanceState = {
      contract: APPEARANCE_DIAL_VALUES_CONTRACT,
      definitionSha256: String(manifest.definitionSha256),
      neutralId: String(neutral.id),
      neutralRecipeSha256: String(neutral.recipeSha256),
      values: { head_size: 0.5 },
      unlockedDialIds: [],
    };
    const source = parseSemanticGlb(input.canonicalHairGlb);
    const sourcePrimitive = (
      source.meshes[0]!.primitives as SemanticJsonRecord[]
    )[0]!;
    const sourcePositions = decodeSemanticGlbAccessor(
      source,
      (sourcePrimitive.attributes as SemanticJsonRecord).POSITION,
    ).values;

    const authored = await authorHairImportProposal(input);
    const baked = bakeHairFollowerGlb({
      hairGlb: authored.geometryGlb,
      definition: authored.followerDefinition,
      state: { values: { head_size: 0.5 } },
    });
    const bakedDocument = parseSemanticGlb(baked);
    const bakedPrimitive = (
      bakedDocument.meshes[0]!.primitives as SemanticJsonRecord[]
    )[0]!;
    const bakedPositions = decodeSemanticGlbAccessor(
      bakedDocument,
      (bakedPrimitive.attributes as SemanticJsonRecord).POSITION,
    ).values;
    expect(bakedPositions).toHaveLength(sourcePositions.length);
    for (let index = 0; index < sourcePositions.length; index += 1) {
      expect(bakedPositions[index]).toBeCloseTo(sourcePositions[index]!, 5);
    }
  });

  it("rejects a static follower guess instead of publishing zero morphs", async () => {
    const input = await inputFixture(true);
    await expect(authorHairImportProposal(input)).rejects.toMatchObject<
      Partial<HairImportAuthoringError>
    >({
      name: "HairImportAuthoringError",
      code: "NO_FOLLOWER_DEFORMATION",
    });
  });

  it("authors canonical triangle-soup OBJ seams through the same intake-to-authoring path", async () => {
    const source = new TextEncoder().encode(`o ImportedFrontClump
v -0.025 1.66 0
v 0.025 1.66 0
v -0.035 1.84 0.005
v 0.035 1.84 0.005
v -0.045 2.02 0.015
v 0.045 2.02 0.015
f 1 2 3
f 2 4 3
f 3 4 5
f 4 6 5
`);
    const input = await inputFixture();
    const canonical = canonicalizeHairImportSelection({ bytes: source });
    input.canonicalHairGlb = canonical.glbBytes;
    input.clumps[0]!.meshNode = String(
      parseSemanticGlb(canonical.glbBytes).nodes.find(
        (node) => node.mesh !== undefined,
      )!.name,
    );

    const authored = await authorHairImportProposal(input);

    const document = parseSemanticGlb(authored.geometryGlb);
    const primitive = (
      document.meshes[0]!.primitives as SemanticJsonRecord[]
    )[0]!;
    const positions = decodeSemanticGlbAccessor(
      document,
      (primitive.attributes as SemanticJsonRecord).POSITION,
    ).values;
    const groups = new Map<string, number[]>();
    for (let vertex = 0; vertex < positions.length / 3; vertex += 1) {
      const offset = vertex * 3;
      const key = `${positions[offset]!.toFixed(7)}:${positions[offset + 1]!.toFixed(7)}:${positions[offset + 2]!.toFixed(7)}`;
      const group = groups.get(key);
      if (group) group.push(vertex);
      else groups.set(key, [vertex]);
    }
    const seams = Array.from(groups.values()).filter(
      (group) => group.length > 1,
    );
    expect(seams.length).toBeGreaterThan(0);
    for (const target of primitive.targets as SemanticJsonRecord[]) {
      const deltas = decodeSemanticGlbAccessor(
        document,
        target.POSITION,
      ).values;
      for (const seam of seams) {
        const representative = seam[0]! * 3;
        for (const vertex of seam.slice(1)) {
          const offset = vertex * 3;
          expect(deltas[offset]).toBe(deltas[representative]);
          expect(deltas[offset + 1]).toBe(deltas[representative + 1]);
          expect(deltas[offset + 2]).toBe(deltas[representative + 2]);
        }
      }
    }

    expect(authored.proposal.chains).toHaveLength(1);
    expect(authored.evidence.anchoredVertexCount).toBeGreaterThan(0);
    expect(authored.evidence.fullyDynamicVertexCount).toBeGreaterThan(0);
  });

  it("keeps sub-5 mm decorative islands explicitly anchored and visible in evidence", async () => {
    const input = await inputFixture();
    input.canonicalHairGlb = makeHairGlb(true);
    input.clumps[0]!.maximumConnectedComponents = 2;

    const authored = await authorHairImportProposal(input);

    expect(authored.evidence).toMatchObject({
      anchoredMicroComponentCount: 1,
      anchoredMicroVertexCount: 3,
    });
    expect(authored.proposal.summary.join(" ")).toMatch(
      /explicitly root-anchored/,
    );
    expect(authored.proposal.clumps[0]).toMatchObject({
      anchoredMicroComponentCount: 1,
      anchoredMicroVertexCount: 3,
    });
  });

  it("keeps a sub-5 mm distal region anchored instead of emitting an invalid motion chain", async () => {
    const input = await inputFixture();
    input.canonicalHairGlb = makeMixedMotionSupportHairGlb();
    input.clumps = [
      {
        id: "ImportedMoving",
        meshNode: "ImportedMovingClump",
        collisionGroups: ["head"],
        maximumConnectedComponents: 1,
      },
      {
        id: "ImportedAnchored",
        meshNode: "ImportedAnchoredDetail",
        collisionGroups: ["head"],
        maximumConnectedComponents: 1,
      },
    ];

    const authored = await authorHairImportProposal(input);

    expect(authored.proposal.chains).toHaveLength(1);
    expect(authored.evidence.motionChainCount).toBe(1);
    expect(authored.proposal.motionRegions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "ImportedMoving:region-001",
          moving: true,
          supportsMotion: true,
        }),
        expect.objectContaining({
          id: "ImportedAnchored:region-001",
          moving: false,
          recommendedMoving: false,
          supportsMotion: false,
          explanation: expect.stringMatching(/too short.*stable motion chain/i),
        }),
      ]),
    );
    const document = parseSemanticGlb(authored.geometryGlb);
    const movingNode = document.nodes.find(
      (node) => node.name === "ImportedMovingClump",
    )!;
    const anchoredNode = document.nodes.find(
      (node) => node.name === "ImportedAnchoredDetail",
    )!;
    const movingPrimitive = (
      document.meshes[Number(movingNode.mesh)]!.primitives as SemanticJsonRecord[]
    )[0]!;
    const anchoredPrimitive = (
      document.meshes[Number(anchoredNode.mesh)]!.primitives as SemanticJsonRecord[]
    )[0]!;
    expect(movingNode.skin).toBe(0);
    expect(movingPrimitive.attributes).toMatchObject({
      JOINTS_0: expect.any(Number),
      WEIGHTS_0: expect.any(Number),
      _BATSHAIR_TIP: expect.any(Number),
    });
    expect(anchoredNode.skin).toBeUndefined();
    expect(anchoredPrimitive.attributes).not.toHaveProperty("JOINTS_0");
    expect(anchoredPrimitive.attributes).not.toHaveProperty("WEIGHTS_0");
    expect(anchoredPrimitive.attributes).not.toHaveProperty("_BATSHAIR_TIP");

    input.motion.regionSelections = authored.proposal.motionRegions.map((region) => ({
      id: region.id,
      moving: true,
    }));
    await expect(authorHairImportProposal(input)).rejects.toMatchObject<
      Partial<HairImportAuthoringError>
    >({
      name: "HairImportAuthoringError",
      code: "INVALID_MOTION",
      blockingReasons: [
        "motion region ImportedAnchored:region-001 is too short to support a stable motion chain",
      ],
    });
  });

  it("discovers complete persistent strand basins before applying the protected-root gradient", async () => {
    const input = await inputFixture();
    input.canonicalHairGlb = makeBranchedHairGlb();

    const authored = await authorHairImportProposal(input);
    const regions = authored.proposal.motionRegions.filter(
      (region) => region.supportsMotion,
    );

    expect(regions).toHaveLength(2);
    expect(regions.every((region) => region.moving)).toBe(true);
    expect(regions.every((region) => region.label.includes("strand"))).toBe(true);
    const tipXs = regions.map((region) => region.tip[0]).sort((a, b) => a - b);
    expect(tipXs[0]).toBeLessThan(-0.05);
    expect(tipXs[1]).toBeGreaterThan(0.05);
    expect(Math.min(...regions.map((region) => region.lengthMeters))).toBeGreaterThan(
      SECONDARY_MOTION_MIN_REST_LENGTH_METERS,
    );
    expect(authored.proposal.chains).toHaveLength(2);

    const document = parseSemanticGlb(authored.geometryGlb);
    const primitive = document.meshes[0]!.primitives[0] as SemanticJsonRecord;
    const attributes = primitive.attributes as SemanticJsonRecord;
    const joints = decodeSemanticGlbAccessor(document, attributes.JOINTS_0).values;
    const tipWeights = decodeSemanticGlbAccessor(
      document,
      attributes._BATSHAIR_TIP,
    ).values;
    for (const slot of [1, 2]) {
      const selectedVertices = Array.from(
        { length: tipWeights.length },
        (_, vertex) => vertex,
      ).filter((vertex) => joints[vertex * 4 + 1] === slot);
      expect(selectedVertices.length).toBeGreaterThan(0);
      expect(selectedVertices.some((vertex) => tipWeights[vertex] === 0)).toBe(
        true,
      );
      expect(selectedVertices.some((vertex) => tipWeights[vertex]! > 0)).toBe(
        true,
      );
    }
  });
});
