import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import { buildFacialArtworkV6DefinitionFixture } from "./__fixtures__/facialArtworkV6";
import type { EyeAppearanceEngineRuntime } from "./eyeAppearance.engine";
import {
  FacialArtworkEngineRuntime,
  buildFacialArtworkTextureMatrix,
  configureArtworkTexture,
  resolveFacialArtworkHorizontalReflection,
} from "./facialArtwork.engine";
import {
  createDefaultFacialArtworkState,
  createFacialArtworkArtworkLayer,
  resolveFacialArtworkTemplateVariant,
  type FacialArtworkDefinition,
  type FacialArtworkOrientation,
  type FacialArtworkRoleId,
} from "./facialArtwork";
import type { SocketEyeSurfaceEngineRuntime } from "./socketEyeSurface.engine";

function definition(): FacialArtworkDefinition {
  return buildFacialArtworkV6DefinitionFixture();
}

function upload(
  role: FacialArtworkRoleId,
  definitionValue: FacialArtworkDefinition,
  url: string,
  orientation?: FacialArtworkOrientation,
) {
  const roleDefinition = definitionValue.roles.find(
    (entry) => entry.id === role,
  )!;
  const template = definitionValue.templates.find(
    (entry) => entry.id === roleDefinition.template,
  )!;
  const resolvedOrientation = orientation ?? template.canonicalOrientation;
  const variant = resolveFacialArtworkTemplateVariant(
    template,
    resolvedOrientation,
  );
  return {
    role,
    url,
    filename: `${role}.png`,
    size: 10,
    mimeType: "image/png" as const,
    sha256: "d".repeat(64),
    template: {
      id: template.id,
      version: template.version,
      orientation: resolvedOrientation,
      guideSha256: variant.guide.sha256,
      maskSha256: variant.safePaintMask.sha256,
    },
    provenance: {
      sourceKind: "user-authored" as const,
      author: "Fixture Artist",
      license: "LicenseRef-User-Owned",
      rightsConfirmed: true as const,
    },
  };
}

function runtimeFixture() {
  const definitionValue = definition();
  const root = new THREE.Group();
  for (const role of definitionValue.roles) {
    for (const side of ["left", "right"] as const) {
      if (role.target[side].bindingKind !== "face-conformal-canvas") continue;
      const mesh = new THREE.Mesh(
        new THREE.BufferGeometry(),
        new THREE.MeshBasicMaterial(),
      );
      mesh.name = role.target[side].runtimeNodes[0];
      root.add(mesh);
    }
  }
  const treatments = Object.fromEntries(
    (["left", "right"] as const).map((side) => {
      const upper = new THREE.Mesh(
        new THREE.BufferGeometry(),
        new THREE.MeshBasicMaterial(),
      );
      upper.name = `${side}-treatment-upper`;
      const lower = new THREE.Mesh(
        new THREE.BufferGeometry(),
        new THREE.MeshBasicMaterial(),
      );
      lower.name = `${side}-treatment-lower`;
      root.add(upper, lower);
      return [side, { upper, lower }];
    }),
  ) as Record<"left" | "right", { upper: THREE.Mesh; lower: THREE.Mesh }>;
  const socketEyes = {
    setVisualState: vi.fn(),
    getTreatmentArtworkMeshes: vi.fn(
      (side: "left" | "right") => treatments[side],
    ),
  } as unknown as SocketEyeSurfaceEngineRuntime;
  const eyeAppearance = {
    resolveSide: vi.fn((side: "left" | "right") => ({
      irisRadiusMeters: side === "left" ? 0.006 : 0.0062,
      pupilRadiusRatio: 0.4,
      irisHorizontalOffsetMeters: side === "left" ? -0.0005 : 0.0005,
      irisVerticalOffsetMeters: side === "left" ? 0.001 : 0.0012,
      edgeSoftnessMeters: 0.0001,
      cornea: { roughness: 0.2, clearcoat: 0.8, clearcoatRoughness: 0.1 },
    })),
  } as unknown as EyeAppearanceEngineRuntime;
  return { definitionValue, root, socketEyes, eyeAppearance, treatments };
}

function trackedTexture() {
  const value = new THREE.Texture();
  vi.spyOn(value, "dispose");
  return value;
}

describe("FacialArtworkEngineRuntime v6", () => {
  it("routes opaque eye roles into one composite material instead of assigning globe meshes", async () => {
    const value = runtimeFixture();
    const runtime = new FacialArtworkEngineRuntime(
      value.root,
      value.definitionValue,
      value.socketEyes,
      value.eyeAppearance,
    );
    await runtime.apply(null);
    expect(value.socketEyes.setVisualState).toHaveBeenCalledTimes(2);
    expect(value.socketEyes.setVisualState).toHaveBeenCalledWith(
      "left",
      expect.objectContaining({
        irisRadiusMeters: 0.006,
        pupilRadiusRatio: 0.4,
        irisHorizontalOffsetMeters: -0.0005,
        irisVerticalOffsetMeters: 0.001,
        cornea: { roughness: 0.2, clearcoat: 0.8, clearcoatRoughness: 0.1 },
      }),
    );
    expect(value.root.getObjectByName("bs_f1_brow_canvas_l")?.visible).toBe(
      false,
    );
    expect(value.treatments.left.upper.visible).toBe(false);
    expect(value.treatments.left.lower.visible).toBe(false);
  });

  it("hands every socket-eye artwork role to its ordered composite layer", async () => {
    const value = runtimeFixture();
    const state = createDefaultFacialArtworkState(value.definitionValue);
    for (const roleId of [
      "sclera",
      "iris",
      "pupil",
      "eye_highlight",
    ] as const) {
      const role = state.roles[roleId];
      if (role.mode !== "shared")
        throw new Error("fixture requires shared state");
      role.shared.visible = true;
      role.shared.artwork = createFacialArtworkArtworkLayer(
        value.definitionValue,
        roleId,
        upload(roleId, value.definitionValue, `/${roleId}.png`),
      );
    }
    const runtime = new FacialArtworkEngineRuntime(
      value.root,
      value.definitionValue,
      value.socketEyes,
      value.eyeAppearance,
      { loadAsync: vi.fn(async () => trackedTexture()) },
    );
    await runtime.apply(state);
    const leftCall = vi
      .mocked(value.socketEyes.setVisualState)
      .mock.calls.find(([side]) => side === "left")!;
    expect(leftCall[1].scleraArtwork.texture).toBeInstanceOf(THREE.Texture);
    expect(leftCall[1].irisArtwork.texture).toBeInstanceOf(THREE.Texture);
    expect(leftCall[1].pupilArtwork.texture).toBeInstanceOf(THREE.Texture);
    expect(leftCall[1].highlight.texture).toBeInstanceOf(THREE.Texture);
    expect(
      new Set(
        [
          leftCall[1].scleraArtwork.texture,
          leftCall[1].irisArtwork.texture,
          leftCall[1].pupilArtwork.texture,
          leftCall[1].highlight.texture,
        ].map((textureValue) => textureValue?.uuid),
      ).size,
    ).toBe(4);
  });

  it("keeps both animated treatment surfaces visible from both sides with ordinary depth testing", async () => {
    const value = runtimeFixture();
    const state = createDefaultFacialArtworkState(value.definitionValue);
    const role = state.roles.lashes_eye_outline;
    if (role.mode !== "shared")
      throw new Error("fixture requires shared liner");
    role.shared.visible = true;
    role.shared.artwork = createFacialArtworkArtworkLayer(
      value.definitionValue,
      "lashes_eye_outline",
      upload("lashes_eye_outline", value.definitionValue, "/liner.png"),
    );
    const runtime = new FacialArtworkEngineRuntime(
      value.root,
      value.definitionValue,
      value.socketEyes,
      value.eyeAppearance,
      { loadAsync: vi.fn(async () => trackedTexture()) },
    );
    await runtime.apply(state);
    for (const mesh of [
      value.treatments.left.upper,
      value.treatments.left.lower,
    ]) {
      expect((mesh.material as THREE.Material).side).toBe(THREE.DoubleSide);
      expect((mesh.material as THREE.Material).depthTest).toBe(true);
      expect((mesh.material as THREE.Material).depthWrite).toBe(false);
    }
  });

  it("applies artwork transforms to both treatment surfaces without a hidden seal", async () => {
    const value = runtimeFixture();
    const originalUpper = value.treatments.left.upper.material;
    const originalLower = value.treatments.left.lower.material;

    const state = createDefaultFacialArtworkState(value.definitionValue);
    const role = state.roles.lashes_eye_outline;
    if (role.mode !== "shared")
      throw new Error("fixture requires shared liner");
    role.shared.visible = true;
    role.shared.artwork = createFacialArtworkArtworkLayer(
      value.definitionValue,
      "lashes_eye_outline",
      upload("lashes_eye_outline", value.definitionValue, "/liner.png"),
    );
    role.shared.artwork.transform = {
      translateU: 0.04,
      translateV: -0.08,
      scale: 1.15,
      rotationDegrees: 8,
    };
    const runtime = new FacialArtworkEngineRuntime(
      value.root,
      value.definitionValue,
      value.socketEyes,
      value.eyeAppearance,
      { loadAsync: vi.fn(async () => trackedTexture()) },
    );

    await runtime.apply(state);

    expect(value.treatments.left.upper.material).not.toBe(originalUpper);
    expect(value.treatments.left.lower.material).not.toBe(originalLower);
    expect(
      value.root.getObjectByName("left-treatment-hidden-seal"),
    ).toBeUndefined();
  });

  it("refreshes material calibration without reloading artwork and disposes only owned textures", async () => {
    const value = runtimeFixture();
    const source = trackedTexture();
    const loadAsync = vi.fn(async () => source);
    const runtime = new FacialArtworkEngineRuntime(
      value.root,
      value.definitionValue,
      value.socketEyes,
      value.eyeAppearance,
      { loadAsync },
    );
    await runtime.apply(null);
    runtime.refreshSocketVisualState();
    expect(loadAsync).not.toHaveBeenCalled();
    runtime.dispose();
    expect(source.dispose).not.toHaveBeenCalled();
  });
});

describe("Facial Artwork v6 texture transforms", () => {
  it("mirrors shared anatomy, keeps shared Highlight fixed, and preserves neutral per-eye uploads", () => {
    const definitionValue = definition();
    const expectedRightTextureMirror: Record<FacialArtworkRoleId, boolean> = {
      brows: false,
      lashes_eye_outline: false,
      iris: true,
      pupil: true,
      eye_highlight: false,
      sclera: true,
    };
    for (const role of definitionValue.roles) {
      const canonical = createFacialArtworkArtworkLayer(
        definitionValue,
        role.id,
        upload(role.id, definitionValue, `/${role.id}-canonical.png`),
      );
      expect(
        resolveFacialArtworkHorizontalReflection(
          role,
          "left",
          canonical,
          "shared",
        ),
      ).toBe(false);
      expect(
        resolveFacialArtworkHorizontalReflection(
          role,
          "right",
          canonical,
          "shared",
        ),
      ).toBe(expectedRightTextureMirror[role.id]);

      if (canonical.upload.template.orientation === "orientation-neutral") {
        expect(
          resolveFacialArtworkHorizontalReflection(
            role,
            "right",
            canonical,
            "per-eye",
          ),
        ).toBe(false);
      }
    }

    const role = definitionValue.roles.find(
      (entry) => entry.id === "lashes_eye_outline",
    )!;
    const template = definitionValue.templates.find(
      (entry) => entry.id === role.template,
    )!;
    const left = createFacialArtworkArtworkLayer(
      definitionValue,
      role.id,
      upload(role.id, definitionValue, "/left.png", "anatomical-left"),
    );
    const right = createFacialArtworkArtworkLayer(
      definitionValue,
      role.id,
      upload(role.id, definitionValue, "/right.png", "anatomical-right"),
    );
    expect(
      resolveFacialArtworkHorizontalReflection(role, "left", left, "per-eye"),
    ).toBe(false);
    expect(
      resolveFacialArtworkHorizontalReflection(role, "right", right, "per-eye"),
    ).toBe(true);

    const textureValue = new THREE.Texture();
    configureArtworkTexture(
      textureValue,
      template,
      role,
      "right",
      left,
      "shared",
    );
    expect(textureValue.matrix.elements).toEqual(
      buildFacialArtworkTextureMatrix(template, role, "right", left, "shared")
        .elements,
    );
  });

  it("keeps shared Highlight orientation and transform signs identical on both eyes", () => {
    const definitionValue = definition();
    const role = definitionValue.roles.find(
      (entry) => entry.id === "eye_highlight",
    )!;
    const template = definitionValue.templates.find(
      (entry) => entry.id === role.template,
    )!;
    const shared = createFacialArtworkArtworkLayer(
      definitionValue,
      role.id,
      upload(role.id, definitionValue, "/highlight.png"),
    );
    shared.transform = {
      translateU: 0.12,
      translateV: -0.08,
      scale: 1.15,
      rotationDegrees: 22,
    };

    expect(
      buildFacialArtworkTextureMatrix(template, role, "right", shared, "shared")
        .elements,
    ).toEqual(
      buildFacialArtworkTextureMatrix(template, role, "left", shared, "shared")
        .elements,
    );
  });
});
