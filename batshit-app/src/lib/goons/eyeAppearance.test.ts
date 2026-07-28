import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  EYE_APPEARANCE_CONTROL_IDS,
  createDefaultEyeAppearanceState,
  parseEyeAppearanceDefinition,
  parseEyeAppearanceState,
  readEyeAppearanceControl,
  reconcileEyeAppearanceState,
  resolveEyeAppearanceRuntimeControlValue,
  updateEyeAppearanceControl,
} from "./eyeAppearance";

function loadPromotedDefinition(): Record<string, any> {
  return JSON.parse(
    readFileSync(
      resolve(process.cwd(), "static/goons/eye-appearance/v3/eye-appearance-v3.json"),
      "utf8",
    ),
  ) as Record<string, any>;
}

function definitionFixture(): any {
  const side = (code: "L" | "R") => ({
    compositeCapNode: `BS_Eye_${code}_CompositeCap`,
    irisNeutralRadiusMeters: 0.006,
    pupilNeutralRadiusRatio: 0.35,
    irisVerticalTravelMeters: 0.003,
    edgeSoftnessMeters: 0.0002,
    artworkMappings: {
      sclera: "gaze-linked-carrier",
      iris: "radial-carrier",
      pupil: "radial-carrier",
      highlight: "iris-space",
    },
    cornea: { roughness: 0.12, clearcoat: 1, clearcoatRoughness: 0.08 },
  });
  const control = (
    id: "iris_size" | "pupil_size" | "iris_vertical_position",
    minimum: number,
    maximum: number,
    unit:
      | "neutral-multiplier"
      | "iris-relative-multiplier"
      | "neutral-travel-fraction",
    defaultValue = 1,
  ) => ({
    id,
    label:
      id === "iris_size"
        ? "Iris Size"
        : id === "pupil_size"
          ? "Pupil Size"
          : "Iris Vertical Position",
    description: `Package-owned ${id} control.`,
    minimum,
    maximum,
    step: 0.01,
    default: defaultValue,
    unit,
    linkedBilateral: true,
    perEyeOverridesAllowed: false,
    runtimeClampingAllowed: false,
    geometrySemantics: "Moves artwork coordinates on the fixed composite cap.",
  });
  return {
    schemaVersion: "eye-appearance/v3",
    stateSchemaVersion: "eye-appearance-state/v3",
    status: "product-export-approved",
    productExportApproved: true,
    definitionSha256: "a".repeat(64),
    dependencies: {
      socketEyeSurface: {
        schemaVersion: "socket-eye-surface/v1",
        definitionSha256: "b".repeat(64),
      },
      eyeApertureSeam: {
        schemaVersion: "eye-aperture-seam/v1",
        definitionSha256: "c".repeat(64),
      },
    },
    ownership: "Package definition owns calibration; state owns three logical controls.",
    zeroLaw: "Defaults reproduce the authored composite eye.",
    symmetryLaw: "Both controls remain linked bilateral.",
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
      coordinateSpace: "socket-eye-surface",
      left: side("L"),
      right: side("R"),
      geometryEvidence: {
        acceptedGlbSha256: "d".repeat(64),
        socketSurfaceSha256: "e".repeat(64),
        apertureSeamSha256: "f".repeat(64),
      },
    },
    controls: [
      control("iris_size", 0.75, 1.35, "neutral-multiplier"),
      control("pupil_size", 0, 2, "iris-relative-multiplier"),
      control(
        "iris_vertical_position",
        -1,
        1,
        "neutral-travel-fraction",
        0,
      ),
    ],
    rangeEvidence: {
      schemaVersion: "eye-appearance-range-evidence/v3",
      sha256: "1".repeat(64),
      canonicalSha256: "2".repeat(64),
    },
  };
}

describe("eye-appearance/v3", () => {
  it("pins the static definition to the promoted socket-eye product tuple", () => {
    const raw = loadPromotedDefinition();
    expect(raw.definitionSha256).toBe(
      "90df1dad9791a10969feb81f6e227dd9088449c25715d49143b624a7132737e8",
    );
    expect(raw.dependencies).toEqual({
      socketEyeSurface: {
        schemaVersion: "socket-eye-surface/v1",
        definitionSha256: "cf946c62c8b81158b96692e99fa8eb9d40cc9e540f2981f18b26fb4f12748f12",
      },
      eyeApertureSeam: {
        schemaVersion: "eye-aperture-seam/v1",
        definitionSha256: "84c07b601e0d6d6093666f813bb0ee09ad1d09393c3f0d6900682a89d3803949",
      },
    });
    expect(raw.runtimeBindings.geometryEvidence).toEqual({
      acceptedGlbSha256: "8424404f3843e48dc0195bf98e4705de2effe28e5cedcf25d0e60749ff8e2e65",
      socketSurfaceSha256: "cf946c62c8b81158b96692e99fa8eb9d40cc9e540f2981f18b26fb4f12748f12",
      apertureSeamSha256: "84c07b601e0d6d6093666f813bb0ee09ad1d09393c3f0d6900682a89d3803949",
    });
    expect(() => parseEyeAppearanceDefinition(raw)).not.toThrow();
  });

  it("parses the fixed-cap material contract and exactly three physical controls", () => {
    const definition = parseEyeAppearanceDefinition(definitionFixture());
    expect(definition.dependencies).toEqual({
      socketEyeSurface: {
        schemaVersion: "socket-eye-surface/v1",
        definitionSha256: "b".repeat(64),
      },
      eyeApertureSeam: {
        schemaVersion: "eye-aperture-seam/v1",
        definitionSha256: "c".repeat(64),
      },
    });
    expect(definition.controls.map((entry) => entry.id)).toEqual(
      EYE_APPEARANCE_CONTROL_IDS,
    );
    expect(definition.runtimeBindings.left.compositeCapNode).toBe(
      "BS_Eye_L_CompositeCap",
    );
  });

  it("creates and updates linked Iris Size, Pupil Size, and vertical position", () => {
    const definition = parseEyeAppearanceDefinition(definitionFixture());
    const state = createDefaultEyeAppearanceState(definition);
    expect(state).toEqual({
      schemaVersion: "eye-appearance-state/v3",
      definitionSha256: definition.definitionSha256,
      irisSize: 1,
      pupilSize: 1,
      irisVerticalPosition: 0,
    });
    expect(readEyeAppearanceControl(state, "iris_size")).toBe(1);
    expect(updateEyeAppearanceControl(new Proxy(state, {}), "pupil_size", 1.25)).toEqual({
      ...state,
      pupilSize: 1.25,
    });
    expect(resolveEyeAppearanceRuntimeControlValue(definition, "iris_size", 1.2)).toBe(1.2);
    expect(
      updateEyeAppearanceControl(state, "iris_vertical_position", 0.25),
    ).toMatchObject({ irisVerticalPosition: 0.25, pupilSize: 1 });
  });

  it("cleanly rejects v1 globe state and retired repair controls", () => {
    const oldDefinition = definitionFixture();
    oldDefinition.schemaVersion = "eye-appearance/v1";
    expect(() => parseEyeAppearanceDefinition(oldDefinition)).toThrow(/eye-appearance\/v3/);

    const definition = parseEyeAppearanceDefinition(definitionFixture());
    const oldState = {
      ...createDefaultEyeAppearanceState(definition),
      eyeConvergence: 0,
      scleraFit: { scale: 0, tilt: 0, horizontal: 0, vertical: 0, depth: 0 },
    };
    expect(() => parseEyeAppearanceState(definition, oldState)).toThrow(/unsupported fields/);
    expect(reconcileEyeAppearanceState(definition, oldState)).toMatchObject({
      state: null,
      incompatible: true,
    });
  });

  it("rejects mapping drift, stale dependencies, and out-of-range values", () => {
    const badLayer = definitionFixture();
    badLayer.runtimeBindings.left.artworkMappings.highlight = "planar";
    expect(() => parseEyeAppearanceDefinition(badLayer)).toThrow(/highlight must be iris-space/);

    const staleDependency = definitionFixture();
    staleDependency.dependencies.socketEyeSurface.schemaVersion = "socket-eye-surface/v2";
    expect(() => parseEyeAppearanceDefinition(staleDependency)).toThrow(/socket-eye-surface\/v1/);

    const definition = parseEyeAppearanceDefinition(definitionFixture());
    const state = createDefaultEyeAppearanceState(definition);
    state.irisSize = 1.351;
    expect(() => parseEyeAppearanceState(definition, state)).toThrow(/inside \[0.75, 1.35\]/);
  });

  it("rejects control endpoints and defaults that the slider cannot represent", () => {
    const unreachableMaximum = definitionFixture();
    unreachableMaximum.controls[0].maximum = 1.355;
    expect(() => parseEyeAppearanceDefinition(unreachableMaximum)).toThrow(
      /maximum must be reachable from minimum by whole steps/,
    );

    const unreachableDefault = definitionFixture();
    unreachableDefault.controls[1].default = 1.005;
    expect(() => parseEyeAppearanceDefinition(unreachableDefault)).toThrow(
      /default must be reachable from minimum by whole steps/,
    );
  });
});
