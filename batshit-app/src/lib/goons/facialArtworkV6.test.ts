import { describe, expect, it } from "vitest";

import {
  FACIAL_ARTWORK_V6_EDITABLE_TRANSFORMS,
  FACIAL_ARTWORK_V6_ROLE_IDS,
  createDefaultFacialArtworkStateV6,
  parseFacialArtworkDefinitionV6,
  parseFacialArtworkStateV6,
  reconcileFacialArtworkStateV6,
  resolveFacialArtworkV6SocketProjectionMode,
  type FacialArtworkV6RoleId,
} from "./facialArtworkV6";
import {
  LEGACY_SOCKET_EYE_HIGHLIGHT_PROJECTION_CONTRACT,
  SOCKET_EYE_HIGHLIGHT_PROJECTION_CONTRACT,
  SOCKET_EYE_INSET_IRIS_PUPIL_PROJECTION_CONTRACT,
  SOCKET_EYE_IRIS_PUPIL_PROJECTION_CONTRACT,
  SOCKET_EYE_SCLERA_PROJECTION_CONTRACT,
} from "./socketEyeArtworkProjection";

const SHA = {
  definition: "a".repeat(64),
  eye: "b".repeat(64),
  socket: "c".repeat(64),
  seam: "d".repeat(64),
  receipt: "e".repeat(64),
  asset: "f".repeat(64),
};

function path(role: FacialArtworkV6RoleId, name: string) {
  return `goons/facial-artwork/v6/test-v6/${role}/${name}.png`;
}

function asset(role: FacialArtworkV6RoleId, name: string) {
  return { path: path(role, name), sha256: SHA.asset };
}

function mask(role: FacialArtworkV6RoleId, name: string) {
  return { ...asset(role, name), channels: "L8", paintThreshold: 1 };
}

function template(role: FacialArtworkV6RoleId) {
  const anatomical = role === "brows" || role === "lashes_eye_outline";
  return {
    id: `${role}-template`,
    version: "6.0.0",
    dimensions: role === "sclera" ? [2048, 1024] : [1024, 1024],
    pixelContract: {
      format: "PNG",
      channels: "RGBA8",
      colorSpace: "sRGB",
      alpha: "straight",
      interlaced: false,
    },
    guide: asset(role, "guide-left"),
    safePaintMask: mask(role, "mask-left"),
    transparentBlank: asset(role, "blank"),
    semanticMap: null,
    canonicalOrientation: anatomical
      ? "anatomical-left"
      : "orientation-neutral",
    transformOriginUv: [0.5, 0.5],
    mirroredHorizontalVariant: anatomical
      ? {
          orientation: "anatomical-right",
          label: "Anatomical right",
          guide: asset(role, "guide-right"),
          safePaintMask: mask(role, "mask-right"),
          semanticMap: null,
        }
      : null,
    orientationReference: anatomical
      ? asset(role, "orientation-reference")
      : null,
  };
}

function roleContract(role: FacialArtworkV6RoleId) {
  if (role === "brows") {
    return {
      ownership: "canvas",
      mapping: "planar",
      projection: "planar-canvas",
      bindingKind: "face-conformal-canvas",
      compositeLayer: null,
      transformBounds: {
        translateU: [-0.25, 0.25],
        translateV: [-0.25, 0.25],
        scale: [0.5, 1.5],
        rotationDegrees: [-45, 45],
      },
    };
  }
  if (role === "lashes_eye_outline") {
    return {
      ownership: "canvas",
      mapping: "planar",
      projection: "planar-canvas",
      bindingKind: "eye-aperture-liner",
      compositeLayer: null,
      transformBounds: {
        translateU: [-0.1, 0.1],
        translateV: [-0.1, 0.1],
        scale: [0.8, 1.2],
        rotationDegrees: [-10, 10],
      },
    };
  }
  if (role === "iris" || role === "pupil") {
    return {
      ownership: "lit-surface",
      mapping: "radial",
      projection: "sphere-tangent-radial",
      bindingKind: "physical-eye-layer",
      compositeLayer: role,
      transformBounds: { rotationDegrees: [-180, 180] },
    };
  }
  if (role === "eye_highlight") {
    return {
      ownership: "lit-overlay",
      mapping: "radial",
      projection: LEGACY_SOCKET_EYE_HIGHLIGHT_PROJECTION_CONTRACT,
      bindingKind: "physical-eye-layer",
      compositeLayer: "highlight",
      transformBounds: {
        translateU: [-0.2, 0.2],
        translateV: [-0.2, 0.2],
        scale: [0.5, 1.5],
        rotationDegrees: [-180, 180],
      },
    };
  }
  return {
    ownership: "lit-surface",
    mapping: "longitude",
    projection: SOCKET_EYE_SCLERA_PROJECTION_CONTRACT,
    bindingKind: "physical-eye-layer",
    compositeLayer: "scleraArtwork",
    transformBounds: { longitudeDegrees: [-180, 180] },
  };
}

function role(role: FacialArtworkV6RoleId) {
  const contract = roleContract(role);
  const colorRole = role === "iris" || role === "pupil" || role === "sclera";
  return {
    id: role,
    template: `${role}-template`,
    ownership: contract.ownership,
    mapping: contract.mapping,
    projection: contract.projection,
    editableTransforms: [...FACIAL_ARTWORK_V6_EDITABLE_TRANSFORMS[role]],
    rotationLaw:
      role === "sclera" ? "additive-to-gaze-longitude" : "artwork-local",
    bilateralLaw:
      role === "eye_highlight"
        ? "shared-unmirrored-same-orientation"
        : "shared-horizontal-mirror-with-same-value-transforms",
    alphaPolicy:
      role === "sclera"
        ? {
            emptyArtworkAllowed: false,
            fullyOpaqueAllowed: true,
            transparencyRequired: false,
          }
        : {
            emptyArtworkAllowed: false,
            fullyOpaqueAllowed: false,
            transparencyRequired: true,
          },
    target: {
      left: {
        runtimeNodes: [`${role}_left`],
        mirrorU: false,
        mirrorV: false,
        bindingKind: contract.bindingKind,
        compositeLayer: contract.compositeLayer,
      },
      right: {
        runtimeNodes: [`${role}_right`],
        mirrorU: role === "eye_highlight" ? false : true,
        mirrorV: false,
        bindingKind: contract.bindingKind,
        compositeLayer: contract.compositeLayer,
      },
    },
    defaultEyeState: {
      visible: colorRole,
      baseColor: colorRole ? [0.2, 0.3, 0.4] : null,
      artwork: null,
    },
    defaultMode: "shared",
    transformBounds: contract.transformBounds,
  };
}

function trusted(role: FacialArtworkV6RoleId) {
  return {
    role,
    side: "shared",
    asset: asset(role, "trusted"),
    sourceSha256: SHA.asset,
    derivation: "exact-source-bytes",
    derivedFromSha256: null,
  };
}

function fixture() {
  return {
    schemaVersion: "facial-artwork/v6",
    stateSchemaVersion: "facial-artwork-state/v6",
    status: "product-export-approved",
    productExportApproved: true,
    definitionSha256: SHA.definition,
    dependencies: {
      eyeAppearance: {
        schemaVersion: "eye-appearance/v5",
        definitionSha256: SHA.eye,
      },
      socketEyeSurface: {
        schemaVersion: "socket-eye-surface/v2",
        definitionSha256: SHA.socket,
      },
      eyeApertureSeam: {
        schemaVersion: "eye-aperture-seam/v2",
        definitionSha256: SHA.seam,
      },
    },
    templateSet: { id: "test-v6", version: "6.0.0" },
    templates: FACIAL_ARTWORK_V6_ROLE_IDS.map(template),
    roles: FACIAL_ARTWORK_V6_ROLE_IDS.map(role),
    trustedArtwork: {
      sourceReceiptSha256: SHA.receipt,
      entries: FACIAL_ARTWORK_V6_ROLE_IDS.map(trusted),
    },
  };
}

function templateBinding(
  role: FacialArtworkV6RoleId,
  orientation?: "anatomical-left" | "orientation-neutral",
) {
  const value = template(role);
  return {
    id: value.id,
    version: value.version,
    orientation: orientation ?? value.canonicalOrientation,
    guideSha256: value.guide.sha256,
    maskSha256: value.safePaintMask.sha256,
  };
}

function upload(role: FacialArtworkV6RoleId) {
  return {
    role,
    url: `/uploads/${role}.png`,
    filename: `${role}.png`,
    size: 4096,
    mimeType: "image/png",
    sha256: SHA.asset,
    template: templateBinding(role),
    provenance: {
      sourceKind: "user-authored",
      author: "Josh",
      license: "Batshit first-party",
      rightsConfirmed: true,
    },
  };
}

function artwork(role: FacialArtworkV6RoleId) {
  const mapping = roleContract(role).mapping;
  const transform =
    role === "sclera"
      ? { longitudeDegrees: 20 }
      : role === "iris" || role === "pupil"
        ? { translateU: 0, translateV: 0, scale: 1, rotationDegrees: 25 }
        : { translateU: 0.1, translateV: -0.1, scale: 1.1, rotationDegrees: 5 };
  return {
    upload: upload(role),
    tint: [1, 1, 1, 1],
    opacity: 0.8,
    mapping,
    transform,
  };
}

describe("facial-artwork/v6 future contract", () => {
  it("requires Eye v5 and the exact six definition-driven role inventories", () => {
    const definition = parseFacialArtworkDefinitionV6(fixture());

    expect(definition.dependencies.eyeAppearance.schemaVersion).toBe(
      "eye-appearance/v5",
    );
    expect(definition.roles.map((entry) => entry.id)).toEqual(
      FACIAL_ARTWORK_V6_ROLE_IDS,
    );
    expect(
      Object.fromEntries(
        definition.roles.map((entry) => [entry.id, entry.editableTransforms]),
      ),
    ).toEqual(FACIAL_ARTWORK_V6_EDITABLE_TRANSFORMS);
    expect(definition.templates).toHaveLength(6);
    expect(definition.trustedArtwork.entries).toHaveLength(6);
  });

  it("materializes clone-safe defaults from a Svelte-like reactive definition", () => {
    const definition = parseFacialArtworkDefinitionV6(fixture());
    const proxiedRoles = definition.roles.map(
      (role) =>
        new Proxy(role, {
          get(target, property, receiver) {
            if (property === "defaultEyeState") {
              return new Proxy(target.defaultEyeState, {});
            }
            return Reflect.get(target, property, receiver);
          },
        }),
    );
    const reactiveDefinition = new Proxy(
      { ...definition, roles: proxiedRoles },
      {},
    ) as typeof definition;

    expect(() =>
      structuredClone(reactiveDefinition.roles[0].defaultEyeState),
    ).toThrow();

    const state = createDefaultFacialArtworkStateV6(reactiveDefinition);

    expect(state).toEqual(createDefaultFacialArtworkStateV6(definition));
    expect(() => structuredClone(state)).not.toThrow();
  });

  it("preserves the immutable legacy projection suite and Sclera contract", () => {
    const definition = parseFacialArtworkDefinitionV6(fixture());
    const highlight = definition.roles.find(
      (entry) => entry.id === "eye_highlight",
    )!;
    const sclera = definition.roles.find((entry) => entry.id === "sclera")!;

    expect(highlight).toMatchObject({
      projection: LEGACY_SOCKET_EYE_HIGHLIGHT_PROJECTION_CONTRACT,
      bilateralLaw: "shared-unmirrored-same-orientation",
      target: { left: { mirrorU: false }, right: { mirrorU: false } },
    });
    expect(sclera).toMatchObject({
      projection: SOCKET_EYE_SCLERA_PROJECTION_CONTRACT,
      editableTransforms: ["longitudeDegrees"],
      rotationLaw: "additive-to-gaze-longitude",
      bilateralLaw: "shared-horizontal-mirror-with-same-value-transforms",
    });
    expect(resolveFacialArtworkV6SocketProjectionMode(definition)).toBe(
      "legacy",
    );
  });

  it("accepts only the complete corrected Iris/Pupil/Highlight projection suite", () => {
    const corrected = fixture() as any;
    corrected.roles[2].projection = SOCKET_EYE_IRIS_PUPIL_PROJECTION_CONTRACT;
    corrected.roles[3].projection = SOCKET_EYE_IRIS_PUPIL_PROJECTION_CONTRACT;
    corrected.roles[4].projection = SOCKET_EYE_HIGHLIGHT_PROJECTION_CONTRACT;
    corrected.roles[2].alphaPolicy = {
      emptyArtworkAllowed: false,
      fullyOpaqueAllowed: true,
      transparencyRequired: false,
    };
    corrected.roles[3].alphaPolicy = {
      emptyArtworkAllowed: false,
      fullyOpaqueAllowed: true,
      transparencyRequired: false,
    };
    const definition = parseFacialArtworkDefinitionV6(corrected);
    expect(resolveFacialArtworkV6SocketProjectionMode(definition)).toBe(
      "corrected",
    );

    const inset = structuredClone(corrected);
    inset.roles[2].projection =
      SOCKET_EYE_INSET_IRIS_PUPIL_PROJECTION_CONTRACT;
    inset.roles[3].projection =
      SOCKET_EYE_INSET_IRIS_PUPIL_PROJECTION_CONTRACT;
    for (const roleIndex of [2, 3]) {
      inset.roles[roleIndex].alphaPolicy = {
        emptyArtworkAllowed: false,
        fullyOpaqueAllowed: false,
        transparencyRequired: true,
      };
    }
    expect(
      resolveFacialArtworkV6SocketProjectionMode(
        parseFacialArtworkDefinitionV6(inset),
      ),
    ).toBe("corrected-inset");

    const mixed = fixture() as any;
    mixed.roles[2].projection = SOCKET_EYE_IRIS_PUPIL_PROJECTION_CONTRACT;
    mixed.roles[2].alphaPolicy = {
      emptyArtworkAllowed: false,
      fullyOpaqueAllowed: true,
      transparencyRequired: false,
    };
    expect(() => parseFacialArtworkDefinitionV6(mixed)).toThrow(
      /one complete legacy, corrected edge-to-edge, or corrected inset suite/,
    );
  });

  it("retains all Brow, Lashes, and Highlight transforms but only rotation for Iris/Pupil", () => {
    const definition = parseFacialArtworkDefinitionV6(fixture());
    const state = createDefaultFacialArtworkStateV6(definition);
    for (const role of FACIAL_ARTWORK_V6_ROLE_IDS) {
      state.roles[role] = {
        mode: "shared",
        shared: {
          visible: true,
          baseColor:
            role === "iris" || role === "pupil" || role === "sclera"
              ? [0.2, 0.3, 0.4]
              : null,
          artwork: artwork(role) as any,
        },
      };
    }
    const parsed = parseFacialArtworkStateV6(definition, state);

    for (const role of [
      "brows",
      "lashes_eye_outline",
      "eye_highlight",
    ] as const) {
      expect(parsed.roles[role]).toMatchObject({
        mode: "shared",
        shared: {
          artwork: {
            transform: {
              translateU: 0.1,
              translateV: -0.1,
              scale: 1.1,
              rotationDegrees: 5,
            },
          },
        },
      });
    }
    for (const role of ["iris", "pupil"] as const) {
      expect(parsed.roles[role]).toMatchObject({
        mode: "shared",
        shared: {
          artwork: {
            transform: {
              translateU: 0,
              translateV: 0,
              scale: 1,
              rotationDegrees: 25,
            },
          },
        },
      });
    }
    expect(parsed.roles.sclera).toMatchObject({
      mode: "shared",
      shared: { artwork: { transform: { longitudeDegrees: 20 } } },
    });
  });

  it("normalizes color channels to a RedisJSON-stable precision", () => {
    const definition = parseFacialArtworkDefinitionV6(fixture());
    const state = createDefaultFacialArtworkStateV6(definition);
    state.roles.iris = {
      mode: "shared",
      shared: {
        visible: true,
        baseColor: [238 / 255, 0.25, 250 / 255],
        artwork: {
          ...(artwork("iris") as any),
          tint: [238 / 255, 0.5, 250 / 255, 128 / 255],
        },
      },
    };

    expect(parseFacialArtworkStateV6(definition, state).roles.iris).toMatchObject({
      mode: "shared",
      shared: {
        baseColor: [0.933333, 0.25, 0.980392],
        artwork: { tint: [0.933333, 0.5, 0.980392, 0.501961] },
      },
    });
  });

  it("rejects nonidentity Iris/Pupil transforms and invalid contract declarations", () => {
    const definition = parseFacialArtworkDefinitionV6(fixture());
    const state = createDefaultFacialArtworkStateV6(definition);
    state.roles.iris = {
      mode: "shared",
      shared: {
        visible: true,
        baseColor: [0.2, 0.3, 0.4],
        artwork: artwork("iris") as any,
      },
    };
    (state.roles.iris as any).shared.artwork.transform.scale = 1.01;
    expect(() => parseFacialArtworkStateV6(definition, state)).toThrow(
      /scale must be 1/,
    );

    const wrongInventory = fixture() as any;
    wrongInventory.roles[2].editableTransforms = [
      "translateU",
      "rotationDegrees",
    ];
    expect(() => parseFacialArtworkDefinitionV6(wrongInventory)).toThrow(
      /editableTransforms/,
    );

    const mirroredHighlight = fixture() as any;
    mirroredHighlight.roles[4].target.right.mirrorU = true;
    expect(() => parseFacialArtworkDefinitionV6(mirroredHighlight)).toThrow(
      /fixed-cornea Highlight/,
    );

    const oldSclera = fixture() as any;
    oldSclera.roles[5].projection = "front-hemisphere-uv";
    expect(() => parseFacialArtworkDefinitionV6(oldSclera)).toThrow(
      /full-sphere-equirectangular/,
    );
  });

  it("fails closed on schema, assets, provenance, hashes, or extra state fields", () => {
    const oldEye = fixture() as any;
    oldEye.dependencies.eyeAppearance.schemaVersion = "eye-appearance/v4";
    expect(() => parseFacialArtworkDefinitionV6(oldEye)).toThrow(
      /eye-appearance\/v5/,
    );

    const privateAsset = fixture() as any;
    privateAsset.templates[0].guide.path = "_private/guide.png";
    expect(() => parseFacialArtworkDefinitionV6(privateAsset)).toThrow(
      /canonical public v6 asset root/,
    );

    const definition = parseFacialArtworkDefinitionV6(fixture());
    const state = createDefaultFacialArtworkStateV6(definition) as any;
    state.roles.brows.shared.artwork = artwork("brows");
    state.roles.brows.shared.artwork.upload.provenance.rightsConfirmed = false;
    expect(() => parseFacialArtworkStateV6(definition, state)).toThrow(
      /rightsConfirmed/,
    );

    state.roles.brows.shared.artwork.upload.provenance.rightsConfirmed = true;
    state.legacyArtworkScale = 1.15;
    expect(() => parseFacialArtworkStateV6(definition, state)).toThrow(
      /must contain exactly/,
    );
    expect(reconcileFacialArtworkStateV6(definition, state)).toMatchObject({
      state: null,
      incompatible: true,
    });
  });
});
