import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createDefaultEyeAppearanceState,
  parseEyeAppearanceDefinition,
} from "$lib/goons/eyeAppearance";
import { APPEARANCE_DIAL_VALUES_CONTRACT } from "$lib/goons/appearanceDials.contracts";
import { buildFacialArtworkV6DefinitionFixture } from "$lib/goons/__fixtures__/facialArtworkV6";
import {
  SOCKET_EYE_HIGHLIGHT_PROJECTION_CONTRACT,
  SOCKET_EYE_INSET_IRIS_PUPIL_PROJECTION_CONTRACT,
  SOCKET_EYE_SCLERA_PROJECTION_CONTRACT,
} from "$lib/goons/socketEyeArtworkProjection";
import {
  loadGoonEyeAppearanceDefinition,
  validateGoonEyeAppearanceState,
} from "../eyeAppearance.server";

const HASH = {
  eye: "a".repeat(64),
  socket: "b".repeat(64),
  seam: "c".repeat(64),
  artwork: "d".repeat(64),
};

function treatmentPerformanceMorphs(suffix: "Left" | "Right"): string[] {
  return [
    `eyeBlink${suffix}`,
    `eyeLookDown${suffix}`,
    `eyeLookIn${suffix}`,
    `eyeLookOut${suffix}`,
    `eyeLookUp${suffix}`,
    `eyeSquint${suffix}`,
    `eyeWide${suffix}`,
    ...Array.from({ length: 31 }, (_, index) => `performance${suffix}${index}`),
  ].sort();
}

function treatmentFollowerMorphs(suffix: "Left" | "Right"): string[] {
  return [
    ...treatmentPerformanceMorphs(suffix),
    ...Array.from({ length: 46 }, (_, index) => `identity${suffix}${index}`),
  ].sort();
}

function seamFixture(): any {
  const side = (name: "left" | "right", code: "l" | "r", offset: number) => ({
    side: name,
    sourceBodyNode: "Body",
    physicalEyeNode: `bs_f1_eye_${code}_physical`,
    lashesEyeOutlineNode: `bs_f1_eye_treatment_${code}`,
    upperBoundary: { sampleCount: 48, bindingSha256: `${offset}`.repeat(64) },
    lowerBoundary: {
      sampleCount: 48,
      bindingSha256: `${offset + 1}`.repeat(64),
    },
    innerCanthusVertexIndex: offset * 100 + 1,
    outerCanthusVertexIndex: offset * 100 + 2,
    treatment: {
      geometryLaw: "animated-upper-lower-thin-surface/v1",
      upperMaterialName: `bs_f1_eye_treatment_${code}_upper_mat`,
      lowerMaterialName: `bs_f1_eye_treatment_${code}_lower_mat`,
      appearanceFollowerContract: "appearance-followers/v2",
      followerInventorySha256: `${offset + 2}`.repeat(64),
      followerMorphs: treatmentFollowerMorphs(
        name === "left" ? "Left" : "Right",
      ),
      retainedPerformanceMorphs: treatmentPerformanceMorphs(
        name === "left" ? "Left" : "Right",
      ),
      surfaceCorrection: {
        contract: "head-projection-blink-surface-correction/v1",
        projectionMorph: `surfaceProjection${name === "left" ? "Left" : "Right"}`,
        blinkLinearMorph: `surfaceBlinkLinear${name === "left" ? "Left" : "Right"}`,
        blinkResidualMorph: `surfaceBlinkResidual${name === "left" ? "Left" : "Right"}`,
        blinkMorph: `eyeBlink${name === "left" ? "Left" : "Right"}`,
        projectionWeightLaw: "appearance-follower-weight",
        blinkLinearWeightLaw: "blink-times-projection",
        blinkResidualWeightLaw: "four-blink-one-minus-blink-times-projection",
      },
      doubleSided: true,
      ordinaryDepthTest: true,
      depthWrite: false,
      renderOrder: "after-physical-eye",
    },
  });
  return {
    schemaVersion: "eye-aperture-seam/v2",
    definitionSha256: HASH.seam,
    status: "product-export-approved",
    productExportApproved: true,
    sharedCanthusRoots: true,
    blinkClosure: {
      composition: "authored-independent/v2",
      fullBlinkSquintFloor: 0,
    },
    runtimeBindings: {
      left: side("left", "l", 1),
      right: side("right", "r", 3),
    },
  };
}

function socketFixture(): any {
  const side = (name: "left" | "right", code: "L" | "R", x: number) => {
    return {
      side: name,
      nodes: { physicalEye: `bs_f1_eye_${code.toLowerCase()}_physical` },
      apertureSeamDefinitionSha256: HASH.seam,
      gazeAnchorHeadLocal: [x, 0, 0],
      surfaceCenterHeadLocal: [x, 0, 0],
      horizontalAxisHeadLocal: [1, 0, 0],
      verticalAxisHeadLocal: [0, 1, 0],
      forwardAxisHeadLocal: [0, 0, 1],
      sphere: {
        geometryLaw: "static-full-sphere/v1",
        radiusMeters: 0.02,
        artworkProjection: "front-hemisphere-uv/v1",
        stableNeutralRear: true,
        surfaceMorphTargets: [],
        physicalFit: {
          mode: "transform-only/v1",
          translation: true,
          rotation: true,
          uniformScale: true,
          nonUniformScale: false,
        },
      },
      gaze: {
        maximumHorizontal: 0.58,
        maximumVertical: 0.45,
        headFollowStart: 0.72,
      },
    };
  };
  return {
    schemaVersion: "socket-eye-surface/v2",
    definitionSha256: HASH.socket,
    status: "product-export-approved",
    productExportApproved: true,
    coordinateSpace: "head-local",
    surfaceKind: "static-full-sphere",
    compositeLayers: [
      "sclera",
      "scleraArtwork",
      "iris",
      "pupil",
      "highlight",
      "cornea",
    ],
    rendering: {
      eyelidsOwnApertureOcclusion: true,
      sphereDepthTest: true,
      sphereDepthWrite: true,
      sphereSide: "front",
      renderOrder: "after-face-before-treatment",
      requiredMaxTextureArrayLayers: 6,
    },
    artwork: {
      scleraOverlay: {
        projection: "front-hemisphere-only/v1",
        transparentRgba: true,
        rearPresentation: "stable-neutral-base",
        gazeLinked: false,
      },
    },
    runtimeBindings: {
      left: side("left", "L", 0.03),
      right: side("right", "R", -0.03),
    },
  };
}

function eyeFixture(): any {
  const side = (code: "L" | "R") => ({
    physicalEyeNode: `bs_f1_eye_${code.toLowerCase()}_physical`,
    irisNeutralRadiusMeters: 0.0081,
    pupilNeutralRadiusRatio: 0.49,
    neutralPlacement: {
      horizontalTravelFraction: -0.5,
      verticalTravelFraction: -0.7,
    },
    irisHorizontalTravelMeters: 0.002,
    irisVerticalTravelMeters: 0.003,
    edgeSoftnessMeters: 0.0002,
    artworkMappings: {
      sclera: SOCKET_EYE_SCLERA_PROJECTION_CONTRACT,
      iris: SOCKET_EYE_INSET_IRIS_PUPIL_PROJECTION_CONTRACT,
      pupil: SOCKET_EYE_INSET_IRIS_PUPIL_PROJECTION_CONTRACT,
      highlight: SOCKET_EYE_HIGHLIGHT_PROJECTION_CONTRACT,
    },
    cornea: { roughness: 0.12, clearcoat: 1, clearcoatRoughness: 0.08 },
  });
  const control = (
    id:
      | "iris_size"
      | "pupil_size"
      | "iris_horizontal_position"
      | "iris_vertical_position",
  ) => ({
    id,
    label:
      id === "iris_size"
        ? "Iris Size"
        : id === "pupil_size"
          ? "Pupil Size"
          : id === "iris_horizontal_position"
            ? "Iris Horizontal Position"
            : "Iris Vertical Position",
    description: `${id} on the physical sphere`,
    minimum: id === "iris_size" || id === "pupil_size" ? 0.5 : -1,
    maximum: id === "iris_size" || id === "pupil_size" ? 1.5 : 1,
    step: 0.01,
    default:
      id === "iris_vertical_position" || id === "iris_horizontal_position"
        ? 0
        : 1,
    unit:
      id === "iris_size"
        ? "neutral-multiplier"
        : id === "pupil_size"
          ? "iris-relative-multiplier"
          : "neutral-travel-fraction",
    linkedBilateral: true,
    bilateralLaw:
      id === "iris_horizontal_position"
        ? "mirrored-convergence-divergence"
        : "linked-same-value",
    perEyeOverridesAllowed: false,
    runtimeClampingAllowed: false,
    geometrySemantics:
      "Moves artwork coordinates without deforming the physical sphere.",
  });
  return {
    schemaVersion: "eye-appearance/v5",
    stateSchemaVersion: "eye-appearance-state/v5",
    status: "product-export-approved",
    productExportApproved: true,
    definitionSha256: HASH.eye,
    dependencies: {
      socketEyeSurface: {
        schemaVersion: "socket-eye-surface/v2",
        definitionSha256: HASH.socket,
      },
      eyeApertureSeam: {
        schemaVersion: "eye-aperture-seam/v2",
        definitionSha256: HASH.seam,
      },
    },
    ownership: "Package-owned calibration.",
    zeroLaw: "Defaults reproduce authored eyes.",
    symmetryLaw: "Linked bilateral controls.",
    compositionOrder: [
      "sclera",
      "scleraArtwork",
      "iris",
      "pupil",
      "highlight",
      "cornea",
    ],
    solidColorDefaults: {
      iris: [0.035, 0.42, 0.34, 1],
      pupil: [0.008, 0.009, 0.012, 1],
      sclera: [0.92, 0.94, 0.96, 1],
    },
    runtimeBindings: {
      coordinateSpace: "physical-eye-sphere",
      left: side("L"),
      right: side("R"),
      geometryEvidence: {
        acceptedGlbSha256: "e".repeat(64),
        socketSurfaceSha256: "f".repeat(64),
        apertureSeamSha256: "1".repeat(64),
      },
    },
    controls: [
      control("iris_size"),
      control("pupil_size"),
      control("iris_horizontal_position"),
      control("iris_vertical_position"),
    ],
    rangeEvidence: {
      schemaVersion: "sa090-eye-appearance-range-calibration/v5",
      sha256: "2".repeat(64),
      canonicalSha256: "3".repeat(64),
    },
  };
}

function facialArtworkFixture(): any {
  const value = structuredClone(buildFacialArtworkV6DefinitionFixture());
  value.definitionSha256 = HASH.artwork;
  value.dependencies = {
    eyeAppearance: {
      schemaVersion: "eye-appearance/v5",
      definitionSha256: HASH.eye,
    },
    socketEyeSurface: {
      schemaVersion: "socket-eye-surface/v2",
      definitionSha256: HASH.socket,
    },
    eyeApertureSeam: {
      schemaVersion: "eye-aperture-seam/v2",
      definitionSha256: HASH.seam,
    },
  };
  for (const role of value.roles) {
    if (role.id === "iris" || role.id === "pupil") {
      role.projection = SOCKET_EYE_INSET_IRIS_PUPIL_PROJECTION_CONTRACT;
    } else if (role.id === "eye_highlight") {
      role.projection = SOCKET_EYE_HIGHLIGHT_PROJECTION_CONTRACT;
    }
    const kind =
      role.id === "brows"
        ? "face-conformal-canvas"
        : role.id === "lashes_eye_outline"
          ? "eye-aperture-liner"
          : "physical-eye-layer";
    const layer =
      role.id === "sclera"
        ? "scleraArtwork"
        : role.id === "eye_highlight"
          ? "highlight"
          : role.id === "iris" || role.id === "pupil"
            ? role.id
            : null;
    for (const side of ["left", "right"]) {
      role.target[side].bindingKind = kind;
      role.target[side].compositeLayer = layer;
      if (kind === "physical-eye-layer") {
        role.target[side].runtimeNodes = [
          side === "left" ? "bs_f1_eye_l_physical" : "bs_f1_eye_r_physical",
        ];
      } else if (kind === "eye-aperture-liner") {
        role.target[side].runtimeNodes = [
          side === "left" ? "bs_f1_eye_treatment_l" : "bs_f1_eye_treatment_r",
        ];
      }
    }
  }
  return value;
}

function packageManifest() {
  return {
    appearanceDials: {},
    facialArtwork: facialArtworkFixture(),
    eyeAppearance: eyeFixture(),
    socketEyeSurface: socketFixture(),
    eyeApertureSeam: seamFixture(),
  };
}

const goon = {
  customAvatar: {
    manifest: {
      url: "/uploads/goon_custom_manifests/avatar.json",
      filename: "avatar.json",
    },
  },
};

const preparedRecipeGoon = {
  ...goon,
  recipe: {
    authoringRevision: {
      state: {
        appearanceDials: { contract: APPEARANCE_DIAL_VALUES_CONTRACT },
      },
    },
  },
} as any;

function reader(
  manifest: unknown,
  manifestUpload: Record<string, unknown> | null = null,
) {
  return {
    json: {
      async get(key: string) {
        return key === "upload:goon_custom_manifests:avatar.json"
          ? (manifestUpload ?? { textContent: JSON.stringify(manifest) })
          : null;
      },
    },
  };
}

describe("eyeAppearance.server", () => {
  it("loads the exact v5/v6/socket/seam package tuple and validates four-control state", async () => {
    const manifest = packageManifest();
    const definition = parseEyeAppearanceDefinition(manifest.eyeAppearance);
    const state = createDefaultEyeAppearanceState(definition);
    await expect(
      loadGoonEyeAppearanceDefinition(reader(manifest), goon),
    ).resolves.toMatchObject({
      schemaVersion: "eye-appearance/v5",
      definitionSha256: HASH.eye,
    });
    await expect(
      validateGoonEyeAppearanceState(reader(manifest), goon, state),
    ).resolves.toEqual(state);
  });

  it("accepts the lean prepared Live manifest when the Recipe owns authoring Appearance Dials", async () => {
    const liveManifest = packageManifest();
    delete (liveManifest as any).appearanceDials;
    await expect(
      loadGoonEyeAppearanceDefinition(reader(liveManifest), preparedRecipeGoon),
    ).resolves.toMatchObject({
      schemaVersion: "eye-appearance/v5",
      definitionSha256: HASH.eye,
    });
    await expect(
      loadGoonEyeAppearanceDefinition(reader(liveManifest), goon),
    ).rejects.toThrow(
      /requires the package Recipe appearance-dials\/v2 definition/,
    );
  });

  it("loads the tuple from the current filesystem-backed manifest upload", async () => {
    const manifest = packageManifest();
    const textContent = JSON.stringify(manifest);
    const uploadRoot = mkdtempSync(
      join(tmpdir(), "batshit-eye-appearance-upload-"),
    );
    const manifestDir = join(uploadRoot, "goon_custom_manifests");
    const previousUploadsDir = process.env.UPLOADS_DIR;
    mkdirSync(manifestDir, { recursive: true });
    writeFileSync(join(manifestDir, "avatar.json"), textContent);
    process.env.UPLOADS_DIR = uploadRoot;
    try {
      await expect(
        loadGoonEyeAppearanceDefinition(
          reader(
            {},
            {
              uploadType: "goon_custom_manifests",
              storage: "filesystem",
              relativePath: "goon_custom_manifests/avatar.json",
              size: Buffer.byteLength(textContent),
            },
          ),
          goon,
        ),
      ).resolves.toMatchObject({ schemaVersion: "eye-appearance/v5" });
    } finally {
      if (previousUploadsDir === undefined) delete process.env.UPLOADS_DIR;
      else process.env.UPLOADS_DIR = previousUploadsDir;
      rmSync(uploadRoot, { recursive: true, force: true });
    }
  });

  it("accepts null and rejects missing or hash-drifted tuple dependencies", async () => {
    await expect(
      validateGoonEyeAppearanceState(reader({}), goon, null),
    ).resolves.toBeNull();
    const manifest = packageManifest();
    const state = createDefaultEyeAppearanceState(
      parseEyeAppearanceDefinition(manifest.eyeAppearance),
    );
    const partial = packageManifest();
    delete (partial as any).socketEyeSurface;
    await expect(
      validateGoonEyeAppearanceState(reader(partial), goon, state),
    ).rejects.toThrow(/requires socket-eye-surface\/v2/);
    const mismatched = packageManifest();
    mismatched.eyeAppearance.dependencies.socketEyeSurface.definitionSha256 =
      "f".repeat(64);
    await expect(
      validateGoonEyeAppearanceState(reader(mismatched), goon, state),
    ).rejects.toThrow(/dependencies do not match/);
  });

  it("rejects facial-artwork targets that do not own the exact treatment and physical-eye nodes", async () => {
    const manifest = packageManifest();
    const state = createDefaultEyeAppearanceState(
      parseEyeAppearanceDefinition(manifest.eyeAppearance),
    );
    const lashes = manifest.facialArtwork.roles.find(
      (role: { id: string }) => role.id === "lashes_eye_outline",
    );
    lashes.target.left.runtimeNodes = ["floating-lash-card"];
    await expect(
      validateGoonEyeAppearanceState(reader(manifest), goon, state),
    ).rejects.toThrow(/treatment target does not match/);
  });
});
