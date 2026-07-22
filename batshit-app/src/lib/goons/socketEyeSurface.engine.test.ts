import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import {
  SOCKET_EYE_COMPOSITE_RENDER_ORDER,
  SOCKET_EYE_LINER_RENDER_ORDER,
  SocketEyeCompositeMaterialRuntime,
  SocketEyeSurfaceEngineRuntime,
  type SocketEyeCompositeVisualState,
} from "./socketEyeSurface.engine";
import { parseSocketEyeSurfaceDefinition } from "./socketEyeSurface";
import { parseEyeApertureSeamDefinition } from "./eyeApertureSeam";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);

function linerPerformanceMorphs(suffix: "Left" | "Right") {
  return [
    `eyeBlink${suffix}`,
    `eyeSquint${suffix}`,
    `eyeWide${suffix}`,
    ...Array.from({ length: 41 }, (_, index) => `performance${suffix}${index}`),
  ].sort();
}

function visualState(): SocketEyeCompositeVisualState {
  return {
    scleraColor: [0.9, 0.9, 0.88, 1],
    irisColor: [0.04, 0.42, 0.33, 1],
    pupilColor: [0.005, 0.01, 0.012, 1],
    irisRadiusMeters: 0.0065,
    pupilRadiusRatio: 0.42,
    irisVerticalOffsetMeters: 0,
    edgeSoftnessMeters: 0.0001,
    scleraArtwork: { texture: null, tint: [1, 1, 1, 1], opacity: 0 },
    irisArtwork: { texture: null, tint: [1, 1, 1, 1], opacity: 0 },
    pupilArtwork: { texture: null, tint: [1, 1, 1, 1], opacity: 0 },
    highlight: { texture: null, tint: [1, 1, 1, 1], opacity: 0 },
    cornea: { roughness: 0.28, clearcoat: 0.7, clearcoatRoughness: 0.18 },
  };
}

function metricFrame() {
  return {
    horizontalAxisLocal: new THREE.Vector3(1, 0, 0),
    verticalAxisLocal: new THREE.Vector3(0, 1, 0),
    centerMeters: new THREE.Vector2(0, 0),
  };
}

function socketDefinition() {
  const side = (name: "left" | "right") => {
    const code = name === "left" ? "L" : "R";
    const suffix = name === "left" ? "Left" : "Right";
    const followerMorphs = [
      `eyeBlink${suffix}`,
      `eyeSquint${suffix}`,
      `eyeWide${suffix}`,
      `identityFace${suffix}`,
    ].sort((left, right) => left.localeCompare(right));
    return {
      side: name,
      nodes: { compositeCap: `BS_Eye_${code}_CompositeCap` },
      apertureSeamDefinitionSha256: HASH_B,
      gazeAnchorHeadLocal: [0, 0, 0],
      surfaceCenterHeadLocal: [0, 0, 0],
      horizontalAxisHeadLocal: [1, 0, 0],
      verticalAxisHeadLocal: [0, 1, 0],
      forwardAxisHeadLocal: [0, 0, 1],
      cap: {
        frontGeometryLaw: "aperture-normalized-shallow-patch/v1",
        frontDepthRatio: 0.08,
        maximumFrontDepthMeters: 0.0008,
        artworkProjection: "deformed-surface-meters/v1",
        carrierHalfWidthMeters: 0.016,
        carrierHalfHeightMeters: 0.015,
        carrierDepthRadiusMeters: 0.014,
        rearClosureDepthMeters: 0.004,
        minimumHiddenUnderlapMeters: 0.002,
        visibleFrontFaceGroup: "visible-front",
        hiddenClosureFaceGroup: "hidden-closure",
        primitiveFollowerMorphs: {
          visibleFront: followerMorphs,
          hiddenClosure: [...followerMorphs],
        },
        apertureFollowing: true,
        closedManifold: true,
      },
      gaze: {
        maximumHorizontal: 0.58,
        maximumVertical: 0.45,
        headFollowStart: 0.72,
      },
    };
  };
  return parseSocketEyeSurfaceDefinition({
    schemaVersion: "socket-eye-surface/v1",
    definitionSha256: HASH_A,
    status: "product-export-approved",
    productExportApproved: true,
    coordinateSpace: "head-local",
    surfaceKind: "aperture-following-composite-cap",
    compositeLayers: [
      "sclera",
      "scleraArtwork",
      "iris",
      "pupil",
      "highlight",
      "cornea",
    ],
    rendering: {
      meshOwnsApertureMask: true,
      visibleFrontDepthTest: true,
      visibleFrontDepthWrite: true,
      visibleFrontSide: "front",
      renderOrder: "after-face-before-liner",
      requiredMaxTextureArrayLayers: 501,
    },
    artwork: {
      scleraOverlay: {
        gazeLinked: true,
        transparentRgba: true,
        minimumOverscanHorizontal: 0.8,
        minimumOverscanVertical: 0.75,
      },
    },
    runtimeBindings: { left: side("left"), right: side("right") },
  });
}

function seamDefinition() {
  const side = (name: "left" | "right") => {
    const code = name === "left" ? "L" : "R";
    return {
      side: name,
      sourceBodyNode: "Body",
      compositeCapNode: `BS_Eye_${code}_CompositeCap`,
      lashesEyeOutlineNode: `BS_EyeTreatmentCanvas_${code}`,
      upperBoundary: {
        sampleCount: 48,
        bindingSha256: name === "left" ? HASH_C : HASH_D,
      },
      lowerBoundary: {
        sampleCount: 48,
        bindingSha256: name === "left" ? HASH_D : HASH_C,
      },
      innerCanthusVertexIndex: name === "left" ? 1 : 3,
      outerCanthusVertexIndex: name === "left" ? 2 : 4,
      capUnderlapMeters: 0.002,
      liner: {
        innerOverlapMeters: 0.00045,
        surfaceClearanceMeters: 0.00008,
        baseForwardPitchDegrees: 0,
        faceConformal: true,
        visibleLidRimAllowed: false,
        ordinaryDepthTest: true,
        renderOrder: "after-composite-cap",
        retainedPerformanceMorphs: linerPerformanceMorphs(
          name === "left" ? "Left" : "Right",
        ),
        freeLashFlare: {
          profile: "geometry-derived-attachment-hinge/v1",
          direction: "model-forward",
          attachmentBandNormalizedWidth: 0.2,
          canthusTaperNormalizedWidth: 0.08,
          upperMaximumForwardOffsetMeters: 0.0016,
          lowerMaximumForwardOffsetMeters: 0.0028,
        },
      },
    };
  };
  return parseEyeApertureSeamDefinition({
    schemaVersion: "eye-aperture-seam/v1",
    definitionSha256: HASH_B,
    status: "product-export-approved",
    productExportApproved: true,
    sharedCanthusRoots: true,
    blinkClosure: {
      composition: "same-side-squint-floor/v1",
      fullBlinkSquintFloor: 0.5,
    },
    runtimeBindings: { left: side("left"), right: side("right") },
  });
}

function eyeMesh(name: string) {
  const cap = new THREE.Group();
  cap.name = name;
  const suffix = name.includes("_L_") ? "Left" : "Right";
  // The source definition also declares authoring-only identity followers,
  // but Appearance Dials removes those before the Socket Eye runtime binds.
  const retainedMorphs = [
    `eyeBlink${suffix}`,
    `eyeSquint${suffix}`,
    `eyeWide${suffix}`,
  ];
  for (const materialName of ["visible-front", "hidden-closure"]) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(
        [-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0],
        3,
      ),
    );
    geometry.setAttribute(
      "uv",
      new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2),
    );
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    geometry.morphTargetsRelative = true;
    geometry.morphAttributes.position = retainedMorphs.map((morphName) => {
      const attribute = new THREE.Float32BufferAttribute(
        new Float32Array(12),
        3,
      );
      attribute.name = morphName;
      return attribute;
    });
    const material = new THREE.MeshBasicMaterial();
    material.name = materialName;
    const primitive = new THREE.Mesh(geometry, material);
    primitive.name = `${name}_${materialName}`;
    primitive.morphTargetDictionary = Object.fromEntries(
      retainedMorphs.map((morphName, index) => [morphName, index]),
    );
    primitive.morphTargetInfluences = retainedMorphs.map(() => 0);
    cap.add(primitive);
  }
  return cap;
}

function linerMesh(name: string) {
  const liner = new THREE.Group();
  liner.name = name;
  const suffix = name.endsWith("_L") ? "Left" : "Right";
  const retainedMorphs = linerPerformanceMorphs(suffix);
  for (const [materialName, triangles, hidden] of [
    [`${name}_mat`, 2820, false],
    [`${name}_hidden_seal_mat`, 188, true],
  ] as const) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 0, 1, 0], 3),
    );
    geometry.setAttribute(
      "uv",
      new THREE.Float32BufferAttribute([0, 0, 1, 0, 0.5, 1], 2),
    );
    const indices = new Uint16Array(triangles * 3);
    for (let index = 0; index < indices.length; index += 3) {
      indices[index] = 0;
      indices[index + 1] = 1;
      indices[index + 2] = 2;
    }
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    geometry.morphTargetsRelative = true;
    geometry.morphAttributes.position = retainedMorphs.map((morphName) => {
      const attribute = new THREE.Float32BufferAttribute(new Float32Array(9), 3);
      attribute.name = morphName;
      return attribute;
    });
    const material = new THREE.MeshBasicMaterial({
      transparent: false,
      opacity: hidden ? 0 : 1,
      alphaTest: hidden ? 0.5 : 0,
    });
    material.name = materialName;
    if (hidden) material.userData.batshit_facial_artwork_hidden_seal = true;
    const primitive = new THREE.Mesh(geometry, material);
    primitive.name = `${name}_${hidden ? "hidden_seal" : "visible_artwork"}`;
    primitive.morphTargetDictionary = Object.fromEntries(
      retainedMorphs.map((morphName, index) => [morphName, index]),
    );
    primitive.morphTargetInfluences = retainedMorphs.map(() => 0);
    liner.add(primitive);
  }
  return liner;
}

function rootFixture() {
  const root = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.BufferGeometry(),
    new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false }),
  );
  body.name = "Body";
  root.add(body);
  for (const code of ["L", "R"]) {
    root.add(eyeMesh(`BS_Eye_${code}_CompositeCap`));
    root.add(linerMesh(`BS_EyeTreatmentCanvas_${code}`));
  }
  return root;
}

describe("SocketEyeCompositeMaterialRuntime", () => {
  it("builds the strict one-draw ordered composite material", () => {
    const definition = socketDefinition();
    const runtime = new SocketEyeCompositeMaterialRuntime(
      definition.runtimeBindings.left,
      visualState(),
      metricFrame(),
    );
    expect(runtime.material.isMeshPhysicalNodeMaterial).toBe(true);
    expect(runtime.material.transparent).toBe(true);
    expect(runtime.material.opacity).toBe(1);
    expect(runtime.material.blending).toBe(THREE.NormalBlending);
    expect(runtime.material.depthTest).toBe(true);
    expect(runtime.material.depthWrite).toBe(true);
    expect(runtime.material.side).toBe(THREE.FrontSide);
    expect(runtime.material.emissiveNode).not.toBeNull();
    expect(runtime.material.userData.batshitSocketEyeLighting).toEqual({
      scleraEmissiveWeight: 0.45,
    });
    expect(runtime.material.userData.batshitSocketEyeArtworkProjection).toBe(
      "deformed-surface-meters/v1",
    );
    expect(runtime.material.userData.batshitSocketEyeLayers).toEqual([
      "sclera",
      "scleraArtwork",
      "iris",
      "pupil",
      "highlight",
      "cornea",
    ]);
    const textureNodes = (
      runtime as unknown as { textureNodes: Record<string, { value: THREE.Texture }> }
    ).textureNodes;
    expect(
      new Set(Object.values(textureNodes).map((node) => node.value.uuid)).size,
    ).toBe(4);
    runtime.setGaze(0.2, -0.1);
    expect(runtime.getGaze().toArray()).toEqual([0.2, -0.1]);
    expect(() => runtime.setGaze(0.58, 0.45)).toThrow("safe domain");
    runtime.dispose();
  });

  it("rejects visual values that would make the material contract ambiguous", () => {
    const definition = socketDefinition();
    const state = visualState();
    state.irisRadiusMeters = 0.02;
    expect(
      () =>
        new SocketEyeCompositeMaterialRuntime(
          definition.runtimeBindings.left,
          state,
          metricFrame(),
        ),
    ).toThrow("virtual carrier");
  });

  it("never disposes caller-owned artwork textures", () => {
    const definition = socketDefinition();
    const textures = Array.from({ length: 4 }, () => new THREE.Texture());
    const disposeSpies = textures.map((textureValue) =>
      vi.spyOn(textureValue, "dispose"),
    );
    const initial = visualState();
    initial.scleraArtwork.texture = textures[0];
    initial.irisArtwork.texture = textures[1];
    const runtime = new SocketEyeCompositeMaterialRuntime(
      definition.runtimeBindings.left,
      initial,
      metricFrame(),
    );
    const updated = visualState();
    updated.pupilArtwork.texture = textures[2];
    updated.highlight.texture = textures[3];
    runtime.setState(updated);
    expect(runtime.getState().pupilArtwork.texture).toBe(textures[2]);
    expect(runtime.getState().highlight.texture).toBe(textures[3]);
    runtime.dispose();
    for (const disposeSpy of disposeSpies) {
      expect(disposeSpy).not.toHaveBeenCalled();
    }
  });
});

describe("SocketEyeSurfaceEngineRuntime", () => {
  it("binds only the visible primitive to the composite and suppresses hidden closure", () => {
    const root = rootFixture();
    const left = root.getObjectByName("BS_Eye_L_CompositeCap") as THREE.Group;
    const [visible, hidden] = left.children as THREE.Mesh[];
    const originalVisibleMaterial = visible.material;
    const originalHiddenMaterial = hidden.material;
    const leftLiner = root.getObjectByName("BS_EyeTreatmentCanvas_L") as THREE.Group;
    const [linerVisible, linerHidden] = leftLiner.children as THREE.Mesh[];
    const originalLinerVisibleMaterial = linerVisible.material;
    const originalLinerHiddenMaterial = linerHidden.material;
    const body = root.getObjectByName("Body") as THREE.Mesh;
    const bodyMaterial = body.material as THREE.Material;
    expect(bodyMaterial.depthWrite).toBe(false);
    const runtime = new SocketEyeSurfaceEngineRuntime(
      root,
      socketDefinition(),
      seamDefinition(),
      {
        left: visualState(),
        right: visualState(),
      },
    );
    expect(visible.material).toBe(runtime.getMaterial("left"));
    expect((hidden.material as THREE.Material).visible).toBe(false);
    expect(visible.renderOrder).toBe(SOCKET_EYE_COMPOSITE_RENDER_ORDER);
    expect(runtime.getLinerArtworkMesh("left")).toBe(linerVisible);
    expect(linerVisible.renderOrder).toBe(SOCKET_EYE_LINER_RENDER_ORDER);
    expect((linerHidden.material as THREE.Material).visible).toBe(false);
    expect((linerHidden.material as THREE.Material).colorWrite).toBe(false);
    expect((linerHidden.material as THREE.Material).depthTest).toBe(false);
    expect((linerHidden.material as THREE.Material).depthWrite).toBe(false);
    expect(bodyMaterial.depthWrite).toBe(true);
    runtime.dispose();
    expect(visible.material).toBe(originalVisibleMaterial);
    expect(hidden.material).toBe(originalHiddenMaterial);
    expect(visible.renderOrder).toBe(0);
    expect(linerVisible.material).toBe(originalLinerVisibleMaterial);
    expect(linerHidden.material).toBe(originalLinerHiddenMaterial);
    expect(linerVisible.renderOrder).toBe(0);
    expect(linerHidden.renderOrder).toBe(0);
    expect(bodyMaterial.depthWrite).toBe(false);
  });

  it("resolves liner primitives by exact material identity instead of child order", () => {
    const root = rootFixture();
    const left = root.getObjectByName("BS_EyeTreatmentCanvas_L") as THREE.Group;
    const [visible, hidden] = left.children as THREE.Mesh[];
    left.remove(visible, hidden);
    left.add(hidden, visible);
    const runtime = new SocketEyeSurfaceEngineRuntime(
      root,
      socketDefinition(),
      seamDefinition(),
      { left: visualState(), right: visualState() },
    );
    expect(runtime.getLinerArtworkMesh("left")).toBe(visible);
    expect((hidden.material as THREE.Material).visible).toBe(false);
    runtime.dispose();
  });

  it("fails closed when the hidden liner seal marker or followers drift", () => {
    const markerRoot = rootFixture();
    const markerLeft = markerRoot.getObjectByName(
      "BS_EyeTreatmentCanvas_L",
    ) as THREE.Group;
    const markerHidden = markerLeft.children[1] as THREE.Mesh;
    delete (markerHidden.material as THREE.Material).userData
      .batshit_facial_artwork_hidden_seal;
    expect(
      () =>
        new SocketEyeSurfaceEngineRuntime(
          markerRoot,
          socketDefinition(),
          seamDefinition(),
          { left: visualState(), right: visualState() },
        ),
    ).toThrow("hidden seal material contract drifted");

    const alphaRoot = rootFixture();
    const alphaLeft = alphaRoot.getObjectByName(
      "BS_EyeTreatmentCanvas_L",
    ) as THREE.Group;
    const alphaHidden = alphaLeft.children[1] as THREE.Mesh;
    (alphaHidden.material as THREE.Material).alphaTest = 0;
    expect(
      () =>
        new SocketEyeSurfaceEngineRuntime(
          alphaRoot,
          socketDefinition(),
          seamDefinition(),
          { left: visualState(), right: visualState() },
        ),
    ).toThrow("hidden seal material contract drifted");

    const morphRoot = rootFixture();
    const morphLeft = morphRoot.getObjectByName(
      "BS_EyeTreatmentCanvas_L",
    ) as THREE.Group;
    const morphHidden = morphLeft.children[1] as THREE.Mesh;
    morphHidden.geometry.morphAttributes.position.pop();
    delete morphHidden.morphTargetDictionary?.eyeWideLeft;
    morphHidden.morphTargetInfluences?.pop();
    expect(
      () =>
        new SocketEyeSurfaceEngineRuntime(
          morphRoot,
          socketDefinition(),
          seamDefinition(),
          { left: visualState(), right: visualState() },
        ),
    ).toThrow("follower morph POSITION count");
  });

  it("recenters physical artwork after identity geometry changes without scaling it", () => {
    const root = rootFixture();
    const runtime = new SocketEyeSurfaceEngineRuntime(
      root,
      socketDefinition(),
      seamDefinition(),
      { left: visualState(), right: visualState() },
    );
    expect(runtime.getMetricCenter("left").toArray()).toEqual([0, 0]);
    const left = root.getObjectByName("BS_Eye_L_CompositeCap") as THREE.Group;
    const visible = left.children[0] as THREE.Mesh;
    const position = visible.geometry.getAttribute(
      "position",
    ) as THREE.BufferAttribute;
    for (let index = 0; index < position.count; index += 1) {
      position.setX(index, position.getX(index) + 0.25);
      position.setY(index, position.getY(index) - 0.125);
    }
    runtime.syncIdentitySurfaceFrames();
    expect(runtime.getMetricCenter("left").toArray()).toEqual([0.25, -0.125]);
    runtime.dispose();
  });

  it("fails closed when visible and hidden faces are not distinct GLB primitives", () => {
    const root = rootFixture();
    const left = root.getObjectByName("BS_Eye_L_CompositeCap") as THREE.Group;
    left.remove(left.children[1]);
    expect(
      () =>
        new SocketEyeSurfaceEngineRuntime(
          root,
          socketDefinition(),
          seamDefinition(),
          {
            left: visualState(),
            right: visualState(),
          },
        ),
    ).toThrow("exactly two primitive meshes");
  });

  it("fails closed when a retained dynamic morph is missing", () => {
    const root = rootFixture();
    const left = root.getObjectByName("BS_Eye_L_CompositeCap") as THREE.Group;
    const visible = left.children[0] as THREE.Mesh;
    visible.geometry.morphAttributes.position.pop();
    delete visible.morphTargetDictionary?.eyeWideLeft;
    visible.morphTargetInfluences?.pop();
    expect(
      () =>
        new SocketEyeSurfaceEngineRuntime(
          root,
          socketDefinition(),
          seamDefinition(),
          { left: visualState(), right: visualState() },
        ),
    ).toThrow("follower morph POSITION count");
  });

  it("fails closed when an authoring-only identity morph survives compaction", () => {
    const root = rootFixture();
    const left = root.getObjectByName("BS_Eye_L_CompositeCap") as THREE.Group;
    const visible = left.children[0] as THREE.Mesh;
    const basePosition = visible.geometry.getAttribute("position");
    visible.geometry.morphAttributes.position.push(
      new THREE.Float32BufferAttribute(
        new Float32Array(basePosition.count * 3),
        3,
      ),
    );
    visible.morphTargetDictionary = {
      ...visible.morphTargetDictionary,
      identityFaceLeft: 3,
    };
    visible.morphTargetInfluences?.push(0);
    expect(
      () =>
        new SocketEyeSurfaceEngineRuntime(
          root,
          socketDefinition(),
          seamDefinition(),
          { left: visualState(), right: visualState() },
        ),
    ).toThrow("follower morph POSITION count");
  });

  it("fails closed when dictionary indices or influence counts drift", () => {
    const badIndexRoot = rootFixture();
    const badIndexLeft = badIndexRoot.getObjectByName(
      "BS_Eye_L_CompositeCap",
    ) as THREE.Group;
    const badIndexVisible = badIndexLeft.children[0] as THREE.Mesh;
    badIndexVisible.morphTargetDictionary = {
      eyeBlinkLeft: 0,
      eyeSquintLeft: 1,
      eyeWideLeft: 3,
    };
    expect(
      () =>
        new SocketEyeSurfaceEngineRuntime(
          badIndexRoot,
          socketDefinition(),
          seamDefinition(),
          { left: visualState(), right: visualState() },
        ),
    ).toThrow("invalid index");

    const badWeightsRoot = rootFixture();
    const badWeightsLeft = badWeightsRoot.getObjectByName(
      "BS_Eye_L_CompositeCap",
    ) as THREE.Group;
    const badWeightsHidden = badWeightsLeft.children[1] as THREE.Mesh;
    badWeightsHidden.morphTargetInfluences?.pop();
    expect(
      () =>
        new SocketEyeSurfaceEngineRuntime(
          badWeightsRoot,
          socketDefinition(),
          seamDefinition(),
          { left: visualState(), right: visualState() },
        ),
    ).toThrow("follower morph weights");
  });

  it("rolls the left side back when right-side binding fails", () => {
    const root = rootFixture();
    const left = root.getObjectByName("BS_Eye_L_CompositeCap") as THREE.Group;
    const [leftVisible, leftHidden] = left.children as THREE.Mesh[];
    const originalVisibleMaterial = leftVisible.material;
    const originalHiddenMaterial = leftHidden.material;
    const right = root.getObjectByName("BS_Eye_R_CompositeCap") as THREE.Group;
    right.remove(right.children[1]);
    const bodyMaterial = (root.getObjectByName("Body") as THREE.Mesh)
      .material as THREE.Material;

    expect(
      () =>
        new SocketEyeSurfaceEngineRuntime(
          root,
          socketDefinition(),
          seamDefinition(),
          { left: visualState(), right: visualState() },
        ),
    ).toThrow("exactly two primitive meshes");
    expect(leftVisible.material).toBe(originalVisibleMaterial);
    expect(leftHidden.material).toBe(originalHiddenMaterial);
    expect(leftVisible.renderOrder).toBe(0);
    expect(leftHidden.renderOrder).toBe(0);
    const leftLiner = root.getObjectByName("BS_EyeTreatmentCanvas_L") as THREE.Group;
    expect((leftLiner.children[0] as THREE.Mesh).renderOrder).toBe(0);
    expect((leftLiner.children[1] as THREE.Mesh).renderOrder).toBe(0);
    expect(bodyMaterial.depthWrite).toBe(false);
  });
});
