import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import {
  APPEARANCE_CLIP_REMAP_CONTRACT,
  APPEARANCE_DIALS_CONTRACT,
  APPEARANCE_DIAL_VALUES_CONTRACT,
  APPEARANCE_FIT_EVIDENCE_CONTRACT,
  APPEARANCE_FOLLOWER_CONTRACT,
  APPEARANCE_JOINT_FOLLOW_CONTRACT,
  APPEARANCE_PRODUCT_RESOLUTION_CONTRACT,
  type AppearanceDialValueState,
  type AppearanceDialsManifest,
} from "./appearanceDials";
import { AppearanceDialsEngineRuntime } from "./appearanceDials.engine";
import type { GoonCustomAvatarManifest } from "./customAvatar";
import type { AppearanceRecipePhysicalBasis } from "./recipe/appearanceRecipePhysicalEvaluator";
import {
  ORAL_CAVITY_ANATOMY_FIT_SOLVER,
  type AnatomyFitResult,
} from "./recipe/anatomyFitContracts";
import { parseFirstPartySocketEyePackage } from "./socketEyePackage";

vi.mock("./socketEyePackage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./socketEyePackage")>();
  return {
    ...actual,
    parseFirstPartySocketEyePackage: vi.fn(
      actual.parseFirstPartySocketEyePackage,
    ),
  };
});

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);
const HASH_E = "e".repeat(64);
const HASH_F = "f".repeat(64);

function provenance(componentId: string) {
  return {
    catalogId: `mh.core.fixture.${componentId}`,
    componentId,
    license: "CC0-1.0",
    reviewStatus: "approved",
    contentSha256: HASH_A,
    containerSha256: HASH_B,
  };
}

function samples(kind: "scale" | "translation") {
  return [-1, 0, 1].map((input) => ({
    input,
    translation: kind === "translation" ? [input * 0.1, 0, 0] : [0, 0, 0],
    rotation: [0, 0, 0, 1],
    scale:
      kind === "scale"
        ? [1 + input * 0.5, 1 + input * 0.5, 1 + input * 0.5]
        : [1, 1, 1],
    pivot: [0, 0, 0],
  }));
}

function performanceRig(nodes: {
  head: string;
  neck: string;
  leftEye: string;
  rightEye: string;
  target: string;
}) {
  const axis = (direction: [number, number, number]) => ({
    axis: direction,
    sign: 1,
    rangeDegrees: { negative: 40, positive: 40 },
  });
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
      head: look(nodes.head),
      neck: look(nodes.neck),
      leftEye: look(nodes.leftEye),
      rightEye: look(nodes.rightEye),
    },
    look: {
      headYawShares: { head: 0.7, neck: 0.3 },
      headPitchShares: { head: 0.7, neck: 0.3 },
      eyeYawMode: "asymmetric-in-out",
      eyePitchMode: "asymmetric-up-down",
    },
    targetTransforms: {
      jaw: {
        node: nodes.target,
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

function buildManifest(): GoonCustomAvatarManifest {
  return {
    contractVersion: 2,
    face: {
      mesh: "Face",
      expressions: { blink: "blink" },
      controls: {
        eyelids_left: { positive: "eyeWideLeft", negative: "eyeBlinkLeft" },
      },
      customMorphs: { scar: "scar" },
    },
    appearanceDials: {
      contract: APPEARANCE_DIALS_CONTRACT,
      definitionSha256: HASH_C,
      neutral: { id: "batshit-base-f-v1-neutral", recipeSha256: HASH_D },
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
        face: {
          node: "Face",
          kind: "mesh",
          role: "face",
          side: "none",
          required: true,
          scalePolicy: "any",
          exactNodeMatches: 1,
        },
        eyes: {
          node: "Eyes",
          kind: "anchor",
          role: "generic-follower",
          side: "none",
          required: true,
          scalePolicy: "uniform-only",
          parent: { kind: "bone", name: "Head" },
          exactNodeMatches: 1,
        },
        composite_cap_left: {
          node: "BS_Eye_L_CompositeCap",
          kind: "mesh",
          role: "socket-eye-composite-cap",
          side: "left",
          required: true,
          scalePolicy: "any",
          parent: { kind: "bone", name: "Head" },
          exactNodeMatches: 1,
        },
      },
      regions: [
        { id: "body", label: "Body", surface: "body", order: 0 },
        { id: "head", label: "Head", surface: "head-face", order: 0 },
      ],
      targets: {
        head_forward: {
          usages: ["identity"],
          runtimeRetention: "recipe-only",
          side: "bilateral",
          bindings: [{ node: "face", morph: "head_forward" }],
          baselineValue: 0,
          influenceMin: -1,
          influenceMax: 1,
          combine: "exclusive",
          impact: "structural",
          requirements: { jointFollow: true, followerRefs: ["head-assets"] },
          provenance: provenance("head_forward"),
        },
        seated_corrective: {
          usages: ["identity"],
          runtimeRetention: "recipe-only",
          side: "none",
          bindings: [{ node: "face", morph: "seated_corrective" }],
          baselineValue: 0,
          influenceMin: -1,
          influenceMax: 1,
          combine: "sum-clamp",
          impact: "surface",
          provenance: provenance("seated_corrective"),
        },
      },
      dials: [
        {
          id: "head_projection",
          label: "Head Projection",
          region: "head",
          tier: "core",
          order: 0,
          description: "Moves the head.",
          keywords: ["head"],
          kind: "tracks",
          range: [-1, 1],
          default: 0,
          step: 0.01,
          members: [
            {
              target: "head_forward",
              track: [
                [-1, -1],
                [0, 0],
                [1, 1],
              ],
            },
          ],
        },
        {
          id: "butt_size",
          label: "Butt Size",
          region: "body",
          tier: "core",
          order: 0,
          description: "Corrective anchor.",
          keywords: ["butt"],
          kind: "tracks",
          range: [0, 1],
          default: 0,
          step: 0.01,
          members: [
            {
              target: "seated_corrective",
              track: [
                [0, 0],
                [1, 1],
              ],
            },
          ],
        },
        {
          id: "overall_height",
          label: "Overall Height",
          region: "body",
          tier: "core",
          order: 1,
          description: "Uniform scale.",
          keywords: ["height"],
          kind: "root-scale",
          range: [-1, 1],
          default: 0,
          step: 0.01,
          scalePerUnit: 0.15,
          requirements: { followerRefs: ["head-assets"] },
        },
        {
          id: "oral_depth",
          label: "Oral Depth",
          region: "head",
          tier: "advanced",
          order: 2,
          description: "",
          keywords: ["oral", "depth"],
          kind: "follower-only",
          range: [-1, 1],
          default: 0,
          step: 0.01,
          requirements: { followerRefs: ["head-assets"] },
        },
      ],
      jointFollow: {
        contract: APPEARANCE_JOINT_FOLLOW_CONTRACT,
        space: "avatar-root",
        units: "meters",
        restSkeletonSha256: HASH_E,
        deltas: {
          head_forward: { Head: [0, 0, 0.2], "mixamorig:Hips": [0, 0.5, 0] },
        },
        clipRemap: {
          contract: APPEARANCE_CLIP_REMAP_CONTRACT,
          hipsBone: "mixamorig:Hips",
        },
      },
      followers: {
        "head-assets": {
          contract: APPEARANCE_FOLLOWER_CONTRACT,
          space: "node-parent-rest",
          composition: "rest-relative-follower-channel-id-order/v2",
          interpolation: "linear-trs-slerp-rotation-morph/v2",
          extrapolation: "clamp",
          provenance: {
            ...provenance("head-assets"),
            license: "LicenseRef-Batshit-First-Party",
          },
          nodeIds: ["face", "eyes", "composite_cap_left"],
          drivers: [
            {
              driver: { kind: "target", id: "head_forward" },
              channels: [
                {
                  id: "a-eye-scale",
                  kind: "node-trs",
                  node: "eyes",
                  samples: samples("scale"),
                },
                {
                  id: "sclera-fit",
                  kind: "morph-weight",
                  node: "composite_cap_left",
                  morph: "follow_head_forward",
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
            {
              driver: { kind: "dial", id: "overall_height" },
              channels: [
                {
                  id: "b-eye-translate",
                  kind: "node-trs",
                  node: "eyes",
                  samples: samples("translation"),
                },
              ],
            },
            {
              driver: { kind: "dial", id: "oral_depth" },
              channels: [
                {
                  id: "c-oral-translate",
                  kind: "node-trs",
                  node: "face",
                  samples: samples("translation"),
                },
              ],
            },
          ],
        },
      },
    },
  } as GoonCustomAvatarManifest;
}

function morphMesh(name: string, morphs: string[], skinned = false) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3),
  );
  geometry.setIndex([0, 1, 2]);
  geometry.morphTargetsRelative = true;
  geometry.morphAttributes.position = morphs.map(
    (_, index) =>
      new THREE.Float32BufferAttribute(
        [index + 1, 0, 0, index + 1, 0, 0, index + 1, 0, 0],
        3,
      ),
  );
  const mesh = skinned
    ? new THREE.SkinnedMesh(geometry, new THREE.MeshBasicMaterial())
    : new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
  mesh.name = name;
  mesh.morphTargetDictionary = Object.fromEntries(
    morphs.map((morph, index) => [morph, index]),
  );
  mesh.morphTargetInfluences = morphs.map(() => 0);
  return mesh;
}

function logicalMorphMesh(name: string, morphs: string[]) {
  const logical = new THREE.Group();
  logical.name = name;
  logical.add(
    morphMesh(`${name}_visible`, morphs),
    morphMesh(`${name}_hidden`, morphs),
  );
  return logical;
}

function buildScene() {
  const root = new THREE.Group();
  root.name = "AvatarRoot";
  // Real GLBs commonly carry unnamed transport/helper nodes. They are not
  // part of the exact manifest inventory and must not invalidate it.
  root.add(new THREE.Object3D());
  const hips = new THREE.Bone();
  hips.name = "mixamorigHips";
  hips.position.y = 1;
  const head = new THREE.Bone();
  head.name = "Head";
  head.position.y = 1;
  root.add(hips, head);

  const body = morphMesh("Body", [], true) as THREE.SkinnedMesh;
  body.bind(new THREE.Skeleton([hips, head]));
  root.add(body);

  const face = morphMesh("Face", [
    "head_forward",
    "seated_corrective",
    "blink",
    "eyeWideLeft",
    "eyeBlinkLeft",
    "scar",
  ]);
  root.add(face);
  const eyes = new THREE.Object3D();
  eyes.name = "Eyes";
  eyes.position.x = 1;
  head.add(eyes);
  const sclera = morphMesh("BS_Eye_L_CompositeCap", ["follow_head_forward"]);
  head.add(sclera);
  root.updateMatrixWorld(true);
  return { root, hips, head, body, face, eyes, sclera };
}

function values(
  manifest: AppearanceDialsManifest,
  next: Record<string, number>,
): AppearanceDialValueState {
  return {
    contract: APPEARANCE_DIAL_VALUES_CONTRACT,
    definitionSha256: manifest.definitionSha256,
    neutralId: manifest.neutral.id,
    neutralRecipeSha256: manifest.neutral.recipeSha256,
    values: next,
    unlockedDialIds: [],
  };
}

function physicalBasis(
  runtime: AppearanceDialsEngineRuntime,
): AppearanceRecipePhysicalBasis {
  return (
    runtime as unknown as { physicalBasis: AppearanceRecipePhysicalBasis }
  ).physicalBasis;
}

describe("AppearanceDialsEngineRuntime", () => {
  it("applies one Appearance state and its matching Anatomy Fit atomically", () => {
    const scene = buildScene();
    const runtime = new AppearanceDialsEngineRuntime(
      scene.root,
      buildManifest(),
      { faceMeshes: [scene.face] },
    );
    const fit: AnatomyFitResult = {
      contract: "anatomy-fit-result/v2",
      solverVersion: ORAL_CAVITY_ANATOMY_FIT_SOLVER,
      domain: "oral-cavity",
      inputSha256: HASH_A,
      status: "converged",
      convergence: {
        converged: true,
        iterations: 0,
        objective: 0,
        tolerance: 0,
        reason: "closed-form-fit",
      },
      resolvedParameters: [],
      nodeTransforms: [
        {
          nodeId: "eyes",
          rootDeltaMatrix: [
            1, 0, 0, 0,
            0, 1, 0, 0,
            0, 0, 1, 0,
            2, 0, 0, 1,
          ],
        },
      ],
      followerMorphCoefficients: [
        {
          followerId: "head-assets",
          channelId: "sclera-fit",
          nodeId: "composite_cap_left",
          morph: "follow_head_forward",
          weight: 0.25,
          lower: -1,
          upper: 1,
        },
      ],
      metrics: [],
      diagnostics: [],
      resultSha256: HASH_B,
    };

    runtime.setFittedValues(values(runtime.manifest, {}), [fit]);
    expect(scene.eyes.position.toArray()).toEqual([3, 0, 0]);
    expect(scene.sclera.geometry.getAttribute("position").getX(0)).toBeCloseTo(
      0.25,
    );

    runtime.setValues(values(runtime.manifest, {}));
    expect(scene.eyes.position.toArray()).toEqual([1, 0, 0]);
    expect(scene.sclera.geometry.getAttribute("position").getX(0)).toBe(0);
  });

  it("preserves editor-owned avatar rotation while applying Appearance values", () => {
    const scene = buildScene();
    const runtime = new AppearanceDialsEngineRuntime(
      scene.root,
      buildManifest(),
      { faceMeshes: [scene.face] },
    );
    const editorRotation = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 1, 0),
      Math.PI / 3,
    );
    scene.root.quaternion.copy(editorRotation);

    runtime.setValues(values(runtime.manifest, { head_projection: 0.5 }));

    expect(scene.root.quaternion.toArray()).toEqual(editorRotation.toArray());
  });

  it("binds the scene inventory, applies every v2 output, and resets to captured rest", () => {
    const scene = buildScene();
    const runtime = new AppearanceDialsEngineRuntime(
      scene.root,
      buildManifest(),
      {
        faceMeshes: [scene.face],
      },
    );
    const active = values(runtime.manifest, {
      head_projection: 0.5,
      overall_height: 1,
      oral_depth: 0.5,
    });
    runtime.setValues(active);

    expect(scene.face.morphTargetDictionary).toEqual({
      blink: 0,
      eyeWideLeft: 1,
      eyeBlinkLeft: 2,
      scar: 3,
    });
    expect(scene.sclera.morphTargetDictionary).toEqual({});
    expect(scene.face.geometry.getAttribute("position").getX(0)).toBeCloseTo(
      0.5,
    );
    expect(scene.sclera.geometry.getAttribute("position").getX(0)).toBeCloseTo(
      0.5,
    );
    expect(scene.head.position.z).toBeCloseTo(0.1);
    expect(scene.hips.position.y).toBeCloseTo(1.25);
    expect(scene.root.scale.toArray()).toEqual([1.15, 1.15, 1.15]);
    // Channel-id order is scale first, then translation: 1 * 1.25 + 0.1.
    expect(scene.eyes.position.x).toBeCloseTo(1.35);
    expect(scene.face.position.x).toBeCloseTo(0.05);

    runtime.setValues(values(runtime.manifest, {}));
    expect(scene.face.geometry.getAttribute("position").getX(0)).toBe(0);
    expect(scene.sclera.geometry.getAttribute("position").getX(0)).toBe(0);
    expect(scene.head.position.toArray()).toEqual([0, 1, 0]);
    expect(scene.hips.position.toArray()).toEqual([0, 1, 0]);
    expect(scene.eyes.position.toArray()).toEqual([1, 0, 0]);
    expect(scene.eyes.scale.toArray()).toEqual([1, 1, 1]);
    expect(scene.face.position.toArray()).toEqual([0, 0, 0]);
    expect(scene.root.scale.toArray()).toEqual([1, 1, 1]);
  });

  it("bakes recipe targets out of the renderer inventory while retaining live face morphs", () => {
    const scene = buildScene();
    const runtime = new AppearanceDialsEngineRuntime(
      scene.root,
      buildManifest(),
      {
        faceMeshes: [scene.face],
      },
    );

    expect(scene.face.geometry.morphAttributes.position).toHaveLength(4);
    expect(scene.sclera.geometry.morphAttributes.position).toBeUndefined();
    expect(Object.keys(scene.face.morphTargetDictionary ?? {})).toEqual([
      "blink",
      "eyeWideLeft",
      "eyeBlinkLeft",
      "scar",
    ]);

    const facePosition = scene.face.geometry.getAttribute(
      "position",
    ) as THREE.BufferAttribute;
    const scleraPosition = scene.sclera.geometry.getAttribute(
      "position",
    ) as THREE.BufferAttribute;
    const faceVersionBeforeEdit = facePosition.version;
    const scleraVersionBeforeEdit = scleraPosition.version;
    runtime.setValues(values(runtime.manifest, { butt_size: 0.8 }));
    // seated_corrective was source index 1, whose fixture delta is +2 X.
    expect(scene.face.geometry.getAttribute("position").getX(0)).toBeCloseTo(
      1.6,
    );
    expect(scene.face.morphTargetInfluences).toEqual([0, 0, 0, 0]);
    expect(facePosition.version).toBeGreaterThan(faceVersionBeforeEdit);
    expect(scleraPosition.version).toBeGreaterThan(scleraVersionBeforeEdit);

    scene.face.morphTargetInfluences[0] = 0.25;
    // blink was source index 2, whose fixture delta is +3 X. The live target
    // remains a renderer morph while the baked identity base stays at +1.6.
    expect(scene.face.geometry.morphAttributes.position?.[0]?.getX(0)).toBe(3);
    expect(scene.face.geometry.getAttribute("position").getX(0)).toBeCloseTo(
      1.6,
    );
  });

  it("keeps dynamic face mappings outside appearance ownership and remaps posed hips once", () => {
    const scene = buildScene();
    const runtime = new AppearanceDialsEngineRuntime(
      scene.root,
      buildManifest(),
      {
        faceMeshes: [scene.face],
      },
    );
    runtime.setValues(values(runtime.manifest, { head_projection: 1 }));
    expect(runtime.ownedFaceMorphNames).toEqual(
      new Set(["head_forward", "seated_corrective", "follow_head_forward"]),
    );
    expect(runtime.ownedFaceMorphNames.has("blink")).toBe(false);

    // Mixer output 2.5 against base rest 1, remapped to new rest 1.5 at ratio 1.5.
    scene.hips.position.y = 2.5;
    runtime.applyHipsClipRemap();
    expect(scene.hips.position.y).toBeCloseTo(3.75);
    runtime.applyHipsClipRemap();
    expect(scene.hips.position.y).toBeCloseTo(3.75);
  });

  it("fails the real scene binding when an identity target collides with a face expression", () => {
    const manifest = buildManifest() as Record<string, any>;
    manifest.appearanceDials.targets.head_forward.bindings[0].morph = "blink";
    const scene = buildScene();
    expect(
      () =>
        new AppearanceDialsEngineRuntime(
          scene.root,
          manifest as GoonCustomAvatarManifest,
          {
            faceMeshes: [scene.face],
          },
        ),
    ).toThrow(/collides with face animation\/custom morph/);
  });

  it("captures hidden meshes, fails missing POSITION, and preserves optional-node omissions", () => {
    const hiddenScene = buildScene();
    hiddenScene.sclera.visible = false;
    const hiddenRuntime = new AppearanceDialsEngineRuntime(
      hiddenScene.root,
      buildManifest(),
      { faceMeshes: [hiddenScene.face] },
    );
    hiddenRuntime.setValues(
      values(hiddenRuntime.manifest, { head_projection: 0.5 }),
    );
    expect(
      physicalBasis(hiddenRuntime).meshes.some(
        (mesh) => mesh.nodeId === hiddenScene.sclera.uuid,
      ),
    ).toBe(true);
    expect(hiddenScene.sclera.geometry.getAttribute("position").getX(0)).toBe(
      0.5,
    );

    const malformedScene = buildScene();
    const missingPosition = new THREE.Mesh(
      new THREE.BufferGeometry(),
      new THREE.MeshBasicMaterial(),
    );
    missingPosition.name = "MissingPosition";
    malformedScene.root.add(missingPosition);
    expect(
      () =>
        new AppearanceDialsEngineRuntime(malformedScene.root, buildManifest(), {
          faceMeshes: [malformedScene.face],
        }),
    ).toThrow(/physical mesh MissingPosition has no POSITION attribute/);

    const optionalScene = buildScene();
    optionalScene.sclera.removeFromParent();
    const optionalManifest = buildManifest() as Record<string, any>;
    optionalManifest.appearanceDials.nodes.composite_cap_left.required = false;
    const optionalRuntime = new AppearanceDialsEngineRuntime(
      optionalScene.root,
      optionalManifest as GoonCustomAvatarManifest,
      { faceMeshes: [optionalScene.face] },
    );
    optionalRuntime.setValues(
      values(optionalRuntime.manifest, { head_projection: 0.5 }),
    );
    expect(physicalBasis(optionalRuntime).followerMorphBindings).toContainEqual(
      expect.objectContaining({
        follower: "head-assets",
        channel: "sclera-fit",
        node: "composite_cap_left",
      }),
    );
    expect(
      physicalBasis(optionalRuntime).followerMorphBindings.find(
        (binding) => binding.channel === "sclera-fit",
      ),
    ).not.toHaveProperty("positionBindingIds");
  });

  it("binds one declared GLB mesh node across aligned loader primitives", () => {
    const scene = buildScene();
    scene.sclera.removeFromParent();
    const compositeCap = new THREE.Group();
    compositeCap.name = "BS_Eye_L_CompositeCap";
    const visibleFront = morphMesh("BS_Eye_L_CompositeCap_1", [
      "follow_head_forward",
    ]);
    const hiddenClosure = morphMesh("BS_Eye_L_CompositeCap_2", [
      "follow_head_forward",
    ]);
    compositeCap.add(visibleFront, hiddenClosure);
    scene.head.add(compositeCap);
    scene.root.updateMatrixWorld(true);

    const runtime = new AppearanceDialsEngineRuntime(
      scene.root,
      buildManifest(),
      { faceMeshes: [scene.face, visibleFront, hiddenClosure] },
    );
    runtime.setValues(values(runtime.manifest, { head_projection: 0.5 }));

    expect(visibleFront.geometry.getAttribute("position").getX(0)).toBeCloseTo(
      0.5,
    );
    expect(hiddenClosure.geometry.getAttribute("position").getX(0)).toBeCloseTo(
      0.5,
    );
    expect(
      physicalBasis(runtime).followerMorphBindings.find(
        (binding) => binding.channel === "sclera-fit",
      )?.positionBindingIds,
    ).toHaveLength(2);
  });

  it("strips socket-eye Source-only liner morphs before the strict runtime binds", async () => {
    const scene = buildScene();
    scene.sclera.removeFromParent();
    const manifest = buildManifest() as Record<string, any>;
    const linerPerformanceMorphs = (suffix: "Left" | "Right") => [
      `eyeBlink${suffix}`,
      `eyeSquint${suffix}`,
      `eyeWide${suffix}`,
      ...Array.from({ length: 41 }, (_, index) => `performance${suffix}${index}`),
    ].sort();
    const nodes = [
      {
        id: "composite_cap_left",
        name: "BS_Eye_L_CompositeCap",
        role: "socket-eye-composite-cap",
        side: "left",
        retained: ["eyeBlinkLeft", "eyeSquintLeft", "eyeWideLeft"],
      },
      {
        id: "composite_cap_right",
        name: "BS_Eye_R_CompositeCap",
        role: "socket-eye-composite-cap",
        side: "right",
        retained: ["eyeBlinkRight", "eyeSquintRight", "eyeWideRight"],
      },
      {
        id: "eye_treatment_canvas_left",
        name: "BS_EyeTreatmentCanvas_L",
        role: "eye-treatment-canvas",
        side: "left",
        retained: linerPerformanceMorphs("Left"),
      },
      {
        id: "eye_treatment_canvas_right",
        name: "BS_EyeTreatmentCanvas_R",
        role: "eye-treatment-canvas",
        side: "right",
        retained: linerPerformanceMorphs("Right"),
      },
    ] as const;
    const logicalNodes = nodes.map((entry) => ({
      ...entry,
      node: logicalMorphMesh(entry.name, [
        "sourceOnlySmile",
        ...entry.retained,
        ...(entry.id === "composite_cap_left"
          ? ["follow_head_forward"]
          : []),
      ]),
    }));
    for (const entry of logicalNodes) {
      scene.head.add(entry.node);
      manifest.appearanceDials.nodes[entry.id] = {
        node: entry.name,
        kind: "mesh",
        role: entry.role,
        side: entry.side,
        required: true,
        scalePolicy: "any",
        parent: { kind: "bone", name: "Head" },
        exactNodeMatches: 1,
      };
    }
    scene.root.updateMatrixWorld(true);

    const packageValue = {
      socketEyeSurface: {
        runtimeBindings: {
          left: { nodes: { compositeCap: "BS_Eye_L_CompositeCap" } },
          right: { nodes: { compositeCap: "BS_Eye_R_CompositeCap" } },
        },
      },
      eyeApertureSeam: {
        runtimeBindings: {
          left: {
            lashesEyeOutlineNode: "BS_EyeTreatmentCanvas_L",
            liner: { retainedPerformanceMorphs: linerPerformanceMorphs("Left") },
          },
          right: {
            lashesEyeOutlineNode: "BS_EyeTreatmentCanvas_R",
            liner: { retainedPerformanceMorphs: linerPerformanceMorphs("Right") },
          },
        },
      },
    } as NonNullable<ReturnType<typeof parseFirstPartySocketEyePackage>>;
    const parser = vi.mocked(parseFirstPartySocketEyePackage);
    parser.mockReturnValue(packageValue);
    try {
      new AppearanceDialsEngineRuntime(
        scene.root,
        manifest as GoonCustomAvatarManifest,
        { faceMeshes: [scene.face] },
      );

      for (const entry of logicalNodes) {
        for (const primitive of entry.node.children as THREE.Mesh[]) {
          expect(
            Object.keys(primitive.morphTargetDictionary ?? {}).sort(),
          ).toEqual([...entry.retained].sort());
          expect(primitive.geometry.morphAttributes.position).toHaveLength(
            entry.retained.length,
          );
          expect(primitive.morphTargetInfluences).toHaveLength(entry.retained.length);
        }
      }
    } finally {
      const actual = await vi.importActual<
        typeof import("./socketEyePackage")
      >("./socketEyePackage");
      parser.mockImplementation(actual.parseFirstPartySocketEyePackage);
    }
  });

  it("captures retained absolute morph deltas and applies their live weights", () => {
    const scene = buildScene();
    const manifest = buildManifest() as Record<string, any>;
    manifest.appearanceDials.targets.seated_corrective.usages = [
      "identity",
      "pose-corrective",
    ];
    manifest.appearanceDials.targets.seated_corrective.runtimeRetention =
      "retain-in-live-goon";
    manifest.rig = {
      correctives: { entries: [{ target: "seated_corrective" }] },
    };
    const base = Array.from(
      (scene.face.geometry.getAttribute("position") as THREE.BufferAttribute)
        .array as Float32Array,
    );
    const absoluteMorphs = scene.face.geometry.morphAttributes.position ?? [];
    for (const [index, delta] of [1, 2].entries()) {
      const attribute = absoluteMorphs[index]!;
      base.forEach((value, scalarIndex) => {
        attribute.setComponent(
          Math.floor(scalarIndex / 3),
          scalarIndex % 3,
          value + (scalarIndex % 3 === 0 ? delta : 0),
        );
      });
    }
    scene.face.geometry.morphTargetsRelative = false;

    const runtime = new AppearanceDialsEngineRuntime(
      scene.root,
      manifest as GoonCustomAvatarManifest,
      { faceMeshes: [scene.face] },
    );
    const retained = physicalBasis(runtime).retainedTargetPositionBindings;
    expect(retained).toHaveLength(1);
    expect(retained[0]).toMatchObject({
      targetId: "seated_corrective",
      node: "face",
      morph: "seated_corrective",
      meshId: scene.face.uuid,
    });
    const delta: number[] = [];
    const positionDelta = retained[0].positionDelta;
    if (positionDelta instanceof Float32Array) {
      delta.push(...positionDelta);
    } else {
      positionDelta.visit((_index, value) => delta.push(value));
    }
    expect(delta).toEqual([2, 0, 0, 2, 0, 0, 2, 0, 0]);

    runtime.setValues(values(runtime.manifest, { butt_size: 0.8 }));
    const retainedIndex = scene.face.morphTargetDictionary?.seated_corrective;
    expect(retainedIndex).toBeTypeOf("number");
    expect(scene.face.morphTargetInfluences?.[retainedIndex!]).toBe(0.8);
    expect(scene.face.geometry.getAttribute("position").getX(0)).toBe(0);
  });

  it("keeps retained bindings on their declared meshes when follower meshes share a morph name", () => {
    const scene = buildScene();
    const overlay = morphMesh("LipArtworkOverlay", ["seated_corrective"]);
    scene.root.add(overlay);
    scene.root.updateMatrixWorld(true);

    const manifest = buildManifest() as Record<string, any>;
    manifest.appearanceDials.nodes.lip_artwork_overlay = {
      node: "LipArtworkOverlay",
      kind: "mesh",
      role: "generic-follower",
      side: "none",
      required: true,
      scalePolicy: "any",
      exactNodeMatches: 1,
    };
    manifest.appearanceDials.targets.seated_corrective.usages = [
      "identity",
      "pose-corrective",
    ];
    manifest.appearanceDials.targets.seated_corrective.runtimeRetention =
      "retain-in-live-goon";
    manifest.appearanceDials.targets.seated_corrective.bindings.push({
      node: "lip_artwork_overlay",
      morph: "seated_corrective",
    });
    manifest.rig = {
      correctives: { entries: [{ target: "seated_corrective" }] },
    };

    const runtime = new AppearanceDialsEngineRuntime(
      scene.root,
      manifest as GoonCustomAvatarManifest,
      { faceMeshes: [scene.face] },
    );
    const retained = physicalBasis(runtime).retainedTargetPositionBindings;
    expect(retained).toHaveLength(2);
    expect(retained).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          node: "face",
          morph: "seated_corrective",
          meshId: scene.face.uuid,
        }),
        expect.objectContaining({
          node: "lip_artwork_overlay",
          morph: "seated_corrective",
          meshId: overlay.uuid,
        }),
      ]),
    );
  });

  it("fails loudly when strict performance role nodes are missing", () => {
    const malformedRigScene = buildScene();
    const malformedRigManifest = buildManifest() as Record<string, any>;
    malformedRigManifest.rig = [];
    expect(
      () =>
        new AppearanceDialsEngineRuntime(
          malformedRigScene.root,
          malformedRigManifest as GoonCustomAvatarManifest,
          { faceMeshes: [malformedRigScene.face] },
        ),
    ).toThrow(/avatar\.json#rig must be an object/);

    const performanceScene = buildScene();
    const performanceManifest = buildManifest() as Record<string, any>;
    performanceManifest.rig = {
      performance: performanceRig({
        head: "Head",
        neck: "mixamorigHips",
        leftEye: "Eyes",
        rightEye: "Face",
        target: "MissingPerformanceTarget",
      }),
    };
    expect(
      () =>
        new AppearanceDialsEngineRuntime(
          performanceScene.root,
          performanceManifest as GoonCustomAvatarManifest,
          { faceMeshes: [performanceScene.face] },
        ),
    ).toThrow(/targetTransforms\.jaw\.node points to missing node/);
  });

  it("pins the R2-C final physical engine oracle before extraction", async () => {
    const scene = buildScene();
    const manifest = buildManifest() as Record<string, any>;
    manifest.appearanceDials.targets.head_forward.soleDeltaY = 0.04;

    const eyeScale =
      manifest.appearanceDials.followers["head-assets"].drivers[0].channels[0];
    eyeScale.samples = [-1, 0, 1].map((input) => ({
      input,
      translation: [0, 0, 0],
      rotation: [
        0,
        0,
        Math.sin((input * Math.PI) / 8),
        Math.cos((input * Math.PI) / 8),
      ],
      scale: [1 + input * 0.2, 1 + input * 0.2, 1 + input * 0.2],
      pivot: [0.25, -0.1, 0],
    }));
    const oralTransform =
      manifest.appearanceDials.followers["head-assets"].drivers[2].channels[0];
    oralTransform.samples = [-1, 0, 1].map((input) => ({
      input,
      translation: [input * 0.1, 0, 0],
      rotation: [
        Math.sin((input * Math.PI) / 12),
        0,
        0,
        Math.cos((input * Math.PI) / 12),
      ],
      scale: [1 + input * 0.1, 1 + input * 0.2, 1 - input * 0.05],
      pivot: [-0.2, 0.15, 0.05],
    }));

    const boneAttachment = new THREE.Object3D();
    boneAttachment.name = "BoneAttachment";
    boneAttachment.position.set(0.2, 0.3, 0.4);
    scene.head.add(boneAttachment);
    const nodeAttachment = new THREE.Object3D();
    nodeAttachment.name = "NodeAttachment";
    nodeAttachment.position.set(-0.1, 0.2, 0.3);
    scene.eyes.add(nodeAttachment);
    manifest.appearanceDials.nodes.bone_attachment = {
      node: "BoneAttachment",
      kind: "anchor",
      role: "attachment-anchor",
      side: "none",
      required: true,
      scalePolicy: "any",
      parent: { kind: "bone", name: "Head" },
      exactNodeMatches: 1,
    };
    manifest.appearanceDials.nodes.node_attachment = {
      node: "NodeAttachment",
      kind: "anchor",
      role: "attachment-anchor",
      side: "none",
      required: true,
      scalePolicy: "any",
      parent: { kind: "node", id: "eyes" },
      exactNodeMatches: 1,
    };

    const stageAnchor = new THREE.Object3D();
    stageAnchor.name = "StageAnchor";
    stageAnchor.position.set(0.05, 0.06, 0.07);
    boneAttachment.add(stageAnchor);
    const performanceRest = new THREE.Object3D();
    performanceRest.name = "PerformanceRest";
    performanceRest.position.set(-0.07, 0.08, 0.09);
    nodeAttachment.add(performanceRest);
    const eyeRest = new THREE.Object3D();
    eyeRest.name = "EyeRest";
    eyeRest.position.set(0.09, -0.08, 0.07);
    nodeAttachment.add(eyeRest);
    manifest.rig = {
      performance: performanceRig({
        head: "Head",
        neck: "Eyes",
        leftEye: "PerformanceRest",
        rightEye: "EyeRest",
        target: "StageAnchor",
      }),
    };
    scene.hips.add(scene.head);
    scene.hips.quaternion.setFromAxisAngle(
      new THREE.Vector3(0, 0, 1),
      Math.PI / 2,
    );
    scene.body.skeleton.boneInverses[0].makeTranslation(1, 2, 3);
    scene.body.skeleton.boneInverses[1].makeTranslation(4, 5, 6);
    scene.root.position.set(2, 3, 4);
    scene.root.quaternion.setFromAxisAngle(
      new THREE.Vector3(0, 1, 0),
      Math.PI / 6,
    );
    scene.root.scale.set(2, 3, 4);

    const facePosition = scene.face.geometry.getAttribute(
      "position",
    ) as THREE.BufferAttribute;
    facePosition.setX(0, 0.1);
    const absoluteMorphs = scene.face.geometry.morphAttributes.position ?? [];
    for (const index of [0, 1]) {
      absoluteMorphs[index].setX(0, 0.2);
      absoluteMorphs[index].setX(1, 1.1);
      absoluteMorphs[index].setX(2, 0.1);
    }
    scene.face.geometry.morphTargetsRelative = false;
    scene.root.updateMatrixWorld(true);

    const runtime = new AppearanceDialsEngineRuntime(
      scene.root,
      manifest as GoonCustomAvatarManifest,
      { faceMeshes: [scene.face] },
    );
    const capturedBasis = physicalBasis(runtime);
    expect(
      capturedBasis.roles
        .filter((role) => role.kind === "performance")
        .map((role) => role.id),
    ).toEqual([
      "look.head",
      "look.neck",
      "look.leftEye",
      "look.rightEye",
      "target.jaw",
    ]);
    expect(capturedBasis.roles.filter((role) => role.kind === "eye")).toEqual(
      [],
    );
    expect(capturedBasis.targets.map((target) => target.id)).toEqual([
      "head_forward",
      "seated_corrective",
    ]);
    expect(capturedBasis.jointOffsetBindings).toEqual([
      { bone: "Head", boneId: scene.head.uuid },
      { bone: "mixamorig:Hips", boneId: scene.hips.uuid },
    ]);
    expect(
      capturedBasis.followerNodeTransformBindings.map(
        (binding) => binding.channel,
      ),
    ).toEqual(["a-eye-scale", "b-eye-translate", "c-oral-translate"]);
    expect(
      capturedBasis.followerMorphBindings.map((binding) => binding.channel),
    ).toEqual(["sclera-fit"]);
    const active = values(runtime.manifest, {
      head_projection: 0.1,
      butt_size: 0.1,
      overall_height: 0.5,
      oral_depth: 0.2,
    });
    runtime.setValues(active);

    const matrix = (node: THREE.Object3D) => node.matrix.toArray();
    const world = (node: THREE.Object3D) => node.matrixWorld.toArray();
    const capture = () => ({
      facePosition: Array.from(
        (scene.face.geometry.getAttribute("position") as THREE.BufferAttribute)
          .array as Float32Array,
      ),
      scleraPosition: Array.from(
        (
          scene.sclera.geometry.getAttribute(
            "position",
          ) as THREE.BufferAttribute
        ).array as Float32Array,
      ),
      retainedFaceWeights: [...(scene.face.morphTargetInfluences ?? [])],
      hipsLocal: matrix(scene.hips),
      headLocal: matrix(scene.head),
      inverseBinds: scene.body.skeleton.boneInverses.map((entry) =>
        entry.toArray(),
      ),
      eyesLocal: matrix(scene.eyes),
      rootPosition: scene.root.position.toArray(),
      rootQuaternion: scene.root.quaternion.toArray(),
      rootScale: scene.root.scale.toArray(),
      rootWorld: world(scene.root),
      boneAttachmentWorld: world(boneAttachment),
      nodeAttachmentWorld: world(nodeAttachment),
      stageAnchorWorld: world(stageAnchor),
      performanceRestWorld: world(performanceRest),
      eyeRestWorld: world(eyeRest),
      skeletonParents: [
        scene.hips.parent?.name ?? null,
        scene.head.parent?.name ?? null,
      ],
    });
    const first = capture();
    runtime.setValues(values(runtime.manifest, {}));
    runtime.setValues(active);
    const repeated = capture();

    expect(first.facePosition[0]).toBe(0.11999999731779099);
    expect(
      Array.from(
        new Uint8Array(
          (
            scene.face.geometry.getAttribute(
              "position",
            ) as THREE.BufferAttribute
          ).array.buffer,
          0,
          4,
        ),
      ),
    ).toEqual([143, 194, 245, 61]);
    expect(repeated).toEqual(first);
  });
});
