import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { describe, expect, it } from "vitest";
import {
  APPEARANCE_CLIP_REMAP_CONTRACT,
  APPEARANCE_DIALS_CONTRACT,
  APPEARANCE_DIAL_VALUES_CONTRACT,
  APPEARANCE_FIT_EVIDENCE_CONTRACT,
  APPEARANCE_FOLLOWER_CONTRACT,
  APPEARANCE_JOINT_FOLLOW_CONTRACT,
  APPEARANCE_PRODUCT_RESOLUTION_CONTRACT,
} from "../appearanceDials.contracts";
import { AppearanceDialsEngineRuntime } from "../appearanceDials.engine";
import { parseAppearanceDialsManifest } from "../appearanceDials.schema";
import { resolveAppearanceDialState } from "../appearanceDials.values";
import { evaluateAppearanceRecipePhysicalOutput } from "./appearanceRecipePhysicalEvaluator";
import { buildAppearanceRecipePhysicalBasisFromGlb } from "./appearanceRecipePhysicalModel";
import {
  getSemanticGlbNode,
  parseSemanticGlb,
  semanticGlbRuntimeNodeName,
} from "./semanticGlb";

type JsonRecord = Record<string, any>;

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);
const HASH_E = "e".repeat(64);
const HASH_F = "f".repeat(64);
const ENCODER = new TextEncoder();

function makeGlb(gltf: JsonRecord, binary: Uint8Array): Uint8Array {
  const json = ENCODER.encode(JSON.stringify(gltf));
  const jsonLength = Math.ceil(json.byteLength / 4) * 4;
  const binaryLength = Math.ceil(binary.byteLength / 4) * 4;
  const result = new Uint8Array(12 + 8 + jsonLength + 8 + binaryLength);
  const view = new DataView(result.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, result.byteLength, true);
  view.setUint32(12, jsonLength, true);
  view.setUint32(16, 0x4e4f534a, true);
  result.fill(0x20, 20, 20 + jsonLength);
  result.set(json, 20);
  const binaryHeader = 20 + jsonLength;
  view.setUint32(binaryHeader, binaryLength, true);
  view.setUint32(binaryHeader + 4, 0x004e4942, true);
  result.set(binary, binaryHeader + 8);
  return result;
}

class Accessors {
  readonly bytes: number[] = [];
  readonly bufferViews: JsonRecord[] = [];
  readonly accessors: JsonRecord[] = [];

  private align() {
    while (this.bytes.length % 4 !== 0) this.bytes.push(0);
  }

  private view(payload: Uint8Array, byteStride?: number) {
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

  floatVec3(values: number[], stride = 12) {
    const count = values.length / 3;
    const payload = new Uint8Array(count * stride);
    const view = new DataView(payload.buffer);
    values.forEach((value, index) => {
      view.setFloat32(
        Math.floor(index / 3) * stride + (index % 3) * 4,
        value,
        true,
      );
    });
    const bufferView = this.view(payload, stride === 12 ? undefined : stride);
    const accessor = this.accessors.length;
    this.accessors.push({
      bufferView,
      componentType: 5126,
      count,
      type: "VEC3",
      min: [0, 1, 2].map((component) =>
        Math.min(
          ...Array.from(
            { length: count },
            (_, row) => values[row * 3 + component]!,
          ),
        ),
      ),
      max: [0, 1, 2].map((component) =>
        Math.max(
          ...Array.from(
            { length: count },
            (_, row) => values[row * 3 + component]!,
          ),
        ),
      ),
    });
    return accessor;
  }

  floatVec4(values: number[]) {
    const payload = new Uint8Array(values.length * 4);
    const view = new DataView(payload.buffer);
    values.forEach((value, index) => view.setFloat32(index * 4, value, true));
    const bufferView = this.view(payload);
    const accessor = this.accessors.length;
    this.accessors.push({
      bufferView,
      componentType: 5126,
      count: values.length / 4,
      type: "VEC4",
    });
    return accessor;
  }

  u16Vec4(values: number[]) {
    const payload = new Uint8Array(values.length * 2);
    const view = new DataView(payload.buffer);
    values.forEach((value, index) => view.setUint16(index * 2, value, true));
    const bufferView = this.view(payload);
    const accessor = this.accessors.length;
    this.accessors.push({
      bufferView,
      componentType: 5123,
      count: values.length / 4,
      type: "VEC4",
    });
    return accessor;
  }

  sparseFloatVec3(count: number, row: number, value: number[]) {
    const indices = this.view(Uint8Array.from([row]));
    const payload = new Uint8Array(12);
    const view = new DataView(payload.buffer);
    value.forEach((entry, index) => view.setFloat32(index * 4, entry, true));
    const values = this.view(payload);
    const accessor = this.accessors.length;
    this.accessors.push({
      componentType: 5126,
      count,
      type: "VEC3",
      min: value.map((entry) => Math.min(0, entry)),
      max: value.map((entry) => Math.max(0, entry)),
      sparse: {
        count: 1,
        indices: { bufferView: indices, componentType: 5121 },
        values: { bufferView: values },
      },
    });
    return accessor;
  }

  matrices(count: number) {
    const payload = new Uint8Array(count * 16 * 4);
    const view = new DataView(payload.buffer);
    for (let matrix = 0; matrix < count; matrix += 1) {
      for (const diagonal of [0, 5, 10, 15]) {
        view.setFloat32((matrix * 16 + diagonal) * 4, 1, true);
      }
    }
    const bufferView = this.view(payload);
    const accessor = this.accessors.length;
    this.accessors.push({
      bufferView,
      componentType: 5126,
      count,
      type: "MAT4",
    });
    return accessor;
  }
}

function packageGlb(
  options: {
    shear?: boolean;
    nonzeroWeight?: boolean;
    duplicateJoint?: boolean;
    extraRecipePrimitive?: boolean;
    alignedRecipePrimitive?: boolean;
    unboundOffset?: number;
    missingUnboundPosition?: boolean;
    omitInactiveMalformedSkin?: boolean;
  } = {},
) {
  const data = new Accessors();
  const neutral = [0, 0, 0, 1, 0, 0, 0, 1, 0];
  const bodyBase = data.floatVec3(neutral, 16);
  const bodyShape = data.sparseFloatVec3(3, 1, [0.5, 0, 0]);
  const bodyCorrective = data.floatVec3([0, 0.1, 0, 0, 0.1, 0, 0, 0.1, 0]);
  const unboundNeutral = [...neutral];
  unboundNeutral[0] = options.unboundOffset ?? 0;
  const unboundBase = data.floatVec3(unboundNeutral);
  const followerBase = data.floatVec3(neutral);
  const followerShape = data.floatVec3([0.25, 0, 0, 0.25, 0, 0, 0.25, 0, 0]);
  const bodyJoints = data.u16Vec4([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const bodyWeights = data.floatVec4([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]);
  const inverseBinds = data.matrices(6);
  const binary = Uint8Array.from(data.bytes);
  const simpleMesh = {
    primitives: [
      {
        attributes: options.missingUnboundPosition
          ? {}
          : { POSITION: unboundBase },
      },
    ],
  };
  const nodes: JsonRecord[] = [
    options.shear
      ? {
          matrix: [1, 0, 0, 0, 0.25, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
          children: [1, 6],
        }
      : { children: [1, 6] },
    { name: "mixamorig:Hips", translation: [0, 1, 0], children: [2, 9, 12] },
    { name: "Neck", translation: [0, 1, 0], children: [3] },
    { name: "Head", translation: [0, 1, 0], children: [4, 5, 7, 8, 11, 13] },
    { name: "LeftEye", children: [14, 15, 16, 17] },
    { name: "RightEye", children: [18, 19, 20, 21] },
    { name: "Body", mesh: 0, skin: 0 },
    { name: "FollowerMesh", mesh: 1 },
    { name: "FollowerAnchor", children: [10] },
    { name: "FeetAnchor" },
    { name: "Attachment" },
    { name: "HeadAnchor" },
    { name: "HipsAnchor" },
    { name: "Jaw" },
    { name: "LeftSclera", mesh: 2 },
    { name: "LeftCornea", mesh: 2 },
    { name: "LeftIris", mesh: 2 },
    { name: "LeftPupil", mesh: 2 },
    { name: "RightSclera", mesh: 2 },
    { name: "RightCornea", mesh: 2 },
    { name: "RightIris", mesh: 2 },
    { name: "RightPupil", mesh: 2 },
    { name: "Detached" },
  ];
  return makeGlb(
    {
      asset: { version: "2.0" },
      scene: 0,
      scenes: [{ nodes: [0] }],
      buffers: [{ byteLength: binary.byteLength }],
      bufferViews: data.bufferViews,
      accessors: data.accessors,
      nodes,
      meshes: [
        {
          extras: { targetNames: ["shape", "corrective"] },
          weights: [options.nonzeroWeight ? 0.1 : 0, 0],
          primitives: [
            {
              attributes: {
                POSITION: bodyBase,
                JOINTS_0: bodyJoints,
                WEIGHTS_0: bodyWeights,
              },
              targets: [{ POSITION: bodyShape }, { POSITION: bodyCorrective }],
            },
            ...(options.extraRecipePrimitive
              ? [{ attributes: { POSITION: bodyBase } }]
              : []),
            ...(options.alignedRecipePrimitive
              ? [
                  {
                    attributes: {
                      POSITION: bodyBase,
                      JOINTS_0: bodyJoints,
                      WEIGHTS_0: bodyWeights,
                    },
                    targets: [
                      { POSITION: bodyShape },
                      { POSITION: bodyCorrective },
                    ],
                  },
                ]
              : []),
          ],
        },
        {
          extras: { targetNames: ["follow_shape"] },
          weights: [0],
          primitives: [
            {
              attributes: { POSITION: followerBase },
              targets: [{ POSITION: followerShape }],
            },
          ],
        },
        simpleMesh,
      ],
      skins: [
        {
          skeleton: 1,
          joints: [1, 2, 3, 4, 5, options.duplicateJoint ? 5 : 13],
          inverseBindMatrices: inverseBinds,
        },
        ...(options.omitInactiveMalformedSkin
          ? []
          : [{ joints: [999], inverseBindMatrices: 999 }]),
      ],
    },
    binary,
  );
}

function provenance(componentId: string) {
  return {
    catalogId: `fixture.${componentId}`,
    componentId,
    license: "CC0-1.0",
    reviewStatus: "approved",
    contentSha256: HASH_A,
  };
}

function samples(kind: "translate" | "identity") {
  return [-1, 0, 1].map((input) => ({
    input,
    translation: kind === "translate" ? [input * 0.1, 0, 0] : [0, 0, 0],
    rotation: [0, 0, 0, 1],
    scale: [1, 1, 1],
    pivot: [0, 0, 0],
  }));
}

function axis(direction: [number, number, number]) {
  return {
    axis: direction,
    sign: 1,
    rangeDegrees: { negative: 40, positive: 40 },
  };
}

function performanceRig() {
  const look = (node: string) => ({
    node,
    yaw: axis([0, 1, 0]),
    pitch: axis([1, 0, 0]),
  });
  return {
    contract: "batshit-performance-rig/v1",
    space: "node-parent-rest",
    rotation: {
      representation: "rotation-vector",
      units: "radians",
      composition: "ordered-expmap/v1",
    },
    nodes: {
      head: look("Head"),
      neck: look("Neck"),
      leftEye: look("LeftEye"),
      rightEye: look("RightEye"),
    },
    look: {
      headYawShares: { head: 0.7, neck: 0.3 },
      headPitchShares: { head: 0.7, neck: 0.3 },
      eyeYawMode: "asymmetric-in-out",
      eyePitchMode: "asymmetric-up-down",
    },
    targetTransforms: {
      jaw: {
        node: "Jaw",
        combine: "translation-sum-rotation-vector-sum/v1",
        channels: {
          jawOpen: {
            translation: [0, -0.02, 0],
            rotationVector: [0.2, 0, 0],
          },
        },
      },
    },
  };
}

function avatarManifest(): JsonRecord {
  return {
    stage: {
      anchors: {
        head: "HeadAnchor",
        hips: "HipsAnchor",
        feet: "FeetAnchor",
      },
    },
    rig: {
      performance: performanceRig(),
      correctives: { entries: [{ target: "corrective" }] },
    },
    appearanceDials: {
      contract: APPEARANCE_DIALS_CONTRACT,
      definitionSha256: HASH_C,
      neutral: { id: "fixture-neutral", recipeSha256: HASH_D },
      productResolution: {
        contract: APPEARANCE_PRODUCT_RESOLUTION_CONTRACT,
        catalogSha256: HASH_A,
        policySha256: HASH_B,
        resolutionSha256: HASH_E,
      },
      fitEvidence: {
        contract: APPEARANCE_FIT_EVIDENCE_CONTRACT,
        definitionSha256: HASH_C,
        modelSha256: HASH_D,
        scenarioSetSha256: HASH_E,
        eyeReportSha256: HASH_A,
        oralReportSha256: HASH_B,
        facialArtworkDefinitionSha256: HASH_F,
        facialArtworkContractFileSha256: HASH_E,
        facialArtworkProofSha256: HASH_D,
      },
      nodes: {
        body: {
          node: "Body",
          kind: "mesh",
          role: "body",
          side: "none",
          required: true,
          scalePolicy: "any",
          exactNodeMatches: 1,
        },
        follower_mesh: {
          node: "FollowerMesh",
          kind: "mesh",
          role: "generic-follower",
          side: "none",
          required: true,
          scalePolicy: "any",
          parent: { kind: "bone", name: "Head" },
          exactNodeMatches: 1,
        },
        follower_anchor: {
          node: "FollowerAnchor",
          kind: "anchor",
          role: "generic-follower",
          side: "none",
          required: true,
          scalePolicy: "any",
          parent: { kind: "bone", name: "Head" },
          exactNodeMatches: 1,
        },
        attachment: {
          node: "Attachment",
          kind: "anchor",
          role: "attachment-anchor",
          side: "none",
          required: true,
          scalePolicy: "any",
          parent: { kind: "node", id: "follower_anchor" },
          exactNodeMatches: 1,
        },
        optional_anchor: {
          node: "OptionalAnchor",
          kind: "anchor",
          role: "generic-follower",
          side: "none",
          required: false,
          scalePolicy: "any",
          exactNodeMatches: 1,
        },
        optional_mesh: {
          node: "OptionalMesh",
          kind: "mesh",
          role: "generic-follower",
          side: "none",
          required: false,
          scalePolicy: "any",
          exactNodeMatches: 1,
        },
      },
      regions: [
        { id: "body", label: "Body", surface: "body", order: 0 },
        { id: "head", label: "Head", surface: "head-face", order: 0 },
      ],
      targets: {
        shape: {
          usages: ["identity"],
          runtimeRetention: "recipe-only",
          side: "none",
          bindings: [{ node: "body", morph: "shape" }],
          baselineValue: 0,
          influenceMin: -1,
          influenceMax: 1,
          combine: "exclusive",
          impact: "structural",
          soleDeltaY: 0.25,
          requirements: { jointFollow: true, followerRefs: ["fit"] },
          provenance: provenance("shape"),
        },
        corrective: {
          usages: ["identity", "pose-corrective"],
          runtimeRetention: "retain-in-live-goon",
          side: "none",
          bindings: [{ node: "body", morph: "corrective" }],
          baselineValue: 0,
          influenceMin: -1,
          influenceMax: 1,
          combine: "exclusive",
          impact: "surface",
          provenance: provenance("corrective"),
        },
      },
      dials: [
        {
          id: "shape",
          label: "Shape",
          region: "head",
          tier: "core",
          order: 0,
          description: "Shape.",
          keywords: ["shape"],
          kind: "tracks",
          range: [-1, 1],
          default: 0,
          step: 0.01,
          members: [
            {
              target: "shape",
              track: [
                [-1, -1],
                [0, 0],
                [1, 1],
              ],
            },
          ],
        },
        {
          id: "corrective",
          label: "Corrective",
          region: "head",
          tier: "detail",
          order: 1,
          description: "Corrective.",
          keywords: ["corrective"],
          kind: "tracks",
          range: [-1, 1],
          default: 0,
          step: 0.01,
          members: [
            {
              target: "corrective",
              track: [
                [-1, -1],
                [0, 0],
                [1, 1],
              ],
            },
          ],
        },
        {
          id: "height",
          label: "Height",
          region: "body",
          tier: "core",
          order: 2,
          description: "Height.",
          keywords: ["height"],
          kind: "root-scale",
          range: [-1, 1],
          default: 0,
          step: 0.01,
          scalePerUnit: 0.1,
        },
      ],
      jointFollow: {
        contract: APPEARANCE_JOINT_FOLLOW_CONTRACT,
        space: "avatar-root",
        units: "meters",
        restSkeletonSha256: HASH_E,
        deltas: {
          shape: {
            "mixamorig:Hips": [0, 0.5, 0],
            Head: [0, 0.2, 0],
          },
        },
        clipRemap: {
          contract: APPEARANCE_CLIP_REMAP_CONTRACT,
          hipsBone: "mixamorig:Hips",
        },
      },
      followers: {
        fit: {
          contract: APPEARANCE_FOLLOWER_CONTRACT,
          space: "node-parent-rest",
          composition: "rest-relative-follower-channel-id-order/v2",
          interpolation: "linear-trs-slerp-rotation-morph/v2",
          extrapolation: "clamp",
          provenance: {
            ...provenance("fit"),
            license: "LicenseRef-Batshit-First-Party",
          },
          nodeIds: [
            "follower_mesh",
            "follower_anchor",
            "optional_anchor",
            "optional_mesh",
          ],
          drivers: [
            {
              driver: { kind: "target", id: "shape" },
              channels: [
                {
                  id: "a-morph",
                  kind: "morph-weight",
                  node: "follower_mesh",
                  morph: "follow_shape",
                  weightRange: [-1, 1],
                  runtimeRetention: "recipe-only",
                  samples: [
                    [-1, -1],
                    [0, 0],
                    [1, 1],
                  ],
                },
                {
                  id: "b-anchor",
                  kind: "node-trs",
                  node: "follower_anchor",
                  samples: samples("translate"),
                },
                {
                  id: "c-optional-anchor",
                  kind: "node-trs",
                  node: "optional_anchor",
                  samples: samples("translate"),
                },
                {
                  id: "d-optional-morph",
                  kind: "morph-weight",
                  node: "optional_mesh",
                  morph: "optional_shape",
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

function loadGlbScene(bytes: Uint8Array): Promise<THREE.Group> {
  const buffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  return new Promise((resolveScene, reject) => {
    new GLTFLoader().parse(
      buffer,
      "",
      (gltf) => resolveScene(gltf.scene),
      reject,
    );
  });
}

function densePosition(mesh: THREE.Mesh): Float32Array {
  const attribute = mesh.geometry.getAttribute("position");
  const result = new Float32Array(attribute.count * 3);
  for (let index = 0; index < attribute.count; index += 1) {
    result[index * 3] = attribute.getX(index);
    result[index * 3 + 1] = attribute.getY(index);
    result[index * 3 + 2] = attribute.getZ(index);
  }
  return result;
}

function float32Bytes(values: Float32Array): number[] {
  return Array.from(
    new Uint8Array(values.buffer, values.byteOffset, values.byteLength),
  );
}

function expectMatrixNear(actual: number[], expected: number[]) {
  expect(actual).toHaveLength(16);
  expect(expected).toHaveLength(16);
  actual.forEach((value, index) => {
    const target = expected[index]!;
    const tolerance = Number.EPSILON * 8 * Math.max(1, Math.abs(target));
    expect(Math.abs(value - target)).toBeLessThanOrEqual(tolerance);
  });
}

describe("appearance Recipe physical GLB model", () => {
  it("builds a lazy exact basis and evaluates final package-independent physical output", () => {
    const rawManifest = avatarManifest();
    const basis = buildAppearanceRecipePhysicalBasisFromGlb(
      packageGlb(),
      rawManifest,
      {
        rootBaseMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 2, 0, 1],
      },
    );

    expect(basis.nodes).toHaveLength(22);
    expect(basis.nodes[0]).toMatchObject({ id: "node:0" });
    expect(basis.meshes.map((mesh) => [mesh.id, mesh.nodeId])).toEqual([
      ["mesh:14:0", "node:14"],
      ["mesh:15:0", "node:15"],
      ["mesh:16:0", "node:16"],
      ["mesh:17:0", "node:17"],
      ["mesh:18:0", "node:18"],
      ["mesh:19:0", "node:19"],
      ["mesh:20:0", "node:20"],
      ["mesh:21:0", "node:21"],
      ["mesh:7:0", "node:7"],
      ["mesh:6:0", "node:6"],
    ]);
    expect(
      basis.meshes.find((mesh) => mesh.id === "mesh:6:0")!.basePositions,
    ).toEqual(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]));
    const delta = basis.targetPositionBindings[0].positionDelta;
    expect(delta).not.toBeInstanceOf(Float32Array);
    if (delta instanceof Float32Array) throw new Error("expected lazy delta");
    const first: Array<[number, number]> = [];
    const second: Array<[number, number]> = [];
    delta.visit((index, value) => first.push([index, value]));
    delta.visit((index, value) => second.push([index, value]));
    expect(first).toEqual([[3, 0.5]]);
    expect(second).toEqual(first);

    expect(basis.targets.map((entry) => entry.id)).toEqual([
      "shape",
      "corrective",
    ]);
    expect(basis.targetPositionBindings[0].meshId).toBe("mesh:6:0");
    expect(basis.retainedTargetPositionBindings[0]).toMatchObject({
      id: "retained:corrective:0",
      targetId: "corrective",
      node: "body",
      morph: "corrective",
      meshId: "mesh:6:0",
    });
    const retainedDelta = basis.retainedTargetPositionBindings[0].positionDelta;
    if (retainedDelta instanceof Float32Array) {
      throw new Error("expected lazy retained delta");
    }
    const retainedValues: Array<[number, number]> = [];
    retainedDelta.visit((index, value) => retainedValues.push([index, value]));
    expect(retainedValues.map(([index]) => index)).toEqual([1, 4, 7]);
    expect(retainedValues.map(([, value]) => value)).toEqual([
      Math.fround(0.1),
      Math.fround(0.1),
      Math.fround(0.1),
    ]);
    expect(basis.followerNodeTransformBindings).toEqual([
      {
        follower: "fit",
        channel: "b-anchor",
        driver: { kind: "target", id: "shape" },
        node: "follower_anchor",
        nodeId: "node:8",
      },
      {
        follower: "fit",
        channel: "c-optional-anchor",
        driver: { kind: "target", id: "shape" },
        node: "optional_anchor",
      },
    ]);
    expect(basis.followerMorphBindings).toEqual([
      {
        follower: "fit",
        channel: "a-morph",
        driver: { kind: "target", id: "shape" },
        node: "follower_mesh",
        morph: "follow_shape",
        positionBindingIds: ["follower:fit:a-morph"],
      },
      {
        follower: "fit",
        channel: "d-optional-morph",
        driver: { kind: "target", id: "shape" },
        node: "optional_mesh",
        morph: "optional_shape",
      },
    ]);
    expect(basis.followerNodeBindings.map((entry) => entry.id)).not.toContain(
      "optional_anchor",
    );
    expect(basis.jointOffsetBindings).toEqual([
      { bone: "mixamorig:Hips", boneId: "bone:1" },
      { bone: "Head", boneId: "bone:3" },
    ]);
    expect(basis.skins[0].joints.map((entry) => entry.boneId)).toEqual([
      "bone:1",
      "bone:2",
      "bone:3",
      "bone:4",
      "bone:5",
      "bone:13",
    ]);
    expect(basis.skins).toHaveLength(1);
    expect(basis.roles.filter((role) => role.kind === "stage")).toHaveLength(3);
    expect(
      basis.roles.filter((role) => role.kind === "performance"),
    ).toHaveLength(5);
    expect(basis.roles.filter((role) => role.kind === "eye")).toHaveLength(0);
    expect(
      basis.roles.find((role) => role.kind === "attachment"),
    ).toMatchObject({
      id: "attachment",
      nodeId: "node:10",
      declaredParent: { kind: "node", id: "follower_anchor" },
    });

    const manifest = parseAppearanceDialsManifest(rawManifest)!;
    const state = resolveAppearanceDialState(manifest, {
      contract: APPEARANCE_DIAL_VALUES_CONTRACT,
      definitionSha256: manifest.definitionSha256,
      neutralId: manifest.neutral.id,
      neutralRecipeSha256: manifest.neutral.recipeSha256,
      values: { shape: 1, corrective: 1, height: 1 },
      unlockedDialIds: [],
    });
    const output = evaluateAppearanceRecipePhysicalOutput(basis, state);
    expect([
      ...output.meshes.find((mesh) => mesh.id === "mesh:6:0")!.positions,
    ]).toEqual([0, 0, 0, 1.5, 0, 0, 0, 1, 0]);
    expect([
      ...output.meshes.find((mesh) => mesh.id === "mesh:7:0")!.positions,
    ]).toEqual([0.25, 0, 0, 1.25, 0, 0, 0.25, 1, 0]);
    expect(output.retainedTargetPositionBindings).toHaveLength(1);
    expect(output.retainedTargetPositionBindings[0]).toMatchObject({
      targetId: "corrective",
      node: "body",
      morph: "corrective",
      meshId: "mesh:6:0",
      weight: 1,
    });
    expect(output.root.rootScale).toBe(1.1);
    expect(output.root.position[1]).toBeCloseTo(1.725);
    expect(output.hipsClipRemap).toMatchObject({
      bone: "mixamorigHips",
      baseRest: [0, 1, 0],
      newRest: [0, 1.5, 0],
      ratio: 1.5,
    });
  });

  it("keeps unbound active meshes in stable primitive order so neutral drift is visible", () => {
    const baseline = buildAppearanceRecipePhysicalBasisFromGlb(
      packageGlb(),
      avatarManifest(),
    );
    const drifted = buildAppearanceRecipePhysicalBasisFromGlb(
      packageGlb({ unboundOffset: 0.75 }),
      avatarManifest(),
    );
    expect(drifted.meshes.map((mesh) => mesh.id)).toEqual(
      baseline.meshes.map((mesh) => mesh.id),
    );
    expect(
      baseline.meshes.find((mesh) => mesh.id === "mesh:14:0")!.basePositions[0],
    ).toBe(0);
    expect(
      drifted.meshes.find((mesh) => mesh.id === "mesh:14:0")!.basePositions[0],
    ).toBe(0.75);
    expect(
      drifted.meshes.find((mesh) => mesh.id === "mesh:6:0")!.basePositions,
    ).toEqual(
      baseline.meshes.find((mesh) => mesh.id === "mesh:6:0")!.basePositions,
    );
  });

  it("keeps every aligned primitive of one Recipe mesh as an independent material owner", () => {
    const basis = buildAppearanceRecipePhysicalBasisFromGlb(
      packageGlb({ alignedRecipePrimitive: true }),
      avatarManifest(),
    );
    expect(basis.meshes.map((mesh) => mesh.id)).toContain("mesh:6:1");
    expect(
      basis.targetPositionBindings.filter((binding) => binding.targetId === "shape"),
    ).toMatchObject([
      { id: "target:shape:0:0", meshId: "mesh:6:0" },
      { id: "target:shape:0:1", meshId: "mesh:6:1" },
    ]);
    expect(
      basis.retainedTargetPositionBindings.filter(
        (binding) => binding.targetId === "corrective",
      ),
    ).toMatchObject([
      { id: "retained:corrective:0:0", meshId: "mesh:6:0" },
      { id: "retained:corrective:0:1", meshId: "mesh:6:1" },
    ]);
  });

  it("rejects nonzero Recipe ownership and inactive-scene role references", () => {
    expect(() =>
      buildAppearanceRecipePhysicalBasisFromGlb(
        packageGlb({ nonzeroWeight: true }),
        avatarManifest(),
      ),
    ).toThrow(/nonzero initial weight/);

    const inactive = avatarManifest();
    inactive.stage.anchors.head = "Detached";
    expect(() =>
      buildAppearanceRecipePhysicalBasisFromGlb(packageGlb(), inactive),
    ).toThrow(/outside the active GLB scene/);
  });

  it("rejects shear and malformed present behavior blocks instead of approximating them", () => {
    expect(() =>
      buildAppearanceRecipePhysicalBasisFromGlb(
        packageGlb({ shear: true }),
        avatarManifest(),
      ),
    ).toThrow(/shear|non-TRS/);

    const malformed = avatarManifest();
    malformed.rig.performance.contract = "batshit-performance-rig/v2";
    expect(() =>
      buildAppearanceRecipePhysicalBasisFromGlb(packageGlb(), malformed),
    ).toThrow(/malformed rig\.performance/);
  });

  it("ignores inactive malformed skins but rejects active slot and primitive ambiguity", () => {
    expect(
      buildAppearanceRecipePhysicalBasisFromGlb(packageGlb(), avatarManifest())
        .skins,
    ).toHaveLength(1);
    expect(() =>
      buildAppearanceRecipePhysicalBasisFromGlb(
        packageGlb({ duplicateJoint: true }),
        avatarManifest(),
      ),
    ).toThrow(/repeats joint node|repeats a joint slot/);
    expect(() =>
      buildAppearanceRecipePhysicalBasisFromGlb(
        packageGlb({ extraRecipePrimitive: true }),
        avatarManifest(),
      ),
    ).toThrow(/morph target names and payloads are misaligned/);
    expect(() =>
      buildAppearanceRecipePhysicalBasisFromGlb(
        packageGlb({ missingUnboundPosition: true }),
        avatarManifest(),
      ),
    ).toThrow(/missing POSITION/);
  });

  it("preserves optional omissions but never loses target or parent ownership", () => {
    const optional = buildAppearanceRecipePhysicalBasisFromGlb(
      packageGlb(),
      avatarManifest(),
    );
    expect(optional.followerNodeTransformBindings[1]).not.toHaveProperty(
      "nodeId",
    );
    expect(optional.followerMorphBindings[1]).not.toHaveProperty(
      "positionBindingIds",
    );

    const target = avatarManifest();
    target.appearanceDials.targets.shape.bindings[0].node = "optional_mesh";
    expect(() =>
      buildAppearanceRecipePhysicalBasisFromGlb(packageGlb(), target),
    ).toThrow(/Recipe binding references missing appearance node/);

    const attachment = avatarManifest();
    attachment.appearanceDials.nodes.attachment.node = "OptionalAttachment";
    attachment.appearanceDials.nodes.attachment.required = false;
    expect(
      buildAppearanceRecipePhysicalBasisFromGlb(packageGlb(), attachment).roles,
    ).not.toContainEqual(expect.objectContaining({ id: "attachment" }));

    const missingParent = avatarManifest();
    missingParent.appearanceDials.nodes.attachment.parent = {
      kind: "node",
      id: "optional_anchor",
    };
    expect(() =>
      buildAppearanceRecipePhysicalBasisFromGlb(packageGlb(), missingParent),
    ).toThrow(/references missing appearance parent optional_anchor/);
  });

  it("matches the live Three runtime through a non-neutral active-neutral-active cycle", async () => {
    const glb = packageGlb({ omitInactiveMalformedSkin: true });
    const rawManifest = avatarManifest();
    const manifest = parseAppearanceDialsManifest(rawManifest)!;
    const activeValues = {
      contract: APPEARANCE_DIAL_VALUES_CONTRACT,
      definitionSha256: manifest.definitionSha256,
      neutralId: manifest.neutral.id,
      neutralRecipeSha256: manifest.neutral.recipeSha256,
      values: { shape: 1, corrective: 0.6, height: 1 },
      unlockedDialIds: [],
    };
    const basis = buildAppearanceRecipePhysicalBasisFromGlb(glb, rawManifest);
    const expectedActive = evaluateAppearanceRecipePhysicalOutput(
      basis,
      resolveAppearanceDialState(manifest, activeValues),
    );
    const expectedNeutral = evaluateAppearanceRecipePhysicalOutput(
      basis,
      resolveAppearanceDialState(manifest, null),
    );
    const scene = await loadGlbScene(glb);
    const runtime = new AppearanceDialsEngineRuntime(scene, rawManifest, {
      initialValues: activeValues,
    });
    const semantic = parseSemanticGlb(glb);
    const physicalName = (physicalNodeId: string) => {
      const index = Number(physicalNodeId.slice("node:".length));
      const rawName = getSemanticGlbNode(semantic, index, physicalNodeId).name;
      if (typeof rawName !== "string") {
        throw new Error(`${physicalNodeId} has no runtime name`);
      }
      return semanticGlbRuntimeNodeName(rawName);
    };
    const boneNameById = new Map(
      basis.bones.map((bone) => [bone.id, bone.name]),
    );

    const assertParity = (
      expected: ReturnType<typeof evaluateAppearanceRecipePhysicalOutput>,
    ) => {
      scene.updateMatrixWorld(true);
      const liveMeshes: THREE.Mesh[] = [];
      scene.traverse((node) => {
        if ((node as { isMesh?: boolean }).isMesh) {
          liveMeshes.push(node as THREE.Mesh);
        }
      });
      const expectedMeshes = basis.meshes.map((mesh, index) => ({
        name: physicalName(mesh.nodeId),
        bytes: float32Bytes(expected.meshes[index]!.positions),
      }));
      const liveMeshSnapshot = liveMeshes.map((mesh) => ({
        name: mesh.name,
        bytes: float32Bytes(densePosition(mesh)),
      }));
      expect(liveMeshSnapshot).toEqual(expectedMeshes);

      const liveJointSnapshot = expected.jointRests.map((joint) => {
        const bone = scene.getObjectByName(joint.bone);
        if (!bone) throw new Error(`missing live bone ${joint.bone}`);
        expect(bone.position.toArray()).toEqual(joint.localPosition);
        expect(bone.matrix.toArray()).toEqual(joint.localMatrix);
        return {
          bone: joint.bone,
          localMatrix: bone.matrix.toArray(),
        };
      });

      const body = scene.getObjectByName("Body") as THREE.SkinnedMesh;
      const expectedSkin = expected.skins[0]!;
      const liveSkinSnapshot = body.skeleton.bones.map((bone, index) => ({
        bone: bone.name,
        inverseBindMatrix: body.skeleton.boneInverses[index]!.toArray(),
      }));
      expect(liveSkinSnapshot).toEqual(
        expectedSkin.joints.map((joint) => ({
          bone: boneNameById.get(joint.boneId),
          inverseBindMatrix: joint.inverseBindMatrix,
        })),
      );

      const liveFollowerSnapshot = basis.followerNodeTransformBindings
        .filter(
          (binding): binding is typeof binding & { nodeId: string } =>
            binding.nodeId !== undefined,
        )
        .map((binding) => {
          const node = scene.getObjectByName(
            manifest.nodes[binding.node]!.node,
          );
          if (!node) throw new Error(`missing live follower ${binding.node}`);
          const expectedNode = expected.nodes.find(
            (candidate) => candidate.id === binding.nodeId,
          )!;
          expect(node.matrix.toArray()).toEqual(expectedNode.localMatrix);
          return {
            node: binding.node,
            localMatrix: node.matrix.toArray(),
          };
        });

      expect(scene.position.toArray()).toEqual(expected.root.position);
      expect(scene.quaternion.toArray()).toEqual(expected.root.rotation);
      expect(scene.scale.toArray()).toEqual(expected.root.scale);
      expect(scene.matrix.toArray()).toEqual(expected.root.matrix);

      const liveRoleSnapshot = basis.roles.map((role) => {
        const node = scene.getObjectByName(physicalName(role.nodeId));
        if (!node) throw new Error(`missing live role ${role.kind}/${role.id}`);
        const expectedRole = expected.roles.find(
          (candidate) =>
            candidate.kind === role.kind && candidate.id === role.id,
        )!;
        expectMatrixNear(node.matrixWorld.toArray(), expectedRole.worldMatrix);
        return {
          kind: role.kind,
          id: role.id,
          worldMatrix: node.matrixWorld.toArray(),
        };
      });

      const correctiveIndex = body.morphTargetDictionary?.corrective;
      if (correctiveIndex === undefined) {
        throw new Error("live retained corrective lost its morph index");
      }
      const expectedRetained = expected.retainedTargetPositionBindings.find(
        (binding) => binding.targetId === "corrective",
      )!;
      expect(body.morphTargetInfluences?.[correctiveIndex]).toBe(
        expectedRetained.weight,
      );

      return {
        meshes: liveMeshSnapshot,
        joints: liveJointSnapshot,
        skin: liveSkinSnapshot,
        followers: liveFollowerSnapshot,
        root: scene.matrix.toArray(),
        roles: liveRoleSnapshot,
        retainedWeight: body.morphTargetInfluences?.[correctiveIndex],
      };
    };

    const firstActive = assertParity(expectedActive);
    runtime.setValues(null);
    assertParity(expectedNeutral);
    runtime.setValues(activeValues);
    expect(assertParity(expectedActive)).toEqual(firstActive);
  });
});
