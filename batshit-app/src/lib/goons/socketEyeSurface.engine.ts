import * as THREE from "three";
import { MeshPhysicalNodeMaterial } from "three/webgpu";
import {
  dot,
  length,
  max,
  mix,
  positionLocal,
  smoothstep,
  texture,
  uniform,
  vec2,
} from "three/tsl";
import {
  SOCKET_EYE_COMPOSITE_LAYER_ORDER,
  socketEyeCapRetainedDynamicMorphs,
  type SocketEyeSide,
  type SocketEyeSurfaceDefinitionV1,
  type SocketEyeSurfaceSideDefinition,
} from "./socketEyeSurface";
import {
  validateSocketEyeApertureOwnership,
  type EyeApertureSeamDefinitionV1,
} from "./eyeApertureSeam";

type RuntimeMesh = THREE.Mesh<
  THREE.BufferGeometry,
  THREE.Material | THREE.Material[]
>;
type SocketEyeRgba = [number, number, number, number];

export type SocketEyeCompositeTextureLayer = {
  texture: THREE.Texture | null;
  tint: SocketEyeRgba;
  opacity: number;
};

export type SocketEyeCompositeVisualState = {
  scleraColor: SocketEyeRgba;
  irisColor: SocketEyeRgba;
  pupilColor: SocketEyeRgba;
  irisRadiusMeters: number;
  pupilRadiusRatio: number;
  irisVerticalOffsetMeters: number;
  edgeSoftnessMeters: number;
  scleraArtwork: SocketEyeCompositeTextureLayer;
  irisArtwork: SocketEyeCompositeTextureLayer;
  pupilArtwork: SocketEyeCompositeTextureLayer;
  highlight: SocketEyeCompositeTextureLayer;
  cornea: {
    roughness: number;
    clearcoat: number;
    clearcoatRoughness: number;
  };
};

type MaterialUniforms = {
  // Three's public TSL declaration exposes `uniform` as an overload interface
  // rather than a generic function type. Keep the runtime handles un-narrowed;
  // their concrete values are still constructed and updated below.
  gaze: any;
  metricCenter: any;
  horizontalAxisLocal: any;
  verticalAxisLocal: any;
  scleraColor: any;
  irisColor: any;
  pupilColor: any;
  irisRadius: any;
  pupilRadiusRatio: any;
  pupilVisibility: any;
  irisVerticalOffset: any;
  edgeSoftness: any;
  scleraArtworkTint: any;
  scleraArtworkOpacity: any;
  irisArtworkTint: any;
  irisArtworkOpacity: any;
  pupilArtworkTint: any;
  pupilArtworkOpacity: any;
  highlightTint: any;
  highlightOpacity: any;
};

type TextureNodes = {
  scleraArtwork: any;
  irisArtwork: any;
  pupilArtwork: any;
  highlight: any;
};

type BoundSide = {
  capNode: THREE.Object3D;
  visibleMesh: RuntimeMesh;
  hiddenMesh: RuntimeMesh;
  linerNode: THREE.Object3D;
  linerVisibleMesh: RuntimeMesh;
  linerHiddenMesh: RuntimeMesh;
  originalVisibleMaterial: THREE.Material;
  originalHiddenMaterial: THREE.Material;
  originalLinerVisibleMaterial: THREE.Material;
  originalLinerHiddenMaterial: THREE.Material;
  originalVisibleRenderOrder: number;
  originalHiddenRenderOrder: number;
  originalLinerVisibleRenderOrder: number;
  originalLinerHiddenRenderOrder: number;
  hiddenMaterial: THREE.MeshBasicMaterial;
  linerHiddenMaterial: THREE.MeshBasicMaterial;
  compositeMaterial: SocketEyeCompositeMaterialRuntime;
  metricFrame: SocketEyeSurfaceMetricFrame;
};

export type SocketEyeSurfaceMetricFrame = {
  horizontalAxisLocal: THREE.Vector3;
  verticalAxisLocal: THREE.Vector3;
  centerMeters: THREE.Vector2;
};

type BodyDepthMaterialState = {
  material: THREE.Material;
  depthWrite: boolean;
};

export const SOCKET_EYE_COMPOSITE_RENDER_ORDER = 100;
export const SOCKET_EYE_LINER_RENDER_ORDER = 101;
export const SOCKET_EYE_SCLERA_EMISSIVE_WEIGHT = 0.45;

function fail(message: string): never {
  throw new Error(`[socket-eye-surface/runtime] ${message}`);
}

function finite(value: number, context: string) {
  if (!Number.isFinite(value)) fail(`${context} must be finite`);
  return value;
}

function positive(value: number, context: string) {
  const parsed = finite(value, context);
  if (parsed <= 0) fail(`${context} must be greater than zero`);
  return parsed;
}

function nonNegative(value: number, context: string) {
  const parsed = finite(value, context);
  if (parsed < 0) fail(`${context} must not be negative`);
  return parsed;
}

function unitInterval(value: number, context: string) {
  const parsed = finite(value, context);
  if (parsed < 0 || parsed > 1) fail(`${context} must be inside [0, 1]`);
  return parsed;
}

function rgba(value: SocketEyeRgba, context: string, opaque: boolean) {
  if (!Array.isArray(value) || value.length !== 4)
    fail(`${context} must contain four channels`);
  const parsed = value.map((channel, index) =>
    unitInterval(channel, `${context}[${index}]`),
  ) as SocketEyeRgba;
  if (opaque && parsed[3] !== 1) fail(`${context} must remain opaque`);
  return parsed;
}

function colorFromSrgb(value: SocketEyeRgba) {
  return new THREE.Color().setRGB(
    value[0],
    value[1],
    value[2],
    THREE.SRGBColorSpace,
  );
}

function makeTransparentPixelTexture() {
  const value = new THREE.DataTexture(
    new Uint8Array([0, 0, 0, 0]),
    1,
    1,
    THREE.RGBAFormat,
  );
  value.name = "Batshit socket-eye transparent texture";
  value.colorSpace = THREE.SRGBColorSpace;
  value.needsUpdate = true;
  return value;
}

function materialList(material: THREE.Material | THREE.Material[]) {
  return Array.isArray(material) ? material : [material];
}

function exactNamedObject(root: THREE.Object3D, name: string) {
  const matches: THREE.Object3D[] = [];
  root.traverse((node) => {
    if (node.name === name) matches.push(node);
  });
  if (matches.length !== 1)
    fail(
      `expected exactly one runtime object named ${name}, found ${matches.length}`,
    );
  return matches[0];
}

function exactNamedMesh(root: THREE.Object3D, name: string): RuntimeMesh {
  const node = exactNamedObject(root, name);
  if (!(node as { isMesh?: boolean }).isMesh) fail(`${name} must be a mesh`);
  return node as RuntimeMesh;
}

function validateVisualState(
  side: SocketEyeSurfaceSideDefinition,
  value: SocketEyeCompositeVisualState,
) {
  const irisRadiusMeters = positive(
    value.irisRadiusMeters,
    "state.irisRadiusMeters",
  );
  if (
    irisRadiusMeters >=
    Math.min(side.cap.carrierHalfWidthMeters, side.cap.carrierHalfHeightMeters)
  ) {
    fail("state.irisRadiusMeters must stay inside the virtual carrier");
  }
  const pupilRadiusRatio = nonNegative(
    value.pupilRadiusRatio,
    "state.pupilRadiusRatio",
  );
  if (pupilRadiusRatio >= 1) fail("state.pupilRadiusRatio must stay below one");
  const irisVerticalOffsetMeters = finite(
    value.irisVerticalOffsetMeters,
    "state.irisVerticalOffsetMeters",
  );
  if (
    Math.abs(irisVerticalOffsetMeters) + irisRadiusMeters >=
    side.cap.carrierHalfHeightMeters
  ) {
    fail("state iris vertical offset and radius must stay inside the virtual carrier");
  }
  const edgeSoftnessMeters = positive(
    value.edgeSoftnessMeters,
    "state.edgeSoftnessMeters",
  );
  if (
    pupilRadiusRatio > 0 &&
    edgeSoftnessMeters >= irisRadiusMeters * pupilRadiusRatio
  ) {
    fail("state.edgeSoftnessMeters must stay below the pupil radius");
  }
  return {
    scleraColor: rgba(value.scleraColor, "state.scleraColor", true),
    irisColor: rgba(value.irisColor, "state.irisColor", true),
    pupilColor: rgba(value.pupilColor, "state.pupilColor", true),
    irisRadiusMeters,
    pupilRadiusRatio,
    irisVerticalOffsetMeters,
    edgeSoftnessMeters,
    scleraArtwork: {
      texture: value.scleraArtwork.texture,
      tint: rgba(value.scleraArtwork.tint, "state.scleraArtwork.tint", false),
      opacity: unitInterval(
        value.scleraArtwork.opacity,
        "state.scleraArtwork.opacity",
      ),
    },
    irisArtwork: {
      texture: value.irisArtwork.texture,
      tint: rgba(value.irisArtwork.tint, "state.irisArtwork.tint", false),
      opacity: unitInterval(
        value.irisArtwork.opacity,
        "state.irisArtwork.opacity",
      ),
    },
    pupilArtwork: {
      texture: value.pupilArtwork.texture,
      tint: rgba(value.pupilArtwork.tint, "state.pupilArtwork.tint", false),
      opacity: unitInterval(
        value.pupilArtwork.opacity,
        "state.pupilArtwork.opacity",
      ),
    },
    highlight: {
      texture: value.highlight.texture,
      tint: rgba(value.highlight.tint, "state.highlight.tint", false),
      opacity: unitInterval(value.highlight.opacity, "state.highlight.opacity"),
    },
    cornea: {
      roughness: unitInterval(value.cornea.roughness, "state.cornea.roughness"),
      clearcoat: unitInterval(value.cornea.clearcoat, "state.cornea.clearcoat"),
      clearcoatRoughness: unitInterval(
        value.cornea.clearcoatRoughness,
        "state.cornea.clearcoatRoughness",
      ),
    },
  } satisfies SocketEyeCompositeVisualState;
}

function validateTrianglePrimitive(mesh: RuntimeMesh, context: string) {
  if (Array.isArray(mesh.material)) fail(`${context} must own one material`);
  const count =
    mesh.geometry.index?.count ??
    mesh.geometry.getAttribute("position")?.count ??
    0;
  if (count <= 0 || count % 3 !== 0)
    fail(`${context} must contain complete triangles`);
  const uvAttribute = mesh.geometry.getAttribute("uv");
  if (!uvAttribute || uvAttribute.itemSize !== 2 || uvAttribute.count <= 0) {
    fail(`${context} must expose the package-authored UV projection`);
  }
}

function triangleCount(mesh: RuntimeMesh) {
  return (
    (mesh.geometry.index?.count ??
      mesh.geometry.getAttribute("position")?.count ??
      0) / 3
  );
}

function metricCenterForGeometry(
  mesh: RuntimeMesh,
  horizontalAxisLocal: THREE.Vector3,
  verticalAxisLocal: THREE.Vector3,
) {
  const position = mesh.geometry.getAttribute("position");
  if (!position || position.itemSize !== 3 || position.count <= 0) {
    fail(`${mesh.name} cannot resolve a physical artwork frame without POSITION`);
  }
  const point = new THREE.Vector3();
  let minimumHorizontal = Number.POSITIVE_INFINITY;
  let maximumHorizontal = Number.NEGATIVE_INFINITY;
  let minimumVertical = Number.POSITIVE_INFINITY;
  let maximumVertical = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < position.count; index += 1) {
    point.fromBufferAttribute(position, index);
    const horizontal = point.dot(horizontalAxisLocal);
    const vertical = point.dot(verticalAxisLocal);
    minimumHorizontal = Math.min(minimumHorizontal, horizontal);
    maximumHorizontal = Math.max(maximumHorizontal, horizontal);
    minimumVertical = Math.min(minimumVertical, vertical);
    maximumVertical = Math.max(maximumVertical, vertical);
  }
  const center = new THREE.Vector2(
    (minimumHorizontal + maximumHorizontal) * 0.5,
    (minimumVertical + maximumVertical) * 0.5,
  );
  if (!Number.isFinite(center.x) || !Number.isFinite(center.y)) {
    fail(`${mesh.name} produced a non-finite physical artwork center`);
  }
  return center;
}

export function resolveSocketEyeSurfaceMetricFrame(
  capNode: THREE.Object3D,
  visibleMesh: RuntimeMesh,
  side: SocketEyeSurfaceSideDefinition,
): SocketEyeSurfaceMetricFrame {
  const headOwner = capNode.parent;
  if (!headOwner) fail(`${capNode.name} must retain its Head owner`);
  headOwner.updateWorldMatrix(true, false);
  visibleMesh.updateWorldMatrix(true, false);
  const headToMesh = visibleMesh.matrixWorld
    .clone()
    .invert()
    .multiply(headOwner.matrixWorld);
  const horizontalAxisLocal = new THREE.Vector3(
    ...side.horizontalAxisHeadLocal,
  )
    .transformDirection(headToMesh)
    .normalize();
  const verticalAxisLocal = new THREE.Vector3(...side.verticalAxisHeadLocal)
    .transformDirection(headToMesh)
    .normalize();
  if (
    !Number.isFinite(horizontalAxisLocal.lengthSq()) ||
    !Number.isFinite(verticalAxisLocal.lengthSq()) ||
    Math.abs(horizontalAxisLocal.dot(verticalAxisLocal)) > 1e-5
  ) {
    fail(`${capNode.name} physical artwork axes are invalid`);
  }
  return {
    horizontalAxisLocal,
    verticalAxisLocal,
    centerMeters: metricCenterForGeometry(
      visibleMesh,
      horizontalAxisLocal,
      verticalAxisLocal,
    ),
  };
}

function validateFollowerMorphInventory(
  mesh: RuntimeMesh,
  expected: readonly string[],
  context: string,
) {
  const basePosition = mesh.geometry.getAttribute("position");
  if (!basePosition || basePosition.itemSize !== 3 || basePosition.count <= 0) {
    fail(`${context} must expose a valid base POSITION attribute`);
  }
  const positionMorphs = mesh.geometry.morphAttributes.position ?? [];
  const dictionary = mesh.morphTargetDictionary ?? {};
  const influences = mesh.morphTargetInfluences ?? [];
  if (!mesh.geometry.morphTargetsRelative) {
    fail(`${context} follower morphs must use relative glTF deltas`);
  }
  if (positionMorphs.length !== expected.length) {
    fail(
      `${context} follower morph POSITION count ${positionMorphs.length} does not match the declared inventory ${expected.length}`,
    );
  }
  if (Object.keys(dictionary).length !== expected.length) {
    fail(
      `${context} follower morph dictionary does not match the declared inventory`,
    );
  }
  if (influences.length !== expected.length) {
    fail(
      `${context} follower morph weights do not match the declared inventory`,
    );
  }
  const namesByIndex = new Array<string>(expected.length);
  for (const [name, index] of Object.entries(dictionary)) {
    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index >= expected.length ||
      namesByIndex[index] !== undefined
    ) {
      fail(
        `${context} follower morph dictionary contains an invalid index for ${name}`,
      );
    }
    namesByIndex[index] = name;
  }
  if (namesByIndex.some((name) => name === undefined)) {
    fail(`${context} follower morph dictionary indices must be contiguous`);
  }
  const actual = [...namesByIndex].sort();
  if (
    actual.length !== expected.length ||
    actual.some((name, index) => name !== expected[index])
  ) {
    fail(
      `${context} follower morph inventory drifted from the package contract`,
    );
  }
  for (const [index, attribute] of positionMorphs.entries()) {
    if (attribute.itemSize !== 3 || attribute.count !== basePosition.count) {
      fail(
        `${context} follower morph ${namesByIndex[index]} must match the primitive POSITION layout`,
      );
    }
  }
}

function bindCompositeCapPrimitives(
  root: THREE.Object3D,
  side: SocketEyeSurfaceSideDefinition,
) {
  const capNode = exactNamedObject(root, side.nodes.compositeCap);
  if ((capNode as { isMesh?: boolean }).isMesh) {
    fail(
      `${capNode.name} must load as one node with separate visible and hidden primitives`,
    );
  }
  const meshes: RuntimeMesh[] = [];
  capNode.traverse((node) => {
    if (node !== capNode && (node as { isMesh?: boolean }).isMesh)
      meshes.push(node as RuntimeMesh);
  });
  if (meshes.length !== 2) {
    fail(
      `${capNode.name} must contain exactly two primitive meshes, found ${meshes.length}`,
    );
  }
  const byMaterialName = (name: string) =>
    meshes.filter(
      (mesh) => !Array.isArray(mesh.material) && mesh.material.name === name,
    );
  const visible = byMaterialName(side.cap.visibleFrontFaceGroup);
  const hidden = byMaterialName(side.cap.hiddenClosureFaceGroup);
  if (visible.length !== 1 || hidden.length !== 1 || visible[0] === hidden[0]) {
    fail(
      `${capNode.name} must keep visible-front and hidden-closure in separate GLB primitives`,
    );
  }
  validateTrianglePrimitive(
    visible[0],
    `${capNode.name}/${side.cap.visibleFrontFaceGroup}`,
  );
  validateTrianglePrimitive(
    hidden[0],
    `${capNode.name}/${side.cap.hiddenClosureFaceGroup}`,
  );
  validateFollowerMorphInventory(
    visible[0],
    socketEyeCapRetainedDynamicMorphs(side.side),
    `${capNode.name}/${side.cap.visibleFrontFaceGroup}`,
  );
  validateFollowerMorphInventory(
    hidden[0],
    socketEyeCapRetainedDynamicMorphs(side.side),
    `${capNode.name}/${side.cap.hiddenClosureFaceGroup}`,
  );
  return { capNode, visibleMesh: visible[0], hiddenMesh: hidden[0] };
}

function bindLinerPrimitives(
  root: THREE.Object3D,
  nodeName: string,
  retainedMorphs: readonly string[],
) {
  const linerNode = exactNamedObject(root, nodeName);
  if ((linerNode as { isMesh?: boolean }).isMesh) {
    fail(
      `${linerNode.name} must load as one node with separate visible artwork and hidden seal primitives`,
    );
  }
  const meshes: RuntimeMesh[] = [];
  linerNode.traverse((node) => {
    if (node !== linerNode && (node as { isMesh?: boolean }).isMesh)
      meshes.push(node as RuntimeMesh);
  });
  if (meshes.length !== 2) {
    fail(
      `${linerNode.name} must contain exactly two primitive meshes, found ${meshes.length}`,
    );
  }
  const visibleMaterialName = `${nodeName}_mat`;
  const hiddenMaterialName = `${nodeName}_hidden_seal_mat`;
  const byMaterialName = (name: string) =>
    meshes.filter(
      (mesh) => !Array.isArray(mesh.material) && mesh.material.name === name,
    );
  const visible = byMaterialName(visibleMaterialName);
  const hidden = byMaterialName(hiddenMaterialName);
  if (visible.length !== 1 || hidden.length !== 1 || visible[0] === hidden[0]) {
    fail(
      `${linerNode.name} must keep visible artwork and hidden seal in separate exact GLB primitives`,
    );
  }
  const visibleMesh = visible[0];
  const hiddenMesh = hidden[0];
  validateTrianglePrimitive(visibleMesh, `${linerNode.name}/visible-artwork`);
  validateTrianglePrimitive(hiddenMesh, `${linerNode.name}/hidden-seal`);
  if (triangleCount(visibleMesh) !== 2820 || triangleCount(hiddenMesh) !== 188) {
    fail(
      `${linerNode.name} must retain 2820 visible artwork triangles and 188 hidden seal triangles`,
    );
  }
  const hiddenMaterial = hiddenMesh.material as THREE.Material;
  if (
    hiddenMaterial.userData?.batshit_facial_artwork_hidden_seal !== true ||
    hiddenMaterial.opacity !== 0 ||
    hiddenMaterial.transparent ||
    hiddenMaterial.alphaTest !== 0.5
  ) {
    fail(`${linerNode.name} hidden seal material contract drifted`);
  }
  validateFollowerMorphInventory(
    visibleMesh,
    retainedMorphs,
    `${linerNode.name}/visible-artwork`,
  );
  validateFollowerMorphInventory(
    hiddenMesh,
    retainedMorphs,
    `${linerNode.name}/hidden-seal`,
  );
  return { linerNode, visibleMesh, hiddenMesh };
}

export class SocketEyeCompositeMaterialRuntime {
  readonly material: MeshPhysicalNodeMaterial;
  private readonly transparentPixels: Record<keyof TextureNodes, THREE.DataTexture>;
  private readonly uniforms: MaterialUniforms;
  private readonly textureNodes: TextureNodes;
  private state: SocketEyeCompositeVisualState;
  private disposed = false;

  constructor(
    private readonly side: SocketEyeSurfaceSideDefinition,
    initialState: SocketEyeCompositeVisualState,
    metricFrame: SocketEyeSurfaceMetricFrame,
  ) {
    this.state = validateVisualState(side, initialState);
    this.transparentPixels = {
      scleraArtwork: makeTransparentPixelTexture(),
      irisArtwork: makeTransparentPixelTexture(),
      pupilArtwork: makeTransparentPixelTexture(),
      highlight: makeTransparentPixelTexture(),
    };
    const carrierSpan = uniform(
      new THREE.Vector2(
        side.cap.carrierHalfWidthMeters * 2,
        side.cap.carrierHalfHeightMeters * 2,
      ),
    );
    const carrierHalfSpan = uniform(
      new THREE.Vector2(
        side.cap.carrierHalfWidthMeters,
        side.cap.carrierHalfHeightMeters,
      ),
    );
    this.uniforms = {
      gaze: uniform(new THREE.Vector2()),
      metricCenter: uniform(metricFrame.centerMeters.clone()),
      horizontalAxisLocal: uniform(metricFrame.horizontalAxisLocal.clone()),
      verticalAxisLocal: uniform(metricFrame.verticalAxisLocal.clone()),
      scleraColor: uniform(colorFromSrgb(this.state.scleraColor)),
      irisColor: uniform(colorFromSrgb(this.state.irisColor)),
      pupilColor: uniform(colorFromSrgb(this.state.pupilColor)),
      irisRadius: uniform(this.state.irisRadiusMeters),
      pupilRadiusRatio: uniform(this.state.pupilRadiusRatio),
      pupilVisibility: uniform(this.state.pupilRadiusRatio > 0 ? 1 : 0),
      irisVerticalOffset: uniform(this.state.irisVerticalOffsetMeters),
      edgeSoftness: uniform(this.state.edgeSoftnessMeters),
      scleraArtworkTint: uniform(colorFromSrgb(this.state.scleraArtwork.tint)),
      scleraArtworkOpacity: uniform(
        this.state.scleraArtwork.opacity * this.state.scleraArtwork.tint[3],
      ),
      irisArtworkTint: uniform(colorFromSrgb(this.state.irisArtwork.tint)),
      irisArtworkOpacity: uniform(
        this.state.irisArtwork.opacity * this.state.irisArtwork.tint[3],
      ),
      pupilArtworkTint: uniform(colorFromSrgb(this.state.pupilArtwork.tint)),
      pupilArtworkOpacity: uniform(
        this.state.pupilArtwork.opacity * this.state.pupilArtwork.tint[3],
      ),
      highlightTint: uniform(colorFromSrgb(this.state.highlight.tint)),
      highlightOpacity: uniform(
        this.state.highlight.opacity * this.state.highlight.tint[3],
      ),
    };
    this.textureNodes = {
      scleraArtwork: texture(
        this.state.scleraArtwork.texture ?? this.transparentPixels.scleraArtwork,
      ),
      irisArtwork: texture(
        this.state.irisArtwork.texture ?? this.transparentPixels.irisArtwork,
      ),
      pupilArtwork: texture(
        this.state.pupilArtwork.texture ?? this.transparentPixels.pupilArtwork,
      ),
      highlight: texture(
        this.state.highlight.texture ?? this.transparentPixels.highlight,
      ),
    };

    const surfaceMeters = vec2(
      dot(positionLocal, this.uniforms.horizontalAxisLocal).sub(
        this.uniforms.metricCenter.x,
      ),
      dot(positionLocal, this.uniforms.verticalAxisLocal).sub(
        this.uniforms.metricCenter.y,
      ),
    );
    const surfaceUv = surfaceMeters.div(carrierSpan).add(0.5);
    const gazeOffsetUv = this.uniforms.gaze.mul(0.5);
    const gazeLinkedUv = surfaceUv.sub(gazeOffsetUv);
    const gazeCenterMeters = this.uniforms.gaze.mul(carrierHalfSpan);
    // Neutral Eye Appearance calibration is intentionally additive to gaze.
    // It shifts Iris/Pupil/Highlight together while Sclera artwork remains
    // driven only by gaze-linked carrier coordinates.
    const irisCenterMeters = gazeCenterMeters.add(
      vec2(0, this.uniforms.irisVerticalOffset),
    );
    const gazeDeltaMeters = surfaceMeters.sub(irisCenterMeters);
    const radialDistance = length(gazeDeltaMeters);
    const irisMask = smoothstep(
      this.uniforms.irisRadius.sub(this.uniforms.edgeSoftness),
      this.uniforms.irisRadius.add(this.uniforms.edgeSoftness),
      radialDistance,
    ).oneMinus();
    const pupilRadius = this.uniforms.irisRadius.mul(
      this.uniforms.pupilRadiusRatio,
    );
    const pupilMask = smoothstep(
      pupilRadius.sub(this.uniforms.edgeSoftness),
      pupilRadius.add(this.uniforms.edgeSoftness),
      radialDistance,
    ).oneMinus();
    const irisUv = gazeDeltaMeters
      .div(this.uniforms.irisRadius.mul(2))
      .add(vec2(0.5));
    const pupilUv = gazeDeltaMeters
      .div(max(pupilRadius, this.uniforms.edgeSoftness).mul(2))
      .add(vec2(0.5));

    const scleraArtworkSample =
      this.textureNodes.scleraArtwork.sample(gazeLinkedUv);
    const irisArtworkSample = this.textureNodes.irisArtwork.sample(irisUv);
    const pupilArtworkSample = this.textureNodes.pupilArtwork.sample(pupilUv);
    const highlightSample = this.textureNodes.highlight.sample(irisUv);
    const scleraArtworkAlpha = scleraArtworkSample.a.mul(
      this.uniforms.scleraArtworkOpacity,
    );
    const scleraPresentationColor = mix(
      this.uniforms.scleraColor,
      scleraArtworkSample.rgb.mul(this.uniforms.scleraArtworkTint),
      scleraArtworkAlpha,
    );
    const irisPresentationColor = mix(
      this.uniforms.irisColor,
      irisArtworkSample.rgb.mul(this.uniforms.irisArtworkTint),
      irisArtworkSample.a.mul(this.uniforms.irisArtworkOpacity),
    );
    const pupilPresentationColor = mix(
      this.uniforms.pupilColor,
      pupilArtworkSample.rgb.mul(this.uniforms.pupilArtworkTint),
      pupilArtworkSample.a.mul(this.uniforms.pupilArtworkOpacity),
    );
    const colorLayers = [
      { id: "iris" as const, color: irisPresentationColor, alpha: irisMask },
      {
        id: "pupil" as const,
        color: pupilPresentationColor,
        alpha: pupilMask.mul(this.uniforms.pupilVisibility),
      },
      {
        id: "highlight" as const,
        color: highlightSample.rgb.mul(this.uniforms.highlightTint),
        alpha: highlightSample.a
          .mul(this.uniforms.highlightOpacity)
          .mul(irisMask),
      },
    ];
    let colorNode: any = scleraPresentationColor;
    for (const layer of colorLayers)
      colorNode = mix(colorNode, layer.color as any, layer.alpha as any);

    const material = new MeshPhysicalNodeMaterial();
    material.name = `${side.nodes.compositeCap}__socket_eye_composite_runtime`;
    // Sclera artwork is authored as presentation color, so steeply curved edge
    // polygons must not turn gray simply because their normals face away from
    // the room key light. Add a bounded self-lit contribution only outside the
    // iris; the iris, pupil, highlight, and physical clearcoat keep their full
    // ordinary light response and corneal shine.
    material.colorNode = colorNode;
    material.emissiveNode = scleraPresentationColor
      .mul(SOCKET_EYE_SCLERA_EMISSIVE_WEIGHT)
      .mul(irisMask.oneMinus());
    // The first-party body is intentionally exported as BLEND. Keep the cap
    // in that transparent queue so renderOrder can enforce face -> cap ->
    // liner. Retain ordinary depth testing against the body depth written by
    // SocketEyeSurfaceEngineRuntime, then write the cap's own fully opaque
    // depth so later liner fragments behind the eye cannot paint through it.
    // This lets the eyelids physically occlude the cap during Blink while the
    // cap correctly occludes the liner from oblique and profile views.
    material.transparent = true;
    material.opacity = 1;
    material.premultipliedAlpha = false;
    material.blending = THREE.NormalBlending;
    material.depthTest = true;
    material.depthWrite = true;
    material.side = THREE.FrontSide;
    material.metalness = 0;
    material.roughness = this.state.cornea.roughness;
    material.clearcoat = this.state.cornea.clearcoat;
    material.clearcoatRoughness = this.state.cornea.clearcoatRoughness;
    material.userData = {
      ...material.userData,
      batshitSocketEyeLayers: [...SOCKET_EYE_COMPOSITE_LAYER_ORDER],
      batshitSocketEyeSurface: side.side,
      batshitSocketEyeArtworkProjection: side.cap.artworkProjection,
      batshitSocketEyeLighting: {
        scleraEmissiveWeight: SOCKET_EYE_SCLERA_EMISSIVE_WEIGHT,
      },
    };
    this.material = material;
  }

  getState() {
    return {
      ...this.state,
      scleraArtwork: { ...this.state.scleraArtwork },
      irisArtwork: { ...this.state.irisArtwork },
      pupilArtwork: { ...this.state.pupilArtwork },
      highlight: { ...this.state.highlight },
      cornea: { ...this.state.cornea },
    };
  }

  setMetricCenter(value: THREE.Vector2) {
    if (this.disposed) fail("cannot update metric center after disposal");
    if (!Number.isFinite(value.x) || !Number.isFinite(value.y)) {
      fail("metric center must remain finite");
    }
    this.uniforms.metricCenter.value.copy(value);
  }

  getMetricCenter() {
    return this.uniforms.metricCenter.value.clone();
  }

  setState(value: SocketEyeCompositeVisualState) {
    if (this.disposed) fail("cannot update composite material after disposal");
    this.state = validateVisualState(this.side, value);
    this.uniforms.scleraColor.value.copy(colorFromSrgb(this.state.scleraColor));
    this.uniforms.irisColor.value.copy(colorFromSrgb(this.state.irisColor));
    this.uniforms.pupilColor.value.copy(colorFromSrgb(this.state.pupilColor));
    this.uniforms.irisRadius.value = this.state.irisRadiusMeters;
    this.uniforms.pupilRadiusRatio.value = this.state.pupilRadiusRatio;
    this.uniforms.pupilVisibility.value =
      this.state.pupilRadiusRatio > 0 ? 1 : 0;
    this.uniforms.irisVerticalOffset.value =
      this.state.irisVerticalOffsetMeters;
    this.uniforms.edgeSoftness.value = this.state.edgeSoftnessMeters;
    this.uniforms.scleraArtworkTint.value.copy(
      colorFromSrgb(this.state.scleraArtwork.tint),
    );
    this.uniforms.scleraArtworkOpacity.value =
      this.state.scleraArtwork.opacity * this.state.scleraArtwork.tint[3];
    this.uniforms.irisArtworkTint.value.copy(
      colorFromSrgb(this.state.irisArtwork.tint),
    );
    this.uniforms.irisArtworkOpacity.value =
      this.state.irisArtwork.opacity * this.state.irisArtwork.tint[3];
    this.uniforms.pupilArtworkTint.value.copy(
      colorFromSrgb(this.state.pupilArtwork.tint),
    );
    this.uniforms.pupilArtworkOpacity.value =
      this.state.pupilArtwork.opacity * this.state.pupilArtwork.tint[3];
    this.uniforms.highlightTint.value.copy(
      colorFromSrgb(this.state.highlight.tint),
    );
    this.uniforms.highlightOpacity.value =
      this.state.highlight.opacity * this.state.highlight.tint[3];
    this.textureNodes.scleraArtwork.value =
      this.state.scleraArtwork.texture ?? this.transparentPixels.scleraArtwork;
    this.textureNodes.irisArtwork.value =
      this.state.irisArtwork.texture ?? this.transparentPixels.irisArtwork;
    this.textureNodes.pupilArtwork.value =
      this.state.pupilArtwork.texture ?? this.transparentPixels.pupilArtwork;
    this.textureNodes.highlight.value =
      this.state.highlight.texture ?? this.transparentPixels.highlight;
    this.material.roughness = this.state.cornea.roughness;
    this.material.clearcoat = this.state.cornea.clearcoat;
    this.material.clearcoatRoughness = this.state.cornea.clearcoatRoughness;
  }

  setGaze(horizontal: number, vertical: number) {
    if (this.disposed) fail("cannot update gaze after disposal");
    const x = finite(horizontal, "gaze.horizontal");
    const y = finite(vertical, "gaze.vertical");
    const radius = Math.sqrt(
      (x * x) /
        (this.side.gaze.maximumHorizontal * this.side.gaze.maximumHorizontal) +
        (y * y) /
          (this.side.gaze.maximumVertical * this.side.gaze.maximumVertical),
    );
    if (radius > 1 + 1e-9)
      fail("gaze coordinate exceeds the package safe domain");
    this.uniforms.gaze.value.set(x, y);
  }

  getGaze() {
    return this.uniforms.gaze.value.clone();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.material.dispose();
    for (const textureValue of Object.values(this.transparentPixels)) {
      textureValue.dispose();
    }
  }
}

export class SocketEyeSurfaceEngineRuntime {
  private readonly sides: Record<SocketEyeSide, BoundSide>;
  private readonly bodyDepthMaterials: BodyDepthMaterialState[];
  private disposed = false;

  constructor(
    private readonly root: THREE.Object3D,
    readonly definition: SocketEyeSurfaceDefinitionV1,
    readonly apertureSeam: EyeApertureSeamDefinitionV1,
    initialState: Record<SocketEyeSide, SocketEyeCompositeVisualState>,
  ) {
    validateSocketEyeApertureOwnership(definition, apertureSeam);
    this.bodyDepthMaterials = this.enableBodyDepthOcclusion();
    const bound: Partial<Record<SocketEyeSide, BoundSide>> = {};
    try {
      bound.left = this.bindSide("left", initialState.left);
      bound.right = this.bindSide("right", initialState.right);
    } catch (error) {
      if (bound.right) this.releaseSide(bound.right);
      if (bound.left) this.releaseSide(bound.left);
      this.restoreBodyDepthOcclusion();
      throw error;
    }
    this.sides = { left: bound.left, right: bound.right };
  }

  private enableBodyDepthOcclusion() {
    const seen = new Set<THREE.Material>();
    const states: BodyDepthMaterialState[] = [];
    for (const side of ["left", "right"] as const) {
      const sourceBody = exactNamedMesh(
        this.root,
        this.apertureSeam.runtimeBindings[side].sourceBodyNode,
      );
      for (const material of materialList(sourceBody.material)) {
        if (seen.has(material)) continue;
        seen.add(material);
        states.push({ material, depthWrite: material.depthWrite });
        material.depthWrite = true;
      }
    }
    return states;
  }

  private restoreBodyDepthOcclusion() {
    for (const state of this.bodyDepthMaterials) {
      state.material.depthWrite = state.depthWrite;
    }
  }

  private bindSide(
    sideName: SocketEyeSide,
    state: SocketEyeCompositeVisualState,
  ): BoundSide {
    const side = this.definition.runtimeBindings[sideName];
    const seam = this.apertureSeam.runtimeBindings[sideName];
    exactNamedObject(this.root, seam.sourceBodyNode);
    const { capNode, visibleMesh, hiddenMesh } = bindCompositeCapPrimitives(
      this.root,
      side,
    );
    const {
      linerNode,
      visibleMesh: linerVisibleMesh,
      hiddenMesh: linerHiddenMesh,
    } = bindLinerPrimitives(
      this.root,
      seam.lashesEyeOutlineNode,
      seam.liner.retainedPerformanceMorphs,
    );
    const originalVisibleMaterial = visibleMesh.material as THREE.Material;
    const originalHiddenMaterial = hiddenMesh.material as THREE.Material;
    const originalLinerVisibleMaterial = linerVisibleMesh.material as THREE.Material;
    const originalLinerHiddenMaterial = linerHiddenMesh.material as THREE.Material;
    const originalVisibleRenderOrder = visibleMesh.renderOrder;
    const originalHiddenRenderOrder = hiddenMesh.renderOrder;
    const originalLinerVisibleRenderOrder = linerVisibleMesh.renderOrder;
    const originalLinerHiddenRenderOrder = linerHiddenMesh.renderOrder;
    if (!originalLinerVisibleMaterial.depthTest)
      fail(`${linerNode.name} must retain ordinary depth testing`);
    const metricFrame = resolveSocketEyeSurfaceMetricFrame(
      capNode,
      visibleMesh,
      side,
    );
    const compositeMaterial = new SocketEyeCompositeMaterialRuntime(
      side,
      state,
      metricFrame,
    );
    const hiddenMaterial = new THREE.MeshBasicMaterial();
    hiddenMaterial.name = `${capNode.name}__hidden_closure_runtime`;
    hiddenMaterial.visible = false;
    hiddenMaterial.colorWrite = false;
    hiddenMaterial.depthTest = false;
    hiddenMaterial.depthWrite = false;
    const linerHiddenMaterial = new THREE.MeshBasicMaterial();
    linerHiddenMaterial.name = `${linerNode.name}__hidden_seal_runtime`;
    linerHiddenMaterial.visible = false;
    linerHiddenMaterial.colorWrite = false;
    linerHiddenMaterial.depthTest = false;
    linerHiddenMaterial.depthWrite = false;
    visibleMesh.material = compositeMaterial.material;
    hiddenMesh.material = hiddenMaterial;
    linerHiddenMesh.material = linerHiddenMaterial;
    visibleMesh.renderOrder = SOCKET_EYE_COMPOSITE_RENDER_ORDER;
    hiddenMesh.renderOrder = SOCKET_EYE_COMPOSITE_RENDER_ORDER;
    linerVisibleMesh.renderOrder = SOCKET_EYE_LINER_RENDER_ORDER;
    linerHiddenMesh.renderOrder = SOCKET_EYE_LINER_RENDER_ORDER;
    return {
      capNode,
      visibleMesh,
      hiddenMesh,
      linerNode,
      linerVisibleMesh,
      linerHiddenMesh,
      originalVisibleMaterial,
      originalHiddenMaterial,
      originalLinerVisibleMaterial,
      originalLinerHiddenMaterial,
      originalVisibleRenderOrder,
      originalHiddenRenderOrder,
      originalLinerVisibleRenderOrder,
      originalLinerHiddenRenderOrder,
      hiddenMaterial,
      linerHiddenMaterial,
      compositeMaterial,
      metricFrame,
    };
  }

  syncIdentitySurfaceFrames() {
    if (this.disposed) fail("cannot update metric frames after disposal");
    for (const sideName of ["left", "right"] as const) {
      const bound = this.sides[sideName];
      bound.metricFrame.centerMeters.copy(
        metricCenterForGeometry(
          bound.visibleMesh,
          bound.metricFrame.horizontalAxisLocal,
          bound.metricFrame.verticalAxisLocal,
        ),
      );
      bound.compositeMaterial.setMetricCenter(bound.metricFrame.centerMeters);
    }
  }

  setVisualState(side: SocketEyeSide, state: SocketEyeCompositeVisualState) {
    if (this.disposed) fail("cannot update composite state after disposal");
    this.sides[side].compositeMaterial.setState(state);
  }

  setGaze(side: SocketEyeSide, horizontal: number, vertical: number) {
    if (this.disposed) fail("cannot update gaze after disposal");
    this.sides[side].compositeMaterial.setGaze(horizontal, vertical);
  }

  getMaterial(side: SocketEyeSide) {
    return this.sides[side].compositeMaterial.material;
  }

  getMetricCenter(side: SocketEyeSide) {
    return this.sides[side].compositeMaterial.getMetricCenter();
  }

  getLinerArtworkMesh(side: SocketEyeSide) {
    if (this.disposed) fail("cannot resolve liner artwork after disposal");
    return this.sides[side].linerVisibleMesh;
  }

  private releaseSide(side: BoundSide) {
    side.visibleMesh.material = side.originalVisibleMaterial;
    side.hiddenMesh.material = side.originalHiddenMaterial;
    side.linerVisibleMesh.material = side.originalLinerVisibleMaterial;
    side.linerHiddenMesh.material = side.originalLinerHiddenMaterial;
    side.visibleMesh.renderOrder = side.originalVisibleRenderOrder;
    side.hiddenMesh.renderOrder = side.originalHiddenRenderOrder;
    side.linerVisibleMesh.renderOrder = side.originalLinerVisibleRenderOrder;
    side.linerHiddenMesh.renderOrder = side.originalLinerHiddenRenderOrder;
    side.compositeMaterial.dispose();
    side.hiddenMaterial.dispose();
    side.linerHiddenMaterial.dispose();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const sideName of ["left", "right"] as const) {
      this.releaseSide(this.sides[sideName]);
    }
    this.restoreBodyDepthOcclusion();
  }
}
