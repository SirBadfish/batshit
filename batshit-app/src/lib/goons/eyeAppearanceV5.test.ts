import { describe, expect, it } from "vitest";

import {
  EYE_APPEARANCE_V5_BASELINES,
  createDefaultEyeAppearanceStateV5,
  parseEyeAppearanceDefinitionV5,
  parseEyeAppearanceStateV5,
  reconcileEyeAppearanceStateV5,
  resolveEyeAppearanceV5SocketProjectionMode,
} from "./eyeAppearanceV5";
import {
  LEGACY_SOCKET_EYE_HIGHLIGHT_PROJECTION_CONTRACT,
  LEGACY_SOCKET_EYE_IRIS_PUPIL_PROJECTION_CONTRACT,
  SOCKET_EYE_HIGHLIGHT_PROJECTION_CONTRACT,
  SOCKET_EYE_INSET_IRIS_PUPIL_PROJECTION_CONTRACT,
  SOCKET_EYE_IRIS_PUPIL_PROJECTION_CONTRACT,
  SOCKET_EYE_SCLERA_PROJECTION_CONTRACT,
} from "./socketEyeArtworkProjection";

const SHA = {
  eye: "a".repeat(64),
  socket: "b".repeat(64),
  seam: "c".repeat(64),
  glb: "d".repeat(64),
  range: "e".repeat(64),
  canonical: "f".repeat(64),
};

function control(
  id: string,
  minimum: number,
  maximum: number,
  defaultValue: number,
  unit: string,
  bilateralLaw = "linked-same-value",
) {
  return {
    id,
    label: id,
    description: `${id} description`,
    minimum,
    maximum,
    step: 0.01,
    default: defaultValue,
    unit,
    linkedBilateral: true,
    bilateralLaw,
    perEyeOverridesAllowed: false,
    runtimeClampingAllowed: false,
    geometrySemantics: `${id} is definition-owned.`,
  };
}

function side(side: "left" | "right") {
  return {
    physicalEyeNode: `physical_eye_${side}`,
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
      iris: SOCKET_EYE_IRIS_PUPIL_PROJECTION_CONTRACT,
      pupil: SOCKET_EYE_IRIS_PUPIL_PROJECTION_CONTRACT,
      highlight: SOCKET_EYE_HIGHLIGHT_PROJECTION_CONTRACT,
    },
    cornea: { roughness: 0.12, clearcoat: 1, clearcoatRoughness: 0.08 },
  };
}

function fixture() {
  return {
    schemaVersion: "eye-appearance/v5",
    stateSchemaVersion: "eye-appearance-state/v5",
    status: "product-export-approved",
    productExportApproved: true,
    definitionSha256: SHA.eye,
    dependencies: {
      socketEyeSurface: {
        schemaVersion: "socket-eye-surface/v2",
        definitionSha256: SHA.socket,
      },
      eyeApertureSeam: {
        schemaVersion: "eye-aperture-seam/v2",
        definitionSha256: SHA.seam,
      },
    },
    ownership: "static physical eye material presentation",
    zeroLaw: "zero resolves through definition-owned neutral placement",
    symmetryLaw:
      "horizontal positive converges; other controls share one bilateral value",
    compositionOrder: [
      "sclera",
      "scleraArtwork",
      "iris",
      "pupil",
      "highlight",
      "cornea",
    ],
    solidColorDefaults: {
      iris: [0.2, 0.4, 0.6, 1],
      pupil: [0.02, 0.02, 0.02, 1],
      sclera: [0.9, 0.9, 0.9, 1],
    },
    runtimeBindings: {
      coordinateSpace: "physical-eye-sphere",
      left: side("left"),
      right: side("right"),
      geometryEvidence: {
        acceptedGlbSha256: SHA.glb,
        socketSurfaceSha256: SHA.socket,
        apertureSeamSha256: SHA.seam,
      },
    },
    controls: [
      control("iris_size", 0.5, 1.5, 1, "neutral-multiplier"),
      control("pupil_size", 0.5, 1.5, 1, "iris-relative-multiplier"),
      control(
        "iris_horizontal_position",
        -1,
        1,
        0,
        "neutral-travel-fraction",
        "mirrored-convergence-divergence",
      ),
      control("iris_vertical_position", -1, 1, 0, "neutral-travel-fraction"),
    ],
    rangeEvidence: {
      schemaVersion: "eye-appearance-range-evidence/v5",
      sha256: SHA.range,
      canonicalSha256: SHA.canonical,
    },
  };
}

describe("eye-appearance/v5 future contract", () => {
  it("requires the rebased physical sizes, neutral placement, and active projections", () => {
    const definition = parseEyeAppearanceDefinitionV5(fixture());

    for (const binding of [
      definition.runtimeBindings.left,
      definition.runtimeBindings.right,
    ]) {
      expect(binding).toMatchObject({
        irisNeutralRadiusMeters: 0.0081,
        pupilNeutralRadiusRatio: 0.49,
        neutralPlacement: {
          horizontalTravelFraction: -0.5,
          verticalTravelFraction: -0.7,
        },
        artworkMappings: {
          sclera: SOCKET_EYE_SCLERA_PROJECTION_CONTRACT,
          highlight: SOCKET_EYE_HIGHLIGHT_PROJECTION_CONTRACT,
        },
      });
    }
    expect(EYE_APPEARANCE_V5_BASELINES).toEqual({
      irisNeutralRadiusMeters: 0.0081,
      pupilNeutralRadiusRatio: 0.49,
      neutralHorizontalTravelFraction: -0.5,
      neutralVerticalTravelFraction: -0.7,
    });
    expect(resolveEyeAppearanceV5SocketProjectionMode(definition)).toBe(
      "corrected",
    );
  });

  it("keeps the immutable finalized-04 projection suite renderable and rejects mixed suites", () => {
    const legacy = fixture() as any;
    for (const binding of [
      legacy.runtimeBindings.left,
      legacy.runtimeBindings.right,
    ]) {
      binding.artworkMappings.iris =
        LEGACY_SOCKET_EYE_IRIS_PUPIL_PROJECTION_CONTRACT;
      binding.artworkMappings.pupil =
        LEGACY_SOCKET_EYE_IRIS_PUPIL_PROJECTION_CONTRACT;
      binding.artworkMappings.highlight =
        LEGACY_SOCKET_EYE_HIGHLIGHT_PROJECTION_CONTRACT;
    }
    expect(
      resolveEyeAppearanceV5SocketProjectionMode(
        parseEyeAppearanceDefinitionV5(legacy),
      ),
    ).toBe("legacy");

    const mixed = fixture() as any;
    mixed.runtimeBindings.left.artworkMappings.highlight =
      LEGACY_SOCKET_EYE_HIGHLIGHT_PROJECTION_CONTRACT;
    expect(() => parseEyeAppearanceDefinitionV5(mixed)).toThrow(
      /complete legacy, corrected edge-to-edge, or corrected inset socket-eye projection suite/,
    );
  });

  it("selects the inset radial authoring boundary only as one complete bilateral suite", () => {
    const inset = fixture() as any;
    for (const binding of [
      inset.runtimeBindings.left,
      inset.runtimeBindings.right,
    ]) {
      binding.artworkMappings.iris =
        SOCKET_EYE_INSET_IRIS_PUPIL_PROJECTION_CONTRACT;
      binding.artworkMappings.pupil =
        SOCKET_EYE_INSET_IRIS_PUPIL_PROJECTION_CONTRACT;
    }
    expect(
      resolveEyeAppearanceV5SocketProjectionMode(
        parseEyeAppearanceDefinitionV5(inset),
      ),
    ).toBe("corrected-inset");
  });

  it("requires both size controls to use 0.5 to 1.5 with default 1", () => {
    const definition = parseEyeAppearanceDefinitionV5(fixture());
    expect(definition.controls.slice(0, 2)).toMatchObject([
      { id: "iris_size", minimum: 0.5, maximum: 1.5, default: 1 },
      { id: "pupil_size", minimum: 0.5, maximum: 1.5, default: 1 },
    ]);

    for (const [field, value] of [
      ["minimum", 0],
      ["maximum", 2],
      ["default", 1.1],
    ] as const) {
      const invalid = fixture();
      invalid.controls[0]![field] = value;
      expect(() => parseEyeAppearanceDefinitionV5(invalid)).toThrow(
        new RegExp(`controls\\[0\\]\\.${field}`),
      );
    }
  });

  it("creates exact v5 neutral state and accepts bounded migrated fractions without coercion", () => {
    const definition = parseEyeAppearanceDefinitionV5(fixture());
    const initial = createDefaultEyeAppearanceStateV5(definition);
    expect(initial).toEqual({
      schemaVersion: "eye-appearance-state/v5",
      definitionSha256: SHA.eye,
      irisSize: 1,
      pupilSize: 1,
      irisHorizontalPosition: 0,
      irisVerticalPosition: 0,
    });
    const migrated = {
      ...initial,
      irisSize: 0.75 / 1.35,
      pupilSize: 0.75 / 1.4,
    };
    expect(parseEyeAppearanceStateV5(definition, migrated)).toEqual(migrated);
  });

  it("rejects old schemas, wrong baselines, old projections, and legacy fields", () => {
    const oldSchema = fixture() as any;
    oldSchema.schemaVersion = "eye-appearance/v4";
    expect(() => parseEyeAppearanceDefinitionV5(oldSchema)).toThrow(
      /eye-appearance\/v5/,
    );

    const wrongRadius = fixture() as any;
    wrongRadius.runtimeBindings.left.irisNeutralRadiusMeters = 0.00809;
    expect(() => parseEyeAppearanceDefinitionV5(wrongRadius)).toThrow(
      /must be 0.0081/,
    );

    const wrongRatio = fixture() as any;
    wrongRatio.runtimeBindings.right.pupilNeutralRadiusRatio = 0.5;
    expect(() => parseEyeAppearanceDefinitionV5(wrongRatio)).toThrow(
      /must be 0.49/,
    );

    const oldSclera = fixture() as any;
    oldSclera.runtimeBindings.left.artworkMappings.sclera =
      "front-hemisphere-uv";
    expect(() => parseEyeAppearanceDefinitionV5(oldSclera)).toThrow(
      /full-sphere-equirectangular/,
    );

    const legacy = fixture() as any;
    legacy.runtimeBindings.left.irisNeutralHorizontalOffset = -0.5;
    expect(() => parseEyeAppearanceDefinitionV5(legacy)).toThrow(
      /must contain exactly/,
    );
  });

  it("rejects malformed state exactly and reconciles it as incompatible", () => {
    const definition = parseEyeAppearanceDefinitionV5(fixture());
    const wrong = {
      ...createDefaultEyeAppearanceStateV5(definition),
      pupilSize: 0,
      legacyPupilScale: 1.4,
    };
    expect(() => parseEyeAppearanceStateV5(definition, wrong)).toThrow(
      /must contain exactly/,
    );
    expect(reconcileEyeAppearanceStateV5(definition, wrong)).toMatchObject({
      state: null,
      incompatible: true,
    });
    expect(reconcileEyeAppearanceStateV5(definition, null)).toEqual({
      state: null,
      incompatible: false,
    });
  });
});
