import { describe, expect, it, vi } from "vitest";
import { EyeAppearanceEngineRuntime } from "./eyeAppearance.engine";
import type {
  EyeAppearanceControlId,
  EyeAppearanceDefinition,
} from "./eyeAppearance";
import {
  SOCKET_EYE_HIGHLIGHT_PROJECTION_CONTRACT,
  SOCKET_EYE_SCLERA_PROJECTION_CONTRACT,
} from "./socketEyeArtworkProjection";

function control(id: EyeAppearanceControlId) {
  const size = id === "iris_size";
  const pupil = id === "pupil_size";
  const position =
    id === "iris_horizontal_position" || id === "iris_vertical_position";
  return {
    id,
    label: id,
    description: id,
    minimum: size || pupil ? 0.5 : -1,
    maximum: size || pupil ? 1.5 : 1,
    step: 0.01,
    default: position ? 0 : 1,
    unit: size
      ? ("neutral-multiplier" as const)
      : pupil
        ? ("iris-relative-multiplier" as const)
        : ("neutral-travel-fraction" as const),
    linkedBilateral: true as const,
    bilateralLaw:
      id === "iris_horizontal_position"
        ? ("mirrored-convergence-divergence" as const)
        : ("linked-same-value" as const),
    perEyeOverridesAllowed: false as const,
    runtimeClampingAllowed: false as const,
    geometrySemantics: id,
  };
}

const definition = {
  schemaVersion: "eye-appearance/v5",
  stateSchemaVersion: "eye-appearance-state/v5",
  status: "product-export-approved",
  productExportApproved: true,
  definitionSha256: "a".repeat(64),
  dependencies: {
    socketEyeSurface: {
      schemaVersion: "socket-eye-surface/v2",
      definitionSha256: "b".repeat(64),
    },
    eyeApertureSeam: {
      schemaVersion: "eye-aperture-seam/v2",
      definitionSha256: "c".repeat(64),
    },
  },
  ownership: "test",
  zeroLaw: "test",
  symmetryLaw: "test",
  compositionOrder: [
    "sclera",
    "scleraArtwork",
    "iris",
    "pupil",
    "highlight",
    "cornea",
  ],
  solidColorDefaults: {
    iris: [0.1, 0.2, 0.3, 1],
    pupil: [0, 0, 0, 1],
    sclera: [0.8, 0.8, 0.8, 1],
  },
  runtimeBindings: {
    coordinateSpace: "physical-eye-sphere",
    left: {
      physicalEyeNode: "BS_PhysicalEye_L",
      irisNeutralRadiusMeters: 0.0081,
      pupilNeutralRadiusRatio: 0.49,
      neutralPlacement: {
        horizontalTravelFraction: -0.5,
        verticalTravelFraction: -0.7,
      },
      irisHorizontalTravelMeters: 0.002,
      irisVerticalTravelMeters: 0.003,
      edgeSoftnessMeters: 0.0001,
      artworkMappings: {
        sclera: SOCKET_EYE_SCLERA_PROJECTION_CONTRACT,
        iris: "sphere-tangent-radial",
        pupil: "sphere-tangent-radial",
        highlight: SOCKET_EYE_HIGHLIGHT_PROJECTION_CONTRACT,
      },
      cornea: { roughness: 0.2, clearcoat: 0.8, clearcoatRoughness: 0.1 },
    },
    right: {
      physicalEyeNode: "BS_PhysicalEye_R",
      irisNeutralRadiusMeters: 0.0081,
      pupilNeutralRadiusRatio: 0.49,
      neutralPlacement: {
        horizontalTravelFraction: -0.5,
        verticalTravelFraction: -0.7,
      },
      irisHorizontalTravelMeters: 0.0025,
      irisVerticalTravelMeters: 0.003,
      edgeSoftnessMeters: 0.0001,
      artworkMappings: {
        sclera: SOCKET_EYE_SCLERA_PROJECTION_CONTRACT,
        iris: "sphere-tangent-radial",
        pupil: "sphere-tangent-radial",
        highlight: SOCKET_EYE_HIGHLIGHT_PROJECTION_CONTRACT,
      },
      cornea: { roughness: 0.2, clearcoat: 0.8, clearcoatRoughness: 0.1 },
    },
    geometryEvidence: {
      acceptedGlbSha256: "d".repeat(64),
      socketSurfaceSha256: "b".repeat(64),
      apertureSeamSha256: "c".repeat(64),
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
    sha256: "e".repeat(64),
    canonicalSha256: "f".repeat(64),
  },
} as EyeAppearanceDefinition;

describe("EyeAppearanceEngineRuntime v5", () => {
  it("applies definition-owned neutral placement before linked user controls", () => {
    const runtime = new EyeAppearanceEngineRuntime(definition, {
      schemaVersion: "eye-appearance-state/v5",
      definitionSha256: definition.definitionSha256,
      irisSize: 1.25,
      pupilSize: 0.5,
      irisHorizontalPosition: 0.5,
      irisVerticalPosition: 0.5,
    });

    const left = runtime.resolveSide("left");
    expect(left.irisRadiusMeters).toBeCloseTo(0.010125);
    expect(left.pupilRadiusRatio).toBeCloseTo(0.245);
    expect(left.irisHorizontalOffsetMeters).toBeCloseTo(0);
    expect(left.irisVerticalOffsetMeters).toBeCloseTo(-0.0006);
    expect(left.edgeSoftnessMeters).toBe(0.0001);
    expect(left.cornea).toEqual({
      roughness: 0.2,
      clearcoat: 0.8,
      clearcoatRoughness: 0.1,
    });
    expect(runtime.resolveSide("right").irisHorizontalOffsetMeters).toBeCloseTo(
      0,
    );
  });

  it("keeps the smallest user-facing Pupil Size inside the balanced range", () => {
    const runtime = new EyeAppearanceEngineRuntime(definition, {
      schemaVersion: "eye-appearance-state/v5",
      definitionSha256: definition.definitionSha256,
      irisSize: 1,
      pupilSize: 0.5,
      irisHorizontalPosition: 0,
      irisVerticalPosition: 0,
    });
    expect(runtime.resolveSide("right").pupilRadiusRatio).toBe(0.245);
  });

  it("notifies the physical-eye composite owner after strict state changes", () => {
    const changed = vi.fn();
    const runtime = new EyeAppearanceEngineRuntime(definition, null, changed);
    runtime.setState({
      schemaVersion: "eye-appearance-state/v5",
      definitionSha256: definition.definitionSha256,
      irisSize: 0.9,
      pupilSize: 1.2,
      irisHorizontalPosition: -0.5,
      irisVerticalPosition: -0.25,
    });
    expect(changed).toHaveBeenCalledOnce();
    runtime.dispose();
    expect(() => runtime.resolveSide("left")).toThrow("after disposal");
  });
});
